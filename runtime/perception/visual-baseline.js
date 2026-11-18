"use strict";


const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const { computeImageDiff } = require("./image-diff");
const { withProbeTimeout } = require("../executor/hard-timeout");

function slugifyKey(value) {
  return String(value || "baseline")
    .trim()
    .replace(/[^A-Za-z0-9一-龥._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "baseline";
}

function baselineSlot({ key, viewport, devicePixelRatio }) {
  const width = Math.round(Number(viewport?.width) || 0);
  const height = Math.round(Number(viewport?.height) || 0);
  const dpr = Number(devicePixelRatio) || 1;
  return `${slugifyKey(key)}@${width}x${height}@${dpr}x`;
}

function baselinePaths({ root, profile, slot }) {
  const dir = path.join(root, slugifyKey(profile || "default"));
  return {
    dir,
    imagePath: path.join(dir, `${slot}.png`),
    metaPath: path.join(dir, `${slot}.json`),
  };
}

// --- element geometry / design tokens ---------------------------------------

// One page evaluation returns everything the visual layer needs: the element's
// box, the tokens we compare, and the accessibility facts that go in the LLM
// material. Batched into one round trip because a per-property probe on a wedged
// renderer is how the v1.3 freeze happened.
// NOTE: this is a real function, not a template string. Playwright treats a
// STRING `pageFunction` as an expression and silently ignores the `arg` — so a
// string version of this received `undefined` for `selectors` and returned
// undefined, which read downstream as "no elements found". Passing a function
// also gets it syntax-checked by node instead of failing at runtime.
function readVisualStateInPage(selectors) {
  const toNumber = (value) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
  };
  const relativeLuminance = (rgb) => {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  };
  const parseRgb = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(String(value || ""));
    if (!match) { return null; }
    const parts = match[1].split(",").map((item) => parseFloat(item.trim()));
    return parts.length >= 3 ? [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1] : null;
  };
  const describe = (selector) => {
    const element = document.querySelector(selector);
    if (!element) { return { selector, found: false }; }
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const color = parseRgb(style.color);
    const background = parseRgb(style.backgroundColor);
    // Walk up for an opaque background: an element with a transparent background
    // has the contrast of whatever is behind it, and reporting "contrast against
    // transparent" would be a made-up number.
    let backdrop = background;
    let cursor = element.parentElement;
    while (cursor && (!backdrop || backdrop[3] === 0)) {
      backdrop = parseRgb(window.getComputedStyle(cursor).backgroundColor);
      cursor = cursor.parentElement;
    }
    if (!backdrop || backdrop[3] === 0) { backdrop = [255, 255, 255, 1]; }
    const contrast = color && backdrop
      ? (() => {
          const a = relativeLuminance(color) + 0.05;
          const b = relativeLuminance(backdrop) + 0.05;
          return Math.round((Math.max(a, b) / Math.min(a, b)) * 100) / 100;
        })()
      : null;
    return {
      selector,
      found: true,
      box: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
      tokens: {
        fontSize: toNumber(style.fontSize),
        fontWeight: style.fontWeight,
        lineHeight: toNumber(style.lineHeight),
        letterSpacing: toNumber(style.letterSpacing),
        fontFamily: (style.fontFamily || "").split(",")[0].trim(),
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: toNumber(style.borderTopWidth),
        borderRadius: toNumber(style.borderTopLeftRadius),
        paddingTop: toNumber(style.paddingTop),
        paddingRight: toNumber(style.paddingRight),
        paddingBottom: toNumber(style.paddingBottom),
        paddingLeft: toNumber(style.paddingLeft),
        marginTop: toNumber(style.marginTop),
        marginBottom: toNumber(style.marginBottom),
        gap: toNumber(style.gap),
        textAlign: style.textAlign,
        display: style.display,
        boxShadow: style.boxShadow === "none" ? null : style.boxShadow,
      },
      accessibility: {
        contrastRatio: contrast,
        // 44x44 CSS px is the widely used minimum touch target; reported, not judged.
        hitTargetOk: rect.width >= 44 && rect.height >= 44,
        role: element.getAttribute("role") || null,
        ariaLabel: element.getAttribute("aria-label") || null,
        tabIndex: element.tabIndex,
        focusVisible: style.outlineStyle !== "none" || Boolean(style.boxShadow && style.boxShadow !== "none"),
      },
      // Truncation is a real, measurable defect class (it was one of the五轮返工).
      truncation: {
        textOverflow: style.textOverflow,
        overflowX: style.overflowX,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        clipped: element.scrollWidth > element.clientWidth + 1,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        clippedVertically: element.scrollHeight > element.clientHeight + 1,
      },
      text: (element.innerText || "").slice(0, 200),
    };
  };
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio || 1,
    // A theme change makes a pixel baseline meaningless; recorded so a mismatch
    // is reported as "different theme" instead of "0.4 diff ratio".
    theme:
      document.documentElement.getAttribute("data-theme") ||
      document.body?.getAttribute("data-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    elements: selectors.map(describe),
  };
}

