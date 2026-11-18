import { LayoutDashboard } from "lucide-react";
import { Button } from "@panel/components/ui/button";

// v1.11 REQ-Z33: the sidebar entry to the run board — history, running and
// queued work of every run type (headless / batch / App-run / panel). Replaces
// the "External activity" popover, which only ever showed this process's own
// external calls and nothing about headless or queued work.
export function RunBoardButton({ compact = false, active = false, onClick }) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size={compact ? "icon-sm" : "sm"}
      className={compact ? undefined : "w-full justify-start"}
      aria-label="运行看板"
      aria-current={active ? "page" : undefined}
      title="运行看板：运行中 / 排队 / 历史"
      data-testid="sidebar-run-board-open"
      onClick={onClick}
    >
      <LayoutDashboard data-icon="inline-start" />
      {!compact ? "运行看板" : null}
    </Button>
  );
}

export default RunBoardButton;
