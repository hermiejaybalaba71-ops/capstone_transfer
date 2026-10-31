import { NextResponse } from "next/server";
import { isModelTrained } from "@/lib/ml/model";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ status: "ok", model_trained: isModelTrained() });
}