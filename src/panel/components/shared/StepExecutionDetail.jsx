import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Braces, CheckCircle2, ClipboardCopy, FileJson, Loader2, Network } from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@panel/components/ui/alert";
import { readEvidenceJson } from "@panel/lib/panel-api";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import { createStepExecutionDetail, previewValue, safeJson } from "@panel/lib/step-execution-detail.mjs";
import styles from "./StepExecutionDetail.module.css";

function statusVariant(status) {
  switch (status) {
    case "passed":
    case "ok":
    case "success":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "running";
    case "skipped":
    case "stopped":
      return "neutral";
    default:
      return "neutral";
  }
}

function DetailRow({ row, copyable = false }) {
  const hasJsonValue = row.json && row.rawValue != null;
  const copyValue = hasJsonValue ? safeJson(row.rawValue) : row.value;
  return (
    <div className={styles.detailRow} data-danger={row.danger ? "true" : "false"}>
      <span>{row.label}</span>
      {hasJsonValue ? (
        <div className={styles.inlineJsonCell}>
          <JsonReader title={row.label} value={row.rawValue} />
        </div>
      ) : (
        <strong className={row.code ? styles.codeValue : undefined} title={typeof row.value === "string" ? row.value : ""}>
          {row.value}
        </strong>
      )}
      {copyable ? (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Copy ${row.label}`} onClick={() => copyTextToClipboard(copyValue)}>
          <ClipboardCopy />
        </Button>
      ) : null}
    </div>
  );
}

function DetailSection({ title, rows, children }) {
  if ((!rows || rows.length === 0) && !children) {
    return null;
  }
  return (
    <section className={styles.section}>
      <h4>{title}</h4>
      {rows?.length ? (
        <div className={styles.rows}>
          {rows.map((row) => (
            <DetailRow key={`${title}-${row.label}`} row={row} copyable={title === "Artifacts"} />
          ))}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function JsonPreview({ label, value }) {
  if (value == null || value === "") {
    return null;
  }
  return <JsonReader title={label} value={value} />;
}

function isJsonBranch(value) {
  return value && typeof value === "object";
}

function jsonSummary(value) {
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (value && typeof value === "object") {
    return `Object(${Object.keys(value).length})`;
  }
  if (typeof value === "string") {
    return `"${value}"`;
  }
  return String(value);
}

function primitiveClass(value) {
  if (value == null) {
    return styles.jsonNull;
  }
  if (typeof value === "number") {
    return styles.jsonNumber;
  }
  if (typeof value === "boolean") {
    return styles.jsonBoolean;
  }
  return styles.jsonString;
}

function JsonTreeNode({ name, value, depth = 0 }) {
  if (!isJsonBranch(value)) {
    return (
      <div className={styles.jsonLine} style={{ "--depth": depth }}>
        {name != null ? <span className={styles.jsonKey}>{name}</span> : null}
        <span className={primitiveClass(value)}>{value == null ? "null" : safeJson(value)}</span>
      </div>
    );
  }

  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  const defaultOpen = depth < 2 && entries.length <= 24;

  return (
    <details className={styles.jsonBranch} style={{ "--depth": depth }} open={defaultOpen}>
      <summary>
        {name != null ? <span className={styles.jsonKey}>{name}</span> : null}
        <span>{jsonSummary(value)}</span>
      </summary>
      <div className={styles.jsonChildren}>
        {entries.length ? (
          entries.map(([childName, childValue]) => (
            <JsonTreeNode key={`${depth}-${childName}`} name={childName} value={childValue} depth={depth + 1} />
          ))
        ) : (
          <div className={styles.jsonLine} style={{ "--depth": depth + 1 }}>
            <span className={styles.jsonEmpty}>empty</span>
          </div>
        )}
      </div>
    </details>
  );
}

function JsonReader({ title, value, defaultOpen = false }) {
  if (value == null || value === "") {
    return null;
  }
  return (
    <details className={styles.jsonReader} open={defaultOpen}>
      <summary>
        <span>
          <Braces />
          {title}
        </span>
        <small>{jsonSummary(value)}</small>
      </summary>
      <div className={styles.jsonTree}>
        <JsonTreeNode value={value} />
      </div>
      <details className={styles.rawInline}>
        <summary>Raw JSON</summary>
        <pre>{previewValue(value, 12000)}</pre>
      </details>
    </details>
  );
}

function getJsonPathValue(source, field) {
  if (!field || source == null) {
    return undefined;
  }
  const normalized = String(field)
    .replace(/^body\./, "")
    .replace(/\[(\d+)\]/g, ".$1");
  return normalized.split(".").filter(Boolean).reduce((current, part) => current?.[part], source);
}

function getEffectiveExpectation(expectation) {
  return expectation?.failedChild || expectation || null;
}

function ApiSummaryRow({ label, value, copyable = false }) {
  if (value == null || value === "") {
    return null;
  }
  return (
    <div className={styles.apiSummaryRow}>
      <span>{label}</span>
      <strong>{String(value)}</strong>
      {copyable ? (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Copy ${label}`} onClick={() => copyTextToClipboard(value)}>
          <ClipboardCopy />
        </Button>
      ) : null}
    </div>
  );
}

