const DEFAULT_FRAME_WIDTH = 1280;
const DEFAULT_FRAME_HEIGHT = 720;
const MATCH_TIER_EXACT = 0;
const MATCH_TIER_CONTAINS = 1;
const MATCH_TIER_FUZZY = 2;
const MATCH_TIER_FALLBACK = 3;

const normalize = (value) =>
  typeof value === 'string'
    ? value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\s_-]+/g, '')
    : '';

const collapseWhitespace = (value) =>
  typeof value === 'string'
    ? value
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    : '';

const levenshtein = (aRaw, bRaw) => {
  const a = normalize(aRaw);
  const b = normalize(bRaw);
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1,
        );
      }
    }
  }
  return matrix[a.length][b.length];
};

const similarity = (a, b) => {
  const normA = normalize(a);
  const normB = normalize(b);
  if (!normA.length && !normB.length) {
    return 1;
  }
  if (!normA.length || !normB.length) {
    return 0;
  }
  if (normA === normB) {
    return 1;
  }
  const distance = levenshtein(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  return maxLen > 0 ? 1 - distance / maxLen : 0;
};

const SYNONYM_GROUPS = [
  {
    category: 'submit',
    terms: [
      'login',
      'log in',
      'log-on',
      'log on',
      'log-on',
      'sign in',
      'signin',
      'sign-in',
      'submit',
      'confirm',
      'go',
      'enter',
      '继续',
      '提交',
      '登录',
      '登入',
      '登陆',
      '确定',
      '确认',
      '下一步',
      '登录系统',
      'signon',
    ],
  },
  {
    category: 'username',
    terms: [
      'username',
      'user name',
      'account',
      'account name',
      'email',
      'email address',
      '邮箱',
      '账号',
      '账户',
      '用戶名',
      '用户名',
      '手机号',
      '手机号码',
      'mobile',
      'mobile number',
      'phone',
      'phone number',
      'login id',
      'login name',
      'member id',
    ],
  },
  {
    category: 'password',
    terms: [
      'password',
      'passwd',
      'passcode',
      'pwd',
      'secret',
      'pin',
      'passwords',
      '密码',
      '密碼',
      '登录密码',
      '登陆密码',
    ],
  },
];

const SYNONYM_LOOKUP = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group.terms) {
      map.set(normalize(term), { category: group.category, term });
    }
  }
  return map;
})();

const resolveCategoriesFromQuery = (variants) => {
  const categories = new Set();
  variants.forEach((variant) => {
    const lookup = SYNONYM_LOOKUP.get(normalize(variant));
    if (lookup?.category) {
      categories.add(lookup.category);
    }
  });
  return categories;
};

const expandQuery = (query, extras = []) => {
  const parts = [];
  const push = (value) => {
    const trimmed = collapseWhitespace(value);
    if (trimmed && !parts.includes(trimmed)) {
      parts.push(trimmed);
    }
  };

  if (Array.isArray(query)) {
    query.forEach((item) => push(item));
  } else if (typeof query === 'string') {
    query
      .split(/[\/|,;]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => push(part));
  }

  extras
    .map((part) => collapseWhitespace(part))
    .filter(Boolean)
    .forEach((part) => push(part));

  return parts;
};

const evaluatePositionPrior = (category, bbox, frameWidth, frameHeight) => {
  if (!bbox || !Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) || frameWidth <= 0 || frameHeight <= 0) {
    return { boost: 0, tags: [] };
  }
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const relX = centerX / frameWidth;
  const relY = centerY / frameHeight;
  const tags = [];
  let boost = 0;

  if (category === 'submit') {
    if (relY >= 0.55) {
      boost += 0.06;
      tags.push('position_prior:lower-half');
    }
    if (relX >= 0.25 && relX <= 0.75) {
      boost += 0.02;
      tags.push('position_prior:centered');
    }
  } else if (category === 'username') {
    if (relY <= 0.45) {
      boost += 0.05;
      tags.push('position_prior:upper-half');
    }
    if (relX >= 0.15 && relX <= 0.75) {
      boost += 0.01;
      tags.push('position_prior:form-lane');
    }
  } else if (category === 'password') {
    if (relY >= 0.35 && relY <= 0.65) {
      boost += 0.05;
      tags.push('position_prior:mid-field');
    }
  }

  return { boost, tags };
};

