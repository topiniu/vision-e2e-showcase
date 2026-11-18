import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronRight as ChevronRightIcon,
  Files,
  FileText,
  FilePlus2,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  History,
  LayoutGrid,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Settings,
  Sun,
} from "lucide-react";
import styles from "./PanelShell.module.css";
import brandLogoUrl from "@panel/assets/app-icon-256.png";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { TooltipProvider } from "@panel/components/ui/tooltip";
import { FullTextTooltip } from "@panel/components/shared/FullTextTooltip";
import { ClipboardFeedbackToast } from "@panel/components/shared/ClipboardFeedbackToast";
import { ExternalActivityPopover } from "@panel/components/shared/ExternalActivityPopover";
import { RunBoardButton } from "@panel/components/shared/RunBoardButton";
import { TestFileActionMenu } from "@panel/features/test-files/TestFileActions";
import { BatchRunDialog } from "@panel/features/test-files/BatchRunDialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@panel/components/ui/sidebar";
import {
  browserCommand,
  appendDebugLog,
  completeExternalAppRun,
  reportExternalAppRunProgress,
  getRuntimeState,
  getPanelAppMode,
  getPanelPreferences,
  getPanelPlatform,
  markExternalAppRunReady,
  notifyRunFileComplete,
  copyTestFile,
  createTestFile,
  listRunHistory,
  listTestFiles,
  navigate,
  readTestFile,
  requestBrowserState,
  runRuntimePayload,
  saveTestFile,
  stopRuntimeRun,
  subscribeTestFileChanges,
  subscribeExternalAppRunCancels,
  subscribeExternalAppRunRequests,
  subscribeRuntimeRunEvents,
  subscribePanelMemoryWarnings,
  subscribeHostMemoryWarnings,
  subscribeBrowserState,
  updatePanelPreferences,
} from "@panel/lib/panel-api";
import {
  createDefaultDraft,
  createDraftFromTemplate,
  createEmptyStep,
  draftToRuntimePayload,
  getDraftWarnings,
  parseLooseJson,
  runtimePayloadToDraft,
} from "@panel/lib/payload-draft.mjs";
import {
  applyRuntimeRunEvent,
  createRunProgress,
  getRunStepIdentity,
  syncRunProgressSteps,
} from "@panel/lib/run-progress.mjs";
import { OverviewPage as OverviewPageBase } from "./pages/OverviewPage";
import { TestFilePage as TestFilePageBase } from "./pages/TestFilePage";
import { HistoryPage as HistoryPageBase } from "./pages/HistoryPage";
import { SettingsPage as SettingsPageBase } from "./pages/SettingsPage";
import { RunBoardPage } from "./pages/RunBoardPage";

// Memoized page shells: only one page mounts at a time and now receives a
// stable pageProps (values + ref-delegated stable handlers), so state changes
// that are NOT in pageProps — sidebar collapse/expand, width drag, etc. — skip
// re-rendering the whole page tree instead of re-rendering it on every toggle.
const OverviewPage = memo(OverviewPageBase);
const TestFilePage = memo(TestFilePageBase);
const HistoryPage = memo(HistoryPageBase);
const SettingsPage = memo(SettingsPageBase);
import { ProfessionalRunReportPage } from "@panel/features/results/ProfessionalRunReportView";
import {
  createCaseDraft,
  createTestFileDraft,
  buildExecutableCaseSteps,
  getSelectedCaseId,
  normalizeTestFile,
  runtimeDraftToTestFile,
  testFileToRuntimeDraft,
} from "../../shared/test-file.mjs";

const navigationSections = [
  {
    label: "Workspace",
    items: [{ id: "workspace", title: "Workspace", icon: LayoutGrid }],
  },
  {
    label: "Library",
    items: [
      { id: "history", title: "History", icon: History },
      { id: "settings", title: "Settings", icon: Settings },
    ],
  },
];

const validWorkspaces = [...navigationSections.flatMap((section) => section.items.map((item) => item.id)), "run-board"];

const testFileModes = [
  ["view", "View"],
  ["edit-file", "Edit file"],
  ["build-cases", "Build cases"],
  ["evaluate", "Evaluate"],
  ["run", "Run"],
  ["history", "History"],
];

const DEFAULT_ROOT_STEP_PHASE = "setup";
const EVIDENCE_PROFILES = new Set(["debug", "fast", "turbo"]);

function normalizeRunEvidenceProfile(value, fallback = "debug") {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EVIDENCE_PROFILES.has(text) ? text : fallback;
}

function getTestFileEvidenceProfile(sourceFile) {
  return normalizeRunEvidenceProfile(sourceFile?.settings?.evidenceProfile);
}
const ROOT_STEP_PHASES = new Set(["setup", "teardown"]);
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 200;
const COLOR_THEMES = new Set(["forest", "mulberry"]);
const BROWSER_PROXY_MODES = ["system", "manual", "direct"];
const DEFAULT_PANEL_PREFERENCES = {
  openChromeOnSecondaryDisplay: true,
  maximizeChromeOnLaunch: true,
  browserProxyMode: "system",
  browserProxyServer: "",
  browserProxyBypass: "",
  browserIdleTimeoutMinutes: 15,
};

function normalizeIdleTimeoutMinutes(value) {
  if (value === 0 || value === "0") {
    return 0;
  }
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PANEL_PREFERENCES.browserIdleTimeoutMinutes;
  }
  return Math.min(parsed, 240);
}

const TEST_FILE_SAVE_BADGES = {
  saved: { label: "Saved", variant: "success" },
  dirty: { label: "Unsaved", variant: "running" },
  "external-updated": { label: "File updated", variant: "warning" },
  conflict: { label: "Review changes", variant: "danger" },
};

// Injected by Vite from package.json (single source of truth). Guarded so a
// non-Vite context (should not happen) degrades to empty rather than crashing.
const APP_VERSION = typeof __ZHUZHU_VERSION__ !== "undefined" ? __ZHUZHU_VERSION__ : "";

function getTestFileSaveBadge(saveState) {
  return TEST_FILE_SAVE_BADGES[saveState] || TEST_FILE_SAVE_BADGES.saved;
}

function clampSidebarWidth(value) {
  return Math.max(MIN_SIDEBAR_WIDTH, value);
}

function getInitialSidebarWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  const stored = Number(window.localStorage.getItem("zhuzhu-sidebar-width"));
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
}

