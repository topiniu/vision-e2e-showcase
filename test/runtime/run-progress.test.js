const test = require("node:test");
const assert = require("node:assert/strict");

test("run progress reducer tracks step execution and final result", async () => {
  const {
    applyRuntimeRunEvent,
    createRunProgress,
    syncRunProgressSteps,
  } = await import("../../src/panel/lib/run-progress.mjs");

  const steps = [
    { id: "step-a", type: "click", query: "Login" },
    { id: "step-b", type: "inspect", query: "Dashboard" },
  ];

  let progress = createRunProgress(steps, "run-1");
  progress = syncRunProgressSteps(progress, steps);
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "run-1",
    startedAt: 100,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "run-1",
    stepIndex: 0,
    stepId: "step-a",
    status: "running",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-1",
    stepIndex: 0,
    stepId: "step-a",
    status: "passed",
    message: "Step completed.",
    durationMs: 320,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "run-1",
    stepIndex: 1,
    stepId: "step-b",
    status: "running",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-1",
    stepIndex: 1,
    stepId: "step-b",
    status: "failed",
    message: "Dashboard not found.",
    error: { message: "Dashboard not found." },
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-complete",
    runId: "run-1",
    status: "failed",
    finishedAt: 200,
    result: { ok: false },
    error: { message: "Dashboard not found." },
  });

  assert.equal(progress.status, "failed");
  assert.equal(progress.currentStepIndex, 1);
  assert.equal(progress.steps[0].status, "passed");
  assert.equal(progress.steps[1].status, "failed");
  assert.equal(progress.steps[1].error.message, "Dashboard not found.");
  assert.equal(progress.result.ok, false);
});

test("run progress reducer tracks runtime variable snapshots", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");
  let progress = createRunProgress([{ id: "capture", type: "callApi" }], "run-vars");
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "run-vars",
    startedAt: 100,
    runtimeVariables: { runId: "run-vars", caseToken: "token-1" },
    runtimeVariableSources: { runId: "builtin", caseToken: "file" },
  });
  assert.equal(progress.runtimeVariables.caseToken, "token-1");
  assert.equal(progress.runtimeVariableSources.caseToken, "file");
  assert.equal(progress.runtimeVariableHistory.caseToken.length, 1);
  assert.equal(progress.runtimeVariableHistory.caseToken[0].changeType, "initial");

  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-vars",
    caseId: "case-a",
    caseName: "Case A",
    stepIndex: 0,
    stepId: "capture",
    status: "passed",
    runtimeVariables: { runId: "run-vars", caseToken: "token-1", taskSpuNo: "SPU-001" },
    runtimeVariableSources: { runId: "builtin", caseToken: "file", taskSpuNo: "capture" },
    finishedAt: 180,
  });
  assert.equal(progress.runtimeVariables.taskSpuNo, "SPU-001");
  assert.equal(progress.runtimeVariableSources.taskSpuNo, "capture");
  assert.equal(progress.runtimeVariablesUpdatedAt, 180);
  assert.equal(progress.runtimeVariableHistory.caseToken.length, 1);
  assert.equal(progress.runtimeVariableHistory.taskSpuNo.length, 1);
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[0].changeType, "update");
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[0].caseId, "case-a");
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[0].stepNumber, 1);

  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-vars",
    caseId: "case-a",
    caseName: "Case A",
    stepIndex: 1,
    stepId: "empty-capture",
    status: "passed",
    runtimeVariables: { runId: "run-vars", caseToken: "token-1", taskSpuNo: "SPU-001", optionalToken: "" },
    runtimeVariableSources: { runId: "builtin", caseToken: "file", taskSpuNo: "capture", optionalToken: "file" },
    finishedAt: 200,
  });
  assert.equal(progress.runtimeVariableHistory.optionalToken, undefined);

  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-vars",
    caseId: "case-b",
    caseName: "Case B",
    stepIndex: 2,
    stepId: "capture-again",
    status: "passed",
    runtimeVariables: { runId: "run-vars", caseToken: "token-1", taskSpuNo: "SPU-002", optionalToken: "" },
    runtimeVariableSources: { runId: "builtin", caseToken: "file", taskSpuNo: "capture", optionalToken: "file" },
    finishedAt: 220,
  });
  assert.equal(progress.runtimeVariableHistory.taskSpuNo.length, 2);
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[1].changeType, "update");
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[1].previousValue, "SPU-001");
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[1].value, "SPU-002");
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[1].caseName, "Case B");
  assert.equal(progress.runtimeVariableHistory.taskSpuNo[1].stepNumber, 3);
});

