// background.js — MV3 service worker
// Handles briefing requests from content scripts by calling Groq directly
// with the same prompt template used by the GeoSignal web app.

// sources.js ends with a CommonJS `module.exports = ...` line. Shim `module`
// so the file runs cleanly in a classic service worker; the top-level
// `const SOURCES`, `SECTOR_KEYWORDS`, and `REGION_COUNTRIES` become globals
// that storage.js can read.
var module = { exports: {} };
importScripts('sources.js', 'storage.js');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_FALLBACK_MODEL = 'llama-3.1-8b-instant';
// API keys are user-supplied via the popup settings and read from
// chrome.storage.local. Do not commit literal keys to this file.
const DEFAULT_GROQ_KEY = '';
const DEFAULT_NEWS_KEY = '';
const DEFAULT_PERPLEXITY_KEY = '';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar';

// GeoSignal web app — when the user is signed in there, the extension
// forwards LLM/news requests through these endpoints so the server's
// keys do the spending. Falls back to the user's local keys otherwise.
const GEOSIGNAL_WEB_URL = 'https://geosignal-6ics.onrender.com';

async function getServerSessionToken() {
  try {
    const c = await chrome.cookies.get({ url: GEOSIGNAL_WEB_URL, name: '__session' });
    return c?.value || '';
  } catch {
    return '';
  }
}

