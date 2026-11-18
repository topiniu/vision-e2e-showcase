import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@panel/components/ui/card";
import { Badge } from "@panel/components/ui/badge";

export function MetricCard({ eyebrow, title, description, value, badge, badgeVariant = "neutral" }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-[var(--muted-foreground)]">{eyebrow}</p>
          <CardTitle className="mt-2">{title}</CardTitle>
          <CardDescription className="mt-1">{description}</CardDescription>
        </div>
        {badge ? <Badge variant={badgeVariant}>{badge}</Badge> : null}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight text-[var(--foreground)]">{value}</div>
      </CardContent>
    </Card>
  );
}
