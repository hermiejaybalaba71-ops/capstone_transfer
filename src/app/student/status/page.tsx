"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime } from "@/lib/utils";
import { STATUS_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface ScholarshipApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_date: string;
  application_status: string;
  remarks?: string;
  scholarship_programs?: { scholarship_name: string };
}

interface Approval {
  application_id: number;
  approval_status: string;
  validation_status?: string;
}

const STATUS_STEPS: string[] = ["Pending", "Approved", "Not Approved"];

function ApprovalBadge({ appId, approvals }: { appId: number; approvals: Approval[] }) {
  const approval = approvals.find((a) => a.application_id === appId);
  if (!approval) return null;
  return (
    <Badge className={approval.approval_status === "Approved" ? "border-blue-200 bg-[#7B1113]/[0.06] text-[#7B1113]" : "border-red-200 bg-red-50 text-red-700"}>
      CHED: {approval.approval_status}
    </Badge>
  );
}

export default function ApplicationStatusPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [applications, setApplications] = useState<ScholarshipApplication[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [studentId, setStudentId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) {
        router.push("/login");
        return;
      }

      const { data: authUser } = await sb.auth.getUser();

      const userId = authUser.user?.id;
      if (!userId) { setLoading(false); return; }

      const userQuery = await sb
        .from("users")
        .select("user_id")
        .eq("auth_user_id", userId)
        .maybeSingle();

      if (userQuery.error || !userQuery.data) {
        setLoading(false);
        return;
      }

      const accountQuery = await sb
        .from("student_accounts")
        .select("student_id")
        .eq("user_id", userQuery.data.user_id)
        .maybeSingle();

      if (accountQuery.error || !accountQuery.data) {
        setLoading(false);
        return;
      }

      const sid = accountQuery.data.student_id;
      setStudentId(sid);

      const { data, error } = await sb
        .from("scholarship_applications")
        .select("*, scholarship_programs(scholarship_name)")
        .eq("student_id", sid)
        .order("application_date", { ascending: false });

      const appIds = data?.map((a: { application_id: number }) => a.application_id) ?? [];
      const { data: apprData } = appIds.length > 0
        ? await sb
            .from("scholarship_approval")
            .select("application_id, approval_status, validation_status")
            .in("application_id", appIds)
        : { data: [] };

      if (!error && data) {
        setApplications(data);
      }
      if (apprData) setApprovals(apprData);

      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router, reloadKey]);

  // Live-refresh when CHED/admin updates approval or application status.
  useEffect(() => {
    if (!studentId) return;
    const sb = getSupabase();
    const channel = sb
      .channel(`student-status-${studentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scholarship_applications", filter: `student_id=eq.${studentId}` },
        () => setReloadKey((k) => k + 1)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scholarship_approval" },
        () => setReloadKey((k) => k + 1)
      )
      .subscribe();
    const poll = window.setInterval(() => setReloadKey((k) => k + 1), 30000);
    return () => {
      sb.removeChannel(channel);
      window.clearInterval(poll);
    };
  }, [studentId]);

  function getProgressWidth(status: string): number {
    const idx = STATUS_STEPS.indexOf(status);
    if (idx < 0) return 0;
    if (status === "Not Approved") return 33;
    return ((idx + 1) / STATUS_STEPS.length) * 100;
  }

  function getProgressColor(status: string): string {
    switch (status) {
      case "Approved":
        return "bg-green-500";
      case "Pending":
        return "bg-amber-500";
      case "Not Approved":
        return "bg-red-500";
      default:
        return "bg-gray-300";
    }
  }

  if (loading) {
    return <Spinner label="Loading applications..." />;
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-[#241012]">Application Status</h1>
      <p className="mt-1 text-xs text-[#6B5458]">See where each of your applications is in the scholarship process.</p>

      {applications.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon="📋"
            title="No applications yet"
            hint="Browse available programs and submit your first application."
          />
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {applications.map((app) => (
            <div
              key={app.application_id}
              className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-[#241012]">
                  {app.scholarship_programs?.scholarship_name || "Scholarship Program"}
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  <ApprovalBadge appId={app.application_id} approvals={approvals} />
                  <Badge className={STATUS_STYLES[app.application_status] || ""}>
                    {app.application_status}
                  </Badge>
                </div>
              </div>

              <p className="mt-2 text-[11px] text-[#6B5458]">
                Applied: {formatDateTime(app.application_date)}
              </p>

              {app.remarks && (
                <p className="mt-2 text-xs text-[#6B5458]">
                  <span className="font-semibold">Remarks:</span> {app.remarks}
                </p>
              )}

              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-[10px] text-[#6B5458]">
                  <span>Pending</span>
                  <span>Approved</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[#F3EEEB]">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${getProgressColor(app.application_status)}`}
                    style={{ width: `${getProgressWidth(app.application_status)}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center gap-4 text-[10px] text-[#6B5458]">
                  {STATUS_STEPS.map((step, idx) => {
                    const currentIdx = STATUS_STEPS.indexOf(app.application_status);
                    const isActive = step === app.application_status;
                    const isPast =
                      app.application_status !== "Not Approved" && idx < currentIdx;
                    return (
                      <div key={step} className="flex items-center gap-1">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            isActive
                              ? "bg-[#7B1113]"
                              : isPast
                                ? "bg-green-500"
                                : "bg-gray-300"
                          }`}
                        />
                        <span className={isActive ? "font-semibold text-[#241012]" : ""}>
                          {step}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
