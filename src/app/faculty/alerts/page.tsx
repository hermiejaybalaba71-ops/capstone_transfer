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

export default function FacultyAlertsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

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

      const { data, error } = await sb
        .from("early_warning_alerts")
        .select(
          "*, student_accounts(given_name, last_name, student_number, program_name, year_level)"
        )
        .order("warning_date", { ascending: false });

      if (!error) {
        setAlerts(data || []);
      }
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router, reloadKey]);

  async function scanRegistrarGrades() {
    setScanning(true);
    setScanMsg("");
    try {
      const sb = getSupabase();
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setScanMsg("Session expired. Please log in again.");
        setScanning(false);
        return;
      }

      const res = await fetch("/api/faculty/scan-alerts", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const payload = await res.json();
      if (!res.ok || payload.error) {
        setScanMsg(payload.error || "Scan failed.");
      } else {
        setScanMsg(payload.message || "Scan complete.");
      }
    } catch {
      setScanMsg("Scan failed. Please try again.");
    }
    setScanning(false);
    setReloadKey((k) => k + 1);
  }

  if (loading) return <Spinner label="Loading early warning alerts..." color="green" />;

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

  const activeAlerts = alerts.filter((a) => a.status === "Active");
  const resolvedAlerts = alerts.filter((a) => a.status === "Resolved");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[#241012]">
          Early Warning Alerts
        </h1>
        <p className="mt-1 text-xs text-[#6B5458]">
          Monitor students whose grades have fallen below the 93% maintenance threshold.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={scanRegistrarGrades}
          disabled={scanning}
          className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#14532d] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {scanning ? "Scanning Registrar..." : "Scan Registrar Grades"}
        </button>
        {scanMsg && <span className="text-xs text-[#6B5458]">{scanMsg}</span>}
      </div>

      {alerts.length === 0 ? (
        <EmptyState
          icon="&#9989;"
          title="No early-warning alerts"
          hint="All monitored averages are at or above the required maintenance grade."
        />
      ) : (
        <>
          {activeAlerts.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-bold text-[#241012]">
                Active Alerts ({activeAlerts.length})
              </h2>
              {activeAlerts.map((alert) => (
                <div
                  key={alert.warning_id}
                  className="rounded-xl border border-red-200 bg-red-50 p-4 shadow-sm"
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
                    <span className="ml-auto text-[10px] text-[#8B7376]">
                      {formatDateTime(alert.warning_date)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[#6B5458]">
                    {alert.warning_message ||
                      "Below the required maintaining grade."}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                    <span className="font-bold text-red-700">
                      Average: {alert.average_grade ?? alert.gpa ?? "\u2014"}%
                    </span>
                    {alert.student_accounts?.program_name && (
                      <span className="text-[#8B7376]">
                        {alert.student_accounts.program_name} &middot;{" "}
                        {alert.student_accounts.year_level}
                      </span>
                    )}
                  </div>
                  <Link
                    href={`/faculty/interventions?studentId=${alert.student_id}`}
                    className="mt-3 inline-block rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#14532d]"
                  >
                    Send intervention &rarr;
                  </Link>
                </div>
              ))}
            </div>
          )}

          {resolvedAlerts.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-bold text-[#241012]">
                Resolved ({resolvedAlerts.length})
              </h2>
              {resolvedAlerts.map((alert) => (
                <div
                  key={alert.warning_id}
                  className="rounded-xl border border-[#241012]/[0.06] bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold text-[#241012]">
                      {alert.student_accounts?.last_name},{" "}
                      {alert.student_accounts?.given_name}
                      <span className="ml-1 font-normal text-[#8B7376]">
                        ({alert.student_accounts?.student_number})
                      </span>
                    </p>
                    <Badge className={STATUS_STYLES["Resolved"] || ""}>
                      Resolved
                    </Badge>
                    {alert.risk_level && (
                      <Badge className="border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]">
                        {alert.risk_level} risk
                      </Badge>
                    )}
                    <span className="ml-auto text-[10px] text-[#8B7376]">
                      {formatDateTime(alert.warning_date)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[#6B5458]">
                    {alert.warning_message ||
                      "Below the required maintaining grade."}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                    <span className="font-bold text-green-700">
                      Average: {alert.average_grade ?? alert.gpa ?? "\u2014"}%
                    </span>
                    {alert.student_accounts?.program_name && (
                      <span className="text-[#8B7376]">
                        {alert.student_accounts.program_name} &middot;{" "}
                        {alert.student_accounts.year_level}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
