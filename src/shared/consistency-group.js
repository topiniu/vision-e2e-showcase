"use strict";


const PROBE_SLOT_PREFIX = "zjProbe";

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Slot names must satisfy the runtime-variable rule `^[A-Za-z][A-Za-z0-9_-]*$`
// (so no leading underscore and no dots), otherwise `setRuntimeVariable` throws
// and the probe silently captures nothing — which would make the consistency
// check compare four empty strings and pass.
function probeSlotName(index, capture) {
  const safeCapture = String(capture || "value").replace(/[^A-Za-z0-9_-]/g, "");
  return `${PROBE_SLOT_PREFIX}${index}_${safeCapture || "value"}`;
}

// Rewrite every capture binding inside a probe step so it lands in that probe's
// own slot. Handles both authoring shapes (`step.saveAs`, `expectation.saveAs`,
// and `expectation.body[].saveAs`).
function rewriteCaptures(step, index, capture) {
  const clone = JSON.parse(JSON.stringify(step));
  const slot = probeSlotName(index, capture);
  const rewrite = (holder) => {
    if (!holder || typeof holder !== "object") {
      return;
    }
    if (trimText(holder.saveAs) === capture) {
      holder.saveAs = slot;
    }
    if (Array.isArray(holder.body)) {
      holder.body.forEach(rewrite);
    }
    if (Array.isArray(holder.assertions)) {
      holder.assertions.forEach(rewrite);
    }
    if (holder.expectation && typeof holder.expectation === "object") {
      rewrite(holder.expectation);
    }
  };
  rewrite(clone);
  return clone;
}

function normalizeProbes(group = {}) {
  const probes = Array.isArray(group.probes) ? group.probes : [];
  return probes
    .map((probe, index) => ({
      index,
      name: trimText(probe?.name) || `入口 ${index + 1}`,
      capture: trimText(probe?.capture) || trimText(group.capture) || "value",
      steps: Array.isArray(probe?.steps) ? probe.steps : [],
      // A probe may legitimately be unreachable in some states; declaring it
      // optional is how an author says "skip rather than block".
      optional: probe?.optional === true,
    }))
    .filter((probe) => probe.steps.length);
}

function hasConsistencyGroup(caseItem = {}) {
  const group = caseItem?.consistencyGroup;
  return Boolean(group && typeof group === "object" && Array.isArray(group.probes) && group.probes.length);
}

// Expand a case's consistencyGroup into ordinary steps + one comparison step.
// `caseItem.steps` (if any) run first: they are the shared setup that puts the
// data in place before every entry point is probed.
function expandConsistencyGroup(caseItem = {}) {
  const group = caseItem.consistencyGroup;
  const probes = normalizeProbes(group);
  if (!probes.length) {
    return [];
  }
  const steps = [];
  for (const probe of probes) {
    probe.steps.forEach((step, stepIndex) => {
      const rewritten = rewriteCaptures(step, probe.index, probe.capture);
      steps.push({
        ...rewritten,
        id: rewritten.id || `probe-${probe.index + 1}-step-${stepIndex + 1}`,
        stepTitle: rewritten.stepTitle || rewritten.title || `${probe.name}：第 ${stepIndex + 1} 步`,
        sourceProbe: probe.name,
      });
    });
  }
  steps.push({
    id: `consistency-${trimText(group.id) || "check"}`,
    type: "assertConsistency",
    stepTitle: `assert 各入口一致：${trimText(group.subject) || "同一份数据"}`,
    subject: trimText(group.subject) || "同一份数据",
    probes: probes.map((probe) => ({
      name: probe.name,
      slot: probeSlotName(probe.index, probe.capture),
      capture: probe.capture,
      optional: probe.optional,
    })),
    expectation: {
      kind: "assertConsistency",
      allEqual: group.expectation?.allEqual !== false,
      normalize: group.expectation?.normalize ?? "trim",
      subject: trimText(group.subject) || "同一份数据",
      probes: probes.map((probe) => ({
        name: probe.name,
        slot: probeSlotName(probe.index, probe.capture),
        optional: probe.optional,
      })),
    },
  });
  return steps;
}

module.exports = {
  PROBE_SLOT_PREFIX,
  expandConsistencyGroup,
  hasConsistencyGroup,
  normalizeProbes,
  probeSlotName,
  rewriteCaptures,
};
