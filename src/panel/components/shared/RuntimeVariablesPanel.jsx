import { Copy, Database, FileJson, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@panel/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@panel/components/ui/popover";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import styles from "./RuntimeVariablesPanel.module.css";

const RUNTIME_VARIABLES_POSITION_KEY = "zhuzhu-runtime-variables-panel-position";

function formatValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function sourceVariant(source) {
  if (source === "capture") {
    return "success";
  }
  if (source === "override") {
    return "running";
  }
  if (source === "file") {
    return "neutral";
  }
  if (source === "builtin") {
    return "warning";
  }
  return "neutral";
}

export function buildRuntimeVariableRows(runtimeVariables, runtimeVariableSources = {}) {
  if (!runtimeVariables || typeof runtimeVariables !== "object" || Array.isArray(runtimeVariables)) {
    return [];
  }
  return Object.entries(runtimeVariables)
    .filter(([key]) => key)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      key,
      value: formatValue(value),
      source: runtimeVariableSources?.[key] || "unknown",
    }));
}

function normalizeHistory(runtimeVariableHistory, key) {
  const entries = runtimeVariableHistory?.[key];
  return Array.isArray(entries) ? entries : [];
}

function formatHistoryLocation(entry = {}) {
  const parts = [];
  if (entry.caseName || entry.caseId) {
    parts.push(entry.caseName || entry.caseId);
  }
  if (entry.stepNumber != null) {
    parts.push(`Step ${entry.stepNumber}`);
  } else if (entry.stepId) {
    parts.push(entry.stepId);
  } else if (entry.eventType) {
    parts.push(entry.eventType);
  }
  return parts.join(" / ") || "Run start";
}

