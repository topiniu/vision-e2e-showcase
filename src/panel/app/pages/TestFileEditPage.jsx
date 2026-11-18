import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Checkbox } from "@panel/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@panel/components/ui/collapsible";
import { Input } from "@panel/components/ui/input";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@panel/components/ui/select";
import { Separator } from "@panel/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@panel/components/ui/sheet";
import { Switch } from "@panel/components/ui/switch";
import { Textarea } from "@panel/components/ui/textarea";
import { cn } from "@panel/lib/utils";
import { StepInspector } from "@panel/features/orchestrator/OrchestratorWorkspace";
import {
  createEmptyStep,
  draftToRuntimePayload,
  getStepDisplayTitle,
  runtimePayloadToDraft,
} from "@panel/lib/payload-draft.mjs";

const EVIDENCE_PROFILE_OPTIONS = [
  {
    value: "debug",
    label: "Debug",
    description: "Full evidence",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Trace first",
  },
  {
    value: "turbo",
    label: "Turbo",
    description: "Light evidence",
  },
];

const SECTIONS = [
  { id: "identity", label: "Identity" },
  { id: "requirement", label: "Requirement" },
  { id: "run", label: "Run defaults" },
  { id: "scaffold", label: "Scaffold" },
];

export function TestFileEditPage({ testFile, onTestFileMetaChange }) {
  const scaffoldSummary = useMemo(() => getScaffoldSummary(testFile), [testFile]);
  const evidenceProfile = ["debug", "fast", "turbo"].includes(testFile?.settings?.evidenceProfile)
    ? testFile.settings.evidenceProfile
    : "debug";

  const scrollRef = useRef(null);
  const activeSection = useActiveSection(scrollRef);

  const counts = {
    cases: testFile?.cases?.length || 0,
    macros: Object.keys(testFile?.macros || {}).length,
    fixtures: Object.keys(testFile?.fixtures || {}).length,
    steps: scaffoldSummary.totalSteps,
  };

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 overflow-y-auto">
      <ManifestRail testFile={testFile} counts={counts} activeSection={activeSection} scrollRef={scrollRef} />

      <div className="grid min-w-0 flex-1 auto-rows-max gap-6 px-6 py-5">
        <Section id="identity" title="Identity" description="文件身份与访问入口。">
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            <Field label="File ID">
              <Input
                value={testFile?.id || ""}
                onChange={(event) => onTestFileMetaChange("id", event.target.value)}
                placeholder="demo-checkout"
              />
            </Field>
            <Field label="Name">
              <Input value={testFile?.name || ""} onChange={(event) => onTestFileMetaChange("name", event.target.value)} />
            </Field>
            <Field label="Group">
              <Input
                value={testFile?.group || ""}
                onChange={(event) => onTestFileMetaChange("group", event.target.value)}
                placeholder="示例任务/demo"
              />
            </Field>
            <Field label="Tags">
              <Input
                value={(testFile?.tags || []).join(", ")}
                onChange={(event) => onTestFileMetaChange("tags", event.target.value)}
                placeholder="app, smoke"
              />
            </Field>
            <Field label="Base URL" className="md:col-span-2">
              <Input
                value={testFile?.baseUrl || ""}
                onChange={(event) => onTestFileMetaChange("baseUrl", event.target.value)}
                placeholder="https://example.com"
              />
            </Field>
            <Field label="Description" className="md:col-span-2">
              <Textarea
                value={testFile?.description || ""}
                onChange={(event) => onTestFileMetaChange("description", event.target.value)}
                className="min-h-20"
              />
            </Field>
          </div>
        </Section>

        <Separator />

        <Section id="requirement" title="Requirement" description="需求元信息，用于报告与追溯。">
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            <Field label="Requirement name">
              <Input
                value={testFile?.requirement?.name || ""}
                onChange={(event) => onTestFileMetaChange("requirement.name", event.target.value)}
              />
            </Field>
            <Field label="Version">
              <Input
                value={testFile?.requirement?.version || ""}
                onChange={(event) => onTestFileMetaChange("requirement.version", event.target.value)}
              />
            </Field>
            <Field label="Owner">
              <Input
                value={testFile?.requirement?.owner || ""}
                onChange={(event) => onTestFileMetaChange("requirement.owner", event.target.value)}
              />
            </Field>
            <Field label="Module">
              <Input
                value={testFile?.requirement?.module || ""}
                onChange={(event) => onTestFileMetaChange("requirement.module", event.target.value)}
              />
            </Field>
            <Field label="Requirement description" className="md:col-span-2">
              <Textarea
                value={testFile?.requirement?.description || ""}
                onChange={(event) => onTestFileMetaChange("requirement.description", event.target.value)}
                className="min-h-20"
              />
            </Field>
          </div>
        </Section>

        <Separator />

        <Section id="run" title="Run defaults" description="执行时默认采集与变量。">
          <div className="grid gap-4">
            <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-[4px] border border-[var(--border-subtle)] bg-[var(--panel-muted)] px-3 py-2 text-sm">
                <span>
                  <span className="block">Capture evidence</span>
                  <span className="text-xs text-[var(--muted-foreground)]">截图 / trace / OCR</span>
                </span>
                <Switch
                  checked={testFile?.settings?.evidence !== false}
                  onCheckedChange={(checked) => onTestFileMetaChange("settings.evidence", Boolean(checked))}
                />
              </label>
              <Field label="Run profile">
                <Select
                  value={evidenceProfile}
                  onValueChange={(value) => onTestFileMetaChange("settings.evidenceProfile", value)}
                >
                  <SelectTrigger className="w-full bg-[var(--input-bg)]">
                    <SelectValue placeholder="Select profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {EVIDENCE_PROFILE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <span className="flex items-center gap-2">
                          <span>{option.label}</span>
                          <span className="text-[var(--muted-foreground)]">{option.description}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <JsonObjectEditor
              label="Run variables"
              description="Use {{name}} or {{$name}} in steps. Values can reference built-ins like {{$timestamp}}."
              value={testFile?.vars || {}}
              onChange={(vars) => onTestFileMetaChange("vars", vars)}
            />

            <Collapsible>
              <CollapsibleTrigger className="group/adv flex w-full items-center gap-2 text-left text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]">
                <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/adv:rotate-90" />
                Advanced settings JSON
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pt-2">
                  <JsonObjectEditor
                    description="settings.evidence 与 settings.evidenceProfile 已在上方可视化；此处编辑其余高级项。"
                    value={testFile?.settings || { evidence: true }}
                    onChange={(settings) => onTestFileMetaChange("settings", settings)}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </Section>

        <Separator />

        <Section
          id="scaffold"
          title="Scaffold"
          description="跨 selected case 共享的前置、清理、Fixture 与 Macro。"
          aside={<Badge variant="neutral">{scaffoldSummary.totalSteps} steps</Badge>}
        >
          <div className="grid gap-2">
            <ScaffoldRow kind="setup" title="Root setup" stepCount={testFile?.setup?.steps?.length || 0}>
              <StepGroupEditor
                hideHeader
                steps={testFile?.setup?.steps || []}
                onStepsChange={(steps) => onTestFileMetaChange("setup", { ...(testFile?.setup || {}), steps })}
              />
            </ScaffoldRow>

            <ScaffoldRow
              kind="teardown"
              title="Root teardown"
              stepCount={testFile?.teardown?.steps?.length || 0}
              flags={testFile?.teardown?.alwaysRun !== false ? ["always run"] : []}
            >
              <StepGroupEditor
                hideHeader
                steps={testFile?.teardown?.steps || []}
                footer={(
                  <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <Checkbox
                      checked={testFile?.teardown?.alwaysRun !== false}
                      onCheckedChange={(checked) => onTestFileMetaChange("teardown", {
                        ...(testFile?.teardown || {}),
                        alwaysRun: Boolean(checked),
                      })}
                    />
                    Always run after case failure
                  </label>
                )}
                onStepsChange={(steps) => onTestFileMetaChange("teardown", { ...(testFile?.teardown || {}), steps })}
              />
            </ScaffoldRow>

            <ScaffoldGroupList
              kind="macro"
              heading="Macros"
              description="Macro 由 useMacro 静态展开，适合复用导航、打开弹窗等步骤组。"
              emptyText="还没有 macro——添加一个即可在多个 case 间复用步骤组。"
              addLabel="Add macro"
              value={testFile?.macros || {}}
              createItem={() => ({ steps: [] })}
              stepCount={(macro) => macro?.steps?.length || 0}
              onChange={(macros) => onTestFileMetaChange("macros", macros)}
              renderContent={(name, macro, updateItem) => (
                <StepGroupEditor
                  hideHeader
                  steps={macro?.steps || []}
                  onStepsChange={(steps) => updateItem({ ...(macro || {}), steps })}
                />
              )}
            />

            <ScaffoldGroupList
              kind="fixture"
              heading="Fixtures"
              description="Fixture 可以被 case 引用，用于登录态、造数和清理。"
              emptyText="还没有 fixture——添加一个用于登录态或造数清理。"
              addLabel="Add fixture"
              value={testFile?.fixtures || {}}
              createItem={() => ({ setup: [], teardown: [] })}
              stepCount={(fixture) => (fixture?.setup?.length || 0) + (fixture?.teardown?.length || 0)}
              onChange={(fixtures) => onTestFileMetaChange("fixtures", fixtures)}
              renderContent={(name, fixture, updateItem) => (
                <div className="grid gap-3">
                  <StepSubGroup label="Setup">
                    <StepGroupEditor
                      hideHeader
                      steps={fixture?.setup || []}
                      onStepsChange={(steps) => updateItem({ ...(fixture || {}), setup: steps })}
                    />
                  </StepSubGroup>
                  <StepSubGroup label="Teardown">
                    <StepGroupEditor
                      hideHeader
                      steps={fixture?.teardown || []}
                      onStepsChange={(steps) => updateItem({ ...(fixture || {}), teardown: steps })}
                    />
                  </StepSubGroup>
                </div>
              )}
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

function useActiveSection(scrollRef) {
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActive(visible[0].target.id);
        }
      },
      { root, rootMargin: "0px 0px -68% 0px", threshold: 0 },
    );
    SECTIONS.forEach((section) => {
      const el = root.querySelector(`#${section.id}`);
      if (el) {
        observer.observe(el);
      }
    });
    return () => observer.disconnect();
  }, [scrollRef]);

  return active;
}

