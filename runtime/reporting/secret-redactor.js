"use strict";


const MASK = "***";
// Shorter values would turn ordinary text into confetti ("1" inside every id).
const MIN_SECRET_LENGTH = 3;

function createSecretRedactor(values = []) {
  const secrets = [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => (value == null ? "" : String(value)))
      .filter((value) => value.length >= MIN_SECRET_LENGTH),
  )].sort((a, b) => b.length - a.length);

  if (!secrets.length) {
    return { active: false, count: 0, redact: (value) => value, redactString: (value) => value };
  }

  const redactString = (text) => {
    let next = text;
    for (const secret of secrets) {
      if (next.includes(secret)) {
        next = next.split(secret).join(MASK);
      }
    }
    return next;
  };

  const redact = (value, seen = new WeakMap()) => {
    if (typeof value === "string") {
      return redactString(value);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    // Binary payloads (screenshots) are not text; leave them alone.
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (Array.isArray(value)) {
      const copy = [];
      seen.set(value, copy);
      for (const item of value) {
        copy.push(redact(item, seen));
      }
      return copy;
    }
    if (value instanceof Date) {
      return value;
    }
    const copy = {};
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      copy[key] = redact(item, seen);
    }
    return copy;
  };

  return { active: true, count: secrets.length, redact: (value) => redact(value), redactString };
}

module.exports = {
  MASK,
  createSecretRedactor,
};
