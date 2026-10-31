"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime } from "@/lib/utils";
import { STATUS_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/ui/stat-card";

interface Alert {
  warning_id: number;
  student_id: number;
  status: string;
  risk_level?: string;
  warning_message?: string;
  average_grade?: number;
  gpa?: number;
  warning_date: string;
  student_accounts?: {
    given_name: string;
    last_name: string;
    student_number: string;
    program_name: string;
    year_level: string;
  };
}

export default function FacultyDashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [activeAlerts, setActiveAlerts] = useState<Alert[]>([]);
  const [totalInterventions, setTotalInterventions] = useState(0);
  const [approvedCount, setApprovedCount] = useState(0);
  const [atRiskStudents, setAtRiskStudents] = useState<Alert[]>([]);

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
        setFatalError("Faculty access is required for this dashboard.");
        setLoading(false);
        return;
      }

      const [alertsRes, interventionsRes, approvedRes] = await Promise.all([
        sb
          .from("early_warning_alerts")
          .select(
            "*, student_accounts(given_name, last_name, student_number, program_name, year_level)"
          )
          .eq("status", "Active")
          .order("warning_date", { ascending: false }),
        sb
          .from("notifications_announcements")
          .select("notification_id", { count: "exact", head: true })
          .eq("notification_type", "Warning")
          .eq("title", "Academic Intervention"),
        sb
          .from("scholarship_applications")
          .select("application_id", { count: "exact", head: true })
          .eq("application_status", "Approved"),
      ]);

      if (!alertsRes.error) {
        const alerts = alertsRes.data || [];
        setActiveAlerts(alerts);
        const unique = alerts.filter(
          (a, i, self) =>
            i === self.findIndex((b) => b.student_id === a.student_id)
        );
        setAtRiskStudents(unique);
      }

      if (!interventionsRes.error) {
        setTotalInterventions(interventionsRes.count ?? 0);
      }

      if (!approvedRes.error) {
        setApprovedCount(approvedRes.count ?? 0);
      }

      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  if (loading) return <Spinner label="Loading faculty dashboard..." color="green" />;

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
      <h1 className="text-xl font-bold text-[#241012]">
        Faculty Monitoring Dashboard
      </h1>
      <p className="mt-1 text-xs text-[#6B5458]">Keep an eye on at-risk students and the interventions sent to them.</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Active Alerts" value={activeAlerts.length} tone="maroon" />
        <StatCard
          label="Total Interventions Sent"
          value={totalInterventions}
          tone="maroon"
        />
        <StatCard
          label="Approved Scholars"
          value={approvedCount}
          tone="maroon"
        />
      </div>

      <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-[#241012]">
          Active At-Risk Students
        </h2>
        <p className="mt-1 text-xs text-[#6B5458]">
          Students with unresolved early-warning alerts requiring attention.
        </p>

        {atRiskStudents.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon="&#9989;"
              title="No active at-risk students"
              hint="All monitored students are currently in good standing."
            />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {atRiskStudents.map((alert) => (
              <Link
                key={alert.warning_id}
                href="/faculty/alerts"
                className="block rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm transition hover:shadow-md"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-bold text-[#241012]">
                    {alert.student_accounts?.last_name},{" "}
                    {alert.student_accounts?.given_name}
                    <span className="ml-1 font-normal text-[#8B7376]">
                      ({alert.student_accounts?.student_number})
                    </span>
                  </p>
                  <Badge className={STATUS_STYLES["Active"] || ""}>
                    Active
                  </Badge>
                  {alert.risk_level && (
                    <Badge className="border-red-200 bg-red-100 text-red-700">
                      {alert.risk_level} risk
                    </Badge>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                  <span className="font-bold text-red-700">
                    Average: {alert.average_grade ?? alert.gpa ?? "\u2014"}%
                  </span>
                  <span className="text-[#8B7376]">
                    {alert.student_accounts?.program_name} &middot;{" "}
                    {alert.student_accounts?.year_level}
                  </span>
                  <span className="ml-auto text-[#8B7376]">
                    {formatDateTime(alert.warning_date)}
                  </span>
                </div>
                {alert.warning_message && (
                  <p className="mt-2 text-xs text-[#6B5458]">
                    {alert.warning_message}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
