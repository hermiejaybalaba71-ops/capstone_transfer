"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";

import { downloadCsv } from "@/lib/utils";

type SheetRow = Record<string, string>;

interface ParsedSheet {
  ok?: boolean;
  import_id: string;
  saved?: boolean;
  updated_at?: string;
  columns: string[];
  rows: SheetRow[];
  row_count: number;
  sheet: string;
  years: string[];
  year_column: string;
  // "ay" = school-year labels (AY 2025-2026); "level" = year level (1st Year).
  // "" when the file carries no year column at all.
  year_kind?: string;
  // Label -> row count, straight from the reader, so chips are exact.
  year_counts?: Record<string, number>;
  group_column: string;
  file_name: string;
  file_size: number;
}

interface SheetGroup {
  key: string;
  label: string;
  rows: SheetRow[];
}

type GroupedBy = "year" | "program" | "none";

const PAGE_SIZE = 50;
const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".csv,.xlsx,.xlsm,.xltx";

// Same pattern ml/read_sheet.py uses: any 20xx-20xx range inside a cell that
// the server already identified as the year column becomes an AY label.
const YEAR_IN_CELL = /(20\d{2})\s*[-\u2013/]\s*(20\d{2})/;

function yearLabel(value: string | undefined): string {
  const match = YEAR_IN_CELL.exec(value || "");
  return match ? `AY ${match[1]}-${match[2]}` : "";
}

/** A year-level cell ("3", "3rd", "3rd Year") -> the label the UI shows.
    Mirrors ordinal_year() in ml/read_sheet.py so both ends agree. */
function ordinalYearLabel(value: string | undefined): string {
  const match = /^\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:year|level)?\s*$/i.exec(value || "");
  if (!match) return "";
  const n = Number(match[1]);
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] || "th";
  return `${n}${suffix} Year`;
}

/** Section the rows the same way the reader described the file.

    Whatever the file actually carries wins - a year column becomes school-year
    sections, otherwise the program column becomes program sections, otherwise
    one flat list. Nothing is hard-coded to a particular scholarship file. */
function buildGroups(
  sheet: ParsedSheet,
  prefer: "year" | "program",
): { groups: SheetGroup[]; groupedBy: GroupedBy; column: string } {
  const { rows, years, year_column, group_column } = sheet;
  const useYear = prefer === "year" ? years.length > 0 : years.length > 0 && !group_column;
  const column = useYear ? year_column : group_column;
  const levelKind = useYear && sheet.year_kind === "level";

  if (column && rows.length) {
    const buckets = new Map<string, SheetRow[]>();
    for (const row of rows) {
      const cell = row[column];
      // AY files canonicalise the cell; year-level files read the bare number
      // into "3rd Year". Either way the label matches an entry of `years`.
      const raw = useYear ? yearLabel(cell) || (levelKind ? ordinalYearLabel(cell) : "") : (cell || "").trim();
      const label = raw || "No value";
      const bucket = buckets.get(label);
      if (bucket) bucket.push(row);
      else buckets.set(label, [row]);
    }

    let ordered: SheetGroup[];
    if (useYear) {
      // Order by the reader's `years` (newest AY first, 1st Year first for
      // levels), then any extra labels, with unlabelled rows at the very end.
      ordered = [];
      const placed = new Set<string>();
      for (const year of years) {
        const bucket = buckets.get(year);
        if (bucket) {
          ordered.push({ key: `y:${year}`, label: year, rows: bucket });
          placed.add(year);
        }
      }
      const leftovers = [...buckets.entries()]
        .filter(([label]) => !placed.has(label) && label !== "No value")
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      for (const [label, bucket] of leftovers) {
        ordered.push({ key: `y:${label}`, label, rows: bucket });
      }
      const unlabelled = buckets.get("No value");
      if (unlabelled) ordered.push({ key: "y:__none__", label: "No school year", rows: unlabelled });
    } else {
      // Biggest program first, mirroring the program chips on the list pages.
      ordered = [...buckets.entries()]
        .map(([label, bucket]) => ({ key: `p:${label}`, label, rows: bucket }))
        .sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
    }
    return { groups: ordered, groupedBy: useYear ? "year" : "program", column };
  }

  return { groups: [{ key: "all", label: "All rows", rows }], groupedBy: "none", column: "" };
}

