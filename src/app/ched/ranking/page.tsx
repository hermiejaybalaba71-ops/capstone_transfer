"use client";
import toast from "react-hot-toast";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { downloadCsv } from "@/lib/utils";
import { autoRejectSiblings, notifyStudentStatus } from "@/lib/scholarship";

interface Ranking {
  ranking_id: number;
  application_id: number;
  ranking_position: number;
  priority_score: number;
  prediction_result?: string;
  generated_date?: string;
}

interface Application {
  application_id: number;
  student_id: number;
  scholarship_programs?: { scholarship_name: string }[] | { scholarship_name: string };
  student_accounts?: {
    given_name: string;
    last_name: string;
    student_number: string;
    program_name: string;
    year_level: string;
    sex: string;
    student_id: number;
  }[] | {
    given_name: string;
    last_name: string;
    student_number: string;
    program_name: string;
    year_level: string;
    sex: string;
    student_id: number;
  };
}

interface ChedForm {
  ched_form_id: number;
  application_id: number;
  student_id?: string;
  given_name?: string;
  last_name?: string;
  ext_name?: string;
  middle_name?: string;
  sex?: string;
  birthdate?: string;
  complete_program_name?: string;
  year_level?: string;
  father_name?: string;
  mother_name?: string;
  street_barangay?: string;
  zipcode?: string;
  disability?: string;
  indigenous_people_group?: string;
  contact_number?: string;
  email_address?: string;
  income_tax_return?: string;
  annual_income_family?: number;
}

interface AcadRecord {
  student_id: number;
  shs_gwa?: number;
  college_gpa?: number;
  applicant_type?: string;
}

function unwrap<T>(val: T[] | T | undefined): T | undefined {
  if (!val) return undefined;
  return Array.isArray(val) ? val[0] : val;
}

