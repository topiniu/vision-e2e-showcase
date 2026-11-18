export function retainEvidenceImageCache(cache = {}, activePaths = []) {
  const next = {};
  const uniquePaths = new Set(activePaths.filter(Boolean));

  uniquePaths.forEach((imagePath) => {
    if (cache[imagePath]) {
      next[imagePath] = cache[imagePath];
    }
  });

  const currentKeys = Object.keys(cache);
  const nextKeys = Object.keys(next);
  if (
    currentKeys.length === nextKeys.length
    && nextKeys.every((imagePath) => cache[imagePath] === next[imagePath])
  ) {
    return cache;
  }
  return next;
}
