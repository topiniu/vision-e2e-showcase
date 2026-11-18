import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  ImageOff,
  Loader2,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { NumberFlowDuration, NumberFlowValue } from "@panel/components/shared/NumberFlowValue";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@panel/components/ui/sheet";
import { StepExecutionDetail } from "@panel/components/shared/StepExecutionDetail";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import { retainEvidenceImageCache } from "@panel/lib/evidence-image-cache.mjs";
import { exportPdf, readEvidenceImage } from "@panel/lib/panel-api";
import { cn } from "@panel/lib/utils";
import appIconUrl from "../../assets/app-icon-256.png";
import styles from "./RunResultReportDialog.module.css";

const STATUS_META = [
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["skipped", "Skipped"],
  ["pending", "Pending"],
];

const EXECUTIVE_KPI_NUMBER_DELAYS = {
  passRate: 160,
  casePassed: 220,
  caseTotal: 260,
  stepPassRate: 240,
  stepPassed: 300,
  stepTotal: 340,
  duration: 320,
  failures: 380,
  failedSteps: 420,
};

const STEP_STATUS_CHART_NUMBER_DELAYS = {
  total: 100,
  barBase: 150,
  legendCount: 260,
  legendStagger: 45,
};

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

function formatDateTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(numeric));
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

function statusIcon(status) {
  if (status === "passed") {
    return <CheckCircle2 />;
  }
  if (status === "failed") {
    return <AlertCircle />;
  }
  return <Clock3 />;
}

