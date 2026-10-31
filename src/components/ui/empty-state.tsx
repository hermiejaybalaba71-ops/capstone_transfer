interface EmptyStateProps { icon: string; title: string; hint?: string; }
export function EmptyState({ icon, title, hint }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-[#241012]/15 bg-[#FAF7F5] px-6 py-10 text-center">
      <div className="text-3xl">{icon}</div>
      <p className="mt-2 text-sm font-semibold text-[#241012]">{title}</p>
      {hint && <p className="mt-1 text-xs text-[#6B5458]">{hint}</p>}
    </div>
  );
}
