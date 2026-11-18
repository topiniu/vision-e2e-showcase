import { useEffect, useId, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Crosshair,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@panel/components/ui/alert";
import { Badge } from "@panel/components/ui/badge";
import { Button } from "@panel/components/ui/button";
import { Input } from "@panel/components/ui/input";
import { ScrollArea } from "@panel/components/ui/scroll-area";
import { Switch } from "@panel/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@panel/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@panel/components/ui/tooltip";
import { capturePageStructure } from "@panel/lib/panel-api";
import { cn } from "@panel/lib/cn";
import styles from "./PageStructureViewer.module.css";

const DEFAULT_FULL_EXPANDED_DEPTH = 2;
const DEFAULT_SMART_EXPANDED_DEPTH = 4;

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "details",
  "input",
  "label",
  "option",
  "select",
  "summary",
  "textarea",
]);

const SEMANTIC_TAGS = new Set([
  "article",
  "aside",
  "dialog",
  "footer",
  "form",
  "header",
  "main",
  "nav",
  "table",
]);

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getNodeLabel(node) {
  if (!node) {
    return "";
  }
  const attrs = node.attributes || {};
  const stable =
    attrs.testId ? `[data-testid="${attrs.testId}"]` :
      attrs.id ? `#${attrs.id}` :
        attrs.role ? `[role="${attrs.role}"]` :
          "";
  return `${node.tag || "node"}${stable ? ` ${stable}` : ""}`;
}

function getNodeText(node) {
  return trimText(node?.accessibleName) || trimText(node?.ownText) || trimText(node?.text);
}

function getNodeSearchText(node) {
  return trimText(node?.accessibleName) || trimText(node?.ownText);
}

function flattenNodes(root, output = [], depth = 0, parentIds = []) {
  if (!root) {
    return output;
  }
  output.push({
    node: root,
    depth,
    parentIds,
    label: getNodeLabel(root),
    text: getNodeText(root),
    searchText: getNodeSearchText(root),
  });
  (root.children || []).forEach((child) => flattenNodes(child, output, depth + 1, [...parentIds, root.id]));
  return output;
}

function isSmartNode(node, isRoot = false) {
  if (!node) {
    return false;
  }
  if (isRoot) {
    return true;
  }
  const attrs = node.attributes || {};
  return Boolean(
    attrs.testId ||
    attrs.id ||
    attrs.role ||
    attrs.ariaLabel ||
    attrs.placeholder ||
    attrs.name ||
    attrs.title ||
    trimText(node.ownText) ||
    INTERACTIVE_TAGS.has(node.tag) ||
    SEMANTIC_TAGS.has(node.tag),
  );
}

function buildViewBranches(node, mode, hideHidden, isRoot = false) {
  if (!node) {
    return [];
  }
  const children = (node.children || []).flatMap((child) => buildViewBranches(child, mode, hideHidden));
  if (hideHidden && !node.visible && !isRoot) {
    return children;
  }
  if (mode === "full" || isSmartNode(node, isRoot)) {
    return [{ node, children }];
  }
  return children;
}

function buildViewTree(root, mode, hideHidden = false) {
  return buildViewBranches(root, mode, hideHidden, true)[0] || null;
}

function flattenViewNodes(root, output = [], depth = 0, parentIds = []) {
  if (!root) {
    return output;
  }
  output.push({
    node: root.node,
    depth,
    parentIds,
    label: getNodeLabel(root.node),
    text: getNodeText(root.node),
    searchText: getNodeSearchText(root.node),
    childIds: root.children.map((child) => child.node.id),
  });
  root.children.forEach((child) => flattenViewNodes(child, output, depth + 1, [...parentIds, root.node.id]));
  return output;
}

function buildDefaultExpanded(root, maxDepth) {
  const expanded = new Set();
  const walk = (node, depth) => {
    if (!node || depth >= maxDepth) {
      return;
    }
    expanded.add(node.node.id);
    node.children.forEach((child) => walk(child, depth + 1));
  };
  walk(root, 0);
  return expanded;
}

