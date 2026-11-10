"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime, validateFile } from "@/lib/utils";
import { STATUS_STYLES, isItrResubmissionCancellation } from "@/lib/constants";
import { DISABILITY_OPTIONS, IP_GROUP_OPTIONS } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import toast from "react-hot-toast";

interface ScholarshipApplication {
  application_id: number;
  student_id: number;
  scholarship_id: number;
  application_date: string;
  application_status: string;
  remarks?: string;
  application_data?: { itr_file?: string | null; itr_file_p2?: string | null } | null;
  ched_form_input?: StudentApplicationForm | null;
  scholarship_programs?: { scholarship_name: string };
}

interface StudentApplicationForm {
  father_name: string;
  mother_name: string;
  street_barangay: string;
  zipcode: string;
  disability: string | null;
  indigenous_people_group: string | null;
  contact_number: string;
  email_address: string;
  annual_income_family: number;
  income_tax_return?: string | null;
}

type EditableApplicationForm = {
  father_name: string;
  mother_name: string;
  street_barangay: string;
  zipcode: string;
  disability: string;
  indigenous_people_group: string;
  contact_number: string;
  email_address: string;
  annual_income_family: string;
};

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
  const [itrFiles, setItrFiles] = useState<Record<number, { page1: File | null; page2: File | null }>>({});
  const [savingItrApplicationId, setSavingItrApplicationId] = useState<number | null>(null);
  const [itrInputResetKey, setItrInputResetKey] = useState(0);
  const [editingApplicationId, setEditingApplicationId] = useState<number | null>(null);
  const [applicationEdits, setApplicationEdits] = useState<Record<number, EditableApplicationForm>>({});

  function startEditingApplication(application: ScholarshipApplication) {
    const form = application.ched_form_input;
    if (!form) {
      toast.error("The submitted application details could not be loaded. Please refresh and try again.");
      return;
    }
    setApplicationEdits((current) => ({
      ...current,
      [application.application_id]: {
        father_name: form.father_name || "",
        mother_name: form.mother_name || "",
        street_barangay: form.street_barangay || "",
        zipcode: form.zipcode || "",
        disability: form.disability || "",
        indigenous_people_group: form.indigenous_people_group || "",
        contact_number: form.contact_number || "",
        email_address: form.email_address || "",
        annual_income_family: String(form.annual_income_family ?? ""),
      },
    }));
    setEditingApplicationId(application.application_id);
  }

  function updateApplicationField(
    applicationId: number,
    field: keyof EditableApplicationForm,
    value: string
  ) {
    setApplicationEdits((current) => ({
      ...current,
      [applicationId]: { ...current[applicationId], [field]: value },
    }));
  }

  function setItrFile(applicationId: number, page: "page1" | "page2", file: File | null) {
    setItrFiles((current) => ({
      ...current,
      [applicationId]: {
        page1: current[applicationId]?.page1 ?? null,
        page2: current[applicationId]?.page2 ?? null,
        [page]: file,
      },
    }));
  }

    function displayItrFilename(path?: string | null) {
      if (!path) return null;
      const name = path.split("/").pop() || path;
      try {
        return decodeURIComponent(name).replace(/^\d+_/, "");
      } catch {
        return name.replace(/^\d+_/, "");
      }
    }

    async function removeStoredItr(application: ScholarshipApplication, page: "itr_file" | "itr_file_p2") {
      if (!application.application_data?.[page]) return;
      setSavingItrApplicationId(application.application_id);
      try {
        const sb = getSupabase();
        const { data: sessionData } = await sb.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) throw new Error("Session expired. Please log in again.");

        const response = await fetch("/api/student/upload-itr", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            application_id: application.application_id,
            page,
          }),
        });
        const result = (await response.json().catch(() => null)) as {
          ok?: boolean;
          application_data?: ScholarshipApplication["application_data"];
          removed_path?: string;
          removed_application_ids?: number[];
          cleanup_warning?: string | null;
          error?: string;
        } | null;
        if (!response.ok || !result?.ok || !result.application_data) {
          throw new Error(result?.error || "Could not remove the ITR page.");
        }

        const removedPath = result.removed_path;
        const removedApplicationIds = new Set(result.removed_application_ids ?? [application.application_id]);
        setApplications((current) => current.map((item) => {
          if (!removedApplicationIds.has(item.application_id)) return item;
          const currentData = item.application_data ?? {};
          return {
            ...item,
            application_data: removedPath
              ? {
                  ...currentData,
                  itr_file: currentData.itr_file === removedPath ? null : currentData.itr_file,
                  itr_file_p2: currentData.itr_file_p2 === removedPath ? null : currentData.itr_file_p2,
                }
              : item.application_id === application.application_id
                ? result.application_data
                : item.application_data,
            ched_form_input: item.ched_form_input
              ? {
                  ...item.ched_form_input,
                  income_tax_return: item.ched_form_input.income_tax_return === removedPath
                    ? null
                    : item.ched_form_input.income_tax_return,
                }
              : item.ched_form_input,
          };
        }));
        if (result.cleanup_warning) toast.error(result.cleanup_warning);
        else toast.success("ITR file removed from all your applications and storage.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not remove the ITR page.");
      } finally {
        setSavingItrApplicationId(null);
      }
    }

  async function saveApplicationChanges(application: ScholarshipApplication) {
    const selected = itrFiles[application.application_id];
    const page1 = selected?.page1 ?? null;
    const page2 = selected?.page2 ?? null;
    const form = applicationEdits[application.application_id];
    if (!form) {
      toast.error("Application details are not loaded.");
      return;
    }

    const fileError = (page1 && validateFile(page1)) || (page2 && validateFile(page2));
    if (fileError) {
      toast.error(fileError);
      return;
    }

    if (!form.father_name.trim() || !form.mother_name.trim() || /\d/.test(form.father_name) || /\d/.test(form.mother_name)) {
      toast.error("Enter both parents' names without numbers.");
      return;
    }
    if (!form.street_barangay.trim()) {
      toast.error("Street / Barangay is required.");
      return;
    }
    if (!/^\d{4}$/.test(form.zipcode)) {
      toast.error("Zipcode must contain exactly 4 digits.");
      return;
    }
    if (!/^09\d{9}$/.test(form.contact_number.replace(/\D/g, ""))) {
      toast.error("Enter a valid Philippine mobile number (09XXXXXXXXX).");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email_address.trim())) {
      toast.error("Enter a valid email address.");
      return;
    }
    const annualIncome = Number(form.annual_income_family);
    if (!form.annual_income_family || !Number.isFinite(annualIncome) || annualIncome < 0) {
      toast.error("Enter a valid annual family income.");
      return;
    }

    setSavingItrApplicationId(application.application_id);
    const sb = getSupabase();
    const { data: sessionData } = await sb.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      toast.error("Session expired. Please log in again.");
      setSavingItrApplicationId(null);
      return;
    }

    const uploadedPaths: string[] = [];
    async function cleanUpUploads() {
      await Promise.all(uploadedPaths.map((path) =>
        fetch("/api/student/upload-itr", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ path }),
        }).catch(() => null)
      ));
    }

    async function uploadPage(file: File, label: string) {
      const signResponse = await fetch("/api/student/upload-itr", {
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
      const signed = (await signResponse.json().catch(() => null)) as {
        ok?: boolean;
        path?: string;
        token?: string;
        error?: string;
      } | null;
      if (!signResponse.ok || !signed?.ok || !signed.path || !signed.token) {
        throw new Error(signed?.error || `Could not prepare ITR ${label} upload.`);
      }

      const { error } = await sb.storage
        .from("itr-documents")
        .uploadToSignedUrl(signed.path, signed.token, file, {
          contentType: file.type || "application/octet-stream",
        });
      if (error) throw new Error(`ITR ${label} upload failed: ${error.message}`);
      uploadedPaths.push(signed.path);
      return signed.path;
    }

    try {
      let itrPath: string | undefined;
      let itrPath2: string | undefined;
      try {
        if (page1) itrPath = await uploadPage(page1, "1");
        if (page2) itrPath2 = await uploadPage(page2, "2");
      } catch (error) {
        await cleanUpUploads();
        throw error;
      }

      const updateResponse = await fetch("/api/student/upload-itr", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          application_id: application.application_id,
          form: {
            ...form,
            annual_income_family: annualIncome,
          },
          ...(itrPath ? { itr_file: itrPath } : {}),
          ...(itrPath2 ? { itr_file_p2: itrPath2 } : {}),
        }),
      });
      const update = (await updateResponse.json().catch(() => null)) as {
        ok?: boolean;
        application_data?: ScholarshipApplication["application_data"];
        error?: string;
        cleanup_warning?: string | null;
      } | null;
      if (!updateResponse.ok || !update?.ok || !update.application_data) {
        await cleanUpUploads();
        throw new Error(update?.error || "Could not save your ITR update.");
      }

      setApplications((current) => current.map((item) =>
        item.application_id === application.application_id
          ? {
              ...item,
              application_data: update.application_data,
              ched_form_input: {
                ...form,
                annual_income_family: annualIncome,
              },
            }
          : item
      ));
      setItrFiles((current) => {
        const next = { ...current };
        delete next[application.application_id];
        return next;
      });
      setEditingApplicationId(null);
      setItrInputResetKey((current) => current + 1);
      if (update.cleanup_warning) {
        toast.success("Your ITR upload has been updated.");
        toast.error(update.cleanup_warning);
      } else {
        toast.success("Your ITR upload has been updated and unused old files were removed.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The ITR update failed.");
    } finally {
      setSavingItrApplicationId(null);
    }
  }

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
      const { data: formData, error: formError } = appIds.length
        ? await sb
            .from("ched_form_input")
            .select("application_id, father_name, mother_name, street_barangay, zipcode, disability, indigenous_people_group, contact_number, email_address, annual_income_family")
            .in("application_id", appIds)
        : { data: [], error: null };
      const { data: apprData } = appIds.length > 0
        ? await sb
            .from("scholarship_approval")
            .select("application_id, approval_status, validation_status")
            .in("application_id", appIds)
        : { data: [] };

      if (!error && data) {
        const formsByApplication = new Map(
          (formData || []).map((form) => [form.application_id, form as StudentApplicationForm & { application_id: number }])
        );
        setApplications(data.map((application) => ({
          ...application,
          ched_form_input: formsByApplication.get(application.application_id) || null,
        })));
      } else if (error) {
        toast.error(`Could not load applications: ${error.message}`);
      }
      if (formError) {
        toast.error(`Could not load submitted application details: ${formError.message}`);
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
                  <span className="font-semibold">Remarks:</span>{" "}
                  {isItrResubmissionCancellation(app)
                    ? "This application was cancelled so you can submit a new application with both genuine ITR pages."
                    : app.remarks}
                </p>
              )}

              {app.application_status === "Not Approved" && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                  <p className="text-[11px] text-amber-900">
                    You may submit a new application for this scholarship if it is still open.
                  </p>
                  <button
                    type="button"
                    onClick={() => router.push("/student/apply")}
                    className="rounded-lg bg-[#7B1113] px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-[#5F0D0F]"
                  >
                    Apply again
                  </button>
                </div>
              )}

              {app.application_status !== "Approved" && !isItrResubmissionCancellation(app) && (
                <>
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => startEditingApplication(app)}
                      disabled={!app.ched_form_input || savingItrApplicationId !== null}
                      className="rounded-lg border border-[#7B1113]/30 px-3 py-2 text-[11px] font-semibold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
                    >
                      Edit application
                    </button>
                  </div>
                  {editingApplicationId === app.application_id && (
                    <div
                      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8"
                      onClick={() => savingItrApplicationId === null && setEditingApplicationId(null)}
                    >
                      <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={`edit-application-title-${app.application_id}`}
                        className="my-auto w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <h2 id={`edit-application-title-${app.application_id}`} className="text-base font-bold text-[#241012]">
                              Edit submitted application
                            </h2>
                            <p className="mt-1 text-[11px] text-[#6B5458]">
                              Update the form and ITR pages for {app.scholarship_programs?.scholarship_name || "this scholarship"}.
                            </p>
                          </div>
                          <button
                            type="button"
                            aria-label="Close edit application dialog"
                            onClick={() => setEditingApplicationId(null)}
                            disabled={savingItrApplicationId !== null}
                            className="rounded-full px-2 py-1 text-xl leading-none text-[#6B5458] hover:bg-[#FAF7F5] disabled:opacity-50"
                          >
                            ×
                          </button>
                        </div>
                      {(() => {
                        const form = applicationEdits[app.application_id];
                        if (!form) return null;
                        const fieldClass = "mt-1 w-full rounded-lg border border-[#241012]/15 bg-white px-3 py-2 text-xs outline-none focus:border-[#7B1113]";
                        return (
                          <>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Father&apos;s Full Name *
                                <input value={form.father_name} onChange={(event) => updateApplicationField(app.application_id, "father_name", event.target.value)} className={fieldClass} required />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Mother&apos;s Full Name *
                                <input value={form.mother_name} onChange={(event) => updateApplicationField(app.application_id, "mother_name", event.target.value)} className={fieldClass} required />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Street / Barangay *
                                <input value={form.street_barangay} onChange={(event) => updateApplicationField(app.application_id, "street_barangay", event.target.value)} className={fieldClass} required />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Zipcode *
                                <input value={form.zipcode} onChange={(event) => updateApplicationField(app.application_id, "zipcode", event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" maxLength={4} className={fieldClass} required />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Contact Number *
                                <input value={form.contact_number} onChange={(event) => updateApplicationField(app.application_id, "contact_number", event.target.value.replace(/\D/g, "").slice(0, 11))} inputMode="numeric" maxLength={11} className={fieldClass} required />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Email Address *
                                <input type="email" value={form.email_address} onChange={(event) => updateApplicationField(app.application_id, "email_address", event.target.value)} className={fieldClass} required />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Annual Family Income (PHP) *
                                <input type="number" min="0" step="0.01" value={form.annual_income_family} onChange={(event) => updateApplicationField(app.application_id, "annual_income_family", event.target.value)} className={fieldClass} required />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                Disability (optional)
                                <select value={form.disability} onChange={(event) => updateApplicationField(app.application_id, "disability", event.target.value)} className={fieldClass}>
                                  <option value="">Select disability (if any)...</option>
                                  {DISABILITY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                                </select>
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458] sm:col-span-2">
                                Indigenous People Group (optional)
                                <select value={form.indigenous_people_group} onChange={(event) => updateApplicationField(app.application_id, "indigenous_people_group", event.target.value)} className={fieldClass}>
                                  <option value="">Select IP group (if any)...</option>
                                  {IP_GROUP_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                                </select>
                              </label>
                            </div>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                ITR 1
                                {app.application_data?.itr_file && (
                                  <span className="mt-1 flex items-center justify-between gap-2 rounded-md border border-[#241012]/10 bg-white px-2 py-1.5 font-normal">
                                    <span className="truncate" title={displayItrFilename(app.application_data.itr_file) || ""}>
                                      {displayItrFilename(app.application_data.itr_file)}
                                    </span>
                                    <button
                                      type="button"
                                      aria-label="Remove uploaded ITR 1"
                                      title="Remove ITR 1"
                                      onClick={() => void removeStoredItr(app, "itr_file")}
                                      disabled={savingItrApplicationId !== null}
                                      className="shrink-0 rounded-full px-2 text-base font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                                    >
                                      ×
                                    </button>
                                  </span>
                                )}
                                {itrFiles[app.application_id]?.page1 && (
                                  <span className="mt-1 flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 font-normal">
                                    <span className="truncate">{itrFiles[app.application_id].page1?.name}</span>
                                    <button
                                      type="button"
                                      aria-label="Clear selected ITR 1 file"
                                      onClick={() => {
                                        setItrFile(app.application_id, "page1", null);
                                        setItrInputResetKey((current) => current + 1);
                                      }}
                                      className="shrink-0 rounded-full px-2 text-base font-bold text-red-700 hover:bg-red-50"
                                    >
                                      ×
                                    </button>
                                  </span>
                                )}
                                <input
                                  key={`itr1-${app.application_id}-${itrInputResetKey}`}
                                  type="file"
                                  accept="image/*,application/pdf"
                                  disabled={savingItrApplicationId !== null}
                                  onChange={(event) => setItrFile(app.application_id, "page1", event.currentTarget.files?.[0] ?? null)}
                                  className={`${fieldClass} file:mr-2 file:rounded-md file:border-0 file:bg-[#7B1113]/10 file:px-3 file:py-1.5 file:text-[11px] file:font-semibold file:text-[#7B1113]`}
                                />
                              </label>
                              <label className="block text-[11px] font-medium text-[#6B5458]">
                                ITR 2
                                {app.application_data?.itr_file_p2 && (
                                  <span className="mt-1 flex items-center justify-between gap-2 rounded-md border border-[#241012]/10 bg-white px-2 py-1.5 font-normal">
                                    <span className="truncate" title={displayItrFilename(app.application_data.itr_file_p2) || ""}>
                                      {displayItrFilename(app.application_data.itr_file_p2)}
                                    </span>
                                    <button
                                      type="button"
                                      aria-label="Remove uploaded ITR 2"
                                      title="Remove ITR 2"
                                      onClick={() => void removeStoredItr(app, "itr_file_p2")}
                                      disabled={savingItrApplicationId !== null}
                                      className="shrink-0 rounded-full px-2 text-base font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
                                    >
                                      ×
                                    </button>
                                  </span>
                                )}
                                {itrFiles[app.application_id]?.page2 && (
                                  <span className="mt-1 flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 font-normal">
                                    <span className="truncate">{itrFiles[app.application_id].page2?.name}</span>
                                    <button
                                      type="button"
                                      aria-label="Clear selected ITR 2 file"
                                      onClick={() => {
                                        setItrFile(app.application_id, "page2", null);
                                        setItrInputResetKey((current) => current + 1);
                                      }}
                                      className="shrink-0 rounded-full px-2 text-base font-bold text-red-700 hover:bg-red-50"
                                    >
                                      ×
                                    </button>
                                  </span>
                                )}
                                <input
                                  key={`itr2-${app.application_id}-${itrInputResetKey}`}
                                  type="file"
                                  accept="image/*,application/pdf"
                                  disabled={savingItrApplicationId !== null}
                                  onChange={(event) => setItrFile(app.application_id, "page2", event.currentTarget.files?.[0] ?? null)}
                                  className={`${fieldClass} file:mr-2 file:rounded-md file:border-0 file:bg-[#7B1113]/10 file:px-3 file:py-1.5 file:text-[11px] file:font-semibold file:text-[#7B1113]`}
                                />
                              </label>
                            </div>
                          </>
                        );
                      })()}
                      <div className="mt-4 flex flex-wrap gap-2 border-t border-[#241012]/10 pt-3">
                        <button
                          type="button"
                          onClick={() => void saveApplicationChanges(app)}
                          disabled={savingItrApplicationId !== null}
                          className="rounded-lg bg-[#7B1113] px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-[#5F0D0F] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {savingItrApplicationId === app.application_id ? "Saving..." : "Save all changes"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingApplicationId(null);
                            setApplicationEdits((current) => {
                              const next = { ...current };
                              delete next[app.application_id];
                              return next;
                            });
                            setItrFiles((current) => {
                              const next = { ...current };
                              delete next[app.application_id];
                              return next;
                            });
                          }}
                          disabled={savingItrApplicationId !== null}
                          className="rounded-lg border border-[#241012]/15 px-3 py-2 text-[11px] font-semibold text-[#6B5458] disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                      </div>
                    </div>
                  )}
                </>
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
