"use strict";


const { parseLayoutSpec } = require("../../src/shared/layout-assertion");

const SAMPLE_INTERVAL_MS = 150;
const MAX_REPORTED = 20;
const MAX_LAYOUT_ITEMS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs in the page. Plain function, no closures: Playwright serializes it.
function measureLayoutInPage(input) {
  const { containerSelector, items, truncationSelector, tolerancePx, noTruncation } = input;
  const container = containerSelector ? document.querySelector(containerSelector) : document.body;
  if (!container) {
    return { containerFound: false, items: [], truncated: [], container: null };
  }
  const isShown = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const labelOf = (el) => {
    const testId = el.getAttribute("data-testid");
    const text = (el.innerText || el.textContent || "").trim().split("\n")[0].slice(0, 24);
    return testId ? `${text || el.tagName.toLowerCase()} [${testId}]` : text || el.tagName.toLowerCase();
  };
  const seen = new Set();
  const elements = [];
  for (const entry of items) {
    const found = entry.scoped
      ? Array.from(container.querySelectorAll(entry.selector))
      : Array.from(document.querySelectorAll(entry.selector));
    for (const el of found) {
      if (!seen.has(el)) {
        seen.add(el);
        elements.push(el);
      }
    }
  }
  let hidden = 0;
  const boxes = [];
  const shownElements = elements.filter(isShown);
  // Bound the pairwise comparison and evidence size; a broad selector must not
  // turn a layout assertion into an unbounded full-page scan.
  if (shownElements.length > 500) {
    return { containerFound: true, items: [], truncated: [], tooManyItems: shownElements.length };
  }
  elements.forEach((el) => {
    if (!isShown(el)) {
      hidden += 1;
      return;
    }
    const rect = el.getBoundingClientRect();
    boxes.push({
      index: boxes.length,
      label: labelOf(el),
      x: Math.round(rect.left * 10) / 10,
      y: Math.round(rect.top * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      ancestors: shownElements.flatMap((other, index) => other !== el && other.contains(el) ? [index] : []),
    });
  });
  const truncationTargets = new Set();
  if (noTruncation && truncationSelector) {
    container.querySelectorAll(truncationSelector).forEach((el) => truncationTargets.add(el));
  } else if (noTruncation) {
    for (const el of shownElements) {
      truncationTargets.add(el);
      el.querySelectorAll("*").forEach((child) => {
        const ownText = Array.from(child.childNodes).some(
          (node) => node.nodeType === 3 && node.textContent.trim(),
        );
        if (ownText) {
          truncationTargets.add(child);
        }
      });
    }
  }
  const truncated = [];
  truncationTargets.forEach((el) => {
    if (!isShown(el) || el.clientWidth === 0) {
      return;
    }
    const style = window.getComputedStyle(el);
    const widthCut = el.scrollWidth > el.clientWidth + tolerancePx;
    const clipsY = ["hidden", "clip"].includes(style.overflowY) || style.webkitLineClamp !== "none";
    const heightCut = clipsY && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + tolerancePx;
    if (widthCut || heightCut) {
      truncated.push({
        label: labelOf(el),
        text: (el.innerText || el.textContent || "").trim().slice(0, 60),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        axis: widthCut ? "x" : "y",
        ellipsis: style.textOverflow === "ellipsis",
      });
    }
  });
  const crect = container.getBoundingClientRect();
  return {
    containerFound: true,
    container: { x: crect.left, y: crect.top, width: crect.width, height: crect.height },
    hidden,
    items: boxes,
    truncated,
    truncationTargetCount: [...truncationTargets].filter(isShown).length,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

function signature(sample) {
  return JSON.stringify([
    sample?.containerFound,
    (sample?.items || []).map((box) => [box.x, box.y, box.width, box.height]),
    (sample?.truncated || []).length,
  ]);
}

function findOverlaps(boxes, tolerancePx) {
  const overlaps = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ix <= tolerancePx || iy <= tolerancePx) {
        continue;
      }
      if (a.ancestors?.includes(j) || b.ancestors?.includes(i)) {
        continue;
      }
      overlaps.push({ a: a.label, b: b.label, intersection: { width: Math.round(ix * 10) / 10, height: Math.round(iy * 10) / 10 } });
    }
  }
  return overlaps;
}

function findOutside(boxes, container, tolerancePx) {
  if (!container) {
    return [];
  }
  return boxes
    .filter(
      (box) =>
        box.x < container.x - tolerancePx ||
        box.y < container.y - tolerancePx ||
        box.x + box.width > container.x + container.width + tolerancePx ||
        box.y + box.height > container.y + container.height + tolerancePx,
    )
    .map((box) => box.label);
}

async function sampleUntilStable(page, input, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let last = null;
  for (;;) {
    last = await page.evaluate(measureLayoutInPage, input);
    if (last.tooManyItems) return { sample: last, stable: false };
    const ready = last.containerFound && last.items.length > 0;
    if (ready && previous && signature(previous) === signature(last)) {
      return { sample: last, stable: true };
    }
    if (Date.now() >= deadline || signal?.aborted) {
      return { sample: last, stable: false };
    }
    previous = ready ? last : null;
    await sleep(SAMPLE_INTERVAL_MS);
  }
}