const buildCandidate = ({
  detection,
  variants,
  categories,
  frameWidth,
  frameHeight,
}) => {
  const rawText = collapseWhitespace(detection?.text);
  if (!rawText) {
    return null;
  }
  const normText = normalize(rawText);
  if (!normText) {
    return null;
  }

  let bestScore = 0;
  let bestTier = MATCH_TIER_FALLBACK;
  let hasMatch = false;
  const reasons = [];
  const matchedCategories = new Set();

  const applyMatch = (tier, score, reason) => {
    hasMatch = true;
    if (tier < bestTier) {
      bestTier = tier;
    }
    if (score > bestScore) {
      bestScore = score;
    }
    if (reason && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  for (const variant of variants) {
    const normVariant = normalize(variant);
    if (!normVariant) {
      continue;
    }

    if (normText === normVariant) {
      applyMatch(MATCH_TIER_EXACT, 0.98, `text_exact:"${variant}"`);
    } else if (normText.includes(normVariant)) {
      applyMatch(MATCH_TIER_CONTAINS, 0.92, `text_contains:"${variant}"`);
    } else {
      const score = similarity(normText, normVariant);
      if (score >= 0.78) {
        const blended = 0.75 + (score - 0.78) * 0.4;
        applyMatch(
          MATCH_TIER_FUZZY,
          blended,
          `text_fuzzy:"${rawText}"≈"${variant}"(${score.toFixed(2)})`,
        );
      }
    }

    const synonym = SYNONYM_LOOKUP.get(normVariant);
    if (synonym?.category) {
      matchedCategories.add(synonym.category);
      if (!reasons.includes(`intent_hint:${synonym.category}:${variant}`)) {
        reasons.push(`intent_hint:${synonym.category}:${variant}`);
      }
    }
  }

  const synonymDirect = SYNONYM_LOOKUP.get(normText);
  if (synonymDirect?.category && categories.has(synonymDirect.category)) {
    matchedCategories.add(synonymDirect.category);
    applyMatch(
      MATCH_TIER_FUZZY,
      0.9,
      `synonym_match:${synonymDirect.category}:${synonymDirect.term}`,
    );
  }

  categories.forEach((category) => matchedCategories.add(category));

  let positionBoost = 0;
  const positionTags = [];
  matchedCategories.forEach((category) => {
    const { boost, tags } = evaluatePositionPrior(
      category,
      detection?.bbox,
      frameWidth,
      frameHeight,
    );
    if (boost > 0) {
      positionBoost += boost;
      positionTags.push(...tags);
    }
  });

  if (positionBoost > 0) {
    for (const tag of positionTags) {
      if (!reasons.includes(tag)) {
        reasons.push(tag);
      }
    }
  }

  if (!hasMatch && positionBoost <= 0) {
    return null;
  }

  const detectionScore = Number.isFinite(detection?.score)
    ? detection.score
    : null;
  const confidence = Number.isFinite(detection?.extras?.confidence)
    ? detection.extras.confidence
    : null;

  const finalScore = Math.min(
    1,
    bestScore + positionBoost + (detectionScore ? detectionScore * 0.05 : 0),
  );

  return {
    text: rawText,
    bbox: detection?.bbox ?? null,
      detectionScore,
      confidence,
      matchBasis: Array.from(new Set(reasons)),
      score: finalScore,
      categories: Array.from(matchedCategories),
      matchTier: hasMatch ? bestTier : MATCH_TIER_FALLBACK,
      source: detection?.extras?.source ?? detection?.extras?.backend ?? null,
      detection,
    };
};

const buildSemanticMatches = ({
  query,
  extraHints = [],
  detections = [],
  frameSize = {},
}) => {
  const variants = expandQuery(query, extraHints);
  if (!variants.length || !Array.isArray(detections) || !detections.length) {
    return [];
  }
  const frameWidth =
    Number.isFinite(frameSize?.width) && frameSize.width > 0
      ? frameSize.width
      : DEFAULT_FRAME_WIDTH;
  const frameHeight =
    Number.isFinite(frameSize?.height) && frameSize.height > 0
      ? frameSize.height
      : DEFAULT_FRAME_HEIGHT;
  const categories = resolveCategoriesFromQuery(variants);

  const candidates = detections
    .map((detection) =>
      buildCandidate({
        detection,
        variants,
        categories,
        frameWidth,
        frameHeight,
      }),
    )
    .filter(Boolean);

  candidates.sort((a, b) => {
    if ((a.matchTier ?? MATCH_TIER_FALLBACK) !== (b.matchTier ?? MATCH_TIER_FALLBACK)) {
      return (a.matchTier ?? MATCH_TIER_FALLBACK) - (b.matchTier ?? MATCH_TIER_FALLBACK);
    }
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return candidates;
};

module.exports = {
  buildSemanticMatches,
  expandQuery,
  similarity,
  normalize,
};
