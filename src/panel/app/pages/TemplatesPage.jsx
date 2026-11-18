import { WandSparkles } from "lucide-react";
import { Button } from "@panel/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@panel/components/ui/card";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { payloadTemplates } from "@panel/features/browser/browser-templates";

export function TemplatesPage({ onApplyTemplate, onNavigatePage }) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="text-xs text-[var(--muted-foreground)]">Template library</div>
          <CardTitle>Seed the current test file.</CardTitle>
          <CardDescription>Apply a curated scaffold to the open test file, then refine it in Edit.</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onNavigatePage("orchestrator")}>
          Open edit
        </Button>
      </CardHeader>
      <CardContent className="pb-4">
        <ScrollArea className="max-h-[560px] pr-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {payloadTemplates.map((template) => (
              <Card key={template.id} className="bg-[var(--panel-muted)] shadow-none">
                <CardHeader className="gap-2 p-4 pb-3">
                  <CardTitle className="text-base">{template.title}</CardTitle>
                  <CardDescription>{template.description}</CardDescription>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <Button variant="secondary" onClick={() => onApplyTemplate(template.payload)}>
                    <WandSparkles data-icon="inline-start" />
                    Apply to current file
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