function safeJson(value) {
  if (value == null) {
    return "{}";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pdfStatusClass(status) {
  if (status === "passed") {
    return "status-passed";
  }
  if (status === "failed") {
    return "status-failed";
  }
  if (status === "skipped" || status === "stopped") {
    return "status-skipped";
  }
  return "status-pending";
}

function renderPdfKpi(label, value, detail, tone = "") {
  return `
    <div class="kpi ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function renderPdfStatusBar(counts = {}) {
  const total = Number(counts.total) || 0;
  const items = [
    ["bar-passed", "Passed", Number(counts.passed) || 0],
    ["bar-failed", "Failed", Number(counts.failed) || 0],
    ["bar-skipped", "Skipped", Number(counts.skipped) || 0],
    ["bar-pending", "Pending", Number(counts.pending) || 0],
  ];
  if (!total) {
    return '<div class="empty">No status data</div>';
  }
  return `
    <div class="stacked-bar">${items.map(([status, label, value]) => `
      <i class="${status}" style="width:${(value / total) * 100}%" title="${escapeHtml(`${label}: ${value}`)}"></i>
    `).join("")}</div>
    <div class="legend">${items.map(([status, label, value]) => `
      <span><i class="${status}"></i>${escapeHtml(label)} <strong>${value}</strong></span>
    `).join("")}</div>
  `;
}

function renderPdfRankList(items = [], valueKey = "value", formatter = (value) => String(value), limit = 8) {
  const rows = items.slice(0, limit);
  const max = Math.max(...rows.map((item) => Number(item[valueKey]) || 0), 0);
  if (!rows.length || !max) {
    return '<div class="empty">No chart data</div>';
  }
  return `
    <div class="rank-list">
      ${rows.map((item) => {
        const value = Number(item[valueKey]) || 0;
        return `
          <div class="rank-row">
            <span>${escapeHtml(item.name || item.caseName || "-")}</span>
            <div><i style="width:${Math.max(3, (value / max) * 100)}%"></i></div>
            <strong>${escapeHtml(formatter(value))}</strong>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function buildReportPdfHtml(model) {
  const status = pdfStatusClass(model.status);
  const stepTotal = model.summary.stepCounts.total || 0;
  const stepPassed = model.summary.stepCounts.passed || 0;
  const stepPassRate = stepTotal ? Math.round((stepPassed / stepTotal) * 100) : 0;
  const finishedAt = formatDateTime(model.summary.finishedAt || model.summary.startedAt);
  const firstFailure = model.summary.firstFailure;
  const verdict = model.status === "failed"
    ? "Execution blocked"
    : model.status === "passed"
      ? "Execution accepted"
      : model.status === "stopped"
        ? "Execution stopped"
        : "Execution incomplete";
  const recommendation = model.status === "failed"
    ? "Fix the first blocking failure, then rerun the affected case before a full file rerun."
    : model.status === "passed"
      ? "Evidence is complete for this run. Review coverage before using it as release support."
      : "Complete the run to produce a release-ready report.";
  const slowestSteps = model.charts.slowestSteps || [];
  const caseRows = model.cases.map((caseItem) => `
    <tr>
      <td><span class="pill ${pdfStatusClass(caseItem.status)}">${escapeHtml(statusLabel(caseItem.status))}</span></td>
      <td><strong>${escapeHtml(caseItem.caseName)}</strong></td>
      <td>${escapeHtml(caseItem.priority || "-")}</td>
      <td>${escapeHtml(`${caseItem.completedSteps}/${caseItem.totalSteps}`)}</td>
      <td>${escapeHtml(formatDuration(caseItem.durationMs))}</td>
      <td>${escapeHtml(caseItem.error ? caseItem.error.message || caseItem.error.code || "Failed" : "-")}</td>
    </tr>
  `).join("");
  const failureCards = model.failures.length
    ? model.failures.map((failure, index) => `
      <article class="failure">
        <header>
          <span class="pill status-failed">Failure ${index + 1}</span>
          <strong>${escapeHtml(failure.caseName || "-")}</strong>
          <small>${escapeHtml([failure.phase, failure.actionType].filter(Boolean).join(" / "))}</small>
        </header>
        <h4>${escapeHtml(failure.stepTitle || "Failed step")}</h4>
        <p>${escapeHtml(failure.message || "Runtime failure")}</p>
        ${failure.tracePath ? `<code>${escapeHtml(failure.tracePath)}</code>` : ""}
      </article>
    `).join("")
    : '<div class="empty">No failed steps</div>';
  const evidenceRows = model.evidence.length
    ? model.evidence.map((item) => `
      <div class="evidence-row">
        <strong>${escapeHtml(item.label || item.kind)}</strong>
        <code>${escapeHtml(item.value)}</code>
      </div>
    `).join("")
    : '<div class="empty">No artifact paths</div>';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(model.context.testFileName)} - QA Report</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #fffdf8;
      color: #17211c;
      font: 11px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .document {
      display: grid;
      gap: 12px;
      min-height: 100vh;
      padding: 16mm 18mm 18mm;
    }
    .sheet-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid #d9d4c6;
      break-after: avoid;
    }
    .eyebrow { color: #2d6c4d; font-size: 8px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    h1, h2, h3, h4, p { margin: 0; }
    h1 { margin-top: 3px; color: #17211c; font-size: 20px; line-height: 1.16; }
    .meta { margin-top: 3px; color: #526258; font-size: 9px; }
    .pill {
      display: inline-flex;
      align-items: center;
      align-self: start;
      min-height: 22px;
      border-radius: 6px;
      padding: 2px 9px;
      border: 1px solid #d9d4c6;
      background: #fffef9;
      color: #526258;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .pill.status-passed { border-color: #b7dfc8; background: #effaf3; color: #20754d; }
    .pill.status-failed { border-color: #efc3bf; background: #fff1ef; color: #b3352d; }
    .pill.status-skipped { border-color: #ecd19a; background: #fff8e8; color: #9b6410; }
    .pill.status-pending { border-color: #d5dccd; background: #f7f8f2; color: #6d7764; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr);
      gap: 12px;
      padding: 12px;
      border: 1px solid #d9d4c6;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(35,65,54,.045), transparent 48%), #fffef9;
      break-inside: avoid;
    }
    .hero.status-failed { background: linear-gradient(135deg, rgba(179,53,45,.07), transparent 48%), #fffef9; }
    .verdict { display: grid; align-content: center; gap: 6px; }
    .verdict h2 { color: #15231c; font-size: 24px; line-height: 1.04; }
    .verdict p { color: #526258; font-size: 10px; }
    .callout {
      display: grid;
      gap: 3px;
      margin-top: 4px;
      padding: 10px;
      border: 1px solid #efc3bf;
      border-radius: 8px;
      background: #fff1ef;
      color: #b3352d;
    }
    .kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .kpi {
      display: grid;
      gap: 4px;
      min-height: 62px;
      padding: 9px 10px;
      border: 1px solid #e4dfd2;
      border-radius: 7px;
      background: #fbfaf5;
    }
    .kpi span, .kpi small { overflow: hidden; color: #526258; font-size: 8.5px; text-overflow: ellipsis; white-space: nowrap; }
    .kpi strong { color: #234136; font-size: 20px; line-height: 1; }
    .kpi.danger strong, .kpi.danger small { color: #b3352d; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .panel {
      display: grid;
      gap: 8px;
      padding: 11px;
      border: 1px solid #d9d4c6;
      border-radius: 7px;
      background: #fffef9;
      break-inside: avoid;
    }
    .section {
      display: grid;
      gap: 8px;
      padding: 10px 0 0;
      border-top: 1px solid #d9d4c6;
      break-inside: auto;
    }
    .section.compact { break-inside: avoid; }
    .panel h3, .section h3 { color: #17211c; font-size: 12px; }
    .panel > p, .section > p { color: #526258; font-size: 8.5px; }
    .stacked-bar { display: flex; height: 10px; overflow: hidden; border-radius: 999px; background: #e8e5da; }
    .stacked-bar i { display: block; min-width: 1px; height: 100%; }
    .bar-passed { background: #20754d; }
    .bar-failed { background: #b3352d; }
    .bar-skipped { background: #b97818; }
    .bar-pending { background: #dbe2d3; }
    .legend { display: flex; flex-wrap: wrap; gap: 6px 10px; color: #526258; font-size: 8.5px; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend i { width: 7px; height: 7px; border-radius: 999px; }
    .rank-list { display: grid; gap: 6px; }
    .rank-row { display: grid; grid-template-columns: minmax(90px, .78fr) minmax(112px, 1fr) 42px; gap: 7px; align-items: center; }
    .rank-row span { overflow: hidden; color: #526258; text-overflow: ellipsis; white-space: nowrap; }
    .rank-row div { height: 6px; overflow: hidden; border-radius: 999px; background: #e8e5da; }
    .rank-row i { display: block; height: 100%; border-radius: inherit; background: #234136; }
    .rank-row strong { color: #17211c; font-size: 8.5px; text-align: right; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8.7px; }
    th, td { padding: 6px 6px; border-bottom: 1px solid #e4dfd2; text-align: left; vertical-align: top; }
    th { color: #526258; font-size: 7.5px; text-transform: uppercase; }
    td { color: #25322b; }
    th:nth-child(1), td:nth-child(1) { width: 70px; }
    th:nth-child(3), td:nth-child(3) { width: 46px; }
    th:nth-child(4), td:nth-child(4) { width: 54px; }
    th:nth-child(5), td:nth-child(5) { width: 58px; }
    th:nth-child(6), td:nth-child(6) { width: 86px; }
    td strong { font-weight: 720; }
    .failure { display: grid; gap: 6px; padding: 10px; border: 1px solid #efc3bf; border-radius: 8px; background: #fff8f7; break-inside: avoid; }
    .failure header { display: flex; align-items: center; gap: 8px; }
    .failure header small { color: #526258; }
    .failure h4 { font-size: 12px; }
    .failure p { color: #7a342d; font-size: 10px; }
    code { overflow-wrap: anywhere; color: #25322b; font: 7.6px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .evidence-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 8px; padding: 6px 0; border-bottom: 1px solid #e4dfd2; break-inside: avoid; }
    .evidence-row strong { color: #25322b; font-size: 8.5px; }
    .evidence-row:last-child { border-bottom: 0; }
    .empty { padding: 9px; border: 1px dashed #d9d4c6; border-radius: 7px; color: #526258; background: #fbfaf5; }
  </style>
</head>
<body>
  <main class="document">
    <header class="sheet-header">
      <div>
        <div class="eyebrow">QA Execution Report</div>
        <h1>${escapeHtml(model.context.testFileName)}</h1>
        <div class="meta">${escapeHtml(model.context.testFilePath || "Current test file")} · ${escapeHtml(finishedAt)}</div>
      </div>
      <span class="pill ${status}">${escapeHtml(statusLabel(model.status))}</span>
    </header>

    <section class="hero ${status}">
      <div class="verdict">
        <div class="eyebrow">Professional QA Result</div>
        <h2>${escapeHtml(verdict)}</h2>
        <p>${escapeHtml(recommendation)}</p>
        ${firstFailure ? `<div class="callout"><strong>${escapeHtml(firstFailure.stepTitle || "First blocking step")}</strong><span>${escapeHtml(firstFailure.message || "Runtime failure")}</span></div>` : ""}
      </div>
      <div class="kpis">
        ${renderPdfKpi("Pass rate", `${model.summary.passRate}%`, `${model.summary.caseCounts.passed}/${model.summary.caseCounts.total || 0} cases passed`)}
        ${renderPdfKpi("Step pass rate", `${stepPassRate}%`, `${stepPassed}/${stepTotal} steps passed`)}
        ${renderPdfKpi("Duration", formatDuration(model.summary.durationMs), model.summary.browserUrl || model.context.baseUrl || "No browser URL")}
        ${renderPdfKpi("Failures", model.failures.length, `${model.summary.stepCounts.failed} failed steps`, model.failures.length ? "danger" : "")}
      </div>
    </section>

    <section class="grid-2">
      <article class="panel">
        <h3>Case status</h3>
        <p>Case outcome mix.</p>
        ${renderPdfStatusBar(model.summary.caseCounts)}
      </article>
      <article class="panel">
        <h3>Step status</h3>
        <p>Executable step outcome mix.</p>
        ${renderPdfStatusBar(model.summary.stepCounts)}
      </article>
      <article class="panel">
        <h3>Slowest cases</h3>
        <p>Top case durations in this run.</p>
        ${renderPdfRankList(model.charts.caseDurations || [], "durationMs", formatDuration, 6)}
      </article>
      <article class="panel">
        <h3>Slowest steps</h3>
        <p>Highest single-step durations.</p>
        ${renderPdfRankList(slowestSteps, "durationMs", formatDuration, 6)}
      </article>
    </section>

    <section class="section">
      <h3>Case Matrix</h3>
      <p>Case-level outcome, priority, timing and first failure.</p>
      <table>
        <thead><tr><th>Status</th><th>Case</th><th>Priority</th><th>Steps</th><th>Duration</th><th>Failure</th></tr></thead>
        <tbody>${caseRows || '<tr><td colspan="6">No case data</td></tr>'}</tbody>
      </table>
    </section>

    <section class="section compact">
      <h3>Failure Analysis</h3>
      <p>First-order runtime failures with trace shortcuts.</p>
      ${failureCards}
    </section>

    <section class="section">
      <h3>Evidence</h3>
      <p>Report, run directory, trace and screenshot artifacts collected from the execution.</p>
      ${evidenceRows}
    </section>
  </main>
</body>
</html>`;
}

function useVisibleOnce({ activateDelay = 0, rootMargin = "0px 0px -10% 0px", threshold = 0.45 } = {}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) {
      return undefined;
    }
    const node = ref.current;
    if (!node || typeof window === "undefined" || !("IntersectionObserver" in window)) {
      setVisible(true);
      return undefined;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setVisible(true);
      return undefined;
    }
    let timer = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          timer = window.setTimeout(() => {
            setVisible(true);
          }, activateDelay);
          observer.disconnect();
        }
      },
      { rootMargin, threshold },
    );
    observer.observe(node);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [activateDelay, rootMargin, threshold, visible]);

  return [ref, visible];
}

