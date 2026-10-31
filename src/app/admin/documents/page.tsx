"use client";
import toast from "react-hot-toast";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime, downloadCsv } from "@/lib/utils";
import JSZip from "jszip";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface StudentAccount {
  student_id: number;
  student_number?: string;
  given_name?: string;
  last_name?: string;
  middle_name?: string;
  year_level?: string;
}

interface SupportDocument {
  document_id: number;
  application_id: number;
  document_type: string;
  file_path: string;
  upload_date?: string;
  scholarship_applications?: { student_accounts?: StudentAccount };
}

interface AcademicRecord {
  record_id: number;
  student_id: number;
  applicant_type: string;
  shs_gwa?: string;
  college_gpa?: string;
  proof_image_path?: string;
  created_at?: string;
  student_accounts?: StudentAccount;
}

interface ChedForm {
  ched_form_id: number;
  application_id: number;
  student_id?: string;
  last_name?: string;
  given_name?: string;
  middle_name?: string;
  year_level?: string;
  annual_income_family?: number;
  income_tax_return?: string;
  contact_number?: string;
  email_address?: string;
  father_name?: string;
  mother_name?: string;
  created_at?: string;
  scholarship_applications?: {
    scholarship_programs?: { scholarship_name: string };
    student_accounts?: StudentAccount;
  };
}

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|avif|svg)$/i;
function isImagePath(path?: string) {
  return !!path && IMG_RE.test(path.split(/[?#]/)[0]);
}

function fullName(s?: StudentAccount | { given_name?: string; last_name?: string; middle_name?: string }) {
  if (!s) return "Student";
  const first = [s.given_name, "middle_name" in s ? s.middle_name : undefined].filter(Boolean).join(" ");
  const n = `${s.last_name || ""}, ${first}`.replace(/^, |, $/g, "").trim();
  return n || "Student";
}

function safeFile(name: string) {
  return name.replace(/[^\w.]+/g, "_");
}

type Kind = "support" | "academic" | "itr";

const KIND_META: Record<Kind, { label: string; cls: string }> = {
  itr: { label: "ITR", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  academic: { label: "Academic Record", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  support: { label: "Support Document", cls: "border-[#7B1113]/25 bg-[#7B1113]/5 text-[#7B1113]" },
};
const KIND_ORDER: Record<Kind, number> = { itr: 0, academic: 1, support: 2 };

type DocRow = {
  key: string;
  kind: Kind;
  studentNumber: string;
  name: string;
  year: string;
  details: string;
  uploaded?: string;
  url?: string;
  bucket: string;
  path: string;
  deleteId: number;
  fileLabel: string;
};

type PreviewItem = { url: string; name: string; bucket: string; path: string };

export default function AdminDocumentsPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [students, setStudents] = useState<StudentAccount[]>([]);
  const [docs, setDocs] = useState<SupportDocument[]>([]);
  const [acads, setAcads] = useState<AcademicRecord[]>([]);
  const [chedForms, setChedForms] = useState<ChedForm[]>([]);
  const [selectedStudent, setSelectedStudent] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | Kind>("all");
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlProgress, setDlProgress] = useState({ done: 0, total: 0 });
  const [delBusyKey, setDelBusyKey] = useState<string | null>(null);
  const [studentDocsOpen, setStudentDocsOpen] = useState<{ studentNumber: string; name: string; mode: "view" | "download" | "delete" } | null>(null);
  const [modalSelected, setModalSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [studentsQ, docsQ, acadsQ, chedQ] = await Promise.all([
        sb.from("student_accounts")
          .select("student_id, student_number, given_name, last_name, middle_name, year_level")
          .order("last_name", { ascending: true }),
        sb.from("support_documents")
          .select("*, scholarship_applications(student_accounts(student_id, student_number, given_name, last_name, middle_name, year_level))")
          .order("upload_date", { ascending: false }),
        sb.from("support_academic_records")
          .select("*, student_accounts(student_id, student_number, given_name, last_name, middle_name, year_level)")
          .order("created_at", { ascending: false }),
        sb.from("ched_form_input")
          .select("*, scholarship_applications(scholarship_id, scholarship_programs(scholarship_name), student_accounts(student_id, student_number, given_name, last_name, middle_name, year_level))")
          .order("ched_form_id", { ascending: false }),
      ]);

      const loadedDocs = docsQ.data || [];
      const loadedAcads = acadsQ.data || [];
      const loadedChed = chedQ.data || [];

      if (!studentsQ.error) setStudents(studentsQ.data || []);
      if (!docsQ.error) setDocs(loadedDocs);
      if (!acadsQ.error) setAcads(loadedAcads);
      if (!chedQ.error) setChedForms(loadedChed);

      const map: Record<string, string> = {};
      const signBatch = async (bucket: string, paths: (string | null | undefined)[]) => {
        const uniq = [...new Set(paths.filter((p): p is string => !!p))];
        if (!uniq.length) return;
        // 1) Normal direct signing (works for buckets with proper read policies)
        const { data, error } = await sb.storage.from(bucket).createSignedUrls(uniq, 3600);
        if (error) return;
        for (const item of data) {
          if (item?.signedUrl && item?.path) map[item.path] = item.signedUrl;
        }
        // 2) Server-side fallback for buckets whose storage RLS blocks the user's
        //    key (e.g. itr-documents) — signed by the API with the service key.
        const missing = uniq.filter((p) => !map[p]);
        if (missing.length) {
          try {
            const res = await fetch("/api/storage/signed-url", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bucket, paths: missing }),
            });
            if (res.ok) {
              const data2 = (await res.json()) as { urls?: Record<string, string> };
              for (const [p, u] of Object.entries(data2.urls || {})) map[p] = u;
            }
          } catch { /* leave those files "not ready" */ }
        }
      };
      await Promise.all([
        signBatch("support-documents", loadedDocs.map((d) => d.file_path)),
        signBatch("academic-records", loadedAcads.map((a) => a.proof_image_path)),
        signBatch("itr-documents", loadedChed.map((c) => c.income_tax_return)),
      ]);
      if (!ignore) {
        setFileUrls(map);
        setLoading(false);
      }
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  function buildFileName(kind: string, s?: StudentAccount, path?: string) {
    const who = s?.student_number || `${s?.last_name || "student"}${s?.given_name || ""}`;
    const ext = (path?.split("/").pop()?.split(".").pop() || "file").toLowerCase();
    return safeFile(`${kind}_${who}.${ext}`);
  }

  async function downloadOne(url: string, name: string) {
    try {
      const blob = await fetch(url).then((r) => r.blob());
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(obj);
    } catch {
      setFlash({ type: "err", text: `Could not download ${name}. The signed link may have expired — refresh the page and try again.` });
    }
  }

  async function downloadAll(files: { url: string; name: string }[], zipName?: string) {
    if (dlBusy || !files.length) return;
    setDlBusy(true);
    setDlProgress({ done: 0, total: files.length });
    try {
      const zip = new JSZip();
      const usedNames = new Map<string, number>();
      for (const f of files) {
        let name = f.name.split("/").pop() || `file-${Date.now()}`;
        const count = usedNames.get(name) ?? 0;
        usedNames.set(name, count + 1);
        if (count > 0) {
          const dot = name.lastIndexOf(".");
          name = dot > -1 ? `${name.slice(0, dot)}-${count}${name.slice(dot)}` : `${name}-${count}`;
        }
        try {
          const blob = await fetch(f.url).then((r) => r.blob());
          zip.file(name, blob);
        } catch {
          setFlash({ type: "err", text: `Could not fetch ${name}. The signed link may have expired — refresh the page and try again.` });
        }
        setDlProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const obj = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = zipName || `all-documents-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(obj);
      setFlash({ type: "ok", text: `Downloaded ${files.length} file(s) as one ZIP.` });
      toast.success(`Downloaded ${files.length} file(s) as one ZIP.`);
    } finally {
      setDlBusy(false);
    }
  }

  async function deleteOneCore(kind: Kind, key: number, bucket: string, path: string) {
    const sb = getSupabase();

    const table = kind === "support" ? "support_documents" : kind === "academic" ? "support_academic_records" : "ched_form_input";
    const idCol = kind === "support" ? "document_id" : kind === "academic" ? "record_id" : "ched_form_id";

    const { error } = await sb.from(table).delete().eq(idCol, key);
    if (!error && path) {
      // Storage cleanup uses the server API (service key) so it works for every bucket.
      try {
        const res = await fetch("/api/storage/signed-url", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, path }),
        });
        if (!res.ok) setFlash({ type: "err", text: "Record deleted, but the file could not be removed from storage." });
      } catch {
        setFlash({ type: "err", text: "Record deleted, but the file could not be removed from storage." });
      }
    }

    if (kind === "support") setDocs((prev) => prev.filter((d) => d.document_id !== key));
    if (kind === "academic") setAcads((prev) => prev.filter((a) => a.record_id !== key));
    if (kind === "itr") setChedForms((prev) => prev.filter((c) => c.ched_form_id !== key));
    setFileUrls((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    return error;
  }

  async function deleteOne(kind: Kind, key: number, bucket: string, path: string, busyKey: string) {
    if (!confirm("Delete this document permanently? This cannot be undone.")) return;
    setDelBusyKey(busyKey);
    setFlash(null);
    const error = await deleteOneCore(kind, key, bucket, path);
    setDelBusyKey(null);
    if (error) { setFlash({ type: "err", text: error.message }); return; }
    setFlash({ type: "ok", text: "Document deleted permanently." });
    toast.success("Document deleted permanently.");
  }

  async function deleteMany(rows: DocRow[]) {
    if (!rows.length) return;
    if (!confirm(`Delete ${rows.length} document(s) permanently? This cannot be undone.`)) return;
    setFlash(null);
    let failed = 0;
    for (const r of rows) {
      setDelBusyKey(r.key);
      const error = await deleteOneCore(r.kind, r.deleteId, r.bucket, r.path);
      if (error) failed++;
    }
    setDelBusyKey(null);
    setModalSelected(new Set());
    if (failed === 0) {
      setFlash({ type: "ok", text: `Deleted ${rows.length} document(s) permanently.` });
      toast.success(`Deleted ${rows.length} document(s) permanently.`);
    } else {
      setFlash({ type: "err", text: `${failed} of ${rows.length} deletion(s) failed.` });
      toast.error(`${failed} of ${rows.length} deletion(s) failed.`);
    }
  }

  const selectedNumber = selectedStudent
    ? students.find((s) => s.student_id === Number(selectedStudent))?.student_number
    : undefined;

  const studentRows: DocRow[] = useMemo(() => {
    const rows: DocRow[] = [
      ...docs.map((d): DocRow => {
        const s = d.scholarship_applications?.student_accounts;
        const file = d.file_path.split("/").pop() || d.document_type;
        return {
          key: `support-${d.document_id}`,
          kind: "support",
          studentNumber: s?.student_number || "\u2014",
          name: fullName(s),
          year: s?.year_level || "\u2014",
          details: `${d.document_type} \u00b7 ${file}`,
          uploaded: d.upload_date,
          url: fileUrls[d.file_path],
          bucket: "support-documents",
          path: d.file_path,
          deleteId: d.document_id,
          fileLabel: buildFileName("support", s, d.file_path),
        };
      }),
      ...acads.map((a): DocRow => {
        const s = a.student_accounts;
        const grade = a.shs_gwa != null ? `SHS GWA ${a.shs_gwa}` : a.college_gpa != null ? `College GPA ${a.college_gpa}` : "No grade recorded";
        return {
          key: `academic-${a.record_id}`,
          kind: "academic",
          studentNumber: s?.student_number || "\u2014",
          name: fullName(s),
          year: s?.year_level || "\u2014",
          details: `${a.applicant_type} \u00b7 ${grade}`,
          uploaded: a.created_at,
          url: a.proof_image_path ? fileUrls[a.proof_image_path] : undefined,
          bucket: "academic-records",
          path: a.proof_image_path || "",
          deleteId: a.record_id,
          fileLabel: buildFileName("academic", s, a.proof_image_path),
        };
      }),
      ...chedForms.map((c): DocRow => {
        const s = c.scholarship_applications?.student_accounts;
        const name = fullName(s) !== "Student"
          ? fullName(s)
          : `${c.last_name || ""}, ${c.given_name || ""}`.replace(/^, |, $/g, "").trim() || "Student";
        const sch = c.scholarship_applications?.scholarship_programs?.scholarship_name;
        const income = c.annual_income_family ? `\u20b1${Number(c.annual_income_family).toLocaleString()}/yr` : null;
        const file = c.income_tax_return ? c.income_tax_return.split("/").pop() || "" : "";
        const details = [sch || "No scholarship linked", income, `App #${c.application_id}`, file].filter(Boolean).join(" \u00b7 ");
        return {
          key: `itr-${c.ched_form_id}`,
          kind: "itr",
          studentNumber: c.student_id || s?.student_number || "\u2014",
          name,
          year: c.year_level || s?.year_level || "\u2014",
          details,
          uploaded: c.created_at,
          url: c.income_tax_return ? fileUrls[c.income_tax_return] : undefined,
          bucket: "itr-documents",
          path: c.income_tax_return || "",
          deleteId: c.ched_form_id,
          fileLabel: buildFileName("itr", s, c.income_tax_return),
        };
      }),
    ];

    const filtered = selectedNumber ? rows.filter((r) => r.studentNumber === selectedNumber) : rows;
    filtered.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (b.uploaded || "").localeCompare(a.uploaded || "")
    );
    return filtered;
  }, [docs, acads, chedForms, fileUrls, selectedNumber]);

  const visibleRows = useMemo(
    () => (typeFilter === "all" ? studentRows : studentRows.filter((r) => r.kind === typeFilter)),
    [studentRows, typeFilter]
  );

  // ONE ROW PER STUDENT — groups every uploaded file under a single student row.
  const studentGroups = useMemo(() => {
    const map = new Map<string, { studentNumber: string; name: string; year: string; latest?: string; files: DocRow[] }>();
    for (const r of visibleRows) {
      if (!map.has(r.studentNumber)) {
        map.set(r.studentNumber, { studentNumber: r.studentNumber, name: r.name, year: r.year, files: [] });
      }
      const g = map.get(r.studentNumber)!;
      g.files.push(r);
      if (r.uploaded && (!g.latest || r.uploaded > g.latest)) g.latest = r.uploaded;
    }
    // The modal shows ALL of the student's files (every type), even under a type filter.
    for (const g of map.values()) {
      g.files = studentRows.filter((r) => r.studentNumber === g.studentNumber);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.studentNumber.localeCompare(b.studentNumber));
  }, [studentRows, visibleRows, typeFilter]);

  const kindCount = (k: Kind) => studentRows.filter((r) => r.kind === k).length;

  function openStudentDocs(r: { studentNumber: string; name: string }, mode: "view" | "download" | "delete") {
    setStudentDocsOpen({ studentNumber: r.studentNumber, name: r.name, mode });
    setModalSelected(new Set());
  }

  // Every file uploaded by the student whose ID was clicked — all types together.
  const studentModalFiles = useMemo(
    () => (studentDocsOpen ? studentRows.filter((r) => r.studentNumber === studentDocsOpen.studentNumber) : []),
    [studentDocsOpen, studentRows]
  );
  const toggleModalItem = (key: string) =>
    setModalSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const allModalSelected =
    studentModalFiles.length > 0 && studentModalFiles.every((r) => modalSelected.has(r.key));
  const selectAllModal = () =>
    setModalSelected(allModalSelected ? new Set() : new Set(studentModalFiles.map((r) => r.key)));
  const modalDownloadable = studentModalFiles
    .filter((r) => r.url)
    .map((r) => ({ url: r.url!, name: r.fileLabel }));
  const modalSelectedFiles = studentModalFiles
    .filter((r) => modalSelected.has(r.key) && r.url)
    .map((r) => ({ url: r.url!, name: r.fileLabel }));

  const allDownloadable: { url: string; name: string }[] = visibleRows
    .filter((r) => r.url)
    .map((r) => ({ url: r.url!, name: r.fileLabel }));

  function exportCsv() {
    downloadCsv(
      "documents.csv",
      visibleRows.map((r, i) => ({
        no: i + 1,
        student_id: r.studentNumber,
        full_name: r.name,
        year_level: r.year,
        type: KIND_META[r.kind].label,
        details: r.details,
        uploaded: formatDateTime(r.uploaded),
        file: r.path.split("/").pop() || "",
      }))
    );
    setFlash({ type: "ok", text: `Exported ${visibleRows.length} document row(s) as CSV (${studentGroups.length} student(s)).` });
    toast.success(`Exported ${visibleRows.length} document row(s) as CSV.`);
  }

  if (loading) return <Spinner label="Loading documents..." />;

  const cellCls = "border border-[#241012]/10 px-3 py-1.5 align-middle";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Documents Viewer</h1>
          <p className="mt-1 text-xs text-[#8B7376]">
            Every submitted file in one list — ITR, academic records, and support documents.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={exportCsv}
            disabled={!visibleRows.length}
            className="rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
          >
            &#11015; Export CSV
          </button>
          <button
            onClick={() => downloadAll(allDownloadable)}
            disabled={!allDownloadable.length || dlBusy}
            className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dlBusy ? `Zipping ${dlProgress.done}/${dlProgress.total}...` : `Download all files (${allDownloadable.length}) as ZIP`}
          </button>
        </div>
      </div>

      {flash && (
        <div className={`rounded-xl border px-4 py-3 text-xs font-medium ${flash.type === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>
          {flash.text}
        </div>
      )}

      {studentRows.length === 0 ? (
        <EmptyState icon="&#128450;" title="No uploads yet" hint="Files appear here as students upload requirements." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">Submitted Documents</p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                {studentRows.length} file{studentRows.length === 1 ? "" : "s"} from {studentGroups.length} student{studentGroups.length === 1 ? "" : "s"} &middot;{" "}
                <span className="font-semibold text-[#7B1113]">{studentGroups.length} row{studentGroups.length === 1 ? "" : "s"} shown</span>
                {" \u00b7 "}
                <span className="text-[#6B5458]">One row per student - click View, Download or Delete to open that student's file-selection modal</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="text-xs font-semibold text-[#241012]">
                <select
                  value={selectedStudent}
                  onChange={(e) => setSelectedStudent(e.target.value)}
                  className="block w-full min-w-64 rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                >
                  <option value="">All students</option>
                  {students.map((s) => (
                    <option key={s.student_id} value={s.student_id}>
                      {s.last_name}, {s.given_name} ({s.student_number || "no ID"})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-3">
            {([["all", "All files"], ["itr", "ITR"], ["academic", "Academic Record"], ["support", "Support Document"]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTypeFilter(k)}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
                  typeFilter === k
                    ? "bg-[#7B1113] text-white shadow-sm"
                    : "border border-[#241012]/10 bg-white text-[#6B5458] hover:bg-[#7B1113]/5"
                }`}
              >
                {label} <span className={typeFilter === k ? "text-white/70" : "text-[#8B7376]"}>{k === "all" ? studentRows.length : kindCount(k)}</span>
              </button>
            ))}
          </div>

          {studentGroups.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[#8B7376]">No files match this filter.</p>
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-[11px] text-[#241012]">
                <thead className="sticky top-0 z-10 bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458]">
                  <tr>
                    <th className={`${cellCls} w-12 text-center font-bold`}>#</th>
                    <th className={`${cellCls} font-bold`}>Student ID</th>
                    <th className={`${cellCls} font-bold`}>Full Name</th>
                    <th className={`${cellCls} w-16 font-bold`}>Year</th>
                    <th className={`${cellCls} font-bold`}>Documents</th>
                    <th className={`${cellCls} font-bold`}>Latest Upload</th>
                    <th className={`${cellCls} w-64 font-bold`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {studentGroups.map((g, i) => {
                    const count = (k: Kind) => g.files.filter((r) => r.kind === k).length;
                    const notReady = g.files.filter((r) => !r.url).length;
                    return (
                      <tr key={g.studentNumber} className={i % 2 ? "bg-[#FAF7F5]/60" : "bg-white"}>
                        <td className={`${cellCls} text-center font-bold text-[#6B5458]`}>{i + 1}</td>
                        <td className={cellCls}>
                          <button
                            onClick={() => openStudentDocs(g, "view")}
                            disabled={studentDocsOpen?.studentNumber === g.studentNumber}
                            title={`Open ALL documents of ${g.name} (${g.studentNumber}) in one modal`}
                            className="font-semibold text-[#7B1113] underline decoration-dotted underline-offset-2 transition hover:bg-[#7B1113]/5 disabled:opacity-50"
                          >
                            {g.studentNumber}
                          </button>
                        </td>
                        <td className={`${cellCls} whitespace-nowrap font-bold text-[#241012]`}>{g.name}</td>
                        <td className={`${cellCls} whitespace-nowrap text-center`}>{g.year}</td>
                        <td className={cellCls}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-bold text-[#7B1113]">{g.files.length} files</span>
                            {count("itr") > 0 && <Badge className={KIND_META.itr.cls}>{count("itr")} ITR</Badge>}
                            {count("academic") > 0 && <Badge className={KIND_META.academic.cls}>{count("academic")} Academic</Badge>}
                            {count("support") > 0 && <Badge className={KIND_META.support.cls}>{count("support")} Support</Badge>}
                            {notReady > 0 && (
                              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700" title="Files the system could not open (missing from storage or no permission to read them)">
                                {notReady} not ready
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={`${cellCls} whitespace-nowrap text-[#6B5458]`}>{formatDateTime(g.latest)}</td>
                        <td className={cellCls}>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => openStudentDocs(g, "view")}
                              title={`View any of ${g.name}'s documents`}
                              className="rounded-md bg-[#7B1113] px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-[#540111]"
                            >
                              View
                            </button>
                            <button
                              onClick={() => openStudentDocs(g, "download")}
                              title={`Download (any or all) of ${g.name}'s documents`}
                              className="rounded-md border border-[#7B1113]/25 px-2.5 py-1 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                            >
                              Download
                            </button>
                            <button
                              onClick={() => openStudentDocs(g, "delete")}
                              title={`Choose which of ${g.name}'s documents to delete`}
                              className="rounded-md border border-red-200 px-2.5 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5 text-[10px] text-[#6B5458]">
            <span>Support documents <b className="text-[#7B1113]">{kindCount("support")}</b></span>
            <span>Academic records <b className="text-[#7B1113]">{kindCount("academic")}</b></span>
            <span>ITR submissions <b className="text-[#7B1113]">{kindCount("itr")}</b></span>
            <span className="ml-auto">Files ready <b className="text-[#7B1113]">{allDownloadable.length}</b> of {visibleRows.length} shown</span>
          </div>
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[#241012]/[0.06] px-5 py-3">
              <p className="truncate text-xs font-bold text-[#241012]">{preview.name}</p>
              <button
                onClick={() => setPreview(null)}
                className="rounded-full p-1 text-lg leading-none text-[#8B7376] transition hover:bg-[#7B1113]/5 hover:text-[#7B1113]"
              >
                &times;
              </button>
            </div>
            <div className="flex max-h-[70vh] items-center justify-center overflow-hidden bg-[#241012]/95 p-2">
              {isImagePath(preview.path) ? (
                <Image
                  src={preview.url}
                  alt={preview.name}
                  width={1200}
                  height={1600}
                  unoptimized
                  className="h-auto max-h-[68vh] w-auto object-contain"
                />
              ) : (
                <iframe src={preview.url} title={preview.name} className="h-[68vh] w-full rounded-lg" />
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3">
              <a
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
              >
                Open original
              </a>
              <button
                onClick={() => downloadOne(preview.url, preview.name)}
                disabled={dlBusy}
                className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* All documents of one student — pick which files to view or download */}
      {studentDocsOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setStudentDocsOpen(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#241012]/[0.06] px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold text-[#241012]">
                  {studentDocsOpen.mode === "view" ? "View documents — " : studentDocsOpen.mode === "download" ? "Download documents — " : "Delete documents — "}
                  {studentDocsOpen.name}
                </h3>
                <p className="mt-0.5 text-[11px] text-[#8B7376]">
                  Student ID {studentDocsOpen.studentNumber} &middot; {studentModalFiles.length} file(s) uploaded &middot;{" "}
                  {studentModalFiles.filter((r) => r.kind === "itr").length} ITR &middot;{" "}
                  {studentModalFiles.filter((r) => r.kind === "academic").length} Academic &middot;{" "}
                  {studentModalFiles.filter((r) => r.kind === "support").length} Support
                </p>
              </div>
              <button
                onClick={() => setStudentDocsOpen(null)}
                className="rounded-full p-1 text-lg leading-none text-[#8B7376] transition hover:bg-[#7B1113]/5 hover:text-[#7B1113]"
              >
                &times;
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-[#241012]/[0.06] bg-[#FAF7F5] px-5 py-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-[11px] font-bold text-[#241012]">
                <input
                  type="checkbox"
                  checked={allModalSelected}
                  onChange={selectAllModal}
                  className="size-4 accent-[#7B1113]"
                />
                Select all ({studentModalFiles.length})
              </label>
              <span className="ml-auto text-[11px] text-[#8B7376]">
                {modalSelected.size} selected
              </span>
            </div>

            <div className="max-h-[55vh] overflow-auto">
              {studentModalFiles.map((r, i) => (
                <div key={r.key} className={`flex items-center gap-3 px-5 py-2.5 ${i % 2 ? "bg-[#FAF7F5]/60" : "bg-white"}`}>
                  <input
                    type="checkbox"
                    checked={modalSelected.has(r.key)}
                    onChange={() => toggleModalItem(r.key)}
                    title="Select this file for the action below"
                    className="size-4 shrink-0 accent-[#7B1113]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={KIND_META[r.kind].cls}>{KIND_META[r.kind].label}</Badge>
                      <span className="truncate text-[11px] font-bold text-[#241012]" title={r.details}>{r.details}</span>
                      {!r.url && <Badge className="border-amber-200 bg-amber-50 text-amber-700">not ready</Badge>}
                    </div>
                    <p className="mt-0.5 text-[10px] text-[#8B7376]">Uploaded {formatDateTime(r.uploaded)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => r.url && setPreview({ url: r.url, name: r.path.split("/").pop() || KIND_META[r.kind].label, bucket: r.bucket, path: r.path })}
                      disabled={!r.url}
                      className="rounded-md bg-[#7B1113] px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-[#540111] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      View
                    </button>
                    <button
                      onClick={() => r.url && downloadOne(r.url, r.fileLabel)}
                      disabled={!r.url || dlBusy}
                      className="rounded-md border border-[#7B1113]/25 px-2.5 py-1 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Download
                    </button>
                    <button
                      onClick={() => deleteOne(r.kind, r.deleteId, r.bucket, r.path, r.key)}
                      disabled={delBusyKey === r.key}
                      className="rounded-md border border-red-200 px-2.5 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                    >
                      {delBusyKey === r.key ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
              {studentModalFiles.length === 0 && (
                <p className="px-5 py-8 text-center text-xs text-[#8B7376]">No files for this student.</p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#241012]/[0.06] px-5 py-3">
              {studentDocsOpen.mode === "delete" ? (
                <button
                  onClick={() => deleteMany(studentModalFiles.filter((r) => modalSelected.has(r.key)))}
                  disabled={!modalSelected.size || !!delBusyKey}
                  className="rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white shadow-md transition hover:bg-red-700 disabled:opacity-50"
                >
                  {delBusyKey ? "Deleting..." : `Delete selected (${modalSelected.size})`}
                </button>
              ) : (
                <button
                  onClick={() => {
                    const first = studentModalFiles.find((r) => modalSelected.has(r.key) && r.url);
                    if (first) setPreview({ url: first.url!, name: first.path.split("/").pop() || KIND_META[first.kind].label, bucket: first.bucket, path: first.path });
                  }}
                  disabled={!modalSelected.size || !studentModalFiles.some((r) => modalSelected.has(r.key) && r.url)}
                  className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
                >
                  View selected ({modalSelected.size})
                </button>
              )}
              <button
                onClick={() => downloadAll(modalSelectedFiles, `student-documents-${studentDocsOpen.studentNumber}-${new Date().toISOString().slice(0, 10)}.zip`)}
                disabled={!modalSelectedFiles.length || dlBusy}
                className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
              >
                {dlBusy ? "Zipping..." : `Download selected (${modalSelectedFiles.length}) as ZIP`}
              </button>
              <button
                onClick={() => downloadAll(modalDownloadable, `student-documents-${studentDocsOpen.studentNumber}-${new Date().toISOString().slice(0, 10)}.zip`)}
                disabled={!modalDownloadable.length || dlBusy}
                className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
              >
                {dlBusy ? `Zipping ${dlProgress.done}/${dlProgress.total}...` : `Download all files (${modalDownloadable.length}) as ZIP`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