test("run progress reducer ignores stale run events and preserves matching step state on sync", async () => {
  const {
    applyRuntimeRunEvent,
    createRunProgress,
    syncRunProgressSteps,
  } = await import("../../src/panel/lib/run-progress.mjs");

  const initialSteps = [
    { id: "step-a", type: "click", query: "Login" },
    { id: "step-b", type: "inspect", query: "Dashboard" },
  ];

  let progress = createRunProgress(initialSteps, "run-2");
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "run-2",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-2",
    stepIndex: 0,
    stepId: "step-a",
    status: "passed",
    message: "done",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-1",
    stepIndex: 1,
    stepId: "step-b",
    status: "failed",
    message: "stale",
  });

  const synced = syncRunProgressSteps(progress, [
    { id: "step-a", type: "click", query: "Login again" },
    { id: "step-c", type: "type", query: "Password" },
  ]);

  assert.equal(synced.steps[0].status, "passed");
  assert.equal(synced.steps[0].query, "Login again");
  assert.equal(synced.steps[1].status, "pending");
  assert.equal(synced.steps[1].stepId, "step-c");
});

test("run progress sync keeps fixture and case steps with the same id isolated", async () => {
  const {
    applyRuntimeRunEvent,
    createRunProgress,
    getRunStepIdentity,
    syncRunProgressSteps,
  } = await import("../../src/panel/lib/run-progress.mjs");

  const steps = [
    { id: "shared-select", type: "comboSearchSelect", phase: "fixtureSetup", sourceFixture: "fxAtSupply", query: "促" },
    { id: "shared-select", type: "click", phase: "case", query: "入驻项目成员" },
  ];

  let progress = createRunProgress(steps, "case-run");
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 0,
    stepId: "shared-select",
    phase: "fixtureSetup",
    sourceFixture: "fxAtSupply",
    status: "failed",
    error: { message: "selection-not-applied" },
  });

  const synced = syncRunProgressSteps(progress, steps);

  assert.notEqual(getRunStepIdentity(synced.steps[0]), getRunStepIdentity(synced.steps[1]));
  assert.equal(synced.steps[0].status, "failed");
  assert.equal(synced.steps[0].sourceFixture, "fxAtSupply");
  assert.equal(synced.steps[1].status, "pending");
  assert.equal(synced.steps[1].phase, "case");
});

test("run progress reducer maps single-step runtime events by step id instead of payload-local index", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const steps = [
    { id: "step-a", type: "click", query: "Login" },
    { id: "step-b", type: "inspect", query: "Dashboard" },
    { id: "step-c", type: "type", query: "Password" },
  ];

  let progress = createRunProgress(steps, "run-3");
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "run-3",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "run-3",
    stepIndex: 0,
    stepId: "step-b",
    status: "running",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "run-3",
    stepIndex: 0,
    stepId: "step-b",
    status: "passed",
    message: "done",
  });

  assert.equal(progress.currentStepIndex, 1);
  assert.equal(progress.steps[0].status, "pending");
  assert.equal(progress.steps[1].status, "passed");
  assert.equal(progress.steps[2].status, "pending");
});

