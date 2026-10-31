import { NextResponse } from "next/server";
import { readClipboardAndTrain, trainSynthetic, predictApplicants } from "@/lib/ml/model";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      type?: "synthetic" | "clipboard";
      n_samples?: number;
      n_trees?: number;
      seed?: number;
      csv_text?: string;
      applicants?: Array<Record<string, unknown>>;
    };

    const nTrees = body.n_trees ?? 100;
    const seed = body.seed ?? 2026;

    let result: ReturnType<typeof trainSynthetic>;
    if (body.type === "clipboard") {
      if (!body.csv_text || !body.csv_text.trim()) {
        return NextResponse.json({ error: "csv_text is required" }, { status: 400 });
      }
      result = readClipboardAndTrain(body.csv_text, nTrees, seed);
    } else {
      result = trainSynthetic(body.n_samples ?? 400, nTrees, seed);
    }

    const applicants = Array.isArray(body.applicants) ? body.applicants : [];
    const predictions = predictApplicants(applicants);

    return NextResponse.json({
      train: {
        accuracy: result.accuracy,
        precision: result.precision,
        recall: result.recall,
        f1_score: result.f1_score,
        n_trees: result.n_trees,
        total_samples: result.total_samples ?? result.n_samples,
        clipboard_rows: result.clipboard_rows ?? 0,
        feature_importance: result.feature_importance,
      },
      predictions,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "ML ranking run failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}