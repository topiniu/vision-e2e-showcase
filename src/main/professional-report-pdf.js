const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const PAGE = {
  size: "A4",
  width: 595.28,
  height: 841.89,
  margin: 42,
};

const COLORS = {
  ink: "#18231d",
  soft: "#5e6a61",
  faint: "#e7ebe5",
  line: "#d6ddd4",
  success: "#24724c",
  danger: "#b33a32",
  warning: "#b77719",
  pending: "#cbd3c3",
  dark: "#273349",
};

const STATUS_COLORS = {
  passed: COLORS.success,
  failed: COLORS.danger,
  skipped: COLORS.warning,
  pending: COLORS.pending,
};

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
];

function pickFontPath() {
  return FONT_CANDIDATES.find((item) => fs.existsSync(item)) || null;
}

function safeText(value, fallback = "-") {
  if (value == null) return fallback;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || fallback;
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function pct(part, total) {
  const denominator = number(total);
  return denominator > 0 ? Math.round((number(part) / denominator) * 100) : 0;
}

function formatDateTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(numeric));
}

function formatDuration(ms) {
  const numeric = number(ms);
  if (numeric < 1000) return `${Math.round(numeric)} ms`;
  const seconds = Math.round(numeric / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function createPdfContext(outputPath) {
  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: "Zhuzhu E2E Report",
      Creator: "Zhuzhu PDFKit report exporter",
      Producer: "PDFKit",
    },
  });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  const fontPath = pickFontPath();
  if (fontPath) {
    doc.registerFont("Report", fontPath);
    doc.registerFont("ReportBold", fontPath);
    doc.font("Report");
  } else {
    doc.font("Helvetica");
  }
  return { doc, stream };
}

function contentWidth() {
  return PAGE.width - PAGE.margin * 2;
}

function ensureSpace(doc, height) {
  if (doc.y + height <= PAGE.height - PAGE.margin) return;
  doc.addPage();
  doc.y = PAGE.margin;
}

function sectionTitle(doc, title, subtitle = "") {
  ensureSpace(doc, subtitle ? 58 : 38);
  doc.moveDown(0.8);
  doc.fillColor(COLORS.ink).fontSize(15).font("ReportBold").text(title, PAGE.margin, doc.y);
  if (subtitle) {
    doc.moveDown(0.25);
    doc.fillColor(COLORS.soft).fontSize(9.5).font("Report").text(subtitle, PAGE.margin, doc.y, { width: contentWidth() });
  }
  doc.moveDown(0.6);
  doc.strokeColor(COLORS.line).lineWidth(0.7).moveTo(PAGE.margin, doc.y).lineTo(PAGE.width - PAGE.margin, doc.y).stroke();
  doc.moveDown(0.7);
}

function labelValue(doc, label, value, x, y, width) {
  doc.fillColor(COLORS.soft).font("ReportBold").fontSize(7.8).text(label.toUpperCase(), x, y, { width });
  doc.fillColor(COLORS.ink).font("ReportBold").fontSize(11).text(safeText(value), x, y + 14, { width, ellipsis: true });
}

