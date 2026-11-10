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

  const { data: user, error: roleError } = await userClient
    .from("users")
    .select("role")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  if (roleError) return "Could not verify admin role.";
  if (!user || user.role !== "Admin") return "Only admins can delete applications.";
  return true;
}

export async function POST(req: Request) {
  try {
    const auth = await assertAdmin(req);
    if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { application_id?: number } | null;
    const applicationId = Number(body?.application_id);
    if (!Number.isInteger(applicationId) || applicationId < 1) {
      return NextResponse.json({ error: "A valid application_id is required." }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: "Server is missing Supabase service configuration." }, { status: 500 });
    }
    const sb = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: application, error: lookupError } = await sb
      .from("scholarship_applications")
      .select("application_id")
      .eq("application_id", applicationId)
      .maybeSingle();
    if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
    if (!application) return NextResponse.json({ error: "Application not found." }, { status: 404 });

    const dependentDeletes = [
      ["support_documents", () => sb.from("support_documents").delete().eq("application_id", applicationId)],
      ["ched_form_input", () => sb.from("ched_form_input").delete().eq("application_id", applicationId)],
      ["ranking_result", () => sb.from("ranking_result").delete().eq("application_id", applicationId)],
      ["scholarship_approval", () => sb.from("scholarship_approval").delete().eq("application_id", applicationId)],
    ] as const;

    for (const [table, remove] of dependentDeletes) {
      const { error } = await remove();
      if (error) {
        return NextResponse.json({
          error: `Could not clean up ${table} for this application: ${error.message}`,
        }, { status: 500 });
      }
    }

    const { data: deleted, error: deleteError } = await sb
      .from("scholarship_applications")
      .delete()
      .eq("application_id", applicationId)
      .select("application_id")
      .maybeSingle();
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
    if (!deleted) return NextResponse.json({ error: "Application was not deleted." }, { status: 500 });

    return NextResponse.json({ ok: true, application_id: applicationId });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not delete the application.",
    }, { status: 500 });
  }
}
