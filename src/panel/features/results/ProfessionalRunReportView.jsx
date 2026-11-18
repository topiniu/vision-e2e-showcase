import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  ClipboardCheck,
  Copy,
  FileJson,
  GitBranch,
  ImageOff,
  Layers3,
  ListChecks,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Target,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { NumberFlowDuration, NumberFlowValue } from "@panel/components/shared/NumberFlowValue";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import { exportPdf, resolveEvidenceImageSrc } from "@panel/lib/panel-api";
import appIconUrl from "../../assets/app-icon-256.png";
import styles from "./ProfessionalRunReportView.module.css";

export const PROFESSIONAL_REPORT_MODES = {
  executive: "executive",
  engineering: "engineering",
};

const STATUS_META = [
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["skipped", "Skipped"],
  ["pending", "Pending"],
];

const STATUS_COLORS = {
  passed: "#24724c",
  failed: "#b33a32",
  skipped: "#b77719",
  pending: "#cbd3c3",
};

const CHART_GRID_COLOR = "rgba(91, 103, 95, 0.18)";
const CHART_AXIS_COLOR = "#6e786f";
const STATIC_CHART_COLORS = ["#24724c", "#b33a32", "#b77719", "#cbd3c3", "#244f42", "#8a6f28"];

const EXECUTIVE_NUMBER_DELAYS = {
  passRate: 220,
  cases: 360,
  steps: 480,
  duration: 600,
  failures: 720,
};

function formatDateTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(numeric));
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
  if (status === "skipped" || status === "stopped") {
    return "warning";
  }
  return "neutral";
}

function statusLabel(status) {
  if (status === "passed") {
    return "Passed";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "stopped") {
    return "Stopped";
  }
  if (status === "skipped") {
    return "Skipped";
  }
  return "Pending";
}

function normalizeMode(value) {
  return value === PROFESSIONAL_REPORT_MODES.engineering
    ? PROFESSIONAL_REPORT_MODES.engineering
    : PROFESSIONAL_REPORT_MODES.executive;
}

function getVerdict(model) {
  if (model.status === "failed") {
    return {
      label: "Do not release",
      title: "Blocked by runtime failure",
      recommendation: "Fix the first blocking failure, rerun the affected case, then use a clean file run for release evidence.",
      tone: "danger",
    };
  }
  if (model.status === "passed") {
    return {
      label: "Release support",
      title: "No blocking failures found",
      recommendation: "This run can support release after QA confirms the covered cases match the intended change scope.",
      tone: "success",
    };
  }
  if (model.status === "stopped") {
    return {
      label: "Needs rerun",
      title: "Run stopped",
      recommendation: "Treat this as incomplete evidence. Finish a clean run before using it for release or regression decisions.",
      tone: "warning",
    };
  }
  return {
    label: "Needs review",
    title: "Evidence incomplete",
    recommendation: "Complete the run to produce a decision-ready QA report.",
    tone: "neutral",
  };
}

function getStepPassRate(model) {
  const total = model.summary.stepCounts.total || 0;
  return total ? Math.round(((model.summary.stepCounts.passed || 0) / total) * 100) : 0;
}

