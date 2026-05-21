// storage.js — local-only reading pattern tracker.
// All data stays in chrome.storage.local on this device. Never transmitted.
//
// Loaded as a classic script. In the background service worker it's pulled in
// via importScripts() after sources.js, so it can reference the SOURCES,
// SECTOR_KEYWORDS, and REGION_COUNTRIES globals declared there.

(() => {
  const HISTORY_KEY = 'gs_history';
  const HISTORY_MAX = 500;

  // ── Lazy lookups built from sources.js globals ──────────────

  let sourceByDomain = null;
  function buildSourceIndex() {
    if (sourceByDomain) return sourceByDomain;
    sourceByDomain = new Map();
    if (typeof SOURCES !== 'object' || !SOURCES) return sourceByDomain;

    for (const regionKey of Object.keys(SOURCES)) {
      for (const src of SOURCES[regionKey] || []) {
        try {
          const host = new URL(src.rssUrl).hostname.replace(/^www\./, '').toLowerCase();
          // Prefer the first registration; don't overwrite if multiple feeds
          // share a host (e.g. dawn.com home + dawn.com opinion).
          if (!sourceByDomain.has(host)) {
            sourceByDomain.set(host, {
              name: src.name,
              tier: src.tier,
              region: src.region,
              country: (src.country && src.country[0]) || null
            });
          }
        } catch (_) { /* bad URL in sources.js — skip */ }
      }
    }
    return sourceByDomain;
  }

  function detectTier(domain) {
    if (!domain) return null;
    const index = buildSourceIndex();
    const host = String(domain).replace(/^www\./, '').toLowerCase();

    // Exact match first, then parent-domain fallback (e.g. edition.cnn.com → cnn.com).
    if (index.has(host)) return index.get(host);
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (index.has(candidate)) return index.get(candidate);
    }
    return null;
  }

  // ── Region detection against REGION_COUNTRIES keyword lists ──

  function detectRegion(text) {
    if (typeof REGION_COUNTRIES !== 'object' || !REGION_COUNTRIES) return null;
    const hay = (text || '').toLowerCase();
    if (!hay) return null;

    let best = null;
    let bestScore = 0;
    for (const region of Object.keys(REGION_COUNTRIES)) {
      if (region === 'global') continue;
      const keywords = REGION_COUNTRIES[region] || [];
      let score = 0;
      for (const kw of keywords) {
        const needle = kw.toLowerCase();
        if (needle && hay.includes(needle)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = region;
      }
    }
    return bestScore >= 1 ? best : null;
  }

  // ── Sector detection against SECTOR_KEYWORDS ──────────────────

  function detectSector(text) {
    if (typeof SECTOR_KEYWORDS !== 'object' || !SECTOR_KEYWORDS) return [];
    const hay = (text || '').toLowerCase();
    if (!hay) return [];

    const scores = [];
    for (const sector of Object.keys(SECTOR_KEYWORDS)) {
      const keywords = SECTOR_KEYWORDS[sector] || [];
      let score = 0;
      for (const kw of keywords) {
        const needle = kw.toLowerCase();
        if (needle && hay.includes(needle)) {
          // Multi-word phrases are stronger signals than single words.
          score += needle.includes(' ') ? 2 : 1;
        }
      }
      if (score > 0) scores.push({ sector, score });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, 3).map(s => s.sector);
  }

  // ── chrome.storage wrappers ───────────────────────────────────

  async function getAll(key) {
    const out = await chrome.storage.local.get(key);
    return out[key];
  }

  async function setAll(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  async function getHistory() {
    return (await getAll(HISTORY_KEY)) || [];
  }

  async function clearHistory() {
    await chrome.storage.local.remove(HISTORY_KEY);
  }

  // ── Log one article view ──────────────────────────────────────
  //
  // Called from background.js every time an article is analysed.
  // Never transmits anywhere — just appends to chrome.storage.local.
  async function logArticleView(article) {
    if (!article || !article.title) return;

    const domain = (article.source || (() => {
      try { return new URL(article.url).hostname.replace(/^www\./, ''); }
      catch { return ''; }
    })()).toLowerCase();

    const haystack = `${article.title}\n${(article.text || '').slice(0, 4000)}`;
    const sourceMeta = detectTier(domain);

    const entry = {
      title: article.title,
      url: article.url || '',
      domain,
      region: detectRegion(haystack),
      sectors: detectSector(haystack),
      sourceTier: sourceMeta ? sourceMeta.tier : null,
      sourceName: sourceMeta ? sourceMeta.name : null,
      timestamp: Date.now()
    };

    const history = await getHistory();
    history.push(entry);
    // Cap the log so storage.local stays under its quota.
    const trimmed = history.length > HISTORY_MAX
      ? history.slice(history.length - HISTORY_MAX)
      : history;
    await setAll(HISTORY_KEY, trimmed);
    return entry;
  }

  globalThis.GeoSignalStorage = {
    logArticleView,
    getHistory,
    clearHistory,
    detectRegion,
    detectSector,
    detectTier
  };
})();