// Returns parsed JSON on success, null when there's no session (signed
// out — caller should fall back to a direct API call). Throws on a real
// server error so the caller surfaces it instead of silently downgrading.
async function callServerProxy(path, body) {
  const token = await getServerSessionToken();
  if (!token) return null;
  const res = await fetch(`${GEOSIGNAL_WEB_URL}/api/ext/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  if (res.status === 401) {
    // Session expired between cookie read and request. Treat as signed
    // out so caller falls back to local keys.
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `GeoSignal proxy ${res.status}`);
  }
  return data;
}

// ── Perplexity API call ──

async function callPerplexity(messages, { temperature = 0.3, max_tokens = 500 } = {}) {
  // Signed-in path: server pays. Server proxy returns null when there's
  // no Clerk session, so we fall through to the user's own key below.
  try {
    const proxied = await callServerProxy('perplexity', { messages, temperature, max_tokens });
    if (proxied) {
      return { content: proxied.content || '', citations: proxied.citations || [] };
    }
  } catch (err) {
    console.warn('[GeoSignal] perplexity proxy failed, using local key:', err.message);
  }

  const { perplexityApiKey } = await chrome.storage.local.get('perplexityApiKey');
  const key = perplexityApiKey || DEFAULT_PERPLEXITY_KEY;
  if (!key) throw new Error('Sign in to GeoSignal or add a Perplexity API key in settings');

  const res = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages,
      temperature,
      max_tokens
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perplexity ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    citations: data.citations || []
  };
}

// ── Think-tank domain list (built from sources.js) ──

function getThinkTankDomains() {
  const domains = new Set();
  if (typeof SOURCES === 'undefined') return domains;
  for (const region of Object.values(SOURCES)) {
    for (const src of region) {
      if (src.tier === 'think-tank-academic' && src.rssUrl) {
        try {
          const host = new URL(src.rssUrl).hostname.replace(/^www\./, '');
          domains.add(host);
        } catch {}
      }
    }
  }
  return domains;
}

// ── Fetch think-tank context via NewsAPI ──

async function fetchThinkTankContext(headline) {
  try {
    // Extract 3-5 key terms from the headline for the search query.
    const stopWords = new Set(['the','a','an','in','on','at','to','for','of','and','or','is','are','was','were','by','with','from','as','its','has','have','had','that','this','but','not','be','been','will','would','can','could','may','over','after','into','new']);
    const terms = headline.split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
      .filter(w => w.length > 2 && !stopWords.has(w))
      .slice(0, 5);
    if (terms.length < 2) return [];

    const query = terms.join(' ');
    const ttDomains = getThinkTankDomains();
    // Build a domains parameter from think-tank sources (NewsAPI cap: 20 domains).
    const domainList = [...ttDomains].slice(0, 20).join(',');

    // Signed-in path: server-side NewsAPI proxy. Returns the same article
    // shape so the downstream mapping below is unchanged.
    let articles = null;
    try {
      const proxied = await callServerProxy('news', {
        q: query,
        domains: domainList,
        language: 'en',
        sortBy: 'relevancy',
        pageSize: 5
      });
      if (proxied) articles = proxied.articles || [];
    } catch (err) {
      console.warn('[GeoSignal] news proxy failed, using local key:', err.message);
    }

    if (!articles) {
      const { newsApiKey } = await chrome.storage.local.get('newsApiKey');
      const key = newsApiKey || DEFAULT_NEWS_KEY;
      if (!key) return [];
      const params = new URLSearchParams({
        q: query,
        domains: domainList,
        language: 'en',
        sortBy: 'relevancy',
        pageSize: '5',
        apiKey: key
      });
      const res = await fetch('https://newsapi.org/v2/everything?' + params);
      if (!res.ok) return [];
      const data = await res.json();
      if (data.status !== 'ok' || !data.articles) return [];
      articles = data.articles;
    }

    return articles
      .filter(a => a.title && a.description)
      .slice(0, 3)
      .map(a => ({
        title: a.title,
        source: a.source?.name || '',
        description: a.description,
        url: a.url
      }));
  } catch {
    return []; // fail silently — briefing still works without context
  }
}

// ── Prompts ──

function buildExpertBlock(thinkTankArticles) {
  if (!thinkTankArticles || thinkTankArticles.length === 0) return '';
  let block = '\nEXPERT & THINK-TANK CONTEXT (use these to enrich your analysis):\n';
  for (const a of thinkTankArticles) {
    block += `- [${a.source}] "${a.title}" — ${a.description}\n`;
  }
  return block;
}

function buildConcisePrompt({ title, source, text, url }, thinkTankArticles) {
  const articleContent = text || '';
  // Concise mode is intentionally austere — 3 single-sentence bullets,
  // no expert/analyst section. Think-tank context (when fetched) is
  // available to the detailed mode only.

  return `You are a senior geopolitical intelligence analyst. Produce a VERY concise briefing — exactly three bullets, one sentence each. Plain text only — never use markdown bold (**) or italic. No filler. No vague language. Every bullet ends with [Article].

ANTI-SPECULATION RULE (CRITICAL):
- Do NOT invent quotes or positions for organizations not mentioned in the article. Never write phrases like "X would likely argue" or "Y analysts would say". Only cite real statements that are actually in the source text.

ARTICLE: ${title}
SOURCE: ${source}
TEXT: ${articleContent}

Use EXACTLY this format. One dash bullet per section. Each bullet ONE sentence — specific, factual, useful:

WHAT HAPPENED:
- The specific actors, action, and timing — name names and key numbers. [Article]

WHY IT MATTERS:
- The most important consequence or risk signal — who is affected and how. [Article]

WATCH FOR:
- The specific next trigger, deadline, or decision point. [Article]`;
}

function buildBriefingPrompt({ title, source, text, url }, thinkTankArticles) {
  const articleContent = text || '';
  const expertContext = buildExpertBlock(thinkTankArticles);
  const hasTT = thinkTankArticles && thinkTankArticles.length > 0;

  const ttNames = hasTT
    ? thinkTankArticles.map(a => `[${a.source}]`).join(', ')
    : '';
  const citationList = hasTT ? `[Article], ${ttNames}` : '[Article]';

  // Only render the analyst section when we actually have real think-tank
  // pieces fetched from NewsAPI. With no real context, omit the section
  // entirely — never ask the LLM to speculate about what an organisation
  // "would" say.
  const expertSection = hasTT
    ? `WHAT ANALYSTS & THINK TANKS ARE SAYING:
- Cite a specific think-tank analysis from the EXPERT CONTEXT block above. Name the institution and its actual key argument from that piece. [Source Name]
- A contrasting or complementary view from a different institution listed in EXPERT CONTEXT. [Source Name]
- If the article itself quotes analysts by name, include their perspective. [Article]`
    : '';

  return `You are a senior geopolitical intelligence analyst. Produce a detailed, scannable briefing. Every bullet: one concrete insight, max one sentence. Never use markdown bold (**) or italic — plain text only. No filler, no vague language.

ANTI-SPECULATION RULE (CRITICAL — NEVER VIOLATE):
- Do NOT invent quotes, positions, or analyses for any organisation, think tank, or analyst that is not named in the source material or in the EXPERT CONTEXT block.
- Phrases like "X would likely argue", "Y analysts would say", "Z would view this as" are FORBIDDEN. Only cite actual statements present in the inputs.
- If you have no real source for an analyst view, omit that bullet entirely. Quality over completeness.

ARTICLE: ${title}
SOURCE: ${source}
TEXT: ${articleContent}
${expertContext}
CITATION RULES — CRITICAL:
- Every bullet MUST end with a citation tag in square brackets
- Allowed tags: ${citationList}
- Use [Article] for article content, [ThinkTankName] for their analysis
- Each bullet gets ONE citation at the end. Never invent sources.

CRITICAL RULE FOR "WHAT HAPPENED":
MUST answer: WHO (named actors), WHAT (concrete event — never vague), WHEN (date/timeframe), core factual claim (what was decided/signed/announced). Never write "a deal was reached" without specifying what. If source lacks specifics: "Limited detail — see original article."

Use EXACTLY this format. Use dashes (-). 3-4 bullets per section, each bullet ONE sentence max:

WHAT HAPPENED:
- Specific actors and what they did, with date. Include numbers and names. [Article]
- What was decided, signed, announced, or changed — be precise. [Article]
- Scope: dollar amounts, affected parties, geographic reach. [Article]
- Any immediate reaction or response from other actors. [Article]

WHAT LED TO THIS:
- Most important preceding event or structural cause. [Article]
- Second factor driving this development. [Article]
- Longer-term trend or pattern this fits into. [Article]

${expertSection}

WHY THIS MATTERS:
- Biggest implication or second-order effect. [Article]
- Who else is directly affected and how. [Article]
- What this signals about the broader geopolitical trajectory. [Article]

WATCH FOR:
- Specific next trigger, deadline, or decision point. [Article]
- Second thing to monitor — a policy response, market reaction, or escalation risk. [Article]`;
}

// ── Groq call with model fallback ──

async function callGroq(prompt, apiKey, { temperature = 0.4, max_tokens = 600 } = {}) {
  // Signed-in path: server-side Groq with its own key rotation + fallback.
  try {
    const proxied = await callServerProxy('groq', { prompt, temperature, max_tokens });
    if (proxied) return proxied.text || '';
  } catch (err) {
    console.warn('[GeoSignal] groq proxy failed, using local key:', err.message);
  }

  const models = [GROQ_MODEL, GROQ_FALLBACK_MODEL];
  let lastError = null;

  for (const model of models) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens
        })
      });

      if (res.ok) {
        const data = await res.json();
        const briefing = data.choices?.[0]?.message?.content;
        if (briefing) return briefing;
        lastError = new Error('Empty Groq response');
        continue;
      }

      // Retry on rate limit with the smaller model; otherwise bail.
      if (res.status === 429) {
        lastError = new Error(`Rate limited on ${model}`);
        continue;
      }

      const body = await res.text();
      throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Groq call failed');
}

// ── Annotate (verbatim prompt from server.js /api/annotate) ──

function buildAnnotatePrompt({ term, headline, briefingText }) {
  return `You are a plain-English explainer for a smart general audience. The user has highlighted a term while reading a news briefing. Explain that term in 1-2 sentences maximum, in the specific context of this article. Do not give a generic definition. Make it feel like a knowledgeable friend is explaining it. Never use jargon in your explanation. If the term is straightforward, keep it to one sentence.

Article headline: ${headline}
Briefing context: ${(briefingText || '').substring(0, 800)}

Term to explain: "${term}"`;
}

// ── Message routing ──

async function getApiKeyOrError() {
  const { groqApiKey } = await chrome.storage.local.get('groqApiKey');
  const key = groqApiKey || DEFAULT_GROQ_KEY;
  return { apiKey: key };
}

// ── Icon state management ──
// Generate active (green) and inactive (grey) icons using OffscreenCanvas.

function makeIconImageData(color, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  // Rounded rectangle background.
  const r = size * 0.2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0); ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r); ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size); ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  // "GS" text.
  ctx.fillStyle = '#FAF8F5';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(size * 0.42)}px sans-serif`;
  ctx.fillText('GS', size / 2, size / 2 + 1);
  return ctx.getImageData(0, 0, size, size);
}

async function setIconActive(tabId) {
  try {
    const data = {};
    for (const s of [16, 32, 48]) data[s] = makeIconImageData('#0F6E56', s);
    await chrome.action.setIcon({ tabId, imageData: data });
    await chrome.action.setTitle({ tabId, title: 'GeoSignal — click for briefing' });
  } catch {}
}

async function setIconInactive(tabId) {
  try {
    const data = {};
    for (const s of [16, 32, 48]) data[s] = makeIconImageData('#9CA3AF', s);
    await chrome.action.setIcon({ tabId, imageData: data });
    await chrome.action.setTitle({ tabId, title: 'GeoSignal — not a news page' });
  } catch {}
}

// Track which tabs are on qualifying pages.
const activeTabPages = new Set();
chrome.tabs.onRemoved.addListener((tabId) => { activeTabPages.delete(tabId); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GEOSIGNAL_PAGE_STATUS') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    if (msg.active) {
      activeTabPages.add(tabId);
      setIconActive(tabId);
    } else {
      activeTabPages.delete(tabId);
      setIconInactive(tabId);
    }
    return;
  }

  if (msg?.type === 'GEOSIGNAL_IS_PAGE_ACTIVE') {
    const tabId = msg.tabId;
    sendResponse({ active: activeTabPages.has(tabId) });
    return;
  }

  if (msg?.type === 'GEOSIGNAL_DETECT_SOURCE') {
    try {
      const meta = GeoSignalStorage.detectTier(msg.domain || '');
      sendResponse({ ok: true, meta });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
    return; // synchronous
  }

  if (msg?.type === 'GEOSIGNAL_GET_SCORING_DATA') {
    (async () => {
      try {
        const { gs_profile, gs_history } = await chrome.storage.local.get(['gs_profile', 'gs_history']);
        const profile = gs_profile || {};
        const history = gs_history || [];

        // Compute top sectors and regions from recent history (last 30 days).
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const recent = history.filter(e => e.timestamp >= cutoff);

        const sectorBag = recent.flatMap(e => e.sectors || []);
        const regionBag = recent.map(e => e.region).filter(Boolean);

        function topN(arr, n) {
          const freq = {};
          for (const v of arr) freq[v] = (freq[v] || 0) + 1;
          return Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([name]) => name);
        }

        sendResponse({
          ok: true,
          profile,
          topHistorySectors: topN(sectorBag, 3),
          topHistoryRegions: topN(regionBag, 2),
          sectorKeywords: typeof SECTOR_KEYWORDS !== 'undefined' ? SECTOR_KEYWORDS : {},
          regionCountries: typeof REGION_COUNTRIES !== 'undefined' ? REGION_COUNTRIES : {},
          significanceWords: typeof SIGNIFICANCE_WORDS !== 'undefined' ? SIGNIFICANCE_WORDS : [],
          junkPatterns: typeof JUNK_PATTERNS !== 'undefined' ? JUNK_PATTERNS.map(r => r.source) : [],
          lowValuePatterns: typeof LOW_VALUE_PATTERNS !== 'undefined' ? LOW_VALUE_PATTERNS.map(r => r.source) : []
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // async
  }

  if (msg?.type === 'GEOSIGNAL_REQUEST_BRIEFING') {
    (async () => {
      try {
        // Log the view locally before anything else. Never transmitted.
        try { await GeoSignalStorage.logArticleView(msg.article); }
        catch (logErr) { console.warn('GeoSignal log failed', logErr); }

        const { apiKey, error } = await getApiKeyOrError();
        if (error) { sendResponse(error); return; }

        // Fetch think-tank context in parallel with nothing — it's the first async step.
        const thinkTankArticles = await fetchThinkTankContext(msg.article.title || '');

        const mode = msg.mode || 'concise';
        const prompt = mode === 'concise'
          ? buildConcisePrompt(msg.article, thinkTankArticles)
          : buildBriefingPrompt(msg.article, thinkTankArticles);
        const maxTok = mode === 'concise' ? 400 : 800;
        const briefing = await callGroq(
          prompt,
          apiKey,
          { temperature: 0.4, max_tokens: maxTok }
        );

        // Build citation map: Article + any think-tank sources found.
        const citationMap = { Article: msg.article.url || '' };
        for (const tt of thinkTankArticles) {
          if (tt.source) citationMap[tt.source] = tt.url || '';
        }

        sendResponse({
          ok: true,
          briefing,
          citationMap
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'GEOSIGNAL_OPEN_ARTICLE') {
    (async () => {
      try {
        const url = msg.url;
        if (!url) { sendResponse({ ok: false, error: 'No URL' }); return; }

        // Push a short-lived auto-open flag so content.js triggers the
        // panel as soon as it mounts on the destination page.
        const { gs_auto_open = [] } = await chrome.storage.local.get('gs_auto_open');
        const now = Date.now();
        const fresh = gs_auto_open
          .filter(e => e && now - e.ts < 60_000)
          .concat([{ url, ts: now }]);
        await chrome.storage.local.set({ gs_auto_open: fresh });

        const tab = await chrome.tabs.create({ url, active: true });

        // Belt and suspenders: also push a message once the page finishes
        // loading, in case the storage flag was already consumed.
        const listener = (tabId, info) => {
          if (tabId !== tab.id || info.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.sendMessage(tabId, { type: 'GEOSIGNAL_AUTO_OPEN' })
            .catch(() => { /* content script may not be injected on this URL */ });
        };
        chrome.tabs.onUpdated.addListener(listener);

        sendResponse({ ok: true, tabId: tab.id });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'GEOSIGNAL_REQUEST_ANNOTATION') {
    (async () => {
      try {
        const term = (msg.term || '').trim();
        if (term.length < 2) {
          sendResponse({ ok: false, error: 'Term too short' });
          return;
        }
        const { apiKey, error } = await getApiKeyOrError();
        if (error) { sendResponse(error); return; }
        const explanation = await callGroq(
          buildAnnotatePrompt({
            term,
            headline: msg.headline || '',
            briefingText: msg.briefingText || ''
          }),
          apiKey,
          { temperature: 0.3, max_tokens: 100 }
        );
        sendResponse({ ok: true, term, explanation: explanation.trim() });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  // ── Perplexity: "How This Impacts You" ──
  if (msg?.type === 'GEOSIGNAL_REQUEST_IMPACT') {
    (async () => {
      try {
        const { gs_profile } = await chrome.storage.local.get('gs_profile');
        const profile = gs_profile || {};
        const profileDesc = [
          profile.occupation && `Role: ${profile.occupation}`,
          profile.company && `Company: ${profile.company}`,
          profile.sectors && `Sectors: ${(Array.isArray(profile.sectors) ? profile.sectors : [profile.sector]).join(', ')}`,
          profile.country && `Based in: ${profile.country}`,
          profile.concern && `Focus: ${profile.concern}`
        ].filter(Boolean).join(' | ') || 'General reader';

        const headline = msg.headline || '';
        const briefingSummary = msg.briefingSummary || '';

        const messages = [
          {
            role: 'system',
            content: `You are a senior analyst. Produce a VERY SHORT personalised impact assessment — exactly 3-4 bullet points. Each bullet: one punchy sentence, max 20 words. Be specific — name exact mechanisms, numbers, policies, or market effects. No filler, no vague language. Never use markdown bold (**) or italic formatting. Use plain text only. Use dashes (-) for bullets.

ANTI-SPECULATION RULE (CRITICAL): Do NOT invent quotes or positions for organisations or analysts. Never write "X would likely argue", "analysts would say", etc. Only cite real statements that you found via your web search. If you cite a source, put it in [brackets] at the end of the bullet — the bracket MUST correspond to a real source from your search, not a guessed institution name.`
          },
          {
            role: 'user',
            content: `READER PROFILE: ${profileDesc}

ARTICLE: ${headline}
CONTEXT: ${briefingSummary}

How does this specifically affect this person? 3-4 bullet points, punchy and specific. Plain text, no markdown formatting.`
          }
        ];

        const result = await callPerplexity(messages, { temperature: 0.3, max_tokens: 300 });
        sendResponse({
          ok: true,
          impact: result.content.trim(),
          citations: result.citations || []
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  // ── Perplexity: headline relevance for homepages ──
  if (msg?.type === 'GEOSIGNAL_PERPLEXITY_RELEVANCE') {
    (async () => {
      try {
        const { gs_profile } = await chrome.storage.local.get('gs_profile');
        const profile = gs_profile || {};
        const profileDesc = [
          profile.occupation && `Role: ${profile.occupation}`,
          profile.company && `Company: ${profile.company}`,
          profile.sectors && `Sectors: ${(Array.isArray(profile.sectors) ? profile.sectors : [profile.sector]).join(', ')}`,
          profile.country && `Based in: ${profile.country}`,
          profile.concern && `Focus: ${profile.concern}`
        ].filter(Boolean).join(' | ') || 'General reader';

        const headlines = msg.headlines || [];
        if (headlines.length === 0) { sendResponse({ ok: true, results: [] }); return; }

        const headlineList = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

        const messages = [
          {
            role: 'system',
            content: `You are a news relevance engine. Given a reader profile and a list of headlines from a news homepage, identify which headlines are most relevant to this person's professional interests and concerns. Search the web briefly for context on the top stories if needed.

Return a JSON array of objects — one per relevant headline — with these fields:
- "index": the headline number (1-based)
- "reason": a short phrase explaining why it's relevant to this person (max 10 words)
- "score": relevance score 1-10

Only include headlines scoring 5 or above. Return ONLY the JSON array, no other text.`
          },
          {
            role: 'user',
            content: `READER PROFILE: ${profileDesc}

HEADLINES:
${headlineList}`
          }
        ];

        const result = await callPerplexity(messages, { temperature: 0.2, max_tokens: 800 });

        // Parse the JSON from the response.
        let results = [];
        try {
          const jsonMatch = result.content.match(/\[[\s\S]*\]/);
          if (jsonMatch) results = JSON.parse(jsonMatch[0]);
        } catch {}

        sendResponse({ ok: true, results });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});