export default function ChedRankingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [rankings, setRankings] = useState<Ranking[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [approvals, setApprovals] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "High Need" | "Low Need">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "Pending" | "Approved" | "Not Approved">("all");
  const [scholarshipFilter, setScholarshipFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [chedUserId, setChedUserId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [chedForms, setChedForms] = useState<ChedForm[]>([]);
  const [academicRecords, setAcademicRecords] = useState<AcadRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

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
      setChedUserId(meData.user_id);

      const [rankQ, appQ, approvalQ, chedQ, acadQ] = await Promise.all([
        sb.from("ranking_result").select("*").order("ranking_position", { ascending: true }),
        sb.from("scholarship_applications").select("application_id, student_id, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number, program_name, year_level, sex, student_id)"),
        sb.from("scholarship_approval").select("application_id, approval_status"),
        sb.from("ched_form_input").select("*").order("ched_form_id", { ascending: false }),
        sb.from("support_academic_records").select("student_id, shs_gwa, college_gpa, applicant_type"),
      ]);

      if (!rankQ.error) setRankings(rankQ.data || []);
      if (!appQ.error) setApplications(appQ.data || []);
      if (!chedQ.error) setChedForms(chedQ.data || []);
      if (!acadQ.error) setAcademicRecords(acadQ.data || []);
      if (!approvalQ.error) {
        const map: Record<number, string> = {};
        (approvalQ.data || []).forEach((a: { application_id: number; approval_status: string }) => { map[a.application_id] = a.approval_status; });
        setApprovals(map);
      }
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router, reloadKey]);

  function appFor(appId: number) { return applications.find((a) => a.application_id === appId); }
  function getSA(app?: Application) { return unwrap(app?.student_accounts); }
  function getSP(app?: Application) { return unwrap(app?.scholarship_programs); }
  function getStudentName(app?: Application) { const sa = getSA(app); return sa ? `${sa.last_name}, ${sa.given_name}` : null; }
  function getStudentNumber(app?: Application) { return getSA(app)?.student_number ?? null; }
  function getScholarshipName(app?: Application) { return getSP(app)?.scholarship_name ?? null; }
  function getYearLevel(app?: Application) { return getSA(app)?.year_level ?? null; }
  function getSex(app?: Application) { return getSA(app)?.sex ?? null; }
  function getProgram(app?: Application) { return getSA(app)?.program_name ?? null; }
  function getChedForm(appId: number) { return chedForms.find((c) => c.application_id === appId); }
  function getAcadRec(studentId: number) { return academicRecords.find((r) => r.student_id === studentId); }

  const scholarshipNames = Array.from(
    new Set(
      rankings
        .map((r) => getScholarshipName(appFor(r.application_id)) || "Scholarship not identified")
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const scholarshipCounts = scholarshipNames.reduce<Record<string, number>>((counts, name) => {
    counts[name] = rankings.filter(
      (r) => (getScholarshipName(appFor(r.application_id)) || "Scholarship not identified") === name,
    ).length;
    return counts;
  }, {});

  const filtered = rankings.filter((r) => {
    const scholarshipName = getScholarshipName(appFor(r.application_id)) || "Scholarship not identified";
    if (scholarshipFilter && scholarshipName !== scholarshipFilter) return false;
    if (filter !== "all" && r.prediction_result !== filter) return false;
    const status = approvals[r.application_id];
    if (statusFilter === "Approved" && status !== "Approved") return false;
    if (statusFilter === "Not Approved" && status !== "Not Approved") return false;
    if (statusFilter === "Pending" && status) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const app = appFor(r.application_id);
    const sa = getSA(app);
    if (getStudentName(app)?.toLowerCase().includes(q)) return true;
    if (sa?.student_number?.toLowerCase().includes(q)) return true;
    if (sa?.program_name?.toLowerCase().includes(q)) return true;
    if (sa?.year_level?.toLowerCase().includes(q)) return true;
    if (sa?.sex?.toLowerCase().includes(q)) return true;
    if (getScholarshipName(app)?.toLowerCase().includes(q)) return true;
    return false;
  });

  function toggleSelect(appId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((r) => r.application_id)));
  }

  async function approveSelected() {
    if (!selected.size) return;
    setSaving(true);
    setMessage("");
    const sb = getSupabase();
    const now = new Date().toISOString();
    const approvedTargets = [];
    let notified = 0;
    for (const appId of selected) {
      await sb.from("scholarship_approval").delete().eq("application_id", appId);
      const { error } = await sb.from("scholarship_approval").insert({
        application_id: appId, approved_by: chedUserId, approval_status: "Approved", approval_date: now, validation_status: "Not Validated",
      });
      if (error) { setMessage(`Error approving #${appId}: ${error.message}`); setSaving(false); return; }
      await sb.from("scholarship_applications").update({ application_status: "Approved" }).eq("application_id", appId);
      const app = appFor(appId);
      if (app) {
        approvedTargets.push({ application_id: appId, student_id: app.student_id });
        await notifyStudentStatus(app.student_id, app, "Approved");
        notified += 1;
      }
    }
    const res = await autoRejectSiblings(approvedTargets, applications);
    setSelected(new Set());
    setMessage(`Approved ${selected.size} applicant(s) and notified ${notified} student(s). Dashboard/status updates are live.${res.rejectedCount > 0 ? ` Auto-rejected ${res.rejectedCount} other application(s).` : ""}`);
    toast.success(`Approved ${selected.size} applicant(s) and notified ${notified} student(s). Dashboard/status updates are live.${res.rejectedCount > 0 ? ` Auto-rejected ${res.rejectedCount} other application(s).` : ""}`);
    setSaving(false);
    setReloadKey((k) => k + 1);
  }

  async function rejectSelected() {
    if (!selected.size) return;
    setSaving(true);
    setMessage("");
    const sb = getSupabase();
    const now = new Date().toISOString();
    let notified = 0;
    for (const appId of selected) {
      await sb.from("scholarship_approval").delete().eq("application_id", appId);
      const { error } = await sb.from("scholarship_approval").insert({
        application_id: appId, approved_by: chedUserId, approval_status: "Not Approved", approval_date: now, validation_status: "Not Validated",
      });
      if (error) { setMessage(`Error rejecting #${appId}: ${error.message}`); setSaving(false); return; }
      await sb.from("scholarship_applications").update({ application_status: "Not Approved" }).eq("application_id", appId);
      const app = appFor(appId);
      if (app) {
        await notifyStudentStatus(app.student_id, app, "Not Approved");
        notified += 1;
      }
    }
    setSelected(new Set());
    setMessage(`Rejected ${selected.size} applicant(s) and notified ${notified} student(s).`);
    toast.success(`Rejected ${selected.size} applicant(s) and notified ${notified} student(s).`);
    setSaving(false);
    setReloadKey((k) => k + 1);
  }

  function exportCsv() {
    downloadCsv("ched-ranking-review.csv", filtered.map((r) => {
      const app = appFor(r.application_id);
      const sa = getSA(app);
      const form = getChedForm(r.application_id);
      const acad = getAcadRec(sa?.student_id ?? 0);
      return {
        rank: r.ranking_position,
        student_id: sa?.student_id ?? "",
        student_number: getStudentNumber(app) ?? "",
        last_name: sa?.last_name ?? "",
        given_name: sa?.given_name ?? "",
        middle_name: form?.middle_name ?? "",
        ext_name: form?.ext_name ?? "",
        sex: form?.sex ?? getSex(app) ?? "",
        birthdate: form?.birthdate ?? "",
        program: form?.complete_program_name ?? getProgram(app) ?? "",
        year_level: form?.year_level ?? getYearLevel(app) ?? "",
        father_name: form?.father_name ?? "",
        mother_name: form?.mother_name ?? "",
        street_barangay: form?.street_barangay ?? "",
        zipcode: form?.zipcode ?? "",
        disability: form?.disability ?? "",
        indigenous_people_group: form?.indigenous_people_group ?? "",
        contact_number: form?.contact_number ?? "",
        email_address: form?.email_address ?? "",
        annual_income_family: form?.annual_income_family ?? "",
        applicant_type: acad?.applicant_type ?? "",
        shs_gwa: acad?.shs_gwa ?? "",
        college_gpa: acad?.college_gpa ?? "",
        scholarship: getScholarshipName(app) ?? "",
        priority_score: r.priority_score,
        prediction: r.prediction_result ?? "",
        approval_status: approvals[r.application_id] ?? "Pending",
      };
    }));
    setMessage(`Exported ${filtered.length} ranking records.`);
    toast.success(`Exported ${filtered.length} ranking records.`);
  }

  if (loading) return <Spinner label="Loading ranking result..." color="blue" />;
  if (fatalError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f0f2f8] px-6">
        <div className="max-w-sm text-center">
          <p className="text-4xl">&#128683;</p>
          <h1 className="mt-3 text-lg font-bold text-[#241012]">{fatalError}</h1>
        </div>
      </main>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[#241012]">Ranking Result</h1>
        <span className="text-xs text-[#8B7376]">{rankings.length} total ranked</span>
      </div>

      {message && (
        <div className="rounded-xl border border-blue-200 bg-[#7B1113]/[0.06] px-4 py-3 text-xs font-medium text-[#7B1113]">{message}</div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B7376]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search by name, student #, program, year, sex, scholarship..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-[#241012]/[0.06] bg-white py-2 pl-10 pr-4 text-xs outline-none focus:border-[#7B1113] focus:ring-1 focus:ring-[#7B1113]/20"
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as "all" | "High Need" | "Low Need")}
          className="rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2 text-xs font-medium text-[#241012]"
        >
          <option value="all">All ({rankings.length})</option>
          <option value="High Need">High Need ({rankings.filter((r) => r.prediction_result === "High Need").length})</option>
          <option value="Low Need">Low Need ({rankings.filter((r) => r.prediction_result === "Low Need").length})</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | "Pending" | "Approved" | "Not Approved")}
          className="rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2 text-xs font-medium text-[#241012]"
        >
          <option value="all">Status: All</option>
          <option value="Approved">Status: Approved ({rankings.filter((r) => approvals[r.application_id] === "Approved").length})</option>
          <option value="Not Approved">Status: Not Approved ({rankings.filter((r) => approvals[r.application_id] === "Not Approved").length})</option>
          <option value="Pending">Status: Pending ({rankings.filter((r) => !approvals[r.application_id]).length})</option>
        </select>
        <button onClick={approveSelected} disabled={!selected.size || saving}
          className="rounded-lg bg-green-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-green-700 disabled:opacity-50">
          {saving ? "Saving..." : `Approve Selected (${selected.size})`}
        </button>
        <button onClick={rejectSelected} disabled={!selected.size || saving}
          className="rounded-lg bg-red-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-red-700 disabled:opacity-50">
          {saving ? "Saving..." : `Reject Selected (${selected.size})`}
        </button>
        <button onClick={exportCsv} disabled={!filtered.length}
          className="rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2 text-[11px] font-bold text-[#241012] hover:bg-[#FAF7F5] disabled:opacity-50">
          Export CSV
        </button>
      </div>

      {rankings.length > 0 && (
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[#6B5458]">
              Ranked scholarship programs
            </p>
            <span className="text-[10px] text-[#8B7376]">
              Click a category to show only that scholarship&apos;s ranking
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setScholarshipFilter("")}
              className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                scholarshipFilter === ""
                  ? "bg-[#7B1113] text-white shadow-sm"
                  : "border border-[#241012]/10 bg-[#FAF7F5] text-[#6B5458] hover:border-[#7B1113]/40 hover:text-[#7B1113]"
              }`}
            >
              All scholarships ({rankings.length})
            </button>
            {scholarshipNames.map((name) => (
              <button
                key={name}
                onClick={() => setScholarshipFilter(scholarshipFilter === name ? "" : name)}
                title={`Show ${scholarshipCounts[name]} ranked applicant(s) under ${name}`}
                className={`max-w-full truncate rounded-full px-3 py-1.5 text-left text-[11px] font-bold transition ${
                  scholarshipFilter === name
                    ? "bg-[#7B1113] text-white shadow-sm"
                    : "border border-[#241012]/10 bg-[#FAF7F5] text-[#6B5458] hover:border-[#7B1113]/40 hover:text-[#7B1113]"
                }`}
              >
                {name} ({scholarshipCounts[name]})
              </button>
            ))}
          </div>
        </div>
      )}

      {rankings.length === 0 ? (
        <EmptyState icon="&#129302;" title="No ranking result yet" hint="The ranking result has not been generated yet. It will appear here once the Administrator runs the ML ranking process." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[#241012]/[0.06] bg-white shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#7B1113]/[0.06] text-[10px] uppercase tracking-wide text-[#6B5458]">
              <tr>
                <th className="px-4 py-3">
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll}
                    className="rounded border-[#241012]/15 text-[#7B1113]" />
                </th>
                <th className="px-4 py-3">Rank</th>
                <th className="px-4 py-3">Student ID</th>
                <th className="px-4 py-3">Applicant Name</th>
                <th className="px-4 py-3">Student #</th>
                <th className="px-4 py-3">Program</th>
                <th className="px-4 py-3">Year</th>
                <th className="px-4 py-3">Sex</th>
                <th className="px-4 py-3">Scholarship</th>
                <th className="px-4 py-3">Priority Score</th>
                <th className="px-4 py-3">Prediction</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const app = appFor(r.application_id);
                const sa = getSA(app);
                const status = approvals[r.application_id];
                return (
                  <tr key={r.ranking_id} className="border-t border-[#241012]/[0.06] hover:bg-[#FAF7F5]">
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.has(r.application_id)} onChange={() => toggleSelect(r.application_id)}
                        className="rounded border-[#241012]/15 text-[#7B1113]" />
                    </td>
                    <td className="px-4 py-3 font-bold text-[#7B1113]">#{r.ranking_position}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[#6B5458]">{sa?.student_id || "\u2014"}</td>
                    <td className="px-4 py-3 font-semibold text-[#241012]">{getStudentName(app) || `App #${r.application_id}`}</td>
                    <td className="px-4 py-3 text-[#6B5458]">{getStudentNumber(app) || "\u2014"}</td>
                    <td className="px-4 py-3 text-[#6B5458]">{getProgram(app) || "\u2014"}</td>
                    <td className="px-4 py-3 text-[#6B5458]">{getYearLevel(app) || "\u2014"}</td>
                    <td className="px-4 py-3 text-[#6B5458]">{getSex(app) || "\u2014"}</td>
                    <td className="px-4 py-3 text-[#6B5458]">{getScholarshipName(app) || "\u2014"}</td>
                    <td className="px-4 py-3 font-semibold text-[#241012]">{r.priority_score}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        r.prediction_result === "High Need" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                      }`}>{r.prediction_result || "\u2014"}</span>
                    </td>
                    <td className="px-4 py-3">
                      {status === "Approved" && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">Approved</span>}
                      {status === "Not Approved" && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">Rejected</span>}
                      {!status && <span className="rounded-full bg-[#F3EEEB] px-2 py-0.5 text-[10px] font-bold text-[#6B5458]">Pending</span>}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-xs text-[#8B7376]">No results match your search</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
