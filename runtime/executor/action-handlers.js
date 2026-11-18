const path = require('node:path');
const fs = require('node:fs/promises');
const { assertResponseShape } = require('../assertions');
const { redactHeaders } = require('./result-shaping');

function normalizeRuntimeText(value) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\s_-]+/g, "")
    : "";
}

function inferFillIntent(action) {
  if (action?.kind !== "fill") {
    return null;
  }
  const query = normalizeRuntimeText(
    action.query ||
      action.target?.name ||
      action.target?.text ||
      action.target?.query ||
      action.target?.placeholder ||
      "",
  );
  if (!query) {
    return null;
  }
  const usernameHints = ["账号", "账户", "用户名", "username", "account", "loginid", "loginname", "login"];
  const passwordHints = ["密码", "登录密码", "登陆密码", "password", "passwd", "pwd"];
  if (usernameHints.some((item) => query.includes(normalizeRuntimeText(item)))) {
    return "username";
  }
  if (passwordHints.some((item) => query.includes(normalizeRuntimeText(item)))) {
    return "password";
  }
  return null;
}

function buildRequestUrl(page, request = {}) {
  const rawUrl = request.url || "";
  const baseUrl = page.url?.() || "http://127.0.0.1/";
  const url = new URL(rawUrl, baseUrl);
  Object.entries(request.query || {}).forEach(([key, value]) => {
    if (value == null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
    } else {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function hasAuthHeader(headers = {}) {
  return Object.keys(headers || {}).some((key) =>
    /^(authorization|token|x-token|x-auth-token)$/i.test(key),
  );
}

function formatAuthHeaderValue(token, authConfig = {}) {
  const value = String(token || "").trim();
  if (!value) {
    return "";
  }
  const scheme = typeof authConfig.scheme === "string" ? authConfig.scheme.trim() : "";
  return scheme ? `${scheme} ${value}` : value;
}

async function readLocalStorageToken(page, request = {}) {
  const authConfig = request.auth && typeof request.auth === "object" && !Array.isArray(request.auth)
    ? request.auth
    : {};
  const preferredKey = String(
    request.authStorageKey ||
      request.localStorageKey ||
      authConfig.localStorageKey ||
      "_TOKEN_",
  ).trim();
  const fallbackKeys = [
    preferredKey,
    "_TOKEN_",
    "TOKEN",
    "token",
    "authToken",
    "accessToken",
  ].filter((item, index, items) => item && items.indexOf(item) === index);
  try {
    return await page.evaluate((keys) => {
      for (const key of keys) {
        const value = window.localStorage.getItem(key);
        if (value && String(value).trim()) {
          return { key, value: String(value).trim() };
        }
      }
      return null;
    }, fallbackKeys);
  } catch (_error) {
    return null;
  }
}

async function buildRequestHeaders(page, request = {}) {
  const headers = {
    ...(request.headers || {}),
  };
  if (request.autoAuth === false || hasAuthHeader(headers)) {
    return { headers, auth: null };
  }
  const token = await readLocalStorageToken(page, request);
  if (!token?.value) {
    return { headers, auth: null };
  }
  const authConfig = request.auth && typeof request.auth === "object" && !Array.isArray(request.auth)
    ? request.auth
    : {};
  const headerName = String(
    request.authHeader ||
      request.authHeaderName ||
      authConfig.header ||
      "token",
  ).trim() || "token";
  headers[headerName] = formatAuthHeaderValue(token.value, authConfig);
  return {
    headers,
    auth: {
      source: "localStorage",
      key: token.key,
      header: headerName,
    },
  };
}

async function summarizeApiResponse(response, requestMeta = {}) {
  const headers = typeof response.headers === "function"
    ? await response.headers()
    : response.headers?.() || response.headers || {};
  const text = typeof response.text === "function" ? await response.text() : "";
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    body = text;
  }
  return {
    url: typeof response.url === "function" ? response.url() : response.url || requestMeta.url,
    method: requestMeta.method || "",
    status: typeof response.status === "function" ? response.status() : response.status,
    headers,
    body,
    bodyText: typeof body === "string" ? body : text,
  };
}

async function runCallApiAction(page, action) {
  const request = action.request || {};
  if (!request.url) {
    return {
      success: false,
      error: "api-url-required",
    };
  }
  const method = (request.method || "GET").toUpperCase();
  const url = buildRequestUrl(page, request);
  const requestHeaders = await buildRequestHeaders(page, request);
  const options = {
    method,
    headers: requestHeaders.headers,
  };
  if (request.body != null && method !== "GET" && method !== "HEAD") {
    if (typeof request.body === "string") {
      options.data = request.body;
    } else {
      options.data = request.body;
      options.headers = {
        "content-type": "application/json",
        ...options.headers,
      };
    }
  }
  const response = await page.context().request.fetch(url, options);
  const summary = await summarizeApiResponse(response, { method, url });
  return {
    success: true,
    detail: "api-response",
    apiResponse: summary,
    requestTrace: {
      method,
      url,
      headers: redactHeaders(options.headers),
      auth: requestHeaders.auth,
      hasBody: request.body != null,
    },
  };
}

function getAssertVisibleTexts(action) {
  if (action.kind !== "assertVisible") {
    return [];
  }
  const target = action.target || {};
  return [action.query, target.text, target.query]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

async function resolveEditableFromOcrAnchor(page, anchorBox, action = null) {
  if (!page || !anchorBox) {
    return null;
  }

  const candidate = await page.evaluate(({ bbox, intent }) => {
    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style) {
        return false;
      }
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const controls = Array.from(
      document.querySelectorAll("input, textarea, select, [contenteditable='true']"),
    )
      .filter((el) => isVisible(el))
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const inputType = String(el.getAttribute("type") || "").toLowerCase();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const anchorCenterX = bbox.x + bbox.width / 2;
        const anchorCenterY = bbox.y + bbox.height / 2;
        const horizontalDistance = Math.abs(centerX - anchorCenterX);
        const verticalDistance = Math.abs(centerY - anchorCenterY);
        const isBelow = rect.top >= bbox.y - 24;
        const isRightSide = rect.left >= bbox.x - 80;
        const overlapsX =
          rect.left <= bbox.x + bbox.width + 180 &&
          rect.right >= bbox.x - 32;
        const intentPenalty =
          intent === "username" && inputType === "password"
            ? 1000
            : intent === "password" && inputType === "password"
              ? -200
              : intent === "password"
                ? 240
                : 0;
        const score =
          horizontalDistance * 0.7 +
          verticalDistance +
          (isBelow ? 0 : 120) +
          (isRightSide ? 0 : 60) +
          (overlapsX ? 0 : 80) +
          intentPenalty;
        return {
          index,
          score,
          bbox: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .sort((a, b) => a.score - b.score);

    return controls[0] || null;
  }, { bbox: anchorBox, intent: inferFillIntent(action) });

  if (!candidate || !Number.isInteger(candidate.index)) {
    return null;
  }

  return {
    locator: page
      .locator("input:visible, textarea:visible, select:visible, [contenteditable='true']:visible")
      .nth(candidate.index),
    bbox: candidate.bbox ?? null,
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCssString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveUploadFilePaths(action) {
  const projectRoot = process.cwd();
  const files = [];
  for (const file of action.files || []) {
    const relativePath = file.path;
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
      return { success: false, error: "file-not-allowed", files: [] };
    }
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        return { success: false, error: "file-not-found", files: [] };
      }
      files.push({
        ...file,
        path: relativePath,
        absolutePath,
        size: stat.size,
      });
    } catch (_error) {
      return { success: false, error: "file-not-found", files: [] };
    }
  }
  return { success: true, files };
}

async function resolveFileInputLocator(page, resolution, options = {}) {
  const allowPageFallback = options.allowPageFallback !== false;
  const locator = resolution?.locator || null;
  if (locator) {
    const isInput = await locator
      .evaluate((el) => el.matches?.("input[type='file']") === true)
      .catch(() => false);
    if (isInput) {
      return locator;
    }
    const nested = locator.locator("input[type='file']").first();
    if ((await nested.count().catch(() => 0)) > 0) {
      return nested;
    }
  }
  if (!allowPageFallback) {
    return null;
  }
  const pageInput = page.locator("input[type='file']").first();
  if ((await pageInput.count().catch(() => 0)) === 1) {
    return pageInput;
  }
  return null;
}

async function runUploadFileAction(page, action, resolution) {
  const prepared = await resolveUploadFilePaths(action);
  if (!prepared.success) {
    return { success: false, error: prepared.error, inputArtifacts: { files: action.files || [] } };
  }
  const absolutePaths = prepared.files.map((file) => file.absolutePath);
  const shouldUseInput =
    action.mode === "input" ||
    resolution?.strategy?.startsWith("dom:file-input") === true;
  const input = shouldUseInput
    ? await resolveFileInputLocator(page, resolution, {
        allowPageFallback: action.mode === "input",
      })
    : null;
  if (input) {
    await input.setInputFiles(absolutePaths, { timeout: action.timeoutMs });
    return {
      success: true,
      detail: "upload-input",
      inputArtifacts: {
        mode: "input",
        files: prepared.files.map(({ absolutePath: _absolutePath, ...file }) => file),
      },
    };
  }
  if (!resolution?.locator) {
    return { success: false, error: "action-target-unresolved" };
  }
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: action.timeoutMs }),
      resolution.locator.click({ timeout: action.timeoutMs }),
    ]);
    await chooser.setFiles(absolutePaths);
    return {
      success: true,
      detail: "upload-chooser",
      inputArtifacts: {
        mode: "chooser",
        files: prepared.files.map(({ absolutePath: _absolutePath, ...file }) => file),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message?.includes("Timeout") ? "upload-timeout" : "upload-failed",
      inputArtifacts: {
        mode: "chooser",
        files: prepared.files.map(({ absolutePath: _absolutePath, ...file }) => file),
      },
    };
  }
}

