import { OrchestratorWorkspace } from "@panel/features/orchestrator/OrchestratorWorkspace";
import { TestFileBar } from "@panel/features/test-files/TestFileBar";
import { TestFileViewPage } from "./TestFileViewPage";

export function OrchestratorPage(props) {
  return (
    <div className="grid gap-4">
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
      {props.testFileMode === "view" ? <TestFileViewPage testFile={props.testFile} /> : <OrchestratorWorkspace {...props} />}
    </div>
  );
}