function getInitialTheme() {
  if (typeof window === "undefined") {
    return "light";
  }
  const stored = window.localStorage.getItem("zhuzhu-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function getInitialColorTheme() {
  if (typeof window === "undefined") {
    return "forest";
  }
  const stored = window.localStorage.getItem("zhuzhu-color-theme");
  return COLOR_THEMES.has(stored) ? stored : "forest";
}

function normalizePanelPreferences(value = {}) {
  return {
    openChromeOnSecondaryDisplay: value.openChromeOnSecondaryDisplay !== false,
    maximizeChromeOnLaunch: value.maximizeChromeOnLaunch !== false,
    browserProxyMode: BROWSER_PROXY_MODES.includes(value.browserProxyMode)
      ? value.browserProxyMode
      : "system",
    browserProxyServer: typeof value.browserProxyServer === "string" ? value.browserProxyServer.trim() : "",
    browserProxyBypass: typeof value.browserProxyBypass === "string" ? value.browserProxyBypass.trim() : "",
    browserIdleTimeoutMinutes: normalizeIdleTimeoutMinutes(value.browserIdleTimeoutMinutes),
  };
}

function normalizeWorkspace(hashValue) {
  if (!hashValue || hashValue === "overview") {
    return "workspace";
  }
  if (hashValue === "observability") {
    return "test-file";
  }
  if (hashValue === "orchestrator" || hashValue === "runner" || hashValue === "templates") {
    return "test-file";
  }
  return validWorkspaces.includes(hashValue) || hashValue === "test-file" || hashValue === "report" ? hashValue : "workspace";
}

function getInitialWorkspace() {
  if (typeof window === "undefined") {
    return "workspace";
  }
  return normalizeWorkspace(window.location.hash.replace("#", ""));
}

function cloneStep(step) {
  return JSON.parse(JSON.stringify(step));
}

function summarizeRunDebugStep(step = {}) {
  return {
    id: step.id || step.stepId || "",
    type: step.type || step.kind || "",
    phase: step.phase || "",
    sourceFixture: step.sourceFixture || "",
    sourceMacro: step.sourceMacro || "",
    title: step.stepTitle || step.title || step.name || "",
  };
}

function writeRunDebugLog(stage, payload = {}) {
  const entry = {
    stage,
    at: new Date().toISOString(),
    payload,
  };
  void appendDebugLog(entry).catch((error) => {
    console.warn("[App][RunDebugLog:write-failed]", error?.message || String(error));
  });
}

function normalizeRootStepPhase(value) {
  return ROOT_STEP_PHASES.has(value) ? value : DEFAULT_ROOT_STEP_PHASE;
}

function runtimeStepsToDraft(steps = []) {
  return runtimePayloadToDraft(Array.isArray(steps) ? steps : []);
}

function draftToRuntimeSteps(draftValue) {
  const payload = draftToRuntimePayload(draftValue);
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload && Object.keys(payload).length ? [payload] : [];
}

function getDraftForBuildTarget(testFileValue, caseId, targetType = "case", rootPhase = DEFAULT_ROOT_STEP_PHASE) {
  const normalized = normalizeTestFile(testFileValue);
  if (targetType === "root") {
    const phase = normalizeRootStepPhase(rootPhase);
    return runtimeStepsToDraft(normalized[phase]?.steps || []);
  }
  return testFileToRuntimeDraft(normalized, caseId);
}

function writeDraftToBuildTarget(draftValue, testFileValue, caseId, targetType = "case", rootPhase = DEFAULT_ROOT_STEP_PHASE) {
  const normalized = normalizeTestFile(testFileValue);
  if (targetType === "root") {
    const phase = normalizeRootStepPhase(rootPhase);
    return normalizeTestFile({
      ...normalized,
      [phase]: {
        ...(normalized[phase] || {}),
        steps: draftToRuntimeSteps(draftValue),
      },
    });
  }
  return runtimeDraftToTestFile(draftValue, normalized, caseId);
}

function createRunId() {
  return `panel-run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function formatRunDuration(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function getExternalRunStatus(result = {}) {
  if (result?.status === "busy" || result?.status === "cancelled") {
    return result.status;
  }
  if (result?.status === "stopped" || result?.error?.code === "run-stopped" || String(result?.type || "").includes("stopped")) {
    return "stopped";
  }
  return result?.ok ? "passed" : "failed";
}

function findRunReportPath(result = {}) {
  return (
    result?.evidence?.reportPath ||
    result?.evidence?.caseRuns?.find((item) => item?.reportPath)?.reportPath ||
    result?.evidence?.steps?.find((item) => item?.reportPath)?.reportPath ||
    null
  );
}

function createExternalAppRunResponse({
  externalRunId = "",
  testFilePath = "",
  scope = "all",
  caseId = null,
  result = null,
  error = null,
} = {}) {
  const runResult = result || { ok: false, type: "run-failed", error };
  const status = getExternalRunStatus(runResult);
  const caseResults = Array.isArray(runResult?.caseResults) ? runResult.caseResults : [];
  const totalCases = caseResults.length || (scope === "selected" || caseId ? 1 : 0);
  const passedCases = caseResults.length
    ? caseResults.filter((item) => item.result?.ok).length
    : runResult?.ok
      ? totalCases
      : 0;
  return {
    ok: status === "passed",
    status,
    externalRunId,
    testFilePath,
    scope,
    caseId: caseId || null,
    summary: {
      totalCases,
      passedCases,
      failedCases: Math.max(0, totalCases - passedCases),
      durationMs: runResult?.telemetry?.durationMs || 0,
      steps: runResult?.telemetry?.steps || 0,
      okCount: runResult?.telemetry?.okCount || 0,
      errorCount: runResult?.telemetry?.errorCount || (status === "failed" ? 1 : 0),
    },
    reportPath: findRunReportPath(runResult),
    error: runResult?.error || error || null,
    result: runResult,
  };
}

function normalizeRunStepRange(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const start = Number.parseInt(value.start, 10);
  const end = Number.parseInt(value.end, 10);
  const normalized = {};
  if (Number.isFinite(start) && start > 0) {
    normalized.start = start;
  }
  if (Number.isFinite(end) && end > 0) {
    normalized.end = end;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function createActivityItem(type, label, detail) {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    label,
    detail,
    timestamp: Date.now(),
  };
}

function buildTestFileTree(files = []) {
  const root = { key: "", label: "root", groups: new Map(), files: [] };
  for (const file of files) {
    const groupPath = String(file.group || "").trim();
    const parts = groupPath.split("/").map((part) => part.trim()).filter(Boolean);
    let cursor = root;
    let key = "";
    for (const part of parts) {
      key = key ? `${key}/${part}` : part;
      if (!cursor.groups.has(part)) {
        cursor.groups.set(part, { key, label: part, groups: new Map(), files: [] });
      }
      cursor = cursor.groups.get(part);
    }
    cursor.files.push(file);
  }
  return root;
}

function TestFileTree({
  files,
  activeFilePath,
  runningFilePath,
  collapsedGroups,
  onToggleGroup,
  onSelectFile,
  onCreateFile,
  onCreateFolder,
  onRefreshFiles,
  onDuplicateFile,
  compact = false,
}) {
  const tree = useMemo(
    () => buildTestFileTree(files.map((file) => ({ ...file, running: file.path === runningFilePath }))),
    [files, runningFilePath],
  );
  const ungrouped = tree.files.filter((file) => !file.invalid);
  const [compactTreeOpen, setCompactTreeOpen] = useState(false);
  const [compactTreePosition, setCompactTreePosition] = useState({ top: 0, left: 0 });
  const [refreshState, setRefreshState] = useState({
    loading: false,
    message: "",
    tone: "neutral",
  });
  const compactTreeButtonRef = useRef(null);
  const compactTreePanelRef = useRef(null);
  const refreshMessageTimerRef = useRef(null);
  const handleSelectFile = (path) => {
    onSelectFile(path);
    setCompactTreeOpen(false);
  };
  const handleCreateFile = (group = "") => {
    onCreateFile(group);
    setCompactTreeOpen(false);
  };
  const handleCreateFolder = () => {
    onCreateFolder();
    setCompactTreeOpen(false);
  };
  const handleDuplicateFile = (file) => {
    onDuplicateFile?.(file);
    setCompactTreeOpen(false);
  };
  const handleRefreshFiles = async () => {
    if (refreshState.loading) {
      return;
    }
    window.clearTimeout(refreshMessageTimerRef.current);
    setRefreshState({
      loading: true,
      message: "Updating test files...",
      tone: "neutral",
    });
    try {
      const response = await onRefreshFiles();
      if (response?.success) {
        setRefreshState({
          loading: false,
          message: `Updated ${response.files?.length || 0} files`,
          tone: "success",
        });
      } else {
        setRefreshState({
          loading: false,
          message: "Refresh failed",
          tone: "danger",
        });
      }
    } catch (_error) {
      setRefreshState({
        loading: false,
        message: "Refresh failed",
        tone: "danger",
      });
    }
    refreshMessageTimerRef.current = window.setTimeout(() => {
      setRefreshState((current) => ({ ...current, message: "", tone: "neutral" }));
    }, 2200);
  };

  const refreshToast = refreshState.message && typeof document !== "undefined"
    ? createPortal(
      <div className={styles.fileTreeToast} data-tone={refreshState.tone} role="status" aria-live="polite">
        <RefreshCw data-loading={refreshState.loading} />
        <span>{refreshState.message}</span>
      </div>,
      document.body,
    )
    : null;

  const treeContent = (
    <TestFileTreeContent
      files={files}
      groups={tree.groups}
      ungrouped={ungrouped}
      activeFilePath={activeFilePath}
      collapsedGroups={collapsedGroups}
      onToggleGroup={onToggleGroup}
      onSelectFile={compact ? handleSelectFile : onSelectFile}
      onCreateFile={compact ? handleCreateFile : onCreateFile}
      onCreateFolder={compact ? handleCreateFolder : onCreateFolder}
      onRefreshFiles={handleRefreshFiles}
      onDuplicateFile={compact ? handleDuplicateFile : onDuplicateFile}
    />
  );

  const toggleCompactTree = () => {
    const rect = compactTreeButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setCompactTreePosition({
        top: rect.top,
        left: rect.right + 8,
      });
    }
    setCompactTreeOpen((value) => !value);
  };

  useEffect(() => {
    if (!compact || !compactTreeOpen) {
      return undefined;
    }
    const closeOnOutside = (event) => {
      if (
        compactTreeButtonRef.current?.contains(event.target) ||
        compactTreePanelRef.current?.contains(event.target)
      ) {
        return;
      }
      setCompactTreeOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setCompactTreeOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnOutside);
    window.addEventListener("scroll", closeOnOutside, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnOutside);
      window.removeEventListener("scroll", closeOnOutside, true);
    };
  }, [compact, compactTreeOpen]);

  useEffect(() => {
    return () => window.clearTimeout(refreshMessageTimerRef.current);
  }, []);

  if (compact) {
    return (
      <>
        <SidebarGroup className={styles.compactTreeGroup}>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <button
                  ref={compactTreeButtonRef}
                  type="button"
                  className={styles.compactTreeButton}
                  aria-label="Open test files tree"
                  title="Test files"
                  aria-expanded={compactTreeOpen}
                  onClick={toggleCompactTree}
                >
                  <FolderTree />
                  <span>Test files</span>
                </button>
                {compactTreeOpen && typeof document !== "undefined"
                  ? createPortal(
                  <div
                    ref={compactTreePanelRef}
                    role="dialog"
                    aria-label="Test files"
                    className={styles.fileTreePopover}
                    style={{
                      top: `${compactTreePosition.top}px`,
                      left: `${compactTreePosition.left}px`,
                    }}
                  >
                    <div className={styles.fileTreePopoverHeader}>
                      <span>Test Files</span>
                      <div className={styles.treeHeaderActions}>
                        <small>{files?.length || 0}</small>
                        <button
                          type="button"
                          className={styles.treeActionButton}
                          data-loading={refreshState.loading}
                          aria-label="Refresh test files"
                          title="Refresh test files"
                          disabled={refreshState.loading}
                          onClick={handleRefreshFiles}
                        >
                          <RefreshCw />
                        </button>
                        <button
                          type="button"
                          className={styles.treeActionButton}
                          aria-label="Create test file"
                          title="Create test file"
                          onClick={() => handleCreateFile("")}
                        >
                          <FilePlus />
                        </button>
                        <button
                          type="button"
                          className={styles.treeActionButton}
                          aria-label="Create folder"
                          title="Create folder"
                          onClick={handleCreateFolder}
                        >
                          <FolderPlus />
                        </button>
                      </div>
                    </div>
                    {treeContent}
                  </div>,
                  document.body,
                )
                  : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {refreshToast}
      </>
    );
  }

  return (
    <>
      <SidebarGroup className={styles.testFilesGroup}>
        <div className={styles.treeHeader}>
          <SidebarGroupLabel className={styles.treeHeaderLabel}>Test Files</SidebarGroupLabel>
          <div className={styles.treeHeaderActions}>
            <button
              type="button"
              className={styles.treeActionButton}
              data-loading={refreshState.loading}
              aria-label="Refresh test files"
              title="Refresh test files"
              disabled={refreshState.loading}
              onClick={handleRefreshFiles}
            >
              <RefreshCw />
            </button>
            <button
              type="button"
              className={styles.treeActionButton}
              aria-label="Create test file"
              title="Create test file"
              onClick={() => onCreateFile("")}
            >
              <FilePlus />
            </button>
            <button
              type="button"
              className={styles.treeActionButton}
              aria-label="Create folder"
              title="Create folder"
              onClick={onCreateFolder}
            >
              <FolderPlus />
            </button>
          </div>
        </div>
        <SidebarGroupContent className={styles.testFilesGroupContent}>
          {treeContent}
        </SidebarGroupContent>
      </SidebarGroup>
      {refreshToast}
    </>
  );
}

function TestFileTreeContent({
  files,
  groups,
  ungrouped,
  activeFilePath,
  collapsedGroups,
  onToggleGroup,
  onSelectFile,
  onCreateFile,
  onCreateFolder,
  onRefreshFiles,
  onDuplicateFile,
}) {
  return (
    <>
      <div className={styles.fileTree}>
        {Array.from(groups.values()).map((group) => (
          <TestFileTreeGroup
            key={group.key}
            group={group}
            activeFilePath={activeFilePath}
            collapsedGroups={collapsedGroups}
            onToggleGroup={onToggleGroup}
            onSelectFile={onSelectFile}
            onCreateFile={onCreateFile}
            onDuplicateFile={onDuplicateFile}
            depth={0}
          />
        ))}
        {ungrouped.map((file) => (
          <TestFileTreeFile
            key={file.path}
            file={file}
            active={file.path === activeFilePath}
            onSelectFile={onSelectFile}
            onDuplicateFile={onDuplicateFile}
            depth={0}
          />
        ))}
        {!files?.length ? <div className={styles.emptyTree}>No test files yet.</div> : null}
      </div>
    </>
  );
}

function groupContainsRunningFile(group) {
  return group.files.some((file) => file.running)
    || Array.from(group.groups.values()).some(groupContainsRunningFile);
}

function TestFileTreeGroup({ group, activeFilePath, collapsedGroups, onToggleGroup, onSelectFile, onCreateFile, onDuplicateFile, depth }) {
  const collapsed = collapsedGroups.includes(group.key) && !groupContainsRunningFile(group);
  return (
    <div className={styles.treeGroup}>
      <div className={styles.treeGroupRow}>
        <FullTextTooltip content={group.label} side="right" align="start">
          <button
            type="button"
            className={styles.treeGroupButton}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() => onToggleGroup(group.key)}
          >
            {collapsed ? <ChevronRightIcon className={styles.treeIcon} /> : <ChevronDown className={styles.treeIcon} />}
            {collapsed ? <Folder className={styles.treeIcon} /> : <FolderOpen className={styles.treeIcon} />}
            <span>{group.label}</span>
          </button>
        </FullTextTooltip>
        <button
          type="button"
          className={styles.treeInlineAction}
          aria-label={`Create test file in ${group.label}`}
          title={`Create test file in ${group.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onCreateFile(group.key);
          }}
        >
          <FilePlus />
        </button>
      </div>
      {!collapsed ? (
        <div>
          {Array.from(group.groups.values()).map((child) => (
            <TestFileTreeGroup
              key={child.key}
              group={child}
              activeFilePath={activeFilePath}
              collapsedGroups={collapsedGroups}
              onToggleGroup={onToggleGroup}
              onSelectFile={onSelectFile}
              onCreateFile={onCreateFile}
              onDuplicateFile={onDuplicateFile}
              depth={depth + 1}
            />
          ))}
          {group.files.filter((file) => !file.invalid).map((file) => (
            <TestFileTreeFile
              key={file.path}
              file={file}
              active={file.path === activeFilePath}
              onSelectFile={onSelectFile}
              onDuplicateFile={onDuplicateFile}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TestFileTreeFile({ file, active, onSelectFile, onDuplicateFile, depth }) {
  const running = file.running === true;
  return (
    <TestFileActionMenu
      file={file}
      onSelectFile={onSelectFile}
      onDuplicateFile={onDuplicateFile}
      tooltip={running ? `${file.name}\nRunning` : file.name}
    >
      <button
        type="button"
        className={styles.treeFileButton}
        data-active={active}
        data-running={running}
        aria-label={running ? `${file.name}, running` : file.name}
        style={{ paddingLeft: `${22 + depth * 12}px` }}
        onClick={() => onSelectFile(file.path)}
      >
        {running ? (
          <LoaderCircle className={`${styles.treeIcon} ${styles.treeRunningIcon}`} aria-hidden="true" />
        ) : (
          <FileText className={styles.treeIcon} />
        )}
        <span>{file.name}</span>
        {running ? <Badge variant="running">Running</Badge> : <small>{file.caseCount || 0}</small>}
      </button>
    </TestFileActionMenu>
  );
}

function AppSidebar({
  isDevelopmentApp,
  workspace,
  activeFilePath,
  runningFilePath,
  testFileList,
  collapsedGroups,
  onToggleGroup,
  onSelectFile,
  onCreateFile,
  onCreateFolder,
  onRefreshFiles,
  onDuplicateFile,
  onNavigatePage,
  theme,
  onToggleTheme,
  sidebarCollapsed,
  onToggleCollapsed,
  onSidebarResizeStart,
  sidebarResizeMovedRef,
}) {
  return (
    <Sidebar collapsible="icon" className={styles.sidebar}>
      <SidebarHeader className={styles.sidebarHeader}>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className={styles.brandButton} title={APP_VERSION ? `Zhuzhu v${APP_VERSION}` : "Vision E2E Showcase"} aria-label="Vision E2E Showcase">
              <img className={styles.brandMark} src={brandLogoUrl} alt="Vision E2E Showcase" width={28} height={28} />
              <div className={styles.brandCopy}>
                <span className={styles.brandTitle}>Zhuzhu</span>
                <span className={styles.brandSubtitle}>
                  Control panel{APP_VERSION ? ` · v${APP_VERSION}` : ""}
                </span>
              </div>
              {isDevelopmentApp ? (
                <Badge className={styles.devBadge} variant="warning" title="Development mode" aria-label="Development mode">
                  DEV
                </Badge>
              ) : null}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className={styles.sidebarContent}>
        <div className={styles.sidebarNavigation}>
          {navigationSections.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        tooltip={item.title}
                        isActive={workspace === item.id}
                        onClick={() => onNavigatePage(item.id)}
                      >
                        <Icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          ))}
        </div>
        <TestFileTree
          files={testFileList}
          activeFilePath={activeFilePath}
          runningFilePath={runningFilePath}
          collapsedGroups={collapsedGroups}
          onToggleGroup={onToggleGroup}
          onSelectFile={onSelectFile}
          onCreateFile={onCreateFile}
          onCreateFolder={onCreateFolder}
          onRefreshFiles={onRefreshFiles}
          onDuplicateFile={onDuplicateFile}
          compact={sidebarCollapsed}
        />
        {!sidebarCollapsed ? (
          <div className={styles.sidebarBatchRun}>
            <BatchRunDialog files={testFileList} triggerClassName={styles.sidebarBatchRunTrigger} />
          </div>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <div className={styles.sidebarExternalActivity}>
          <RunBoardButton compact={sidebarCollapsed} active={workspace === "run-board"} onClick={() => onNavigatePage("run-board")} />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={theme === "dark" ? "Light mode" : "Dark mode"} onClick={onToggleTheme}>
              {theme === "dark" ? <Sun /> : <Moon />}
              <span>{theme === "dark" ? "Light" : "Dark"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={onToggleCollapsed}
            >
              {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              <span>{sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail
        className={styles.sidebarResizeRail}
        onPointerDown={onSidebarResizeStart}
        onClick={() => {
          if (sidebarResizeMovedRef?.current) {
            sidebarResizeMovedRef.current = false;
            return;
          }
          onToggleCollapsed();
        }}
      />
    </Sidebar>
  );
}

function AppTitleFilePicker({ files, onSelectFile, onDuplicateFile }) {
  return (
    <div className={styles.windowFilePicker}>
      <button type="button" className={styles.windowFileTrigger}>
        <Files />
        Files
      </button>
      <div className={styles.windowFilePanel}>
        {files?.length ? (
          <>
            <div className={styles.windowFileCount}>{files.length} test files</div>
            <div className={styles.windowFileList}>
              {files.map((file) => (
                <TestFileActionMenu
                  key={file.path}
                  file={file}
                  onSelectFile={onSelectFile}
                  onDuplicateFile={onDuplicateFile}
                  tooltip={`${file.name}\n${file.path}`}
                >
                  <button
                    type="button"
                    className={styles.windowFileItem}
                    onClick={() => onSelectFile(file.path)}
                    disabled={file.invalid}
                  >
                    <span>{file.name}</span>
                    <small>{file.caseCount || 0} cases · {file.path}</small>
                  </button>
                </TestFileActionMenu>
              ))}
            </div>
          </>
        ) : (
          <div className={styles.windowFileEmpty}>No saved test files yet.</div>
        )}
      </div>
    </div>
  );
}

function AppTitleBar({
  isDevelopmentApp,
  workspace,
  testFile,
  currentTestFilePath,
  testFileMode,
  testFileSaveState,
  sidebarCollapsed,
  testFileList,
  isTestFileDirty,
  isSavingTestFile,
  isReloadingTestFile,
  onTestFileModeChange,
  onCreateTestFile,
  onSaveTestFile,
  onReloadTestFile,
  onSelectTestFile,
  onDuplicateTestFile,
}) {
  const titleByWorkspace = {
    workspace: "Workspace",
    "test-file": testFile?.name || "Test file",
    report: "Report",
    history: "History",
    "run-board": "运行看板",
    settings: "Settings",
  };
  const subtitleByWorkspace = {
    workspace: "Zhuzhu Control Panel",
    "test-file": currentTestFilePath || testFile?.id || testFileMode || "No file selected",
    report: "Professional QA report",
    history: "Run archive and activity",
    "run-board": "运行中 / 排队 / 历史",
    settings: "Surface controls",
  };
  const title = titleByWorkspace[workspace] || "Vision E2E Showcase";
  const subtitle = subtitleByWorkspace[workspace] || "Control panel";
  const tagCount = testFile?.tags?.length || 0;
  const isTestFileWorkspace = workspace === "test-file";
  const saveBadge = getTestFileSaveBadge(testFileSaveState || (isTestFileDirty ? "dirty" : "saved"));
  const canReloadTestFile = isTestFileWorkspace
    && currentTestFilePath
    && (testFileSaveState === "external-updated" || testFileSaveState === "conflict");

  return (
    <div
      className={styles.windowTitlebar}
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
    >
      <div className={styles.windowTitlebarSide} />
      <div className={styles.windowTitlebarMain}>
        <div className={styles.windowTitleIdentity}>
          {isDevelopmentApp ? (
            <Badge className={styles.devBadge} variant="warning" title="Development mode" aria-label="Development mode">
              DEV
            </Badge>
          ) : null}
          {isTestFileWorkspace ? (
            <Badge variant={saveBadge.variant}>
              {saveBadge.label}
            </Badge>
          ) : null}
          {canReloadTestFile ? (
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              onClick={onReloadTestFile}
              disabled={isReloadingTestFile}
              aria-label="Reload current test file"
              title="Reload current test file"
            >
              <RefreshCw />
            </Button>
          ) : null}
          <FileText className={styles.windowTitleIcon} />
          <div className={styles.windowTitleText}>
            <FullTextTooltip content={title} side="bottom" align="start">
              <span>{title}</span>
            </FullTextTooltip>
            <FullTextTooltip content={subtitle} side="bottom" align="start">
              <small>{subtitle}</small>
            </FullTextTooltip>
          </div>
          {isTestFileWorkspace ? <span className={styles.windowTagPill}>{tagCount}</span> : null}
        </div>
        <div className={styles.windowTitleControls}>
          <ExternalActivityPopover />
          {isTestFileWorkspace ? (
            <>
            <div className={styles.windowModeGroup} role="tablist" aria-label="Test file mode">
              {testFileModes.map(([item, label]) => (
                <button
                  key={item}
                  type="button"
                  className={styles.windowModeButton}
                  data-active={testFileMode === item}
                  onClick={() => onTestFileModeChange(item)}
                >
                  {label}
                </button>
              ))}
            </div>
            <AppTitleFilePicker
              files={testFileList}
              onSelectFile={onSelectTestFile}
              onDuplicateFile={onDuplicateTestFile}
            />
            <Button type="button" variant="secondary" size="sm" onClick={onCreateTestFile}>
              <FilePlus2 data-icon="inline-start" />
              New
            </Button>
            <Button type="button" variant="default" size="sm" onClick={onSaveTestFile} disabled={isSavingTestFile || !isTestFileDirty}>
              <Save data-icon="inline-start" />
              Save
            </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Memoized sidebar: skips re-render when only unrelated App state changes; its
// handlers arrive via the stable `sidebarHandlers` delegation.
const MemoAppSidebar = memo(AppSidebar);

export default function App() {
  const [theme, setTheme] = useState(getInitialTheme);
  const [colorTheme, setColorTheme] = useState(getInitialColorTheme);
  const panelPlatform = getPanelPlatform();
  const isDevelopmentApp = getPanelAppMode() === "development";
  const [workspace, setWorkspace] = useState(getInitialWorkspace);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("zhuzhu-sidebar-collapsed") === "true";
  });
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [browserState, setBrowserState] = useState(null);
  const [runtimeState, setRuntimeState] = useState(null);
  const [panelPreferences, setPanelPreferences] = useState(DEFAULT_PANEL_PREFERENCES);
  const [navInput, setNavInput] = useState("");
  const [draft, setDraft] = useState(createDefaultDraft);
  const [currentTestFilePath, setCurrentTestFilePath] = useState(null);
  const [testFile, setTestFile] = useState(() =>
    runtimeDraftToTestFile(createDefaultDraft(), createTestFileDraft()),
  );
  const [testFileList, setTestFileList] = useState([]);
  const [testFileMode, setTestFileMode] = useState("view");
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [buildTargetType, setBuildTargetType] = useState("case");
  const [rootStepPhase, setRootStepPhase] = useState(DEFAULT_ROOT_STEP_PHASE);
  const [lastDeletedCase, setLastDeletedCase] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    if (typeof window === "undefined") {
      return [];
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem("zhuzhu-test-file-groups") || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  });
  const [savedTestFileSnapshot, setSavedTestFileSnapshot] = useState("");
  const [externalTestFileUpdate, setExternalTestFileUpdate] = useState(null);
  const [isSavingTestFile, setIsSavingTestFile] = useState(false);
  const [isReloadingTestFile, setIsReloadingTestFile] = useState(false);
  const [authoringMode, setAuthoringMode] = useState("visual");
  const [editorText, setEditorText] = useState(() => JSON.stringify(draftToRuntimePayload(createDefaultDraft()), null, 2));
  const [editorError, setEditorError] = useState("");
  const [syncMessage, setSyncMessage] = useState("Visual draft");
  const [result, setResult] = useState(null);
  const [testFileHistory, setTestFileHistory] = useState([]);
  const [historyFocusReportPath, setHistoryFocusReportPath] = useState("");
  const [professionalReportPage, setProfessionalReportPage] = useState({ model: null, returnWorkspace: "test-file", returnTestFileMode: "run" });
  const [buildStepFocusRequest, setBuildStepFocusRequest] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runningTestFilePath, setRunningTestFilePath] = useState(null);
  const [isStoppingRun, setIsStoppingRun] = useState(false);
  const [runProgress, setRunProgress] = useState(() => createRunProgress(createDefaultDraft().steps));
  const [lastRunAt, setLastRunAt] = useState(null);
  const [activityItems, setActivityItems] = useState(() => [
    createActivityItem("system", "Panel booted", "Runtime shell initialized."),
  ]);
  const draftSnapshotRef = useRef(null);
  const syncedDraftSnapshotRef = useRef("");
  const resultSnapshotRef = useRef(null);
  const browserUrlRef = useRef("");
  const currentTestFilePathRef = useRef(null);
  const navInputDirtyRef = useRef(false);
  // Perf: holds this render's latest page handlers; `pageHandlers` delegators
  // read it so memoized pages get stable handler identities (no stale closures).
  const pageHandlersRef = useRef({});
  const sidebarHandlersRef = useRef({});
  // Perf: skip re-rendering the whole App tree when a browser-state push is
  // identical to the last one we applied (belt-and-suspenders on top of the
  // main-process dedup/coalesce for forced or duplicate pushes).
  const lastBrowserStateJsonRef = useRef("");
  const draftSyncSuppressedRef = useRef(false);
  const stopRunRequestedRef = useRef(false);
  const activeRunIdRef = useRef(null);
  const rootRuntimeRunMapRef = useRef(new Map());
  const sidebarResizeMovedRef = useRef(false);
  const executePayloadRef = useRef(null);

  const testFileSnapshot = useMemo(() => JSON.stringify(normalizeTestFile(testFile)), [testFile]);
  const visibleTestFile = useMemo(() => {
    const activeSummary = testFileList.find((item) => item.path === currentTestFilePath);
    if (!activeSummary) {
      return testFile;
    }
    return normalizeTestFile({
      ...testFile,
      createdAt: testFile.createdAt || activeSummary.createdAt,
      updatedAt: testFile.updatedAt || activeSummary.updatedAt,
    });
  }, [currentTestFilePath, testFile, testFileList]);
  const isTestFileDirty = testFileSnapshot !== savedTestFileSnapshot;
  const isCurrentTestFileExternallyUpdated = Boolean(
    currentTestFilePath
      && externalTestFileUpdate?.path
      && externalTestFileUpdate.path === currentTestFilePath,
  );
  const testFileSaveState = isCurrentTestFileExternallyUpdated
    ? (isTestFileDirty ? "conflict" : "external-updated")
    : (isTestFileDirty ? "dirty" : "saved");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("zhuzhu-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.colorTheme = colorTheme;
    window.localStorage.setItem("zhuzhu-color-theme", colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    window.localStorage.setItem("zhuzhu-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem("zhuzhu-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  const handleSidebarResizeStart = (event) => {
    if (sidebarCollapsed || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    sidebarResizeMovedRef.current = false;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    // Perf: drive the resize via the CSS variable directly on the shell during
    // the drag — a per-pointermove setState would re-render the whole App tree
    // (all pages + browser panel) and write localStorage on every pixel. We
    // commit to React state once on pointerup instead.
    const shellEl = document.querySelector('[data-slot="sidebar-wrapper"]');
    let liveWidth = startWidth;

    const handlePointerMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      if (Math.abs(delta) > 3) {
        sidebarResizeMovedRef.current = true;
      }
      liveWidth = clampSidebarWidth(startWidth + delta);
      if (shellEl) {
        shellEl.style.setProperty("--sidebar-width", `${liveWidth}px`);
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      // Single commit: one re-render + one localStorage write for the whole drag.
      setSidebarWidth(liveWidth);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  useEffect(() => {
    window.localStorage.setItem("zhuzhu-test-file-groups", JSON.stringify(collapsedGroups));
  }, [collapsedGroups]);

  useEffect(() => {
    let cancelled = false;
    getPanelPreferences()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPanelPreferences(normalizePanelPreferences(response?.preferences || response));
      })
      .catch(() => {
        if (!cancelled) {
          setPanelPreferences(DEFAULT_PANEL_PREFERENCES);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    currentTestFilePathRef.current = currentTestFilePath;
  }, [currentTestFilePath]);

  useEffect(() => {
    const syncFromHash = () => {
      const nextWorkspace = normalizeWorkspace(window.location.hash.replace("#", ""));
      if (window.location.hash.replace("#", "") === "overview") {
        window.location.hash = "workspace";
      }
      setWorkspace(nextWorkspace);
    };
    window.addEventListener("hashchange", syncFromHash);
    syncFromHash();
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeBrowserState((state) => {
      const serialized = JSON.stringify(state);
      if (serialized === lastBrowserStateJsonRef.current) {
        return;
      }
      lastBrowserStateJsonRef.current = serialized;
      setBrowserState(state);
      setNavInput((current) => {
        const nextUrl = state?.url || state?.requestedUrl || "";
        const previousUrl = browserUrlRef.current;
        browserUrlRef.current = nextUrl;
        if (!navInputDirtyRef.current || !current || current === "about:blank" || current === previousUrl) {
          return nextUrl;
        }
        return current;
      });
    });
    // Coalesce high-frequency run-step events into ONE state update per ~frame
    // instead of a full-App re-render on every step-start/step-complete. During a
    // run these fire rapidly; without batching each one re-renders the whole tree
    // (incl. the 52/92-step list). A short trailing flush keeps progress live.
    let runEventBuffer = [];
    let runEventTimer = null;
    const flushRunEvents = () => {
      runEventTimer = null;
      if (!runEventBuffer.length) {
        return;
      }
      const batch = runEventBuffer;
      runEventBuffer = [];
      setRunProgress((current) => batch.reduce((acc, evt) => applyRuntimeRunEvent(acc, evt), current));
    };
    const unsubscribeRunEvents = subscribeRuntimeRunEvents((event) => {
      const rootRunMeta = event?.runId ? rootRuntimeRunMapRef.current.get(event.runId) : null;
      if (rootRunMeta && !["step-start", "step-complete"].includes(event?.type)) {
        return;
      }
      const progressEvent = rootRunMeta
        ? {
            ...event,
            runId: rootRunMeta.parentRunId,
            childRunId: event.runId,
            rootPhase: rootRunMeta.phase,
          }
        : event;
      // v1.4: surface browser death / memory pressure in the Activity log. These
      // are rare and already throttled at the source, so they bypass the run-event
      // coalescing buffer — the operator should see them immediately, not in 40ms.
      if (event?.type === "browser-crashed") {
        setActivityItems((current) => [
          createActivityItem(
            "system",
            event.code === "browser-oom" ? "Chrome crashed (out of memory)" : "Browser lost",
            [event.crashKind, event.peakHeapUsedMb ? `peak heap ${event.peakHeapUsedMb}MB` : null]
              .filter(Boolean)
              .join(" · "),
          ),
          ...current.slice(0, 11),
        ]);
      } else if (event?.type === "browser-memory-warning") {
        setActivityItems((current) => [
          createActivityItem(
            "system",
            "Browser memory high",
            `JS heap ${event.heapUsedMb}MB (threshold ${event.thresholdMb}MB)`,
          ),
          ...current.slice(0, 11),
        ]);
      } else if (event?.type === "browser-recovering") {
        setActivityItems((current) => [
          createActivityItem(
            "system",
            "Rebuilding browser after crash",
            event.reason || "",
          ),
          ...current.slice(0, 11),
        ]);
      }
      runEventBuffer.push(progressEvent);
      if (runEventTimer === null) {
        runEventTimer = setTimeout(flushRunEvents, 40);
      }
    });
    // v1.8: renderer memory pressure is surfaced, not silent. The panel used
    // to die of OOM with no warning anywhere — the window simply went dark.
    const unsubscribePanelMemory = subscribePanelMemoryWarnings((payload) => {
      setActivityItems((current) => [
        createActivityItem(
          "warning",
          "Panel memory high",
          `${payload?.residentMb ?? "?"}MB resident (threshold ${payload?.thresholdMb ?? "?"}MB) · close finished run reports to release it`,
        ),
        ...current.slice(0, 11),
      ]);
    });
    // v1.9: machine-level pressure. The operator needs this *before* clicking
    // "open browser" — a Chromium that gets OOM-killed on launch looks like a
    // Zhuzhu bug, and the only evidence is a free-memory number nobody showed.
    const unsubscribeHostMemory = subscribeHostMemoryWarnings((payload) => {
      setActivityItems((current) => [
        createActivityItem(
          "warning",
          "Machine memory low",
          `${payload?.freeMb ?? "?"}MB free of ${payload?.totalMb ?? "?"}MB (${payload?.usedPercent ?? "?"}% used) · a visible browser may fail to start until something is closed`,
        ),
        ...current.slice(0, 11),
      ]);
    });
    requestBrowserState();
    void getRuntimeState().then((state) => {
      setRuntimeState(state);
      setActivityItems((current) => [
        createActivityItem(
          state?.available ? "success" : "warning",
          state?.available ? "Runtime ready" : "Runtime unavailable",
          state?.available ? "Runtime bridge is connected." : state?.error?.message || "Bridge is not ready.",
        ),
        ...current,
      ].slice(0, 8));
    });
    return () => {
      unsubscribe();
      unsubscribeRunEvents();
      unsubscribePanelMemory();
      unsubscribeHostMemory();
      if (runEventTimer !== null) {
        clearTimeout(runEventTimer);
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeTestFileChanges((payload) => {
      const changes = Array.isArray(payload?.changes)
        ? payload.changes
        : (payload ? [payload] : []);
      if (!changes.length) {
        return;
      }
      void refreshTestFileList();
      const activePath = currentTestFilePathRef.current;
      if (!activePath) {
        return;
      }
      let activeChange = null;
      for (const change of changes) {
        if (change?.path === activePath) {
          activeChange = change;
        }
      }
      if (!activeChange) {
        return;
      }
      setExternalTestFileUpdate({
        path: activeChange.path,
        eventType: activeChange.eventType || "change",
        updatedAt: activeChange.updatedAt || new Date().toISOString(),
      });
      setActivityItems((current) => [
        createActivityItem("warning", "Test file changed on disk", activeChange.path),
        ...current,
      ].slice(0, 8));
    });
    return unsubscribe;
  }, []);

  const refreshTestFileList = async () => {
    const response = await listTestFiles();
    if (response?.success) {
      setTestFileList(response.files || []);
    }
    return response;
  };

  const refreshRunHistory = async (pathValue = currentTestFilePath) => {
    if (!pathValue) {
      setTestFileHistory([]);
      return null;
    }
    const response = await listRunHistory({ testFilePath: pathValue, limit: 8 });
    if (response?.success) {
      setTestFileHistory(response.runs || []);
    }
    return response;
  };

  const getExecutableStepsForCase = (sourceFile, caseId, options = {}) => {
    try {
      return buildExecutableCaseSteps(sourceFile, caseId, options);
    } catch (_error) {
      return testFileToRuntimeDraft(sourceFile, caseId).steps;
    }
  };

  const buildRunProgressCases = (sourceFile = testFile, options = {}) =>
    (sourceFile?.cases || []).map((caseItem) => ({
      ...caseItem,
      steps: getExecutableStepsForCase(sourceFile, caseItem.id, options),
    }));

  const commitDraftToCurrentTarget = (sourceFile = testFile, sourceDraft = draft) => {
    const sourceDraftSnapshot = JSON.stringify(sourceDraft);
    if (syncedDraftSnapshotRef.current === sourceDraftSnapshot) {
      return sourceFile;
    }
    syncedDraftSnapshotRef.current = sourceDraftSnapshot;
    return writeDraftToBuildTarget(sourceDraft, sourceFile, selectedCaseId, buildTargetType, rootStepPhase);
  };

  const openTestFile = async (relativePath, options = {}) => {
    const response = await readTestFile(relativePath);
    if (!response?.success) {
      setActivityItems((current) => [
        createActivityItem("danger", "Open test file failed", response?.message || response?.error || "read-failed"),
        ...current,
      ].slice(0, 8));
      return;
    }
    const normalized = normalizeTestFile(response.testFile);
    const nextCaseId = getSelectedCaseId(normalized);
    setCurrentTestFilePath(response.path);
    setExternalTestFileUpdate(null);
    setTestFile(normalized);
    setSelectedCaseId(nextCaseId);
    setBuildTargetType("case");
    setRootStepPhase(DEFAULT_ROOT_STEP_PHASE);
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(normalized, nextCaseId, "case", DEFAULT_ROOT_STEP_PHASE));
    setAuthoringMode("visual");
    setSavedTestFileSnapshot(JSON.stringify(normalized));
    setResult(null);
    setRunProgress(
      createRunProgress(testFileToRuntimeDraft(normalized, nextCaseId).steps, null, {
        scope: "file",
        cases: buildRunProgressCases(normalized),
        selectedCaseId: nextCaseId,
      }),
    );
    if (!options.preserveMode) {
      setTestFileMode("view");
    }
    navigatePage("test-file");
    void refreshRunHistory(response.path);
  };

  const reloadCurrentTestFile = async ({ requireConfirm = true } = {}) => {
    const activePath = currentTestFilePathRef.current;
    if (!activePath) {
      return null;
    }
    if (requireConfirm && isTestFileDirty) {
      const confirmed = window.confirm("Reload the current test file from disk? Unsaved local changes will be discarded.");
      if (!confirmed) {
        return null;
      }
    }
    setIsReloadingTestFile(true);
    try {
      await openTestFile(activePath, { preserveMode: true });
      setActivityItems((current) => [
        createActivityItem("success", "Test file reloaded", activePath),
        ...current,
      ].slice(0, 8));
    } finally {
      setIsReloadingTestFile(false);
    }
    return activePath;
  };

  const handleRefreshTestFiles = async () => {
    const response = await refreshTestFileList();
    const activePath = currentTestFilePathRef.current;
    if (!response?.success || !activePath) {
      return response;
    }
    const activeFile = response.files?.find((item) => item.path === activePath && !item.invalid);
    if (activeFile) {
      await reloadCurrentTestFile({ requireConfirm: true });
    }
    return response;
  };

  useEffect(() => {
    void refreshTestFileList().then((response) => {
      const firstFile = response?.files?.find((item) => !item.invalid);
      if (firstFile) {
        void openTestFile(firstFile.path);
        return;
      }
      const initial = runtimeDraftToTestFile(createDefaultDraft(), createTestFileDraft());
      setTestFile(initial);
      const nextCaseId = getSelectedCaseId(initial);
      setSelectedCaseId(nextCaseId);
      setBuildTargetType("case");
      setRootStepPhase(DEFAULT_ROOT_STEP_PHASE);
      draftSyncSuppressedRef.current = true;
      setDraft(getDraftForBuildTarget(initial, nextCaseId, "case", DEFAULT_ROOT_STEP_PHASE));
      setSavedTestFileSnapshot("");
    });
  }, []);

  useEffect(() => {
    if (authoringMode !== "visual") {
      return;
    }
    setEditorText(JSON.stringify(draftToRuntimePayload(draft), null, 2));
    setEditorError("");
    setSyncMessage("Visual draft");
  }, [authoringMode, draft]);

  useEffect(() => {
    const draftSnapshot = JSON.stringify(draft);
    if (draftSyncSuppressedRef.current) {
      draftSyncSuppressedRef.current = false;
      syncedDraftSnapshotRef.current = draftSnapshot;
      return;
    }
    if (syncedDraftSnapshotRef.current === draftSnapshot) {
      return;
    }
    syncedDraftSnapshotRef.current = draftSnapshot;
    setTestFile((current) => writeDraftToBuildTarget(draft, current, selectedCaseId, buildTargetType, rootStepPhase));
  }, [draft, selectedCaseId, buildTargetType, rootStepPhase]);

  useEffect(() => {
    const snapshot = JSON.stringify({
      count: draft.steps.length,
      types: draft.steps.map((step) => step.type),
    });
    if (draftSnapshotRef.current == null) {
      draftSnapshotRef.current = snapshot;
      return;
    }
    if (draftSnapshotRef.current !== snapshot) {
      draftSnapshotRef.current = snapshot;
      setActivityItems((current) => [
        createActivityItem("draft", "Payload updated", `${draft.steps.length} steps in the current flow.`),
        ...current,
      ].slice(0, 8));
    }
  }, [draft]);

  useEffect(() => {
    const sourceFile = commitDraftToCurrentTarget();
    const nextSteps =
      authoringMode === "expert" && buildTargetType === "case"
        ? draft.steps
        : getExecutableStepsForCase(sourceFile, selectedCaseId);
    setRunProgress((current) => syncRunProgressSteps(current, nextSteps));
  }, [authoringMode, draft, selectedCaseId, testFile, buildTargetType, rootStepPhase]);

  useEffect(() => {
    const snapshot = result ? JSON.stringify({ ok: result.ok, error: result.error?.message, dir: result.evidence?.runDir }) : null;
    if (resultSnapshotRef.current == null) {
      resultSnapshotRef.current = snapshot;
      return;
    }
    if (snapshot && resultSnapshotRef.current !== snapshot) {
      resultSnapshotRef.current = snapshot;
      setActivityItems((current) => [
        createActivityItem(
          result.ok ? "success" : "danger",
          result.ok ? "Run completed" : "Run failed",
          result.ok ? `Duration ${result.telemetry?.durationMs ?? "-"} ms.` : result.error?.message || "Execution failed.",
        ),
        ...current,
      ].slice(0, 8));
    }
  }, [result]);

  const previewPayload = useMemo(() => draftToRuntimePayload(draft), [draft]);
  const draftWarnings = useMemo(() => getDraftWarnings(draft), [draft]);

  const updateStep = (stepId, updater) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? updater(step) : step)),
    }));
  };

  const handleStepFieldChange = (stepId, field, value) => {
    updateStep(stepId, (step) => {
      const next = { ...step, [field]: value };
      if (field === "type") {
        next.needRes = true;
        next.strictMatch = value === "assertVisible";
      }
      if (field === "type" && (value === "comboSearchSelect" || value === "cascaderSelect")) {
        next.optionMatch = next.optionMatch || "contains";
        next.role = next.role || "combobox";
      }
      if (field === "type" && value === "uploadFile") {
        next.uploadMode = next.uploadMode || "chooser";
      }
      return next;
    });
  };

  const handleStepExpectationChange = (stepId, value) => {
    updateStep(stepId, (step) => ({ ...step, expectation: value }));
  };

  const handleAddStep = (type) => {
    const nextStep = createEmptyStep(type);
    setDraft((current) => ({
      ...current,
      steps: [...current.steps, nextStep],
    }));
    return nextStep.id;
  };

  const handleDuplicateStep = (stepId) => {
    setDraft((current) => {
      const nextSteps = [];
      current.steps.forEach((step) => {
        nextSteps.push(step);
        if (step.id === stepId) {
          const duplicate = cloneStep(step);
          duplicate.id = `${step.id}-copy-${Date.now()}`;
          nextSteps.push(duplicate);
        }
      });
      return { ...current, steps: nextSteps };
    });
  };

  const handleRemoveStep = (stepId) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.filter((step) => step.id !== stepId),
    }));
  };

  const handleSortStep = (oldIndex, newIndex) => {
    setDraft((current) => {
      if (oldIndex === newIndex) {
        return current;
      }
      const nextSteps = [...current.steps];
      if (
        oldIndex < 0 ||
        oldIndex >= nextSteps.length ||
        newIndex < 0 ||
        newIndex >= nextSteps.length
      ) {
        return current;
      }
      const [item] = nextSteps.splice(oldIndex, 1);
      nextSteps.splice(newIndex, 0, item);
      return { ...current, steps: nextSteps };
    });
  };

  const handleEditorTextChange = (value) => {
    setAuthoringMode("expert");
    setEditorText(value);
    try {
      const nextDraft = runtimePayloadToDraft(parseLooseJson(value));
      setDraft(nextDraft);
      setEditorError("");
      setSyncMessage("JSON synced");
    } catch (error) {
      setEditorError(error.message || String(error));
      setSyncMessage("Waiting for valid JSON");
    }
  };

  const navigatePage = (nextPage) => {
    const normalized = normalizeWorkspace(nextPage);
    window.location.hash = normalized;
    setWorkspace(normalized);
  };

  const openProfessionalReport = (model) => {
    if (!model) {
      return;
    }
    setProfessionalReportPage({
      model,
      returnWorkspace: workspace,
      returnTestFileMode: workspace === "test-file" ? testFileMode : "",
    });
    navigatePage("report");
  };

  const closeProfessionalReport = () => {
    const returnWorkspace = professionalReportPage.returnWorkspace || "test-file";
    if (returnWorkspace === "test-file" && professionalReportPage.returnTestFileMode) {
      setTestFileMode(professionalReportPage.returnTestFileMode);
    }
    navigatePage(returnWorkspace);
  };

  const openHistoryRun = (reportPath) => {
    if (reportPath) {
      setHistoryFocusReportPath(reportPath);
    }
    setTestFileMode("history");
    navigatePage("test-file");
  };

  const openBuildStep = ({ caseId = "", stepId = "", phase = "", runSnapshot = null } = {}) => {
    if (!stepId) {
      return;
    }
    const committedFile = commitDraftToCurrentTarget();
    const normalizedPhase = String(phase || "");
    const rootPhase = normalizedPhase.includes("teardown") ? "teardown" : "setup";
    const isRootFailure = !caseId && (normalizedPhase === "setup" || normalizedPhase === "teardown" || normalizedPhase.startsWith("root"));
    setTestFile(committedFile);
    setAuthoringMode("visual");
    if (isRootFailure) {
      setBuildTargetType("root");
      setRootStepPhase(rootPhase);
      draftSyncSuppressedRef.current = true;
      setDraft(getDraftForBuildTarget(committedFile, selectedCaseId, "root", rootPhase));
    } else {
      const nextCaseId = getSelectedCaseId(committedFile, caseId || selectedCaseId);
      setSelectedCaseId(nextCaseId);
      setBuildTargetType("case");
      draftSyncSuppressedRef.current = true;
      setDraft(getDraftForBuildTarget(committedFile, nextCaseId, "case", rootStepPhase));
    }
    setBuildStepFocusRequest({
      id: `${Date.now()}-${stepId}`,
      caseId,
      stepId,
      phase: normalizedPhase,
    });
    if (runSnapshot?.selectedRun) {
      setResult(runSnapshot.reportData?.report?.summary || runSnapshot.selectedRun || null);
      setRunProgress(restoreRunProgressFromHistory(committedFile, runSnapshot, caseId, {
        stepId,
        phase: normalizedPhase,
      }));
      setLastRunAt(runSnapshot.selectedRun.finishedAt || runSnapshot.selectedRun.startedAt || Date.now());
    }
    setTestFileMode("build-cases");
    navigatePage("test-file");
  };

  const handleTestFileMetaChange = (field, value) => {
    setTestFile((current) => {
      if (field.startsWith("requirement.")) {
        const key = field.replace("requirement.", "");
        return normalizeTestFile({
          ...current,
          requirement: {
            ...(current.requirement || {}),
            [key]: value,
          },
        });
      }
      if (field.startsWith("settings.")) {
        const key = field.replace("settings.", "");
        return normalizeTestFile({
          ...current,
          settings: {
            ...(current.settings || {}),
            [key]: value,
          },
        });
      }
      return normalizeTestFile({ ...current, [field]: value });
    });
  };

  const handleTestFileModeChange = (mode) => {
    setTestFileMode(mode);
    navigatePage("test-file");
  };

  const handleSelectCase = (caseId) => {
    if (buildTargetType === "case" && selectedCaseId === caseId) {
      return;
    }
    const committedFile = commitDraftToCurrentTarget();
    const nextCaseId = getSelectedCaseId(committedFile, caseId);
    setTestFile(committedFile);
    setSelectedCaseId(nextCaseId);
    setBuildTargetType("case");
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(committedFile, nextCaseId, "case", rootStepPhase));
    setAuthoringMode("visual");
  };

  const handleSelectRootSteps = (phase = rootStepPhase) => {
    const nextPhase = normalizeRootStepPhase(phase);
    if (buildTargetType === "root" && rootStepPhase === nextPhase) {
      return;
    }
    const committedFile = commitDraftToCurrentTarget();
    setTestFile(committedFile);
    setBuildTargetType("root");
    setRootStepPhase(nextPhase);
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(committedFile, selectedCaseId, "root", nextPhase));
    setAuthoringMode("visual");
  };

  const handleRootStepPhaseChange = (phase) => {
    const nextPhase = normalizeRootStepPhase(phase);
    if (rootStepPhase === nextPhase) {
      return;
    }
    const committedFile = commitDraftToCurrentTarget();
    setTestFile(committedFile);
    setRootStepPhase(nextPhase);
    setBuildTargetType("root");
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(committedFile, selectedCaseId, "root", nextPhase));
    setAuthoringMode("visual");
  };

  const handleCaseMetaChange = (caseId, field, value) => {
    setTestFile((current) =>
      normalizeTestFile({
        ...current,
        cases: current.cases.map((item) =>
          item.id === caseId
            ? {
                ...item,
                [field]: value,
              }
            : item,
        ),
      }),
    );
  };

  const handleSharedStepPatch = (source = {}, _stepId = "", patch = {}) => {
    if (!source?.type || !patch || !Object.keys(patch).length) {
      return;
    }
    const committedFile = commitDraftToCurrentTarget();
    let nextFile = committedFile;
    if (source.type === "fixture" && source.fixtureName && source.fixturePhase) {
      const fixture = committedFile.fixtures?.[source.fixtureName];
      const groupKey = source.fixturePhase === "teardown" ? "teardown" : "setup";
      const groupSteps = Array.isArray(fixture?.[groupKey]) ? fixture[groupKey] : [];
      if (!fixture || !Number.isInteger(source.index) || source.index < 0 || source.index >= groupSteps.length) {
        return;
      }
      const nextSteps = groupSteps.map((step, index) =>
        index === source.index ? { ...patch, id: patch.id || step.id } : step,
      );
      nextFile = normalizeTestFile({
        ...committedFile,
        fixtures: {
          ...(committedFile.fixtures || {}),
          [source.fixtureName]: {
            ...fixture,
            [groupKey]: nextSteps,
          },
        },
      });
    }
    if (source.type === "macro" && source.macroName) {
      const macro = committedFile.macros?.[source.macroName];
      const macroSteps = Array.isArray(macro?.steps) ? macro.steps : [];
      if (!macro || !Number.isInteger(source.index) || source.index < 0 || source.index >= macroSteps.length) {
        return;
      }
      const nextSteps = macroSteps.map((step, index) =>
        index === source.index ? { ...patch, id: patch.id || step.id } : step,
      );
      nextFile = normalizeTestFile({
        ...committedFile,
        macros: {
          ...(committedFile.macros || {}),
          [source.macroName]: {
            ...macro,
            steps: nextSteps,
          },
        },
      });
    }
    if (nextFile !== committedFile) {
      setTestFile(nextFile);
      draftSyncSuppressedRef.current = true;
      setDraft(getDraftForBuildTarget(nextFile, selectedCaseId, buildTargetType, rootStepPhase));
    }
  };

  const handleAddCase = () => {
    const committedFile = commitDraftToCurrentTarget();
    const nextCase = createCaseDraft({
      id: `case-${Date.now().toString(36)}`,
      name: `新用例 ${committedFile.cases.length + 1}`,
      priority: "P1",
    });
    const nextFile = normalizeTestFile({ ...committedFile, cases: [...committedFile.cases, nextCase] });
    setTestFile(nextFile);
    setSelectedCaseId(nextCase.id);
    setBuildTargetType("case");
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(nextFile, nextCase.id, "case", rootStepPhase));
    setAuthoringMode("visual");
  };

  const handleDuplicateCase = (caseId) => {
    const committedFile = commitDraftToCurrentTarget();
    const sourceCase = committedFile.cases.find((item) => item.id === caseId);
    if (!sourceCase) {
      return;
    }
    const nextCase = createCaseDraft({
      ...sourceCase,
      id: `${sourceCase.id}-copy-${Date.now().toString(36)}`,
      name: `${sourceCase.name} Copy`,
    });
    const nextFile = normalizeTestFile({ ...committedFile, cases: [...committedFile.cases, nextCase] });
    setTestFile(nextFile);
    setSelectedCaseId(nextCase.id);
    setBuildTargetType("case");
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(nextFile, nextCase.id, "case", rootStepPhase));
    setAuthoringMode("visual");
  };

  const handleRemoveCase = (caseId) => {
    const committedFile = commitDraftToCurrentTarget();
    if (committedFile.cases.length <= 1) {
      return;
    }
    const removedCase = committedFile.cases.find((item) => item.id === caseId);
    if (!removedCase) {
      return;
    }
    const confirmed = window.confirm(`Delete case "${removedCase.name || caseId}"? This only changes the current draft until you save.`);
    if (!confirmed) {
      return;
    }
    const removedIndex = Math.max(0, committedFile.cases.findIndex((item) => item.id === caseId));
    const nextCases = committedFile.cases.filter((item) => item.id !== caseId);
    const nextFile = normalizeTestFile({ ...committedFile, cases: nextCases });
    const nextCaseId = getSelectedCaseId(nextFile, selectedCaseId === caseId ? null : selectedCaseId);
    setLastDeletedCase({
      filePath: currentTestFilePath,
      caseItem: removedCase,
      index: removedIndex,
    });
    setTestFile(nextFile);
    setSelectedCaseId(nextCaseId);
    setBuildTargetType("case");
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(nextFile, nextCaseId, "case", rootStepPhase));
    setAuthoringMode("visual");
  };

  const handleRestoreDeletedCase = () => {
    if (!lastDeletedCase?.caseItem || lastDeletedCase.filePath !== currentTestFilePath) {
      return;
    }
    const committedFile = commitDraftToCurrentTarget();
    const restoredCase = lastDeletedCase.caseItem;
    const nextCases = [...committedFile.cases];
    const hasSameId = nextCases.some((item) => item.id === restoredCase.id);
    const safeCase = hasSameId
      ? createCaseDraft({
          ...restoredCase,
          id: `${restoredCase.id}-restored-${Date.now().toString(36)}`,
        })
      : restoredCase;
    const insertAt = Math.min(Math.max(lastDeletedCase.index ?? nextCases.length, 0), nextCases.length);
    nextCases.splice(insertAt, 0, safeCase);
    const nextFile = normalizeTestFile({ ...committedFile, cases: nextCases });
    setTestFile(nextFile);
    setSelectedCaseId(safeCase.id);
    setBuildTargetType("case");
    draftSyncSuppressedRef.current = true;
    setDraft(getDraftForBuildTarget(nextFile, safeCase.id, "case", rootStepPhase));
    setAuthoringMode("visual");
    setLastDeletedCase(null);
  };

  const handleSaveTestFile = async () => {
    setIsSavingTestFile(true);
    try {
      const fileToSave = commitDraftToCurrentTarget();
      setTestFile(fileToSave);
      const response = await saveTestFile({
        path: currentTestFilePath,
        testFile: fileToSave,
      });
      if (!response?.success) {
        throw new Error(response?.message || response?.error || "save-failed");
      }
      const normalized = normalizeTestFile(response.testFile);
      const nextCaseId = getSelectedCaseId(normalized, selectedCaseId);
      setCurrentTestFilePath(response.path);
      setExternalTestFileUpdate(null);
      setTestFile(normalized);
      setSelectedCaseId(nextCaseId);
      draftSyncSuppressedRef.current = true;
      setDraft(getDraftForBuildTarget(normalized, nextCaseId, buildTargetType, rootStepPhase));
      setSavedTestFileSnapshot(JSON.stringify(normalized));
      await refreshTestFileList();
      setActivityItems((current) => [
        createActivityItem("success", "Test file saved", response.path),
        ...current,
      ].slice(0, 8));
    } catch (error) {
      setActivityItems((current) => [
        createActivityItem("danger", "Save test file failed", error.message || String(error)),
        ...current,
      ].slice(0, 8));
    } finally {
      setIsSavingTestFile(false);
    }
  };

  const handleCreateTestFile = async (targetGroup = null) => {
    const group = typeof targetGroup === "string" ? targetGroup.trim() : (testFile.group || "");
    const response = await createTestFile({
      testFile: createTestFileDraft({
        name: "New test file",
        baseUrl: browserState?.url || browserState?.requestedUrl || testFile.baseUrl,
        group,
      }),
    });
    if (!response?.success) {
      setActivityItems((current) => [
        createActivityItem("danger", "Create test file failed", response?.message || response?.error || "create-failed"),
        ...current,
      ].slice(0, 8));
      return;
    }
    if (group) {
      setCollapsedGroups((current) => current.filter((item) => item !== group));
    }
    await refreshTestFileList();
    await openTestFile(response.path);
    setTestFileMode("edit-file");
    navigatePage("test-file");
  };

  const handleDuplicateTestFile = async (file) => {
    if (!file?.path) {
      return;
    }
    const response = await copyTestFile({ path: file.path });
    if (!response?.success) {
      setActivityItems((current) => [
        createActivityItem("danger", "Copy test file failed", response?.message || response?.error || "copy-failed"),
        ...current,
      ].slice(0, 8));
      return;
    }
    await refreshTestFileList();
    setActivityItems((current) => [
      createActivityItem("success", "Test file copied", response.path),
      ...current,
    ].slice(0, 8));
  };

  const handleCreateFolder = async () => {
    if (typeof window === "undefined") {
      return;
    }
    const group = window.prompt("Folder name");
    const normalizedGroup = String(group || "").trim();
    if (!normalizedGroup) {
      return;
    }
    await handleCreateTestFile(normalizedGroup);
  };

  const handleApplyTemplate = (payload) => {
    const committedFile = commitDraftToCurrentTarget();
    setTestFile(committedFile);
    const nextDraft = createDraftFromTemplate(payload);
    setBuildTargetType("case");
    setDraft(nextDraft);
    setAuthoringMode("visual");
    setTestFileMode("build-cases");
    navigatePage("test-file");
  };

	  const buildExecutionPayload = ({
	    caseItem,
	    stepId = null,
    sourceDraft = draft,
    useExpertSource = true,
    sourceFile = testFile,
    sourceTargetType = "case",
    executableOptions = {},
  }) => {
    if (!stepId && useExpertSource && authoringMode === "expert") {
      return editorText;
    }
    const executionFile =
      sourceTargetType === "file"
        ? normalizeTestFile(sourceFile)
        : runtimeDraftToTestFile(sourceDraft, sourceFile, caseItem?.id || selectedCaseId);
	    const executableSteps = buildExecutableCaseSteps(
	      executionFile,
	      caseItem?.id || selectedCaseId,
	      stepId ? { ...executableOptions, stepId } : executableOptions,
	    );
    const debugCase = executionFile.cases?.find((item) => item.id === (caseItem?.id || selectedCaseId));
    const payloadDebug = {
      caseId: caseItem?.id || selectedCaseId,
      stepId,
      sourceTargetType,
      executableOptions,
      executionCaseFixtures: debugCase?.fixtures || [],
      executionFixtureKeys: Object.keys(executionFile.fixtures || {}),
      stepCount: executableSteps.length,
      steps: executableSteps.slice(0, 5).map(summarizeRunDebugStep),
    };
	    if (!executableSteps.length) {
	      console.warn("[App][Run:payload-empty]", payloadDebug);
      writeRunDebugLog("app.payload-empty", payloadDebug);
	    } else {
	      console.info("[App][Run:payload]", payloadDebug);
      writeRunDebugLog("app.payload", payloadDebug);
	    }
	    if (!executableSteps.length) {
	      return null;
	    }
    return JSON.stringify(executableSteps);
  };

  const buildRootExecutionSteps = (sourceFile, phase = "setup") => {
    const firstCaseId = sourceFile?.cases?.[0]?.id || selectedCaseId;
    if (!firstCaseId) {
      return [];
    }
    return buildExecutableCaseSteps(sourceFile, firstCaseId, {
      includeRootSetup: phase === "setup",
      includeFixtureSetup: false,
      includeCaseSteps: false,
      includeFixtureTeardown: false,
      includeRootTeardown: phase === "teardown",
    });
  };

  const getReportInputSteps = (report = {}) => {
    if (Array.isArray(report.input)) {
      return report.input;
    }
    if (report.input && typeof report.input === "object") {
      return Object.values(report.input).filter(Boolean);
    }
    return [];
  };

  const getHistoryStepId = (step = {}) => step.stepId || step.id || step.input?.id || "";

  const getHistoryStepIdentity = (step = {}, fallbackIndex = "") => getRunStepIdentity({
    stepId: getHistoryStepId(step),
    phase: step.phase || step.input?.phase || step.raw?.input?.phase || "case",
    sourceFixture: step.sourceFixture || step.input?.sourceFixture || step.raw?.input?.sourceFixture || "",
    sourceMacro: step.sourceMacro || step.input?.sourceMacro || step.raw?.input?.sourceMacro || "",
  }, fallbackIndex);

  const getHistoryPayloadPhase = (payload = {}) => {
    const report = payload.report || {};
    const summary = payload.summary || {};
    const phase = report.runContext?.phase || summary.runContext?.phase || "";
    if (phase) {
      return phase;
    }
    const source = [payload.path, summary.reportPath, summary.runDir].filter(Boolean).join("/");
    if (/-root-setup(?:\/|$)/.test(source)) {
      return "root-setup";
    }
    if (/-root-teardown(?:\/|$)/.test(source)) {
      return "root-teardown";
    }
    return report.testContext?.caseId || summary.caseId ? "case" : "";
  };

  const buildHistoryStepStates = (sourceSteps = [], payload = {}, fallbackFailure = null) => {
    const report = payload.report || {};
    const summary = payload.summary || {};
    const inputSteps = getReportInputSteps(report);
    const evidenceSteps = Array.isArray(report.evidence?.steps)
      ? report.evidence.steps
      : [];
    let firstFailure = summary.firstFailure || report.summary?.error || fallbackFailure || null;
    if (firstFailure && fallbackFailure?.stepId && !firstFailure.stepId) {
      firstFailure = {
        ...firstFailure,
        stepId: fallbackFailure.stepId,
        stepTitle: firstFailure.stepTitle || fallbackFailure.stepTitle,
        phase: firstFailure.phase || fallbackFailure.phase,
        caseId: firstFailure.caseId || fallbackFailure.caseId,
        beforeScreenshotPath: firstFailure.beforeScreenshotPath || fallbackFailure.beforeScreenshotPath,
        afterScreenshotPath: firstFailure.afterScreenshotPath || fallbackFailure.afterScreenshotPath,
        tracePath: firstFailure.tracePath || fallbackFailure.tracePath,
      };
    }
    const failedStepId = firstFailure?.stepId || null;
    const failedIndex = failedStepId
      ? inputSteps.findIndex((step) =>
          getHistoryStepId(step) === failedStepId &&
          (!firstFailure?.phase || (step.phase || step.input?.phase || "case") === firstFailure.phase) &&
          (!firstFailure?.sourceFixture || (step.sourceFixture || step.input?.sourceFixture || "") === firstFailure.sourceFixture) &&
          (!firstFailure?.sourceMacro || (step.sourceMacro || step.input?.sourceMacro || "") === firstFailure.sourceMacro))
      : -1;
    const reportFailed = summary.status === "failed" || report.summary?.ok === false || Boolean(firstFailure);
    const executedCount = evidenceSteps.length || (failedIndex >= 0 ? failedIndex + 1 : inputSteps.length);
    const inputIndexByIdentity = new Map(
      inputSteps.map((step, index) => [getHistoryStepIdentity(step, index), index]).filter(([identity]) => identity),
    );
    const inputIndexesByStepId = new Map();
    inputSteps.forEach((step, index) => {
      const stepId = getHistoryStepId(step);
      if (!stepId) {
        return;
      }
      const matches = inputIndexesByStepId.get(stepId) || [];
      matches.push(index);
      inputIndexesByStepId.set(stepId, matches);
    });

    return sourceSteps.map((step, sourceIndex) => {
      const inputIndexByExactIdentity = inputIndexByIdentity.get(getHistoryStepIdentity(step, sourceIndex));
      const idMatches = inputIndexesByStepId.get(getHistoryStepId(step)) || [];
      const inputIndex = Number.isInteger(inputIndexByExactIdentity)
        ? inputIndexByExactIdentity
        : idMatches.length === 1
          ? idMatches[0]
          : null;
      if (!Number.isInteger(inputIndex)) {
        return step;
      }
      const evidence = evidenceSteps[inputIndex] || null;
      if (failedIndex >= 0 && inputIndex === failedIndex) {
        return {
          ...step,
          status: "failed",
          message: firstFailure?.message || "",
          error: firstFailure || null,
          durationMs: null,
          evidence: {
            ...(evidence || {}),
            beforeScreenshotPath: firstFailure?.beforeScreenshotPath || evidence?.beforeScreenshotPath || "",
            afterScreenshotPath: firstFailure?.afterScreenshotPath || evidence?.afterScreenshotPath || "",
            tracePath: firstFailure?.tracePath || evidence?.tracePath || "",
            ocrPath: evidence?.ocrPath || "",
          },
        };
      }
      if (!reportFailed || failedIndex < 0 || inputIndex < failedIndex) {
        return {
          ...step,
          status: "passed",
          message: "",
          error: null,
          durationMs: null,
          evidence,
        };
      }
      if (inputIndex >= executedCount) {
        return {
          ...step,
          status: "skipped",
          message: "Skipped after an earlier failure in this history run.",
          error: null,
          durationMs: null,
          evidence: null,
        };
      }
      return {
        ...step,
        status: "skipped",
        message: "",
        error: null,
        durationMs: null,
        evidence,
      };
    });
  };

  const restoreRunProgressFromHistory = (sourceFile, runSnapshot = {}, focusCaseId = "", focusFailure = {}) => {
    const selectedRun = runSnapshot.selectedRun || {};
    const reportPayloads = Array.isArray(runSnapshot.reportData?.reports)
      ? runSnapshot.reportData.reports.filter((payload) => payload?.success && payload.report)
      : [];
    const runId = `history-${selectedRun.id || selectedRun.reportPath || Date.now()}`;
    const rootProgressSteps = createRunProgress([
      ...buildRootExecutionSteps(sourceFile, "setup"),
      ...buildRootExecutionSteps(sourceFile, "teardown"),
    ], runId, { scope: "file" }).steps;
    const selectedProgressCaseId = getSelectedCaseId(sourceFile, focusCaseId || selectedRun.firstFailure?.caseId || selectedRun.caseId || selectedCaseId);
    let nextProgress = createRunProgress(rootProgressSteps, runId, {
      scope: "file",
      cases: buildRunProgressCases(sourceFile, {
        includeRootSetup: false,
        includeRootTeardown: false,
      }),
      selectedCaseId: selectedProgressCaseId,
    });
    let nextRootSteps = rootProgressSteps;
    const selectedStatus = selectedRun.status === "passed" ? "success" : selectedRun.status || "idle";
    const fallbackFailure = selectedRun.firstFailure || focusFailure.stepId
      ? {
          ...(selectedRun.firstFailure || {}),
          ...(focusFailure.stepId ? { stepId: focusFailure.stepId } : {}),
          ...(focusFailure.phase ? { phase: focusFailure.phase } : {}),
          ...(focusFailure.sourceFixture ? { sourceFixture: focusFailure.sourceFixture } : {}),
          ...(focusFailure.sourceMacro ? { sourceMacro: focusFailure.sourceMacro } : {}),
          ...(focusCaseId ? { caseId: focusCaseId } : {}),
        }
      : null;

    const nextCases = nextProgress.cases.map((caseItem) => {
      const payload = reportPayloads.find((item) => {
        const context = item.report?.testContext || {};
        const summary = item.summary || {};
        return (context.caseId || summary.caseId) === caseItem.caseId;
      });
      const effectivePayload = payload || (fallbackFailure?.caseId === caseItem.caseId
        ? {
            report: {
              input: caseItem.steps,
              summary: { ok: false },
              evidence: { steps: [] },
            },
            summary: {
              status: "failed",
              firstFailure: fallbackFailure,
            },
          }
        : null);
      if (!effectivePayload) {
        return caseItem;
      }
      const firstFailure = effectivePayload.summary?.firstFailure || (fallbackFailure?.caseId === caseItem.caseId ? fallbackFailure : null);
      const steps = buildHistoryStepStates(caseItem.steps, effectivePayload, firstFailure);
      const failed = steps.find((step) => step.status === "failed") || null;
      const hasSkipped = steps.some((step) => step.status === "skipped");
      const status = failed
        ? "failed"
        : hasSkipped
          ? "skipped"
          : effectivePayload.summary?.status === "passed" || effectivePayload.report?.summary?.ok === true
            ? "passed"
            : effectivePayload.summary?.status || "pending";
      return {
        ...caseItem,
        status,
        steps,
        completedSteps: steps.filter((step) => ["passed", "failed", "skipped"].includes(step.status)).length,
        failedSteps: failed ? 1 : 0,
        durationMs: effectivePayload.report?.telemetry?.durationMs ?? effectivePayload.summary?.durationMs ?? null,
        error: failed?.error || null,
        result: effectivePayload.report?.summary || null,
        runId: effectivePayload.report?.runId || effectivePayload.summary?.runId || runId,
        startedAt: effectivePayload.report?.startedAt || effectivePayload.summary?.startedAt || null,
        finishedAt: effectivePayload.report?.finishedAt || effectivePayload.summary?.finishedAt || null,
      };
    });

    reportPayloads.forEach((payload) => {
      const phase = getHistoryPayloadPhase(payload);
      if (phase !== "root-setup" && phase !== "root-teardown") {
        return;
      }
      const rootPhase = phase === "root-teardown" ? "teardown" : "setup";
      nextRootSteps = buildHistoryStepStates(
        nextRootSteps,
        {
          ...payload,
          report: {
            ...(payload.report || {}),
            input: getReportInputSteps(payload.report).filter((step) => (step?.phase || rootPhase) === rootPhase),
          },
        },
        fallbackFailure,
      );
    });

    const selectedCaseProgress = nextCases.find((caseItem) => caseItem.caseId === selectedProgressCaseId) || nextCases[0] || null;
    const selectedSteps = selectedCaseProgress?.steps || nextProgress.steps;
    const failedStepIndex = selectedSteps.findIndex((step) => step.status === "failed");
    return {
      ...nextProgress,
      scope: "file",
      runId,
      status: selectedStatus,
      currentCaseId: selectedProgressCaseId,
      currentCaseRunId: null,
      currentStepIndex: failedStepIndex >= 0 ? failedStepIndex : null,
      cases: nextCases,
      steps: selectedSteps,
      rootSteps: nextRootSteps,
      error: fallbackFailure,
      result: runSnapshot.reportData?.report?.summary || selectedRun || null,
      startedAt: selectedRun.startedAt || null,
      finishedAt: selectedRun.finishedAt || null,
      lastEvent: {
        type: "history-restore",
        runId,
        reportPath: selectedRun.reportPath || "",
      },
    };
  };

  const runOneCase = async ({
    caseItem,
    sourceDraft,
    stepId = null,
    runId,
    runtimeVariables = null,
    runtimeVariableSources = null,
    stopOnFailure = true,
    includeRootSteps = true,
    navigateToBaseUrlBeforeRun = true,
    runContext = null,
    useExpertSource = true,
    navigateToBaseUrl = false,
	    sourceFile = testFile,
    sourcePath = currentTestFilePath,
	    sourceTargetType = "case",
	    executableOptions = {},
	    checkpoint = null,
	    resume = null,
	  }) => {
    const payload = buildExecutionPayload({
      caseItem,
      stepId,
      sourceDraft,
      useExpertSource,
      sourceFile,
      sourceTargetType,
      executableOptions,
    });
    if (!payload) {
      throw new Error("step-not-found");
    }
    const runUrl = typeof sourceFile?.baseUrl === "string" && sourceFile.baseUrl.trim()
      ? sourceFile.baseUrl.trim()
      : null;
    const evidenceProfile = getTestFileEvidenceProfile(sourceFile);
    const fileRuntimeVariables = {
      ...(sourceFile?.vars || {}),
      ...(runtimeVariables || {}),
    };
    const fileRuntimeVariableSources = {
      ...Object.fromEntries(Object.keys(sourceFile?.vars || {}).map((key) => [key, "file"])),
      ...(runtimeVariableSources || Object.fromEntries(Object.keys(runtimeVariables || {}).map((key) => [key, "override"]))),
    };
    return runRuntimePayload({
      payload,
      options: {
        runId,
        evidenceProfile,
        ...(runUrl ? { fallbackUrl: runUrl } : {}),
        ...(navigateToBaseUrl && runUrl ? { url: runUrl } : {}),
        // v1.2.1 recovery model: carry the file's recovery handlers so run() can
        // log in on demand (proactive on /login, reactive on a session loss).
        ...(sourceFile?.recovery && Object.keys(sourceFile.recovery).length ? { recovery: sourceFile.recovery } : {}),
        // v1.5: forward the file's settings verbatim; the main process expands
        // them into the trust-gate run options (page-error gate, environment
        // freshness, download capture) via the single shared mapping.
        ...(sourceFile?.settings ? { testFileSettings: sourceFile.settings } : {}),
        // v1.11 REQ-Z30: the case's own viewport; main resolves case > file.
        ...(caseItem?.viewport ? { caseViewport: caseItem.viewport } : {}),
        ...(checkpoint ? { checkpoint } : {}),
        ...(resume ? { resume } : {}),
        ...(Object.keys(fileRuntimeVariables).length ? { runtimeVariables: fileRuntimeVariables } : {}),
        ...(Object.keys(fileRuntimeVariableSources).length ? { runtimeVariableSources: fileRuntimeVariableSources } : {}),
        stopOnFailure,
        stopAfterCaseFailure: stopOnFailure,
        includeRootSteps,
        navigateToBaseUrlBeforeRun,
        ...(runContext ? { runContext } : {}),
	        testContext: {
	          testFileId: sourceFile?.id || null,
	          testFilePath: sourcePath || null,
	          testFileName: sourceFile?.name || null,
          evidenceProfile,
          caseId: caseItem?.id || null,
          caseName: caseItem?.name || null,
        },
      },
    });
  };

  const runRootSteps = async ({
    steps,
    runId,
    sourceFile = testFile,
    runtimeVariables = null,
    runtimeVariableSources = null,
	    runContext = null,
	    navigateToBaseUrl = false,
    sourcePath = currentTestFilePath,
	  }) => {
    if (!steps.length) {
      return { ok: true, type: "root-empty", data: { results: [] }, telemetry: { durationMs: 0, steps: 0 } };
    }
    const runUrl = typeof sourceFile?.baseUrl === "string" && sourceFile.baseUrl.trim()
      ? sourceFile.baseUrl.trim()
      : null;
    const evidenceProfile = getTestFileEvidenceProfile(sourceFile);
    const fileRuntimeVariables = {
      ...(sourceFile?.vars || {}),
      ...(runtimeVariables || {}),
    };
    const fileRuntimeVariableSources = {
      ...Object.fromEntries(Object.keys(sourceFile?.vars || {}).map((key) => [key, "file"])),
      ...(runtimeVariableSources || Object.fromEntries(Object.keys(runtimeVariables || {}).map((key) => [key, "override"]))),
    };
    return runRuntimePayload({
      payload: JSON.stringify(steps),
      options: {
        runId,
        evidenceProfile,
        ...(runUrl ? { fallbackUrl: runUrl } : {}),
        ...(navigateToBaseUrl && runUrl ? { url: runUrl } : {}),
        ...(sourceFile?.recovery && Object.keys(sourceFile.recovery).length ? { recovery: sourceFile.recovery } : {}),
        ...(sourceFile?.settings ? { testFileSettings: sourceFile.settings } : {}),
        stopAfterScaffoldFailure: true,
        ...(Object.keys(fileRuntimeVariables).length ? { runtimeVariables: fileRuntimeVariables } : {}),
        ...(Object.keys(fileRuntimeVariableSources).length ? { runtimeVariableSources: fileRuntimeVariableSources } : {}),
        ...(runContext ? { runContext } : {}),
	        testContext: {
	          testFileId: sourceFile?.id || null,
	          testFilePath: sourcePath || null,
	          testFileName: sourceFile?.name || null,
          evidenceProfile,
          caseId: null,
          caseName: "Root Steps",
        },
      },
    });
  };

  const notifyRunFileFinished = (runResult, sourceFile = testFile, sourcePath = currentTestFilePath) => {
    const caseResults = Array.isArray(runResult?.caseResults) ? runResult.caseResults : [];
    const totalCases = caseResults.length || sourceFile?.cases?.length || 0;
    const passedCases = caseResults.filter((item) => item.result?.ok).length;
    void notifyRunFileComplete({
      ok: Boolean(runResult?.ok),
      status: runResult?.type === "test-file-stopped" || runResult?.error?.code === "run-stopped"
        ? "stopped"
        : runResult?.ok
          ? "passed"
          : "failed",
      testFileName: sourceFile?.name || sourcePath || "Run file",
      testFilePath: sourcePath || "",
      totalCases,
      passedCases,
      durationMs: runResult?.telemetry?.durationMs || 0,
      durationText: formatRunDuration(runResult?.telemetry?.durationMs),
      errorMessage: runResult?.error?.message || "",
    }).catch((error) => {
      console.warn("[App][RunFileNotification:failed]", error?.message || String(error));
    });
  };

  const markRootPhaseRunning = (phase) => {
    setRunProgress((current) => {
      const rootSteps = current?.rootSteps?.length ? current.rootSteps : current?.steps || [];
      if (!rootSteps.length) {
        return current;
      }
      const firstIndex = rootSteps.findIndex((step) => step.phase === phase);
      let phaseRunningMarked = false;
      const nextRootSteps = rootSteps.map((step, index) => {
        if (step.phase !== phase) {
          return step;
        }
        const shouldMarkRunning = !phaseRunningMarked && index === firstIndex;
        if (shouldMarkRunning) {
          phaseRunningMarked = true;
        }
        return {
          ...step,
          status: shouldMarkRunning ? "running" : "pending",
          message: shouldMarkRunning ? `Running root ${phase}...` : "",
          error: null,
          durationMs: null,
          evidence: null,
          diagnostics: null,
        };
      });
      const currentStepsAreRoot = (current.steps || []).some((step) => step.phase === "setup" || step.phase === "teardown");
      return {
        ...current,
        status: "running",
        currentCaseId: null,
        currentStepIndex: firstIndex >= 0 ? firstIndex : current.currentStepIndex,
        rootSteps: nextRootSteps,
        steps: currentStepsAreRoot ? nextRootSteps : current.steps,
      };
    });
  };

  const applyRootPhaseResult = (phase, phaseResult) => {
    setRunProgress((current) => {
      const rootSteps = current?.rootSteps?.length ? current.rootSteps : current?.steps || [];
      if (!rootSteps.length) {
        return current;
      }
      const resultSteps = Array.isArray(phaseResult?.data?.results) ? phaseResult.data.results : [];
      const evidenceSteps = Array.isArray(phaseResult?.evidence?.steps) ? phaseResult.evidence.steps : [];
      let phaseIndex = 0;
      let firstFailedIndex = null;
      const nextRootSteps = rootSteps.map((step, index) => {
        if (step.phase !== phase) {
          return step;
        }
        const resultStep = resultSteps[phaseIndex] || null;
        const evidenceStep = evidenceSteps[phaseIndex] || null;
        const stepWasExecuted = Boolean(resultStep || evidenceStep || step.status === "running");
        phaseIndex += 1;
        if (!stepWasExecuted || resultStep?.skipped || resultStep?.stopped) {
          return step;
        }
        const failed = resultStep ? resultStep.ok === false : phaseResult?.ok === false;
        if (failed && firstFailedIndex == null) {
          firstFailedIndex = index;
        }
        return {
          ...step,
          status: failed ? "failed" : "passed",
          message: failed ? resultStep?.error?.message || phaseResult?.error?.message || "Root step failed." : "",
          error: failed ? resultStep?.error || phaseResult?.error || null : null,
          durationMs:
            resultStep?.data?.trace?.durationMs ??
            evidenceStep?.data?.trace?.durationMs ??
            evidenceStep?.data?.action?.durationMs ??
            null,
          evidence: resultStep || evidenceStep ? resultStep?.evidence || evidenceStep || resultStep || null : step.evidence,
          raw: resultStep || evidenceStep || step.raw || null,
        };
      });
      const currentStepsAreRoot = (current.steps || []).some((step) => step.phase === "setup" || step.phase === "teardown");
      return {
        ...current,
        currentCaseId: null,
        currentStepIndex: firstFailedIndex ?? current.currentStepIndex,
        rootSteps: nextRootSteps,
        steps: currentStepsAreRoot ? nextRootSteps : current.steps,
      };
    });
  };

  const skipPendingCasesAfterRootFailure = (reason) => {
    setRunProgress((current) => {
      if (!current?.cases?.length) {
        return current;
      }
      return {
        ...current,
        cases: current.cases.map((caseItem) =>
          caseItem.status === "pending"
            ? {
                ...caseItem,
                status: "pending",
                error: null,
                steps: caseItem.steps.map((step) =>
                  step.status === "pending"
                    ? {
                        ...step,
                        status: "pending",
                        message: "",
                        error: null,
                      }
                    : step,
                ),
              }
            : caseItem,
        ),
      };
    });
  };

	  const executePayload = async (request = {}) => {
    if (isRunning) {
      return {
        ok: false,
        status: "busy",
        error: { code: "run-busy", message: "A run is already active." },
      };
    }
    const requestPayload = typeof request === "string"
      ? ["all", "selected"].includes(request)
        ? { scope: request }
        : { stepId: request }
      : { ...(request || {}) };
    const externalRunId = requestPayload.externalRunId || "";
    const isExternalAppRun = requestPayload.triggerSurface === "external-app-run" || Boolean(externalRunId);
    if (isCurrentTestFileExternallyUpdated && !isExternalAppRun) {
      const confirmed = window.confirm(
        isTestFileDirty
          ? "The current test file has changed on disk, and this view also has unsaved local changes. Continue running the current loaded draft?"
          : "The current test file has changed on disk. Continue running the current loaded version?",
      );
      if (!confirmed) {
        return {
          ok: false,
          status: "cancelled",
          error: { code: "run-cancelled", message: "Run was cancelled before execution." },
        };
      }
    }
    stopRunRequestedRef.current = false;
    const externalSourceFile = requestPayload.testFile && typeof requestPayload.testFile === "object"
      ? normalizeTestFile(requestPayload.testFile)
      : null;
    const executionTestFilePath = requestPayload.testFilePath || currentTestFilePath || "";
    const stepId = requestPayload.stepId || null;
    const stepPhase = requestPayload.stepPhase || requestPayload.phase || "";
    const sourceFixture = requestPayload.sourceFixture || "";
    const sourceMacro = requestPayload.sourceMacro || "";
    const scope = requestPayload.scope || "selected";
    const requestedCaseId = requestPayload.caseId || null;
    const runtimeVariables =
      requestPayload.runtimeVariables && typeof requestPayload.runtimeVariables === "object"
        ? requestPayload.runtimeVariables
        : null;
    const stopOnFailure = requestPayload.stopOnFailure !== false;
    // Z11: checkpoint save / resume for this run (external App-run passes them via
    // runOptions). run() gets them through runOneCase -> runtime options; main
    // resolves the checkpoint id to an on-disk dir.
    const checkpointOption = requestPayload.checkpoint && typeof requestPayload.checkpoint === "object" ? requestPayload.checkpoint : null;
    const resumeOption = requestPayload.resume && typeof requestPayload.resume === "object" ? requestPayload.resume : null;
    const includeRootSteps = requestPayload.includeRootSteps !== false;
    const includeCaseFixtures = requestPayload.includeCaseFixtures !== false;
    const navigateToBaseUrlBeforeRun = requestPayload.navigateToBaseUrlBeforeRun !== false;
    const runStepRange = normalizeRunStepRange(requestPayload.runStepRange);
    const caseStepRangeOptions = runStepRange
      ? {
          ...(runStepRange.start != null ? { caseStepStartIndex: runStepRange.start } : {}),
          ...(runStepRange.end != null ? { caseStepEndIndex: runStepRange.end } : {}),
        }
      : {};
	    const evidenceProfile = getTestFileEvidenceProfile(externalSourceFile || testFile);
    const runtimeVariableKeys = runtimeVariables ? Object.keys(runtimeVariables).filter((key) => runtimeVariables[key] !== "") : [];
    const runContext = {
      triggerSurface: requestPayload.triggerSurface || "unknown",
      scope: stepId ? "step" : scope === "all" ? "all" : "selected",
      evidenceProfile,
      stepId: stepId || null,
      runtimeVariableKeys,
      stopOnFailure,
      includeRootSteps,
      includeCaseFixtures,
      navigateToBaseUrlBeforeRun,
      ...(runStepRange ? { runStepRange } : {}),
      ...(stepPhase ? { stepPhase } : {}),
      ...(sourceFixture ? { sourceFixture } : {}),
      ...(sourceMacro ? { sourceMacro } : {}),
    };
    const committedFile = externalSourceFile || commitDraftToCurrentTarget();
    setTestFile(committedFile);
    if (externalSourceFile) {
      void refreshTestFileList();
      setCurrentTestFilePath(executionTestFilePath);
      currentTestFilePathRef.current = executionTestFilePath;
      setExternalTestFileUpdate(null);
      setSavedTestFileSnapshot(JSON.stringify(externalSourceFile));
      setAuthoringMode("visual");
      setBuildTargetType("case");
      setRootStepPhase(DEFAULT_ROOT_STEP_PHASE);
      setTestFileMode("run");
      navigatePage("test-file");
    }
    const externalDefaultCaseId = externalSourceFile ? getSelectedCaseId(committedFile, requestedCaseId || selectedCaseId) : selectedCaseId;
    const runCaseId = scope === "all" ? externalDefaultCaseId : requestedCaseId || externalDefaultCaseId;
    const selectedCase = committedFile.cases.find((item) => item.id === runCaseId) || committedFile.cases[0];
    if (externalSourceFile) {
      const nextSelectedCaseId = selectedCase?.id || getSelectedCaseId(committedFile);
      setSelectedCaseId(nextSelectedCaseId);
      draftSyncSuppressedRef.current = true;
      setDraft(getDraftForBuildTarget(committedFile, nextSelectedCaseId, "case", DEFAULT_ROOT_STEP_PHASE));
    }
    const selectedSourceDraft =
      !externalSourceFile && buildTargetType === "case" && selectedCase?.id === selectedCaseId
        ? draft
        : selectedCase?.id
          ? testFileToRuntimeDraft(committedFile, selectedCase.id)
          : draft;
    const useExpertForSelected =
      !externalSourceFile &&
      authoringMode === "expert" &&
      buildTargetType === "case" &&
      selectedCase?.id === selectedCaseId;
    if (!externalSourceFile && selectedCase?.id && selectedCase.id !== selectedCaseId) {
      setSelectedCaseId(selectedCase.id);
      if (buildTargetType === "case") {
        draftSyncSuppressedRef.current = true;
        setDraft(selectedSourceDraft);
      }
      setAuthoringMode("visual");
    }
    const isSharedStepRun = Boolean(
      stepId &&
        (sourceFixture ||
          sourceMacro ||
          stepPhase === "fixtureSetup" ||
          stepPhase === "fixtureTeardown" ||
          stepPhase === "macro"),
    );
	    const selectedExecutionFile =
	      isSharedStepRun
	        ? committedFile
	        : !externalSourceFile && (useExpertForSelected || (buildTargetType === "case" && selectedCase?.id === selectedCaseId))
	          ? runtimeDraftToTestFile(selectedSourceDraft, committedFile, selectedCase?.id)
	          : committedFile;
    const fileCaseExecutableOptions = {
      includeRootSetup: false,
      includeRootTeardown: false,
      ...(includeCaseFixtures ? {} : { includeFixtureSetup: false, includeFixtureTeardown: false }),
      ...caseStepRangeOptions,
    };
	    const selectedCaseExecutableOptions = {
	      ...(stepId ? { stepId } : {}),
      ...(stepPhase ? { stepPhase } : {}),
      ...(sourceFixture ? { sourceFixture } : {}),
      ...(sourceMacro ? { sourceMacro } : {}),
      ...(includeRootSteps ? {} : { includeRootSetup: false, includeRootTeardown: false }),
      ...(includeCaseFixtures ? {} : { includeFixtureSetup: false, includeFixtureTeardown: false }),
      ...caseStepRangeOptions,
    };
	    const selectedExecutableSteps = selectedCase
	      ? getExecutableStepsForCase(selectedExecutionFile, selectedCase.id, selectedCaseExecutableOptions)
	      : [];
    const requestDebug = {
      requestPayload,
      runContext,
      selectedCaseId: selectedCase?.id || "",
      selectedCaseExecutableOptions,
      isSharedStepRun,
      selectedExecutionCaseFixtures: selectedExecutionFile.cases?.find((item) => item.id === selectedCase?.id)?.fixtures || [],
      selectedExecutionFixtureKeys: Object.keys(selectedExecutionFile.fixtures || {}),
      selectedExecutableStepCount: selectedExecutableSteps.length,
      selectedExecutableSteps: selectedExecutableSteps.slice(0, 5).map(summarizeRunDebugStep),
      buildTargetType,
      authoringMode,
      useExpertForSelected,
	    };
	    console.info("[App][Run:request]", requestDebug);
    writeRunDebugLog("app.request", requestDebug);
    setActivityItems((current) => [
      createActivityItem(
        "system",
        "Run debug",
        `step=${stepId || "-"} phase=${stepPhase || "-"} fixture=${sourceFixture || "-"} payloadSteps=${selectedExecutableSteps.length}`,
      ),
      ...current.slice(0, 11),
    ]);
	    const progressSteps = useExpertForSelected && !stepId ? selectedSourceDraft.steps : selectedExecutableSteps;
    const runId = createRunId();
    let sharedRuntimeVariables = runtimeVariables ? { ...runtimeVariables } : null;
    let sharedRuntimeVariableSources = runtimeVariables
      ? Object.fromEntries(Object.keys(runtimeVariables).map((key) => [key, "override"]))
      : null;
    const syncSharedRuntimeVariables = (runResult) => {
      if (runResult?.runtimeVariables && typeof runResult.runtimeVariables === "object") {
        sharedRuntimeVariables = { ...runResult.runtimeVariables };
      }
      if (runResult?.runtimeVariableSources && typeof runResult.runtimeVariableSources === "object") {
        sharedRuntimeVariableSources = { ...runResult.runtimeVariableSources };
      }
    };
    activeRunIdRef.current = runId;
    setRunningTestFilePath(executionTestFilePath || null);
    const progressScope = stepId ? "step" : scope === "all" ? "file" : "case";
    const rootSetupSteps = scope === "all" && !stepId && includeRootSteps ? buildRootExecutionSteps(committedFile, "setup") : [];
    const rootTeardownSteps = scope === "all" && !stepId && includeRootSteps ? buildRootExecutionSteps(committedFile, "teardown") : [];
    const fileRootProgressSteps = [...rootSetupSteps, ...rootTeardownSteps];
    const progressCases =
      scope === "all" && !stepId
        ? buildRunProgressCases(committedFile, fileCaseExecutableOptions)
        : [{ ...selectedCase, steps: progressSteps }];
    const initialRunProgress = createRunProgress(
      scope === "all" && !stepId ? fileRootProgressSteps : progressSteps,
      runId,
	      {
	        scope: progressScope,
	        cases: progressCases,
	        selectedCaseId: selectedCase?.id,
        runContext,
	      },
	    );
    setResult(null);
    setLastRunAt(null);
    if (scope === "all" && !stepId) {
	      const rootRunProgress = createRunProgress(fileRootProgressSteps, runId, {
	        scope: "file",
        runContext,
	      });
      setRunProgress({
        ...initialRunProgress,
        status: "running",
        currentCaseId: null,
        currentStepIndex: fileRootProgressSteps.length ? 0 : null,
        steps: rootRunProgress.steps,
        rootSteps: rootRunProgress.steps,
        runId,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        result: null,
      });
    } else {
      setRunProgress(
        applyRuntimeRunEvent(initialRunProgress, {
	          type: "run-start",
	          runId,
	          startedAt: Date.now(),
          runContext,
	        }),
	      );
    }
    setIsRunning(true);
    try {
      const nextRuntimeState = await getRuntimeState();
      setRuntimeState(nextRuntimeState);
      const canRecoverBrowser =
        nextRuntimeState?.error?.message === "browser-unavailable" ||
        nextRuntimeState?.error === "browser-unavailable" ||
        nextRuntimeState?.autoRecovery === true;
      if (!nextRuntimeState?.available && !canRecoverBrowser) {
        throw new Error(nextRuntimeState?.error?.message || "runtime-unavailable");
      }

      if (scope === "all" && !stepId) {
        const caseResults = [];
        let rootSetupResult = null;
        let rootTeardownResult = null;
        const rootSetupRunId = `${runId}-root-setup`;
        const rootTeardownRunId = `${runId}-root-teardown`;
        if (rootSetupSteps.length && !stopRunRequestedRef.current) {
          markRootPhaseRunning("setup");
          rootRuntimeRunMapRef.current.set(rootSetupRunId, { parentRunId: runId, phase: "setup" });
          rootSetupResult = await runRootSteps({
            steps: rootSetupSteps,
            runId: rootSetupRunId,
	            sourceFile: committedFile,
            sourcePath: executionTestFilePath,
	            runtimeVariables: sharedRuntimeVariables,
            runtimeVariableSources: sharedRuntimeVariableSources,
            navigateToBaseUrl: navigateToBaseUrlBeforeRun,
            runContext: {
              ...runContext,
              scope: "all",
              phase: "root-setup",
            },
          });
          syncSharedRuntimeVariables(rootSetupResult);
          applyRootPhaseResult("setup", rootSetupResult);
          if (rootSetupResult?.ok === false) {
            skipPendingCasesAfterRootFailure(rootSetupResult.error || { message: "root-setup-failed" });
          }
        }
        for (const caseItem of committedFile.cases) {
          if (stopRunRequestedRef.current || rootSetupResult?.ok === false) {
            break;
          }
          const caseRunId = `${runId}-${caseItem.id}`;
          const caseDraft = testFileToRuntimeDraft(committedFile, caseItem.id);
          const caseStartedAt = Date.now();
          setRunProgress((current) =>
            applyRuntimeRunEvent(current, {
              type: "case-start",
              runId,
              caseRunId,
              caseId: caseItem.id,
              startedAt: caseStartedAt,
            }),
          );
          const caseResult = await runOneCase({
            caseItem,
            sourceDraft: caseDraft,
            runId: caseRunId,
            useExpertSource: false,
            navigateToBaseUrl: navigateToBaseUrlBeforeRun && !rootSetupSteps.length,
	            sourceFile: committedFile,
            sourcePath: executionTestFilePath,
	            sourceTargetType: "case",
            executableOptions: fileCaseExecutableOptions,
            runtimeVariables: sharedRuntimeVariables,
            runtimeVariableSources: sharedRuntimeVariableSources,
            stopOnFailure,
            includeRootSteps: false,
            includeCaseFixtures,
            navigateToBaseUrlBeforeRun,
            checkpoint: checkpointOption,
            resume: resumeOption,
            runContext: {
              ...runContext,
              scope: "all",
            },
          });
          syncSharedRuntimeVariables(caseResult);
          setRunProgress((current) =>
            applyRuntimeRunEvent(current, {
              type: "case-complete",
              runId,
              caseId: caseItem.id,
              status: caseResult?.ok ? "passed" : "failed",
              durationMs: Date.now() - caseStartedAt,
              finishedAt: Date.now(),
              result: caseResult,
              error: caseResult?.error || null,
            }),
          );
          caseResults.push({
            caseId: caseItem.id,
            caseName: caseItem.name,
            priority: caseItem.priority,
            result: caseResult,
          });
          if (stopRunRequestedRef.current) {
            break;
          }
        }
        const shouldRunTeardown = rootTeardownSteps.length && committedFile?.teardown?.alwaysRun !== false;
        if (shouldRunTeardown && !stopRunRequestedRef.current) {
          markRootPhaseRunning("teardown");
          rootRuntimeRunMapRef.current.set(rootTeardownRunId, { parentRunId: runId, phase: "teardown" });
          rootTeardownResult = await runRootSteps({
            steps: rootTeardownSteps,
            runId: rootTeardownRunId,
	            sourceFile: committedFile,
            sourcePath: executionTestFilePath,
	            runtimeVariables: sharedRuntimeVariables,
            runtimeVariableSources: sharedRuntimeVariableSources,
            navigateToBaseUrl: false,
            runContext: {
              ...runContext,
              scope: "all",
              phase: "root-teardown",
            },
          });
          syncSharedRuntimeVariables(rootTeardownResult);
          applyRootPhaseResult("teardown", rootTeardownResult);
        }
        const stopped = stopRunRequestedRef.current;
        const rootOk = rootSetupResult?.ok !== false && rootTeardownResult?.ok !== false;
        const ok = rootOk && caseResults.every((item) => item.result?.ok);
        const durationMs =
          (rootSetupResult?.telemetry?.durationMs || 0) +
          caseResults.reduce((sum, item) => sum + (item.result?.telemetry?.durationMs || 0), 0) +
          (rootTeardownResult?.telemetry?.durationMs || 0);
        const nextResult = {
          ok: stopped ? false : ok,
          type: stopped ? "test-file-stopped" : "test-file",
          data: caseResults,
          caseResults,
          error: stopped
            ? { code: "run-stopped", message: "Run stopped by user." }
            : ok
              ? null
              : rootSetupResult?.ok === false
                ? rootSetupResult.error || { message: "root-setup-failed" }
                : rootTeardownResult?.ok === false
                  ? rootTeardownResult.error || { message: "root-teardown-failed" }
                  : { message: "one-or-more-cases-failed" },
          telemetry: {
            durationMs,
            steps:
              (rootSetupResult?.telemetry?.steps || 0) +
              caseResults.reduce((sum, item) => sum + (item.result?.telemetry?.steps || 0), 0) +
              (rootTeardownResult?.telemetry?.steps || 0),
            okCount: caseResults.filter((item) => item.result?.ok).length,
            errorCount:
              (rootSetupResult?.ok === false ? 1 : 0) +
              caseResults.filter((item) => !item.result?.ok).length +
              (rootTeardownResult?.ok === false ? 1 : 0),
          },
          evidence: {
            steps: [
              ...(rootSetupResult?.evidence?.steps || []),
              ...caseResults.flatMap((item) => item.result?.evidence?.steps || []),
              ...(rootTeardownResult?.evidence?.steps || []),
            ],
            rootSetup: rootSetupResult?.evidence || null,
            rootTeardown: rootTeardownResult?.evidence || null,
            caseRuns: caseResults.map((item) => ({
              caseId: item.caseId,
              caseName: item.caseName,
              runDir: item.result?.evidence?.runDir || null,
              reportPath: item.result?.evidence?.reportPath || null,
              summaryPath: item.result?.evidence?.summaryPath || null,
              markdownReportPath: item.result?.evidence?.markdownReportPath || null,
            })),
          },
        };
        setResult(nextResult);
        setRunProgress((current) =>
          applyRuntimeRunEvent(current, {
	            type: "run-complete",
	            runId,
	            status: stopped ? "stopped" : nextResult.ok ? "success" : "failed",
	            finishedAt: Date.now(),
	            result: nextResult,
	            error: nextResult.error || null,
            runContext,
	          }),
	        );
      notifyRunFileFinished(nextResult, committedFile, executionTestFilePath);
      setLastRunAt(Date.now());
      void refreshRunHistory(executionTestFilePath);
      return createExternalAppRunResponse({
        externalRunId,
        testFilePath: executionTestFilePath,
        scope: "all",
        caseId: null,
        result: nextResult,
      });
	      }

      const nextResult = await runOneCase({
        caseItem: selectedCase,
        sourceDraft: selectedSourceDraft,
        stepId,
        runId,
        useExpertSource: useExpertForSelected,
        navigateToBaseUrl: !stepId && navigateToBaseUrlBeforeRun,
	        sourceFile: selectedExecutionFile,
        sourcePath: executionTestFilePath,
	        sourceTargetType: "file",
        runtimeVariables,
        stopOnFailure,
        includeRootSteps,
        includeCaseFixtures,
        navigateToBaseUrlBeforeRun,
        executableOptions: selectedCaseExecutableOptions,
        runContext,
      });
      const stopped = stopRunRequestedRef.current;
      const finalResult = stopped
        ? {
            ok: false,
            type: stepId ? "step-stopped" : "case-stopped",
            data: nextResult,
            error: { code: "run-stopped", message: "Run stopped by user." },
            telemetry: nextResult?.telemetry || null,
            evidence: nextResult?.evidence || null,
          }
        : nextResult;
      setResult(finalResult);
      setRunProgress((current) =>
        applyRuntimeRunEvent(current, {
          type: "run-complete",
          runId,
          status: stopped ? "stopped" : finalResult?.ok ? "success" : "failed",
          finishedAt: Date.now(),
	          result: finalResult,
	          error: finalResult?.error || null,
          runContext,
	        }),
	      );
	      setLastRunAt(Date.now());
	      void refreshRunHistory(executionTestFilePath);
      return createExternalAppRunResponse({
        externalRunId,
        testFilePath: executionTestFilePath,
        scope: stepId ? "step" : "selected",
        caseId: selectedCase?.id || null,
        result: finalResult,
      });
	    } catch (error) {
      const stopped = stopRunRequestedRef.current;
      const failedResult = {
        ok: false,
        type: stopped ? "run-stopped" : "run-failed",
        error: {
          code: stopped ? "run-stopped" : undefined,
          message: stopped ? "Run stopped by user." : error.message || String(error),
        },
      };
      setResult(failedResult);
      setRunProgress((current) =>
        applyRuntimeRunEvent(current, {
          type: "run-complete",
          runId,
          status: stopped ? "stopped" : "failed",
          finishedAt: Date.now(),
	          result: failedResult,
	          error: failedResult.error,
          runContext,
	        }),
	      );
      if (scope === "all" && !stepId) {
        notifyRunFileFinished(
          {
            ...failedResult,
            caseResults: [],
            telemetry: { durationMs: 0, steps: 0, okCount: 0, errorCount: 1 },
          },
          committedFile,
          executionTestFilePath,
	        );
	      }
	      setLastRunAt(Date.now());
	      void refreshRunHistory(executionTestFilePath);
      return createExternalAppRunResponse({
        externalRunId,
        testFilePath: executionTestFilePath,
        scope: stepId ? "step" : scope === "all" ? "all" : "selected",
        caseId: selectedCase?.id || null,
        result: failedResult,
        error: failedResult.error,
      });
	    } finally {
      if (activeRunIdRef.current === runId) {
        activeRunIdRef.current = null;
      }
      rootRuntimeRunMapRef.current.forEach((meta, childRunId) => {
        if (meta?.parentRunId === runId) {
          rootRuntimeRunMapRef.current.delete(childRunId);
        }
      });
      setIsStoppingRun(false);
      setIsRunning(false);
      setRunningTestFilePath((current) => current === executionTestFilePath ? null : current);
    }
	  };
  executePayloadRef.current = executePayload;

  // REQ-Z13 (需求单v3): main has force-cancelled the App-run we are driving
  // (explicit cancel endpoint, or the stall watchdog reclaiming a wedged slot).
  // Main already aborted the runtime AbortControllers; this flag stops the panel
  // from continuing to the next case and from reporting a stale completion.
  useEffect(() => {
    const unsubscribe = subscribeExternalAppRunCancels((payload = {}) => {
      stopRunRequestedRef.current = true;
      setActivityItems((current) => [
        createActivityItem(
          "system",
          "External run cancelled",
          payload?.reason || payload?.externalRunId || "",
        ),
        ...current.slice(0, 11),
      ]);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeExternalAppRunRequests(async (payload = {}) => {
      const externalRunId = payload.externalRunId || "";
      const testFilePath = payload.testFilePath || "";
      const scope = payload.scope === "selected" ? "selected" : "all";
      const caseId = payload.caseId || null;
      try {
        if (!payload.testFile || typeof payload.testFile !== "object") {
          throw Object.assign(new Error("External app run request did not include a testFile snapshot."), {
            code: "missing-test-file",
          });
        }
        setActivityItems((current) => [
          createActivityItem("system", "External Run file requested", testFilePath || externalRunId),
          ...current.slice(0, 11),
        ]);
        // Z02: tell subscribers the panel has accepted the run and started
        // executing (best-effort; never blocks the run).
        void reportExternalAppRunProgress({
          externalRunId,
          phase: "panel-started",
          status: "running",
          detail: testFilePath || "",
        });
        const runResponse = await executePayloadRef.current?.({
          ...(payload.runOptions && typeof payload.runOptions === "object" ? payload.runOptions : {}),
          externalRunId,
          triggerSurface: "external-app-run",
          testFilePath,
          testFile: payload.testFile,
          scope,
          ...(caseId ? { caseId } : {}),
        });
        await completeExternalAppRun({
          ...(runResponse || {}),
          externalRunId,
          testFilePath,
          scope,
          caseId,
        });
      } catch (error) {
        await completeExternalAppRun({
          ok: false,
          status: "failed",
          externalRunId,
          testFilePath,
          scope,
          caseId,
          error: {
            code: error?.code || "external-app-run-failed",
            message: error?.message || String(error),
          },
        });
      }
    });
    void markExternalAppRunReady();
    return unsubscribe;
  }, []);

	  const handleNavigate = async (targetUrl = null) => {
    const target = typeof targetUrl === "string" ? targetUrl.trim() : navInput.trim();
    if (!target) {
      return;
    }
    navInputDirtyRef.current = false;
    await navigate(target);
  };

  const handleBrowserCommand = async (command) => {
    await browserCommand(command);
  };

  const handleStopRun = async () => {
    if (!isRunning || isStoppingRun) {
      return;
    }
    stopRunRequestedRef.current = true;
    setIsStoppingRun(true);
    setRunProgress((current) => {
      if (!current) {
        const fallbackProgress = createRunProgress([], activeRunIdRef.current, {
          scope: "file",
        });
        return {
          ...fallbackProgress,
          status: "stopping",
          error: {
            code: "run-stop-requested",
            message: "Stop requested. Waiting for the current runtime operation to settle.",
          },
        };
      }
      return {
        ...current,
        status: "stopping",
        error: current.error || {
          code: "run-stop-requested",
          message: "Stop requested. Waiting for the current runtime operation to settle.",
        },
      };
    });
    try {
      await stopRuntimeRun({});
    } catch (_error) {
      // Front-end loop stop still applies even if the runtime stop IPC is unavailable.
    }
    try {
      await browserCommand("stop");
    } catch (_error) {
      // Stop intent is still honored by the front-end run loop even if the browser command fails.
    }
  };

  const handleClearRunState = () => {
    const sourceFile = commitDraftToCurrentTarget();
    const progressSteps =
      authoringMode === "expert" && buildTargetType === "case"
        ? draft.steps
        : getExecutableStepsForCase(sourceFile, selectedCaseId);
    setResult(null);
    setLastRunAt(null);
    setRunProgress(
      createRunProgress(progressSteps, null, {
        scope: "file",
        cases: buildRunProgressCases(sourceFile),
        selectedCaseId,
      }),
    );
  };

  const handleAuthoringModeChange = (mode) => {
    setAuthoringMode(mode);
    if (mode === "expert") {
      setEditorText(JSON.stringify(draftToRuntimePayload(draft), null, 2));
      setSyncMessage("Expert JSON");
    }
  };

  const handlePanelPreferenceChange = async (patch) => {
    const nextPreferences = normalizePanelPreferences({
      ...panelPreferences,
      ...(patch || {}),
    });
    setPanelPreferences(nextPreferences);
    const response = await updatePanelPreferences({ preferences: nextPreferences });
    const savedPreferences = normalizePanelPreferences(response?.preferences || nextPreferences);
    setPanelPreferences(savedPreferences);
    return savedPreferences;
  };

  // Point the stable page-handler shim at this render's latest handlers. The
  // delegators in `pageHandlers` keep a fixed identity (so memoized pages don't
  // re-render when only the handlers "change") while always invoking the current
  // closure via this ref — no stale-closure risk.
  pageHandlersRef.current = {
    onNavInputChange: (value) => {
      navInputDirtyRef.current = true;
      setNavInput(value);
    },
    onNavigate: handleNavigate,
    onCommand: handleBrowserCommand,
    onApplyTemplate: handleApplyTemplate,
    onAuthoringModeChange: handleAuthoringModeChange,
    onStepFieldChange: handleStepFieldChange,
    onStepExpectationChange: handleStepExpectationChange,
    onSharedStepPatch: handleSharedStepPatch,
    onAddStep: handleAddStep,
    onDuplicateStep: handleDuplicateStep,
    onRemoveStep: handleRemoveStep,
    onSortStep: handleSortStep,
    onEditorTextChange: handleEditorTextChange,
    onApplyGeneratedJson: () => {
      setEditorText(JSON.stringify(draftToRuntimePayload(draft), null, 2));
      setEditorError("");
      setSyncMessage("Reset from visual draft");
    },
    onNavigatePage: navigatePage,
    onOpenProfessionalReport: openProfessionalReport,
    onOpenHistoryRun: openHistoryRun,
    onHistoryFocusConsumed: () => setHistoryFocusReportPath(""),
    onBuildStepFocusConsumed: () => setBuildStepFocusRequest(null),
    onOpenBuildStep: openBuildStep,
    onPanelPreferenceChange: handlePanelPreferenceChange,
    onColorThemeChange: (value) => {
      if (COLOR_THEMES.has(value)) {
        setColorTheme(value);
      }
    },
    onToggleTheme: () => setTheme((value) => (value === "dark" ? "light" : "dark")),
    onRunPayload: (request = "selected") => executePayload(
      typeof request === "string" ? { scope: request } : request,
    ),
    onRunStep: (stepId, runtimeVariables = null, runOptions = {}) => executePayload({
      ...runOptions,
      stepId,
      scope: "selected",
      runtimeVariables,
    }),
    onStopRun: handleStopRun,
    onClearRunState: handleClearRunState,
    onTestFileModeChange: handleTestFileModeChange,
    onTestFileMetaChange: handleTestFileMetaChange,
    onSelectCase: handleSelectCase,
    onSelectRootSteps: handleSelectRootSteps,
    onRootStepPhaseChange: handleRootStepPhaseChange,
    onCaseMetaChange: handleCaseMetaChange,
    onAddCase: handleAddCase,
    onDuplicateCase: handleDuplicateCase,
    onRemoveCase: handleRemoveCase,
    onRestoreDeletedCase: handleRestoreDeletedCase,
    onCreateTestFile: handleCreateTestFile,
    onDuplicateTestFile: handleDuplicateTestFile,
    onSaveTestFile: handleSaveTestFile,
    onReloadTestFile: reloadCurrentTestFile,
    onSelectTestFile: openTestFile,
  };
  const pageHandlers = useMemo(() => {
    const handlers = {};
    for (const key of Object.keys(pageHandlersRef.current)) {
      handlers[key] = (...args) => pageHandlersRef.current[key](...args);
    }
    return handlers;
    // Built once from the (fixed) handler key set; identities stay stable.
  }, []);

  // Same stable-delegation for the sidebar so its file tree doesn't re-render on
  // every unrelated App change (draft edits, browser-state pushes, run progress).
  sidebarHandlersRef.current = {
    onToggleGroup: (groupKey) =>
      setCollapsedGroups((current) =>
        current.includes(groupKey) ? current.filter((item) => item !== groupKey) : [...current, groupKey],
      ),
    onSelectFile: openTestFile,
    onCreateFile: handleCreateTestFile,
    onCreateFolder: handleCreateFolder,
    onRefreshFiles: handleRefreshTestFiles,
    onDuplicateFile: handleDuplicateTestFile,
    onNavigatePage: navigatePage,
    onToggleTheme: () => setTheme((value) => (value === "dark" ? "light" : "dark")),
    onToggleCollapsed: () => setSidebarCollapsed((value) => !value),
    onSidebarResizeStart: handleSidebarResizeStart,
  };
  const sidebarHandlers = useMemo(() => {
    const handlers = {};
    for (const key of Object.keys(sidebarHandlersRef.current)) {
      handlers[key] = (...args) => sidebarHandlersRef.current[key](...args);
    }
    return handlers;
  }, []);

  const pageProps = {
    browserState,
    panelPreferences,
    panelPlatform,
    isWindowFullScreen: browserState?.isWindowFullScreen ?? false,
    runtimeState,
    navInput,
    draft,
    draftWarnings,
    authoringMode,
    editorText,
    editorError,
    syncMessage,
    result,
    theme,
    colorTheme,
    historyFocusReportPath,
    buildStepFocusRequest,
    activityItems,
    lastRunAt,
    testFileHistory,
    isRunning,
    isStoppingRun,
    runProgress,
    testFile: visibleTestFile,
    currentTestFilePath,
    testFileList,
    testFileMode,
    selectedCaseId,
    buildTargetType,
    rootStepPhase,
    isTestFileDirty,
    testFileSaveState,
    isCurrentTestFileExternallyUpdated,
    isSavingTestFile,
    isReloadingTestFile,
    deletedCaseName: lastDeletedCase?.filePath === currentTestFilePath ? lastDeletedCase.caseItem?.name : "",
    ...pageHandlers,
  };

  return (
    <>
      <ClipboardFeedbackToast />
      <TooltipProvider>
        <SidebarProvider
        open={!sidebarCollapsed}
        onOpenChange={(open) => setSidebarCollapsed(!open)}
        className={styles.shell}
        data-platform={panelPlatform}
        data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
        data-window-fullscreen={browserState?.isWindowFullScreen ? "true" : "false"}
        style={{
          "--sidebar-width": `${sidebarWidth}px`,
          "--sidebar-width-icon": "48px",
        }}
      >
        {workspace !== "report" ? (
          <AppTitleBar
            isDevelopmentApp={isDevelopmentApp}
            workspace={workspace}
            testFile={testFile}
            currentTestFilePath={currentTestFilePath}
            testFileMode={testFileMode}
            testFileSaveState={testFileSaveState}
            sidebarCollapsed={sidebarCollapsed}
            testFileList={testFileList}
            isTestFileDirty={isTestFileDirty}
            isSavingTestFile={isSavingTestFile}
            isReloadingTestFile={isReloadingTestFile}
            onTestFileModeChange={handleTestFileModeChange}
            onCreateTestFile={handleCreateTestFile}
            onSaveTestFile={handleSaveTestFile}
            onReloadTestFile={reloadCurrentTestFile}
            onSelectTestFile={openTestFile}
            onDuplicateTestFile={handleDuplicateTestFile}
          />
        ) : null}
        {workspace !== "report" ? (
          <MemoAppSidebar
            isDevelopmentApp={isDevelopmentApp}
            workspace={workspace}
            activeFilePath={currentTestFilePath}
            runningFilePath={runningTestFilePath}
            testFileList={testFileList}
            collapsedGroups={collapsedGroups}
            onToggleGroup={sidebarHandlers.onToggleGroup}
            onSelectFile={sidebarHandlers.onSelectFile}
            onCreateFile={sidebarHandlers.onCreateFile}
            onCreateFolder={sidebarHandlers.onCreateFolder}
            onRefreshFiles={sidebarHandlers.onRefreshFiles}
            onDuplicateFile={sidebarHandlers.onDuplicateFile}
            onNavigatePage={sidebarHandlers.onNavigatePage}
            theme={theme}
            onToggleTheme={sidebarHandlers.onToggleTheme}
            sidebarCollapsed={sidebarCollapsed}
            onToggleCollapsed={sidebarHandlers.onToggleCollapsed}
            onSidebarResizeStart={sidebarHandlers.onSidebarResizeStart}
            sidebarResizeMovedRef={sidebarResizeMovedRef}
          />
        ) : null}

        <SidebarInset className={styles.main} data-report-workspace={workspace === "report" ? "true" : "false"}>
          <main className={styles.mainBody}>
            {workspace !== "workspace" && workspace !== "report" ? (
              <div className={styles.mobileToolbar}>
                <SidebarTrigger className={styles.mobileSidebarTrigger} />
                <Button variant="ghost" size="sm" onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}>
                  {theme === "dark" ? <Sun data-icon="inline-start" /> : <Moon data-icon="inline-start" />}
                  {theme === "dark" ? "Light" : "Dark"}
                </Button>
              </div>
            ) : null}
            {workspace === "workspace" ? <OverviewPage {...pageProps} /> : null}
            {workspace === "test-file" ? <TestFilePage {...pageProps} /> : null}
            {workspace === "history" ? <HistoryPage {...pageProps} /> : null}
            {workspace === "run-board" ? <RunBoardPage theme={theme} /> : null}
            {workspace === "report" ? (
              professionalReportPage.model ? (
                <ProfessionalRunReportPage
                  model={professionalReportPage.model}
                  onClose={closeProfessionalReport}
                />
              ) : (
                <div className="grid h-full place-items-center p-8 text-center">
                  <div className="grid max-w-[420px] gap-3">
                    <h2 className="text-xl font-semibold text-foreground">No report selected</h2>
                    <p className="text-sm text-muted-foreground">Open a run from History or Run, then choose Open new report.</p>
                    <Button type="button" variant="secondary" className="justify-self-center" onClick={() => navigatePage("history")}>
                      Back to History
                    </Button>
                  </div>
                </div>
              )
            ) : null}
            {workspace === "settings" ? <SettingsPage {...pageProps} /> : null}
          </main>
        </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </>
  );
}
