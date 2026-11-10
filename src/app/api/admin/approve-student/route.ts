import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createRegistrarClient } from "@/lib/supabase/registrar";

export const runtime = "nodejs";

const MAINTAINING_GRADE_PCT = 93;

/* ------------------------------------------------------------------ *
 * Auth helpers — same pattern as /api/admin/delete-user
 * ------------------------------------------------------------------ */
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
    .select("role")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();

  if (roleErr) return "Could not verify admin role.";
  if (!row || row.role !== "Admin") return "Only admins can approve students.";
  return true;
}

/* ------------------------------------------------------------------ *
 * Simulated registrar data generation
 * ------------------------------------------------------------------ */
type SubjectTuple = [code: string, name: string, units: number];

const SUBJECTS_BY_YEAR: Record<string, SubjectTuple[]> = {
  "1st Year": [
    ["IT011", "Introduction to Computing", 3],
    ["IT012", "Computer Programming 1", 3],
    ["GE011", "Purposive Communication", 3],
    ["GE012", "Mathematics in the Modern World", 3],
    ["GE013", "Understanding the Self", 3],
    ["GE014", "Ethics", 3],
    ["PE011", "Physical Fitness", 2],
    ["PE012", "Rhythmic Activities", 2],
  ],
  "2nd Year": [
    ["IT211", "Web Systems and Technologies", 3],
    ["IT212", "Database Systems", 3],
    ["IT213", "Object-Oriented Programming", 3],
    ["GE221", "Purposive Communication", 3],
    ["GE222", "Mathematics in the Modern World", 3],
    ["GE224", "Ethics", 3],
    ["PE221", "Physical Fitness", 2],
    ["PE222", "Rhythmic Activities", 2],
  ],
  "3rd Year": [
    ["IT301", "Data Structures and Algorithms", 3],
    ["IT302", "Operating Systems", 3],
    ["IT303", "Software Engineering", 3],
    ["GE321", "Purposive Communication", 3],
    ["GE322", "Mathematics in the Modern World", 3],
    ["GE323", "Ethics", 3],
    ["PE321", "Physical Fitness", 2],
    ["PE322", "Rhythmic Activities", 2],
  ],
  "4th Year": [
    ["CS401", "Capstone Project", 3],
    ["CS402", "Computer Networks", 3],
    ["CS403", "Information Assurance and Security", 3],
    ["IT401", "Advanced Web Systems", 3],
    ["IT402", "Machine Learning Fundamentals", 3],
    ["GE401", "The Life and Works of Rizal", 3],
    ["PE401", "Physical Fitness", 2],
    ["PE402", "Rhythmic Activities", 2],
  ],
};

const DEFAULT_SUBJECTS = SUBJECTS_BY_YEAR["3rd Year"];

/** FNV-1a — stable seed so re-approving the same student yields the same grades. */
function seedFrom(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * PH grading scale: 1.00 (best) ... 5.00 (failing).
 * percentage = ((5 - gpa) / 4) * 100  ->  gpa must be <= 1.28 to clear 93%.
 * ~30% of generated students land below the maintaining grade so the
 * Early-Warning feature has real data to scan.
 */
function generateSubjects(studentNumber: string, yearLevel?: string | null) {
  const template = SUBJECTS_BY_YEAR[yearLevel || ""] || DEFAULT_SUBJECTS;
  const rnd = mulberry32(seedFrom(studentNumber));
  const atRisk = rnd() < 0.3;

  return template.map(([code, name, units]) => {
    const grade = atRisk
      ? round2(1.75 + Math.floor(rnd() * 6) * 0.25) // 1.75 - 3.00
      : rnd() < 0.6
        ? 1.0
        : 1.25; // 1.00 / 1.25 -> comfortably above 93%
    return { subject_code: code, subject_name: name, grade, units };
  });
}

function computeGpa(subjects: { grade: number; units: number }[]) {
  let weighted = 0;
  let units = 0;
  for (const s of subjects) {
    weighted += Number(s.grade) * Number(s.units);
    units += Number(s.units);
  }
  const gpa = units > 0 ? weighted / units : 0;
  const percentage = ((5 - gpa) / 4) * 100;
  return { gpa: round2(gpa), percentage: round2(percentage) };
}

/** August-December = 1st semester of AY y-(y+1); January-July = 2nd semester. */
function currentTerm() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 8
    ? { academic_year: `${y}-${y + 1}`, semester: "1st Semester" }
    : { academic_year: `${y - 1}-${y}`, semester: "2nd Semester" };
}

/* ------------------------------------------------------------------ *
 * POST /api/admin/approve-student
 * ------------------------------------------------------------------ */