function buildSelector(target = {}) {
  if (target.locator) {
    return target.locator;
  }
  if (target.testId) {
    const value = String(target.testId).replace(/"/g, '\\"');
    return `[data-testid="${value}"]`;
  }
  return null;
}

async function readVisualState(page, targets = []) {
  const selectors = targets.map(buildSelector).filter(Boolean);
  if (!page || typeof page.evaluate !== "function" || !selectors.length) {
    return { viewport: null, devicePixelRatio: 1, theme: null, elements: [] };
  }
  return withProbeTimeout(() => page.evaluate(readVisualStateInPage, selectors), {
    label: "visual:readState",
  });
}

// --- masking -----------------------------------------------------------------

// Mask regions are painted flat in BOTH images before diffing (facet E-4: a
// change inside a masked area must not turn the case red). Painting rather than
// cropping keeps the geometry identical, so the diff coordinates still line up
// with what a reader sees in the screenshot.
async function paintMasks(buffer, masks = []) {
  if (!masks.length) {
    return buffer;
  }
  const { PNG } = require("pngjs");
  const png = PNG.sync.read(buffer);
  for (const mask of masks) {
    const x0 = Math.max(0, Math.floor(mask.x || 0));
    const y0 = Math.max(0, Math.floor(mask.y || 0));
    const x1 = Math.min(png.width, x0 + Math.floor(mask.width || 0));
    const y1 = Math.min(png.height, y0 + Math.floor(mask.height || 0));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = (y * png.width + x) * 4;
        png.data[index] = 255;
        png.data[index + 1] = 0;
        png.data[index + 2] = 255;
        png.data[index + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

// Mask rectangles are authored as targets; resolve them to element boxes that are
// relative to the captured element (not to the viewport).
function resolveMaskBoxes(maskElements = [], anchorBox = null) {
  return maskElements
    .filter((item) => item?.found && item.box)
    .map((item) => ({
      x: anchorBox ? item.box.x - anchorBox.x : item.box.x,
      y: anchorBox ? item.box.y - anchorBox.y : item.box.y,
      width: item.box.width,
      height: item.box.height,
      selector: item.selector,
    }));
}

// --- peer (同族) comparison ---------------------------------------------------

// Which tokens are compared, and how a difference is described. This is the
// "和隔壁不一致" list from the roadmap, made concrete.
const PEER_TOKENS = [
  { key: "fontSize", label: "字号", numeric: true, tolerance: 0.5 },
  { key: "lineHeight", label: "行高", numeric: true, tolerance: 1 },
  { key: "fontWeight", label: "字重", numeric: false },
  { key: "fontFamily", label: "字体", numeric: false },
  { key: "letterSpacing", label: "字间距", numeric: true, tolerance: 0.2 },
  { key: "paddingTop", label: "内边距(上)", numeric: true, tolerance: 1 },
  { key: "paddingRight", label: "内边距(右)", numeric: true, tolerance: 1 },
  { key: "paddingBottom", label: "内边距(下)", numeric: true, tolerance: 1 },
  { key: "paddingLeft", label: "内边距(左)", numeric: true, tolerance: 1 },
  { key: "gap", label: "间距", numeric: true, tolerance: 1 },
  { key: "borderRadius", label: "圆角", numeric: true, tolerance: 1 },
  { key: "borderColor", label: "边框色", numeric: false },
  { key: "borderWidth", label: "边框宽", numeric: true, tolerance: 0.5 },
  { key: "color", label: "主色", numeric: false },
  { key: "backgroundColor", label: "背景色", numeric: false },
  { key: "textAlign", label: "对齐", numeric: false },
];

function comparePeerTokens(subject, peers = []) {
  const rows = [];
  for (const token of PEER_TOKENS) {
    const subjectValue = subject?.tokens?.[token.key] ?? null;
    const peerValues = peers.map((peer) => ({
      selector: peer.selector,
      value: peer.tokens?.[token.key] ?? null,
    }));
    const differing = peerValues.filter((peer) => {
      if (peer.value == null || subjectValue == null) {
        return false;
      }
      if (token.numeric) {
        return Math.abs(Number(peer.value) - Number(subjectValue)) > (token.tolerance ?? 0);
      }
      return String(peer.value) !== String(subjectValue);
    });
    if (!differing.length) {
      continue;
    }
    rows.push({
      token: token.key,
      label: token.label,
      subject: subjectValue,
      peers: peerValues,
      differsFrom: differing.map((peer) => peer.selector),
      // Human-readable, because this table's job is to be pasted into a review:
      // "字号 12 vs 14" is the sentence the roadmap asks for.
      summary: `${token.label} ${subjectValue} vs ${differing.map((peer) => peer.value).join(" / ")}`,
    });
  }
  return rows;
}

// --- the assertVisual evaluator ---------------------------------------------

async function evaluateVisualAssertion(spec = {}, context = {}) {
  const page = context.page;
  const target = spec.target || {};
  const selector = buildSelector(target);
  const baselineRoot = context.visualBaselineRoot;
  const profile = spec.profile || context.visualProfile || "default";
  const key = spec.baseline || spec.key || target.testId || "baseline";
  const onMissingBaseline = String(spec.expectation?.onMissingBaseline || spec.onMissingBaseline || "record");
  const maxDiffRatio = Number(spec.expectation?.maxDiffRatio ?? spec.maxDiffRatio ?? 0.02);

  if (!page || typeof page.screenshot !== "function") {
    return {
      ok: false,
      type: "assertVisual",
      error: "visual-capture-unavailable",
      detail: "No page is available to capture, so the visual assertion could not be evaluated (fail-closed).",
    };
  }
  if (!selector) {
    return {
      ok: false,
      type: "assertVisual",
      error: "visual-target-missing",
      detail: "assertVisual requires target.testId or target.locator.",
    };
  }
  if (!baselineRoot) {
    return {
      ok: false,
      type: "assertVisual",
      error: "visual-baseline-root-unavailable",
      detail:
        "No baseline directory is configured for this run, so nothing could be compared or recorded (fail-closed).",
    };
  }

  const maskTargets = Array.isArray(spec.mask) ? spec.mask : [];
  const state = await readVisualState(page, [target, ...maskTargets]);
  const element = state.elements.find((item) => item.selector === selector);
  if (!element?.found) {
    return {
      ok: false,
      type: "assertVisual",
      error: "visual-target-not-found",
      detail: `${selector} was not found on the page.`,
    };
  }

  const slot = baselineSlot({ key, viewport: state.viewport, devicePixelRatio: state.devicePixelRatio });
  const { dir, imagePath, metaPath } = baselinePaths({ root: baselineRoot, profile, slot });
  const masks = resolveMaskBoxes(
    state.elements.filter((item) => item.selector !== selector),
    element.box,
  );

  let shot;
  try {
    const locator = page.locator(selector).first();
    shot = await withProbeTimeout(() => locator.screenshot({ type: "png" }), { label: "visual:screenshot" });
  } catch (error) {
    return {
      ok: false,
      type: "assertVisual",
      error: "visual-screenshot-failed",
      detail: error?.message || String(error),
    };
  }
  const masked = await paintMasks(shot, masks);
  const meta = {
    key,
    slot,
    profile,
    viewport: state.viewport,
    devicePixelRatio: state.devicePixelRatio,
    theme: state.theme,
    masks,
    box: element.box,
    capturedAt: Date.now(),
  };

  if (!fsSync.existsSync(imagePath)) {
    if (onMissingBaseline === "record") {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(imagePath, masked);
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    }
    // E-1: recorded, and reported as `no-baseline` — NOT as a pass. A tool that
    // silently accepts its first observation is a tool where a broken layout
    // quietly becomes the reference.
    return {
      ok: false,
      type: "assertVisual",
      noBaseline: true,
      error: "visual-no-baseline",
      baseline: { slot, imagePath: onMissingBaseline === "record" ? imagePath : null, recorded: onMissingBaseline === "record" },
      meta,
      // Reported in BOTH branches: a caller must not have to know which path was
      // taken to find out what was masked.
      masks,
      tokens: element.tokens,
      truncation: element.truncation,
      accessibility: element.accessibility,
      detail:
        onMissingBaseline === "record"
          ? `没有基线可比。已记录基线到 ${imagePath}（按 viewport ${meta.viewport?.width}x${meta.viewport?.height} @${meta.devicePixelRatio}x 分槽），` +
            "**先确认这张图本身是对的**，然后重跑即可进入比对。第一次运行不会假装通过。"
          : `没有基线可比，且 onMissingBaseline="fail"，因此判失败（槽位 ${slot}）。`,
    };
  }

  let baselineMeta = null;
  try {
    baselineMeta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch (_error) {
    baselineMeta = null;
  }
  // A theme change makes the pixel comparison meaningless; say that instead of
  // reporting a huge diff ratio the reader would have to decode.
  if (baselineMeta?.theme && state.theme && baselineMeta.theme !== state.theme) {
    return {
      ok: false,
      type: "assertVisual",
      error: "visual-theme-mismatch",
      baseline: { slot, imagePath, theme: baselineMeta.theme },
      actual: { theme: state.theme },
      detail:
        `基线是在 ${baselineMeta.theme} 主题下录的，本次是 ${state.theme}。像素比对在跨主题时没有意义——` +
        "请为该主题录一份自己的基线（基线按 viewport/DPR 分槽，主题需要显式区分）。",
    };
  }

  const baselineBuffer = await fs.readFile(imagePath);
  const diff = computeImageDiff(baselineBuffer, masked, { threshold: maxDiffRatio, pixelThreshold: 0.1 });
  const actualPath = context.saveVisualArtifact
    ? await context.saveVisualArtifact(`visual/${slot}-actual.png`, masked)
    : null;

  const outcome = {
    ok: diff.ratio <= maxDiffRatio,
    type: "assertVisual",
    baseline: { slot, imagePath, theme: baselineMeta?.theme ?? null },
    actual: { path: actualPath, theme: state.theme, box: element.box },
    diff: {
      ratio: Number(diff.ratio.toFixed(5)),
      diffPixels: diff.diffPixels,
      maxDiffRatio,
      // Reused from the existing image-diff: WHERE the difference is, which is
      // the difference between an actionable finding and "it looks different".
      bounds: diff.bounds,
      sizeChanged: diff.width !== undefined && baselineMeta?.box
        ? diff.width !== baselineMeta.box.width || diff.height !== baselineMeta.box.height
        : null,
    },
    tokens: element.tokens,
    truncation: element.truncation,
    accessibility: element.accessibility,
    masks,
    ...(diff.ratio > maxDiffRatio
      ? {
          error: `assertVisual:diff-ratio ${diff.ratio.toFixed(4)} > ${maxDiffRatio}`,
          detail:
            `与基线的差异集中在 ${diff.bounds ? `x=${diff.bounds.x},y=${diff.bounds.y},${diff.bounds.width}x${diff.bounds.height}` : "整块区域"}。` +
            "本条只回答「和基线不一样了」，不回答「好不好看」——观感判断请看 visual-review.json 的素材包。",
        }
      : {}),
  };
  if (typeof context.collectVisualReview === "function") {
    context.collectVisualReview({
      kind: "baseline",
      key,
      slot,
      selector,
      box: element.box,
      tokens: element.tokens,
      truncation: element.truncation,
      accessibility: element.accessibility,
      theme: state.theme,
      viewport: state.viewport,
      devicePixelRatio: state.devicePixelRatio,
      diff: outcome.diff,
      baselineImagePath: imagePath,
      actualImagePath: actualPath,
      masks,
    });
  }
  return outcome;
}

// --- the assertVisualPeers evaluator ----------------------------------------

async function evaluatePeerAssertion(spec = {}, context = {}) {
  const page = context.page;
  const target = spec.target || {};
  const peers = Array.isArray(spec.peers) ? spec.peers : [];
  const selector = buildSelector(target);
  if (!selector || !peers.length) {
    return {
      ok: false,
      type: "assertVisualPeers",
      error: "visual-peers-missing",
      detail: "assertVisualPeers requires `target` and a non-empty `peers` array (the modules it should look like).",
    };
  }
  const state = await readVisualState(page, [target, ...peers]);
  const subject = state.elements.find((item) => item.selector === selector);
  if (!subject?.found) {
    return { ok: false, type: "assertVisualPeers", error: "visual-target-not-found", detail: selector };
  }
  const peerStates = state.elements.filter((item) => item.selector !== selector);
  const missingPeers = peerStates.filter((item) => !item.found).map((item) => item.selector);
  const rows = comparePeerTokens(subject, peerStates.filter((item) => item.found));

  // `mustMatch` is the only way this assertion fails. Without it the peer table is
  // *material*, not a verdict — because "differs from the module next door" is
  // sometimes correct and deciding that is a human's job (roadmap §8: 猪猪 only
  // reports quantified differences; the aesthetic conclusion stays with people).
  const mustMatch = Array.isArray(spec.mustMatch) ? spec.mustMatch : [];
  const violations = rows.filter((row) => mustMatch.includes(row.token));
  if (typeof context.collectVisualReview === "function") {
    context.collectVisualReview({
      kind: "peers",
      selector,
      box: subject.box,
      tokens: subject.tokens,
      truncation: subject.truncation,
      accessibility: subject.accessibility,
      theme: state.theme,
      viewport: state.viewport,
      peers: peerStates.map((item) => ({ selector: item.selector, found: item.found, tokens: item.tokens ?? null })),
      differences: rows,
    });
  }
  return {
    ok: violations.length === 0 && !missingPeers.length,
    type: "assertVisualPeers",
    subject: { selector, tokens: subject.tokens, box: subject.box },
    peers: peerStates.map((item) => ({ selector: item.selector, found: item.found, tokens: item.tokens ?? null })),
    differences: rows,
    mustMatch,
    ...(missingPeers.length
      ? {
          error: `visual-peers-not-found: ${missingPeers.join(", ")}`,
          detail: "声明的同族模块没找到，无法比对——这不是「一致」，是没测到。",
        }
      : {}),
    ...(violations.length
      ? {
          error: `assertVisualPeers:${violations.map((row) => row.token).join(",")}`,
          detail: `与同族模块不一致：${violations.map((row) => row.summary).join("；")}`,
        }
      : {}),
  };
}

// --- LLM material ------------------------------------------------------------

// `visual-review.json`: screenshots + box models + token metrics + peer diffs +
// accessibility facts. Zhuzhu produces material and quantified differences and
// **no aesthetic conclusion** — that split is the reason this can be trusted.
function buildVisualReview(entries = []) {
  if (!entries.length) {
    return null;
  }
  return {
    reviewVersion: 1,
    generatedAt: Date.now(),
    note:
      "这是给人/LLM 判观感用的素材：截图、盒模型、设计 token、同族差异、无障碍要点。" +
      "猪猪只出素材与量化差异，不出审美结论——「和隔壁不一致」是可测的，「好不好看」不是。",
    items: entries,
  };
}

module.exports = {
  PEER_TOKENS,
  readVisualStateInPage,
  baselinePaths,
  baselineSlot,
  buildSelector,
  buildVisualReview,
  comparePeerTokens,
  evaluatePeerAssertion,
  evaluateVisualAssertion,
  paintMasks,
  readVisualState,
  resolveMaskBoxes,
  slugifyKey,
};
