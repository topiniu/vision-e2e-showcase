const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 10000;
const DEFAULT_TEXT_LENGTH = 120;

function clampPositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.round(parsed), max);
}

function buildDomStructureScript(options = {}) {
  const maxDepth = clampPositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 64);
  const maxNodes = clampPositiveInteger(options.maxNodes, DEFAULT_MAX_NODES, 20000);
  const textLength = clampPositiveInteger(options.textLength, DEFAULT_TEXT_LENGTH, 260);

  return `(() => {
    const config = ${JSON.stringify({ maxDepth, maxNodes, textLength })};
    let nodeCount = 0;
    let truncated = false;

    const normalizeText = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const clipText = (value) => {
      const text = normalizeText(value);
      return text.length > config.textLength ? text.slice(0, config.textLength - 3) + "..." : text;
    };
    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(String(value));
      }
      return String(value).replace(/["\\\\]/g, "\\\\$&");
    };
    const attributeSelector = (name, value) => "[" + name + "=\\"" + cssEscape(value) + "\\"]";
    const getTestId = (element) =>
      element.getAttribute("data-testid") ||
      element.getAttribute("data-test-id") ||
      element.getAttribute("data-cy") ||
      "";
    const getOwnText = (element) =>
      Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ");
    const getAccessibleName = (element) =>
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("alt") ||
      element.getAttribute("value") ||
      "";
    const getTagSegment = (element) => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? "#" + cssEscape(element.id) : "";
      if (id) {
        return tag + id;
      }
      const testId = getTestId(element);
      if (testId) {
        return tag + attributeSelector("data-testid", testId);
      }
      const className = typeof element.className === "string" ? element.className : "";
      const classSegment = className
        .split(/\\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((item) => "." + cssEscape(item))
        .join("");
      return tag + classSegment;
    };
    const getSelector = (element) => {
      const testId = getTestId(element);
      if (testId) {
        return attributeSelector("data-testid", testId);
      }
      if (element.id) {
        return "#" + cssEscape(element.id);
      }
      const segments = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && segments.length < 5) {
        let segment = getTagSegment(current);
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
          if (siblings.length > 1 && !current.id && !getTestId(current)) {
            segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
          }
        }
        segments.unshift(segment);
        if (current.id || getTestId(current)) {
          break;
        }
        current = parent;
      }
      return segments.join(" > ");
    };
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const getBounds = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const collect = (element, depth) => {
      if (!element || nodeCount >= config.maxNodes) {
        truncated = true;
        return null;
      }
      nodeCount += 1;
      const nodeId = "dom-" + nodeCount;
      const testId = getTestId(element);
      const attributes = {
        id: element.id || "",
        className: typeof element.className === "string" ? element.className : "",
        role: element.getAttribute("role") || "",
        testId,
        name: element.getAttribute("name") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        title: element.getAttribute("title") || "",
        placeholder: element.getAttribute("placeholder") || "",
        type: element.getAttribute("type") || "",
        value: ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ? String(element.value || "") : "",
        disabled: element.disabled === true,
        checked: element.checked === true,
      };
      const children = [];
      if (depth < config.maxDepth) {
        for (const child of Array.from(element.children || [])) {
          if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(child.tagName)) {
            continue;
          }
          const childNode = collect(child, depth + 1);
          if (childNode) {
            children.push(childNode);
          }
          if (nodeCount >= config.maxNodes) {
            truncated = true;
            break;
          }
        }
      } else if ((element.children || []).length) {
        truncated = true;
      }
      return {
        id: nodeId,
        tag: element.tagName.toLowerCase(),
        selector: getSelector(element),
        attributes,
        role: attributes.role,
        testId,
        accessibleName: clipText(getAccessibleName(element)),
        ownText: clipText(getOwnText(element)),
        text: clipText(element.innerText || element.textContent || ""),
        visible: isVisible(element),
        bounds: getBounds(element),
        childCount: element.children?.length || 0,
        children,
      };
    };
    const rootElement = document.body || document.documentElement;
    const root = collect(rootElement, 0);
    return {
      url: window.location.href,
      title: document.title || "",
      capturedAt: Date.now(),
      nodeCount,
      truncated,
      root,
    };
  })()`;
}

async function capturePageStructure(browserAdapter, options = {}) {
  if (!browserAdapter?.isAvailable?.()) {
    return {
      success: false,
      error: {
        code: "browser-unavailable",
        message: "Open a controlled browser page before reading page structure.",
      },
    };
  }
  try {
    const data = await browserAdapter.evaluate(buildDomStructureScript(options));
    return {
      success: true,
      data,
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "page-structure-capture-failed",
        message: error?.message || String(error),
      },
    };
  }
}

module.exports = {
  buildDomStructureScript,
  capturePageStructure,
};
