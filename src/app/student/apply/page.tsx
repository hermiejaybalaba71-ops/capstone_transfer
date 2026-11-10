"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { getSupabase } from "@/lib/supabase/browser";
import { isItrResubmissionCancellation } from "@/lib/constants";
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
  const [selectedProgramIds, setSelectedProgramIds] = useState<number[]>(
    programIdParam && Number.isFinite(Number(programIdParam)) ? [Number(programIdParam)] : []
  );
  const [appliedProgramStatuses, setAppliedProgramStatuses] = useState<Record<number, string>>({});

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
    familySize: "",
  });
  const [itrFile, setItrFile] = useState<File | null>(null);
  // Students may upload either ITR page or both; OCR scans the available pages.
  const [itrFile2, setItrFile2] = useState<File | null>(null);
  const [showSampleForm, setShowSampleForm] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("error");

  /**
   * The student may attach ANY image (or PDF) as proof of income — it does not
   * have to be a readable ITR. OCR / income matching happens on the Admin
   * ranking + machine-learning side, never on the applicant side.
   */
  function handleItrChange(file: File | null) {
    setItrFile(file);
  }

  function handleItrPage2Change(file: File | null) {
    setItrFile2(file);
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
    if (!profile) return;
    let cancelled = false;
    const sb = getSupabase();
    sb.from("scholarship_applications")
      .select("scholarship_id, application_status, remarks")
      .eq("student_id", profile.studentId)
      .then(({ data }) => {
        if (cancelled) return;
        const statuses: Record<number, string> = {};
        (data || []).forEach((application) => {
          if (!isItrResubmissionCancellation(application)) {
            const scholarshipId = Number(application.scholarship_id);
            if (Number.isFinite(scholarshipId)) {
              const status = application.application_status;
              const currentStatus = statuses[scholarshipId];
              if (status !== "Not Approved" || !currentStatus) {
                statuses[scholarshipId] = status;
              }
            }
          }
        });
        setAppliedProgramStatuses(statuses);
      });
    return () => { cancelled = true; };
  }, [profile]);

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

    if (!selectedProgramIds.length) {
      setMessage("Select at least one scholarship program.");
      setMessageType("error");
      return;
    }

    const chosenPrograms = selectedProgramIds.map((id) =>
      programs.find((program) => program.scholarship_id === id)
    );
    const selectedPrograms = chosenPrograms.filter(
      (program): program is ScholarshipProgram => Boolean(program)
    );
    const unavailableProgram = chosenPrograms.find(
      (program) => program && (program.status !== "Open" || isDeadlinePassed(program))
    );
    if (chosenPrograms.some((program) => !program) || unavailableProgram) {
      setMessage(
        unavailableProgram
          ? `"${unavailableProgram.scholarship_name}" is no longer accepting applications. Remove it and try again.`
          : "A selected scholarship is no longer available. Refresh and try again."
      );
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

    // Household size drives the per-capita income the model learns from
    // (the historical label is a per-capita income decile), so it is required.
    const familySize = Number(form.familySize);
    if (!Number.isInteger(familySize) || familySize < 1 || familySize > 20) {
      setMessage("Family Size must be a whole number from 1 to 20 (number of people in the household).");
      setMessageType("error");
      return;
    }
    if (!(Number(form.annualIncome) >= 0)) {
      setMessage("Annual Family Income must be zero or more.");
      setMessageType("error");
      return;
    }

    if (!itrFile && !itrFile2) {
      setMessage("Please attach at least one ITR page.");
      setMessageType("error");
      return;
    }

    const fileErr =
      (itrFile ? validateFile(itrFile) : "") ||
      (itrFile2 ? validateFile(itrFile2) : "");
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
        .select("application_id, scholarship_id, application_status, remarks")
        .eq("student_id", profile.studentId)
        .in("scholarship_id", selectedProgramIds);

      if (existingApp.error) {
        setMessage(`Could not check existing applications: ${existingApp.error.message}`);
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const blockingApplications = (existingApp.data || []).filter(
        (application) =>
          !isItrResubmissionCancellation(application) &&
          application.application_status !== "Not Approved"
      );
      if (blockingApplications.length) {
        const blockedNames = blockingApplications
          .map((application) => programs.find((p) => p.scholarship_id === application.scholarship_id)?.scholarship_name)
          .filter(Boolean);
        setMessage(
          blockedNames.length
            ? `You already applied to: ${blockedNames.join(", ")}. Remove those programs and submit the others.`
            : "You already applied to one or more selected programs. Remove them and submit the others."
        );
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

      if (hasApproved.error) {
        setMessage(`Could not check approved applications: ${hasApproved.error.message}`);
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      if ((hasApproved.data || []).length > 0) {
        setMessage("You already have an approved scholarship. Applications are closed for you.");
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      // The "itr-documents" bucket has no usable RLS insert policy, so we ask
      // our own API route for a one-time signed upload URL (signed with the
      // service-role key) and send the file straight to Supabase Storage.
      // Each submitted ITR page gets its own signed URL + object. Page 2 is optional.
      const { data: sessionData } = await sb.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setMessage("Session expired. Please log in again.");
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      async function uploadItrPage(file: File, label: string): Promise<string> {
        const signRes = await fetch("/api/student/upload-itr", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            file_name: file.name,
            content_type: file.type,
            size: file.size,
          }),
        });
        const signed = (await signRes.json().catch(() => null)) as {
          ok?: boolean;
          path?: string;
          token?: string;
          error?: string;
        } | null;

        if (!signRes.ok || !signed?.ok || !signed.path || !signed.token) {
          throw new Error(
            `ITR ${label} upload failed: ${signed?.error || "Could not prepare the upload."}`
          );
        }

        const up = await sb.storage.from("itr-documents").uploadToSignedUrl(signed.path, signed.token, file, {
          contentType: file.type || "application/octet-stream",
        });
        if (up.error) {
          throw new Error(`ITR ${label} upload failed: ${up.error.message}`);
        }
        return signed.path;
      }

      let itrPath = "";
      let itrPath2 = "";
      try {
        if (itrFile) {
          itrPath = await uploadItrPage(itrFile, "Page 1");
        }
        if (itrFile2) {
          itrPath2 = await uploadItrPage(itrFile2, "Page 2");
        }
      } catch (upErr) {
        for (const uploadedPath of [itrPath, itrPath2]) {
          if (!uploadedPath) continue;
          await fetch("/api/student/upload-itr", {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ path: uploadedPath }),
          }).catch(() => null);
        }
        setMessage(upErr instanceof Error ? upErr.message : "ITR upload failed.");
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const { data: appRows, error: appErr } = await sb
        .from("scholarship_applications")
        .insert(selectedPrograms.map((program) => ({
          student_id: profile.studentId,
          scholarship_id: program.scholarship_id,
          application_data: {
            annual_income_family: Number(form.annualIncome) || 0,
            family_size: familySize,
            itr_file: itrPath || null,
            itr_file_p2: itrPath2 || null,
          },
        })))
        .select("application_id, scholarship_id");

      if (appErr) {
        // Best-effort cleanup — only this student's own folder can be deleted.
        for (const uploadedPath of [itrPath, itrPath2]) {
          if (!uploadedPath) continue;
          await fetch("/api/student/upload-itr", {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ path: uploadedPath }),
          }).catch(() => null);
        }
        setMessage(`Application failed: ${appErr.message}`);
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const { error: chedErr } = await sb.from("ched_form_input").insert(
        (appRows || []).map((appRow) => ({
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
          income_tax_return: itrPath || null,
          annual_income_family: Number(form.annualIncome) || 0,
        }))
      );

      if (chedErr) {
        setMessage(`Application saved but CHED form data failed: ${chedErr.message}`);
        setMessageType("error");
        setSubmitting(false);
        return;
      }

      const { error: notificationError } = await sb.from("notifications_announcements").insert(selectedPrograms.map((selectedProgram) => ({
        student_id: profile.studentId,
        title: "Scholarship Application Submitted",
        message: `Your application for "${selectedProgram?.scholarship_name || "scholarship"}" has been submitted and is currently under review. You will be notified once a decision has been made.`,
        notification_type: "Status Update",
        status: "Unread",
      })));
      if (notificationError) {
        console.error("Could not create application notifications:", notificationError.message);
      }

      setMessage(
        `${appRows?.length || selectedPrograms.length} scholarship application(s) submitted. Upload your supporting documents and academic records under Profile & Documents, and track each application in Application Status.`
      );
      setMessageType("success");
      toast.success(`${appRows?.length || selectedPrograms.length} scholarship application(s) submitted!`);
      setAppliedProgramStatuses((current) => ({
        ...current,
        ...Object.fromEntries(selectedPrograms.map((program) => [program.scholarship_id, "Pending"])),
      }));

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
        familySize: "",
      });
      setSelectedProgramIds([]);
      setItrFile(null);
      setItrFile2(null);
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
          <p className="mt-1 text-xs text-[#6B5458]">Select one or more available scholarships and submit one application per selected program. Upload supporting documents and academic records under Profile &amp; Documents.</p>
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

      <form onSubmit={handleSubmit} className="mt-4 space-y-5">
        <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-[#241012]">Scholarship Programs</h2>
              <p className="mt-1 text-[11px] text-[#6B5458]">
                Choose one or more programs. Each selected program gets its own application.
              </p>
            </div>
          </div>
          <details className="group relative mt-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-[#241012]/15 bg-white px-3 py-2.5 text-xs text-[#241012] outline-none focus:border-[#7B1113] [&::-webkit-details-marker]:hidden">
              <span className="truncate">
                {selectedProgramIds.length
                  ? `${selectedProgramIds.length} scholarship program${selectedProgramIds.length === 1 ? "" : "s"} selected`
                  : "Choose available scholarship programs..."}
              </span>
              <span aria-hidden="true" className="shrink-0 text-[#6B5458] transition group-open:rotate-180">▼</span>
            </summary>
            <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-[#241012]/15 bg-white p-3 shadow-xl">
              <div className="mb-2 flex justify-end gap-2 border-b border-[#241012]/10 pb-2">
                <button
                  type="button"
                  onClick={() => setSelectedProgramIds(
                    programs
                      .filter((program) =>
                        program.status === "Open" &&
                        !isDeadlinePassed(program) &&
                        (!appliedProgramStatuses[program.scholarship_id] ||
                          appliedProgramStatuses[program.scholarship_id] === "Not Approved")
                      )
                      .map((program) => program.scholarship_id)
                  )}
                  className="rounded-md border border-[#7B1113]/30 px-2.5 py-1 text-[10px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                >
                  Select all available
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedProgramIds([])}
                  className="rounded-md border border-[#241012]/15 px-2.5 py-1 text-[10px] font-bold text-[#6B5458] hover:bg-[#FAF7F5]"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {programs.map((program) => {
                  const closed = program.status !== "Open" || isDeadlinePassed(program);
                  const appliedStatus = appliedProgramStatuses[program.scholarship_id];
                  const canReapply = appliedStatus === "Not Approved";
                  const blockedByExistingApplication = Boolean(appliedStatus) && !canReapply;
                  const checked = selectedProgramIds.includes(program.scholarship_id);
                  return (
                    <label
                      key={program.scholarship_id}
                      className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-[#FAF7F5] ${
                        closed || blockedByExistingApplication ? "opacity-60" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={closed || blockedByExistingApplication}
                        onChange={(event) => {
                          setSelectedProgramIds((current) =>
                            event.target.checked
                              ? [...new Set([...current, program.scholarship_id])]
                              : current.filter((id) => id !== program.scholarship_id)
                          );
                        }}
                        className="mt-0.5 accent-[#7B1113]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-[#241012]">{program.scholarship_name}</span>
                        <span className="mt-0.5 block text-[10px] text-[#6B5458]">
                          {canReapply
                            ? "Not approved — you may apply again"
                            : appliedStatus
                            ? `Already applied (${appliedStatus})`
                            : closed
                              ? isDeadlinePassed(program)
                                ? `Closed — deadline was ${formatDate(program.deadline)}`
                                : "Closed to applications"
                              : program.deadline
                                ? `Open — deadline: ${formatDate(program.deadline)}`
                                : "Open"}
                        </span>
                      </span>
                    </label>
                  );
                })}
                {!programs.length && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">There are no open scholarship programs right now.</p>
                )}
              </div>
            </div>
          </details>
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
            </label>
            <label className="block text-xs font-semibold text-[#241012]">
              Family Size (household members) *
              <input
                type="number"
                min="1"
                max="20"
                step="1"
                value={form.familySize}
                onChange={(e) => handleFormChange("familySize", e.target.value)}
                placeholder="4"
                required
                className="mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]"
              />
              <span className="mt-1 block text-[11px] text-[#6B5458]">
                Number of people supported by this income (used for per-capita income).
              </span>
            </label>
            <label className="block text-xs font-semibold text-[#241012] sm:col-span-2">
              ITR Page 1 (optional) — front page (JPG, PNG, HEIC, screenshot) or PDF, max 10 MB
              <input
                type="file"
                accept="image/*,.pdf,application/pdf"
                onChange={(e) => handleItrChange(e.target.files?.[0] || null)}
                className="mt-1 w-full rounded-lg border border-dashed border-[#241012]/15 bg-[#FAF7F5] px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-[#7B1113] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
              />
              <span className="mt-1 block text-[11px] text-[#6B5458]">
                {itrFile ? `Attached: ${itrFile.name}` : "Upload Page 1, Page 2, or both pages."}
              </span>
            </label>
            <label className="block text-xs font-semibold text-[#241012] sm:col-span-2">
              ITR Page 2 (optional) — back page with the income figures (JPG, PNG, HEIC, screenshot) or PDF, max 10 MB
              <input
                type="file"
                accept="image/*,.pdf,application/pdf"
                onChange={(e) => handleItrPage2Change(e.target.files?.[0] || null)}
                className="mt-1 w-full rounded-lg border border-dashed border-[#241012]/15 bg-[#FAF7F5] px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-[#7B1113] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
              />
              <span className="mt-1 block text-[11px] text-[#6B5458]">
                {itrFile2
                  ? `Attached: ${itrFile2.name}`
                  : "Upload at least one page. Both pages may help OCR find the income; unreadable OCR falls back to declared income."}
              </span>
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
            disabled={submitting || selectedProgramIds.length === 0}
            className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-60"
          >
            {submitting
              ? "Submitting applications\u2026"
              : `Submit ${selectedProgramIds.length || ""} Application${selectedProgramIds.length === 1 ? "" : "s"}`}
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
