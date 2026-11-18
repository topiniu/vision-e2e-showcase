import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@panel/components/ui/dialog";
import { Button } from "@panel/components/ui/button";
import { Checkbox } from "@panel/components/ui/checkbox";
import { Input } from "@panel/components/ui/input";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { Badge } from "@panel/components/ui/badge";
import { runTestBatch, subscribeTestBatchProgress } from "@panel/lib/panel-api";

// Z10 panel entry: pick test files (tree-organized by folder) and run them in
// parallel. Each file is an independent headless session; the main process
// streams per-item progress over `test-batch-progress` for live per-file status.

const STATUS_META = {
  pending: { label: "待运行", variant: "neutral" },
  running: { label: "运行中", variant: "running" },
  passed: { label: "通过", variant: "success" },
  failed: { label: "失败", variant: "danger" },
  error: { label: "错误", variant: "danger" },
  blocked: { label: "阻断", variant: "warning" },
};

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.pending;
}

function normalizeStatus(status) {
  if (status === "passed" || status === "failed" || status === "error" || status === "blocked") {
    return status;
  }
  if (status === "completed") {
    return "passed";
  }
  return status || "passed";
}

// Build a folder tree from the flat file list using each file's `group` path.
function buildTree(files) {
  const root = { key: "", label: "", groups: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.group || "").split("/").map((p) => p.trim()).filter(Boolean);
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

function collectPaths(node, out = []) {
  for (const file of node.files) {
    out.push(file.path);
  }
  for (const child of node.groups.values()) {
    collectPaths(child, out);
  }
  return out;
}

function folderState(node, selected) {
  const paths = collectPaths(node);
  if (!paths.length) {
    return "none";
  }
  const count = paths.filter((p) => selected.has(p)).length;
  if (count === 0) {
    return "none";
  }
  return count === paths.length ? "all" : "some";
}

export function BatchRunDialog({ files = [], triggerClassName }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [concurrency, setConcurrency] = useState(3);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({});
  const [stats, setStats] = useState(null);

  const runnable = useMemo(() => files.filter((file) => file && file.path && !file.invalid), [files]);
  const tree = useMemo(() => buildTree(runnable), [runnable]);
  const allPaths = useMemo(() => runnable.map((file) => file.path), [runnable]);

  useEffect(() => {
    const unsubscribe = subscribeTestBatchProgress((event) => {
      if (!event) {
        return;
      }
      if (event.type === "item-start" && event.testFilePath) {
        setProgress((prev) => ({ ...prev, [event.testFilePath]: { status: "running" } }));
      } else if (event.type === "item-complete" && event.testFilePath) {
        setProgress((prev) => ({
          ...prev,
          [event.testFilePath]: { status: normalizeStatus(event.status), message: event.error?.message || null },
        }));
      } else if (event.type === "batch-complete") {
        if (event.stats) {
          setStats(event.stats);
        }
        setRunning(false);
      }
    });
    return unsubscribe;
  }, []);

  const allSelected = allPaths.length > 0 && allPaths.every((p) => selected.has(p));

  const setSelection = (paths, on) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) {
          next.add(p);
        } else {
          next.delete(p);
        }
      }
      return next;
    });
  };

  const toggleFile = (path) => setSelection([path], !selected.has(path));
  const toggleFolder = (node) => {
    const paths = collectPaths(node);
    const state = folderState(node, selected);
    setSelection(paths, state !== "all");
  };
  const toggleAll = () => setSelection(allPaths, !allSelected);
  const toggleCollapse = (key) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleRun = async () => {
    const items = runnable.filter((file) => selected.has(file.path)).map((file) => ({ testFilePath: file.path }));
    if (!items.length || running) {
      return;
    }
    setRunning(true);
    setStats(null);
    setProgress(Object.fromEntries(items.map((item) => [item.testFilePath, { status: "pending" }])));
    const response = await runTestBatch({ items, concurrency: Number(concurrency) || 2 });
    if (!response?.success) {
      setProgress((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (next[key]?.status === "pending" || next[key]?.status === "running") {
            next[key] = { status: "error", message: response?.message || response?.error || "batch failed" };
          }
        }
        return next;
      });
      setRunning(false);
      return;
    }
    if (response.stats) {
      setStats(response.stats);
    }
    setRunning(false);
  };

  const selectedCount = selected.size;

  const renderFile = (file, depth) => {
    const entry = progress[file.path];
    const meta = entry?.status ? statusMeta(entry.status) : null;
    return (
      <div
        key={file.path}
        className="flex items-center gap-2.5 rounded-[4px] px-2 py-1.5 hover:bg-[var(--panel-muted)]"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <Checkbox checked={selected.has(file.path)} onCheckedChange={() => toggleFile(file.path)} disabled={running} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-foreground" title={file.path}>{file.name || file.path}</div>
          {entry?.message ? (
            <div className="truncate text-[11px] text-[var(--danger)]" title={entry.message}>{entry.message}</div>
          ) : (
            <div className="truncate text-[11px] text-[var(--muted-foreground)]">{file.path}</div>
          )}
        </div>
        {meta ? <Badge variant={meta.variant}>{meta.label}</Badge> : (
          <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">{file.caseCount || 0} 用例</span>
        )}
      </div>
    );
  };

  const renderNode = (node, depth) => {
    const childGroups = Array.from(node.groups.values());
    return (
      <React.Fragment key={node.key || "root"}>
        {childGroups.map((group) => {
          const state = folderState(group, selected);
          const isCollapsed = collapsed.has(group.key);
          const count = collectPaths(group).length;
          return (
            <div key={group.key}>
              <div
                className="flex items-center gap-2 rounded-[4px] px-2 py-1.5 hover:bg-[var(--panel-muted)]"
                style={{ paddingLeft: `${8 + depth * 16}px` }}
              >
                <Checkbox
                  checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
                  onCheckedChange={() => toggleFolder(group)}
                  disabled={running}
                />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => toggleCollapse(group.key)}
                >
                  {isCollapsed ? <ChevronRight className="size-3.5 shrink-0 text-[var(--muted-foreground)]" /> : <ChevronDown className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />}
                  {isCollapsed ? <Folder className="size-3.5 shrink-0 text-[var(--muted-foreground)]" /> : <FolderOpen className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />}
                  <span className="truncate text-[13px] font-medium text-foreground">{group.label}</span>
                  <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">{count}</span>
                </button>
              </div>
              {!isCollapsed ? renderNode(group, depth + 1) : null}
            </div>
          );
        })}
        {node.files.map((file) => renderFile(file, depth))}
      </React.Fragment>
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName} data-testid="test-files-batch-run-trigger">
          并行运行…
        </button>
      </DialogTrigger>
      <DialogContent className="h-[80vh] max-w-3xl gap-0 p-0">
        <DialogHeader className="border-b border-[var(--border-subtle)] px-5 pt-5 pb-3">
          <DialogTitle>并行运行测试文件</DialogTitle>
          <DialogDescription>
            按目录树勾选多个测试文件，各自独立 <b>headless（无界面）</b> 会话并发执行；超出并发度的会排队。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-5 py-2.5">
          <label className="flex items-center gap-2 text-[12px] text-foreground">
            <Checkbox checked={allSelected} onCheckedChange={toggleAll} disabled={!runnable.length || running} />
            全选（{selectedCount}/{runnable.length}）
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--muted-foreground)]">
            并发度
            <Input
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
              className="h-7 w-14 text-[12px]"
              data-testid="test-files-batch-run-concurrency"
            />
          </label>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3 py-2" data-testid="test-files-batch-run-tree">
            {runnable.length === 0 ? (
              <div className="px-2 py-6 text-center text-[12px] text-[var(--muted-foreground)]">没有可运行的测试文件。</div>
            ) : (
              renderNode(tree, 0)
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-5 py-3">
          <span className="text-[12px] text-[var(--muted-foreground)]">
            {stats
              ? `完成 ${stats.okCount}/${stats.total}（失败 ${stats.errorCount}），并发 ${stats.peakConcurrency}，用时 ${(stats.wallDurationMs / 1000).toFixed(1)}s · 结果见 History`
              : `已选 ${selectedCount} 个`}
          </span>
          <Button onClick={handleRun} disabled={running || selectedCount === 0} data-testid="test-files-batch-run-start">
            {running ? "运行中…" : `并行运行（${selectedCount}）`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default BatchRunDialog;
