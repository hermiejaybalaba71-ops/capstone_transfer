"use client";
import toast from "react-hot-toast";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { downloadCsv } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

const PIPELINE_API = "/api/ml/ocr-rank";

interface Applicant {
  application_id: number;
  student_name: string;
  student_number: string;
  scholarship: string;
  program: string | null;
  annual_income_family: number | null;
  itr_path: string | null;
  year_level: string | null;
  sex: string | null;
  shs_gwa: number | null;
  college_gpa: number | null;
  hasItr: boolean;
  // statutory priority data (same fields the historical preprocessing derives)
  disability?: string | null;
  indigenous_people_group?: string | null;
  solo_parent?: number | null;
  first_gen?: number | null;
  is_4ps?: number | null;
  birthdate?: string | null;
  age?: number | null;
}

interface ChedForm {
  ched_form_id: number;
  application_id: number;
  student_id?: string;
  last_name?: string;
  given_name?: string;
  middle_name?: string;
  ext_name?: string;
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
  shs_gwa?: number;
  college_gpa?: number;
  created_at?: string;
  scholarship_applications?: {
    application_id: number;
    application_status?: string;
    application_date?: string;
    scholarship_id?: number | null;
    scholarship_programs?: { scholarship_name: string } | { scholarship_name: string }[];
    student_accounts?: {
      last_name?: string;
      given_name?: string;
      middle_name?: string;
      ext_name?: string;
      student_number?: string;
      program_name?: string;
      year_level?: string;
      sex?: string;
      birthdate?: string;
      registration_status?: string;
    } | {
      last_name?: string;
      given_name?: string;
      middle_name?: string;
      ext_name?: string;
      student_number?: string;
      program_name?: string;
      year_level?: string;
      sex?: string;
      birthdate?: string;
      registration_status?: string;
    }[];
  } | {
    application_id: number;
    application_status?: string;
    application_date?: string;
    scholarship_id?: number | null;
    scholarship_programs?: { scholarship_name: string } | { scholarship_name: string }[];
    student_accounts?: {
      last_name?: string;
      given_name?: string;
      middle_name?: string;
      ext_name?: string;
      student_number?: string;
      program_name?: string;
      year_level?: string;
      sex?: string;
      birthdate?: string;
      registration_status?: string;
    } | {
      last_name?: string;
      given_name?: string;
      middle_name?: string;
      ext_name?: string;
      student_number?: string;
      program_name?: string;
      year_level?: string;
      sex?: string;
      birthdate?: string;
      registration_status?: string;
    }[];
  }[];
}

interface SavedRanking {
  application_id: number;
  ranking_position: number;
  priority_score: number;
  prediction_result: string;
  generated_date: string;
}

function restoreSavedRankings(
  rankings: SavedRanking[],
  forms: ChedForm[],
): RankedRow[] {
  const formByApplication = new Map(forms.map((form) => [form.application_id, form]));

  return rankings.map((ranking) => {
    const form = formByApplication.get(ranking.application_id);
    const application = Array.isArray(form?.scholarship_applications)
      ? form.scholarship_applications[0]
      : form?.scholarship_applications;
    const student = Array.isArray(application?.student_accounts)
      ? application.student_accounts[0]
      : application?.student_accounts;
    const scholarship = Array.isArray(application?.scholarship_programs)
      ? application.scholarship_programs[0]
      : application?.scholarship_programs;
    return {
      application_id: ranking.application_id,
      student_name: student
        ? `${student.last_name ?? ""}, ${student.given_name ?? ""}`.trim()
        : `Application #${ranking.application_id}`,
      student_number: student?.student_number ?? null,
      scholarship: scholarship?.scholarship_name ?? null,
      program: student?.program_name ?? form?.complete_program_name ?? null,
      priority_score: Number(ranking.priority_score) || 0,
      prediction: ranking.prediction_result || "Unclassified",
      declared_income: null,
      annual_income_family: null,
      ocr_income: null,
      income_used: null,
      ocr_match_pct: null,
      ocr_status: "OCR details not saved",
      financial_need_score: null,
      itr_path: form?.income_tax_return ?? null,
      year_level: student?.year_level ?? form?.year_level ?? null,
      sex: student?.sex ?? form?.sex ?? null,
      savedResultOnly: true,
    };
  });
}

interface MatchInfo {
  exact_match: boolean;
  align_pct: number;
  diff: number | null;
  status: string;
}

interface DocRecord {
  path: string;
  application_id?: number | null;
  student_name?: string | null;
  declared_income?: number | null;
  linked?: boolean;
  ocr_value?: number | null;
  match?: MatchInfo;
  confidence?: number;
  ocr_ms?: number;
  line_count?: number;
  method?: string | null;
  variant?: string | null;
  box_thresh?: number | null;
  attempts?: number;
  cached?: boolean;
  skipped?: string | null;
  error?: string | null;
  low_confidence?: boolean;
  anchor?: string | null;
  amount_line?: string | null;
  steps?: string[];
  accuracy_pct?: number | null;
  scan_failure?: boolean;
  income_confidence?: number | null;
  income_used?: number | null;
  income_source?: string | null;
  income_delta?: number | null;
  need_score?: number | null;
  image?: { width?: number; height?: number; bytes?: number };
  preview?: Array<{ text: string; score: number }>;
}

interface DocUi extends DocRecord {
  index: number;
  total: number;
  status: "queued" | "scanning" | "done" | "error" | "skipped";
}

interface ScanAnalytics {
  documents_in_bucket: number;
  documents_scanned: number;
  skipped_documents: number;
  linked_to_application: number;
  unlinked: number;
  income_detected: number;
  detection_rate_pct: number;
  income_not_detected: number;
  declared_income_available: number;
  scan_failures: number;
  comparable: number;
  exact_matches: number;
  mismatches: number;
  match_rate_pct: number | null;
  avg_align_pct: number | null;
  income_confidence_mean: number | null;
  typed_accuracy_pct?: number | null;
  avg_need_score?: number | null;
  avg_confidence: number | null;
  total_ocr_ms: number;
  engine_load_ms: number;
  engine: Record<string, unknown>;
  scan_seconds: number;
  cache_hits?: number;
}

interface TrainDataset {
  sources: { synthetic: number; csv: number; real: number };
  label_sources?: { observed_npcinc: number; derived_proxy: number };
  target_classes?: { priority: number; not_priority: number };
  priority_flags?: Record<string, number>;
  total: number;
  with_income: number;
  need_mean: number | null;
  income?: { min: number; p25: number; median: number; p75: number; max: number; mean: number };
  histogram?: Array<{ label: string; count: number; pct: number }>;
}

interface TrainInfo {
  n_samples: number;
  n_real: number;
  n_synthetic: number;
  n_csv?: number;
  dataset?: TrainDataset | null;
  // Set when the run scored with a model trained earlier (the Execute Training
  // Data panel's scholarship_rf_model.joblib) instead of refitting locally.
  external?: boolean;
  model_source?: string;
  model_id?: string | null;
  trained_at?: string | null;
  model_params?: {
    max_depth?: number | null;
    min_samples_leaf?: number;
    min_samples_split?: number;
    class_weight?: string;
  };
  persisted?: boolean;
  evaluation?: {
    available: boolean;
    source: string;
    n_test: number;
    n_train: number;
  };
  n_trees: number;
  seed: number;
  feature_columns?: string[];
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  roc_auc: number | null;
  confusion_matrix: number[][] | null;
  r2: number | null;
  rmse: number | null;
  feature_importance: Record<string, number>;
  model_path: string;
  model_size_kb: number;
  train_ms: number;
}

interface RankedRow {
  application_id: number | null;
  student_name: string | null;
  student_number: string | null;
  scholarship: string | null;
  program: string | null;
  priority_score: number;
  prediction: string;
  probability?: number;
  declared_income: number | null;
  annual_income_family?: number | null;
  ocr_income: number | null;
  ocr_error?: string | null;
  ocr_scan_failed?: boolean;
  income_used: number | null;
  income_source?: string | null;
  income_delta?: number | null;
  ocr_income_differs?: boolean;
  ocr_match_pct: number | null;
  ocr_exact_match?: boolean;
  ocr_status: string;
  itr_trust?: "verified" | "mismatch" | "unverified" | "no_itr";
  itr_verified?: boolean;
  financial_need_score: number | null;
  priority_target?: number;
  itr_path: string | null;
  year_level: string | null;
  sex: string | null;
  savedResultOnly?: boolean;
}

interface LogLine {
  t?: number;
  msg: string;
  stderr?: boolean;
}

type Phase = "scanning" | "training" | "ranking" | "saving";

const peso = (value: number | null | undefined) =>
  value == null ? "\u2014" : `\u20B1${Number(value).toLocaleString()}`;

// Values from OCR analytics are already percentages (for example 95.7).
const pct = (value: number | null | undefined, digits = 1) =>
  value == null ? "\u2014" : `${Number(value).toFixed(digits)}%`;

/** Model metrics are fractions (0..1), e.g. 0.9565 -> "95.7%". */
const fpct = (value: number | null | undefined, digits = 1) =>
  value == null ? "\u2014" : `${(Number(value) * 100).toFixed(digits)}%`;

const INCOME_BRACKETS = [
  { min: null, max: 100_000, label: "\u2264100k" },
  { min: 100_000, max: 200_000, label: "100\u2013200k" },
  { min: 200_000, max: 300_000, label: "200\u2013300k" },
  { min: 300_000, max: 400_000, label: "300\u2013400k" },
  { min: 400_000, max: 500_000, label: "400\u2013500k" },
  { min: 500_000, max: null, label: ">500k" },
];

function incomeDistribution(values: Array<number | null | undefined>) {
  const amounts = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return INCOME_BRACKETS.map((bracket) => {
    const count = amounts.filter(
      (value) =>
        (bracket.min == null || value > bracket.min) &&
        (bracket.max == null || value <= bracket.max),
    ).length;
    return {
      ...bracket,
      count,
      pct: amounts.length ? (count / amounts.length) * 100 : 0,
    };
  });
}