function buildOptionCandidateLocators(root, text, exact, pattern) {
  const escapedText = escapeCssString(text);
  const roleLocator =
    typeof root.getByRole === "function"
      ? root.getByRole("option", { name: text, exact })
      : root.locator(`[role='option']`).filter({ hasText: pattern });
  return [
    roleLocator,
    root
      .locator(
        `.ant-select-dropdown:not(.ant-select-dropdown-hidden) [title="${escapedText}"], .ant-select-dropdown:not(.ant-select-dropdown-hidden) [data-value="${escapedText}"], .ant-select-dropdown:not(.ant-select-dropdown-hidden) [aria-label="${escapedText}"], [title="${escapedText}"], [data-value="${escapedText}"], [aria-label="${escapedText}"]`,
      )
      .filter({ hasText: pattern }),
    root
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) [role='option'], [role='option']")
      .filter({ hasText: pattern }),
    root
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-item-option")
      .filter({ hasText: pattern }),
    root
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item, .ant-select-item")
      .filter({ hasText: pattern }),
    root
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content, .ant-select-item-option-content")
      .filter({ hasText: pattern }),
    root.locator("[role='listbox'] [role='option']").filter({ hasText: pattern }),
    root.locator("[role='listbox'] li").filter({ hasText: pattern }),
    root.locator(".rc-virtual-list-holder [role='option']").filter({ hasText: pattern }),
    root.locator(".rc-virtual-list-holder .ant-select-item-option").filter({ hasText: pattern }),
    root.locator(".rc-virtual-list-holder .ant-select-item-option-content").filter({ hasText: pattern }),
  ];
}

async function findVisibleOption(page, action, scopeLocator = null) {
  const option = action.option || {};
  const text = option.text || option.value || action.query;
  const root = scopeLocator || page;
  if (!text && Number.isInteger(option.index)) {
    const indexed = root
      .locator(
        [
          ".ant-select-dropdown:not(.ant-select-dropdown-hidden) [role='option']",
          ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option",
          ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item",
          "[role='listbox'] [role='option']",
          "[role='listbox'] li",
          ".rc-virtual-list-holder [role='option']",
          ".rc-virtual-list-holder .ant-select-item-option",
        ].join(", "),
      )
      .nth(option.index);
    return (await indexed.count().catch(() => 0)) ? indexed : null;
  }
  if (!text) {
    return null;
  }
  const exact = option.match === "exact";
  const pattern = exact
    ? new RegExp(`^\\s*${escapeRegex(text)}\\s*$`, "i")
    : new RegExp(escapeRegex(text), "i");
  if (scopeLocator) {
    const rootMatches = await scopeLocator
      .evaluate((element, { expectedText, matchMode }) => {
        const isOptionLike =
          element.matches?.("[role='option'], .ant-select-item-option, .ant-select-item, .ant-select-item-option-content, li") === true;
        if (!isOptionLike) {
          return false;
        }
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0;
        if (!visible) {
          return false;
        }
        const normalizeText = (value) =>
          typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
        const actual = normalizeText(
          [
            element.getAttribute("title"),
            element.getAttribute("data-value"),
            element.getAttribute("aria-label"),
            element.innerText,
            element.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        );
        const expected = normalizeText(expectedText);
        return matchMode === "exact" ? actual === expected : actual.includes(expected);
      }, { expectedText: text, matchMode: exact ? "exact" : "contains" })
      .catch(() => false);
    if (rootMatches) {
      return scopeLocator;
    }
  }
  const candidates = buildOptionCandidateLocators(root, text, exact, pattern);
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (
        (await item.isVisible().catch(() => false)) === true &&
        (await item.boundingBox().catch(() => null))
      ) {
        return item;
      }
    }
  }
  return null;
}

