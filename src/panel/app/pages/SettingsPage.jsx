import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Bot,
  BookOpenText,
  ClipboardCopy,
  ExternalLink,
  FolderOpen,
  HardDrive,
  KeyRound,
  Maximize2,
  MonitorUp,
  MoonStar,
  Network,
  Palette,
  PlugZap,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Clock,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@panel/components/ui/alert";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Input } from "@panel/components/ui/input";
import { Separator } from "@panel/components/ui/separator";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@panel/components/ui/select";
import { Skeleton } from "@panel/components/ui/skeleton";
import { Switch } from "@panel/components/ui/switch";
import { Textarea } from "@panel/components/ui/textarea";
import { cn } from "@panel/lib/utils";
import { copyTextToClipboard } from "@panel/lib/clipboard";
import {
  captureAuthProfile,
  chooseWorkspace,
  getAuthRenewalConfig,
  getAuthStatus,
  getExternalIntegrationDocuments,
  getWorkspaceSettings,
  openWorkspace,
  renewAuthProfile,
  resetWorkspace,
  restartApp,
  setAuthRenewalConfig,
  subscribeAuthRenewalStatus,
} from "@panel/lib/panel-api";

const MarkdownDocument = lazy(() => import("@panel/components/shared/MarkdownDocument"));

const DEFAULT_LOGIN_URL = "http://127.0.0.1:32148/";

// Auth freshness → badge label/variant. staleness comes from the local
// cookie-expiry evaluation in runtime/server/auth-profile.js.
const AUTH_FRESHNESS_META = {
  fresh: { label: "有效", variant: "success" },
  expiring: { label: "即将过期", variant: "warning" },
  expired: { label: "已过期", variant: "destructive" },
  unknown: { label: "已登录（无到期信息）", variant: "secondary" },
  missing: { label: "未保存", variant: "outline" },
  invalid: { label: "文件损坏", variant: "destructive" },
};

function resolveAuthFreshnessMeta(status) {
  if (!status) {
    return AUTH_FRESHNESS_META.missing;
  }
  if (status.status === "missing") {
    return AUTH_FRESHNESS_META.missing;
  }
  if (status.status === "invalid") {
    return AUTH_FRESHNESS_META.invalid;
  }
  return AUTH_FRESHNESS_META[status.staleness] || AUTH_FRESHNESS_META.unknown;
}

function formatAbsoluteTime(value) {
  if (!value && value !== 0) {
    return "—";
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    return "—";
  }
  try {
    return new Date(ms).toLocaleString();
  } catch (_error) {
    return "—";
  }
}

function formatRelativeFromNow(value) {
  if (!value && value !== 0) {
    return "";
  }
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const diffMinutes = Math.round((ms - Date.now()) / 60000);
  const abs = Math.abs(diffMinutes);
  const unit = abs >= 60 ? `${Math.round(abs / 60)} 小时` : `${abs} 分钟`;
  if (diffMinutes === 0) {
    return "刚刚";
  }
  return diffMinutes > 0 ? `${unit}后` : `${unit}前`;
}
const DEFAULT_EXTERNAL_INTEGRATION_ENDPOINTS = [{
  kind: "local",
  label: "This computer",
  address: "127.0.0.1",
  interfaceName: "loopback",
  baseUrl: "http://127.0.0.1:32147",
  documentsUrl: "http://127.0.0.1:32147/external-integration-documents",
}];

// Resolve the MCP endpoint for a specific access endpoint. The `mcp` block from
// the desktop reports the route for the origin that asked; reuse only its path so
// every LAN/Tailnet address gets its own reachable MCP URL.
function resolveMcpUrl(endpoint, mcp) {
  if (!mcp?.endpoint || !endpoint?.baseUrl) {
    return "";
  }
  try {
    return `${endpoint.baseUrl.replace(/\/+$/, "")}${new URL(mcp.endpoint).pathname}`;
  } catch {
    return "";
  }
}

function buildAiIntegrationCopy(endpoint, workspace, mcp) {
  const mcpUrl = resolveMcpUrl(endpoint, mcp);
  const toolCount = Array.isArray(mcp?.tools) ? mcp.tools.length : 0;
  return [
    "请读取猪猪当前版本的 AI / 外部工具对接文档：",
    endpoint.documentsUrl,
    "",
    `猪猪桌面 App Run API 基地址：${endpoint.baseUrl}`,
    mcpUrl
      ? `猪猪 MCP Server（Streamable HTTP、无状态${toolCount ? `、${toolCount} 个类型化工具` : ""}）：${mcpUrl}${
          toolCount ? "。支持 MCP 的客户端优先连它、直接 listTools/callTool，不必手拼 HTTP；能力与 HTTP 端点等价。" : "。"
        }`
      : null,
    workspace?.workspaceRoot ? `猪猪当前 Workspace：${workspace.workspaceRoot}` : null,
    workspace?.testWorkflowsRoot ? `测试用例 JSON 写入目录：${workspace.testWorkflowsRoot}` : null,
    workspace?.testAssetsRoot ? `测试资产目录：${workspace.testAssetsRoot}` : null,
    workspace?.outputRoot ? `运行产物目录：${workspace.outputRoot}` : null,
    workspace?.testWorkflowsRoot
      ? "调用接口时，testFilePath 只传相对于 test-workflows 的路径，不要包含 test-workflows/ 前缀。"
      : null,
    "该地址可以读取对接协议并调用桌面端能力；调用时请让猪猪保持运行。",
  ].filter(Boolean).join("\n");
}