function createStaticLinePoints(data, key, width, height, padding = 18) {
  const values = data.map((item) => Number(item[key]) || 0);
  const max = Math.max(...values, 1);
  const step = data.length > 1 ? (width - padding * 2) / (data.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = data.length > 1 ? padding + index * step : width / 2;
      const y = height - padding - (value / max) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function getRiskFlags(model) {
  const flags = [];
  if (model.failures.length) {
    flags.push({ tone: "danger", label: "Release-blocking issue", detail: `${model.failures.length} issue${model.failures.length === 1 ? "" : "s"} must be resolved before this evidence can support release.` });
  }
  if (model.summary.caseCounts.skipped) {
    flags.push({ tone: "warning", label: "Skipped cases", detail: `${model.summary.caseCounts.skipped} case${model.summary.caseCounts.skipped === 1 ? "" : "s"} did not execute.` });
  }
  if (model.summary.stepCounts.pending) {
    flags.push({ tone: "warning", label: "Pending steps", detail: `${model.summary.stepCounts.pending} step${model.summary.stepCounts.pending === 1 ? "" : "s"} remain without terminal status.` });
  }
  if (!model.evidence.length) {
    flags.push({ tone: "warning", label: "Missing evidence package", detail: "No supporting records were attached to this report." });
  }
  if (/fast|turbo/i.test(model.context?.evidenceProfile || model.context?.profile || "")) {
    flags.push({ tone: "warning", label: "Fast evidence profile", detail: "Confirm trace/screenshot depth is enough for release audit." });
  }
  return flags;
}

function getCoverageScope(model) {
  const context = model.context || {};
  return [
    context.scope ? `scope=${context.scope}` : "",
    context.triggerSurface ? `trigger=${context.triggerSurface}` : "",
    model.summary.browserUrl || context.baseUrl ? `url=${model.summary.browserUrl || context.baseUrl}` : "",
  ].filter(Boolean);
}

function getBusinessSubject(model) {
  return model.context.testFileName || "QA execution scope";
}

function getExecutionWindow(model) {
  const started = formatDateTime(model.summary.startedAt);
  const finished = formatDateTime(model.summary.finishedAt || model.summary.startedAt);
  return started === finished ? started : `${started} - ${finished}`;
}

function getCoverageNarrative(model) {
  const caseTotal = model.summary.caseCounts.total || 0;
  const stepTotal = model.summary.stepCounts.total || 0;
  const scopeLabel = model.context.scope === "all" ? "full planned scope" : "selected execution scope";
  return `${scopeLabel}; ${caseTotal} business scenario${caseTotal === 1 ? "" : "s"} and ${stepTotal} executable check${stepTotal === 1 ? "" : "s"} were included.`;
}

function getEvidenceNarrative(model) {
  const traces = countEvidenceByKind(model.evidence, "trace");
  const screenshots = countEvidenceByKind(model.evidence, "screenshot");
  return `${model.evidence.length} supporting evidence item${model.evidence.length === 1 ? "" : "s"} available, including ${traces} replay record${traces === 1 ? "" : "s"} and ${screenshots} screenshot${screenshots === 1 ? "" : "s"}.`;
}

function getFailureAudienceLabel(failure) {
  if (!failure) {
    return "No blocking issue";
  }
  return failure.stepTitle || failure.caseName || "Blocking issue";
}

function getFailureAudienceDetail(failure) {
  if (!failure) {
    return "No blocking issue was detected in this execution.";
  }
  const caseName = failure.caseName ? ` in ${failure.caseName}` : "";
  return `Execution was blocked${caseName} while completing "${failure.stepTitle || "the failed check"}". Technical details are kept in the appendix for replay.`;
}

function getRunVerdictReason(model, firstFailure) {
  const caseCounts = model.summary.caseCounts || {};
  const stepCounts = model.summary.stepCounts || {};
  if (model.status === "failed") {
    const firstBlocker = firstFailure?.stepTitle || firstFailure?.message || "the first failed step";
    return `${caseCounts.failed || model.failures.length} of ${caseCounts.total || 0} business scenarios failed; first blocker: ${firstBlocker}.`;
  }
  if (model.status === "passed") {
    return `${caseCounts.passed || 0} of ${caseCounts.total || 0} business scenarios passed, with ${stepCounts.passed || 0} passed checks.`;
  }
  if (model.status === "stopped") {
    return "The run stopped before it produced complete release evidence.";
  }
  return "The run evidence is incomplete and needs QA review before a release decision.";
}

function getRetryScope(model, firstFailure) {
  if (!firstFailure) {
    return model.status === "passed" ? "No rerun required unless the release scope changes." : "Finish a clean run before release review.";
  }
  return `Fix "${firstFailure.stepTitle || firstFailure.caseName || "the first blocker"}", then rerun the affected case before running the full file again.`;
}

function getFailureStepLabel(failure) {
  const current = Number(failure?.stepIndex);
  if (!Number.isFinite(current)) {
    return "Step -";
  }
  return `Step ${current + 1}`;
}

function createFailureEvidenceItems(failure) {
  if (!failure) {
    return [];
  }
  return [
    { kind: "screenshot", label: "After screenshot", value: failure.afterScreenshotPath, preview: true },
    { kind: "screenshot", label: "Before screenshot", value: failure.beforeScreenshotPath, preview: false },
    { kind: "trace", label: "Trace", value: failure.tracePath },
  ].filter((item) => item.value);
}

function summarizeFailureMessage(failure) {
  const message = failure?.message || failure?.actionType || "Step failed.";
  const normalized = String(message).replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 116)}...`;
}

function pickExpectation(raw) {
  const expectation =
    raw?.data?.expectation ||
    raw?.raw?.data?.expectation ||
    raw?.result?.expectation ||
    raw?.expectation ||
    raw?.data?.action?.expectation ||
    null;
  if (!expectation || typeof expectation !== "object") {
    return { expected: "-", actual: "-" };
  }
  if (Array.isArray(expectation.results)) {
    const failed = expectation.results.find((item) => item?.ok === false) || expectation.results[0];
    return pickExpectation({ expectation: failed });
  }
  const expected =
    expectation.expected ??
    expectation.text ??
    expectation.value ??
    expectation.count ??
    expectation.url ??
    expectation.contains ??
    "-";
  const actual =
    expectation.actual ??
    expectation.received ??
    expectation.matched ??
    expectation.present ??
    expectation.current ??
    "-";
  return {
    expected: typeof expected === "object" ? JSON.stringify(expected) : String(expected),
    actual: typeof actual === "object" ? JSON.stringify(actual) : String(actual),
  };
}

function getFailureSource(failure = {}) {
  const rawInput = failure.raw?.input || failure.raw?.raw?.input || failure.raw?.data?.normalizedAction || {};
  return [
    failure.phase || rawInput.phase,
    rawInput.sourceFixture ? `fixture:${rawInput.sourceFixture}` : "",
    rawInput.sourceMacro ? `macro:${rawInput.sourceMacro}` : "",
  ].filter(Boolean);
}

function getFixAction(failure) {
  if (!failure) {
    return "No blocking failure is present in this run.";
  }
  if (/assert|expect|text|count|url/i.test(failure.actionType || failure.message || "")) {
    return "Check whether the business state is correct first, then update the assertion only if the requirement changed.";
  }
  if (/select|combo|dropdown|option/i.test(failure.actionType || failure.message || "")) {
    return "Verify the target field scope, option text, and fixture data. Rerun the case after confirming the selected value is visible.";
  }
  if (/click|button|target|locator/i.test(failure.actionType || failure.message || "")) {
    return "Confirm the target is visible in the intended page state and tighten the target scope before rerunning.";
  }
  return "Fix the failing step, preserve the trace evidence, and rerun the affected case before a full file rerun.";
}

function getReleaseConfidence(model) {
  const caseRate = Number(model.summary.passRate) || 0;
  const stepRate = getStepPassRate(model);
  const skippedPenalty = model.summary.caseCounts.skipped ? 10 : 0;
  const pendingPenalty = model.summary.stepCounts.pending ? 10 : 0;
  const failurePenalty = model.failures.length ? 45 : 0;
  return Math.max(0, Math.min(100, Math.round((caseRate * 0.55) + (stepRate * 0.45) - skippedPenalty - pendingPenalty - failurePenalty)));
}

function countEvidenceByKind(evidence = [], kind) {
  return evidence.filter((item) => item.kind === kind || new RegExp(kind, "i").test(item.label || "")).length;
}

function createStatusChartData(counts = {}) {
  return STATUS_META.map(([status, label]) => ({
    status,
    name: label,
    value: Number(counts[status]) || 0,
    color: STATUS_COLORS[status],
  })).filter((item) => item.value > 0);
}

function createCaseDurationTrend(cases = []) {
  return cases.map((caseItem, index) => ({
    name: caseItem.caseLabel || `Case ${index + 1}`,
    fullName: caseItem.caseName || caseItem.caseLabel || `Case ${index + 1}`,
    durationSeconds: Math.round((Number(caseItem.durationMs) || 0) / 1000),
    steps: Number(caseItem.totalSteps) || 0,
    failed: Number(caseItem.failedSteps) || (caseItem.error ? 1 : 0),
  }));
}

function createPhaseDistributionData(model) {
  const phaseData = model.charts?.phaseDistribution || [];
  if (phaseData.length) {
    return phaseData.map((item) => ({
      name: item.name || item.phase || "-",
      value: Number(item.value) || 0,
    })).filter((item) => item.value > 0);
  }
  const totals = new Map();
  (model.cases || []).forEach((caseItem) => {
    const phase = caseItem.phase || (caseItem.isRoot ? "root" : "case");
    totals.set(phase, (totals.get(phase) || 0) + (Number(caseItem.totalSteps) || 0));
  });
  return Array.from(totals, ([name, value]) => ({ name, value })).filter((item) => item.value > 0);
}

function createQualitySignals(model, riskFlags) {
  const evidenceProfile = model.context.evidenceProfile || model.context.profile || "not specified";
  const assertionActions = (model.charts.actionTypes || [])
    .filter((item) => /assert|expect|check/i.test(item.name || ""))
    .reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const totalActions = (model.charts.actionTypes || []).reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const evidenceCount = model.evidence.length;
  return [
    {
      label: "Decision quality",
      value: model.status === "passed" && !riskFlags.length ? "Ready for scope review" : "Needs QA review",
      detail: riskFlags.length ? `${riskFlags.length} risk signal${riskFlags.length === 1 ? "" : "s"} found` : "No blocking risk signal from this run",
      tone: riskFlags.length ? "warning" : "success",
    },
    {
      label: "Assertion density",
      value: `${assertionActions}/${totalActions || 0}`,
      detail: totalActions ? `${Math.round((assertionActions / totalActions) * 100)}% assertion/check actions` : "No action distribution",
      tone: assertionActions ? "success" : "warning",
    },
    {
      label: "Evidence profile",
      value: evidenceProfile,
      detail: `${evidenceCount} artifact path${evidenceCount === 1 ? "" : "s"} available`,
      tone: /fast|turbo/i.test(evidenceProfile) ? "warning" : "neutral",
    },
  ];
}

function createNarrativeSections(model, verdict, riskFlags) {
  const caseCounts = model.summary.caseCounts || {};
  const stepCounts = model.summary.stepCounts || {};
  const failedCases = caseCounts.failed || 0;
  const failedSteps = stepCounts.failed || 0;
  const skippedSteps = stepCounts.skipped || 0;
  const pendingSteps = stepCounts.pending || 0;
  const releaseText = model.status === "passed"
    ? "The run did not expose a blocking failure. Use it as release support only after confirming the covered cases match the change scope and the evidence profile is acceptable for audit."
    : `The run is not release-ready. ${failedCases || model.failures.length} case-level risk signal${(failedCases || model.failures.length) === 1 ? "" : "s"} and ${failedSteps} failed step${failedSteps === 1 ? "" : "s"} require follow-up before this report can support release.`;
  const coverageText = `${caseCounts.passed || 0}/${caseCounts.total || 0} cases and ${stepCounts.passed || 0}/${stepCounts.total || 0} executable steps reached passed status. ${skippedSteps || pendingSteps ? `There are ${skippedSteps} skipped and ${pendingSteps} pending steps that need QA review.` : "No skipped or pending steps are present in this report model."}`;
  const evidenceText = model.evidence.length
    ? `${model.evidence.length} supporting evidence items are available, including ${countEvidenceByKind(model.evidence, "trace")} replay records and ${countEvidenceByKind(model.evidence, "screenshot")} screenshots. Raw paths are kept in the technical appendix for audit replay.`
    : "No supporting evidence is attached, so this run should not be used as standalone delivery evidence.";
  return [
    { title: "Release assessment", body: releaseText, tone: verdict.tone },
    { title: "Coverage interpretation", body: coverageText, tone: riskFlags.length ? "warning" : "success" },
    { title: "Evidence note", body: evidenceText, tone: model.evidence.length ? "neutral" : "warning" },
  ];
}

function createReviewChecklist(model, riskFlags, releaseConfidence) {
  const caseCounts = model.summary.caseCounts || {};
  const stepCounts = model.summary.stepCounts || {};
  const evidenceCount = model.evidence.length;
  const traceCount = countEvidenceByKind(model.evidence, "trace");
  const screenshotCount = countEvidenceByKind(model.evidence, "screenshot");
  const rows = [
    {
      area: "Release gate",
      status: model.status === "passed" && !model.failures.length ? "Clear" : "Blocked",
      signal: verdictText(model),
      evidence: model.failures.length ? `${model.failures.length} blocking failure(s)` : "No blocking failure detected",
      tone: model.failures.length ? "danger" : "success",
    },
    {
      area: "Case coverage",
      status: caseCounts.failed || caseCounts.skipped || caseCounts.pending ? "Review" : "Clear",
      signal: `${caseCounts.passed || 0}/${caseCounts.total || 0} cases passed`,
      evidence: `failed ${caseCounts.failed || 0} / skipped ${caseCounts.skipped || 0} / pending ${caseCounts.pending || 0}`,
      tone: caseCounts.failed ? "danger" : caseCounts.skipped || caseCounts.pending ? "warning" : "success",
    },
    {
      area: "Step coverage",
      status: stepCounts.failed || stepCounts.skipped || stepCounts.pending ? "Review" : "Clear",
      signal: `${stepCounts.passed || 0}/${stepCounts.total || 0} steps passed`,
      evidence: `failed ${stepCounts.failed || 0} / skipped ${stepCounts.skipped || 0} / pending ${stepCounts.pending || 0}`,
      tone: stepCounts.failed ? "danger" : stepCounts.skipped || stepCounts.pending ? "warning" : "success",
    },
    {
      area: "Evidence package",
      status: evidenceCount ? "Available" : "Missing",
      signal: `${evidenceCount} evidence item(s)`,
      evidence: `${traceCount} replay records / ${screenshotCount} screenshots`,
      tone: evidenceCount ? "success" : "warning",
    },
    {
      area: "Decision confidence",
      status: releaseConfidence >= 90 ? "High" : releaseConfidence >= 60 ? "Medium" : "Low",
      signal: `${releaseConfidence}% confidence`,
      evidence: `${riskFlags.length} risk signal(s) in register`,
      tone: releaseConfidence >= 90 ? "success" : releaseConfidence >= 60 ? "warning" : "danger",
    },
  ];
  return rows;
}

function verdictText(model) {
  if (model.status === "passed") {
    return "Release support candidate";
  }
  if (model.status === "failed") {
    return "Release blocked";
  }
  if (model.status === "stopped") {
    return "Incomplete run";
  }
  return "Needs QA review";
}

function createAuditMemoRows(model, firstFailure) {
  return [
    ["Business scope", getBusinessSubject(model)],
    ["Execution window", getExecutionWindow(model)],
    ["Coverage scale", `${model.summary.caseCounts.total || 0} business scenarios / ${model.summary.stepCounts.total || 0} executable checks`],
    ["Evidence package", getEvidenceNarrative(model)],
    ["Primary blocker", firstFailure ? `${firstFailure.caseName || "-"} / ${firstFailure.stepTitle || "-"}` : "None"],
  ];
}

function replaceElementWithStaticNode(element, tagName = "div", extraClassName = "") {
  const staticNode = document.createElement(tagName);
  staticNode.className = [element.className || "", extraClassName].filter(Boolean).join(" ");
  staticNode.setAttribute("data-print-static-control", "true");
  while (element.firstChild) {
    staticNode.appendChild(element.firstChild);
  }
  element.replaceWith(staticNode);
  return staticNode;
}

function flattenInteractivePrintControls(reportClone) {
  reportClone.querySelectorAll(`.${styles.mastheadActions}`).forEach((node) => node.remove());
  reportClone.querySelectorAll(`.${styles.modeSwitch}`).forEach((node) => node.remove());
  reportClone.querySelectorAll(`.${styles.miniDonutChart} > strong`).forEach((node) => node.remove());
  reportClone.querySelectorAll(`.${styles.pathList} button svg, .${styles.copyChip} svg`).forEach((node) => node.remove());
  reportClone.querySelectorAll("button").forEach((button) => {
    replaceElementWithStaticNode(button, "div");
  });
  reportClone.querySelectorAll("details").forEach((detailsNode) => {
    const section = document.createElement("section");
    section.className = [detailsNode.className || "", styles.printDetails].filter(Boolean).join(" ");
    const summary = detailsNode.querySelector("summary");
    if (summary) {
      const heading = document.createElement("h3");
      heading.className = styles.printSummary;
      heading.textContent = summary.textContent || "";
      section.appendChild(heading);
      summary.remove();
    }
    while (detailsNode.firstChild) {
      section.appendChild(detailsNode.firstChild);
    }
    detailsNode.replaceWith(section);
  });
}

function buildCurrentReportPrintHtml() {
  if (typeof document === "undefined") {
    return "";
  }
  const reportNode = document.querySelector("[data-professional-report-root]");
  if (!reportNode) {
    return "";
  }
  const reportClone = reportNode.cloneNode(true);
  reportClone.querySelectorAll("[data-visible]").forEach((node) => {
    node.setAttribute("data-visible", "true");
  });
  reportClone.querySelectorAll("details").forEach((node) => {
    node.setAttribute("open", "");
  });
  flattenInteractivePrintControls(reportClone);
  const styleMarkup = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((node) => {
      if (node.tagName === "STYLE") {
        return `<style>${node.textContent || ""}</style>`;
      }
      const href = node.getAttribute("href");
      if (!href) {
        return "";
      }
      return `<link rel="stylesheet" href="${new URL(href, document.baseURI).href}">`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base href="${document.baseURI}">
  <title>${document.title || "Zhuzhu E2E Report"}</title>
  ${styleMarkup}
  <style>
    @page { size: A4; margin: 12mm; }
    html, body { margin: 0 !important; background: #fff !important; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    [data-professional-report-print-page] {
      display: block !important;
      width: 196mm !important;
      margin: 0 auto !important;
      background: #fff !important;
    }
    [data-professional-report-root] {
      width: 100% !important;
      max-width: none !important;
      min-width: 0 !important;
      border: 0 !important;
      box-shadow: none !important;
      padding: 0 !important;
    }
    [data-professional-report-root] * {
      max-width: 100%;
    }
    [data-professional-report-root] [data-visible],
    [data-professional-report-root] [data-visible] * {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
    }
  </style>
</head>
<body>
  <main data-professional-report-print-page>${reportClone.outerHTML}</main>
</body>
</html>`;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className={styles.chartTooltip}>
      {label ? <strong>{label}</strong> : null}
      {payload.map((item) => (
        <span key={`${item.name}-${item.value}`} style={{ "--tooltip-color": item.color || item.payload?.color || CHART_AXIS_COLOR }}>
          {item.name}: {item.value}
        </span>
      ))}
    </div>
  );
}

