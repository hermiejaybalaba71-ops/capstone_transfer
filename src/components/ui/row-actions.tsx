"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface RowAction {
  label: string;
  onClick: () => void;
  /** Renders the label as-is (for busy states like "Approving..."). */
  busy?: boolean;
  disabled?: boolean;
  /** Red text — for destructive actions such as Delete. */
  danger?: boolean;
  /** Solid maroon primary style — used for the most common action (Edit). */
  primary?: boolean;
  /** Highlighted as the currently-selected option (for filter dropdowns). */
  active?: boolean;
  /** Trailing count/number rendered dimmed, e.g. "Pending 9". */
  count?: number;
  title?: string;
}

interface MenuPos {
  top: number;
  left: number;
  minWidth: number;
}

const MENU_MIN_W = 168;

/**
 * Collapses a table row's action buttons into a single dropdown so the
 * Actions column stays narrow instead of stacking 3-4 buttons per row.
 *
 * The menu is portalled to <body> with `position: fixed` because every card
 * in this admin UI is `overflow-hidden` - an absolutely-positioned child
 * would be clipped by the card and the dropdown would be cut off.
 *
 * The menu closes on outside click, Escape, scroll, or after an item is chosen.
 */
export function RowActions({
  actions,
  label = "Actions",
  /** Read-only popover body — use instead of `actions` for non-clickable detail
   *  (e.g. the requirement chips in Manage Scholarship Programs). */
  content,
  menuAlign = "right",
  triggerClassName,
}: {
  actions?: RowAction[];
  label?: string;
  content?: ReactNode;
  menuAlign?: "right" | "left";
  /** Extra classes replacing the trigger button's default styling (e.g. status colouring). */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const wrapRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const visible = (actions ?? []).filter((a) => a.label);
  const isContent = content != null;

  // Position the portalled menu against the trigger, flipping above or
  // clamping to the viewport when it would fall off-screen.
  const place = () => {
    const trigger = wrapRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const menu = menuRef.current;
    const w = Math.max(MENU_MIN_W, menu?.offsetWidth ?? MENU_MIN_W);
    const h = menu?.offsetHeight ?? 0;

    let top = r.bottom + 4;
    if (h && top + h > window.innerHeight - 8) {
      const above = r.top - 4 - h;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - h - 8);
    }
    const left =
      menuAlign === "left"
        ? r.left
        : Math.min(Math.max(8, r.right - w), Math.max(8, window.innerWidth - w - 8));

    setPos({ top, left, minWidth: w });
  };

  useLayoutEffect(() => {
    if (!open) return;

    const frame = window.requestAnimationFrame(() => {
      place();
    });

    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onShift = () => setOpen(false);
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onShift);
    window.addEventListener("scroll", onShift, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onShift);
      window.removeEventListener("scroll", onShift, true);
    };
  }, [open]);

  const trigger = (
    <button
      type="button"
      ref={wrapRef}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-haspopup={isContent ? "dialog" : "menu"}
      className={
        triggerClassName ??
        "rounded-md border border-[#7B1113]/25 bg-white px-2.5 py-1 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
      }
      title={label}
    >
      {label} <span className="text-[9px]">&#9662;</span>
    </button>
  );

  const menu =
    open && pos ? (
      createPortal(
        <div
          ref={menuRef}
          role={isContent ? "dialog" : "menu"}
          style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, position: "fixed" }}
          className={[
            "z-[999] rounded-lg border border-[#241012]/10 bg-white shadow-2xl",
            isContent ? "p-2.5" : "py-1",
          ].join(" ")}
        >
          {isContent ? (
            content
          ) : (
            visible.map((a, i) => (
              <button
                key={`${a.label}-${i}`}
                type="button"
                role="menuitem"
                title={a.title}
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false);
                  a.onClick();
                }}
                className={[
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
                  a.active
                    ? "bg-[#7B1113] text-white"
                    : a.danger
                      ? "text-red-600 hover:bg-red-50"
                      : a.primary
                        ? "text-[#7B1113] hover:bg-[#7B1113]/5"
                        : "text-[#6B5458] hover:bg-[#FAF7F5]",
                ].join(" ")}
              >
                <span className="truncate">{a.label}</span>
                {a.count != null && (
                  <span className={a.active ? "text-white/70" : "text-[#8B7376]"}>{a.count}</span>
                )}
              </button>
            ))
          )}
        </div>,
        document.body,
      )
    ) : null;

  // The wrapper keeps no `position: relative` child-menu anymore - the menu
  // lives in a portal - so only the trigger needs a positioning context.
  return (
    <>
      {trigger}
      {menu}
    </>
  );
}