async function resolveComboPopupScope(page, openTrace, resolution) {
  const reference = openTrace?.searchInput || resolution?.locator;
  const referenceBox = await reference?.boundingBox?.().catch(() => null);
  const relationScope = await reference
    ?.evaluate((element) => {
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== "function") {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0
        );
      };
      const descriptorFor = (node, mode = "aria-linked") => {
        if (node?.id) {
          return { selector: `[id="${node.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`, mode };
        }
        const key = `e2e-combo-popup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        node.setAttribute("data-e2e-combo-popup-id", key);
        return { selector: `[data-e2e-combo-popup-id="${key}"]`, mode };
      };
      const visibleVirtualPopupFor = (node) => {
        const dropdown = node?.closest?.(".ant-select-dropdown");
        if (!dropdown) {
          return null;
        }
        const hasBox = (item) => {
          if (!item || typeof item.getBoundingClientRect !== "function") {
            return false;
          }
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(
          dropdown.querySelectorAll?.(
            ".rc-virtual-list-holder, .rc-virtual-list-holder-inner, .ant-select-item-option, .ant-select-item-option-content",
          ) || [],
        );
        return candidates.find((candidate) => {
          if (!hasBox(candidate)) {
            return false;
          }
          return Array.from(
            candidate.querySelectorAll?.(".ant-select-item-option, .ant-select-item-option-content, [role='option']") || [],
          ).some(hasBox) || candidate.matches?.(".ant-select-item-option, .ant-select-item-option-content");
        }) || null;
      };
      const ids = [
        element.getAttribute("aria-controls"),
        element.getAttribute("aria-owns"),
        element.getAttribute("aria-activedescendant"),
      ].filter(Boolean);
      for (const id of ids) {
        const node = document.getElementById(id);
        const virtualPopup = visibleVirtualPopupFor(node);
        if (virtualPopup) {
          return descriptorFor(virtualPopup, "aria-linked-virtual-list");
        }
        const popup =
          node?.closest?.(".ant-select-dropdown, .rc-virtual-list-holder") ||
          node?.closest?.("[role='listbox']") ||
          node;
        const hiddenAriaListbox =
          popup?.matches?.("[role='listbox']") &&
          popup.closest?.(".ant-select-dropdown") &&
          !isVisible(popup);
        if (hiddenAriaListbox) {
          continue;
        }
        if (isVisible(popup)) {
          return descriptorFor(popup, "aria-linked");
        }
      }
      return null;
    })
    .catch(() => null);
  if (relationScope?.selector) {
    return {
      locator: page.locator(relationScope.selector).first(),
      mode: relationScope.mode || "aria-linked",
    };
  }

  const localScope = await reference
    ?.evaluate((element) => {
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== "function") {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0
        );
      };
      const descriptorFor = (node) => {
        if (node?.id) {
          return { selector: `[id="${node.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`, mode: "local-dom" };
        }
        const key = `e2e-combo-popup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        node.setAttribute("data-e2e-combo-popup-id", key);
        return { selector: `[data-e2e-combo-popup-id="${key}"]`, mode: "local-dom" };
      };
      const root =
        element.closest?.(".ant-select, .ant-cascader, .ant-cascader-picker") ||
        (element.matches?.(".ant-select, .ant-cascader, .ant-cascader-picker") ? element : null);
      const containers = [
        root?.closest?.(".ant-form-item, label, .field, [data-testid], form, section"),
        root?.parentElement,
      ].filter(Boolean);
      for (const container of containers) {
        const popup = Array.from(
          container.querySelectorAll?.(
            ".ant-select-dropdown:not(.ant-select-dropdown-hidden), [role='listbox'], .rc-virtual-list-holder",
          ) || [],
        ).find(isVisible);
        if (popup) {
          return descriptorFor(popup);
        }
      }
      return null;
    })
    .catch(() => null);
  if (localScope?.selector) {
    return {
      locator: page.locator(localScope.selector).first(),
      mode: localScope.mode || "local-dom",
    };
  }

  if (!referenceBox) {
    return { locator: null, mode: "no-reference-box" };
  }

  const geometrySelector = await page
    .evaluate((box) => {
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== "function") {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0
        );
      };
      const selectorFor = (node) => {
        if (node?.id) {
          return `[id="${node.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
        }
        const key = `e2e-combo-popup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        node.setAttribute("data-e2e-combo-popup-id", key);
        return `[data-e2e-combo-popup-id="${key}"]`;
      };
      const centerX = box.x + box.width / 2;
      const popups = Array.from(
        document.querySelectorAll(
          ".ant-select-dropdown:not(.ant-select-dropdown-hidden), [role='listbox'], .rc-virtual-list-holder",
        ),
      )
        .filter(isVisible)
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const popupCenterX = rect.left + rect.width / 2;
          const horizontalOverlap = Math.max(0, Math.min(box.x + box.width, rect.right) - Math.max(box.x, rect.left));
          const verticalGap = rect.top - (box.y + box.height);
          const centerDistance = Math.abs(popupCenterX - centerX);
          const plausible =
            horizontalOverlap > Math.min(box.width, rect.width) * 0.35 &&
            verticalGap >= -12 &&
            verticalGap <= 360;
          return {
            node,
            index,
            plausible,
            score: (plausible ? 0 : 10000) + Math.abs(verticalGap) + centerDistance / 10 + index / 1000,
          };
        })
        .filter((item) => item.plausible)
        .sort((a, b) => a.score - b.score);
      return popups[0]?.node ? selectorFor(popups[0].node) : null;
    }, referenceBox)
    .catch(() => null);

  return geometrySelector
    ? { locator: page.locator(geometrySelector).first(), mode: "geometry" }
    : { locator: null, mode: "not-found" };
}

function isAntSelectResolution(resolution) {
  return String(resolution?.strategy || "").includes("ant-select");
}

async function readComboTargetText(locator, expectedTexts = [], options = {}) {
  return locator
    .evaluate((element, { expectedValues, allowCommittedInputValue }) => {
      const normalizeText = (value) =>
        typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      const expected = (Array.isArray(expectedValues) ? expectedValues : [])
        .map(normalizeText)
        .filter(Boolean);
      const root =
        element.closest?.(".ant-select, .ant-cascader, .ant-cascader-picker") ||
        element;
      const isAntComboRoot =
        root.matches?.(".ant-select, .ant-cascader, .ant-cascader-picker") === true;
      const visible = (node) => {
        if (!node || !(node instanceof Element)) {
          return false;
        }
        const style = window.getComputedStyle(node);
        if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const selectedText = Array.from(
        root.querySelectorAll?.(
          [
            ".ant-select-selection-item",
            ".ant-select-selection-item-content",
            ".ant-select-selection-overflow-item",
            ".ant-select-selection-selected-value",
            ".ant-select-selection__choice__content",
            "[class*='selection-item']",
            "[class*='selection-selected-value']",
          ].join(", "),
        ) || [],
      )
        .filter((node) => !node.closest?.(".ant-select-dropdown, [role='listbox']"))
        .filter((node) => visible(node))
        .filter((node) => !node.classList?.contains("ant-select-selection-placeholder"))
        .map((node) => normalizeText(node.innerText || node.textContent || ""))
        .filter(Boolean);
      const placeholderText = Array.from(
        root.querySelectorAll?.(
          ".ant-select-selection-placeholder, .ant-select-selection__placeholder, [class*='selection-placeholder']",
        ) || [],
      )
        .map((node) => normalizeText(node.innerText || node.textContent || ""))
        .filter(Boolean);
      const visibleTextFrom = (container) => {
        const textNodeFilter = window.NodeFilter?.SHOW_TEXT ?? 4;
        const walker = document.createTreeWalker(container, textNodeFilter);
        const texts = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!parent || !visible(parent)) {
            continue;
          }
          if (
            parent.closest?.(
              [
                "input",
                "textarea",
                "select",
                ".ant-select-selection-search",
                ".ant-select-selection-placeholder",
                ".ant-select-selection__placeholder",
                "[class*='selection-placeholder']",
                ".ant-select-arrow",
                "[class*='select-arrow']",
                ".ant-select-dropdown",
                "[role='listbox']",
              ].join(", "),
            )
          ) {
            continue;
          }
          const text = normalizeText(node.textContent || "");
          if (text) {
            texts.push(text);
          }
        }
        return normalizeText(texts.join(" "));
      };
      const selectorText = isAntComboRoot
        ? Array.from(
            root.querySelectorAll?.(".ant-select-selector, .ant-select-selection, [class*='select-selector']") || [],
          )
            .map(visibleTextFrom)
            .filter(Boolean)
            .filter((text) => !placeholderText.includes(text))
        : [];
      const directSelectedText = normalizeText([...selectedText, ...selectorText].filter(Boolean).join(" "));
      if (directSelectedText && (!expected.length || expected.some((text) => directSelectedText.includes(text)))) {
        return directSelectedText;
      }
      const relatedPopupClosed = (input) => {
        const expanded = input?.getAttribute?.("aria-expanded");
        if (expanded === "false") {
          return true;
        }
        const ids = [
          input?.getAttribute?.("aria-controls"),
          input?.getAttribute?.("aria-owns"),
          input?.getAttribute?.("aria-activedescendant"),
        ].filter(Boolean);
        for (const id of ids) {
          const node = document.getElementById(id);
          const popup = node?.closest?.(".ant-select-dropdown, [role='listbox'], .rc-virtual-list-holder") || node;
          if (popup && visible(popup)) {
            return false;
          }
        }
        return expanded !== "true";
      };
      const committedAntInputValues = isAntComboRoot && allowCommittedInputValue
        ? Array.from(
            root.querySelectorAll?.("input, textarea, select, [contenteditable='true']") || [],
          )
            .filter((node) => !node.closest?.(".ant-select-dropdown, [role='listbox']"))
            .filter((node) => relatedPopupClosed(node))
            .map((node) => {
              if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
                return node.value;
              }
              return node.textContent || "";
            })
            .map(normalizeText)
            .filter(Boolean)
            .filter((value) => !expected.length || expected.some((text) => value === text || value.includes(text)))
        : [];
      if (committedAntInputValues.length) {
        return normalizeText(committedAntInputValues.join(" "));
      }
      const hasVisibleTextChild = (node) =>
        Array.from(node.children || []).some((child) => visible(child) && normalizeText(child.innerText || child.textContent || ""));
      const rootRect = root.getBoundingClientRect?.();
      const rectNearRoot = (rect) => {
        if (!rootRect || !rect) {
          return true;
        }
        const rootCenterY = rootRect.top + rootRect.height / 2;
        const nodeCenterY = rect.top + rect.height / 2;
        const verticalOk =
          Math.abs(nodeCenterY - rootCenterY) <= Math.max(rootRect.height * 1.5, 48);
        const horizontalOk =
          rect.right >= rootRect.left - 48 && rect.left <= rootRect.right + 48;
        return verticalOk && horizontalOk;
      };
      const expectedMatch = (text) => {
        const normalized = normalizeText(text);
        if (!normalized || placeholderText.includes(normalized)) {
          return "";
        }
        return expected.find((item) => normalized === item || normalized.includes(item)) || "";
      };
      const textNodeCandidateTextFrom = (container) => {
        if (!container || !expected.length) {
          return [];
        }
        const textNodeFilter = window.NodeFilter?.SHOW_TEXT ?? 4;
        const walker = document.createTreeWalker(container, textNodeFilter);
        const matches = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          const text = expectedMatch(node.textContent || "");
          if (!text || !parent || root.contains(parent)) {
            continue;
          }
          if (parent.closest?.(".ant-select-dropdown, [role='listbox']")) {
            continue;
          }
          if (parent.matches?.("script, style, input, textarea, select, button, [role='button']")) {
            continue;
          }
          if (!visible(parent)) {
            continue;
          }
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          range.detach?.();
          if (rect.width > 0 && rect.height > 0 && rectNearRoot(rect)) {
            matches.push(text);
          }
        }
        return matches;
      };
      const elementCandidateTextFrom = (container) =>
        Array.from(container?.querySelectorAll?.("*") || [])
            .filter((node) => node !== root && !root.contains(node))
            .filter((node) => !node.closest?.(".ant-select-dropdown, [role='listbox']"))
            .filter((node) => !node.matches?.("input, textarea, select, button, [role='button']"))
            .filter((node) => !node.classList?.contains("ant-select-selection-placeholder"))
            .filter(visible)
            .filter((node) => rectNearRoot(node.getBoundingClientRect?.()))
            .filter((node) => !hasVisibleTextChild(node))
            .map((node) => expectedMatch(node.innerText || node.textContent || node.getAttribute?.("title") || ""))
            .filter(Boolean);
      const candidateTextFrom = (container) => [
        ...elementCandidateTextFrom(container),
        ...textNodeCandidateTextFrom(container),
      ];
      const neighborSelectedText = (() => {
        if (!expected.length) {
          return [];
        }
        const semanticSelectors = [
          ".ant-form-item",
          ".ant-form-item-control",
          ".ant-form-item-control-input",
          ".ant-form-item-control-input-content",
          "label",
          ".field",
          "[class*='formItem']",
          "[class*='FormItem']",
          "[class*='form-item']",
        ].join(", ");
        const candidates = [];
        let current = root;
        let depth = 0;
        while (current && depth < 8) {
          const rect = current.getBoundingClientRect?.();
          let sizeOk = true;
          if (rootRect && rect) {
            const widthOk = rect.width <= Math.max(rootRect.width * 8, 900);
            const heightOk = rect.height <= Math.max(rootRect.height * 8, 260);
            sizeOk = widthOk && heightOk;
            if (current !== root && !sizeOk && !current.matches?.(semanticSelectors)) {
              break;
            }
          }
          if (
            current === root ||
            sizeOk ||
            current.matches?.(semanticSelectors) ||
            current.parentElement === null
          ) {
            candidates.push(current);
          }
          current = current.parentElement;
          depth += 1;
        }
        if (root.parentElement && !candidates.includes(root.parentElement)) {
          candidates.push(root.parentElement);
        }
        for (const candidate of candidates) {
          const texts = candidateTextFrom(candidate);
          if (texts.length) {
            return texts;
          }
        }
        return [];
      })();
      const directValue =
        root instanceof HTMLInputElement ||
        root instanceof HTMLTextAreaElement ||
        root instanceof HTMLSelectElement
          ? root.value
          : "";
      const inputValues = isAntComboRoot
        ? []
        : Array.from(
            root.querySelectorAll?.("input, textarea, select, [contenteditable='true']") || [],
          )
            .filter((node) => !node.closest?.(".ant-select-dropdown, [role='listbox']"))
            .map((node) => {
              if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
                return node.value;
              }
              return node.textContent || "";
            })
            .map(normalizeText)
            .filter(Boolean);
      return normalizeText([directValue, ...selectedText, ...selectorText, ...neighborSelectedText, ...inputValues].filter(Boolean).join(" "));
    }, { expectedValues: expectedTexts, allowCommittedInputValue: Boolean(options.allowCommittedInputValue) })
    .catch(() => "");
}

async function waitForComboPopupScope(page, openTrace, resolution, action) {
  const timeoutMs = action.optionWaitTimeoutMs ?? action.timeoutMs;
  const intervalMs = action.optionPollIntervalMs ?? 200;
  const startedAt = Date.now();
  let attempts = 0;
  let latest = { locator: null, mode: "not-found" };

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    latest = await resolveComboPopupScope(page, openTrace, resolution);
    if (latest.locator) {
      return {
        ...latest,
        attempts,
        durationMs: Date.now() - startedAt,
      };
    }
    await page.waitForTimeout(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt)))).catch(() => {});
  }

  return {
    ...latest,
    attempts,
    durationMs: Date.now() - startedAt,
  };
}

async function waitForComboSelectionApplied(page, action, resolution, openTrace = null) {
  const expectedTexts = [action.option?.value, action.option?.text]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const locators = [openTrace?.comboRoot, resolution?.locator].filter(Boolean);
  if (!expectedTexts.length || !locators.length) {
    return { ok: true, actual: "" };
  }
  const timeoutMs = Math.min(
    Math.max(action.timeoutMs ?? 1000, action.optionWaitTimeoutMs ?? 0, 1200),
    5000,
  );
  const startedAt = Date.now();
  let actual = "";
  while (Date.now() - startedAt <= timeoutMs) {
    for (const locator of locators) {
      actual = await readComboTargetText(locator, expectedTexts, {
        allowCommittedInputValue: Boolean(action.target?.testId),
      });
      if (expectedTexts.some((text) => actual.includes(text))) {
        return { ok: true, actual };
      }
    }
    await page.waitForTimeout(100).catch(() => {});
  }
  return { ok: false, actual, expected: expectedTexts };
}

function splitOptionPath(option = {}) {
  const explicitPath = Array.isArray(option.path) ? option.path : [];
  const source = explicitPath.length
    ? explicitPath
    : [option.text || option.value || ""];
  return source
    .flatMap((item) =>
      typeof item === "string" ? item.split(/\r?\n|[>/]|→|›/) : [item],
    )
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

async function findVisibleCascaderItemByLevel(page, label, action, level) {
  if (!Number.isInteger(level) || level < 0) {
    return null;
  }
  const result = await page.evaluate(({ labelText, matchMode, targetLevel }) => {
    const normalizeText = (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const matchesLabel = (value) => {
      const text = normalizeText(value);
      const expected = normalizeText(labelText);
      if (!text || !expected) {
        return false;
      }
      return matchMode === "exact" ? text === expected : text.includes(expected);
    };
    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (
        !style ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (el) => {
      const key = `e2e-cascader-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      el.setAttribute("data-e2e-cascader-target-id", key);
      return `[data-e2e-cascader-target-id="${key}"]`;
    };
    const menuNodes = Array.from(
      document.querySelectorAll(
        ".ant-cascader-dropdown .ant-cascader-menu, .ant-cascader-menus .ant-cascader-menu, .ant-cascader-menu",
      ),
    )
      .filter(isVisible)
      .map((menu, domIndex) => {
        const rect = menu.getBoundingClientRect();
        return {
          menu,
          domIndex,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      })
      .sort((a, b) => {
        if (Math.abs(a.x - b.x) > 4) {
          return a.x - b.x;
        }
        if (Math.abs(a.y - b.y) > 4) {
          return a.y - b.y;
        }
        return a.domIndex - b.domIndex;
      });
    const menu = menuNodes[targetLevel]?.menu;
    if (!menu) {
      return {
        selector: null,
        columns: menuNodes.map((item, index) => ({
          level: index,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          items: Array.from(
            item.menu.querySelectorAll(".ant-cascader-menu-item, [role='menuitem'], li"),
          )
            .filter(isVisible)
            .slice(0, 12)
            .map((node) => normalizeText(node.innerText || node.textContent || node.getAttribute("title") || "")),
        })),
      };
    }
    const items = Array.from(
      menu.querySelectorAll(".ant-cascader-menu-item, [role='menuitem'], li"),
    ).filter(isVisible);
    const matched = items.find((item) =>
      matchesLabel(
        [
          item.getAttribute("title"),
          item.getAttribute("data-value"),
          item.getAttribute("aria-label"),
          item.innerText,
          item.textContent,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    );
    if (!matched) {
      return {
        selector: null,
        columns: menuNodes.map((item, index) => ({
          level: index,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          items: Array.from(
            item.menu.querySelectorAll(".ant-cascader-menu-item, [role='menuitem'], li"),
          )
            .filter(isVisible)
            .slice(0, 12)
            .map((node) => normalizeText(node.innerText || node.textContent || node.getAttribute("title") || "")),
        })),
      };
    }
    return {
      selector: selectorFor(matched),
      columns: menuNodes.map((item, index) => ({
        level: index,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      })),
    };
  }, {
    labelText: label,
    matchMode: action.option?.match === "exact" ? "exact" : "contains",
    targetLevel: level,
  }).catch(() => null);

  if (!result?.selector) {
    return {
      item: null,
      columns: result?.columns ?? [],
    };
  }
  const item = page.locator(result.selector).first();
  if (
    (await item.isVisible().catch(() => false)) === true &&
    (await item.boundingBox().catch(() => null))
  ) {
    return {
      item,
      columns: result.columns ?? [],
    };
  }
  return {
    item: null,
    columns: result.columns ?? [],
  };
}

async function findVisibleCascaderItem(page, label, action, level = null) {
  const exact = action.option?.match === "exact";
  const pattern = exact
    ? new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i")
    : new RegExp(escapeRegex(label), "i");
  const escapedLabel = label.replace(/"/g, '\\"');
  if (Number.isInteger(level) && level >= 0) {
    const geometryMatch = await findVisibleCascaderItemByLevel(page, label, action, level);
    if (geometryMatch?.item || geometryMatch?.columns?.length) {
      return geometryMatch;
    }
    const menuScopes = [
      page.locator(".ant-cascader-dropdown .ant-cascader-menu:visible"),
      page.locator(".ant-cascader-menus .ant-cascader-menu:visible"),
      page.locator(".ant-cascader-menu:visible"),
    ];
    for (const menus of menuScopes) {
      const menuCount = await menus.count().catch(() => 0);
      if (menuCount <= level) {
        continue;
      }
      const menu = menus.nth(level);
      const scopedCandidates = [
        menu.locator(`[title="${escapedLabel}"], [data-value="${escapedLabel}"], [aria-label="${escapedLabel}"]`).filter({ hasText: pattern }),
        menu.locator(".ant-cascader-menu-item").filter({ hasText: pattern }),
        menu.locator("[role='menuitem']").filter({ hasText: pattern }),
        menu.locator("li").filter({ hasText: pattern }),
      ];
      for (const candidate of scopedCandidates) {
        const count = await candidate.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const item = candidate.nth(index);
          if (
            (await item.isVisible().catch(() => false)) === true &&
            (await item.boundingBox().catch(() => null))
          ) {
            return { item, columns: [] };
          }
        }
      }
      return { item: null, columns: [] };
    }
    return { item: null, columns: [] };
  }
  const candidates = [
    page
      .locator(
        `.ant-cascader-dropdown [title="${escapedLabel}"], .ant-cascader-menus [title="${escapedLabel}"], .ant-cascader-menu [title="${escapedLabel}"]`,
      )
      .filter({ hasText: pattern }),
    page.locator(".ant-cascader-dropdown .ant-cascader-menu-item").filter({ hasText: pattern }),
    page.locator(".ant-cascader-menus .ant-cascader-menu-item").filter({ hasText: pattern }),
    page.locator(".ant-cascader-menu .ant-cascader-menu-item").filter({ hasText: pattern }),
    page.locator(".ant-cascader-dropdown [role='menuitem']").filter({ hasText: pattern }),
    page.locator(".ant-cascader-dropdown li").filter({ hasText: pattern }),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (
          (await item.isVisible().catch(() => false)) === true &&
          (await item.boundingBox().catch(() => null))
        ) {
        return { item, columns: [] };
      }
    }
  }
  return { item: null, columns: [] };
}

