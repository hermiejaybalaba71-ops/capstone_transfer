"use client";
import toast from "react-hot-toast";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime, downloadCsv } from "@/lib/utils";
import { STATUS_STYLES, getProgramRequirementDocs, matchRequirementOption } from "@/lib/constants";
import { autoRejectSiblings } from "@/lib/scholarship";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

const FILTER_TABS = [
  { key: "", label: "All", active: "bg-[#7B1113] text-white", idle: "text-[#6B5458] hover:bg-[#7B1113]/5 hover:text-[#7B1113]" },
  { key: "Pending", label: "Pending", active: "bg-amber-500 text-white", idle: "text-amber-700 hover:bg-amber-50" },
  { key: "Approved", label: "Approved", active: "bg-green-600 text-white", idle: "text-green-700 hover:bg-green-50" },
  { key: "Not Approved", label: "Not Approved", active: "bg-red-600 text-white", idle: "text-red-600 hover:bg-red-50" },
] as const;

const STATUS_ACTIONS = [
  { status: "Pending", label: "Pending", active: "bg-amber-500 border-amber-500 text-white", idle: "border-amber-300 text-amber-700 hover:bg-amber-50" },
] as const;

interface ScholarshipApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_date: string;
  application_status: string;
  remarks?: string | null;
  scholarship_programs?: { scholarship_name: string; requirements?: string };
  student_accounts?: { given_name: string; last_name: string; student_number: string; program_name: string; year_level?: string; sex?: string; registration_status?: string; account_status?: string };
}

interface SupportDocument {
  document_id: number;
  student_id: number;
  application_id?: number;
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

const NO_VALUE = "";

interface ScholarshipProgramOption {
  scholarship_id: number;
  scholarship_name: string;
}

function fill(value: unknown): string {
  if (value === null || value === undefined || value === "") return "N/A";
  return String(value);
}

/** The parsed shape the import API returns - only what merging the file's rows
    into the applications table needs. */
interface ImportedSheetData {
  import_id: string;
  saved?: boolean;
  file_name: string;
  file_size: number;
  columns: string[];
  rows: Record<string, string>[];
  row_count: number;
  year_column: string;
  group_column: string;
  year_kind?: string;
  years?: string[];
}

/** One imported file row, already shaped like the table's cells. */
interface ImportedRowView {
  sourceFile: string;
  studentId: string;
  name: string;
  program: string;
  year: string;
}

/** A cell value, treating "" and the em-dash placeholder the registrar exports
    use ("—") as "no value". */
function cellVal(row: Record<string, string>, column: string): string {
  if (!column) return "";
  const raw = (row[column] ?? "").trim();
  return raw === "—" || raw === "-" ? "" : raw;
}

/** First column whose name matches `re`, so the merge works on any registrar
    export (student_id / student_no / ID No..., complete_program_name /
    program / course...) instead of hard-coding one file's headers. */
function pickCol(columns: string[], re: RegExp): string {
  return columns.find((c) => re.test(c.trim())) || "";
}

/** Imported files carry thousands of rows; this many render first, with a
    "Show more" button paging the rest in. */
const INITIAL_IMPORTED_ROWS = 100;
const IMPORTED_PAGE = 100;

/** Any year-level spelling ("3", "3rd", "3rd Year") -> the canonical label
    ("3rd Year"); empty for anything else. Mirrors ordinal_year() in
    ml/read_sheet.py so imported rows read exactly like the DB rows. */
function normalizeYearLevel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "—") return "";
  const match = /^(\d{1,2})(?:st|nd|rd|th)?(?:\s*year|\s*level)?$/i.exec(raw);
  if (!match) return /^(?:1st|2nd|3rd|4th)\s+year$/i.test(raw) ? raw.replace(/\s+/g, " ") : "";
  const n = Number(match[1]);
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] || "th";
  return `${n}${suffix} Year`;
}