const settingsSections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: MoonStar },
  { id: "chrome", label: "Chrome", icon: MonitorUp },
  { id: "runtime", label: "Runtime", icon: PlugZap },
  { id: "auth", label: "Auth", icon: KeyRound },
  { id: "integrations", label: "Integration docs", icon: BookOpenText },
];

function IntegrationDocumentsSection() {
  const [documents, setDocuments] = useState([]);
  const [accessEndpoints, setAccessEndpoints] = useState(DEFAULT_EXTERNAL_INTEGRATION_ENDPOINTS);
  const [integrationWorkspace, setIntegrationWorkspace] = useState(null);
  const [integrationMcp, setIntegrationMcp] = useState(null);
  const [activeDocumentId, setActiveDocumentId] = useState("");
  const [loadState, setLoadState] = useState({ status: "loading", message: "" });

  useEffect(() => {
    let cancelled = false;
    getExternalIntegrationDocuments()
      .then((result) => {
        if (cancelled) return;
        const nextDocuments = Array.isArray(result?.documents) ? result.documents : [];
        const nextEndpoints = Array.isArray(result?.endpoints) && result.endpoints.length
          ? result.endpoints
          : DEFAULT_EXTERNAL_INTEGRATION_ENDPOINTS;
        setDocuments(nextDocuments);
        setAccessEndpoints(nextEndpoints);
        setIntegrationWorkspace(result?.workspace || null);
        setIntegrationMcp(result?.mcp || null);
        setActiveDocumentId((current) => current || nextDocuments[0]?.id || "");
        setLoadState({
          status: nextDocuments.length ? "ready" : "empty",
          message: nextDocuments.length ? "" : "No integration documents are configured.",
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadState({ status: "failed", message: error?.message || "Failed to load integration documents." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeDocument = documents.find((document) => document.id === activeDocumentId) || documents[0];

  if (loadState.status === "loading") {
    return (
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
        <Skeleton className="h-[520px]" />
        <Skeleton className="h-[520px]" />
      </div>
    );
  }

  if (loadState.status !== "ready") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Integration documents unavailable</AlertTitle>
        <AlertDescription>{loadState.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="integration-documents-endpoint-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <h2 id="integration-documents-endpoint-title" className="text-sm font-semibold">AI / external tool documentation</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Share a reachable address with an AI or external tool. Zhuzhu must remain open while the integration is active.
            </p>
          </div>
          <Badge variant="warning">Network access enabled</Badge>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>LAN and Tailnet devices can access every desktop endpoint, including test-file writes and Run file. Only share these addresses with trusted devices or protected tunnels.</p>
        </div>
        <div className="mt-3 grid gap-2">
          {accessEndpoints.map((endpoint) => {
            const mcpUrl = resolveMcpUrl(endpoint, integrationMcp);
            const mcpToolCount = Array.isArray(integrationMcp?.tools) ? integrationMcp.tools.length : 0;
            return (
            <div key={`${endpoint.kind}-${endpoint.address}`} className="grid gap-2 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs font-medium">
                  <Network className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  {endpoint.label}
                  <span className="font-normal text-muted-foreground">{endpoint.interfaceName}</span>
                </span>
                <Badge variant={endpoint.kind === "local" ? "neutral" : endpoint.kind === "tailnet" ? "running" : "success"}>
                  {endpoint.kind === "tailnet" ? "Tailnet" : endpoint.kind === "lan" ? "LAN" : "Local"}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={endpoint.documentsUrl}
                  readOnly
                  aria-label={`${endpoint.label} documentation address`}
                  className="min-w-[280px] flex-1 font-mono"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={() => copyTextToClipboard(endpoint.documentsUrl)}>
                  <ClipboardCopy data-icon="inline-start" />
                  Copy address
                </Button>
                <Button type="button" onClick={() => copyTextToClipboard(buildAiIntegrationCopy(endpoint, integrationWorkspace, integrationMcp))}>
                  <Bot data-icon="inline-start" />
                  Copy for AI
                </Button>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">API base: {endpoint.baseUrl}</p>
              {mcpUrl ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-all font-mono text-[11px] text-muted-foreground">MCP: {mcpUrl}</p>
                  <Button type="button" size="sm" variant="outline" onClick={() => copyTextToClipboard(mcpUrl)}>
                    <ClipboardCopy data-icon="inline-start" />
                    Copy MCP address
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {mcpToolCount ? `${mcpToolCount} typed tools · ` : ""}
                    {integrationMcp?.transport || "streamable-http"}
                    {integrationMcp?.stateless ? " · stateless" : ""}
                  </span>
                </div>
              ) : null}
              {integrationWorkspace?.testWorkflowsRoot ? (
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  Cases: {integrationWorkspace.testWorkflowsRoot}
                </p>
              ) : null}
            </div>
            );
          })}
        </div>
      </section>

      <div className="grid min-h-[620px] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card">
        <nav className="flex flex-col gap-2 border-r border-border bg-muted/30 p-3" aria-label="Integration documents">
          <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Published contracts</div>
          {documents.map((document) => (
            <button
              key={document.id}
              type="button"
              className={cn(
                "flex flex-col items-start gap-1 rounded-md px-3 py-2.5 text-left transition-colors",
                document.id === activeDocument?.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setActiveDocumentId(document.id)}
            >
              <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                <span>{document.title}</span>
                <Badge variant={document.audience === "AI" ? "running" : "neutral"}>{document.audience}</Badge>
              </span>
              <span className="line-clamp-2 text-xs leading-4">{document.description}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border px-6 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {activeDocument?.audience === "AI" ? <Bot aria-hidden="true" /> : <BookOpenText aria-hidden="true" />}
                <h2 className="truncate text-sm font-semibold">{activeDocument?.title}</h2>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">{activeDocument?.path}</p>
            </div>
            <Badge variant={activeDocument?.audience === "AI" ? "running" : "neutral"}>{activeDocument?.audience}</Badge>
          </div>
          <ScrollArea className="h-[calc(100vh-380px)] min-h-[460px]">
            <div className="px-8 py-7">
              <Suspense fallback={<Skeleton className="h-[480px]" />}>
                <MarkdownDocument markdown={activeDocument?.markdown || ""} />
              </Suspense>
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function WorkspaceSettingsSection() {
  const [workspaceState, setWorkspaceState] = useState({ status: "loading", data: null, message: "" });
  const [operation, setOperation] = useState("");

  useEffect(() => {
    let cancelled = false;
    getWorkspaceSettings()
      .then((result) => {
        if (cancelled) return;
        setWorkspaceState(result?.success
          ? { status: "ready", data: result, message: "" }
          : { status: "failed", data: null, message: result?.message || "Workspace settings are unavailable." });
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceState({ status: "failed", data: null, message: error?.message || "Workspace settings are unavailable." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyWorkspaceResult = (result) => {
    if (result?.canceled) return;
    if (result?.success) {
      setWorkspaceState({ status: "ready", data: result, message: "" });
      return;
    }
    setWorkspaceState((current) => ({
      ...current,
      status: current.data ? "ready" : "failed",
      message: result?.message || result?.error || "Workspace update failed.",
    }));
  };

  const runWorkspaceOperation = async (name, callback) => {
    setOperation(name);
    try {
      applyWorkspaceResult(await callback());
    } catch (error) {
      applyWorkspaceResult({ success: false, message: error?.message || "Workspace update failed." });
    } finally {
      setOperation("");
    }
  };

  if (workspaceState.status === "loading") {
    return <Skeleton className="h-44" />;
  }

  if (!workspaceState.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Workspace settings unavailable</AlertTitle>
        <AlertDescription>{workspaceState.message}</AlertDescription>
      </Alert>
    );
  }

  const settings = workspaceState.data;
  const configuredRoot = settings.configuredWorkspaceRoot || settings.defaultWorkspaceRoot;

  return (
    <SettingsGroup title="Workspace folder">
      <div className="grid gap-4 px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="grid min-w-0 gap-1">
              <div className="text-sm font-medium">Test and run workspace</div>
              <p className="max-w-[650px] text-sm leading-5 text-muted-foreground">
                Zhuzhu reads test-workflows and writes test-assets and output under this folder. Choose the repository root to share the same files with dev.
              </p>
            </div>
          </div>
          <Badge variant={settings.restartRequired ? "warning" : "success"}>
            {settings.restartRequired ? "Restart required" : "Active"}
          </Badge>
        </div>

        <div className="grid gap-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="workspace-folder-path">Selected folder</label>
          <div className="flex flex-wrap items-center gap-2">
            <Input id="workspace-folder-path" value={configuredRoot} readOnly className="min-w-[360px] flex-1 font-mono" />
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(operation) || settings.environmentOverride}
              onClick={() => runWorkspaceOperation("choose", chooseWorkspace)}
            >
              <FolderOpen data-icon="inline-start" />
              Choose folder
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(operation) || settings.environmentOverride || configuredRoot === settings.defaultWorkspaceRoot}
              onClick={() => runWorkspaceOperation("reset", resetWorkspace)}
            >
              <RotateCcw data-icon="inline-start" />
              Restore default
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">Active now: {settings.activeWorkspaceRoot}</span>
            <Button type="button" variant="link" size="sm" onClick={() => openWorkspace(configuredRoot)}>
              <ExternalLink data-icon="inline-start" />
              Open folder
            </Button>
          </div>
        </div>

        {settings.environmentOverride ? (
          <Alert>
            <AlertTitle>Workspace controlled by environment</AlertTitle>
            <AlertDescription>Remove ZHUZHU_WORKSPACE_DIR before changing this folder in Settings.</AlertDescription>
          </Alert>
        ) : null}

        {workspaceState.message ? (
          <Alert variant="destructive">
            <AlertTitle>Workspace update failed</AlertTitle>
            <AlertDescription>{workspaceState.message}</AlertDescription>
          </Alert>
        ) : null}

        {settings.restartRequired ? (
          <Alert>
            <AlertTitle>Restart to switch workspace</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{settings.packaged ? "Restart Zhuzhu to apply the selected folder." : "Stop and run npm run dev again to apply the selected folder to Electron, Panel, and Runtime Server."}</span>
              {settings.packaged ? (
                <Button type="button" size="sm" disabled={operation === "restart"} onClick={() => runWorkspaceOperation("restart", restartApp)}>
                  Restart Zhuzhu
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function SettingsRow({ title, description, icon: Icon, action }) {
  return (
    <div className="flex min-h-[72px] items-center justify-between gap-5 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description ? <div className="max-w-[620px] text-sm leading-5 text-muted-foreground">{description}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </div>
  );
}

function SettingsGroup({ title, children }) {
  return (
    <section className="grid gap-3">
      {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : null}
      <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </section>
  );
}

export function SettingsPage({
  theme,
  colorTheme,
  runtimeState,
  browserState,
  panelPreferences,
  onNavigate,
  onColorThemeChange,
  onToggleTheme,
  onPanelPreferenceChange,
}) {
  const [activeSection, setActiveSection] = useState("general");
  const [authProfile, setAuthProfile] = useState("demo-local");
  const [authCaptureState, setAuthCaptureState] = useState({ status: "idle", message: "", path: "" });
  const [authStatus, setAuthStatus] = useState(null);
  const [authRenewal, setAuthRenewal] = useState(null);
  const [renewState, setRenewState] = useState({ status: "idle", message: "" });
  const [isOpeningBrowser, setIsOpeningBrowser] = useState(false);
  const [savingPreference, setSavingPreference] = useState("");
  const hasControlledBrowser = Boolean(
    browserState?.browserMode === "playwright-visible"
      && browserState?.runtimeEndpoint === "integrated-runtime-v2"
      && browserState?.url,
  );
  const preferences = {
    openChromeOnSecondaryDisplay: panelPreferences?.openChromeOnSecondaryDisplay !== false,
    maximizeChromeOnLaunch: panelPreferences?.maximizeChromeOnLaunch !== false,
    browserProxyMode: ["system", "manual", "direct"].includes(panelPreferences?.browserProxyMode)
      ? panelPreferences.browserProxyMode
      : "system",
    browserProxyServer: typeof panelPreferences?.browserProxyServer === "string" ? panelPreferences.browserProxyServer : "",
    browserProxyBypass: typeof panelPreferences?.browserProxyBypass === "string" ? panelPreferences.browserProxyBypass : "",
    browserIdleTimeoutMinutes: Number.isFinite(Number(panelPreferences?.browserIdleTimeoutMinutes))
      ? Math.max(0, Math.round(Number(panelPreferences.browserIdleTimeoutMinutes)))
      : 15,
  };
  // Local drafts so typing the proxy server/bypass does not save (and relaunch
  // the browser) on every keystroke — persisted on blur when the value changes.
  const [proxyServerDraft, setProxyServerDraft] = useState(preferences.browserProxyServer);
  const [proxyBypassDraft, setProxyBypassDraft] = useState(preferences.browserProxyBypass);
  useEffect(() => {
    setProxyServerDraft(preferences.browserProxyServer);
  }, [preferences.browserProxyServer]);
  useEffect(() => {
    setProxyBypassDraft(preferences.browserProxyBypass);
  }, [preferences.browserProxyBypass]);

  const activeSectionLabel = useMemo(
    () => settingsSections.find((section) => section.id === activeSection)?.label || "General",
    [activeSection],
  );

  const updatePreference = async (key, value) => {
    if (typeof onPanelPreferenceChange !== "function") {
      return;
    }
    setSavingPreference(key);
    try {
      await onPanelPreferenceChange({ [key]: Boolean(value) });
    } finally {
      setSavingPreference("");
    }
  };

  // Save non-boolean preference values (proxy mode/server/bypass) via a patch.
  const savePreferencePatch = async (key, patch) => {
    if (typeof onPanelPreferenceChange !== "function") {
      return;
    }
    setSavingPreference(key);
    try {
      await onPanelPreferenceChange(patch);
    } finally {
      setSavingPreference("");
    }
  };

  const handleOpenLoginPage = async () => {
    if (typeof onNavigate !== "function") {
      setAuthCaptureState({
        status: "failed",
        message: "Open the Zhuzhu desktop app to start the controlled browser.",
        path: "",
      });
      return;
    }
    setIsOpeningBrowser(true);
    setAuthCaptureState({ status: "running", message: "Opening controlled browser...", path: "" });
    try {
      await onNavigate(DEFAULT_LOGIN_URL);
      setAuthCaptureState({
        status: "idle",
        message: "Log in with the controlled browser, then save this auth profile.",
        path: "",
      });
    } catch (error) {
      setAuthCaptureState({
        status: "failed",
        message: error?.message || "Failed to open controlled browser.",
        path: "",
      });
    } finally {
      setIsOpeningBrowser(false);
    }
  };

  const handleCaptureAuthProfile = async () => {
    const profile = authProfile.trim();
    if (!profile) {
      setAuthCaptureState({
        status: "failed",
        message: "Profile name is required.",
        path: "",
      });
      return;
    }
    setAuthCaptureState({ status: "running", message: "Capturing current browser session...", path: "" });
    try {
      const result = await captureAuthProfile({ profile });
      if (!result?.ok && !result?.success) {
        setAuthCaptureState({
          status: "failed",
          message: result?.error?.message || result?.message || "Capture failed.",
          path: "",
        });
        return;
      }
      setAuthCaptureState({
        status: "passed",
        message: `${result.cookieCount || 0} cookies · ${result.originCount || 0} origins`,
        path: result.storageStatePath || "",
      });
    } catch (error) {
      setAuthCaptureState({
        status: "failed",
        message: error?.message || "Capture failed.",
        path: "",
      });
    }
  };

  // Refresh the local auth status + renewal config (cheap, no network).
  const refreshAuthStatus = async () => {
    try {
      const [statusResult, configResult] = await Promise.all([
        getAuthStatus(),
        getAuthRenewalConfig(),
      ]);
      if (statusResult?.ok) {
        setAuthStatus(statusResult.status || null);
        if (statusResult.renewal) {
          setAuthRenewal(statusResult.renewal);
        }
      }
      if (configResult?.ok && configResult.config) {
        setAuthRenewal((prev) => ({ ...(prev || {}), ...configResult.config }));
        if (configResult.config.profile) {
          setAuthProfile(configResult.config.profile);
        }
      }
    } catch (_error) {
      // status is best-effort; leave prior state
    }
  };

  // Load auth status on mount and whenever the Auth section is opened
  // ("打开面板/Settings 时自动查"), and live-update on renewal broadcasts.
  useEffect(() => {
    if (activeSection !== "auth") {
      return undefined;
    }
    void refreshAuthStatus();
    const unsubscribe = subscribeAuthRenewalStatus((snapshot) => {
      if (snapshot?.status) {
        setAuthStatus(snapshot.status);
      }
      if (snapshot?.renewal) {
        setAuthRenewal((prev) => ({ ...(prev || {}), ...snapshot.renewal }));
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

  const persistRenewalPatch = async (patch) => {
    const result = await setAuthRenewalConfig(patch);
    if (result?.ok && result.config) {
      setAuthRenewal((prev) => ({ ...(prev || {}), ...result.config }));
      if (result.snapshot?.status) {
        setAuthStatus(result.snapshot.status);
      }
    }
    return result;
  };

  const handleToggleRenewal = async (enabled) => {
    await persistRenewalPatch({ enabled: Boolean(enabled), profile: authProfile.trim() || undefined });
  };

  const handleIntervalCommit = async (value) => {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) {
      return;
    }
    await persistRenewalPatch({ intervalMinutes: minutes });
  };

  const handleRenewNow = async () => {
    setRenewState({ status: "running", message: "正在无头重登刷新登录态…" });
    try {
      // Save the current target profile first so renewal targets it.
      await persistRenewalPatch({ profile: authProfile.trim() || undefined });
      const result = await renewAuthProfile({ force: false });
      if (result?.snapshot?.status) {
        setAuthStatus(result.snapshot.status);
      }
      if (result?.snapshot?.renewal) {
        setAuthRenewal((prev) => ({ ...(prev || {}), ...result.snapshot.renewal }));
      }
      if (result?.ok) {
        setRenewState({ status: "passed", message: "已刷新，登录态有效。" });
      } else if (result?.skipped === "active-run") {
        setRenewState({ status: "failed", message: "有运行进行中，已跳过刷新（避免同账号互踢）。稍后重试或点强制。" });
      } else if (result?.skipped === "in-flight") {
        setRenewState({ status: "running", message: "已有一次续期在进行中…" });
      } else {
        setRenewState({ status: "failed", message: result?.error?.message || "刷新失败（登录未通过）。" });
      }
    } catch (error) {
      setRenewState({ status: "failed", message: error?.message || "刷新失败。" });
    }
  };

  const authFreshnessMeta = resolveAuthFreshnessMeta(authStatus);

  const authBadgeVariant =
    authCaptureState.status === "passed"
      ? "success"
      : authCaptureState.status === "failed"
        ? "danger"
        : authCaptureState.status === "running"
          ? "running"
          : "neutral";

  return (
    <div className="grid min-h-[calc(100vh-var(--window-titlebar-height,0px))] grid-cols-[260px_minmax(0,1fr)] bg-background text-foreground">
      <aside className="border-r border-border/70 bg-muted/30 px-3 py-5">
        <div className="grid gap-5">
          <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground">
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Search settings...</span>
          </div>

          <nav className="grid gap-4" aria-label="Settings sections">
            <div className="grid gap-1">
              <div className="px-2 text-xs font-medium text-muted-foreground">Personal</div>
              {settingsSections.slice(0, 3).map((section) => {
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    type="button"
                    className={cn(
                      "flex h-9 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors",
                      activeSection === section.id && "bg-muted text-foreground",
                    )}
                    onClick={() => setActiveSection(section.id)}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{section.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-1">
              <div className="px-2 text-xs font-medium text-muted-foreground">Automation</div>
              {settingsSections.slice(3).map((section) => {
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    type="button"
                    className={cn(
                      "flex h-9 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors",
                      activeSection === section.id && "bg-muted text-foreground",
                    )}
                    onClick={() => setActiveSection(section.id)}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{section.label}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </div>
      </aside>

      <main className="min-w-0 overflow-auto px-10 py-10">
        <div className="mx-auto grid max-w-[920px] gap-9">
          <h1 className="text-xl font-semibold text-foreground">{activeSectionLabel}</h1>

          {activeSection === "general" ? (
            <div className="grid gap-8">
              <SettingsGroup title="General">
                <SettingsRow
                  title="Runtime bridge"
                  description={
                    runtimeState?.available
                      ? "Integrated runtime is connected."
                      : runtimeState?.error?.message || "Integrated runtime is not connected."
                  }
                  icon={PlugZap}
                  action={
                    <Badge variant={runtimeState?.available ? "success" : "danger"}>
                      {runtimeState?.available ? "ready" : "down"}
                    </Badge>
                  }
                />
              </SettingsGroup>
            </div>
          ) : null}

          {activeSection === "appearance" ? (
            <SettingsGroup title="Appearance">
              <SettingsRow
                title="Color theme"
                description="Choose the panel accent palette. Forest green is the default."
                icon={Palette}
                action={
                  <Select value={colorTheme || "forest"} onValueChange={onColorThemeChange}>
                    <SelectTrigger className="w-[170px]" aria-label="Panel color theme">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="forest">
                        <span className="flex items-center gap-2">
                          <span className="size-2.5 rounded-full bg-[#2d5a1b]" aria-hidden="true" />
                          Forest green
                        </span>
                      </SelectItem>
                      <SelectItem value="mulberry">
                        <span className="flex items-center gap-2">
                          <span className="size-2.5 rounded-full bg-[#6c355b]" aria-hidden="true" />
                          Mulberry
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              <Separator />
              <SettingsRow
                title="Appearance mode"
                description="Switch the panel between light and dark token sets."
                icon={MoonStar}
                action={
                  <div className="flex items-center gap-2">
                    <Badge variant="running">{theme}</Badge>
                    <Button variant="secondary" size="sm" onClick={onToggleTheme}>
                      Switch
                    </Button>
                  </div>
                }
              />
            </SettingsGroup>
          ) : null}

          {activeSection === "chrome" ? (
            <SettingsGroup title="Chrome instance">
              <SettingsRow
                title="Open on another display"
                description="Prefer the largest display that is not showing the Zhuzhu panel."
                icon={MonitorUp}
                action={
                  <Switch
                    checked={preferences.openChromeOnSecondaryDisplay}
                    disabled={savingPreference === "openChromeOnSecondaryDisplay"}
                    aria-label="Open Chrome on another display"
                    onCheckedChange={(checked) => updatePreference("openChromeOnSecondaryDisplay", checked)}
                  />
                }
              />
              <Separator />
              <SettingsRow
                title="Maximize by default"
                description="Use the native Chrome window maximize state after startup."
                icon={Maximize2}
                action={
                  <Switch
                    checked={preferences.maximizeChromeOnLaunch}
                    disabled={savingPreference === "maximizeChromeOnLaunch"}
                    aria-label="Maximize Chrome by default"
                    onCheckedChange={(checked) => updatePreference("maximizeChromeOnLaunch", checked)}
                  />
                }
              />
              <Separator />
              <SettingsRow
                title="Release when idle"
                description="Close the test browser after this long with no run or navigation, freeing the memory a heavy page keeps resident. It relaunches automatically on the next run — logins are handled per test case."
                icon={Clock}
                action={
                  <Select
                    value={String(preferences.browserIdleTimeoutMinutes)}
                    disabled={savingPreference === "browserIdleTimeoutMinutes"}
                    onValueChange={(value) =>
                      savePreferencePatch("browserIdleTimeoutMinutes", {
                        browserIdleTimeoutMinutes: Number(value),
                      })
                    }
                  >
                    <SelectTrigger className="w-[180px]" aria-label="Release the test browser when idle">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Never</SelectItem>
                      <SelectItem value="5">After 5 minutes</SelectItem>
                      <SelectItem value="10">After 10 minutes</SelectItem>
                      <SelectItem value="15">After 15 minutes</SelectItem>
                      <SelectItem value="30">After 30 minutes</SelectItem>
                      <SelectItem value="60">After 60 minutes</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              <Separator />
              <SettingsRow
                title="Proxy for the test browser"
                description="How the automated browser routes traffic. If a system proxy can't reach intranet sites (e.g. 502 on *.example.test while your normal browser works), choose Manual and add those hosts to the bypass list so they connect directly."
                icon={Network}
                action={
                  <Select
                    value={preferences.browserProxyMode}
                    disabled={savingPreference === "browserProxyMode"}
                    onValueChange={(value) => savePreferencePatch("browserProxyMode", { browserProxyMode: value })}
                  >
                    <SelectTrigger className="w-[180px]" aria-label="Proxy mode for the test browser">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">Follow system proxy</SelectItem>
                      <SelectItem value="manual">Manual proxy</SelectItem>
                      <SelectItem value="direct">Direct (ignore proxy)</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              {preferences.browserProxyMode === "manual" ? (
                <div className="grid gap-4 border-t border-border bg-muted/30 px-4 py-4">
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="browser-proxy-server">
                      Proxy server
                    </label>
                    <Input
                      id="browser-proxy-server"
                      value={proxyServerDraft}
                      placeholder="http://127.0.0.1:7897"
                      className="max-w-[420px] font-mono"
                      disabled={savingPreference === "browserProxyServer"}
                      onChange={(event) => setProxyServerDraft(event.target.value)}
                      onBlur={() => {
                        const next = proxyServerDraft.trim();
                        if (next !== preferences.browserProxyServer) {
                          savePreferencePatch("browserProxyServer", { browserProxyServer: next });
                        }
                      }}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="browser-proxy-bypass">
                      Bypass list (connect directly)
                    </label>
                    <Textarea
                      id="browser-proxy-bypass"
                      value={proxyBypassDraft}
                      placeholder="*.example.test, 192.168.*"
                      className="max-w-[420px] font-mono"
                      rows={2}
                      disabled={savingPreference === "browserProxyBypass"}
                      onChange={(event) => setProxyBypassDraft(event.target.value)}
                      onBlur={() => {
                        const next = proxyBypassDraft.trim();
                        if (next !== preferences.browserProxyBypass) {
                          savePreferencePatch("browserProxyBypass", { browserProxyBypass: next });
                        }
                      }}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      Comma-separated hosts/patterns that skip the proxy and connect directly. Saving relaunches the controlled browser to apply the change.
                    </p>
                  </div>
                </div>
              ) : null}
            </SettingsGroup>
          ) : null}

          {activeSection === "runtime" ? (
            <div className="grid gap-8">
              <SettingsGroup title="Runtime">
                <SettingsRow
                  title="Runtime bridge"
                  description={
                    runtimeState?.available
                      ? "Bridge connected and ready for payload execution."
                      : runtimeState?.error?.message || "Bridge not connected yet."
                  }
                  icon={PlugZap}
                  action={
                    <Badge variant={runtimeState?.available ? "success" : "danger"}>
                      {runtimeState?.available ? "ready" : "down"}
                    </Badge>
                  }
                />
              </SettingsGroup>
              <WorkspaceSettingsSection />
            </div>
          ) : null}

          {activeSection === "auth" ? (
            <div className="grid gap-4">
              <SettingsGroup title="Auth profile">
                <div className="flex min-h-[92px] items-start justify-between gap-5 px-4 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="grid min-w-0 flex-1 gap-3">
                      <div className="grid gap-1">
                        <div className="text-sm font-medium text-foreground">Session profile</div>
                        <div className="max-w-[620px] text-sm leading-5 text-muted-foreground">
                          {hasControlledBrowser
                            ? "Save the current controlled browser session for headless test sessions."
                            : "Open the controlled browser, log in, then save its session for headless runs."}
                        </div>
                        <div className="max-w-[620px] text-xs leading-5 text-muted-foreground">
                          何时使用：<strong>无头运行</strong>（提交测试会话 / 并行运行 / 自动续期）会复用这份登录态<strong>跳过登录步骤</strong>；
                          可视 App-run 走测试文件里的登录 setup 现场登录，不吃这份存档。它只对下方「覆盖域名/源」里的站点生效。
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={authProfile}
                          onChange={(event) => setAuthProfile(event.target.value)}
                          placeholder="demo-local"
                          aria-label="Auth profile"
                        />
                        {!hasControlledBrowser ? (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={handleOpenLoginPage}
                            disabled={isOpeningBrowser}
                          >
                            <ExternalLink data-icon="inline-start" />
                            Open login page
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          onClick={handleCaptureAuthProfile}
                          disabled={authCaptureState.status === "running" || !hasControlledBrowser}
                        >
                          <KeyRound data-icon="inline-start" />
                          Save current session
                        </Button>
                      </div>
                      {authCaptureState.message ? (
                        <div className="text-xs text-muted-foreground">
                          {authCaptureState.message}
                          {authCaptureState.path ? <span className="block truncate">{authCaptureState.path}</span> : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <Badge variant={authBadgeVariant}>
                    {authCaptureState.status === "passed"
                      ? "saved"
                      : authCaptureState.status === "failed"
                        ? "failed"
                        : authCaptureState.status === "running"
                          ? "working"
                          : hasControlledBrowser
                            ? "ready"
                            : "browser needed"}
                  </Badge>
                </div>
              </SettingsGroup>

              <SettingsGroup title="登录态健康度">
                <div className="flex items-start justify-between gap-5 px-4 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    {authFreshnessMeta.variant === "success" ? (
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <div className="grid min-w-0 flex-1 gap-2">
                      <div className="text-sm font-medium text-foreground">
                        当前 profile「{authRenewal?.profile || authProfile || "demo-local"}」的保存登录态
                      </div>
                      <div className="grid gap-1 text-xs text-muted-foreground">
                        <div>抓取时间：{formatAbsoluteTime(authStatus?.capturedAt)}</div>
                        <div>
                          最早 cookie 到期：{formatAbsoluteTime(authStatus?.earliestCookieExpiry)}
                          {authStatus?.earliestCookieExpiry
                            ? `（${formatRelativeFromNow(authStatus.earliestCookieExpiry)}）`
                            : ""}
                        </div>
                        <div className="break-all">
                          覆盖域名/源：
                          {authStatus?.domains?.length
                            ? authStatus.domains.join("、")
                            : "—（此登录态仅对这些站点生效，换域名/环境需重新保存）"}
                        </div>
                        <div>
                          上次续期：{formatAbsoluteTime(authRenewal?.lastRenewAt)}
                          {authRenewal?.lastRenewStatus
                            ? ` · ${authRenewal.lastRenewStatus === "passed" ? "成功" : "失败"}`
                            : ""}
                          {authRenewal?.lastRenewStatus === "failed" && authRenewal?.lastRenewError?.message
                            ? `（${authRenewal.lastRenewError.message}）`
                            : ""}
                        </div>
                        <div className="text-[11px]">
                          说明：cookie 到期为本地判断；服务端会话若提前失效，由续期时的登录后断言探测（失败会提醒）。
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={handleRenewNow}
                          disabled={renewState.status === "running" || authRenewal?.inFlight}
                        >
                          <RefreshCw data-icon="inline-start" />
                          立即刷新（无头重登）
                        </Button>
                        {renewState.message ? (
                          <span className="text-xs text-muted-foreground">{renewState.message}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <Badge variant={authFreshnessMeta.variant}>{authFreshnessMeta.label}</Badge>
                </div>
              </SettingsGroup>

              <SettingsGroup title="自动续期">
                <div className="flex items-start justify-between gap-5 px-4 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="grid min-w-0 flex-1 gap-3">
                      <div className="grid gap-1">
                        <div className="text-sm font-medium text-foreground">后台定时保鲜</div>
                        <div className="max-w-[620px] text-sm leading-5 text-muted-foreground">
                          开启后，猪猪每隔一段时间在后台无头重登一次，把新的登录态写回该 profile，避免"别人用时才发现过期"。登录工作流：
                          <code className="ml-1">{authRenewal?.loginTestFilePath || "common/auth-login-only.json"}</code>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="flex items-center gap-2 text-sm text-foreground">
                          <span>间隔（分钟）</span>
                          <Input
                            type="number"
                            min={5}
                            max={1440}
                            className="w-28"
                            defaultValue={authRenewal?.intervalMinutes ?? 120}
                            key={authRenewal?.intervalMinutes ?? 120}
                            onBlur={(event) => handleIntervalCommit(event.target.value)}
                            aria-label="续期间隔（分钟）"
                            disabled={!authRenewal?.enabled}
                          />
                        </label>
                        {authRenewal?.enabled ? (
                          <span className="text-xs text-muted-foreground">
                            下次续期：{formatAbsoluteTime(authRenewal?.nextRenewAt)}
                            {authRenewal?.nextRenewAt ? `（${formatRelativeFromNow(authRenewal.nextRenewAt)}）` : ""}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={Boolean(authRenewal?.enabled)}
                    onCheckedChange={handleToggleRenewal}
                    aria-label="开启自动续期"
                  />
                </div>
              </SettingsGroup>

              {!hasControlledBrowser ? (
                <Alert>
                  <AlertTitle>Controlled browser required</AlertTitle>
                  <AlertDescription>
                    Open the login page in Zhuzhu's controlled browser before saving an auth profile.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          {activeSection === "integrations" ? <IntegrationDocumentsSection /> : null}
        </div>
      </main>
    </div>
  );
}