async function waitForVisibleCascaderItem(page, label, action, level = null) {
  const timeoutMs = action.optionWaitTimeoutMs ?? action.timeoutMs;
  const intervalMs = action.optionPollIntervalMs ?? 200;
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    const result = await findVisibleCascaderItem(page, label, action, level);
    if (result?.item) {
      return {
        item: result.item,
        columns: result.columns ?? [],
        attempts,
        durationMs: Date.now() - startedAt,
      };
    }
    await page.waitForTimeout(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt)))).catch(() => {});
  }

  return {
    item: null,
    columns: [],
    attempts,
    durationMs: Date.now() - startedAt,
  };
}

async function waitForVisibleOption(page, action, scopeLocator = null) {
  const timeoutMs = action.optionWaitTimeoutMs ?? action.timeoutMs;
  const intervalMs = action.optionPollIntervalMs ?? 200;
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    const option = await findVisibleOption(page, action, scopeLocator);
    if (option) {
      return {
        option,
        attempts,
        durationMs: Date.now() - startedAt,
      };
    }
    await page.waitForTimeout(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt)))).catch(() => {});
  }

  return {
    option: null,
    attempts,
    durationMs: Date.now() - startedAt,
  };
}

async function clickComboOption(page, option, timeoutMs) {
  try {
    await option.click({ timeout: timeoutMs });
    return "locator-click";
  } catch (firstError) {
    const message = firstError?.message || "";
    const shouldFallback =
      message.includes("intercepts pointer events") ||
      message.includes("Timeout") ||
      message.includes("not receive pointer events");
    if (!shouldFallback) {
      throw firstError;
    }
  }

  try {
    await option.click({ timeout: timeoutMs, force: true });
    return "force-click";
  } catch (_forceError) {
    await option.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    return "dispatch-click";
  }
}

