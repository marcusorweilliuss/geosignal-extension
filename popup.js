// popup.js — onboarding wizard, insights dashboard, and Feed tab.
// Reads/writes chrome.storage.local directly. NewsAPI is the only network
// call, and only when the Feed tab is active.

const PROFILE_KEY = 'gs_profile';
const ONBOARDED_KEY = 'gs_onboarded';
const HISTORY_KEY = 'gs_history';
const FEED_CACHE_KEY = 'gs_feed_cache';
const FEED_FILTERS_KEY = 'gs_feed_filters';
const FEED_CACHE_TTL = 10 * 60 * 1000; // 10 min

// GeoSignal web app — Clerk session lives here; cookie sync target.
const GEOSIGNAL_WEB_URL = 'https://geosignal-6ics.onrender.com';

const SECTORS = [
  'Geopolitics', 'Economy & Trade', 'Technology & AI', 'Climate & Energy',
  'Defence & Security', 'Society & Culture', 'Space & Frontier', 'Health & Biotech'
];
const SOURCE_TIERS = [
  { key: 'mainstream', label: 'Mainstream' },
  { key: 'independent-left', label: 'Indep. Left' },
  { key: 'independent-right', label: 'Indep. Right' },
  { key: 'business', label: 'Business' },
  { key: 'regional', label: 'Regional' },
  { key: 'think-tank-academic', label: 'Think Tank' },
  { key: 'government-official', label: 'Government' }
];

const REGION_LABELS = {
  'south-asia': 'South Asia',
  'north-america': 'North America',
  'latin-america': 'Latin America',
  'central-asia-caucasus': 'Central Asia & Caucasus',
  'middle-east': 'Middle East',
  'europe': 'Europe',
  'africa': 'Africa',
  'southeast-asia': 'Southeast Asia',
  'east-asia': 'East Asia',
  'oceania': 'Oceania',
  'global': 'Global'
};

// ── Boot ──

document.addEventListener('DOMContentLoaded', async () => {
  // Auth row is independent of onboarding — render it every open.
  initAuthRow();

  // Check if this is the very first time the extension is opened.
  const { gs_first_install_seen } = await chrome.storage.local.get('gs_first_install_seen');

  // Check if current tab is on a qualifying page.
  let pageActive = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const resp = await chrome.runtime.sendMessage({ type: 'GEOSIGNAL_IS_PAGE_ACTIVE', tabId: tab.id });
      pageActive = resp?.active ?? true;
    }
  } catch {}

  const state = await chrome.storage.local.get([
    ONBOARDED_KEY, PROFILE_KEY, 'groqApiKey', 'newsApiKey', HISTORY_KEY
  ]);

  // Show first-install overlay on very first open.
  if (!gs_first_install_seen) {
    document.getElementById('first-install').classList.remove('hidden');
    document.getElementById('dismiss-first-install').addEventListener('click', async () => {
      await chrome.storage.local.set({ gs_first_install_seen: true });
      document.getElementById('first-install').classList.add('hidden');
      // Proceed to onboarding or insights.
      if (!state[ONBOARDED_KEY]) {
        startOnboarding(state);
      } else {
        showMainView(state, pageActive);
      }
    });
    return;
  }

  if (!state[ONBOARDED_KEY]) {
    startOnboarding(state);
  } else {
    showMainView(state, pageActive);
  }
});

// ── Auth (Clerk session bridge with web app) ──
// We can't run Clerk's JS SDK inside the popup (CSP + no bundler), so we
// read the __session cookie that Clerk sets on the geosignal-6ics domain.
// Presence = signed in on the web app. To sign out, the user does it on
// the web app — we just reflect what the cookie says.

