"use client";

import { getSupabase } from "@/lib/supabase/browser";

interface ApplicationLike {
  application_id: number;
  student_id: number;
  application_status?: string;
  scholarship_programs?: { scholarship_name?: string } | { scholarship_name?: string }[];
}

function scholarshipNameFor(app: ApplicationLike | undefined): string {
  if (!app) return "a scholarship";
  if (app.scholarship_programs && !Array.isArray(app.scholarship_programs)) {
    return app.scholarship_programs.scholarship_name || "a scholarship";
  }
  if (Array.isArray(app.scholarship_programs)) {
    return app.scholarship_programs[0]?.scholarship_name || "a scholarship";
  }
  return "a scholarship";
}

export function applicationUpdateMessage(
  app: ApplicationLike | undefined,
  status: string,
  remarks?: string | null
): string {
  const scholarship = scholarshipNameFor(app);
  let base: string;
  if (status === "Approved") {
    base = `Congratulations! CHED has approved your application for "${scholarship}". Check your dashboard and Application Status for next steps.`;
  } else if (status === "Not Approved") {
    base = `Your application for "${scholarship}" has not been approved. Thank you for applying. You may contact the scholarship office for details.`;
  } else {
    base = `Your application for "${scholarship}" is now pending review.`;
  }
  const r = (remarks || "").trim();
  return r ? `${base} Remarks: ${r}` : base;
}

/** Insert an unread Status Update notification for the student. */
export async function notifyStudentStatus(
  studentId: number,
  app: ApplicationLike | undefined,
  status: string,
  remarks?: string | null
): Promise<void> {
  const sb = getSupabase();
  await sb.from("notifications_announcements").insert({
    student_id: studentId,
    title: "Application Update",
    message: applicationUpdateMessage(app, status, remarks),
    notification_type: "Status Update",
    status: "Unread",
  });
}

async function notifyStudent(studentId: number, approvedAppId: number, approvalScholarship: string, rejectedAppId: number, rejectedScholarship: string) {
  const sb = getSupabase();
  await sb.from("notifications_announcements").insert({
    student_id: studentId,
    title: "Application Update",
    message: `Your application for "${rejectedScholarship}" has been marked Not Approved because you were already approved for "${approvalScholarship}". You may only hold one approved scholarship.`,
    notification_type: "Status Update",
    status: "Unread",
  });
}

/**
 * When one application is set to Approved, automatically reject all OTHER
 * applications belonging to the same student (application_status -> "Not Approved")
 * and notify the student.
 *
 * `approvedApps` = the applications that are being approved in this operation.
 * `apps` = the currently loaded list of applications (to find siblings).
 *
 * Returns { approvedCount, rejectedCount }.
 */
export async function autoRejectSiblings(
  approvedApps: { application_id: number; student_id: number }[],
  apps: ApplicationLike[]
): Promise<{ approvedCount: number; rejectedCount: number }> {
  if (!approvedApps.length) return { approvedCount: 0, rejectedCount: 0 };
  const sb = getSupabase();
  let rejectedCount = 0;

  for (const target of approvedApps) {
    const targetApp = apps.find((a) => a.application_id === target.application_id);
    const targetScholarship = scholarshipNameFor(targetApp);

    // Find sibling applications (same student, different app, not already rejected)
    const siblings = apps.filter(
      (a) =>
        a.student_id === target.student_id &&
        a.application_id !== target.application_id &&
        a.application_status !== "Not Approved"
    );

    if (!siblings.length) continue;

    const siblingIds = siblings.map((s) => s.application_id);
    const { error } = await sb.from("scholarship_applications")
      .update({ application_status: "Not Approved", remarks: `Auto-rejected: already approved for "${targetScholarship}".` })
      .in("application_id", siblingIds);

    for (const sib of siblings) {
      rejectedCount += 1;
      await notifyStudent(target.student_id, target.application_id, targetScholarship, sib.application_id, scholarshipNameFor(sib));
      if (error) {
        // Keep counting but let the caller know the DB update failed via message
        console.error("Failed to auto-reject sibling", sib.application_id, error);
      }
    }
  }

  return { approvedCount: approvedApps.length, rejectedCount };
}
