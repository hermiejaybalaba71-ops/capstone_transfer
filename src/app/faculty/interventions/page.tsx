"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface StudentAccountMini {
  given_name: string;
  last_name: string;
  student_number: string;
}

interface ActiveAlertStudent {
  student_id: number;
  warning_id: number;
  risk_level?: string;
  average_grade?: number;
  gpa?: number;
  student_accounts?: StudentAccountMini | StudentAccountMini[];
}

interface SentMessage {
  notification_id: number;
  title?: string;
  message: string;
  date_sent: string;
  notification_type?: string;
  student_accounts?: StudentAccountMini | StudentAccountMini[];
}

function getSa(val: StudentAccountMini | StudentAccountMini[] | undefined): StudentAccountMini | undefined {
  if (!val) return undefined;
  return Array.isArray(val) ? val[0] : val;
}

export default function FacultyInterventionsPage() {
  return (
    <Suspense fallback={<Spinner label="Loading interventions..." color="green" />}>
      <FacultyInterventionsContent />
    </Suspense>
  );
}

function FacultyInterventionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedStudentId = searchParams.get("studentId") || "";

  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [activeStudents, setActiveStudents] = useState<ActiveAlertStudent[]>([]);
  const [recentMessages, setRecentMessages] = useState<SentMessage[]>([]);

  const [targetStudent, setTargetStudent] = useState(preselectedStudentId);
  const [prevSelected, setPrevSelected] = useState(preselectedStudentId);
  if (prevSelected !== preselectedStudentId) {
    setPrevSelected(preselectedStudentId);
    setTargetStudent(preselectedStudentId);
  }
  const [interventionMsg, setInterventionMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      setFatalError("");
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      const { data: meData, error: meErr } = await sb
        .from("users")
        .select("*")
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      if (meErr || !meData) {
        setFatalError("Account not found.");
        setLoading(false);
        return;
      }
      if (meData.role !== "Faculty") {
        setFatalError("Faculty access is required.");
        setLoading(false);
        return;
      }

      const [studentsRes, messagesRes] = await Promise.all([
        sb
          .from("early_warning_alerts")
          .select(
            "student_id, warning_id, risk_level, average_grade, gpa, student_accounts(given_name, last_name, student_number)"
          )
          .eq("status", "Active")
          .order("warning_date", { ascending: false }),
        sb
          .from("notifications_announcements")
          .select(
            "notification_id, title, message, date_sent, notification_type, student_accounts(given_name, last_name, student_number)"
          )
          .in("notification_type", ["Announcement", "Warning"])
          .order("date_sent", { ascending: false })
          .limit(15),
      ]);

      if (!studentsRes.error) {
        const raw = studentsRes.data || [];
        const unique = raw.filter(
          (a: ActiveAlertStudent, i: number, self: ActiveAlertStudent[]) =>
            i === self.findIndex((b) => b.student_id === a.student_id)
        );
        setActiveStudents(unique);
      }
      if (!messagesRes.error) {
        setRecentMessages(messagesRes.data || []);
      }
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  async function handleSendIntervention(e: React.FormEvent) {
    e.preventDefault();
    setSuccessMsg("");
    setErrorMsg("");

    if (!targetStudent) {
      setErrorMsg("Please select an at-risk student first.");
      return;
    }
    if (!interventionMsg.trim()) {
      setErrorMsg("Please write the intervention message.");
      return;
    }

    setSending(true);
    const sb = getSupabase();
    const { error } = await sb.from("notifications_announcements").insert({
      student_id: Number(targetStudent),
      title: "Academic Intervention",
      message: interventionMsg.trim(),
      notification_type: "Warning",
      status: "Unread",
    });
    setSending(false);

    if (error) {
      setErrorMsg(error.message);
      return;
    }

    setSuccessMsg(
      "Intervention sent \u2014 the student will see it in their notifications."
    );
    toast.success("Intervention sent to the student.");
    setInterventionMsg("");
    setTargetStudent("");

    const refreshed = await sb
      .from("notifications_announcements")
      .select(
        "notification_id, title, message, date_sent, notification_type, student_accounts(given_name, last_name, student_number)"
      )
      .in("notification_type", ["Announcement", "Warning"])
      .order("date_sent", { ascending: false })
      .limit(15);
    if (!refreshed.error) {
      setRecentMessages(refreshed.data || []);
    }
  }

  if (loading) return <Spinner label="Loading interventions..." color="green" />;

  if (fatalError) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-sm text-center">
          <p className="text-4xl">&#128683;</p>
          <h1 className="mt-3 text-lg font-bold text-[#241012]">{fatalError}</h1>
          <Link
            href="/"
            className="mt-5 inline-block rounded-lg bg-[#7B1113] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#14532d]"
          >
            Back to home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[#241012]">
          Send Academic Intervention
        </h1>
        <p className="mt-1 text-xs text-[#6B5458]">
          Counsel and support at-risk scholars through targeted notifications.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Left: Send Form */}
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">
            Send Academic Intervention
          </h2>
          <p className="mt-1 text-[11px] text-[#6B5458]">
            Select an at-risk student and compose a counseling message. The
            student will receive it as a notification in their portal.
          </p>

          {successMsg && (
            <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs font-medium text-green-700">
              {successMsg}
            </div>
          )}
          {errorMsg && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleSendIntervention} className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-[#241012]">
                At-Risk Student
              </label>
              <select
                value={targetStudent}
                onChange={(e) => setTargetStudent(e.target.value)}
                className="w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2.5 text-xs outline-none focus:border-[#7B1113] focus:ring-1 focus:ring-[#7B1113]"
              >
                <option value="">Select an at-risk student&hellip;</option>
                {activeStudents.map((s) => (
                  <option key={s.student_id} value={s.student_id}>
                    {getSa(s.student_accounts)?.last_name},{" "}
                    {getSa(s.student_accounts)?.given_name} &mdash; Avg{" "}
                    {s.average_grade ?? s.gpa ?? "\u2014"}% (
                    {s.risk_level || "N/A"} risk)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-[#241012]">
                Intervention Message
              </label>
              <textarea
                value={interventionMsg}
                onChange={(e) => setInterventionMsg(e.target.value)}
                rows={5}
                placeholder="e.g., Hi! We noticed your average dropped below the maintenance grade. Please visit the guidance office to discuss support options..."
                className="w-full rounded-lg border border-[#241012]/15 px-3 py-2 text-xs outline-none focus:border-[#7B1113] focus:ring-1 focus:ring-[#7B1113]"
              />
            </div>

            <button
              type="submit"
              disabled={sending}
              className="w-full rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#14532d] disabled:opacity-60"
            >
              {sending ? "Sending..." : "Send intervention"}
            </button>
          </form>
        </div>

        {/* Right: Recent Messages */}
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">
            Recent Messages Sent
          </h2>
          <p className="mt-1 text-[11px] text-[#6B5458]">
            The latest 15 intervention and warning messages.
          </p>

          {recentMessages.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                icon="&#128172;"
                title="No messages sent yet"
                hint="Interventions and announcements will appear here once you send them."
              />
            </div>
          ) : (
            <ul className="mt-4 max-h-[32rem] space-y-2 overflow-y-auto pr-1">
              {recentMessages.map((msg) => (
                <li
                  key={msg.notification_id}
                  className="rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5] p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold text-[#241012]">
                      {getSa(msg.student_accounts)?.last_name},{" "}
                      {getSa(msg.student_accounts)?.given_name}
                    </p>
                    <span className="text-[10px] text-[#8B7376]">
                      {formatDateTime(msg.date_sent)}
                    </span>
                  </div>
                  {msg.notification_type && (
                    <div className="mt-1">
                      <Badge
                        className={
                          msg.notification_type === "Warning"
                            ? "border-red-200 bg-red-100 text-red-700"
                            : "border-blue-200 bg-blue-100 text-[#7B1113]"
                        }
                      >
                        {msg.notification_type}
                      </Badge>
                    </div>
                  )}
                  <p className="mt-1 line-clamp-2 text-[11px] text-[#6B5458]">
                    {msg.message}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
