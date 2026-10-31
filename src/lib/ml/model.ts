/**
 * Random Forest Classifier for Scholarship Applicant Ranking (TypeScript).
 * The ranking is based ONLY on the applicant's annual family income, so
 * each applicant is represented by a single feature: annual_income.
 */
import { RandomForestClassifier } from "./random-forest";

const DEFAULT_SEED = 2026;

const FEATURE_COLUMNS = ["annual_income"] as const;

export type ModelFeatures = Record<(typeof FEATURE_COLUMNS)[number], number>;

export interface ParsedRow {
  columns: Record<string, string | number>;
}

/** Parse CSV text (clipboard) into rows keyed by normalized column names. */
export function parseClipboardCSV(csvText: string): ParsedRow[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!lines.length) return [];

  const header = splitCSVLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCSVLine(lines[i]);
    const row: Record<string, string | number> = {};
    header.forEach((h, j) => {
      const raw = cells[j]?.trim() ?? "";
      if (raw === "") return;
      row[h] = isNaN(Number(raw)) ? raw : Number(raw);
    });
    rows.push({ columns: row });
  }
  return rows;
}

function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function firstValue(row: Record<string, string | number>, ...keys: string[]): string | number | undefined {
  for (const k of keys) {
    if (k in row && row[k] !== "" && row[k] != null) return row[k];
  }
  return undefined;
}

function textOf(value: string | number | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function numOf(value: string | number | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}

/** Extract and encode the single model feature for one applicant row. */
export function prepareFeatures(row: Record<string, string | number>): ModelFeatures {
  const income = numOf(firstValue(row, "annual_income_family", "income", "annual_income"), 150000);
  return { annual_income: income };
}

/** Extract label (high_need) from a row. Falls back to income-based rule. */
export function prepareLabels(row: Record<string, string | number>): string {
  const label = firstValue(row, "high_need", "label", "need");
  if (label != null) {
    const l = textOf(label);
    if (["1", "yes", "high", "true"].includes(l)) return "1";
    if (["0", "no", "low", "false"].includes(l)) return "0";
    return "0";
  }
  const income = numOf(firstValue(row, "annual_income_family", "income", "annual_income"), 150000);
  return income < 150000 ? "1" : "0";
}

/** Generate synthetic training data based on annual income only. */
export function generateSyntheticData(n = 400, seed = DEFAULT_SEED): { X: ModelFeatures[]; y: string[] } {
  const rng = seededRandom(seed);
  const X: ModelFeatures[] = [];
  const y: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const income = Math.exp(Math.log(40000) + rng() * (Math.log(600000) - Math.log(40000)));
    let label = income < 150000 ? "1" : "0";
    if (rng() < 0.05) label = label === "1" ? "0" : "1";
    X.push({ annual_income: income });
    y.push(label);
  }
  return { X, y };
}

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-memory trained model store (analogous to the .pkl files). */
let trainedModel: RandomForestClassifier | null = null;
let modelTrained = false;

export function isModelTrained(): boolean {
  return modelTrained && trainedModel !== null;
}

export function clearModel(): void {
  trainedModel = null;
  modelTrained = false;
}

export interface TrainResult {
  accuracy: number;
  precision: number;
  recall: number;
  f1_score: number;
  n_trees: number;
  n_samples: number;
  total_samples?: number;
  clipboard_rows?: number;
  feature_importance: Record<string, number>;
}

function toMatrix(X: ModelFeatures[]): number[][] {
  return X.map((r) => FEATURE_COLUMNS.map((c) => r[c]));
}

