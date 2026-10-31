"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

interface Clause {
  number: string;
  title: string;
  body: string[];
}

const CLAUSES: Clause[] = [
  {
    number: "01",
    title: "Acceptance of these Terms",
    body: [
      "These Terms and Conditions govern the use of the ISEWM Scholarship System of St. Peter's College, Iligan City — covering student registration, scholarship applications, automated ranking, approvals, and student monitoring.",
      "By creating an account, checking the agreement box during registration, or signing in, you confirm that you have read, understood, and agreed to be bound by these Terms. If you do not agree, do not use this system.",
    ],
  },
  {
    number: "02",
    title: "Eligibility and account responsibility",
    body: [
      "Only currently enrolled students, alumni applicants, faculty, CHED reviewers, and authorized administrators may hold an account.",
      "You are responsible for keeping your username and password confidential. All activity performed through your account is treated as activity performed by you.",
      "Accounts are personal. Sharing, selling, or creating accounts for another person is not allowed and may lead to disqualification.",
    ],
  },
  {
    number: "03",
    title: "Accurate and truthful information",
    body: [
      "All details you provide — student number, name, sex, birthdate, program, year level, grades, family income, and supporting documents — must be complete, accurate, and consistent with your official Registrar record.",
      "Providing false information, editing documents, or submitting someone else's requirements is grounds for immediate disqualification, cancellation of any grant already awarded, and referral to the proper school authorities.",
      "Your student number is automatically checked against the Registrar Information System. Accounts that do not match are marked Unverified and cannot apply until an administrator verifies them.",
    ],
  },
  {
    number: "04",
    title: "Document submission (ITR and supporting files)",
    body: [
      "You must upload a clear, readable copy of your latest Annual Income Tax Return (ITR) or other accepted proof of family income when requested by the application form.",
      "Uploaded files must be genuine, unaltered, and belong to your household. Blurry, cropped, or tampered files may be rejected by the administrator.",
      "Documents you upload are stored in the system's document repository and are used only for scholarship evaluation, verification, and audit purposes.",
    ],
  },
  {
    number: "05",
    title: "Automated OCR verification and AI ranking",
    body: [
      "The system reads your uploaded ITR using Optical Character Recognition (OCR) to extract the Total Family Annual Income and compares it with the income you typed in the form.",
      "When the two figures differ, the figure read from the ITR is used as the verified income for the financial-need score, and the difference is flagged for the reviewer.",
      "Applicants are then ranked by a Random Forest machine-learning model that combines financial need, OCR verification, and academic performance. The model output (priority score, need classification, and rank) is a decision-support tool.",
      "Rankings and scores are advisory. Final approval, disbursement, and amount of any scholarship remain subject to review and decision by the Scholarship and Financial Aid Office, CHED reviewers, and available funding.",
    ],
  },
  {
    number: "06",
    title: "Academic monitoring and early-warning alerts",
    body: [
      "By enrolling in the program you agree that your grades and academic records may be monitored to generate early-warning alerts when your grade falls below the maintenance requirement (93%).",
      "Alerts are sent to you, your faculty, and the scholarship office so that academic interventions can be offered. Monitoring is for your benefit and program compliance only.",
    ],
  },
  {
    number: "07",
    title: "Data privacy and confidentiality",
    body: [
      "Your personal data and documents are collected, used, and stored in accordance with the Data Privacy Act of 2012 (Republic Act No. 10173) and school policy.",
      "Data is accessible only to authorized personnel (administrators, faculty advisers, and CHED reviewers) who need it to process, rank, and monitor scholarship applications.",
      "We do not sell your data. Data may be retained for audit, reporting, and compliance purposes, and disposed of according to the school's retention policy.",
    ],
  },
  {
    number: "08",
    title: "System availability, security, and acceptable use",
    body: [
      "The system is provided on an as-is basis. Scheduled maintenance, power interruptions, or network issues may cause temporary unavailability; submissions in progress should be retried.",
      "You agree not to attempt to breach or bypass system security, manipulate automated rankings, mass-create accounts, or interfere with other users' data. Violations may result in account suspension.",
      "Security events and account activity may be logged for protection and audit purposes.",
    ],
  },
  {
    number: "09",
    title: "Decisions, appeals, and amendments",
    body: [
      "If you believe your ranking, verification status, or approval is incorrect, you may file an appeal with the Scholarship and Financial Aid Office together with your reference/application number and supporting documents.",
      "The school may amend these Terms at any time. Continued use of the system after an update constitutes acceptance of the revised Terms. The current version is always available on this page.",
    ],
  },
];

export default function TermsPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-[#FAF7F5] font-sans text-[#241012]">
      <Link href="/" title="Back to homepage" aria-label="Back to homepage" className="fixed right-4 top-4 z-[60] inline-flex items-center gap-2 rounded-full border border-[#241012]/10 bg-white py-2 pl-2.5 pr-4 text-xs font-semibold text-[#7B1113] shadow-lg transition hover:bg-[#FAF7F5]">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#7B1113]/10">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" /></svg>
        </span>
        Home
      </Link>

      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
        <div className="rounded-2xl border border-[#241012]/[0.06] bg-white p-6 shadow-[0_18px_50px_-20px_rgba(36,16,18,0.18)] sm:p-9">
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#7B1113]">ISEWM Scholarship System</p>
          <h1 className="mt-1.5 text-2xl font-bold text-[#241012]">Terms and Conditions</h1>
          <p className="mt-2 text-sm leading-relaxed text-[#6B5458]">
            Please read these terms carefully. You must agree to them during registration before you can create an
            account and use the scholarship system.
          </p>
          <p className="mt-1 text-xs text-[#8B7376]">Effective date: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })} &middot; St. Peter&rsquo;s College, Iligan City</p>

          <div className="mt-7 space-y-6">
            {CLAUSES.map((clause) => (
              <section key={clause.number}>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[#7B1113] text-[11px] font-bold text-white">{clause.number}</span>
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-[#241012]">{clause.title}</h2>
                    {clause.body.map((paragraph, i) => (
                      <p key={i} className="mt-1.5 text-[13px] leading-relaxed text-[#6B5458]">{paragraph}</p>
                    ))}
                  </div>
                </div>
              </section>
            ))}
          </div>

          <div className="mt-8 rounded-xl border border-[#7B1113]/15 bg-[#FAF7F5] px-4 py-3 text-xs leading-relaxed text-[#6B5458]">
            <b className="text-[#7B1113]">Summary:</b> give truthful details and genuine documents &middot; the OCR-read
            ITR income is used for your financial-need score &middot; the Random Forest ranking is advisory and final
            approval rests with the Scholarship &amp; Financial Aid Office &middot; your data is protected under RA 10173.
          </div>

          <div className="mt-7 flex flex-col gap-3 border-t border-[#241012]/[0.06] pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-relaxed text-[#8B7376]">
              Questions about these terms? Contact the Scholarship &amp; Financial Aid Office.
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => router.back()}
                className="rounded-xl border border-[#7B1113]/25 px-5 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
              >
                &larr; Go back
              </button>
              <Link
                href="/register"
                className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-5 py-2.5 text-xs font-bold text-white shadow-md transition hover:brightness-110"
              >
                I agree &mdash; create account
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
