import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Buckets the app is allowed to open storage objects in.
const ALLOWED_BUCKETS = new Set(["itr-documents", "support-documents", "academic-records"]);

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

// Verifies the caller is a logged-in Supabase user; optionally checks role.
async function assertAccess(req: Request, requiredRole?: "Admin"): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const token = getToken(req);
  if (!token) return { ok: false, error: "Not authenticated." };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return { ok: false, error: "Session expired. Please log in again." };

  if (requiredRole) {
    const { data: row, error: roleErr } = await userClient
      .from("users")
      .select("role")
      .eq("auth_user_id", data.user.id)
      .maybeSingle();
    if (roleErr || !row || row.role !== requiredRole) {
      return { ok: false, error: `Only ${requiredRole.toLowerCase()}s can do this.` };
    }
  }
  return { ok: true, userId: data.user.id };
}

function serviceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// POST /api/storage/signed-url  { bucket: string, paths: string[] }
// Returns short-lived signed URLs for storage objects, using the service key
// so uploaded files can be viewed/downloaded even when a bucket lacks a
// storage RLS policy (e.g. itr-documents).
export async function POST(req: Request) {
  try {
    const access = await assertAccess(req);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: 401 });

    const body = (await req.json()) as { bucket?: string; paths?: unknown };
    const bucket = String(body.bucket || "");
    if (!ALLOWED_BUCKETS.has(bucket)) {
      return NextResponse.json({ error: `Bucket not allowed: ${bucket}` }, { status: 400 });
    }
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (!paths.length) {
      return NextResponse.json({ error: "At least one file path is required." }, { status: 400 });
    }

    const sb = serviceClient();
    if (!sb) {
      return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
    }

    const { data, error } = await sb.storage.from(bucket).createSignedUrls(paths, 3600);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const urls: Record<string, string> = {};
    for (const item of data || []) {
      const signed = (item as { signedUrl?: string; signedURL?: string; path?: string })?.signedUrl
        ?? (item as { signedURL?: string })?.signedURL;
      if (signed && item?.path) urls[item.path] = signed;
    }
    return NextResponse.json({ ok: true, urls });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Signed URL failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/storage/signed-url  { bucket: string, path: string }
// Admin-only storage object removal (record row deletion is done client-side
// under normal RLS policies; this just cleans the file bytes from storage).
export async function DELETE(req: Request) {
  try {
    const access = await assertAccess(req, "Admin");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: 401 });

    const body = (await req.json()) as { bucket?: string; path?: string };
    const bucket = String(body.bucket || "");
    const path = String(body.path || "");
    if (!ALLOWED_BUCKETS.has(bucket) || !path) {
      return NextResponse.json({ error: "bucket and path are required." }, { status: 400 });
    }

    const sb = serviceClient();
    if (!sb) {
      return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
    }

    const { error } = await sb.storage.from(bucket).remove([path]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Storage delete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
