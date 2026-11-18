"use strict";


function hasAuthEvidence(storageState) {
  if (!storageState || typeof storageState !== "object" || Array.isArray(storageState)) {
    return false;
  }
  const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
  if (cookies.some((cookie) => String(cookie?.value || "").trim())) {
    return true;
  }
  const origins = Array.isArray(storageState.origins) ? storageState.origins : [];
  return origins.some((origin) =>
    (origin?.localStorage || []).some((item) => {
      const name = String(item?.name || "").toLowerCase();
      const value = String(item?.value || "").trim();
      return Boolean(value) && (
        name.includes("token") ||
        name.includes("auth") ||
        name.includes("session") ||
        name.includes("user")
      );
    }),
  );
}

module.exports = { hasAuthEvidence };