function drawHeader(doc, model) {
  const startY = doc.y;
  doc.roundedRect(PAGE.margin, startY, 26, 26, 5).fill(COLORS.dark);
  doc.fillColor("#ffffff").font("ReportBold").fontSize(12).text("ZZ", PAGE.margin + 6, startY + 8);
  doc.fillColor(COLORS.ink).font("ReportBold").fontSize(10).text("ZHUZHU E2E REPORT", PAGE.margin + 36, startY + 2);
  doc.fillColor(COLORS.soft).font("Report").fontSize(9).text("Automated QA evidence package", PAGE.margin + 36, startY + 16);
  doc.y = startY + 48;

  doc.fillColor(COLORS.soft).font("ReportBold").fontSize(9).text("QA EVIDENCE REPORT", PAGE.margin, doc.y);
  doc.moveDown(0.35);
  doc.fillColor(COLORS.ink).font("ReportBold").fontSize(20).text(safeText(model?.context?.testFileName || model?.context?.testFilePath || "Run report"), {
    width: contentWidth(),
    lineGap: 2,
  });
  doc.moveDown(0.6);

  const boxY = doc.y;
  const half = contentWidth() / 2;
  doc.strokeColor(COLORS.faint).lineWidth(0.8).rect(PAGE.margin, boxY, contentWidth(), 74).stroke();
  doc.moveTo(PAGE.margin + half, boxY).lineTo(PAGE.margin + half, boxY + 74).stroke();
  const started = model?.summary?.startedAt;
  const finished = model?.summary?.finishedAt;
  labelValue(doc, "Execution window", `${formatDateTime(started)} - ${formatDateTime(finished)}`, PAGE.margin + 10, boxY + 10, half - 20);
  labelValue(doc, "Scenarios", model?.summary?.caseCounts?.total || 0, PAGE.margin + half + 10, boxY + 10, 120);
  labelValue(doc, "Checks", model?.summary?.stepCounts?.total || 0, PAGE.margin + 10, boxY + 43, half - 20);
  labelValue(doc, "Evidence", `${model?.evidence?.length || 0} items`, PAGE.margin + half + 10, boxY + 43, 120);
  doc.y = boxY + 92;
}

function verdictFor(model) {
  if (model?.status === "failed") {
    return {
      label: "Do not release",
      tone: COLORS.danger,
      recommendation: "Fix the first blocking failure, rerun the affected case, then use a clean file run for release evidence.",
    };
  }
  if (model?.status === "passed") {
    return {
      label: "Release support",
      tone: COLORS.success,
      recommendation: "This run can support release after QA confirms the covered cases match the intended change scope.",
    };
  }
  return {
    label: "Needs review",
    tone: COLORS.warning,
    recommendation: "Complete or rerun the execution before using it as release evidence.",
  };
}

function drawDecision(doc, model) {
  const verdict = verdictFor(model);
  ensureSpace(doc, 148);
  const y = doc.y;
  doc.rect(PAGE.margin, y, 4, 132).fill(verdict.tone);
  doc.fillColor(COLORS.ink).font("ReportBold").fontSize(9).text("DECISION SUMMARY", PAGE.margin + 14, y);
  doc.fillColor(COLORS.ink).font("ReportBold").fontSize(28).text(verdict.label, PAGE.margin + 14, y + 18, { width: contentWidth() - 14 });
  doc.fillColor(COLORS.soft).font("Report").fontSize(10.5).text(verdict.recommendation, PAGE.margin + 14, y + 56, { width: contentWidth() - 14 });
  const firstFailure = model?.summary?.firstFailure;
  const rows = [
    ["Blocking issue", firstFailure ? safeText(firstFailure.caseName || firstFailure.stepTitle) : "No blocking issue in this execution"],
    ["Coverage summary", `${model?.summary?.caseCounts?.total || 0} business scenarios and ${model?.summary?.stepCounts?.total || 0} executable checks were included.`],
    ["Release note", model?.status === "passed" ? "Review business scope before publishing." : "Rerun required before release evidence can be trusted."],
  ];
  let rowY = y + 82;
  rows.forEach(([label, value]) => {
    doc.strokeColor(COLORS.faint).moveTo(PAGE.margin + 14, rowY - 4).lineTo(PAGE.width - PAGE.margin, rowY - 4).stroke();
    doc.fillColor(COLORS.soft).font("Report").fontSize(8.5).text(label, PAGE.margin + 14, rowY);
    doc.fillColor(COLORS.ink).font("ReportBold").fontSize(9.5).text(value, PAGE.margin + 118, rowY, { width: contentWidth() - 118, ellipsis: true });
    rowY += 17;
  });
  doc.y = y + 146;
}

