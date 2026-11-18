import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@panel/components/ui/tooltip";

export function FullTextTooltip({ content, children, side = "top", align = "center" }) {
  const fullText = content == null ? "" : String(content);

  if (!fullText) {
    return children;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        sideOffset={6}
        className="max-w-[min(560px,calc(100vw-32px))] whitespace-pre-wrap break-words text-left leading-5"
      >
        {fullText}
      </TooltipContent>
    </Tooltip>
  );
}