/** Train Random Forest on prepared samples (port of train_model). */
export function trainModel(X: ModelFeatures[], y: string[], nTrees = 100, seed = DEFAULT_SEED): TrainResult {
  const matrix = toMatrix(X);

  const { trainX, trainY, testX, testY } = splitTrainTest(matrix, y, seed);

  const model = new RandomForestClassifier();
  model.fit(trainX, trainY, [...FEATURE_COLUMNS], {
    nEstimators: nTrees,
    maxDepth: 10,
    minSamplesSplit: 5,
    minSamplesLeaf: 2,
    seed,
  });

  const preds = model.predict(testX);
  const { accuracy, precision, recall, f1 } = scores(testY, preds);

  trainedModel = model;
  modelTrained = true;

  return {
    accuracy,
    precision,
    recall,
    f1_score: f1,
    n_trees: nTrees,
    n_samples: X.length,
    feature_importance: importanceFor(model),
  };
}

function splitTrainTest(X: number[][], y: string[], seed: number) {
  const rng = seededRandom(seed + 1);
  const idx = X.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const testCount = Math.max(1, Math.floor(X.length * 0.2));
  const testIdx = new Set(idx.slice(0, testCount));
  const trainId = idx.filter((i) => !testIdx.has(i));
  return {
    trainX: trainId.map((i) => X[i]),
    trainY: trainId.map((i) => y[i]),
    testX: [...testIdx].map((i) => X[i]),
    testY: [...testIdx].map((i) => y[i]),
  };
}

function scores(yTrue: string[], yPred: string[]) {
  const n = yTrue.length || 1;
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < yTrue.length; i += 1) {
    if (yPred[i] === "1" && yTrue[i] === "1") tp += 1;
    else if (yPred[i] === "1" && yTrue[i] === "0") fp += 1;
    else if (yPred[i] === "0" && yTrue[i] === "1") fn += 1;
    else tn += 1;
  }
  const accuracy = (tp + tn) / n;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { accuracy, precision, recall, f1 };
}

/** Predict scholarship need for a list of applicant dictionaries (port of predict_applicants). */
export function predictApplicants(applicants: Array<Record<string, unknown>>): Array<{
  application_id?: unknown;
  prediction: string;
  priority_score: number;
  probabilities: Record<string, number>;
}> {
  if (!isModelTrained() || !trainedModel) {
    return [{ prediction: "Model not trained yet", priority_score: 0, probabilities: {} }];
  }

  const rows = applicants.map((a) => {
    const row: Record<string, string | number> = {};
    for (const k of Object.keys(a)) row[k] = a[k] as string | number;
    return row;
  });
  const X = toMatrix(rows.map((r) => prepareFeatures(r)));
  const preds = trainedModel.predict(X);

  return preds.map((pred, i) => {
    const probs = trainedModel!.predictProba(X[i]);
    const highNeedProb = probs["1"] ?? 0;
    return {
      application_id: applicants[i].application_id,
      prediction: pred === "1" ? "High Need" : "Low Need",
      priority_score: Math.round(highNeedProb * 100 * 100) / 100,
      probabilities: probs,
    };
  });
}

function importanceFor(model: RandomForestClassifier): Record<string, number> {
  const imp = model.meta?.featureImportance ?? {};
  const out: Record<string, number> = {};
  model.features.forEach((f, i) => {
    out[f] = imp[String(i)] ?? 0;
  });
  return out;
}

/** Parse clipboard CSV, combine with synthetic data, and train (port of read_clipboard_and_train). */
export function readClipboardAndTrain(csvText: string, nTrees = 100, seed = DEFAULT_SEED): TrainResult {
  const parsed = parseClipboardCSV(csvText);
  const { X: synthX, y: synthY } = generateSyntheticData(400, seed);

  const clipX = parsed.map((r) => prepareFeatures(r.columns));
  const clipY = parsed.map((r) => prepareLabels(r.columns));

  const result = trainModel([...synthX, ...clipX], [...synthY, ...clipY], nTrees, seed);
  result.clipboard_rows = parsed.length;
  result.total_samples = synthX.length + clipX.length;
  return result;
}

/** Train on synthetic data only (port of the /train/synthetic endpoint). */
export function trainSynthetic(nSamples = 400, nTrees = 100, seed = DEFAULT_SEED): TrainResult {
  const { X, y } = generateSyntheticData(nSamples, seed);
  return trainModel(X, y, nTrees, seed);
}