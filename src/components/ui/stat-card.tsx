interface StatCardProps { label: string; value: number | string; icon?: string; tone?: string; title?: string; }
const TONE_CLASSES: Record<string, string> = {
  maroon: "text-[#7B1113]",
  default: "text-[#241012]",
};
export function StatCard({ label, value, icon, tone, title }: StatCardProps) {
  const valueClass = TONE_CLASSES[tone || "maroon"] || TONE_CLASSES.maroon;
  return (
    <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm" title={title}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-[#6B5458]">{label}</p>
        {icon && <span className="text-lg">{icon}</span>}
      </div>
      <p className={`mt-2 text-2xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}
