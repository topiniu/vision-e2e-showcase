import { useCallback, useEffect, useRef, useState } from "react";

function normalizeLayout(value, fallback) {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const next = {};
  for (const key of Object.keys(fallback)) {
    const size = Number(value[key]);
    next[key] = Number.isFinite(size) && size > 0 ? size : fallback[key];
  }
  return next;
}

function readStoredLayout(storageKey, fallback) {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    return normalizeLayout(JSON.parse(window.localStorage.getItem(storageKey) || "null"), fallback);
  } catch (_error) {
    return fallback;
  }
}

export function usePersistedPanelLayout(storageKey, fallback) {
  const [layout, setLayout] = useState(() => readStoredLayout(storageKey, fallback));
  const commitTimerRef = useRef(null);
  const latestLayoutRef = useRef(layout);

  useEffect(
    () => () => {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
      }
    },
    [],
  );

  const handleLayoutChanged = useCallback(
    (nextLayout) => {
      const normalizedLayout = normalizeLayout(nextLayout, fallback);
      latestLayoutRef.current = normalizedLayout;
      // Perf: the resizable primitive drives the visual resize itself (panels are
      // uncontrolled via defaultSize), so this state/localStorage write is only
      // for persistence. onLayoutChanged fires on every pointermove tick; a
      // per-tick setState would re-render the whole workspace and hit localStorage
      // each pixel. Debounce to a single trailing commit after the drag settles.
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
      }
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = null;
        setLayout(latestLayoutRef.current);
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(latestLayoutRef.current));
        } catch (_error) {
          // Layout persistence is a convenience; resizing still works without storage.
        }
      }, 180);
    },
    [fallback, storageKey],
  );

  return [layout, handleLayoutChanged];
}