async function setEditableValue(locator, value) {
  await locator.evaluate((element, nextValue) => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    descriptor?.set?.call(element, nextValue);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function isEditableComboInput(locator) {
  return locator
    .evaluate((element) => {
      const tag = element?.tagName;
      return (
        (tag === "INPUT" || tag === "TEXTAREA" || element?.isContentEditable) &&
        (element.getAttribute("role") === "combobox" ||
          element.getAttribute("aria-autocomplete") ||
          element.classList?.contains("ant-select-selection-search-input"))
      );
    })
    .catch(() => false);
}

async function findNestedComboInput(locator) {
  const nested = locator
    .locator("input[role='combobox'], input.ant-select-selection-search-input, input[type='search'], input")
    .first();
  const count = await nested.count().catch(() => 0);
  return count > 0 ? nested : null;
}

async function resolveComboRootLocator(page, locator, options = {}) {
  if (options.preserveRootLocator) {
    if (options.markPreservedRoot) {
      await locator
        .evaluate((element) => {
          const root =
            element.closest?.(".ant-select, .ant-cascader, .ant-cascader-picker") ||
            (element.matches?.(".ant-select, .ant-cascader, .ant-cascader-picker") ? element : null);
          if (!root || root.getAttribute("data-e2e-combo-root-id")) {
            return;
          }
          const key = `e2e-combo-root-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          root.setAttribute("data-e2e-combo-root-id", key);
        })
        .catch(() => {});
    }
    return locator;
  }
  const selector = await locator
    .evaluate((element) => {
      const root =
        element.closest?.(".ant-select, .ant-cascader, .ant-cascader-picker") ||
        (element.matches?.(".ant-select, .ant-cascader, .ant-cascader-picker") ? element : null);
      if (!root) {
        return null;
      }
      const key = `e2e-combo-root-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      root.setAttribute("data-e2e-combo-root-id", key);
      return `[data-e2e-combo-root-id="${key}"]`;
    })
    .catch(() => null);
  return selector ? page.locator(selector).first() : locator;
}

async function isAntLikeComboResolution(resolution, openTrace = null) {
  const locators = [openTrace?.comboRoot, resolution?.locator].filter(Boolean);
  for (const locator of locators) {
    const matched = await locator
      .evaluate((element) => {
        const root =
          element.closest?.(".ant-select, .ant-cascader, .ant-cascader-picker") ||
          (element.matches?.(".ant-select, .ant-cascader, .ant-cascader-picker") ? element : null);
        return Boolean(root);
      })
      .catch(() => false);
    if (matched) {
      return true;
    }
  }
  return isAntSelectResolution(resolution);
}

async function inputBelongsToMarkedComboRoot(input) {
  return input
    .evaluate((element) => {
      if (!element) {
        return false;
      }
      const root =
        element.closest?.(".ant-select, .ant-cascader, .ant-cascader-picker") ||
        element;
      return Boolean(root?.getAttribute?.("data-e2e-combo-root-id"));
    })
    .catch(() => false);
}

async function typeComboQuery(page, input, query, timeoutMs, options = {}) {
  const startedAt = Date.now();
  const finish = (typed, method, activation) => ({
    typed,
    method,
    activation,
    durationMs: Date.now() - startedAt,
  });
  if (!input || !query) {
    return finish(false, "none", "none");
  }
  const count = await input.count().catch(() => 0);
  if (!count) {
    return finish(false, "none", "not-found");
  }
  const readValue = async () =>
    input
      .evaluate((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          return element.value || "";
        }
        return element.textContent || "";
      })
      .catch(() => "");
  let activation = "focus";
  try {
    if (!options.focusOnly) {
      const activationTimeoutMs = Math.min(timeoutMs, 600);
      try {
        await input.click({ timeout: activationTimeoutMs });
        activation = "locator-click";
      } catch (_clickError) {
        await input.click({ timeout: activationTimeoutMs, force: true });
        activation = "force-click";
      }
    }
    await input.evaluate((element) => {
      element.focus?.();
      if (typeof element.select === "function") {
        element.select();
      }
    }).catch(() => {});
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+A`).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.insertText(query);
    await page.waitForTimeout(80).catch(() => {});
    if ((await readValue()) === query) {
      return finish(true, "keyboard", activation);
    }
    await input.evaluate((element) => {
      element.focus?.();
      if (typeof element.select === "function") {
        element.select();
      }
    }).catch(() => {});
    await input.fill(query, { timeout: timeoutMs });
    await page.waitForTimeout(80).catch(() => {});
    if ((await readValue()) === query) {
      return finish(true, "fill", activation);
    }
    await setEditableValue(input, query);
    return finish(true, "dom-value", activation);
  } catch (_keyboardError) {
    try {
      await input.fill(query, { timeout: timeoutMs });
      return finish(true, "fill-fallback", activation);
    } catch (_fillError) {
      await setEditableValue(input, query);
      return finish(true, "dom-value-fallback", activation);
    }
  }
}

async function openComboSearchTarget(page, action, resolution) {
  const trigger = resolution.locator;
  const comboRoot = await resolveComboRootLocator(page, trigger, {
    preserveRootLocator: Boolean(action.target?.locator || action.target?.testId),
    markPreservedRoot: Boolean(action.target?.testId && !action.target?.locator),
  });
  if ((await isEditableComboInput(trigger)) && action.query) {
    const queryInput = await typeComboQuery(page, trigger, action.query, action.timeoutMs);
    return { openedBy: "direct-keyboard", searchInput: trigger, comboRoot, queryInput };
  }

  let nestedInput = await findNestedComboInput(comboRoot);
  const openStartedAt = Date.now();
  try {
    await comboRoot.click({ timeout: Math.min(action.timeoutMs, 800) });
    nestedInput = (await findNestedComboInput(comboRoot)) || nestedInput;
    if (nestedInput && action.query) {
      const queryInput = await typeComboQuery(page, nestedInput, action.query, action.timeoutMs, {
        focusOnly: true,
      });
      const bound = await inputBelongsToMarkedComboRoot(nestedInput);
      return {
        openedBy: bound ? "root-click:nested-keyboard" : "root-click:nested-keyboard:unbound",
        searchInput: nestedInput,
        comboRoot,
        queryInput,
        openDurationMs: Date.now() - openStartedAt,
      };
    }
    return { openedBy: "root-click", searchInput: nestedInput, comboRoot, openDurationMs: Date.now() - openStartedAt };
  } catch (error) {
    const message = error?.message || "";
    const shouldFallback =
      message.includes("intercepts pointer events") ||
      message.includes("Timeout") ||
      message.includes("not receive pointer events");
    if (!shouldFallback) {
      throw error;
    }
  }

  const antWrapper = trigger
    .locator(
      "xpath=ancestor-or-self::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-select ')][1]",
    )
    .first();
  if ((await antWrapper.count().catch(() => 0)) > 0) {
    await antWrapper.click({ timeout: Math.min(action.timeoutMs, 800), force: true }).catch(() => {});
    const wrapperInput = (await findNestedComboInput(antWrapper)) || nestedInput;
    if (wrapperInput && action.query) {
      const queryInput = await typeComboQuery(page, wrapperInput, action.query, action.timeoutMs, {
        focusOnly: true,
      });
      return {
        openedBy: "wrapper-force-click:nested-keyboard",
        searchInput: wrapperInput,
        comboRoot,
        queryInput,
        openDurationMs: Date.now() - openStartedAt,
      };
    }
    return { openedBy: "wrapper-force-click", searchInput: wrapperInput, comboRoot, openDurationMs: Date.now() - openStartedAt };
  }

  await comboRoot.click({ timeout: Math.min(action.timeoutMs, 800), force: true });
  nestedInput = (await findNestedComboInput(comboRoot)) || nestedInput;
  if (nestedInput && action.query) {
    const queryInput = await typeComboQuery(page, nestedInput, action.query, action.timeoutMs, {
      focusOnly: true,
    });
    const bound = await inputBelongsToMarkedComboRoot(nestedInput);
    return {
      openedBy: bound ? "root-force-click:nested-keyboard" : "root-force-click:nested-keyboard:unbound",
      searchInput: nestedInput,
      comboRoot,
      queryInput,
      openDurationMs: Date.now() - openStartedAt,
    };
  }
  return { openedBy: "root-force-click", searchInput: nestedInput, comboRoot, openDurationMs: Date.now() - openStartedAt };
}

async function runComboSearchSelectAction(page, action, resolution) {
  if (!resolution?.locator) {
    return { success: false, error: "action-target-unresolved" };
  }
  const openTrace = await openComboSearchTarget(page, action, resolution);
  await page.waitForTimeout(120).catch(() => {});

  const focused = page.locator("input:focus, textarea:focus, [contenteditable='true']:focus").first();
  const popupInput = page
    .locator(".ant-select-dropdown input, [role='listbox'] input, input[type='search'], input")
    .last();
  const searchInput = openTrace.searchInput || ((await focused.count().catch(() => 0)) ? focused : popupInput);
  if (
    !openTrace.openedBy.includes("keyboard") &&
    openTrace.openedBy !== "direct-fill" &&
    openTrace.openedBy !== "dom-input" &&
    (await searchInput.count().catch(() => 0)) > 0 &&
    action.query
  ) {
    await searchInput.fill(action.query, { timeout: action.timeoutMs }).catch(async () => {
      await searchInput.click({ timeout: action.timeoutMs });
      await page.keyboard.insertText(action.query);
    });
  }
  const scopedToAntSelect = await isAntLikeComboResolution(resolution, openTrace);
  const popupScope = scopedToAntSelect
    ? await waitForComboPopupScope(page, openTrace, resolution, action)
    : await resolveComboPopupScope(page, openTrace, resolution);
  let optionWait = popupScope.locator || !scopedToAntSelect
    ? await waitForVisibleOption(page, action, popupScope.locator)
    : {
        option: null,
        attempts: 0,
        durationMs: 0,
      };
  let option = optionWait.option;
  let optionScopeMode = popupScope.mode;
  if (!option && popupScope.locator) {
    const allowGlobalOptionFallback = !scopedToAntSelect || ["geometry", "local-dom"].includes(popupScope.mode);
    const fallbackOptionWait = allowGlobalOptionFallback
      ? await waitForVisibleOption(page, action, null)
      : {
          option: null,
          attempts: 0,
          durationMs: 0,
        };
    if (fallbackOptionWait.option) {
      optionWait = fallbackOptionWait;
      option = fallbackOptionWait.option;
      optionScopeMode = `${popupScope.mode}->visible-fallback`;
    }
  }
  if (!option) {
    return {
      success: false,
      error: "option-not-found",
      popupTrace: {
        query: action.query,
        option: action.option,
        openedBy: openTrace.openedBy,
        openDurationMs: openTrace.openDurationMs ?? null,
        queryInput: openTrace.queryInput ?? null,
        optionScope: optionScopeMode,
        optionScopeWait: {
          attempts: popupScope.attempts ?? 0,
          durationMs: popupScope.durationMs ?? 0,
        },
        optionWait: {
          timeoutMs: action.optionWaitTimeoutMs ?? action.timeoutMs,
          pollIntervalMs: action.optionPollIntervalMs ?? 200,
          attempts: optionWait.attempts,
          durationMs: optionWait.durationMs,
        },
      },
    };
  }
  const optionClick = await clickComboOption(page, option, action.timeoutMs);
  const applied = await waitForComboSelectionApplied(page, action, resolution, openTrace);
  if (!applied.ok) {
    return {
      success: false,
      error: "selection-not-applied",
      popupTrace: {
        query: action.query,
        option: action.option,
        openedBy: openTrace.openedBy,
        openDurationMs: openTrace.openDurationMs ?? null,
        queryInput: openTrace.queryInput ?? null,
        optionScope: optionScopeMode,
        optionScopeWait: {
          attempts: popupScope.attempts ?? 0,
          durationMs: popupScope.durationMs ?? 0,
        },
        optionWait: {
          timeoutMs: action.optionWaitTimeoutMs ?? action.timeoutMs,
          pollIntervalMs: action.optionPollIntervalMs ?? 200,
          attempts: optionWait.attempts,
          durationMs: optionWait.durationMs,
        },
        optionClick,
        selected: {
          expected: applied.expected,
          actual: applied.actual,
        },
      },
    };
  }
  return {
    success: true,
    detail: "combo-search-select",
    popupTrace: {
      query: action.query,
      option: action.option,
      openedBy: openTrace.openedBy,
      openDurationMs: openTrace.openDurationMs ?? null,
      queryInput: openTrace.queryInput ?? null,
      optionScope: optionScopeMode,
      optionScopeWait: {
        attempts: popupScope.attempts ?? 0,
        durationMs: popupScope.durationMs ?? 0,
      },
      optionWait: {
        timeoutMs: action.optionWaitTimeoutMs ?? action.timeoutMs,
        pollIntervalMs: action.optionPollIntervalMs ?? 200,
        attempts: optionWait.attempts,
        durationMs: optionWait.durationMs,
      },
      optionClick,
      selected: {
        actual: applied.actual,
      },
    },
  };
}

async function runCascaderSelectAction(page, action, resolution) {
  if (!resolution?.locator) {
    return { success: false, error: "action-target-unresolved" };
  }
  const path = splitOptionPath(action.option);
  if (!path.length) {
    return {
      success: false,
      error: "option-not-found",
      popupTrace: {
        option: action.option,
        cascaderPath: [],
      },
    };
  }

  const openTrace = await openComboSearchTarget(page, action, resolution);
  await page.waitForTimeout(120).catch(() => {});

  const clicked = [];
  const waits = [];
  const expansionProbes = [];
  for (let index = 0; index < path.length; index += 1) {
    const label = path[index];
    const waitResult = await waitForVisibleCascaderItem(page, label, action, index);
    waits.push({
      label,
      level: index,
      attempts: waitResult.attempts,
      durationMs: waitResult.durationMs,
      columns: waitResult.columns ?? [],
    });
    if (!waitResult.item) {
      return {
        success: false,
        error: "option-not-found",
        popupTrace: {
          option: action.option,
          cascaderPath: path,
          clicked,
          expansionProbes,
          optionWait: {
            timeoutMs: action.optionWaitTimeoutMs ?? action.timeoutMs,
            pollIntervalMs: action.optionPollIntervalMs ?? 200,
            waits,
          },
        },
      };
    }

    await waitResult.item.hover({ timeout: action.timeoutMs }).catch(() => {});
    let clickMode = null;
    if (index < path.length - 1) {
      const nextLabel = path[index + 1];
      const nextAfterHover = await waitForVisibleCascaderItem(page, nextLabel, {
        ...action,
        optionWaitTimeoutMs: Math.min(action.optionWaitTimeoutMs ?? action.timeoutMs, 180),
        optionPollIntervalMs: Math.min(action.optionPollIntervalMs ?? 200, 60),
      }, index + 1);
      expansionProbes.push({
        label,
        nextLabel,
        level: index,
        attempts: nextAfterHover.attempts,
        durationMs: nextAfterHover.durationMs,
        expanded: Boolean(nextAfterHover.item),
      });
      if (nextAfterHover.item) {
        clicked.push({ label, clickMode: "hover-expand" });
        continue;
      }
    }
    clickMode = await clickComboOption(page, waitResult.item, action.timeoutMs);
    clicked.push({ label, clickMode });
    await page.waitForTimeout(index === path.length - 1 ? 80 : 40).catch(() => {});
  }

  return {
    success: true,
    detail: "cascader-select",
    popupTrace: {
      option: action.option,
      openedBy: openTrace.openedBy,
      openDurationMs: openTrace.openDurationMs ?? null,
      cascaderPath: path,
      clicked,
      expansionProbes,
      optionWait: {
        timeoutMs: action.optionWaitTimeoutMs ?? action.timeoutMs,
        pollIntervalMs: action.optionPollIntervalMs ?? 200,
        waits,
      },
    },
  };
}

async function runSelectOptionAction(action, locator) {
  const option = action.option || {};
  const selected = {};
  if (Number.isInteger(option.index)) {
    selected.index = option.index;
  } else if (option.value || action.value) {
    selected.value = option.value || action.value;
  } else if (option.text) {
    selected.label = option.text;
  }
  if (!Object.keys(selected).length) {
    return {
      success: false,
      error: "option-not-found",
      popupTrace: {
        option,
      },
    };
  }
  await locator.selectOption(selected, { timeout: action.timeoutMs });
  return {
    success: true,
    detail: "select-option",
    popupTrace: {
      option,
      selected,
    },
  };
}

async function setCheckedState(locator, checked, timeoutMs) {
  if (checked) {
    await locator.check({ timeout: timeoutMs });
    return "locator-check";
  }
  await locator.uncheck({ timeout: timeoutMs });
  return "locator-uncheck";
}

async function executeDomAction(page, action, resolution) {
  if (action.kind === "assertVisible" && getAssertVisibleTexts(action).length) {
    return {
      success: true,
      detail: "assert-visible-text-check",
    };
  }

  if (action.actionDefinition?.needsTarget && !resolution) {
    return {
      success: false,
      error: "target-not-found",
    };
  }

  if (action.kind === "openUrl") {
    const targetUrl =
      typeof action.raw?.url === "string"
        ? action.raw.url
        : typeof action.query === "string" && action.query
          ? action.query
          : null;
    if (!targetUrl) {
      return { success: false, error: "invalid-url" };
    }
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: action.timeoutMs,
    });
    return { success: true, detail: "open-url" };
  }

  if (action.kind === "reload") {
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: action.timeoutMs,
    });
    return { success: true, detail: "reload" };
  }

  if (action.kind === "goBack") {
    await page.goBack({ timeout: action.timeoutMs });
    return { success: true, detail: "go-back" };
  }

  if (action.kind === "goForward") {
    await page.goForward({ timeout: action.timeoutMs });
    return { success: true, detail: "go-forward" };
  }

  if (action.kind === "assertVisible" || action.kind === "capture") {
    return {
      success: true,
      detail: action.kind === "capture" ? "capture-only" : "assert-visible-resolved",
    };
  }

  if (action.kind === "press") {
    const key = action.key || action.value;
    if (!key) {
      return { success: false, error: "key-required" };
    }
    if (resolution?.locator) {
      await resolution.locator.click({ timeout: action.timeoutMs });
    }
    await page.keyboard.press(key, { timeout: action.timeoutMs });
    return { success: true, detail: resolution?.locator ? "target-press" : "page-press" };
  }

  if (resolution?.source === "ocr" && resolution.bbox) {
    const x = resolution.bbox.x + resolution.bbox.width / 2;
    const y = resolution.bbox.y + resolution.bbox.height / 2;
    if (action.kind === "click" || action.kind === "hover") {
      if (action.kind === "hover") {
        await page.mouse.move(x, y);
        return { success: true, detail: "ocr-hover" };
      }
      await page.mouse.click(x, y);
      return { success: true, detail: "ocr-click" };
    }
    if (action.kind === "fill") {
      const editableTarget = await resolveEditableFromOcrAnchor(
        page,
        resolution.bbox,
        action,
      );
      if (editableTarget?.locator) {
        await editableTarget.locator.click({ timeout: action.timeoutMs });
        await editableTarget.locator.fill(action.value ?? "", {
          timeout: action.timeoutMs,
        });
        return { success: true, detail: "ocr-fill" };
      }
      await page.mouse.click(x, y);
      await page.keyboard.insertText(action.value ?? "");
      return { success: true, detail: "ocr-fill" };
    }
  }

  const locator = resolution?.locator;
  if (!locator && resolution?.targetSummary?.bbox) {
    const x =
      resolution.targetSummary.bbox.x + resolution.targetSummary.bbox.width / 2;
    const y =
      resolution.targetSummary.bbox.y + resolution.targetSummary.bbox.height / 2;
    if (action.kind === "click" || action.kind === "hover") {
      if (action.kind === "hover") {
        await page.mouse.move(x, y);
        return { success: true, detail: "bbox-hover" };
      }
      await page.mouse.click(x, y);
      return { success: true, detail: "bbox-click" };
    }
  }

  if (!locator && action.actionDefinition?.needsTarget) {
    return {
      success: false,
      error: "action-target-unresolved",
    };
  }

  switch (action.kind) {
    case "click":
      await locator.click({ timeout: action.timeoutMs });
      return { success: true, detail: "locator-click" };
    case "hover":
      await locator.hover({ timeout: action.timeoutMs });
      return { success: true, detail: "locator-hover" };
    case "fill":
      await locator.click({ timeout: action.timeoutMs });
      await locator.fill(action.value ?? "", { timeout: action.timeoutMs });
      return { success: true, detail: "locator-fill" };
    case "check":
      return {
        success: true,
        detail: await setCheckedState(locator, true, action.timeoutMs),
      };
    case "uncheck":
      return {
        success: true,
        detail: await setCheckedState(locator, false, action.timeoutMs),
      };
    case "selectOption":
      return runSelectOptionAction(action, locator);
    case "callApi":
      return runCallApiAction(page, action);
    case "comboSearchSelect":
      return runComboSearchSelectAction(page, action, resolution);
    case "cascaderSelect":
      return runCascaderSelectAction(page, action, resolution);
    case "uploadFile":
      return runUploadFileAction(page, action, resolution);
    case "scroll":
      await page.mouse.wheel(0, action.autoScroll?.deltaY ?? 360);
      return { success: true, detail: "page-scroll" };
    case "waitForText":
    case "waitForNav":
    case "waitForIdle":
    case "assertVisible":
    case "assertUrl":
    case "assertCount":
    case "capture":
      return { success: true, detail: "no-op" };
    default:
      return {
        success: false,
        error: `unsupported-action:${action.kind}`,
      };
  }
}

module.exports = {
  executeDomAction,
};