function useDelayedVisible({ activateDelay = 0 } = {}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) {
      return undefined;
    }
    if (typeof window === "undefined") {
      setVisible(true);
      return undefined;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setVisible(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setVisible(true), activateDelay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [activateDelay, visible]);

  return [ref, visible];
}

function MotionBlock({ as: Component = "section", children, className = "", delay = 0, style, ...props }) {
  const [ref, visible] = useDelayedVisible({ activateDelay: delay });
  return (
    <Component
      ref={ref}
      className={className}
      data-visible={visible}
      style={{
        "--section-delay": `${delay}ms`,
        ...style,
      }}
      {...props}
    >
      {children}
    </Component>
  );
}

function ScrollReveal({ children, className = "", delay = 0 }) {
  const [ref, visible] = useDelayedVisible({ activateDelay: delay });
  return (
    <section ref={ref} className={className} data-visible={visible} style={{ "--section-delay": `${delay}ms` }}>
      {children}
    </section>
  );
}

export function ProfessionalRunReportPage({ model, mode = PROFESSIONAL_REPORT_MODES.executive, onModeChange, onClose }) {
  if (!model) {
    return null;
  }
  return (
    <main className={styles.page}>
      <ScrollArea className={styles.pageScroll}>
        <ProfessionalRunReportView model={model} mode={mode} onModeChange={onModeChange} onClose={onClose} />
      </ScrollArea>
    </main>
  );
}