export async function POST(req: Request) {
  try {
    const auth = await assertAdmin(req);
    if (auth !== true) {
      return NextResponse.json({ error: auth }, { status: 401 });
    }

    const body = (await req.json()) as { user_id?: number };
    const userId = Number(body.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return NextResponse.json({ error: "user_id is required." }, { status: 400 });
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

    /* ---- 1. Load the registered account (main database) ---- */
    const { data: student, error: stErr } = await sb
      .from("student_accounts")
      .select(
        "student_id, user_id, student_number, given_name, middle_name, last_name, ext_name, sex, birthdate, program_name, year_level, registration_status"
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (stErr) {
      return NextResponse.json({ error: stErr.message }, { status: 500 });
    }
    if (!student) {
      return NextResponse.json(
        { error: "No student record is linked to this account." },
        { status: 404 }
      );
    }

    const studentNumber = (student.student_number || "").trim();
    if (!studentNumber) {
      return NextResponse.json(
        {
          error:
            "This account has no student number. Click Edit, add a student number, then approve again.",
        },
        { status: 400 }
      );
    }

    const fullName = [student.last_name, student.given_name, student.middle_name, student.ext_name]
      .filter(Boolean)
      .join(", ");

    /* ---- 2. Simulated registrar record ---- */
    const registrar = createRegistrarClient();
    const { data: existing, error: lookErr } = await registrar
      .from("registrar_students")
      .select("student_id, registration_status")
      .eq("student_number", studentNumber)
      .maybeSingle();

    if (lookErr) {
      return NextResponse.json(
        {
          error: `Registrar lookup failed: ${lookErr.message}. Run db/registrar-approve-policy.sql in the Registrar Supabase SQL Editor.`,
        },
        { status: 502 }
      );
    }

    let registrarStudentId: number | null = existing?.student_id ?? null;
    let createdStudent = false;

    if (!registrarStudentId) {
      const { data: inserted, error: insErr } = await registrar
        .from("registrar_students")
        .insert({
          student_number: studentNumber,
          last_name: student.last_name || null,
          given_name: student.given_name || null,
          middle_name: student.middle_name || null,
          ext_name: student.ext_name || null,
          sex: student.sex || null,
          birthdate: student.birthdate || null,
          program_name: student.program_name || null,
          year_level: student.year_level || null,
          registration_status: "Enrolled",
        })
        .select("student_id")
        .maybeSingle();

      if (insErr || !inserted) {
        return NextResponse.json(
          {
            error: `Could not create the simulated registrar record: ${
              insErr?.message || "no row returned"
            }. Run db/registrar-approve-policy.sql in the Registrar Supabase SQL Editor.`,
          },
          { status: 502 }
        );
      }
      registrarStudentId = inserted.student_id;
      createdStudent = true;
    } else if (existing?.registration_status !== "Enrolled") {
      await registrar
        .from("registrar_students")
        .update({ registration_status: "Enrolled" })
        .eq("student_id", registrarStudentId);
    }

    /* ---- 3. Enrollment row ---- */
    const term = currentTerm();
    const { data: enrollment } = await registrar
      .from("registrar_enrollment")
      .select("enrollment_id")
      .eq("student_id", registrarStudentId)
      .limit(1);

    if (!enrollment?.length) {
      const { error: enErr } = await registrar.from("registrar_enrollment").insert({
        student_id: registrarStudentId,
        academic_year: term.academic_year,
        semester: term.semester,
        enrollment_status: "Enrolled",
      });
      if (enErr) {
        return NextResponse.json(
          { error: `Could not create the enrollment row: ${enErr.message}.` },
          { status: 502 }
        );
      }
    }

    /* ---- 4. Subjects + grades + GPA ---- */
    const { data: haveSubjects, error: subLookErr } = await registrar
      .from("registrar_student_subjects")
      .select("subject_code")
      .eq("student_id", registrarStudentId);

    if (subLookErr) {
      return NextResponse.json(
        { error: `Could not read subjects: ${subLookErr.message}.` },
        { status: 502 }
      );
    }

    let subjects = generateSubjects(studentNumber, student.year_level);
    let createdSubjects = 0;

    if (!haveSubjects?.length) {
      const { error: subErr } = await registrar
        .from("registrar_student_subjects")
        .insert(subjects.map((s) => ({ ...s, student_id: registrarStudentId })));

      if (subErr) {
        return NextResponse.json(
          { error: `Could not generate subjects/grades: ${subErr.message}.` },
          { status: 502 }
        );
      }
      createdSubjects = subjects.length;
    } else {
      const { data: rows } = await registrar
        .from("registrar_student_subjects")
        .select("grade, units")
        .eq("student_id", registrarStudentId);
      subjects = (rows || []) as typeof subjects;
    }

    const { gpa, percentage } = computeGpa(subjects);

    /* ---- 5. Mark the account Verified (main database) ---- */
    const { error: verifyErr } = await sb
      .from("student_accounts")
      .update({ registration_status: "Verified" })
      .eq("student_id", student.student_id);

    if (verifyErr) {
      return NextResponse.json({ error: verifyErr.message }, { status: 500 });
    }

    /* ---- 5b. Auto-notify the student (best-effort, never blocks approval).
       The student sees this on their dashboard the moment it lands — the
       dashboard subscribes to notifications_announcements in realtime. ---- */
    try {
      await sb.from("notifications_announcements").insert({
        student_id: student.student_id,
        title: "Account Approved",
        message:
          `Your scholarship account has been approved${fullName ? ` for ${fullName}` : ""} (${studentNumber}). You can now sign in and submit applications. Track every update on your dashboard.`,
        notification_type: "Status Update",
        status: "Unread",
      });
    } catch {
      // Notification is a convenience — approval itself already succeeded.
    }

    /* ---- 6. Report ---- */
    const passing = percentage >= MAINTAINING_GRADE_PCT;
    const message = [
      `Approved — ${fullName || studentNumber} (${studentNumber}) can now apply for scholarships.`,
      createdStudent
        ? `Simulated registrar record created (${student.program_name || "—"}, ${student.year_level || "—"}).`
        : "Existing simulated registrar record linked.",
      `${subjects.length} subjects generated, GPA ${gpa.toFixed(2)} (${percentage.toFixed(1)}%) — ${
        passing ? "above" : "below"
      } the ${MAINTAINING_GRADE_PCT}% maintaining grade.`,
    ].join(" ");

    return NextResponse.json({
      ok: true,
      student_number: studentNumber,
      full_name: fullName,
      program_name: student.program_name || null,
      year_level: student.year_level || null,
      registrar_student_id: registrarStudentId,
      created_student: createdStudent,
      subjects_created: createdSubjects,
      subject_count: subjects.length,
      gpa,
      percentage,
      at_risk: !passing,
      message,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Approval failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