export default function ApplicationsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [applications, setApplications] = useState<ScholarshipApplication[]>([]);
  const [docs, setDocs] = useState<SupportDocument[]>([]);
  const [acads, setAcads] = useState<SupportAcademicRecord[]>([]);
  const [chedForms, setChedForms] = useState<ChedFormInput[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [programFilter, setProgramFilter] = useState("");
  const [viewingId, setViewingId] = useState<number | null>(null);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [urlsLoading, setUrlsLoading] = useState(false);
  const [statusDraft, setStatusDraft] = useState<Record<number, { status: string; remarks: string }>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchMsg, setBatchMsg] = useState("");
  const [notifyDraft, setNotifyDraft] = useState<Record<number, string>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [search, setSearch] = useState("");
  // Every program the Admin created, fetched straight from the table so a brand
  // new (still empty) program shows up as a chip even before anyone applies.
  const [allPrograms, setAllPrograms] = useState<ScholarshipProgramOption[]>([]);
  // Uploaded previous-application files and their rows persist in Supabase
  // Storage and merge into the main table below.
  const [importedSheets, setImportedSheets] = useState<ImportedSheetData[]>([]);
  const [importing, setImporting] = useState(false);
  const [deletingImport, setDeletingImport] = useState(false);
  // How many imported rows the table currently renders - the files carry
  // thousands of rows, so they page in rather than render all at once.
  const [importedVisible, setImportedVisible] = useState(INITIAL_IMPORTED_ROWS);
  // The one imported-file category is folded until its file-name row is clicked.
  const [importedCollapsed, setImportedCollapsed] = useState(true);
  const importInputRef = useRef<HTMLInputElement>(null);
  const scrollToImportedRowsRef = useRef(false);

  useEffect(() => {
    if (importedCollapsed || !scrollToImportedRowsRef.current) return;
    scrollToImportedRowsRef.current = false;
    document.getElementById("imported-applications-group")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [importedCollapsed]);

  // Restore every upload so a refresh does not wipe the imported rows.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/import/parse?scope=applications");
        const json = (await res.json()) as {
          error?: string;
          sheets?: Array<Partial<ImportedSheetData>>;
          restored?: boolean;
        } & Partial<ImportedSheetData>;
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error || "Could not restore imported files.");
        const restored = Array.isArray(json.sheets)
          ? json.sheets
          : json.restored && Array.isArray(json.rows) && Array.isArray(json.columns)
            ? [json]
            : [];
        setImportedSheets(restored.flatMap((item, index) => {
          if (!Array.isArray(item.columns) || !Array.isArray(item.rows)) return [];
          return [{
            import_id: String(item.import_id || `${item.file_name || "file"}-${index}`),
            saved: true,
            file_name: String(item.file_name || "imported file"),
            file_size: Number(item.file_size ?? 0),
            columns: item.columns.map(String),
            rows: item.rows as Record<string, string>[],
            row_count: Number(item.row_count ?? item.rows.length),
            year_column: String(item.year_column || ""),
            group_column: String(item.group_column || ""),
            year_kind: String(item.year_kind || ""),
            years: Array.isArray(item.years) ? item.years.map(String) : [],
          }];
        }));
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Could not restore imported files.";
          setMessage(msg);
          toast.error(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [appsQ, docsQ, acadsQ, chedQ, progsQ] = await Promise.all([
        sb.from("scholarship_applications")
          .select("*, scholarship_programs(scholarship_name, requirements), student_accounts(given_name, last_name, student_number, program_name, year_level, sex, registration_status, account_status)")
          .order("application_date", { ascending: false }),
        sb.from("support_documents").select("*").order("upload_date", { ascending: false }),
        sb.from("support_academic_records").select("*").order("created_at", { ascending: false }),
        sb.from("ched_form_input").select("*").order("ched_form_id", { ascending: false }),
        sb.from("scholarship_programs").select("scholarship_id, scholarship_name").order("created_at", { ascending: false }),
      ]);

      if (!appsQ.error) setApplications(appsQ.data || []);
      if (!docsQ.error) setDocs(docsQ.data || []);
      if (!acadsQ.error) setAcads(acadsQ.data || []);
      if (!chedQ.error) setChedForms(chedQ.data || []);
      if (!progsQ.error) setAllPrograms((progsQ.data || []) as ScholarshipProgramOption[]);
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

  const appChed = (app: ScholarshipApplication) => chedForms.filter((c) => c.application_id === app.application_id);
  const appDocs = (app: ScholarshipApplication) => docs.filter((d) => d.application_id === app.application_id || d.student_id === app.student_id);
  const appAcads = (app: ScholarshipApplication) => acads.filter((a) => a.student_id === app.student_id);

  // Requirement compliance for one application: the program's checked requirements
  // (COR / Valid ID / Signature Form / ITR / …) vs what the student actually uploaded.
  // ITR lives in the CHED form's income_tax_return field; the rest in support_documents.
  const requirementStats = (app: ScholarshipApplication) => {
    const required = getProgramRequirementDocs(app.scholarship_programs?.requirements);
    const present = new Set<string>();
    for (const d of docs.filter((x) => x.application_id === app.application_id)) {
      const canon = matchRequirementOption(d.document_type);
      if (canon) present.add(canon);
    }
    if (chedForms.some((c) => c.application_id === app.application_id && !!c.income_tax_return)) {
      present.add("Income Tax Return (ITR)");
    }
    const missing = required.filter((r) => !present.has(r));
    return { required, missing, done: required.length - missing.length };
  };

  // Declared BEFORE filteredApps on purpose: the program filter calls programKey
  // on every row, and a `const` is in its temporal dead zone until this line
  // runs. This only ever appeared to work because `!programFilter ||` used to
  // short-circuit while the filter was still empty - the first chip click threw
  // "Cannot access 'ea' before initialization".
  const programKey = (a: ScholarshipApplication) => a.scholarship_programs?.scholarship_name || "No Scholarship Program";

  const filteredApps = applications
    .filter((a) => !statusFilter || a.application_status === statusFilter)
    .filter((a) => !programFilter || programKey(a) === programFilter)
    .filter((a) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const name = `${a.student_accounts?.given_name || ""} ${a.student_accounts?.last_name || ""}`.toLowerCase();
      const studentNo = a.student_accounts?.student_number?.toLowerCase() || "";
      const program = a.student_accounts?.program_name?.toLowerCase() || "";
      const scholarship = a.scholarship_programs?.scholarship_name?.toLowerCase() || "";
      return name.includes(q) || studentNo.includes(q) || program.includes(q) || scholarship.includes(q);
    });

  const pendingCount = applications.filter((a) => a.application_status === "Pending").length;
  const approvedCount = applications.filter((a) => a.application_status === "Approved").length;
  const notApprovedCount = applications.filter((a) => a.application_status === "Not Approved").length;

  // ── Imported file rows, merged into the main table ──────────────────────
  // The uploaded file's rows are mapped into the same shape the table renders
  // (Student ID / Full Name / Program / Year), so they read exactly like the
  // DB rows instead of living in a separate panel. Column names are detected
  // so any registrar export works, not just one file's headers.
  // The file rows that belong on screen for the active search. The WHOLE file
  // is one category - "Previous Scholarship Applications" - so every row is
  // bulked together, never split per course or year. The file carries no
  // application status, so imported rows are shown on the "All" tab only -
  // listing them under "Pending" would be misleading.
  const importedRows: ImportedRowView[] = [];
  if (importedSheets.length && !statusFilter) {
    const q = search.trim().toLowerCase();
    for (const importedSheet of importedSheets) {
      const impCols = {
        studentId: pickCol(importedSheet.columns, /^student[\s_-]*(id|no|number)|^id$|^student$/i),
        last: pickCol(importedSheet.columns, /last[\s_-]*name|surname/i),
        given: pickCol(importedSheet.columns, /given[\s_-]*name|first[\s_-]*name/i),
        middle: pickCol(importedSheet.columns, /middle[\s_-]*name/i),
        ext: pickCol(importedSheet.columns, /\bext\b|extension/i),
        program: pickCol(importedSheet.columns, /program|course/i),
        year: importedSheet.year_column || pickCol(importedSheet.columns, /year[\s_-]*level|level/i),
      };
      for (const row of importedSheet.rows) {
        const last = cellVal(row, impCols.last);
        const given = cellVal(row, impCols.given);
        const middle = cellVal(row, impCols.middle);
        const ext = cellVal(row, impCols.ext);
        const name = `${last}, ${given}${ext ? ` ${ext}` : ""}${middle ? ` ${middle}` : ""}`.replace(/,\s*$/, "");
        const studentId = cellVal(row, impCols.studentId);
        const program = cellVal(row, impCols.program) || "No program listed";
        const year = normalizeYearLevel(cellVal(row, impCols.year));
        if (q && !`${studentId} ${name} ${program} ${year}`.toLowerCase().includes(q)) continue;
        importedRows.push({ sourceFile: importedSheet.file_name, studentId, name, program, year });
      }
    }
  }
  const importedRowCount = importedRows.length;

  // Clickable category chips: one per scholarship program, so Admin can jump to
  // a program and see only the applications filed under it. Counts respect the
  // active status tab (All / Pending / Approved / Not Approved).
  // Union of (a) every program Admin created - including ones nobody has applied
  // to yet - and (b) every program an application still references, so neither an
  // empty new program nor a renamed/deleted one can drop off the chip row.
  const programNames = Array.from(
    new Set([
      ...allPrograms.map((p) => (p.scholarship_name || "").trim()).filter(Boolean),
      ...applications.map(programKey),
    ])
  ).sort((a, b) => a.localeCompare(b));
  const programCounts: Record<string, number> = {};
  for (const name of programNames) {
    programCounts[name] = applications
      .filter((a) => programKey(a) === name && (!statusFilter || a.application_status === statusFilter))
      .length;
  }
  const totalByStatus = !statusFilter ? applications.length : applications.filter((a) => a.application_status === statusFilter).length;

  async function loadFileUrls(app: ScholarshipApplication) {
    setFileUrls({});
    setUrlsLoading(true);
    const sb = getSupabase();
    const urls: Record<string, string> = {};

    // 1) Sign with the logged-in user's key (fast, works for buckets that have a
    //    read policy) ... 2) whatever is left gets signed by the API route with
    //    the service key. The itr-documents bucket has no storage SELECT policy,
    //    so step 1 alone leaves the ITR on "Opening ITR..." forever.
    const signBatch = async (bucket: string, paths: (string | null | undefined)[]) => {
      const uniq = [...new Set(paths.filter((p): p is string => !!p))];
      if (!uniq.length) return;
      try {
        const { data } = await sb.storage.from(bucket).createSignedUrls(uniq, 3600);
        for (const item of data || []) {
          if (item?.signedUrl && item?.path) urls[item.path] = item.signedUrl;
        }
      } catch { /* fall through and ask the server */ }

      const missing = uniq.filter((p) => !urls[p]);
      if (!missing.length) return;
      try {
        const res = await fetch("/api/storage/signed-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, paths: missing }),
        });
        if (res.ok) {
          const payload = (await res.json()) as { urls?: Record<string, string> };
          for (const [p, u] of Object.entries(payload.urls || {})) {
            if (u) urls[p] = u;
          }
        }
      } catch { /* leave those files unreadable rather than spinning forever */ }
    };

    await Promise.all([
      signBatch("support-documents", appDocs(app).map((d) => d.file_path)),
      signBatch("academic-records", appAcads(app).map((a) => a.proof_image_path)),
      signBatch("itr-documents", appChed(app).map((c) => c.income_tax_return)),
    ]);

    setFileUrls({ ...urls });
    setUrlsLoading(false);
  }

  function openDetails(appId: number) {
    const app = applications.find((a) => a.application_id === appId);
    if (!app) return;
    setViewingId(appId);
    loadFileUrls(app);
  }

  async function notifyStudent(app: ScholarshipApplication, title: string, message: string) {
    const sb = getSupabase();
    await sb.from("notifications_announcements").insert({
      student_id: app.student_id,
      title,
      message,
      notification_type: "Status Update",
      status: "Unread",
    });
  }

  function friendlyMessage(app: ScholarshipApplication, status: string) {
    const scholarship = app.scholarship_programs?.scholarship_name || "a scholarship";
    if (status === "Approved") return `Congratulations! Your application for "${scholarship}" has been approved.`;
    if (status === "Not Approved") return `Your application for "${scholarship}" has not been approved. Thank you for applying.`;
    return `Your application for "${scholarship}" is now pending review.`;
  }

  const CHED_ONLY_DECISION = "Only CHED can approve or not-approve applications. Admin can notify, validate against the Registrar, or set the status back to Pending.";

  async function quickStatus(app: ScholarshipApplication, targetStatus: string) {
    if (app.application_status === targetStatus || savingId !== null) return;
    if (targetStatus === "Approved" || (targetStatus === "Not Approved" && app.application_status !== "Not Approved")) {
      setMessage(CHED_ONLY_DECISION);
      return;
    }
    setSavingId(app.application_id);
    setMessage("");
    const sb = getSupabase();
    const { error } = await sb.from("scholarship_applications")
      .update({ application_status: targetStatus })
      .eq("application_id", app.application_id);
    if (error) { setMessage(error.message); setSavingId(null); return; }

    await notifyStudent(app, "Application Update", friendlyMessage(app, targetStatus));

    let rejectNote = "";
    if (targetStatus === "Approved" && app.application_status !== "Approved") {
      const res = await autoRejectSiblings([{ application_id: app.application_id, student_id: app.student_id }], applications);
      if (res.rejectedCount > 0) {
        rejectNote = ` Auto-rejected ${res.rejectedCount} other application(s).`;
        setApplications((prev) => prev.map((a) =>
          a.student_id === app.student_id && a.application_id !== app.application_id
            ? { ...a, application_status: "Not Approved", remarks: `Auto-rejected: already approved for "${app.scholarship_programs?.scholarship_name || "another scholarship"}".` }
            : a
        ));
      }
    }

    setApplications((prev) => prev.map((a) =>
      a.application_id === app.application_id ? { ...a, application_status: targetStatus } : a
    ));
    setMessage(`${app.student_accounts?.last_name || "Application"} marked as ${targetStatus} and the student was notified.${rejectNote}`);
    toast.success(`${app.student_accounts?.last_name || "Application"} marked as ${targetStatus} and the student was notified.${rejectNote}`);
    setSavingId(null);
  }

  async function handleStatusSave(app: ScholarshipApplication) {
    setMessage("");
    setSavingId(app.application_id);
    const draft = statusDraft[app.application_id] || { status: app.application_status, remarks: app.remarks || "" };
    const newStatus = draft.status;
    const newRemarks = draft.remarks.trim() || null;
    if (newStatus === "Approved" || (newStatus === "Not Approved" && app.application_status !== "Not Approved")) {
      setMessage(CHED_ONLY_DECISION);
      setSavingId(null);
      return;
    }
    const sb = getSupabase();
    const { error } = await sb.from("scholarship_applications")
      .update({ application_status: newStatus, remarks: newRemarks })
      .eq("application_id", app.application_id);

    if (error) { setMessage(error.message); setSavingId(null); return; }

    await notifyStudent(app, "Application Update",
      `Your application for "${app.scholarship_programs?.scholarship_name || "a scholarship"}" is now ${newStatus}. ${newRemarks || ""}`.trim());

    let rejectNote = "";
    if (newStatus === "Approved" && app.application_status !== "Approved") {
      const res = await autoRejectSiblings([{ application_id: app.application_id, student_id: app.student_id }], applications);
      if (res.rejectedCount > 0) {
        rejectNote = ` Auto-rejected ${res.rejectedCount} other application(s).`;
        setApplications((prev) => prev.map((a) =>
          a.student_id === app.student_id && a.application_id !== app.application_id
            ? { ...a, application_status: "Not Approved", remarks: `Auto-rejected: already approved for "${app.scholarship_programs?.scholarship_name || "another scholarship"}".` }
            : a
        ));
      }
    }

    setApplications((prev) => prev.map((a) =>
      a.application_id === app.application_id ? { ...a, application_status: newStatus, remarks: newRemarks } : a
    ));
    setMessage(`Updated status to ${newStatus} and notified the student.${rejectNote}`);
    toast.success(`Updated status to ${newStatus} and notified the student.${rejectNote}`);
    setSavingId(null);
  }

  async function handleNotify(app: ScholarshipApplication) {
    const msg = (notifyDraft[app.application_id] || "").trim();
    if (!msg) { setMessage("Type a message first."); return; }
    setMessage("");
    await notifyStudent(app, "Notification from SPC Scholarship Office", msg);
    setNotifyDraft((prev) => ({ ...prev, [app.application_id]: "" }));
    setMessage(`Notification sent to ${app.student_accounts?.last_name || "student"}.`);
    toast.success(`Notification sent to ${app.student_accounts?.last_name || "student"}.`);
  }

  function toggleSelect(appId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId); else next.add(appId);
      return next;
    });
  }

  function toggleSelectAll() {
    const visibleIds = filteredApps.map((a) => a.application_id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = visibleIds.every((id) => next.has(id));
      visibleIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  const selectedApps = applications.filter((a) => selectedIds.has(a.application_id));

  async function batchStatus(targetStatus: string, scopeIds: number[]) {
    if (!scopeIds.length || batchBusy) return;
    if (targetStatus === "Approved") {
      setMessage(CHED_ONLY_DECISION);
      return;
    }
    if (targetStatus === "Not Approved") {
      const fresh = applications.filter((a) => scopeIds.includes(a.application_id) && a.application_status !== "Not Approved");
      if (fresh.length) {
        setMessage(CHED_ONLY_DECISION);
        return;
      }
    }
    setBatchBusy(true);
    setMessage("");
    const sb = getSupabase();
    try {
      const { error } = await sb.from("scholarship_applications")
        .update({ application_status: targetStatus })
        .in("application_id", scopeIds);
      if (error) { setMessage(`Batch update failed: ${error.message}`); setBatchBusy(false); return; }

      const targets = applications.filter((a) => scopeIds.includes(a.application_id));
      let rejectNote = "";
      if (targetStatus === "Approved") {
        const fresh = targets.filter((a) => a.application_status !== "Approved");
        const res = await autoRejectSiblings(fresh.map((a) => ({ application_id: a.application_id, student_id: a.student_id })), applications);
        if (res.rejectedCount > 0) rejectNote = ` Auto-rejected ${res.rejectedCount} other application(s).`;
      }

      const notifRows = targets.map((a) => ({
        student_id: a.student_id,
        title: "Application Update",
        message: friendlyMessage(a, targetStatus),
        notification_type: "Status Update",
        status: "Unread",
      }));
      if (notifRows.length) {
        const { error: nErr } = await sb.from("notifications_announcements").insert(notifRows);
        if (nErr) { setMessage(`Status saved ${notifRows.length} apps but notify failed: ${nErr.message}`); }
      }

      setApplications((prev) => prev.map((a) =>
        scopeIds.includes(a.application_id) ? { ...a, application_status: targetStatus } : a
      ));
      setSelectedIds(new Set());
      setMessage(`Updated ${scopeIds.length} application(s) to ${targetStatus} and notified students.${rejectNote}`);
      toast.success(`Updated ${scopeIds.length} application(s) to ${targetStatus} and notified students.${rejectNote}`);
    } finally {
      setBatchBusy(false);
    }
  }

  async function batchNotify() {
    if (!selectedIds.size || batchBusy) return;
    const msg = batchMsg.trim() || "You have a new update from the scholarship office.";
    setBatchBusy(true);
    setMessage("");
    const sb = getSupabase();
    const rows = selectedApps.map((a) => ({
      student_id: a.student_id,
      title: "Notification from SPC Scholarship Office",
      message: msg,
      notification_type: "Announcement",
      status: "Unread",
    }));
    const { error } = await sb.from("notifications_announcements").insert(rows);
    setBatchBusy(false);
    if (error) { setMessage(`Notify failed: ${error.message}`); return; }
    setBatchMsg("");
    setMessage(`Notification sent to ${rows.length} student(s).`);
    toast.success(`Notification sent to ${rows.length} student(s).`);
  }

  function buildCsvRows(apps: ScholarshipApplication[]) {
    const chedByApp = Object.fromEntries(chedForms.map((c) => [c.application_id, c]));
    const acadByStudent = Object.fromEntries(acads.map((a) => [a.student_id, a]));
    const docByApp: Record<number, string> = {};
    const docFilesByApp: Record<number, string> = {};
    docs.forEach((d) => {
      const key = d.application_id ?? d.student_id;
      if (!key) return;
      docByApp[key] = docByApp[key] ? `${docByApp[key]}; ${d.document_type}` : d.document_type;
      docFilesByApp[key] = docFilesByApp[key] ? `${docFilesByApp[key]}; ${d.file_path}` : d.file_path;
    });

    return apps.map((a) => {
      const c = chedByApp[a.application_id];
      const acad = acadByStudent[a.student_id];
      return {
        "Application ID": a.application_id,
        "Student No.": fill(a.student_accounts?.student_number || c?.student_id || NO_VALUE),
        "Last Name": fill(c?.last_name || a.student_accounts?.last_name || NO_VALUE),
        "First Name": fill(c?.given_name || a.student_accounts?.given_name || NO_VALUE),
        "Middle Name": fill(c?.middle_name || NO_VALUE),
        "Ext. Name": fill(c?.ext_name || NO_VALUE),
        "Sex": fill(c?.sex || a.student_accounts?.sex || NO_VALUE),
        "Birthdate": fill(c?.birthdate || NO_VALUE),
        "Program": fill(c?.complete_program_name || a.student_accounts?.program_name || NO_VALUE),
        "Year Level": fill(c?.year_level || a.student_accounts?.year_level || NO_VALUE),
        "Scholarship Program": fill(a.scholarship_programs?.scholarship_name || NO_VALUE),
        "Application Status": a.application_status,
        "Application Date": formatDateTime(a.application_date),
        "Father's Full Name": fill(c?.father_name || NO_VALUE),
        "Mother's Full Name": fill(c?.mother_name || NO_VALUE),
        "Street / Barangay": fill(c?.street_barangay || NO_VALUE),
        "Zipcode": fill(c?.zipcode || NO_VALUE),
        "Contact Number": fill(c?.contact_number || NO_VALUE),
        "Email Address": fill(c?.email_address || NO_VALUE),
        "Disability": fill(c?.disability || NO_VALUE),
        "Indigenous People Group": fill(c?.indigenous_people_group || NO_VALUE),
        "Annual Family Income (PHP)": c?.annual_income_family != null ? Number(c.annual_income_family) : 0,
        "ITR File Present": c?.income_tax_return ? "Yes" : "No",
        "ITR File Path": fill(c?.income_tax_return || NO_VALUE),
        "Registration Status": fill(a.student_accounts?.registration_status || NO_VALUE),
        "Account Status": fill(a.student_accounts?.account_status || NO_VALUE),
        "Supporting Documents": fill(docByApp[a.application_id] || NO_VALUE),
        "Supporting Doc Files": fill(docFilesByApp[a.application_id] || NO_VALUE),
        "Applicant Type": fill(acad?.applicant_type || NO_VALUE),
        "SHS GWA": acad?.shs_gwa != null ? Number(acad.shs_gwa) : acad?.college_gpa != null ? Number(acad.college_gpa) : "N/A",
        "College GPA": acad?.college_gpa != null ? Number(acad.college_gpa) : acad?.shs_gwa != null ? Number(acad.shs_gwa) : "N/A",
        "Academic Proof File": fill(acad?.proof_image_path || NO_VALUE),
        "Remarks": fill(a.remarks || NO_VALUE),
      };
    });
  }

  function exportCsv() {
    const rows = buildCsvRows(filteredApps);
    if (!rows.length) return;
    downloadCsv("scholarship-applications.csv", rows);
    setMessage(`Exported ${rows.length} application(s) as CSV.`);
    toast.success(`Exported ${rows.length} application(s) as CSV.`);
  }

  function exportOneCsv(app: ScholarshipApplication) {
    const rows = buildCsvRows([app]);
    downloadCsv(`application-${app.application_id}-details.csv`, rows);
    setMessage("Exported this student's full application form as CSV.");
    toast.success("Exported this student's full application form as CSV.");
  }

  const viewingApp = applications.find((a) => a.application_id === viewingId) || null;

  /** Import a CSV/Excel of previous applications - parsed by the same reader
      the ML pipeline uses, saved on the server, and merged into the table. */
  async function importSheet(files: File[]) {
    if (!files.length) return;
    setImporting(true);
    const failures: string[] = [];
    let importedCount = 0;
    for (const file of files) {
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("scope", "applications");
        const res = await fetch("/api/import/parse", { method: "POST", body: form });
        const json = (await res.json()) as Partial<ImportedSheetData> & {
          error?: string;
          warning?: string;
          columns?: string[];
          rows?: Record<string, string>[];
        };
        if (!res.ok || json.error || !Array.isArray(json.columns) || !Array.isArray(json.rows)) {
          throw new Error(json.error || "Import failed.");
        }
        const imported: ImportedSheetData = {
          import_id: String(json.import_id || `${Date.now()}-${file.name}`),
          saved: Boolean(json.saved),
          file_name: String(json.file_name || file.name),
          file_size: Number(json.file_size ?? file.size),
          columns: json.columns.map(String),
          rows: json.rows,
          row_count: Number(json.row_count ?? json.rows.length),
          year_column: String(json.year_column || ""),
          group_column: String(json.group_column || ""),
          year_kind: String(json.year_kind || ""),
          years: Array.isArray(json.years) ? json.years.map(String) : [],
        };
        setImportedSheets((previous) => [...previous, imported]);
        importedCount += 1;
        if (!json.saved) failures.push(`${file.name}: ${json.warning || "file could not be saved for refresh."}`);
        toast.success(
          `${json.saved ? "Saved" : "Read"} ${imported.row_count.toLocaleString()} rows from ${imported.file_name}.`,
        );
        if (json.warning) toast(json.warning, { icon: "\u26a0\ufe0f" });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Import failed.";
        failures.push(`${file.name}: ${msg}`);
        toast.error(`${file.name}: ${msg}`);
      }
    }
    setProgramFilter("");
    setImportedVisible(INITIAL_IMPORTED_ROWS);
    setImportedCollapsed(true);
    setMessage(
      `${importedCount} of ${files.length} selected file(s) imported.` +
        (failures.length ? ` Issues: ${failures.join(" ")}` : " All imported files are saved and will survive a refresh."),
    );
    setImporting(false);
  }

  /** Remove one saved import - the file, its parsed copy and its table rows. */
  async function deleteImportedSheet(target: ImportedSheetData) {
    if (!target || deletingImport) return;
    if (!window.confirm(`Delete the imported file "${target.file_name}" and its ${target.row_count.toLocaleString()} row(s) from the table?`)) {
      return;
    }
    setDeletingImport(true);
    try {
      const res = await fetch(`/api/import/parse?scope=applications&import_id=${encodeURIComponent(target.import_id)}`, { method: "DELETE" });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || "Delete failed.");
      setImportedSheets((previous) => previous.filter((item) => item.import_id !== target.import_id));
      setProgramFilter("");
      setMessage(`Deleted the imported file "${target.file_name}".`);
      toast.success(`${target.file_name} removed.`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeletingImport(false);
    }
  }

  // Same cell padding/borders the Documents Viewer table uses, so both pages
  // read as one design system.
  const cellCls = "border border-[#241012]/10 px-3 py-1.5 align-middle";

  if (loading) return <Spinner label="Loading applications..." color="maroon" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Scholarship Applications</h1>
          <p className="mt-1 text-xs text-[#8B7376]">
            Every submitted application in one list — filter by status, search by name, or jump to a program chip.
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={!filteredApps.length}
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

      {applications.length === 0 && importedSheets.length === 0 ? (
        <EmptyState
          icon="&#128196;"
          title="No applications found"
          hint="Applications will appear here once students submit them."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
          {/* Card header - same shape as Documents Viewer: title + counts on the
              left, the search field on the right where its student <select> sits. */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">All Submitted Applications</p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                {filteredApps.length} of {applications.length} application{applications.length === 1 ? "" : "s"} shown &middot;{" "}
                <span className="font-semibold text-[#7B1113]">one row per application</span>
                {" \u00b7 "}
                <span className="text-[#6B5458]">Click View Details to open the full form, uploaded documents and status controls</span>
                {importedSheets.length > 0 && (
                  <>
                    {" \u00b7 "}
                    <span className="font-semibold text-[#7B1113]">
                      + {importedRowCount.toLocaleString()} imported row{importedRowCount === 1 ? "" : "s"} from {importedSheets.length} file{importedSheets.length === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </p>
            </div>
            <div className="relative w-full sm:max-w-xs">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B7376]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search by name, student #, program, year, sex, scholarship..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-[#241012]/10 bg-white py-2.5 pl-9 pr-3 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
              />
            </div>
          </div>

          {/* Status filter row - mirrors the Documents Viewer's type-filter row. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-3">
            {FILTER_TABS.map((tab) => {
              const count = tab.key === "" ? applications.length : tab.key === "Approved" ? approvedCount : tab.key === "Not Approved" ? notApprovedCount : pendingCount;
              return (
                <button
                  key={tab.key || "all"}
                  onClick={() => setStatusFilter(tab.key)}
                  className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
                    statusFilter === tab.key
                      ? `${tab.active} shadow-sm`
                      : `border border-[#241012]/10 bg-white ${tab.idle}`
                  }`}
                >
                  {tab.label} <span className={statusFilter === tab.key ? "text-white/70" : "text-[#8B7376]"}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Program chips scroll sideways instead of wrapping, so the row stays one
              line no matter how many programs Admin creates - and every chip stays
              clickable. The right-hand fade hints there is more to scroll to. */}
          <div className="relative border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-2.5">
            <div className="flex gap-2 overflow-x-auto scroll-smooth pb-1 [-ms-overflow-style:none] [scrollbar-color:#7B111340_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:rounded-full [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#7B1113]/40 [&::-webkit-scrollbar-track]:bg-transparent">
              <button
                onClick={() => setProgramFilter("")}
                className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-bold transition ${programFilter === "" ? "bg-[#7B1113] text-white shadow" : "border border-[#241012]/[0.08] bg-white text-[#241012] hover:border-[#7B1113]/40"}`}
                title="Show every scholarship program"
              >
                📚 All programs ({totalByStatus})
              </button>
              {programNames.map((name) => (
                <button
                  key={name}
                  onClick={() => setProgramFilter(programFilter === name ? "" : name)}
                  className={`max-w-[18rem] shrink-0 truncate whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-bold transition ${programFilter === name ? "bg-[#7B1113] text-white shadow" : "border border-[#241012]/[0.08] bg-white text-[#241012] hover:border-[#7B1113]/40"}`}
                  title={`Show only applications filed under "${name}" (${programCounts[name] ?? 0})`}
                >
                  📚 {name} ({programCounts[name] ?? 0})
                </button>
              ))}

              {/* Import control - sits right in the chip row so a file of
                  previous applications is one click away. The imported rows
                  land in the same table below and its programs join the chips. */}
              <input
                ref={importInputRef}
                type="file"
                accept=".csv,.xlsx,.xlsm,.xltx"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) void importSheet(files);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
                className="shrink-0 whitespace-nowrap rounded-full border border-dashed border-[#7B1113]/50 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
                title="Import a CSV / Excel file of previous scholarship applications - its rows are listed in the same table below"
              >
                {importing ? "\u23f3 Importing files..." : "\u{1F4DA} Import file here"}
              </button>
              {importedSheets.map((item) => (
                <span
                  key={item.import_id}
                  className="inline-flex max-w-[22rem] shrink-0 items-center gap-2 truncate rounded-full bg-[#7B1113]/10 py-1.5 pl-3 pr-1 text-[11px] font-bold text-[#7B1113]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setStatusFilter("");
                      setSearch("");
                      setProgramFilter("");
                      setImportedVisible(INITIAL_IMPORTED_ROWS);
                      scrollToImportedRowsRef.current = true;
                      setImportedCollapsed(false);
                    }}
                    className="min-w-0 truncate rounded-full px-1.5 py-0.5 text-left transition hover:bg-[#7B1113]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7B1113]"
                    title={`${item.file_name} - click to view ${item.row_count.toLocaleString()} imported row(s).${item.saved ? " Saved on the server, so it survives a refresh." : " Not saved on the server."}`}
                    aria-label={`View ${item.row_count.toLocaleString()} rows from ${item.file_name}`}
                  >
                    {"\u{1F4C4}"} {item.file_name} ({item.row_count.toLocaleString()})
                  </button>
                  <button
                    onClick={() => void deleteImportedSheet(item)}
                    disabled={deletingImport}
                    className="rounded-full px-1 leading-none transition hover:bg-[#7B1113]/15 disabled:opacity-50"
                    aria-label={`Delete ${item.file_name}`}
                    title={`Delete ${item.file_name} and its rows from the table`}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#FAF7F5] via-[#FAF7F5]/70 to-transparent"
            />
          </div>

          {/* Explicit confirmation of what is on screen: which program was picked
              and how many of its students are listed below. */}
          {programFilter && (
            <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] bg-[#7B1113]/[0.04] px-5 py-2.5">
              <span className="text-xs font-bold text-[#7B1113]">
                &#128218; Showing {filteredApps.length + importedRowCount} student
                {filteredApps.length + importedRowCount === 1 ? "" : "s"} who
                applied to <span className="underline decoration-[#7B1113]/40 underline-offset-2">{programFilter}</span>
              </span>
              <button
                onClick={() => setProgramFilter("")}
                className="ml-auto rounded-lg border border-[#7B1113]/30 px-2.5 py-1 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/10"
                title="Clear the program filter and show every program again"
              >
                &#10005; Show all programs
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] px-5 py-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[#241012]">
              <input
                type="checkbox"
                checked={filteredApps.length > 0 && filteredApps.every((a) => selectedIds.has(a.application_id))}
                onChange={toggleSelectAll}
                className="h-4 w-4 accent-[#7B1113]"
              />
              Select all ({filteredApps.length})
            </label>
            {selectedIds.size > 0 && (
              <span className="rounded-full bg-[#7B1113]/10 px-2.5 py-1 text-[11px] font-bold text-[#7B1113]">{selectedIds.size} selected</span>
            )}
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#241012]/[0.12] bg-[#F3EEEB] px-3 py-1.5 text-[11px] font-bold text-[#6B5458]"
              title="Locked for Admin — only CHED can approve or not-approve applications. Approve/Not approve buttons are on the CHED portal."
            >
              &#128274; Final approval: CHED only
            </span>
            <button
              onClick={() => batchStatus("Pending", [...selectedIds])}
              disabled={!selectedIds.size || batchBusy}
              className="rounded-lg border border-amber-300 px-3 py-1.5 text-[11px] font-bold text-amber-700 transition hover:bg-amber-50 disabled:opacity-40"
            >
              Mark Pending
            </button>
            <input
              value={batchMsg}
              onChange={(e) => setBatchMsg(e.target.value)}
              placeholder="Notification message for selected students..."
              className="min-w-48 flex-1 rounded-lg border border-[#241012]/[0.06] px-3 py-1.5 text-xs outline-none focus:border-[#7B1113]"
            />
            <button
              onClick={batchNotify}
              disabled={!selectedIds.size || batchBusy}
              className="rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-40"
            >
              Notify selected
            </button>
          </div>

          {/* One row per application - same table shape as Documents Viewer:
              sticky header, alternating rows, scrolling body, stats footer. */}
          {filteredApps.length === 0 && importedRowCount === 0 ? (
            <p className="px-5 py-10 text-center text-xs text-[#8B7376]">
              {programFilter
                ? `No applications for "${programFilter}" match this filter.`
                : "No applications match this search or status filter."}
            </p>
          ) : (
            <div className="max-h-[70vh] overflow-auto [-ms-overflow-style:none] [scrollbar-color:#7B111345_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:rounded-full [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#7B1113]/45 [&::-webkit-scrollbar-track]:bg-[#241012]/[0.04]">
              <table className="w-full min-w-[1040px] border-collapse text-left text-[11px] text-[#241012]">
                <thead className="sticky top-0 z-10 bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458] shadow-[0_1px_0_0_rgba(36,16,18,0.07)]">
                  <tr>
                    <th className={`${cellCls} w-10 text-center`}>
                      <input
                        type="checkbox"
                        checked={filteredApps.length > 0 && filteredApps.every((a) => selectedIds.has(a.application_id))}
                        onChange={toggleSelectAll}
                        className="h-4 w-4 accent-[#7B1113]"
                        title="Select every application shown"
                      />
                    </th>
                    <th className={`${cellCls} w-12 text-center font-bold`}>#</th>
                    <th className={`${cellCls} font-bold`}>Student ID</th>
                    <th className={`${cellCls} font-bold`}>Full Name</th>
                    <th className={`${cellCls} font-bold`}>Scholarship Program</th>
                    <th className={`${cellCls} font-bold`}>Submitted</th>
                    <th className={`${cellCls} font-bold`}>Status</th>
                    <th className={`${cellCls} font-bold`}>Requirements</th>
                    <th className={`${cellCls} w-32 font-bold`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredApps.map((app, i) => {
                    const currentStatus = app.application_status;
                    const reqStats = requirementStats(app);
                    const allReqs = reqStats.required.length > 0 && reqStats.missing.length === 0;
                    const isSel = selectedIds.has(app.application_id);
                    const studentName = `${app.student_accounts?.last_name || ""}, ${app.student_accounts?.given_name || ""}`;
                    return (
                      <tr
                        key={app.application_id}
                        className={isSel ? "bg-[#7B1113]/[0.07]" : i % 2 ? "bg-[#FAF7F5]/60" : "bg-white"}
                      >
                        <td className={`${cellCls} text-center`}>
                          <input
                            type="checkbox"
                            checked={isSel}
                            onChange={() => toggleSelect(app.application_id)}
                            className="h-4 w-4 accent-[#7B1113]"
                            title="Select this application"
                          />
                        </td>
                        <td className={`${cellCls} text-center font-bold text-[#6B5458]`}>{i + 1}</td>
                        <td className={cellCls}>
                          <button
                            onClick={() => openDetails(app.application_id)}
                            title={`Open the full application of ${studentName} (${app.student_accounts?.student_number || "no ID"})`}
                            className="font-semibold text-[#7B1113] underline decoration-dotted underline-offset-2 transition hover:bg-[#7B1113]/5"
                          >
                            {app.student_accounts?.student_number || "\u2014"}
                          </button>
                        </td>
                        <td className={`${cellCls} whitespace-nowrap font-bold text-[#241012]`}>
                          {studentName}
                          <div className="text-[10px] font-normal text-[#8B7376]">
                            {app.student_accounts?.program_name || "\u2014"}
                            {app.student_accounts?.year_level ? ` \u00b7 ${app.student_accounts.year_level}` : ""}
                          </div>
                        </td>
                        <td className={cellCls}>
                          <div
                            className="max-w-[190px] truncate font-semibold text-[#7B1113]"
                            title={app.scholarship_programs?.scholarship_name || "No scholarship program"}
                          >
                            {app.scholarship_programs?.scholarship_name || "\u2014"}
                          </div>
                        </td>
                        <td className={`${cellCls} whitespace-nowrap text-[#6B5458]`}>{formatDateTime(app.application_date)}</td>
                        <td className={cellCls}>
                          <Badge className={STATUS_STYLES[currentStatus] || ""}>{currentStatus}</Badge>
                        </td>
                        <td className={cellCls}>
                          <Badge
                            className={
                              allReqs
                                ? "border-green-200 bg-green-50 text-green-700"
                                : "border-amber-200 bg-amber-50 text-amber-700"
                            }
                            title={
                              reqStats.missing.length === 0
                                ? "The student uploaded every requirement of this program"
                                : `Not compliant - missing: ${reqStats.missing.join(", ")}`
                            }
                          >
                            {allReqs ? "\u2713 " : "\u26A0 "}
                            {reqStats.done}/{reqStats.required.length}
                          </Badge>
                        </td>
                        <td className={cellCls}>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => openDetails(app.application_id)}
                              title={`Open ${studentName}'s form, documents, notify box and status controls`}
                              className="rounded-md bg-[#7B1113] px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-[#540111]"
                            >
                              View Details
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {/* Keep rows from every imported file together as one historical-data group. */}
                  {importedSheets.length > 0 && importedRowCount > 0 && (
                    <tr
                      id="imported-applications-group"
                      className="cursor-pointer bg-[#7B1113]/[0.06] transition hover:bg-[#7B1113]/[0.1]"
                      onClick={() => {
                        if (importedCollapsed) {
                          setImportedVisible(importedRowCount);
                          setImportedCollapsed(false);
                        } else {
                          setImportedCollapsed(true);
                        }
                      }}
                      title={importedCollapsed ? `Click to show all ${importedRowCount.toLocaleString()} rows from ${importedSheets.length} imported files` : `Click to hide ${importedRowCount.toLocaleString()} imported rows`}
                    >
                      <td className={`${cellCls} w-10 text-center text-[#7B1113]`} aria-hidden="true">
                        {importedCollapsed ? "\u25b8" : "\u25be"}
                      </td>
                      <td className={cellCls} aria-hidden="true" />
                      <td className={`${cellCls} text-[10px] font-bold uppercase tracking-wide text-[#8B7376]`}>Imported files</td>
                      <td className={`${cellCls} whitespace-nowrap text-xs font-bold text-[#7B1113]`} colSpan={2}>
                        {importedSheets.length} file{importedSheets.length === 1 ? "" : "s"}
                      </td>
                      <td className={`${cellCls} text-[11px] font-bold text-[#6B5458]`}>
                        {importedRowCount.toLocaleString()} student{importedRowCount === 1 ? "" : "s"}
                      </td>
                      <td className={`${cellCls} text-[10px] text-[#8B7376]`} colSpan={3}>
                        {importedCollapsed ? "Click to show all imported rows" : "Imported rows shown \u00b7 click to hide"}
                      </td>
                    </tr>
                  )}
                  {!importedCollapsed &&
                    importedRows.slice(0, importedVisible).map((row, i) => (
                    <tr
                      key={`imported-${i}`}
                      className={(filteredApps.length + i) % 2 ? "bg-[#FAF7F5]/60" : "bg-white"}
                    >
                      <td className={`${cellCls} text-center text-[#8B7376]`}>&#8212;</td>
                      <td className={`${cellCls} text-center font-bold text-[#6B5458]`}>{filteredApps.length + i + 1}</td>
                      <td className={`${cellCls} font-semibold text-[#241012]`}>{row.studentId || "\u2014"}</td>
                      <td className={`${cellCls} whitespace-nowrap font-bold text-[#241012]`}>
                        {row.name || "\u2014"}
                        <div className="text-[10px] font-normal text-[#8B7376]">
                          {row.year || row.program} &middot; {row.sourceFile}
                        </div>
                      </td>
                      <td className={cellCls}>
                        <div className="max-w-[190px] truncate font-semibold text-[#7B1113]" title={row.program}>
                          {row.program}
                        </div>
                      </td>
                      <td className={`${cellCls} whitespace-nowrap text-[#8B7376]`} title="Imported file rows carry no submission date">
                        &#8212;
                      </td>
                      <td className={cellCls}>
                        <Badge className="border-[#241012]/[0.08] bg-[#F3EEEB] text-[#6B5458]" title="Imported from the uploaded file - not a submitted application">
                          Imported
                        </Badge>
                      </td>
                      <td className={`${cellCls} text-[#8B7376]`} title="Imported file rows have no uploaded requirements on record">
                        &#8212;
                      </td>
                      <td className={`${cellCls} text-[10px] text-[#8B7376]`}>From imported file</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Imported rows page in - this button pulls the next batch so a
              2,600-row file never freezes the table. */}
          {importedRowCount > importedVisible && (
            <div className="flex items-center justify-center gap-2 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5">
              <button
                onClick={() => setImportedVisible((v) => v + IMPORTED_PAGE)}
                className="rounded-lg border border-[#7B1113]/30 bg-white px-3 py-1.5 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
              >
                Show {Math.min(IMPORTED_PAGE, importedRowCount - importedVisible)} more imported row(s)
              </button>
              <button
                onClick={() => setImportedVisible(importedRowCount)}
                className="rounded-lg border border-[#241012]/10 bg-white px-3 py-1.5 text-[11px] font-bold text-[#6B5458] transition hover:bg-[#241012]/5"
              >
                Show all {importedRowCount.toLocaleString()}
              </button>
              <span className="text-[10px] text-[#8B7376]">
                Showing {importedVisible.toLocaleString()} of {importedRowCount.toLocaleString()} imported rows
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5 text-[10px] text-[#6B5458]">
            <span>Pending <b className="text-amber-700">{filteredApps.filter((a) => a.application_status === "Pending").length}</b></span>
            <span>Approved <b className="text-green-700">{filteredApps.filter((a) => a.application_status === "Approved").length}</b></span>
            <span>Not approved <b className="text-red-600">{filteredApps.filter((a) => a.application_status === "Not Approved").length}</b></span>
            <span>Programs <b className="text-[#7B1113]">{programNames.length}</b></span>
            <span className="ml-auto">
              Showing <b className="text-[#7B1113]">{filteredApps.length}</b> of {applications.length} applications
              {importedSheets.length > 0 ? ` + ${importedRowCount.toLocaleString()} imported from ${importedSheets.length} file${importedSheets.length === 1 ? "" : "s"}` : ""}
              {selectedIds.size ? ` \u00b7 ${selectedIds.size} selected` : ""}
            </span>
          </div>
        </div>
      )}

      {viewingApp && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={() => setViewingId(null)}>
          <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-[#241012]/[0.06] px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold text-[#241012]">
                  Application Details — {viewingApp.student_accounts?.last_name}, {viewingApp.student_accounts?.given_name}
                </h3>
                <p className="mt-0.5 text-[11px] text-[#8B7376]">
                  Student ID {viewingApp.student_accounts?.student_number || "\u2014"} &middot;{" "}
                  {viewingApp.scholarship_programs?.scholarship_name || "No program"} &middot; Submitted {formatDateTime(viewingApp.application_date)} &middot;{" "}
                  {appDocs(viewingApp).length} support &middot; {appAcads(viewingApp).length} academic &middot; {appChed(viewingApp).length} form
                </p>
              </div>
              <button
                onClick={() => setViewingId(null)}
                className="rounded-full p-1 text-lg leading-none text-[#8B7376] transition hover:bg-[#7B1113]/5 hover:text-[#7B1113]"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.06] bg-[#FAF7F5] px-5 py-2.5">
              <Badge className={STATUS_STYLES[viewingApp.application_status] || ""}>{viewingApp.application_status}</Badge>
              <Badge className="border-[#241012]/[0.06] bg-white text-[#6B5458]">{viewingApp.scholarship_programs?.scholarship_name || "\u2014"}</Badge>
              <span className="ml-auto text-[11px] text-[#8B7376]">
                {requirementStats(viewingApp).required.length === 0
                  ? "No requirements set for this program"
                  : `${requirementStats(viewingApp).done} of ${requirementStats(viewingApp).required.length} requirements uploaded`}
              </span>
            </div>

            <div className="max-h-[55vh] overflow-auto">
              <div className="border-b border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-5 py-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Applicant Profile</h4>
                <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Full Name</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.last_name}, {viewingApp.student_accounts?.given_name}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Student No.</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.student_number || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Program</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.program_name || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Year Level</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.year_level || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Sex</p><p className="mt-0.5 font-semibold text-[#241012]">{viewingApp.student_accounts?.sex || "\u2014"}</p></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Registration</p><div className="mt-0.5"><Badge className={viewingApp.student_accounts?.registration_status === "Verified" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{viewingApp.student_accounts?.registration_status || "\u2014"}</Badge></div></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Account Status</p><div className="mt-0.5"><Badge className={viewingApp.student_accounts?.account_status === "Active" ? "border-green-200 bg-green-50 text-green-700" : "border-[#241012]/[0.06] bg-[#F3EEEB] text-[#6B5458]"}>{viewingApp.student_accounts?.account_status || "\u2014"}</Badge></div></div>
                  <div className="rounded-lg bg-white p-2.5 shadow-sm"><p className="text-[10px] uppercase tracking-wide text-[#8B7376]">Submitted</p><p className="mt-0.5 font-semibold text-[#241012]">{formatDateTime(viewingApp.application_date)}</p></div>
                </div>
              </div>

              {appChed(viewingApp).length > 0 ? (
                <div className="border-b border-[#241012]/[0.06] bg-white px-5 py-4">
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
                          ) : urlsLoading ? (
                            <button type="button" disabled className="mt-1 inline-flex cursor-default items-center gap-1.5 rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-semibold text-[#8B7376]" title="Signing a secure link...">
                              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#7B1113]/30 border-t-[#7B1113]" />
                              Opening ITR...
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => loadFileUrls(viewingApp)}
                              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] font-bold text-amber-700 transition hover:bg-amber-100"
                              title={`The ITR (${c.income_tax_return.split("/").pop()}) is uploaded but the link could not be created. Click to try again.`}
                            >
                              Could not open ITR · Retry
                            </button>
                          )
                        ) : <p className="mt-0.5 font-semibold text-[#241012]">{"\u2014"}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="border-b border-[#241012]/[0.06] bg-white px-5 py-4">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Application Form</h4>
                  <p className="mt-2 text-[11px] text-[#8B7376]">The student has not completed the CHED application form yet.</p>
                </div>
              )}

              <div className="border-b border-[#241012]/[0.06] bg-[#FAF7F5]/60 px-5 py-4">
                <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Academic Records ({appAcads(viewingApp).length})</h4>
                {appAcads(viewingApp).length === 0 ? (
                  <p className="text-[11px] text-[#8B7376]">No academic records uploaded.</p>
                ) : (
                  <ul className="space-y-2">
                    {appAcads(viewingApp).map((a) => (
                      <li key={a.record_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#241012]/[0.06] bg-white px-3 py-2 shadow-sm">
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

              <div className="bg-white px-5 py-4">
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

            <div className="flex flex-col gap-3 border-t border-[#241012]/[0.06] px-5 py-3">
              <div className="flex flex-col gap-2 rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5] px-3 py-2.5 sm:flex-row sm:items-center">
                <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Notify student</span>
                <input
                  value={notifyDraft[viewingApp.application_id] || ""}
                  onChange={(e) => setNotifyDraft((prev) => ({ ...prev, [viewingApp.application_id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleNotify(viewingApp); } }}
                  placeholder="Send this student a message..."
                  className="min-w-48 flex-1 rounded-lg border border-[#241012]/10 bg-white px-3 py-2 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                />
                <button
                  onClick={() => handleNotify(viewingApp)}
                  className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                >
                  Notify student
                </button>
              </div>

              <div>
                <h4 className="text-[11px] font-bold uppercase tracking-wide text-[#8B7376]">Update Status</h4>
                <p className="mt-0.5 text-[10px] text-[#8B7376]">
                  Approve &amp; Not Approve are decided by <b className="text-[#7B1113]">CHED only</b>.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {STATUS_ACTIONS.map((action) => {
                    const draft = statusDraft[viewingApp.application_id] || { status: viewingApp.application_status, remarks: viewingApp.remarks || "" };
                    const isActive = draft.status === action.status;
                    return (
                      <button
                        key={action.status}
                        onClick={() => setStatusDraft({ ...statusDraft, [viewingApp.application_id]: { ...draft, status: action.status } })}
                        className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold transition ${isActive ? action.active : action.idle}`}
                      >
                        {action.label}
                      </button>
                    );
                  })}
                  <input
                    value={(statusDraft[viewingApp.application_id] && statusDraft[viewingApp.application_id].remarks) ?? viewingApp.remarks ?? ""}
                    onChange={(e) => setStatusDraft((prev) => ({ ...prev, [viewingApp.application_id]: { status: prev[viewingApp.application_id]?.status ?? viewingApp.application_status, remarks: e.target.value } }))}
                    placeholder="Remarks (sent to the student)..."
                    className="min-w-56 flex-1 rounded-lg border border-[#241012]/10 px-3 py-1.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {viewingApp.application_status !== "Pending" && (
                  <button
                    onClick={() => quickStatus(viewingApp, "Pending")}
                    disabled={savingId !== null}
                    title="One click: set this application back to Pending and notify the student (Approve / Not approve stay with CHED)"
                    className="rounded-xl border border-amber-300 px-4 py-2 text-xs font-bold text-amber-700 transition hover:bg-amber-50 disabled:opacity-40"
                  >
                    Mark Pending now
                  </button>
                )}
                <button
                  onClick={() => exportOneCsv(viewingApp)}
                  className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                >
                  &#11015; Export form CSV
                </button>
                <button
                  onClick={() => handleStatusSave(viewingApp)}
                  disabled={savingId !== null}
                  className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 disabled:opacity-40"
                >
                  {savingId === viewingApp.application_id ? "Saving..." : "Save Status + Notify Student"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
