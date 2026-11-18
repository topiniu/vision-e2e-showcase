import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, CircleX, LoaderCircle, Radio } from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@panel/components/ui/popover";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { Separator } from "@panel/components/ui/separator";
import { getExternalActivitySnapshot, subscribeExternalActivity } from "@panel/lib/panel-api";

function sortActivities(items) {
  return [...items].sort((left, right) => String(right.startedAt || "").localeCompare(String(left.startedAt || "")));
}

function upsertActivity(items, activity) {
  return sortActivities([activity, ...items.filter((item) => item.id !== activity.id)]).slice(0, 20);
}

function formatActivityTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function ActivityRow({ item, active = false }) {
  const failed = item.status === "failed" || Number(item.statusCode) >= 400;
  const StatusIcon = active ? LoaderCircle : failed ? CircleX : CheckCircle2;
  return (
    <div className="flex min-w-0 max-w-full gap-3 overflow-hidden px-1 py-3">
      <div className="shrink-0 pt-0.5 text-muted-foreground">
        <StatusIcon className={active ? "animate-spin text-accent" : failed ? "text-destructive" : "text-[var(--success)]"} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={item.label}>{item.label}</div>
          <span className="shrink-0 text-xs text-muted-foreground">{formatActivityTime(item.startedAt)}</span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden">
          <Badge variant={active ? "running" : failed ? "danger" : "success"}>
            {active ? "running" : failed ? "failed" : "completed"}
          </Badge>
          <span className="min-w-0 break-all text-xs text-muted-foreground">{item.source}</span>
          {item.method ? <span className="text-xs text-muted-foreground">{item.method}</span> : null}
        </div>
        {item.detail || item.path ? (
          <div className="mt-1.5 max-w-full truncate font-mono text-xs text-muted-foreground" title={item.detail || item.path}>{item.detail || item.path}</div>
        ) : null}
      </div>
    </div>
  );
}

export function ExternalActivityPopover({ compact = false, sidebar = false }) {
  const [activities, setActivities] = useState([]);

  useEffect(() => {
    let cancelled = false;
    getExternalActivitySnapshot().then((snapshot) => {
      if (!cancelled) {
        setActivities(sortActivities([...(snapshot?.active || []), ...(snapshot?.recent || [])]));
      }
    }).catch(() => {});
    const unsubscribe = subscribeExternalActivity((activity) => {
      setActivities((current) => upsertActivity(current, activity));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const active = useMemo(() => activities.filter((item) => item.phase === "started"), [activities]);
  const recent = useMemo(() => activities.filter((item) => item.phase !== "started").slice(0, 8), [activities]);
  const visibleActivityCount = active.length + recent.length;
  const activityListHeight = visibleActivityCount
    ? Math.min(460, 32 + (visibleActivityCount * 92) + (active.length && recent.length ? 9 : 0))
    : 144;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={compact ? "icon-sm" : "sm"}
          className={sidebar && !compact ? "w-full justify-start" : undefined}
          aria-label="External tool activity"
        >
          {active.length ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Activity data-icon="inline-start" />}
          {!compact ? "External activity" : null}
          {active.length && !compact ? <Badge variant="running">{active.length}</Badge> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className="flex max-h-[min(540px,var(--radix-popover-content-available-height))] w-[390px] max-w-[calc(100vw-16px)] flex-col overflow-hidden p-0"
      >
        <div className="flex min-w-0 shrink-0 items-start justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Radio className="shrink-0" aria-hidden="true" />
              <span className="truncate">External tool activity</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Live capability calls received by Zhuzhu.</p>
          </div>
          <Badge className="shrink-0" variant={active.length ? "running" : "neutral"}>{active.length ? `${active.length} active` : "idle"}</Badge>
        </div>
        <Separator />
        <ScrollArea
          type="always"
          className="w-full min-w-0 shrink-0 overflow-hidden"
          style={{
            height: activityListHeight,
            maxHeight: "calc(var(--radix-popover-content-available-height) - 74px)",
          }}
        >
          <div className="w-full min-w-0 max-w-full overflow-hidden px-3 py-2">
            {active.length ? (
              <section>
                <div className="px-1 py-1 text-xs font-medium text-muted-foreground">Now</div>
                {active.map((item) => <ActivityRow key={item.id} item={item} active />)}
              </section>
            ) : null}
            {active.length && recent.length ? <Separator /> : null}
            {recent.length ? (
              <section className={active.length ? "pt-2" : ""}>
                <div className="px-1 py-1 text-xs font-medium text-muted-foreground">Recent</div>
                {recent.map((item) => <ActivityRow key={item.id} item={item} />)}
              </section>
            ) : null}
            {!active.length && !recent.length ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center">
                <Activity className="text-muted-foreground" aria-hidden="true" />
                <div className="text-sm font-medium">No external calls yet</div>
                <p className="max-w-64 text-xs text-muted-foreground">Validate, test session, invoke, and app-run calls will appear here.</p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
