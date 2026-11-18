const { withProbeTimeout } = require("./hard-timeout");

async function detectUiFrameworks(page) {
  const fallback = {
    antd: {
      detected: false,
      confidence: 0,
      versionHint: null,
      components: [],
      signals: {},
    },
  };

  if (!page) {
    return fallback;
  }

  // REQ-Z12: hard-bounded — a framework probe is best-effort telemetry and must
  // never park a step on a wedged renderer (`page.evaluate` has no timeout).
  return withProbeTimeout(() => page.evaluate(() => {
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch (_error) {
        return 0;
      }
    };
    const scriptsAndStyles = Array.from(document.querySelectorAll("script[src], link[href]"))
      .map((node) => node.getAttribute("src") || node.getAttribute("href") || "")
      .filter(Boolean);
    const components = [];
    const addComponent = (name, selector) => {
      const value = count(selector);
      if (value > 0) {
        components.push(name);
      }
      return value;
    };

    const signals = {
      antClass: count("[class^='ant-'], [class*=' ant-']"),
      modal: addComponent("modal", ".ant-modal-root, .ant-modal, .ant-modal-content"),
      drawer: addComponent("drawer", ".ant-drawer, .ant-drawer-content"),
      radio: addComponent("radio", ".ant-radio, .ant-radio-wrapper"),
      checkbox: addComponent("checkbox", ".ant-checkbox, .ant-checkbox-wrapper"),
      switch: addComponent("switch", ".ant-switch"),
      select: addComponent("select", ".ant-select, .ant-select-dropdown"),
      treeSelect: addComponent("treeSelect", ".ant-tree-select, .ant-select-tree"),
      cascader: addComponent("cascader", ".ant-cascader, .ant-cascader-dropdown, .ant-cascader-menus"),
      picker: addComponent("picker", ".ant-picker, .ant-picker-dropdown"),
      table: addComponent("table", ".ant-table, .ant-table-wrapper"),
      upload: addComponent("upload", ".ant-upload, .ant-upload-wrapper"),
      message: addComponent("message", ".ant-message, .ant-message-notice"),
      notification: addComponent("notification", ".ant-notification, .ant-notification-notice"),
      popover: addComponent("popover", ".ant-popover, .ant-popconfirm"),
      cssOrScript: scriptsAndStyles.filter((value) => /antd|ant-design|ant\.css|ant-design-vue/i.test(value)).length,
    };

    const score =
      Math.min(signals.antClass, 30) * 0.018 +
      components.length * 0.08 +
      Math.min(signals.cssOrScript, 3) * 0.12;
    const confidence = Math.max(0, Math.min(0.98, score));
    const versionHint =
      window.antd?.version ||
      window.ANTD_VERSION ||
      window.__ANT_DESIGN_VERSION__ ||
      null;

    return {
      antd: {
        detected: confidence >= 0.18 || signals.antClass >= 3 || components.length >= 2,
        confidence,
        versionHint,
        components: Array.from(new Set(components)),
        signals,
      },
    };
  }), { label: "detectUiFrameworks(page.evaluate)" }).catch(() => fallback);
}

module.exports = {
  detectUiFrameworks,
};
