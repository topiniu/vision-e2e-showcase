import { ClipboardCopy, Copy, FilePlus2, FolderOpen } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@panel/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@panel/components/ui/tooltip";
import { copyTextToClipboard } from "@panel/lib/clipboard";

function getWorkflowPath(file) {
  return file?.path ? `test-workflows/${file.path}` : "";
}

function getFileName(file) {
  const pathValue = String(file?.path || "");
  return pathValue.split("/").filter(Boolean).pop() || file?.name || "";
}

export function TestFileActionMenu({ file, onSelectFile, onDuplicateFile, tooltip, children }) {
  const disabled = !file?.path || file.invalid;
  return (
    <ContextMenu>
      {tooltip ? (
        <Tooltip>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>{children}</TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent
            side="right"
            align="start"
            sideOffset={6}
            className="max-w-[min(560px,calc(100vw-32px))] whitespace-pre-wrap break-words text-left leading-5"
          >
            {tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      )}
      <ContextMenuContent alignOffset={4} className="min-w-44">
        <ContextMenuItem disabled={disabled} onSelect={() => onSelectFile?.(file.path)}>
          <FolderOpen />
          Open
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!file?.path} onSelect={() => copyTextToClipboard(getWorkflowPath(file))}>
          <ClipboardCopy />
          Copy path
        </ContextMenuItem>
        <ContextMenuItem disabled={!file?.path} onSelect={() => copyTextToClipboard(getFileName(file))}>
          <Copy />
          Copy file name
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={disabled} onSelect={() => onDuplicateFile?.(file)}>
          <FilePlus2 />
          Duplicate file
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
