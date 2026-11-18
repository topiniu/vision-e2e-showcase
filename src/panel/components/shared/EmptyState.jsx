import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@panel/components/ui/card";

export function EmptyState({ title, description }) {
  return (
    <Card className="border-dashed bg-[var(--panel)]">
      <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--panel-muted)] p-3 text-[var(--foreground)]">
          <Sparkles />
        </div>
        <div>
          <h4 className="text-sm font-semibold text-[var(--foreground)]">{title}</h4>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}
