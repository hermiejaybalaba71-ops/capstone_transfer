import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function getToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
}

async function assertAdmin(req: Request) {
  const token = getToken(req);
  if (!token) return "Not authenticated.";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return "Supabase is not configured.";

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return "Session expired. Please log in again.";

  const { data: row, error: roleError } = await userClient
    .from("users")
    .select("role")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  if (roleError) return "Could not verify admin role.";
  if (!row || row.role !== "Admin") return "Only admins can create faculty accounts.";
  return true;
}

export async function POST(req: Request) {
  try {
    const authorized = await assertAdmin(req);
    if (authorized !== true) {
      return NextResponse.json({ error: authorized }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      username?: string;
      email?: string;
      password?: string;
    } | null;
    const username = String(body?.username ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    if (!username || !email || !password) {
      return NextResponse.json({ error: "Username, email, and password are required." }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: "Server is missing Supabase service configuration." }, { status: 500 });
    }
    const sb = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: createError } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, role: "Faculty" },
    });
    if (createError || !authData.user) {
      const message = createError?.message || "Could not create faculty login.";
      const triggerRlsFailure =
        message.toLowerCase().includes("row-level security") &&
        message.toLowerCase().includes("users");
      return NextResponse.json({
        error: triggerRlsFailure
          ? "Faculty creation is blocked by the Supabase signup trigger. Run db/fix-faculty-account-rls.sql in the main Supabase SQL Editor, then try again."
          : message,
      }, { status: 400 });
    }

    const authUserId = authData.user.id;
    const { data: userRow, error: lookupError } = await sb
      .from("users")
      .select("user_id")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (lookupError) {
      const { error: cleanupError } = await sb.auth.admin.deleteUser(authUserId);
      return NextResponse.json({
        error: cleanupError
          ? `Could not link the faculty account (${lookupError.message}); cleanup also failed (${cleanupError.message}).`
          : `Could not link the faculty account: ${lookupError.message}`,
      }, { status: 500 });
    }

    if (userRow) {
      const { error: studentCleanupError } = await sb
        .from("student_accounts")
        .delete()
        .eq("user_id", userRow.user_id);
      if (studentCleanupError) {
        const { error: cleanupError } = await sb.auth.admin.deleteUser(authUserId);
        return NextResponse.json({
          error: cleanupError
            ? `Could not remove the trigger-created student record (${studentCleanupError.message}); account cleanup also failed (${cleanupError.message}).`
            : `Could not remove the trigger-created student record: ${studentCleanupError.message}`,
        }, { status: 500 });
      }

      const { error: updateError } = await sb
        .from("users")
        .update({ username, email, role: "Faculty", status: "Active" })
        .eq("user_id", userRow.user_id);
      if (updateError) {
        const { error: cleanupError } = await sb.auth.admin.deleteUser(authUserId);
        return NextResponse.json({
          error: cleanupError
            ? `Could not finish setting up the faculty profile (${updateError.message}); account cleanup also failed (${cleanupError.message}).`
            : `Could not finish setting up the faculty profile: ${updateError.message}`,
        }, { status: 500 });
      }
    } else {
      const { error: insertError } = await sb.from("users").insert({
        username,
        email,
        role: "Faculty",
        auth_user_id: authUserId,
        status: "Active",
      });
      if (insertError) {
        const { error: cleanupError } = await sb.auth.admin.deleteUser(authUserId);
        return NextResponse.json({
          error: cleanupError
            ? `Could not create the faculty profile (${insertError.message}); account cleanup also failed (${cleanupError.message}).`
            : `Could not create the faculty profile: ${insertError.message}`,
        }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, message: "Faculty account created successfully." });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not create the faculty account.",
    }, { status: 500 });
  }
}
