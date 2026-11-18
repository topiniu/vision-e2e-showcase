const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createRunMarkdownReport, createRunSummary } = require("./run-feedback");

function formatStamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

class ArtifactStore {
  static async create({
    outputDir = path.join(process.cwd(), "output", "runs"),
    runId = null,
  } = {}) {
    const root = path.resolve(
      outputDir || path.join(process.cwd(), "output", "runs"),
    );
    const finalRunId = runId || randomUUID().slice(0, 8);
    const runDir = path.join(root, `${formatStamp()}-${finalRunId}`);
    const stepsDir = path.join(runDir, "steps");
    await fs.mkdir(stepsDir, { recursive: true });
    return new ArtifactStore({ root, runDir, stepsDir, runId: finalRunId });
  }

  constructor({ root, runDir, stepsDir, runId }) {
    this.root = root;
    this.runDir = runDir;
    this.stepsDir = stepsDir;
    this.runId = runId;
    this.stepArtifacts = [];
    // v1.10 Z27-5: masks secret values in every JSON this store writes.
    this.redactor = null;
  }

  setRedactor(redactor) {
    this.redactor = redactor && redactor.active ? redactor : null;
  }

  redact(data) {
    return this.redactor ? this.redactor.redact(data) : data;
  }

  buildStepName(index, suffix, ext) {
    return path.join(
      this.stepsDir,
      `${String(index + 1).padStart(2, "0")}-${suffix}.${ext}`,
    );
  }

  async saveScreenshot(index, suffix, buffer) {
    if (!buffer) {
      return null;
    }
    const filePath = this.buildStepName(index, suffix, "png");
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async saveJson(index, suffix, data) {
    const filePath = this.buildStepName(index, suffix, "json");
    await fs.writeFile(filePath, JSON.stringify(this.redact(data), null, 2));
    return filePath;
  }

  recordStep(index, artifacts) {
    this.stepArtifacts[index] = artifacts;
  }

  // v1.5: run-level (not step-level) artifacts, e.g. `diagnostics/page-errors.json`
  // (Z-A), `environment/fingerprint.json` (Z-B), `artifacts/downloads/*` (Z-C).
  // Returns the absolute path so it can be linked from summary/evidence-bundle.
  async saveRunFile(relativePath, buffer) {
    const filePath = path.join(this.runDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async saveRunJson(relativePath, data) {
    return this.saveRunFile(relativePath, JSON.stringify(this.redact(data), null, 2));
  }

  async writeReport(report) {
    const reportPath = path.join(this.runDir, "report.json");
    await fs.writeFile(reportPath, JSON.stringify(this.redact(report), null, 2));
    return reportPath;
  }

  async writeRunFeedback(report) {
    const reportPath = await this.writeReport(report);
    const summary = createRunSummary(this.redact(report), reportPath);
    const summaryPath = path.join(this.runDir, "summary.json");
    const markdownReportPath = path.join(this.runDir, "report.md");
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    await fs.writeFile(markdownReportPath, createRunMarkdownReport(summary));
    return {
      reportPath,
      summaryPath,
      markdownReportPath,
      summary,
    };
  }
}

module.exports = {
  ArtifactStore,
};
