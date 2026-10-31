import { NextResponse } from "next/server";
import { parseClipboardCSV, prepareFeatures, prepareLabels } from "@/lib/ml/model";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { csv_text?: string };
    if (!body.csv_text) {
      return NextResponse.json({ error: "csv_text is required" }, { status: 400 });
    }
    const rows = parseClipboardCSV(body.csv_text);
    const columns = rows.length ? Object.keys(rows[0].columns) : [];
    return NextResponse.json({
      rows: rows.length,
      columns,
      features: rows.map((r) => prepareFeatures(r.columns)),
      labels: rows.map((r) => prepareLabels(r.columns)),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "CSV parsing failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}