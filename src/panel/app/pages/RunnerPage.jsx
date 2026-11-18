import { BrowserWorkspace } from "@panel/features/browser/BrowserWorkspace";
import { ResultsWorkspace } from "@panel/features/results/ResultsWorkspace";
import { TestFileBar } from "@panel/features/test-files/TestFileBar";
import { TestFileViewPage } from "./TestFileViewPage";
import styles from "./RunnerPage.module.css";

export function RunnerPage(props) {
  return (
    <div className={styles.layout}>
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
        <TestFileViewPage testFile={props.testFile} />
      ) : (
        <>
          <BrowserWorkspace {...props} />
          <ResultsWorkspace result={props.result} />
        </>
      )}
    </div>
  );
}
