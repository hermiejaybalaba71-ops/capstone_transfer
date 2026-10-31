import { NextResponse } from "next/server";
import { predictApplicants, isModelTrained } from "@/lib/ml/model";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { applicants?: Array<Record<string, unknown>> };
    const applicants = Array.isArray(body.applicants) ? body.applicants : [];

    if (!isModelTrained()) {
      return NextResponse.json(
        { error: "Model not trained yet. Call /api/ml/train first." },
        { status: 400 }
      );
    }

    const predictions = predictApplicants(applicants);
    return NextResponse.json({ predictions });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Prediction failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}