test("run progress reducer tracks file-level case runs with child runtime ids", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  let progress = createRunProgress([], "file-run", {
    scope: "file",
    selectedCaseId: "case-a",
    cases: [
      {
        id: "case-a",
        name: "Case A",
        priority: "P0",
        steps: [{ id: "a-1", type: "click", query: "Create" }],
      },
      {
        id: "case-b",
        name: "Case B",
        priority: "P1",
        steps: [{ id: "b-1", type: "fill", query: "Name" }],
      },
    ],
  });

  progress = applyRuntimeRunEvent(progress, {
    type: "case-start",
    runId: "file-run",
    caseRunId: "file-run-case-a",
    caseId: "case-a",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "file-run-case-a",
    stepIndex: 0,
    stepId: "a-1",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "file-run-case-a",
    stepIndex: 0,
    stepId: "a-1",
    status: "passed",
    durationMs: 50,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-complete",
    runId: "file-run-case-a",
    status: "success",
  });

  assert.equal(progress.runId, "file-run");
  assert.equal(progress.status, "running");
  assert.equal(progress.cases[0].steps[0].status, "passed");
  assert.equal(progress.cases[0].completedSteps, 1);

  progress = applyRuntimeRunEvent(progress, {
    type: "case-complete",
    runId: "file-run",
    caseId: "case-a",
    status: "passed",
    result: { ok: true, telemetry: { durationMs: 60 } },
  });

  assert.equal(progress.cases[0].status, "passed");
  assert.equal(progress.cases[0].durationMs, 60);
  assert.equal(progress.cases[1].status, "pending");
});

test("run progress reducer marks selected case passed only when every step passed", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const cases = [
    {
      id: "case-a",
      name: "Case A",
      priority: "P1",
      steps: [
        { id: "a-1", type: "click", query: "Login" },
        { id: "a-2", type: "click", query: "Workbench" },
      ],
    },
  ];

  let progress = createRunProgress(cases[0].steps, "case-run", {
    scope: "case",
    selectedCaseId: "case-a",
    cases,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "case-run",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 0,
    stepId: "a-1",
    status: "passed",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-complete",
    runId: "case-run",
    status: "success",
    result: { ok: true },
  });

  assert.equal(progress.cases[0].status, "pending");

  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 1,
    stepId: "a-2",
    status: "passed",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-complete",
    runId: "case-run",
    status: "success",
    result: { ok: true },
  });

  assert.equal(progress.cases[0].status, "passed");
  assert.equal(progress.cases[0].completedSteps, 2);
  assert.equal(progress.cases[0].failedSteps, 0);
});

test("run progress reducer does not mark all-skipped case steps as passed", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const cases = [
    {
      id: "case-a",
      name: "Case A",
      priority: "P1",
      steps: [
        { id: "setup-fail", type: "click", phase: "setup" },
        { id: "case-skipped", type: "click", phase: "case" },
      ],
    },
  ];

  let progress = createRunProgress(cases[0].steps, "case-run", {
    scope: "case",
    selectedCaseId: "case-a",
    cases,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "case-run",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 0,
    stepId: "setup-fail",
    status: "skipped",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 1,
    stepId: "case-skipped",
    status: "skipped",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-complete",
    runId: "case-run",
    status: "success",
    result: { ok: true },
  });

  assert.equal(progress.cases[0].status, "skipped");
  assert.equal(progress.cases[0].completedSteps, 2);
  assert.equal(progress.cases[0].failedSteps, 0);
});

test("run progress reducer preserves skipped result steps after fixture failure", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const cases = [
    {
      id: "case-a",
      name: "Case A",
      priority: "P1",
      steps: [
        { id: "fixture-failed", type: "comboSearchSelect", phase: "fixtureSetup" },
        { id: "case-skipped-1", type: "click", phase: "case" },
        { id: "case-skipped-2", type: "click", phase: "case" },
      ],
    },
  ];

  let progress = createRunProgress(cases[0].steps, "case-run", {
    scope: "case",
    selectedCaseId: "case-a",
    cases,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "case-run",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 0,
    stepId: "fixture-failed",
    status: "failed",
    error: { message: "fixture failed" },
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 1,
    stepId: "case-skipped-1",
    result: { ok: true, skipped: true },
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 2,
    stepId: "case-skipped-2",
    result: { ok: true, skipped: true },
  });

  assert.equal(progress.steps[0].status, "failed");
  assert.equal(progress.steps[1].status, "skipped");
  assert.equal(progress.steps[2].status, "skipped");
  assert.equal(progress.cases[0].steps[1].status, "skipped");
  assert.equal(progress.cases[0].failedSteps, 1);
});

