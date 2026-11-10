import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const ROLES = ["Admin", "Faculty", "Student", "CHED"] as const;
type UserRole = (typeof ROLES)[number];

function getToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
}

async function getAdmin(req: Request) {
  const token = getToken(req);
  if (!token) return { error: "Not authenticated." } as const;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { error: "Supabase is not configured." } as const;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return { error: "Session expired. Please log in again." } as const;

  const { data: row, error: roleError } = await userClient
    .from("users")
    .select("user_id, role")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  if (roleError) return { error: "Could not verify admin role." } as const;
  if (!row || row.role !== "Admin") return { error: "Only admins can change user roles." } as const;
  return { adminUserId: row.user_id as number } as const;
}

export async function POST(req: Request) {
  try {
    const auth = await getAdmin(req);
    if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: 401 });

    const body = (await req.json().catch(() => null)) as {
      user_id?: number;
      role?: string;
    } | null;
    const userId = Number(body?.user_id);
    const role = body?.role;
    if (!Number.isInteger(userId) || userId < 1 || typeof role !== "string" || !ROLES.includes(role as UserRole)) {
      return NextResponse.json({ error: "A valid user_id and role are required." }, { status: 400 });
    }
    if (userId === auth.adminUserId) {
      return NextResponse.json({ error: "You cannot change your own admin role." }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: "Server is missing Supabase service configuration." }, { status: 500 });
    }
    const sb = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: user, error: userError } = await sb
      .from("users")
      .select("user_id, role, auth_user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (userError) return NextResponse.json({ error: userError.message }, { status: 500 });
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });

    const { error: roleUpdateError } = await sb
      .from("users")
      .update({ role })
      .eq("user_id", userId);
    if (roleUpdateError) return NextResponse.json({ error: roleUpdateError.message }, { status: 500 });

    let previousMetadata: Record<string, unknown> | null = null;
    if (user.auth_user_id) {
      const { data: authUser, error: authUserError } = await sb.auth.admin.getUserById(user.auth_user_id);
      if (authUserError || !authUser.user) {
        await sb.from("users").update({ role: user.role }).eq("user_id", userId);
        return NextResponse.json({
          error: authUserError?.message || "Could not read the user's authentication profile.",
        }, { status: 500 });
      }
      previousMetadata = authUser.user.user_metadata ?? {};
      const { error: metadataError } = await sb.auth.admin.updateUserById(user.auth_user_id, {
        user_metadata: { ...previousMetadata, role },
      });
      if (metadataError) {
        await sb.from("users").update({ role: user.role }).eq("user_id", userId);
        return NextResponse.json({ error: metadataError.message }, { status: 500 });
      }
    }

    if (role === "Faculty" && user.role !== "Faculty") {
      const { error: studentError } = await sb
        .from("student_accounts")
        .delete()
        .eq("user_id", userId);
      if (studentError) {
        const rollbackResults = await Promise.all([
          sb.from("users").update({ role: user.role }).eq("user_id", userId),
          ...(user.auth_user_id && previousMetadata
            ? [sb.auth.admin.updateUserById(user.auth_user_id, { user_metadata: previousMetadata })]
            : []),
        ]);
        const rollbackFailed = rollbackResults.some((result) => result.error);
        return NextResponse.json({
          error: rollbackFailed
            ? `Could not remove the student/registrar record (${studentError.message}), and role rollback failed. Please contact support.`
            : `Could not remove the student/registrar record: ${studentError.message}`,
        }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, user_id: userId, role });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not update the user's role.",
    }, { status: 500 });
  }
}