export function RunResultReportDialog({ open, onOpenChange, model, titlebarSafe = false }) {
  const [imageCache, setImageCache] = useState({});
  const [lightbox, setLightbox] = useState(null);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const [pdfExportState, setPdfExportState] = useState({ status: "idle", message: "" });
  const imageCacheRef = useRef({});

  const screenshotPaths = useMemo(
    () =>
      (model?.failures || [])
        .flatMap((failure) => [
          { label: `${failure.stepTitle} before`, path: failure.beforeScreenshotPath },
          { label: `${failure.stepTitle} after`, path: failure.afterScreenshotPath },
        ])
        .filter((item) => item.path)
        .slice(0, 6),
    [model],
  );

  useEffect(() => {
    if (!open) {
      imageCacheRef.current = {};
      setImageCache({});
      setLightbox(null);
      return undefined;
    }
    let cancelled = false;
    const activePaths = screenshotPaths.map((item) => item.path);
    const retainedCache = retainEvidenceImageCache(imageCacheRef.current, activePaths);
    imageCacheRef.current = retainedCache;
    setImageCache(retainedCache);
    setLightbox((current) => (
      current?.path && !activePaths.includes(current.path) ? null : current
    ));
    const loadScreenshots = () => {
      screenshotPaths.forEach((item) => {
        if (imageCacheRef.current[item.path]) {
          return;
        }
        const loadingCache = {
          ...imageCacheRef.current,
          [item.path]: { status: "loading" },
        };
        imageCacheRef.current = loadingCache;
        setImageCache(loadingCache);
        readEvidenceImage(item.path)
          .then((payload) => {
            if (cancelled) {
              return;
            }
            const nextCache = {
              ...imageCacheRef.current,
              [item.path]: payload?.success
                ? { status: "loaded", dataUrl: payload.dataUrl, mimeType: payload.mimeType }
                : { status: "error", error: payload?.message || payload?.error || "read-failed" },
            };
            imageCacheRef.current = nextCache;
            setImageCache(nextCache);
          })
          .catch((error) => {
            if (cancelled) {
              return;
            }
            const nextCache = {
              ...imageCacheRef.current,
              [item.path]: { status: "error", error: error?.message || "read-failed" },
            };
            imageCacheRef.current = nextCache;
            setImageCache(nextCache);
          });
      });
    };
    const idleId = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(loadScreenshots, { timeout: 800 })
      : window.setTimeout(loadScreenshots, 220);
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      } else {
        window.clearTimeout(idleId);
      }
    };
  }, [open, screenshotPaths]);

  useEffect(() => {
    if (!open) {
      setEvidenceExpanded(false);
    }
  }, [open]);

  const handleExportPdf = useCallback(async () => {
    if (!model || pdfExportState.status === "exporting") {
      return;
    }
    setPdfExportState({ status: "exporting", message: "" });
    try {
      const payload = await exportPdf({
        title: model.context.testFileName,
        testFileName: model.context.testFileName,
        testFilePath: model.context.testFilePath,
        status: model.status,
        html: buildReportPdfHtml(model),
      });
      if (payload?.success) {
        setPdfExportState({ status: "success", message: payload.path || "PDF exported." });
        window.setTimeout(() => {
          setPdfExportState((current) => (current.status === "success" ? { status: "idle", message: "" } : current));
        }, 3200);
        return;
      }
      if (payload?.canceled) {
        setPdfExportState({ status: "idle", message: "" });
        return;
      }
      setPdfExportState({
        status: "error",
        message: payload?.message || payload?.error || "PDF export failed.",
      });
    } catch (error) {
      setPdfExportState({ status: "error", message: error?.message || "PDF export failed." });
    }
  }, [model, pdfExportState.status]);

  if (!model) {
    return null;
  }

  const failed = model.status === "failed";
  const firstFailure = model.summary.firstFailure;
  const verdict = failed
    ? "Execution blocked"
    : model.status === "passed"
      ? "Execution accepted"
      : model.status === "stopped"
        ? "Execution stopped"
        : "Execution incomplete";
  const recommendation = failed
    ? "Fix the first blocking failure, then rerun the affected case before a full file rerun."
    : model.status === "passed"
      ? "Evidence is complete for this run. Review coverage before using it as release support."
      : "Complete the run to produce a release-ready report.";
  const stepTotal = model.summary.stepCounts.total || 0;
  const stepPassed = model.summary.stepCounts.passed || 0;
  const stepPassRate = stepTotal ? Math.round((stepPassed / stepTotal) * 100) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        overlayClassName={styles.reportOverlay}
        className={cn(styles.reportSheet, titlebarSafe && styles.reportSheetTitlebarSafe)}
      >
        <div className={styles.reportShell}>
          <div className={styles.reportScrollFrame}>
            <ScrollArea className={styles.reportScroll}>
              <article className={styles.reportDocument}>
                <SheetHeader className={styles.reportHeader}>
                  <div className={styles.reportMastheadTop}>
                    <div className={styles.reportBrand}>
                      <div className={styles.reportBrandMark}>
                        <img src={appIconUrl} alt="Vision E2E Showcase" />
                      </div>
                      <div>
                        <strong>Zhuzhu E2E Report</strong>
                        <span>Automated QA evidence package</span>
                      </div>
                    </div>
                    <div className={styles.reportHeaderActions}>
                      {pdfExportState.message ? (
                        <span className={styles.exportStatus} data-status={pdfExportState.status}>
                          {pdfExportState.message}
                        </span>
                      ) : null}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className={styles.exportButton}
                        disabled={pdfExportState.status === "exporting"}
                        onClick={handleExportPdf}
                      >
                        {pdfExportState.status === "exporting" ? <Loader2 className={styles.spinIcon} /> : <Download />}
                        Export PDF
                      </Button>
                      <Badge variant={statusVariant(model.status)} className={styles.statusBadge}>
                        {statusIcon(model.status)}
                        {statusLabel(model.status)}
                      </Badge>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label="Close report" onClick={() => onOpenChange?.(false)}>
                        <X />
                      </Button>
                    </div>
                  </div>
                  <div className={styles.reportIdentity}>
                    <div className={styles.reportEyebrow}>
                      <ShieldCheck />
                      QA Execution Report
                    </div>
                    <SheetTitle className={styles.reportTitle}>{model.context.testFileName}</SheetTitle>
                    <SheetDescription className={styles.reportDescription}>
                      {model.context.testFilePath || "Current test file"} · {formatDateTime(model.summary.finishedAt || model.summary.startedAt)}
                    </SheetDescription>
                  </div>
                </SheetHeader>

                <section id="run-report-summary" className={styles.heroSection} data-status={model.status}>
                <div className={styles.verdictBlock}>
                  <span>Professional QA Result</span>
                  <h2>{verdict}</h2>
                  <p>{recommendation}</p>
                  {firstFailure ? (
                    <div className={styles.blockingCallout}>
                      <AlertCircle />
                      <div>
                        <strong>{firstFailure.stepTitle || "First blocking step"}</strong>
                        <span>{firstFailure.message || "A runtime failure blocked this execution."}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className={styles.kpiGrid}>
                  <ReportKpi label="Pass rate" value={<NumberFlowValue value={model.summary.passRate} suffix="%" delay={EXECUTIVE_KPI_NUMBER_DELAYS.passRate} />} detail={<><NumberFlowValue value={model.summary.caseCounts.passed} delay={EXECUTIVE_KPI_NUMBER_DELAYS.casePassed} />/<NumberFlowValue value={model.summary.caseCounts.total || 0} delay={EXECUTIVE_KPI_NUMBER_DELAYS.caseTotal} /> cases passed</>} />
                  <ReportKpi label="Step pass rate" value={<NumberFlowValue value={stepPassRate} suffix="%" delay={EXECUTIVE_KPI_NUMBER_DELAYS.stepPassRate} />} detail={<><NumberFlowValue value={stepPassed} delay={EXECUTIVE_KPI_NUMBER_DELAYS.stepPassed} />/<NumberFlowValue value={stepTotal} delay={EXECUTIVE_KPI_NUMBER_DELAYS.stepTotal} /> steps passed</>} />
                  <ReportKpi label="Duration" value={<NumberFlowDuration className={styles.reportDurationValue} value={model.summary.durationMs} delay={EXECUTIVE_KPI_NUMBER_DELAYS.duration} />} detail={model.summary.browserUrl || model.context.baseUrl || "No browser URL"} tone="duration" />
                  <ReportKpi label="Failures" value={<NumberFlowValue value={model.failures.length} delay={EXECUTIVE_KPI_NUMBER_DELAYS.failures} />} detail={<><NumberFlowValue value={model.summary.stepCounts.failed} delay={EXECUTIVE_KPI_NUMBER_DELAYS.failedSteps} /> failed steps</>} danger={model.failures.length > 0} />
                </div>
                </section>

                <section className={styles.chartGrid} aria-label="Run report charts">
                <ChartPanel title="Case status" icon={Target} description="Per-case executable step outcome mix.">
                  <CaseStatusChart data={model.charts.caseStepStatus || []} />
                </ChartPanel>
                <ChartPanel title="Step status" icon={BarChart3} description="Executable step outcome mix.">
                  <StepStatusChart data={model.charts.stepStatus} />
                </ChartPanel>
                <ChartPanel title="Phase distribution" icon={Sparkles} description="Where the execution spent its checks." compact>
                  <SmallBarChart data={model.charts.phaseDistribution} valueKey="value" />
                </ChartPanel>
                <ChartPanel title="Slowest cases" icon={Clock3} description="Top case durations in this run." compact>
                  <DurationChart data={model.charts.caseDurations} />
                </ChartPanel>
                <ChartPanel title="Slowest steps" icon={Clock3} description="Highest single-step durations." compact>
                  <SlowestStepList data={model.charts.slowestSteps || []} />
                </ChartPanel>
                </section>

                <ReportSection id="coverage" title="Coverage" description="What this run exercised and what still needs attention." revealOnVisible>
                  <CoveragePanel
                    caseCounts={model.summary.caseCounts}
                    stepCounts={model.summary.stepCounts}
                    actionTypes={model.charts.actionTypes}
                    failureTypes={model.charts.failureTypes}
                  />
                </ReportSection>

                <ReportSection id="failures" title="Failure Analysis" description="First-order runtime failures with evidence shortcuts.">
                {model.failures.length ? (
                  <div className={styles.failureStack}>
                    {model.failures.map((failure, index) => (
                      <FailureCard
                        key={`${failure.caseId}-${failure.stepId}-${index}`}
                        failure={failure}
                        index={index}
                        imageCache={imageCache}
                        onPreview={setLightbox}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyReportLine icon={CheckCircle2} title="No failed steps" text="No runtime failure was found in this report model." />
                )}
                {firstFailure?.raw ? (
                  <div className={styles.stepDetailWrap}>
                    <StepExecutionDetail step={{ raw: firstFailure.raw }} tracePath={firstFailure.tracePath} compact />
                  </div>
                ) : null}
                </ReportSection>

                <ReportSection id="matrix" title="Case Matrix" description="Case-level outcome, priority, timing and first failure.">
                <div className={styles.matrixTable} role="table" aria-label="Case result matrix">
                  <div className={styles.matrixHeader} role="row">
                    <span>Status</span>
                    <span>Case</span>
                    <span>Priority</span>
                    <span>Steps</span>
                    <span>Duration</span>
                    <span>Failure</span>
                  </div>
                  {model.cases.map((caseItem) => (
                    <div key={caseItem.caseId} className={styles.matrixRow} role="row" data-status={caseItem.status}>
                      <span><Badge variant={statusVariant(caseItem.status)}>{statusLabel(caseItem.status)}</Badge></span>
                      <strong>{caseItem.caseName}</strong>
                      <span>{caseItem.priority}</span>
                      <span><NumberFlowValue value={caseItem.completedSteps} />/<NumberFlowValue value={caseItem.totalSteps} /></span>
                      <span><NumberFlowDuration value={caseItem.durationMs} /></span>
                      <span>{caseItem.error ? caseItem.error.message || caseItem.error.code || "Failed" : "-"}</span>
                    </div>
                  ))}
                </div>
                </ReportSection>

                <ReportSection id="evidence" title="Evidence" description="Report, run directory, trace and screenshot artifacts collected from the execution.">
                {model.evidence.length ? (
                  <>
                    <div className={styles.evidenceList}>
                      {model.evidence.slice(0, evidenceExpanded ? model.evidence.length : 4).map((item) => (
                        <button key={`${item.kind}-${item.value}`} type="button" onClick={() => copyTextToClipboard(item.value)}>
                          {item.kind === "run-dir" ? <FolderOpen /> : <FileJson />}
                          <span>
                            <strong>{item.label}</strong>
                            <small>{item.value}</small>
                          </span>
                          <Copy />
                        </button>
                      ))}
                    </div>
                    {model.evidence.length > 4 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className={styles.evidenceToggle}
                        onClick={() => setEvidenceExpanded((current) => !current)}
                      >
                        {evidenceExpanded ? "Show less" : `Show ${model.evidence.length - 4} more`}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <EmptyReportLine icon={FileJson} title="No artifact paths" text="This run did not expose report, trace, or screenshot paths." />
                )}
                </ReportSection>

                <ReportSection id="appendix" title="Technical Appendix" description="Raw runtime payload fragments for engineering review.">
                <details className={styles.rawDetails}>
                  <summary>Runtime result JSON</summary>
                  <pre>{safeJson(model.raw.result)}</pre>
                </details>
                <details className={styles.rawDetails}>
                  <summary>Report summary JSON</summary>
                  <pre>{safeJson(model.raw.summary || model.raw.report?.telemetry || {})}</pre>
                </details>
                </ReportSection>
              </article>
            </ScrollArea>
          </div>
        </div>

        {lightbox ? (
          <div className={styles.reportLightbox} role="dialog" aria-modal="true" aria-label={`${lightbox.label} screenshot`}>
            <div className={styles.reportLightboxBar}>
              <strong>{lightbox.label}</strong>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Close screenshot preview" onClick={() => setLightbox(null)}>
                <X />
              </Button>
            </div>
            <button type="button" className={styles.reportLightboxCanvas} onClick={() => setLightbox(null)}>
              <img src={lightbox.dataUrl} alt={`${lightbox.label} screenshot`} />
            </button>
            <span>{lightbox.path}</span>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ReportKpi({ label, value, detail, danger = false, tone = "" }) {
  return (
    <div className={styles.reportKpi} data-danger={danger} data-tone={tone || undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ChartPanel({ title, description, icon: Icon, children, compact = false }) {
  const [panelRef, visible] = useVisibleOnce({ activateDelay: 35, rootMargin: "0px 0px -4% 0px", threshold: 0.12 });
  return (
    <section ref={panelRef} className={styles.chartPanel} data-compact={compact} data-visible={visible}>
      <header>
        <div>
          {Icon ? <Icon /> : null}
          <strong>{title}</strong>
        </div>
        {description ? <span>{description}</span> : null}
      </header>
      <div className={styles.chartCanvas} data-visible={visible}>{children}</div>
    </section>
  );
}

function valueRankMap(items, getValue, getKey) {
  const ranked = items
    .map((item, index) => ({
      key: getKey(item, index),
      value: Number(getValue(item)) || 0,
    }))
    .sort((a, b) => a.value - b.value || a.key.localeCompare(b.key));
  return new Map(ranked.map((item, index) => [item.key, index]));
}

function CaseStatusChart({ data }) {
  if (!data.length) {
    return <EmptyChart text="No case status data" />;
  }
  const maxTotal = Math.max(...data.map((caseItem) => Number(caseItem.total) || 0), 0);
  const ranks = valueRankMap(
    data,
    (caseItem) => caseItem.total || caseItem.passed + caseItem.failed + caseItem.skipped + caseItem.pending || 0,
    (caseItem) => caseItem.caseId || caseItem.name,
  );
  return (
    <div className={styles.caseStepStatusChart}>
      <StatusBadgeLegend items={STATUS_META} />
      <div className={styles.caseStepColumnPlot} aria-label="Case step status stacked columns">
        {data.map((caseItem, rowIndex) => {
          const total = caseItem.total || caseItem.passed + caseItem.failed + caseItem.skipped + caseItem.pending || 0;
          const segments = STATUS_META.map(([status, label], index) => ({
            status,
            label,
            value: caseItem[status] || 0,
            delay: 80 + (ranks.get(caseItem.caseId || caseItem.name) || 0) * 70 + index * 24,
          }));
          const barHeight = maxTotal ? Math.max(8, (total / maxTotal) * 100) : 0;
          return (
            <div key={caseItem.caseId || caseItem.name} className={styles.caseStepColumn} data-status={caseItem.status}>
              <div className={styles.caseStepColumnValue}>
                <NumberFlowValue value={total} delay={90 + rowIndex * 58} />
              </div>
              <div className={styles.caseStepColumnBar} style={{ height: `${barHeight}%` }} aria-label={`${caseItem.name}: ${total} steps`}>
                <div>
                  {segments.map(({ status, label, value, delay }) => (
                    <i
                      key={status}
                      data-status={status}
                      style={{ height: total ? `${(value / total) * 100}%` : "0%", "--bar-delay": `${delay}ms` }}
                      title={`${caseItem.name} · ${label}: ${value}`}
                    />
                  ))}
                </div>
              </div>
              <span title={caseItem.caseName || caseItem.name}>{caseItem.name}</span>
            </div>
          );
        })}
      </div>
      <CaseAliasFootnotes data={data} />
    </div>
  );
}

function StepStatusChart({ data }) {
  const counts = data[0] || {};
  const total = counts.total || counts.passed + counts.failed + counts.skipped + counts.pending || 0;
  const statusCounts = [
    ["passed", "Passed", counts.passed || 0],
    ["failed", "Failed", counts.failed || 0],
    ["skipped", "Skipped", counts.skipped || 0],
    ["pending", "Pending", counts.pending || 0],
  ];
  if (!total) {
    return <EmptyChart text="No step status data" />;
  }
  const ranks = valueRankMap(statusCounts, (item) => item[2], (item) => item[0]);
  return (
    <div className={styles.statusChartLayout}>
      <div className={styles.statusTotalLine}>
        <strong><NumberFlowValue value={total} delay={STEP_STATUS_CHART_NUMBER_DELAYS.total} /></strong>
        <span>total executable steps</span>
      </div>
      <div className={styles.stepStackBar} aria-label={`${total} total steps`}>
        {statusCounts.map(([status, label, value], index) => (
          <span
            key={status}
            data-status={status}
            style={{ width: `${(value / total) * 100}%`, "--bar-delay": `${STEP_STATUS_CHART_NUMBER_DELAYS.barBase + (ranks.get(status) || 0) * 70 + index * 18}ms` }}
            title={`${label}: ${value}`}
          />
        ))}
      </div>
      <StatusBadgeLegend
        items={statusCounts}
        showCounts
        countDelay={STEP_STATUS_CHART_NUMBER_DELAYS.legendCount}
        countStagger={STEP_STATUS_CHART_NUMBER_DELAYS.legendStagger}
      />
    </div>
  );
}

function StatusBadgeLegend({ items, showCounts = false, countDelay = 130, countStagger = 42 }) {
  return (
    <div className={styles.statusBadgeLegend}>
      {items.map(([status, label, value], index) => (
        <span key={status} data-status={status}>
          <i />
          {label}
          {showCounts ? <strong><NumberFlowValue value={value || 0} delay={countDelay + index * countStagger} /></strong> : null}
        </span>
      ))}
    </div>
  );
}

function CaseAliasFootnotes({ data }) {
  const seen = new Set();
  const rows = data
    .map((caseItem) => ({
      id: caseItem.caseId || `${caseItem.caseLabel || caseItem.name}-${caseItem.caseName}`,
      label: caseItem.caseLabel || caseItem.name,
      name: caseItem.caseName || caseItem.name,
    }))
    .filter((caseItem) => {
      if (!caseItem.label || !caseItem.name || seen.has(`${caseItem.label}::${caseItem.name}`)) {
        return false;
      }
      seen.add(`${caseItem.label}::${caseItem.name}`);
      return true;
    });
  if (!rows.length) {
    return null;
  }
  return (
    <div className={styles.caseAliasFootnotes}>
      {rows.map((caseItem) => (
        <span key={caseItem.id}>
          <strong>{caseItem.label}</strong>
          <em>{caseItem.name}</em>
        </span>
      ))}
    </div>
  );
}

function SmallBarChart({ data, valueKey, danger = false }) {
  if (!data.length) {
    return <EmptyChart text="No chart data" />;
  }
  return <RankedBarList data={data} valueKey={valueKey} danger={danger} />;
}

function DurationChart({ data }) {
  if (!data.length) {
    return <EmptyChart text="No duration data" />;
  }
  return (
    <>
      <RankedBarList
      data={data}
      valueKey="durationMs"
      valueFormatter={formatDuration}
      valueRenderer={(value, delay) => <NumberFlowDuration value={value} delay={delay} />}
      maxItems={6}
      />
      <CaseAliasFootnotes data={data} />
    </>
  );
}

function SlowestStepList({ data }) {
  const rows = data.slice(0, 6);
  if (!rows.length) {
    return <EmptyChart text="No step duration data" />;
  }
  return (
    <>
      <div className={styles.slowestStepList}>
        {rows.map((step, index) => (
          <div key={`${step.caseId}-${step.name}-${index}`} className={styles.slowestStepRow} style={{ "--row-delay": `${70 + index * 58}ms` }}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong title={step.name}>{step.name}</strong>
            <small title={step.caseName}>{step.caseLabel}</small>
            <em><NumberFlowDuration value={step.durationMs} delay={150 + index * 58} /></em>
          </div>
        ))}
      </div>
      <CaseAliasFootnotes data={rows} />
    </>
  );
}

function RankedBarList({
  data,
  valueKey,
  danger = false,
  valueFormatter = (value) => value,
  valueRenderer = (value, delay) => <NumberFlowValue value={value} delay={delay} />,
  maxItems = 8,
}) {
  const rows = data.slice(0, maxItems);
  const maxValue = Math.max(...rows.map((item) => Number(item[valueKey]) || 0), 0);
  const ranks = valueRankMap(rows, (item) => item[valueKey], (item, index) => `${item.name}-${index}`);
  if (!maxValue) {
    return <EmptyChart text="No chart data" />;
  }
  return (
    <div className={styles.rankedBarList}>
      {rows.map((item, index) => {
        const value = Number(item[valueKey]) || 0;
        const delay = 80 + (ranks.get(`${item.name}-${index}`) || 0) * 58 + index * 14;
        return (
          <div key={`${item.name}-${value}`} className={styles.rankedBarRow}>
            <span className={styles.rankedLabel} title={item.caseName || item.name}>{item.name}</span>
            <div className={styles.rankedTrack} title={`${item.caseName || item.name}: ${valueFormatter(value)}`}>
              <i style={{ width: `${(value / maxValue) * 100}%`, "--bar-delay": `${delay}ms` }} data-danger={danger} />
            </div>
            <strong>{valueRenderer(value, delay + 140)}</strong>
          </div>
        );
      })}
    </div>
  );
}

function EmptyChart({ text }) {
  return (
    <div className={styles.emptyChart}>
      <BarChart3 />
      {text}
    </div>
  );
}

function ReportSection({ id, title, description, children, revealOnVisible = true }) {
  const [sectionRef, visible] = useVisibleOnce({ activateDelay: 30, rootMargin: "0px 0px -3% 0px", threshold: 0.08 });
  return (
    <section
      id={`run-report-${id}`}
      ref={revealOnVisible ? sectionRef : undefined}
      className={styles.reportSection}
      data-visible={revealOnVisible ? visible : undefined}
    >
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function CoveragePanel({ caseCounts, stepCounts, actionTypes, failureTypes }) {
  const actionTotal = actionTypes.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const failureTotal = failureTypes.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  return (
    <div className={styles.coveragePanel}>
      <div className={styles.coverageOverview}>
        <CoverageMeter label="Cases" detail="Case outcomes" counts={caseCounts} />
        <CoverageMeter label="Steps" detail="Executable checks" counts={stepCounts} strong />
      </div>
      <div className={styles.coverageBreakdown}>
        <CoverageRankSection
          title="Action coverage"
          description={<><NumberFlowValue value={actionTotal} delay={120} /> recorded actions</>}
          icon={BarChart3}
          data={actionTypes}
        />
        <CoverageRankSection
          title="Failure focus"
          description={failureTotal ? <><NumberFlowValue value={failureTotal} delay={160} /> failed action type{failureTotal === 1 ? "" : "s"}</> : "No failed action types"}
          icon={AlertCircle}
          data={failureTypes}
          danger
          emptyText="No failure types"
        />
      </div>
    </div>
  );
}

function CoverageMeter({ label, detail, counts, strong = false }) {
  const total = counts.total || 0;
  const segments = [
    ["passed", "Passed", counts.passed || 0],
    ["failed", "Failed", counts.failed || 0],
    ["skipped", "Skipped", counts.skipped || 0],
    ["pending", "Pending", counts.pending || 0],
  ];
  const complete = total ? Math.round(((counts.passed || 0) / total) * 100) : 0;
  const ranks = valueRankMap(segments, (item) => item[2], (item) => item[0]);
  const baseDelay = strong ? 170 : 80;
  return (
    <div className={styles.coverageMeter} data-strong={strong}>
      <div className={styles.coverageMeterHead}>
        <div>
          <span>{label}</span>
          <small>{detail}</small>
        </div>
        <strong><NumberFlowValue value={total} delay={Math.max(0, baseDelay - 40)} /></strong>
      </div>
      <div className={styles.coverageMeterBar}>
        {segments.map(([status, statusLabelText, value], index) => (
          <i
            key={status}
            data-status={status}
            style={{ width: total ? `${(value / total) * 100}%` : "0%", "--bar-delay": `${baseDelay + (ranks.get(status) || 0) * 48 + index * 14}ms` }}
            title={`${statusLabelText}: ${value}`}
          />
        ))}
      </div>
      <div className={styles.coverageMeterStats}>
        <small data-status="passed"><NumberFlowValue value={complete} suffix="%" delay={baseDelay} /> passed</small>
        {segments.map(([status, statusLabelText, value]) => (
          <small key={status} data-status={status}>{statusLabelText} <NumberFlowValue value={value} delay={baseDelay + (ranks.get(status) || 0) * 48} /></small>
        ))}
      </div>
    </div>
  );
}

function CoverageRankSection({ title, description, icon: Icon, data, danger = false, emptyText = "No chart data" }) {
  return (
    <section className={styles.coverageRankSection} data-danger={danger}>
      <header>
        <div>
          {Icon ? <Icon /> : null}
          <strong>{title}</strong>
        </div>
        <span>{description}</span>
      </header>
      <CoverageRankList data={data} danger={danger} emptyText={emptyText} />
    </section>
  );
}

function CoverageRankList({ data, danger = false, emptyText }) {
  const rows = data.slice(0, 6);
  const maxValue = Math.max(...rows.map((item) => Number(item.value) || 0), 0);
  const ranks = valueRankMap(rows, (item) => item.value, (item, index) => `${item.name}-${index}`);
  if (!rows.length || !maxValue) {
    return (
      <div className={styles.coverageEmpty}>
        <span>{emptyText}</span>
      </div>
    );
  }
  return (
    <div className={styles.coverageRankList}>
      {rows.map((item, index) => {
        const value = Number(item.value) || 0;
        const delay = 90 + (ranks.get(`${item.name}-${index}`) || 0) * 55 + index * 14;
        return (
          <div key={`${item.name}-${value}`} className={styles.coverageRankRow} style={{ "--row-delay": `${40 + index * 36}ms` }}>
            <span className={styles.coverageRankIndex}>{String(index + 1).padStart(2, "0")}</span>
            <span className={styles.coverageRankName} title={item.name}>{item.name}</span>
            <div className={styles.coverageRankTrack} title={`${item.name}: ${value}`}>
              <i style={{ width: `${(value / maxValue) * 100}%`, "--bar-delay": `${delay}ms` }} data-danger={danger} />
            </div>
            <strong><NumberFlowValue value={value} delay={delay + 120} /></strong>
          </div>
        );
      })}
    </div>
  );
}

function FailureCard({ failure, index, imageCache, onPreview }) {
  const [expanded, setExpanded] = useState(false);
  const shots = [
    { label: "Before", path: failure.beforeScreenshotPath },
    { label: "After", path: failure.afterScreenshotPath },
  ].filter((item) => item.path);
  return (
    <article className={styles.failureCard}>
      <header>
        <Badge variant="danger">Failure <NumberFlowValue value={index + 1} /></Badge>
        <strong>{failure.caseName}</strong>
        <span>{failure.phase} · {failure.actionType}</span>
      </header>
      <div className={styles.failureSummary}>
        <div>
          <h4>{failure.stepTitle}</h4>
          <p>{failure.message}</p>
        </div>
        <div className={styles.failureActions}>
          {failure.tracePath ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => copyTextToClipboard(failure.tracePath)}>
              <Copy data-icon="inline-start" />
              Copy trace
            </Button>
          ) : null}
          {shots.length ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setExpanded((current) => !current)}>
              {expanded ? "Hide evidence" : "Show evidence"}
            </Button>
          ) : null}
        </div>
      </div>
      {shots.length && expanded ? (
        <div className={styles.shotGrid}>
          {shots.map((shot) => (
            <EvidenceShot key={shot.path} item={shot} image={imageCache[shot.path]} onPreview={onPreview} />
          ))}
        </div>
      ) : shots.length ? (
        <div className={styles.shotSummary}>
          {shots.map((shot) => (
            <span key={shot.path}>{shot.label}</span>
          ))}
          <small>{shots.length} screenshots available</small>
        </div>
      ) : null}
    </article>
  );
}

function EvidenceShot({ item, image, onPreview }) {
  const ready = image?.status === "loaded" && image.dataUrl;
  const loading = !image || image.status === "loading";
  return (
    <button
      type="button"
      className={styles.evidenceShot}
      disabled={!ready}
      onClick={() => onPreview?.({ label: item.label, path: item.path, dataUrl: image.dataUrl })}
    >
      <span>{item.label}</span>
      {ready ? <img src={image.dataUrl} alt={`${item.label} screenshot`} /> : (
        <small>
          {loading ? <Loader2 /> : <ImageOff />}
          {loading ? "Loading" : image?.error || "Unavailable"}
        </small>
      )}
    </button>
  );
}

function EmptyReportLine({ icon: Icon, title, text }) {
  return (
    <div className={styles.emptyReportLine}>
      <Icon />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

export {
  PROFESSIONAL_REPORT_MODES,
  ProfessionalRunReportPage,
  ProfessionalRunReportView,
} from "./ProfessionalRunReportView";