test("run progress reducer keeps selected case pending until a case-phase step starts", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const cases = [
    {
      id: "case-a",
      name: "Case A",
      priority: "P1",
      steps: [
        { id: "setup-1", type: "click", phase: "setup", query: "Login" },
        { id: "a-1", type: "click", phase: "case", query: "Create" },
      ],
    },
  ];

  let progress = createRunProgress(cases[0].steps, "case-run", {
    scope: "case",
    selectedCaseId: "case-a",
    cases,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "case-run",
    startedAt: 100,
  });

  assert.equal(progress.status, "running");
  assert.equal(progress.cases[0].status, "pending");
  assert.equal(progress.cases[0].steps[0].status, "pending");

  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "case-run",
    stepIndex: 0,
    stepId: "setup-1",
  });

  assert.equal(progress.cases[0].status, "pending");
  assert.equal(progress.cases[0].steps[0].status, "running");

  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "case-run",
    stepIndex: 1,
    stepId: "a-1",
  });

  assert.equal(progress.cases[0].status, "running");
  assert.equal(progress.cases[0].steps[1].status, "running");
});

test("run progress reducer treats runtime event phase as authoritative for setup steps", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const cases = [
    {
      id: "case-a",
      name: "Case A",
      priority: "P1",
      steps: [
        { id: "setup-1", type: "click", phase: "case", query: "Legacy mis-synced step" },
        { id: "a-1", type: "click", phase: "case", query: "Create" },
      ],
    },
  ];

  let progress = createRunProgress(cases[0].steps, "case-run", {
    scope: "case",
    selectedCaseId: "case-a",
    cases,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "case-run",
  });
  progress = applyRuntimeRunEvent({
    ...progress,
    cases: [{ ...progress.cases[0], status: "running" }],
  }, {
    type: "step-start",
    runId: "case-run",
    stepIndex: 0,
    stepId: "setup-1",
    phase: "setup",
  });

  assert.equal(progress.cases[0].status, "pending");
  assert.equal(progress.cases[0].steps[0].status, "running");
});

test("run progress reducer finalizes a running step when a failed run completes without step-complete", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const cases = [
    {
      id: "case-a",
      name: "Case A",
      priority: "P1",
      steps: [
        { id: "a-1", type: "click", query: "Login" },
        { id: "a-2", type: "click", query: "Submit" },
      ],
    },
  ];

  let progress = createRunProgress(cases[0].steps, "case-run", {
    scope: "case",
    selectedCaseId: "case-a",
    cases,
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-start",
    runId: "case-run",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "case-run",
    stepIndex: 0,
    stepId: "a-1",
    status: "passed",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "case-run",
    stepIndex: 1,
    stepId: "a-2",
  });
  progress = applyRuntimeRunEvent(progress, {
    type: "run-complete",
    runId: "case-run",
    status: "failed",
    result: { ok: false, error: { message: "Submit failed." } },
    error: { message: "Submit failed." },
  });

  assert.equal(progress.status, "failed");
  assert.equal(progress.steps[0].status, "passed");
  assert.equal(progress.steps[1].status, "failed");
  assert.equal(progress.cases[0].status, "failed");
  assert.equal(progress.cases[0].failedSteps, 1);
});

