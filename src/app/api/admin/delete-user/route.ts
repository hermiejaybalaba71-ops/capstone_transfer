import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function cookieName() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const match = url.match(/https?:\/\/([^./]+)/);
  return `sb-${match ? match[1] : "xflsxzmniseetvkrddmj"}-auth-token`;
}

function getToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7);
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === cookieName()) {
      try {
        const raw = decodeURIComponent(rest.join("="));
        const parsed = JSON.parse(raw);
        if (parsed?.access_token) return parsed.access_token;
      } catch {
        return rest.join("=");
      }
    }
  }
  return null;
}

async function assertAdmin(req: Request) {
  const token = getToken(req);
  if (!token) return "Not authenticated.";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const svc = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await svc.auth.getUser();
  if (error || !data.user) return "Session expired. Please log in again.";

  const { data: row, error: roleErr } = await svc
    .from("users")
    .select("role, user_id")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();

  if (roleErr) return "Could not verify admin role.";
  if (!row || row.role !== "Admin") return "Only admins can delete users.";
  return { adminUserId: row.user_id as number, targetAuthId: data.user.id };
}

export async function POST(req: Request) {
  try {
    const auth = await assertAdmin(req);
    if (typeof auth === "string") {
      return NextResponse.json({ error: auth }, { status: 401 });
    }

    const body = (await req.json()) as { user_id?: number };
    const userId = Number(body.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return NextResponse.json({ error: "user_id is required." }, { status: 400 });
    }
    if (userId === auth.adminUserId) {
      return NextResponse.json({ error: "You cannot delete your own admin account." }, { status: 400 });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
    }

    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: user, error: userErr } = await sb
      .from("users")
      .select("user_id, username, email, role, auth_user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (userErr) return NextResponse.json({ error: userErr.message }, { status: 500 });
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });

    const { data: student } = await sb
      .from("student_accounts")
      .select("student_id")
      .eq("user_id", userId)
      .maybeSingle();

    const studentId = student?.student_id as number | undefined;

    // Best-effort cleanup of related rows (ignore missing tables / FK edge cases).
    const tryDelete = async (fn: () => PromiseLike<unknown>) => {
      try { await fn(); } catch { /* ignore */ }
    };

    if (studentId != null) {
      const { data: apps } = await sb
        .from("scholarship_applications")
        .select("application_id")
        .eq("student_id", studentId);
      const appIds = (apps || []).map((a) => a.application_id);

      if (appIds.length) {
        await tryDelete(() => sb.from("support_documents").delete().in("application_id", appIds));
        await tryDelete(() => sb.from("ched_form_input").delete().in("application_id", appIds));
        await tryDelete(() => sb.from("ranking_result").delete().in("application_id", appIds));
        await tryDelete(() => sb.from("scholarship_approval").delete().in("application_id", appIds));
        await tryDelete(() => sb.from("scholarship_applications").delete().in("application_id", appIds));
      }

      await tryDelete(() => sb.from("support_academic_records").delete().eq("student_id", studentId));
      await tryDelete(() => sb.from("notifications_announcements").delete().eq("student_id", studentId));
      await tryDelete(() => sb.from("early_warning_alerts").delete().eq("student_id", studentId));
      await tryDelete(() => sb.from("student_accounts").delete().eq("user_id", userId));
    }

    const { error: delUserErr } = await sb.from("users").delete().eq("user_id", userId);
    if (delUserErr) {
      return NextResponse.json({ error: delUserErr.message }, { status: 500 });
    }

    let authDeleted = false;
    if (user.auth_user_id) {
      const { error: authErr } = await sb.auth.admin.deleteUser(user.auth_user_id);
      if (!authErr) authDeleted = true;
    }

    return NextResponse.json({
      ok: true,
      deleted_user_id: userId,
      username: user.username,
      auth_deleted: authDeleted,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
