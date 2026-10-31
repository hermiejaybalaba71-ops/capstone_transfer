"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDate, validateFile } from "@/lib/utils";
import { DISABILITY_OPTIONS, IP_GROUP_OPTIONS } from "@/lib/constants";
import { Spinner } from "@/components/ui/spinner";

interface StudentProfile {
  studentId: number;
  studentNumber: string;
  givenName: string;
  lastName: string;
  middleName?: string;
  extName?: string;
  sex?: string;
  birthdate?: string;
  programName?: string;
  yearLevel?: string;
  email: string;
}

interface ScholarshipProgram {
  scholarship_id: number;
  scholarship_name: string;
  description?: string;
  requirements?: string;
  deadline?: string;
  status?: string;
}

export default function ApplyPage() {
  return (
    <Suspense fallback={<Spinner label="Loading application form..." color="maroon" />}>
      <ApplyPageContent />
    </Suspense>
  );
}

function ApplyPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const programIdParam = searchParams.get("programId");

  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [programs, setPrograms] = useState<ScholarshipProgram[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<number | null>(
    programIdParam ? Number(programIdParam) : null
  );
  const [alreadyApplied, setAlreadyApplied] = useState(false);
  const [alreadyAppliedStatus, setAlreadyAppliedStatus] = useState("");

  const [form, setForm] = useState({
    fatherName: "",
    motherName: "",
    streetBarangay: "",
    zipcode: "",
    disability: "",
    ipGroup: "",
    contactNumber: "",
    email: "",
    annualIncome: "",
  });
  const [itrFile, setItrFile] = useState<File | null>(null);
  const [itrIncome, setItrIncome] = useState<number | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [showSampleForm, setShowSampleForm] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("error");

  async function handleItrChange(file: File | null) {
    setItrFile(file);
    setItrIncome(null);
    setOcrStatus("");
    if (!file) return;
    if (/\.(jpg|jpeg|png|webp)$/i.test(file.name)) {
      setOcrBusy(true);
      setOcrStatus("Reading ITR with OCR…");
      try {
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const { data } = await worker.recognize(file);
        await worker.terminate();
        const text = data.text || "";
        const incomeMatch =
          text.match(/(?:total\s+family\s+annual\s+income|total\s+annual\s+family\s+income|family\s+annual\s+income|total\s+family\s+income|total\s+gross\s+compensation\s+income|total\s+compensation\s+income|gross\s+compensation\s+income|taxable\s+compensation\s+income|annual\s+compensation\s+income|total\s+annual\s+income|total\s+gross\s+income|gross\s+income\s+from\s+(?:business|operation)|gross\s+income|total\s+taxable\s+income|net\s+taxable\s+income|total\s+income|taxable\s+income|net\s+income)[^\d]{0,40}(?:₱|PHP|P)?\s*((?:\d{1,3}(?:[,.]\d{3})+|\d{4,9})(?:[.,]\d{1,2})?)/i) ||
          text.match(/₱\s*([\d,]+(?:\.\d{2})?)/);
        if (incomeMatch) {
          const amount = incomeMatch[1];
          const decimal = amount.match(/[.,]\d{1,2}$/)?.[0] ?? "";
          const integer = decimal ? amount.slice(0, -decimal.length) : amount;
          const grouped = /^\d{1,3}(?:[,.]\d{3})+$/.test(integer);
          const normalized = grouped
            ? `${integer.replace(/[,.]/g, "")}${decimal ? `.${decimal.slice(1)}` : ""}`
            : amount.replace(/,/g, "");
          const parsed = Number(normalized);
          if (!isNaN(parsed) && parsed > 0) {
            setItrIncome(Math.round(parsed));
            setOcrStatus(`OCR read ₱${Math.round(parsed).toLocaleString()} from the ITR. Enter your declared annual family income to see the match percentage.`);
          } else {
            setOcrStatus("OCR read the ITR but could not detect income. Please enter it manually.");
          }
        } else {
          setOcrStatus("OCR could not find an income figure on this ITR. Please enter annual family income manually.");
        }
      } catch {
        setOcrStatus("OCR failed for this file. Please enter annual family income manually.");
      }
      setOcrBusy(false);
    } else if (/\.pdf$/i.test(file.name)) {
      setOcrStatus("PDF selected. Enter the annual family income shown on the ITR; automatic image matching supports JPG, PNG, and WEBP.");
    }
  }

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      setFatalError("");

      const sb = getSupabase();
      const { data: sessionData } = await sb.auth.getSession();
      if (!sessionData.session) {
        router.push("/login");
        return;
      }

      const { data: authUser } = await sb.auth.getUser();

      const userId = authUser.user?.id;
      if (!userId) { setFatalError("Could not identify your account."); setLoading(false); return; }

      const userQuery = await sb
        .from("users")
        .select("user_id, email")
        .eq("auth_user_id", userId)
        .maybeSingle();

      if (userQuery.error || !userQuery.data) {
        setFatalError("Could not find your user record.");
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

      const acct = accountQuery.data;

      let regStatus = acct.registration_status;
      if (regStatus !== "Verified" && acct.student_number) {
        const { queryRegistrar } = await import("@/lib/supabase/registrar");
        const reg = await queryRegistrar<{ student_number: string }>((rsb) =>
          rsb
            .from("registrar_students")
            .select("student_number")
            .eq("student_number", acct.student_number!)
            .maybeSingle()
        );
        if (reg.data) {
          await sb.from("student_accounts").update({ registration_status: "Verified" }).eq("student_id", acct.student_id);
          regStatus = "Verified";
        }
      }

      if (regStatus !== "Verified") {
        setFatalError("Your account is not yet verified against the Registrar Information System. Please contact the Administrator to get verified before applying for scholarships.");
        setLoading(false);
        return;
      }

      setProfile({
        studentId: acct.student_id,
        studentNumber: acct.student_number || "",
        givenName: acct.given_name || "",
        lastName: acct.last_name || "",
        middleName: acct.middle_name || "",
        extName: acct.ext_name || "",
        sex: acct.sex || "",
        birthdate: acct.birthdate || "",
        programName: acct.program_name || "",
        yearLevel: acct.year_level || "",
        email: userQuery.data.email || "",
      });

      setForm((f) => ({ ...f, email: userQuery.data!.email || "" }));

      const programsQuery = await sb
        .from("scholarship_programs")
        .select("*")
        .eq("status", "Open")
        .order("created_at", { ascending: false });

      if (!programsQuery.error && programsQuery.data) {
        setPrograms(programsQuery.data);
      }

      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  useEffect(() => {
    if (!profile || !selectedProgramId) return;
    let cancelled = false;
    const sb = getSupabase();
    sb.from("scholarship_applications")
      .select("application_status")
      .eq("student_id", profile.studentId)
      .eq("scholarship_id", selectedProgramId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setAlreadyApplied(!!data);
        setAlreadyAppliedStatus(data?.application_status ?? "");
      });
    return () => { cancelled = true; };
  }, [profile, selectedProgramId]);

  function handleFormChange(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function handleContactChange(raw: string) {
    let digits = raw.replace(/\D/g, "");
    if (digits.startsWith("63") && digits.length >= 12) digits = "0" + digits.slice(2);
    else if (digits.startsWith("630")) digits = "0" + digits.slice(3);
    if (digits.length > 0 && digits[0] !== "0") digits = "0" + digits;
    if (digits.length >= 2 && digits[0] === "0" && digits[1] !== "9") {
      digits = "09" + digits.slice(2);
    }
    if (digits.length > 11) digits = digits.slice(0, 11);
    setForm((f) => ({ ...f, contactNumber: digits }));
  }

  function handleZipChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    setForm((f) => ({ ...f, zipcode: digits }));
  }

  const PH_PHONE_RE = /^09\d{9}$/;
  const PH_ZIP_RE = /^\d{4}$/;
  const declaredFamilyIncome = Number(form.annualIncome);
  const itrMatchPct =
    itrIncome !== null &&
    form.annualIncome.trim() !== "" &&
    Number.isFinite(declaredFamilyIncome) &&
    declaredFamilyIncome >= 0
      ? Math.max(
          0,
          Math.min(
            100,
            100 * (1 - Math.abs(itrIncome - declaredFamilyIncome) / Math.max(itrIncome, declaredFamilyIncome, 1)),
          ),
        )
      : null;
  const NAME_RE = /^[A-Za-z\u00C0-\u00FF'.\- ]+$/;

  function validateNameField(label: string, value: string): string | null {
    if (!value.trim()) return `${label} is required.`;
    if (/\d/.test(value)) return `${label} must not contain numbers.`;
    if (!NAME_RE.test(value)) return `${label} contains invalid characters.`;
    return null;
  }

  function validatePhone(value: string): string | null {
    const cleaned = value.replace(/\D/g, "");
    if (!PH_PHONE_RE.test(cleaned)) {
      return "Contact number must be a Philippine mobile number: exactly 09XXXXXXXXX (11 digits, starts with 09).";
    }
    return null;
  }

  function validateZipcode(value: string): string | null {
    const cleaned = value.replace(/\D/g, "");
    if (!PH_ZIP_RE.test(cleaned)) {
      return "Zipcode must be a valid PH postal code (exactly 4 digits, e.g. 9200 for Iligan).";
    }
    return null;
  }

  function isDeadlinePassed(p?: { deadline?: string | null }) {
    if (!p?.deadline) return false;
    return Date.now() > new Date(`${p.deadline}T23:59:59`).getTime();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;

    if (!selectedProgramId) {
      setMessage("Please select a scholarship program.");
      setMessageType("error");
      return;
    }

    const chosenProgram = programs.find((p) => p.scholarship_id === selectedProgramId);
    if (chosenProgram?.status !== "Open") {
      setMessage(`"${chosenProgram?.scholarship_name || "This program"}" is no longer open for applications.`);
      setMessageType("error");
      return;
    }
    if (isDeadlinePassed(chosenProgram)) {
      setMessage(`Application cut-off reached — "${chosenProgram.scholarship_name}" closed last ${formatDate(chosenProgram.deadline)}. Applications are no longer accepted.`);
      setMessageType("error");
      return;
    }

    const nameChecks: [string, string][] = [
      ["Father's Full Name", form.fatherName],
      ["Mother's Full Name", form.motherName],
    ];
    for (const [label, val] of nameChecks) {
      const err = validateNameField(label, val);
      if (err) { setMessage(err); setMessageType("error"); return; }
    }

    const phoneErr = validatePhone(form.contactNumber);
    if (phoneErr) { setMessage(phoneErr); setMessageType("error"); return; }

    const zipErr = validateZipcode(form.zipcode);
    if (zipErr) { setMessage(zipErr); setMessageType("error"); return; }

    if (!itrFile) {
      setMessage("Please attach the Income Tax Return (ITR) file.");
      setMessageType("error");
      return;
    }

    const fileErr = validateFile(itrFile);
    if (fileErr) {
      setMessage(fileErr);
      setMessageType("error");
      return;
    }

    setSubmitting(true);
    setMessage("");

    try {
      const sb = getSupabase();
      const existingApp = await sb
        .from("scholarship_applications")
        .select("application_id, application_status")
        .eq("student_id", profile.studentId)
        .eq("scholarship_id", selectedProgramId)
        .maybeSingle();

      if (existingApp.data) {
        setMessage("You have already applied to this scholarship program.");
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const hasApproved = await sb
        .from("scholarship_applications")
        .select("application_id")
        .eq("student_id", profile.studentId)
        .eq("application_status", "Approved")
        .limit(1);

      if ((hasApproved.data || []).length > 0) {
        setMessage("You already have an approved scholarship. Applications are closed for you.");
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const safeItrName = itrFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const itrPath = `${profile.studentId}/ITR/${Date.now()}_${safeItrName}`;

      const itrUpload = await sb.storage.from("itr-documents").upload(itrPath, itrFile);
      if (itrUpload.error) {
        setMessage(`ITR upload failed: ${itrUpload.error.message}`);
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const { data: appRow, error: appErr } = await sb
        .from("scholarship_applications")
        .insert({
          student_id: profile.studentId,
          scholarship_id: selectedProgramId,
          application_data: {
            annual_income_family: Number(form.annualIncome) || 0,
            itr_file: itrPath,
          },
        })
        .select()
        .single();

      if (appErr) {
        await sb.storage.from("itr-documents").remove([itrPath]);
        setMessage(`Application failed: ${appErr.message}`);
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const { error: chedErr } = await sb.from("ched_form_input").insert({
        application_id: appRow.application_id,
        student_id: String(profile.studentNumber || profile.studentId),
        last_name: profile.lastName,
        given_name: profile.givenName,
        ext_name: profile.extName || null,
        middle_name: profile.middleName || null,
        sex: profile.sex,
        birthdate: profile.birthdate,
        complete_program_name: profile.programName,
        year_level: profile.yearLevel,
        father_name: form.fatherName.trim(),
        mother_name: form.motherName.trim(),
        street_barangay: form.streetBarangay.trim(),
        zipcode: form.zipcode.replace(/\D/g, ""),
        disability: form.disability.trim() || null,
        indigenous_people_group: form.ipGroup.trim() || null,
        contact_number: form.contactNumber.replace(/\D/g, ""),
        email_address: form.email.trim(),
        income_tax_return: itrPath,
        annual_income_family: Number(form.annualIncome) || 0,
      });

      if (chedErr) {
        setMessage(`Application saved but CHED form data failed: ${chedErr.message}`);
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const selectedProgram = programs.find((p) => p.scholarship_id === selectedProgramId);

      await sb.from("notifications_announcements").insert({
        student_id: profile.studentId,
        title: "Scholarship Application Submitted",
        message: `Your application for "${selectedProgram?.scholarship_name || "scholarship"}" has been submitted and is currently under review. You will be notified once a decision has been made.`,
        notification_type: "Status Update",
        status: "Unread",
      });

      setMessage(
        `Application submitted for "${selectedProgram?.scholarship_name || "scholarship"}". Upload your supporting documents and academic records under Profile & Documents, and track the status in Application Status.`
      );
      setMessageType("success");
      toast.success(`Application submitted for "${selectedProgram?.scholarship_name || "scholarship"}"!`);

      setForm({
        fatherName: "",
        motherName: "",
        streetBarangay: "",
        zipcode: "",
        disability: "",
        ipGroup: "",
        contactNumber: "",
        email: profile.email,
        annualIncome: "",
      });
      setItrFile(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "An unexpected error occurred.";
      setMessage(msg);
      setMessageType("error");
    }

    setSubmitting(false);
  }

  if (loading) {
    return <Spinner label="Loading application form..." />;
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Submit Application</h1>
          <p className="mt-1 text-xs text-[#6B5458]">Fill in the form to apply for a scholarship. Upload your supporting documents and academic records under Profile &amp; Documents.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowSampleForm(true)}
          className="shrink-0 rounded-lg border border-[#7B1113]/30 px-3 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
        >
          View Form Sample
        </button>
      </div>

      {message && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            messageType === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {message}
        </div>
      )}

      {alreadyApplied && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You already applied to this program
          {alreadyAppliedStatus ? ` (${alreadyAppliedStatus})` : ""}. Submission is
          disabled — track it under <span className="font-semibold">Status</span>.
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-4 space-y-5">
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">Scholarship Program</h2>
          <select
            value={selectedProgramId || ""}
            onChange={(e) => setSelectedProgramId(Number(e.target.value) || null)}
            required
            className="mt-3 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
          >
            <option value="">Choose a program...</option>
            {programs.map((p) => {
              const closed = p.status !== "Open" || isDeadlinePassed(p);
              return (
                <option key={p.scholarship_id} value={p.scholarship_id} disabled={closed}>
                  {p.scholarship_name}
                  {p.status !== "Open"
                    ? " — Closed"
                    : isDeadlinePassed(p)
                      ? ` — CLOSED: deadline was ${formatDate(p.deadline)}`
                      : p.deadline
                        ? ` — Deadline: ${formatDate(p.deadline)}`
                        : ""}
                </option>
              );
            })}
          </select>
          {(() => {
            const chosen = programs.find((p) => p.scholarship_id === selectedProgramId);
            if (chosen && isDeadlinePassed(chosen)) {
              return (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
                  The application deadline for <b>{chosen.scholarship_name}</b> was {formatDate(chosen.deadline)}
                  {" "}— the cut-off has passed, so students can no longer apply. Choose another open program.
                </div>
              );
            }
            if (chosen?.deadline) {
              return (
                <div className="mt-3 rounded-lg border border-[#241012]/[0.06] bg-[#FAF7F5] px-4 py-3 text-xs text-[#6B5458]">
                  Applications close on <b className="text-[#7B1113]">{formatDate(chosen.deadline)}</b> (11:59 PM) — after that date this program is automatically closed to new applications.
                </div>
              );
            }
            return null;
          })()}
        </div>

        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">CHED Application Form</h2>
          <p className="mt-1 text-[11px] text-[#6B5458]">All fields marked with * are required.</p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-[#241012]">
              Father&apos;s Full Name *
              <input
                value={form.fatherName}
                onChange={(e) => handleFormChange("fatherName", e.target.value)}
                placeholder="Juan D. Dela Cruz"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Mother&apos;s Full Name *
              <input
                value={form.motherName}
                onChange={(e) => handleFormChange("motherName", e.target.value)}
                placeholder="Maria D. Dela Cruz"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Street / Barangay *
              <input
                value={form.streetBarangay}
                onChange={(e) => handleFormChange("streetBarangay", e.target.value)}
                placeholder="e.g. Purok 6, Tibanga"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Zipcode *
              <input
                value={form.zipcode}
                onChange={(e) => handleZipChange(e.target.value)}
                inputMode="numeric"
                maxLength={4}
                pattern="\d{4}"
                placeholder="9200"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
              <span className="mt-0.5 block text-[10px] font-normal text-[#8B7376]">Digits only — exactly 4 digits (e.g. 9200).</span>
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Contact Number *
              <input
                value={form.contactNumber}
                onChange={(e) => handleContactChange(e.target.value)}
                inputMode="numeric"
                maxLength={11}
                pattern="09\d{9}"
                placeholder="09XXXXXXXXX"
                autoComplete="tel-national"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
              <span
                className={`mt-0.5 block text-[10px] font-normal ${
                  !form.contactNumber
                    ? "text-[#8B7376]"
                    : PH_PHONE_RE.test(form.contactNumber)
                      ? "text-green-700"
                      : "text-amber-700"
                }`}
              >
                {!form.contactNumber
                  ? "Philippine mobile only — exactly 11 digits starting with 09 (e.g. 09171234567)."
                  : PH_PHONE_RE.test(form.contactNumber)
                    ? "Valid PH mobile number."
                    : `Digits only · max 11 · must start with 09 (${form.contactNumber.length}/11).`}
              </span>
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Email Address *
              <input
                type="email"
                value={form.email}
                onChange={(e) => handleFormChange("email", e.target.value)}
                placeholder="you@email.com"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Disability (optional)
              <select
                value={form.disability}
                onChange={(e) => handleFormChange("disability", e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              >
                <option value="">Select disability (if any)...</option>
                {DISABILITY_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Indigenous People Group (optional)
              <select
                value={form.ipGroup}
                onChange={(e) => handleFormChange("ipGroup", e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              >
                <option value="">Select IP group (if any)...</option>
                {IP_GROUP_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Annual Family Income (PHP) *
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.annualIncome}
                onChange={(e) => handleFormChange("annualIncome", e.target.value)}
                placeholder="150000"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
              {itrIncome !== null && (
                <span className="mt-1 block text-[11px] font-medium text-[#6B5458]">
                  OCR read from ITR: <b className="text-[#7B1113]">₱{itrIncome.toLocaleString()}</b>
                </span>
              )}
              {itrMatchPct !== null && (
                <span
                  aria-live="polite"
                  className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${
                    itrMatchPct >= 90
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  OCR MATCH: {itrMatchPct.toFixed(2)}% {itrMatchPct >= 90 ? "— Match" : "— Review difference"}
                </span>
              )}
            </label>
            <label className="block text-xs font-semibold text-[#241012] sm:col-span-2">
              Income Tax Return (ITR) File * — JPG / PNG / PDF, max 10 MB
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.pdf"
                onChange={(e) => handleItrChange(e.target.files?.[0] || null)}
                required
                className="mt-1 w-full rounded-lg border border-dashed border-[#241012]/15 bg-[#FAF7F5] px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-[#7B1113] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
              />
              {ocrStatus && (
                <span className={`mt-1 block text-[11px] ${ocrBusy ? "text-amber-700" : "text-[#6B5458]"}`}>{ocrStatus}</span>
              )}
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-[#241012]">Supporting Documents &amp; Academic Records</h2>
          <p className="mt-1 text-[11px] text-[#6B5458]">
            These are no longer uploaded here. Manage them under{" "}
            <span className="font-semibold text-[#7B1113]">Profile &amp; Documents</span>: your COR, Valid ID,
            Signature Form, ITR, and academic records (SHS GWA / College GPA with proof). They stay attached to
            your account and are shown to reviewers together with this application.
          </p>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting || alreadyApplied || (!!selectedProgramId && (isDeadlinePassed(programs.find((p) => p.scholarship_id === selectedProgramId)) || programs.find((p) => p.scholarship_id === selectedProgramId)?.status !== "Open"))}
            title={(selectedProgramId && (isDeadlinePassed(programs.find((p) => p.scholarship_id === selectedProgramId)) || programs.find((p) => p.scholarship_id === selectedProgramId)?.status !== "Open")) ? "Application cut-off reached for this program" : undefined}
            className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-60"
          >
            {submitting
              ? "Submitting\u2026"
              : alreadyApplied
                ? "Already Applied"
                : selectedProgramId && isDeadlinePassed(programs.find((p) => p.scholarship_id === selectedProgramId))
                  ? "Deadline Passed"
                  : "Submit Application"}
          </button>
        </div>
      </form>

      {showSampleForm && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setShowSampleForm(false)}>
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-[#241012]">CHED Application Form — Sample Preview</h2>
                <p className="mt-1 text-xs text-[#8B7376]">All fields marked * are required. This is how your completed form will look.</p>
              </div>
              <button type="button" onClick={() => setShowSampleForm(false)} className="rounded-lg border border-[#241012]/10 px-3 py-1.5 text-xs font-bold text-[#6B5458] hover:bg-[#FAF7F5]">Close</button>
            </div>
            <div className="mt-4 space-y-3 rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5]/60 p-4 text-xs text-[#241012]">
              <p className="font-bold uppercase tracking-wide text-[#7B1113]">Section 1 — Scholarship Program</p>
              <p>Choose the open scholarship program and note the deadline.</p>
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
                <li>ITR File * — JPG / PNG / PDF, max 10 MB (OCR may auto-detect income)</li>
              </ul>
              <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 3 — Supporting Documents &amp; Academic Records</p>
              <p className="text-[#6B5458]">Managed under Profile &amp; Documents: COR, Valid ID, Signature Form, ITR, and academic records (SHS GWA / College GPA with proof).</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
