"use client";
import toast from "react-hot-toast";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDate, formatDateTime, downloadCsv } from "@/lib/utils";
import { STATUS_STYLES, PROGRAM_REQUIREMENT_OPTIONS, getProgramRequirementDocs } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface ScholarshipProgram {
  scholarship_id: number;
  scholarship_name: string;
  description?: string;
  requirements?: string;
  deadline?: string;
  status: "Open" | "Closed";
  created_by?: number;
  created_at?: string;
}

interface ProgramApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_date: string;
  application_status: string;
  remarks?: string | null;
  student_accounts?: {
    given_name?: string; last_name?: string; student_number?: string;
    program_name?: string; year_level?: string; sex?: string;
    registration_status?: string; account_status?: string;
  } | {
    given_name?: string; last_name?: string; student_number?: string;
    program_name?: string; year_level?: string; sex?: string;
    registration_status?: string; account_status?: string;
  }[];
}

interface ProgramForm {
  application_id: number;
  student_id?: string;
  given_name?: string; last_name?: string; middle_name?: string; ext_name?: string;
  sex?: string; birthdate?: string; complete_program_name?: string; year_level?: string;
  father_name?: string; mother_name?: string; street_barangay?: string; zipcode?: string;
  disability?: string; indigenous_people_group?: string; contact_number?: string;
  email_address?: string; income_tax_return?: string; annual_income_family?: number;
}

interface ProgramDoc {
  document_id: number;
  student_id: number;
  application_id?: number;
  document_type: string;
  file_path: string;
  upload_date: string;
}

interface ProgramAcad {
  record_id: number;
  student_id: number;
  applicant_type?: string;
  shs_gwa?: number;
  college_gpa?: number;
  proof_image_path?: string;
}

function fill(value: unknown): string {
  if (value === null || value === undefined || value === "") return "N/A";
  return String(value);
}

const emptyForm = { scholarship_name: "", description: "", requirements: [] as string[], deadline: "", status: "Open" as "Open" | "Closed" };

