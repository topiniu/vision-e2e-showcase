import { FilePlus2, Files, RefreshCw, Save } from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Input } from "@panel/components/ui/input";
import { FullTextTooltip } from "@panel/components/shared/FullTextTooltip";
import { TestFileActionMenu } from "./TestFileActions";
import styles from "./TestFileBar.module.css";

const modes = [
  ["view", "View"],
  ["edit-file", "Edit file"],
  ["build-cases", "Build cases"],
  ["evaluate", "Evaluate"],
  ["run", "Run"],
  ["history", "History"],
];

const saveBadges = {
  saved: { label: "Saved", variant: "success" },
  dirty: { label: "Unsaved", variant: "running" },
  "external-updated": { label: "File updated", variant: "warning" },
  conflict: { label: "Review changes", variant: "danger" },
};

export function TestFileBar({
  currentTestFile,
  testFileList,
  dirty,
  saveState,
  mode,
  onModeChange,
  onCreate,
  onSave,
  onReload,
  onSelectFile,
  onDuplicateFile,
  isSaving,
  isReloading,
}) {
  const saveBadge = saveBadges[saveState || (dirty ? "dirty" : "saved")] || saveBadges.saved;
  const canReload = saveState === "external-updated" || saveState === "conflict";
  return (
    <section className={styles.bar} aria-label="Test file">
      <div className={styles.identity}>
        <Badge variant={saveBadge.variant}>{saveBadge.label}</Badge>
        {canReload ? (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            onClick={onReload}
            disabled={isReloading}
            aria-label="Reload current test file"
            title="Reload current test file"
          >
            <RefreshCw />
          </Button>
        ) : null}
        <div className={styles.titleBlock}>
          <FullTextTooltip content={currentTestFile?.name || "Untitled test file"} side="bottom" align="start">
            <strong>{currentTestFile?.name || "Untitled test file"}</strong>
          </FullTextTooltip>
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.modeGroup} role="tablist" aria-label="Test file mode">
          {modes.map(([item, label]) => (
            <button
              key={item}
              type="button"
              className={styles.modeButton}
              data-active={mode === item}
              onClick={() => onModeChange(item)}
            >
              {label}
            </button>
          ))}
        </div>
        <FilePicker files={testFileList} onSelectFile={onSelectFile} onDuplicateFile={onDuplicateFile} />
        <Button type="button" variant="secondary" size="sm" onClick={onCreate}>
          <FilePlus2 data-icon="inline-start" />
          New
        </Button>
        <Button type="button" variant="default" size="sm" onClick={onSave} disabled={isSaving || !dirty}>
          <Save data-icon="inline-start" />
          Save
        </Button>
      </div>
    </section>
  );
}

function FilePicker({ files, onSelectFile, onDuplicateFile }) {
  return (
    <div className={styles.filePicker}>
      <button type="button" className={styles.fileTrigger}>
        <Files className="size-4" />
        Files
      </button>
      <div className={styles.filePanel}>
        {files?.length ? (
          <>
            <Input
              readOnly
              value={`${files.length} test files`}
              aria-label="Test file count"
              className={styles.fileCount}
            />
            <div className={styles.fileList}>
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
                    className={styles.fileItem}
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
          <div className={styles.emptyFiles}>No saved test files yet.</div>
        )}
      </div>
    </div>
  );
}