function AssertionFailures({ expectation, responseBody }) {
  const effective = getEffectiveExpectation(expectation);
  const failures = Array.isArray(effective?.failures) ? effective.failures : [];
  if (!failures.length) {
    return null;
  }
  return (
    <div className={styles.failurePanel}>
      <div className={styles.failurePanelHeader}>
        <AlertCircle />
        <span>Failed response checks</span>
      </div>
      {failures.map((failure, index) => {
        const actual = failure.actual ?? getJsonPathValue(responseBody, failure.field || failure.path);
        return (
          <div className={styles.failureItem} key={`${failure.field || failure.path || "failure"}-${index}`}>
            <code>{failure.field || failure.path || "response"}</code>
            <div>
              <span>expected</span>
              <strong>{safeJson(failure.expected)}</strong>
            </div>
            <div>
              <span>actual</span>
              <strong>{actual === undefined ? "not found" : safeJson(actual)}</strong>
            </div>
            <Badge variant="danger">{failure.operator || "failed"}</Badge>
          </div>
        );
      })}
    </div>
  );
}

function ApiNetworkViewer({ detail }) {
  const request = detail.action.request;
  const response = detail.action.response || detail.expectation?.response;
  const responseStatus = response?.status == null || response?.status === "" ? null : Number(response.status);
  const responseVariant = responseStatus == null ? "neutral" : responseStatus >= 400 ? "danger" : "success";
  if (!request && !response) {
    return null;
  }

  return (
    <section className={styles.section}>
      <h4 className={styles.sectionTitleWithIcon}>
        <Network />
        API / Network
      </h4>
      <AssertionFailures expectation={detail.expectation} responseBody={response?.body} />
      <div className={styles.exchangeGrid}>
        {request ? (
          <div className={styles.exchangePanel}>
            <div className={styles.exchangeHeader}>
              <span>Request</span>
              <Badge variant="neutral">{request.method || "HTTP"}</Badge>
            </div>
            <div className={styles.apiSummary}>
              <ApiSummaryRow label="URL" value={request.url} copyable />
              <ApiSummaryRow label="Input URL" value={request.inputUrl && request.inputUrl !== request.url ? request.inputUrl : ""} copyable />
              <ApiSummaryRow label="Has body" value={request.hasBody == null ? "" : request.hasBody ? "true" : "false"} />
            </div>
            <JsonReader title="Headers" value={request.headers} />
            <JsonReader title="Body" value={request.body} defaultOpen />
          </div>
        ) : null}

        {response ? (
          <div className={styles.exchangePanel}>
            <div className={styles.exchangeHeader}>
              <span>Response</span>
              <Badge variant={responseVariant}>{response.status || "received"}</Badge>
            </div>
            <div className={styles.apiSummary}>
              <ApiSummaryRow label="URL" value={response.url} copyable />
              <ApiSummaryRow label="Method" value={response.method} />
            </div>
            <JsonReader title="Headers" value={response.headers} />
            <JsonReader title="Body" value={response.body} defaultOpen />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function StepExecutionDetail({
  step,
  executionState,
  tracePath,
  compact = false,
}) {
  const [traceState, setTraceState] = useState({ status: "idle", path: "", data: null, error: "" });
  const effectiveTracePath = tracePath || executionState?.evidence?.tracePath || step?.evidence?.tracePath || step?.raw?.data?.evidence?.tracePath || "";

  useEffect(() => {
    let cancelled = false;
    if (!effectiveTracePath) {
      setTraceState({ status: "idle", path: "", data: null, error: "" });
      return () => {
        cancelled = true;
      };
    }
    setTraceState({ status: "loading", path: effectiveTracePath, data: null, error: "" });
    readEvidenceJson(effectiveTracePath)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setTraceState(
          payload?.success
            ? { status: "loaded", path: payload.path || effectiveTracePath, data: payload.data, error: "" }
            : {
                status: "error",
                path: effectiveTracePath,
                data: null,
                error: payload?.message || payload?.error || "read-failed",
              },
        );
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setTraceState({
          status: "error",
          path: effectiveTracePath,
          data: null,
          error: error?.message || "read-failed",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveTracePath]);

  const detail = useMemo(
    () => createStepExecutionDetail({ step, executionState, trace: traceState.data }),
    [executionState, step, traceState.data],
  );
  const hasRequest = detail.rows.request.length > 0;
  const hasResponse = detail.rows.response.length > 0;
  const hasPopup = detail.rows.popup.length > 0;
  const hasArtifacts = detail.rows.artifacts.length > 0;
  const hasRuntimeVariables = detail.rows.runtimeVariables.length > 0;
  const rawTrace = traceState.data || detail.trace;

  return (
    <div className={styles.detail} data-compact={compact ? "true" : "false"}>
      <div className={styles.header}>
        <div>
          <span>Execution detail</span>
          <strong>{detail.title}</strong>
        </div>
        <Badge variant={statusVariant(detail.status)}>{detail.status}</Badge>
      </div>

      {traceState.status === "loading" ? (
        <Alert className={styles.notice}>
          <Loader2 className={styles.spin} />
          <AlertTitle>Loading trace</AlertTitle>
          <AlertDescription>{effectiveTracePath}</AlertDescription>
        </Alert>
      ) : null}
      {traceState.status === "error" ? (
        <Alert className={styles.notice}>
          <AlertCircle />
          <AlertTitle>Trace unavailable</AlertTitle>
          <AlertDescription>{traceState.error}</AlertDescription>
        </Alert>
      ) : null}

      {detail.warnings.length ? (
        <Alert className={styles.notice}>
          <AlertCircle />
          <AlertTitle>Runtime notes</AlertTitle>
          <AlertDescription>{detail.warnings.join(" · ")}</AlertDescription>
        </Alert>
      ) : null}

      <DetailSection title="Overview" rows={detail.rows.overview} />
      <DetailSection title="Action" rows={detail.rows.action} />
      <DetailSection title="Result" rows={detail.rows.result} />
      <DetailSection title="Assertion" rows={detail.rows.expectation} />
      {hasRequest || hasResponse ? <ApiNetworkViewer detail={detail} /> : null}
      {hasPopup ? <DetailSection title="Popup / Selection" rows={detail.rows.popup} /> : null}
      {hasArtifacts ? <DetailSection title="Input artifacts" rows={detail.rows.artifacts} /> : null}
      {hasRuntimeVariables ? <DetailSection title="Run variables" rows={detail.rows.runtimeVariables} /> : null}
      <DetailSection title="Artifacts" rows={detail.rows.paths} />

      <JsonPreview label="Raw expectation" value={detail.expectation} />
      <JsonPreview label="Raw trace" value={rawTrace} />
      {!rawTrace && !effectiveTracePath && !detail.rows.expectation.length && !detail.rows.action.length ? (
        <Alert className={styles.notice}>
          <CheckCircle2 />
          <AlertTitle>No structured trace yet</AlertTitle>
          <AlertDescription>This step only has live progress metadata.</AlertDescription>
        </Alert>
      ) : null}
      {traceState.path ? (
        <button type="button" className={styles.pathButton} onClick={() => copyTextToClipboard(traceState.path)}>
          <FileJson />
          <span>{traceState.path}</span>
        </button>
      ) : null}
    </div>
  );
}
