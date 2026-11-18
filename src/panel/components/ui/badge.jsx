import { cn } from "@panel/lib/cn";

const variants = {
  neutral: "border border-[var(--border-subtle)] bg-[var(--panel-muted)] text-[var(--muted-foreground)]",
  success: "border border-[#b8ebcc] bg-[var(--success-soft)] text-[var(--success)]",
  warning: "border border-[#f6d58c] bg-[var(--warning-soft)] text-[var(--warning)]",
  danger: "border border-[#fecdca] bg-[var(--danger-soft)] text-[var(--danger)]",
  running: "border border-[var(--border-subtle)] bg-[var(--accent-soft)] text-[var(--accent-strong)]",
};

export function Badge({ className, variant = "neutral", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center gap-1 rounded-[4px] px-2 py-0.5 text-[12px] font-medium leading-[16px] [&>svg]:pointer-events-none [&>svg]:size-3.5 [&>svg]:shrink-0",
        variants[variant] || variants.neutral,
        className,
      )}
      {...props}
    />
  );
}
