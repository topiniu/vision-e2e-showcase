const testFileCollator = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

function getSortText(value) {
  return String(value || "").trim();
}

function compareTestFileItems(left, right) {
  const groupOrder = testFileCollator.compare(getSortText(left?.group), getSortText(right?.group));
  if (groupOrder !== 0) {
    return groupOrder;
  }

  const nameOrder = testFileCollator.compare(getSortText(left?.name), getSortText(right?.name));
  if (nameOrder !== 0) {
    return nameOrder;
  }

  return testFileCollator.compare(getSortText(left?.path), getSortText(right?.path));
}

module.exports = {
  compareTestFileItems,
};
