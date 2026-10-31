import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public, read-only counters for the landing page.
 * Uses the service-role key server-side so anonymous visitors can see
 * that the system is live without any RLS access to the tables.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return NextResponse.json({ ok: false, stats: null }, { status: 503 });
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const count = async (table: string, filter?: { column: string; value: string }) => {
    try {
      let q = sb.from(table).select("*", { count: "exact", head: true });
      if (filter) q = q.eq(filter.column, filter.value);
      const { count: n } = await q;
      return n ?? 0;
    } catch {
      return 0;
    }
  };

  const [programs, applications, scholars, students] = await Promise.all([
    count("scholarship_programs", { column: "status", value: "Open" }),
    count("scholarship_applications"),
    count("scholarship_approval", { column: "approval_status", value: "Approved" }),
    count("student_accounts"),
  ]);

  return NextResponse.json({
    ok: true,
    stats: { programs, applications, scholars, students },
    generatedAt: new Date().toISOString(),
  });
}