function ManifestRail({ testFile, counts, activeSection, scrollRef }) {
  const handleJump = (id) => {
    const root = scrollRef.current;
    const el = root?.querySelector(`#${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const chips = [
    { label: "cases", value: counts.cases },
    { label: "macros", value: counts.macros },
    { label: "fixtures", value: counts.fixtures },
    { label: "steps", value: counts.steps },
  ];

  return (
    <aside className="sticky top-0 hidden h-fit w-52 shrink-0 self-start border-r border-[var(--border-subtle)] bg-[var(--panel-muted)] px-4 py-5 md:block">
      <div className="grid gap-1">
        <div className="truncate text-sm font-semibold text-[var(--foreground)]" title={testFile?.name || ""}>
          {testFile?.name || "Untitled file"}
        </div>
        <div className="truncate text-xs text-[var(--muted-foreground)]" title={testFile?.group || ""}>
          {testFile?.group || "No group"}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2">
        {chips.map((chip) => (
          <div key={chip.label} className="rounded-[4px] border border-[var(--border-subtle)] bg-[var(--panel)] px-2 py-1.5">
            <dd className="text-sm font-semibold tabular-nums text-[var(--foreground)]">{chip.value}</dd>
            <dt className="text-[11px] text-[var(--muted-foreground)]">{chip.label}</dt>
          </div>
        ))}
      </dl>

      <Separator className="my-4" />

      <nav className="grid gap-0.5">
        {SECTIONS.map((section) => {
          const isActive = section.id === activeSection;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => handleJump(section.id)}
              className={cn(
                "flex items-center gap-2 rounded-[4px] border-l-2 px-2 py-1.5 text-left text-xs transition-colors",
                isActive
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent-strong)]"
                  : "border-transparent text-[var(--muted-foreground)] hover:bg-[var(--panel)] hover:text-[var(--foreground)]",
              )}
            >
              {section.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function Section({ id, title, description, aside = null, children }) {
  return (
    <section id={id} className="scroll-mt-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const SCAFFOLD_KIND_LABEL = {
  setup: "Setup",
  teardown: "Teardown",
  macro: "Macro",
  fixture: "Fixture",
};

function ScaffoldRow({ kind, title, stepCount = 0, flags = [], onRemove = null, children }) {
  return (
    <Collapsible className="rounded-[4px] border border-[var(--border-subtle)] bg-[var(--panel)]">
      <div className="group/row flex items-center gap-2 pr-2">
        <CollapsibleTrigger className="group/trg flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm">
          <ChevronRight className="size-3.5 shrink-0 text-[var(--muted-foreground)] transition-transform group-data-[state=open]/trg:rotate-90" />
          <span className="truncate font-medium text-[var(--foreground)]">{title}</span>
          <Badge variant="neutral" className="shrink-0">{SCAFFOLD_KIND_LABEL[kind] || kind}</Badge>
          <span className="shrink-0 text-xs tabular-nums text-[var(--muted-foreground)]">{stepCount} steps</span>
          {flags.map((flag) => (
            <Badge key={flag} variant="running" className="shrink-0">{flag}</Badge>
          ))}
        </CollapsibleTrigger>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Remove"
            className="shrink-0 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--danger)] group-hover/row:opacity-100 focus-visible:opacity-100"
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className="border-t border-[var(--border-subtle)] p-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StepSubGroup({ label, children }) {
  return (
    <div className="grid gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">{label}</span>
      {children}
    </div>
  );
}

function ScaffoldGroupList({
  kind,
  heading,
  description,
  emptyText,
  addLabel,
  value = {},
  createItem,
  stepCount,
  onChange,
  renderContent,
}) {
  const entries = Object.entries(value || {});

  const handleAdd = () => {
    let index = entries.length + 1;
    let name = `${kind}${index}`;
    while (value[name]) {
      index += 1;
      name = `${kind}${index}`;
    }
    onChange?.({
      ...(value || {}),
      [name]: createItem(),
    });
  };

  const handleRename = (oldName, nextName) => {
    const normalized = String(nextName || "").trim();
    if (!normalized || normalized === oldName || value[normalized]) {
      return;
    }
    const next = {};
    entries.forEach(([name, item]) => {
      next[name === oldName ? normalized : name] = item;
    });
    onChange?.(next);
  };

  const handleUpdateItem = (name, item) => {
    onChange?.({
      ...(value || {}),
      [name]: item,
    });
  };

  const handleRemove = (name) => {
    const next = { ...(value || {}) };
    delete next[name];
    onChange?.(next);
  };

  return (
    <div className="mt-2 grid gap-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-[var(--foreground)]">{heading}</h3>
          <p className="text-xs text-[var(--muted-foreground)]">{description}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus />
          {addLabel}
        </Button>
      </div>
      {entries.length ? (
        <div className="grid gap-2">
          {entries.map(([name, item]) => (
            <ScaffoldRow
              key={name}
              kind={kind}
              title={name}
              stepCount={stepCount(item)}
              onRemove={() => handleRemove(name)}
            >
              <div className="grid gap-3">
                <RenameField name={name} onRename={(nextName) => handleRename(name, nextName)} />
                {renderContent(name, item, (nextItem) => handleUpdateItem(name, nextItem))}
              </div>
            </ScaffoldRow>
          ))}
        </div>
      ) : (
        <div className="rounded-[4px] border border-dashed border-[var(--border-subtle)] bg-[var(--panel-muted)] p-3 text-xs text-[var(--muted-foreground)]">
          {emptyText}
        </div>
      )}
    </div>
  );
}

function RenameField({ name, onRename }) {
  const [draftName, setDraftName] = useState(name);

  useEffect(() => {
    setDraftName(name);
  }, [name]);

  return (
    <Field label="Name" className="max-w-xs">
      <Input
        value={draftName}
        onChange={(event) => setDraftName(event.target.value)}
        onBlur={() => onRename?.(draftName)}
      />
    </Field>
  );
}

function getScaffoldSummary(testFile) {
  const rootSetup = testFile?.setup?.steps?.length || 0;
  const rootTeardown = testFile?.teardown?.steps?.length || 0;
  const fixtureSteps = Object.values(testFile?.fixtures || {}).reduce(
    (sum, fixture) => sum + (fixture?.setup?.length || 0) + (fixture?.teardown?.length || 0),
    0,
  );
  const macroSteps = Object.values(testFile?.macros || {}).reduce(
    (sum, macro) => sum + (macro?.steps?.length || 0),
    0,
  );
  return {
    totalSteps: rootSetup + rootTeardown + fixtureSteps + macroSteps,
  };
}

function parseJsonObject(value) {
  const parsed = JSON.parse(value || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Value must be a JSON object.");
  }
  return parsed;
}

function JsonObjectEditor({ label, description, value = {}, className = "", onChange }) {
  const initialText = JSON.stringify(value || {}, null, 2);
  const [text, setText] = useState(() => initialText);
  const [error, setError] = useState("");
  const committedTextRef = useRef(initialText);

  useEffect(() => {
    const nextText = JSON.stringify(value || {}, null, 2);
    if (nextText === committedTextRef.current) {
      return;
    }
    committedTextRef.current = nextText;
    setText(nextText);
    setError("");
  }, [value]);

  const handleChange = (nextText) => {
    setText(nextText);
    try {
      const parsed = parseJsonObject(nextText);
      committedTextRef.current = JSON.stringify(parsed, null, 2);
      setError("");
      onChange?.(parsed);
    } catch (parseError) {
      setError(parseError?.message || String(parseError));
    }
  };

  return (
    <div className={`grid gap-2 text-sm ${className}`}>
      {label || description ? (
        <div>
          {label ? <span className="text-xs text-[var(--muted-foreground)]">{label}</span> : null}
          {description ? <p className="mt-1 text-xs text-[var(--muted-foreground)]">{description}</p> : null}
        </div>
      ) : null}
      <Textarea
        value={text}
        onChange={(event) => handleChange(event.target.value)}
        className="min-h-28 font-mono text-xs"
        spellCheck={false}
      />
      {error ? <div className="text-xs text-[var(--danger)]">{error}</div> : null}
    </div>
  );
}

function stepsToDraft(steps) {
  return runtimePayloadToDraft(Array.isArray(steps) ? steps : []).steps || [];
}

function draftStepsToRuntimeSteps(draftSteps) {
  const payload = draftToRuntimePayload({ steps: draftSteps });
  return Array.isArray(payload) ? payload : payload && Object.keys(payload).length ? [payload] : [];
}

function applyStepFieldValue(step, field, value) {
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
}

function StepGroupEditor({ title, description, steps = [], footer = null, hideHeader = false, onStepsChange }) {
  const draftSteps = useMemo(() => stepsToDraft(steps), [steps]);
  const [editingStepId, setEditingStepId] = useState(null);
  const [editingStep, setEditingStep] = useState(null);

  const commitDraftSteps = (nextDraftSteps) => {
    onStepsChange?.(draftStepsToRuntimeSteps(nextDraftSteps));
  };

  const handleAdd = () => {
    const nextStep = createEmptyStep("click");
    commitDraftSteps([...draftSteps, nextStep]);
    setEditingStepId(nextStep.id);
    setEditingStep(nextStep);
  };

  const handleDuplicate = (step) => {
    const nextStep = {
      ...JSON.parse(JSON.stringify(step)),
      id: `${step.id || "step"}-copy-${Date.now().toString(36)}`,
      stepTitle: `${step.stepTitle || getStepDisplayTitle(step)} Copy`,
    };
    commitDraftSteps([...draftSteps, nextStep]);
  };

  const handleRemove = (stepId) => {
    commitDraftSteps(draftSteps.filter((step) => step.id !== stepId));
    if (editingStepId === stepId) {
      setEditingStepId(null);
      setEditingStep(null);
    }
  };

  const handleMove = (stepId, direction) => {
    const index = draftSteps.findIndex((step) => step.id === stepId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= draftSteps.length) {
      return;
    }
    const nextSteps = [...draftSteps];
    const [step] = nextSteps.splice(index, 1);
    nextSteps.splice(nextIndex, 0, step);
    commitDraftSteps(nextSteps);
  };

  const handleEdit = (step) => {
    setEditingStepId(step.id);
    setEditingStep(JSON.parse(JSON.stringify(step)));
  };

  const handleInspectorFieldChange = (stepId, field, value) => {
    setEditingStep((current) => {
      if (!current || current.id !== stepId) {
        return current;
      }
      return applyStepFieldValue(current, field, value);
    });
  };

  const handleInspectorExpectationChange = (stepId, value) => {
    setEditingStep((current) => (current && current.id === stepId ? { ...current, expectation: value } : current));
  };

  const handleSave = () => {
    if (!editingStep) {
      setEditingStepId(null);
      return;
    }
    const nextSteps = draftSteps.map((step) => (step.id === editingStep.id ? editingStep : step));
    commitDraftSteps(nextSteps);
    setEditingStepId(null);
    setEditingStep(null);
  };

  return (
    <div className="grid gap-2">
      {hideHeader ? null : (
        <div className="flex items-start justify-between gap-3">
          <div>
            <strong className="text-sm">{title}</strong>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">{description}</p>
          </div>
          <Badge variant="neutral">{draftSteps.length} steps</Badge>
        </div>
      )}
      <div className="grid gap-1">
        {draftSteps.length ? (
          draftSteps.map((step, index) => (
            <div
              key={step.id || `${title}-${index}`}
              className="group/step flex items-center justify-between gap-2 rounded-[4px] border border-[var(--border-subtle)] bg-[var(--panel-muted)] px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <strong className="block truncate text-sm">{getStepDisplayTitle(step)}</strong>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {index + 1}. {step.type}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/step:opacity-100 focus-within:opacity-100">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Move up"
                  onClick={() => handleMove(step.id, -1)}
                  disabled={index === 0}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Move down"
                  onClick={() => handleMove(step.id, 1)}
                  disabled={index === draftSteps.length - 1}
                >
                  <ArrowDown />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" title="Edit" onClick={() => handleEdit(step)}>
                  <Pencil />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" title="Duplicate" onClick={() => handleDuplicate(step)}>
                  <Copy />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Remove"
                  className="hover:text-[var(--danger)]"
                  onClick={() => handleRemove(step.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-[4px] border border-dashed border-[var(--border-subtle)] bg-[var(--panel-muted)] p-3 text-xs text-[var(--muted-foreground)]">
            No steps in this group.
          </div>
        )}
      </div>
      <Button type="button" variant="outline" size="sm" className="w-full border-dashed" onClick={handleAdd}>
        <Plus />
        Add step
      </Button>
      {footer}
      <Sheet open={Boolean(editingStepId)} onOpenChange={(open) => {
        if (!open) {
          setEditingStepId(null);
          setEditingStep(null);
        }
      }}>
        <SheetContent side="bottom" className="h-[88vh] overflow-hidden p-0" aria-describedby={undefined}>
          <SheetHeader className="border-b border-[var(--border-subtle)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <SheetTitle>{editingStep ? getStepDisplayTitle(editingStep) : "Edit step"}</SheetTitle>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => {
                  setEditingStepId(null);
                  setEditingStep(null);
                }}>
                  Discard
                </Button>
                <Button type="button" size="sm" onClick={handleSave}>
                  Save step
                </Button>
              </div>
            </div>
          </SheetHeader>
          <ScrollArea className="h-[calc(88vh-76px)]">
            <div className="p-4">
              <StepInspector
                step={editingStep}
                onFieldChange={handleInspectorFieldChange}
                onExpectationChange={handleInspectorExpectationChange}
              />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Field({ label, className = "", children }) {
  return (
    <label className={`grid gap-1.5 text-sm ${className}`}>
      <span className="text-xs text-[var(--muted-foreground)]">{label}</span>
      {children}
    </label>
  );
}
