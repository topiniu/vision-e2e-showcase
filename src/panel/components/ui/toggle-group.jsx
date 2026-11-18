import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cva } from "class-variance-authority";
import { cn } from "@panel/lib/cn";

const toggleGroupItemVariants = cva(
  "inline-flex items-center justify-center rounded-md border border-transparent text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 data-[state=on]:border-[var(--border-strong)] data-[state=on]:bg-[var(--panel)] data-[state=on]:text-[var(--foreground)]",
  {
    variants: {
      variant: {
        default: "bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]",
        outline:
          "border-[var(--border-subtle)] bg-[var(--panel)] text-[var(--foreground-soft)] hover:bg-[var(--panel-muted)]",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-xs",
        lg: "h-10 px-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export function ToggleGroup({ className, ...props }) {
  return <ToggleGroupPrimitive.Root className={cn("inline-flex items-center gap-1", className)} {...props} />;
}

export function ToggleGroupItem({ className, variant, size, ...props }) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(toggleGroupItemVariants({ variant, size }), className)}
      {...props}
    />
  );
}
