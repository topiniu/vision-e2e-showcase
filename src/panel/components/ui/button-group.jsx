import { cn } from "@panel/lib/cn";

export function ButtonGroup({ className, children, ...props }) {
  return (
    <div
      className={cn(
        "inline-flex flex-wrap items-center gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--panel-muted)] p-1",
        className,
      )}
      role="group"
      {...props}
    >
      {children}
    </div>
  );
}
