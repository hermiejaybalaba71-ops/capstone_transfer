"use client";
import toast from "react-hot-toast";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDate, formatDateTime, validateFile } from "@/lib/utils";
import { DOC_TYPES } from "@/lib/constants";
import type { User, StudentAccount, SupportDocument, SupportAcademicRecord } from "@/lib/types";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";

interface EditForm {
  middle_name: string;
  ext_name: string;
  birthdate: string;
}

export default function StudentProfilePage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");

  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<StudentAccount | null>(null);
  const [docs, setDocs] = useState<SupportDocument[]>([]);
  const [acads, setAcads] = useState<SupportAcademicRecord[]>([]);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>({ middle_name: "", ext_name: "", birthdate: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState("");

  const [uploadingDocType, setUploadingDocType] = useState<string | null>(null);
  const [acadUploading, setAcadUploading] = useState(false);
  const [acadError, setAcadError] = useState("");

  const acadFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    setLoading(true);
    setFatalError("");

    const sb = getSupabase();
    const { data: sessionData } = await sb.auth.getSession();
    if (!sessionData.session) {
      router.push("/login");
      return;
    }

    const { data: authUser } = await sb.auth.getUser();

    const userId = authUser.user?.id;
    if (!userId) {
      setFatalError("Your session is invalid. Please log in again.");
      setLoading(false);
      return;
    }

    const userQuery = await sb
      .from("users")
      .select("*")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (userQuery.error || !userQuery.data) {
      setFatalError("Could not find your user record. Please contact the Scholarship Office.");
      setLoading(false);
      return;
    }

    const accountQuery = await sb
      .from("student_accounts")
      .select("*")
      .eq("user_id", userQuery.data.user_id)
      .maybeSingle();

    if (accountQuery.error || !accountQuery.data) {
      setFatalError("Could not find your student account.");
      setLoading(false);
      return;
    }

    const studentId = accountQuery.data.student_id;

    const [appsForDocs, acadQuery] = await Promise.all([
      sb.from("scholarship_applications").select("application_id").eq("student_id", studentId),
      sb
        .from("support_academic_records")
        .select("*")
        .eq("student_id", studentId)
        .order("created_at", { ascending: false }),
    ]);

    const appIds = (appsForDocs.data || []).map((a: { application_id: number }) => a.application_id);
    const docQuery = appIds.length > 0
      ? await sb.from("support_documents").select("*").in("application_id", appIds).order("upload_date", { ascending: false })
      : { data: [], error: null };

    setUser(userQuery.data);
    setAccount(accountQuery.data);
    setEditForm({
      middle_name: accountQuery.data.middle_name || "",
      ext_name: accountQuery.data.ext_name || "",
      birthdate: accountQuery.data.birthdate || "",
    });

    const loadedDocs = (docQuery.data || []) as SupportDocument[];
    // The same scan may be linked to several of this student's applications
    // (that is how per-application requirements are satisfied). Show each
    // distinct file only once on the profile page.
    const seenDocs = new Set<string>();
    const uniqueDocs = loadedDocs.filter((d) => {
      const key = `${d.document_type}::${d.file_path}`;
      if (seenDocs.has(key)) return false;
      seenDocs.add(key);
      return true;
    });
    const loadedAcads = (acadQuery.data || []) as SupportAcademicRecord[];
    setDocs(uniqueDocs);
    setAcads(loadedAcads);

    await buildSignedUrls([
      ...loadedDocs.map((d) => ({ bucket: "support-documents", path: d.file_path })),
      ...loadedAcads.filter((a) => a.proof_image_path).map((a) => ({ bucket: "academic-records", path: a.proof_image_path! })),
    ]);

    setLoading(false);
  }

  async function buildSignedUrls(items: { bucket: string; path: string }[]) {
    const sb = getSupabase();
    const map: Record<string, string> = {};
    for (const item of items) {
      if (!item.path) continue;
      const res = await sb.storage.from(item.bucket).createSignedUrl(item.path, 3600);
      if (res.data?.signedUrl) map[item.path] = res.data.signedUrl;
    }
    setFileUrls((prev) => ({ ...prev, ...map }));
  }

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault();
    if (!account) return;
    setProfileMsg("");
    setSavingProfile(true);

    const updates = {
      middle_name: editForm.middle_name.trim() || null,
      ext_name: editForm.ext_name.trim() || null,
      birthdate: editForm.birthdate || null,
    };

    const sb = getSupabase();
    const { error } = await sb
      .from("student_accounts")
      .update(updates)
      .eq("student_id", account.student_id);

    setSavingProfile(false);

    if (error) {
      setProfileMsg(error.message);
      return;
    }

    setAccount({ ...account, ...updates });
    setProfileMsg("Profile updated successfully.");
    toast.success("Profile updated successfully.");
    setEditing(false);
  }

  async function handleAcadSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAcadError("");
    if (!account) return;

    const form = e.currentTarget;
    const formData = new FormData(form);
    const applicantType = formData.get("applicantType") as string;
    const scoreStr = formData.get("score") as string;
    const file = formData.get("proof") as File | null;

    if (!applicantType) {
      setAcadError("Select Freshman or Alumni first.");
      return;
    }

    const numeric = parseFloat(scoreStr);
    if (Number.isNaN(numeric)) {
      setAcadError("Enter your GWA/GPA as a number.");
      return;
    }
    if (numeric <= 0 || numeric > 100) {
      setAcadError("Enter a valid grade between 1 and 100.");
      return;
    }

    if (!file || file.size === 0) {
      setAcadError("Please choose a proof file.");
      return;
    }
    const invalid = validateFile(file);
    if (invalid) {
      setAcadError(invalid);
      return;
    }

    setAcadUploading(true);
    const sb = getSupabase();
    const sid = account.student_id;
    const safeName = file.name.replace(/[^\w.\-]/g, "_");
    const acadFolder = applicantType === "Freshman" ? "SHS" : "Alumni";
    const path = `${sid}/${acadFolder}/${Date.now()}_${safeName}`;

    const up = await sb.storage.from("academic-records").upload(path, file);
    if (up.error) {
      setAcadError(up.error.message);
      setAcadUploading(false);
      return;
    }

    const payload: Record<string, unknown> = {
      student_id: sid,
      applicant_type: applicantType,
      proof_image_path: path,
    };
    if (applicantType === "Freshman") payload.shs_gwa = numeric;
    else payload.college_gpa = numeric;

    const ins = await sb.from("support_academic_records").insert(payload);
    setAcadUploading(false);

    if (ins.error) {
      await sb.storage.from("academic-records").remove([path]);
      setAcadError(ins.error.message);
      return;
    }

    form.reset();
    setProfileMsg("Academic record submitted successfully.");
    toast.success("Academic record submitted successfully.");
    await refreshAcads();
  }

  async function refreshAcads() {
    if (!account) return;
    const sb = getSupabase();
    const { data } = await sb
      .from("support_academic_records")
      .select("*")
      .eq("student_id", account.student_id)
      .order("created_at", { ascending: false });
    const loaded = (data || []) as SupportAcademicRecord[];
    setAcads(loaded);
    await buildSignedUrls(
      loaded.filter((a) => a.proof_image_path).map((a) => ({ bucket: "academic-records", path: a.proof_image_path! }))
    );
  }

  async function handleUploadDoc(docType: string, file: File) {
    if (!account) return;
    setProfileMsg("");
    const invalid = validateFile(file);
    if (invalid) {
      setProfileMsg(`${docType}: ${invalid}`);
      return;
    }

    setUploadingDocType(docType);
    const sb = getSupabase();
    const sid = account.student_id;
    const safeName = file.name.replace(/[^\w.\-]/g, "_");
    const path = `${sid}/${docType.replace(/\s+/g, "_")}/${Date.now()}_${safeName}`;

    const up = await sb.storage.from("support-documents").upload(path, file);
    if (up.error) {
      setProfileMsg(`Upload failed (${docType}): ${up.error.message}`);
      setUploadingDocType(null);
      return;
    }

    const apps = await sb.from("scholarship_applications").select("application_id").eq("student_id", sid).order("application_date", { ascending: false }).limit(1);
    const appId = apps.data?.[0]?.application_id;
    if (!appId) {
      await sb.storage.from("support-documents").remove([path]);
      setProfileMsg("No application found to attach this document to. Please apply first.");
      setUploadingDocType(null);
      return;
    }

    const ins = await sb
      .from("support_documents")
      .insert({ application_id: appId, document_type: docType, file_path: path });

    setUploadingDocType(null);

    if (ins.error) {
      await sb.storage.from("support-documents").remove([path]);
      setProfileMsg(`Saved to storage but not to your record: ${ins.error.message}`);
      return;
    }

    setProfileMsg(`${docType} uploaded successfully.`);
    toast.success(`${docType} uploaded successfully.`);
    await refreshDocs();
  }

  async function refreshDocs() {
    if (!account) return;
    const sb = getSupabase();
    const apps = await sb.from("scholarship_applications").select("application_id").eq("student_id", account.student_id);
    const appIds = (apps.data || []).map((a: { application_id: number }) => a.application_id);
    if (appIds.length === 0) { setDocs([]); return; }
    const { data } = await sb
      .from("support_documents")
      .select("*")
      .in("application_id", appIds)
      .order("upload_date", { ascending: false });
    const loaded = (data || []) as SupportDocument[];
    setDocs(loaded);
    await buildSignedUrls(
      loaded.map((d) => ({ bucket: "support-documents", path: d.file_path }))
    );
  }

  if (loading) {
    return <Spinner label="Loading profile..." />;
  }

  if (fatalError) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-bold text-red-700">Something went wrong</p>
          <p className="mt-2 text-sm text-red-600">{fatalError}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-[#241012]">Profile & Documents</h1>
      <p className="mt-1 text-xs text-[#6B5458]">Your registered details, academic records, and uploaded documents.</p>

      {profileMsg && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            profileMsg.includes("success") || profileMsg.includes("validated")
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-[#7B1113]/20 bg-white text-[#7B1113]"
          }`}
        >
          {profileMsg}
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* ---------- ACCOUNT INFO ---------- */}
        <div className="rounded-xl border border-[#7B1113]/10 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#7B1113]">My Information</h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div>
              <dt className="text-[#8B7376]">Student Number</dt>
              <dd className="font-semibold">{account?.student_number || "—"}</dd>
            </div>
            <div>
              <dt className="text-[#8B7376]">Full Name</dt>
              <dd className="font-semibold">
                {account?.last_name}, {account?.given_name}
              </dd>
            </div>
            <div>
              <dt className="text-[#8B7376]">Middle Name</dt>
              <dd className="font-semibold">{account?.middle_name || "—"}</dd>
            </div>
            <div>
              <dt className="text-[#8B7376]">Ext. Name</dt>
              <dd className="font-semibold">{account?.ext_name || "—"}</dd>
            </div>
            <div>
              <dt className="text-[#8B7376]">Sex</dt>
              <dd className="font-semibold">{account?.sex || "—"}</dd>
            </div>
            <div>
              <dt className="text-[#8B7376]">Birthdate</dt>
              <dd className="font-semibold">{formatDate(account?.birthdate)}</dd>
            </div>
            <div>
              <dt className="text-[#8B7376]">Program</dt>
              <dd className="font-semibold">{account?.program_name || "—"}</dd>
            </div>
            <div>
              <dt className="text-[#8B7376]">Year Level</dt>
              <dd className="font-semibold">{account?.year_level || "—"}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[#8B7376]">Email</dt>
              <dd className="break-all font-semibold">{user?.email}</dd>
            </div>
          </dl>

          {/* Editable details */}
          <form onSubmit={handleProfileSave} className="mt-5 border-t border-[#7B1113]/10 pt-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-[#241012]">Editable details</p>
              {!editing && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-lg border border-[#7B1113]/30 px-3 py-1.5 text-[11px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                >
                  Edit
                </button>
              )}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[#6B5458]">Middle Name</span>
                <input
                  value={editForm.middle_name}
                  onChange={(e) => setEditForm({ ...editForm, middle_name: e.target.value })}
                  disabled={!editing || savingProfile}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-[#7B1113]/25 px-3 py-2 text-xs outline-none focus:border-[#7B1113] disabled:bg-[#FAF7F5] disabled:text-[#6B5458]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[#6B5458]">Ext. Name</span>
                <input
                  value={editForm.ext_name}
                  onChange={(e) => setEditForm({ ...editForm, ext_name: e.target.value })}
                  disabled={!editing || savingProfile}
                  placeholder="Jr., III…"
                  className="w-full rounded-lg border border-[#7B1113]/25 px-3 py-2 text-xs outline-none focus:border-[#7B1113] disabled:bg-[#FAF7F5] disabled:text-[#6B5458]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[#6B5458]">Birthdate</span>
                <input
                  type="date"
                  value={editForm.birthdate}
                  onChange={(e) => setEditForm({ ...editForm, birthdate: e.target.value })}
                  max={new Date().toISOString().split("T")[0]}
                  min="1920-01-01"
                  disabled={!editing || savingProfile}
                  className="w-full rounded-lg border border-[#7B1113]/25 px-3 py-2 text-xs outline-none focus:border-[#7B1113] disabled:bg-[#FAF7F5] disabled:text-[#6B5458]"
                />
              </label>
            </div>
            {editing && (
              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="rounded-lg bg-[#7B1113] px-4 py-2 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-60"
                >
                  {savingProfile ? "Saving..." : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEditForm({
                      middle_name: account?.middle_name || "",
                      ext_name: account?.ext_name || "",
                      birthdate: account?.birthdate || "",
                    });
                  }}
                  disabled={savingProfile}
                  className="rounded-lg border border-[#241012]/15 px-4 py-2 text-xs font-bold text-[#6B5458] hover:bg-[#FAF7F5] disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            )}
          </form>
        </div>

        {/* ---------- ACADEMIC RECORDS ---------- */}
        <div className="rounded-xl border border-[#7B1113]/10 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#7B1113]">Academic Records</h2>
          <p className="mt-1 text-[11px] text-[#6B5458]">
            Freshman → SHS General Weighted Average · Alumni → College GPA.
            Upload your report card / grades card as proof (JPG, PNG, or PDF, max 10 MB).
          </p>

          <form ref={acadFormRef} onSubmit={handleAcadSubmit} className="mt-4 space-y-3">
            <select
              name="applicantType"
              defaultValue=""
              className="w-full rounded-lg border border-[#7B1113]/25 px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
            >
              <option value="">Applicant type…</option>
              <option value="Freshman">Freshman — SHS GWA</option>
              <option value="Alumni">Alumni — College GPA</option>
            </select>

            <input
              name="score"
              type="number"
              step="0.01"
              min="1"
              max="100"
              placeholder="Enter GWA or GPA"
              className="w-full rounded-lg border border-[#7B1113]/25 px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
            />

            <input
              name="proof"
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.pdf"
              className="w-full rounded-lg border border-dashed border-[#7B1113]/30 px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-[#7B1113] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
            />

            {acadError && <p className="text-xs font-semibold text-red-600">{acadError}</p>}

            <button
              type="submit"
              disabled={acadUploading}
              className="w-full rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-60"
            >
              {acadUploading ? "Uploading…" : "Submit academic record"}
            </button>
          </form>

          {acads.length > 0 ? (
            <ul className="mt-4 space-y-2 border-t border-[#7B1113]/10 pt-3">
              {acads.map((a) => (
                <li key={a.record_id} className="flex items-center justify-between gap-2 text-xs">
                  <span>
                    <Badge className="border-[#7B1113]/20 bg-[#7B1113]/5 text-[#7B1113]">{a.applicant_type}</Badge>{" "}
                    <strong>{a.shs_gwa ?? a.college_gpa}</strong>
                    <span className="ml-2 text-[10px] text-[#8B7376]">{formatDate(a.created_at)}</span>
                  </span>
                  {a.proof_image_path && fileUrls[a.proof_image_path] && (
                    <a href={fileUrls[a.proof_image_path]} target="_blank" rel="noreferrer" className="shrink-0 font-semibold text-[#7B1113] hover:underline">
                      View
                    </a>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4">
              <EmptyState icon="📋" title="No academic records" hint="Submit your GWA or GPA above." />
            </div>
          )}
        </div>
      </div>

      {/* ---------- SUPPORT DOCUMENTS ---------- */}
      <div className="mt-5 rounded-xl border border-[#7B1113]/10 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-[#7B1113]">Supporting Documents</h2>
        <p className="mt-1 text-[11px] text-[#6B5458]">
          Upload clear scans of each requirement (JPG, PNG, or PDF, max 10 MB).
          The Valid ID must have your signature.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {DOC_TYPES.map((docType) => {
            const existing = docs.filter((d) => d.document_type === docType);
            const busy = uploadingDocType === docType;
            return (
              <div key={docType} className="rounded-xl border border-dashed border-[#7B1113]/30 bg-[#FAF7F5] p-4 text-center">
                <p className="text-xs font-bold text-[#241012]">{docType}</p>
                <p className="mt-1 text-[10px] text-[#8B7376]">
                  {existing.length > 0 ? `${existing.length} uploaded` : "Not yet uploaded"}
                </p>
                <label className={`mt-3 block cursor-pointer rounded-lg px-3 py-2 text-xs font-bold transition ${
                  busy ? "bg-[#7B1113]/50 text-white" : existing.length > 0 ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-[#7B1113] text-white hover:bg-[#540111]"
                }`}>
                  {busy ? "Uploading…" : existing.length > 0 ? "Replace" : "Upload"}
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.pdf"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      if (e.target.files?.[0]) handleUploadDoc(docType, e.target.files[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            );
          })}
        </div>

        {docs.length > 0 ? (
          <ul className="mt-4 space-y-2 border-t border-[#7B1113]/10 pt-3">
            {docs.map((d) => (
              <li key={d.document_id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0">
                  <Badge className="border-[#7B1113]/20 bg-[#7B1113]/5 text-[#7B1113]">{d.document_type}</Badge>{" "}
                  <span className="ml-1 truncate text-[#6B5458]">{d.file_path.split("/").pop()}</span>
                  <span className="ml-2 text-[10px] text-[#8B7376]">{formatDateTime(d.upload_date)}</span>
                </span>
                {fileUrls[d.file_path] && (
                  <a href={fileUrls[d.file_path]} target="_blank" rel="noreferrer" className="shrink-0 font-semibold text-[#7B1113] hover:underline">
                    View
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4">
            <EmptyState icon="📁" title="No documents uploaded" hint="Upload your COR, Valid ID, and Signature Form above." />
          </div>
        )}
      </div>
    </div>
  );
}
