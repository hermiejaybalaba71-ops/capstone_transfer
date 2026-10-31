"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime } from "@/lib/utils";
import { STATUS_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/ui/stat-card";

interface ScholarshipApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_date: string;
  application_status: string;
  scholarship_programs?: { scholarship_name: string };
  student_accounts?: { given_name: string; last_name: string; student_number: string };
}

interface EarlyWarningAlert {
  warning_id: number;
  student_id: number;
  status: string;
  risk_level?: string;
  warning_message?: string;
  warning_date: string;
  student_accounts?: { given_name: string; last_name: string; student_number: string };
}

export default function AdminDashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  const [totalStudents, setTotalStudents] = useState(0);
  const [pendingApps, setPendingApps] = useState(0);
  const [approvedScholars, setApprovedScholars] = useState(0);
  const [activeAlerts, setActiveAlerts] = useState(0);

  const [recentApplications, setRecentApplications] = useState<ScholarshipApplication[]>([]);
  const [recentAlerts, setRecentAlerts] = useState<EarlyWarningAlert[]>([]);
  const [recentNotices, setRecentNotices] = useState<
    { notification_id: number; title: string; message: string; notification_type: string; date_sent: string; student_accounts?: { given_name: string; last_name: string } | null }[]
  >([]);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [
        studentsQ,
        appsQ,
        approvalsQ,
        alertsQ,
        recentAppsQ,
        recentAlertsQ,
        noticesQ,
      ] = await Promise.all([
        sb.from("student_accounts").select("student_id", { count: "exact", head: true }),
        sb.from("scholarship_applications").select("*").eq("application_status", "Pending"),
        sb.from("scholarship_approval").select("approval_id", { count: "exact", head: true }),
        sb.from("early_warning_alerts").select("*").eq("status", "Active"),
        sb.from("scholarship_applications")
          .select("*, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number)")
          .order("application_date", { ascending: false })
          .limit(10),
        sb.from("early_warning_alerts")
          .select("*, student_accounts(given_name, last_name, student_number)")
          .order("warning_date", { ascending: false })
          .limit(5),
        sb.from("notifications_announcements")
          .select("notification_id, title, message, notification_type, date_sent, student_accounts(given_name, last_name)")
          .in("notification_type", ["Announcement", "Status Update"])
          .order("date_sent", { ascending: false })
          .limit(6),
      ]);

      setTotalStudents(studentsQ.count ?? 0);
      setPendingApps(appsQ.data?.length ?? 0);
      setApprovedScholars(approvalsQ.count ?? 0);
      setActiveAlerts(alertsQ.data?.length ?? 0);

      if (!recentAppsQ.error) setRecentApplications(recentAppsQ.data || []);
      if (!recentAlertsQ.error) setRecentAlerts(recentAlertsQ.data || []);
      if (!noticesQ.error) {
        const rows = (noticesQ.data || []) as {
          notification_id: number;
          title: string;
          message: string;
          notification_type: string;
          date_sent: string;
          student_accounts?: { given_name: string; last_name: string }[] | null;
        }[];
        setRecentNotices(
          rows.map((r) => ({
            ...r,
            student_accounts: Array.isArray(r.student_accounts) ? (r.student_accounts[0] ?? null) : r.student_accounts,
          }))
        );
      }

      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  if (loading) return <Spinner label="Loading dashboard..." color="maroon" />;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold text-[#241012]">Admin Dashboard</h1>
      <p className="mt-1 text-xs text-[#8B7376]">An overview of students, applications, approvals, alerts, and sent notices.</p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Students" value={totalStudents} />
        <StatCard label="Pending Applications" value={pendingApps} tone="maroon" />
        <StatCard label="Approved Scholars" value={approvedScholars} tone="maroon" />
        <StatCard label="Active Alerts" value={activeAlerts} tone="maroon" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-bold text-[#241012]">Recent Applications</h2>
          {recentApplications.length === 0 ? (
            <EmptyState icon="&#128196;" title="No recent applications" />
          ) : (
            <ul className="max-h-72 space-y-3 overflow-y-auto pr-1">
              {recentApplications.map((app) => (
                <li key={app.application_id} className="flex items-center justify-between rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5]/50 p-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#241012]">
                      {app.student_accounts?.last_name}, {app.student_accounts?.given_name}
                    </p>
                    <p className="text-[11px] text-[#6B5458]">
                      {app.scholarship_programs?.scholarship_name} &middot; {formatDateTime(app.application_date)}
                    </p>
                  </div>
                  <Badge className={STATUS_STYLES[app.application_status] || ""}>
                    {app.application_status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-bold text-[#241012]">Active Alerts</h2>
          {recentAlerts.length === 0 ? (
            <EmptyState icon="&#9989;" title="No active alerts" />
          ) : (
            <ul className="max-h-72 space-y-3 overflow-y-auto pr-1">
              {recentAlerts.map((alert) => (
                <li key={alert.warning_id} className="flex items-start justify-between rounded-lg border border-red-100 bg-red-50/50 p-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#241012]">
                      {alert.student_accounts?.last_name}, {alert.student_accounts?.given_name}
                    </p>
                    <p className="text-[11px] text-[#6B5458]">
                      {alert.warning_message}
                    </p>
                    <p className="mt-1 text-[10px] text-[#8B7376]">
                      {formatDateTime(alert.warning_date)}
                    </p>
                  </div>
                  <Badge className={STATUS_STYLES[alert.status] || ""}>
                    {alert.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <section className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-[#241012]">Notices &amp; Status Updates</h2>
          <span className="rounded-full bg-[#7B1113]/10 px-2.5 py-0.5 text-[10px] font-bold text-[#7B1113]">{recentNotices.length}</span>
        </div>
        <p className="mt-1 text-xs text-[#8B7376]">Latest announcements and status updates sent to students.</p>
        {recentNotices.length === 0 ? (
          <div className="mt-3">
            <EmptyState icon="&#128276;" title="No notices sent yet" hint="Send an Announcement or Status Update from the Notifications page." />
          </div>
        ) : (
          <ul className="mt-4 max-h-72 space-y-3 overflow-y-auto pr-1">
            {recentNotices.map((n) => (
              <li key={n.notification_id} className="flex items-start justify-between gap-3 rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5]/50 p-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-bold text-[#241012]">{n.title}</p>
                    <Badge className="border-[#7B1113]/20 bg-[#7B1113]/5 text-[#7B1113]">{n.notification_type}</Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-[#6B5458]">{n.message}</p>
                  <p className="mt-1 text-[10px] text-[#8B7376]">
                    {n.student_accounts ? `To: ${n.student_accounts.last_name}, ${n.student_accounts.given_name}` : "To: All students"} &middot; {formatDateTime(n.date_sent)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
