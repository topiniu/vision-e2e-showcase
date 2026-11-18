const {
  resolveAntdActionTarget,
  readAntdDomState,
} = require("./antd");

async function resolveActionTargetWithAdapters(page, action, options = {}) {
  const antd = await resolveAntdActionTarget(page, action, options);
  if (antd) {
    return antd;
  }
  return null;
}

async function readDomStateWithAdapters(page, expectation, context = {}) {
  const antd = await readAntdDomState(page, expectation, context);
  if (antd) {
    return antd;
  }
  return null;
}

module.exports = {
  resolveActionTargetWithAdapters,
  readDomStateWithAdapters,
};
