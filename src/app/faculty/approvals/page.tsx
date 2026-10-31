"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDate, downloadCsv } from "@/lib/utils";
import { STATUS_STYLES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface ApprovedScholar {
  application_id: number;
  application_status: string;
  application_date: string;
  scholarship_programs?: {
    scholarship_name: string;
  };
  student_accounts?: {
    given_name: string;
    last_name: string;
    student_number: string;
    program_name: string;
  };
  scholarship_approval?: {
    validation_status?: string;
    approval_status?: string;
  };
}

export default function FacultyApprovalsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [scholars, setScholars] = useState<ApprovedScholar[]>([]);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      setFatalError("");
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      const { data: meData, error: meErr } = await sb
        .from("users")
        .select("*")
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      if (meErr || !meData) {
        setFatalError("Account not found.");
        setLoading(false);
        return;
      }
      if (meData.role !== "Faculty") {
        setFatalError("Faculty access is required.");
        setLoading(false);
        return;
      }

      const { data, error } = await sb
        .from("scholarship_applications")
        .select(
          "*, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number, program_name), scholarship_approval(validation_status, approval_status)"
        )
        .eq("application_status", "Approved")
        .order("application_date", { ascending: false });

      if (!error) {
        setScholars(data || []);
      }
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  function exportCsv() {
    if (!scholars.length) return;
    const rows = scholars.map((s, i) => ({
      "No.": i + 1,
      "Student Number": s.student_accounts?.student_number ?? "",
      Name: `${s.student_accounts?.last_name}, ${s.student_accounts?.given_name}`,
      Program: s.student_accounts?.program_name ?? "",
      Scholarship: s.scholarship_programs?.scholarship_name ?? "",
      "Validation Status":
        s.scholarship_approval?.validation_status ?? "Pending",
      "Approval Status": s.application_status,
      "Application Date": formatDate(s.application_date),
    }));
    downloadCsv("approved-scholars.csv", rows);
  }

  if (loading) return <Spinner label="Loading approved scholars..." color="green" />;

  if (fatalError) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-sm text-center">
          <p className="text-4xl">&#128683;</p>
          <h1 className="mt-3 text-lg font-bold text-[#241012]">{fatalError}</h1>
          <Link
            href="/"
            className="mt-5 inline-block rounded-lg bg-[#7B1113] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#14532d]"
          >
            Back to home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">
            Approved Scholars List
          </h1>
          <p className="mt-1 text-xs text-[#6B5458]">
            Final list of scholarship recipients already approved.
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={scholars.length === 0}
          className="self-start rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#14532d] disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>

      {scholars.length === 0 ? (
        <EmptyState
          icon="&#127942;"
          title="No approved scholars yet"
          hint="The Administrator has not finalized any scholarship decisions."
        />
      ) : (
        <div className="space-y-3">
          {scholars.map((scholar) => (
            <div
              key={scholar.application_id}
              className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[#241012]">
                    {scholar.student_accounts?.last_name},{" "}
                    {scholar.student_accounts?.given_name}
                    <span className="ml-1 font-normal text-[#8B7376]">
                      ({scholar.student_accounts?.student_number})
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-[#7B1113]">
                    {scholar.scholarship_programs?.scholarship_name}
                  </p>
                  <p className="text-[11px] text-[#8B7376]">
                    {scholar.student_accounts?.program_name}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
                  {scholar.scholarship_approval?.validation_status && (
                    <Badge
                      className={
                        scholar.scholarship_approval.validation_status ===
                        "Validated"
                          ? "border-green-300 bg-green-100 text-green-800"
                          : "border-orange-200 bg-orange-50 text-orange-700"
                      }
                    >
                      {scholar.scholarship_approval.validation_status}
                    </Badge>
                  )}
                  <Badge className={STATUS_STYLES[scholar.application_status] || ""}>
                    {scholar.application_status}
                  </Badge>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