async function readClerkSession() {
  try {
    // __session is short-lived; __client persists across refreshes. Either
    // one being present indicates an active Clerk session.
    const [session, client] = await Promise.all([
      chrome.cookies.get({ url: GEOSIGNAL_WEB_URL, name: '__session' }),
      chrome.cookies.get({ url: GEOSIGNAL_WEB_URL, name: '__client' })
    ]);
    const token = session?.value || '';
    const signedIn = !!(token || client?.value);
    // Decode the JWT payload only to surface user-friendly identity bits.
    // No signature check — this is display-only; server still verifies.
    let userId = '';
    if (token && token.split('.').length === 3) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        userId = payload.sub || '';
      } catch {}
    }
    return { signedIn, token, userId };
  } catch (err) {
    console.warn('[GeoSignal] cookie read failed:', err.message);
    return { signedIn: false, token: '', userId: '' };
  }
}

async function initAuthRow() {
  const statusEl = document.getElementById('auth-status');
  const actionEl = document.getElementById('auth-action');
  if (!statusEl || !actionEl) return;

  const { signedIn, userId } = await readClerkSession();

  if (signedIn) {
    statusEl.textContent = userId
      ? `Signed in · ${userId.slice(0, 12)}…`
      : 'Signed in';
    statusEl.classList.add('signed-in');
    actionEl.textContent = 'Manage';
    actionEl.classList.remove('hidden');
    actionEl.onclick = () => chrome.tabs.create({ url: GEOSIGNAL_WEB_URL });
    await chrome.storage.local.set({ gs_signed_in: true });
  } else {
    statusEl.textContent = 'Not signed in';
    statusEl.classList.remove('signed-in');
    actionEl.textContent = 'Sign in';
    actionEl.classList.remove('hidden');
    actionEl.onclick = () => chrome.tabs.create({ url: GEOSIGNAL_WEB_URL });
    await chrome.storage.local.set({ gs_signed_in: false });
  }
}

function showMainView(state, pageActive) {
  document.getElementById('tabs').classList.remove('hidden');
  document.getElementById('edit-profile-top').classList.remove('hidden');
  if (!pageActive) {
    document.getElementById('inactive-msg').classList.remove('hidden');
    document.getElementById('insights').classList.add('hidden');
    document.getElementById('feed').classList.add('hidden');
  }
  showInsights(state);
  initFeedTab();
  wireTabs();
  wireEditProfileButton();
}

// ── Tab switching ──

function wireTabs() {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b === btn);
      document.getElementById('inactive-msg').classList.add('hidden');
      document.getElementById('insights').classList.toggle('hidden', tab !== 'insights');
      document.getElementById('feed').classList.toggle('hidden', tab !== 'feed');
    });
  }
}

// ── Onboarding / Profile editing ──

const DEFAULT_PROFILE = {
  occupation: '',
  sectors: ['Geopolitics'],
  sector: 'Geopolitics', // backwards compat — primary sector
  company: '',
  country: 'Global',
  concern: ''
};

function getSelectedSectors() {
  const checks = document.querySelectorAll('#sector-checks input[type="checkbox"]');
  return [...checks].filter(c => c.checked).map(c => c.value);
}

function setSelectedSectors(sectors) {
  const arr = Array.isArray(sectors) ? sectors : (sectors ? [sectors] : []);
  const checks = document.querySelectorAll('#sector-checks input[type="checkbox"]');
  for (const c of checks) c.checked = arr.includes(c.value);
}

function populateProfileForm(p) {
  if (p.occupation) document.getElementById('occupation').value = p.occupation;
  if (p.company) document.getElementById('company').value = p.company;
  if (p.country) document.getElementById('country').value = p.country;
  if (p.concern) document.getElementById('concern').value = p.concern;
  setSelectedSectors(p.sectors || p.sector || []);
}

function collectProfile() {
  const sectors = getSelectedSectors();
  return {
    occupation: document.getElementById('occupation').value.trim(),
    company: document.getElementById('company').value.trim(),
    sectors: sectors.length > 0 ? sectors : DEFAULT_PROFILE.sectors,
    sector: sectors[0] || DEFAULT_PROFILE.sector, // primary for backwards compat
    country: document.getElementById('country').value.trim() || DEFAULT_PROFILE.country,
    concern: document.getElementById('concern').value.trim()
  };
}

