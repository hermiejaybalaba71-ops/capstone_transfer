import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createRegistrarClient } from "@/lib/supabase/registrar";

export const runtime = "nodejs";

const MAINTAINING_GRADE_PCT = 93;

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

async function assertFaculty(req: Request) {
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
    .select("role")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();

  if (roleErr) return "Could not verify your role.";
  if (!row || (row.role !== "Faculty" && row.role !== "Admin")) {
    return "Faculty access is required.";
  }
  return true;
}

export async function POST(req: Request) {
  try {
    const auth = await assertFaculty(req);
    if (auth !== true) {
      return NextResponse.json({ error: auth }, { status: 401 });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return NextResponse.json(
        { error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." },
        { status: 500 }
      );
    }

    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: students, error: stErr } = await sb
      .from("student_accounts")
      .select("student_id, student_number, given_name, last_name, registration_status")
      .eq("registration_status", "Verified");

    if (stErr) {
      return NextResponse.json({ error: stErr.message }, { status: 500 });
    }
    if (!students?.length) {
      return NextResponse.json({
        created: 0,
        notified: 0,
        scanned: 0,
        message: "No verified students found.",
      });
    }

    const registrar = createRegistrarClient();
    let alertsCreated = 0;
    let studentsNotified = 0;
    let scanned = 0;

    for (const student of students) {
      if (!student.student_number) continue;

      const { data: regStudent } = await registrar
        .from("registrar_students")
        .select("student_id")
        .eq("student_number", student.student_number)
        .maybeSingle();
      if (!regStudent) continue;

      const { data: subjects } = await registrar
        .from("registrar_student_subjects")
        .select("grade, units")
        .eq("student_id", regStudent.student_id);
      if (!subjects?.length) continue;

      let totalUnits = 0;
      let totalWeighted = 0;
      let validGrades = 0;
      for (const s of subjects) {
        const grade = Number(s.grade);
        if (s.grade == null || Number.isNaN(grade)) continue;
        const units = Number(s.units) || 3;
        totalWeighted += grade * units;
        totalUnits += units;
        validGrades++;
      }
      if (totalUnits === 0 || validGrades === 0) continue;

      scanned++;
      const avgGrade = totalWeighted / totalUnits;
      const percentage = ((5 - avgGrade) / 4) * 100;
      if (percentage >= MAINTAINING_GRADE_PCT) continue;

      const riskLevel = percentage < 80 ? "High" : percentage < 90 ? "Medium" : "Low";
      const message = `Academic average of ${percentage.toFixed(1)}% is below the ${MAINTAINING_GRADE_PCT}% maintaining grade requirement.`;

      const { data: existing } = await sb
        .from("early_warning_alerts")
        .select("warning_id")
        .eq("student_id", student.student_id)
        .eq("status", "Active")
        .maybeSingle();

      if (!existing) {
        const { error: insErr } = await sb.from("early_warning_alerts").insert({
          student_id: student.student_id,
          status: "Active",
          risk_level: riskLevel,
          warning_message: message,
          gpa: Number(avgGrade.toFixed(2)),
          average_grade: Number(percentage.toFixed(1)),
        });
        if (insErr) {
          return NextResponse.json({ error: insErr.message }, { status: 500 });
        }
        alertsCreated++;

        await sb.from("notifications_announcements").insert({
          student_id: student.student_id,
          title: "Early Warning - Below Maintaining Grade",
          message: `${message} Please coordinate with your faculty adviser / Scholarship Office to avoid suspension of benefits.`,
          notification_type: "Warning",
          status: "Unread",
        });
        studentsNotified++;
      }
    }

    const message = alertsCreated > 0
      ? `Scan complete. ${alertsCreated} new early warning alert(s) created for students below ${MAINTAINING_GRADE_PCT}% — ${studentsNotified} student(s) notified.`
      : `Scan complete. ${scanned} student(s) scanned — all are at or above the ${MAINTAINING_GRADE_PCT}% maintaining grade (or already have an active alert).`;

    return NextResponse.json({ created: alertsCreated, notified: studentsNotified, scanned, message });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Scan failed." },
      { status: 500 }
    );
  }
}
