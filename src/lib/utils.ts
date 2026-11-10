export function formatDate(value?: string | null) {
  if (!value) return "\u2014";
  return new Date(value).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(value?: string | null) {
  if (!value) return "\u2014";
  return new Date(value).toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function validateFile(file: File | null): string | null {
  if (!file) return "Please choose a file.";
  // Accept ANY image — the applicant does not have to supply a readable ITR.
  // Verification / OCR happens on the Admin ranking + ML side.
  const name = (file.name || "").toLowerCase();
  const imageByName = /\.(jpe?g|png|webp|gif|bmp|avif|svg|heic|heif|jfif|tif|tiff|ico|pdf)$/.test(name);
  const isImage = file.type.startsWith("image/") || (file.type === "" && imageByName);
  const isPdf = file.type === "application/pdf" || (file.type === "" && name.endsWith(".pdf"));
  if (!isImage && !isPdf && !imageByName) {
    return "Please attach an image file (JPG, PNG, WEBP, HEIC, screenshot, etc.) or a PDF.";
  }
  if (file.size > 10 * 1024 * 1024) return "File must be 10 MB or smaller.";
  return null;
}