function formatHistoryTime(entry = {}) {
  return entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

function formatExecutionSource(value) {
  if (value === "external-app-run") {
    return { label: "External API", variant: "warning" };
  }
  if (value === "build-cases") {
    return { label: "Build cases", variant: "running" };
  }
  if (value === "run") {
    return { label: "Run page", variant: "success" };
  }
  if (value) {
    return { label: String(value), variant: "neutral" };
  }
  return { label: "Not started", variant: "neutral" };
}

export function RuntimeVariablesPanel({
  runtimeVariables,
  runtimeVariableSources,
  runtimeVariableHistory,
  artifacts,
  executionSource,
  updatedAt,
  compact = false,
  floating = false,
  className = "",
}) {
  const panelRef = useRef(null);
  const dragStateRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [openHistoryKey, setOpenHistoryKey] = useState("");
  const [panelPosition, setPanelPosition] = useState(() => {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(RUNTIME_VARIABLES_POSITION_KEY) || "null");
      return Number.isFinite(parsed?.right) && Number.isFinite(parsed?.y) ? parsed : null;
    } catch (_error) {
      return null;
    }
  });
	  const rows = buildRuntimeVariableRows(runtimeVariables, runtimeVariableSources).map((row) => {
    const history = normalizeHistory(runtimeVariableHistory, row.key);
    return {
      ...row,
      history,
      changeCount: history.filter((entry) => entry.changeType !== "initial").length,
    };
	  });
	  const artifactRows = Array.isArray(artifacts)
    ? artifacts.filter((item) => item?.value).map((item) => ({
        label: item.label || "Artifact",
        value: formatValue(item.value),
        kind: item.kind || "artifact",
      }))
	    : [];
  const sourceBadge = formatExecutionSource(executionSource);
	  const updatedLabel = updatedAt
    ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "Not started";

  const clampPanelPosition = (nextPosition) => {
    const element = panelRef.current;
    const parent = element?.offsetParent;
    if (!element || !parent || !nextPosition) {
      return nextPosition;
    }
    const parentRect = parent.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      right: Math.min(Math.max(12, nextPosition.right), Math.max(12, parentRect.width - rect.width - 12)),
      y: Math.min(Math.max(12, nextPosition.y), Math.max(12, parentRect.height - rect.height - 12)),
    };
  };

  const persistPanelPosition = (nextPosition) => {
    if (typeof window === "undefined" || !nextPosition) {
      return;
    }
    window.localStorage.setItem(RUNTIME_VARIABLES_POSITION_KEY, JSON.stringify(nextPosition));
  };

  useEffect(() => {
    if (!floating || !panelPosition || typeof window === "undefined") {
      return undefined;
    }
    const onResize = () => {
      setPanelPosition((current) => {
        const nextPosition = clampPanelPosition(current);
        persistPanelPosition(nextPosition);
        return nextPosition;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [floating, panelPosition]);

  const startPanelDrag = (event) => {
    if (!floating || (event.button != null && event.button !== 0)) {
      return;
    }
    const closestButton = event.target?.closest?.("button");
    if (closestButton && closestButton !== panelRef.current) {
      return;
    }
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches) {
      return;
    }
    const element = panelRef.current;
    const parent = element?.offsetParent;
    if (!element || !parent) {
      return;
    }
    const parentRect = parent.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const startPosition = {
      right: parentRect.right - rect.right,
      y: rect.top - parentRect.top,
    };
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition,
      moved: false,
    };
    element.setPointerCapture?.(event.pointerId);
    setPanelPosition(startPosition);
    event.preventDefault();
  };

  const movePanelDrag = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    dragState.moved = dragState.moved || Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3;
    const nextPosition = clampPanelPosition({
      right: dragState.startPosition.right - deltaX,
      y: dragState.startPosition.y + deltaY,
    });
    setPanelPosition(nextPosition);
  };

  const endPanelDrag = (event) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = null;
    suppressClickRef.current = dragState.moved;
    panelRef.current?.releasePointerCapture?.(event.pointerId);
    setPanelPosition((current) => {
      const nextPosition = clampPanelPosition(current);
      persistPanelPosition(nextPosition);
      return nextPosition;
    });
  };

  const floatingPositionStyle = panelPosition ? { right: `${panelPosition.right}px`, top: `${panelPosition.y}px` } : undefined;

  if (floating && collapsed) {
    return (
      <button
        ref={panelRef}
        type="button"
        className={`${styles.floatingChip} ${className}`}
        style={floatingPositionStyle}
        data-dragged={panelPosition ? "true" : "false"}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          setCollapsed(false);
        }}
        onPointerDown={startPanelDrag}
        onPointerMove={movePanelDrag}
        onPointerUp={endPanelDrag}
        onPointerCancel={endPanelDrag}
        aria-label="Show runtime context"
        title="Show runtime context"
      >
	        <Database />
	        <span>Runtime context</span>
        <Badge variant={sourceBadge.variant}>{sourceBadge.label}</Badge>
	        <Badge variant="neutral">{rows.length + artifactRows.length}</Badge>
	      </button>
    );
  }

  return (
    <Card
      ref={panelRef}
      className={`${styles.panel} ${compact ? styles.compact : ""} ${floating ? styles.floatingPanel : ""} ${className}`}
      style={floating ? floatingPositionStyle : undefined}
      data-dragged={floating && panelPosition ? "true" : "false"}
      onPointerMove={movePanelDrag}
      onPointerUp={endPanelDrag}
      onPointerCancel={endPanelDrag}
    >
      <CardHeader
        className={styles.header}
        data-draggable={floating ? "true" : "false"}
        onPointerDown={startPanelDrag}
      >
        <div>
          <div className={styles.kicker}>Runtime context</div>
          <CardTitle className={styles.title}>
            <Database />
            Runtime variables
          </CardTitle>
        </div>
	        <div className={styles.headerActions}>
          <Badge variant={sourceBadge.variant}>{sourceBadge.label}</Badge>
	          <Badge variant="neutral">{rows.length + artifactRows.length}</Badge>
          {floating ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={styles.minimizeButton}
              onClick={() => setCollapsed(true)}
              aria-label="Collapse runtime context"
              title="Collapse runtime context"
            >
              <Minimize2 />
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className={styles.content}>
	        <div className={styles.meta}>Updated {updatedLabel}</div>
        {artifactRows.length ? (
          <div className={styles.artifacts} aria-label="Run artifacts">
            <div className={styles.sectionHeader}>
              <FileJson />
              <span>Run artifacts</span>
            </div>
            {artifactRows.map((item) => (
              <div key={`${item.kind}:${item.value}`} className={styles.artifactRow}>
                <div className={styles.artifactText}>
                  <strong>{item.label}</strong>
                  <span title={item.value}>{item.value}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={styles.copyButtonInline}
                  onClick={() => copyTextToClipboard(item.value)}
                  aria-label={`Copy ${item.label}`}
                  title={`Copy ${item.label}`}
                >
                  <Copy />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
	        {rows.length ? (
          <ScrollArea className={styles.scrollArea}>
            <div className={styles.rows}>
              {rows.map((row) => (
                <Popover key={row.key} open={openHistoryKey === row.key && row.history.length > 0}>
                  <PopoverTrigger asChild>
                    <div
                      className={styles.row}
                      tabIndex={0}
                      onMouseEnter={() => setOpenHistoryKey(row.key)}
                      onMouseLeave={() => setOpenHistoryKey((current) => current === row.key ? "" : current)}
                      onFocus={() => setOpenHistoryKey(row.key)}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) {
                          setOpenHistoryKey((current) => current === row.key ? "" : current);
                        }
                      }}
                    >
                      <div className={styles.rowHeader}>
                        <strong>{row.key}</strong>
                        <div className={styles.badges}>
                          {row.changeCount > 0 ? <Badge variant="running">{row.changeCount} changes</Badge> : null}
                          <Badge variant={sourceVariant(row.source)}>{row.source}</Badge>
                        </div>
                      </div>
                      <div className={styles.value} title={row.value}>
                        {row.value || "-"}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={styles.copyButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          copyTextToClipboard(row.value);
                        }}
                        aria-label={`Copy ${row.key}`}
                        title={`Copy ${row.key}`}
                      >
                        <Copy />
                      </Button>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent
                    className={styles.historyPopover}
                    side="left"
                    align="start"
                    onMouseEnter={() => setOpenHistoryKey(row.key)}
                    onMouseLeave={() => setOpenHistoryKey((current) => current === row.key ? "" : current)}
                    onOpenAutoFocus={(event) => event.preventDefault()}
                  >
                    <div className={styles.historyHeader}>
                      <strong>{row.key}</strong>
                      <Badge variant="neutral">{row.history.length} records</Badge>
                    </div>
                    <div className={styles.historyRows}>
                      {row.history.map((entry, index) => (
                        <div key={`${entry.at || index}-${entry.value}`} className={styles.historyRow}>
                          <div className={styles.historyMeta}>
                            <span>{formatHistoryLocation(entry)}</span>
                            <small>{formatHistoryTime(entry)}</small>
                          </div>
                          <div className={styles.historyValue} title={entry.value}>
                            {entry.value || "-"}
                          </div>
                          {entry.changeType === "update" && entry.previousValue && entry.previousValue !== entry.value ? (
                            <div className={styles.historyPrevious} title={entry.previousValue}>
                              Previous {entry.previousValue}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className={styles.emptyState}>Run a case to inspect the active variable context.</div>
        )}
      </CardContent>
    </Card>
  );
}
