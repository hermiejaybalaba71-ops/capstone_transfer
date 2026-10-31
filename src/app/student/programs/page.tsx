"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDate } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { getProgramRequirementDocs } from "@/lib/constants";

interface ScholarshipProgram {
  scholarship_id: number;
  scholarship_name: string;
  description?: string;
  requirements?: string;
  deadline?: string;
  status?: string;
}

interface StudentApplication {
  scholarship_id: number;
  application_status: string;
}

export default function BrowseProgramsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [programs, setPrograms] = useState<ScholarshipProgram[]>([]);
  const [applications, setApplications] = useState<StudentApplication[]>([]);
  const [hasApprovedApplication, setHasApprovedApplication] = useState(false);
  const [showSampleForm, setShowSampleForm] = useState(false);

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
      const uid = authUser.user?.id;
      if (uid) {
        const userQ = await sb.from("users").select("user_id").eq("auth_user_id", uid).maybeSingle();
        if (userQ.data) {
          const studentQ = await sb.from("student_accounts").select("student_id").eq("user_id", userQ.data.user_id).maybeSingle();
          if (studentQ.data) {
            const approvedQ = await sb.from("scholarship_applications").select("application_id").eq("student_id", studentQ.data.student_id).eq("application_status", "Approved").maybeSingle();
            if (approvedQ.data) setHasApprovedApplication(true);
            const appsQ = await sb
              .from("scholarship_applications")
              .select("scholarship_id, application_status")
              .eq("student_id", studentQ.data.student_id);
            if (!appsQ.error) setApplications(appsQ.data || []);
          }
        }
      }

      const { data, error } = await sb
        .from("scholarship_programs")
        .select("*")
        .eq("status", "Open")
        .order("created_at", { ascending: false });

      if (!error && data) {
        setPrograms(data);
      }

      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  if (loading) {
    return <Spinner label="Loading programs..." />;
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Browse Available Programs</h1>
          <p className="mt-1 text-xs text-[#6B5458]">Check the open scholarships below and apply to the one that fits you.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowSampleForm(true)}
          className="shrink-0 rounded-lg border border-[#7B1113]/30 px-3 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
        >
          View Form Sample
        </button>
      </div>

      {hasApprovedApplication && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800 shadow-sm">
          You already have an approved scholarship application. Applications are closed for you.
        </div>
      )}

      {programs.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon="🎓"
            title="No open scholarships right now"
            hint="Check back later — new programs appear here automatically."
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {programs.map((program) => {
            const applied = applications.find((a) => a.scholarship_id === program.scholarship_id);
            const isLocked = hasApprovedApplication || !!applied;
            return (
              <article
                key={program.scholarship_id}
                className="flex flex-col rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <h3 className="text-sm font-bold text-[#7B1113]">
                  {program.scholarship_name}
                </h3>
                <p className="mt-2 line-clamp-3 flex-1 text-xs leading-relaxed text-[#6B5458]">
                  {program.description || "No description provided."}
                </p>
                {applied && (
                  <p className="mt-2 inline-flex self-start items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-[10px] font-bold text-green-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
                    Already applied for this scholarship
                  </p>
                )}
                {getProgramRequirementDocs(program.requirements).length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-semibold text-[#241012]">Requirements:</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {getProgramRequirementDocs(program.requirements).map((r) => (
                        <span key={r} className="rounded-full bg-[#7B1113]/5 px-2 py-0.5 text-[10px] font-semibold text-[#7B1113]">{r}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-3 space-y-1 text-[11px] text-[#6B5458]">
                  <p>
                    Deadline:{" "}
                    <span className="font-semibold text-[#241012]">
                      {formatDate(program.deadline)}
                    </span>
                  </p>
                  {applied && (
                    <p>
                      Application status:{" "}
                      <span className="font-semibold text-[#7B1113]">
                        {applied.application_status}
                      </span>
                    </p>
                  )}
                </div>
                <Link
                  href={`/student/apply?programId=${program.scholarship_id}`}
                  className={`mt-4 inline-block rounded-lg px-4 py-2.5 text-center text-xs font-bold text-white ${
                    isLocked
                      ? "cursor-not-allowed bg-gray-400"
                      : "bg-[#7B1113] hover:bg-[#540111]"
                  }`}
                  onClick={isLocked ? (e) => e.preventDefault() : undefined}
                >
                  {applied ? "Already Applied" : hasApprovedApplication ? "Applications Closed" : "Apply Now"}
                </Link>
              </article>
            );
          })}
        </div>
      )}

      {showSampleForm && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setShowSampleForm(false)}>
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-[#241012]">CHED Application Form — Sample Preview</h2>
                <p className="mt-1 text-xs text-[#8B7376]">This is how the form looks when you apply. All fields marked * are required.</p>
              </div>
              <button type="button" onClick={() => setShowSampleForm(false)} className="rounded-lg border border-[#241012]/10 px-3 py-1.5 text-xs font-bold text-[#6B5458] hover:bg-[#FAF7F5]">Close</button>
            </div>
            <div className="mt-4 space-y-3 rounded-xl border border-[#241012]/[0.06] bg-[#FAF7F5]/60 p-4 text-xs text-[#241012]">
              <p className="font-bold uppercase tracking-wide text-[#7B1113]">Section 1 — Scholarship Program</p>
              <p>Dropdown to choose the open scholarship program and deadline.</p>
              <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 2 — CHED Application Form</p>
              <ul className="list-inside list-disc space-y-1 text-[#6B5458]">
                <li>Father&apos;s Full Name *</li>
                <li>Mother&apos;s Full Name *</li>
                <li>Street / Barangay *</li>
                <li>Zipcode *</li>
                <li>Contact Number *</li>
                <li>Email Address *</li>
                <li>Disability / Indigenous People Group (optional)</li>
                <li>Annual Family Income (PHP) *</li>
                <li>Income Tax Return (ITR) File * — JPG / PNG / PDF, max 10 MB (OCR may auto-detect income)</li>
              </ul>
              <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 3 — Supporting Documents</p>
              <p className="text-[#6B5458]">Upload clear scans of each required document for your chosen program (JPG, PNG, or PDF, max 10 MB).</p>
              <p className="mt-3 font-bold uppercase tracking-wide text-[#7B1113]">Section 4 — Academic Records</p>
              <ul className="list-inside list-disc space-y-1 text-[#6B5458]">
                <li>Applicant Type * (Freshman / Alumni)</li>
                <li>SHS GWA or College GPA * (1–100)</li>
                <li>Proof File *</li>
              </ul>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => { setShowSampleForm(false); router.push("/student/apply"); }}
                className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111]"
              >
                Go to Apply Form
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
