interface SpinnerProps { label?: string; color?: string; }
const SPINNER_COLORS: Record<string, string> = {
  maroon: "border-t-[#7B1113]",
  blue: "border-t-blue-600",
  green: "border-t-green-600",
};
export function Spinner({ label, color = "maroon" }: SpinnerProps) {
  const ring = SPINNER_COLORS[color] || SPINNER_COLORS.maroon;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#FAF7F5]">
      <div className={`h-9 w-9 animate-spin rounded-full border-4 border-gray-200 ${ring}`} />
      {label && <p className="text-xs font-medium text-gray-500">{label}</p>}
    </div>
  );
}