function createTargetPatch(node) {
  const attrs = node?.attributes || {};
  const patch = {};
  if (attrs.testId) {
    patch.testId = attrs.testId;
    patch.targetStrategy = "testId";
  } else if (attrs.role) {
    patch.role = attrs.role;
    patch.targetStrategy = "role";
    const name = trimText(node.accessibleName) || trimText(node.ownText);
    if (name) {
      patch.targetName = name;
    }
  } else if (attrs.placeholder) {
    patch.placeholder = attrs.placeholder;
    patch.targetStrategy = "placeholder";
  } else if (attrs.ariaLabel) {
    patch.ariaLabel = attrs.ariaLabel;
    patch.targetStrategy = "ariaLabel";
  } else if (attrs.title) {
    patch.title = attrs.title;
    patch.targetStrategy = "title";
  } else if (node.selector) {
    patch.locator = node.selector;
    patch.targetStrategy = "css";
  }
  if (!patch.targetName && !patch.locator && !patch.testId) {
    const text = trimText(node.ownText) || trimText(node.accessibleName);
    if (text) {
      patch.targetName = text;
    }
  }
  return patch;
}

function createScopePatch(node) {
  const attrs = node?.attributes || {};
  if (attrs.testId) {
    return { testId: attrs.testId };
  }
  if (attrs.role) {
    return {
      role: attrs.role,
      ...(trimText(node.accessibleName) || trimText(node.ownText)
        ? { nearText: trimText(node.accessibleName) || trimText(node.ownText) }
        : {}),
    };
  }
  if (node?.selector) {
    return { locator: node.selector };
  }
  return {};
}

function nodeMatchesSearch(item, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const attrs = item.node.attributes || {};
  const haystack = [
    item.label,
    item.searchText,
    item.node.selector,
    attrs.id,
    attrs.className,
    attrs.testId,
    attrs.role,
    attrs.name,
    attrs.ariaLabel,
    attrs.title,
    attrs.placeholder,
  ].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes(normalizedQuery);
}

function getVisibleNodeIds(root, expanded) {
  const ids = new Set();
  const walk = (node) => {
    if (!node) {
      return;
    }
    ids.add(node.node.id);
    if (expanded.has(node.node.id)) {
      node.children.forEach(walk);
    }
  };
  walk(root);
  return ids;
}

function buildSearchVisibleIds(flatNodes, matchedIds) {
  const ids = new Set();
  flatNodes.forEach((item) => {
    if (!matchedIds.has(item.node.id)) {
      return;
    }
    ids.add(item.node.id);
    item.parentIds.forEach((parentId) => ids.add(parentId));
  });
  return ids;
}

function buildSearchExpandedIds(flatNodes, matchedIds) {
  const ids = new Set();
  flatNodes.forEach((item) => {
    if (matchedIds.has(item.node.id)) {
      item.parentIds.forEach((parentId) => ids.add(parentId));
    }
  });
  return ids;
}

function NodeRow({ item, selected, expanded, matched, onToggle, onSelect }) {
  const { node, depth, label } = item;
  const hasChildren = Boolean(item.childIds?.length);
  const handleRowClick = () => {
    onSelect(node.id);
    if (hasChildren) {
      onToggle(node.id);
    }
  };
  return (
    <div
      className={styles.nodeRow}
      data-selected={selected ? "true" : "false"}
      data-matched={matched ? "true" : "false"}
      style={{ "--depth": depth }}
    >
      <button
        type="button"
        className={styles.expandButton}
        onClick={(event) => {
          event.stopPropagation();
          handleRowClick();
        }}
        disabled={!hasChildren}
        aria-label={expanded ? "Collapse DOM node" : "Expand DOM node"}
      >
        {hasChildren ? expanded ? <ChevronDown /> : <ChevronRight /> : <span />}
      </button>
      <button type="button" className={styles.nodeButton} onClick={handleRowClick}>
        <span className={styles.nodeMain}>
          <strong>{label}</strong>
          <span className={styles.nodeVisibility} data-visible={node.visible ? "true" : "false"}>
            {node.visible ? "visible" : "hidden"}
          </span>
        </span>
      </button>
    </div>
  );
}

function DetailRow({ label, value }) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return (
    <div className={styles.detailRow}>
      <span>{label}</span>
      <strong title={String(value)}>{String(value)}</strong>
    </div>
  );
}