export default function MLRankingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [chedForms, setChedForms] = useState<ChedForm[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [programs, setPrograms] = useState<{ scholarship_id: number; scholarship_name: string; status?: string }[]>([]);
  const [pendingByProgram, setPendingByProgram] = useState<Record<number, number>>({});
  const [selectedProgramId, setSelectedProgramId] = useState<number | null>(null);

  const [busy, setBusy] = useState<null | "scan" | "rank" | "train">(null);
  const [savedCount, setSavedCount] = useState(0);
  const [savedBusy, setSavedBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("scanning");
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [docs, setDocs] = useState<DocUi[]>([]);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [ocrAnalytics, setOcrAnalytics] = useState<ScanAnalytics | null>(null);
  const [trainInfo, setTrainInfo] = useState<TrainInfo | null>(null);
  const [ranked, setRanked] = useState<RankedRow[]>([]);
  const [savedRankings, setSavedRankings] = useState<SavedRanking[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [histFile, setHistFile] = useState<{ name: string; size: number; updated_at?: string } | null>(null);
  const [histBusy, setHistBusy] = useState(false);
  const [histError, setHistError] = useState("");
  const histInputRef = useRef<HTMLInputElement | null>(null);

  // A finished run's log + result, kept after the progress modal closes so the
  // admin can still review what the training / ranking actually did.
  const [lastRun, setLastRun] = useState<{
    mode: "scan" | "rank" | "train";
    finishedAt: string;
    logs: LogLine[];
    trainInfo: TrainInfo | null;
    rankedCount: number;
    error: string;
  } | null>(null);
  const logLinesRef = useRef<LogLine[]>([]);
  const [showTrainLog, setShowTrainLog] = useState(false);
  const [showRankLog, setShowRankLog] = useState(false);

  const logRef = useRef<HTMLDivElement | null>(null);

  async function refreshHistFile() {
    try {
      const res = await fetch("/api/ml/training-data");
      if (!res.ok) return;
      const json = await res.json();
      setHistFile(json.file || null);
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch("/api/ml/training-data");
        if (!res.ok || ignore) return;
        const json = await res.json();
        if (!ignore) setHistFile(json.file || null);
      } catch {
        // non-fatal
      }
    })();
    return () => { ignore = true; };
  }, []);

  async function uploadHistFile(file: File) {
    setHistBusy(true);
    setHistError("");
    try {
      const prepare = await fetch("/api/ml/training-data?mode=prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size }),
      });
      const prepared = await prepare.json().catch(() => ({}));
      if (!prepare.ok) throw new Error(prepared.error || `Upload preparation failed (${prepare.status})`);

      const { error: uploadError } = await getSupabase()
        .storage
        .from("training-data")
        .uploadToSignedUrl(prepared.path, prepared.token, file, {
          contentType: file.type || (file.name.toLowerCase().endsWith(".csv")
            ? "text/csv"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        });
      if (uploadError) throw new Error(`Training-data upload failed in Supabase Storage: ${uploadError.message}`);

      const res = new Response(JSON.stringify({ ok: true, name: file.name, size: file.size }), { status: 200 });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Upload failed (${res.status})`);
      await refreshHistFile();
      setMessage(
        `Machine learning train data "${json.name}" saved. Click Execute Training Data to train and deploy this file-only model.`
        + (json.warning ? ` ${json.warning}` : "")
      );
      toast.success("Machine learning train data uploaded.");
    } catch (err: unknown) {
      setHistError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setHistBusy(false);
      if (histInputRef.current) histInputRef.current.value = "";
    }
  }

  async function removeHistFile() {
    setHistBusy(true);
    setHistError("");
    try {
      const res = await fetch("/api/ml/training-data", { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Remove failed (${res.status})`);
      }
      setHistFile(null);
      setMessage("Machine learning train data removed — the next ranking run uses the bundled sample only.");
    } catch (err: unknown) {
      setHistError(err instanceof Error ? err.message : "Remove failed.");
    } finally {
      setHistBusy(false);
    }
  }

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      let sb: ReturnType<typeof getSupabase>;
      try {
        sb = getSupabase();
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Supabase configuration is missing.");
          setLoading(false);
        }
        return;
      }
      const { data: { session }, error: sessionError } = await sb.auth.getSession();
      if (sessionError) {
        if (!ignore) { setError(`Failed to load admin session: ${sessionError.message}`); setLoading(false); }
        return;
      }
      if (!session) { router.push("/login"); return; }

      const [chedQ, pendingQ, progQ, savedQ, rankQ] = await Promise.all([
        sb.from("ched_form_input")
          .select(`*, scholarship_applications!inner(
               application_id, application_status, application_date,
               scholarship_programs(scholarship_name),
               student_accounts(last_name, given_name, middle_name, ext_name, student_number, program_name, year_level, sex, birthdate, registration_status)
             )`)
          .order("ched_form_id", { ascending: false }),
        sb.from("scholarship_applications")
          .select("application_id, student_id, scholarship_id")
          .eq("application_status", "Pending"),
        sb.from("scholarship_programs")
          .select("scholarship_id, scholarship_name, status")
          .order("created_at", { ascending: false }),
        sb.from("ranking_result")
          .select("ranking_id", { count: "exact", head: true }),
        sb.from("ranking_result")
          .select("application_id, ranking_position, priority_score, prediction_result, generated_date")
          .order("ranking_position", { ascending: true }),
      ]);

      const loadedForms = (chedQ.data || []) as ChedForm[];
      const loadedRankings = (rankQ.data || []) as SavedRanking[];
      if (!chedQ.error) setChedForms(loadedForms);
      if (!rankQ.error) {
        setSavedRankings(loadedRankings);
        setRanked(restoreSavedRankings(loadedRankings, loadedForms));
      }
      setPendingCount(pendingQ.data?.length ?? 0);
      if (!savedQ.error) setSavedCount(savedQ.count ?? 0);
      if (!progQ.error) setPrograms((progQ.data || []) as { scholarship_id: number; scholarship_name: string; status?: string }[]);
      const byProgram: Record<number, number> = {};
      (pendingQ.data || []).forEach((row: { scholarship_id: number | null }) => {
        if (row.scholarship_id == null) return;
        byProgram[row.scholarship_id] = (byProgram[row.scholarship_id] || 0) + 1;
      });
      setPendingByProgram(byProgram);
      const queryErrors = [
        chedQ.error && `CHED forms: ${chedQ.error.message}`,
        pendingQ.error && `pending applications: ${pendingQ.error.message}`,
        progQ.error && `scholarship programs: ${progQ.error.message}`,
        savedQ.error && `saved ranking: ${savedQ.error.message}`,
        rankQ.error && `ranking results: ${rankQ.error.message}`,
      ].filter(Boolean);
      if (queryErrors.length) setError(`Some ranking data could not be loaded: ${queryErrors.join("; ")}`);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logLines]);

  async function viewItr(itrPath: string) {
    const sb = getSupabase();
    // 1) Normal signing - works for buckets that have a storage read policy
    //    for the logged-in user.
    const { data, error: err } = await sb.storage.from("itr-documents").createSignedUrl(itrPath, 3600);
    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
      return;
    }
    // 2) The itr-documents bucket has no SELECT policy, so the user's key gets
    //    404 "Object not found" even though the file is really there (the OCR
    //    pipeline reads it fine because it uses the service key). Fall back to
    //    the server route, which signs with the service key - same workaround
    //    the Documents Viewer already uses.
    try {
      const res = await fetch("/api/storage/signed-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket: "itr-documents", paths: [itrPath] }),
      });
      const payload = (await res.json()) as { urls?: Record<string, string>; error?: string };
      const url = payload.urls?.[itrPath];
      if (res.ok && url) {
        window.open(url, "_blank");
        return;
      }
      setError(payload.error || err?.message || "Could not open the ITR file.");
    } catch {
      setError(err?.message || "Could not open the ITR file.");
    }
  }

  async function buildApplicants(): Promise<Applicant[]> {
    const sb = getSupabase();
    if (!selectedProgramId) throw new Error("Select a scholarship program before scanning or ranking.");
    const { data: pendingApps, error: appErr } = await sb
      .from("scholarship_applications")
      .select("application_id, student_id, application_data, scholarship_id, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number, program_name, year_level, sex, birthdate)")
      .eq("application_status", "Pending")
      .eq("scholarship_id", selectedProgramId);

    if (appErr) throw new Error(appErr.message);
    if (!pendingApps?.length) return [];

    const formMap: Record<number, ChedForm> = {};
    chedForms.forEach((c) => { formMap[c.application_id] = c; });

    const { data: acadRows } = await sb
      .from("support_academic_records")
      .select("student_id, shs_gwa, college_gpa");
    const acadByStudent = new Map<number, { shs_gwa?: number | null; college_gpa?: number | null }>();
    (acadRows || []).forEach((r) => {
      if (r.student_id != null) acadByStudent.set(Number(r.student_id), r);
    });

    return pendingApps.map((app) => {
      const sa = Array.isArray(app.student_accounts) ? app.student_accounts[0] : app.student_accounts;
      const sp = Array.isArray(app.scholarship_programs) ? app.scholarship_programs[0] : app.scholarship_programs;
      const form = formMap[app.application_id];
      const applicationData = (app.application_data || {}) as { annual_income_family?: number; itr_file?: string };
      const income = form?.annual_income_family ?? applicationData.annual_income_family ?? null;
      const itrPath = form?.income_tax_return ?? applicationData.itr_file ?? null;
      const acad = acadByStudent.get(Number(app.student_id));
      const birthdate = form?.birthdate ?? sa?.birthdate ?? null;
      let age: number | null = null;
      if (birthdate) {
        const born = new Date(String(birthdate).slice(0, 10));
        if (!Number.isNaN(born.getTime())) {
          const now = new Date();
          age = now.getFullYear() - born.getFullYear()
            - ((now.getMonth(), now.getDate()) < (born.getMonth(), born.getDate()) ? 1 : 0);
        }
      }
      return {
        application_id: app.application_id,
        student_name: sa ? `${sa.last_name ?? ""}, ${sa.given_name ?? ""}` : `App #${app.application_id}`,
        student_number: sa?.student_number ?? "",
        scholarship: sp?.scholarship_name ?? "",
        program: sa?.program_name ?? null,
        annual_income_family: income ?? null,
        itr_path: itrPath ?? null,
        year_level: form?.year_level ?? sa?.year_level ?? null,
        sex: form?.sex ?? sa?.sex ?? null,
        shs_gwa: form?.shs_gwa ?? acad?.shs_gwa ?? null,
        college_gpa: form?.college_gpa ?? acad?.college_gpa ?? null,
        hasItr: !!itrPath,
        // statutory priority fields (CHED form has no solo-parent / 4Ps /
        // first-gen column yet - they arrive as null and score 0)
        disability: form?.disability ?? null,
        indigenous_people_group: form?.indigenous_people_group ?? null,
        solo_parent: null,
        first_gen: null,
        is_4ps: null,
        birthdate,
        age,
      } as Applicant;
    });
  }

  function pushLog(line: LogLine) {
    setLogLines((prev) => {
      const next = prev.length > 400 ? prev.slice(-300) : prev.slice();
      next.push(line);
      logLinesRef.current = next;
      return next;
    });
  }

  async function runPipeline(mode: "scan" | "rank" | "train") {
    const startedAt = Date.now();
    let localError = "";
    const runMode = mode === "rank" && !selectedProgramId && histFile ? "train" : mode;
    const isTrain = runMode === "train";
    const trainUploadedAndRank = runMode === "rank" && Boolean(histFile);
    if (!isTrain && !selectedProgramId) {
      setError("Select a scholarship program first — only that program's student applications are scanned and ranked.");
      return;
    }
    if (isTrain && !histFile) {
      setError("Upload a CSV / Excel training file first — the train-only ranking trains on that file and ranks its own rows.");
      return;
    }
    const programName = programs.find((p) => p.scholarship_id === selectedProgramId)?.scholarship_name || `program #${selectedProgramId}`;
    setMessage("");
    setError("");
    setBusy(runMode);
    setPhase("scanning");
    setElapsed(0);
    setProgress({ done: 0, total: 0 });
    setDocs([]);
    setLogLines([]);
    if (isTrain) {
      setOcrAnalytics(null);
      setTrainInfo(null);
      setRanked([]);
      pushLog({ msg: `Starting file-only training from "${histFile?.name}" (backend/ml/pipeline.py)...` });
      pushLog({ msg: "No program selection needed for training: the uploaded file is the only training dataset." });
      pushLog({ msg: "Colab-notebook setup: 200 trees, max_depth 3, min_samples_leaf 200, seed 42." });
    } else {
      pushLog({ msg: `Starting ${runMode === "scan" ? "OCR scan" : trainUploadedAndRank ? "OCR + uploaded-data training + Random Forest ranking" : "OCR + Random Forest ranking"} (python ml/pipeline.py)...` });
      pushLog({ msg: `Selected scholarship program: ${programName} (${selectedProgramId ? pendingByProgram[selectedProgramId] || 0 : 0} pending application(s)).` });
      pushLog({ msg: "Loading pending applicants from Supabase..." });
      if (runMode === "rank") {
        setOcrAnalytics(null);
        setTrainInfo(null);
        setRanked([]);
      }
    }
    if (runMode === "scan") {
      setOcrAnalytics(null);
      setRanked([]);
      setTrainInfo(null);
    }

    // Declared before the try so the finally block can read them - a finished
    // run's log + metrics stay on screen after the progress modal closes.
    let finalAnalytics: ScanAnalytics | null = null;
    let finalRows: RankedRow[] = [];
    let finalTrainInfo: TrainInfo | null = null;

    try {
      const applicants = isTrain ? [] : await buildApplicants();
      if (!isTrain && !applicants.length) {
        setError(`No pending application is waiting under "${programName}". Choose another program or wait for students to apply.`);
        setBusy(null);
        return;
      }
      const eligible = applicants.filter((a) => a.hasItr && a.annual_income_family != null);
      if (runMode === "rank" && !eligible.length) {
        // Training must never be blocked by missing ITR / income: the Random
        // Forest still fits on the synthetic + historical rows, and every
        // applicant without income trains with the neutral need score (50).
        pushLog({
          msg:
            "No pending applicant has an uploaded ITR with income data - continuing anyway. "
          + "The model uses declared income when available; OCR only compares the ITR against it. "
          + "Applicants without declared income are still scored with the model's missing-value handling.",
        });
      }

      const queued = isTrain ? [] : applicants.filter((a) => a.itr_path);
      setProgress({ done: 0, total: queued.length });
      if (queued.length) {
        setDocs(
          queued.map((a, i) => ({
            path: a.itr_path as string,
            application_id: a.application_id,
            student_name: a.student_name,
            declared_income: a.annual_income_family ?? null,
            index: i + 1,
            total: queued.length,
            status: "queued",
          })),
        );
        pushLog({ msg: `Queued ${queued.length} ITR document(s) for OCR scanning:` });
        queued.forEach((a, i) =>
          pushLog({ msg: `  [${i + 1}/${queued.length}] ${a.itr_path} - ${a.student_name} (typed ${peso(a.annual_income_family)})` }),
        );
      } else if (!isTrain) {
        pushLog({ msg: "No ITR file is linked to an applicant in this program; no documents will be scanned." });
      }
      if (queued.length) pushLog({ msg: "Handing this program's linked ITR documents to the OCR engine..." });

      const res = await fetch(PIPELINE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isTrain
            ? {
                // Train-only: the uploaded file supplies every row. Hyperparameters
                // mirror the Colab notebook's proof-of-dataset run.
                mode: "train",
                seed: 42,
                n_trees: 200,
                n_synth: 0,
                max_depth: 3,
                min_samples_leaf: 200,
                applicants: [],
              }
            : {
          mode: runMode,
          train_uploaded: trainUploadedAndRank,
          seed: trainUploadedAndRank ? 42 : 2026,
          n_trees: trainUploadedAndRank ? 200 : 100,
          n_synth: trainUploadedAndRank ? 0 : 800,
          ...(trainUploadedAndRank ? { max_depth: 3, min_samples_leaf: 200 } : {}),
          applicants: applicants.map((a) => ({
            application_id: a.application_id,
            student_name: a.student_name,
            student_number: a.student_number,
            scholarship: a.scholarship,
            program: a.program,
            declared_income: a.annual_income_family,
            itr_path: a.itr_path,
            year_level: a.year_level,
            sex: a.sex,
            shs_gwa: a.shs_gwa,
            college_gpa: a.college_gpa,
            disability: a.disability,
            indigenous_people_group: a.indigenous_people_group,
            solo_parent: a.solo_parent,
            first_gen: a.first_gen,
            is_4ps: a.is_4ps,
            birthdate: a.birthdate,
            age: a.age,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || body?.message || `Pipeline request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      let doneOk = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!raw) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }

          const type = String(event.type);
          if (type === "log") {
            pushLog({ t: event.t as number | undefined, msg: String(event.msg ?? ""), stderr: event.stream === "stderr" });
          } else if (type === "start") {
            // stack / weights info no longer displayed - ranking rules card explains the model
          } else if (type === "doc") {
            const index = Number(event.index);
            const total = Number(event.total);
            setProgress({ done: (index || 1) - 1, total });
            setDocs((prev) => {
              const next = prev.slice();
              const existing = next.findIndex((d) => d.path === event.path);
              const base: DocUi = {
                path: String(event.path),
                application_id: null,
                student_name: (event.student_name as string) || null,
                declared_income: (event.declared_income as number) || null,
                index,
                total,
                status: "scanning",
              };
              if (existing >= 0) next[existing] = { ...next[existing], ...base };
              else next.push(base);
              return next;
            });
          } else if (type === "doc_result") {
            const record = event.record as DocRecord;
            setProgress({ done: Number(event.done ?? event.index ?? 0), total: Number(event.total ?? 0) });
            setDocs((prev) => {
              const next = prev.slice();
              const existing = next.findIndex((d) => d.path === record.path);
              const ui: DocUi = {
                ...record,
                index: existing >= 0 ? next[existing].index : prev.length + 1,
                total: Number(event.total ?? 0),
                status: (event.status as DocUi["status"]) || "done",
              };
              if (existing >= 0) next[existing] = ui;
              else next.push(ui);
              return next;
            });
            const m = record.match;
            pushLog({
              t: event.t as number | undefined,
              msg:
                `${record.path} \u2192 ${record.ocr_value != null ? peso(record.ocr_value) : "no value"}` +
                (m && record.declared_income != null
                  ? m.status === "not_comparable"
                    ? ` (declared ${peso(record.declared_income)}, income not detected; no match percentage)`
                    : ` (declared ${peso(record.declared_income)}, ${pct(m.align_pct, 2)} alignment, ${m.status})`
                  : "") +
                (record.cached ? " [cached]" : "") +
                (record.skipped ? ` [skipped: ${record.skipped}]` : ""),
            });
          } else if (type === "scan_progress") {
            setProgress({ done: Number(event.done), total: Number(event.total) });
          } else if (type === "scan_analytics") {
            const analytics = event.analytics as ScanAnalytics;
            setOcrAnalytics(analytics);
            finalAnalytics = analytics;
          } else if (type === "preprocess") {
            const rowLabel = event.row_label === "training" ? "training" : "applicant";
            pushLog({ t: event.t as number | undefined, msg: `Preprocessed ${Array.isArray(event.rows) ? event.rows.length : 0} ${rowLabel} row(s) into ${Array.isArray(event.feature_columns) ? event.feature_columns.length : 0} features (NumPy + median imputation).` });
          } else if (type === "train") {
            setPhase("training");
            setTrainInfo(event as unknown as TrainInfo);
            finalTrainInfo = event as unknown as TrainInfo;
            const modelPath = typeof event.model_path === "string" ? event.model_path : "the deployed model";
            const isExternal = Boolean(event.external || event.model_source === "external");
            pushLog({
              t: event.t as number | undefined,
              msg: isExternal
                ? `Using deployed Random Forest: ${modelPath} (${Number(event.n_trees) || 0} trees, ${Array.isArray(event.feature_columns) ? event.feature_columns.length : 0} features). Holdout accuracy metrics are not included in this ranking run.`
                : event.evaluation && (event.evaluation as { available?: boolean }).available
                  ? `Random Forest trained: observed-label holdout accuracy ${event.accuracy != null ? fpct(Number(event.accuracy)) : "n/a"}, F1 ${event.f1 != null ? fpct(Number(event.f1)) : "n/a"}, ROC-AUC ${event.roc_auc != null ? fpct(Number(event.roc_auc), 2) : "n/a"}.`
                  : "Random Forest trained, but no observed NPCINC labels were available for independent evaluation; proxy-label metrics are not reported.",
            });
          } else if (type === "rank") {
            setPhase("ranking");
            finalRows = (event.rows as RankedRow[]) || [];
            setRanked(finalRows);
          } else if (type === "error") {
            const message = String(event.message ?? "Pipeline error");
            localError = message;
            pushLog({ msg: `ERROR: ${message}`, stderr: true });
            if (event.trace) pushLog({ msg: String(event.trace), stderr: true });
          } else if (type === "done") {
            sawDone = true;
            doneOk = Boolean(event.ok);
            if (!finalAnalytics && event.scan_analytics) {
              finalAnalytics = event.scan_analytics as ScanAnalytics;
              setOcrAnalytics(finalAnalytics);
            }
            if (!finalRows.length && Array.isArray(event.rankings) && event.rankings.length) {
              finalRows = event.rankings as RankedRow[];
              setRanked(finalRows);
            }
          }
        }
      }

      if (!sawDone) {
        throw new Error("The OCR/ML pipeline closed before it finished. Check the Python environment.");
      }

      if (runMode === "rank" && doneOk && !localError && finalRows.length) {
        setPhase("saving");
        const sb = getSupabase();
        const rows = finalRows
          .filter((row): row is RankedRow & { application_id: number } => row.application_id != null)
          .map((row, i) => ({
          application_id: row.application_id,
          priority_score: row.priority_score,
          ranking_position: i + 1,
          prediction_result: row.prediction,
          generated_date: new Date().toISOString(),
          }));
        const { error: deleteErr } = await sb
          .from("ranking_result")
          .delete()
          .in("application_id", rows.map((row) => row.application_id));
        if (deleteErr) {
          localError = `Ranking computed but existing results could not be replaced: ${deleteErr.message}`;
        }
        if (!localError) {
          const { error: saveErr } = await sb.from("ranking_result").insert(rows);
          if (saveErr) localError = `Ranking computed but saving to ranking_result failed: ${saveErr.message}`;
        }
        if (!localError) {
          const [countQ, savedQ] = await Promise.all([
            sb.from("ranking_result").select("ranking_id", { count: "exact", head: true }),
            sb.from("ranking_result")
              .select("application_id, ranking_position, priority_score, prediction_result, generated_date")
              .order("ranking_position", { ascending: true }),
          ]);
          if (countQ.error) localError = `Ranking saved, but its saved-result count could not be refreshed: ${countQ.error.message}`;
          if (savedQ.error) localError = `Ranking saved, but saved results could not be reloaded: ${savedQ.error.message}`;
          if (!countQ.error) setSavedCount(countQ.count ?? 0);
          if (!savedQ.error) setSavedRankings((savedQ.data || []) as SavedRanking[]);
        }
      }

      if (sawDone && !doneOk && !localError) {
        localError = "The pipeline reported that it did not finish successfully.";
      }

      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (localError) {
        setError(localError);
      } else {
        setMessage(
          runMode === "scan"
            ? `OCR scan finished in ${seconds}s \u2014 ${finalAnalytics?.income_detected ?? 0} of ${finalAnalytics?.documents_scanned ?? 0} ITR image(s) produced an income value.`
            : isTrain
              ? `Train-only run finished in ${seconds}s \u2014 the Random Forest fit on the uploaded file${
                  finalTrainInfo?.persisted ? " and the model plus analytics were saved to Storage" : ", but the model could not be saved to persistent Storage"
                }.`
              : trainUploadedAndRank
                ? `Training and ranking complete in ${seconds}s \u2014 the uploaded file trained the model, which then ranked ${finalRows.length} applicant(s) after OCR.`
                : `Ranking complete in ${seconds}s \u2014 ${finalRows.length} applicant(s) prioritized by the trained model; annual income breaks probability ties.`,
        );

      }
      setElapsed(0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to run the OCR / ranking pipeline.");
    } finally {
      // Keep a finished run's log + metrics on screen after the progress modal
      // closes, so the admin has proof of what the training / ranking did.
      setLastRun({
        mode: runMode,
        finishedAt: new Date().toLocaleTimeString("en-PH"),
        logs: logLinesRef.current.slice(),
        trainInfo: finalTrainInfo,
        rankedCount: finalRows.length,
        error: localError,
      });
      setBusy(null);
    }
  }

  async function deleteSavedRanking() {
    if (savedBusy || !savedCount) return;
    const ok = window.confirm(
      `Delete the saved AI ranking (${savedCount} row(s)) from the database? CHED and the Admin dashboard will stop showing it until Execute AI Ranking is run again.`
    );
    if (!ok) return;
    setSavedBusy(true);
    try {
      const sb = getSupabase();
      const { data: rows, error: selErr } = await sb.from("ranking_result").select("ranking_id");
      if (selErr) throw new Error(selErr.message);
      if (rows?.length) {
        const { error: delErr } = await sb
          .from("ranking_result")
          .delete()
          .in("ranking_id", rows.map((r) => r.ranking_id));
        if (delErr) throw new Error(delErr.message);
      }
      setSavedCount(0);
      setSavedRankings([]);
      setRanked([]);
      setMessage(`Deleted the saved AI ranking (${rows?.length ?? 0} row(s)) from the database.`);
      toast.success("Saved ranking deleted.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete the saved ranking.";
      setError(msg);
      toast.error(msg);
    } finally {
      setSavedBusy(false);
    }
  }

  function exportOcrCsv() {
    if (!docs.length) { setError("Run an OCR scan first."); return; }
    downloadCsv("itr-ocr-audit.csv", docs.map((d) => ({
      file: d.path,
      student_name: d.student_name ?? "",
      declared_income: d.declared_income ?? "",
      ocr_income: d.ocr_value ?? "",
      match_status: d.match?.status ?? "",
      align_pct: d.match?.align_pct ?? "",
      difference: d.match?.diff ?? "",
      confidence: d.confidence ?? "",
      extraction_method: d.method ?? "",
      cached: d.cached ? "yes" : "no",
      error: d.error ?? "",
    })));
    setMessage(`Exported OCR audit CSV (${docs.length} file(s)).`);
    toast.success(`Exported OCR audit CSV (${docs.length} file(s)).`);
  }

  function exportChedFormsCsv() {
    // Only applications with an EXECUTED ranking (saved in ranking_result) are exported.
    if (!savedRankings.length) {
      setError("No ranking has been executed yet — nothing is saved in the ranking datastore, so there is nothing to export. Run 'Execute AI Ranking' first.");
      toast.error("No executed ranking yet — nothing to export.");
      return;
    }
    const rankedIds = new Set(savedRankings.map((r) => r.application_id));
    const rowsToExport = chedForms.filter((c) => rankedIds.has(c.application_id));
    if (!rowsToExport.length) {
      setError("The executed ranking does not reference any CHED form submission — nothing to export.");
      toast.error("No CHED forms match the executed ranking.");
      return;
    }

    // In-session preprocessing sources (latest OCR scan / ranking run), keyed by application.
    const rankedByApp = new Map<number, RankedRow>();
    ranked.forEach((r) => { if (r.application_id != null) rankedByApp.set(r.application_id, r); });
    const ocrByApp = new Map<number, DocUi>();
    docs.forEach((d) => { if (d.application_id != null) ocrByApp.set(d.application_id, d); });

    // Nothing in the CSV is ever blank: every empty value falls back to "-".
    const val = (value: unknown) => {
      if (value === null || value === undefined) return "-";
      if (typeof value === "string" && !value.trim()) return "-";
      return value;
    };
    const pesoVal = (value: number | null | undefined) => (value == null ? "-" : `${Number(value)}`);
    const unwrap = <T,>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? v[0] ?? null : v ?? null;

    downloadCsv(
      "ched-forms-with-ranking.csv",
      [...rowsToExport]
        .sort((a, b) =>
          (savedRankings.find((r) => r.application_id === a.application_id)?.ranking_position ?? 9999) -
          (savedRankings.find((r) => r.application_id === b.application_id)?.ranking_position ?? 9999))
        .map((c: ChedForm) => {
          const app = unwrap(c.scholarship_applications);
          const sp = unwrap(app?.scholarship_programs);
          const sa = unwrap(app?.student_accounts);
          const saving = savedRankings.find((r) => r.application_id === c.application_id);
          const live = rankedByApp.get(c.application_id);
          const ocr = ocrByApp.get(c.application_id);

          const incomeUsed = live?.income_used ?? ocr?.income_used ?? null;
          const incomeSource = live?.income_source ?? ocr?.income_source ?? null;
          const incomeDelta = live?.income_delta ?? ocr?.income_delta ?? null;
          const ocrPct = live?.ocr_match_pct ?? ocr?.match?.align_pct ?? null;
          const ocrStatus = live?.ocr_status ?? ocr?.match?.status ?? null;
          const needScore = live?.financial_need_score ?? ocr?.need_score ?? null;
          return {
            // --- ranking result (the executed ranking) ---
            rank: val(saving?.ranking_position),
            priority_score: val(saving?.priority_score),
            prediction: val(saving?.prediction_result),
            ranking_generated: val(saving?.generated_date?.slice(0, 19).replace("T", " ")),
            "high_need_probability": val(live?.probability ?? "-"),

            // --- applicant (CHED form input - every table column) ---
            ched_form_id: val(c.ched_form_id),
            application_id: val(c.application_id),
            student_number: val(sa?.student_number ?? c.student_id),
            last_name: val(sa?.last_name ?? c.last_name),
            given_name: val(sa?.given_name ?? c.given_name),
            middle_name: val(sa?.middle_name ?? c.middle_name),
            ext_name: val(sa?.ext_name ?? c.ext_name),
            sex: val(sa?.sex ?? c.sex),
            birthdate: val(sa?.birthdate ?? c.birthdate),
            program: val(sa?.program_name ?? c.complete_program_name),
            year_level: val(sa?.year_level ?? c.year_level),
            father_name: val(c.father_name),
            mother_name: val(c.mother_name),
            street_barangay: val(c.street_barangay),
            zipcode: val(c.zipcode),
            disability: val(c.disability),
            indigenous_people_group: val(c.indigenous_people_group),
            contact_number: val(c.contact_number),
            email_address: val(c.email_address),
            shs_gwa: val(c.shs_gwa),
            college_gpa: val(c.college_gpa),
            form_submitted: val((c.created_at || "").slice(0, 10)),

            // --- application context ---
            scholarship_name: val(sp?.scholarship_name),
            application_status: val(app?.application_status),
            application_date: val((app?.application_date || "").slice(0, 10)),

            // --- OCR of the uploaded ITR (data preprocessing) ---
            itr_uploaded: c.income_tax_return ? "Yes" : "No",
            itr_file_path: val(c.income_tax_return),
            declared_income: pesoVal(c.annual_income_family),
            ocr_income: pesoVal(ocr?.ocr_value ?? live?.ocr_income),
            ocr_match_pct: val(ocrPct),
            ocr_match_status: val(ocrStatus),
            ocr_confidence: val(ocr?.confidence),
            extraction_method: val(ocr?.method ?? live?.income_source),
            income_delta: val(incomeDelta != null ? Number(incomeDelta) : null),
            income_used: pesoVal(incomeUsed),
            income_source: val(incomeSource),
            financial_need_score: val(needScore),
          };
        }),
    );
    setMessage(`Exported ${rowsToExport.length} CHED form(s) with their executed ranking, OCR and preprocessing details (no empty cells).`);
    toast.success(`Exported ${rowsToExport.length} ranked CHED form(s).`);
  }

  function exportRankedCsv() {
    if (!ranked.length) { setError("Run the ranking first."); return; }
    downloadCsv("ai-ranking.csv", ranked.map((r, i) => ({
      rank: i + 1,
      application_id: r.application_id,
      student_name: r.student_name,
      student_number: r.student_number,
      scholarship: r.scholarship,
      program: r.program ?? "",
      declared_income: r.declared_income ?? "",
      ocr_income: r.ocr_income ?? "",
      income_used: r.income_used ?? r.declared_income ?? "",
      income_source: r.income_source ?? "",
      income_delta: r.income_delta ?? "",
      ocr_match_pct: r.ocr_match_pct ?? "",
      ocr_status: r.ocr_status,
      itr_trust: r.itr_trust ?? "",
      financial_need_score: r.financial_need_score,
      priority_score: r.priority_score,
      prediction: r.prediction,
      probability: r.probability ?? "",
      year_level: r.year_level ?? "",
      sex: r.sex ?? "",
      itr_path: r.itr_path ?? "",
    })));
    setMessage(`Exported AI ranking CSV (${ranked.length} row(s)).`);
    toast.success(`Exported AI ranking CSV (${ranked.length} row(s)).`);
  }

  function handleProgramChange(value: string) {
    const id = value ? Number(value) : null;
    setSelectedProgramId(id);
    setRanked([]);
    setDocs([]);
    setOcrAnalytics(null);
    setTrainInfo(null);
    setLogLines([]);
    setProgress({ done: 0, total: 0 });
    setExpanded(null);
    setMessage("");
    setError("");
  }

  if (loading) return <Spinner label="Loading ranking data..." color="maroon" />;

  const phaseLabel: Record<Phase, string> = {
    scanning: "AI OCR is reading the uploaded ITR images",
    training: "Training the Random Forest classifier and regressor",
    ranking: "Ranking applicants by financial need",
    saving: "Saving the ranking for CHED review",
  };
  const isOcrOnlyRun = lastRun?.mode === "scan" || busy === "scan";
  const liveRankedRows = ranked.filter((row) => !row.savedResultOnly);
  const declaredIncomeValues = liveRankedRows.map((row) => row.declared_income);
  const ocrIncomeValues = liveRankedRows.map((row) => row.ocr_income);
  const declaredIncomeCount = declaredIncomeValues.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  ).length;
  const rankedIncomeBins = incomeDistribution(declaredIncomeValues);
  const ocrIncomeBins = incomeDistribution(ocrIncomeValues);
  const maxRankedIncomePct = Math.max(
    ...rankedIncomeBins.map((bin) => bin.pct),
    ...ocrIncomeBins.map((bin) => bin.pct),
    1,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Machine Learning Ranking</h1>
          <p className="mt-1 text-xs text-[#8B7376]">
            OCR &middot; scikit-learn &middot; Supabase &mdash; scans every ITR, then ranks the applicants.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={exportChedFormsCsv}
            disabled={!chedForms.length}
            className="rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-40"
          >
            &#11015; Export CHED Forms CSV
          </button>
          <button
            onClick={deleteSavedRanking}
            disabled={savedBusy || !savedCount}
            className="rounded-xl border border-red-200 px-4 py-2.5 text-xs font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-40"
            title={savedCount ? "Deletes the ranking saved in the database (Admin only)" : "There is no saved ranking in the database"}
          >
            &#128465; {savedBusy ? "Deleting..." : savedCount ? `Delete saved ranking (${savedCount})` : "Delete saved ranking"}
          </button>
        </div>
      </div>

      {message && (
        <div className="flex items-start gap-2 rounded-xl border border-[#7B1113]/20 bg-[#7B1113]/[0.04] px-4 py-3 text-xs font-medium text-[#7B1113] shadow-sm">
          <span className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#7B1113] text-[9px] font-bold text-white">&#10003;</span>
          {message}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
          <span className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white">!</span>
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
        {/* Card header - same shape as Documents Viewer: title + counts on the
            left, the program <select> on the right where its student select sits. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
          <div>
            <p className="text-sm font-bold text-[#241012]">AI OCR + Random Forest Ranking</p>
            <p className="mt-0.5 text-[11px] text-[#6B5458]">
              OCR reads each ITR linked to this program&rsquo;s applicants, then the trained Random Forest ranks them &middot;{" "}
              <span className="font-semibold text-[#7B1113]">Highest predicted priority ranks first; lower income breaks ties</span>
              {selectedProgramId && (
                <>
                  {" \u00b7 "}
                  <span className="font-semibold text-emerald-700">
                    {pendingByProgram[selectedProgramId] || 0} pending ready
                  </span>
                </>
              )}
            </p>
          </div>
          <label className="text-xs font-semibold text-[#241012]">
            Step 1 &middot; Scholarship program <span className="text-[#7B1113]">*</span>
            <select
              value={selectedProgramId ?? ""}
              onChange={(e) => handleProgramChange(e.target.value)}
              disabled={!!busy}
              className="mt-1 block w-full rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10 disabled:cursor-not-allowed disabled:bg-[#F3EEEB] sm:min-w-[340px]"
            >
              <option value="">Choose a scholarship program...</option>
              {programs.map((p) => (
                <option key={p.scholarship_id} value={p.scholarship_id}>
                  {p.scholarship_name} ({pendingByProgram[p.scholarship_id] || 0} pending)
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Control row - Step 2 runs the pipeline. Delete / Export moved up to the
            page header so this row stays one clean line. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-3">
          <span
            className="inline-flex h-6 items-center rounded-full border border-red-300 bg-red-50 px-3 text-[10px] font-bold text-red-700"
            title="Admin prepares the ranking - only CHED users can give the final Approve / Not Approve decision"
          >
            Final approve: CHED only
          </span>
          <span className="inline-flex h-6 items-center rounded-full bg-[#241012]/[0.06] px-2.5 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">
            Step 2
          </span>
          <button
            onClick={() => runPipeline(selectedProgramId ? "rank" : "train")}
            disabled={
              !!busy ||
              (selectedProgramId
                ? !pendingByProgram[selectedProgramId]
                : !histFile)
            }
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
            title={
              selectedProgramId
                ? histFile
                  ? "Scans this program's ITRs, trains a fresh model from the uploaded file only, then ranks applicants with that same model."
                  : "Runs the OCR scan of every ITR, then the Random Forest ranking."
                : histFile
                  ? "Runs file-only training and displays training analytics; choose a program afterward to scan ITRs and rank applicants."
                  : "Upload a training file or choose a scholarship program."
            }
          >
            <span aria-hidden>&#9654;</span>
            {busy === "rank"
              ? histFile
                ? "Training file + ranking..."
                : "Executing OCR + Random Forest..."
              : busy === "train"
                ? "Training uploaded data..."
                : selectedProgramId
                  ? histFile
                    ? `Train file + Execute AI Ranking (${pendingByProgram[selectedProgramId] || 0})`
                    : `Execute AI Ranking (${pendingByProgram[selectedProgramId] || 0} pending)`
                  : histFile
                    ? "Execute Training Data"
                    : "Upload training data or select a program"}
          </button>
          <span className="ml-auto text-[11px] text-[#6B5458]">
            {selectedProgramId ? (
              <>
                {histFile
                  ? <>Trains on the uploaded file, scans &amp; ranks <b className="text-[#7B1113]">{pendingByProgram[selectedProgramId] || 0}</b> pending application(s) of this program.</>
                  : <>Scans &amp; ranks only <b className="text-[#7B1113]">{pendingByProgram[selectedProgramId] || 0}</b> pending application(s) of this program.</>}
              </>
            ) : histFile ? (
              <>No program selected: this runs uploaded-file training and its analytics only. Choose a program afterward to run OCR + applicant ranking.</>
            ) : (
              <>
                <b className="text-[#7B1113]">{pendingCount}</b> pending application(s) across all programs &mdash;
                upload the training file or pick a program in Step 1.
              </>
            )}
          </span>
        </div>

        {/* How it works - three short rules instead of a wall of text. */}
        <div className="bg-white px-5 py-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[#7B1113]">How this ranking works</p>
          <div className="grid gap-2 text-[11px] leading-5 text-[#6B5458] sm:grid-cols-3">
            <p className="rounded-lg bg-[#FAF7F5]/70 px-3 py-2">
              <b className="text-[#241012]">1. Trained model decides priority</b>
              <br />
              The Colab-aligned Random Forest predicts priority from the five TOINC-derived income features.
            </p>
            <p className="rounded-lg bg-[#FAF7F5]/70 px-3 py-2">
              <b className="text-[#241012]">2. Declared income is the model input</b>
              <br />
              OCR reads the ITR and compares it with the entered annual income; it flags differences but does not replace the input.
            </p>
            <p className="rounded-lg bg-[#FAF7F5]/70 px-3 py-2">
              <b className="text-[#241012]">3. OCR is an audit check</b>
              <br />
              Highest model-predicted priority ranks first; declared income breaks probability ties. OCR match is shown for review.
            </p>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-[#6B5458]">
            <b className="text-[#7B1113]">Official note:</b> Admin runs the OCR + Random Forest and prepares the CHED
            forms &mdash; <b className="text-[#241012]">the final Approve / Not Approve decision is CHED only</b>.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
          <div>
            <p className="text-sm font-bold text-[#241012]">Machine learning train data</p>
            <p className="mt-0.5 text-[11px] text-[#6B5458]">
              Upload the PSA FIES workbook (or the school&rsquo;s past applications). With no program selected,
              the main action runs file-only training and shows its analytics. With a program selected, the main
              action trains from <b className="text-[#241012]">this uploaded file only</b>, scans linked ITRs,
              then ranks those applicants using that same freshly-trained model.
              <b className="text-[#241012]"> The separate Execute Training Data button remains available for training-only runs.</b>
              <br />
              Reads <code className="rounded bg-[#241012]/[0.05] px-1">TOINC</code> (annual family income) &rarr; 5 features,
              target <code className="rounded bg-[#241012]/[0.05] px-1">NPCINC &le; 4</code>. Both columns and valid values on every row are required for Colab-aligned training.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => runPipeline("train")}
              disabled={!!busy || !histFile}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
              title={
                histFile
                  ? "Trains the Random Forest directly on your uploaded file, then deploys that model for the main Execute AI Ranking (OCR + ITR / annual income) - no program selection needed"
                  : "Upload a CSV / Excel file first - it becomes the training set for the deployed model."
              }
            >
              <span aria-hidden>&#9654;</span>
              {busy === "train" ? "Training data..." : "Execute Training Data"}
            </button>
            <input
              ref={histInputRef}
              type="file"
              accept=".csv,.xlsx"
              aria-label="Upload training CSV or Excel file"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadHistFile(f);
              }}
            />
            <button
              onClick={() => histInputRef.current?.click()}
              disabled={histBusy}
              className="rounded-xl bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:bg-[#540111] disabled:opacity-50"
            >
              {histBusy ? "Saving..." : histFile ? "Replace file" : "Upload CSV / Excel"}
            </button>
            {histFile && (
              <button
                onClick={removeHistFile}
                disabled={histBusy}
                className="rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <div className="bg-[#FAF7F5]/60 px-5 py-2.5 text-[11px] leading-5 text-[#6B5458]">
          {histError ? (
            <span className="font-semibold text-red-600">{histError}</span>
          ) : histFile ? (
            <span>
              Using <b className="text-[#241012]">{histFile.name}</b> ({Math.max(1, Math.round(histFile.size / 1024))} KB)
              {histFile.updated_at ? ` \u00b7 updated ${new Date(histFile.updated_at).toLocaleDateString("en-PH")}` : ""}
              {" \u00b7 "}used to train the model; with a program selected, the main action trains from this file and ranks applicants in the same run{" "}
              <span className="text-[#7B1113]">
                &mdash; watch the scan log for &quot;Loaded N historical training row(s)&quot; to confirm this file was read.
              </span>
            </span>
          ) : (
            <span>
              No file uploaded &mdash; the bundled sample ({trainInfo?.n_csv ?? 20} rows) is used. The file is optional;
              training still runs without it.
            </span>
          )}
        </div>
      </div>

      {(ocrAnalytics || trainInfo) && (
        <div className="grid gap-3 lg:grid-cols-2" aria-label="Training and ranking analytics">
          {trainInfo && (
            <section className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/70 px-4 py-3">
                <div>
                  <h2 className="text-xs font-extrabold uppercase tracking-wide text-[#7B1113]">Training data + model analytics</h2>
                  <p className="mt-0.5 text-[10px] text-[#6B5458]">
                    {trainInfo.external ? "Loaded trained model" : "Model trained in this run"} &middot; {trainInfo.n_trees} trees &middot; seed {trainInfo.seed}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wide ${
                  trainInfo.persisted ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-100 text-amber-800"
                }`}>
                  {trainInfo.persisted ? "saved model" : "runtime model"}
                </span>
              </div>
              <div className="space-y-3 p-4 text-[11px] leading-5 text-[#6B5458]">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Training rows</p>
                    <p className="font-extrabold text-[#241012]">{trainInfo.n_samples.toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Uploaded rows</p>
                    <p className="font-extrabold text-[#241012]">{(trainInfo.n_csv ?? 0).toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Income available</p>
                    <p className="font-extrabold text-[#241012]">
                      {trainInfo.dataset
                        ? `${trainInfo.dataset.with_income.toLocaleString()}/${trainInfo.dataset.total.toLocaleString()}`
                        : "\u2014"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Observed labels</p>
                    <p className="font-extrabold text-[#241012]">
                      {trainInfo.dataset?.label_sources?.observed_npcinc.toLocaleString() ?? "\u2014"}
                    </p>
                    <p>NPCINC target rows</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Priority class</p>
                    <p className="font-extrabold text-[#241012]">
                      {trainInfo.dataset?.target_classes
                        ? `${trainInfo.dataset.target_classes.priority.toLocaleString()} / ${trainInfo.dataset.target_classes.not_priority.toLocaleString()}`
                        : "\u2014"}
                    </p>
                    <p>priority / not priority</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Holdout rows</p>
                    <p className="font-extrabold text-[#241012]">
                      {trainInfo.evaluation?.available ? trainInfo.evaluation.n_test.toLocaleString() : "Not evaluated"}
                    </p>
                  </div>
                </div>
                <div className="rounded-lg border border-[#241012]/[0.07] px-3 py-2">
                  <p className="font-semibold text-[#241012]">Model identity</p>
                  {trainInfo.model_id ? (
                    <code className="break-all text-[10px]">ID: {trainInfo.model_id}</code>
                  ) : (
                    <p className="font-semibold text-amber-800">
                      This older model has no saved ID, so a link to a specific training run cannot be confirmed.
                    </p>
                  )}
                  {trainInfo.trained_at && <p>Trained: {trainInfo.trained_at}</p>}
                  <p>
                    {trainInfo.feature_columns?.length ?? 0} input features &middot; {trainInfo.model_size_kb.toLocaleString()} KB
                    {trainInfo.model_params && (
                      <>
                        {" \u00b7 "}max depth {trainInfo.model_params.max_depth ?? "unlimited"}
                        {" \u00b7 "}min leaf {trainInfo.model_params.min_samples_leaf ?? "\u2014"}
                        {" \u00b7 "}min split {trainInfo.model_params.min_samples_split ?? "\u2014"}
                      </>
                    )}
                  </p>
                </div>
                <div>
                  <p className="mb-1 font-semibold text-[#241012]">Holdout evaluation</p>
                  {trainInfo.evaluation?.available ? (
                    <>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      <span>Observed NPCINC &le; 4 labels</span>
                      <span>Accuracy <b className="text-[#241012]">{fpct(trainInfo.accuracy, 1)}</b></span>
                      <span>Precision <b className="text-[#241012]">{fpct(trainInfo.precision, 1)}</b></span>
                      <span>Recall <b className="text-[#241012]">{fpct(trainInfo.recall, 1)}</b></span>
                      <span>F1 <b className="text-[#241012]">{fpct(trainInfo.f1, 1)}</b></span>
                      <span>ROC-AUC <b className="text-[#241012]">{fpct(trainInfo.roc_auc, 1)}</b></span>
                    </div>
                    {trainInfo.confusion_matrix && (
                      <p className="mt-1">
                        Confusion matrix (actual rows: not-priority, priority; columns: predicted not-priority, priority):{" "}
                        <b className="text-[#241012]">
                          [[{trainInfo.confusion_matrix[0]?.join(", ") ?? "\u2014"}], [{trainInfo.confusion_matrix[1]?.join(", ") ?? "\u2014"}]]
                        </b>
                      </p>
                    )}
                    </>
                  ) : (
                    <p className="font-semibold text-amber-800">
                      No observed NPCINC holdout labels; model-quality metrics are not available.
                    </p>
                  )}
                </div>
                {trainInfo.dataset && (
                  <div className="border-t border-[#241012]/[0.07] pt-2">
                    <p>
                      Data used: {trainInfo.dataset.sources.csv.toLocaleString()} uploaded &middot;{" "}
                      {trainInfo.dataset.sources.synthetic.toLocaleString()} generated &middot;{" "}
                      {trainInfo.dataset.sources.real.toLocaleString()} applicant rows
                      {trainInfo.dataset.label_sources && (
                        <> &middot; {trainInfo.dataset.label_sources.derived_proxy.toLocaleString()} proxy-labeled rows</>
                      )}
                    </p>
                    <p>
                      Training labels: {trainInfo.dataset.label_sources?.observed_npcinc.toLocaleString() ?? "\u2014"} observed NPCINC
                      {" \u00b7 "}{trainInfo.dataset.label_sources?.derived_proxy.toLocaleString() ?? "\u2014"} proxy labels
                    </p>
                    {trainInfo.dataset.income && (
                      <p>
                        Annual family income min <b className="text-[#241012]">{peso(trainInfo.dataset.income.min)}</b>
                        {" \u00b7 "}mean <b className="text-[#241012]">{peso(trainInfo.dataset.income.mean)}</b>
                        {" \u00b7 "}p25 <b className="text-[#241012]">{peso(trainInfo.dataset.income.p25)}</b>
                        {" \u00b7 "}median <b className="text-[#241012]">{peso(trainInfo.dataset.income.median)}</b>
                        {" \u00b7 "}p75 <b className="text-[#241012]">{peso(trainInfo.dataset.income.p75)}</b>
                        {" \u00b7 "}max <b className="text-[#241012]">{peso(trainInfo.dataset.income.max)}</b>
                      </p>
                    )}
                    {trainInfo.dataset.priority_flags && (
                      <p className="mt-1">
                        Priority flags in training rows:{" "}
                        {Object.entries(trainInfo.dataset.priority_flags)
                          .map(([name, count]) => `${name.replace(/_/g, " ")} ${count.toLocaleString()}`)
                          .join(" \u00b7 ")}
                      </p>
                    )}
                    {trainInfo.dataset.need_mean != null && (
                      <p>
                        Mean training financial-need score: <b className="text-[#241012]">{trainInfo.dataset.need_mean.toFixed(1)}/100</b>
                      </p>
                    )}
                    {trainInfo.dataset.histogram && trainInfo.dataset.histogram.length > 0 && (
                      <div className="mt-2 flex items-end gap-1" aria-label="Training income distribution">
                        {(() => {
                          const hist = trainInfo.dataset!.histogram!;
                          const maxPct = Math.max(...hist.map((bin) => bin.pct), 1);
                          return hist.map((bin) => (
                            <span
                              key={bin.label}
                              className="flex w-9 flex-col items-center gap-0.5"
                              title={`${bin.label}: ${bin.count} rows (${bin.pct}%)`}
                            >
                              <span className="text-[9px] font-semibold">{bin.count}</span>
                              <span
                                className="w-full rounded-t bg-[#7B1113]/70"
                                style={{ height: `${Math.max(4, Math.round((bin.pct / maxPct) * 26))}px` }}
                              />
                              <span className="whitespace-nowrap text-[8px] leading-none">{bin.label}</span>
                            </span>
                          ));
                        })()}
                      </div>
                    )}
                  </div>
                )}
                {Object.keys(trainInfo.feature_importance || {}).length > 0 && (
                  <div className="border-t border-[#241012]/[0.07] pt-2">
                    <p className="mb-1 font-semibold text-[#241012]">Feature importance (trained forest)</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {Object.entries(trainInfo.feature_importance)
                        .sort((a, b) => b[1] - a[1])
                        .map(([name, value]) => (
                          <span key={name}>
                            {name.replace(/_/g, " ")} <b className="text-[#241012]">{(value * 100).toFixed(1)}%</b>
                          </span>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {ocrAnalytics && (
            <section className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/70 px-4 py-3">
                <div>
                  <h2 className="text-xs font-extrabold uppercase tracking-wide text-[#7B1113]">AI ranking + ITR/OCR analytics</h2>
                  <p className="mt-0.5 text-[10px] text-[#6B5458]">
                    {ocrAnalytics.documents_scanned.toLocaleString()} scanned ITR(s) &middot;{" "}
                    {ocrAnalytics.linked_to_application.toLocaleString()} linked application(s) &middot;{" "}
                    {ocrAnalytics.skipped_documents.toLocaleString()} skipped &middot;{" "}
                    {ocrAnalytics.scan_seconds > 0 ? `${ocrAnalytics.scan_seconds.toFixed(1)}s` : "cached"}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wide ${
                  trainInfo?.model_id
                    ? "bg-emerald-500/10 text-emerald-700"
                    : isOcrOnlyRun
                      ? "bg-[#241012]/[0.06] text-[#6B5458]"
                      : "bg-amber-100 text-amber-800"
                }`}>
                  {trainInfo?.model_id
                    ? "model link confirmed"
                    : isOcrOnlyRun
                      ? "OCR scan only"
                      : "model link not confirmed"}
                </span>
              </div>
              <div className="space-y-3 p-4 text-[11px] leading-5 text-[#6B5458]">
                {trainInfo?.model_id ? (
                  <div className="rounded-lg border border-emerald-700/20 bg-emerald-50/60 px-3 py-2">
                    <p className="font-semibold text-[#241012]">Same model ID as the training analytics</p>
                    <code className="break-all text-[10px]">{trainInfo.model_id}</code>
                  </div>
                ) : isOcrOnlyRun ? (
                  <p className="rounded-lg border border-[#241012]/[0.07] bg-[#FAF7F5] px-3 py-2">
                    This run scanned ITRs only; no AI ranking model was used.
                  </p>
                ) : (
                  <p className="rounded-lg border border-amber-700/20 bg-amber-50 px-3 py-2 font-semibold text-amber-900">
                    The ranking run has no model ID, so it cannot be verified against a specific training result.
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">ITR income detected</p>
                    <p className="font-extrabold text-[#241012]">{ocrAnalytics.income_detected}/{ocrAnalytics.documents_scanned}</p>
                    <p>{pct(ocrAnalytics.detection_rate_pct)}</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Declared income received</p>
                    <p className="font-extrabold text-[#241012]">{ocrAnalytics.declared_income_available}/{ocrAnalytics.linked_to_application}</p>
                    <p>Linked scanned applications</p>
                  </div>
                  <div className={`rounded-lg p-2 ${ocrAnalytics.scan_failures ? "bg-red-50" : "bg-[#FAF7F5]"}`}>
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">OCR scan errors</p>
                    <p className={`font-extrabold ${ocrAnalytics.scan_failures ? "text-red-700" : "text-[#241012]"}`}>{ocrAnalytics.scan_failures}</p>
                    <p>{ocrAnalytics.income_not_detected} scanned, no income read</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Compared</p>
                    <p className="font-extrabold text-[#241012]">{ocrAnalytics.comparable}</p>
                    <p>OCR read + declared income</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Exact matches</p>
                    <p className="font-extrabold text-[#241012]">{ocrAnalytics.exact_matches}/{ocrAnalytics.comparable}</p>
                    <p>Exact match rate {pct(ocrAnalytics.match_rate_pct)}</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Mismatches</p>
                    <p className="font-extrabold text-[#241012]">{ocrAnalytics.mismatches}</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Average income alignment</p>
                    <p className="font-extrabold text-[#241012]">{pct(ocrAnalytics.typed_accuracy_pct ?? ocrAnalytics.avg_align_pct)}</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Mean OCR confidence</p>
                    <p className="font-extrabold text-[#241012]">
                      {ocrAnalytics.avg_confidence == null ? "No OCR text" : pct(ocrAnalytics.avg_confidence * 100)}
                    </p>
                    <p>Detected text lines</p>
                  </div>
                  <div className="rounded-lg bg-[#FAF7F5] p-2">
                    <p className="text-[9px] font-bold uppercase text-[#8B7376]">Income-read confidence</p>
                    <p className="font-extrabold text-[#241012]">
                      {ocrAnalytics.income_confidence_mean == null ? "\u2014" : pct(ocrAnalytics.income_confidence_mean * 100)}
                    </p>
                    <p>Only documents with an extracted income</p>
                  </div>
                </div>
                <div className="rounded-lg border border-[#241012]/[0.07] p-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <p className="font-semibold text-[#241012]">Applicant annual family income distribution</p>
                    <p>Declared income: {declaredIncomeCount}/{liveRankedRows.length} &middot; OCR income: {ocrAnalytics.income_detected}</p>
                  </div>
                  {liveRankedRows.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {[
                        { label: "Declared/model input", bins: rankedIncomeBins, color: "bg-[#7B1113]/75" },
                        { label: "ITR OCR read", bins: ocrIncomeBins, color: "bg-emerald-600/75" },
                      ].map((series) => (
                        <div key={series.label}>
                          <p className="mb-1 text-[10px] font-semibold">{series.label}</p>
                          <div className="flex items-end gap-1">
                            {series.bins.map((bin) => (
                              <div key={bin.label} className="flex min-w-0 flex-1 flex-col items-center gap-0.5" title={`${bin.label}: ${bin.count} applicants`}>
                                <span className="text-[9px] font-semibold text-[#241012]">{bin.count}</span>
                                <span className={`w-full rounded-t ${series.color}`} style={{ height: `${Math.max(3, Math.round((bin.pct / maxRankedIncomePct) * 32))}px` }} />
                                <span className="whitespace-nowrap text-[8px]">{bin.label}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-amber-800">Ranking applicant income details were not saved or are unavailable in this run.</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] pt-2">
                  <span>Applicants ranked <b className="text-[#241012]">{liveRankedRows.length}</b></span>
                  <span>High need <b className="text-[#241012]">{liveRankedRows.filter((row) => row.prediction === "High Need").length}</b></span>
                  <span>Low need <b className="text-[#241012]">{liveRankedRows.filter((row) => row.prediction === "Low Need").length}</b></span>
                  <span>Mean model priority <b className="text-[#241012]">
                    {liveRankedRows.length
                      ? `${(liveRankedRows.reduce((total, row) => total + row.priority_score, 0) / liveRankedRows.length).toFixed(1)}%`
                      : "\u2014"}
                  </b></span>
                  <span>Average probability <b className="text-[#241012]">
                    {(() => {
                      const probabilities = liveRankedRows
                        .map((row) => row.probability)
                        .filter((probability): probability is number => probability != null);
                      return probabilities.length
                        ? fpct(probabilities.reduce((total, probability) => total + probability, 0) / probabilities.length)
                        : "\u2014";
                    })()}
                  </b></span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] pt-2">
                  <span>Documents in bucket <b className="text-[#241012]">{ocrAnalytics.documents_in_bucket}</b></span>
                  <span>Unlinked <b className="text-[#241012]">{ocrAnalytics.unlinked}</b></span>
                  <span>OCR cache hits <b className="text-[#241012]">{ocrAnalytics.cache_hits ?? 0}</b></span>
                  <span>OCR time <b className="text-[#241012]">{(ocrAnalytics.total_ocr_ms / 1000).toFixed(1)}s</b></span>
                  <span>Engine load <b className="text-[#241012]">{(ocrAnalytics.engine_load_ms / 1000).toFixed(1)}s</b></span>
                  <span>Mean income-need score <b className="text-[#241012]">{ocrAnalytics.avg_need_score == null ? "\u2014" : `${ocrAnalytics.avg_need_score.toFixed(1)}/100`}</b></span>
                  <span>OCR engine <b className="text-[#241012]">{String(ocrAnalytics.engine.engine ?? "unavailable")}</b></span>
                  <span>Runtime <b className="text-[#241012]">{String(ocrAnalytics.engine.runtime ?? ocrAnalytics.engine.provider ?? ocrAnalytics.engine.status ?? "unavailable")}</b></span>
                  {ocrAnalytics.engine.provider != null && (
                    <span>Provider <b className="text-[#241012]">{String(ocrAnalytics.engine.provider)}</b></span>
                  )}
                </div>
                <p className="rounded-lg border border-[#241012]/[0.07] px-3 py-2">
                  <b className="text-[#241012]">Income connection:</b> the student&rsquo;s declared annual family income is the model input. OCR independently reads the ITR and compares the two; OCR does not silently replace the declared value. Per-applicant income and match percentages are shown in the ranking table and OCR audit export.
                </p>
              </div>
            </section>
          )}
        </div>
      )}

      {/* Training-data result: persists after the progress modal closes, so the
          admin keeps proof of what Execute Training Data produced - the model
          file, its holdout metrics, the full log, and a download button. */}
      {lastRun?.mode === "train" && (
        <div className="overflow-hidden rounded-2xl border border-[#7B1113]/20 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#7B1113]/15 bg-gradient-to-r from-[#7B1113]/[0.06] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">
                Training data result
                <span className={`ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  lastRun.trainInfo?.persisted ? "bg-emerald-500/10 text-emerald-700" : "bg-red-100 text-red-700"
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    lastRun.trainInfo?.persisted ? "bg-emerald-500" : "bg-red-500"
                  }`} />
                  {lastRun.trainInfo?.persisted ? "model saved" : "model not persisted"}
                </span>
              </p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                Fitted on <b className="text-[#241012]">{histFile?.name || "the uploaded file"}</b>
                {lastRun.trainInfo ? ` \u00b7 ${lastRun.trainInfo.n_samples.toLocaleString()} rows \u00b7 ${lastRun.trainInfo.n_trees} trees` : ""}
                {" \u00b7 "}finished {lastRun.finishedAt}
                {" \u00b7 "}
                <span className="font-semibold text-[#7B1113]">
                  {lastRun.trainInfo?.persisted
                    ? "this model is used automatically by Execute AI Ranking"
                    : "save to Storage must succeed before later rankings can reuse this model"}
                </span>
              </p>
              {lastRun.trainInfo?.model_id && (
                <p className="mt-1 text-[10px] text-[#6B5458]">
                  Model ID: <code className="break-all font-semibold text-[#241012]">{lastRun.trainInfo.model_id}</code>
                  {" \u00b7 "}compare this ID with the AI Ranking analytics to confirm the same model was used.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/ml/model"
                download="scholarship_rf_model.joblib"
                className="rounded-lg bg-[#7B1113] px-3.5 py-2 text-[11px] font-bold text-white hover:bg-[#540111]"
                title="Download the trained model (scholarship_rf_model.joblib)"
              >
                Download model
              </a>
              <button
                onClick={() => setShowTrainLog((v) => !v)}
                className="rounded-lg border border-[#7B1113]/30 px-3.5 py-2 text-[11px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
              >
                {showTrainLog ? "Hide logs" : "View logs"}
              </button>
            </div>
          </div>

          <div className="border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-3 text-[11px] leading-5 text-[#6B5458]">
            <b className="text-[#241012]">How to read these results:</b>{" "}
            {lastRun.trainInfo?.evaluation?.available
              ? `Metrics compare predictions against ${lastRun.trainInfo.evaluation.n_test.toLocaleString()} held-out records with observed NPCINC labels. They indicate agreement with those labels, not a guarantee for every applicant.`
              : "This run has no observed NPCINC labels, so genuine held-out model-quality metrics are unavailable. Proxy targets are not presented as accuracy."}
          </div>
          {/* Genuine holdout metrics are shown only for observed NPCINC labels. */}
          {lastRun.trainInfo && (
            <div className="grid grid-cols-2 gap-px border-b border-[#241012]/[0.07] bg-[#241012]/[0.07] sm:grid-cols-4">
              {[
                {
                  label: "Overall accuracy",
                  value: lastRun.trainInfo.evaluation?.available ? fpct(lastRun.trainInfo.accuracy, 1) : "Not evaluated",
                  title: "Percentage of held-out rows with observed NPCINC labels classified correctly.",
                },
                {
                  label: "Priority detection (F1)",
                  value: lastRun.trainInfo.evaluation?.available ? fpct(lastRun.trainInfo.f1, 1) : "Not evaluated",
                  title: "Balance between finding priority applicants and avoiding incorrect priority labels.",
                },
                {
                  label: "Ranking separation (ROC-AUC)",
                  value: lastRun.trainInfo.evaluation?.available
                    ? lastRun.trainInfo.roc_auc != null ? fpct(lastRun.trainInfo.roc_auc, 1) : "Unavailable"
                    : "Not evaluated",
                  title: "How well the model separates priority from non-priority rows. 50% is random; 100% is perfect.",
                },
                { label: "Deployed model", value: "scholarship_rf_model.joblib", title: "This model is used by Execute AI Ranking." },
              ].map((m) => (
                <div key={m.label} className="bg-white px-5 py-3">
                  <p className="text-[10px] font-extrabold uppercase tracking-wide text-[#6B5458]" title={m.title}>{m.label}</p>
                  <p className="mt-0.5 truncate text-sm font-bold text-[#241012]" title={m.value}>{m.value}</p>
                </div>
              ))}
            </div>
          )}

          {lastRun.trainInfo && Object.keys(lastRun.trainInfo.feature_importance || {}).length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#241012]/[0.07] px-5 py-2.5 text-[11px] text-[#6B5458]">
              <span
                className="text-[10px] font-extrabold uppercase tracking-wide text-[#7B1113]"
                title="The percentage shows how much each input contributed to the model's decisions."
              >
                Main factors used
              </span>
              {Object.entries(lastRun.trainInfo.feature_importance)
                .sort((a, b) => b[1] - a[1])
                .map(([name, value]) => (
                  <span key={name}>
                    {name.replace(/_/g, " ")} <b className="text-[#241012]">{(value * 100).toFixed(1)}%</b>
                  </span>
                ))}
            </div>
          )}

          {/* The full execution log, kept on screen as proof of the training run. */}
          {showTrainLog && (
            <div className="px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Execution log</p>
              <div className="mt-1.5 max-h-72 overflow-y-auto rounded-xl bg-[#241012] p-3 font-mono text-[10px] leading-relaxed text-[#F3E9EA]">
                {lastRun.logs.length === 0 && <p className="text-[#8B7376]">No log lines were captured.</p>}
                {lastRun.logs.map((line, i) => (
                  <p key={i} className={line.stderr ? "text-[#FF9A9A]" : undefined}>
                    {line.t != null ? <span className="text-[#8B7376]">[{line.t.toFixed(1)}s] </span> : null}
                    {line.msg}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {ranked.length === 0 ? (
        <EmptyState
          icon="&#129302;"
          title="No ranking generated yet"
          hint={
            histFile
              ? "With no program selected, click Execute Training Data to fit and evaluate the uploaded file. Select a program to train from that file, scan linked ITRs, and rank applicants in one run."
              : "Select a program, then click Execute AI Ranking — OCR scans only the ITRs linked to applicants in that program."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">
                AI Ranking Results
                {(() => {
                  // Proof of which model scored these applicants: the trained
                  // model from Execute Training Data, or a fresh local fit.
                  const ti = lastRun?.mode === "rank" ? lastRun.trainInfo : trainInfo;
                  const usedTrained = Boolean(ti?.external) || String(ti?.model_source || "") === "external";
                  return usedTrained ? (
                    <span
                      className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700"
                      title={ti?.model_path || "Trained model from Execute Training Data"}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      trained model used
                    </span>
                  ) : null;
                })()}
              </p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                {(() => {
                  const pname = programs.find((p) => p.scholarship_id === selectedProgramId)?.scholarship_name;
                  return pname ? `${pname} \u00b7 ` : "";
                })()}
                {ranked.length} applicant{ranked.length === 1 ? "" : "s"} ranked &middot;{" "}
                <span className="font-semibold text-[#7B1113]">Rank 1 = highest model-predicted priority</span>
                {" \u00b7 "}
                <span className="text-[#6B5458]">
                  {ranked.some((row) => row.savedResultOnly)
                    ? "saved ranking values restored from the database"
                    : "declared income feeds the model; OCR only checks it against the ITR"}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setShowRankLog((v) => !v)}
                className="rounded-lg border border-[#7B1113]/30 px-3.5 py-2 text-[11px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
                title="Show the execution log - the 'Using the externally trained model' line proves which model ranked these applicants"
              >
                {showRankLog ? "Hide logs" : "View logs"}
              </button>
              <button
                onClick={exportRankedCsv}
                className="rounded-lg bg-[#7B1113] px-3.5 py-2 text-[11px] font-bold text-white hover:bg-[#540111]"
              >
                Export AI Ranking CSV
              </button>
              <button
                onClick={exportOcrCsv}
                className="rounded-lg border border-[#7B1113]/30 px-3.5 py-2 text-[11px] font-bold text-[#7B1113] hover:bg-[#7B1113]/5"
              >
                Export OCR Audit CSV
              </button>
            </div>
          </div>

          {!lastRun && savedRankings.length > 0 && (
            <div className="border-b border-[#241012]/[0.07] bg-amber-50 px-5 py-2.5 text-[11px] leading-5 text-amber-900">
              Showing <b>{savedRankings.length}</b> ranking result(s) restored from the database
              {savedRankings[0]?.generated_date
                ? ` \u00b7 last saved ${new Date(savedRankings[0].generated_date).toLocaleString("en-PH")}`
                : ""}
              . Rank, priority score, prediction, and applicant details persist. OCR comparisons, full execution logs,
              and training analytics are not stored in the current ranking table.
            </div>
          )}

          {/* The execution log as proof of which model scored these rows -
              the "Using the externally trained model" line names the file. */}
          {showRankLog && (
            <div className="border-b border-[#241012]/[0.07] px-5 py-4">
              <p className="text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Execution log</p>
              <div className="mt-1.5 max-h-72 overflow-y-auto rounded-xl bg-[#241012] p-3 font-mono text-[10px] leading-relaxed text-[#F3E9EA]">
                {(lastRun?.mode === "rank" ? lastRun.logs : []).length === 0 && (
                  <p className="text-[#8B7376]">
                    Run Execute AI Ranking to capture this run&rsquo;s log. The line
                    &ldquo;Using the externally trained model&rdquo; names the model file that ranked these applicants.
                  </p>
                )}
                {(lastRun?.mode === "rank" ? lastRun.logs : []).map((line, i) => {
                  const proof = line.msg.indexOf("externally trained model") >= 0;
                  return (
                    <p key={i} className={line.stderr ? "text-[#FF9A9A]" : proof ? "text-[#8FE3B0] font-bold" : undefined}>
                      {line.t != null ? <span className="text-[#8B7376]">[{line.t.toFixed(1)}s] </span> : null}
                      {line.msg}
                    </p>
                  );
                })}
              </div>
            </div>
          )}

          {/* The table is wider than the card: a clearly visible scrollbar plus a
              right-edge fade make it obvious there are more columns (Prediction,
              ITR) to the right. */}
          <div className="relative">
            <div className="max-h-[70vh] overflow-auto [scrollbar-color:#7B111359_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:rounded-full [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#7B1113]/45 [&::-webkit-scrollbar-track]:bg-[#241012]/[0.04]">
            <table className="w-full min-w-[1120px] text-left text-xs">
              <thead className="sticky top-0 z-10 bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458] shadow-[0_1px_0_0_rgba(36,16,18,0.07)]">
                <tr>
                  <th className="px-4 py-3 font-bold">Rank</th>
                  <th className="px-4 py-3 font-bold">Student</th>
                  <th className="px-4 py-3 font-bold">Program</th>
                  <th className="px-4 py-3 font-bold">Year</th>
                  <th className="px-4 py-3 font-bold">Sex</th>
                  <th className="px-4 py-3 font-bold">Scholarship</th>
                  <th className="px-4 py-3 font-bold">Declared annual family income</th>
                  <th className="px-4 py-3 font-bold">ITR OCR income</th>
                  <th className="px-4 py-3 font-bold">OCR match</th>
                  <th className="px-4 py-3 font-bold">Financial need</th>
                  <th className="px-4 py-3 font-bold">Priority</th>
                  <th className="px-4 py-3 font-bold">Prediction</th>
                  <th className="px-4 py-3 font-bold">ITR</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r, i) => (
                  <RankRow
                    key={r.application_id ?? `file-row-${i}`}
                    row={r}
                    index={i}
                    expanded={expanded === r.application_id && r.application_id != null}
                    onToggle={() => setExpanded(expanded === r.application_id ? null : r.application_id)}
                    onViewItr={viewItr}
                  />
                ))}
              </tbody>
            </table>
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-white via-white/75 to-transparent"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5 text-[10px] text-[#6B5458]">
            <span>
              Average priority{" "}
              <b className="text-[#7B1113]">
                {(ranked.reduce((s, r) => s + r.priority_score, 0) / ranked.length).toFixed(1)}%
              </b>
            </span>
            <span>
              High need{" "}
              <b className="text-[#7B1113]">{ranked.filter((r) => r.prediction === "High Need").length}</b>
            </span>
            <span>
              OCR income differs{" "}
              <b className="text-[#7B1113]">
                {ranked.some((row) => row.savedResultOnly) ? "\u2014" : ranked.filter((r) => r.ocr_income_differs).length}
              </b>
            </span>
            <span className="ml-auto">
              {ranked.some((row) => row.savedResultOnly)
                ? "Saved OCR breakdown and model inputs are not available after refresh."
                : "Click any row to see the OCR breakdown and model inputs."}
            </span>
          </div>
        </div>
      )}

      {busy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-[#7B1113]/20 border-t-[#7B1113]" />
                <div>
                  <p className="text-sm font-bold text-[#241012]">
                    {busy === "train"
                      ? "Training the model on your uploaded file"
                      : busy === "scan"
                        ? "AI OCR is running"
                        : "AI OCR + Random Forest ranking is running"}
                  </p>
                  <p className="text-[11px] text-[#8B7376]">
                    {busy === "train" ? "Fitting the Random Forest (no OCR, no ranking)" : phaseLabel[phase]} &middot; {elapsed}s elapsed
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center">
                {(busy === "train"
                  ? (["preparing", "training", "deploying"] as string[])
                  : (["scanning", "training", "ranking", "saving"] as string[])
                ).map((step, i, arr) => {
                  const stepIndex =
                    busy === "train"
                      ? phase === "scanning"
                        ? 0
                        : phase === "training"
                          ? 1
                          : 2
                      : arr.indexOf(phase);
                  const done = i < stepIndex;
                  const active = i === stepIndex;
                  return (
                    <div key={step} className="flex flex-1 items-center last:flex-none">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ring-1 ${
                            done
                              ? "bg-[#7B1113] text-white ring-[#7B1113]"
                              : active
                                ? "bg-white text-[#7B1113] ring-[#7B1113] animate-pulse"
                                : "bg-white text-[#8B7376] ring-[#241012]/15"
                          }`}
                        >
                          {done ? "\u2713" : i + 1}
                        </span>
                        <span
                          className={`hidden text-[10px] font-semibold uppercase tracking-wide sm:inline ${
                            active ? "text-[#7B1113]" : done ? "text-[#241012]" : "text-[#8B7376]"
                          }`}
                        >
                          {step}
                        </span>
                      </div>
                      {i < arr.length - 1 && (
                        <span className={`mx-2 h-px flex-1 ${done ? "bg-[#7B1113]" : "bg-[#241012]/12"}`} />
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#7B1113]/10">
                <div
                  className="h-2 rounded-full bg-gradient-to-r from-[#7B1113] to-[#B01E28] transition-all"
                  style={{
                    width: progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : phase === "scanning" ? "35%" : "90%",
                  }}
                />
              </div>
              <p className="mt-1.5 text-[10px] text-[#6B5458]">
                {progress.total ? `${progress.done}/${progress.total} documents processed` : "Starting the pipeline..."}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {docs.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Documents</p>
                  {docs.map((d) => (
                    <div key={d.path} className="rounded-xl border border-[#241012]/[0.06] bg-white px-3 py-2.5 transition hover:border-[#7B1113]/25">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-2.5">
                          <span
                            className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] ring-1 ${
                              d.status === "done" && !d.error
                                ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                                : d.status === "error" || d.error
                                  ? "bg-red-50 text-red-600 ring-red-200"
                                  : d.status === "scanning"
                                    ? "bg-[#7B1113]/10 text-[#7B1113] ring-[#7B1113]/25 animate-pulse"
                                    : "bg-gray-50 text-gray-500 ring-gray-200"
                            }`}
                          >
                            {d.status === "done" && !d.error ? "\u2713" : d.status === "error" || d.error ? "!" : "\u2022"}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-[11px] font-semibold text-[#241012]">{d.path}</p>
                            <p className="text-[10px] text-[#8B7376]">
                              {d.student_name || "not linked to an application"}
                              {d.declared_income != null && ` \u00b7 declared ${peso(d.declared_income)}`}
                            </p>
                          </div>
                        </div>
                        <DocBadge doc={d} />
                      </div>
                      {d.ocr_value != null ? (
                        <div className="mt-1.5 space-y-0.5 rounded-lg bg-[#FAF7F5] px-2.5 py-1.5 text-[10px] text-[#6B5458]">
                          <p>
                            OCR read <b className="text-[#7B1113]">{peso(d.ocr_value)}</b>
                            {d.confidence ? ` \u00b7 confidence ${d.confidence.toFixed(3)}` : ""}
                            {d.cached ? " \u00b7 served from cache" : ""}
                          </p>
                          <p>
                            Typed-income accuracy:{" "}
                            <b className="text-[#7B1113]">{pct(d.accuracy_pct ?? d.match?.align_pct, 2)}</b>
                            {d.declared_income != null &&
                              ` \u00b7 typed ${peso(d.declared_income)} vs OCR ${peso(d.ocr_value)}`}
                            {d.income_delta != null &&
                              Math.abs(d.income_delta) > 0.5 &&
                              ` \u00b7 corrected ${d.income_delta > 0 ? "+" : ""}${peso(d.income_delta)}`}
                          </p>
                          <p>
                            Financial need score:{" "}
                            <b className="text-[#7B1113]">
                              {d.need_score != null ? d.need_score.toFixed(1) : "\u2014"}
                            </b>
                            {d.need_score != null &&
                              ` \u00b7 ${d.income_source?.startsWith("ocr") ? "from ITR income" : "from typed income"}`}
                          </p>
                        </div>
                      ) : (
                        <p className="mt-1.5 text-[10px] text-[#6B5458]">
                          {d.declared_income != null && `typed ${peso(d.declared_income)}`}
                          {d.skipped ? ` \u00b7 ${d.skipped}` : ""}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-4 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Execution log</p>
              <div
                ref={logRef}
                className="mt-1.5 h-56 overflow-y-auto rounded-xl bg-[#241012] p-3 font-mono text-[10px] leading-relaxed text-[#F3E9EA]"
              >
                {logLines.length === 0 && <p className="text-[#8B7376]">Waiting for the pipeline...</p>}
                {logLines.map((line, i) => (
                  <p key={i} className={line.stderr ? "text-[#FF9A9A]" : undefined}>
                    {line.t != null ? <span className="text-[#8B7376]">[{line.t.toFixed(1)}s] </span> : null}
                    {line.msg}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DocBadge({ doc }: { doc: DocUi }) {
  if (doc.status === "queued") {
    return <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">Queued</span>;
  }
  if (doc.status === "scanning") {
    return <span className="shrink-0 rounded-full bg-[#7B1113]/10 px-2 py-0.5 text-[10px] font-bold text-[#7B1113]">Scanning...</span>;
  }
  if (doc.status === "skipped" || doc.skipped) {
    return <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">Skipped</span>;
  }
  if (doc.status === "error" || doc.error) {
    return <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">No value</span>;
  }
  if (doc.match?.exact_match) {
    return <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">Exact match</span>;
  }
  if (doc.match?.status === "mismatch") {
    return <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">Mismatch {pct(doc.match.align_pct, 1)}</span>;
  }
  return <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">Done</span>;
}

function RankBadge({ index }: { index: number }) {
  const styles = [
    "bg-gradient-to-br from-[#FDE68A] to-[#D97706] text-[#5B3406] ring-1 ring-[#D97706]/40",
    "bg-gradient-to-br from-[#E5E7EB] to-[#9CA3AF] text-[#374151] ring-1 ring-gray-400/40",
    "bg-gradient-to-br from-[#FED7AA] to-[#C2703B] text-[#5B2E12] ring-1 ring-[#C2703B]/40",
  ];
  if (index < 3) {
    return (
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-extrabold shadow-sm ${styles[index]}`}>
        {index + 1}
      </span>
    );
  }
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#7B1113]/10 text-[11px] font-extrabold text-[#7B1113] ring-1 ring-[#7B1113]/20">
      {index + 1}
    </span>
  );
}

function ScoreMeter({ value, tone }: { value: number; tone: "priority" | "need" }) {
  const clamped = Math.max(0, Math.min(100, value));
  const fill =
    tone === "priority"
      ? "bg-gradient-to-r from-[#7B1113] to-[#B01E28]"
      : clamped >= 70
        ? "bg-gradient-to-r from-[#DC2626] to-[#F87171]"
        : clamped >= 40
          ? "bg-gradient-to-r from-[#D97706] to-[#FBBF24]"
          : "bg-gradient-to-r from-[#059669] to-[#34D399]";
  return (
    <div className="min-w-[86px]">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-bold ${tone === "priority" ? "text-[#7B1113]" : "text-[#241012]"}`}>
          {value.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#241012]/[0.08]">
        <div className={`h-1.5 rounded-full transition-all ${fill}`} style={{ width: `${Math.max(3, clamped)}%` }} />
      </div>
    </div>
  );
}

function RankRow({
  row,
  index,
  expanded,
  onToggle,
  onViewItr,
}: {
  row: RankedRow;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onViewItr: (path: string) => void;
}) {
  const predictionChip =
    row.prediction === "High Need"
      ? "bg-[#FEE2E2] text-[#B91C1C] ring-1 ring-[#DC2626]/30"
      : row.prediction === "Moderate Need"
        ? "bg-[#FEF3C7] text-[#92400E] ring-1 ring-[#D97706]/30"
        : "bg-[#D1FAE5] text-[#065F46] ring-1 ring-[#059669]/30";
  const trust: "verified" | "mismatch" | "unverified" | "no_itr" | "not_saved" =
    row.savedResultOnly ? "not_saved" : row.itr_trust ?? (row.itr_path ? "mismatch" : "no_itr");
  const matchChip =
    trust === "not_saved"
      ? { cls: "bg-gray-100 text-gray-600 ring-gray-300/50", dot: "bg-gray-400", text: "Details not saved", title: "The ranking row persisted, but OCR details are not part of the current ranking_result table" }
      : trust === "verified"
      ? { cls: "bg-[#D1FAE5] text-[#065F46] ring-[#059669]/30", dot: "bg-emerald-500", text: `${pct(row.ocr_match_pct, 1)} \u2713`, title: "Typed income matches the scanned ITR; the trained model ranks applicants" }
      : trust === "mismatch"
        ? { cls: "bg-[#FEF3C7] text-[#92400E] ring-[#D97706]/30", dot: "bg-amber-500", text: `${pct(row.ocr_match_pct, 1)} \u2717`, title: "Typed income differs from the ITR; OCR is an audit warning and does not change model input" }
        : trust === "unverified"
          ? { cls: "bg-gray-100 text-gray-600 ring-gray-300/50", dot: "bg-gray-400", text: "OCR unavailable", title: "An ITR was uploaded, but OCR could not read an income amount. Review the document; no match percentage is available." }
          : { cls: "bg-gray-100 text-gray-600 ring-gray-300/50", dot: "bg-gray-400", text: "No ITR", title: "No ITR uploaded; declared annual income is used when available" };
  const trustNote =
    trust === "not_saved"
      ? "OCR comparison was not stored with this ranking result"
      : trust === "verified"
      ? `Typed income matches the ITR (${pct(row.ocr_match_pct, 1)})`
      : trust === "mismatch"
        ? `Typed income differs from the ITR (${pct(row.ocr_match_pct, 1)}); declared income remains the model input`
        : trust === "unverified"
          ? "ITR uploaded, but OCR did not find an income amount to compare"
          : "No ITR uploaded; declared income is used when available";
  return (
    <>
      <tr
        className={`cursor-pointer border-t border-[#241012]/[0.05] transition-colors hover:bg-[#7B1113]/[0.04] ${
          index % 2 ? "bg-[#FAF9F8]" : "bg-white"
        } ${index === 0 ? "shadow-[inset_3px_0_0_0_#7B1113]" : ""}`}
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <RankBadge index={index} />
        </td>
        <td className="px-4 py-3">
          <div className="whitespace-nowrap font-semibold text-[#241012]">
            {row.student_name || `File row ${index + 1}`}
          </div>
          <div className="whitespace-nowrap text-[10px] text-[#8B7376]">
            {row.student_number || (row.application_id != null ? "\u2014" : "from uploaded training file")}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="max-w-[160px] truncate text-[#6B5458]" title={row.program || undefined}>
            {row.program || "\u2014"}
          </div>
        </td>
        <td className="px-4 py-3 text-[#6B5458]">{row.year_level || "\u2014"}</td>
        <td className="px-4 py-3 text-[#6B5458]">{row.sex || "\u2014"}</td>
        <td className="px-4 py-3 text-[#6B5458]">{row.scholarship}</td>
        <td className="whitespace-nowrap px-4 py-3">
          <div className="font-semibold text-[#7B1113]">{peso(row.declared_income ?? row.annual_income_family)}</div>
          <div className="text-[10px] text-[#8B7376]">
            {row.savedResultOnly
              ? "details not saved"
              : row.declared_income == null
                ? "not declared"
                : "student input · model income"}
          </div>
        </td>
        <td className="whitespace-nowrap px-4 py-3" title={row.ocr_error || undefined}>
          <div className={`font-semibold ${row.ocr_income == null ? "text-[#8B7376]" : "text-[#241012]"}`}>
            {peso(row.ocr_income)}
          </div>
          <div className="max-w-[170px] truncate text-[10px] text-[#8B7376]">
            {row.savedResultOnly
              ? "OCR details not saved"
              : row.ocr_income != null
                ? "amount read from ITR"
                : row.ocr_scan_failed && row.ocr_error
                  ? `scan failed: ${row.ocr_error}`
                  : row.itr_path
                    ? "income not detected"
                    : "no ITR uploaded"}
          </div>
        </td>
        <td className="px-4 py-3">
          <span
            title={matchChip.title}
            className={`inline-flex whitespace-nowrap items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${matchChip.cls}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${matchChip.dot}`} />
            {matchChip.text}
          </span>
        </td>
        <td className="px-4 py-3">
          {row.financial_need_score == null
            ? <span className="text-[#8B7376]">\u2014</span>
            : <ScoreMeter value={row.financial_need_score} tone="need" />}
        </td>
        <td className="px-4 py-3">
          <ScoreMeter value={row.priority_score} tone="priority" />
        </td>
        <td className="px-4 py-3">
          <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold ring-1 ${predictionChip}`}>
            {row.prediction}
          </span>
        </td>
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          {row.itr_path ? (
            <button
              onClick={() => onViewItr(row.itr_path!)}
              className="inline-flex whitespace-nowrap items-center gap-1 rounded-lg border border-[#7B1113]/25 px-2.5 py-1.5 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/10"
            >
              View ITR
            </button>
          ) : (
            <span className="text-[#8B7376]">None</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-[#241012]/[0.05] bg-[#FAF7F5]">
          <td colSpan={13} className="px-4 py-4">
            <div className="grid gap-3 text-[11px] md:grid-cols-3">
              <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-3.5">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">OCR result</p>
                <p className="flex justify-between gap-2 py-0.5">Declared income <b>{peso(row.declared_income)}</b></p>
                <p className="flex justify-between gap-2 py-0.5">OCR income <b>{peso(row.ocr_income)}</b></p>
                <p className="flex justify-between gap-2 py-0.5">
                  <span>Income used for ranking</span>
                  <b className="text-[#7B1113]">{peso(row.income_used ?? row.declared_income)}</b>
                </p>
                {row.ocr_income_differs && row.income_delta != null && (
                  <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-amber-700">
                    OCR differs by {row.income_delta > 0 ? "+" : ""}{peso(row.income_delta)} &mdash; shown for review; declared income remains the model input.
                  </p>
                )}
                <p className="flex justify-between gap-2 py-0.5">
                  <span>ITR check</span>
                  <b className={trust === "verified" ? "text-emerald-700" : trust === "mismatch" ? "text-amber-700" : "text-gray-500"}>
                    {trustNote}
                  </b>
                </p>
              </div>
              <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-3.5">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Model inputs</p>
                <p className="flex justify-between gap-2 py-0.5">
                  <span>Ranking basis</span>
                  <b className="text-[#7B1113]">Model priority probability</b>
                </p>
                <p className="flex justify-between gap-2 py-0.5">Financial need score <b>{row.financial_need_score?.toFixed(1) ?? "\u2014"}</b></p>
                <p className="flex justify-between gap-2 py-0.5">OCR match (audit only) <b>{row.ocr_status === "not_comparable" ? "\u2014" : row.ocr_match_pct?.toFixed(2) ?? "\u2014"}</b></p>
                <p className="flex justify-between gap-2 py-0.5">Priority score (predicted) <b className="text-[#7B1113]">{row.priority_score.toFixed(2)}</b></p>
                {row.probability != null && (
                  <p className="flex justify-between gap-2 py-0.5">P(high need) <b>{(row.probability * 100).toFixed(1)}%</b></p>
                )}
              </div>
              <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-3.5">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Applicant</p>
                <p className="flex justify-between gap-2 py-0.5">Program <b>{row.program || "\u2014"}</b></p>
                <p className="flex justify-between gap-2 py-0.5">Year level <b>{row.year_level || "\u2014"}</b></p>
                <p className="flex justify-between gap-2 py-0.5">Sex <b>{row.sex || "\u2014"}</b></p>
                <p className="mt-1 break-all rounded-lg bg-[#FAF7F5] px-2 py-1 text-[10px] text-[#6B5458]">
                  {row.itr_path || "No ITR uploaded yet"}
                </p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
