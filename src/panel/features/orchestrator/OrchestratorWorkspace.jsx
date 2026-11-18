import { forwardRef, memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { SortableContainer, SortableElement, SortableHandle } from "react-sortable-hoc";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleDashed,
  ClipboardCopy,
  Copy,
  Globe,
  GripVertical,
  ImageOff,
  ListChecks,
  Loader2,
  LoaderCircle,
  Maximize2,
  MousePointerClick,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Square,
  Target,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@panel/components/ui/button";
import { Input } from "@panel/components/ui/input";
import { Textarea } from "@panel/components/ui/textarea";
import { Badge } from "@panel/components/ui/badge";
import { Checkbox } from "@panel/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@panel/components/ui/sheet";
import { Alert, AlertDescription, AlertTitle } from "@panel/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@panel/components/ui/card";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@panel/components/ui/resizable";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@panel/components/ui/select";
import { Switch } from "@panel/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@panel/components/ui/toggle-group";
import { appendDebugLog, resolveEvidenceImageSrc } from "@panel/lib/panel-api";
import { retainEvidenceImageCache } from "@panel/lib/evidence-image-cache.mjs";
import { StepExecutionDetail } from "@panel/components/shared/StepExecutionDetail";
import { RuntimeVariablesPanel } from "@panel/components/shared/RuntimeVariablesPanel";
import { PageStructureViewer } from "@panel/components/shared/PageStructureViewer";
import { FullTextTooltip } from "@panel/components/shared/FullTextTooltip";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import { getRunProgressForCase, getRunStepIdentity } from "@panel/lib/run-progress.mjs";
import { usePersistedPanelLayout } from "@panel/hooks/use-persisted-panel-layout";
import {
  ACTION_TYPES,
  ADVANCED_EXPECTATIONS,
  COMMON_TEXT_EXPECTATIONS,
  NAVIGATION_BEHAVIOR_OPTIONS,
  WAIT_UNTIL_OPTIONS,
  createEmptyStep,
  draftToRuntimePayload,
  getStepDisplayTitle,
  runtimePayloadToDraft,
  summarizeDraftActions,
} from "@panel/lib/payload-draft.mjs";
import { cn } from "@panel/lib/cn";
import styles from "./OrchestratorWorkspace.module.css";

function eg(value) {
  return value ? `e.g. ${value}` : "";
}

function writeRunDebugLog(stage, payload = {}) {
  void appendDebugLog({
    stage,
    at: new Date().toISOString(),
    payload,
  }).catch((error) => {
    console.warn("[BuildCases][RunDebugLog:write-failed]", error?.message || String(error));
  });
}

function NumberInput({ value, onChange, placeholder }) {
  return (
    <Input
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      inputMode="numeric"
    />
  );
}

const RUN_VARIABLE_FIELDS = [
  {
    key: "timestamp",
    label: "timestamp",
    placeholder: "System: yyyyMMdd-HHmmss",
  },
  {
    key: "timestampMs",
    label: "timestampMs",
    placeholder: "System: Unix ms",
  },
  {
    key: "isoTimestamp",
    label: "isoTimestamp",
    placeholder: "System: ISO string",
  },
  {
    key: "runId",
    label: "runId",
    placeholder: "System: generated run id",
  },
];

const BUILD_CASES_VISUAL_LAYOUT = { cases: 22, canvas: 48, run: 30 };
const BUILD_CASES_EXPERT_LAYOUT = { cases: 22, source: 48, preview: 30 };

const RUN_VARIABLE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EMPTY_RUN_VARIABLE_DRAFT = Object.freeze({
  timestamp: "",
  timestampMs: "",
  isoTimestamp: "",
  runId: "",
  custom: "",
  stopOnFailure: true,
  includeRootSteps: true,
  includeCaseFixtures: true,
  navigateToBaseUrlBeforeRun: true,
  runStartStep: "",
  runEndStep: "",
});

function normalizeReferenceName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeReferenceNames(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(source.map(normalizeReferenceName).filter(Boolean))];
}

function getStepMacroNames(step = {}) {
  if (!step || typeof step !== "object") {
    return [];
  }
  const names = [];
  if (step.type === "useMacro") {
    names.push(step.macro, step.macroName, step.name, step.ref, step.query);
  }
  names.push(step.sourceMacro);
  return normalizeReferenceNames(names);
}

function getStepFixtureNames(step = {}) {
  if (!step || typeof step !== "object") {
    return [];
  }
  return normalizeReferenceNames([step.sourceFixture, step.fixture, ...(Array.isArray(step.fixtures) ? step.fixtures : [])]);
}

function getStepCount(value) {
  if (Array.isArray(value?.steps)) {
    return value.steps.length;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  return 0;
}

function buildFixtureReferenceItems(names = [], fixtureMap = {}) {
  return normalizeReferenceNames(names).map((name) => {
    const fixture = fixtureMap?.[name];
    if (!fixture) {
      return {
        name,
        detail: "Missing fixture definition",
        missing: true,
      };
    }
    const setupCount = getStepCount(fixture.setup);
    const teardownCount = getStepCount(fixture.teardown);
    return {
      name,
      detail: `${setupCount} setup · ${teardownCount} teardown`,
      missing: false,
    };
  });
}

function buildMacroReferenceItems(names = [], macroMap = {}) {
  return normalizeReferenceNames(names).map((name) => {
    const macro = macroMap?.[name];
    if (!macro) {
      return {
        name,
        detail: "Missing macro definition",
        missing: true,
      };
    }
    return {
      name,
      detail: `${getStepCount(macro)} steps`,
      missing: false,
    };
  });
}

function collectMacroNamesFromSteps(steps = []) {
  return normalizeReferenceNames((Array.isArray(steps) ? steps : []).flatMap((step) => getStepMacroNames(step)));
}

function getReferenceCountLabel(kind, item) {
  if (item.missing) {
    return "missing";
  }
  if (kind === "fixture") {
    return item.detail.replace(" · ", " / ");
  }
  return item.detail;
}

function getStepTone(step = {}) {
  if (step.type === "useMacro" || step.sourceMacro) {
    return "macro";
  }
  if (step.phase === "fixtureTeardown") {
    return "teardown";
  }
  if (step.sourceFixture || step.phase === "fixtureSetup") {
    return "fixture";
  }
  if (["assertVisible", "assertDom", "assertUrl", "assertResponse"].includes(step.type) || step.expectation?.mode?.startsWith?.("assert")) {
    return "assertion";
  }
  if (["type", "press", "comboSearchSelect", "cascaderSelect", "uploadFile"].includes(step.type)) {
    return "input";
  }
  if (["click", "navigate"].includes(step.type) || step.navigationBehavior) {
    return "navigation";
  }
  if (["capture", "callApi"].includes(step.type)) {
    return "evidence";
  }
  return "case";
}

function ReferenceTags({ kind, items }) {
  if (!items?.length) {
    return null;
  }
  const isFixture = kind === "fixture";
  const label = isFixture ? "Fixtures" : "Macros";
  const Icon = isFixture ? ListChecks : SlidersHorizontal;

  return (
    <div className={styles.referenceTags} data-kind={kind} aria-label={`${label}: ${items.map((item) => item.name).join(", ")}`}>
      {items.map((item) => (
        <span key={item.name} className={styles.referenceTag} data-kind={kind} data-missing={item.missing ? "true" : "false"}>
          <Icon aria-hidden="true" />
          <strong>{item.name}</strong>
          <small>{getReferenceCountLabel(kind, item)}</small>
        </span>
      ))}
    </div>
  );
}

function createDisplayStep(step = {}, meta = {}, fallbackId = "step") {
  const sourceStep = meta.buildSource ? (runtimePayloadToDraft([step]).steps[0] || step) : step;
  const stepId = step.id || sourceStep.id || fallbackId;
  const phase = step.phase || sourceStep.phase || meta.phase;
  const sourceFixture = step.sourceFixture || sourceStep.sourceFixture || meta.sourceFixture;
  const sourceMacro = step.sourceMacro || sourceStep.sourceMacro || meta.sourceMacro;
  return {
    ...sourceStep,
    id: stepId,
    phase,
    sourceFixture,
    sourceMacro,
    _flowKey: `${phase || "case"}::${sourceFixture || ""}::${sourceMacro || ""}::${stepId}`,
    _buildSource: meta.buildSource || null,
    _rawRuntimeStep: meta.buildSource ? step : null,
  };
}

function buildFixtureFlowSections(selectedCase, fixtureMap = {}) {
  const fixtureNames = normalizeReferenceNames(selectedCase?.fixtures || []);
  const setupSteps = [];
  const teardownSteps = [];
  fixtureNames.forEach((fixtureName) => {
    const fixture = fixtureMap?.[fixtureName];
    if (!fixture) {
      return;
    }
    (Array.isArray(fixture.setup) ? fixture.setup : []).forEach((step, index) => {
      setupSteps.push(createDisplayStep(
        step,
        {
          phase: "fixtureSetup",
          sourceFixture: fixtureName,
          buildSource: { type: "fixture", fixtureName, fixturePhase: "setup", index },
        },
        `${fixtureName}-setup-${index + 1}`,
      ));
    });
    (Array.isArray(fixture.teardown) ? fixture.teardown : []).forEach((step, index) => {
      teardownSteps.push(createDisplayStep(
        step,
        {
          phase: "fixtureTeardown",
          sourceFixture: fixtureName,
          buildSource: { type: "fixture", fixtureName, fixturePhase: "teardown", index },
        },
        `${fixtureName}-teardown-${index + 1}`,
      ));
    });
  });
  return { setupSteps, teardownSteps };
}

function buildMacroFlowSections(referenceSteps = [], macroMap = {}) {
  const macroNames = collectMacroNamesFromSteps(referenceSteps);
  return macroNames
    .map((macroName) => {
      const macro = macroMap?.[macroName];
      const steps = Array.isArray(macro?.steps) ? macro.steps : [];
      if (!steps.length) {
        return null;
      }
      return {
        name: macroName,
        steps: steps.map((step, index) => createDisplayStep(
          { ...step, id: `${macroName}::${step.id || `step-${index + 1}`}` },
          {
            phase: "macro",
            sourceMacro: macroName,
            buildSource: { type: "macro", macroName, index },
          },
          `${macroName}-macro-${index + 1}`,
        )),
      };
    })
    .filter(Boolean);
}

function createExecutionStateMap(steps = []) {
  const stateMap = new Map();
  (Array.isArray(steps) ? steps : []).forEach((step, index) => {
    const identity = getRunStepIdentity(step, index);
    if (identity) {
      stateMap.set(identity, step);
    }
    if (step.stepId) {
      const idKey = `id::${step.stepId}`;
      const matches = stateMap.get(idKey) || [];
      matches.push(step);
      stateMap.set(idKey, matches);
    }
  });
  return stateMap;
}

function getExecutionStateForStep(executionStateMap, step = {}, flowPhase = "case", fallbackIndex = "") {
  const sourceStep = {
    ...step,
    stepId: step.stepId || step.id,
    phase: step.phase || flowPhase || "case",
    sourceFixture: step.sourceFixture || "",
    sourceMacro: step.sourceMacro || "",
  };
  const exact = executionStateMap.get(getRunStepIdentity(sourceStep, fallbackIndex));
  if (exact) {
    return exact;
  }
  const idMatches = executionStateMap.get(`id::${sourceStep.stepId}`) || [];
  return idMatches.length === 1 ? idMatches[0] : null;
}

function getFlowStepKey(step = {}, fallbackIndex = "") {
  if (step._flowKey) {
    return step._flowKey;
  }
  const stepId = step.id || step.stepId || (fallbackIndex !== "" && fallbackIndex != null ? `index-${fallbackIndex}` : "");
  return `${step.phase || "case"}::${step.sourceFixture || ""}::${step.sourceMacro || ""}::${stepId}`;
}

function normalizeRunVariableDraft(value) {
  return {
    ...EMPTY_RUN_VARIABLE_DRAFT,
    ...(value || {}),
    stopOnFailure: value?.stopOnFailure !== false,
    includeRootSteps: value?.includeRootSteps !== false,
    includeCaseFixtures: value?.includeCaseFixtures !== false,
    navigateToBaseUrlBeforeRun: value?.navigateToBaseUrlBeforeRun !== false,
    runStartStep: typeof value?.runStartStep === "string" ? value.runStartStep : "",
    runEndStep: typeof value?.runEndStep === "string" ? value.runEndStep : "",
  };
}

function parsePositiveStepNumber(value) {
  const number = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getActiveRunStepRange(value, stepCount = 0) {
  const draft = normalizeRunVariableDraft(value);
  const start = parsePositiveStepNumber(draft.runStartStep);
  const end = parsePositiveStepNumber(draft.runEndStep);
  const normalizedStepCount = Number.isFinite(stepCount) && stepCount > 0 ? stepCount : null;
  const hasCustomStart = start != null && start !== 1;
  const hasCustomEnd = end != null && (!normalizedStepCount || end !== normalizedStepCount);
  if (!hasCustomStart && !hasCustomEnd) {
    return null;
  }
  return {
    ...(start != null ? { start } : {}),
    ...(end != null ? { end } : {}),
  };
}

function getActiveRunVariableOverrides(value) {
  const draft = normalizeRunVariableDraft(value);
  const overrides = {};
  RUN_VARIABLE_FIELDS.forEach((field) => {
    const nextValue = typeof draft[field.key] === "string" ? draft[field.key].trim() : "";
    if (nextValue) {
      overrides[field.key] = nextValue;
    }
  });
  String(draft.custom || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("=")) {
        return;
      }
      const separatorIndex = trimmed.indexOf("=");
      const key = trimmed.slice(0, separatorIndex).trim();
      const customValue = trimmed.slice(separatorIndex + 1).trim();
      if (RUN_VARIABLE_KEY_PATTERN.test(key) && customValue) {
        overrides[key] = customValue;
      }
    });
  return overrides;
}