export function ProfessionalRunReportView({ model, mode = PROFESSIONAL_REPORT_MODES.executive, onModeChange, onClose }) {
  if (!model) {
    return null;
  }

  const [pdfExportState, setPdfExportState] = useState({ status: "idle", message: "" });
  const verdict = getVerdict(model);
  const firstFailure = model.summary.firstFailure;
  const stepPassRate = getStepPassRate(model);
  const contextRows = useMemo(() => [
    ["Business scope", getBusinessSubject(model)],
    ["Execution window", getExecutionWindow(model)],
    ["Coverage scale", `${model.summary.caseCounts.total || 0} scenarios / ${model.summary.stepCounts.total || 0} checks`],
    ["Evidence package", getEvidenceNarrative(model)],
    ["Evidence profile", model.context.evidenceProfile || model.context.profile || "standard"],
  ], [model]);
  const caseStatusData = useMemo(() => createStatusChartData(model.summary.caseCounts), [model.summary.caseCounts]);
  const stepStatusData = useMemo(() => createStatusChartData(model.summary.stepCounts), [model.summary.stepCounts]);
  const handleExportPdf = useCallback(async () => {
    if (pdfExportState.status === "exporting") {
      return;
    }
    setPdfExportState({ status: "exporting", message: "" });
    try {
      const payload = await exportPdf({
        kind: "professional-run-report",
        title: model.context.testFileName || getBusinessSubject(model),
        testFileName: model.context.testFileName,
        testFilePath: model.context.testFilePath,
        status: model.status,
        model,
        html: buildCurrentReportPrintHtml(),
      });
      if (payload?.success) {
        setPdfExportState({ status: "success", message: payload.path || "PDF exported." });
        window.setTimeout(() => {
          setPdfExportState((current) => (current.status === "success" ? { status: "idle", message: "" } : current));
        }, 3000);
        return;
      }
      if (payload?.canceled) {
        setPdfExportState({ status: "idle", message: "" });
        return;
      }
      setPdfExportState({ status: "error", message: payload?.message || payload?.error || "PDF export failed." });
    } catch (error) {
      setPdfExportState({ status: "error", message: error?.message || "PDF export failed." });
    }
  }, [model, pdfExportState.status]);

  return (
    <article className={styles.report} data-status={model.status} data-professional-report-root>
      <header className={styles.masthead}>
        <div className={styles.mastheadTop}>
          <div className={styles.brandBlock}>
            <div className={styles.brandMark}>
              <img src={appIconUrl} alt="Vision E2E Showcase" />
            </div>
            <div>
              <strong>Zhuzhu E2E Report</strong>
              <span>Automated QA evidence package</span>
            </div>
          </div>
          <div className={styles.mastheadActions}>
            <Button type="button" variant="secondary" size="sm" onClick={handleExportPdf} disabled={pdfExportState.status === "exporting"}>
                <FileJson data-icon="inline-start" />
                {pdfExportState.status === "exporting" ? "Exporting" : "Export"}
            </Button>
            {onClose ? (
              <Button type="button" variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
            ) : null}
            {pdfExportState.status === "error" ? <span className={styles.exportMessage}>{pdfExportState.message}</span> : null}
          </div>
        </div>
        <div className={styles.mastheadBody}>
          <div className={styles.mastheadIdentity}>
            <span className={styles.reportType}>QA Evidence Report</span>
            <h1>{getBusinessSubject(model)}</h1>
            <div className={styles.mastheadMeta}>
              <span><small>Execution window</small><strong>{getExecutionWindow(model)}</strong></span>
              <span><small>Scenarios</small><strong>{model.summary.caseCounts.total || 0}</strong></span>
              <span><small>Checks</small><strong>{model.summary.stepCounts.total || 0}</strong></span>
              <span><small>Evidence</small><strong>{model.evidence.length} items</strong></span>
            </div>
          </div>
        </div>
      </header>

      <MotionBlock className={styles.verdictHero} delay={60} aria-label="Run verdict">
        <RunVerdict verdict={verdict} model={model} firstFailure={firstFailure} />
      </MotionBlock>

      <MotionBlock className={styles.executiveStrip} delay={100} aria-label="Core metrics">
        <MiniMetric label="Case pass rate" value={<NumberFlowValue value={model.summary.passRate} suffix="%" delay={EXECUTIVE_NUMBER_DELAYS.passRate} />} detail={`${model.summary.caseCounts.passed}/${model.summary.caseCounts.total || 0} cases`} tone={model.status === "failed" ? "danger" : "success"} />
        <MiniMetric label="Step pass rate" value={<NumberFlowValue value={stepPassRate} suffix="%" delay={EXECUTIVE_NUMBER_DELAYS.steps} />} detail={`${model.summary.stepCounts.passed}/${model.summary.stepCounts.total || 0} steps`} />
        <MiniMetric label="Duration" value={<NumberFlowDuration value={model.summary.durationMs} delay={EXECUTIVE_NUMBER_DELAYS.duration} />} detail="start to finish" />
        <MiniMetric label="Failures" value={<NumberFlowValue value={model.failures.length} delay={EXECUTIVE_NUMBER_DELAYS.failures} />} detail={`${model.summary.stepCounts.failed || 0} failed steps`} tone={model.failures.length ? "danger" : "success"} />
      </MotionBlock>

      <ScrollReveal className={styles.outcomeSection} delay={105}>
        <OutcomeOverviewChart caseCounts={model.summary.caseCounts} stepCounts={model.summary.stepCounts} />
      </ScrollReveal>

      <ScrollReveal className={styles.diagnosisSection} delay={100}>
        <SectionHeader
          icon={ShieldAlert}
          title="First Blocking Failure"
          description="The first failure to fix, with expected signal, actual signal, evidence, and retry scope."
        />
        <FailureDiagnosis failure={firstFailure} />
      </ScrollReveal>

      <ScrollReveal className={styles.failedCasesSection} delay={120}>
        <SectionHeader
          icon={ListChecks}
          title="Failed Cases"
          description="Only failed scenarios are listed here. Passed and raw matrix details are folded below."
        />
        <FailedCasesList failures={model.failures} cases={model.cases} />
      </ScrollReveal>

      <ScrollReveal className={styles.evidenceSection} delay={140}>
        <SectionHeader
          icon={FileJson}
          title="Evidence Package"
          description="Evidence is grouped by failure so the next trace or screenshot is one click away."
        />
        <FailureEvidencePackage failures={model.failures} evidence={model.evidence} />
      </ScrollReveal>

      <ScrollReveal className={styles.performanceSection} delay={150}>
        <SlowestStepsSnapshot data={model.charts.slowestSteps || []} />
      </ScrollReveal>

      <MotionBlock className={styles.secondarySummary} delay={170} aria-label="Secondary report details">
        <details>
          <summary>Passed / Skipped Summary</summary>
          <div className={styles.compactSummaryGrid}>
            <ContextPanel rows={contextRows} />
            <CoverageSnapshot model={model} stepPassRate={stepPassRate} caseStatusData={caseStatusData} stepStatusData={stepStatusData} />
          </div>
        </details>
        <details>
          <summary>Full Case Matrix</summary>
          <CaseMatrix cases={model.cases} />
        </details>
      </MotionBlock>

      <ScrollReveal className={styles.appendixSection} delay={190}>
        <SectionHeader
          icon={ClipboardCheck}
          title="Technical Appendix"
          description="Raw execution identifiers, artifact paths, and engineering details for audit and replay."
        />
        <Appendix evidence={model.evidence} failures={model.failures} />
      </ScrollReveal>
    </article>
  );
}