function statusItems(counts = {}) {
  return [
    ["passed", "Passed", counts.passed || 0],
    ["failed", "Failed", counts.failed || 0],
    ["skipped", "Skipped", counts.skipped || 0],
    ["pending", "Pending", counts.pending || 0],
  ].filter((item) => item[2] > 0);
}

function drawStatusBars(doc, title, counts, x, y, width) {
  const total = number(counts?.total);
  doc.fillColor(COLORS.ink).font("ReportBold").fontSize(11).text(title, x, y, { width });
  doc.fillColor(COLORS.soft).font("Report").fontSize(9).text(`${pct(counts?.passed, total)}%`, x, y + 18);
  let barY = y + 42;
  statusItems(counts).forEach(([key, label, value]) => {
    const color = STATUS_COLORS[key] || COLORS.soft;
    doc.circle(x + 3, barY + 4, 3).fill(color);
    doc.fillColor(COLORS.ink).font("ReportBold").fontSize(8.8).text(label, x + 12, barY, { width: 70 });
    const trackX = x + 86;
    const trackWidth = width - 116;
    doc.roundedRect(trackX, barY + 2, trackWidth, 6, 3).fill(COLORS.faint);
    doc.roundedRect(trackX, barY + 2, Math.max(3, trackWidth * (number(value) / Math.max(total, 1))), 6, 3).fill(color);
    doc.fillColor(COLORS.ink).font("ReportBold").fontSize(8.8).text(String(value), x + width - 24, barY, { width: 24, align: "right" });
    barY += 18;
  });
  doc.fillColor(COLORS.soft).font("Report").fontSize(8.5).text(statusItems(counts).map(([, label, value]) => `${label} ${value}`).join(" / ") || "No data", x, barY + 3, { width });
  return barY + 24;
}

function drawCoverageSnapshot(doc, model) {
  ensureSpace(doc, 148);
  sectionTitle(doc, "Coverage Snapshot");
  const y = doc.y;
  const col = (contentWidth() - 22) / 2;
  const endA = drawStatusBars(doc, "Cases", model?.summary?.caseCounts || {}, PAGE.margin, y, col);
  const endB = drawStatusBars(doc, "Steps", model?.summary?.stepCounts || {}, PAGE.margin + col + 22, y, col);
  doc.y = Math.max(endA, endB) + 6;
}

function drawRiskRegister(doc, model) {
  ensureSpace(doc, 112);
  sectionTitle(doc, "Risk Register");
  const risks = [];
  if (number(model?.summary?.caseCounts?.failed)) risks.push(["Release-blocking issue", `${model.summary.caseCounts.failed} failed scenario(s) must be resolved.`]);
  if (number(model?.summary?.stepCounts?.failed)) risks.push(["Failed steps", `${model.summary.stepCounts.failed} failed executable check(s).`]);
  if (number(model?.summary?.stepCounts?.pending)) risks.push(["Pending steps", `${model.summary.stepCounts.pending} steps remain without terminal status.`]);
  if (!risks.length) risks.push(["No blocking risk flagged", "Review coverage fit before making the final release call."]);
  risks.forEach(([title, body]) => {
    ensureSpace(doc, 34);
    const y = doc.y;
    doc.rect(PAGE.margin, y + 2, 3, 24).fill(title.includes("No blocking") ? COLORS.success : COLORS.danger);
    doc.fillColor(COLORS.ink).font("ReportBold").fontSize(10).text(title, PAGE.margin + 12, y);
    doc.fillColor(COLORS.soft).font("Report").fontSize(9).text(body, PAGE.margin + 12, y + 14, { width: contentWidth() - 12 });
    doc.y = y + 36;
  });
}

