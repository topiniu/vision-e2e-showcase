import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  FileJson,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@panel/components/ui/alert";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@panel/components/ui/card";
import { Checkbox } from "@panel/components/ui/checkbox";
import { Input } from "@panel/components/ui/input";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@panel/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@panel/components/ui/sheet";
import { StepExecutionDetail } from "@panel/components/shared/StepExecutionDetail";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import { cn } from "@panel/lib/cn";
import { createRunReportModel } from "@panel/lib/run-report-model.mjs";
import { listRunArchive, readRunReport, rebuildRunArchive } from "@panel/lib/panel-api";

const PAGE_SIZE = 20;
const RunResultReportDialog = lazy(() =>
  import("@panel/features/results/RunResultReportDialog").then((module) => ({ default: module.RunResultReportDialog })),
);

const STATUS_OPTIONS = [
  { value: "all", label: "All status" },
  { value: "failed", label: "Failed" },
  { value: "passed", label: "Passed" },
  { value: "unknown", label: "Unknown" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(value) {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  const ms = Number(value);
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function dateInputToTimestamp(value, endOfDay = false) {
  if (!value) {
    return null;
  }
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function statusVariant(status) {
  if (status === "passed") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  return "neutral";
}

function statusIcon(status) {
  if (status === "passed") {
    return <CheckCircle2 data-icon="inline-start" />;
  }
  if (status === "failed") {
    return <XCircle data-icon="inline-start" />;
  }
  return <Clock3 data-icon="inline-start" />;
}

function surfaceLabel(value) {
  switch (value) {
    case "view":
      return "View";
    case "build-cases":
      return "Build cases";
    case "run":
      return "Run";
    default:
      return "Unknown";
  }
}

function getRunTitle(item) {
  return item.caseName || item.testFileName || item.testFilePath || "Untitled run";
}

function getRunSubtitle(item) {
  return [item.testFileName || item.testFilePath, item.caseName].filter(Boolean).join(" / ") || "-";
}

function findFailedStep(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const caseResults = Array.isArray(value.caseResults) ? value.caseResults : [];
  for (const caseResult of caseResults) {
    const found = findFailedStep(caseResult?.result || caseResult);
    if (found) {
      return found;
    }
  }
  const resultSteps = Array.isArray(value.data?.results)
    ? value.data.results
    : Array.isArray(value.summary?.data?.results)
      ? value.summary.data.results
      : [];
  for (const step of resultSteps) {
    if (step?.ok === false || step?.status === "failed") {
      return step;
    }
  }
  return value.ok === false ? value : null;
}

function pathButton(label, value) {
  if (!value) {
    return null;
  }
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => copyTextToClipboard(value)}>
      <ClipboardCopy data-icon="inline-start" />
      {label}
    </Button>
  );
}

export function HistoryPage({
  panelPlatform = "web",
  result,
  lastRunAt,
  testFileList = [],
  historyFocusReportPath = "",
  onNavigatePage,
  onSelectTestFile,
  onTestFileModeChange,
  onOpenProfessionalReport,
  onHistoryFocusConsumed,
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [failedOnly, setFailedOnly] = useState(false);
  const [testFilePath, setTestFilePath] = useState("all");
  const [sort, setSort] = useState("newest");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [archiveState, setArchiveState] = useState({ status: "idle", data: null, error: "" });
  const [selectedRun, setSelectedRun] = useState(null);
  const [reportState, setReportState] = useState({ status: "idle", data: null, error: "" });
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const archiveRequest = useMemo(() => ({
    page,
    pageSize: PAGE_SIZE,
    status: failedOnly ? "failed" : status,
    testFilePath: testFilePath === "all" ? "" : testFilePath,
    query,
    dateFrom: dateInputToTimestamp(dateFrom),
    dateTo: dateInputToTimestamp(dateTo, true),
    sort,
  }), [dateFrom, dateTo, failedOnly, page, query, sort, status, testFilePath]);

  const loadArchive = useCallback(() => {
    let cancelled = false;
    setArchiveState((current) => ({ ...current, status: "loading", error: "" }));
    listRunArchive(archiveRequest)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setArchiveState(
          payload?.success
            ? { status: "loaded", data: payload, error: "" }
            : { status: "error", data: null, error: payload?.message || payload?.error || "load-failed" },
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setArchiveState({ status: "error", data: null, error: error?.message || "load-failed" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [archiveRequest]);

  useEffect(() => loadArchive(), [loadArchive, refreshToken, lastRunAt, result]);

  useEffect(() => {
    setPage(1);
  }, [dateFrom, dateTo, failedOnly, query, sort, status, testFilePath]);

  useEffect(() => {
    let cancelled = false;
    if (!historyFocusReportPath) {
      return () => {
        cancelled = true;
      };
    }
    setReportState({ status: "loading", data: null, error: "" });
    readRunReport({ reportPath: historyFocusReportPath })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (payload?.success) {
          setSelectedRun(payload.summary || { reportPath: historyFocusReportPath, status: "unknown" });
          setReportState({ status: "loaded", data: payload, error: "" });
          return;
        }
        setReportState({ status: "error", data: null, error: payload?.message || payload?.error || "read-failed" });
      })
      .catch((error) => {
        if (!cancelled) {
          setReportState({ status: "error", data: null, error: error?.message || "read-failed" });
        }
      })
      .finally(() => {
        if (!cancelled) {
          onHistoryFocusConsumed?.();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [historyFocusReportPath]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedRun?.reportPath) {
      setReportState({ status: "idle", data: null, error: "" });
      return () => {
        cancelled = true;
      };
    }
    setReportState({ status: "loading", data: null, error: "" });
    readRunReport({ reportPath: selectedRun.reportPath })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setReportState(
          payload?.success
            ? { status: "loaded", data: payload, error: "" }
            : { status: "error", data: null, error: payload?.message || payload?.error || "read-failed" },
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setReportState({ status: "error", data: null, error: error?.message || "read-failed" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRun?.reportPath]);

  const archive = archiveState.data;
  const items = archive?.items || [];
  const stats = archive?.stats || {};
  const totalPages = archive?.totalPages || 1;
  const selectedReport = reportState.data?.report || null;
  const selectedFailedStep = selectedReport ? findFailedStep(selectedReport.summary || selectedReport) : null;
  const selectedFailure = selectedRun?.firstFailure || reportState.data?.summary?.firstFailure || null;
  const selectedReportModel = useMemo(
    () =>
      selectedRun || selectedReport
        ? createRunReportModel({
            report: selectedReport,
            summary: reportState.data?.summary || selectedRun,
          })
        : null,
    [selectedReport, selectedRun, reportState.data?.summary],
  );
  const shouldAvoidTitlebar = panelPlatform === "darwin";

  const openRunContext = async (item) => {
    if (item?.testFilePath) {
      await onSelectTestFile?.(item.testFilePath);
    }
    onTestFileModeChange?.("run");
    onNavigatePage?.("test-file");
  };

  const rebuildArchive = async () => {
    setArchiveState((current) => ({ ...current, status: "loading", error: "" }));
    const response = await rebuildRunArchive();
    if (!response?.success) {
      setArchiveState({ status: "error", data: null, error: response?.message || response?.error || "rebuild-failed" });
      return;
    }
    setRefreshToken((value) => value + 1);
  };

  return (
    <main className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="grid gap-3 min-[1100px]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">History</p>
          <h1 className="text-[18px] font-semibold leading-7 text-foreground">Run archive</h1>
          <p className="max-w-3xl text-[12px] leading-5 text-muted-foreground">
            Persistent run records from output/runs, optimized for failed-run triage.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setRefreshToken((value) => value + 1)}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={rebuildArchive}>
            <RotateCcw data-icon="inline-start" />
            Rebuild index
          </Button>
        </div>
      </header>

      <section className="grid gap-3 min-[900px]:grid-cols-5">
        <MetricCard icon={BarChart3} label="Total runs" value={stats.totalRuns ?? "-"} />
        <MetricCard icon={XCircle} label="Failed" value={stats.failedRuns ?? "-"} danger />
        <MetricCard icon={Clock3} label="Avg duration" value={formatDuration(stats.averageDurationMs)} />
        <MetricCard icon={AlertCircle} label="Latest failure" value={formatDateTime(stats.latestFailureAt)} />
        <MetricCard icon={FileJson} label="Archive size" value={formatBytes(stats.archiveBytes)} />
      </section>

      <Card className="min-h-0 flex-1 overflow-hidden rounded-[8px]">
        <CardHeader className="border-b border-border px-3 py-3">
          <div className="grid gap-2 min-[1100px]:grid-cols-[minmax(180px,1fr)_auto_auto_auto_auto_auto] min-[1400px]:grid-cols-[minmax(220px,1fr)_auto_auto_auto_auto_auto_auto]">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-7 text-[12px]"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search file, case, failure, path..."
              />
            </div>
            <Select value={status} onValueChange={setStatus} disabled={failedOnly}>
              <SelectTrigger className="h-8 min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={testFilePath} onValueChange={setTestFilePath}>
              <SelectTrigger className="h-8 min-w-40 max-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All test files</SelectItem>
                  {testFileList.map((file) => (
                    <SelectItem key={file.path} value={file.path}>{file.name || file.path}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-8 min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Input className="h-8 w-36 text-[12px]" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            <Input className="h-8 w-36 text-[12px]" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            <label className="flex h-8 items-center gap-2 text-[12px] text-muted-foreground">
              <Checkbox checked={failedOnly} onCheckedChange={(checked) => setFailedOnly(Boolean(checked))} />
              Failed only
            </label>
          </div>
        </CardHeader>

        <CardContent className="min-h-0 p-0">
          {archiveState.status === "loading" ? (
            <div className="flex h-48 items-center justify-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading archive
            </div>
          ) : null}

          {archiveState.status === "error" ? (
            <Alert className="m-3">
              <AlertCircle />
              <AlertTitle>Archive unavailable</AlertTitle>
              <AlertDescription>{archiveState.error}</AlertDescription>
            </Alert>
          ) : null}

          {archiveState.status === "loaded" && !items.length ? (
            <div className="m-3 rounded-[8px] border border-dashed border-border bg-muted/30 p-6 text-[12px] text-muted-foreground">
              No run records match the current filters.
            </div>
          ) : null}

          {items.length ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="grid grid-cols-[104px_minmax(220px,1.4fr)_minmax(180px,1fr)_96px_84px_90px_minmax(180px,1fr)] gap-3 border-b border-border px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>Status</span>
                <span>Run</span>
                <span>File</span>
                <span>Source</span>
                <span>Steps</span>
                <span>Duration</span>
                <span>Failure</span>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="divide-y divide-border">
                  {items.map((item) => (
                    <button
                      key={item.reportPath}
                      type="button"
                      className="grid w-full grid-cols-[104px_minmax(220px,1.4fr)_minmax(180px,1fr)_96px_84px_90px_minmax(180px,1fr)] gap-3 px-3 py-3 text-left text-[12px] transition-colors hover:bg-muted/50 data-[active=true]:bg-[var(--accent-soft)]"
                      data-active={selectedRun?.reportPath === item.reportPath}
                      onClick={() => setSelectedRun(item)}
                    >
                      <span className="flex items-start">
                        <RunStatusBadge status={item.status} />
                      </span>
                      <span className="min-w-0">
                        <strong className="block truncate text-[13px] text-foreground">{getRunTitle(item)}</strong>
                        <span className="block truncate text-muted-foreground">{formatDateTime(item.finishedAt || item.startedAt)}</span>
                      </span>
                      <span className="min-w-0">
                        <strong className="block truncate text-foreground">{item.testFileName || "-"}</strong>
                        <span className="block truncate font-mono text-[12px] text-muted-foreground">{item.testFilePath || "-"}</span>
                      </span>
                      <span className="text-muted-foreground">{surfaceLabel(item.runContext?.triggerSurface)}</span>
                      <span className="text-muted-foreground">{item.okCount ?? 0}/{item.steps ?? 0}</span>
                      <span className="text-muted-foreground">{formatDuration(item.durationMs)}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{item.firstFailure?.message || "-"}</span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
              <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
                <span>{archive.total || 0} records · page {page} / {totalPages}</span>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                    Previous
                  </Button>
                  <Button type="button" variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
                    Next
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Sheet open={Boolean(selectedRun)} onOpenChange={(open) => !open && setSelectedRun(null)}>
        <SheetContent
          className={cn(
            "!w-[min(92vw,640px)] !max-w-[640px] gap-0 overflow-hidden p-0 sm:!max-w-[640px]",
            shouldAvoidTitlebar && "!top-12 !bottom-0 !h-auto max-h-[calc(100dvh-48px)]",
          )}
          side="right"
          showCloseButton={false}
        >
          {selectedRun ? (
            <>
              <SheetHeader className="border-b border-border px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <SheetTitle className="truncate text-[15px]">{getRunTitle(selectedRun)}</SheetTitle>
                    <SheetDescription className="truncate">{getRunSubtitle(selectedRun)}</SheetDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RunStatusBadge status={selectedRun.status} className="h-6" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Close run details"
                      onClick={() => setSelectedRun(null)}
                    >
                      <X />
                    </Button>
                  </div>
                </div>
              </SheetHeader>

              <ScrollArea className="min-h-0 flex-1">
                <div className="grid gap-0">
                  <DetailSection title="Run summary">
                    <DetailRow label="Finished" value={formatDateTime(selectedRun.finishedAt || selectedRun.startedAt)} />
                    <DetailRow label="Duration" value={formatDuration(selectedRun.durationMs)} />
                    <DetailRow label="Source" value={`${surfaceLabel(selectedRun.runContext?.triggerSurface)} / ${selectedRun.runContext?.scope || "unknown"}`} />
                    <DetailRow label="Steps" value={`${selectedRun.okCount ?? 0}/${selectedRun.steps ?? 0} passed`} />
                    <DetailRow label="Browser URL" value={selectedRun.browserUrl || "-"} mono />
                  </DetailSection>

                  <DetailSection title="Failure">
                    {selectedFailure ? (
                      <>
                        <DetailRow label="Message" value={selectedFailure.message || "-"} danger />
                        <DetailRow label="Step" value={selectedFailure.stepTitle || selectedFailure.stepId || "-"} />
                        <DetailRow label="Action" value={selectedFailure.actionType || "-"} />
                        <DetailRow label="Phase" value={selectedFailure.phase || "-"} />
                        <div className="mt-2 flex flex-wrap gap-2">
                          {pathButton("Copy trace", selectedFailure.tracePath)}
                          {pathButton("Copy before shot", selectedFailure.beforeScreenshotPath)}
                          {pathButton("Copy after shot", selectedFailure.afterScreenshotPath)}
                        </div>
                      </>
                    ) : (
                      <p className="text-[12px] text-muted-foreground">No failed step summary is available for this run.</p>
                    )}
                  </DetailSection>

                  <DetailSection title="Artifacts">
                    <DetailRow label="Report" value={selectedRun.reportPath || "-"} mono />
                    <DetailRow label="Run dir" value={selectedRun.runDir || "-"} mono />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {pathButton("Copy report", selectedRun.reportPath)}
                      {pathButton("Copy run dir", selectedRun.runDir)}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={reportState.status === "loading" || (!selectedReport && !selectedRun)}
                        onClick={() => setReportDialogOpen(true)}
                      >
                        <BarChart3 data-icon="inline-start" />
                        Open report
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={reportState.status === "loading" || !selectedReportModel}
                        onClick={() => onOpenProfessionalReport?.(selectedReportModel)}
                      >
                        <FileJson data-icon="inline-start" />
                        Open new report
                      </Button>
                      <Button type="button" variant="secondary" size="sm" onClick={() => openRunContext(selectedRun)}>
                        <FolderOpen data-icon="inline-start" />
                        Open in Run
                      </Button>
                    </div>
                  </DetailSection>

                  <DetailSection title="Step detail">
                    {reportState.status === "loading" ? (
                      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Loading report
                      </div>
                    ) : null}
                    {reportState.status === "error" ? (
                      <Alert>
                        <AlertCircle />
                        <AlertTitle>Report unavailable</AlertTitle>
                        <AlertDescription>{reportState.error}</AlertDescription>
                      </Alert>
                    ) : null}
                    {selectedFailedStep ? (
                      <StepExecutionDetail
                        step={{ raw: selectedFailedStep }}
                        tracePath={selectedFailure?.tracePath || selectedFailedStep.evidence?.tracePath}
                        compact
                      />
                    ) : reportState.status === "loaded" ? (
                      <Alert>
                        <FileJson />
                        <AlertTitle>No failed step detail</AlertTitle>
                        <AlertDescription>The report is readable, but it does not contain a failed step payload.</AlertDescription>
                      </Alert>
                    ) : null}
                  </DetailSection>
                </div>
              </ScrollArea>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <Suspense fallback={null}>
        <RunResultReportDialog
          open={reportDialogOpen}
          onOpenChange={setReportDialogOpen}
          model={selectedReportModel}
          titlebarSafe={shouldAvoidTitlebar}
        />
      </Suspense>
    </main>
  );
}

function MetricCard({ icon: Icon, label, value, danger = false }) {
  return (
    <Card className="rounded-[8px]">
      <CardHeader className="flex-row items-center justify-between px-3 py-3">
        <div>
          <CardDescription className="text-[12px]">{label}</CardDescription>
          <CardTitle className={`mt-1 text-[18px] ${danger ? "text-destructive" : ""}`}>{value}</CardTitle>
        </div>
        <Icon className={cn("size-5", danger ? "text-destructive" : "text-muted-foreground")} />
      </CardHeader>
    </Card>
  );
}

function RunStatusBadge({ status, className }) {
  return (
    <Badge
      variant={statusVariant(status)}
      className={cn(
        "h-[22px] gap-1.5 rounded-[5px] px-1.5 text-[12px] font-semibold leading-none",
        className,
      )}
    >
      {statusIcon(status)}
      {status}
    </Badge>
  );
}

function DetailSection({ title, children }) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function DetailRow({ label, value, mono = false, danger = false }) {
  return (
    <div className="flex items-start gap-4 border-b border-border/60 py-2 last:border-b-0">
      <span className="w-24 shrink-0 text-[12px] leading-5 text-muted-foreground">{label}</span>
      <strong
        className={`min-w-0 break-all text-[12px] font-medium leading-5 ${mono ? "font-mono text-[12px]" : ""} ${danger ? "text-destructive" : "text-foreground"}`}
      >
        {value}
      </strong>
    </div>
  );
}