function toTsv(columns: string[], rows: SheetRow[]): string {
  const cell = (v: string | undefined) => (v || "").replace(/\t/g, " ").replace(/\r?\n/g, " ");
  return [
    columns.join("\t"),
    ...rows.map((row) => columns.map((col) => cell(row[col])).join("\t")),
  ].join("\n");
}

async function copyTsv(columns: string[], rows: SheetRow[], what: string) {
  if (!rows.length) {
    toast.error("Nothing to copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(toTsv(columns, rows));
    toast.success(`Copied ${rows.length.toLocaleString()} row(s)${what ? ` of ${what}` : ""} - paste into Excel or Google Sheets.`);
  } catch {
    toast.error("The browser blocked clipboard access - use Download CSV instead.");
  }
}

function slug(label: string): string {
  return (label || "rows").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rows";
}

export function ImportedSheet({
  prefer,
  title,
  hint,
  emoji = "\u{1F4DA}",
  scope,
  onSheet,
  hideChips = false,
  activeYear = "",
  readOnly = false,
}: {
  /** Year grouping wins when the file carries a school-year column; program
      grouping wins when it carries a program column and no year was found. */
  prefer: "year" | "program";
  title: string;
  hint: string;
  emoji?: string;
  /** Which page's saved file this is - uploads persist per scope, so the
      Scholarship Applications file and the Approvals file never collide, and
      deleting one never touches the other. */
  scope: "applications" | "approvals";
  /** Reports the parsed sheet upward whenever a file is loaded, restored or
      deleted, so the page can drive its own year chips from the file. Passes
      null when there is no file. */
  onSheet?: (sheet: ParsedSheet | null) => void;
  /** Suppress this card's own group chips - the page renders year chips in its
      main chip row instead and drives them through `activeYear`. */
  hideChips?: boolean;
  /** A year label ("3rd Year", "AY 2025-2026") to show only; "" = every year.
      Supersedes this card's internal chip selection. */
  activeYear?: string;
  /** Show a saved file without exposing admin-only upload/delete controls. */
  readOnly?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [activeSheetId, setActiveSheetId] = useState("");
  const [activeGroup, setActiveGroup] = useState("");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [visible, setVisible] = useState<Record<string, number>>({});

  const sheet = sheets.find((item) => item.import_id === activeSheetId) || sheets[0] || null;

  // Keep the parent in sync with the currently selected file.
  useEffect(() => {
    onSheet?.(sheet);
  }, [sheet, onSheet]);

  // Restore every upload for this page, so a refresh does not wipe the list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/import/parse?scope=${scope}`);
        const json = (await res.json()) as {
          error?: string;
          sheets?: Array<Partial<ParsedSheet>>;
          columns?: string[];
          rows?: SheetRow[];
          restored?: boolean;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || "Could not restore uploaded files.");
          return;
        }
        const restored = Array.isArray(json.sheets)
          ? json.sheets
          : json.restored && Array.isArray(json.columns) && Array.isArray(json.rows)
            ? [json as Partial<ParsedSheet>]
            : [];
        const parsed = restored.flatMap((item, index) => {
          if (!Array.isArray(item.columns) || !Array.isArray(item.rows)) return [];
          return [{
            import_id: String(item.import_id || `${item.file_name || "file"}-${index}`),
            saved: true,
            updated_at: item.updated_at ? String(item.updated_at) : undefined,
            columns: item.columns.map(String),
            rows: item.rows as SheetRow[],
            row_count: Number(item.row_count ?? item.rows.length),
            sheet: String(item.sheet || item.file_name || ""),
            years: Array.isArray(item.years) ? item.years.map(String) : [],
            year_column: String(item.year_column || ""),
            year_kind: String(item.year_kind || ""),
            year_counts: (item.year_counts as Record<string, number>) || {},
            group_column: String(item.group_column || ""),
            file_name: String(item.file_name || ""),
            file_size: Number(item.file_size ?? 0),
          }];
        });
        setSheets(parsed);
        setActiveSheetId(parsed[0]?.import_id || "");
        setError("");
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not restore uploaded files.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const { groups, groupedBy, column } = useMemo(
    () => (sheet ? buildGroups(sheet, prefer) : { groups: [] as SheetGroup[], groupedBy: "none" as GroupedBy, column: "" }),
    [sheet, prefer],
  );

  const shownGroups = useMemo(() => {
    // The page's year chips drive the section via `activeYear`; the card's own
    // chip selection only applies when the page is not driving it.
    if (activeYear) {
      return groups.filter((g) => g.label === activeYear);
    }
    return activeGroup ? groups.filter((g) => g.key === activeGroup) : groups;
  }, [groups, activeGroup, activeYear]);
  const totalRows = sheet?.row_count ?? 0;

  async function upload(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setError("");
    const failures: string[] = [];
    let imported = 0;
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        failures.push(`${file.name}: file must be 20 MB or smaller.`);
        continue;
      }
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("scope", scope);
        const res = await fetch("/api/import/parse", { method: "POST", body: form });
        const json = (await res.json()) as Partial<ParsedSheet> & { error?: string; warning?: string };
        if (!res.ok || json.ok !== true || !Array.isArray(json.columns) || !Array.isArray(json.rows)) {
          throw new Error(json.error || "Could not read this file.");
        }
        const parsed: ParsedSheet = {
          import_id: String(json.import_id || `${Date.now()}-${file.name}`),
          saved: Boolean(json.saved),
          updated_at: json.updated_at ? String(json.updated_at) : undefined,
          columns: json.columns.map(String),
          rows: json.rows as SheetRow[],
          row_count: Number(json.row_count ?? json.rows.length),
          sheet: String(json.sheet || file.name),
          years: Array.isArray(json.years) ? json.years.map(String) : [],
          year_column: String(json.year_column || ""),
          year_kind: String(json.year_kind || ""),
          year_counts: (json.year_counts as Record<string, number>) || {},
          group_column: String(json.group_column || ""),
          file_name: String(json.file_name || file.name),
          file_size: Number(json.file_size ?? file.size),
        };
        setSheets((previous) => [...previous, parsed]);
        setActiveSheetId(parsed.import_id);
        setActiveGroup("");
        setOpenSections({});
        setVisible({});
        imported += 1;
        if (json.saved) {
          toast.success(`Imported and saved ${parsed.file_name} (${parsed.row_count.toLocaleString()} rows).`);
        } else {
          failures.push(`${file.name}: ${json.warning || "the file could not be saved for refresh."}`);
          toast.error(`${parsed.file_name} was read but not saved.`);
        }
        if (json.warning) toast(json.warning, { icon: "\u26a0\ufe0f" });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Upload failed.";
        failures.push(`${file.name}: ${msg}`);
        toast.error(`${file.name}: ${msg}`);
      }
    }
    if (failures.length) setError(failures.join(" "));
    if (imported && !failures.length) {
      setError("");
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  /** Delete one saved upload from storage. */
  async function deleteSheet(target: ParsedSheet) {
    if (!target || deleting) return;
    const ok = window.confirm(
      `Delete the saved upload "${target.file_name}"? It is removed from the server - this cannot be undone.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/import/parse?scope=${scope}&import_id=${encodeURIComponent(target.import_id)}`, { method: "DELETE" });
      const json = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok || json.ok !== true) throw new Error(json.error || "Could not delete this file.");
      const remaining = sheets.filter((item) => item.import_id !== target.import_id);
      setSheets(remaining);
      if (activeSheetId === target.import_id) setActiveSheetId(remaining[0]?.import_id || "");
      setError("");
      setActiveGroup("");
      setOpenSections({});
      setVisible({});
      if (inputRef.current) inputRef.current.value = "";
      toast.success(`Deleted ${target.file_name} from the server.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Delete failed.";
      setError(msg);
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  }

  function toggleSection(key: string, index: number) {
    setOpenSections((prev) => ({ ...prev, [key]: !isOpen(key, index) }));
  }

  function isOpen(key: string, index: number): boolean {
    return openSections[key] ?? index === 0;
  }

  function visibleRows(key: string, total: number): number {
    return Math.min(visible[key] ?? PAGE_SIZE, total);
  }

  function showMore(key: string, total: number) {
    setVisible((prev) => ({ ...prev, [key]: Math.min((prev[key] ?? PAGE_SIZE) + PAGE_SIZE, total) }));
  }

  function showAll(key: string, total: number) {
    setVisible((prev) => ({ ...prev, [key]: total }));
  }

  const groupedByLabel =
    groupedBy === "year"
      ? sheet?.year_kind === "level"
        ? `year level (from the "${column}" column)`
        : `school year (from the "${column}" column)`
      : groupedBy === "program"
        ? `the "${column}" column`
        : "one flat list - no year or program column found";

  return (
    <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
      {/* Header: title on the left, upload control on the right - same shape as
          the ML train-data card on the Ranking page. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
        <div>
          <p className="text-sm font-bold text-[#241012]">{title}</p>
          <p className="mt-0.5 text-[11px] text-[#6B5458]">{hint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              const selected = Array.from(e.target.files || []);
              if (selected.length) void upload(selected);
            }}
          />}
          {!readOnly && <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="rounded-xl bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:bg-[#540111] disabled:opacity-50"
            title="Read every row and column of a CSV or Excel file"
          >
            {busy ? "Importing files..." : "Import CSV / Excel"}
          </button>}
        </div>
      </div>

      {error && (
        <div className="border-b border-[#241012]/[0.07] bg-red-50 px-5 py-2.5 text-[11px] font-semibold text-red-600">{error}</div>
      )}
      {sheets.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-3">
          {sheets.map((item) => (
            <span
              key={item.import_id}
              className={`inline-flex max-w-full items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-semibold ${
                sheet?.import_id === item.import_id
                  ? "border-[#7B1113] bg-[#7B1113] text-white"
                  : "border-[#241012]/10 bg-white text-[#241012]"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  setActiveSheetId(item.import_id);
                  setActiveGroup("");
                  setOpenSections({});
                  setVisible({});
                }}
                className="max-w-[18rem] truncate"
                title={`${item.file_name} · ${item.row_count.toLocaleString()} rows${item.saved ? " · saved" : " · not saved"}`}
              >
                {item.file_name} ({item.row_count.toLocaleString()})
              </button>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void deleteSheet(item)}
                  disabled={deleting || busy}
                  aria-label={`Delete ${item.file_name}`}
                  title={`Delete ${item.file_name}`}
                  className="rounded-full px-1 leading-none hover:bg-black/10 disabled:opacity-50"
                >
                  &times;
                </button>
              )}
            </span>
          ))}
          <span className="self-center text-[10px] text-[#6B5458]">
            {sheets.length} file{sheets.length === 1 ? "" : "s"} · {sheets.reduce((sum, item) => sum + item.row_count, 0).toLocaleString()} total rows
          </span>
        </div>
      )}

      {!sheet ? (
        <div className="px-5 py-3 text-[11px] leading-5 text-[#6B5458]">
          No file loaded yet. Upload a CSV / Excel export - every row and column is read, grouped by whatever school
          year or program column the file contains, and can be copied or downloaded from here.
        </div>
      ) : (
        <>
          {/* Summary strip: what was read and how it is sectioned. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-2.5 text-[11px] leading-5 text-[#6B5458]">
            <span className="font-bold text-[#241012]">{sheet.file_name}</span>
            <span>
              {totalRows.toLocaleString()} row{totalRows === 1 ? "" : "s"} &middot; {sheet.columns.length} columns
              {sheet.sheet && sheet.sheet !== sheet.file_name ? ` \u00b7 sheet "${sheet.sheet}"` : ""}
            </span>
            <span>
              Grouped by{" "}
              <span className="font-semibold text-[#7B1113]">{groupedByLabel}</span>
            </span>
            {sheet.years.length > 0 && (
              <span>
                {sheet.year_kind === "level" ? "Year levels in file" : "School years in file"}: {sheet.years.join(" \u00b7 ")}
              </span>
            )}
            {sheet.saved && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700"
                title="This file is stored on the server and will still be available after a refresh."
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                saved - survives refresh
              </span>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => copyTsv(sheet.columns, sheet.rows, sheet.file_name)}
                className="rounded-lg border border-[#7B1113]/30 px-2.5 py-1 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                title="Copy every row and column to the clipboard as a tab-separated table"
              >
                &#128203; Copy all
              </button>
              <button
                onClick={() => downloadCsv(sheet.file_name.replace(/\.[^.]+$/, "") + "-imported.csv", sheet.rows)}
                className="rounded-lg border border-[#7B1113]/30 px-2.5 py-1 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                title="Download every row and column as a CSV file"
              >
                &#11015; Download CSV
              </button>
            </span>
          </div>

          {/* Group chips - same interaction as the program chips on the list
              pages: pick one section, or "All" for every section stacked.
              Hidden when the page renders the year chips in its own chip row. */}
          {!hideChips && groups.length > 1 && (
            <div className="relative border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-2.5">
              <div className="flex gap-2 overflow-x-auto scroll-smooth pb-1 [-ms-overflow-style:none] [scrollbar-color:#7B111340_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:rounded-full [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#7B1113]/40 [&::-webkit-scrollbar-track]:bg-transparent">
                <button
                  onClick={() => setActiveGroup("")}
                  className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                    activeGroup === ""
                      ? "bg-[#7B1113] text-white shadow"
                      : "border border-[#241012]/[0.08] bg-white text-[#241012] hover:border-[#7B1113]/40"
                  }`}
                  title="Show every section"
                >
                  {groupedBy === "year" ? "\u{1F4C5} All school years" : "\u{1F4DA} All groups"} ({totalRows.toLocaleString()})
                </button>
                {groups.map((group) => (
                  <button
                    key={group.key}
                    onClick={() => setActiveGroup(activeGroup === group.key ? "" : group.key)}
                    className={`max-w-[18rem] shrink-0 truncate whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                      activeGroup === group.key
                        ? "bg-[#7B1113] text-white shadow"
                        : "border border-[#241012]/[0.08] bg-white text-[#241012] hover:border-[#7B1113]/40"
                    }`}
                    title={`Show only the ${group.rows.length.toLocaleString()} row(s) of "${group.label}"`}
                  >
                    {groupedBy === "year" ? "\u{1F4C5}" : emoji} {group.label} ({group.rows.length.toLocaleString()})
                  </button>
                ))}
              </div>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#FAF7F5] via-[#FAF7F5]/70 to-transparent"
              />
            </div>
          )}

          {/* One collapsible section per group; every column of every row is
              rendered, paged so a 2,000+ row file stays responsive. */}
          {shownGroups.map((group, index) => {
            const open = isOpen(group.key, activeGroup ? 0 : index);
            const shown = visibleRows(group.key, group.rows.length);
            const rows = group.rows.slice(0, shown);
            return (
              <div key={group.key} className="border-b border-[#241012]/[0.07] last:border-b-0">
                <div className="flex items-center justify-between gap-2 bg-white px-5 py-3">
                  <button
                    onClick={() => toggleSection(group.key, activeGroup ? 0 : index)}
                    className="flex min-w-0 items-center gap-2 text-left"
                    title={open ? "Collapse this section" : "Expand this section"}
                  >
                    <span aria-hidden className="text-xs text-[#8B7376]">{open ? "\u25BE" : "\u25B8"}</span>
                    <span className="truncate text-xs font-bold text-[#241012]">
                      {groupedBy === "year" ? "\u{1F4C5}" : emoji} {group.label}
                    </span>
                    <span className="rounded-full bg-[#7B1113]/10 px-2 py-0.5 text-[10px] font-bold text-[#7B1113]">
                      {group.rows.length.toLocaleString()}
                    </span>
                  </button>
                  <span className="flex flex-none items-center gap-1.5">
                    <button
                      onClick={() => copyTsv(sheet.columns, group.rows, group.label)}
                      className="rounded-lg border border-[#241012]/[0.12] px-2.5 py-1 text-[11px] font-bold text-[#6B5458] transition hover:bg-[#FAF7F5]"
                      title={`Copy all ${group.rows.length.toLocaleString()} row(s) of this section to the clipboard`}
                    >
                      &#128203; Copy
                    </button>
                    <button
                      onClick={() => downloadCsv(`${slug(group.label)}.csv`, group.rows)}
                      className="rounded-lg border border-[#241012]/[0.12] px-2.5 py-1 text-[11px] font-bold text-[#6B5458] transition hover:bg-[#FAF7F5]"
                      title={`Download this section as a CSV file`}
                    >
                      &#11015; CSV
                    </button>
                  </span>
                </div>

                {open && (
                  <div className="px-5 pb-4">
                    <div className="overflow-x-auto rounded-xl border border-[#241012]/[0.07]">
                      <table className="min-w-full text-xs">
                        <thead className="bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458]">
                          <tr>
                            <th className="w-12 border border-[#241012]/10 px-3 py-1.5 text-center font-bold">#</th>
                            {sheet.columns.map((col) => (
                              <th key={col} className="whitespace-nowrap border border-[#241012]/10 px-3 py-1.5 text-left font-bold">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, rowIndex) => (
                            <tr key={rowIndex} className="odd:bg-white even:bg-[#FAF7F5]/50">
                              <td className="border border-[#241012]/10 px-3 py-1.5 text-center font-semibold text-[#8B7376]">
                                {rowIndex + 1}
                              </td>
                              {sheet.columns.map((col) => (
                                <td key={col} className="border border-[#241012]/10 px-3 py-1.5 align-middle text-[#241012]">
                                  {row[col] ? row[col] : <span className="text-[#8B7376]">{"\u2014"}</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                          {rows.length === 0 && (
                            <tr>
                              <td colSpan={sheet.columns.length + 1} className="border border-[#241012]/10 px-3 py-3 text-center text-[11px] text-[#8B7376]">
                                This group has no rows.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {group.rows.length > shown && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[#6B5458]">
                        <span>
                          Showing {shown.toLocaleString()} of {group.rows.length.toLocaleString()} row(s)
                        </span>
                        <button
                          onClick={() => showMore(group.key, group.rows.length)}
                          className="rounded-lg border border-[#7B1113]/30 px-2.5 py-1 text-[11px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
                        >
                          Show {Math.min(PAGE_SIZE, group.rows.length - shown)} more
                        </button>
                        <button
                          onClick={() => showAll(group.key, group.rows.length)}
                          className="rounded-lg border border-[#241012]/[0.12] px-2.5 py-1 text-[11px] font-bold text-[#6B5458] transition hover:bg-[#FAF7F5]"
                          title="Render every remaining row of this section"
                        >
                          Show all {group.rows.length.toLocaleString()}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
