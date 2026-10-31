"use client";
import toast from "react-hot-toast";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { queryRegistrar } from "@/lib/supabase/registrar";
import { formatDateTime, downloadCsv } from "@/lib/utils";
import { STATUS_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { ImportedSheet } from "@/components/import/imported-sheet";

const VALIDATION_TABS = [
  { key: "all" as const, label: "All", active: "bg-[#7B1113] text-white", idle: "text-[#6B5458] hover:bg-[#7B1113]/5 hover:text-[#7B1113]" },
  { key: "Not Validated" as const, label: "Not Validated", active: "bg-amber-500 text-white", idle: "text-amber-700 hover:bg-amber-50" },
  { key: "Validated" as const, label: "Validated", active: "bg-green-600 text-white", idle: "text-green-700 hover:bg-green-50" },
] as const;

interface ScholarshipApproval {
  approval_id: number;
  application_id: number;
  approved_by?: number;
  approval_date?: string;
  approval_status: string;
  validation_status?: string;
  approved_by_user?: { username: string; role: string } | null;
}

interface ScholarshipApplication {
  application_id: number;
  student_id: number;
  application_date: string;
  application_status: string;
  scholarship_programs?: { scholarship_name: string };
  student_accounts?: { given_name: string; last_name: string; student_number: string; program_name: string; year_level?: string; sex?: string; registration_status?: string; account_status?: string };
}

interface SupportDocument {
  document_id: number;
  student_id: number;
  document_type: string;
  file_path: string;
  upload_date: string;
}

interface SupportAcademicRecord {
  record_id: number;
  student_id: number;
  applicant_type?: string;
  shs_gwa?: number;
  college_gpa?: number;
  proof_image_path?: string;
  created_at?: string;
}

interface ChedFormInput {
  ched_form_id: number;
  application_id: number;
  student_id: string;
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
  contact_number?: string;
  email_address?: string;
  indigenous_people_group?: string;
  income_tax_return?: string;
  annual_income_family?: number;
}

export default function ApprovalsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [approvals, setApprovals] = useState<ScholarshipApproval[]>([]);
  const [applications, setApplications] = useState<ScholarshipApplication[]>([]);
  const [docs, setDocs] = useState<SupportDocument[]>([]);
  const [acads, setAcads] = useState<SupportAcademicRecord[]>([]);
  const [chedForms, setChedForms] = useState<ChedFormInput[]>([]);
  const [validatingId, setValidatingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [validationFilter, setValidationFilter] = useState<"all" | "Not Validated" | "Validated">("all");
  const [viewingId, setViewingId] = useState<number | null>(null);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [apprQ, appsQ, docsQ, acadsQ, chedQ] = await Promise.all([
        sb.from("scholarship_approval").select("*, approved_by_user:users(username, role)").order("approval_date", { ascending: false }),
        sb.from("scholarship_applications")
          .select("*, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number, program_name, year_level, sex, registration_status, account_status)")
          .eq("application_status", "Approved"),
        sb.from("support_documents").select("*").order("upload_date", { ascending: false }),
        sb.from("support_academic_records").select("*").order("created_at", { ascending: false }),
        sb.from("ched_form_input").select("*").order("ched_form_id", { ascending: false }),
      ]);

      if (!apprQ.error) setApprovals(apprQ.data || []);
      if (!appsQ.error) setApplications(appsQ.data || []);
      if (!docsQ.error) setDocs(docsQ.data || []);
      if (!acadsQ.error) setAcads(acadsQ.data || []);
      if (!chedQ.error) setChedForms(chedQ.data || []);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  useEffect(() => {
    if (viewingId !== null) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [viewingId]);

  function getApp(appId: number) {
    return applications.find((a) => a.application_id === appId);
  }

  function isChedApproval(appr: ScholarshipApproval) {
    return appr.approved_by_user?.role === "CHED";
  }

  const approvedEntries = approvals.filter((a) => a.approval_status === "Approved" && getApp(a.application_id) && isChedApproval(a));

  const validatedCount = approvedEntries.filter((a) => a.validation_status === "Validated").length;
  const notValidatedCount = approvedEntries.length - validatedCount;

  const filteredApprovals = approvedEntries.filter((a) => {
    if (validationFilter !== "all" && (a.validation_status || "Not Validated") !== validationFilter) return false;
    return true;
  });

  const appChed = (app: ScholarshipApplication) => chedForms.filter((c) => c.application_id === app.application_id);
  const appDocs = (app: ScholarshipApplication) => docs.filter((d) => d.student_id === app.student_id);
  const appAcads = (app: ScholarshipApplication) => acads.filter((a) => a.student_id === app.student_id);

  async function loadFileUrls(app: ScholarshipApplication) {
    setFileUrls({});
    const sb = getSupabase();
    const urls: Record<string, string> = {};
    for (const d of appDocs(app)) {
      const res = await sb.storage.from("support-documents").createSignedUrl(d.file_path, 3600);
      if (res.data?.signedUrl) urls[d.file_path] = res.data.signedUrl;
    }
    for (const a of appAcads(app)) {
      if (!a.proof_image_path) continue;
      const res = await sb.storage.from("academic-records").createSignedUrl(a.proof_image_path, 3600);
      if (res.data?.signedUrl) urls[a.proof_image_path] = res.data.signedUrl;
    }
    for (const c of appChed(app)) {
      if (!c.income_tax_return) continue;
      const res = await sb.storage.from("itr-documents").createSignedUrl(c.income_tax_return, 3600);
      if (res.data?.signedUrl) urls[c.income_tax_return] = res.data.signedUrl;
    }
    setFileUrls(urls);
  }

  function openDetails(appId: number) {
    const app = getApp(appId);
    if (!app) return;
    setViewingId(appId);
    loadFileUrls(app);
  }

  async function handleValidate(approval: ScholarshipApproval) {
    setMessage("");
    setValidatingId(approval.application_id);

    const app = getApp(approval.application_id);
    const studentNumber = app?.student_accounts?.student_number?.trim();
    if (!studentNumber) {
      setMessage("Student number not found for this application.");
      setValidatingId(null);
      return;
    }

    const regStudentLookup = await queryRegistrar<{ student_id: number; registration_status?: string }>((rsb) =>
      rsb
        .from("registrar_students")
        .select("*")
        .eq("student_number", studentNumber)
        .limit(1)
        .maybeSingle()
    );

    const regStudent = regStudentLookup.data ?? null;

    if (regStudentLookup.error) {
      setMessage(`Registrar lookup failed: ${regStudentLookup.error.message}`);
      setValidatingId(null);
      return;
    }

    let isEnrolled = !!regStudent?.registration_status && regStudent.registration_status === "Enrolled";
    if (regStudent && !isEnrolled) {
      const enrollLookup = await queryRegistrar<{ enrollment_status: string }[]>((rsb) =>
        rsb
          .from("registrar_enrollment")
          .select("enrollment_status")
          .eq("student_id", regStudent.student_id)
          .eq("enrollment_status", "Enrolled")
          .limit(1)
      );
      if (!enrollLookup.error) isEnrolled = !!enrollLookup.data?.length;
    }

    const sb = getSupabase();
    if (regStudent && isEnrolled) {
      const { error } = await sb
        .from("scholarship_approval")
        .update({ validation_status: "Validated" })
        .eq("application_id", approval.application_id);

      if (error) { setMessage(error.message); setValidatingId(null); return; }

      await sb
        .from("student_accounts")
        .update({ registration_status: "Verified" })
        .eq("student_number", studentNumber);

      setApprovals((prev) => prev.map((a) =>
        a.application_id === approval.application_id ? { ...a, validation_status: "Validated" } : a
      ));
      setMessage("Student found and enrolled in the Registrar database. Marked as Validated.");
      toast.success("Student found and enrolled in the Registrar database. Marked as Validated.");
    } else {
      const { error } = await sb
        .from("scholarship_approval")
        .update({ validation_status: "Not Validated" })
        .eq("application_id", approval.application_id);

      if (error) { setMessage(error.message); setValidatingId(null); return; }

      setApprovals((prev) => prev.map((a) =>
        a.application_id === approval.application_id ? { ...a, validation_status: "Not Validated" } : a
      ));
      setMessage("Student not found or not enrolled in the Registrar database.");
    }

    setValidatingId(null);
  }

  function exportOneCsv(approval: ScholarshipApproval) {
    const app = getApp(approval.application_id);
    const rows = app ? [{
      student: `${app.student_accounts?.last_name || ""}, ${app.student_accounts?.given_name || ""}`,
      student_number: app.student_accounts?.student_number ?? "",
      program: app.student_accounts?.program_name ?? "",
      scholarship: app.scholarship_programs?.scholarship_name ?? "",
      application_date: formatDateTime(app.application_date),
      approval_date: approval.approval_date ? formatDateTime(approval.approval_date) : "",
      approval_status: approval.approval_status,
      validation_status: approval.validation_status ?? "Not Validated",
    }] : [];
    if (!rows.length) return;
    downloadCsv(`approved-scholar-${approval.application_id}.csv`, rows);
    setMessage("Exported this scholar's approval record as CSV.");
    toast.success("Exported this scholar's approval record as CSV.");
  }

  function exportCsv() {
    if (!approvedEntries.length) return;
    downloadCsv("approved-scholars.csv", approvedEntries.map((a) => {
      const app = getApp(a.application_id);
      return {
        student: app?.student_accounts ? `${app.student_accounts.last_name}, ${app.student_accounts.given_name}` : "",
        student_number: app?.student_accounts?.student_number ?? "",
        program: app?.student_accounts?.program_name ?? "",
        scholarship: app?.scholarship_programs?.scholarship_name ?? "",
        application_date: app ? formatDateTime(app.application_date) : "",
        approval_date: a.approval_date ? formatDateTime(a.approval_date) : "",
        approval_status: a.approval_status,
        validation_status: a.validation_status ?? "Not Validated",
      };
    }));
    setMessage(`Exported ${approvedEntries.length} approved scholar(s) as CSV.`);
    toast.success(`Exported ${approvedEntries.length} approved scholar(s) as CSV.`);
  }

  const viewingAppr = approvals.find((a) => a.application_id === viewingId) || null;
  const viewingApp = viewingAppr ? getApp(viewingAppr.application_id) : null;

  if (loading) return <Spinner label="Loading approvals..." color="maroon" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Approved Scholars List</h1>
          <p className="mt-1 text-xs text-[#8B7376]">Scholars approved by CHED. Your role is to validate each one against the Registrar.</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={!approvedEntries.length}
          className="self-start rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-40"
        >
          &#11015; Export CSV
        </button>
      </div>

      {message && (
        <div className="rounded-xl border border-[#7B1113]/20 bg-white px-4 py-3 text-xs font-medium text-[#7B1113] shadow-sm">
          {message}
        </div>
      )}

      {/* Bulk import viewer: upload the CHED approval list CSV / Excel and
          read every row and column here, sectioned by whatever school years
          the file itself contains (AY 2024-2025, AY 2025-2026, ...). */}
      <ImportedSheet
        prefer="year"
        scope="approvals"
        emoji="📋"
        title="Imported approval list"
        hint="Upload a CSV / Excel file of approved scholars - every row and column is read and shown below, grouped by school year. The file is saved on the server, so it is still here after a refresh."
      />

      <div className="flex flex-wrap gap-2">
        {VALIDATION_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setValidationFilter(tab.key)}
            className={`rounded-xl px-4 py-2 text-xs font-bold transition ${validationFilter === tab.key ? tab.active : `${tab.idle} border border-[#241012]/[0.06]`}`}
          >
            {tab.label} ({tab.key === "all" ? approvedEntries.length : tab.key === "Validated" ? validatedCount : notValidatedCount})
          </button>
        ))}
      </div>

      {filteredApprovals.length === 0 ? (
        <EmptyState icon="&#9989;" title="No CHED-approved scholars yet" hint="Once CHED approves applications, they appear here for you to validate against the Registrar." />
      ) : (
        <div className="space-y-3">
          {filteredApprovals.map((appr) => {
            const app = getApp(appr.application_id);
            const isValidated = appr.validation_status === "Validated";

            return (
              <div key={appr.approval_id} className="rounded-xl border border-[#241012]/[0.06] bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[#7B1113]/10 text-sm font-bold text-[#7B1113]">
                      {app?.student_accounts?.given_name?.[0] || "S"}{app?.student_accounts?.last_name?.[0] || ""}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-[#241012]">
                          {app?.student_accounts?.last_name}, {app?.student_accounts?.given_name}
                          <span className="font-normal text-[#8B7376]"> ({app?.student_accounts?.student_number || "\u2014"})</span>
                        </p>
                        <Badge className="border-blue-200 bg-[#7B1113]/[0.06] text-[#7B1113]">Approved by CHED</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-[#7B1113]">{app?.scholarship_programs?.scholarship_name || "\u2014"}</p>
                      <p className="text-[11px] text-[#8B7376]">{app?.student_accounts?.program_name || "\u2014"} &middot; Approved {formatDateTime(appr.approval_date)}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:flex-none">
                    <Badge className={STATUS_STYLES[appr.approval_status] || ""}>{appr.approval_status}</Badge>
                    {isValidated ? (
                      <Badge className="border-green-200 bg-green-50 text-green-700">&#10003; Validated</Badge>
                    ) : (
                      <Badge className="border-amber-200 bg-amber-50 text-amber-700">{appr.validation_status || "Not Validated"}</Badge>
                    )}
                    <button
                      onClick={() => handleValidate(appr)}
                      disabled={isValidated || validatingId === appr.application_id}
                      className="rounded-lg border border-green-300 px-3 py-1.5 text-[11px] font-bold text-green-700 transition hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {validatingId === appr.application_id ? "Validating..." : isValidated ? "Validated" : "Validate against Registrar"}
                    </button>
                    <button
                      onClick={() => openDetails(appr.application_id)}
                      className="rounded-lg border border-[#241012]/15 px-3 py-1.5 text-[11px] font-bold text-[#241012] transition hover:bg-[#FAF7F5]"
                    >
                      View Details
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewingApp && viewingAppr && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-[#241012]/50 p-4 backdrop-blur-sm sm:p-8" onClick={() => setViewingId(null)}>
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-[#241012]/[0.06] p-5">
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-[#241012]">Scholar Details</h3>
                <p className="mt-0.5 text-xs text-[#8B7376]">
                  {viewingApp.student_accounts?.last_name}, {viewingApp.student_accounts?.given_name} &middot; {viewingApp.student_accounts?.student_number || "\u2014"}
                </p>
              </div>
              <button onClick={() => setViewingId(null)} className="rounded-lg p-2 text-[#8B7376] transition hover:bg-[#F3EEEB] hover:text-[#241012]" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="max-h-[calc(100vh-12rem)] space-y-6 overflow-y-auto p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={STATUS_STYLES[viewingAppr.approval_status] || ""}>{viewingAppr.approval_status}</Badge>
                <Badge className="border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]">{viewingApp.scholarship_programs?.scholarship_name || "\u2014"}</Badge>
                {viewingAppr.validation_status === "Validated" ? (
                  <Badge className="border-green-200 bg-green-50 text-green-700">&#10003; Validated</Badge>
                ) : (
                  <Badge className="border-amber-200 bg-amber-50 text-amber-700">{viewingAppr.validation_status || "Not Validated"}</Badge>
                )}
                <Badge className="border-blue-200 bg-[#7B1113]/[0.06] text-[#7B1113]">Approved by CHED</Badge>
                <button onClick={() => exportOneCsv(viewingAppr)} className="rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5">
                  &#11015; Export CSV
                </button>
              </div>

              <div className="rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5]/60 p-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Applicant Profile</h4>
                <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Full Name</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.last_name}, {viewingApp.student_accounts?.given_name}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Student No.</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.student_number || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Program</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.program_name || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Year Level</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.year_level || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Sex</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.sex || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Registration</p><div className="mt-0.5"><Badge className={viewingApp.student_accounts?.registration_status === "Verified" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{viewingApp.student_accounts?.registration_status || "\u2014"}</Badge></div></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Account Status</p><div className="mt-0.5"><Badge className={viewingApp.student_accounts?.account_status === "Active" ? "border-green-200 bg-green-50 text-green-700" : "border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]"}>{viewingApp.student_accounts?.account_status || "\u2014"}</Badge></div></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Approved</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingAppr.approval_date ? formatDateTime(viewingAppr.approval_date) : "\u2014"}</p></div>
                </div>
              </div>

              {appChed(viewingApp).length > 0 ? (
                <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                  <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Application Form Submitted</h4>
                  {appChed(viewingApp).map((c) => (
                    <div key={c.ched_form_id} className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Last Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.last_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">First Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.given_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Middle Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.middle_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Ext. Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.ext_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Sex</p><p className="mt-0.5 font-semibold text-[#241012]">{c.sex || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Birthdate</p><p className="mt-0.5 font-semibold text-[#241012]">{c.birthdate || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Program</p><p className="mt-0.5 font-semibold text-[#241012]">{c.complete_program_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Year Level</p><p className="mt-0.5 font-semibold text-[#241012]">{c.year_level || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Father&apos;s Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.father_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Mother&apos;s Name</p><p className="mt-0.5 font-semibold text-[#241012]">{c.mother_name || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Street / Barangay</p><p className="mt-0.5 font-semibold text-[#241012]">{c.street_barangay || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Zipcode</p><p className="mt-0.5 font-semibold text-[#241012]">{c.zipcode || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Contact Number</p><p className="mt-0.5 font-semibold text-[#241012]">{c.contact_number || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Email Address</p><p className="mt-0.5 font-semibold text-[#241012]">{c.email_address || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Disability</p><p className="mt-0.5 font-semibold text-[#241012]">{c.disability || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">IP Group</p><p className="mt-0.5 font-semibold text-[#241012]">{c.indigenous_people_group || "\u2014"}</p></div>
                      <div><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Annual Family Income</p><p className="mt-0.5 font-semibold text-[#241012]">&#8369;{Number(c.annual_income_family || 0).toLocaleString()}/yr</p></div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-[#8B7376]">ITR File</p>
                        {c.income_tax_return ? (
                          fileUrls[c.income_tax_return] ? (
                            <a href={fileUrls[c.income_tax_return]} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-[#7B1113] px-3 py-1.5 text-[11px] font-bold text-white shadow-sm transition hover:bg-[#540111]" title="Open the submitted Income Tax Return in a new tab">
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5h18M3 6h18M12 6v18M10.5 3h3M4.5 21h15a1.5 1.5 0 001.5-1.5V7.5A1.5 1.5 0 0019.5 6h-15A1.5 1.5 0 003 7.5v12A1.5 1.5 0 004.5 21z" /></svg>
                              View ITR
                            </a>
                          ) : (
                            <button type="button" disabled className="mt-1 inline-flex cursor-default items-center gap-1.5 rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-semibold text-[#8B7376]" title="Opening...">
                              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#7B1113]/30 border-t-[#7B1113]" />
                              Opening ITR...
                            </button>
                          )
                        ) : <p className="mt-0.5 font-semibold text-[#241012]">{"\u2014"}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Application Form</h4>
                  <p className="mt-2 text-[11px] text-[#8B7376]">The student has not completed the CHED application form yet.</p>
                </div>
              )}

              <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Academic Records ({appAcads(viewingApp).length})</h4>
                {appAcads(viewingApp).length === 0 ? (
                  <p className="text-[11px] text-[#8B7376]">No academic records uploaded.</p>
                ) : (
                  <ul className="space-y-2">
                    {appAcads(viewingApp).map((a) => (
                      <li key={a.record_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-3 py-2">
                        <div className="flex items-center gap-3 text-xs">
                          <Badge className="border-[#241012]/[0.06] bg-white text-[#6B5458]">{a.applicant_type || "N/A"}</Badge>
                          <span className="font-semibold text-[#241012]">GWA/GPA: {a.shs_gwa ?? a.college_gpa ?? "\u2014"}</span>
                        </div>
                        {a.proof_image_path && fileUrls[a.proof_image_path] ? (
                          <a href={fileUrls[a.proof_image_path]} target="_blank" rel="noreferrer" className="font-semibold text-[#7B1113] hover:underline">View proof</a>
                        ) : a.proof_image_path ? (
                          <span className="text-[10px] font-semibold text-[#8B7376]">uploaded</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Support Documents ({appDocs(viewingApp).length})</h4>
                {appDocs(viewingApp).length === 0 ? (
                  <p className="text-[11px] text-[#8B7376]">No documents uploaded.</p>
                ) : (
                  <ul className="space-y-2">
                    {appDocs(viewingApp).map((d) => (
                      <li key={d.document_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-3 py-2">
                        <div className="flex items-center gap-2 text-xs">
                          <Badge className="border-[#241012]/[0.06] bg-white text-[#6B5458]">{d.document_type}</Badge>
                          <span className="text-[10px] text-[#8B7376]">{d.file_path.split("/").pop()}</span>
                        </div>
                        {fileUrls[d.file_path] ? (
                          <a href={fileUrls[d.file_path]} target="_blank" rel="noreferrer" className="font-semibold text-[#7B1113] hover:underline">View</a>
                        ) : (
                          <span className="text-[10px] font-semibold text-[#8B7376]">uploaded</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-[#241012]/[0.06] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-[11px] text-[#8B7376]">
                {viewingAppr.validation_status === "Validated"
                  ? "This scholar was validated against the Registrar database."
                  : "Validate this scholar to confirm they exist and are enrolled in the Registrar."}
              </div>
              <button
                onClick={() => handleValidate(viewingAppr)}
                disabled={viewingAppr.validation_status === "Validated" || validatingId !== null}
                className="rounded-xl bg-gradient-to-r from-green-600 to-green-700 px-4 py-2.5 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-40"
              >
                {validatingId === viewingAppr.application_id ? "Validating..." : viewingAppr.validation_status === "Validated" ? "&#10003; Validated" : "Validate against Registrar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