function startOnboarding(state, isEdit = false) {
  document.getElementById('onboarding').classList.remove('hidden');
  document.getElementById('insights').classList.add('hidden');
  document.getElementById('feed').classList.add('hidden');
  document.getElementById('inactive-msg').classList.add('hidden');
  if (!isEdit) document.getElementById('tabs').classList.add('hidden');
  document.getElementById('profile-success').classList.add('hidden');

  if (isEdit) {
    document.getElementById('ob-title').textContent = 'Edit profile';
    document.getElementById('skip-onboarding').textContent = 'Cancel';
  } else {
    document.getElementById('ob-title').textContent = 'Personalise GeoSignal';
    document.getElementById('skip-onboarding').textContent = 'Skip';
  }

  const p = state[PROFILE_KEY] || {};
  populateProfileForm(p);

  async function finishOnboarding(profile, skipped) {
    await chrome.storage.local.set({
      [PROFILE_KEY]: profile,
      [ONBOARDED_KEY]: true
    });

    if (!skipped) {
      // Show success message briefly.
      document.getElementById('profile-success').classList.remove('hidden');
      await new Promise(r => setTimeout(r, 1500));
    }

    const fresh = await chrome.storage.local.get([PROFILE_KEY, HISTORY_KEY]);
    document.getElementById('onboarding').classList.add('hidden');
    document.getElementById('tabs').classList.remove('hidden');
    document.getElementById('edit-profile-top').classList.remove('hidden');
    showInsights(fresh);
    initFeedTab();
    wireTabs();
    wireEditProfileButton();
  }

  // Remove old listeners by cloning buttons.
  const skipBtn = document.getElementById('skip-onboarding');
  const finishBtn = document.getElementById('finish');
  const newSkip = skipBtn.cloneNode(true);
  const newFinish = finishBtn.cloneNode(true);
  skipBtn.replaceWith(newSkip);
  finishBtn.replaceWith(newFinish);

  newSkip.addEventListener('click', () => {
    if (isEdit) {
      // Cancel — just close the form.
      document.getElementById('onboarding').classList.add('hidden');
      document.getElementById('tabs').classList.remove('hidden');
      document.getElementById('insights').classList.remove('hidden');
    } else {
      finishOnboarding(DEFAULT_PROFILE, true);
    }
  });

  newFinish.addEventListener('click', () => {
    finishOnboarding(collectProfile(), false);
  });
}

function wireEditProfileButton() {
  const topBtn = document.getElementById('edit-profile-top');
  const bottomBtn = document.getElementById('edit-profile');

  async function openProfileEditor() {
    const state = await chrome.storage.local.get([PROFILE_KEY, HISTORY_KEY]);
    startOnboarding(state, true);
  }

  if (topBtn) {
    const fresh = topBtn.cloneNode(true);
    topBtn.replaceWith(fresh);
    fresh.addEventListener('click', openProfileEditor);
  }
  if (bottomBtn) {
    const fresh = bottomBtn.cloneNode(true);
    bottomBtn.replaceWith(fresh);
    fresh.addEventListener('click', openProfileEditor);
  }
}

// ── Insights ──

function showInsights(state) {
  document.getElementById('insights').classList.remove('hidden');

  const history = state[HISTORY_KEY] || [];
  const profile = state[PROFILE_KEY] || {};

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthEntries = history.filter(e => e.timestamp >= monthStart);

  document.getElementById('stat-count').textContent = monthEntries.length;
  document.getElementById('stat-streak').textContent = computeStreak(history);

  renderRankList(
    'top-regions',
    topN(monthEntries.map(e => e.region).filter(Boolean).map(prettifyRegion), 3),
    'No regional signal yet — open a briefing on any article.'
  );

  const sectorBag = [];
  for (const e of monthEntries) for (const s of (e.sectors || [])) sectorBag.push(s);
  renderRankList(
    'top-sectors',
    topN(sectorBag, 3),
    'No sector signal yet.'
  );

  renderRankList(
    'top-domains',
    topN(monthEntries.map(e => e.domain).filter(Boolean), 5),
    'No sources read yet.'
  );

  document.getElementById('summary-line').textContent =
    buildSummaryLine(profile, monthEntries, sectorBag);

  document.getElementById('edit-profile').addEventListener('click', async () => {
    const full = await chrome.storage.local.get([
      PROFILE_KEY, 'groqApiKey', 'newsApiKey'
    ]);
    startOnboarding(full);
  });

  document.getElementById('clear-history').addEventListener('click', async () => {
    await chrome.storage.local.remove(HISTORY_KEY);
    const fresh = await chrome.storage.local.get([PROFILE_KEY, HISTORY_KEY]);
    document.getElementById('insights').innerHTML = ''; // re-render cleanly
    location.reload();
  });
}

