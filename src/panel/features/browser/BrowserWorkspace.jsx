import {
  ArrowLeft,
  ArrowRight,
  ClipboardList,
  Globe,
  Info,
  Play,
  RefreshCw,
  Square,
  WandSparkles,
} from "lucide-react";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Input } from "@panel/components/ui/input";
import { payloadTemplates } from "./browser-templates";
import styles from "./BrowserWorkspace.module.css";

function statusVariant(browserState) {
  if (browserState?.lastError) {
    return "danger";
  }
  if (browserState?.isLoading) {
    return "running";
  }
  return "success";
}

const browserRows = [
  ["Title", (browserState) => browserState?.title || "-"],
  ["Current URL", (browserState) => browserState?.url || "-"],
  ["Requested URL", (browserState) => browserState?.requestedUrl || "-"],
  ["Last error", (browserState) => browserState?.lastError?.description || "-"],
];

export function BrowserWorkspace({
  browserState,
  navInput,
  onNavInputChange,
  onNavigate,
  onCommand,
  onApplyTemplate,
  onRunPayload,
  isRunning,
  showTemplates = true,
}) {
  return (
    <section className={styles.toolbar} aria-label="Browser runner controls">
      <form
        className={styles.navForm}
        onSubmit={(event) => {
          event.preventDefault();
          onNavigate();
        }}
      >
        <div className={styles.statusCluster}>
          <Badge variant={statusVariant(browserState)}>
            {browserState?.isLoading ? "Loading" : browserState?.lastError ? "Error" : "Ready"}
          </Badge>
          <span className={styles.currentTitle}>{browserState?.title || "No page"}</span>
        </div>

        <div className={styles.addressCluster}>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onCommand("back")} title="Back" aria-label="Back">
            <ArrowLeft className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onCommand("forward")} title="Forward" aria-label="Forward">
            <ArrowRight className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onCommand("reload")} title="Reload" aria-label="Reload">
            <RefreshCw className="size-3.5" />
          </Button>
          <Input
            value={navInput}
            onChange={(event) => onNavInputChange(event.target.value)}
            placeholder="https://example.com"
            aria-label="Target URL"
          />
          <Button type="submit" variant="secondary" size="icon-sm" title="Navigate" aria-label="Navigate">
            <Globe className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onCommand("stop")} title="Stop" aria-label="Stop">
            <Square className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            onClick={onRunPayload}
            disabled={isRunning}
            title={isRunning ? "Running payload" : "Run payload"}
            aria-label={isRunning ? "Running payload" : "Run payload"}
          >
            <Play className="size-3.5" />
          </Button>
        </div>
      </form>

      <div className={styles.infoDock}>
        <InfoPopover
          icon={Info}
          label="Session"
          align="right"
          panel={
            <div className={styles.stateList}>
              {browserRows.map(([label, getValue]) => (
                <div key={label} className={styles.stateRow}>
                  <span>{label}</span>
                  <strong>{getValue(browserState)}</strong>
                </div>
              ))}
            </div>
          }
        />
        {showTemplates ? (
          <InfoPopover
            icon={ClipboardList}
            label="Templates"
            align="right"
            panel={
              <div className={styles.templateList}>
                {payloadTemplates.map((template) => (
                  <div key={template.id} className={styles.templateItem}>
                    <div>
                      <div className={styles.templateTitle}>{template.title}</div>
                      <p className={styles.templateDescription}>{template.description}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onApplyTemplate(template.payload)}
                      title="Apply template"
                      aria-label={`Apply ${template.title}`}
                    >
                      <WandSparkles />
                    </Button>
                  </div>
                ))}
              </div>
            }
          />
        ) : null}
      </div>
    </section>
  );
}

function InfoPopover({ icon: Icon, label, panel, align = "left" }) {
  return (
    <div className={styles.infoPopover} data-align={align}>
      <button type="button" className={styles.infoTrigger} aria-label={label}>
        <Icon className="size-4" />
        <span>{label}</span>
      </button>
      <div className={styles.popoverPanel}>{panel}</div>
    </div>
  );
}