async function evaluateLayoutAssertion(raw = {}, context = {}) {
  const page = context.page;
  const { spec, errors } = parseLayoutSpec(raw);
  if (!spec) {
    return { ok: false, type: "assertLayout", error: "invalid-layout-assertion", detail: errors.join("; ") };
  }
  if (!page || typeof page.evaluate !== "function") {
    return { ok: false, type: "assertLayout", error: "layout-page-unavailable" };
  }
  const { sample, stable } = await sampleUntilStable(
    page,
    {
      containerSelector: spec.containerSelector,
      items: spec.items,
      truncationSelector: spec.truncationSelector,
      tolerancePx: spec.tolerancePx,
      noTruncation: spec.noTruncation,
    },
    spec.timeoutMs,
    context.signal || null,
  );
  const checks = [
    ...(spec.noOverlap ? ["no-overlap"] : []),
    ...(spec.noTruncation ? ["no-truncation"] : []),
    ...(spec.withinTarget ? ["within-target"] : []),
  ];
  const base = {
    type: "assertLayout",
    expected: checks.join(" + "),
    checks,
    target: spec.containerSelector,
    stable,
    viewport: sample.viewport || null,
    itemCount: sample.items.length,
    hiddenItems: sample.hidden || 0,
    items: sample.items.slice(0, 60),
  };
  if (!sample.containerFound) {
    return { ...base, ok: false, actual: "target not found", error: "layout-target-not-found", detail: spec.containerSelector };
  }
  if (sample.tooManyItems) {
    return { ...base, ok: false, error: "layout-too-many-items", actual: sample.tooManyItems,
      detail: `Narrow assertLayout.items to at most ${MAX_LAYOUT_ITEMS} visible elements.` };
  }
  if (spec.noTruncation && spec.truncationSelector && !sample.truncationTargetCount) {
    return { ...base, ok: false, error: "layout-truncation-target-missing", actual: "no visible text targets" };
  }
  if (sample.items.length < spec.minItems) {
    return {
      ...base,
      ok: false,
      actual: `${sample.items.length} visible item(s)`,
      error: "layout-items-missing",
      detail:
        `Found ${sample.items.length} visible element(s) for ${spec.items.map((item) => item.selector).join(", ")}, ` +
        `need at least ${spec.minItems}. A layout with nothing in it proves nothing.`,
    };
  }
  if (spec.expectCount != null && sample.items.length !== spec.expectCount) {
    return {
      ...base,
      ok: false,
      actual: `${sample.items.length} visible item(s)`,
      error: `assertLayout:item-count ${sample.items.length} != ${spec.expectCount}`,
    };
  }
  const overlaps = spec.noOverlap ? findOverlaps(sample.items, spec.tolerancePx) : [];
  const truncated = spec.noTruncation ? sample.truncated : [];
  const outside = spec.withinTarget ? findOutside(sample.items, sample.container, spec.tolerancePx) : [];
  const failures = [
    ...(overlaps.length ? [`${overlaps.length} overlapping pair(s)`] : []),
    ...(truncated.length ? [`${truncated.length} truncated element(s)`] : []),
    ...(outside.length ? [`${outside.length} item(s) outside the target`] : []),
  ];
  const outcome = {
    ...base,
    ok: failures.length === 0,
    actual: failures.length ? failures.join(", ") : `${sample.items.length} items, no violation`,
    overlaps: overlaps.slice(0, MAX_REPORTED),
    truncated: truncated.slice(0, MAX_REPORTED),
    outside: outside.slice(0, MAX_REPORTED),
  };
  if (!outcome.ok) {
    outcome.error = `assertLayout:${failures.join(", ")}`;
    outcome.detail = [
      ...overlaps.slice(0, 5).map((row) => `「${row.a}」与「${row.b}」相交 ${row.intersection.width}x${row.intersection.height}px`),
      ...truncated.slice(0, 5).map((row) => `「${row.text || row.label}」被截断（scroll${row.axis === "x" ? "Width" : "Height"} ${row.axis === "x" ? row.scrollWidth : row.scrollHeight} > client ${row.axis === "x" ? row.clientWidth : row.clientHeight}）`),
      ...outside.slice(0, 5).map((label) => `「${label}」超出容器`),
    ].join("；");
    if (!stable) {
      outcome.detail += "（注意：版式在超时前未稳定，按最后一次采样判定）";
    }
    // Evidence for the reader: what the region looked like when it failed.
    if (typeof context.saveVisualArtifact === "function" && typeof page.locator === "function") {
      try {
        const region = spec.containerSelector ? page.locator(spec.containerSelector).first() : page;
        const buffer = await region.screenshot({ timeout: 3000 });
        outcome.screenshotPath = await context.saveVisualArtifact(`layout/${Date.now()}-violation.png`, buffer);
      } catch (_error) {
        // evidence only
      }
    }
  }
  return outcome;
}

module.exports = {
  evaluateLayoutAssertion,
  findOverlaps,
  measureLayoutInPage,
};