function NodeDetail({ node, onApplyTarget, onApplyScope }) {
  if (!node) {
    return (
      <Alert>
        <Search />
        <AlertTitle>No DOM node selected</AlertTitle>
        <AlertDescription>Select a node from the tree to inspect selector and target fields.</AlertDescription>
      </Alert>
    );
  }
  const attrs = node.attributes || {};
  const targetPatch = createTargetPatch(node);
  const scopePatch = createScopePatch(node);
  const canApplyTarget = typeof onApplyTarget === "function";
  const canApplyScope = typeof onApplyScope === "function";
  const hasTargetPatch = Object.keys(targetPatch).some((key) => targetPatch[key] !== "");
  const hasScopePatch = Object.keys(scopePatch).some((key) => scopePatch[key] !== "");
  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <div>
          <span>Selected node</span>
          <strong>{getNodeLabel(node)}</strong>
        </div>
        <Badge variant={node.visible ? "success" : "neutral"}>{node.visible ? "visible" : "hidden"}</Badge>
      </div>
      {canApplyTarget || canApplyScope ? (
        <div className={styles.detailActions}>
          {canApplyTarget ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => onApplyTarget(targetPatch)} disabled={!hasTargetPatch}>
              <Crosshair data-icon="inline-start" />
              Use as target
            </Button>
          ) : null}
          {canApplyScope ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onApplyScope(scopePatch)} disabled={!hasScopePatch}>
              <Check data-icon="inline-start" />
              Use as scope
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className={styles.detailGrid}>
        <DetailRow label="selector" value={node.selector} />
        <DetailRow label="testId" value={attrs.testId} />
        <DetailRow label="role" value={attrs.role} />
        <DetailRow label="name" value={attrs.name || node.accessibleName} />
        <DetailRow label="id" value={attrs.id} />
        <DetailRow label="class" value={attrs.className} />
        <DetailRow label="text" value={getNodeText(node)} />
        <DetailRow label="placeholder" value={attrs.placeholder} />
        <DetailRow label="title" value={attrs.title} />
        <DetailRow label="bounds" value={node.bounds ? `${node.bounds.x},${node.bounds.y} ${node.bounds.width}x${node.bounds.height}` : ""} />
      </div>
    </div>
  );
}

