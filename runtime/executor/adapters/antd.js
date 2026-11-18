function getTargetQuery(actionOrTarget = {}) {
  const target = actionOrTarget.target || actionOrTarget || {};
  return (
    actionOrTarget.query ||
    target.name ||
    target.text ||
    target.query ||
    target.placeholder ||
    target.ariaLabel ||
    target.title ||
    target.iconHint ||
    ""
  );
}

function isProbablyAntd(uiContext) {
  return Boolean(uiContext?.antd?.detected || uiContext?.beforeAction?.antd?.detected || uiContext?.beforeExpectation?.antd?.detected);
}

async function resolveAntdActionTarget(page, action, options = {}) {
  const target = action.target || {};
  const query = getTargetQuery(action);
  const role = String(target.role || "").trim().toLowerCase();
  const result = await page.evaluate(({ role, queryText, nearText, placeholder, targetIndex, kind, uiLooksAntd }) => {
    const normalizeText = (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const normalizeComparableText = (value) =>
      normalizeText(value)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\s_-]+/g, "");
    const attrText = (el, name) => normalizeText(el?.getAttribute?.(name) || "");
    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const hasAntd = uiLooksAntd || document.querySelector("[class^='ant-'], [class*=' ant-']");
    if (!hasAntd) {
      return null;
    }
    const textOf = (el) =>
      normalizeText(
        [
          el?.innerText,
          el?.textContent,
          el?.value,
          attrText(el, "aria-label"),
          attrText(el, "title"),
          attrText(el, "placeholder"),
          attrText(el, "data-testid"),
          attrText(el, "data-test-id"),
          attrText(el, "data-cy"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    const includesText = (actual, expected) => {
      const normalizedExpected = normalizeComparableText(expected);
      if (!normalizedExpected) {
        return true;
      }
      const normalizedActual = normalizeComparableText(actual);
      if (!normalizedActual) {
        return false;
      }
      return normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual);
    };
    const selectorFor = (el) => {
      const key = `e2e-antd-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      el.setAttribute("data-e2e-antd-target-id", key);
      return `[data-e2e-antd-target-id="${key}"]`;
    };
    const contextMatch = (el) => {
      const expected = normalizeText(nearText);
      if (!expected) {
        return { matched: false, method: null, score: 0 };
      }
      if (includesText(textOf(el), expected)) {
        return { matched: true, method: "self", score: -1000 };
      }
      const targetRect = el.getBoundingClientRect();
      const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
      let current = el.parentElement;
      for (let depth = 1; current && current !== document.body && depth <= 10; depth += 1) {
        if (!isVisible(current)) {
          current = current.parentElement;
          continue;
        }
        const rect = current.getBoundingClientRect();
        const area = Math.max(rect.width * rect.height, 1);
        const className = String(current.getAttribute("class") || "").toLowerCase();
        const semanticContainer =
          current.getAttribute("role") === "dialog" ||
          className.includes("modal") ||
          className.includes("drawer") ||
          className.includes("popover") ||
          className.includes("popconfirm") ||
          className.includes("form") ||
          className.includes("table");
        const compactContainer =
          area <= viewportArea * 0.72 &&
          rect.width <= Math.max(targetRect.width * 20, 1080) &&
          rect.height <= Math.max(targetRect.height * 20, 760);
        if ((semanticContainer || compactContainer) && includesText(textOf(current), expected)) {
          return {
            matched: true,
            method: semanticContainer ? `ancestor-semantic-${depth}` : `ancestor-local-${depth}`,
            score: depth * 10 + area / 100000,
          };
        }
        current = current.parentElement;
      }
      return { matched: false, method: "not-found", score: Number.POSITIVE_INFINITY };
    };
    const selectorsByRole = {
      radio: ".ant-radio-wrapper, .ant-radio-button-wrapper, label:has(.ant-radio), label:has(.ant-radio-button), [role='radio']",
      checkbox: ".ant-checkbox-wrapper, label:has(.ant-checkbox), [role='checkbox']",
      switch: ".ant-switch, [role='switch']",
      combobox: ".ant-select, .ant-tree-select, .ant-cascader, .ant-cascader-picker, .ant-picker",
    };
    let selector = selectorsByRole[role] || "";
    if (!selector && (kind === "comboSearchSelect" || kind === "cascaderSelect")) {
      selector = selectorsByRole.combobox;
    }
    if (!selector && (placeholder || queryText)) {
      selector = ".ant-select, .ant-tree-select, .ant-cascader, .ant-cascader-picker, .ant-picker, .ant-upload-wrapper, .ant-upload";
    }
    if (!selector) {
      return null;
    }

    const matches = Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .map((node, index) => {
        const text = textOf(node);
        const queryMatched =
          (Boolean(queryText) && includesText(text, queryText)) ||
          (Boolean(placeholder) && includesText(text, placeholder));
        if ((queryText || placeholder) && !queryMatched) {
          return null;
        }
        const near = contextMatch(node);
        if (nearText && !near.matched) {
          return null;
        }
        const rect = node.getBoundingClientRect();
        const exactBonus = normalizeComparableText(text) === normalizeComparableText(queryText) ? -200 : 0;
        return {
          node,
          index,
          text,
          score: (near.score || 0) + exactBonus + index / 1000,
          nearTextMatched: Boolean(near.matched),
          nearTextMatchMethod: near.method,
          bbox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    const selected = Number.isInteger(targetIndex) && targetIndex >= 0
      ? matches[targetIndex]
      : matches[0];
    if (!selected) {
      return {
        selector: null,
        candidateCount: matches.length,
        candidates: matches.slice(0, 8).map((item) => ({
          id: `antd-${item.index}`,
          text: item.text,
          score: item.score,
          bbox: item.bbox,
          nearTextMatched: item.nearTextMatched,
          nearTextMatchMethod: item.nearTextMatchMethod,
        })),
      };
    }
    return {
      selector: selectorFor(selected.node),
      matchedText: selected.text,
      targetSummary: {
        text: selected.text || queryText || placeholder || null,
        role: role || null,
        nearText: nearText || null,
        nearTextMatched: selected.nearTextMatched,
        nearTextMatchMethod: selected.nearTextMatchMethod,
        bbox: selected.bbox,
        candidateIndex: selected.index,
        candidateCount: matches.length,
      },
      candidates: matches.slice(0, 8).map((item) => ({
        id: `antd-${item.index}`,
        text: item.text,
        score: item.score,
        bbox: item.bbox,
        nearTextMatched: item.nearTextMatched,
        nearTextMatchMethod: item.nearTextMatchMethod,
      })),
    };
  }, {
    role,
    queryText: query,
    nearText: target.nearText || "",
    placeholder: target.placeholder || "",
    targetIndex: target.index,
    kind: action.kind,
    uiLooksAntd: isProbablyAntd(options.uiContext),
  }).catch(() => null);

  if (!result?.selector) {
    return null;
  }

  const adapterName = role ? `antd.${role}` : "antd.target";
  return {
    source: "dom",
    locator: page.locator(result.selector).first(),
    strategy: `adapter:${adapterName}`,
    confidence: 0.96,
    matchedText: result.matchedText,
    targetSummary: {
      ...result.targetSummary,
      adapter: adapterName,
      adapterReason: "antd-component-target",
    },
    locatorSummary: {
      strategy: `adapter:${adapterName}`,
      count: result.targetSummary?.candidateCount || result.candidates?.length || 1,
    },
    rankedCandidates: result.candidates || [],
    adapter: {
      name: adapterName,
      reason: "antd-component-target",
      nearTextMatched: Boolean(result.targetSummary?.nearTextMatched),
      nearTextMatchMethod: result.targetSummary?.nearTextMatchMethod || null,
    },
  };
}

async function readAntdDomState(page, expectation, context = {}) {
  const target = expectation.target || expectation.raw?.target || {};
  const property = String(expectation.property || expectation.raw?.property || "exists").trim();
  const hasTexts = []
    .concat(target.hasTexts || target.hasText || [])
    .filter(Boolean)
    .map((item) => String(item));
  const tagTexts = []
    .concat(target.tagTexts || target.tagText || [])
    .filter(Boolean)
    .map((item) => String(item));
  const result = await page.evaluate(({ target, property, visibleOnly, hasTexts, tagTexts, uiLooksAntd }) => {
    const normalizeText = (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    const normalizeComparableText = (value) =>
      normalizeText(value)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\s_-]+/g, "");
    const attrText = (el, name) => normalizeText(el?.getAttribute?.(name) || "");
    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const hasAntd = uiLooksAntd || document.querySelector("[class^='ant-'], [class*=' ant-']");
    if (!hasAntd) {
      return null;
    }
    const textOf = (el) =>
      normalizeText(
        [
          el?.innerText,
          el?.textContent,
          el?.value,
          attrText(el, "aria-label"),
          attrText(el, "title"),
          attrText(el, "placeholder"),
          attrText(el, "data-testid"),
          attrText(el, "data-test-id"),
          attrText(el, "data-cy"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    const includesText = (actual, expected) => {
      const normalizedExpected = normalizeComparableText(expected);
      if (!normalizedExpected) {
        return true;
      }
      const normalizedActual = normalizeComparableText(actual);
      if (!normalizedActual) {
        return false;
      }
      return normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual);
    };
    const contextMatch = (el, nearText) => {
      if (!nearText) {
        return { matched: false, method: null, score: 0 };
      }
      if (includesText(textOf(el), nearText)) {
        return { matched: true, method: "self", score: -1000 };
      }
      const targetRect = el.getBoundingClientRect();
      const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
      let current = el.parentElement;
      for (let depth = 1; current && current !== document.body && depth <= 10; depth += 1) {
        if (!isVisible(current)) {
          current = current.parentElement;
          continue;
        }
        const rect = current.getBoundingClientRect();
        const area = Math.max(rect.width * rect.height, 1);
        const className = String(current.getAttribute("class") || "").toLowerCase();
        const semanticContainer =
          current.getAttribute("role") === "dialog" ||
          className.includes("modal") ||
          className.includes("drawer") ||
          className.includes("popover") ||
          className.includes("popconfirm") ||
          className.includes("form") ||
          className.includes("table");
        const compactContainer =
          area <= viewportArea * 0.72 &&
          rect.width <= Math.max(targetRect.width * 20, 1080) &&
          rect.height <= Math.max(targetRect.height * 20, 760);
        if ((semanticContainer || compactContainer) && includesText(textOf(current), nearText)) {
          return {
            matched: true,
            method: semanticContainer ? `ancestor-semantic-${depth}` : `ancestor-local-${depth}`,
            score: depth * 10 + area / 100000,
          };
        }
        current = current.parentElement;
      }
      return { matched: false, method: "not-found", score: Number.POSITIVE_INFINITY };
    };
    const role = String(target.role || "").trim().toLowerCase();
    const query = target.name || target.text || target.query || target.placeholder || target.ariaLabel || target.title || "";
    const selectorsByRole = {
      radio: ".ant-radio-wrapper, .ant-radio-button-wrapper, label:has(.ant-radio), label:has(.ant-radio-button), [role='radio']",
      checkbox: ".ant-checkbox-wrapper, label:has(.ant-checkbox), [role='checkbox']",
      switch: ".ant-switch, [role='switch']",
      combobox: ".ant-select, .ant-tree-select, .ant-cascader, .ant-cascader-picker, .ant-picker",
      table: ".ant-table-row, .ant-table-tbody > tr, .ant-table",
    };
    const selectors = [];
    if (target.locator) {
      selectors.push(target.locator);
    }
    if (target.testId) {
      const escaped = CSS.escape(target.testId);
      selectors.push(`[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-cy="${escaped}"]`);
    }
    if (role && selectorsByRole[role]) {
      selectors.push(selectorsByRole[role]);
    }
    if (!selectors.length && query) {
      selectors.push(".ant-radio-wrapper, .ant-checkbox-wrapper, .ant-switch, .ant-select, .ant-cascader, .ant-picker, .ant-table-row, .ant-message-notice, .ant-notification-notice");
    }
    if (!selectors.length) {
      return null;
    }
    const rawNodes = [];
    for (const selector of selectors) {
      try {
        for (const node of document.querySelectorAll(selector)) {
          if (!rawNodes.includes(node)) {
            rawNodes.push(node);
          }
        }
      } catch (_error) {
        // Ignore unsupported user selectors here; native locator diagnostics will carry that failure.
      }
    }
    const tagSelector = ".ant-tag, .task-tag, [data-tag], [data-role='tag'], [class~='tag'], [role='status'], [role='note']";
    const tagMatch = (actual, expected) => normalizeText(actual) === normalizeText(expected);
    const collectTags = (node) => {
      const tags = Array.from(node.querySelectorAll?.(tagSelector) || []);
      if (node.matches?.(tagSelector)) {
        tags.unshift(node);
      }
      return tags.filter((tag) => !visibleOnly || isVisible(tag));
    };
    const findCheckedControl = (node) => {
      const checkedInput = node.querySelector?.("input[type='radio']:checked, input[type='checkbox']:checked");
      if (checkedInput) {
        return {
          input: checkedInput,
          wrapper:
            checkedInput.closest?.(".ant-radio-wrapper, .ant-radio-button-wrapper, .ant-checkbox-wrapper, label, [role='radio'], [role='checkbox']") ||
            checkedInput,
          source: "checked-input",
        };
      }
      const checkedWrapper = node.querySelector?.(
        ".ant-radio-wrapper-checked, .ant-radio-button-wrapper-checked, .ant-checkbox-wrapper-checked, [aria-checked='true']",
      );
      if (checkedWrapper) {
        return {
          input: checkedWrapper.querySelector?.("input, textarea, select") || null,
          wrapper: checkedWrapper,
          source: "checked-wrapper",
        };
      }
      return null;
    };
    const candidates = rawNodes
      .filter((node) => !visibleOnly || isVisible(node) || ["radio", "checkbox", "switch", "combobox"].includes(role))
      .map((node, index) => {
        const groupControl = findCheckedControl(node);
        const input = groupControl?.input || (node.matches?.("input, textarea, select")
          ? node
          : node.querySelector?.("input, textarea, select"));
        const stateNode = groupControl?.wrapper || node;
        const text = textOf(node);
        const inputText = textOf(input);
        const fullText = normalizeText(`${text} ${inputText}`);
        const queryMatched = includesText(fullText, query);
        if (query && !queryMatched) {
          return null;
        }
        if (hasTexts.length && !hasTexts.every((item) => includesText(fullText, item))) {
          return null;
        }
        const tags = collectTags(node);
        if (tagTexts.length && !tagTexts.every((item) => tags.some((tag) => tagMatch(textOf(tag), item)))) {
          return null;
        }
        const near = contextMatch(node, target.nearText || "");
        if (target.nearText && !near.matched) {
          return null;
        }
        const className = String(stateNode.getAttribute("class") || "");
        const inputClassName = String(input?.getAttribute?.("class") || "");
        const selectedItem = node.querySelector?.(".ant-select-selection-item, .ant-cascader-picker-label, .ant-picker-input input");
        const isAntdTabActive = /\bant-tabs-tab-active\b/.test(className);
        const stateSource =
          groupControl ? groupControl.source :
          input ? "input" :
          className.includes("-checked") || className.includes("-selected") || isAntdTabActive ? "class" :
          selectedItem ? "selection" :
          "wrapper";
        const value = input?.value ?? selectedItem?.value ?? textOf(selectedItem) ?? attrText(node, "value") ?? "";
        const checked = Boolean(
          input?.checked ||
          stateNode.getAttribute("aria-checked") === "true" ||
          input?.getAttribute?.("aria-checked") === "true" ||
          className.includes("ant-radio-wrapper-checked") ||
          className.includes("ant-radio-button-wrapper-checked") ||
          className.includes("ant-checkbox-wrapper-checked") ||
          className.includes("ant-switch-checked") ||
          inputClassName.includes("ant-radio-checked") ||
          inputClassName.includes("ant-checkbox-checked")
        );
        const disabled = Boolean(
          input?.disabled ||
          stateNode.hasAttribute("disabled") ||
          stateNode.getAttribute("aria-disabled") === "true" ||
          className.includes("-disabled")
        );
        const selected = Boolean(
          stateNode.getAttribute("aria-selected") === "true" ||
          className.includes("-selected") ||
          isAntdTabActive
        );
        const rect = node.getBoundingClientRect();
        return {
          node,
          input,
          index,
          text,
          fullText,
          value,
          checked,
          disabled,
          selected,
          className,
          stateSource,
          near,
          bbox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.near.score || 0) - (b.near.score || 0) || a.index - b.index);
    const first = candidates[0] || null;
    const state = {
      count: candidates.length,
      exists: candidates.length > 0,
      visible: first ? isVisible(first.node) : false,
      text: first ? first.text.trim() : "",
      value: first ? first.value ?? "" : "",
      checked: first ? first.checked : false,
      disabled: first ? first.disabled : false,
      selected: first ? first.selected : false,
      attribute: first && (target.attribute || target.attributeName) ? first.node.getAttribute(target.attribute || target.attributeName) : null,
      class: first ? first.className : "",
      samples: candidates.slice(0, 5).map((item) => ({
        text: item.text.slice(0, 300),
        value: item.value ?? "",
        className: item.className,
        stateSource: item.stateSource,
        checked: item.checked,
        nearTextMatched: Boolean(item.near.matched),
        nearTextMatchMethod: item.near.method,
      })),
      adapter: "antd",
      stateSource: first?.stateSource || null,
      matchedWrapper: first ? {
        text: first.text.slice(0, 300),
        className: first.className,
        bbox: first.bbox,
      } : null,
      matchedInput: first?.input ? {
        type: first.input.getAttribute("type") || null,
        value: first.input.value || "",
        checked: Boolean(first.input.checked),
        disabled: Boolean(first.input.disabled),
        className: first.input.getAttribute("class") || "",
      } : null,
      nearTextMatched: Boolean(first?.near?.matched),
      nearTextMatchMethod: first?.near?.method || null,
    };
    state.actual = state[property];
    return {
      state,
      diagnostics: {
        adapter: role ? `antd.${role}` : "antd",
        adapterReason: "antd-dom-state-reader",
        adapterCandidateCount: candidates.length,
        stateSource: state.stateSource,
        topCandidates: state.samples,
        matchedWrapper: state.matchedWrapper,
        matchedInput: state.matchedInput,
        nearTextMatched: state.nearTextMatched,
        nearTextMatchMethod: state.nearTextMatchMethod,
      },
    };
  }, {
    target,
    property,
    visibleOnly: expectation.visibleOnly !== false && expectation.raw?.visibleOnly !== false,
    hasTexts,
    tagTexts,
    uiLooksAntd: isProbablyAntd(context.uiContext),
  }).catch(() => null);

  return result;
}

module.exports = {
  resolveAntdActionTarget,
  readAntdDomState,
};
