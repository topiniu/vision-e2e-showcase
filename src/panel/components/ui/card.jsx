import { forwardRef } from "react";
import { cn } from "@panel/lib/cn";

export const Card = forwardRef(function Card({ className, ...props }, ref) {
  return (
    <section
      ref={ref}
      className={cn(
        "rounded-[4px] border border-[var(--border-subtle)] bg-[var(--panel)] shadow-none",
        className,
      )}
      {...props}
    />
  );
});

export const CardHeader = forwardRef(function CardHeader({ className, ...props }, ref) {
  return <div ref={ref} className={cn("flex items-start justify-between gap-3 p-3 pb-2", className)} {...props} />;
});

export const CardTitle = forwardRef(function CardTitle({ className, ...props }, ref) {
  return (
    <h3 ref={ref} className={cn("text-[12px] font-semibold tracking-normal text-[var(--foreground-soft)]", className)} {...props} />
  );
});

export const CardDescription = forwardRef(function CardDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn("text-[12px] text-[var(--muted-foreground)]", className)} {...props} />;
});

export const CardContent = forwardRef(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn("px-3 pb-3", className)} {...props} />;
});

export const CardFooter = forwardRef(function CardFooter({ className, ...props }, ref) {
  return <div ref={ref} className={cn("flex items-center gap-2 px-3 pb-3 pt-1", className)} {...props} />;
});
