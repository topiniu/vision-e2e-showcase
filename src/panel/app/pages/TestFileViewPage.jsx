import { useMemo, useState } from "react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@panel/components/ui/card";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { FullTextTooltip } from "@panel/components/shared/FullTextTooltip";
import { cn } from "@panel/lib/cn";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@panel/components/ui/sheet";
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Hammer,
  History,
  Loader2,
  PencilLine,
  PlayCircle,
  X,
} from "lucide-react";
import styles from "./TestFileViewPage.module.css";

const TAG_PALETTES = [
  { color: "#9a3412", bg: "#fff1e8", border: "#fed7aa" },
  { color: "#6d28d9", bg: "#ede9fe", border: "#ddd6fe" },
  { color: "#b45309", bg: "#fef3c7", border: "#fde68a" },
  { color: "#065f46", bg: "#d1fae5", border: "#a7f3d0" },
  { color: "#9d174d", bg: "#fce7f3", border: "#fbcfe8" },
  { color: "#6c355b", bg: "#f5eaf1", border: "#e7cfe0" },
];

const PRIORITY_VARIANTS = {
  P0: "danger",
  P1: "neutral",
  P2: "running",
};

export function TestFileViewPage({
  testFile,
  selectedCaseId,
  result,
  lastRunAt,
  history = [],
  onModeChange,
  onSelectCase,
  onRunAll,
  onOpenHistoryRun,
  historyOnly = false,
}) {
  const [drawerCaseId, setDrawerCaseId] = useState(null);
  const cases = testFile?.cases || [];
  const drawerCase = cases.find((item) => item.id === drawerCaseId) || null;
  const totalCaseSteps = cases.reduce((sum, item) => sum + (item.steps?.length || 0), 0);
  const requirement = testFile?.requirement || {};
  const latestRun = getLatestRunSummary(result, history, lastRunAt);
  const drawerLatestRun = getCaseRunSummary(drawerCase, result, history, lastRunAt);
  const runTone = getRunTone(latestRun.label);

  const fileTags = useMemo(
    () => (testFile?.tags || []).map((label, index) => ({
      label,
      ...TAG_PALETTES[index % TAG_PALETTES.length],
    })),
    [testFile?.tags],
  );

  const openLatestRunCase = (mode) => {
    if (!latestRun.caseId) {
      return;
    }
    onSelectCase?.(latestRun.caseId);
    onModeChange?.(mode);
  };

  if (historyOnly) {
    return (
      <div className="grid min-h-0 content-start gap-3">
        <HistorySummary
          latestRun={latestRun}
          history={history}
          onOpenHistoryRun={onOpenHistoryRun}
          onOpenCaseInBuild={() => openLatestRunCase("build-cases")}
        />
      </div>
    );
  }

  const openCaseDrawer = (caseItem) => {
    onSelectCase?.(caseItem.id);
    setDrawerCaseId(caseItem.id);
  };

  return (
    <>
      <main className={styles.page}>
        <div className={styles.viewport}>
          <div className="grid h-full min-h-0 w-full grid-cols-1 items-stretch gap-4 min-[960px]:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[minmax(0,1fr)_320px] min-[1800px]:xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3">
              <section className={styles.commandPanel}>
                <div className={styles.commandHeader}>
                  <div className={styles.fileSummary}>
                    <div className={styles.kickerRow}>
                      <span>{testFile?.group || "Ungrouped"}</span>
                      <span aria-hidden="true">/</span>
                      <span>{requirement.version ? `v${requirement.version}` : "No version"}</span>
                    </div>
                    <FullTextTooltip content={testFile?.name || "Untitled test file"} side="bottom" align="start">
                      <h2 className={styles.fileTitle}>{testFile?.name || "Untitled test file"}</h2>
                    </FullTextTooltip>
                    <p className={styles.fileDescription} title={testFile?.description || ""}>
                      {compactPreviewText(testFile?.description, 260) || "No description."}
                    </p>
                    {fileTags.length ? (
                      <div className={styles.tagRow}>
                        {fileTags.map((tag) => (
                          <span
                            key={tag.label}
                            className={styles.fileTag}
                            style={{ color: tag.color, backgroundColor: tag.bg, borderColor: tag.border }}
                          >
                            {tag.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className={cn(styles.runVerdict, styles[runTone])}>
                    <div className={styles.runVerdictTop}>
                      <span className={styles.runVerdictIcon}>{latestRun.icon}</span>
                      <div>
                        <p className={styles.runVerdictLabel}>{latestRun.label}</p>
                        <p className={styles.runVerdictMeta}>{latestRun.lastRun}</p>
                      </div>
                    </div>
                    <div className={styles.runVerdictGrid}>
                      <MiniMetric label="Steps" value={latestRun.stepSummary} />
                      <MiniMetric label="Duration" value={latestRun.duration} />
                    </div>
                  </div>
                </div>

                <div className={styles.commandFooter}>
                  <div className={styles.primaryActions}>
                    <Button
                      size="lg"
                      className={styles.primaryRunButton}
                      onClick={() => {
                        onModeChange("run");
                        onRunAll?.();
                      }}
                    >
                      <PlayCircle data-icon="inline-start" />
                      Run file
                    </Button>
                    <Button size="lg" variant="secondary" onClick={() => onModeChange("build-cases")}>
                      <Hammer data-icon="inline-start" />
                      Build cases
                    </Button>
                    <Button size="lg" variant="secondary" onClick={() => onModeChange("edit-file")}>
                      <PencilLine data-icon="inline-start" />
                      Edit file
                    </Button>
                  </div>

                  <div className={styles.fileStats} aria-label="File summary">
                    <MiniMetric label="Cases" value={String(cases.length)} />
                    <MiniMetric label="Steps" value={String(totalCaseSteps)} />
                    <MiniMetric label="Owner" value={requirement.owner || "-"} />
                  </div>
                </div>
              </section>

              <Card className={styles.casesPanel}>
                <CardHeader className={styles.casesHeader}>
                  <div>
                    <span className={styles.sectionKicker}>Cases</span>
                    <CardTitle className={styles.sectionTitle}>用例清单</CardTitle>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => onModeChange("build-cases")}>
                    <Hammer data-icon="inline-start" />
                    Build
                  </Button>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 p-0">
                  {cases.length ? (
                    <ScrollArea className="h-full">
                      <div className={styles.caseList}>
                        {cases.map((caseItem) => {
                          const caseRun = getCaseRunSummary(caseItem, result, history, lastRunAt);
                          return (
                            <CaseListItem
                              key={caseItem.id}
                              caseItem={caseItem}
                              latestRun={caseRun}
                              active={caseItem.id === drawerCase?.id}
                              onClick={() => openCaseDrawer(caseItem)}
                            />
                          );
                        })}
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className={styles.emptyCases}>
                      No cases in this file.
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>

            <aside className="hidden min-h-0 min-w-0 overflow-hidden min-[960px]:block">
              <ScrollArea className="h-full">
                <div className="grid gap-3 pr-1">
                  <SectionCard label="Requirement" heading={requirement.name || "-"}>
                    <div>
                      <InfoRow label="Version" value={requirement.version || "-"} />
                      <InfoRow label="Owner" value={requirement.owner || "-"} />
                      <InfoRow label="Module" value={requirement.module || "-"} />
                    </div>
                    <p className="mt-2 mb-3 line-clamp-3 text-[13px] leading-5 text-muted-foreground" title={requirement.description || ""}>
                      {compactPreviewText(requirement.description, 150) || "No requirement description."}
                    </p>
                    <div className="border-t border-border pt-3">
                      <p className="mb-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">File</p>
                      <InfoRow label="File ID" value={testFile?.id || "-"} mono />
                      <InfoRow label="Schema" value={String(testFile?.schemaVersion || 2)} />
                      <InfoRow label="Base URL" value={testFile?.baseUrl || "-"} mono />
                      <InfoRow label="Created" value={<TimestampPreview value={testFile?.createdAt} />} />
                      <InfoRow label="Updated" value={<TimestampPreview value={testFile?.updatedAt} />} />
                      <InfoRow label="Cases" value={String(cases.length)} />
                      <InfoRow label="Steps" value={String(totalCaseSteps)} />
                    </div>
                  </SectionCard>

                  <HistorySummary
                    latestRun={latestRun}
                    history={history}
                    compact
                    onOpenHistoryRun={onOpenHistoryRun}
                    onOpenCaseInBuild={() => openLatestRunCase("build-cases")}
                  />
                </div>
              </ScrollArea>
            </aside>
          </div>
        </div>
      </main>

      <CaseDetailSheet
        caseItem={drawerCase}
        latestRun={drawerLatestRun}
        onClose={() => setDrawerCaseId(null)}
        onEdit={() => {
          if (drawerCase) {
            onSelectCase?.(drawerCase.id);
          }
          onModeChange("build-cases");
        }}
        onOpenCaseInBuild={() => {
          if (drawerCase) {
            onSelectCase?.(drawerCase.id);
          }
          onModeChange("build-cases");
        }}
      />
    </>
  );
}

function MiniMetric({ label, value }) {
  return (
    <div className={styles.miniMetric}>
      <span>{label}</span>
      <strong title={String(value)}>{value}</strong>
    </div>
  );
}

function CaseListItem({ caseItem, latestRun, active, onClick }) {
  const tags = caseItem.tags || [];
  const keyLabel = getCaseKey(caseItem);
  const runTone = getRunTone(latestRun.label);
  return (
    <FullTextTooltip content={caseItem.name} side="right" align="start">
      <button
        type="button"
        className={cn(styles.caseItem, styles[runTone])}
        data-active={active}
        onClick={onClick}
      >
      <div className={styles.caseMarker} aria-hidden="true" />
      <div className={styles.caseBody}>
        <div className={styles.caseMainRow}>
          <div className={styles.caseTitleGroup}>
            {keyLabel ? <span className={styles.caseKey}>{keyLabel}</span> : null}
            <p className={styles.caseTitle}>
              {keyLabel ? stripCaseKey(caseItem.name, keyLabel) : caseItem.name}
            </p>
          </div>
          <div className={styles.caseBadges}>
            <PriorityBadge priority={caseItem.priority || "P1"} />
            <span className={styles.caseStatus}>
              {latestRun.icon}
              {latestRun.label}
            </span>
          </div>
        </div>
        <div className={styles.caseMetaRow}>
          <span>{(caseItem.steps?.length || 0)} step{(caseItem.steps?.length || 0) === 1 ? "" : "s"}</span>
          {latestRun.lastRun !== "-" ? <span>{latestRun.lastRun}</span> : null}
          {tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
        </div>
        {caseItem.description ? (
          <p className={styles.caseDescription} title={caseItem.description}>
            {compactPreviewText(caseItem.description, 120)}
          </p>
        ) : null}
      </div>
      <ChevronRight
        className={styles.caseChevron}
        data-icon="inline-end"
      />
      </button>
    </FullTextTooltip>
  );
}

function CaseDetailSheet({
  caseItem,
  latestRun,
  onClose,
  onEdit,
  onOpenCaseInBuild,
}) {
  const open = Boolean(caseItem);
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        onClose();
      }
    }}>
      <SheetContent
        className="!w-[min(92vw,420px)] !max-w-[420px] gap-0 p-0 sm:!max-w-[420px] min-[1800px]:!w-[460px] min-[1800px]:!max-w-[460px]"
        side="right"
        showCloseButton={false}
        style={{
          top: "var(--window-titlebar-height, 48px)",
          bottom: 0,
          height: "auto",
        }}
      >
        {caseItem ? (
          <>
            <SheetHeader className="border-b border-[#e5e7eb] px-4 pt-4 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="mb-0.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                    {getCaseKey(caseItem) || "Case"}
                  </p>
                  <SheetTitle className="text-[14px] font-semibold leading-[19px] text-foreground">
                    {stripCaseKey(caseItem.name, getCaseKey(caseItem))}
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    Case details and recent run status.
                  </SheetDescription>
                </div>
                <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close case details">
                  <X />
                </Button>
              </div>
            </SheetHeader>

            <ScrollArea className="min-h-0 flex-1">
              <div className="grid gap-0">
                <SheetSection title="Case details">
                  <InfoRow label="ID" value={caseItem.id || "-"} mono />
                  <InfoRow label="Priority" value={<PriorityBadge priority={caseItem.priority || "P1"} />} />
                  <InfoRow label="Steps" value={String(caseItem.steps?.length || 0)} />
                  <InfoRow label="Fixtures" value={caseItem.fixtures?.length ? caseItem.fixtures.join(", ") : "-"} />
                  <InfoRow label="Tags" value={caseItem.tags?.length ? caseItem.tags.join(", ") : "-"} />
                </SheetSection>

                <SheetSection title="Description" bordered>
                  <p className="text-[12px] leading-[19px] text-muted-foreground">{caseItem.description || "No description."}</p>
                </SheetSection>

                <SheetSection title="Recent run">
                  <div className="mb-3 flex items-center gap-2">
                    {latestRun.icon}
                    <span className="text-[13px] font-semibold text-foreground">{latestRun.label}</span>
                  </div>
                  <InfoRow label="Last run" value={latestRun.lastRun} />
                  <InfoRow label="Duration" value={latestRun.duration} />
                  <InfoRow label="Steps" value={latestRun.stepSummary} />
                  <InfoRow label="Source" value={latestRun.sourceLabel} />
                  {latestRun.caseName !== "-" ? (
                    <InfoRow
                      label="Case"
                      value={(
                        <CaseRunActions
                          caseName={latestRun.caseName}
                          disabled={!latestRun.caseId}
                          onOpenBuild={onOpenCaseInBuild}
                        />
                      )}
                    />
                  ) : null}
                  {latestRun.failure ? <InfoRow label="Failure" value={latestRun.failure} /> : null}
                </SheetSection>
              </div>
            </ScrollArea>

            <SheetFooter className="border-t border-[#e5e7eb] px-4 py-3">
              <Button className="w-full justify-center" onClick={onEdit}>
                <PencilLine data-icon="inline-start" />
                Open in Build cases
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function SectionCard({ label, heading, children }) {
  return (
    <Card className={styles.sideCard}>
      <CardHeader className={styles.sideHeader}>
        <span className={styles.sectionKicker}>{label}</span>
        <CardTitle className={styles.sideTitle}>{heading}</CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3">{children}</CardContent>
    </Card>
  );
}

function SheetSection({ title, heading = null, bordered = false, children }) {
  return (
    <section className={bordered ? "border-b border-[#e5e7eb] px-4 py-4" : "px-4 py-4"}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        {heading ? <span className="text-[12px] font-semibold text-foreground">{heading}</span> : null}
      </div>
      {children}
    </section>
  );
}

function HistorySummary({
  latestRun,
  history = [],
  compact = false,
  onOpenHistoryRun,
  onOpenCaseInBuild,
}) {
  const canOpenDetails = Boolean(onOpenHistoryRun && latestRun.reportPath && latestRun.reportPath !== "-");
  const runTone = getRunTone(latestRun.label);
  return (
    <SectionCard
      label="Recent run"
      heading={(
        <span className={cn(styles.sideVerdictTitle, styles[runTone])}>
          {latestRun.icon}
          {latestRun.label}
        </span>
      )}
    >
      <InfoRow label="Last run" value={latestRun.lastRun} />
      <InfoRow label="Duration" value={latestRun.duration} />
      <InfoRow label="Steps" value={latestRun.stepSummary} />
      <InfoRow label="Source" value={latestRun.sourceLabel} />
      {latestRun.caseName !== "-" ? (
        <InfoRow
          label="Case"
          value={(
            <CaseRunActions
              caseName={latestRun.caseName}
              disabled={!latestRun.caseId}
              onOpenBuild={onOpenCaseInBuild}
            />
          )}
        />
      ) : null}
      {latestRun.failure ? <InfoRow label="Failure" value={latestRun.failure} /> : null}
      <InfoRow label="Report" value={<PathPreview value={latestRun.report} />} />
      {history.length > 1 || !compact ? <InfoRow label="Archive" value={history.length > 1 ? `${history.length} recent runs` : "-"} /> : null}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-3 w-full justify-center"
        disabled={!canOpenDetails}
        onClick={() => onOpenHistoryRun?.(latestRun.reportPath)}
      >
        <History data-icon="inline-start" />
        View history detail
      </Button>
    </SectionCard>
  );
}

function CaseRunActions({ caseName, disabled = false, onOpenBuild }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <FullTextTooltip content={caseName} side="left" align="start">
        <span className="line-clamp-2 min-w-0 break-words text-[12px] font-medium leading-5 text-foreground">
          {compactPreviewText(caseName, 64)}
        </span>
      </FullTextTooltip>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onOpenBuild}>
          <Hammer data-icon="inline-start" />
          Build cases
        </Button>
      </div>
    </div>
  );
}

function PriorityBadge({ priority }) {
  return <Badge variant={PRIORITY_VARIANTS[priority] || "neutral"}>{priority}</Badge>;
}

function PathPreview({ value }) {
  if (!value || value === "-") {
    return "-";
  }
  return (
    <span className="block truncate font-mono text-[12px] font-medium text-muted-foreground" title={value}>
      {compactPath(value)}
    </span>
  );
}

function TimestampPreview({ value }) {
  if (!value) {
    return "-";
  }
  const formatted = formatDate(value);
  const displayValue = formatted === "-" ? String(value) : formatted;
  return <span title={String(value)}>{displayValue}</span>;
}

function InfoRow({ label, value, mono = false }) {
  return (
    <div className="flex items-start gap-4 border-b border-border py-2 last:border-0">
      <span className="w-20 shrink-0 text-[12px] leading-5 text-muted-foreground">{label}</span>
      <div className={`min-w-0 break-all text-[12px] font-medium leading-5 text-foreground ${mono ? "font-mono text-[12px] text-muted-foreground" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function compactPath(value, maxLength = 54) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  const parts = text.split("/");
  const fileName = parts[parts.length - 1] || text.slice(-24);
  const parent = parts[parts.length - 2] || "";
  const tail = parent ? `${parent}/${fileName}` : fileName;
  if (tail.length >= maxLength - 2) {
    return `...${tail.slice(-(maxLength - 3))}`;
  }
  return `.../${tail}`;
}

function compactPreviewText(value, maxLength = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  const slice = text.slice(0, maxLength);
  const punctuationIndex = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf(";"),
    slice.lastIndexOf("."),
    slice.lastIndexOf("，"),
    slice.lastIndexOf(","),
  );
  const shouldCutAtPunctuation = punctuationIndex >= Math.floor(maxLength * 0.55);
  const compact = shouldCutAtPunctuation ? slice.slice(0, punctuationIndex) : slice;
  return `${compact.replace(/[，,；;。.\s]+$/, "")}...`;
}

function getLatestRunSummary(result, history, lastRunAt) {
  const latestPersisted = history[0] || null;
  const latestOk = result ? result.ok : latestPersisted?.ok;
  const latestDuration = result?.telemetry?.durationMs ?? latestPersisted?.telemetry?.durationMs;
  const latestSteps = result?.telemetry?.steps ?? latestPersisted?.telemetry?.steps;
  const latestOkCount = result?.telemetry?.okCount ?? latestPersisted?.telemetry?.okCount;
  const latestErrorCount = result?.telemetry?.errorCount ?? latestPersisted?.telemetry?.errorCount;
  const latestReport = result?.evidence?.reportPath || result?.evidence?.caseRuns?.[0]?.reportPath || latestPersisted?.reportPath || "-";
  const latestFailure = result?.error || latestPersisted?.error || latestPersisted?.firstFailure || null;
  const latestRunContext = result?.runContext || latestPersisted?.runContext || {};
  const latestTestContext = result?.testContext || latestPersisted?.testContext || {};
  const finishedAt = lastRunAt || latestPersisted?.finishedAt;
  const running = result?.running === true;
  const sourceLabel = formatRunSource(latestRunContext);
  const stepSummary = formatStepSummary(latestSteps, latestOkCount, latestErrorCount);
  const caseName = latestTestContext.caseName || latestPersisted?.caseName || "-";
  const caseId = latestTestContext.caseId || latestPersisted?.caseId || "";
  const failure = latestOk === false ? formatFailure(latestFailure) : "";
  if (running) {
    return {
      label: "Running",
      icon: <Loader2 className="text-primary animate-spin" />,
      lastRun: finishedAt ? formatDate(finishedAt) : "-",
      duration: latestDuration != null ? formatDuration(latestDuration) : "-",
      steps: latestSteps != null ? String(latestSteps) : "-",
      stepSummary,
      sourceLabel,
      caseName,
      caseId,
      failure,
      report: latestReport,
      reportPath: latestReport,
    };
  }
  return {
    label: latestOk == null ? "No run yet" : latestOk ? "Passed" : "Failed",
    icon: latestOk == null
      ? <Clock className="text-muted-foreground" />
      : latestOk
        ? <CheckCircle2 className="text-emerald-500" />
        : <FileText className="text-[#d92d20]" />,
    lastRun: finishedAt ? formatDate(finishedAt) : "-",
    duration: latestDuration != null ? formatDuration(latestDuration) : "-",
    steps: latestSteps != null ? String(latestSteps) : "-",
    stepSummary,
    sourceLabel,
    caseName,
    caseId,
    failure,
    report: latestReport,
    reportPath: latestReport,
  };
}

function getCaseRunSummary(caseItem, result, history, lastRunAt) {
  if (!caseItem) {
    return createEmptyRunSummary();
  }
  const liveCaseResult = findCaseResult(result, caseItem);
  const latestPersistedCase = (history || []).find((item) => {
    if (item?.caseId && item.caseId === caseItem.id) {
      return true;
    }
    return !item?.caseId && item?.caseName && item.caseName === caseItem.name;
  });
  const source = liveCaseResult || latestPersistedCase || null;
  if (!source) {
    return createEmptyRunSummary({
      caseId: caseItem.id,
      caseName: caseItem.name,
    });
  }

  const telemetry = source.telemetry || {};
  const latestOk = source.ok;
  const latestDuration = telemetry.durationMs ?? source.durationMs;
  const latestSteps = telemetry.steps ?? source.steps;
  const latestOkCount = telemetry.okCount ?? source.okCount;
  const latestErrorCount = telemetry.errorCount ?? source.errorCount;
  const latestReport = source.evidence?.reportPath || source.reportPath || "-";
  const latestFailure = source.error || source.firstFailure || null;
  const finishedAt = source.finishedAt || lastRunAt;
  const running = source.running === true;
  const failure = latestOk === false ? formatFailure(latestFailure) : "";

  return {
    label: running ? "Running" : latestOk == null ? "No run yet" : latestOk ? "Passed" : "Failed",
    icon: running
      ? <Loader2 className="text-primary animate-spin" />
      : latestOk == null
        ? <Clock className="text-muted-foreground" />
        : latestOk
          ? <CheckCircle2 className="text-emerald-500" />
          : <FileText className="text-[#d92d20]" />,
    lastRun: finishedAt ? formatDate(finishedAt) : "-",
    duration: latestDuration != null ? formatDuration(latestDuration) : "-",
    steps: latestSteps != null ? String(latestSteps) : "-",
    stepSummary: formatStepSummary(latestSteps, latestOkCount, latestErrorCount),
    sourceLabel: formatRunSource(source.runContext || {}),
    caseName: caseItem.name,
    caseId: caseItem.id,
    failure,
    report: latestReport,
    reportPath: latestReport,
  };
}

function createEmptyRunSummary(overrides = {}) {
  return {
    label: "No run yet",
    icon: <Clock className="text-muted-foreground" />,
    lastRun: "-",
    duration: "-",
    steps: "-",
    stepSummary: "-",
    sourceLabel: "-",
    caseName: "-",
    caseId: "",
    failure: "",
    report: "-",
    reportPath: "-",
    ...overrides,
  };
}

function findCaseResult(result, caseItem) {
  if (!result || !caseItem?.id) {
    return null;
  }
  if (result.testContext?.caseId === caseItem.id) {
    return result;
  }
  const caseResults = Array.isArray(result.caseResults)
    ? result.caseResults
    : Array.isArray(result.data)
      ? result.data
      : [];
  const match = caseResults.find((item) => item?.caseId === caseItem.id || item?.result?.testContext?.caseId === caseItem.id);
  if (!match) {
    return null;
  }
  return {
    ...(match.result || {}),
    caseId: match.caseId || match.result?.testContext?.caseId || caseItem.id,
    caseName: match.caseName || match.result?.testContext?.caseName || caseItem.name,
    priority: match.priority || caseItem.priority,
  };
}

function formatRunSource(runContext = {}) {
  const surface = (() => {
    switch (runContext.triggerSurface) {
      case "view":
        return "View";
      case "build-cases":
        return "Build cases";
      case "run":
        return "Run";
      default:
        return "Unknown";
    }
  })();
  const scope = runContext.scope && runContext.scope !== "unknown" ? runContext.scope : "";
  return scope ? `${surface} / ${scope}` : surface;
}

function formatStepSummary(steps, okCount, errorCount) {
  const total = Number(steps);
  const ok = Number(okCount);
  const failed = Number(errorCount);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(ok)) {
    return failed > 0 ? `${ok}/${total} passed · ${failed} failed` : `${ok}/${total} passed`;
  }
  return Number.isFinite(total) ? String(total) : "-";
}

function formatFailure(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || error.code || error.error || "Run failed.";
}

function getCaseKey(caseItem) {
  const match = String(caseItem.name || "").match(/^([A-Z]\d+)\s+/i);
  if (match?.[1]) {
    return match[1];
  }
  const tagKey = (caseItem.tags || []).find((tag) => /^(?!P\d$)[A-Z]\d+$/i.test(String(tag)));
  if (tagKey) {
    return tagKey;
  }
  return "";
}

function getRunTone(label) {
  switch (label) {
    case "Passed":
      return "passed";
    case "Failed":
      return "failed";
    case "Running":
      return "running";
    default:
      return "idle";
  }
}

function stripCaseKey(name, key) {
  if (!name || !key) {
    return name || "-";
  }
  return String(name).replace(new RegExp(`^${escapeRegExp(key)}\\s+`, "i"), "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}

function formatDuration(value) {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  const totalMs = Math.max(0, Math.round(Number(value)));
  if (totalMs < 1000) {
    return `${totalMs} ms`;
  }
  const totalSeconds = Math.round(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes || hours) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