function RunVariablesPopover({ value, onChange, disabled = false, placement = "bottom", stepCount = 0 }) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef(null);
  const panelRef = useRef(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const draft = normalizeRunVariableDraft(value);
  const activeCount =
    Object.keys(getActiveRunVariableOverrides(draft)).length +
    (draft.stopOnFailure === false ? 1 : 0) +
    (draft.includeRootSteps === false ? 1 : 0) +
    (draft.includeCaseFixtures === false ? 1 : 0) +
    (draft.navigateToBaseUrlBeforeRun === false ? 1 : 0) +
    (getActiveRunStepRange(draft, stepCount) ? 1 : 0);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const updatePopoverPosition = () => {
      const rect = controlRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const width = Math.min(360, Math.max(280, viewportWidth - 24));
      const left = Math.min(Math.max(12, rect.right - width), Math.max(12, viewportWidth - width - 12));
      const gap = 8;
      const topSpace = Math.max(0, rect.top - 16);
      const bottomSpace = Math.max(0, viewportHeight - rect.bottom - 16);
      const resolvedPlacement = placement === "top" && topSpace >= 220 ? "top" : bottomSpace >= topSpace ? "bottom" : "top";
      setPopoverPosition({
        left,
        width,
        maxHeight: Math.max(180, resolvedPlacement === "top" ? topSpace : bottomSpace),
        ...(resolvedPlacement === "top"
          ? { bottom: Math.max(8, viewportHeight - rect.top + gap) }
          : { top: Math.min(viewportHeight - 8, rect.bottom + gap) }),
      });
    };
    const handlePointerDown = (event) => {
      if (controlRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    const handleScrollOrResize = () => {
      updatePopoverPosition();
      if (!controlRef.current?.isConnected) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    updatePopoverPosition();
    window.addEventListener("resize", handleScrollOrResize);
    window.addEventListener("scroll", handleScrollOrResize, true);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleScrollOrResize);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, placement]);

  const updateField = (field, nextValue) => {
    onChange?.({
      ...draft,
      [field]: nextValue,
    });
  };

  return (
    <div className={styles.runVariablesControl} ref={controlRef}>
      <Button
        type="button"
        variant={activeCount ? "secondary" : "outline"}
        size="icon"
        title="Run variables"
        aria-label="Run variables"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
      >
        <SlidersHorizontal />
      </Button>
      {activeCount ? <span className={styles.runVariablesCount}>{activeCount}</span> : null}
      {open && popoverPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              className={styles.runVariablesPopover}
              style={{
                left: `${popoverPosition.left}px`,
                width: `${popoverPosition.width}px`,
                maxHeight: `${popoverPosition.maxHeight}px`,
                ...(popoverPosition.top !== undefined
                  ? { top: `${popoverPosition.top}px` }
                  : { bottom: `${popoverPosition.bottom}px` }),
              }}
              role="dialog"
              aria-label="Run variables"
            >
              <div className={styles.runVariablesHeader}>
                <div>
                  <strong>Run variables</strong>
                  <span>Blank fields use system defaults.</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onChange?.({ ...EMPTY_RUN_VARIABLE_DRAFT })}
                >
                  Use defaults
                </Button>
              </div>
              <div className={styles.runVariablesGrid}>
                {RUN_VARIABLE_FIELDS.map((field) => (
                  <label key={field.key} className={styles.runVariableField}>
                    <span>{field.label}</span>
                    <Input
                      value={draft[field.key]}
                      onChange={(event) => updateField(field.key, event.target.value)}
                      placeholder={field.placeholder}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
              <label className={styles.runVariableField}>
                <span>custom variables</span>
                <Textarea
                  value={draft.custom}
                  onChange={(event) => updateField("custom", event.target.value)}
                  placeholder={"spu=SPU-001\nsku=SKU-001"}
                  spellCheck={false}
                />
              </label>
              <div className={styles.runVariableRange}>
                <span>run step range</span>
                <div>
                  <Input
                    value={draft.runStartStep}
                    onChange={(event) => updateField("runStartStep", event.target.value)}
                    placeholder="1"
                    inputMode="numeric"
                    spellCheck={false}
                  />
                  <Input
                    value={draft.runEndStep}
                    onChange={(event) => updateField("runEndStep", event.target.value)}
                    placeholder={stepCount > 0 ? String(stepCount) : "last"}
                    inputMode="numeric"
                    spellCheck={false}
                  />
                </div>
              </div>
              <label className={styles.runVariableCheckbox}>
                <Checkbox
                  checked={draft.stopOnFailure}
                  onCheckedChange={(checked) => updateField("stopOnFailure", checked === true)}
                />
                <span>
                  <strong>Stop case on failed step</strong>
                </span>
              </label>
              <label className={styles.runVariableCheckbox}>
                <Checkbox
                  checked={draft.includeRootSteps}
                  onCheckedChange={(checked) => updateField("includeRootSteps", checked === true)}
                />
                <span>
                  <strong>Run root steps</strong>
                </span>
              </label>
              <label className={styles.runVariableCheckbox}>
                <Checkbox
                  checked={draft.includeCaseFixtures}
                  onCheckedChange={(checked) => updateField("includeCaseFixtures", checked === true)}
                />
                <span>
                  <strong>Run case fixtures</strong>
                </span>
              </label>
              <label className={styles.runVariableCheckbox}>
                <Checkbox
                  checked={draft.navigateToBaseUrlBeforeRun}
                  onCheckedChange={(checked) => updateField("navigateToBaseUrlBeforeRun", checked === true)}
                />
                <span>
                  <strong>Navigate to base URL before run</strong>
                </span>
              </label>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const ACTION_TYPE_OPTIONS = [
  {
    value: "click",
    label: "Click",
    description: "Trigger a semantic target.",
  },
  {
    value: "hover",
    label: "Hover",
    description: "Move the pointer over a target.",
  },
  {
    value: "press",
    label: "Press key",
    description: "Send a keyboard key to the page or focused target.",
  },
  {
    value: "fill",
    label: "Fill",
    description: "Fill text into a field.",
  },
  {
    value: "check",
    label: "Check",
    description: "Turn on a checkbox or switch.",
  },
  {
    value: "uncheck",
    label: "Uncheck",
    description: "Turn off a checkbox or switch.",
  },
  {
    value: "selectOption",
    label: "Select option",
    description: "Choose an option from a native select.",
  },
  {
    value: "assertVisible",
    label: "Check visible",
    description: "Verify a target or text exists.",
  },
  {
    value: "assertUrl",
    label: "Check URL",
    description: "Verify the current URL or title.",
  },
  {
    value: "assertCount",
    label: "Check count",
    description: "Verify how many elements match a target.",
  },
  {
    value: "callApi",
    label: "Call API",
    description: "Call an API with the current browser session and assert the response.",
  },
  {
    value: "capture",
    label: "Capture evidence",
    description: "Persist page evidence without changing state.",
  },
  {
    value: "openUrl",
    label: "Open URL",
    description: "Navigate the browser to a URL.",
  },
  {
    value: "reload",
    label: "Reload",
    description: "Refresh the current page.",
  },
  {
    value: "goBack",
    label: "Go back",
    description: "Navigate to the previous browser history entry.",
  },
  {
    value: "goForward",
    label: "Go forward",
    description: "Navigate to the next browser history entry.",
  },
  {
    value: "scroll",
    label: "Scroll",
    description: "Scroll the current page.",
  },
  {
    value: "waitForText",
    label: "Wait text",
    description: "Wait for text to appear on the page.",
  },
  {
    value: "waitForNav",
    label: "Wait navigation",
    description: "Wait for page navigation to complete.",
  },
  {
    value: "waitForIdle",
    label: "Wait idle",
    description: "Wait for the page network to become idle.",
  },
  {
    value: "comboSearchSelect",
    label: "Search select",
    description: "Choose or search an option from a select.",
  },
  {
    value: "cascaderSelect",
    label: "Cascader select",
    description: "Choose a multi-level option path.",
  },
  {
    value: "uploadFile",
    label: "Upload file",
    description: "Attach an image or file to an upload control.",
  },
  {
    value: "useMacro",
    label: "Use macro",
    description: "Expand a named reusable step group at runtime.",
  },
];

const ADVANCED_FIELD_META = {
  needRes: {
    label: "Capture artifacts",
    description: "Persist screenshots, OCR output, and trace files for this step.",
  },
  strictMatch: {
    label: "Use exact text match",
    description: "Require an exact text match during target lookup. Disable to allow fuzzy matching.",
  },
  enableScroll: {
    label: "Enable auto scroll",
    description: "Scroll and retry lookup when the target may start outside the current viewport.",
  },
  waitForNav: {
    label: "Wait for DOM ready",
    description: "After the action completes, wait for domcontentloaded.",
  },
  waitForIdle: {
    label: "Wait for network idle",
    description: "After the action completes, wait for networkidle.",
  },
};

const EXPECTATION_CARD_OPTIONS = [
  { value: "none", label: "No check", description: "Run the step without a post-action assertion." },
  { value: "text-exists", label: "Text appears", description: "Wait for expected text to show up." },
  { value: "text-absent", label: "Text disappears", description: "Wait for text to disappear from the page." },
  { value: "waitForChange", label: "Page changes", description: "Wait for a meaningful page delta after the action." },
  { value: "region-similar", label: "Region matches", description: "Compare a page region against a reference snapshot." },
  { value: "assertDom", label: "DOM state", description: "Check structured DOM state such as value, checked, disabled, attribute, class, or row text." },
  { value: "assertResponse", label: "API response", description: "Check the response returned by a callApi step." },
  { value: "networkResponse", label: "Network response", description: "Check a page request triggered by this action." },
  { value: "composite", label: "Composite checks", description: "Combine multiple assertions into one gate." },
];

function OptionDescriptionHint({ label, description }) {
  const [tooltipPosition, setTooltipPosition] = useState(null);

  if (!description) {
    return null;
  }

  const showTooltip = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    setTooltipPosition({
      left: Math.min(Math.max(rect.left + rect.width / 2, 128), Math.max(viewportWidth - 128, 128)),
      top: Math.max(rect.top - 8, 8),
    });
  };

  const hideTooltip = () => {
    setTooltipPosition(null);
  };

  return (
    <>
      <span
        className={styles.optionDescriptionHint}
        title={description}
        aria-label={`${label}: ${description}`}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
      >
        <CircleHelp aria-hidden="true" />
      </span>
      {tooltipPosition && typeof document !== "undefined"
        ? createPortal(
            <span
              className={styles.optionTooltipPortal}
              style={{
                left: `${tooltipPosition.left}px`,
                top: `${tooltipPosition.top}px`,
              }}
              role="tooltip"
            >
              {description}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function expectationDisplayLabel(mode) {
  return EXPECTATION_CARD_OPTIONS.find((option) => option.value === mode)?.label || mode || "No check";
}

function expectationSummary(expectation) {
  if (!expectation || expectation.mode === "none") {
    return "No post-action verification.";
  }
  const timeoutLabel = expectation.timeoutMs || 4000;
  const textLabel = expectation.textsText
    ? `"${String(expectation.textsText).split(/\r?\n/).filter(Boolean).join(", ")}"`
    : "the target text";
  switch (expectation.mode) {
    case "text-exists":
      return `Wait up to ${timeoutLabel}ms for ${textLabel} to appear.`;
    case "text-absent":
      return `Wait up to ${timeoutLabel}ms for ${textLabel} to disappear.`;
    case "waitForChange":
      return `Wait up to ${timeoutLabel}ms for the page to change.`;
    case "region-similar":
      return "Compare a specific page region against a reference image.";
    case "assertDom":
      return "Check structured DOM state for a target.";
    case "assertResponse":
      return "Check the API response returned by this step.";
    case "networkResponse":
      return "Wait for and check a matching page network response.";
    case "composite":
      return `${expectation.assertions?.length || 0} assertions must pass in order.`;
    default:
      return expectation.mode;
  }
}

function navigationBadgeLabel(behavior) {
  if (!behavior || behavior === "ignore") {
    return null;
  }
  return `nav:${behavior}`;
}

function expectationBadgeVariant(mode) {
  return mode === "none" ? "neutral" : "running";
}

function executionBadgeVariant(status) {
  switch (status) {
    case "running":
      return "running";
    case "stopping":
    case "stopped":
      return "neutral";
    case "passed":
    case "success":
      return "success";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function executionLabel(status) {
  switch (status) {
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "success":
      return "Run passed";
    default:
      return "Pending";
  }
}

function deriveExecutionGroupStatus(steps = []) {
  if (!steps.length) {
    return "pending";
  }
  if (steps.some((step) => step.status === "running")) {
    return "running";
  }
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (steps.some((step) => step.status === "stopped")) {
    return "stopped";
  }
  if (steps.every((step) => step.status === "skipped")) {
    return "skipped";
  }
  if (
    steps.some((step) => step.status === "passed") &&
    steps.every((step) => step.status === "passed" || step.status === "skipped")
  ) {
    return "passed";
  }
  return "pending";
}

function deriveFlowSectionStatus(executionStateMap, steps = [], flowPhase = "case", startIndex = 0) {
  return deriveExecutionGroupStatus(
    steps.map((step, index) => getExecutionStateForStep(executionStateMap, step, flowPhase, startIndex + index) || { status: "pending" }),
  );
}

function phaseLabel(phase) {
  switch (phase) {
    case "setup":
      return "Setup";
    case "fixtureSetup":
      return "Fixture setup";
    case "fixtureTeardown":
      return "Fixture teardown";
    case "teardown":
      return "Teardown";
    case "macro":
      return "Macro";
    default:
      return "Case";
  }
}

function ExecutionStatusIcon({ status }) {
  switch (status) {
    case "running":
    case "stopping":
      return <LoaderCircle className={`${styles.statusIcon} ${styles.statusIconSpinning}`} />;
    case "stopped":
      return <Square className={styles.statusIcon} />;
    case "passed":
    case "success":
      return <CheckCircle2 className={styles.statusIcon} />;
    case "failed":
      return <AlertCircle className={styles.statusIcon} />;
    default:
      return <CircleDashed className={`${styles.statusIcon} ${styles.statusIconPending}`} />;
  }
}

function runStatusVariant(status) {
  if (status === "running" || status === "stopping") {
    return "running";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "success") {
    return "success";
  }
  return "neutral";
}

function SelectField({ value, onChange, options, placeholder = eg("select option") }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full bg-[var(--input-bg)]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function formatJsonObject(value) {
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {}, null, 2);
}

function hasObjectEntries(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length);
}

function JsonObjectTextarea({ label, value, onChange, rows = 5 }) {
  const [text, setText] = useState(() => formatJsonObject(value));
  const [error, setError] = useState("");

  useEffect(() => {
    setText(formatJsonObject(value));
    setError("");
  }, [value]);

  const handleChange = (nextText) => {
    setText(nextText);
    try {
      const parsed = JSON.parse(nextText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Value must be a JSON object.");
      }
      setError("");
      onChange(parsed);
    } catch (parseError) {
      setError(parseError?.message || String(parseError));
    }
  };

  return (
    <div className={cn(styles.field, styles.jsonObjectField)}>
      <label>{label}</label>
      <Textarea
        rows={rows}
        value={text}
        onChange={(event) => handleChange(event.target.value)}
        className={styles.jsonObjectTextarea}
        spellCheck={false}
      />
      {error ? <div className={styles.jsonObjectError}>{error}</div> : null}
    </div>
  );
}

function ExpectationEditor({ expectation, onChange, onOpenPageStructure }) {
  const isAdvanced = ADVANCED_EXPECTATIONS.includes(expectation.mode);
  const showExpectationJsonOnlyFields = expectation.mode !== "none" && (isAdvanced || hasObjectEntries(expectation.rawExtras));
  const compositeModeOptions = [
    ...COMMON_TEXT_EXPECTATIONS.filter((mode) => mode !== "waitForChange"),
    "assertDom",
    "networkResponse",
  ].map((mode) => ({
    value: mode,
    label: expectationDisplayLabel(mode),
  }));

  const updateField = (field, value) => {
    onChange({
      ...expectation,
      [field]: value,
    });
  };

  const updateRegion = (field, value) => {
    onChange({
      ...expectation,
      region: {
        ...expectation.region,
        [field]: value,
      },
    });
  };

  const updateScope = (field, value) => {
    onChange({
      ...expectation,
      scope: {
        ...(expectation.scope || {}),
        [field]: value,
      },
    });
  };

  const updateRawExtra = (field, value) => {
    onChange({
      ...expectation,
      rawExtras: {
        ...(expectation.rawExtras || {}),
        [field]: value,
      },
    });
  };

  const updateRawExtrasObject = (rawExtras) => {
    onChange({
      ...expectation,
      rawExtras,
    });
  };

  const updateRawTarget = (field, value) => {
    updateRawExtra("target", {
      ...((expectation.rawExtras || {}).target || {}),
      [field]: value,
    });
  };

  const applyMode = (mode) => {
    onChange({
      ...expectation,
      mode,
      assertions: mode === "composite" ? expectation.assertions || [] : [],
    });
  };

  const updateAssertion = (assertionId, updater) => {
    updateField(
      "assertions",
      (expectation.assertions || []).map((item) => (item.id === assertionId ? updater(item) : item)),
    );
  };

  const updateAssertionRawExtra = (assertionId, field, value) => {
    updateAssertion(assertionId, (item) => ({
      ...item,
      rawExtras: {
        ...(item.rawExtras || {}),
        [field]: value,
      },
    }));
  };

  const updateAssertionRawExtrasObject = (assertionId, rawExtras) => {
    updateAssertion(assertionId, (item) => ({
      ...item,
      rawExtras,
    }));
  };

  const updateAssertionRawTarget = (assertionId, field, value) => {
    updateAssertion(assertionId, (item) => ({
      ...item,
      rawExtras: {
        ...(item.rawExtras || {}),
        target: {
          ...((item.rawExtras || {}).target || {}),
          [field]: value,
        },
      },
    }));
  };

  const addCompositeAssertion = () => {
    onChange({
      ...expectation,
      assertions: [
        ...(expectation.assertions || []),
        {
          id: `composite-${Date.now()}`,
          mode: "text-exists",
          textsText: "",
          timeoutMs: "",
          intervalMs: "",
          rawExtras: {},
        },
      ],
    });
  };

  return (
    <section id="step-expectation" className={styles.inspectorGroup}>
      <div className={styles.inspectorSectionHeader}>
        <div className={styles.inspectorSectionTitle}>
          <span className={styles.inspectorSectionIcon}>
            <ListChecks />
          </span>
          <strong>Expectation</strong>
        </div>
        <div className={styles.inspectorSectionMeta}>
          <Badge variant={expectationBadgeVariant(expectation.mode)}>{expectationDisplayLabel(expectation.mode)}</Badge>
        </div>
      </div>
      <div className={styles.inspectorSectionBody}>
      <div className={styles.expectationSummary}>{expectationSummary(expectation)}</div>

      <div className={styles.expectationCardGrid}>
        {EXPECTATION_CARD_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.expectationCard}
            data-active={expectation.mode === option.value}
            onClick={() => applyMode(option.value)}
          >
            <span className={styles.optionChoiceHeader}>
              <span className={styles.expectationCardTitle}>{option.label}</span>
              <OptionDescriptionHint label={option.label} description={option.description} />
            </span>
          </button>
        ))}
      </div>

      {expectation.mode !== "none" && expectation.mode !== "waitForChange" ? (
        <>
          {!["composite", "assertDom", "assertResponse", "networkResponse"].includes(expectation.mode) ? (
            <div className={styles.field}>
              <label>{expectation.mode === "text-absent" ? "Texts to disappear" : "Texts to appear"}</label>
              <Textarea
                rows={3}
                value={expectation.textsText}
                onChange={(event) => updateField("textsText", event.target.value)}
                placeholder={eg("欢迎回来")}
              />
            </div>
          ) : null}

          <div className={styles.grid2}>
            <div className={styles.field}>
              <label>Timeout (ms)</label>
              <NumberInput value={expectation.timeoutMs} onChange={(value) => updateField("timeoutMs", value)} />
            </div>
            <div className={styles.field}>
              <label>Interval (ms)</label>
              <NumberInput value={expectation.intervalMs} onChange={(value) => updateField("intervalMs", value)} />
            </div>
          </div>
          {["text-exists", "text-absent"].includes(expectation.mode) ? (
            <div className={styles.inspectorSubGroup}>
              <div className={styles.inlineHeader}>
                <strong>Scope</strong>
                <Badge variant="neutral">optional</Badge>
              </div>
              <div className={styles.grid2}>
                <div className={styles.field}>
                  <label>Scope role</label>
                  <Input
                    value={expectation.scope?.role || ""}
                    onChange={(event) => updateScope("role", event.target.value)}
                    placeholder={eg("dialog / form / region")}
                  />
                </div>
                <div className={styles.field}>
                  <label>Scope near text</label>
                  <Input
                    value={expectation.scope?.nearText || ""}
                    onChange={(event) => updateScope("nearText", event.target.value)}
                    placeholder={eg("创建任务任务")}
                  />
                </div>
                <div className={styles.field}>
                  <label>Scope locator</label>
                  <Input
                    value={expectation.scope?.locator || ""}
                    onChange={(event) => updateScope("locator", event.target.value)}
                    placeholder={eg(".ant-modal-content")}
                  />
                </div>
                <div className={styles.field}>
                  <label>Scope test id</label>
                  <Input
                    value={expectation.scope?.testId || ""}
                    onChange={(event) => updateScope("testId", event.target.value)}
                    placeholder={eg("create-task-modal")}
                  />
                </div>
              </div>
            </div>
          ) : null}
          {expectation.mode === "assertDom" ? (
            <div className={styles.inspectorSubGroup}>
              <div className={styles.inlineHeader}>
                <strong>DOM target and state</strong>
                <Badge variant="neutral">structured</Badge>
                <Button type="button" variant="outline" size="sm" onClick={() => onOpenPageStructure?.("expectationTarget")}>
                  <ScanSearch data-icon="inline-start" />
                  Pick from page
                </Button>
              </div>
              <div className={styles.grid2}>
                <div className={styles.field}>
                  <label>Target locator</label>
                  <Input value={expectation.rawExtras?.target?.locator || ""} onChange={(event) => updateRawTarget("locator", event.target.value)} placeholder={eg(".result-row")} />
                </div>
                <div className={styles.field}>
                  <label>Target test id</label>
                  <Input value={expectation.rawExtras?.target?.testId || ""} onChange={(event) => updateRawTarget("testId", event.target.value)} placeholder={eg("demo-result-table")} />
                </div>
                <div className={styles.field}>
                  <label>Has text</label>
                  <Input value={expectation.rawExtras?.target?.hasText || ""} onChange={(event) => updateRawTarget("hasText", event.target.value)} placeholder={eg("快速任务")} />
                </div>
                <div className={styles.field}>
                  <label>Tag text</label>
                  <Input value={expectation.rawExtras?.target?.tagText || ""} onChange={(event) => updateRawTarget("tagText", event.target.value)} placeholder={eg("任务跟进")} />
                </div>
                <div className={styles.field}>
                  <label>Tag match</label>
                  <SelectField
                    value={expectation.rawExtras?.target?.tagMatch || "exact"}
                    onChange={(value) => updateRawTarget("tagMatch", value)}
                    options={["exact", "contains", "startsWith"].map((value) => ({ value, label: value }))}
                  />
                </div>
                <div className={styles.field}>
                  <label>Property</label>
                  <SelectField
                    value={expectation.rawExtras?.property || "exists"}
                    onChange={(value) => updateRawExtra("property", value)}
                    options={["exists", "visible", "count", "text", "value", "checked", "disabled", "selected", "attribute", "class"].map((value) => ({ value, label: value }))}
                  />
                </div>
                <div className={styles.field}>
                  <label>Operator</label>
                  <SelectField
                    value={expectation.rawExtras?.operator || "equals"}
                    onChange={(value) => updateRawExtra("operator", value)}
                    options={["equals", "contains", "matches", "exists", "notExists", "atLeast", "atMost", "greaterThan", "lessThan"].map((value) => ({ value, label: value }))}
                  />
                </div>
                <div className={styles.field}>
                  <label>Expected</label>
                  <Input value={expectation.rawExtras?.expected ?? ""} onChange={(event) => updateRawExtra("expected", event.target.value)} />
                </div>
                <div className={styles.field}>
                  <label>Attribute</label>
                  <Input value={expectation.rawExtras?.attribute || ""} onChange={(event) => updateRawExtra("attribute", event.target.value)} placeholder={eg("data-status")} />
                </div>
              </div>
            </div>
          ) : null}
          {["assertResponse", "networkResponse"].includes(expectation.mode) ? (
            <div className={styles.inspectorSubGroup}>
              <div className={styles.inlineHeader}>
                <strong>Response check</strong>
                <Badge variant="neutral">{expectation.mode === "networkResponse" ? "page network" : "callApi"}</Badge>
              </div>
              <div className={styles.grid2}>
                <div className={styles.field}>
                  <label>Status</label>
                  <NumberInput value={expectation.rawExtras?.status ?? ""} onChange={(value) => updateRawExtra("status", value)} placeholder={eg("200")} />
                </div>
                <div className={styles.field}>
                  <label>URL includes</label>
                  <Input value={expectation.rawExtras?.urlIncludes || ""} onChange={(event) => updateRawExtra("urlIncludes", event.target.value)} placeholder={eg("/api/demo")} />
                </div>
                <div className={styles.field}>
                  <label>Body path</label>
                  <Input value={expectation.rawExtras?.body?.[0]?.path || ""} onChange={(event) => updateRawExtra("body", [{ ...(expectation.rawExtras?.body?.[0] || {}), path: event.target.value }])} placeholder={eg("data.status")} />
                </div>
                <div className={styles.field}>
                  <label>Body expected</label>
                  <Input value={expectation.rawExtras?.body?.[0]?.expected ?? ""} onChange={(event) => updateRawExtra("body", [{ ...(expectation.rawExtras?.body?.[0] || {}), expected: event.target.value }])} placeholder={eg("8")} />
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {expectation.mode === "waitForChange" ? (
        <div className={styles.grid2}>
          <div className={styles.field}>
            <label>Timeout (ms)</label>
            <NumberInput value={expectation.timeoutMs} onChange={(value) => updateField("timeoutMs", value)} />
          </div>
          <div className={styles.field}>
            <label>Interval (ms)</label>
            <NumberInput value={expectation.intervalMs} onChange={(value) => updateField("intervalMs", value)} />
          </div>
          <div className={styles.field}>
            <label>Threshold</label>
            <NumberInput value={expectation.threshold} onChange={(value) => updateField("threshold", value)} />
          </div>
        </div>
      ) : null}

      {expectation.mode === "region-similar" ? (
        <>
          <div className={styles.field}>
            <label>Reference data URL</label>
            <Textarea
              rows={4}
              value={expectation.reference}
              onChange={(event) => updateField("reference", event.target.value)}
              placeholder={eg("data:image/png;base64,...")}
            />
          </div>
          <div className={styles.grid2}>
            {["x", "y", "width", "height"].map((field) => (
              <div key={field} className={styles.field}>
                <label>{field}</label>
                <NumberInput value={expectation.region[field]} onChange={(value) => updateRegion(field, value)} />
              </div>
            ))}
          </div>
          <div className={styles.field}>
            <label>Threshold</label>
            <NumberInput value={expectation.threshold} onChange={(value) => updateField("threshold", value)} />
          </div>
        </>
      ) : null}

      {expectation.mode === "composite" ? (
        <div className={styles.compositeStack}>
          {(expectation.assertions || []).map((assertion, index) => (
            <div key={assertion.id} className={styles.assertionBlock}>
              <div className={styles.assertionHeader}>
                <div className={styles.assertionTitleGroup}>
                  <span className={styles.assertionIndex}>{index + 1}</span>
                  <div>
                    <strong>Assertion {index + 1}</strong>
                    <span>{expectationDisplayLabel(assertion.mode)}</span>
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className={styles.assertionRemoveButton}
                  onClick={() =>
                    updateField(
                      "assertions",
                      expectation.assertions.filter((item) => item.id !== assertion.id),
                    )
                  }
                >
                  <Trash2 data-icon="inline-start" />
                  Remove
                </Button>
              </div>
              <div className={styles.grid2}>
                <div className={styles.field}>
                  <label>Mode</label>
                  <SelectField
                    value={assertion.mode}
                    onChange={(value) => updateAssertion(assertion.id, (item) => ({ ...item, mode: value }))}
                    options={
                      assertion.mode === "waitForChange"
                        ? [...compositeModeOptions, { value: "waitForChange", label: "Page changes" }]
                        : compositeModeOptions
                    }
                  />
                </div>
                <div className={styles.field}>
                  <label>Timeout (ms)</label>
                  <NumberInput
                    value={assertion.timeoutMs}
                    onChange={(value) => updateAssertion(assertion.id, (item) => ({ ...item, timeoutMs: value }))}
                  />
                </div>
              </div>
              {["text-exists", "text-absent"].includes(assertion.mode) ? (
                <div className={styles.field}>
                  <label>Texts</label>
                  <Textarea
                    rows={3}
                    value={assertion.textsText}
                    onChange={(event) =>
                      updateAssertion(assertion.id, (item) => ({ ...item, textsText: event.target.value }))
                    }
                  />
                </div>
              ) : null}
              {assertion.mode === "assertDom" ? (
                <div className={styles.inspectorSubGroup}>
                  <div className={styles.inlineHeader}>
                    <strong>DOM target and state</strong>
                    <Badge variant="neutral">structured</Badge>
                  </div>
                  <div className={styles.grid2}>
                    <div className={styles.field}>
                      <label>Target locator</label>
                      <Input
                        value={assertion.rawExtras?.target?.locator || ""}
                        onChange={(event) => updateAssertionRawTarget(assertion.id, "locator", event.target.value)}
                        placeholder={eg(".ant-table-row")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Target test id</label>
                      <Input
                        value={assertion.rawExtras?.target?.testId || ""}
                        onChange={(event) => updateAssertionRawTarget(assertion.id, "testId", event.target.value)}
                        placeholder={eg("demo-workflow-table")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Has text</label>
                      <Input
                        value={assertion.rawExtras?.target?.hasText || ""}
                        onChange={(event) => updateAssertionRawTarget(assertion.id, "hasText", event.target.value)}
                        placeholder={eg("自动化测试-快速任务-{{$timestamp}}")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Tag text</label>
                      <Input
                        value={assertion.rawExtras?.target?.tagText || ""}
                        onChange={(event) => updateAssertionRawTarget(assertion.id, "tagText", event.target.value)}
                        placeholder={eg("任务跟进")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Tag match</label>
                      <SelectField
                        value={assertion.rawExtras?.target?.tagMatch || "exact"}
                        onChange={(value) => updateAssertionRawTarget(assertion.id, "tagMatch", value)}
                        options={["exact", "contains", "startsWith"].map((value) => ({ value, label: value }))}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Property</label>
                      <SelectField
                        value={assertion.rawExtras?.property || "exists"}
                        onChange={(value) => updateAssertionRawExtra(assertion.id, "property", value)}
                        options={["exists", "visible", "count", "text", "value", "checked", "disabled", "selected", "attribute", "class"].map((value) => ({ value, label: value }))}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Operator</label>
                      <SelectField
                        value={assertion.rawExtras?.operator || "equals"}
                        onChange={(value) => updateAssertionRawExtra(assertion.id, "operator", value)}
                        options={["equals", "contains", "matches", "exists", "notExists", "atLeast", "atMost", "greaterThan", "lessThan"].map((value) => ({ value, label: value }))}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Expected</label>
                      <Input
                        value={assertion.rawExtras?.expected ?? ""}
                        onChange={(event) => updateAssertionRawExtra(assertion.id, "expected", event.target.value)}
                        placeholder={eg("任务跟进")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Attribute</label>
                      <Input
                        value={assertion.rawExtras?.attribute || ""}
                        onChange={(event) => updateAssertionRawExtra(assertion.id, "attribute", event.target.value)}
                        placeholder={eg("data-status")}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
              {assertion.mode === "networkResponse" ? (
                <div className={styles.inspectorSubGroup}>
                  <div className={styles.inlineHeader}>
                    <strong>Response check</strong>
                    <Badge variant="neutral">page network</Badge>
                  </div>
                  <div className={styles.grid2}>
                    <div className={styles.field}>
                      <label>Status</label>
                      <NumberInput
                        value={assertion.rawExtras?.status ?? ""}
                        onChange={(value) => updateAssertionRawExtra(assertion.id, "status", value)}
                        placeholder={eg("200")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>URL includes</label>
                      <Input
                        value={assertion.rawExtras?.urlIncludes || ""}
                        onChange={(event) => updateAssertionRawExtra(assertion.id, "urlIncludes", event.target.value)}
                        placeholder={eg("/api/demo")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Body path</label>
                      <Input
                        value={assertion.rawExtras?.body?.[0]?.path || ""}
                        onChange={(event) =>
                          updateAssertionRawExtra(assertion.id, "body", [{ ...(assertion.rawExtras?.body?.[0] || {}), path: event.target.value }])
                        }
                        placeholder={eg("data.status")}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Body expected</label>
                      <Input
                        value={assertion.rawExtras?.body?.[0]?.expected ?? ""}
                        onChange={(event) =>
                          updateAssertionRawExtra(assertion.id, "body", [{ ...(assertion.rawExtras?.body?.[0] || {}), expected: event.target.value }])
                        }
                        placeholder={eg("8")}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
              {(ADVANCED_EXPECTATIONS.includes(assertion.mode) || hasObjectEntries(assertion.rawExtras)) ? (
                <JsonObjectTextarea
                  label="Assertion JSON-only fields"
                  value={assertion.rawExtras || {}}
                  onChange={(value) => updateAssertionRawExtrasObject(assertion.id, value)}
                  rows={5}
                />
              ) : null}
            </div>
          ))}
          <Button variant="secondary" onClick={addCompositeAssertion}>
            <Plus data-icon="inline-start" />
            Add assertion
          </Button>
        </div>
      ) : null}

      {showExpectationJsonOnlyFields ? (
        <JsonObjectTextarea
          label="Expectation JSON-only fields"
          value={expectation.rawExtras || {}}
          onChange={updateRawExtrasObject}
          rows={6}
        />
      ) : null}
      </div>
    </section>
  );
}

const DragHandle = SortableHandle(
  forwardRef(function DragHandle(props, ref) {
    return (
      <span
        {...props}
        ref={ref}
        role="button"
        tabIndex={0}
        className={cn(styles.dragHandle, "rounded-md border border-[var(--border-subtle)] bg-[var(--panel-muted)]")}
        aria-label="Drag to reorder step"
        onClick={(event) => event.stopPropagation()}
      >
        <GripVertical className={styles.dragIcon} />
      </span>
    );
  }),
);

// Memoized: a step row only re-renders when its own inputs change (step,
// executionState — a stable map ref, active/selection, run flags, or the
// fixture/macro maps). Handlers are stabilized by the caller (rowHandlers ref
// shim) and step objects come from a useMemo'd list, so unrelated App/workspace
// state changes (sidebar collapse, browser-state pushes, typing elsewhere) no
// longer re-render all 52/92 rows.
const StepSummary = memo(forwardRef(function StepSummary(
  {
    step,
    stepKey,
    executionState,
    sortIndex,
    active,
    onSelect,
    onEdit,
    onCopyTitle,
    onDuplicate,
    onRemove,
    onRunStep,
    onShowExecutionStatus,
    total,
    isRunning,
    allowStepRun,
    showExecutionStatus,
    fixtureMap,
    macroMap,
    readOnly = false,
    allowEdit = false,
    flowPhase = "case",
  },
  ref,
) {
  const expectationMode = step.expectation?.mode || "none";
  const visibleStatus = executionState?.status || "pending";
  const fixtureReferences = buildFixtureReferenceItems(getStepFixtureNames(step), fixtureMap);
  const macroReferences = buildMacroReferenceItems(getStepMacroNames(step), macroMap);
  const isMacroStep = step.type === "useMacro" || macroReferences.length > 0;
  const canEditStep = !readOnly;
  const canOpenEditor = canEditStep || allowEdit;
  const displayPhase = flowPhase || step.phase || "case";
  const stepTone = getStepTone({ ...step, phase: displayPhase });

  return (
    <Card
      ref={ref}
      className={cn(styles.stepCard, "shadow-none")}
      data-active={active}
      data-readonly={readOnly ? "true" : "false"}
      data-phase={displayPhase}
      data-step-tone={stepTone}
      data-reference={isMacroStep ? "macro" : undefined}
      data-flow-step-id={stepKey || step.id}
      onClick={() => onSelect(stepKey || step.id)}
    >
      <div className={styles.stepTop}>
        <div className={styles.stepHeading}>
          {canEditStep ? <DragHandle /> : <span className={styles.flowStepMarker} aria-hidden="true" />}
          <div>
            <div className={styles.stepIndex}>Step {sortIndex + 1}</div>
            <FullTextTooltip content={getStepDisplayTitle(step)} side="top" align="start">
              <div className={styles.stepQuery}>{getStepDisplayTitle(step)}</div>
            </FullTextTooltip>
          </div>
        </div>
        <div className={styles.stepTopRight}>
          {canOpenEditor ? (
          <div className={styles.stepActions}>
            {allowStepRun ? (
              <Button
                variant="outline"
                size="icon-sm"
	                className={styles.stepActionIcon}
	                onClick={(event) => {
	                  event.stopPropagation();
                  const debugPayload = {
                    stepId: step.id,
                    stepKey: stepKey || step.id,
                    phase: step.phase || flowPhase || "case",
                    sourceFixture: step.sourceFixture || "",
                    sourceMacro: step.sourceMacro || "",
                    buildSource: step._buildSource || null,
                  };
                  console.info("[BuildCases][RunStep:click]", debugPayload);
                  writeRunDebugLog("build-cases.click", debugPayload);
	                  onRunStep(stepKey || step.id, step);
	                }}
                disabled={isRunning}
                title="Run step"
                aria-label="Run step"
              >
                <Play data-icon="inline-start" />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon-sm"
              className={styles.stepActionIcon}
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit?.(stepKey || step.id);
                }}
              title="Edit step"
              aria-label="Edit step"
            >
                <PencilLine />
              </Button>
            {canEditStep ? (
              <>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className={styles.stepActionIcon}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopyTitle(step.id);
                  }}
                  title="Copy step title"
                  aria-label="Copy step title"
                >
                  <ClipboardCopy />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className={styles.stepActionIcon}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDuplicate(step.id);
                  }}
                  title="Duplicate step"
                  aria-label="Duplicate step"
                >
                  <Copy data-icon="inline-start" />
                </Button>
                <Button
                  variant="destructive"
                  size="icon-sm"
                  className={styles.stepActionIcon}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(step.id);
                  }}
                  disabled={total === 1}
                  title="Delete step"
                  aria-label="Delete step"
                >
                  <Trash2 />
                </Button>
              </>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>

      <div className={styles.badgeRow}>
        <div className={styles.stepTagGroup}>
          {readOnly ? <Badge variant="neutral">{phaseLabel(displayPhase).toLowerCase()}</Badge> : null}
          <span className={styles.flowTag} data-kind={stepTone}>{step.type}</span>
          {isMacroStep ? <span className={styles.flowTag} data-kind="macro">useMacro</span> : null}
          {fixtureReferences.map((item) => (
            <span key={item.name} className={styles.flowTag} data-kind="fixture">
              {item.name}
            </span>
          ))}
          <span className={styles.flowTag}>{expectationDisplayLabel(expectationMode)}</span>
          {navigationBadgeLabel(step.navigationBehavior) ? <span className={styles.flowTag}>{navigationBadgeLabel(step.navigationBehavior)}</span> : null}
          {step.needRes ? <span className={styles.flowTag}>evidence</span> : null}
        </div>
        {showExecutionStatus ? (
          <button
            type="button"
            className={styles.statusTagButton}
            data-status={visibleStatus}
            onClick={(event) => {
              event.stopPropagation();
              onShowExecutionStatus(stepKey || step.id);
            }}
          >
            <ExecutionStatusIcon status={visibleStatus} />
            <span>{executionLabel(visibleStatus)}</span>
          </button>
        ) : null}
      </div>
    </Card>
  );
}));

const SortableStepSummary = SortableElement(StepSummary);

const SortableStepList = SortableContainer(
  forwardRef(function SortableStepList(
    {
      steps,
      selectedStepId,
      executionByStepId,
      onSelect,
      onEdit,
      onCopyTitle,
      onDuplicate,
      onRemove,
      onRunStep,
      onShowExecutionStatus,
      isRunning,
      allowStepRun,
      showExecutionStatus,
      fixtureMap,
      macroMap,
      flowPhase = "case",
    },
    ref,
  ) {
    return (
      <div ref={ref} className={styles.stepList}>
        {steps.map((step, index) => {
          const stepKey = getFlowStepKey(step, index);
          return (
          <SortableStepSummary
            key={stepKey}
            index={index}
            sortIndex={index}
            step={step}
            stepKey={stepKey}
            executionState={getExecutionStateForStep(executionByStepId, step, flowPhase, index)}
            total={steps.length}
            active={selectedStepId === stepKey}
            onSelect={onSelect}
            onEdit={onEdit}
            onCopyTitle={onCopyTitle}
            onDuplicate={onDuplicate}
            onRemove={onRemove}
            onRunStep={onRunStep}
            onShowExecutionStatus={onShowExecutionStatus}
            isRunning={isRunning}
            allowStepRun={allowStepRun}
            showExecutionStatus={showExecutionStatus}
            fixtureMap={fixtureMap}
            macroMap={macroMap}
            flowPhase={flowPhase}
          />
          );
        })}
      </div>
    );
  }),
);

function StaticStepList({
  steps,
  selectedStepId,
  executionByStepId,
  onSelect,
  onEdit,
  onShowExecutionStatus,
  onRunStep,
  isRunning,
  allowStepRun = false,
  showExecutionStatus,
  fixtureMap,
  macroMap,
  flowPhase,
  startIndex = 0,
  allowEdit = false,
}) {
  if (!steps.length) {
    return null;
  }
  return (
    <div className={styles.stepList}>
      {steps.map((step, index) => {
        const stepKey = getFlowStepKey(step, startIndex + index);
        return (
        <StepSummary
          key={stepKey}
          step={step}
          stepKey={stepKey}
          sortIndex={startIndex + index}
          executionState={getExecutionStateForStep(executionByStepId, step, flowPhase, startIndex + index)}
          total={steps.length}
          active={selectedStepId === stepKey}
          onSelect={onSelect}
          onEdit={onEdit}
          onRunStep={onRunStep}
          onShowExecutionStatus={onShowExecutionStatus}
          isRunning={isRunning}
          allowStepRun={allowStepRun}
          showExecutionStatus={showExecutionStatus}
          fixtureMap={fixtureMap}
          macroMap={macroMap}
          readOnly
          allowEdit={allowEdit}
          flowPhase={flowPhase}
        />
        );
      })}
    </div>
  );
}

function FlowSection({ id, title, subtitle, count, status = "pending", collapsed, onToggle, tone = "case", children, footer }) {
  return (
    <section className={styles.flowSection} data-tone={tone} data-collapsed={collapsed ? "true" : "false"}>
      <button type="button" className={styles.flowSectionHeader} onClick={onToggle} aria-expanded={!collapsed} aria-controls={id}>
        <span className={styles.flowSectionRail} aria-hidden="true" />
        <span className={styles.flowSectionCopy}>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        <span className={styles.flowSectionMeta}>
          <Badge variant="neutral">{count} steps</Badge>
          <span className={styles.flowSectionStatus} data-status={status} aria-label={`${title} ${executionLabel(status)}`}>
            <ExecutionStatusIcon status={status} />
            <span>{executionLabel(status)}</span>
          </span>
          {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </span>
      </button>
      {collapsed ? null : (
        <div id={id} className={styles.flowSectionBody}>
          {children}
          {footer}
        </div>
      )}
    </section>
  );
}

function InspectorSection({ id, title, icon: Icon, meta, children }) {
  return (
    <section id={id} className={styles.inspectorGroup}>
      <div className={styles.inspectorSectionHeader}>
        <div className={styles.inspectorSectionTitle}>
          <span className={styles.inspectorSectionIcon}>
            <Icon />
          </span>
          <strong>{title}</strong>
        </div>
        {meta ? <div className={styles.inspectorSectionMeta}>{meta}</div> : null}
      </div>
      <div className={styles.inspectorSectionBody}>{children}</div>
    </section>
  );
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hydrateInspectorStep(rawStep = null) {
  if (!rawStep) {
    return null;
  }
  const defaults = createEmptyStep(rawStep.type || "click");
  const expectation = asPlainObject(rawStep.expectation);
  return {
    ...defaults,
    ...rawStep,
    targetScope: {
      ...defaults.targetScope,
      ...asPlainObject(rawStep.targetScope),
    },
    navigationTarget: {
      ...defaults.navigationTarget,
      ...asPlainObject(rawStep.navigationTarget),
    },
    autoScroll: {
      ...defaults.autoScroll,
      ...asPlainObject(rawStep.autoScroll),
    },
    expectation: {
      ...defaults.expectation,
      ...expectation,
      region: {
        ...(defaults.expectation?.region || {}),
        ...asPlainObject(expectation.region),
      },
      scope: {
        ...(defaults.expectation?.scope || {}),
        ...asPlainObject(expectation.scope),
      },
      rawExtras: {
        ...(defaults.expectation?.rawExtras || {}),
        ...asPlainObject(expectation.rawExtras),
      },
      assertions: Array.isArray(expectation.assertions) ? expectation.assertions : defaults.expectation?.assertions || [],
    },
  };
}

export function StepInspector({ step: rawStep, onFieldChange, onExpectationChange }) {
  const step = hydrateInspectorStep(rawStep);
  const [pageStructureOpen, setPageStructureOpen] = useState(false);
  const [pageStructureMode, setPageStructureMode] = useState("target");
  if (!step) {
    return (
      <div className={styles.emptyInspector}>
        <Search className="size-4" />
        Select a step to edit its config, assertions, and advanced runtime flags.
      </div>
    );
  }
  const actionTypes = ACTION_TYPES.includes(step.type) ? ACTION_TYPES : [step.type, ...ACTION_TYPES];
  const needsTarget = !["capture", "press", "assertUrl", "callApi", "useMacro", "openUrl", "reload", "goBack", "goForward", "scroll", "waitForText", "waitForNav", "waitForIdle"].includes(step.type);
  const showValue = ["fill", "type", "press", "selectOption", "assertCount"].includes(step.type);
  const showComboFields = step.type === "comboSearchSelect" || step.type === "cascaderSelect";
  const showCascaderFields = step.type === "cascaderSelect";
  const showUploadFields = step.type === "uploadFile";
  const showApiFields = step.type === "callApi";
  const showMacroFields = step.type === "useMacro";
  const showActionQueryFields = !showApiFields && !showComboFields && !showMacroFields;
  const navSections = [
    { id: "step-action", label: "Action", icon: MousePointerClick },
    showComboFields ? { id: "step-select", label: showCascaderFields ? "Cascader" : "Select", icon: ScanSearch } : null,
    needsTarget ? { id: "step-target", label: showComboFields ? "Advanced target" : "Target", icon: Target } : null,
    showUploadFields ? { id: "step-upload", label: "Upload", icon: Upload } : null,
    showApiFields ? { id: "step-api", label: "API", icon: ScanSearch } : null,
    showMacroFields ? { id: "step-macro", label: "Macro", icon: ListChecks } : null,
    { id: "step-expectation", label: "Checks", icon: ListChecks },
    { id: "step-runtime", label: "Runtime", icon: LoaderCircle },
    { id: "step-advanced", label: "Advanced", icon: SlidersHorizontal },
  ].filter(Boolean);
  const scrollToSection = (sectionId) => {
    document.getElementById(sectionId)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const openPageStructure = (mode = "target") => {
    setPageStructureMode(mode);
    setPageStructureOpen(true);
  };
  const applyTargetPatch = (patch = {}) => {
    if (!patch || !Object.keys(patch).length) {
      return;
    }
    if (pageStructureMode === "expectationTarget") {
      onExpectationChange(step.id, {
        ...step.expectation,
        mode: step.expectation?.mode === "none" ? "assertDom" : step.expectation?.mode || "assertDom",
        rawExtras: {
          ...(step.expectation?.rawExtras || {}),
          target: {
            ...((step.expectation?.rawExtras || {}).target || {}),
            ...(patch.locator ? { locator: patch.locator } : {}),
            ...(patch.testId ? { testId: patch.testId } : {}),
            ...(patch.role ? { role: patch.role } : {}),
            ...(patch.targetName ? { name: patch.targetName } : {}),
            ...(patch.placeholder ? { placeholder: patch.placeholder } : {}),
            ...(patch.ariaLabel ? { ariaLabel: patch.ariaLabel } : {}),
            ...(patch.title ? { title: patch.title } : {}),
          },
          property: step.expectation?.rawExtras?.property || "exists",
        },
      });
      return;
    }
    Object.entries(patch).forEach(([field, value]) => {
      if (value !== undefined && value !== null) {
        onFieldChange(step.id, field, value);
      }
    });
  };
  const applyScopePatch = (patch = {}) => {
    if (!patch || !Object.keys(patch).length) {
      return;
    }
    if (pageStructureMode === "expectationTarget") {
      onExpectationChange(step.id, {
        ...step.expectation,
        scope: {
          ...(step.expectation?.scope || {}),
          ...patch,
        },
      });
      return;
    }
    onFieldChange(step.id, "targetScope", {
      ...(step.targetScope || {}),
      ...patch,
    });
  };

  return (
    <div className={styles.inspectorWorkbench}>
      <nav className={styles.inspectorSectionNav} aria-label="Step config sections">
        {navSections.map((section) => {
          const Icon = section.icon;
          return (
            <button key={section.id} type="button" className={styles.inspectorNavButton} onClick={() => scrollToSection(section.id)}>
              <Icon />
              <span>{section.label}</span>
            </button>
          );
        })}
      </nav>
      <div className={styles.inspectorStack}>
      <InspectorSection
        id="step-action"
        title="Step config"
        icon={MousePointerClick}
        meta={<Badge variant="running">{step.type}</Badge>}
      >
        <div className={styles.field}>
          <label>Action type</label>
          <ToggleGroup
            type="single"
            value={step.type}
            onValueChange={(value) => {
              if (value) {
                onFieldChange(step.id, "type", value);
              }
            }}
            className={styles.actionTypeChoices}
            aria-label="Action type"
          >
            {actionTypes.map((type) => {
              const option =
                ACTION_TYPE_OPTIONS.find((item) => item.value === type) ||
                {
                  value: type,
                  label: type === "type" ? "Type (legacy)" : type === "inspect" ? "Inspect (legacy)" : type,
                  description: "Legacy action kept for compatibility.",
              };
              return (
                <ToggleGroupItem key={type} value={type} variant="outline" className={styles.actionTypeChoice}>
                  <span className={styles.optionChoiceHeader}>
                    <span className={styles.actionTypeTitle}>{option.label}</span>
                    <OptionDescriptionHint label={option.label} description={option.description} />
                  </span>
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        </div>
        {showActionQueryFields ? (
          <div className={styles.field}>
            <label>{step.type === "openUrl" ? "URL" : needsTarget ? "Target name / query" : "Capture label"}</label>
            <Input
              value={step.query}
              onChange={(event) => onFieldChange(step.id, "query", event.target.value)}
              placeholder={step.type === "openUrl" ? eg("https://example.com/path") : needsTarget ? eg("visible text, label, or nearby wording") : eg("optional note for this capture")}
            />
          </div>
        ) : null}
        {showValue ? (
          <div className={styles.field}>
            <label>{step.type === "press" ? "Key" : step.type === "selectOption" ? "Option" : step.type === "assertCount" ? "Expected count" : "Value"}</label>
            <Input value={step.value} onChange={(event) => onFieldChange(step.id, "value", event.target.value)} />
          </div>
        ) : null}
        {step.type === "selectOption" ? (
          <div className={styles.field}>
            <label>Option index</label>
            <NumberInput
              value={step.optionIndex}
              onChange={(value) => onFieldChange(step.id, "optionIndex", value)}
            />
          </div>
        ) : null}
        {showActionQueryFields ? (
          <div className={styles.field}>
            <label>Hints</label>
            <Textarea
              rows={3}
              value={step.hintsText}
              onChange={(event) => onFieldChange(step.id, "hintsText", event.target.value)}
              placeholder={eg("button\nprimary")}
            />
          </div>
        ) : null}
      </InspectorSection>

      {showComboFields ? (
        <InspectorSection
          id="step-select"
          title={showCascaderFields ? "Cascader select" : "Search select"}
          icon={ScanSearch}
        >
          <div className={styles.grid2}>
            <div className={styles.field}>
              <label>{showCascaderFields ? "Cascader box" : "Search box"}</label>
              <Input
                value={step.targetName || ""}
                onChange={(event) => onFieldChange(step.id, "targetName", event.target.value)}
                placeholder={showCascaderFields ? eg("请选择类目 / 类目") : eg("请输入负责人姓名搜索 / 负责人")}
              />
            </div>
            <div className={styles.field}>
              <label>Type</label>
              <Input
                value={step.query || ""}
                onChange={(event) => onFieldChange(step.id, "query", event.target.value)}
                placeholder={eg("optional search text")}
              />
            </div>
            {showCascaderFields ? (
              <div className={styles.field}>
                <label>Choose path</label>
                <Input
                  value={step.optionPathText || ""}
                  onChange={(event) => onFieldChange(step.id, "optionPathText", event.target.value)}
                  placeholder={eg("女士服装 / 婚礼及活动 / 花童 礼服")}
                />
              </div>
            ) : (
              <div className={styles.field}>
                <label>Choose option</label>
                <Input
                  value={step.optionText || ""}
                  onChange={(event) => onFieldChange(step.id, "optionText", event.target.value)}
                  placeholder={eg("促佳贸易")}
                />
              </div>
            )}
            <div className={styles.field}>
              <label>Scope</label>
              <Input
                value={step.nearText || ""}
                onChange={(event) => onFieldChange(step.id, "nearText", event.target.value)}
                placeholder={eg("创建任务任务")}
              />
            </div>
            <div className={styles.field}>
              <label>Option match</label>
              <SelectField
                value={step.optionMatch || "contains"}
                onChange={(value) => onFieldChange(step.id, "optionMatch", value)}
                options={["contains", "exact", "startsWith", "fuzzy"].map((value) => ({ value, label: value }))}
              />
            </div>
            <div className={styles.field}>
              <label>Option index</label>
              <NumberInput
                value={step.optionIndex}
                onChange={(value) => onFieldChange(step.id, "optionIndex", value)}
              />
            </div>
            <div className={styles.field}>
              <label>Option wait (ms)</label>
              <NumberInput
                value={step.optionWaitTimeoutMs}
                onChange={(value) => onFieldChange(step.id, "optionWaitTimeoutMs", value)}
                placeholder={eg("5000")}
              />
            </div>
            <div className={styles.field}>
              <label>Poll interval (ms)</label>
              <NumberInput
                value={step.optionPollIntervalMs}
                onChange={(value) => onFieldChange(step.id, "optionPollIntervalMs", value)}
                placeholder={eg("200")}
              />
            </div>
          </div>
        </InspectorSection>
      ) : null}

      {needsTarget ? (
        <InspectorSection
          id="step-target"
          title={showComboFields ? "Advanced target" : "Target"}
          icon={Target}
        >
          <div className={styles.grid2}>
            <div className={styles.field}>
              <label>Strategy</label>
              <SelectField
                value={step.targetStrategy || "auto"}
                onChange={(value) => onFieldChange(step.id, "targetStrategy", value)}
                options={["auto", "role", "label", "text", "placeholder", "testId", "css", "xpath", "title", "ariaLabel"].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </div>
            <div className={styles.field}>
              <label>Role</label>
              <Input value={step.role || ""} onChange={(event) => onFieldChange(step.id, "role", event.target.value)} placeholder={eg("button / textbox / combobox")} />
            </div>
            {!showComboFields ? (
              <div className={styles.field}>
                <label>Target name</label>
                <Input value={step.targetName || ""} onChange={(event) => onFieldChange(step.id, "targetName", event.target.value)} placeholder={eg("项目成员 / 上传图片")} />
              </div>
            ) : null}
            <div className={styles.field}>
              <label>Locator</label>
              <Input value={step.locator || ""} onChange={(event) => onFieldChange(step.id, "locator", event.target.value)} placeholder={eg("CSS, XPath, or test id")} />
            </div>
            <div className={styles.field}>
              <label>Placeholder</label>
              <Input value={step.placeholder || ""} onChange={(event) => onFieldChange(step.id, "placeholder", event.target.value)} placeholder={eg("请输入负责人姓名搜索")} />
            </div>
            <div className={styles.field}>
              <label>Test id</label>
              <Input value={step.testId || ""} onChange={(event) => onFieldChange(step.id, "testId", event.target.value)} />
            </div>
            <div className={styles.field}>
              <label>ARIA label</label>
              <Input value={step.ariaLabel || ""} onChange={(event) => onFieldChange(step.id, "ariaLabel", event.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Title</label>
              <Input value={step.title || ""} onChange={(event) => onFieldChange(step.id, "title", event.target.value)} />
            </div>
            {!showComboFields ? (
              <div className={styles.field}>
                <label>Near text</label>
                <Input value={step.nearText || ""} onChange={(event) => onFieldChange(step.id, "nearText", event.target.value)} placeholder={eg("container or nearby label")} />
              </div>
            ) : null}
            <div className={styles.inspectorSubGroup}>
              <div className={styles.inlineHeader}>
                <strong>Search within</strong>
                <Button type="button" variant="outline" size="sm" onClick={() => openPageStructure("scope")}>
                  <ScanSearch data-icon="inline-start" />
                  Pick scope
                </Button>
              </div>
              <div className={styles.field}>
                <label>Scope locator</label>
                <Input
                  value={step.targetScope?.locator || ""}
                  onChange={(event) => onFieldChange(step.id, "targetScope", { ...(step.targetScope || {}), locator: event.target.value })}
                  placeholder={eg(".ant-modal-content")}
                />
              </div>
              <div className={styles.field}>
                <label>Scope test id</label>
                <Input
                  value={step.targetScope?.testId || ""}
                  onChange={(event) => onFieldChange(step.id, "targetScope", { ...(step.targetScope || {}), testId: event.target.value })}
                  placeholder={eg("demo-create-task-modal")}
                />
              </div>
              <div className={styles.field}>
                <label>Scope role</label>
                <Input
                  value={step.targetScope?.role || ""}
                  onChange={(event) => onFieldChange(step.id, "targetScope", { ...(step.targetScope || {}), role: event.target.value })}
                  placeholder={eg("dialog")}
                />
              </div>
              <div className={styles.field}>
                <label>Scope near text</label>
                <Input
                  value={step.targetScope?.nearText || ""}
                  onChange={(event) => onFieldChange(step.id, "targetScope", { ...(step.targetScope || {}), nearText: event.target.value })}
                  placeholder={eg("创建任务任务")}
                />
              </div>
            </div>
            <div className={styles.field}>
              <label>Icon hint</label>
              <Input value={step.iconHint || ""} onChange={(event) => onFieldChange(step.id, "iconHint", event.target.value)} placeholder={eg("add / upload / search / delete")} />
            </div>
            <div className={styles.field}>
              <label>Candidate index</label>
              <NumberInput value={step.targetIndex || ""} onChange={(value) => onFieldChange(step.id, "targetIndex", value)} />
            </div>
          </div>
        </InspectorSection>
      ) : null}

      {showUploadFields ? (
        <InspectorSection id="step-upload" title="Upload" icon={Upload}>
          <div className={styles.field}>
            <label>File paths</label>
            <Textarea
              rows={3}
              value={step.filesText || ""}
              onChange={(event) => onFieldChange(step.id, "filesText", event.target.value)}
              placeholder={eg("test-assets/demo/fixture.png")}
            />
          </div>
          <div className={styles.field}>
            <label>Upload mode</label>
            <SelectField
              value={step.uploadMode || "chooser"}
              onChange={(value) => onFieldChange(step.id, "uploadMode", value)}
              options={[
                { value: "chooser", label: "chooser" },
                { value: "input", label: "input" },
              ]}
            />
          </div>
        </InspectorSection>
      ) : null}

      {showApiFields ? (
        <InspectorSection id="step-api" title="API request" icon={ScanSearch}>
          <div className={styles.grid2}>
            <div className={styles.field}>
              <label>Method</label>
              <SelectField
                value={step.requestMethod || "GET"}
                onChange={(value) => onFieldChange(step.id, "requestMethod", value)}
                options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value, label: value }))}
              />
            </div>
            <div className={styles.field}>
              <label>URL</label>
              <Input value={step.requestUrl || ""} onChange={(event) => onFieldChange(step.id, "requestUrl", event.target.value)} placeholder={eg("/api/demo/detail")} />
            </div>
            <div className={styles.field}>
              <label>Headers JSON</label>
              <Textarea rows={3} value={step.requestHeadersText || ""} onChange={(event) => onFieldChange(step.id, "requestHeadersText", event.target.value)} placeholder={eg('{"x-env":"test"}')} />
            </div>
            <div className={styles.field}>
              <label>Query JSON</label>
              <Textarea rows={3} value={step.requestQueryText || ""} onChange={(event) => onFieldChange(step.id, "requestQueryText", event.target.value)} placeholder={eg('{"id":"{{$runId}}"}')} />
            </div>
            <div className={styles.field}>
              <label>Body JSON</label>
              <Textarea rows={4} value={step.requestBodyText || ""} onChange={(event) => onFieldChange(step.id, "requestBodyText", event.target.value)} placeholder={eg('{"status":8}')} />
            </div>
            <div className={styles.field}>
              <label>Save as</label>
              <Input value={step.saveAs || ""} onChange={(event) => onFieldChange(step.id, "saveAs", event.target.value)} placeholder={eg("createdTask")} />
            </div>
          </div>
        </InspectorSection>
      ) : null}

      {showMacroFields ? (
        <InspectorSection id="step-macro" title="Macro" icon={ListChecks}>
          <div className={styles.field}>
            <label>Macro name</label>
            <Input
              value={step.macro || ""}
              onChange={(event) => onFieldChange(step.id, "macro", event.target.value)}
              placeholder={eg("openCreateSamplingTask")}
            />
          </div>
        </InspectorSection>
      ) : null}

      <ExpectationEditor
        expectation={step.expectation}
        onChange={(value) => onExpectationChange(step.id, value)}
        onOpenPageStructure={openPageStructure}
      />

      <InspectorSection id="step-runtime" title="Timing & retries" icon={LoaderCircle}>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <label>Timeout (ms)</label>
            <NumberInput value={step.timeoutMs} onChange={(value) => onFieldChange(step.id, "timeoutMs", value)} />
          </div>
          <div className={styles.field}>
            <label>Retries</label>
            <NumberInput value={step.retries} onChange={(value) => onFieldChange(step.id, "retries", value)} />
          </div>
          <div className={styles.field}>
            <label>Retry delay (ms)</label>
            <NumberInput value={step.retryDelayMs} onChange={(value) => onFieldChange(step.id, "retryDelayMs", value)} />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection id="step-completion" title="Completion" icon={Globe}>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <label>Navigation behavior</label>
            <SelectField
              value={step.navigationBehavior}
              onChange={(value) => onFieldChange(step.id, "navigationBehavior", value)}
              options={NAVIGATION_BEHAVIOR_OPTIONS.map((value) => ({ value, label: value }))}
            />
          </div>
          <div className={styles.field}>
            <label>Wait until</label>
            <SelectField
              value={step.waitUntil}
              onChange={(value) => onFieldChange(step.id, "waitUntil", value)}
              options={WAIT_UNTIL_OPTIONS.map((value) => ({ value, label: value }))}
            />
          </div>
          <div className={styles.field}>
            <label>Navigation timeout (ms)</label>
            <NumberInput
              value={step.navigationTimeoutMs}
              onChange={(value) => onFieldChange(step.id, "navigationTimeoutMs", value)}
            />
          </div>
          <div className={styles.field}>
            <label>Stabilization delay (ms)</label>
            <NumberInput
              value={step.stabilizationDelayMs}
              onChange={(value) => onFieldChange(step.id, "stabilizationDelayMs", value)}
            />
          </div>
          <div className={styles.field}>
            <label>URL includes</label>
            <Input
              value={step.navigationTarget.urlIncludes}
              onChange={(event) =>
                onFieldChange(step.id, "navigationTarget", {
                  ...step.navigationTarget,
                  urlIncludes: event.target.value,
                })
              }
            />
          </div>
          <div className={styles.field}>
            <label>URL matches (RegExp)</label>
            <Input
              value={step.navigationTarget.urlMatches}
              onChange={(event) =>
                onFieldChange(step.id, "navigationTarget", {
                  ...step.navigationTarget,
                  urlMatches: event.target.value,
                })
              }
            />
          </div>
          <div className={styles.field}>
            <label>Path equals</label>
            <Input
              value={step.navigationTarget.pathEquals}
              onChange={(event) =>
                onFieldChange(step.id, "navigationTarget", {
                  ...step.navigationTarget,
                  pathEquals: event.target.value,
                })
              }
            />
          </div>
          <div className={styles.field}>
            <label>Title includes</label>
            <Input
              value={step.navigationTarget.titleIncludes}
              onChange={(event) =>
                onFieldChange(step.id, "navigationTarget", {
                  ...step.navigationTarget,
                  titleIncludes: event.target.value,
                })
              }
            />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection id="step-advanced" title="Advanced" icon={SlidersHorizontal}>
        <div className={styles.toggleGrid}>
          {[
            "needRes",
            "strictMatch",
            "enableScroll",
            "waitForNav",
            "waitForIdle",
          ].map((field) => (
            <div key={field} className={styles.fieldSwitchRow}>
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{ADVANCED_FIELD_META[field].label}</div>
                <div className="text-xs text-[var(--muted-foreground)]">{ADVANCED_FIELD_META[field].description}</div>
              </div>
              <Switch
                checked={Boolean(step[field])}
                onCheckedChange={(checked) => onFieldChange(step.id, field, checked)}
              />
            </div>
          ))}
        </div>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <label>Auto scroll: maxSteps</label>
            <div className="text-xs text-[var(--muted-foreground)]">Only used when auto scroll is enabled.</div>
            <NumberInput
              value={step.autoScroll.maxSteps}
              onChange={(value) =>
                onFieldChange(step.id, "autoScroll", {
                  ...step.autoScroll,
                  maxSteps: value,
                })
              }
            />
          </div>
          <div className={styles.field}>
            <label>Auto scroll: deltaY</label>
            <div className="text-xs text-[var(--muted-foreground)]">Only used when auto scroll is enabled.</div>
            <NumberInput
              value={step.autoScroll.deltaY}
              onChange={(value) =>
                onFieldChange(step.id, "autoScroll", {
                  ...step.autoScroll,
                  deltaY: value,
                })
              }
            />
          </div>
          <div className={styles.field}>
            <label>Auto scroll: settleMs</label>
            <div className="text-xs text-[var(--muted-foreground)]">Only used when auto scroll is enabled.</div>
            <NumberInput
              value={step.autoScroll.settleMs}
              onChange={(value) =>
                onFieldChange(step.id, "autoScroll", {
                  ...step.autoScroll,
                  settleMs: value,
                })
              }
            />
          </div>
        </div>
        {(hasObjectEntries(step.rawExtras) || hasObjectEntries(step.targetExtras)) ? (
          <div className={styles.jsonOnlyStack}>
            {hasObjectEntries(step.rawExtras) ? (
              <JsonObjectTextarea
                label="Action JSON-only fields"
                value={step.rawExtras || {}}
                onChange={(value) => onFieldChange(step.id, "rawExtras", value)}
                rows={5}
              />
            ) : null}
            {hasObjectEntries(step.targetExtras) ? (
              <JsonObjectTextarea
                label="Target JSON-only fields"
                value={step.targetExtras || {}}
                onChange={(value) => onFieldChange(step.id, "targetExtras", value)}
                rows={5}
              />
            ) : null}
          </div>
        ) : null}
      </InspectorSection>
      </div>
      <Sheet open={pageStructureOpen} onOpenChange={setPageStructureOpen}>
        <SheetContent side="right" className={styles.pageStructureSheet} aria-describedby={undefined}>
          <SheetHeader className={styles.inspectorSheetHeader}>
            <SheetTitle>Page structure</SheetTitle>
            <SheetDescription>
              Read the current controlled page DOM and apply stable target or scope fields to this step draft.
            </SheetDescription>
          </SheetHeader>
          <PageStructureViewer
            className={styles.pageStructureViewer}
            onApplyTarget={(patch) => {
              applyTargetPatch(patch);
              setPageStructureOpen(false);
            }}
            onApplyScope={(patch) => {
              applyScopePatch(patch);
              setPageStructureOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RunWorkspaceRail({
  browserState,
  navInput,
  defaultUrl,
  onNavInputChange,
  onNavigate,
  onCommand,
  onOpenPageStructure,
  onRunPayload,
  onStopRun,
  runButtonLabel = "Run case",
  isRunning,
  isStoppingRun,
  runProgress,
  onClearRunState,
  runVariableDraft,
  onRunVariableDraftChange,
  stepCount = 0,
}) {
  const [addressValue, setAddressValue] = useState(defaultUrl || navInput || browserState?.url || "");
  const defaultUrlRef = useRef(defaultUrl || "");
  useEffect(() => {
    const nextDefaultUrl = defaultUrl || "";
    if (nextDefaultUrl !== defaultUrlRef.current) {
      defaultUrlRef.current = nextDefaultUrl;
      const nextAddress = nextDefaultUrl || navInput || browserState?.url || "";
      setAddressValue(nextAddress);
      if (nextDefaultUrl) {
        onNavInputChange?.(nextDefaultUrl);
      }
      return;
    }
    if (!nextDefaultUrl && !addressValue) {
      setAddressValue(navInput || browserState?.url || "");
    }
  }, [addressValue, browserState?.url, defaultUrl, navInput, onNavInputChange]);
  const completedSteps = runProgress.steps.filter((step) => ["passed", "failed", "skipped"].includes(step.status)).length;
  const failedStep = runProgress.steps.find((step) => step.status === "failed") || null;
  const activeStep =
    (typeof runProgress.currentStepIndex === "number" && runProgress.steps[runProgress.currentStepIndex]) || null;
  const evidenceStep =
    failedStep ||
    activeStep ||
    [...(runProgress.steps || [])].reverse().find((step) => step.evidence) ||
    null;
  const evidence = evidenceStep?.evidence || null;
  const beforePath = evidence?.beforeScreenshotPath || "";
  const afterPath = evidence?.afterScreenshotPath || "";
  const [imageCache, setImageCache] = useState({});
  const imageCacheRef = useRef({});
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const activePaths = [...new Set([beforePath, afterPath].filter(Boolean))];
    const retainedCache = retainEvidenceImageCache(imageCacheRef.current, activePaths);
    imageCacheRef.current = retainedCache;
    setImageCache(retainedCache);
    setLightbox((current) => (
      current?.path && !activePaths.includes(current.path) ? null : current
    ));
    activePaths.forEach((imagePath) => {
      const cached = imageCacheRef.current[imagePath];
      if (cached?.status === "loaded" || cached?.status === "loading") {
        return;
      }
      const loadingCache = {
        ...imageCacheRef.current,
        [imagePath]: { status: "loading" },
      };
      imageCacheRef.current = loadingCache;
      setImageCache(loadingCache);
      resolveEvidenceImageSrc(imagePath)
        .then((payload) => {
          if (cancelled) {
            return;
          }
          const nextCache = {
            ...imageCacheRef.current,
            [imagePath]: payload?.success
              ? { status: "loaded", src: payload.src, streamed: Boolean(payload.streamed) }
              : { status: "error", error: payload?.error || "read-failed" },
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
            [imagePath]: { status: "error", error: error?.message || "read-failed" },
          };
          imageCacheRef.current = nextCache;
          setImageCache(nextCache);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [beforePath, afterPath]);

  const failureMessage = failedStep?.error?.message || runProgress.result?.error?.message || "";
  const tracePath = evidence?.tracePath || "";
  const ocrPath = evidence?.ocrPath || "";
  const totalSteps = runProgress.steps.length;
  const currentStepLabel = activeStep
    ? `Step ${activeStep.index + 1}`
    : evidenceStep
      ? `Step ${evidenceStep.index + 1}`
      : "Idle";
  const currentStepTitle = activeStep || evidenceStep
    ? `${phaseLabel((activeStep || evidenceStep).phase)} · ${(activeStep || evidenceStep).query || (activeStep || evidenceStep).type}`
    : "No active step";
  const evidenceLabel = evidenceStep ? `Step ${evidenceStep.index + 1}` : "No evidence yet";

  return (
    <aside className={styles.runRail}>
      <Card className={styles.railPanel}>
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
          <div>
            <div className={styles.kicker}>Inline test</div>
            <CardTitle className="mt-1 text-base">Browser controls</CardTitle>
          </div>
          <Badge variant={runStatusVariant(runProgress.status)}>
            {isRunning ? "Running" : browserState?.isLoading ? "Loading" : "Ready"}
          </Badge>
        </CardHeader>

        <form
          className="grid gap-3 px-3 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            onNavigate(addressValue);
          }}
        >
          <div className={styles.addressRow}>
            <Input
              value={addressValue}
              onChange={(event) => {
                setAddressValue(event.target.value);
                onNavInputChange(event.target.value);
              }}
              placeholder="https://example.com"
            />
            <Button type="submit" variant="secondary" size="icon" title="Navigate" aria-label="Navigate">
              <Globe className="size-4" />
            </Button>
          </div>

          <div className={styles.commandRow}>
            <Button type="button" variant="outline" size="icon" onClick={() => onCommand("back")} title="Back" aria-label="Back">
              <ArrowLeft />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => onCommand("forward")} title="Forward" aria-label="Forward">
              <ArrowRight />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => onCommand("reload")} title="Reload" aria-label="Reload">
              <RefreshCw />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => onCommand("stop")} title="Stop" aria-label="Stop">
              <Square />
            </Button>
            <RunVariablesPopover
              value={runVariableDraft}
              onChange={onRunVariableDraftChange}
              disabled={isRunning || isStoppingRun}
              stepCount={stepCount}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={onOpenPageStructure}
              title="Page structure"
              aria-label="Page structure"
            >
              <ScanSearch />
            </Button>
            <Button
              type="button"
              variant={isRunning ? "outline" : "secondary"}
              className={styles.inlineRunButton}
              onClick={isRunning ? onStopRun : onRunPayload}
              disabled={isStoppingRun}
            >
              {isRunning ? <Square data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              {isStoppingRun ? "Stopping" : isRunning ? "Stop run" : runButtonLabel}
            </Button>
          </div>
        </form>
      </Card>

      <Card className={styles.railPanel}>
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
          <div>
            <div className={styles.kicker}>Execution status</div>
            <CardTitle className="mt-1 text-base">Run snapshot</CardTitle>
          </div>
          <Button variant="outline" size="sm" onClick={onClearRunState}>
            Clear
          </Button>
        </CardHeader>

        <CardContent className={styles.statusPanelContent}>
          <div className={styles.runSnapshotHero} data-status={runProgress.status}>
            <div className={styles.runSnapshotTopline}>
              <Badge variant={runStatusVariant(runProgress.status)}>
                {executionLabel(runProgress.status)}
              </Badge>
              <span>{completedSteps}/{totalSteps} steps</span>
            </div>
            <strong>{currentStepLabel}</strong>
            <p>{currentStepTitle}</p>
          </div>

          <Alert className={cn(styles.runSnapshotAlert, failureMessage ? styles.runSnapshotFailure : styles.runSnapshotNotice)}>
            {failureMessage ? <AlertCircle /> : <CheckCircle2 />}
            <AlertTitle>{failureMessage ? "Failure" : "Run state is clean"}</AlertTitle>
            <AlertDescription>{failureMessage || "No run error captured."}</AlertDescription>
          </Alert>

          <section className={styles.inlineEvidenceBlock} aria-label="Run evidence">
            <div className={styles.inlineEvidenceHeader}>
              <div>
                <strong>Evidence</strong>
                <span>{evidenceLabel}</span>
              </div>
            </div>
            <div className={styles.inlineEvidenceGrid}>
              <InlineEvidenceThumb
                label="Before"
                path={beforePath}
                image={imageCache[beforePath]}
                onPreview={(payload) => setLightbox(payload)}
              />
              <InlineEvidenceThumb
                label="After"
                path={afterPath}
                image={imageCache[afterPath]}
                onPreview={(payload) => setLightbox(payload)}
              />
            </div>
            <details className={styles.evidenceDetails}>
              <summary>Trace & OCR</summary>
              <div className={styles.evidencePathList}>
                <EvidencePathRow label="Trace" value={tracePath} />
                <EvidencePathRow label="OCR" value={ocrPath} />
              </div>
            </details>
          </section>
        </CardContent>
      </Card>

      {lightbox ? (
        <div className={styles.inlineLightbox} role="dialog" aria-modal="true" aria-label={`${lightbox.label} evidence preview`}>
          <button type="button" className={styles.inlineLightboxScrim} aria-label="Close preview" onClick={() => setLightbox(null)} />
          <div className={styles.inlineLightboxPanel}>
            <div className={styles.inlineLightboxHeader}>
              <div>
                <strong>{lightbox.label}</strong>
                <span>Evidence preview</span>
              </div>
              <Button type="button" variant="secondary" size="icon-sm" aria-label="Close preview" onClick={() => setLightbox(null)}>
                <X />
              </Button>
            </div>
            <div className={styles.inlineLightboxCanvas}>
              <img src={lightbox.src} alt={`${lightbox.label} evidence`} />
            </div>
            <div className={styles.inlineLightboxPath}>{lightbox.path}</div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function InlineEvidenceThumb({ label, path, image, onPreview }) {
  const ready = path && image?.status === "loaded" && image.src;
  const loading = path && image?.status === "loading";
  const error = path && image?.status === "error";

  return (
    <div className={styles.inlineEvidenceThumb}>
      <div className={styles.inlineEvidenceThumbHeader}>
        <span>{label}</span>
        {ready ? (
          <Button type="button" variant="outline" size="sm" aria-label={`Preview ${label}`} onClick={() => onPreview({ label, path, src: image.src })}>
            <Maximize2 data-icon="inline-start" />
            Preview
          </Button>
        ) : path ? (
          <span className={styles.inlineEvidenceState}>{loading ? "Loading" : error ? "Failed" : "Pending"}</span>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.inlineEvidenceImage}
        disabled={!ready}
        data-ready={Boolean(ready)}
        onClick={() => onPreview({ label, path, src: image.src })}
      >
        {ready ? (
          <>
            <img src={image.src} alt={`${label} screenshot`} loading="lazy" decoding="async" />
            <span className={styles.inlineEvidenceImageHint}>
            <Maximize2 />
            Open preview
            </span>
          </>
        ) : (
          <span>
            {loading ? <Loader2 className={styles.statusSpin} /> : <ImageOff />}
            {path ? (error ? "Load failed" : "Loading") : "No image"}
          </span>
        )}
      </button>
    </div>
  );
}

function EvidencePathRow({ label, value }) {
  return (
    <div className={styles.evidencePathRow}>
      <span>{label}</span>
      <strong title={value || ""}>{value || "-"}</strong>
    </div>
  );
}

function ExecutionStatusSheet({
  open,
  onOpenChange,
  step,
  executionState,
  shouldAvoidTitlebar = false,
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={styles.executionSheet}
        data-titlebar-safe={shouldAvoidTitlebar ? "true" : "false"}
      >
        <SheetHeader className={styles.inspectorSheetHeader}>
          <SheetTitle>{step ? `Execution status · Step ${executionState?.index + 1}` : "Execution status"}</SheetTitle>
          <SheetDescription>
            Review the last runtime feedback for this node, including the failure reason when execution stops here.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className={cn(styles.executionSheetBody, styles.sheetScroll)}>
          <div className="grid gap-3 p-3">
          {step ? (
            <StepExecutionDetail
              step={step}
              executionState={executionState}
              tracePath={executionState?.evidence?.tracePath}
            />
          ) : (
            <Alert>
              <Search />
              <AlertTitle>No step execution selected</AlertTitle>
              <AlertDescription>Select a step status badge to review its latest runtime evidence.</AlertDescription>
            </Alert>
          )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export function OrchestratorWorkspace({
  browserState,
  panelPlatform = "web",
  isWindowFullScreen = false,
  navInput,
  onNavInputChange,
  onNavigate,
  onCommand,
  draft,
  draftWarnings = [],
  authoringMode,
  editorText,
  editorError,
  syncMessage,
  onAuthoringModeChange,
  onStepFieldChange,
  onStepExpectationChange,
  onSharedStepPatch,
  onAddStep,
  onDuplicateStep,
  onRemoveStep,
  onSortStep,
  onEditorTextChange,
  onApplyGeneratedJson,
  onRunPayload,
  onRunStep,
  onStopRun,
  onClearRunState,
  isRunning,
  isStoppingRun,
  runProgress,
  testFile,
  selectedCaseId,
  buildTargetType = "case",
  rootStepPhase = "setup",
  onSelectCase,
  onSelectRootSteps,
  onRootStepPhaseChange,
  onCaseMetaChange,
  onAddCase,
  onDuplicateCase,
  onRemoveCase,
  onRestoreDeletedCase,
  deletedCaseName,
  buildStepFocusRequest,
  onBuildStepFocusConsumed,
}) {
  const previewItems = useMemo(() => summarizeDraftActions(draft), [draft]);
  const isRootTarget = buildTargetType === "root";
  const selectedCase = testFile?.cases?.find((item) => item.id === selectedCaseId) || testFile?.cases?.[0] || null;
  const selectedCaseExecution = useMemo(() => {
    if (isRootTarget || !selectedCase?.id) {
      return null;
    }
    return (runProgress?.cases || []).find((caseItem) => caseItem.caseId === selectedCase.id) || null;
  }, [isRootTarget, runProgress, selectedCase?.id]);
  const targetRunProgress = useMemo(() => {
    if (isRootTarget || !selectedCaseExecution || !selectedCase?.id) {
      return runProgress;
    }
    return getRunProgressForCase(runProgress, selectedCase.id);
  }, [isRootTarget, runProgress, selectedCase?.id, selectedCaseExecution]);
  const rootProgressSteps = useMemo(
    () => (Array.isArray(runProgress?.rootSteps) && runProgress.rootSteps.length ? runProgress.rootSteps : runProgress?.steps || []),
    [runProgress],
  );
  const executionByStepId = useMemo(
    () => createExecutionStateMap(targetRunProgress?.steps || []),
    [targetRunProgress],
  );
  const rootExecutionByStepId = useMemo(
    () =>
      createExecutionStateMap(rootProgressSteps.filter((step) => step.phase === rootStepPhase)),
    [rootProgressSteps, rootStepPhase],
  );
  const flowExecutionByStepId = isRootTarget ? rootExecutionByStepId : executionByStepId;
  const rootExecutionStatus = useMemo(
    () =>
      deriveExecutionGroupStatus(
        rootProgressSteps.filter((step) => step.phase === "setup" || step.phase === "teardown"),
      ),
    [rootProgressSteps],
  );
  const caseExecutionById = useMemo(
    () => new Map((runProgress?.cases || []).map((caseItem) => [caseItem.caseId, caseItem])),
    [runProgress],
  );
  const showStepExecutionStatus = Boolean(
    isRunning ||
      isStoppingRun ||
      runProgress?.runId ||
      runProgress?.startedAt ||
      runProgress?.finishedAt ||
      runProgress?.result ||
      (runProgress?.status && runProgress.status !== "idle"),
  );
  const showCaseExecutionStatus = showStepExecutionStatus;
  const shouldAvoidTitlebar = panelPlatform === "darwin" && !isWindowFullScreen;
  const [selectedStepId, setSelectedStepId] = useState(draft.steps[0]?.id || null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorDraftStep, setInspectorDraftStep] = useState(null);
  const [caseSheetOpen, setCaseSheetOpen] = useState(false);
  const [browserPageStructureOpen, setBrowserPageStructureOpen] = useState(false);
  const [executionStepId, setExecutionStepId] = useState(null);
  const [warningsCollapsed, setWarningsCollapsed] = useState(true);
  const [runVariableDraft, setRunVariableDraft] = useState({ ...EMPTY_RUN_VARIABLE_DRAFT });
  const [flowSectionCollapsed, setFlowSectionCollapsed] = useState({
    fixtureSetup: true,
    case: false,
    fixtureTeardown: true,
  });
  const canvasStackRef = useRef(null);
  const [visualPanelLayout, handleVisualPanelLayoutChanged] = usePersistedPanelLayout(
    "zhuzhu-build-cases-visual-layout",
    BUILD_CASES_VISUAL_LAYOUT,
  );
  const [expertPanelLayout, handleExpertPanelLayoutChanged] = usePersistedPanelLayout(
    "zhuzhu-build-cases-expert-layout",
    BUILD_CASES_EXPERT_LAYOUT,
  );
  const activeRunVariableOverrides = useMemo(
    () => getActiveRunVariableOverrides(runVariableDraft),
    [runVariableDraft],
  );
  const activeRunVariableCount = Object.keys(activeRunVariableOverrides).length;
  const stopOnFailure = normalizeRunVariableDraft(runVariableDraft).stopOnFailure;
  const includeRootSteps = normalizeRunVariableDraft(runVariableDraft).includeRootSteps;
  const includeCaseFixtures = normalizeRunVariableDraft(runVariableDraft).includeCaseFixtures;
  const navigateToBaseUrlBeforeRun = normalizeRunVariableDraft(runVariableDraft).navigateToBaseUrlBeforeRun;
  const activeRunStepRange = useMemo(
    () => getActiveRunStepRange(runVariableDraft, draft.steps.length),
    [draft.steps.length, runVariableDraft],
  );

  const handleRunPayload = (request = "selected") => {
    const requestPayload = typeof request === "string" ? { scope: request } : { ...(request || {}) };
    onRunPayload?.(
      {
        ...requestPayload,
        stopOnFailure,
        includeRootSteps,
        includeCaseFixtures,
        navigateToBaseUrlBeforeRun,
        ...(activeRunStepRange ? { runStepRange: activeRunStepRange } : {}),
        ...(activeRunVariableCount ? { runtimeVariables: activeRunVariableOverrides } : {}),
      },
    );
  };

		  const handleRunStep = (stepId, sourceStep = null) => {
		    const flowStep =
		      sourceStep ||
		      allFlowSteps.find((step, index) => getFlowStepKey(step, index) === stepId || step.id === stepId);
    const debugPayload = {
      inputStepId: stepId,
      resolvedStepId: flowStep?.id || stepId,
      resolvedFlowKey: flowStep ? getFlowStepKey(flowStep) : "",
      phase: flowStep?.phase || "",
      sourceFixture: flowStep?.sourceFixture || "",
      sourceMacro: flowStep?.sourceMacro || "",
      found: Boolean(flowStep),
    };
    console.info("[BuildCases][RunStep:resolve]", debugPayload);
    writeRunDebugLog("build-cases.resolve", debugPayload);
	    onRunStep?.(flowStep?.id || stepId, activeRunVariableCount ? activeRunVariableOverrides : null, {
      stopOnFailure,
      includeRootSteps,
      includeCaseFixtures,
      navigateToBaseUrlBeforeRun,
      ...(flowStep?.phase ? { stepPhase: flowStep.phase } : {}),
      ...(flowStep?.sourceFixture ? { sourceFixture: flowStep.sourceFixture } : {}),
      ...(flowStep?.sourceMacro ? { sourceMacro: flowStep.sourceMacro } : {}),
    });
  };

  const runningStepId = useMemo(() => {
    if (!isRunning) {
      return null;
    }
    const visibleSteps = isRootTarget
      ? rootProgressSteps.filter((step) => step.phase === rootStepPhase)
      : targetRunProgress?.steps || [];
    const runningStep = visibleSteps.find((step) => step.status === "running");
    if (runningStep?.stepId) {
      return runningStep.stepId;
    }
    if (!isRootTarget && Number.isInteger(targetRunProgress?.currentStepIndex)) {
      return targetRunProgress.steps?.[targetRunProgress.currentStepIndex]?.stepId || draft.steps[targetRunProgress.currentStepIndex]?.id || null;
    }
    return null;
  }, [draft.steps, isRootTarget, isRunning, rootProgressSteps, rootStepPhase, targetRunProgress]);

  useEffect(() => {
    if (!runningStepId || authoringMode !== "visual") {
      return undefined;
    }
    const frameId = window.requestAnimationFrame(() => {
      const target = [...(canvasStackRef.current?.querySelectorAll("[data-flow-step-id]") || [])].find(
        (element) => element.dataset.flowStepId === runningStepId || element.dataset.flowStepId?.endsWith(`::${runningStepId}`),
      );
      target?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [authoringMode, runningStepId]);

  // Stable identities so they don't defeat the memoized step rows (the raw
  // `|| {}` fallback would be a fresh object every render).
  const fixtureMap = useMemo(() => testFile?.fixtures || {}, [testFile?.fixtures]);
  const macroMap = useMemo(() => testFile?.macros || {}, [testFile?.macros]);
  // Stable handler identities for the step rows: `rowHandlers` is created once
  // and delegates to the latest handler via a ref updated each render, so
  // React.memo(StepSummary) is effective while the row always calls current
  // logic (no stale closures). Assigned after the handlers are defined below.
  const rowHandlersRef = useRef({});
  const rowHandlers = useMemo(
    () => ({
      onSelect: (...args) => rowHandlersRef.current.onSelect?.(...args),
      onEdit: (...args) => rowHandlersRef.current.onEdit?.(...args),
      onCopyTitle: (...args) => rowHandlersRef.current.onCopyTitle?.(...args),
      onDuplicate: (...args) => rowHandlersRef.current.onDuplicate?.(...args),
      onRemove: (...args) => rowHandlersRef.current.onRemove?.(...args),
      onRunStep: (...args) => rowHandlersRef.current.onRunStep?.(...args),
      onShowExecutionStatus: (...args) => rowHandlersRef.current.onShowExecutionStatus?.(...args),
    }),
    [],
  );
  const fixtureFlow = useMemo(
    () => (isRootTarget ? { setupSteps: [], teardownSteps: [] } : buildFixtureFlowSections(selectedCase, fixtureMap)),
    [fixtureMap, isRootTarget, selectedCase],
  );
  const macroFlowSections = useMemo(
    () => (isRootTarget
      ? []
      : buildMacroFlowSections([...fixtureFlow.setupSteps, ...draft.steps, ...fixtureFlow.teardownSteps], macroMap)),
    [draft.steps, fixtureFlow.setupSteps, fixtureFlow.teardownSteps, isRootTarget, macroMap],
  );
  const allFlowSteps = useMemo(
    () => [
      ...fixtureFlow.setupSteps,
      ...draft.steps,
      ...fixtureFlow.teardownSteps,
      ...macroFlowSections.flatMap((section) => section.steps),
    ],
    [draft.steps, fixtureFlow.setupSteps, fixtureFlow.teardownSteps, macroFlowSections],
  );
  const selectedStep = allFlowSteps.find((step, index) => getFlowStepKey(step, index) === selectedStepId || step.id === selectedStepId) || null;
  const executionStep = allFlowSteps.find((step, index) => getFlowStepKey(step, index) === executionStepId || step.id === executionStepId) || null;
  const executionState = executionStep
    ? getExecutionStateForStep(flowExecutionByStepId, executionStep, executionStep.phase || "case")
    : null;
  const setupStepCount = isRootTarget && rootStepPhase === "setup" ? draft.steps.length : testFile?.setup?.steps?.length || 0;
  const teardownStepCount = isRootTarget && rootStepPhase === "teardown" ? draft.steps.length : testFile?.teardown?.steps?.length || 0;
  const rootReferenceSteps = useMemo(() => {
    const setupSteps = rootStepPhase === "setup" && isRootTarget ? draft.steps : testFile?.setup?.steps || [];
    const teardownSteps = rootStepPhase === "teardown" && isRootTarget ? draft.steps : testFile?.teardown?.steps || [];
    return [...setupSteps, ...teardownSteps];
  }, [draft.steps, isRootTarget, rootStepPhase, testFile?.setup?.steps, testFile?.teardown?.steps]);
  const rootMacroReferences = useMemo(
    () => buildMacroReferenceItems(collectMacroNamesFromSteps(rootReferenceSteps), macroMap),
    [macroMap, rootReferenceSteps],
  );
  const activeFlowLabel = isRootTarget
    ? rootStepPhase === "teardown"
      ? "Root teardown"
      : "Root setup"
    : selectedCase?.name || "Current case";
  const visibleFlowStepCount = isRootTarget
    ? draft.steps.length
    : fixtureFlow.setupSteps.length + draft.steps.length + fixtureFlow.teardownSteps.length + macroFlowSections.reduce((sum, section) => sum + section.steps.length, 0);
  const fixtureSetupSectionStatus = useMemo(
    () => deriveFlowSectionStatus(flowExecutionByStepId, fixtureFlow.setupSteps, "fixtureSetup"),
    [fixtureFlow.setupSteps, flowExecutionByStepId],
  );
  const caseSectionStatus = useMemo(
    () => deriveFlowSectionStatus(flowExecutionByStepId, draft.steps, "case"),
    [draft.steps, flowExecutionByStepId],
  );
  const fixtureTeardownSectionStatus = useMemo(
    () => deriveFlowSectionStatus(flowExecutionByStepId, fixtureFlow.teardownSteps, "fixtureTeardown", fixtureFlow.setupSteps.length + draft.steps.length),
    [draft.steps.length, fixtureFlow.setupSteps.length, fixtureFlow.teardownSteps, flowExecutionByStepId],
  );
  const macroSectionStatuses = useMemo(
    () =>
      new Map(
        macroFlowSections.map((macroSection) => [
          macroSection.name,
          deriveFlowSectionStatus(flowExecutionByStepId, macroSection.steps, "macro"),
        ]),
      ),
    [flowExecutionByStepId, macroFlowSections],
  );

  useEffect(() => {
    if (!buildStepFocusRequest?.stepId || authoringMode !== "visual") {
      return undefined;
    }
    const targetStep = allFlowSteps.find((step) => step.id === buildStepFocusRequest.stepId);
    if (!targetStep) {
      onBuildStepFocusConsumed?.();
      return undefined;
    }
    const targetPhase = targetStep.phase || buildStepFocusRequest.phase || "case";
    setSelectedStepId(getFlowStepKey(targetStep));
    setFlowSectionCollapsed((current) => ({
      ...current,
      fixtureSetup: targetPhase === "fixtureSetup" ? false : current.fixtureSetup,
      case: targetPhase === "case" ? false : current.case,
      fixtureTeardown: targetPhase === "fixtureTeardown" ? false : current.fixtureTeardown,
      ...(targetPhase === "macro" && targetStep.sourceMacro ? { [`macro:${targetStep.sourceMacro}`]: false } : {}),
    }));
    const timeoutId = window.setTimeout(() => {
      const target = [...(canvasStackRef.current?.querySelectorAll("[data-flow-step-id]") || [])].find(
        (element) => element.dataset.flowStepId === getFlowStepKey(targetStep),
      );
      target?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
      onBuildStepFocusConsumed?.();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [allFlowSteps, authoringMode, buildStepFocusRequest, onBuildStepFocusConsumed]);

  useEffect(() => {
    if (!allFlowSteps.some((step, index) => getFlowStepKey(step, index) === selectedStepId || step.id === selectedStepId)) {
      setSelectedStepId(draft.steps[0]?.id || (allFlowSteps[0] ? getFlowStepKey(allFlowSteps[0], 0) : null));
    }
  }, [allFlowSteps, draft.steps, selectedStepId]);

  useEffect(() => {
    if (inspectorOpen && selectedStep) {
      setInspectorDraftStep(JSON.parse(JSON.stringify(selectedStep)));
      return;
    }
    setInspectorDraftStep(null);
  }, [inspectorOpen, selectedStepId, selectedStep?._flowKey, selectedStep?.id]);

  const handleEditStep = (stepId) => {
    setSelectedStepId(stepId);
    setInspectorOpen(true);
  };

  const handleSelectStep = (stepId) => {
    setSelectedStepId(stepId);
    setExecutionStepId(stepId);
  };

  const handleCopyStepTitle = (stepId) => {
    const step = draft.steps.find((item) => item.id === stepId);
    copyTextToClipboard(step?.stepTitle || (step ? getStepDisplayTitle(step) : ""));
  };

  const handleCopyCaseTitle = (caseItem) => {
    copyTextToClipboard(caseItem?.name || "");
  };

  const applyStepFieldValue = (step, field, value) => {
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
    if (field === "type" && value === "callApi") {
      next.requestMethod = next.requestMethod || "GET";
      next.needRes = true;
      if (!next.expectation || next.expectation.mode === "none") {
        next.expectation = {
          ...next.expectation,
          mode: "assertResponse",
          rawExtras: {
            status: 200,
          },
        };
      }
    }
    if (field === "type" && value === "useMacro") {
      next.needRes = false;
      next.macro = next.macro || "";
      next.expectation = {
        ...next.expectation,
        mode: "none",
      };
    }
    return next;
  };

  const handleInspectorFieldChange = (stepId, field, value) => {
    setInspectorDraftStep((current) => {
      if (!current || (current.id !== stepId && getFlowStepKey(current) !== stepId)) {
        return current;
      }
      return applyStepFieldValue(current, field, value);
    });
  };

  const handleInspectorExpectationChange = (stepId, value) => {
    setInspectorDraftStep((current) =>
      current && (current.id === stepId || getFlowStepKey(current) === stepId)
        ? { ...current, expectation: value }
        : current);
  };

  const handleDiscardInspector = () => {
    setInspectorOpen(false);
    setInspectorDraftStep(null);
  };

  const handleSaveInspectorStep = () => {
    if (!selectedStep || !inspectorDraftStep) {
      setInspectorOpen(false);
      return;
    }
    const source = selectedStep._buildSource || null;
    const patch = {};
    Object.entries(inspectorDraftStep).forEach(([field, value]) => {
      if (
        field === "id" ||
        field.startsWith("_") ||
        ((source?.type === "fixture" || source?.type === "macro") && ["phase", "sourceFixture", "sourceMacro"].includes(field))
      ) {
        return;
      }
      const currentValue = selectedStep[field];
      if (JSON.stringify(currentValue) === JSON.stringify(value)) {
        return;
      }
      patch[field] = value;
    });
    if (source?.type === "fixture" || source?.type === "macro") {
      const runtimeDraftStep = {
        ...inspectorDraftStep,
      };
      delete runtimeDraftStep.phase;
      delete runtimeDraftStep.sourceFixture;
      delete runtimeDraftStep.sourceMacro;
      delete runtimeDraftStep._flowKey;
      delete runtimeDraftStep._buildSource;
      delete runtimeDraftStep._rawRuntimeStep;
      const runtimeStep = draftToRuntimePayload({ steps: [runtimeDraftStep] });
      onSharedStepPatch?.(source, selectedStep.id, runtimeStep);
      setInspectorOpen(false);
      setInspectorDraftStep(null);
      return;
    }
    Object.entries(patch).forEach(([field, value]) => {
      if (field === "expectation") {
        onStepExpectationChange(selectedStep.id, value);
        return;
      }
      onStepFieldChange(selectedStep.id, field, value);
    });
    setInspectorOpen(false);
    setInspectorDraftStep(null);
  };

  const handleOpenExecutionStatus = (stepId) => {
    setSelectedStepId(stepId);
    setExecutionStepId(stepId);
  };

  // Point the stable row-handler shim at this render's latest handlers.
  rowHandlersRef.current = {
    onSelect: handleSelectStep,
    onEdit: handleEditStep,
    onCopyTitle: handleCopyStepTitle,
    onDuplicate: onDuplicateStep,
    onRemove: onRemoveStep,
    onRunStep: handleRunStep,
    onShowExecutionStatus: handleOpenExecutionStatus,
  };

  const handleAddCaseFromList = () => {
    onAddCase?.();
    setCaseSheetOpen(true);
  };

  const handleDuplicateSelectedCase = () => {
    if (!selectedCase) {
      return;
    }
    onDuplicateCase?.(selectedCase.id);
    setCaseSheetOpen(true);
  };

  const handleRemoveSelectedCase = () => {
    if (!selectedCase) {
      return;
    }
    onRemoveCase?.(selectedCase.id);
  };

  const handleAddStepFromCanvas = () => {
    const nextStepId = onAddStep?.("click");
    if (nextStepId) {
      setSelectedStepId(nextStepId);
    }
    setInspectorOpen(true);
  };

  const toggleFlowSection = (sectionKey) => {
    setFlowSectionCollapsed((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }));
  };

  const modeToggle = (
    <ToggleGroup
      type="single"
      value={authoringMode}
      onValueChange={(value) => {
        if (value) {
          onAuthoringModeChange(value);
        }
      }}
      className={styles.modeToggle}
      aria-label="Authoring mode"
    >
      <ToggleGroupItem value="visual" size="sm" className={styles.modeToggleItem}>
        Visual
      </ToggleGroupItem>
      <ToggleGroupItem value="expert" size="sm" className={styles.modeToggleItem}>
        JSON
      </ToggleGroupItem>
    </ToggleGroup>
  );

  const rootPhaseToggle = isRootTarget ? (
    <ToggleGroup
      type="single"
      value={rootStepPhase}
      onValueChange={(value) => {
        if (value) {
          onRootStepPhaseChange?.(value);
        }
      }}
      className={cn(styles.modeToggle, styles.rootPhaseToggle)}
      aria-label="Root step phase"
    >
      <ToggleGroupItem value="setup" size="sm" className={styles.modeToggleItem}>
        Setup
      </ToggleGroupItem>
      <ToggleGroupItem value="teardown" size="sm" className={styles.modeToggleItem}>
        Teardown
      </ToggleGroupItem>
    </ToggleGroup>
  ) : null;

  const warningPanel = draftWarnings.length ? (
    warningsCollapsed ? (
      <div role="alert">
        <button
          type="button"
          className={styles.warningCompact}
          onClick={() => setWarningsCollapsed(false)}
          aria-expanded="false"
        >
          <AlertCircle aria-hidden="true" />
          <div className={styles.warningCompactCopy}>
            <strong>Draft warnings</strong>
            <span>Review {draftWarnings.length} draft quality warnings before running.</span>
          </div>
          <span className={styles.warningToggle}>
            <ChevronRight aria-hidden="true" />
            {draftWarnings.length} warnings
          </span>
        </button>
      </div>
    ) : (
      <div className={styles.warningPanel} role="alert">
        <button
          type="button"
          className={styles.warningHeader}
          onClick={() => setWarningsCollapsed(true)}
          aria-expanded="true"
        >
          <span className={styles.warningHeaderCopy}>
            <AlertCircle aria-hidden="true" />
            <span>Draft warnings</span>
          </span>
          <span className={styles.warningToggle}>
            <ChevronDown aria-hidden="true" />
            Collapse
          </span>
        </button>
        <ul className={styles.warningList}>
          {draftWarnings.map((warning) => (
            <li key={`${warning.code}-${warning.stepId || warning.stepIndex}-${warning.path}`}>
              {warning.message}
            </li>
          ))}
        </ul>
      </div>
    )
  ) : null;

  const caseListPanel = (
    <Card className={styles.casePanel}>
      <CardContent className={styles.casePanelContent}>
        <div className={styles.caseList}>
          <div className={styles.caseListHeader}>
            <div>
              <div className={styles.kicker}>Cases</div>
              <FullTextTooltip content={testFile?.name || "Untitled test file"} side="bottom" align="start">
                <strong>{testFile?.name || "Untitled test file"}</strong>
              </FullTextTooltip>
            </div>
            <Button variant="secondary" size="sm" onClick={handleAddCaseFromList}>
              <Plus data-icon="inline-start" />
              Case
            </Button>
          </div>
          <ScrollArea className={styles.caseListScroll}>
            <div className={styles.caseItems}>
              <button
                type="button"
                className={cn(styles.caseItem, styles.rootCaseItem)}
                data-active={isRootTarget}
                data-case-tone="root"
                onClick={() => onSelectRootSteps?.()}
              >
                <div className={styles.caseItemTitleRow}>
                  <span>Root steps</span>
                  {showStepExecutionStatus ? (
                    <span
                      className={styles.caseRunStatus}
                      data-status={rootExecutionStatus}
                      title={executionLabel(rootExecutionStatus)}
                      aria-label={`Root steps status: ${executionLabel(rootExecutionStatus)}`}
                    >
                      <ExecutionStatusIcon status={rootExecutionStatus} />
                    </span>
                  ) : null}
                </div>
                <div className={styles.caseItemMetaRow}>
                  <small>Setup {setupStepCount} · Teardown {teardownStepCount}</small>
                </div>
                <ReferenceTags kind="macro" items={rootMacroReferences} />
              </button>
              {(testFile?.cases || []).map((caseItem) => {
                const caseExecution = caseExecutionById.get(caseItem.id) || null;
                const caseStatus = caseExecution?.status || "pending";
                const caseStepsForReferences =
                  caseItem.id === selectedCaseId && !isRootTarget ? draft.steps : caseItem.steps || [];
                const fixtureReferences = buildFixtureReferenceItems(caseItem.fixtures, fixtureMap);
                const macroReferences = buildMacroReferenceItems(collectMacroNamesFromSteps(caseStepsForReferences), macroMap);
                return (
                  <div
                    key={caseItem.id}
                    role="button"
                    tabIndex={0}
                    className={styles.caseItem}
                    data-active={caseItem.id === selectedCaseId}
                    onClick={() => onSelectCase?.(caseItem.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectCase?.(caseItem.id);
                      }
                    }}
                  >
                    <div className={styles.caseItemTitleRow}>
                      <FullTextTooltip content={caseItem.name} side="right" align="start">
                        <span>{caseItem.name}</span>
                      </FullTextTooltip>
                      <div className={styles.caseItemControls}>
                        <button
                          type="button"
                          className={styles.caseTitleCopyButton}
                          title="Copy case title"
                          aria-label={`Copy case title: ${caseItem.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCopyCaseTitle(caseItem);
                          }}
                        >
                          <ClipboardCopy />
                        </button>
                        {showCaseExecutionStatus && caseExecution ? (
                          <span
                            className={styles.caseRunStatus}
                            data-status={caseStatus}
                            title={executionLabel(caseStatus)}
                            aria-label={`Case status: ${executionLabel(caseStatus)}`}
                          >
                            <ExecutionStatusIcon status={caseStatus} />
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className={styles.caseItemMetaRow}>
                      <small>{caseItem.priority || "P1"} · {caseItem.steps?.length || 0} steps</small>
                    </div>
                    <ReferenceTags kind="fixture" items={fixtureReferences} />
                    <ReferenceTags kind="macro" items={macroReferences} />
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          {deletedCaseName ? (
            <Alert className={styles.caseRestoreAlert}>
              <AlertCircle />
              <AlertTitle>Case deleted</AlertTitle>
              <AlertDescription>
                {deletedCaseName} was removed from this draft.
              </AlertDescription>
              <Button variant="secondary" size="sm" onClick={onRestoreDeletedCase}>
                Restore
              </Button>
            </Alert>
          ) : null}
          <div className={styles.caseListFooter}>
            <div>
              <div className={styles.kicker}>{isRootTarget ? "Current root flow" : "Current case"}</div>
              <strong>{isRootTarget ? activeFlowLabel : selectedCase?.name || "-"}</strong>
              <span>
                {isRootTarget
                  ? `Setup ${setupStepCount} · Teardown ${teardownStepCount}`
                  : `${selectedCase?.priority || "P1"} · ${selectedCase?.steps?.length || 0} steps`}
              </span>
            </div>
            {isRootTarget ? null : (
              <div className={styles.caseFooterActions}>
                <Button
                  variant={isRunning ? "outline" : "default"}
                  onClick={isRunning ? onStopRun : handleRunPayload}
                  disabled={!selectedCase || isStoppingRun}
                >
                  {isRunning ? <Square data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                  {isStoppingRun ? "Stopping" : isRunning ? "Stop run" : "Run case"}
                </Button>
                <RunVariablesPopover
                  value={runVariableDraft}
                  onChange={setRunVariableDraft}
                  disabled={isRunning || isStoppingRun}
                  placement="top"
                  stepCount={selectedCase?.steps?.length || 0}
                />
                <Button variant="outline" onClick={() => setCaseSheetOpen(true)} disabled={!selectedCase}>
                  <PencilLine data-icon="inline-start" />
                  Edit case
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const caseInfoSheet = (
    <Sheet open={caseSheetOpen} onOpenChange={setCaseSheetOpen}>
      <SheetContent className={styles.caseSheet}>
        <SheetHeader className={styles.inspectorSheetHeader}>
          <SheetTitle>{selectedCase ? selectedCase.name || "Untitled case" : "Case info"}</SheetTitle>
          <SheetDescription>
            Edit case-level metadata without mixing it into the step flow.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className={cn(styles.inspectorSheetBody, styles.sheetScroll)}>
          <div className={styles.caseSheetBody}>
            <div className={styles.inspectorGroup}>
              <div className={styles.inlineHeader}>
                <strong>Case config</strong>
                <Badge variant="neutral">{selectedCase?.steps?.length || 0} steps</Badge>
              </div>
              <div className={styles.field}>
                <label>Case name</label>
                <Input
                  value={selectedCase?.name || ""}
                  onChange={(event) => onCaseMetaChange?.(selectedCase.id, "name", event.target.value)}
                  placeholder="Case name"
                  disabled={!selectedCase}
                />
              </div>
              <div className={styles.grid2}>
                <div className={styles.field}>
                  <label>Priority</label>
                  <Input
                    value={selectedCase?.priority || ""}
                    onChange={(event) => onCaseMetaChange?.(selectedCase.id, "priority", event.target.value)}
                    placeholder="P0"
                    disabled={!selectedCase}
                  />
                </div>
                <div className={styles.field}>
                  <label>Tags</label>
                  <Input
                    value={(selectedCase?.tags || []).join(", ")}
                    onChange={(event) => onCaseMetaChange?.(selectedCase.id, "tags", event.target.value)}
                    placeholder="smoke, regression"
                    disabled={!selectedCase}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <label>Description</label>
                <Textarea
                  value={selectedCase?.description || ""}
                  onChange={(event) => onCaseMetaChange?.(selectedCase.id, "description", event.target.value)}
                  placeholder="Case description"
                  className={styles.caseDescription}
                  disabled={!selectedCase}
                />
              </div>
              <div className={styles.field}>
                <label>Fixtures</label>
                <Textarea
                  rows={3}
                  value={(selectedCase?.fixtures || []).join("\n")}
                  onChange={(event) => onCaseMetaChange?.(selectedCase.id, "fixtures", event.target.value)}
                  placeholder="loginSession"
                  disabled={!selectedCase}
                />
              </div>
            </div>

            <div className={styles.caseSheetActions}>
              <Button variant="secondary" onClick={handleDuplicateSelectedCase} disabled={!selectedCase}>
                <Copy data-icon="inline-start" />
                Duplicate case
              </Button>
              <Button
                variant="destructive"
                onClick={handleRemoveSelectedCase}
                disabled={!selectedCase || (testFile?.cases?.length || 0) <= 1}
              >
                <Trash2 data-icon="inline-start" />
                Delete case
              </Button>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );

  const browserPageStructureSheet = (
    <Sheet open={browserPageStructureOpen} onOpenChange={setBrowserPageStructureOpen}>
      <SheetContent side="right" className={styles.pageStructureSheet} aria-describedby={undefined}>
        <SheetHeader className={styles.inspectorSheetHeader}>
          <SheetTitle>Page structure</SheetTitle>
          <SheetDescription>
            Inspect the current controlled browser DOM tree without changing the selected step.
          </SheetDescription>
        </SheetHeader>
        <PageStructureViewer className={styles.pageStructureViewer} />
      </SheetContent>
    </Sheet>
  );

  const selectedStepIndex = selectedStep
    ? selectedStep._buildSource?.type === "fixture" || selectedStep._buildSource?.type === "macro"
      ? selectedStep._buildSource.index
      : draft.steps.findIndex((item) => item.id === selectedStep.id)
    : -1;
  const activeInspectorStep = inspectorDraftStep || selectedStep;
  const activeInspectorHasTarget = activeInspectorStep && !["capture", "useMacro"].includes(activeInspectorStep.type);
  const activeInspectorHasSecondaryAction =
    activeInspectorStep?.type === "comboSearchSelect" ||
    activeInspectorStep?.type === "cascaderSelect" ||
    activeInspectorStep?.type === "uploadFile";
  const sheet = (
    <Sheet open={inspectorOpen} onOpenChange={(open) => (open ? setInspectorOpen(true) : handleDiscardInspector())}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        overlayClassName={styles.bottomStepOverlay}
        className={styles.bottomStepDrawer}
        data-has-target={activeInspectorHasTarget ? "true" : "false"}
        data-has-secondary-action={activeInspectorHasSecondaryAction ? "true" : "false"}
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">Step editor</SheetTitle>
        <div className={styles.bottomDrawerHandle} aria-hidden="true">
          <span />
        </div>
        <div className={styles.bottomDrawerHeader}>
          <div className={styles.bottomDrawerTitle}>
            <span>{selectedStepIndex >= 0 ? selectedStepIndex + 1 : "-"}</span>
            <Input
              value={activeInspectorStep?.stepTitle || ""}
              onChange={(event) => activeInspectorStep && handleInspectorFieldChange(activeInspectorStep.id, "stepTitle", event.target.value)}
              placeholder={eg("step title")}
              disabled={!activeInspectorStep}
              aria-label="Step title"
            />
            {selectedStep?._buildSource?.type === "fixture" ? (
              <Badge variant="neutral">{`${selectedStep._buildSource.fixtureName} · ${selectedStep._buildSource.fixturePhase}`}</Badge>
            ) : null}
            {selectedStep?._buildSource?.type === "macro" ? (
              <Badge variant="neutral">{`macro · ${selectedStep._buildSource.macroName}`}</Badge>
            ) : null}
          </div>
          <div className={styles.bottomDrawerActions}>
            <Button type="button" variant="ghost" size="sm" onClick={handleDiscardInspector}>
              Discard
            </Button>
            <Button type="button" size="sm" onClick={handleSaveInspectorStep}>
              Save step
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close step editor" onClick={handleDiscardInspector}>
              <X />
            </Button>
          </div>
        </div>
        <div className={styles.bottomDrawerBody}>
          <StepInspector step={activeInspectorStep} onFieldChange={handleInspectorFieldChange} onExpectationChange={handleInspectorExpectationChange} />
        </div>
      </SheetContent>
    </Sheet>
  );

  if (authoringMode === "expert") {
    return (
      <div className={styles.workspaceStack}>
        <ResizablePanelGroup
          id="build-cases-expert-layout"
          orientation="horizontal"
          defaultLayout={expertPanelLayout}
          onLayoutChanged={handleExpertPanelLayoutChanged}
          className={cn(styles.resizableWorkbench, styles.expertResizableWorkbench)}
          resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
        >
          <ResizablePanel id="cases" defaultSize={`${expertPanelLayout.cases}%`} minSize="210px" maxSize="50%" className={styles.resizablePanel}>
            {caseListPanel}
          </ResizablePanel>
          <ResizableHandle withHandle className={styles.resizeHandle} />
          <ResizablePanel id="source" defaultSize={`${expertPanelLayout.source}%`} minSize="360px" className={styles.resizablePanel}>
            <div className={styles.canvasStack} data-has-warnings={draftWarnings.length ? "true" : "false"}>
            {warningPanel}
            <Card className={styles.jsonPanel}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
                <div>
                  <div className={styles.kicker}>{isRootTarget ? activeFlowLabel : "Expert JSON"}</div>
                  <CardTitle className={styles.sectionTitle}>Payload source of truth</CardTitle>
                </div>
                <div className={styles.canvasHeaderControls}>
                  {rootPhaseToggle}
                  {modeToggle}
                  <Badge variant={editorError ? "danger" : "success"}>{editorError ? "Parse error" : "JSON synced"}</Badge>
                </div>
              </CardHeader>
              <CardContent className={cn("gap-3 px-3 pb-3", styles.jsonPanelContent)}>
              <CodeMirror
                value={editorText}
                height="100%"
                extensions={[json()]}
                className={cn(styles.codeMirrorEditor, styles.jsonEditor)}
                onChange={(value) => onEditorTextChange(value)}
              />
              <div className={styles.toolbarRow}>
                <Button variant="secondary" onClick={onApplyGeneratedJson}>
                  <ScanSearch data-icon="inline-start" />
                  Reset from visual draft
                </Button>
              </div>
              {editorError ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>JSON parse error</AlertTitle>
                  <AlertDescription>{editorError}</AlertDescription>
                </Alert>
              ) : null}
              </CardContent>
            </Card>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle className={styles.resizeHandle} />
          <ResizablePanel id="preview" defaultSize={`${expertPanelLayout.preview}%`} minSize="280px" maxSize="440px" className={styles.resizablePanel}>
            <aside className={styles.rail}>
            <Card className={styles.railPanel}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
                <div>
                  <div className={styles.kicker}>Sync state</div>
                  <CardTitle className={styles.railTitle}>Runtime preview</CardTitle>
                </div>
                <Badge variant={editorError ? "danger" : "success"}>{syncMessage}</Badge>
              </CardHeader>
              <CardContent className="px-3 pb-3">
                <ScrollArea className="max-h-[260px] pr-3">
                  <div className={styles.previewList}>
                    {previewItems.map((item) => (
                      <Card key={item.id} className="bg-[var(--panel-muted)] shadow-none">
                        <CardContent className="grid gap-1 p-3">
                          <strong>{item.title}</strong>
                          <span>{item.meta}</span>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <RunWorkspaceRail
              browserState={browserState}
              navInput={navInput}
              defaultUrl={testFile?.baseUrl || ""}
              onNavInputChange={onNavInputChange}
              onNavigate={onNavigate}
              onCommand={onCommand}
              onOpenPageStructure={() => setBrowserPageStructureOpen(true)}
              onRunPayload={handleRunPayload}
              onStopRun={onStopRun}
              runButtonLabel="Run case"
              isRunning={isRunning}
              isStoppingRun={isStoppingRun}
              runProgress={targetRunProgress}
              onClearRunState={onClearRunState}
              runVariableDraft={runVariableDraft}
              onRunVariableDraftChange={setRunVariableDraft}
              stepCount={selectedCase?.steps?.length || 0}
            />
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
        <RuntimeVariablesPanel
          runtimeVariables={targetRunProgress?.runtimeVariables}
          runtimeVariableSources={targetRunProgress?.runtimeVariableSources}
          runtimeVariableHistory={targetRunProgress?.runtimeVariableHistory}
          updatedAt={targetRunProgress?.runtimeVariablesUpdatedAt || targetRunProgress?.finishedAt}
          compact
          floating
          className={styles.runtimeVariablesPanel}
        />
        {sheet}
        {caseInfoSheet}
        {browserPageStructureSheet}
      </div>
    );
  }

  return (
    <div className={styles.workspaceStack}>
      <ResizablePanelGroup
        id="build-cases-visual-layout"
        orientation="horizontal"
        defaultLayout={visualPanelLayout}
        onLayoutChanged={handleVisualPanelLayoutChanged}
        className={styles.resizableWorkbench}
        resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
      >
        <ResizablePanel id="cases" defaultSize={`${visualPanelLayout.cases}%`} minSize="210px" maxSize="50%" className={styles.resizablePanel}>
          {caseListPanel}
        </ResizablePanel>
        <ResizableHandle withHandle className={styles.resizeHandle} />
        <ResizablePanel id="canvas" defaultSize={`${visualPanelLayout.canvas}%`} minSize="360px" className={styles.resizablePanel}>
          <div className={styles.canvasStack} data-has-warnings={draftWarnings.length ? "true" : "false"} ref={canvasStackRef}>
          {warningPanel}
          <Card className={styles.canvasPanel}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
              <div>
                <div className={styles.canvasKickerRow}>
                  <span className={styles.kicker}>{isRootTarget ? activeFlowLabel : "Flow canvas"}</span>
                </div>
              </div>
              <div className={styles.canvasHeaderControls}>
                {rootPhaseToggle}
                {modeToggle}
                <Badge variant="neutral">{visibleFlowStepCount} steps</Badge>
              </div>
            </CardHeader>

            <CardContent className={cn("px-3 pb-3", styles.canvasPanelContent)}>
              <ScrollArea className={cn(styles.canvasScroll, "pr-3")}>
                {isRootTarget ? (
                  <SortableStepList
                    steps={draft.steps}
                    selectedStepId={selectedStepId}
                    executionByStepId={flowExecutionByStepId}
                    onSelect={rowHandlers.onSelect}
                    onEdit={rowHandlers.onEdit}
                    onCopyTitle={rowHandlers.onCopyTitle}
                    onDuplicate={rowHandlers.onDuplicate}
                    onRemove={rowHandlers.onRemove}
                    onRunStep={rowHandlers.onRunStep}
                    onShowExecutionStatus={rowHandlers.onShowExecutionStatus}
                    isRunning={isRunning}
                    allowStepRun={false}
                    showExecutionStatus={showStepExecutionStatus}
                    fixtureMap={fixtureMap}
                    macroMap={macroMap}
                    flowPhase={rootStepPhase}
                    onSortEnd={({ oldIndex, newIndex }) => onSortStep(oldIndex, newIndex)}
                    useDragHandle
                    axis="y"
                    lockAxis="y"
                    distance={4}
                    helperClass={styles.sortingHelper}
                  />
                ) : (
                  <div className={styles.flowSectionStack}>
                    {fixtureFlow.setupSteps.length ? (
                      <FlowSection
                        id="fixture-setup-flow"
                        title="Fixture setup"
                        subtitle="Case dependencies prepared before the editable case steps."
                        count={fixtureFlow.setupSteps.length}
                        status={fixtureSetupSectionStatus}
                        collapsed={flowSectionCollapsed.fixtureSetup}
                        onToggle={() => toggleFlowSection("fixtureSetup")}
                        tone="fixture"
                      >
                        <StaticStepList
                          steps={fixtureFlow.setupSteps}
                          selectedStepId={selectedStepId}
                          executionByStepId={flowExecutionByStepId}
                          onSelect={rowHandlers.onSelect}
                          onEdit={rowHandlers.onEdit}
                          onRunStep={rowHandlers.onRunStep}
                          onShowExecutionStatus={rowHandlers.onShowExecutionStatus}
                          isRunning={isRunning}
                          allowStepRun
                          showExecutionStatus={showStepExecutionStatus}
                          fixtureMap={fixtureMap}
                          macroMap={macroMap}
                          flowPhase="fixtureSetup"
                          allowEdit
                        />
                      </FlowSection>
                    ) : null}
                    <FlowSection
                      id="case-steps-flow"
                      title="Case steps"
                      subtitle="Editable steps owned by this case."
                      count={draft.steps.length}
                      status={caseSectionStatus}
                      collapsed={flowSectionCollapsed.case}
                      onToggle={() => toggleFlowSection("case")}
                      tone="case"
                      footer={
                        <div className={styles.canvasFooter}>
                          <Button type="button" variant="secondary" size="sm" onClick={handleAddStepFromCanvas}>
                            <Plus data-icon="inline-start" />
                            Add step
                          </Button>
                        </div>
                      }
                    >
                      <SortableStepList
                        steps={draft.steps}
                        selectedStepId={selectedStepId}
                        executionByStepId={flowExecutionByStepId}
                        onSelect={rowHandlers.onSelect}
                        onEdit={rowHandlers.onEdit}
                        onCopyTitle={rowHandlers.onCopyTitle}
                        onDuplicate={rowHandlers.onDuplicate}
                        onRemove={rowHandlers.onRemove}
                        onRunStep={rowHandlers.onRunStep}
                        onShowExecutionStatus={rowHandlers.onShowExecutionStatus}
                        isRunning={isRunning}
                        allowStepRun
                        showExecutionStatus={showStepExecutionStatus}
                        fixtureMap={fixtureMap}
                        macroMap={macroMap}
                        flowPhase="case"
                        onSortEnd={({ oldIndex, newIndex }) => onSortStep(oldIndex, newIndex)}
                        useDragHandle
                        axis="y"
                        lockAxis="y"
                        distance={4}
                        helperClass={styles.sortingHelper}
                      />
                    </FlowSection>
                    {fixtureFlow.teardownSteps.length ? (
                      <FlowSection
                        id="fixture-teardown-flow"
                        title="Fixture teardown"
                        subtitle="Cleanup steps that run after the case body."
                        count={fixtureFlow.teardownSteps.length}
                        status={fixtureTeardownSectionStatus}
                        collapsed={flowSectionCollapsed.fixtureTeardown}
                        onToggle={() => toggleFlowSection("fixtureTeardown")}
                        tone="fixtureTeardown"
                      >
                        <StaticStepList
                          steps={fixtureFlow.teardownSteps}
                          selectedStepId={selectedStepId}
                          executionByStepId={flowExecutionByStepId}
                          onSelect={rowHandlers.onSelect}
                          onEdit={rowHandlers.onEdit}
                          onRunStep={rowHandlers.onRunStep}
                          onShowExecutionStatus={rowHandlers.onShowExecutionStatus}
                          isRunning={isRunning}
                          allowStepRun
                          showExecutionStatus={showStepExecutionStatus}
                          fixtureMap={fixtureMap}
                          macroMap={macroMap}
                          flowPhase="fixtureTeardown"
                          startIndex={fixtureFlow.setupSteps.length + draft.steps.length}
                          allowEdit
                        />
                      </FlowSection>
                    ) : null}
                    {macroFlowSections.map((macroSection) => (
                      <FlowSection
                        key={macroSection.name}
                        id={`macro-flow-${macroSection.name}`}
                        title={`Macro: ${macroSection.name}`}
                        subtitle="Reusable steps referenced by this flow."
                        count={macroSection.steps.length}
                        status={macroSectionStatuses.get(macroSection.name) || "pending"}
                        collapsed={flowSectionCollapsed[`macro:${macroSection.name}`] ?? true}
                        onToggle={() => toggleFlowSection(`macro:${macroSection.name}`)}
                        tone="macro"
                      >
                        <StaticStepList
                          steps={macroSection.steps}
                          selectedStepId={selectedStepId}
                          executionByStepId={flowExecutionByStepId}
                          onSelect={rowHandlers.onSelect}
                          onEdit={rowHandlers.onEdit}
                          onShowExecutionStatus={rowHandlers.onShowExecutionStatus}
                          showExecutionStatus={false}
                          fixtureMap={fixtureMap}
                          macroMap={macroMap}
                          flowPhase="macro"
                          allowEdit
                        />
                      </FlowSection>
                    ))}
                  </div>
                )}
              </ScrollArea>
              {isRootTarget ? (
                <div className={styles.canvasFooter}>
                  <Button type="button" variant="secondary" size="sm" onClick={handleAddStepFromCanvas}>
                    <Plus data-icon="inline-start" />
                    Add step
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          </div>
        </ResizablePanel>
        <ResizableHandle withHandle className={styles.resizeHandle} />
        <ResizablePanel id="run" defaultSize={`${visualPanelLayout.run}%`} minSize="280px" maxSize="440px" className={styles.resizablePanel}>
          <RunWorkspaceRail
          browserState={browserState}
          navInput={navInput}
          defaultUrl={testFile?.baseUrl || ""}
          onNavInputChange={onNavInputChange}
          onNavigate={onNavigate}
          onCommand={onCommand}
          onOpenPageStructure={() => setBrowserPageStructureOpen(true)}
          onRunPayload={handleRunPayload}
          onStopRun={onStopRun}
          runButtonLabel="Run case"
          isRunning={isRunning}
          isStoppingRun={isStoppingRun}
          runProgress={targetRunProgress}
          onClearRunState={onClearRunState}
          runVariableDraft={runVariableDraft}
          onRunVariableDraftChange={setRunVariableDraft}
          stepCount={selectedCase?.steps?.length || 0}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <RuntimeVariablesPanel
        runtimeVariables={targetRunProgress?.runtimeVariables}
        runtimeVariableSources={targetRunProgress?.runtimeVariableSources}
        runtimeVariableHistory={targetRunProgress?.runtimeVariableHistory}
        updatedAt={targetRunProgress?.runtimeVariablesUpdatedAt || targetRunProgress?.finishedAt}
        compact
        floating
        className={styles.runtimeVariablesPanel}
      />
      {sheet}
      {caseInfoSheet}
      {browserPageStructureSheet}
      <ExecutionStatusSheet
        open={Boolean(executionStepId)}
        onOpenChange={(open) => {
          if (!open) {
            setExecutionStepId(null);
          }
        }}
        step={executionStep}
        executionState={executionState}
        shouldAvoidTitlebar={shouldAvoidTitlebar}
      />
    </div>
  );
}