export default function ManageProgramsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [programs, setPrograms] = useState<ScholarshipProgram[]>([]);
  const [apps, setApps] = useState<ProgramApplication[]>([]);
  const [forms, setForms] = useState<ProgramForm[]>([]);
  const [docs, setDocs] = useState<ProgramDoc[]>([]);
  const [acads, setAcads] = useState<ProgramAcad[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [previewProgram, setPreviewProgram] = useState<ScholarshipProgram | null>(null);
  const [editingPreview, setEditingPreview] = useState(false);
  const [previewDraft, setPreviewDraft] = useState<{
    scholarship_name: string;
    description: string;
    requirements: string[];
    deadline: string;
    status: "Open" | "Closed";
  } | null>(null);
  const [savingPreview, setSavingPreview] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [progQ, appQ, formQ, docsQ, acadQ] = await Promise.all([
        sb.from("scholarship_programs").select("*").order("created_at", { ascending: false }),
        sb.from("scholarship_applications")
          .select("application_id, student_id, scholarship_id, application_date, application_status, remarks, student_accounts(given_name, last_name, student_number, program_name, year_level, sex, registration_status, account_status)")
          .order("application_date", { ascending: false }),
        sb.from("ched_form_input").select("*").order("ched_form_id", { ascending: false }),
        sb.from("support_documents").select("*").order("upload_date", { ascending: false }),
        sb.from("support_academic_records").select("*").order("created_at", { ascending: false }),
      ]);
      if (!progQ.error) setPrograms(progQ.data || []);
      if (!appQ.error) setApps(appQ.data || []);
      if (!formQ.error) setForms(formQ.data || []);
      if (!docsQ.error) setDocs(docsQ.data || []);
      if (!acadQ.error) setAcads(acadQ.data || []);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  function openNew() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError("");
    setMessage("");
    setShowModal(true);
  }

  function openEdit(p: ScholarshipProgram) {
    setEditingId(p.scholarship_id);
    setForm({
      scholarship_name: p.scholarship_name || "",
      description: p.description || "",
      requirements: getProgramRequirementDocs(p.requirements),
      deadline: p.deadline || "",
      status: p.status || "Open",
    });
    setFormError("");
    setMessage("");
    setShowModal(true);
  }

  function toggleRequirement(requirement: string, checked: boolean) {
    setFormError("");
    setForm((prev) => ({
      ...prev,
      requirements: checked
        ? prev.requirements.includes(requirement)
          ? prev.requirements
          : [...prev.requirements, requirement]
        : prev.requirements.filter((r) => r !== requirement),
    }));
  }

  function openPreview(p: ScholarshipProgram) {
    setPreviewProgram(p);
    setPreviewDraft({
      scholarship_name: p.scholarship_name || "",
      description: p.description || "",
      requirements: getProgramRequirementDocs(p.requirements),
      deadline: p.deadline || "",
      status: p.status || "Open",
    });
    setEditingPreview(false);
  }

  function closePreview() {
    setPreviewProgram(null);
    setPreviewDraft(null);
    setEditingPreview(false);
    setFormError("");
  }

  function togglePreviewRequirement(requirement: string, checked: boolean) {
    if (!previewDraft) return;
    setPreviewDraft({
      ...previewDraft,
      requirements: checked
        ? previewDraft.requirements.includes(requirement)
          ? previewDraft.requirements
          : [...previewDraft.requirements, requirement]
        : previewDraft.requirements.filter((r) => r !== requirement),
    });
  }

  async function handleSavePreview() {
    if (!previewProgram || !previewDraft) return;
    const name = previewDraft.scholarship_name.trim();
    if (!name) {
      setFormError("Please enter a scholarship name.");
      return;
    }
    if (previewDraft.requirements.length === 0) {
      setFormError("Please check at least one requirement for this program.");
      return;
    }
    setFormError("");
    setSavingPreview(true);
    const ordered = PROGRAM_REQUIREMENT_OPTIONS.filter((opt) =>
      previewDraft.requirements.includes(opt)
    );
    const sb = getSupabase();
    const payload = {
      scholarship_name: name,
      description: previewDraft.description.trim() || null,
      requirements: ordered.join(" | "),
      deadline: previewDraft.deadline || null,
      status: previewDraft.status,
    };
    const res = await sb
      .from("scholarship_programs")
      .update(payload)
      .eq("scholarship_id", previewProgram.scholarship_id);
    setSavingPreview(false);
    if (res.error) {
      setFormError(res.error.message);
      return;
    }
    setPreviewProgram({ ...previewProgram, ...payload, deadline: payload.deadline ?? undefined, description: payload.description ?? undefined });
    setPreviewDraft({ ...previewDraft, scholarship_name: name, requirements: ordered });
    setEditingPreview(false);
    const { data } = await sb.from("scholarship_programs").select("*").order("created_at", { ascending: false });
    if (data) setPrograms(data);
    setMessage(`Updated "${name}" — ${ordered.length} requirement(s) checked.`);
    toast.success(`Updated "${name}" — ${ordered.length} requirement(s) checked.`);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setFormError("");

    const name = form.scholarship_name.trim();
    if (!name) {
      setFormError("Please enter a scholarship name.");
      return;
    }
    if (form.requirements.length === 0) {
      setFormError("Please check at least one requirement for this program. Students will be asked to upload exactly what you check.");
      return;
    }

    // Keep only canonical options, in stable order, pipe-separated for storage.
    const orderedRequirements = PROGRAM_REQUIREMENT_OPTIONS.filter((opt) =>
      form.requirements.includes(opt)
    );

    setSaving(true);
    const sb = getSupabase();

    const payload = {
      scholarship_name: name,
      description: form.description.trim() || null,
      requirements: orderedRequirements.join(" | "),
      deadline: form.deadline || null,
      status: form.status,
    };

    const res = editingId
      ? await sb.from("scholarship_programs").update(payload).eq("scholarship_id", editingId)
      : await sb.from("scholarship_programs").insert(payload);

    setSaving(false);

    if (res.error) {
      setMessage(res.error.message);
      return;
    }

    setShowModal(false);
    setMessage(
      editingId
        ? `Updated "${name}" — ${orderedRequirements.length} requirement(s) checked.`
        : `Created "${name}" — ${orderedRequirements.length} requirement(s) checked.`
    );
    const { data } = await sb.from("scholarship_programs").select("*").order("created_at", { ascending: false });
    if (data) setPrograms(data);
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this program?")) return;
    const sb = getSupabase();
    const { error } = await sb.from("scholarship_programs").delete().eq("scholarship_id", id);
    if (!error) setPrograms((prev) => prev.filter((p) => p.scholarship_id !== id));
  }

  function buildProgramCsvRows(scholarshipId: number) {
    const prog = programs.find((p) => p.scholarship_id === scholarshipId);
    const programApps = apps
      .filter((a) => a.scholarship_id === scholarshipId)
      .sort((a, b) => a.application_id - b.application_id);
    const docByApp: Record<number, string> = {};
    const docFilesByApp: Record<number, string> = {};
    docs.forEach((d) => {
      const key = d.application_id ?? d.student_id;
      if (!key) return;
      docByApp[key] = docByApp[key] ? `${docByApp[key]}; ${d.document_type}` : d.document_type;
      docFilesByApp[key] = docFilesByApp[key] ? `${docFilesByApp[key]}; ${d.file_path}` : d.file_path;
    });
    const rows = programApps.map((a) => {
      const c = forms.find((f) => f.application_id === a.application_id);
      const sa = Array.isArray(a.student_accounts) ? a.student_accounts[0] : a.student_accounts;
      const acad = acads.find((ac) => ac.student_id === a.student_id);
      return {
        "Application ID": a.application_id,
        "Student No.": fill(sa?.student_number || c?.student_id),
        "Last Name": fill(c?.last_name || sa?.last_name),
        "First Name": fill(c?.given_name || sa?.given_name),
        "Middle Name": fill(c?.middle_name),
        "Ext. Name": fill(c?.ext_name),
        "Sex": fill(c?.sex || sa?.sex),
        "Birthdate": fill(c?.birthdate),
        "Program": fill(c?.complete_program_name || sa?.program_name),
        "Year Level": fill(c?.year_level || sa?.year_level),
        "Scholarship Program": fill(prog?.scholarship_name),
        "Application Status": a.application_status,
        "Application Date": formatDateTime(a.application_date),
        "Father's Full Name": fill(c?.father_name),
        "Mother's Full Name": fill(c?.mother_name),
        "Street / Barangay": fill(c?.street_barangay),
        "Zipcode": fill(c?.zipcode),
        "Contact Number": fill(c?.contact_number),
        "Email Address": fill(c?.email_address),
        "Disability": fill(c?.disability),
        "Indigenous People Group": fill(c?.indigenous_people_group),
        "Annual Family Income (PHP)": c?.annual_income_family != null ? Number(c.annual_income_family) : 0,
        "ITR File Present": c?.income_tax_return ? "Yes" : "No",
        "ITR File Path": fill(c?.income_tax_return),
        "Registration Status": fill(sa?.registration_status),
        "Account Status": fill(sa?.account_status),
        "Supporting Documents": fill(docByApp[a.application_id]),
        "Supporting Doc Files": fill(docFilesByApp[a.application_id]),
        "Applicant Type": fill(acad?.applicant_type),
        "SHS GWA": acad?.shs_gwa != null ? Number(acad.shs_gwa) : acad?.college_gpa != null ? Number(acad.college_gpa) : "N/A",
        "College GPA": acad?.college_gpa != null ? Number(acad.college_gpa) : acad?.shs_gwa != null ? Number(acad.shs_gwa) : "N/A",
        "Academic Proof File": fill(acad?.proof_image_path),
        "Remarks": fill(a.remarks),
      };
    });
    return { rows, name: prog?.scholarship_name || "scholarship" };
  }

  function exportProgramCsv(scholarshipId: number) {
    const { rows, name } = buildProgramCsvRows(scholarshipId);
    if (!rows.length) { setMessage("No applications yet for this scholarship."); return; }
    downloadCsv(`${name.replace(/[^\w]+/g, "_").toLowerCase()}-applications.csv`, rows);
    setMessage(`Exported ${rows.length} application form(s) for "${name}".`);
    toast.success(`Exported ${rows.length} application form(s) for "${name}".`);
  }

  function exportAllProgramsCsv() {
    const all = programs.flatMap((p) => buildProgramCsvRows(p.scholarship_id).rows);
    if (!all.length) { setMessage("No applications found yet."); return; }
    downloadCsv("all-scholarship-applications.csv", all);
    setMessage(`Exported ${all.length} application form(s) across all scholarships.`);
    toast.success(`Exported ${all.length} application form(s) across all scholarships.`);
  }

  if (loading) return <Spinner label="Loading programs..." color="maroon" />;

  const cellCls = "border border-[#241012]/10 px-3 py-1.5 align-middle";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Manage Scholarship Programs</h1>
          <p className="mt-1 text-xs text-[#8B7376]">Create, edit, or close the scholarships students can apply to.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={exportAllProgramsCsv}
            disabled={!apps.length}
            className="self-start rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-40"
          >
            &#11015; Export All Applications CSV
          </button>
          <button
            onClick={openNew}
            className="self-start rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:brightness-110"
          >
            ＋ Create scholarship program
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded-xl border border-[#7B1113]/20 bg-white px-4 py-3 text-xs font-medium text-[#7B1113] shadow-sm">
          {message}
        </div>
      )}

      {programs.length === 0 ? (
        <EmptyState icon="&#128218;" title="No programs yet" hint="Create your first scholarship program." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">Scholarship Programs</p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                {programs.length} program{programs.length === 1 ? "" : "s"} &middot; {apps.length} applicant{apps.length === 1 ? "" : "s"} &middot;{" "}
                <span className="font-semibold text-[#7B1113]">one row per program</span>
                {" \u00b7 "}
                <span className="text-[#6B5458]">Click Edit to change a program, View Form to preview what students see, or Delete to remove it</span>
              </p>
            </div>
          </div>

          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full min-w-[980px] border-collapse text-left text-[11px] text-[#241012]">
              <thead className="sticky top-0 z-10 bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458] shadow-[0_1px_0_0_rgba(36,16,18,0.07)]">
                <tr>
                  <th className={`${cellCls} w-12 text-center font-bold`}>#</th>
                  <th className={`${cellCls} font-bold`}>Program</th>
                  <th className={`${cellCls} font-bold`}>Requirements</th>
                  <th className={`${cellCls} w-28 font-bold`}>Deadline</th>
                  <th className={`${cellCls} w-20 font-bold`}>Status</th>
                  <th className={`${cellCls} w-24 font-bold`}>Applicants</th>
                  <th className={`${cellCls} w-36 font-bold`}>Created</th>
                  <th className={`${cellCls} w-72 font-bold`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {programs.map((p, i) => {
                  const reqs = getProgramRequirementDocs(p.requirements);
                  const applicantCount = apps.filter((a) => a.scholarship_id === p.scholarship_id).length;
                  return (
                    <tr key={p.scholarship_id} className={i % 2 ? "bg-[#FAF7F5]/60" : "bg-white"}>
                      <td className={`${cellCls} text-center font-bold text-[#6B5458]`}>{i + 1}</td>
                      <td className={cellCls}>
                        <div className="font-bold text-[#7B1113]">{p.scholarship_name}</div>
                        <div className="line-clamp-2 max-w-[280px] text-[10px] font-normal text-[#8B7376]">
                          {p.description || "No description."}
                        </div>
                      </td>
                      <td className={cellCls}>
                        {reqs.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {reqs.map((r) => (
                              <span key={r} className="rounded-full bg-[#7B1113]/5 px-2 py-0.5 text-[10px] font-semibold text-[#7B1113]">
                                {r}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[10px] font-normal text-[#8B7376]">
                            None listed &mdash; COR, Valid ID and Signature Form apply.
                          </span>
                        )}
                        <div className="text-[10px] font-normal text-[#8B7376]">
                          {reqs.length} of {PROGRAM_REQUIREMENT_OPTIONS.length} requirement(s) checked
                        </div>
                      </td>
                      <td className={`${cellCls} whitespace-nowrap`}>{formatDate(p.deadline)}</td>
                      <td className={cellCls}>
                        <Badge className={STATUS_STYLES[p.status] || ""}>{p.status}</Badge>
                      </td>
                      <td className={`${cellCls} whitespace-nowrap text-center font-bold text-[#7B1113]`}>{applicantCount}</td>
                      <td className={`${cellCls} whitespace-nowrap text-[#6B5458]`}>{formatDateTime(p.created_at)}</td>
                      <td className={cellCls}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            onClick={() => exportProgramCsv(p.scholarship_id)}
                            title={`Download ${applicantCount} application form(s) as CSV`}
                            className="rounded-md border border-[#7B1113]/25 px-2.5 py-1 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                          >
                            &#11015; Applications CSV
                          </button>
                          <button
                            onClick={() => openPreview(p)}
                            title="Preview and edit the student application form for this program"
                            className="rounded-md border border-[#7B1113]/25 px-2.5 py-1 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                          >
                            &#128196; View Form
                          </button>
                          <button
                            onClick={() => openEdit(p)}
                            title={`Edit ${p.scholarship_name}`}
                            className="rounded-md bg-[#7B1113] px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-[#540111]"
                          >
                            &#9998; Edit
                          </button>
                          <button
                            onClick={() => handleDelete(p.scholarship_id)}
                            title={`Delete ${p.scholarship_name}`}
                            className="rounded-md border border-red-200 px-2.5 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                          >
                            &#128465; Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5 text-[10px] text-[#6B5458]">
            <span>Open programs <b className="text-[#7B1113]">{programs.filter((p) => p.status === "Open").length}</b></span>
            <span>Closed programs <b className="text-[#7B1113]">{programs.filter((p) => p.status === "Closed").length}</b></span>
            <span>Applications <b className="text-[#7B1113]">{apps.length}</b></span>
            <span>Supporting documents <b className="text-[#7B1113]">{docs.length}</b></span>
            <span>Academic records <b className="text-[#7B1113]">{acads.length}</b></span>
            <span className="ml-auto">Showing <b className="text-[#7B1113]">{programs.length}</b> of {programs.length} programs</span>
          </div>
        </div>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowModal(false)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#241012]/[0.06] px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold text-[#241012]">
                  {editingId ? "Edit Program" : "Create New Program"}
                </h3>
                <p className="mt-0.5 text-[11px] text-[#8B7376]">
                  Scholarship name, description, required documents, deadline and status &mdash; everything students see before they apply.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-full p-1 text-lg leading-none text-[#8B7376] transition hover:bg-[#7B1113]/5 hover:text-[#7B1113]"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
              <div className="max-h-[55vh] overflow-auto">
                <div className="space-y-4 border-b border-[#241012]/[0.06] bg-white px-5 py-4">
                  <label className="block text-xs font-semibold text-[#241012]">
                    Scholarship Name
                    <input
                      type="text"
                      value={form.scholarship_name}
                      onChange={(e) => setForm({ ...form, scholarship_name: e.target.value })}
                      required
                      className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                    />
                  </label>
                  <label className="block text-xs font-semibold text-[#241012]">
                    Description
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                    />
                  </label>
                </div>

                <div className="border-b border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-5 py-4">
                  <div className="block text-xs font-semibold text-[#241012]">
                    <span>
                      Requirements
                      <span className="ml-1 font-normal text-[#7B1113]">* required</span>
                    </span>
                    <span className="mt-1 block text-[10px] font-normal text-[#8B7376]">
                      Check every document students must upload. Checked items appear on the student application form and are required before they can submit.
                    </span>
                    <div
                      className={`mt-2 grid gap-x-4 gap-y-2 rounded-xl border p-3 sm:grid-cols-2 ${
                        formError && form.requirements.length === 0
                          ? "border-red-300 bg-red-50/50"
                          : "border-[#241012]/[0.06]"
                      }`}
                    >
                      {PROGRAM_REQUIREMENT_OPTIONS.map((requirement) => (
                        <label key={requirement} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#241012]/[0.06] px-3 py-2 text-[11px] text-[#241012] transition hover:border-[#7B1113]/40 has-checked:border-[#7B1113] has-checked:bg-[#FAF5F5]">
                          <input
                            type="checkbox"
                            checked={form.requirements.includes(requirement)}
                            onChange={(e) => toggleRequirement(requirement, e.target.checked)}
                            className="h-3.5 w-3.5 accent-[#7B1113]"
                          />
                          {requirement}
                        </label>
                      ))}
                    </div>
                    <p className={`mt-1.5 text-[10px] font-semibold ${form.requirements.length ? "text-[#7B1113]" : "text-[#8B7376]"}`}>
                      {form.requirements.length} of {PROGRAM_REQUIREMENT_OPTIONS.length} checked
                      {form.requirements.length > 0 ? `: ${form.requirements.join(", ")}` : " — select at least one"}
                    </p>
                  </div>
                </div>

                <div className="space-y-4 border-b border-[#241012]/[0.06] bg-white px-5 py-4">
                  {formError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-700">
                      {formError}
                    </div>
                  )}
                  <label className="block text-xs font-semibold text-[#241012]">
                    Deadline
                    <input
                      type="date"
                      value={form.deadline}
                      onChange={(e) => setForm({ ...form, deadline: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                    />
                  </label>
                  <label className="block text-xs font-semibold text-[#241012]">
                    Status
                    <select
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as "Open" | "Closed" })}
                      className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                    >
                      <option value="Open">Open</option>
                      <option value="Closed">Closed</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#241012]/[0.06] px-5 py-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
                >
                  {saving ? "Saving..." : editingId ? "Update" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {previewProgram && previewDraft && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={closePreview}>
          <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-[#241012]/[0.06] px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold text-[#241012]">
                  {editingPreview ? "Edit Application Form" : "Student Application Form — Preview"}
                </h3>
                <p className="mt-0.5 text-[11px] text-[#8B7376]">
                  {editingPreview ? (
                    <>Change the program details and requirements students must check before applying.</>
                  ) : (
                    <>This is what students see when they apply to <span className="font-semibold text-[#7B1113]">{previewProgram.scholarship_name}</span>.</>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={closePreview}
                className="rounded-full p-1 text-lg leading-none text-[#8B7376] transition hover:bg-[#7B1113]/5 hover:text-[#7B1113]"
              >
                &times;
              </button>
            </div>

            <div className="max-h-[55vh] overflow-auto">
              {editingPreview ? (
                <>
                  <div className="space-y-3 border-b border-[#241012]/[0.06] bg-white px-5 py-4">
                    <label className="block text-xs font-semibold text-[#241012]">
                      Scholarship Name *required
                      <input
                        type="text"
                        value={previewDraft.scholarship_name}
                        onChange={(e) => setPreviewDraft({ ...previewDraft, scholarship_name: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                    <label className="block text-xs font-semibold text-[#241012]">
                      Description
                      <textarea
                        value={previewDraft.description}
                        onChange={(e) => setPreviewDraft({ ...previewDraft, description: e.target.value })}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                      />
                    </label>
                  </div>
                  <div className="space-y-3 border-b border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-5 py-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-xs font-semibold text-[#241012]">
                        Deadline
                        <input
                          type="date"
                          value={previewDraft.deadline}
                          onChange={(e) => setPreviewDraft({ ...previewDraft, deadline: e.target.value })}
                          className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                        />
                      </label>
                      <label className="block text-xs font-semibold text-[#241012]">
                        Status
                        <select
                          value={previewDraft.status}
                          onChange={(e) => setPreviewDraft({ ...previewDraft, status: e.target.value as "Open" | "Closed" })}
                          className="mt-1 w-full rounded-lg border border-[#241012]/10 px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                        >
                          <option value="Open">Open</option>
                          <option value="Closed">Closed</option>
                        </select>
                      </label>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-[#241012]">
                        Requirements *required
                        <span className="ml-1 font-normal text-[#7B1113]">* required</span>
                      </p>
                      <p className="mt-0.5 text-[10px] font-normal text-[#8B7376]">
                        Checked items are what students must upload. At least one must be checked.
                      </p>
                      <div
                        className={`mt-2 grid gap-x-4 gap-y-2 rounded-xl border p-3 sm:grid-cols-2 ${
                          formError && previewDraft.requirements.length === 0
                            ? "border-red-300 bg-red-50/50"
                            : "border-[#241012]/[0.06]"
                        }`}
                      >
                        {PROGRAM_REQUIREMENT_OPTIONS.map((requirement) => (
                          <label key={requirement} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[#241012]/[0.06] px-3 py-2 text-[11px] text-[#241012] transition hover:border-[#7B1113]/40 has-checked:border-[#7B1113] has-checked:bg-[#FAF5F5]">
                            <input
                              type="checkbox"
                              checked={previewDraft.requirements.includes(requirement)}
                              onChange={(e) => togglePreviewRequirement(requirement, e.target.checked)}
                              className="h-3.5 w-3.5 accent-[#7B1113]"
                            />
                            {requirement}
                          </label>
                        ))}
                      </div>
                      <p className={`mt-1.5 text-[10px] font-semibold ${previewDraft.requirements.length ? "text-[#7B1113]" : "text-[#8B7376]"}`}>
                        {previewDraft.requirements.length} of {PROGRAM_REQUIREMENT_OPTIONS.length} checked
                        {previewDraft.requirements.length > 0 ? `: ${previewDraft.requirements.join(", ")}` : " — select at least one"}
                      </p>
                    </div>
                    {formError && (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-700">
                        {formError}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="border-b border-[#241012]/[0.06] bg-white px-5 py-4 text-xs text-[#241012]">
                    <p className="font-bold text-[#7B1113]">{previewProgram.scholarship_name}</p>
                    <p className="mt-1 text-[#6B5458]">{previewProgram.description || "No description provided."}</p>
                    <p className="mt-2 text-[11px] text-[#8B7376]">
                      Deadline: <span className="font-semibold text-[#241012]">{formatDate(previewProgram.deadline)}</span>
                      {" · "}Status: <span className="font-semibold text-[#241012]">{previewProgram.status}</span>
                    </p>
                  </div>

                  <div className="space-y-3 border-b border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-5 py-4 text-xs text-[#241012]">
                    <p className="font-bold uppercase tracking-wide text-[#7B1113]">Section 1 — Scholarship Program</p>
                    <p>Dropdown to choose {previewProgram.scholarship_name} and note the deadline.</p>

                    <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 2 — CHED Application Form</p>
                    <ul className="list-inside list-disc space-y-1 text-[#6B5458]">
                      <li>Father&apos;s Full Name *</li>
                      <li>Mother&apos;s Full Name *</li>
                      <li>Street / Barangay *</li>
                      <li>Zipcode *</li>
                      <li>Contact Number *</li>
                      <li>Email Address *</li>
                      <li>Disability / IP Group (optional)</li>
                      <li>Annual Family Income (PHP) *</li>
                      <li>Income Tax Return (ITR) File * — JPG / PNG / PDF, max 10 MB (OCR may auto-detect income)</li>
                    </ul>

                    <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 3 — Supporting Documents</p>
                    {getProgramRequirementDocs(previewProgram.requirements).length > 0 ? (
                      <>
                        <p className="text-[#6B5458]">Students must upload every checked requirement below before they can submit:</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {getProgramRequirementDocs(previewProgram.requirements).map((r) => (
                            <span key={r} className="rounded-full bg-[#7B1113]/10 px-2.5 py-1 text-[10px] font-bold text-[#7B1113]">
                              {r} *
                            </span>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="text-amber-700">No requirements checked yet — students fall back to COR, Valid ID, Signature Form.</p>
                    )}

                    <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 4 — Academic Records</p>
                    <ul className="list-inside list-disc space-y-1 text-[#6B5458]">
                      <li>Applicant Type * (Freshman / Alumni)</li>
                      <li>SHS GWA or College GPA * (1–100)</li>
                      <li>Proof File *</li>
                    </ul>

                    <p className="mt-3 text-[11px] font-semibold text-[#7B1113]">Submit Application</p>
                    <p className="text-[#8B7376]">All fields marked * are required. Missing files block submission.</p>
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#241012]/[0.06] px-5 py-3">
              {editingPreview ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setEditingPreview(false); setFormError(""); }}
                    disabled={savingPreview}
                    className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSavePreview}
                    disabled={savingPreview}
                    className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
                  >
                    {savingPreview ? "Saving..." : "Save Form"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => { setEditingPreview(true); setFormError(""); }}
                    className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                  >
                    Edit Form
                  </button>
                  <button
                    type="button"
                    onClick={() => { const p = previewProgram; closePreview(); openEdit(p); }}
                    className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                  >
                    Open Full Editor
                  </button>
                  <button
                    type="button"
                    onClick={closePreview}
                    className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110"
                  >
                    Close Preview
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