test("run progress reducer maps root child-run events onto root steps by phase and id", async () => {
  const { applyRuntimeRunEvent, createRunProgress } = await import("../../src/panel/lib/run-progress.mjs");

  const rootSteps = [
    { id: "open", type: "navigate", phase: "setup" },
    { id: "open", type: "capture", phase: "teardown" },
  ];

  let progress = createRunProgress(rootSteps, "file-run");
  progress = {
    ...progress,
    scope: "file",
    status: "running",
    currentCaseId: null,
    rootSteps: progress.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "running" : "pending",
    })),
    steps: [{ stepId: "case-1", type: "click", phase: "case", status: "pending" }],
    cases: [
      {
        caseId: "case-a",
        caseName: "Case A",
        steps: [{ stepId: "case-1", type: "click", phase: "case", status: "pending" }],
      },
    ],
  };

  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "file-run",
    childRunId: "file-run-root-setup",
    stepIndex: 0,
    stepId: "open",
    phase: "setup",
    status: "passed",
    durationMs: 21,
  });

  assert.equal(progress.currentCaseId, null);
  assert.equal(progress.currentStepIndex, 0);
  assert.equal(progress.rootSteps[0].status, "passed");
  assert.equal(progress.rootSteps[0].durationMs, 21);

  progress = applyRuntimeRunEvent(progress, {
    type: "step-start",
    runId: "file-run",
    childRunId: "file-run-root-teardown",
    stepIndex: 0,
    stepId: "open",
    phase: "teardown",
  });

  assert.equal(progress.currentCaseId, null);
  assert.equal(progress.currentStepIndex, 1);
  assert.equal(progress.rootSteps[0].status, "passed");
  assert.equal(progress.rootSteps[1].status, "running");
  assert.equal(progress.steps[1].status, "running");

  progress = applyRuntimeRunEvent(progress, {
    type: "step-complete",
    runId: "file-run",
    childRunId: "file-run-root-teardown",
    stepIndex: 0,
    stepId: "open",
    phase: "teardown",
    status: "passed",
    durationMs: 42,
  });

  assert.equal(progress.rootSteps[0].status, "passed");
  assert.equal(progress.rootSteps[1].status, "passed");
  assert.equal(progress.steps[0].status, "passed");
  assert.equal(progress.steps[1].status, "passed");
  assert.equal(progress.steps[1].durationMs, 42);
});

test("run progress case scope keeps same fixture step ids isolated per case", async () => {
  const { getRunProgressForCase } = await import("../../src/panel/lib/run-progress.mjs");

  const progress = {
    runId: "file-run",
    scope: "file",
    status: "failed",
    currentCaseId: "case-b",
    currentStepIndex: 2,
    steps: [
      { stepId: "fx-home-1", index: 0, phase: "fixtureSetup", status: "passed" },
      { stepId: "fx-home-2", index: 1, phase: "fixtureSetup", status: "passed" },
      { stepId: "fx-home-3", index: 2, phase: "fixtureSetup", status: "failed", error: { message: "case b setup failed" } },
    ],
    cases: [
      {
        caseId: "case-a",
        caseName: "L1-09a",
        status: "partial",
        steps: [
          { stepId: "fx-home-1", index: 0, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-home-2", index: 1, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-home-3", index: 2, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-supply-4", index: 3, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-supply-5", index: 4, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-supply-6", index: 5, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-supply-7", index: 6, phase: "fixtureSetup", status: "failed", error: { message: "case a operator failed" } },
        ],
      },
      {
        caseId: "case-b",
        caseName: "L2-02",
        status: "failed",
        steps: [
          { stepId: "fx-home-1", index: 0, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-home-2", index: 1, phase: "fixtureSetup", status: "passed" },
          { stepId: "fx-home-3", index: 2, phase: "fixtureSetup", status: "failed", error: { message: "case b setup failed" } },
        ],
      },
    ],
  };

  const caseAProgress = getRunProgressForCase(progress, "case-a");
  const failedSteps = caseAProgress.steps.filter((step) => step.status === "failed");

  assert.equal(caseAProgress.status, "partial");
  assert.equal(caseAProgress.currentCaseId, "case-a");
  assert.equal(caseAProgress.currentStepIndex, null);
  assert.equal(failedSteps.length, 1);
  assert.equal(failedSteps[0].stepId, "fx-supply-7");
  assert.equal(failedSteps[0].error.message, "case a operator failed");
});