function countBy(items, getter) {
  const map = new Map();
  items.forEach((item) => {
    const key = safeText(getter(item), "unknown");
    map.set(key, (map.get(key) || 0) + 1);
  });
  return Array.from(map, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

function drawHorizontalChart(doc, title, subtitle, data) {
  const rows = (data || []).slice(0, 8);
  ensureSpace(doc, 56 + rows.length * 18);
  sectionTitle(doc, title, subtitle);
  const max = Math.max(...rows.map((item) => number(item.value)), 1);
  rows.forEach((item) => {
    const y = doc.y;
    doc.fillColor(COLORS.soft).font("Report").fontSize(8.5).text(safeText(item.name), PAGE.margin, y, { width: 118, ellipsis: true });
    const x = PAGE.margin + 128;
    const w = contentWidth() - 168;
    doc.roundedRect(x, y + 2, w, 7, 3.5).fill(COLORS.faint);
    doc.roundedRect(x, y + 2, Math.max(3, w * (number(item.value) / max)), 7, 3.5).fill(COLORS.success);
    doc.fillColor(COLORS.ink).font("ReportBold").fontSize(8.5).text(String(item.value), PAGE.width - PAGE.margin - 34, y, { width: 34, align: "right" });
    doc.y += 18;
  });
  doc.moveDown(0.5);
}

function drawLineChart(doc, title, subtitle, data) {
  const rows = (data || []).slice(0, 10);
  ensureSpace(doc, 160);
  sectionTitle(doc, title, subtitle);
  const x = PAGE.margin + 20;
  const y = doc.y;
  const w = contentWidth() - 40;
  const h = 104;
  doc.strokeColor(COLORS.faint).rect(x, y, w, h).stroke();
  if (rows.length) {
    const maxDuration = Math.max(...rows.map((item) => number(item.durationSeconds)), 1);
    const maxSteps = Math.max(...rows.map((item) => number(item.steps)), 1);
    const drawSeries = (key, max, color) => {
      doc.strokeColor(color).lineWidth(2);
      rows.forEach((item, index) => {
        const px = rows.length > 1 ? x + 12 + index * ((w - 24) / (rows.length - 1)) : x + w / 2;
        const py = y + h - 14 - (number(item[key]) / max) * (h - 28);
        if (index === 0) doc.moveTo(px, py);
        else doc.lineTo(px, py);
      });
      doc.stroke();
    };
    drawSeries("durationSeconds", maxDuration, COLORS.success);
    drawSeries("steps", maxSteps, COLORS.warning);
    rows.forEach((_, index) => {
      const px = rows.length > 1 ? x + 12 + index * ((w - 24) / (rows.length - 1)) : x + w / 2;
      doc.fillColor(COLORS.soft).font("Report").fontSize(7.5).text(String(index + 1), px - 3, y + h + 4, { width: 12, align: "center" });
    });
  }
  doc.y = y + h + 24;
}

function drawFailureDiagnosis(doc, model) {
  const failure = model?.summary?.firstFailure || model?.failures?.[0];
  if (!failure) return;
  ensureSpace(doc, 130);
  sectionTitle(doc, "Failure Diagnosis", "First blocking issue and recommended next action.");
  const rows = [
    ["Case", failure.caseName],
    ["Stage", `${failure.phase || "-"} / ${failure.actionType || failure.type || "-"}`],
    ["Step", failure.stepTitle || failure.name],
    ["Actual", Array.isArray(failure.actual) ? failure.actual.join(", ") : failure.actual],
    ["Suggested fix", "Confirm the target is visible in the intended page state and tighten the target scope before rerunning."],
  ];
  rows.forEach(([label, value]) => {
    ensureSpace(doc, 22);
    const y = doc.y;
    doc.fillColor(COLORS.soft).font("Report").fontSize(8.5).text(label, PAGE.margin, y, { width: 86 });
    doc.fillColor(COLORS.ink).font("ReportBold").fontSize(9).text(safeText(value), PAGE.margin + 96, y, { width: contentWidth() - 96, ellipsis: true });
    doc.y += 22;
  });
}

function drawCaseMatrix(doc, model) {
  const cases = (model?.cases || []).filter((item) => !item.isRoot).slice(0, 18);
  if (!cases.length) return;
  ensureSpace(doc, 80);
  sectionTitle(doc, "Case Matrix", "Formal execution table for QA review and handoff.");
  const cols = [34, 220, 70, 70, 80];
  const headers = ["#", "Case", "Status", "Steps", "Duration"];
  let x = PAGE.margin;
  doc.fillColor(COLORS.soft).font("ReportBold").fontSize(8).text(headers[0], x, doc.y, { width: cols[0] });
  for (let i = 1; i < headers.length; i += 1) {
    x += cols[i - 1];
    doc.text(headers[i], x, doc.y, { width: cols[i] });
  }
  doc.y += 18;
  cases.forEach((item, index) => {
    ensureSpace(doc, 30);
    const y = doc.y;
    x = PAGE.margin;
    const values = [
      String(index + 1),
      safeText(item.caseName || item.name),
      safeText(item.status),
      `${number(item.completedSteps)}/${number(item.totalSteps || item.steps?.length)}`,
      formatDuration(item.durationMs),
    ];
    doc.strokeColor(COLORS.faint).moveTo(PAGE.margin, y - 4).lineTo(PAGE.width - PAGE.margin, y - 4).stroke();
    values.forEach((value, colIndex) => {
      doc.fillColor(colIndex === 2 && value === "failed" ? COLORS.danger : COLORS.ink)
        .font(colIndex === 1 ? "ReportBold" : "Report")
        .fontSize(8.5)
        .text(value, x, y, { width: cols[colIndex], ellipsis: true });
      x += cols[colIndex];
    });
    doc.y = y + 24;
  });
}

function drawEvidence(doc, model) {
  const evidence = (model?.evidence || []).slice(0, 14);
  ensureSpace(doc, 70);
  sectionTitle(doc, "Evidence Index", "Raw local paths are kept for replay and audit.");
  if (!evidence.length) {
    doc.fillColor(COLORS.soft).font("Report").fontSize(9).text("No evidence paths recorded.", PAGE.margin, doc.y);
    doc.moveDown();
    return;
  }
  evidence.forEach((item, index) => {
    ensureSpace(doc, 24);
    const label = safeText(item.label || item.kind || `Evidence ${index + 1}`);
    const value = safeText(item.value || item.path || item.reportPath);
    doc.fillColor(COLORS.ink).font("ReportBold").fontSize(8.5).text(label, PAGE.margin, doc.y, { width: 128, ellipsis: true });
    doc.fillColor(COLORS.soft).font("Report").fontSize(7.5).text(value, PAGE.margin + 136, doc.y, { width: contentWidth() - 136, ellipsis: true });
    doc.y += 20;
  });
}

function drawCharts(doc, model) {
  const steps = (model?.cases || []).flatMap((item) => item.steps || []);
  const phaseData = model?.charts?.phaseDistribution || countBy(steps, (step) => step.phase);
  const actionData = model?.charts?.actionTypes || countBy(steps, (step) => step.type);
  drawHorizontalChart(doc, "Phase Distribution", "Where executable steps were concentrated.", phaseData);
  drawHorizontalChart(doc, "Action Coverage", "Action type distribution across executed steps.", actionData);
  drawLineChart(doc, "Case Duration Profile", "Duration by case with step volume context.", model?.charts?.caseDurations || []);
}

function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.fillColor(COLORS.soft).font("Report").fontSize(7.5).text(`Page ${i + 1} / ${range.count}`, PAGE.margin, PAGE.height - 28, {
      width: contentWidth(),
      align: "right",
    });
  }
}

function writeProfessionalReportPdf(outputPath, model) {
  return new Promise((resolve, reject) => {
    const { doc, stream } = createPdfContext(outputPath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    try {
      drawHeader(doc, model || {});
      drawDecision(doc, model || {});
      drawCoverageSnapshot(doc, model || {});
      drawRiskRegister(doc, model || {});
      drawFailureDiagnosis(doc, model || {});
      drawCharts(doc, model || {});
      drawCaseMatrix(doc, model || {});
      drawEvidence(doc, model || {});
      addPageNumbers(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  writeProfessionalReportPdf,
};
