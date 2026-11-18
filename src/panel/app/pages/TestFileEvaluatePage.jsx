import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Gauge,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@panel/components/ui/alert";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@panel/components/ui/card";
import { Checkbox } from "@panel/components/ui/checkbox";
import { Input } from "@panel/components/ui/input";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import {
  clearCheckpoint,
  evaluateTestFile,
  listCheckpoints,
  runTestSession,
} from "@panel/lib/panel-api";
import styles from "./TestFileEvaluatePage.module.css";

function statusVariant(status) {
  if (status === "passed") return "success";
  if (status === "blocked" || status === "failed") return "danger";
  if (status === "warning") return "warning";
  return "neutral";
}

function gradeTone(grade) {
  if (grade === "A" || grade === "B") return "good";
  if (grade === "C") return "warn";
  return "bad";
}

function compact(value, fallback = "-") {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function topIssues(result) {
  return (result?.issues || [])
    .filter((issue) => issue.severity === "blocking" || issue.severity === "warning")
    .slice(0, 8);
}

function getSessionStatus(session) {
  return session?.status || session?.diagnosis?.status || "";
}

export function TestFileEvaluatePage({
  testFile,
  currentTestFilePath,
  isTestFileDirty,
  onSaveTestFile,
  isSavingTestFile,
}) {
  const [authProfile, setAuthProfile] = useState(() => {
    if (typeof window === "undefined") return "demo-local";
    return window.localStorage.getItem("zhuzhu-evaluate-auth-profile") || "demo-local";
  });
  const [mode, setMode] = useState("advisory");
  const [validation, setValidation] = useState(null);
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Z11: checkpoint / resume controls for long data-gen chains.
  const [checkpointId, setCheckpointId] = useState("");
  const [checkpointStepId, setCheckpointStepId] = useState("");
  const [saveCheckpoint, setSaveCheckpoint] = useState(false);
  const [resumeCheckpoint, setResumeCheckpoint] = useState(false);
  const [checkpoints, setCheckpoints] = useState([]);

  const refreshCheckpoints = async () => {
    const response = await listCheckpoints();
    setCheckpoints(response?.checkpoints || []);
  };
  useEffect(() => {
    refreshCheckpoints();
  }, []);
  const handleClearCheckpoint = async (id) => {
    await clearCheckpoint(id);
    await refreshCheckpoints();
  };

  const summary = validation?.result?.quality?.summary || {};
  const issues = useMemo(() => topIssues(validation?.result), [validation]);
  const repairContext = session?.repairContext || null;
  const sessionStatus = getSessionStatus(session);

  const evaluatePayload = () => {
    if (isTestFileDirty || !currentTestFilePath) {
      return {
        mode,
        path: currentTestFilePath || "",
        testFile,
      };
    }
    return {
      mode,
      testFilePath: currentTestFilePath,
    };
  };

  const runPayload = () => {
    const base = {
      authProfile: authProfile.trim() || "demo-local",
      scope: "all",
      caseIds: [],
      runNow: true,
      qualityGate: "gate",
      authBootstrap: "auto",
      feedback: "Panel Evaluate run",
      // Z11: save / resume a data-gen checkpoint when the operator opts in.
      ...(saveCheckpoint && checkpointId.trim() && checkpointStepId.trim()
        ? { checkpoint: { id: checkpointId.trim(), atStepId: checkpointStepId.trim() } }
        : {}),
      ...(resumeCheckpoint && checkpointId.trim() ? { resume: { id: checkpointId.trim() } } : {}),
    };
    if (isTestFileDirty || !currentTestFilePath) {
      return { ...base, path: currentTestFilePath || "", testFile };
    }
    return { ...base, testFilePath: currentTestFilePath };
  };

  const handleEvaluate = async (nextMode = mode) => {
    setBusy("validate");
    setError("");
    setMode(nextMode);
    try {
      const response = await evaluateTestFile({ ...evaluatePayload(), mode: nextMode });
      if (!response?.success) {
        throw new Error(response?.message || response?.error || "Evaluate failed.");
      }
      setValidation(response);
    } catch (nextError) {
      setError(nextError?.message || String(nextError));
    } finally {
      setBusy("");
    }
  };

  const handleRunSession = async () => {
    setBusy("session");
    setError("");
    try {
      const response = await runTestSession(runPayload());
      if (!response?.success) {
        throw new Error(response?.message || response?.error || "Test session failed.");
      }
      setSession(response);
      await refreshCheckpoints();
      if (!validation) {
        await handleEvaluate("advisory");
      }
    } catch (nextError) {
      setError(nextError?.message || String(nextError));
    } finally {
      setBusy("");
    }
  };

  const persistAuthProfile = (value) => {
    setAuthProfile(value);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("zhuzhu-evaluate-auth-profile", value);
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Trust loop</p>
          <h2>Evaluate test file</h2>
          <p>Run the same validation, scoring, session execution, diagnosis, and repair-context path used by external AI integrations.</p>
        </div>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={() => handleEvaluate("advisory")} disabled={Boolean(busy)}>
            {busy === "validate" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Gauge data-icon="inline-start" />}
            Score
          </Button>
          <Button type="button" onClick={handleRunSession} disabled={Boolean(busy)}>
            {busy === "session" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
            Run session
          </Button>
        </div>
      </section>

      {error ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Evaluate failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isTestFileDirty ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Unsaved draft</AlertTitle>
          <AlertDescription>
            Scoring can use the loaded draft. Test-session execution also supports the draft, but saving first keeps History and file paths easier to compare.
          </AlertDescription>
          <Button type="button" variant="secondary" size="sm" onClick={onSaveTestFile} disabled={isSavingTestFile}>
            Save file
          </Button>
        </Alert>
      ) : null}

      <section className={styles.controls}>
        <label>
          <span>Validate mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="advisory">advisory</option>
            <option value="gate">gate</option>
          </select>
        </label>
        <label>
          <span>Auth profile</span>
          <Input value={authProfile} onChange={(event) => persistAuthProfile(event.target.value)} />
        </label>
        <div className={styles.flow}>
          <span>validate-test-file</span>
          <span>test-sessions</span>
          <span>repair-context</span>
        </div>
      </section>

      <Card className="rounded-[8px]">
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px]">造数链 checkpoint / 续跑</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--muted-foreground)]">checkpoint id</span>
              <Input
                value={checkpointId}
                onChange={(event) => setCheckpointId(event.target.value)}
                placeholder="demo-workflow"
                className="h-7 w-44 text-[12px]"
                data-testid="evaluate-checkpoint-id"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <Checkbox checked={saveCheckpoint} onCheckedChange={(v) => setSaveCheckpoint(v === true)} />
              <span>存 checkpoint 于步骤</span>
              <Input
                value={checkpointStepId}
                onChange={(event) => setCheckpointStepId(event.target.value)}
                placeholder="step id（该步通过后存点）"
                className="h-7 w-52 text-[12px]"
                disabled={!saveCheckpoint}
                data-testid="evaluate-checkpoint-step"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <Checkbox checked={resumeCheckpoint} onCheckedChange={(v) => setResumeCheckpoint(v === true)} />
              <span>从该 checkpoint 续跑</span>
            </label>
          </div>
          {checkpoints.length ? (
            <div className="flex flex-col gap-1 border-t border-[var(--border-subtle)] pt-2">
              {checkpoints.map((cp) => (
                <div key={cp.id} className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    className="truncate text-left text-[var(--accent-strong)] hover:underline"
                    onClick={() => setCheckpointId(cp.id)}
                    title="点击填入上方 checkpoint id"
                  >
                    {cp.id}
                  </button>
                  <span className="text-[var(--muted-foreground)]">
                    @{cp.atStepId || `#${cp.atIndex}`}
                    {cp.runtimeVariableKeys?.length ? ` · ${cp.runtimeVariableKeys.length} 个造数据` : ""}
                  </span>
                  <button
                    type="button"
                    className="ml-auto text-[var(--danger)] hover:underline"
                    onClick={() => handleClearCheckpoint(cp.id)}
                  >
                    清除
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[var(--muted-foreground)]">暂无已存 checkpoint。跑一次「存 checkpoint」即可，之后勾选「续跑」从中段重跑。</div>
          )}
        </CardContent>
      </Card>

      <section className={styles.grid}>
        <Card className={styles.panel}>
          <CardHeader className={styles.panelHeader}>
            <CardTitle>Quality gate</CardTitle>
            <Badge variant={statusVariant(summary.overall)}>{summary.overall || "not scored"}</Badge>
          </CardHeader>
          <CardContent className={styles.scoreContent}>
            <div className={styles.scoreRow}>
              <ScoreDial label="Locator" grade={summary.locatorGrade} />
              <ScoreDial label="Proof" grade={summary.proofGrade} />
            </div>
            <div className={styles.kv}>
              <span>Recommendation</span>
              <strong>{summary.recommendation || "-"}</strong>
              <span>Blocked</span>
              <strong>{validation?.result?.blocked ? "yes" : validation ? "no" : "-"}</strong>
              <span>Errors</span>
              <strong>{validation?.result?.summary?.errorCount ?? "-"}</strong>
              <span>Blocking issues</span>
              <strong>{validation?.result?.summary?.blockingCount ?? "-"}</strong>
            </div>
          </CardContent>
        </Card>

        <Card className={styles.panel}>
          <CardHeader className={styles.panelHeader}>
            <CardTitle>Test session</CardTitle>
            <Badge variant={statusVariant(sessionStatus)}>{sessionStatus || "not run"}</Badge>
          </CardHeader>
          <CardContent className={styles.kv}>
            <span>Session</span>
            <strong>{session?.sessionId || "-"}</strong>
            <span>Round</span>
            <strong>{session?.roundId || "-"}</strong>
            <span>First failure</span>
            <strong>{session?.firstFailure?.stepId || session?.firstFailure?.code || "-"}</strong>
            <span>Repair context</span>
            <strong title={session?.repairContextPath || ""}>{session?.repairContextPath ? "ready" : "-"}</strong>
          </CardContent>
        </Card>
      </section>

      <section className={styles.columns}>
        <Card className={styles.listPanel}>
          <CardHeader className={styles.panelHeader}>
            <CardTitle>Blocking and warnings</CardTitle>
            <Button type="button" variant="secondary" size="sm" onClick={() => handleEvaluate(mode)} disabled={Boolean(busy)}>
              <RefreshCw data-icon="inline-start" />
              Refresh
            </Button>
          </CardHeader>
          <CardContent className={styles.listContent}>
            {issues.length ? (
              <ScrollArea className={styles.scroll}>
                <div className={styles.issueList}>
                  {issues.map((issue, index) => (
                    <IssueRow key={`${issue.code}-${issue.path}-${index}`} issue={issue} />
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <EmptyState icon={CheckCircle2} title={validation ? "No blocking issue" : "No score yet"} detail="Run Score to evaluate this file before execution." />
            )}
          </CardContent>
        </Card>

        <Card className={styles.listPanel}>
          <CardHeader className={styles.panelHeader}>
            <CardTitle>Repair context</CardTitle>
            <Badge variant={repairContext ? "success" : "neutral"}>{repairContext ? "available" : "empty"}</Badge>
          </CardHeader>
          <CardContent className={styles.listContent}>
            {repairContext ? (
              <ScrollArea className={styles.scroll}>
                <div className={styles.repair}>
                  <InfoLine label="Failure type" value={repairContext.failureType} />
                  <InfoLine label="Step" value={repairContext.originalStep?.id || repairContext.failedStep?.id || session?.firstFailure?.stepId} />
                  <InfoLine label="Expected" value={compact(repairContext.expected)} />
                  <InfoLine label="Actual" value={compact(repairContext.actual)} />
                  <InfoLine label="Current URL" value={repairContext.page?.url || repairContext.currentUrl} />
                  <InfoLine label="Observed requests" value={String(repairContext.observedRequests?.length || 0)} />
                  <div className={styles.jsonPreview}>
                    <pre>{JSON.stringify(repairContext.suggestedPatches || repairContext.validateIssues || [], null, 2)}</pre>
                  </div>
                </div>
              </ScrollArea>
            ) : (
              <EmptyState icon={Wrench} title="No repair context" detail="Run a test session. Failures will generate structured repair evidence here." />
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function ScoreDial({ label, grade }) {
  const value = grade || "-";
  return (
    <div className={styles.scoreDial} data-tone={gradeTone(value)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IssueRow({ issue }) {
  const Icon = issue.severity === "blocking" ? ShieldAlert : AlertTriangle;
  return (
    <article className={styles.issue} data-severity={issue.severity}>
      <Icon />
      <div>
        <div className={styles.issueTitle}>
          <strong>{issue.code}</strong>
          <Badge variant={issue.severity === "blocking" ? "danger" : "warning"}>{issue.severity}</Badge>
        </div>
        <p>{issue.message}</p>
        <small>{issue.path || "-"} · {issue.evidenceSource || "-"} · {issue.evidenceConfidence ?? "-"}</small>
      </div>
    </article>
  );
}

function InfoLine({ label, value }) {
  return (
    <div className={styles.infoLine}>
      <span>{label}</span>
      <strong>{compact(value)}</strong>
    </div>
  );
}

function EmptyState({ icon: Icon, title, detail }) {
  return (
    <div className={styles.empty}>
      <Icon />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
