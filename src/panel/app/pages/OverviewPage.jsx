import { ArrowRight, Eye, PlayCircle, Workflow } from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@panel/components/ui/card";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { Separator } from "@panel/components/ui/separator";

function formatTime(timestamp) {
  if (!timestamp) {
    return "Not yet";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function itemVariant(type) {
  if (type === "success") {
    return "success";
  }
  if (type === "danger" || type === "warning") {
    return "danger";
  }
  return "running";
}

export function OverviewPage({ draft, runtimeState, result, lastRunAt, activityItems, onNavigatePage }) {
  const stats = [
    {
      label: "Runtime",
      value: runtimeState?.available ? "Ready" : "Unavailable",
      meta: runtimeState?.available ? "Bridge connected" : runtimeState?.error?.message || "Awaiting runtime",
    },
    {
      label: "Last run",
      value: lastRunAt ? formatTime(lastRunAt) : "No run yet",
      meta: result ? (result.ok ? "Latest run passed" : "Latest run failed") : "No execution recorded",
    },
    {
      label: "Steps",
      value: String(draft.steps.length),
      meta: "Current draft payload",
    },
  ];

  const actions = [
    {
      label: "Open test file",
      detail: "Review the selected requirement file and its cases.",
      icon: Workflow,
      target: "test-file",
    },
    {
      label: "Run cases",
      detail: "Execute the selected case or the entire file.",
      icon: PlayCircle,
      target: "test-file",
    },
    {
      label: "Inspect result",
      detail: "Open the latest evidence timeline.",
      icon: Eye,
      target: "test-file",
    },
  ];

  return (
    <div className="grid gap-4">
      <Card className="border-[var(--border-subtle)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--panel-muted)_70%,transparent),transparent_50%),var(--panel)]">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="text-xs text-[var(--muted-foreground)]">Runtime workspace</div>
            <CardTitle className="text-xl">Control the payload pipeline from one surface.</CardTitle>
            <CardDescription>Monitor runtime health, jump into authoring, and inspect the latest run without leaving the dashboard.</CardDescription>
          </div>
          {result ? <Badge variant={result.ok ? "success" : "danger"}>{result.ok ? "Passed" : "Failed"}</Badge> : null}
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          {stats.map((item) => (
            <Card key={item.label} className="bg-[var(--panel-muted)] shadow-none">
              <CardHeader className="flex-col items-start gap-1 p-4 pb-2">
                <div className="text-xs text-[var(--muted-foreground)]">{item.label}</div>
                <CardTitle className="text-2xl">{item.value}</CardTitle>
                <CardDescription>{item.meta}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              key={action.label}
              type="button"
              variant="outline"
              className="h-auto min-h-36 flex-col items-start gap-4 whitespace-normal rounded-xl border-[var(--border-subtle)] bg-[var(--panel)] px-5 py-4 text-left hover:bg-[var(--panel-muted)]"
              onClick={() => onNavigatePage(action.target)}
            >
              <span className="inline-flex items-center gap-2 text-sm font-semibold">
                <Icon data-icon="inline-start" />
                {action.label}
              </span>
              <span className="text-sm text-[var(--muted-foreground)]">{action.detail}</span>
              <span className="inline-flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                Open
                <ArrowRight />
              </span>
            </Button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="text-xs text-[var(--muted-foreground)]">Recent activity</div>
            <CardTitle>Session timeline</CardTitle>
            <CardDescription>Latest orchestration and runtime events for the current desktop session.</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onNavigatePage("test-file")}>
            Open test file
          </Button>
        </CardHeader>
        <CardContent className="pb-4">
          <ScrollArea className="max-h-[360px] pr-4">
            <div className="grid gap-4">
              {activityItems.map((item, index) => (
                <div key={item.id} className="grid gap-4">
                  <div className="grid gap-2 md:grid-cols-[auto_1fr_auto] md:items-start">
                    <div className="mt-1 size-2 rounded-full bg-[var(--foreground)] data-[variant=success]:bg-[var(--success)] data-[variant=danger]:bg-[var(--danger)] data-[variant=warning]:bg-[var(--danger)]" data-variant={item.type} />
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm font-medium">{item.label}</div>
                      <p className="m-0 text-sm text-[var(--muted-foreground)]">{item.detail}</p>
                    </div>
                    <Badge variant={itemVariant(item.type)}>{formatTime(item.timestamp)}</Badge>
                  </div>
                  {index < activityItems.length - 1 ? <Separator /> : null}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
