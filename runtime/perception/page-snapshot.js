const { withProbeTimeout } = require("../executor/hard-timeout");

function clip(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

async function capturePageSnapshot(page, options = {}) {
  // REQ-Z12: both probes are hard-bounded. `page.screenshot` honours the
  // Playwright default timeout, but `capturePageState`'s `page.evaluate` does
  // not — a wedged renderer parked evidence capture forever.
  const screenshotBuffer = await withProbeTimeout(
    () =>
      page.screenshot({
        fullPage: Boolean(options.fullPage),
        type: "png",
        ...(options.clip ? { clip: options.clip } : {}),
      }),
    { label: "page.screenshot", timeoutMs: options.probeTimeoutMs },
  );

  const state = await capturePageState(page, options);

  return {
    ...state,
    screenshotBuffer,
    clip: options.clip
      ? {
          x: clip(options.clip.x),
          y: clip(options.clip.y),
          width: clip(options.clip.width),
          height: clip(options.clip.height),
        }
      : null,
  };
}

// v1.8 perf: how much page text is ever carried out of the renderer.
//
// Before, this probe returned `document.body.innerText` in full, on every step,
// before and after the action. On a real ERP list that is hundreds of KB per
// sample; measured on the heavy-page fixture at 20k nodes it was 52,820 chars
// per sample. Nothing consumed it — the only readers of the step result's
// `snapshot` are `url`/`title` (panel) and `interactables.length` (trace) — so
// it was pure weight in memory, in IPC and in report.json (49% of a 2.3MB
// report). It is now capped and marked when truncated, which keeps it useful
// for a human reading evidence without making it the dominant payload.
const PAGE_TEXT_LIMIT = Math.max(
  256,
  Number(process.env.ZHUZHU_PAGE_TEXT_LIMIT || 4000),
);

// Upper bound on how many interactables are described. Unchanged in value from
// the previous `.slice(0, 250)`; what changed is that the cap is now applied
// *while* collecting rather than after every candidate in the document has
// already been measured.
const INTERACTABLE_LIMIT = Math.max(
  10,
  Number(process.env.ZHUZHU_INTERACTABLE_LIMIT || 250),
);

// Below this many semantic (button/link/input/role) candidates, the probe falls
// back to scanning plain containers for pointer-ish affordances. Above it, that
// scan is skipped: it is the expensive half (a getComputedStyle for every div,
// span and li in the document) and it only ever mattered for pages that expose
// no real semantics.
const POINTER_SCAN_THRESHOLD = Math.max(
  0,
  Number(process.env.ZHUZHU_POINTER_SCAN_THRESHOLD || 20),
);

async function capturePageState(page, options = {}) {
  const limits = {
    textLimit: Number(options.textLimit) > 0 ? Number(options.textLimit) : PAGE_TEXT_LIMIT,
    interactableLimit:
      Number(options.interactableLimit) > 0 ? Number(options.interactableLimit) : INTERACTABLE_LIMIT,
    pointerScanThreshold:
      Number.isFinite(Number(options.pointerScanThreshold))
        ? Number(options.pointerScanThreshold)
        : POINTER_SCAN_THRESHOLD,
  };
  const dom = await withProbeTimeout(() => page.evaluate((budget) => {
    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      // Cheap geometric rejection before touching computed style: an element
      // with no box can never be visible, and getBoundingClientRect is far
      // cheaper than getComputedStyle on a warm layout.
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style) {
        return false;
      }
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) !== 0
      );
    };

    const pickText = (el) => {
      const values = [
        el.innerText,
        el.textContent,
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("placeholder"),
        el.getAttribute?.("name"),
        el.value,
      ];
      return values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .find(Boolean) || "";
    };

    const describe = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute("role") || null,
        text: pickText(el),
        name: el.getAttribute("name") || null,
        placeholder: el.getAttribute("placeholder") || null,
        type: el.getAttribute("type") || null,
        enabled:
          !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
        editable:
          el.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName),
        bbox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    };

    const interactables = [];
    const seen = new Set();
    // Semantic candidates first, and stop as soon as the budget is filled.
    // Previously the whole document was filtered and measured and only then
    // sliced to 250, so a page with 1000 buttons paid for 1000 descriptions.
    const semanticCandidates = document.querySelectorAll(
      "button, a, input, textarea, select, [role='button'], [role='link'], [role='tab'], [role='combobox'], [role='option'], [role='menuitem'], [contenteditable='true']",
    );
    let semanticSeen = 0;
    for (const el of semanticCandidates) {
      semanticSeen += 1;
      seen.add(el);
      if (interactables.length >= budget.interactableLimit) {
        continue;
      }
      if (isVisible(el)) {
        interactables.push(describe(el));
      }
    }

    // The pointer-affordance scan is the expensive path and is only worth
    // running when the page exposes almost no semantics of its own.
    let pointerScanned = false;
    if (interactables.length < budget.pointerScanThreshold) {
      pointerScanned = true;
      const pointerCandidates = document.querySelectorAll("body div, body span, body li");
      for (const el of pointerCandidates) {
        if (interactables.length >= budget.interactableLimit) {
          break;
        }
        if (seen.has(el)) {
          continue;
        }
        // Order matters: attribute checks are free, computed style is not.
        const cheapHit =
          typeof el.onclick === "function" ||
          el.hasAttribute("onclick") ||
          el.hasAttribute("tabindex");
        if (!cheapHit) {
          const style = window.getComputedStyle(el);
          if (style?.cursor !== "pointer") {
            continue;
          }
        }
        if (isVisible(el)) {
          interactables.push(describe(el));
        }
      }
    }

    const rawText = (document.body?.innerText || "").trim();
    const truncated = rawText.length > budget.textLimit;

    return {
      url: location.href,
      title: document.title,
      text: truncated ? rawText.slice(0, budget.textLimit) : rawText,
      textLength: rawText.length,
      textTruncated: truncated,
      interactables,
      interactableCandidates: semanticSeen,
      interactablesTruncated: interactables.length >= budget.interactableLimit,
      pointerScanned,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
  }, limits), { label: "capturePageState(page.evaluate)", timeoutMs: options.probeTimeoutMs });

  return {
    text: dom.text,
    textLength: dom.textLength ?? (dom.text || "").length,
    textTruncated: Boolean(dom.textTruncated),
    url: dom.url,
    title: dom.title,
    interactables: dom.interactables,
    interactablesTruncated: Boolean(dom.interactablesTruncated),
    pointerScanned: Boolean(dom.pointerScanned),
    viewport: dom.viewport,
    clip: null,
  };
}

module.exports = {
  capturePageState,
  capturePageSnapshot,
};
