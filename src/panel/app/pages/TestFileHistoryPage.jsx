import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  ExternalLink,
  FileJson,
  LocateFixed,
  Loader2,
  Play,
  XCircle,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Alert, AlertDescription, AlertTitle } from "@panel/components/ui/alert";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { NumberFlowDuration, NumberFlowValue } from "@panel/components/shared/NumberFlowValue";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import { createRunReportModel } from "@panel/lib/run-report-model.mjs";
import { listRunHistory, readRunReport } from "@panel/lib/panel-api";
import styles from "./TestFileHistoryPage.module.css";

const PAGE_SIZE = 24;
const HISTORY_VIEW_OPTIONS = [
  {
    id: "file",
    label: "Run file",
    description: "Full file runs",
    trendLabel: "Run file records",
    stepTrendLabel: "Successful steps per Run file",
    emptyTitle: "No Run file history yet",
    emptyDescription: "Run this test file to create file-level evidence.",
  },
  {
    id: "build",
    label: "Build cases",
    description: "Case and step runs",
    trendLabel: "Build cases records",
    stepTrendLabel: "Successful steps per Build cases run",
    emptyTitle: "No Build cases history yet",
    emptyDescription: "Run a case or step from Build cases to create build-level evidence.",
  },
];
const HISTORY_VIEW_COPY = HISTORY_VIEW_OPTIONS.reduce((acc, item) => ({ ...acc, [item.id]: item }), {});
const CHART_COLORS = {
  passed: "#207044",
  failed: "#b42318",
  stopped: "#b7791f",
  unknown: "#6a7282",
};

const RunResultReportDialog = lazy(() =>
  import("@panel/features/results/RunResultReportDialog").then((module) => ({ default: module.RunResultReportDialog })),
);

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

function formatShortTime(value) {
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
  }).format(date);
}

function formatDuration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  if (numeric < 1000) {
    return `${Math.round(numeric)} ms`;
  }
  const seconds = numeric / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function statusVariant(status) {
  if (status === "passed") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "stopped") {
    return "warning";
  }
  return "neutral";
}

