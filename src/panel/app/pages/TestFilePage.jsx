import { OrchestratorWorkspace } from "@panel/features/orchestrator/OrchestratorWorkspace";
import { ResultsWorkspace } from "@panel/features/results/ResultsWorkspace";
import { TestFileBar } from "@panel/features/test-files/TestFileBar";
import { TestFileEvaluatePage } from "./TestFileEvaluatePage";
import { TestFileEditPage } from "./TestFileEditPage";
import { TestFileHistoryPage } from "./TestFileHistoryPage";
import { TestFileViewPage } from "./TestFileViewPage";
import styles from "./RunnerPage.module.css";

export function TestFilePage(props) {
  return (
    <div className={styles.layout} data-test-file-mode={props.testFileMode}>
      <TestFileBar
        currentTestFile={{ ...props.testFile, path: props.currentTestFilePath }}
        testFileList={props.testFileList}
        dirty={props.isTestFileDirty}
        saveState={props.testFileSaveState}
        mode={props.testFileMode}
        onModeChange={props.onTestFileModeChange}
        onCreate={props.onCreateTestFile}
        onSave={props.onSaveTestFile}
        onReload={props.onReloadTestFile}
        onSelectFile={props.onSelectTestFile}
        onDuplicateFile={props.onDuplicateTestFile}
        isSaving={props.isSavingTestFile}
        isReloading={props.isReloadingTestFile}
      />

      {props.testFileMode === "view" ? (
        <TestFileViewPage
          testFile={props.testFile}
          selectedCaseId={props.selectedCaseId}
          result={props.result}
          lastRunAt={props.lastRunAt}
          history={props.testFileHistory}
          onModeChange={props.onTestFileModeChange}
          onSelectCase={props.onSelectCase}
          onRunAll={() => props.onRunPayload({ scope: "all", triggerSurface: "view" })}
          onOpenHistoryRun={props.onOpenHistoryRun}
        />
      ) : null}

      {props.testFileMode === "edit-file" ? <TestFileEditPage {...props} /> : null}

      {props.testFileMode === "build-cases" ? (
        <OrchestratorWorkspace
          {...props}
          onRunPayload={(request) =>
            props.onRunPayload(typeof request === "string"
              ? { scope: request, triggerSurface: "build-cases" }
              : { ...(request || {}), triggerSurface: "build-cases" })}
          onRunStep={(stepId, runtimeVariables = null, runOptions = {}) =>
            props.onRunStep(stepId, runtimeVariables, { ...runOptions, triggerSurface: "build-cases" })}
        />
      ) : null}

      {props.testFileMode === "evaluate" ? (
        <TestFileEvaluatePage
          testFile={props.testFile}
          currentTestFilePath={props.currentTestFilePath}
          isTestFileDirty={props.isTestFileDirty}
          onSaveTestFile={props.onSaveTestFile}
          isSavingTestFile={props.isSavingTestFile}
        />
      ) : null}

      {props.testFileMode === "run" ? (
        <ResultsWorkspace
          {...props}
          onRunPayload={(request) =>
            props.onRunPayload(typeof request === "string"
              ? { scope: request, triggerSurface: "run" }
              : { ...(request || {}), triggerSurface: "run" })}
        />
      ) : null}

      {props.testFileMode === "history" ? (
        <TestFileHistoryPage
          testFile={props.testFile}
          currentTestFilePath={props.currentTestFilePath}
          result={props.result}
          lastRunAt={props.lastRunAt}
          panelPlatform={props.panelPlatform}
          onModeChange={props.onTestFileModeChange}
          onRunAll={() => props.onRunPayload({ scope: "all", triggerSurface: "history" })}
          historyFocusReportPath={props.historyFocusReportPath}
          onHistoryFocusConsumed={props.onHistoryFocusConsumed}
          onOpenProfessionalReport={props.onOpenProfessionalReport}
          onOpenBuildStep={props.onOpenBuildStep}
        />
      ) : null}
    </div>
  );
}
