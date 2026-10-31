import { NextResponse } from "next/server";
import { readClipboardAndTrain, trainSynthetic } from "@/lib/ml/model";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      type?: "synthetic" | "clipboard";
      n_samples?: number;
      n_trees?: number;
      seed?: number;
      csv_text?: string;
    };

    const nTrees = body.n_trees ?? 100;
    const seed = body.seed ?? 2026;

    if (body.type === "clipboard") {
      if (!body.csv_text || !body.csv_text.trim()) {
        return NextResponse.json({ error: "csv_text is required" }, { status: 400 });
      }
      const result = readClipboardAndTrain(body.csv_text, nTrees, seed);
      return NextResponse.json({
        message: `Model trained with ${result.clipboard_rows} clipboard rows + synthetic data`,
        accuracy: result.accuracy,
        precision: result.precision,
        recall: result.recall,
        f1_score: result.f1_score,
        n_trees: result.n_trees,
        total_samples: result.total_samples,
        clipboard_rows: result.clipboard_rows,
        feature_importance: result.feature_importance,
      });
    }

    const result = trainSynthetic(body.n_samples ?? 400, nTrees, seed);
    return NextResponse.json({
      message: "Model trained on synthetic data",
      accuracy: result.accuracy,
      precision: result.precision,
      recall: result.recall,
      f1_score: result.f1_score,
      n_trees: result.n_trees,
      n_samples: result.n_samples,
      feature_importance: result.feature_importance,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Training failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}