function StatusBadge({ status }) {
  const Icon = status === "passed" ? CheckCircle2 : status === "failed" ? XCircle : Clock3;
  return (
    <Badge variant={statusVariant(status)} className={styles.statusBadge}>
      <Icon />
      {status || "unknown"}
    </Badge>
  );
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

function getRunTimestamp(item) {
  return item?.finishedAt || item?.startedAt || 0;
}

function getFileRunKey(item = {}) {
  const source = [item.reportPath, item.runDir].filter(Boolean).join("\n");
  const match = source.match(/panel-run-\d+-[a-z0-9]+/i);
  if (match) {
    return match[0];
  }
  return `${item.testFilePath || "file"}:${item.runContext?.triggerSurface || "unknown"}:${item.startedAt || item.finishedAt || item.reportPath || "unknown-run"}`;
}

function getRunPhase(item = {}) {
  if (item.runContext?.phase) {
    return item.runContext.phase;
  }
  const source = [item.reportPath, item.runDir].filter(Boolean).join("/");
  if (/-root-setup(?:\/|$)/.test(source)) {
    return "root-setup";
  }
  if (/-root-teardown(?:\/|$)/.test(source)) {
    return "root-teardown";
  }
  if (/-case-[^/]+(?:\/|$)/.test(source)) {
    return "case";
  }
  return "";
}

function getHistoryRunId(item = {}) {
  return item.reportPath || item.runDir || `${item.testFilePath || "file"}:${item.startedAt || item.finishedAt || "unknown-run"}`;
}

function getRunTitle(item, testFile) {
  return item?.testContext?.testFileName || item?.testFileName || testFile?.name || "Untitled test file";
}

function normalizeRun(item = {}) {
  const telemetry = item.telemetry || {};
  const testContext = item.testContext || {};
  const phase = getRunPhase(item);
  return {
    ...item,
    status: item.status || (item.ok === true ? "passed" : item.ok === false ? "failed" : "unknown"),
    ok: item.ok,
    durationMs: telemetry.durationMs ?? item.durationMs,
    steps: telemetry.steps ?? item.steps ?? 0,
    okCount: telemetry.okCount ?? item.okCount ?? 0,
    errorCount: telemetry.errorCount ?? item.errorCount ?? 0,
    browserUrl: telemetry.browserUrl ?? item.browserUrl ?? "",
    caseId: testContext.caseId || item.caseId || "",
    caseName: testContext.caseName || item.caseName || "",
    testFilePath: testContext.testFilePath || item.testFilePath || "",
    testFileName: testContext.testFileName || item.testFileName || "",
    phase,
    firstFailure: item.error || item.firstFailure || null,
  };
}

function getCoverageLabel(item = {}) {
  if (item.phase === "root-setup") {
    return "Root Setup";
  }
  if (item.phase === "root-teardown") {
    return "Root Teardown";
  }
  if (!item.caseId && item.caseName) {
    return item.caseName;
  }
  return item.caseName || item.caseId || "Case run";
}

function aggregateFileRun(groupItems = []) {
  const items = groupItems.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const rootItem = items.find((item) => item.phase === "root-setup") || items.find((item) => !item.caseId) || items[0] || {};
  const failedItem = items.find((item) => item.status === "failed") || null;
  const hasFailed = items.some((item) => item.status === "failed");
  const hasStopped = items.some((item) => item.status === "stopped");
  const hasPassed = items.some((item) => item.status === "passed");
  const startedAt = Math.min(...items.map((item) => Number(item.startedAt)).filter(Number.isFinite));
  const finishedAt = Math.max(...items.map((item) => Number(item.finishedAt)).filter(Number.isFinite));
  const durationFromBounds = Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
    ? finishedAt - startedAt
    : null;
  const durationFromChildren = items.reduce((sum, item) => sum + (Number(item.durationMs) || 0), 0);
  const steps = items.reduce((sum, item) => sum + (Number(item.steps) || 0), 0);
  const okCount = items.reduce((sum, item) => sum + (Number(item.okCount) || 0), 0);
  const errorCount = items.reduce((sum, item) => sum + (Number(item.errorCount) || 0), 0);
  const status = hasFailed ? "failed" : hasStopped ? "stopped" : hasPassed ? "passed" : "unknown";
  const firstFailure = failedItem?.firstFailure
    ? {
        ...failedItem.firstFailure,
        caseId: failedItem.firstFailure.caseId || failedItem.caseId || "",
        caseName: failedItem.firstFailure.caseName || failedItem.caseName || "",
        phase: failedItem.firstFailure.phase || failedItem.phase || "",
      }
    : rootItem.firstFailure || null;
  return {
    ...rootItem,
    id: getFileRunKey(rootItem),
    status,
    ok: status === "passed" ? true : status === "failed" || status === "stopped" ? false : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : rootItem.startedAt,
    finishedAt: Number.isFinite(finishedAt) ? finishedAt : rootItem.finishedAt,
    durationMs: durationFromBounds ?? durationFromChildren,
    steps,
    okCount,
    errorCount,
    firstFailure,
    reportPath: rootItem.reportPath || items[0]?.reportPath || "",
    reportPaths: items.map((item) => item.reportPath).filter(Boolean),
    runDir: rootItem.runDir || items[0]?.runDir || "",
    browserUrl: items.find((item) => item.browserUrl)?.browserUrl || rootItem.browserUrl || "",
    caseCoverage: items.map((item) => ({
      id: `${item.phase || "case"}:${item.caseId || item.reportPath}`,
      name: getCoverageLabel(item),
      status: item.status,
      okCount: item.okCount,
      totalSteps: item.steps,
      reportPath: item.reportPath,
      isRoot: item.phase?.startsWith("root") || !item.caseId,
    })),
    childRuns: items,
  };
}

function buildFileHistoryRuns(rawRuns = []) {
  const groups = new Map();
  rawRuns
    .map(normalizeRun)
    .filter((item) => (item.runContext?.scope || "") === "all" || (!item.runContext?.scope && !item.caseId))
    .forEach((item) => {
      const key = getFileRunKey(item);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    });
  return Array.from(groups.values()).map(aggregateFileRun);
}

function buildBuildCasesHistoryRuns(rawRuns = []) {
  return rawRuns
    .map(normalizeRun)
    .filter((item) => item.runContext?.triggerSurface === "build-cases")
    .map((item) => ({
      ...item,
      id: getHistoryRunId(item),
      reportPaths: item.reportPath ? [item.reportPath] : [],
      caseCoverage: [],
      childRuns: [item],
    }));
}

function buildHistoryModel(rawRuns = [], view = "file") {
  const runs = (view === "build" ? buildBuildCasesHistoryRuns(rawRuns) : buildFileHistoryRuns(rawRuns))
    .sort((a, b) => getRunTimestamp(b) - getRunTimestamp(a));
  const total = runs.length;
  const passed = runs.filter((item) => item.status === "passed").length;
  const failed = runs.filter((item) => item.status === "failed").length;
  const durations = runs.map((item) => Number(item.durationMs)).filter(Number.isFinite);
  const averageDuration = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
  const slowestRun = runs
    .filter((item) => Number.isFinite(Number(item.durationMs)))
    .sort((a, b) => Number(b.durationMs) - Number(a.durationMs))[0] || null;
  const latestFailure = runs.find((item) => item.status === "failed") || null;
  const passRate = total ? (passed / total) * 100 : null;
  const chartRuns = runs.slice(0, 18).reverse();
  return {
    runs,
    total,
    passed,
    failed,
    passRate,
    failureRate: total ? (failed / total) * 100 : null,
    averageDuration,
    slowestRun,
    latestFailure,
    durationTrend: chartRuns.map((item, index) => ({
      name: `#${index + 1}`,
      timestamp: formatShortTime(getRunTimestamp(item)),
      durationSeconds: Number.isFinite(Number(item.durationMs)) ? Math.round(Number(item.durationMs) / 1000) : 0,
      durationLabel: formatDuration(item.durationMs),
      okSteps: Number(item.okCount) || 0,
      failedSteps: Math.max(0, (Number(item.steps) || 0) - (Number(item.okCount) || 0)),
      totalSteps: Number(item.steps) || 0,
      status: item.status,
    })),
    stepTrend: chartRuns.map((item, index) => ({
      name: `#${index + 1}`,
      timestamp: formatShortTime(getRunTimestamp(item)),
      okSteps: Number(item.okCount) || 0,
      failedSteps: Math.max(0, (Number(item.steps) || 0) - (Number(item.okCount) || 0)),
      totalSteps: Number(item.steps) || 0,
      status: item.status,
    })),
  };
}

function createFallbackReportModel({ selectedRun, reportState, testFile }) {
  if (!selectedRun && !reportState.data?.report) {
    return null;
  }
  return createRunReportModel({
    report: reportState.data?.report || null,
    summary: reportState.data?.summary || selectedRun,
    testFile,
  });
}

function buildSyntheticFileReport(selectedRun, payloads = []) {
  const reports = payloads.filter((payload) => payload?.success && payload.report);
  const caseResults = reports.map((payload, index) => {
    const report = payload.report;
    const summary = payload.summary || {};
    const context = report.testContext || {};
    const phase = getRunPhase({ reportPath: payload.path, runDir: summary.runDir, runContext: report.runContext });
    const isRoot = phase?.startsWith("root") || !context.caseId;
    const caseName = isRoot ? getCoverageLabel({ phase, caseName: context.caseName }) : context.caseName || summary.caseName || `Case ${index + 1}`;
    return {
      caseId: context.caseId || phase || `root-${index + 1}`,
      caseName,
      priority: isRoot ? "ROOT" : "P1",
      result: {
        ...(report.summary || {}),
        telemetry: report.telemetry,
        evidence: report.evidence,
        testContext: report.testContext,
        runContext: report.runContext,
      },
    };
  });
  return {
    startedAt: selectedRun?.startedAt,
    finishedAt: selectedRun?.finishedAt,
    mode: "test-file",
    testContext: {
      testFileId: selectedRun?.testContext?.testFileId || "",
      testFilePath: selectedRun?.testFilePath || selectedRun?.testContext?.testFilePath || "",
      testFileName: selectedRun?.testFileName || selectedRun?.testContext?.testFileName || "",
      caseId: null,
      caseName: null,
    },
    runContext: selectedRun?.runContext || {},
    telemetry: {
      durationMs: selectedRun?.durationMs,
      steps: selectedRun?.steps,
      okCount: selectedRun?.okCount,
      errorCount: selectedRun?.errorCount,
      browserUrl: selectedRun?.browserUrl,
    },
    summary: {
      ok: selectedRun?.ok,
      type: "test-file",
      caseResults,
      data: caseResults,
      error: selectedRun?.firstFailure || null,
    },
    evidence: {
      runDir: selectedRun?.runDir,
      reportPath: selectedRun?.reportPath,
      caseRuns: selectedRun?.caseCoverage || [],
    },
  };
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

function HistoryTooltip({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }
  const item = payload[0]?.payload || {};
  const isDurationTooltip = payload[0]?.dataKey === "durationSeconds";
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipHeader}>
        <strong>{label}</strong>
        <span data-status={item.status}>{item.status}</span>
      </div>
      <dl className={styles.tooltipRows}>
        <div>
          <dt>Finished</dt>
          <dd>{item.timestamp}</dd>
        </div>
        {isDurationTooltip ? (
          <div>
            <dt>Duration</dt>
            <dd>{item.durationLabel}</dd>
          </div>
        ) : null}
        {Number.isFinite(Number(item.totalSteps)) ? (
          <div>
            <dt>Passed</dt>
            <dd>{item.okSteps}/{item.totalSteps} steps</dd>
          </div>
        ) : null}
        {item.failedSteps ? (
          <div>
            <dt>Failed</dt>
            <dd data-danger="true">{item.failedSteps} steps</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function ChartEmptyState({ title, description, loading = false }) {
  return (
    <div className={styles.chartEmptyState} data-loading={loading}>
      {loading ? <Loader2 /> : <BarChart3 />}
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function RunListState({ title, description, loading = false, children }) {
  return (
    <div className={styles.runListState} data-loading={loading}>
      {loading ? <Loader2 /> : children}
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function AnimatedNumber({ value, suffix = "", decimals = 0, delay = 320 }) {
  return <NumberFlowValue value={value} suffix={suffix} decimals={decimals} delay={delay} />;
}

function AnimatedDuration({ value, delay = 420 }) {
  return <NumberFlowDuration value={value} delay={delay} />;
}

function MetricTile({ label, children, tone = "neutral", detail = "" }) {
  return (
    <div className={styles.metricTile} data-tone={tone}>
      <div className={styles.metricBody}>
        <span>{label}</span>
        <strong>{children}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

function buildCaseSummary(item = {}) {
  const coverage = item.caseCoverage || [];
  const cases = coverage.filter((caseItem) => !caseItem.isRoot);
  const roots = coverage.filter((caseItem) => caseItem.isRoot);
  const caseTotal = cases.reduce((sum, caseItem) => sum + (Number(caseItem.totalSteps) || 0), 0);
  const caseOk = cases.reduce((sum, caseItem) => sum + (Number(caseItem.okCount) || 0), 0);
  const rootTotal = roots.reduce((sum, caseItem) => sum + (Number(caseItem.totalSteps) || 0), 0);
  const rootOk = roots.reduce((sum, caseItem) => sum + (Number(caseItem.okCount) || 0), 0);
  const caseNames = cases.map((caseItem) => caseItem.name).filter(Boolean).slice(0, 2);
  const more = Math.max(0, cases.length - caseNames.length);
  const headline = cases.length
    ? `${cases.length} cases · ${caseOk}/${caseTotal} case steps`
    : `${item.okCount ?? 0}/${item.steps ?? 0} steps`;
  const detail = [
    roots.length ? `Root ${rootOk}/${rootTotal}` : "",
    caseNames.join(" · "),
    more ? `+${more} more` : "",
  ].filter(Boolean).join(" · ");
  return { headline, detail };
}

function RunCard({ item, active, onSelect, testFile }) {
  const failure = item.firstFailure?.message || "";
  const caseSummary = buildCaseSummary(item);
  return (
    <button
      type="button"
      className={styles.runCard}
      data-active={active}
      data-status={item.status}
      onClick={onSelect}
    >
      <span className={styles.runRail} aria-hidden="true" />
      <span className={styles.runCardContent}>
        <span className={styles.runCardHeader}>
          <StatusBadge status={item.status} />
          <span>{formatDateTime(getRunTimestamp(item))}</span>
          <span>{formatDuration(item.durationMs)}</span>
        </span>
        <strong>{caseSummary.headline}</strong>
        <span className={styles.runMeta}>
          <span>{surfaceLabel(item.runContext?.triggerSurface)} / {item.runContext?.scope || "unknown"}</span>
          <span>{getRunTitle(item, testFile)}</span>
        </span>
        {failure ? <span className={styles.failureText}>{failure}</span> : <span className={styles.caseSummaryText}>{caseSummary.detail || "No case coverage recorded"}</span>}
      </span>
    </button>
  );
}

function DetailRow({ label, value, mono = false, danger = false }) {
  return (
    <div className={styles.detailRow}>
      <span>{label}</span>
      <strong data-mono={mono} data-danger={danger}>{value || "-"}</strong>
    </div>
  );
}

function CaseCoverage({ selectedRun, model }) {
  const coverage = selectedRun?.caseCoverage || [];
  if (coverage.length) {
    return (
      <div className={styles.caseMatrix}>
        {coverage.slice(0, 10).map((caseItem) => (
          <div key={caseItem.id} className={styles.caseRow} data-status={caseItem.status}>
            <span />
            <strong title={caseItem.name}>{caseItem.name}</strong>
            <small>{caseItem.okCount}/{caseItem.totalSteps} steps</small>
          </div>
        ))}
      </div>
    );
  }
  const cases = model?.cases || [];
  if (!cases.length) {
    return <p className={styles.mutedText}>No case matrix is available in this report.</p>;
  }
  return (
    <div className={styles.caseMatrix}>
      {cases.filter((item) => !item.isRoot).slice(0, 8).map((caseItem) => (
        <div key={caseItem.caseId} className={styles.caseRow} data-status={caseItem.status}>
          <span />
          <strong title={caseItem.caseName}>{caseItem.caseName}</strong>
          <small>{caseItem.completedSteps}/{caseItem.totalSteps} steps</small>
        </div>
      ))}
    </div>
  );
}

function DetailPanel({
  selectedRun,
  reportState,
  reportModel,
  onOpenReport,
  onOpenProfessionalReport,
  onOpenRunPage,
  onOpenBuildStep,
}) {
  if (!selectedRun) {
    return (
      <aside className={styles.detailPanel}>
        <div className={styles.emptyDetail}>
          <FileJson />
          <strong>Select a run</strong>
          <span>Pick a Run file record to inspect failure evidence, case coverage, and artifacts.</span>
        </div>
      </aside>
    );
  }
  const failure = selectedRun.firstFailure || reportModel?.summary?.firstFailure || null;
  return (
    <aside className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <div>
          <span>Run file detail</span>
          <strong>{formatDateTime(getRunTimestamp(selectedRun))}</strong>
        </div>
        <StatusBadge status={selectedRun.status} />
      </div>
      <ScrollArea className={styles.detailScroll}>
        <section className={styles.detailSection}>
          <h3>Run summary</h3>
          <DetailRow label="Finished" value={formatDateTime(getRunTimestamp(selectedRun))} />
          <DetailRow label="Duration" value={formatDuration(selectedRun.durationMs)} />
          <DetailRow label="Source" value={`${surfaceLabel(selectedRun.runContext?.triggerSurface)} / ${selectedRun.runContext?.scope || "unknown"}`} />
          <DetailRow label="Steps" value={`${selectedRun.okCount ?? 0}/${selectedRun.steps ?? 0} passed`} />
          <DetailRow label="Browser URL" value={selectedRun.browserUrl || "-"} mono />
        </section>

        <section className={styles.detailSection}>
          <h3>First failure</h3>
          {failure ? (
            <>
              <DetailRow label="Message" value={failure.message || "-"} danger />
              <div className={styles.detailRow}>
                <span>Step</span>
                <div className={styles.failureStepTarget}>
                  <strong>{failure.stepTitle || failure.stepId || "-"}</strong>
                  {failure.stepId ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => onOpenBuildStep?.({
                        caseId: failure.caseId || selectedRun.caseId || "",
                        stepId: failure.stepId,
                        phase: failure.phase || "",
                        runSnapshot: {
                          selectedRun,
                          reportData: reportState.data,
                        },
                      })}
                    >
                      <LocateFixed data-icon="inline-start" />
                      Build
                    </Button>
                  ) : null}
                </div>
              </div>
              <DetailRow label="Action" value={failure.actionType || "-"} />
              <div className={styles.detailActions}>
                {pathButton("Copy trace", failure.tracePath)}
                {pathButton("Copy before shot", failure.beforeScreenshotPath)}
                {pathButton("Copy after shot", failure.afterScreenshotPath)}
              </div>
            </>
          ) : (
            <p className={styles.mutedText}>No blocking failure was recorded for this Run file.</p>
          )}
        </section>

        <section className={styles.detailSection}>
          <h3>Case coverage</h3>
          {reportState.status === "loading" ? (
            <div className={styles.loadingLine}>
              <Loader2 />
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
          {reportState.status === "loaded" ? <CaseCoverage selectedRun={selectedRun} model={reportModel} /> : null}
        </section>

        <section className={styles.detailSection}>
          <h3>Artifacts</h3>
          <DetailRow label="Report" value={selectedRun.reportPath || "-"} mono />
          <DetailRow label="Run dir" value={selectedRun.runDir || "-"} mono />
          <div className={styles.artifactActions}>
            <Button
              type="button"
              variant="default"
              size="sm"
              className={styles.primaryArtifactAction}
              disabled={reportState.status === "loading" || !reportModel}
              onClick={onOpenReport}
            >
              <BarChart3 data-icon="inline-start" />
              Open report
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.secondaryArtifactAction}
              disabled={reportState.status === "loading" || !reportModel}
              onClick={() => onOpenProfessionalReport?.(reportModel)}
            >
              <FileJson data-icon="inline-start" />
              Open new report
            </Button>
            <Button type="button" variant="secondary" size="sm" className={styles.secondaryArtifactAction} onClick={onOpenRunPage}>
              <ExternalLink data-icon="inline-start" />
              Open in Run
            </Button>
            <div className={styles.copyActions}>
              {pathButton("Copy report", selectedRun.reportPath)}
              {pathButton("Copy run dir", selectedRun.runDir)}
            </div>
          </div>
        </section>
      </ScrollArea>
    </aside>
  );
}

export function TestFileHistoryPage({
  testFile,
  currentTestFilePath,
  result,
  lastRunAt,
  panelPlatform = "web",
  historyFocusReportPath = "",
  onHistoryFocusConsumed,
  onOpenProfessionalReport,
  onModeChange,
  onRunAll,
  onOpenBuildStep,
}) {
  const [historyView, setHistoryView] = useState("file");
  const [page, setPage] = useState(1);
  const [historyState, setHistoryState] = useState({ status: "idle", data: null, error: "" });
  const [selectedReportPath, setSelectedReportPath] = useState("");
  const [reportState, setReportState] = useState({ status: "idle", data: null, error: "" });
  const [reportDialogOpen, setReportDialogOpen] = useState(false);

  const loadHistory = useCallback(() => {
    const requestView = historyView;
    if (!currentTestFilePath) {
      setHistoryState({ status: "loaded", data: { runs: [], total: 0, totalPages: 1 }, error: "", view: requestView });
      return () => {};
    }
    let cancelled = false;
    setHistoryState((current) => ({ ...current, status: "loading", error: "", pendingView: requestView }));
    listRunHistory({
      testFilePath: currentTestFilePath,
      page,
      pageSize: PAGE_SIZE,
      sort: "newest",
      scope: requestView === "file" ? "all" : "",
      triggerSurface: requestView === "build" ? "build-cases" : "",
      excludeCaseRuns: false,
    })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setHistoryState((current) =>
          payload?.success
            ? { status: "loaded", data: payload, error: "", view: requestView, pendingView: "" }
            : {
                ...current,
                status: "error",
                error: payload?.message || payload?.error || "load-failed",
                pendingView: requestView,
              },
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setHistoryState((current) => ({
            ...current,
            status: "error",
            error: error?.message || "load-failed",
            pendingView: requestView,
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentTestFilePath, historyView, page]);

  useEffect(() => loadHistory(), [loadHistory, lastRunAt, result]);

  useEffect(() => {
    setPage(1);
  }, [currentTestFilePath]);

  useEffect(() => {
    setSelectedReportPath("");
  }, [currentTestFilePath]);

  const runs = historyState.data?.runs || [];
  const displayView = historyState.view || historyView;
  const viewCopy = HISTORY_VIEW_COPY[displayView] || HISTORY_VIEW_COPY.file;
  const targetViewCopy = HISTORY_VIEW_COPY[historyView] || HISTORY_VIEW_COPY.file;
  const model = useMemo(() => buildHistoryModel(runs, displayView), [displayView, runs]);
  const isHistoryLoading = historyState.status === "loading";
  const hasHistoryError = historyState.status === "error";
  const hasHistoryRuns = model.runs.length > 0;
  const selectedRun = useMemo(
    () =>
      model.runs.find((item) => item.reportPath === selectedReportPath || item.reportPaths?.includes(selectedReportPath)) ||
      model.runs[0] ||
      null,
    [model.runs, selectedReportPath],
  );

  useEffect(() => {
    if (!historyFocusReportPath) {
      return;
    }
    setSelectedReportPath(historyFocusReportPath);
    onHistoryFocusConsumed?.();
  }, [historyFocusReportPath, onHistoryFocusConsumed]);

  useEffect(() => {
    const reportPaths = selectedRun?.reportPaths?.length ? selectedRun.reportPaths : selectedRun?.reportPath ? [selectedRun.reportPath] : [];
    if (!reportPaths.length) {
      setReportState({ status: "idle", data: null, error: "" });
      return () => {};
    }
    let cancelled = false;
    setReportState({ status: "loading", data: null, error: "" });
    Promise.all(reportPaths.map((reportPath) => readRunReport({ reportPath })))
      .then((payloads) => {
        if (cancelled) {
          return;
        }
        const successful = payloads.filter((payload) => payload?.success);
        if (successful.length) {
          const syntheticReport = buildSyntheticFileReport(selectedRun, successful);
          setReportState({
            status: "loaded",
            data: {
              success: true,
              report: syntheticReport,
              reports: successful,
              summary: selectedRun,
            },
            error: "",
          });
          return;
        }
        const firstFailure = payloads.find((payload) => !payload?.success);
        setReportState(
          { status: "error", data: null, error: firstFailure?.message || firstFailure?.error || "read-failed" },
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
  }, [selectedRun]);

  const reportModel = useMemo(
    () => createFallbackReportModel({ selectedRun, reportState, testFile }),
    [reportState, selectedRun, testFile],
  );
  const titlebarSafe = panelPlatform === "darwin";
  const totalPages = historyState.data?.totalPages || 1;

  return (
    <main className={styles.page}>
      <section className={styles.board}>
        <section className={styles.historyToolbar} aria-label="History scope">
          <div className={styles.historyViewTabs} role="tablist" aria-label="History scope">
            {HISTORY_VIEW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={historyView === option.id}
                className={styles.historyViewTab}
                data-active={historyView === option.id}
                onClick={() => {
                  setPage(1);
                  setHistoryView(option.id);
                }}
              >
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.metrics}>
          <MetricTile label="Pass rate" tone={model.failed ? "danger" : "success"} detail={`${model.passed}/${model.total} passed`}>
            <AnimatedNumber value={model.passRate ?? 0} suffix="%" delay={260} />
          </MetricTile>
          <MetricTile label="Failures" tone={model.failed ? "danger" : "neutral"} detail={model.latestFailure ? formatDateTime(getRunTimestamp(model.latestFailure)) : "No recent failure"}>
            <AnimatedNumber value={model.failed || 0} delay={340} />
          </MetricTile>
          <MetricTile label="Avg duration" detail={model.slowestRun ? `Slowest ${formatDuration(model.slowestRun.durationMs)}` : "No duration data"}>
            <AnimatedDuration value={model.averageDuration} delay={460} />
          </MetricTile>
          <MetricTile label="Latest run" detail={selectedRun ? formatDateTime(getRunTimestamp(selectedRun)) : `${targetViewCopy.label} to create evidence`}>
            <span className={styles.latestStatus} data-status={selectedRun?.status || "unknown"}>{selectedRun ? selectedRun.status : "No run"}</span>
          </MetricTile>
        </section>

        <section className={styles.charts}>
          <div className={styles.chartPanel} data-state={hasHistoryRuns ? "ready" : isHistoryLoading ? "loading" : "empty"}>
            <header>
              <strong>Duration trend</strong>
              <span>Recent {model.durationTrend.length} {viewCopy.trendLabel}</span>
            </header>
            <ResponsiveContainer width="100%" height={178}>
              <BarChart data={model.durationTrend}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} width={36} />
                <Tooltip content={<HistoryTooltip />} />
                <Bar dataKey="durationSeconds" radius={[4, 4, 0, 0]} animationBegin={120} animationDuration={420}>
                  {model.durationTrend.map((item) => (
                    <Cell key={item.name} fill={CHART_COLORS[item.status] || CHART_COLORS.unknown} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {!hasHistoryRuns ? (
              <ChartEmptyState
                loading={isHistoryLoading}
                title={isHistoryLoading ? "Loading history" : targetViewCopy.emptyTitle}
                description={hasHistoryError ? historyState.error : targetViewCopy.emptyDescription}
              />
            ) : null}
          </div>
          <div className={styles.chartPanel} data-state={hasHistoryRuns ? "ready" : isHistoryLoading ? "loading" : "empty"}>
            <header>
              <strong>Step success trend</strong>
              <span>{viewCopy.stepTrendLabel}</span>
            </header>
            <ResponsiveContainer width="100%" height={178}>
              <LineChart data={model.stepTrend}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} width={36} />
                <Tooltip content={<HistoryTooltip />} />
                <Line
                  type="monotone"
                  dataKey="okSteps"
                  name="Passed steps"
                  stroke={CHART_COLORS.passed}
                  strokeWidth={2.5}
                  dot={{ r: 3, strokeWidth: 2 }}
                  activeDot={{ r: 5, strokeWidth: 0 }}
                  animationBegin={160}
                  animationDuration={460}
                />
              </LineChart>
            </ResponsiveContainer>
            {!hasHistoryRuns ? (
              <ChartEmptyState
                loading={isHistoryLoading}
                title={isHistoryLoading ? "Loading history" : targetViewCopy.emptyTitle}
                description={hasHistoryError ? historyState.error : targetViewCopy.emptyDescription}
              />
            ) : null}
          </div>
        </section>

        <section className={styles.timelineSection}>
          <div className={styles.sectionTitle}>
            <div>
              <strong>Run records</strong>
              <span>{model.total || 0} records · page {page} / {totalPages}</span>
            </div>
            <div className={styles.pager}>
              <Button type="button" variant="secondary" size="sm" disabled={isHistoryLoading || page <= 1 || !hasHistoryRuns} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                Previous
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={isHistoryLoading || page >= totalPages || !hasHistoryRuns} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
                Next
              </Button>
            </div>
          </div>
          <ScrollArea className={styles.runList}>
            <div className={styles.runListInner}>
              {hasHistoryRuns ? model.runs.map((item) => (
                <RunCard
                  key={item.id || item.reportPath}
                  item={item}
                  testFile={testFile}
                  active={selectedRun?.reportPath === item.reportPath}
                  onSelect={() => setSelectedReportPath(item.reportPath)}
                />
              )) : (
                <RunListState
                  loading={isHistoryLoading}
                  title={isHistoryLoading ? "Loading history" : targetViewCopy.emptyTitle}
                  description={hasHistoryError ? historyState.error : targetViewCopy.emptyDescription}
                >
                  <FileJson />
                  {historyView === "file" && !hasHistoryError ? (
                    <Button type="button" size="sm" onClick={onRunAll}>
                      <Play data-icon="inline-start" />
                      Run file
                    </Button>
                  ) : null}
                </RunListState>
              )}
            </div>
          </ScrollArea>
        </section>
      </section>

      <DetailPanel
        selectedRun={selectedRun}
        reportState={reportState}
        reportModel={reportModel}
        onOpenReport={() => setReportDialogOpen(true)}
        onOpenProfessionalReport={onOpenProfessionalReport}
        onOpenRunPage={() => onModeChange?.("run")}
        onOpenBuildStep={onOpenBuildStep}
      />

      <Suspense fallback={null}>
        <RunResultReportDialog
          open={reportDialogOpen}
          onOpenChange={setReportDialogOpen}
          model={reportModel}
          titlebarSafe={titlebarSafe}
        />
      </Suspense>
    </main>
  );
}
