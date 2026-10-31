"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/browser";
import { STATUS_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { StatCard } from "@/components/ui/stat-card";

interface Application {
  application_id: number;
  student_id: number;
  application_status: string;
  application_date: string;
  scholarship_programs?: { scholarship_name: string };
  student_accounts?: { given_name: string; last_name: string; student_number: string; program_name: string };
}

interface Ranking {
  ranking_id: number;
  application_id: number;
  ranking_position: number;
  priority_score: number;
  prediction_result?: string;
}

interface Approval {
  application_id: number;
  approval_status: string;
}

export default function ChedDashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [applications, setApplications] = useState<Application[]>([]);
  const [rankings, setRankings] = useState<Ranking[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      setFatalError("");
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const { data: meData, error: meErr } = await sb.from("users").select("*").eq("auth_user_id", session.user.id).maybeSingle();
      if (meErr || !meData) { setFatalError("Account not found."); setLoading(false); return; }
      if (meData.role !== "CHED") { setFatalError("CHED personnel access is required."); setLoading(false); return; }

      const [appQ, rankQ, apprQ] = await Promise.all([
        sb.from("scholarship_applications").select("*, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number, program_name)").order("application_date", { ascending: false }),
        sb.from("ranking_result").select("*").order("ranking_position", { ascending: true }),
        sb.from("scholarship_approval").select("application_id, approval_status"),
      ]);

      if (!appQ.error) setApplications(appQ.data || []);
      if (!rankQ.error) setRankings(rankQ.data || []);
      if (!apprQ.error) setApprovals(apprQ.data || []);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  if (loading) return <Spinner label="Loading CHED dashboard..." color="blue" />;

  if (fatalError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f0f2f8] px-6">
        <div className="max-w-sm text-center">
          <p className="text-4xl">&#128683;</p>
          <h1 className="mt-3 text-lg font-bold text-[#241012]">{fatalError}</h1>
          <Link href="/" className="mt-5 inline-block rounded-lg bg-[#7B1113] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#540111]">Back to home</Link>
        </div>
      </main>
    );
  }

  const pendingCount = applications.filter((a) => a.application_status === "Pending").length;
  const approvedCount = applications.filter((a) => a.application_status === "Approved").length;
  const approvedBeneficiaryCount = approvals.filter((a) => a.approval_status === "Approved").length;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-[#241012]">CHED Dashboard</h1>
      <p className="mt-1 text-xs text-[#6B5458]">Review applications, the ranking result, and approved beneficiaries.</p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total Applications" value={applications.length} tone="maroon" />
        <StatCard label="Ranking Results" value={rankings.length} tone="maroon" />
        <StatCard label="Approved Beneficiaries" value={approvedBeneficiaryCount} tone="maroon" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">Pending Applications</h2>
          <p className="mt-1 text-xs text-[#6B5458]">Applications awaiting CHED review.</p>
          {pendingCount === 0 ? (
            <EmptyState icon="&#10003;" title="No pending applications" hint="All applications have been processed." />
          ) : (
            <div className="mt-3 space-y-2">
              {applications.filter((a) => a.application_status === "Pending").slice(0, 5).map((a) => (
                <div key={a.application_id} className="flex items-center justify-between rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5] px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#241012]">{a.student_accounts?.last_name}, {a.student_accounts?.given_name}</p>
                    <p className="text-[11px] text-[#6B5458]">{a.scholarship_programs?.scholarship_name}</p>
                  </div>
                  <Badge className={STATUS_STYLES[a.application_status] || ""}>{a.application_status}</Badge>
                </div>
              ))}
              {pendingCount > 5 && (
                <p className="text-[11px] text-[#6B5458]">+ {pendingCount - 5} more pending applications</p>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">Approved Beneficiaries</h2>
          <p className="mt-1 text-xs text-[#6B5458]">Students approved by CHED.</p>
          {approvedCount === 0 ? (
            <EmptyState icon="&#128203;" title="No approved beneficiaries" hint="Approve applications in the Approvals page." />
          ) : (
            <div className="mt-3 space-y-2">
              {applications.filter((a) => a.application_status === "Approved").slice(0, 5).map((a) => (
                <div key={a.application_id} className="flex items-center justify-between rounded-lg border border-green-100 bg-green-50 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#241012]">{a.student_accounts?.last_name}, {a.student_accounts?.given_name}</p>
                    <p className="text-[11px] text-[#6B5458]">{a.scholarship_programs?.scholarship_name}</p>
                  </div>
                  <Badge className="border-green-200 bg-green-50 text-green-700">Approved</Badge>
                </div>
              ))}
              {approvedCount > 5 && (
                <p className="text-[11px] text-[#6B5458]">+ {approvedCount - 5} more approved beneficiaries</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