function topN(items, n) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

function renderRankList(id, rows, emptyMessage) {
  const ul = document.getElementById(id);
  ul.innerHTML = '';
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-hint';
    li.textContent = emptyMessage;
    ul.appendChild(li);
    return;
  }
  for (const { name, count } of rows) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.className = 'rank-name';
    left.textContent = name;
    const right = document.createElement('span');
    right.className = 'rank-count';
    right.textContent = `${count} article${count === 1 ? '' : 's'}`;
    li.append(left, right);
    ul.appendChild(li);
  }
}

function prettifyRegion(slug) {
  return REGION_LABELS[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function computeStreak(history) {
  if (!history.length) return 0;
  const days = new Set(
    history.map(e => {
      const d = new Date(e.timestamp);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    })
  );
  let streak = 0;
  const cursor = new Date();
  while (true) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
    if (days.has(key)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      if (streak === 0) {
        cursor.setDate(cursor.getDate() - 1);
        const k2 = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
        if (days.has(k2)) continue;
      }
      break;
    }
  }
  return streak;
}

function buildSummaryLine(profile, monthEntries, sectorBag) {
  if (monthEntries.length === 0) {
    if (profile.sector && profile.concern) {
      return `Set up to track ${profile.sector} with a focus on ${profile.concern}. Open any article and GeoSignal will start building your picture.`;
    }
    return 'Open any article to start building your reading picture.';
  }
  const topRegion = topN(
    monthEntries.map(e => e.region).filter(Boolean).map(prettifyRegion), 1
  )[0]?.name;
  const topSector = topN(sectorBag, 1)[0]?.name;
  const parts = [];
  if (topSector && topRegion) parts.push(`You're tracking ${topSector} signals, mostly out of ${topRegion}`);
  else if (topSector) parts.push(`You're tracking ${topSector} signals this month`);
  else if (topRegion) parts.push(`Most of your reading has been out of ${topRegion}`);
  else parts.push(`You've read ${monthEntries.length} articles this month`);
  if (profile.concern) parts.push(`aligned with your focus on ${profile.concern}`);
  else if (profile.sector && profile.sector !== topSector) parts.push(`versus your stated focus on ${profile.sector}`);
  return parts.join(' — ') + '.';
}

// ── Feed tab ──

let feedFilters = { region: 'global', sectors: new Set(), tiers: new Set() };

async function initFeedTab() {
  // Populate region dropdown
  const regionSel = document.getElementById('feed-region');
  regionSel.innerHTML = '';
  const regionOrder = [
    'global', 'south-asia', 'east-asia', 'southeast-asia', 'middle-east',
    'europe', 'north-america', 'latin-america', 'africa',
    'central-asia-caucasus', 'oceania'
  ];
  for (const slug of regionOrder) {
    const opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = REGION_LABELS[slug] || slug;
    regionSel.appendChild(opt);
  }

  // Sector pills
  const sectorRow = document.getElementById('feed-sectors');
  sectorRow.innerHTML = '';
  for (const s of SECTORS) {
    const b = document.createElement('button');
    b.className = 'pill';
    b.type = 'button';
    b.dataset.sector = s;
    b.textContent = s;
    b.addEventListener('click', () => {
      const isActive = b.classList.toggle('active');
      b.textContent = isActive ? '✓ ' + s : s;
      if (feedFilters.sectors.has(s)) feedFilters.sectors.delete(s);
      else feedFilters.sectors.add(s);
      persistFilters();
    });
    sectorRow.appendChild(b);
  }

  // Source tier pills
  const tierRow = document.getElementById('feed-sources');
  tierRow.innerHTML = '';
  for (const t of SOURCE_TIERS) {
    const b = document.createElement('button');
    b.className = 'pill';
    b.type = 'button';
    b.dataset.tier = t.key;
    b.textContent = t.label;
    b.addEventListener('click', () => {
      const isActive = b.classList.toggle('active');
      b.textContent = isActive ? '✓ ' + t.label : t.label;
      if (feedFilters.tiers.has(t.key)) feedFilters.tiers.delete(t.key);
      else feedFilters.tiers.add(t.key);
      persistFilters();
    });
    tierRow.appendChild(b);
  }

  // Restore saved filters
  const { [FEED_FILTERS_KEY]: saved } = await chrome.storage.local.get(FEED_FILTERS_KEY);
  if (saved) {
    feedFilters.region = saved.region || 'global';
    feedFilters.sectors = new Set(saved.sectors || []);
    feedFilters.tiers = new Set(saved.tiers || []);
    regionSel.value = feedFilters.region;
    for (const b of sectorRow.children) {
      if (feedFilters.sectors.has(b.dataset.sector)) {
        b.classList.add('active');
        b.textContent = '✓ ' + b.dataset.sector;
      }
    }
    for (const b of tierRow.children) {
      if (feedFilters.tiers.has(b.dataset.tier)) {
        b.classList.add('active');
        const tier = SOURCE_TIERS.find(t => t.key === b.dataset.tier);
        b.textContent = '✓ ' + (tier ? tier.label : b.dataset.tier);
      }
    }
  }

  regionSel.addEventListener('change', () => {
    feedFilters.region = regionSel.value;
    persistFilters();
    loadFeed();
  });
  document.getElementById('feed-refresh').addEventListener('click', () => loadFeed(true));

  loadFeed();
}

function persistFilters() {
  chrome.storage.local.set({
    [FEED_FILTERS_KEY]: {
      region: feedFilters.region,
      sectors: [...feedFilters.sectors],
      tiers: [...feedFilters.tiers]
    }
  });
}

// ── Feed fetch + render ──

async function loadFeed(forceRefresh = false) {
  const DEFAULT_NEWS_KEY = '';
  const { newsApiKey } = await chrome.storage.local.get('newsApiKey');
  const activeNewsKey = newsApiKey || DEFAULT_NEWS_KEY;
  if (!activeNewsKey) {
    showFeedState('Add a NewsAPI key under Edit profile & keys to enable the Feed.');
    renderFeedCards([]);
    return;
  }

  const cacheKey = `${feedFilters.region}|sorted`;
  if (!forceRefresh) {
    const { [FEED_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(FEED_CACHE_KEY);
    const entry = cache[cacheKey];
    if (entry && Date.now() - entry.ts < FEED_CACHE_TTL) {
      renderFilteredFeed(entry.articles);
      return;
    }
  }

  showFeedState('<span class="feed-spinner"></span>Loading feed…', false);
  renderFeedCards([]);

  try {
    const articles = await fetchNewsApi(feedFilters.region, activeNewsKey);

    // Tag each article with a tier looked up from sources.js.
    const tagged = articles.map(a => ({
      ...a,
      tier: detectTierLocal(a.domain),
      sourceName: detectSourceNameLocal(a.domain)
    }));

    const { [FEED_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(FEED_CACHE_KEY);
    cache[cacheKey] = { ts: Date.now(), articles: tagged };
    await chrome.storage.local.set({ [FEED_CACHE_KEY]: cache });

    renderFilteredFeed(tagged);
  } catch (err) {
    showFeedState(`Couldn't load feed: ${err.message || err}`, true);
  }
}

async function fetchNewsApi(regionSlug, apiKey) {
  // Build query from REGION_COUNTRIES. NewsAPI caps q length; take the first
  // few anchor terms for signal. Global → broad world-news query.
  let q;
  if (regionSlug === 'global' || !REGION_COUNTRIES[regionSlug]) {
    q = '(world OR international OR global)';
  } else {
    const terms = REGION_COUNTRIES[regionSlug]
      .filter(t => /^[A-Za-z][A-Za-z\s\-]*$/.test(t))
      .slice(0, 6)
      .map(t => `"${t}"`);
    q = `(${terms.join(' OR ')})`;
  }

  const url = 'https://newsapi.org/v2/everything?' + new URLSearchParams({
    q,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: '40',
    apiKey
  }).toString();

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsAPI ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'NewsAPI error');

  return (data.articles || []).map(a => ({
    title: a.title || '',
    url: a.url || '',
    description: a.description || '',
    publishedAt: a.publishedAt || '',
    domain: extractDomain(a.url || ''),
    rawSource: a.source?.name || ''
  })).filter(a => a.title && a.url && a.title !== '[Removed]');
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

// Tier + source-name lookup from sources.js globals (loaded via <script>).
let _sourceIndex = null;
function buildSourceIndexLocal() {
  if (_sourceIndex) return _sourceIndex;
  _sourceIndex = new Map();
  if (typeof SOURCES !== 'object') return _sourceIndex;
  for (const region of Object.keys(SOURCES)) {
    for (const s of SOURCES[region] || []) {
      try {
        const host = new URL(s.rssUrl).hostname.replace(/^www\./, '').toLowerCase();
        if (!_sourceIndex.has(host)) _sourceIndex.set(host, { name: s.name, tier: s.tier });
      } catch (_) {}
    }
  }
  return _sourceIndex;
}
function detectTierLocal(domain) {
  const idx = buildSourceIndexLocal();
  if (!domain) return null;
  if (idx.has(domain)) return idx.get(domain).tier;
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    if (idx.has(cand)) return idx.get(cand).tier;
  }
  return null;
}
function detectSourceNameLocal(domain) {
  const idx = buildSourceIndexLocal();
  if (!domain) return null;
  if (idx.has(domain)) return idx.get(domain).name;
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    if (idx.has(cand)) return idx.get(cand).name;
  }
  return null;
}

function renderFilteredFeed(articles) {
  // Apply sector + tier filters client-side.
  let filtered = articles;

  if (feedFilters.tiers.size > 0) {
    filtered = filtered.filter(a => a.tier && feedFilters.tiers.has(a.tier));
  }

  if (feedFilters.sectors.size > 0) {
    const activeKws = [...feedFilters.sectors]
      .flatMap(s => SECTOR_KEYWORDS[s] || [])
      .map(k => k.toLowerCase());
    filtered = filtered.filter(a => {
      const hay = `${a.title} ${a.description}`.toLowerCase();
      return activeKws.some(k => hay.includes(k));
    });
  }

  if (filtered.length === 0) {
    showFeedState('No stories match these filters.');
    renderFeedCards([]);
    return;
  }

  hideFeedState();
  renderFeedCards(filtered.slice(0, 25));
}

function renderFeedCards(articles) {
  const list = document.getElementById('feed-list');
  list.innerHTML = '';
  for (const a of articles) {
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const src = document.createElement('span');
    src.className = 'card-source';
    src.textContent = a.sourceName || a.rawSource || a.domain;
    meta.appendChild(src);
    if (a.tier) {
      const tierChip = document.createElement('span');
      tierChip.className = 'card-tier';
      tierChip.textContent = a.tier.replace(/-/g, ' ');
      meta.appendChild(tierChip);
    }
    if (a.publishedAt) {
      const t = document.createElement('span');
      t.textContent = timeAgo(a.publishedAt);
      meta.appendChild(t);
    }

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = a.title;

    card.append(meta, title);
    card.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'GEOSIGNAL_OPEN_ARTICLE', url: a.url });
      window.close();
    });
    list.appendChild(card);
  }
}

function showFeedState(html, isError = false) {
  const el = document.getElementById('feed-status');
  el.innerHTML = html;
  el.classList.toggle('err', !!isError);
  el.classList.remove('hidden');
}
function hideFeedState() {
  document.getElementById('feed-status').classList.add('hidden');
}

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
