export const STATUS_STYLES: Record<string, string> = {
  Pending: "bg-amber-100 text-amber-800 border-amber-200",
  Approved: "bg-green-100 text-green-800 border-green-200",
  "Not Approved": "bg-red-100 text-red-700 border-red-200",
  Open: "border-green-200 bg-green-50 text-green-700",
  Closed: "border-gray-200 bg-gray-100 text-gray-600",
  Active: "border-red-200 bg-red-50 text-red-600",
  Resolved: "border-green-200 bg-green-50 text-green-700",
};

export const NOTIFICATION_TYPE_STYLES: Record<string, string> = {
  Announcement: "bg-[#7B1113]/10 text-[#7B1113]",
  "Status Update": "bg-blue-100 text-blue-800",
  Warning: "bg-red-100 text-red-700",
  Scholarship: "bg-green-100 text-green-800",
};

export const DOC_TYPES = ["COR", "Valid ID", "Signature Form"] as const;

export const PROGRAM_REQUIREMENT_OPTIONS = [
  "COR",
  "Valid ID",
  "Signature Form",
  "Certificate of Enrollment",
  "Transcript of Records",
  "Report Card (Form 138)",
  "Good Moral Certificate",
  "Barangay Certificate of Residency",
  "Income Tax Return (ITR)",
  "Certificate of Indigency",
  "Medical Certificate",
  "Parent Waiver / Consent",
] as const;

/** Split a stored requirements string on | , or ; so legacy free-text still loads. */
export function parseProgramRequirements(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[|,;]/)
    .map((r) => r.trim())
    .filter(Boolean);
}

/** Map a free-text requirement to a canonical PROGRAM_REQUIREMENT_OPTIONS item. */
export function matchRequirementOption(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  const exact = PROGRAM_REQUIREMENT_OPTIONS.find((o) => o.toLowerCase() === s);
  if (exact) return exact;

  if (/\bcor\b|certificate of registration/.test(s)) return "COR";
  if (/valid\s*i\.?d|national id|school id/.test(s)) return "Valid ID";
  if (/signature/.test(s)) return "Signature Form";
  if (/enrollment/.test(s)) return "Certificate of Enrollment";
  if (/transcript|\btor\b/.test(s)) return "Transcript of Records";
  if (/form\s*138|report card/.test(s)) return "Report Card (Form 138)";
  if (/good moral|moral certificate/.test(s)) return "Good Moral Certificate";
  if (/barangay/.test(s)) return "Barangay Certificate of Residency";
  if (/\bitr\b|income tax/.test(s)) return "Income Tax Return (ITR)";
  if (/indigency/.test(s)) return "Certificate of Indigency";
  if (/medical/.test(s)) return "Medical Certificate";
  if (/waiver|consent|parent/.test(s)) return "Parent Waiver / Consent";

  // Academic GWA/GPA is collected in the Academic Records section, not as a file slot.
  if (/academic record|shs gwa|college gpa|gwa|gpa/.test(s)) return null;

  return null;
}

/** Parse stored requirements and keep only canonical option labels (deduped, stable order). */
export function getProgramRequirementDocs(value?: string | null): string[] {
  const matched = parseProgramRequirements(value)
    .map(matchRequirementOption)
    .filter((x): x is string => !!x);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const opt of PROGRAM_REQUIREMENT_OPTIONS) {
    if (matched.includes(opt) && !seen.has(opt)) {
      seen.add(opt);
      ordered.push(opt);
    }
  }
  return ordered;
}

export const DISABILITY_OPTIONS = [
  "None",
  "Blind",
  "Low Vision",
  "Deaf",
  "Hard of Hearing",
  "Speech / Language Impairment",
  "Mobility Impairment",
  "Mental / Psychosocial Disability",
  "Learning Disability",
  "Other Disability",
] as const;

export const IP_GROUP_OPTIONS = [
  "None",
  "Higaonon",
  "Maranao",
  "Subanen",
  "Talaandig",
  "Manobo",
  "B'laan",
  "Teduray",
  "Other Indigenous People Group",
] as const;

export const PROGRAMS = [
  "Bachelor of Science in Civil Engineering",
  "Bachelor of Science in Electrical Engineering",
  "Bachelor of Science in Mechanical Engineering",
  "Bachelor of Science in Computer Engineering",
  "Bachelor of Science in Electronics Engineering",
  "Bachelor of Science in Computer Science",
  "Bachelor of Science in Information Technology",
  "Bachelor of Science in Criminology",
  "Bachelor of Science in Business Administration Major in Marketing Management",
  "Bachelor of Science in Business Administration Major in Financial Management",
  "Bachelor of Science in Business Administration Major in Human Resource Management",
  "Bachelor of Science in Business Administration Major in Operations Management",
  "Bachelor of Elementary Education",
  "Bachelor of Secondary Education",
  "Bachelor of Early Childhood Education",
  "Bachelor of Arts in English Language",
  "Bachelor of Arts in Political Science",
];

export const YEAR_LEVELS = ["1st Year", "2nd Year", "3rd Year", "4th Year", "5th Year"];

export const APPLICATION_STATUSES = ["Pending", "Approved", "Not Approved"] as const;

export const REQUIRED_DOCS = ["COR", "Valid ID", "Signature Form", "Academic Record"] as const;
