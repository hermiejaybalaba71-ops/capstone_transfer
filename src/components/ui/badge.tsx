interface BadgeProps { children: React.ReactNode; className?: string; title?: string; }
export function Badge({ children, className = "", title }: BadgeProps) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${className}`} title={title}>{children}</span>;
}
