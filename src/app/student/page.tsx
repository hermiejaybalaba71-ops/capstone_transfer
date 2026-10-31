"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { queryRegistrar } from "@/lib/supabase/registrar";
import { formatDateTime } from "@/lib/utils";
import { STATUS_STYLES, NOTIFICATION_TYPE_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/ui/stat-card";

interface EarlyWarningAlert {
  warning_id: number;
  student_id: number;
  status: string;
  risk_level?: string;
  warning_message?: string;
  gpa?: number;
  average_grade?: number;
  warning_date: string;
}

interface Notification {
  notification_id: number;
  student_id?: number;
  title?: string;
  message: string;
  notification_type?: string;
  date_sent: string;
  is_read?: boolean;
  status?: string;
}

interface AppItem {
  application_id: number;
  application_status?: string;
  application_date?: string;
  scholarship_programs?: { scholarship_name?: string };
}

interface Stats {
  activePrograms: number;
  myApplications: number;
  unreadNotifications: number;
  academicRecords: number;
}

const statusNotes: Record<string, { note: string; hint: string }> = {
  Pending: { note: "Your application is being reviewed.", hint: "You will be notified once a decision is made." },
  Approved: { note: "Congratulations! Your application has been approved.", hint: "See your scholarship status for the next steps." },
  "Not Approved": { note: "Your application was not approved this time.", hint: "You may contact the scholarship office for more details." },
};

function statusNote(status: string) {
  return statusNotes[status] || { note: "Your application is being reviewed.", hint: "You will be notified once a decision is made." };
}

export default function StudentDashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [verified, setVerified] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [stats, setStats] = useState<Stats>({ activePrograms: 0, myApplications: 0, unreadNotifications: 0, academicRecords: 0 });
  const [alerts, setAlerts] = useState<EarlyWarningAlert[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [applications, setApplications] = useState<AppItem[]>([]);
  const [studentId, setStudentId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      setFatalError("");

      const sb = getSupabase();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) {
        router.push("/login");
        return;
      }

      const { data: authUser } = await sb.auth.getUser();
      const authUserId = authUser.user?.id;
      if (!authUserId) {
        setFatalError("Your session is invalid. Please log in again.");
        setLoading(false);
        return;
      }

      try {
      const userQuery = await sb
        .from("users")
        .select("user_id")
        .eq("auth_user_id", authUserId)
        .maybeSingle();

      if (userQuery.error || !userQuery.data) {
        setFatalError("Could not find your user record. Please contact the Scholarship Office.");
        setLoading(false);
        return;
      }

      const accountQuery = await sb
        .from("student_accounts")
        .select("student_id")
        .eq("user_id", userQuery.data.user_id)
        .maybeSingle();

      if (accountQuery.error || !accountQuery.data) {
        setFatalError("Could not find your student account.");
        setLoading(false);
        return;
      }

      const sid = accountQuery.data.student_id;
      setStudentId(sid);

      const [
        programsQuery,
        applicationsQuery,
        notificationsQuery,
        alertsQuery,
        acadsQuery,
        studentProfile,
      ] = await Promise.all([
        sb
          .from("scholarship_programs")
          .select("scholarship_id")
          .eq("status", "Open"),
        sb
          .from("scholarship_applications")
          .select("application_id, application_status, application_date, scholarship_programs(scholarship_name)")
          .eq("student_id", sid)
          .order("application_date", { ascending: false }),
        sb
          .from("notifications_announcements")
          .select("*")
          .eq("student_id", sid)
          .order("date_sent", { ascending: false }),
        sb
          .from("early_warning_alerts")
          .select("*")
          .eq("student_id", sid)
          .eq("status", "Active")
          .order("warning_date", { ascending: false }),
        sb
          .from("support_academic_records")
          .select("record_id")
          .eq("student_id", sid),
        sb
          .from("student_accounts")
          .select("student_id, student_number, given_name, last_name")
          .eq("student_id", sid)
          .maybeSingle(),
      ]);

      if (studentProfile.data) {
        const { student_number, given_name } = studentProfile.data as { student_number?: string | null; given_name?: string | null };
        setFirstName(given_name || "");
        if (student_number) {
          const reg = await queryRegistrar<{ student_number: string }>((rsb) =>
            rsb
              .from("registrar_students")
              .select("student_number")
              .eq("student_number", student_number)
              .maybeSingle()
          );
          const matched = !!reg.data;
          setVerified(matched);
          if (matched) {
            await sb.from("student_accounts").update({ registration_status: "Verified" }).eq("student_id", sid);
          }
        } else {
          setVerified(false);
        }
      }

      const loadedNotifications = (notificationsQuery.data || []) as Notification[];
      const unreadCount = loadedNotifications.filter((n) => n.status === "Unread").length;

      setStats({
        activePrograms: programsQuery.data?.length || 0,
        myApplications: applicationsQuery.data?.length || 0,
        unreadNotifications: unreadCount,
        academicRecords: acadsQuery.data?.length || 0,
      });

      setAlerts((alertsQuery.data || []) as EarlyWarningAlert[]);
      setNotifications(loadedNotifications.slice(0, 5));
      setApplications((applicationsQuery.data || []) as AppItem[]);

      if (!ignore) setLoading(false);
      } catch {
        if (!ignore) {
          setFatalError("Failed to load your dashboard. Please try again.");
          setLoading(false);
        }
      }
    }
    startFetching();
    return () => { ignore = true; };
  }, [router, reloadKey]);

  // Live-refresh dashboard so CHED/admin approval updates appear without a manual reload.
  useEffect(() => {
    if (!studentId) return;
    const sb = getSupabase();
    const channel = sb
      .channel(`student-dash-${studentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications_announcements", filter: `student_id=eq.${studentId}` },
        () => setReloadKey((k) => k + 1)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scholarship_applications", filter: `student_id=eq.${studentId}` },
        () => setReloadKey((k) => k + 1)
      )
      .subscribe();

    const poll = window.setInterval(() => setReloadKey((k) => k + 1), 30000);
    return () => {
      sb.removeChannel(channel);
      window.clearInterval(poll);
    };
  }, [studentId]);

  // Keep header unread badge fresh even before this page's first load finishes.
  useEffect(() => {
    if (!studentId) return;
    let cancelled = false;
    const sb = getSupabase();
    async function refreshBadge() {
      const { data } = await sb
        .from("notifications_announcements")
        .select("notification_id, status")
        .eq("student_id", studentId!);
      if (cancelled || !data) return;
      const unread = data.filter((n) => n.status === "Unread").length;
      setStats((s) => ({ ...s, unreadNotifications: unread }));
    }
    refreshBadge();
    const id = window.setInterval(refreshBadge, 30000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [studentId]);

  async function handleVerify() {
    setVerifying(true);
    const sb = getSupabase();
    const { data: authUser } = await sb.auth.getUser();
    const uid = authUser.user?.id;
    if (!uid) { setVerifying(false); return; }
    const userQ = await sb.from("users").select("user_id").eq("auth_user_id", uid).maybeSingle();
    if (!userQ.data) { setVerifying(false); return; }
    const studentQ = await sb.from("student_accounts").select("student_id, student_number, given_name, last_name").eq("user_id", userQ.data.user_id).maybeSingle();
    if (!studentQ.data) { setVerifying(false); return; }
    const { student_id, student_number } = studentQ.data;
    if (!student_number) {
      setVerified(false);
      setVerifying(false);
      return;
    }
    const reg = await queryRegistrar<{ student_number: string }>((rsb) =>
      rsb
        .from("registrar_students")
        .select("student_number")
        .eq("student_number", student_number)
        .maybeSingle()
    );
    const verified = !!reg.data;
    setVerified(verified);
    if (verified) {
      await sb.from("student_accounts").update({ registration_status: "Verified" }).eq("student_id", student_id);
    }
    setVerifying(false);
  }

  if (loading) {
    return <Spinner label="Loading dashboard..." />;
  }

  const currentStatus = applications[0]?.application_status || "";
  const nearby = applications[0];

  if (fatalError) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-bold text-red-700">Something went wrong</p>
          <p className="mt-2 text-sm text-red-600">{fatalError}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-2xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
        <h1 className="text-xl font-bold text-[#241012]">
          {firstName ? <>Welcome back, {firstName}!</> : <>Welcome back!</>}
        </h1>
        <p className="mt-1 text-xs text-[#6B5458]">
          Here is a quick look at your scholarship journey and any updates for you.
        </p>
      </div>

      {verified === false && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800 shadow-sm">
          <span>Your account is not yet verified. Please visit the Registrar&rsquo;s Office or click Verify to check your records.</span>
          <button
            onClick={handleVerify}
            disabled={verifying}
            className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-[11px] font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            {verifying ? "Verifying..." : "Verify again"}
          </button>
        </div>
      )}

      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active Programs" value={stats.activePrograms} />
        <StatCard label="My Applications" value={stats.myApplications} />
        <StatCard label="Unread Notifications" value={stats.unreadNotifications} />
        <StatCard label="Academic Records" value={stats.academicRecords} />
      </section>

      {currentStatus && (
        <section className="mt-6">
          <div className="rounded-2xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7376]">Your Scholarship Status</p>
                <h2 className="mt-1 text-base font-bold text-[#241012]">
                  {nearby?.scholarship_programs?.scholarship_name || "Scholarship Application"}
                </h2>
                <p className="mt-1 text-xs text-[#6B5458]">{statusNote(currentStatus).note}</p>
              </div>
              <Badge className={STATUS_STYLES[currentStatus] || ""}>{currentStatus}</Badge>
            </div>
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-[10px] text-[#8B7376]">
                <span>Pending</span>
                <span>Approved</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[#F3EEEB]">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    currentStatus === "Approved" ? "bg-green-500" : currentStatus === "Not Approved" ? "bg-red-500" : "bg-amber-500"
                  }`}
                  style={{ width: `${currentStatus === "Approved" ? 100 : currentStatus === "Not Approved" ? 33 : 50}%` }}
                />
              </div>
              <div className="mt-2 flex items-center gap-4 text-[10px] text-[#6B5458]">
                {["Pending", "Approved", "Not Approved"].map((step) => {
                  const isActive = step === currentStatus;
                  const isDone = currentStatus === "Approved" && step === "Pending";
                  return (
                    <span key={step} className="flex items-center gap-1">
                      <span className={`h-1.5 w-1.5 rounded-full ${isActive ? "bg-[#7B1113]" : isDone ? "bg-green-500" : "bg-gray-300"}`} />
                      <span className={isActive ? "font-semibold text-[#241012]" : ""}>{step}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-bold text-[#241012]">My Scholarship Applications</h2>
        {applications.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon="🎓"
              title="No applications yet"
              hint="Apply to an open scholarship program to get started."
            />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {applications.map((app) => {
              const info =
                statusNotes[app.application_status || ""] ||
                { note: "Your application is being reviewed.", hint: "You will be notified once a decision is made." };
              return (
                <div
                  key={app.application_id}
                  className="rounded-xl border border-[#241012]/[0.06] bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-[#241012]">
                        {app.scholarship_programs?.scholarship_name || "Scholarship Application"}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[#6B5458]">
                        Submitted {formatDateTime(app.application_date)}
                      </p>
                    </div>
                    <Badge className={STATUS_STYLES[app.application_status || ""] || ""}>
                      {app.application_status || "Pending"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-[#241012]">{info.note}</p>
                  <p className="mt-0.5 text-[11px] text-[#6B5458]">{info.hint}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-bold text-[#241012]">Active Early Warning Alerts</h2>
        {alerts.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon="✅"
              title="No active alerts"
              hint="Your academic standing is on track."
            />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {alerts.map((alert) => (
              <div
                key={alert.warning_id}
                className="rounded-xl border border-red-200 bg-red-50 p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={STATUS_STYLES["Active"] || ""}>
                    {alert.status}
                  </Badge>
                  {alert.risk_level && (
                    <span className="text-xs font-bold text-red-700">
                      Risk: {alert.risk_level}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-[#6B5458]">
                    {formatDateTime(alert.warning_date)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-[#241012]">{alert.warning_message}</p>
                <div className="mt-2 flex gap-4 text-xs text-[#6B5458]">
                  {alert.gpa != null && (
                    <span>
                      GPA: <strong>{alert.gpa}</strong>
                    </span>
                  )}
                  {alert.average_grade != null && (
                    <span>
                      Average: <strong>{alert.average_grade}%</strong>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-bold text-[#241012]">Recent Notifications</h2>
        {notifications.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon="🔔"
              title="No notifications yet"
              hint="You will see updates here when available."
            />
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {notifications.map((n) => (
              <div
                key={n.notification_id}
                className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs ${n.status === "Unread" ? "font-bold text-[#241012]" : "text-[#6B5458]"}`}>
                      {n.title || "Notification"}
                    </p>
                    <p className="mt-1 text-xs text-[#6B5458]">{n.message}</p>
                    <p className="mt-1 text-[11px] text-[#8B7376]">{formatDateTime(n.date_sent)}</p>
                  </div>
                  {n.notification_type && (
                    <Badge className={NOTIFICATION_TYPE_STYLES[n.notification_type] || ""}>
                      {n.notification_type}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