function RunVerdict({ verdict, model, firstFailure }) {
  return (
    <section className={styles.runVerdict} data-tone={verdict.tone}>
      <div className={styles.verdictCopy}>
        <span className={styles.panelKicker}>
          <ShieldCheck />
          Run Verdict
        </span>
        <h2>{verdict.label}</h2>
        <p>{getRunVerdictReason(model, firstFailure)}</p>
        <strong>{getRetryScope(model, firstFailure)}</strong>
      </div>
      <div className={styles.verdictSide}>
        <span>First blocker</span>
        <strong title={firstFailure?.stepTitle || ""}>{firstFailure ? firstFailure.stepTitle || firstFailure.caseName : "None"}</strong>
        <small>{firstFailure ? firstFailure.caseName : getCoverageNarrative(model)}</small>
      </div>
    </section>
  );
}

function OutcomeOverviewChart({ caseCounts, stepCounts }) {
  return (
    <section className={styles.diagnosticChart} aria-label="Outcome overview chart">
      <header>
        <Target />
        <div>
          <strong>Outcome Overview</strong>
          <span>Case and step status at a glance</span>
        </div>
      </header>
      <div className={styles.outcomeOverview}>
        <OutcomeStatusRow title="Cases" counts={caseCounts} />
        <OutcomeStatusRow title="Steps" counts={stepCounts} />
      </div>
    </section>
  );
}

function OutcomeStatusRow({ title, counts }) {
  const total = counts.total || 0;
  const segments = STATUS_META.map(([status, label]) => ({
    status,
    label,
    value: counts[status] || 0,
  })).filter((item) => item.value > 0 || item.status === "passed" || item.status === "failed");
  return (
    <div className={styles.outcomeStatusRow}>
      <div>
        <strong>{title}</strong>
        <span>{segments.map((item) => `${item.label} ${item.value}`).join(" / ")}</span>
      </div>
      <div className={styles.outcomeStack} aria-label={`${title}: ${total}`}>
        {segments.map((item) => (
          <i
            key={`${title}-${item.status}`}
            data-status={item.status}
            style={{ width: total ? `${(item.value / total) * 100}%` : "0%" }}
            title={`${item.label}: ${item.value}`}
          />
        ))}
      </div>
      <span>{total} total</span>
    </div>
  );
}