export function PageStructureViewer({
  className,
  onApplyTarget,
  onApplyScope,
}) {
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("smart");
  const [hideHidden, setHideHidden] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState("");
  const hiddenFilterId = useId();

  const flatNodes = useMemo(() => flattenNodes(snapshot?.root), [snapshot?.root]);
  const viewTree = useMemo(
    () => buildViewTree(snapshot?.root, viewMode, hideHidden),
    [hideHidden, snapshot?.root, viewMode],
  );
  const viewNodes = useMemo(() => flattenViewNodes(viewTree), [viewTree]);
  const nodeById = useMemo(() => new Map(flatNodes.map((item) => [item.node.id, item.node])), [flatNodes]);
  const visibleNodeIds = useMemo(() => getVisibleNodeIds(viewTree, expanded), [expanded, viewTree]);
  const normalizedQuery = query.trim();
  const matchedIds = useMemo(
    () => new Set(flatNodes
      .filter((item) => (!hideHidden || item.node.visible) && nodeMatchesSearch(item, normalizedQuery))
      .map((item) => item.node.id)),
    [flatNodes, hideHidden, normalizedQuery],
  );
  const searchVisibleIds = useMemo(
    () => (normalizedQuery ? buildSearchVisibleIds(flatNodes, matchedIds) : null),
    [flatNodes, matchedIds, normalizedQuery],
  );
  const visibleItems = useMemo(
    () => {
      if (searchVisibleIds) {
        return flatNodes.filter((item) => searchVisibleIds.has(item.node.id) && (!hideHidden || item.node.visible));
      }
      return viewNodes.filter((item) => visibleNodeIds.has(item.node.id));
    },
    [flatNodes, hideHidden, searchVisibleIds, viewNodes, visibleNodeIds],
  );
  const selectedNode = nodeById.get(selectedId) || snapshot?.root || null;

  const loadSnapshot = async () => {
    setStatus("loading");
    setError("");
    const result = await capturePageStructure({ maxDepth: 32, maxNodes: 10000 });
    if (!result?.success) {
      setStatus("error");
      setError(result?.error?.message || result?.message || result?.error || "Failed to read page structure.");
      return;
    }
    setSnapshot(result.data);
    const nextViewTree = buildViewTree(result.data?.root, viewMode, hideHidden);
    setExpanded(buildDefaultExpanded(
      nextViewTree,
      viewMode === "smart" ? DEFAULT_SMART_EXPANDED_DEPTH : DEFAULT_FULL_EXPANDED_DEPTH,
    ));
    setSelectedId(result.data?.root?.id || "");
    setStatus("ready");
  };

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    if (!normalizedQuery) {
      return;
    }
    const searchExpanded = buildSearchExpandedIds(flatNodes, matchedIds);
    if (searchExpanded.size) {
      setExpanded((current) => new Set([...current, ...searchExpanded]));
    }
    const firstMatch = flatNodes.find((item) => matchedIds.has(item.node.id));
    if (firstMatch && (!selectedId || !matchedIds.has(selectedId))) {
      setSelectedId(firstMatch.node.id);
    }
  }, [flatNodes, matchedIds, normalizedQuery, selectedId]);

  useEffect(() => {
    const currentSelection = nodeById.get(selectedId);
    if (!hideHidden || !currentSelection || currentSelection.visible) {
      return;
    }
    setSelectedId(viewNodes[0]?.node.id || snapshot?.root?.id || "");
  }, [hideHidden, nodeById, selectedId, snapshot?.root?.id, viewNodes]);

  const toggleNode = (nodeId) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const selectNode = (nodeId) => {
    const sourceItems = normalizedQuery ? flatNodes : viewNodes;
    const item = sourceItems.find((candidate) => candidate.node.id === nodeId);
    setSelectedId(nodeId);
    if (item?.parentIds?.length) {
      setExpanded((current) => new Set([...current, ...item.parentIds]));
    }
  };

  const changeViewMode = (nextMode) => {
    if (!nextMode || nextMode === viewMode) {
      return;
    }
    setViewMode(nextMode);
    const nextViewTree = buildViewTree(snapshot?.root, nextMode, hideHidden);
    setExpanded(buildDefaultExpanded(
      nextViewTree,
      nextMode === "smart" ? DEFAULT_SMART_EXPANDED_DEPTH : DEFAULT_FULL_EXPANDED_DEPTH,
    ));
  };

  return (
    <div className={cn(styles.viewer, className)}>
      <div className={styles.toolbar}>
        <ToggleGroup
          type="single"
          value={viewMode}
          onValueChange={changeViewMode}
          aria-label="Page structure detail level"
        >
          <ToggleGroupItem value="smart" size="sm">Smart</ToggleGroupItem>
          <ToggleGroupItem value="full" size="sm">Full DOM</ToggleGroupItem>
        </ToggleGroup>
        <label className={styles.hiddenFilter} htmlFor={hiddenFilterId}>
          <Switch
            id={hiddenFilterId}
            size="sm"
            checked={hideHidden}
            onCheckedChange={setHideHidden}
          />
          <span>Hide hidden</span>
        </label>
        <div className={styles.searchBox}>
          <Search aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search selector, testId, role, text"
            aria-label="Search page structure"
          />
        </div>
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="icon-sm" onClick={loadSnapshot} disabled={status === "loading"} aria-label="Refresh page structure">
                {status === "loading" ? <Loader2 className={styles.spin} /> : <RefreshCw />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh page structure</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {status === "error" ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Page structure unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {snapshot ? (
        <div className={styles.metaRow}>
          <span title={snapshot.url}>{snapshot.title || snapshot.url || "Untitled page"}</span>
          <div className={styles.metaBadges}>
            {normalizedQuery ? (
              <Badge variant={matchedIds.size ? "success" : "neutral"}>{matchedIds.size} matches</Badge>
            ) : null}
            {!normalizedQuery && viewMode === "smart" ? (
              <Badge variant="neutral">{viewNodes.length} relevant</Badge>
            ) : null}
            <Badge variant={snapshot.truncated ? "neutral" : "success"}>
              {snapshot.nodeCount || 0} nodes{snapshot.truncated ? " sampled" : ""}
            </Badge>
          </div>
        </div>
      ) : null}

      <div className={styles.contentGrid}>
        <ScrollArea className={styles.treeScroll}>
          <div className={styles.tree}>
            {status === "loading" && !snapshot ? (
              <div className={styles.loadingState}>
                <Loader2 className={styles.spin} />
                Reading current DOM...
              </div>
            ) : visibleItems.length ? (
              visibleItems.map((item) => (
                <NodeRow
                  key={item.node.id}
                  item={item}
                  selected={selectedNode?.id === item.node.id}
                  expanded={expanded.has(item.node.id)}
                  matched={normalizedQuery ? matchedIds.has(item.node.id) : false}
                  onToggle={toggleNode}
                  onSelect={selectNode}
                />
              ))
            ) : (
              <div className={styles.loadingState}>No matching DOM nodes.</div>
            )}
          </div>
        </ScrollArea>
        <ScrollArea className={styles.detailScroll}>
          <NodeDetail
            node={selectedNode}
            onApplyTarget={(patch) => onApplyTarget?.(patch, selectedNode)}
            onApplyScope={(patch) => onApplyScope?.(patch, selectedNode)}
          />
        </ScrollArea>
      </div>
    </div>
  );
}