function SlowestStepsSnapshot({ data }) {
  const rows = data.slice(0, 6).map((item, index) => ({
    name: item.name || `Step ${index + 1}`,
    caseName: item.caseName || item.caseLabel || "-",
    type: item.type || "-",
    durationMs: Number(item.durationMs) || 0,
  })).filter((item) => item.durationMs > 0);
  const max = Math.max(...rows.map((item) => item.durationMs), 0);
  return (
    <section className={styles.diagnosticChart} aria-label="Slowest steps chart">
      <header>
        <Clock3 />
        <div>
          <strong>Performance Snapshot</strong>
          <span>Slowest steps that may hide wait or selector instability</span>
        </div>
      </header>
      {rows.length && max ? (
        <div className={`${styles.diagnosticBars} ${styles.slowestSnapshotBars}`}>
          {rows.map((item, index) => (
            <div key={`${item.caseName}-${item.name}-${index}`}>
              <span title={`${item.name} · ${item.caseName}`}>{item.name}</span>
              <i><b style={{ width: `${Math.max(4, (item.durationMs / max) * 100)}%`, "--bar-delay": `${100 + index * 64}ms` }} /></i>
              <strong>{formatDuration(item.durationMs)}</strong>
              <small title={item.caseName}>{item.caseName}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.emptyPanel}>No step timing data</div>
      )}
    </section>
  );
}

function ReportNarrative({ sections, className = "", motionDelay = 0, ...props }) {
  const [ref, visible] = useDelayedVisible({ activateDelay: motionDelay });
  return (
    <section
      ref={ref}
      className={`${styles.narrativeSection} ${className}`}
      aria-label="QA narrative summary"
      data-visible={visible}
      style={{ "--section-delay": `${motionDelay}ms` }}
      {...props}
    >
      {sections.map((section) => (
        <article key={section.title} data-tone={section.tone}>
          <span>{section.title}</span>
          <p>{section.body}</p>
        </article>
      ))}
    </section>
  );
}

function AuditMemo({ rows, checklist, className = "", motionDelay = 0, ...props }) {
  const [ref, visible] = useDelayedVisible({ activateDelay: motionDelay });
  return (
    <section
      ref={ref}
      className={`${styles.auditMemo} ${className}`}
      aria-label="QA audit memo"
      data-visible={visible}
      style={{ "--section-delay": `${motionDelay}ms` }}
      {...props}
    >
      <div className={styles.auditFacts}>
        <header>
          <ClipboardCheck />
          <strong>Delivery memo</strong>
          <span>Business-readable summary for release review and handoff.</span>
        </header>
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={String(value)}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={styles.releaseChecklist}>
        <header>
          <ListChecks />
          <strong>Release gate checklist</strong>
          <span>Decision signals translated from the execution evidence.</span>
        </header>
        <div className={styles.checklistTable} role="table" aria-label="Release gate checklist">
          <div role="row">
            <span>Area</span>
            <span>Status</span>
            <span>Signal</span>
            <span>Evidence</span>
          </div>
          {checklist.map((item) => (
            <div key={item.area} role="row" data-tone={item.tone}>
              <strong>{item.area}</strong>
              <span>{item.status}</span>
              <span>{item.signal}</span>
              <span>{item.evidence}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ModeSwitch({ mode, onModeChange }) {
  const normalized = normalizeMode(mode);
  return (
    <div className={styles.modeSwitch} role="tablist" aria-label="Report mode">
      {Object.values(PROFESSIONAL_REPORT_MODES).map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={normalized === item}
          data-active={normalized === item}
          onClick={() => onModeChange?.(item)}
        >
          {item === PROFESSIONAL_REPORT_MODES.executive ? "Executive" : "Engineering"}
        </button>
      ))}
    </div>
  );
}

function MiniMetric({ label, value, detail, tone = "neutral" }) {
  return (
    <div className={styles.miniMetric} data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function DecisionSummary({ verdict, model, firstFailure }) {
  return (
    <section className={styles.decisionSummary} data-tone={verdict.tone}>
      <div className={styles.panelKicker}>
        <ShieldCheck />
        Decision Summary
      </div>
      <h2>{verdict.label}</h2>
      <p>{verdict.recommendation}</p>
      <dl>
        <div>
          <dt>Blocking issue</dt>
          <dd>{firstFailure ? getFailureAudienceLabel(firstFailure) : "No blocking issue in this execution"}</dd>
        </div>
        <div>
          <dt>Coverage summary</dt>
          <dd>{getCoverageNarrative(model)}</dd>
        </div>
        <div>
          <dt>Release note</dt>
          <dd>{model.status === "passed" ? "Review business scope before publishing." : "Rerun required before release evidence can be trusted."}</dd>
        </div>
      </dl>
    </section>
  );
}

function CoverageSnapshot({ model, stepPassRate, caseStatusData, stepStatusData }) {
  return (
    <section className={styles.coverageSnapshot}>
      <div className={styles.panelKicker}>
        <Target />
        Coverage Snapshot
      </div>
      <div className={styles.coverageRates}>
        <div>
          <span>Cases</span>
          <strong><NumberFlowValue value={model.summary.passRate} suffix="%" delay={EXECUTIVE_NUMBER_DELAYS.cases} /></strong>
          <small>{model.summary.caseCounts.passed}/{model.summary.caseCounts.total || 0} passed</small>
        </div>
        <div>
          <span>Steps</span>
          <strong><NumberFlowValue value={stepPassRate} suffix="%" delay={EXECUTIVE_NUMBER_DELAYS.steps} /></strong>
          <small>{model.summary.stepCounts.passed}/{model.summary.stepCounts.total || 0} passed</small>
        </div>
      </div>
      <div className={styles.snapshotDonuts}>
        <MiniStatusDonut title="Cases" data={caseStatusData} total={model.summary.caseCounts.total || 0} />
        <MiniStatusDonut title="Steps" data={stepStatusData} total={model.summary.stepCounts.total || 0} />
      </div>
    </section>
  );
}

function MiniStatusDonut({ title, data, total }) {
  const staticData = data.length ? data : [{ name: "No data", value: 1, color: "#d8d3c4" }];
  return (
    <div className={styles.miniDonut}>
      <div className={styles.miniDonutChart}>
        <ResponsiveContainer width="100%" height={122} className={styles.rechartsChart}>
          <PieChart>
            <Pie
              data={staticData}
              dataKey="value"
              nameKey="name"
              innerRadius={34}
              outerRadius={54}
              paddingAngle={data.length > 1 ? 2 : 0}
              isAnimationActive={false}
            >
              {staticData.map((entry, index) => (
                <Cell key={`${title}-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <StaticStatusBreakdown data={staticData} />
        <strong><NumberFlowValue value={total} delay={180} /></strong>
      </div>
      <div>
        <span>{title}</span>
        <small>{data.map((item) => `${item.name} ${item.value}`).join(" / ") || "No data"}</small>
      </div>
    </div>
  );
}

function RiskRegister({ flags, model }) {
  const risks = flags.length ? flags : [{ tone: "success", label: "No blocking risk flagged", detail: "Review coverage fit and evidence profile before making the final release call." }];
  return (
    <section className={styles.riskRegister}>
      <div className={styles.panelKicker}>
        <ShieldAlert />
        Risk Register
      </div>
      <div className={styles.riskList}>
        {risks.map((risk) => (
          <article key={`${risk.label}-${risk.detail}`} data-tone={risk.tone}>
            <strong>{risk.label}</strong>
            <span>{risk.detail}</span>
          </article>
        ))}
      </div>
      <div className={styles.riskEvidence}>
        <span>Evidence</span>
        <strong><NumberFlowValue value={model.evidence.length} delay={320} /></strong>
        <small>{countEvidenceByKind(model.evidence, "trace")} traces / {countEvidenceByKind(model.evidence, "screenshot")} screenshots</small>
      </div>
    </section>
  );
}

function SectionHeader({ icon: Icon, title, description }) {
  return (
    <header className={styles.sectionHeader}>
      <div>
        {Icon ? <Icon /> : null}
        <h2>{title}</h2>
      </div>
      <p>{description}</p>
    </header>
  );
}

function FailureDiagnosis({ failure }) {
  if (!failure) {
    return (
      <div className={styles.noFailure}>
        <CheckCircle2 />
        <div>
          <strong>No blocking failure</strong>
          <span>The report model did not identify a failed step. Continue with coverage and evidence review.</span>
        </div>
      </div>
    );
  }
  const expectation = pickExpectation(failure.raw);
  const source = getFailureSource(failure);
  const evidenceItems = createFailureEvidenceItems(failure);
  return (
    <div className={styles.failureDiagnosis}>
      <div className={styles.failureLead}>
        <Badge variant="danger">First blocker</Badge>
        <h3>{failure.stepTitle || "Failed step"}</h3>
        <p>{failure.message || getFailureAudienceDetail(failure)}</p>
      </div>
      <div className={styles.failureFacts}>
        <Fact label="Case" value={failure.caseName || "-"} />
        <Fact label="Step" value={getFailureStepLabel(failure)} />
        <Fact label="Failed operation" value={failure.actionType || "-"} />
        <Fact label="Execution stage" value={source.join(" / ") || "-"} />
      </div>
      <div className={styles.expectationGrid}>
        <Fact label="Expected" value={expectation.expected} mono />
        <Fact label="Actual" value={expectation.actual} mono />
      </div>
      <div className={styles.fixBox}>
        <GitBranch />
        <div>
          <strong>Suggested fix action</strong>
          <span>{getFixAction(failure)}</span>
        </div>
      </div>
      {failure.afterScreenshotPath || failure.beforeScreenshotPath ? (
        <div className={styles.failurePreviewGrid}>
          {failure.afterScreenshotPath ? <EvidenceImagePreview label="After screenshot" path={failure.afterScreenshotPath} prominent /> : null}
          {failure.beforeScreenshotPath ? <EvidenceImagePreview label="Before screenshot" path={failure.beforeScreenshotPath} /> : null}
        </div>
      ) : null}
      <div className={styles.evidenceChips}>
        {evidenceItems.map((item) => (
          <CopyChip key={`${item.label}-${item.value}`} label={item.label} value={item.value} />
        ))}
      </div>
    </div>
  );
}

function EvidenceImagePreview({ label, path, prominent = false }) {
  // v1.8 perf: state holds a URL, not the image bytes. Under Electron this is a
  // `zhuzhu-evidence://` address, so the screenshot never crosses IPC and never
  // sits in the renderer's JS heap as a base64 string.
  const [image, setImage] = useState({ status: "idle", src: "", error: "" });

  useEffect(() => {
    let canceled = false;
    if (!path) {
      setImage({ status: "empty", src: "", error: "" });
      return undefined;
    }
    setImage({ status: "loading", src: "", error: "" });
    resolveEvidenceImageSrc(path)
      .then((payload) => {
        if (canceled) {
          return;
        }
        if (payload?.success && payload.src) {
          setImage({ status: "loaded", src: payload.src, error: "" });
          return;
        }
        setImage({ status: "error", src: "", error: payload?.error || "Screenshot unavailable" });
      })
      .catch((error) => {
        if (!canceled) {
          setImage({ status: "error", src: "", error: error?.message || "Screenshot unavailable" });
        }
      });
    return () => {
      canceled = true;
    };
  }, [path]);

  const ready = image.status === "loaded" && image.src;
  return (
    <button
      type="button"
      className={styles.evidenceImagePreview}
      data-prominent={prominent}
      onClick={() => copyTextToClipboard(path)}
      title={path}
    >
      <span>{label}</span>
      {ready ? (
        <img src={image.src} alt={`${label} evidence`} loading="lazy" decoding="async" />
      ) : (
        <small>
          {image.status === "loading" ? <Loader2 data-loading="true" /> : <ImageOff />}
          {image.status === "loading" ? "Loading screenshot" : image.error || "No screenshot"}
        </small>
      )}
    </button>
  );
}

function FailedCasesList({ failures, cases }) {
  const passedCount = cases.filter((item) => !item.isRoot && item.status === "passed").length;
  const skippedCount = cases.filter((item) => !item.isRoot && item.status === "skipped").length;
  if (!failures.length) {
    return (
      <div className={styles.noFailure}>
        <CheckCircle2 />
        <div>
          <strong>No failed cases</strong>
          <span>{passedCount} passed cases, {skippedCount} skipped cases.</span>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.failedCasesList}>
      {failures.map((failure, index) => (
        <article key={`${failure.caseId}-${failure.stepId}-${index}`}>
          <span className={styles.failedCaseNumber}>{String(index + 1).padStart(2, "0")}</span>
          <div className={styles.failedCaseBody}>
            <strong>{failure.caseName || "-"}</strong>
            <small>{getFailureStepLabel(failure)} · {failure.stepTitle || "-"}</small>
            <p>{summarizeFailureMessage(failure)}</p>
            {failure.message && failure.message !== summarizeFailureMessage(failure) ? (
              <details className={styles.failureRawDetails}>
                <summary>Technical error</summary>
                <code>{failure.message}</code>
              </details>
            ) : null}
          </div>
          <div className={styles.failedCaseActions}>
            {failure.tracePath ? <CopyChip label="Trace" value={failure.tracePath} /> : null}
            {failure.afterScreenshotPath ? <CopyChip label="Screenshot" value={failure.afterScreenshotPath} /> : null}
          </div>
        </article>
      ))}
      <footer>
        <strong>Passed cases: {passedCount}</strong>
        <span>Skipped cases: {skippedCount}</span>
      </footer>
    </div>
  );
}

function FailureEvidencePackage({ failures, evidence }) {
  if (!failures.length) {
    return <EvidenceSummary evidence={evidence} failures={failures} />;
  }
  return (
    <div className={styles.failureEvidencePackage}>
      {failures.map((failure, index) => {
        const items = createFailureEvidenceItems(failure);
        return (
          <article key={`${failure.caseId}-${failure.stepId}-${index}`}>
            <header>
              <Badge variant="danger">Failure {index + 1}</Badge>
              <strong>{failure.caseName || "-"}</strong>
              <span>{failure.stepTitle || "-"}</span>
            </header>
            {items.length ? (
              <div className={styles.failureEvidenceLinks}>
                {items.map((item) => (
                  <button key={`${item.label}-${item.value}`} type="button" onClick={() => copyTextToClipboard(item.value)}>
                    <FileJson />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.kind} evidence · copy path</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className={styles.emptyPanel}>No evidence paths for this failure.</div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function FailureIndexTable({ failures }) {
  if (!failures.length) {
    return null;
  }
  return (
    <div className={styles.failureTable} role="table" aria-label="Failure index">
      <div role="row">
        <span>#</span>
        <span>Case</span>
        <span>Step</span>
        <span>Type</span>
        <span>Trace</span>
      </div>
      {failures.slice(0, 12).map((failure, index) => (
        <div key={`${failure.caseId}-${failure.stepId}-${index}`} role="row">
          <span>{index + 1}</span>
          <strong title={failure.caseName}>{failure.caseName || "-"}</strong>
          <span title={failure.stepTitle}>{failure.stepTitle || "-"}</span>
          <span>{failure.actionType || failure.message || "-"}</span>
          <code title={failure.tracePath || ""}>{failure.tracePath || "-"}</code>
        </div>
      ))}
    </div>
  );
}

function Fact({ label, value, mono = false }) {
  return (
    <div className={styles.fact} data-mono={mono}>
      <span>{label}</span>
      <strong title={String(value ?? "-")}>{value || "-"}</strong>
    </div>
  );
}

function CopyChip({ label, value }) {
  return (
    <button type="button" className={styles.copyChip} onClick={() => copyTextToClipboard(value)}>
      <Copy />
      <span>{label}</span>
    </button>
  );
}

function StatusMix({ title, counts, emphasize = false, compact = false }) {
  const total = counts.total || 0;
  const segments = STATUS_META.map(([status, label], index) => ({
    status,
    label,
    value: counts[status] || 0,
    delay: 100 + index * 72,
  }));
  return (
    <div className={styles.statusMix} data-emphasize={emphasize} data-compact={compact}>
      <header>
        <span>{title}</span>
        <strong><NumberFlowValue value={total} delay={140} /></strong>
      </header>
      <div className={styles.statusBar} aria-label={`${title}: ${total}`}>
        {segments.map((segment) => (
          <i
            key={segment.status}
            data-status={segment.status}
            style={{
              width: total ? `${(segment.value / total) * 100}%` : "0%",
              "--bar-delay": `${segment.delay}ms`,
            }}
            title={`${segment.label}: ${segment.value}`}
          />
        ))}
      </div>
      <div className={styles.statusLegend}>
        {segments.map((segment) => (
          <span key={segment.status} data-status={segment.status}>
            <i />
            {segment.label}
            <strong><NumberFlowValue value={segment.value} delay={segment.delay + 120} /></strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function ContextPanel({ rows }) {
  return (
    <div className={styles.contextPanel}>
      <header>
        <Layers3 />
        <strong>Report context</strong>
      </header>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={String(value)}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function StatusCompositionChart({ title, caseData, stepData }) {
  const [panelRef, visible] = useDelayedVisible({ activateDelay: 140 });
  const combined = [
    ...caseData.map((item) => ({ ...item, group: "Cases" })),
    ...stepData.map((item) => ({ ...item, group: "Steps" })),
  ];
  return (
    <div ref={panelRef} className={styles.chartPanel} data-visible={visible}>
      <header>
        <Target />
        <strong>{title}</strong>
        <span>Case and step outcome distribution</span>
      </header>
      <div className={styles.dualDonutGrid}>
        <MiniStatusDonut title="Cases" data={caseData} total={caseData.reduce((sum, item) => sum + item.value, 0)} />
        <MiniStatusDonut title="Steps" data={stepData} total={stepData.reduce((sum, item) => sum + item.value, 0)} />
      </div>
      <div className={styles.statusColorLegend}>
        {STATUS_META.map(([status, label]) => (
          <span key={status}>
            <i style={{ background: STATUS_COLORS[status] }} />
            {label}
            <strong>{combined.filter((item) => item.status === status).reduce((sum, item) => sum + item.value, 0)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function PhaseDistributionChart({ data }) {
  const [panelRef, visible] = useDelayedVisible({ activateDelay: 180 });
  return (
    <div ref={panelRef} className={styles.chartPanel} data-visible={visible}>
      <header>
        <GitBranch />
        <strong>Phase distribution</strong>
        <span>Where executable steps were concentrated</span>
      </header>
      {data.length ? (
        <div className={styles.chartCanvas}>
          <ResponsiveContainer width="100%" height={190} className={styles.rechartsChart}>
            <BarChart data={data} margin={{ top: 8, right: 10, bottom: 8, left: -18 }}>
              <CartesianGrid stroke={CHART_GRID_COLOR} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="value" name="Steps" fill={STATUS_COLORS.passed} radius={[5, 5, 2, 2]} isAnimationActive={visible} animationDuration={620} animationEasing="ease-out" />
            </BarChart>
          </ResponsiveContainer>
          <StaticHorizontalBarChart data={data} />
        </div>
      ) : (
        <div className={styles.emptyPanel}>No phase distribution data</div>
      )}
    </div>
  );
}

function ActionCoverageChart({ data }) {
  const [panelRef, visible] = useDelayedVisible({ activateDelay: 220 });
  const rows = data.slice(0, 8).map((item) => ({
    name: item.name,
    value: Number(item.value) || 0,
  }));
  return (
    <div ref={panelRef} className={styles.chartPanel} data-visible={visible}>
      <header>
        <BarChart3 />
        <strong>Action coverage</strong>
        <span>Action type distribution across executed steps</span>
      </header>
      {rows.length ? (
        <div className={styles.chartCanvas}>
          <ResponsiveContainer width="100%" height={218} className={styles.rechartsChart}>
            <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 8 }}>
              <CartesianGrid stroke={CHART_GRID_COLOR} horizontal={false} />
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="name"
                width={104}
                tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="value" name="Steps" fill="#244f42" radius={[0, 5, 5, 0]} isAnimationActive={visible} animationDuration={620} animationEasing="ease-out" />
            </BarChart>
          </ResponsiveContainer>
          <StaticHorizontalBarChart data={rows} />
        </div>
      ) : (
        <div className={styles.emptyPanel}>No action coverage data</div>
      )}
    </div>
  );
}

function CaseDurationChart({ data }) {
  const [panelRef, visible] = useDelayedVisible({ activateDelay: 260 });
  return (
    <div ref={panelRef} className={styles.chartPanel} data-visible={visible}>
      <header>
        <ListChecks />
        <strong>Case duration profile</strong>
        <span>Duration by case with step volume context</span>
      </header>
      {data.length ? (
        <div className={styles.chartCanvas}>
          <ResponsiveContainer width="100%" height={218} className={styles.rechartsChart}>
            <LineChart data={data} margin={{ top: 12, right: 18, bottom: 8, left: -8 }}>
              <CartesianGrid stroke={CHART_GRID_COLOR} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="duration" tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="steps" orientation="right" tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Line yAxisId="duration" type="monotone" dataKey="durationSeconds" name="Duration (s)" stroke={STATUS_COLORS.passed} strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }} isAnimationActive={visible} animationDuration={680} animationEasing="ease-out" />
              <Line yAxisId="steps" type="monotone" dataKey="steps" name="Steps" stroke="#8a6f28" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={visible} animationDuration={720} animationEasing="ease-out" />
            </LineChart>
          </ResponsiveContainer>
          <StaticLineChart data={data} />
        </div>
      ) : (
        <div className={styles.emptyPanel}>No case duration data</div>
      )}
    </div>
  );
}

function StaticHorizontalBarChart({ data }) {
  const max = Math.max(...data.map((item) => Number(item.value) || 0), 1);
  return (
    <div className={styles.staticHorizontalBars} aria-hidden="true">
      {data.map((item, index) => {
        const value = Number(item.value) || 0;
        return (
          <div key={`${item.name}-${index}`}>
            <span>{item.name}</span>
            <i><b style={{ width: `${Math.max(3, (value / max) * 100)}%` }} /></i>
            <strong>{value}</strong>
          </div>
        );
      })}
    </div>
  );
}

function StaticStatusBreakdown({ data }) {
  const max = Math.max(...data.map((item) => Number(item.value) || 0), 1);
  return (
    <div className={styles.staticStatusBreakdown} aria-hidden="true">
      {data.map((item, index) => {
        const value = Number(item.value) || 0;
        const color = item.color || STATIC_CHART_COLORS[index % STATIC_CHART_COLORS.length];
        return (
          <div key={`${item.name}-${index}`}>
            <span><i style={{ background: color }} />{item.name}</span>
            <b><em style={{ width: `${Math.max(3, (value / max) * 100)}%`, background: color }} /></b>
            <strong>{value}</strong>
          </div>
        );
      })}
    </div>
  );
}

function StaticLineChart({ data }) {
  const width = 520;
  const height = 150;
  const durationPoints = createStaticLinePoints(data, "durationSeconds", width, height);
  const stepPoints = createStaticLinePoints(data, "steps", width, height);
  return (
    <svg className={styles.staticLineChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Case duration static chart">
      <polyline points={durationPoints} fill="none" stroke={STATUS_COLORS.passed} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={stepPoints} fill="none" stroke="#8a6f28" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((item, index) => {
        const x = data.length > 1 ? 18 + index * ((width - 36) / (data.length - 1)) : width / 2;
        return <text key={`${item.name}-${index}`} x={x} y={height - 2} textAnchor="middle">{index + 1}</text>;
      })}
    </svg>
  );
}

function SlowestStepsChart({ data }) {
  const [panelRef, visible] = useDelayedVisible({ activateDelay: 300 });
  const rows = data.slice(0, 8).map((item, index) => ({
    name: item.name || `Step ${index + 1}`,
    caseName: item.caseName || item.caseLabel || "-",
    type: item.type || "-",
    durationMs: Number(item.durationMs) || 0,
    durationSeconds: Math.round((Number(item.durationMs) || 0) / 1000),
  })).filter((item) => item.durationMs > 0);
  const maxDuration = Math.max(...rows.map((item) => item.durationMs), 0);
  return (
    <div ref={panelRef} className={`${styles.chartPanel} ${styles.slowestStepsPanel}`} data-visible={visible}>
      <header>
        <Clock3 />
        <strong>Slowest steps</strong>
        <span>Highest single-step durations with case context</span>
      </header>
      {rows.length && maxDuration ? (
        <div className={styles.slowestSteps}>
          {rows.map((item, index) => (
            <div key={`${item.caseName}-${item.name}-${index}`} className={styles.slowestStepRow}>
              <span title={item.name}>{item.name}</span>
              <small title={item.caseName}>{item.caseName}</small>
              <div aria-label={`${item.name}: ${formatDuration(item.durationMs)}`}>
                <i style={{ width: `${Math.max(4, (item.durationMs / maxDuration) * 100)}%`, "--bar-delay": `${120 + index * 54}ms` }} />
              </div>
              <strong>{formatDuration(item.durationMs)}</strong>
              <em>{item.type}</em>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.emptyPanel}>No slow step timing data</div>
      )}
    </div>
  );
}

function QualitySignals({ signals }) {
  return (
    <div className={styles.qualityPanel}>
      <header>
        <ShieldCheck />
        <strong>Quality signals</strong>
      </header>
      <div className={styles.qualityList}>
        {signals.map((signal) => (
          <article key={signal.label} data-tone={signal.tone}>
            <span>{signal.label}</span>
            <strong>{signal.value}</strong>
            <small>{signal.detail}</small>
          </article>
        ))}
      </div>
    </div>
  );
}

function RankedBars({ title, data }) {
  const rows = data.slice(0, 7);
  const max = Math.max(...rows.map((item) => Number(item.value) || 0), 0);
  return (
    <div className={styles.rankedPanel}>
      <header>
        <BarChart3 />
        <strong>{title}</strong>
      </header>
      {rows.length && max ? (
        <div className={styles.rankedRows}>
          {rows.map((item, index) => {
            const value = Number(item.value) || 0;
            return (
              <div key={`${item.name}-${index}`} className={styles.rankedRow}>
                <span title={item.name}>{item.name}</span>
                <div title={`${item.name}: ${value}`}>
                  <i style={{ width: `${(value / max) * 100}%`, "--bar-delay": `${120 + index * 62}ms` }} />
                </div>
                <strong><NumberFlowValue value={value} delay={240 + index * 62} /></strong>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyPanel}>No action coverage data</div>
      )}
    </div>
  );
}

function CaseMatrix({ cases }) {
  if (!cases.length) {
    return <div className={styles.emptyPanel}>No case matrix is available.</div>;
  }
  return (
    <div className={styles.caseMatrix} role="table" aria-label="Professional case matrix">
      <div className={styles.caseMatrixHeader} role="row">
        <span>Status</span>
        <span>Case</span>
        <span>Priority</span>
        <span>Steps</span>
        <span>Duration</span>
        <span>Failure / note</span>
      </div>
      {cases.map((caseItem) => (
        <div key={caseItem.caseId} className={styles.caseMatrixRow} role="row" data-status={caseItem.status}>
          <span>
            <Badge variant={statusVariant(caseItem.status)}>{statusLabel(caseItem.status)}</Badge>
          </span>
          <strong title={caseItem.caseName}>{caseItem.caseName}</strong>
          <span>{caseItem.isRoot ? "Root" : caseItem.priority || "Case"}</span>
          <span>
            <NumberFlowValue value={caseItem.completedSteps} delay={120} />/<NumberFlowValue value={caseItem.totalSteps} delay={200} />
          </span>
          <span><NumberFlowDuration value={caseItem.durationMs} delay={240} /></span>
          <span title={caseItem.error ? caseItem.error.message || caseItem.error.code || "Failed" : ""}>
            {caseItem.error ? caseItem.error.message || caseItem.error.code || "Failed" : "-"}
          </span>
        </div>
      ))}
    </div>
  );
}

function EvidenceSummary({ evidence, failures }) {
  const summaryItems = [
    ["Evidence items", evidence.length],
    ["Replay records", failures.filter((item) => item.tracePath).length],
    ["Screenshots", failures.reduce((sum, item) => sum + (item.beforeScreenshotPath ? 1 : 0) + (item.afterScreenshotPath ? 1 : 0), 0)],
  ];
  return (
    <div className={styles.evidenceSummary}>
      {summaryItems.map(([label, value], index) => (
        <div key={label}>
          <span>{label}</span>
          <strong><NumberFlowValue value={value} delay={120 + index * 90} /></strong>
        </div>
      ))}
      <div className={styles.evidencePreview}>
        {(evidence.slice(0, 8).length ? evidence.slice(0, 8) : [{ kind: "empty", label: "No evidence paths", value: "The current model did not expose artifact paths." }]).map((item) => (
          <button
            key={`${item.kind}-${item.value}`}
            type="button"
            disabled={item.kind === "empty"}
            onClick={() => item.kind !== "empty" && copyTextToClipboard(item.value)}
          >
            <FileJson />
            <span>
              <strong>{item.label}</strong>
              <small>{item.kind === "empty" ? item.value : item.kind}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Appendix({ evidence, failures }) {
  return (
    <div className={styles.appendix}>
      <details>
        <summary>Full evidence paths</summary>
        <div className={styles.pathList}>
          {evidence.length ? evidence.map((item) => (
            <button key={`${item.kind}-${item.value}`} type="button" onClick={() => copyTextToClipboard(item.value)}>
              <span>{item.label}</span>
              <code>{item.value}</code>
              <Copy />
            </button>
          )) : <div className={styles.emptyPanel}>No evidence paths</div>}
        </div>
      </details>
      <details>
        <summary>Failure evidence index</summary>
        <div className={styles.failureIndex}>
          {failures.length ? failures.map((failure, index) => (
            <article key={`${failure.caseId}-${failure.stepId}-${index}`}>
              <strong>{failure.caseName}</strong>
              <span>{failure.stepTitle}</span>
              <code>{failure.tracePath || "No trace path"}</code>
            </article>
          )) : <div className={styles.emptyPanel}>No failures</div>}
        </div>
      </details>
    </div>
  );
}
