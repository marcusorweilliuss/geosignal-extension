// content.js — article detection, extraction, floating UI, briefing fetch.
// Runs at document_idle on every page. All UI is mounted inside a Shadow DOM
// so host-page styles can't bleed in or out.

(() => {
  if (window.__geosignalInjected) return;
  window.__geosignalInjected = true;

  // ---------- Page qualification gate ----------
  // Determine early whether this page is worth activating on.

  const EXCLUDED_DOMAINS = [
    'google.com', 'docs.google.com', 'mail.google.com', 'drive.google.com',
    'sheets.google.com', 'slides.google.com', 'calendar.google.com',
    'maps.google.com', 'accounts.google.com', 'meet.google.com',
    'youtube.com', 'facebook.com', 'twitter.com', 'x.com',
    'instagram.com', 'linkedin.com', 'reddit.com', 'github.com',
    'notion.so', 'figma.com', 'canva.com', 'slack.com',
    'discord.com', 'twitch.tv', 'tiktok.com', 'pinterest.com',
    'amazon.com', 'ebay.com', 'netflix.com', 'spotify.com',
    'whatsapp.com', 'telegram.org', 'zoom.us'
  ];

  const ARTICLE_URL_PATTERNS = [
    /\/article[s]?\//i, /\/news\//i, /\/story\//i, /\/post[s]?\//i,
    /\/blog\//i, /\/opinion\//i, /\/editorial\//i, /\/analysis\//i,
    /\/feature[s]?\//i, /\/report[s]?\//i, /\/review\//i,
    /\/\d{4}\/\d{2}\//,  // date pattern like /2024/03/
    /\/[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/  // slug with 3+ hyphens
  ];

  function isExcludedDomain() {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    // file:// and localhost
    if (location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1') return true;
    // Check exact match and parent domain match (e.g. mail.google.com → google.com)
    for (const d of EXCLUDED_DOMAINS) {
      if (host === d || host.endsWith('.' + d)) return true;
    }
    return false;
  }

  function hasArticleUrlPattern() {
    const path = location.pathname;
    return ARTICLE_URL_PATTERNS.some(p => p.test(path));
  }

  function hasSubstantialText() {
    // Count words in main content, excluding nav/header/footer/sidebar.
    const exclude = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header, .menu';
    const body = document.body;
    if (!body) return false;
    const clone = body.cloneNode(true);
    for (const el of clone.querySelectorAll(exclude)) el.remove();
    const text = clone.textContent || '';
    const wordCount = text.split(/\s+/).filter(w => w.length > 1).length;
    return wordCount > 400;
  }

  function hasArticleTag() {
    return document.querySelector('article') !== null;
  }

  function isQualifyingPage() {
    // Hard exclusion first.
    if (isExcludedDomain()) return false;
    // Any of these signals qualifies the page.
    if (hasNewsArticleSchema()) return true;
    if (hasOgArticle()) return true;
    if (hasArticleTag()) return true;
    if (hasArticleUrlPattern()) return true;
    if (hasSubstantialText()) return true;
    return false;
  }

  // Run the check once and cache it.
  // Note: hasNewsArticleSchema and hasOgArticle are defined below, so
  // isQualifyingPage is called in the boot section after those are defined.

  // ---------- Article detection ----------

  function hasNewsArticleSchema() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const t = item && (item['@type'] || (item['@graph'] && item['@graph'].map(g => g['@type']).flat()));
          const types = Array.isArray(t) ? t : [t];
          if (types.some(x => typeof x === 'string' && /Article|NewsArticle|BlogPosting/i.test(x))) {
            return true;
          }
        }
      } catch (_) { /* ignore malformed JSON-LD */ }
    }
    return false;
  }

  function hasOgArticle() {
    const m = document.querySelector('meta[property="og:type"]');
    return !!(m && /article/i.test(m.getAttribute('content') || ''));
  }

  function findArticleRoot() {
    const candidates = [
      ...document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]')
    ];
    if (candidates.length === 0) {
      document.querySelectorAll('div, section').forEach(el => {
        if (el.querySelectorAll(':scope > p').length >= 4) candidates.push(el);
      });
    }
    let best = null;
    let bestLen = 0;
    for (const c of candidates) {
      const len = [...c.querySelectorAll('p')]
        .reduce((n, p) => n + (p.textContent || '').trim().length, 0);
      if (len > bestLen) { best = c; bestLen = len; }
    }
    return { root: best, textLength: bestLen };
  }

  function isArticlePage() {
    if (hasNewsArticleSchema()) return true;
    if (hasOgArticle()) return true;
    const { textLength } = findArticleRoot();
    return textLength >= 750;
  }

  // ---------- Extraction ----------

  function extractArticle() {
    const { root } = findArticleRoot();
    const titleFromMeta = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    const title =
      (titleFromMeta && titleFromMeta.trim()) ||
      (root?.querySelector('h1')?.textContent?.trim()) ||
      document.title;

    let text = '';
    if (root) {
      const paragraphs = [...root.querySelectorAll('p')]
        .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(t => t.length > 40);
      text = paragraphs.join('\n\n');
    }

    return {
      title: (title || '').trim(),
      text: text.slice(0, 8000),
      url: location.href,
      source: location.hostname.replace(/^www\./, '')
    };
  }

  // ---------- Paywall detection ----------

  // Heuristics: not enough prose, or known paywall phrases in page body.
  function isPaywalled(article) {
    if (!article.text || article.text.length < 500) return true;

    const bodyText = (document.body?.innerText || '').toLowerCase();
    const markers = [
      'subscribe to continue reading',
      'subscribe to read',
      'subscribers only',
      'already a subscriber',
      'create a free account to continue',
      'this article is for subscribers',
      'please log in to continue reading',
      'you have reached your article limit'
    ];
    const markerHits = markers.filter(m => bodyText.includes(m)).length;
    if (markerHits >= 1 && article.text.length < 1500) return true;

    return false;
  }

  // ---------- Briefing parsing & formatting ----------

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function stripMd(s) {
    if (!s) return '';
    return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
      .replace(/\*\*/g, '').replace(/__/g, '');
  }

  const LABELS_DETAILED = ['WHAT HAPPENED', 'WHAT LED TO THIS', 'WHAT REGIONAL EXPERTS ARE SAYING', 'WHY THIS MATTERS'];
  const LABELS_CONCISE  = ['WHAT HAPPENED', 'WHY IT MATTERS', 'CONTEXT', 'WATCH FOR'];

  function parseBriefing(text) {
    text = stripMd(text || '');
    // Pick the label set that has the most matches in the text.
    const countHits = (labels) => labels.filter(l => new RegExp(l, 'i').test(text)).length;
    const LABELS = countHits(LABELS_CONCISE) > countHits(LABELS_DETAILED)
      ? LABELS_CONCISE : LABELS_DETAILED;
    const sections = [];
    for (let i = 0; i < LABELS.length; i++) {
      const label = LABELS[i];
      const nextLabel = LABELS[i + 1];
      const match = text.match(new RegExp(label + '[:\\s]*', 'i'));
      if (!match) continue;
      const startIdx = match.index + match[0].length;
      let endIdx = text.length;
      if (nextLabel) {
        const nm = text.match(new RegExp(nextLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[:\\s]*', 'i'));
        if (nm) endIdx = nm.index;
      }
      const sectionText = text.substring(startIdx, endIdx).trim();
      if (sectionText) sections.push({ label, text: sectionText });
    }
    if (sections.length === 0) sections.push({ label: 'BRIEFING', text: text.trim() });
    return sections;
  }

  function renderCitations(line, citationMap) {
    line = stripMd(line);
    const lastOpen = line.lastIndexOf('[');
    const lastClose = line.lastIndexOf(']');
    if (lastOpen > lastClose) line = line + ']';

    const re = /\[([^\[\]]+)\]/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const tag = m[1].trim();
      if (citationMap && Object.prototype.hasOwnProperty.call(citationMap, tag)) {
        out += escapeHtml(line.substring(last, m.index));
        const url = citationMap[tag];
        if (url) {
          out += `<a class="gs-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(tag)}</a>`;
        } else {
          out += `<span class="gs-chip">${escapeHtml(tag)}</span>`;
        }
        last = m.index + m[0].length;
      }
    }
    out += escapeHtml(line.substring(last));
    return out;
  }

  function formatBullets(text, citationMap) {
    if (!text) return '';
    text = stripMd(text);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const hasBullets = lines.some(l => l.startsWith('- ') || l.startsWith('* '));
    if (!hasBullets) return `<p>${renderCitations(text, citationMap)}</p>`;

    let html = '';
    let inList = false;
    for (const line of lines) {
      if (line.startsWith('- ') || line.startsWith('* ')) {
        if (!inList) { html += '<ul class="gs-bullets">'; inList = true; }
        html += `<li>${renderCitations(line.substring(2), citationMap)}</li>`;
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += `<p>${renderCitations(line, citationMap)}</p>`;
      }
    }
    if (inList) html += '</ul>';
    return html;
  }

  // ---------- UI ----------

  function mountUi(article) {
    const host = document.createElement('div');
    host.id = 'geosignal-host';
    host.style.all = 'initial';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; }
      :host {
        /* Editorial design-system tokens, mirroring the web app palette. */
        --gs-bg: #FAF8F5;
        --gs-ink: #1C1917;
        --gs-ink-soft: #3F362E;
        --gs-muted: #6B635A;
        --gs-line: rgba(28, 25, 23, 0.08);
        --gs-accent: #0F6E56;
        --gs-accent-hover: #0B5744;
        --gs-accent-dim: rgba(15, 110, 86, 0.08);
        --gs-accent-soft: rgba(15, 110, 86, 0.16);
        --gs-serif: 'Lora', 'Georgia', 'Times New Roman', serif;
        --gs-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "DM Sans", Helvetica, Arial, sans-serif;
        --gs-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
      }

      .gs-btn {
        position: fixed; right: 24px; bottom: 24px;
        width: 48px; height: 48px; border-radius: 50%;
        border: none; background: #0F6E56; color: #faf7f2;
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "DM Sans", sans-serif;
        letter-spacing: 0.04em; cursor: pointer;
        box-shadow: 0 6px 18px rgba(0,0,0,0.22);
        z-index: 2147483646;
        display: flex; align-items: center; justify-content: center;
        transition: transform 150ms ease, box-shadow 150ms ease;
      }
      .gs-btn:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(0,0,0,0.28); }

      .gs-panel {
        position: fixed; top: 0; right: 0;
        width: 380px; height: 100vh;
        background: #FAF8F5; color: #1C1917;
        box-shadow: -8px 0 24px rgba(0,0,0,0.12);
        transform: translateX(100%);
        transition: transform 250ms ease;
        z-index: 2147483647;
        font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "DM Sans", sans-serif;
        display: flex; flex-direction: column;
      }
      .gs-panel {
        transition: transform 260ms var(--gs-ease);
      }
      .gs-panel.gs-open { transform: translateX(0); }

      /* Subtle fade-in for body content swaps (loading → briefing, etc.) */
      .gs-body > * {
        animation: gs-fade 260ms var(--gs-ease);
      }
      @keyframes gs-fade {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .gs-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px; border-bottom: 1px solid rgba(28,25,23,0.08);
      }
      .gs-title { font-weight: 700; font-size: 13px; letter-spacing: 1.6px;
        text-transform: uppercase; color: #0F6E56; }
      .gs-close {
        background: transparent; border: none; font-size: 22px; line-height: 1;
        color: #1C1917; cursor: pointer; padding: 2px 8px; border-radius: 4px;
      }
      .gs-close:hover { background: rgba(28,25,23,0.08); }

      .gs-body { flex: 1; overflow-y: auto; padding: 22px 22px 28px; }

      .gs-article-title {
        font-family: 'Lora', 'Georgia', 'Times New Roman', serif;
        font-size: 18px; font-weight: 700; line-height: 1.35;
        color: #1C1917; margin: 0 0 4px;
      }
      .gs-article-source {
        font-size: 11px; letter-spacing: 0.5px;
        text-transform: uppercase; color: #6B635A;
        margin-bottom: 22px;
      }

      .gs-loading {
        display: flex; align-items: center; gap: 12px;
        font-family: 'Lora', 'Georgia', serif; font-style: italic;
        color: #6B635A; font-size: 14px;
      }
      .gs-spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid rgba(15,110,86,0.2); border-top-color: #0F6E56;
        animation: gs-spin 0.8s linear infinite;
      }
      @keyframes gs-spin { to { transform: rotate(360deg); } }

      .gs-error, .gs-paywall {
        font-family: 'Lora', 'Georgia', serif; font-size: 14px;
        line-height: 1.6; color: #6B635A; padding: 16px 0;
      }
      .gs-paywall-title {
        font-family: 'Lora', 'Georgia', serif; font-size: 17px; font-weight: 700;
        color: #1C1917; margin-bottom: 8px; font-style: normal;
      }

      .gs-section { margin-bottom: 24px; }
      .gs-section:last-of-type { margin-bottom: 0; }

      .gs-label {
        font-size: 11px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 1.8px; color: #0F6E56;
        margin-bottom: 10px;
        display: flex; align-items: center; gap: 10px;
      }
      .gs-label::after {
        content: ''; flex: 1; height: 1px; background: rgba(15,110,86,0.14);
      }

      .gs-text {
        font-family: 'Lora', 'Georgia', 'Times New Roman', serif;
        font-size: 16px; color: #1C1917; line-height: 1.75; font-weight: 500;
      }
      .gs-text p { margin: 0 0 10px 0; }
      .gs-bullets { list-style: none; padding: 0; margin: 0; }
      .gs-bullets li {
        position: relative; padding-left: 22px;
        margin-bottom: 10px; line-height: 1.7;
      }
      .gs-bullets li:last-child { margin-bottom: 0; }
      .gs-bullets li::before {
        content: ''; position: absolute; left: 2px; top: 13px;
        width: 6px; height: 6px; border-radius: 50%;
        background: #0F6E56; opacity: 0.7;
      }

      .gs-chip {
        display: inline-block;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "DM Sans", sans-serif;
        font-size: 10px; font-weight: 600; letter-spacing: 0.1px;
        padding: 2px 9px; margin-left: 6px; border-radius: 999px;
        text-decoration: none;
        background: rgba(15,110,86,0.08); color: #0F6E56;
        border: 1px solid rgba(15,110,86,0.14);
      }
      .gs-chip:hover { background: rgba(15,110,86,0.14); }

      /* Briefing mode segmented control */
      .gs-mode-bar {
        display: flex; align-items: center; gap: 0;
        padding: 12px 22px 0;
      }
      .gs-mode-btn {
        flex: 1; padding: 6px 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "DM Sans", sans-serif;
        font-size: 11px; font-weight: 600; letter-spacing: 0.4px;
        text-transform: uppercase; text-align: center;
        color: #6B635A; background: transparent;
        border: 1px solid rgba(28,25,23,0.14);
        cursor: pointer; transition: all 150ms ease;
      }
      .gs-mode-btn:first-child { border-radius: 6px 0 0 6px; }
      .gs-mode-btn:last-child  { border-radius: 0 6px 6px 0; border-left: none; }
      .gs-mode-btn.gs-active {
        background: #0F6E56; color: #FAF8F5;
        border-color: #0F6E56;
      }
      .gs-mode-btn:not(.gs-active):hover { background: rgba(15,110,86,0.06); }

      /* Annotate toggle */
      .gs-toggle {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 22px 0;
        font-size: 11px; letter-spacing: 0.5px; text-transform: uppercase;
        color: #6B635A; font-weight: 600;
      }
      .gs-switch {
        position: relative; width: 30px; height: 16px;
        background: rgba(28,25,23,0.16); border-radius: 999px;
        cursor: pointer; transition: background 150ms ease;
        border: none; padding: 0;
      }
      .gs-switch::after {
        content: ''; position: absolute; top: 2px; left: 2px;
        width: 12px; height: 12px; border-radius: 50%;
        background: #FAF8F5; transition: transform 150ms ease;
      }
      .gs-switch.gs-on { background: #0F6E56; }
      .gs-switch.gs-on::after { transform: translateX(14px); }

      /* Pulsing ring on annotate toggle */
      @keyframes gs-ring-pulse {
        0% { box-shadow: 0 0 0 0 rgba(245,158,11,0.55); }
        70% { box-shadow: 0 0 0 7px rgba(245,158,11,0); }
        100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
      }
      .gs-switch.gs-pulse-ring {
        animation: gs-ring-pulse 2s ease infinite;
      }

      /* First-use annotation hint */
      .gs-hint {
        position: relative;
        margin: 10px 22px 4px;
        padding: 12px 32px 12px 14px;
        background: #FFF3E0;
        border: 1.5px solid #F59E0B;
        border-radius: 8px;
        font: 500 13.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #92400E;
      }
      .gs-hint-close {
        position: absolute; top: 6px; right: 8px;
        background: none; border: none; font-size: 16px; color: #92400E;
        cursor: pointer; padding: 2px 4px; line-height: 1;
      }
      .gs-hint-close:hover { opacity: 0.6; }

      /* Profile prompt in briefing */
      .gs-profile-prompt {
        margin: 12px 0;
        padding: 10px 14px;
        background: rgba(15,110,86,0.06);
        border: 1px dashed rgba(15,110,86,0.25);
        border-radius: 6px;
        font: 400 12.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #3F362E;
      }
      .gs-profile-prompt a {
        color: #0F6E56; font-weight: 600; text-decoration: underline;
        cursor: pointer;
      }

      /* Impact section (Perplexity-powered) — uses same styles as briefing */
      .gs-impact {
        margin-top: 24px;
        padding-top: 20px;
        border-top: 1px solid rgba(28,25,23,0.08);
      }
      .gs-impact-loading {
        display: flex; align-items: center; gap: 8px;
        font: 400 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #6B635A; padding: 8px 0;
      }
      .gs-impact-citations {
        margin-top: 10px;
        font: 400 10.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #6B635A;
      }
      .gs-impact-citations a {
        color: #0F6E56; text-decoration: none;
      }
      .gs-impact-citations a:hover { text-decoration: underline; }

      /* Improved paywall message */
      .gs-paywall-search {
        display: inline-block;
        margin-top: 10px;
        padding: 6px 14px;
        background: #0F6E56; color: #FAF8F5;
        border: none; border-radius: 6px;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer; text-decoration: none;
        transition: background 150ms ease;
      }
      .gs-paywall-search:hover { background: #0B5744; }

      /* First-visit arrow pointing at toolbar icon (top-right) */
      .gs-toolbar-hint {
        position: fixed;
        right: 24px;
        top: 12px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 4px;
        z-index: 2147483646;
        pointer-events: auto;
        animation: gs-toolbar-bounce 1.5s ease infinite;
      }
      .gs-toolbar-arrow {
        font-size: 22px; color: #F59E0B;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.15));
      }
      .gs-toolbar-label {
        background: #F59E0B; color: #fff;
        font: 600 12.5px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 8px 14px;
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.18);
        max-width: 220px;
      }
      .gs-toolbar-dismiss {
        position: absolute; top: -4px; left: -8px;
        background: #1C1917; color: #FAF8F5;
        border: none; border-radius: 50%;
        width: 18px; height: 18px;
        font-size: 11px; line-height: 18px;
        text-align: center; cursor: pointer;
        box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      }
      @keyframes gs-toolbar-bounce {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-5px); }
      }

      /* First-visit arrow pointing at GS button */
      .gs-arrow-hint {
        position: fixed;
        right: 82px;
        bottom: 28px;
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 2147483646;
        pointer-events: auto;
        animation: gs-arrow-bounce 1.5s ease infinite;
      }
      .gs-arrow-label {
        background: #F59E0B;
        color: #fff;
        font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 8px 14px;
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.18);
        white-space: nowrap;
      }
      .gs-arrow-icon {
        font-size: 22px;
        color: #F59E0B;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.15));
      }
      .gs-arrow-dismiss {
        position: absolute; top: -8px; right: -8px;
        background: #1C1917; color: #FAF8F5;
        border: none; border-radius: 50%;
        width: 18px; height: 18px;
        font-size: 11px; line-height: 18px;
        text-align: center; cursor: pointer;
        box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      }
      @keyframes gs-arrow-bounce {
        0%, 100% { transform: translateX(0); }
        50% { transform: translateX(6px); }
      }

      /* Annotate tooltip */
      .gs-tooltip {
        position: fixed;
        max-width: 320px;
        background: #1C1917; color: #FAF8F5;
        padding: 12px 14px;
        border-radius: 8px;
        box-shadow: 0 12px 28px rgba(0,0,0,0.28);
        font-family: 'Lora', 'Georgia', serif;
        font-size: 13.5px; line-height: 1.5;
        z-index: 2147483647;
        opacity: 0; transform: translateY(4px);
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events: auto;
      }
      .gs-tooltip.gs-show { opacity: 1; transform: translateY(0); }
      .gs-tooltip-term {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "DM Sans", sans-serif;
        font-size: 10px; font-weight: 700; letter-spacing: 1px;
        text-transform: uppercase; color: #8FD4BF;
        margin-bottom: 6px;
      }
      .gs-tooltip-loading {
        display: inline-block; width: 10px; height: 10px;
        border-radius: 50%;
        border: 2px solid rgba(250,248,245,0.25); border-top-color: #FAF8F5;
        animation: gs-spin 0.8s linear infinite;
        vertical-align: middle;
      }
    `;

    const btn = document.createElement('button');
    btn.className = 'gs-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open GeoSignal');
    btn.textContent = 'GS';

    const panel = document.createElement('aside');
    panel.className = 'gs-panel';
    panel.setAttribute('aria-label', 'GeoSignal panel');
    panel.innerHTML = `
      <div class="gs-header">
        <div class="gs-title">GeoSignal</div>
        <button class="gs-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="gs-mode-bar">
        <button class="gs-mode-btn gs-active" data-mode="concise" type="button">Concise</button>
        <button class="gs-mode-btn" data-mode="detailed" type="button">Detailed</button>
      </div>
      <div class="gs-toggle">
        <button class="gs-switch gs-on gs-pulse-ring" type="button" role="switch" aria-checked="true" aria-label="Annotate mode"></button>
        <span>Annotate</span>
      </div>
      <div class="gs-hint hidden" id="gs-annotate-hint">
        <button class="gs-hint-close" type="button" aria-label="Dismiss">&times;</button>
        Tip: highlight any word or phrase on the page or in this briefing for an instant plain-English explanation.
      </div>
      <div class="gs-body"></div>
    `;

    const body = panel.querySelector('.gs-body');
    const annotateSwitch = panel.querySelector('.gs-switch');
    const annotateHint = panel.querySelector('#gs-annotate-hint');
    let briefingMode = 'concise'; // 'concise' | 'detailed'
    const modeButtons = panel.querySelectorAll('.gs-mode-btn');

    // Show annotation hint on first visit.
    const hintKey = 'gs_annotate_hint_dismissed';
    chrome.storage.local.get(hintKey).then(({ [hintKey]: dismissed }) => {
      if (!dismissed) annotateHint.classList.remove('hidden');
    });
    annotateHint.querySelector('.gs-hint-close').addEventListener('click', () => {
      annotateHint.classList.add('hidden');
      chrome.storage.local.set({ [hintKey]: true });
    });

    // Tooltip lives in the shadow root so it inherits our styles and
    // is insulated from host-page CSS.
    const tooltip = document.createElement('div');
    tooltip.className = 'gs-tooltip';
    tooltip.style.display = 'none';

    function renderHeader() {
      return `
        <div class="gs-article-title">${escapeHtml(article.title)}</div>
        <div class="gs-article-source">${escapeHtml(article.source)}</div>
      `;
    }

    function renderLoading() {
      body.innerHTML = renderHeader() +
        `<div class="gs-loading"><div class="gs-spinner"></div><span>Composing the briefing…</span></div>`;
    }

    function renderPaywall() {
      const searchQuery = encodeURIComponent(article.title || '');
      const searchUrl = `https://news.google.com/search?q=${searchQuery}`;
      body.innerHTML = renderHeader() + `
        <div class="gs-paywall">
          <div class="gs-paywall-title">This article appears to be behind a paywall</div>
          GeoSignal can only analyse articles with publicly available text.
          The page didn't have enough content to produce a reliable briefing.
          <br><br>
          Try opening an ungated version of this article, or search for the
          same story elsewhere.
          <br>
          <a class="gs-paywall-search" href="${searchUrl}" target="_blank" rel="noopener">Search for this story</a>
        </div>`;
    }

    function renderError(message) {
      body.innerHTML = renderHeader() +
        `<div class="gs-error">${escapeHtml(message || 'Something went wrong generating the briefing.')}</div>`;
    }

    async function renderBriefing(briefingText, citationMap) {
      const sections = parseBriefing(briefingText);
      let html = renderHeader();

      // Check if user has a profile set up.
      let hasProfile = false;
      try {
        const { gs_profile } = await chrome.storage.local.get('gs_profile');
        hasProfile = !!(gs_profile && gs_profile.sector && gs_profile.country && gs_profile.country !== 'Global');
      } catch {}

      for (const s of sections) {
        html += `<div class="gs-section">
          <div class="gs-label">${escapeHtml(s.label)}</div>
          <div class="gs-text">${formatBullets(s.text, citationMap)}</div>
        </div>`;
        // After "WHY THIS MATTERS" or "WHY IT MATTERS", show profile prompt if not set up.
        if (!hasProfile && /why.*matters/i.test(s.label)) {
          html += `<div class="gs-profile-prompt">
            Want this tailored to your role and sector? Click the GeoSignal icon in your browser toolbar (next to the puzzle piece) and set up your profile.
          </div>`;
        }
      }
      body.innerHTML = html;

      // Async: fetch "How This Impacts You" from Perplexity.
      loadImpactSection(briefingText);
    }

    async function loadImpactSection(briefingText) {
      // Add loading placeholder.
      const impactDiv = document.createElement('div');
      impactDiv.className = 'gs-impact';
      impactDiv.innerHTML = `
        <div class="gs-label">How this impacts you</div>
        <div class="gs-impact-loading">
          <div class="gs-spinner" style="width:12px;height:12px;border-width:2px;"></div>
          Searching for personalised impact analysis…
        </div>`;
      body.appendChild(impactDiv);

      try {
        // Build a summary of the briefing for context.
        const textEls = body.querySelectorAll('.gs-text');
        const summary = [...textEls].map(el => el.textContent).join(' ').substring(0, 600);

        const resp = await chrome.runtime.sendMessage({
          type: 'GEOSIGNAL_REQUEST_IMPACT',
          headline: article.title,
          briefingSummary: summary
        });

        if (!resp || !resp.ok) {
          impactDiv.querySelector('.gs-impact-loading').innerHTML =
            '<em style="color:#6B635A;font-size:12px;">Could not load impact analysis.</em>';
          return;
        }

        // Render using the same markup as briefing sections.
        const bullets = resp.impact.split('\n').filter(l => l.trim());
        const listItems = bullets.map(b => {
          let cleaned = b.replace(/^[-•*]\s*/, '').trim();
          cleaned = cleaned.replace(/\*\*/g, '');
          cleaned = cleaned.replace(/\*/g, '');
          return cleaned ? `<li>${escapeHtml(cleaned)}</li>` : '';
        }).join('');

        let citationsHtml = '';
        if (resp.citations && resp.citations.length > 0) {
          const links = resp.citations.map((url, i) =>
            `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">[${i + 1}]</a>`
          ).join(' ');
          citationsHtml = `<div class="gs-impact-citations">Sources: ${links}</div>`;
        }

        impactDiv.innerHTML = `
          <div class="gs-label">How this impacts you</div>
          <div class="gs-text"><ul class="gs-bullets">${listItems}</ul></div>
          ${citationsHtml}`;
      } catch (err) {
        impactDiv.querySelector('.gs-impact-loading').innerHTML =
          '<em style="color:#6B635A;font-size:12px;">Impact analysis unavailable.</em>';
      }
    }

    // Cache briefings per mode so switching doesn't re-fetch.
    const briefingCache = {}; // { concise: {briefing, citationMap}, detailed: ... }
    const modeState = { concise: 'idle', detailed: 'idle' }; // idle | loading | done | error

    async function ensureBriefing(mode) {
      mode = mode || briefingMode;

      if (isPaywalled(article)) {
        modeState[mode] = 'done';
        renderPaywall();
        return;
      }

      // Already have it cached — just render.
      if (modeState[mode] === 'done' && briefingCache[mode]) {
        renderBriefing(briefingCache[mode].briefing, briefingCache[mode].citationMap);
        return;
      }
      if (modeState[mode] === 'loading') return;

      modeState[mode] = 'loading';
      renderLoading();
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'GEOSIGNAL_REQUEST_BRIEFING',
          article,
          mode  // 'concise' or 'detailed'
        });
        if (!resp || !resp.ok) {
          modeState[mode] = 'error';
          if (resp?.errorKind === 'no_key') {
            renderError('No Groq API key yet. Click the GeoSignal icon in your browser toolbar and finish the quick setup — the briefing will work immediately after.');
          } else {
            renderError(resp?.error);
          }
          return;
        }
        modeState[mode] = 'done';
        briefingCache[mode] = { briefing: resp.briefing, citationMap: resp.citationMap };
        // Only render if this is still the active mode.
        if (mode === briefingMode) {
          renderBriefing(resp.briefing, resp.citationMap);
        }
      } catch (err) {
        modeState[mode] = 'error';
        renderError(err?.message || String(err));
      }
    }

    // Mode toggle wiring
    modeButtons.forEach(b => {
      b.addEventListener('click', () => {
        const newMode = b.dataset.mode;
        if (newMode === briefingMode) return;
        briefingMode = newMode;
        modeButtons.forEach(m => m.classList.toggle('gs-active', m.dataset.mode === newMode));
        ensureBriefing(newMode);
      });
    });

    btn.addEventListener('click', () => {
      panel.classList.add('gs-open');
      ensureBriefing(briefingMode);
    });
    panel.querySelector('.gs-close').addEventListener('click', () => {
      panel.classList.remove('gs-open');
      hideTooltip();
    });

    // ---------- Annotate mode ----------

    let annotateOn = true;
    const annotateCache = new Map(); // key: lowercased term → explanation

    function setAnnotate(on) {
      annotateOn = on;
      annotateSwitch.classList.toggle('gs-on', on);
      annotateSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
      if (!on) hideTooltip();
    }
    annotateSwitch.addEventListener('click', () => setAnnotate(!annotateOn));

    function showTooltipAt(rect, html) {
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';
      // Measure and clamp so it stays on screen and doesn't sit under the panel.
      const viewportW = document.documentElement.clientWidth;
      const panelOpen = panel.classList.contains('gs-open');
      const rightLimit = panelOpen ? viewportW - 380 - 12 : viewportW - 12;

      // Temporarily make it visible to measure.
      tooltip.classList.remove('gs-show');
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;

      let x = rect.left + (rect.width / 2) - (tw / 2);
      if (x < 12) x = 12;
      if (x + tw > rightLimit) x = rightLimit - tw;

      let y = rect.top - th - 10;
      if (y < 12) y = rect.bottom + 10; // flip below selection if no room above

      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
      // Next frame for transition.
      requestAnimationFrame(() => tooltip.classList.add('gs-show'));
    }

    function hideTooltip() {
      tooltip.classList.remove('gs-show');
      tooltip.style.display = 'none';
    }

    function renderTooltipLoading(term, rect) {
      showTooltipAt(rect, `
        <div class="gs-tooltip-term">${escapeHtml(term)}</div>
        <span class="gs-tooltip-loading"></span>
      `);
    }
    function renderTooltipExplanation(term, explanation, rect) {
      showTooltipAt(rect, `
        <div class="gs-tooltip-term">${escapeHtml(term)}</div>
        ${escapeHtml(explanation)}
      `);
    }
    function renderTooltipError(term, message, rect) {
      showTooltipAt(rect, `
        <div class="gs-tooltip-term">${escapeHtml(term)}</div>
        <em>${escapeHtml(message || 'Could not explain this term.')}</em>
      `);
    }

    // Allow selections inside the briefing body; block selections on controls.
    function selectionIsOnControls(sel) {
      if (!sel || sel.rangeCount === 0) return false;
      const node = sel.anchorNode;
      if (!node) return false;
      // If inside the shadow root but within the briefing body, allow it.
      const inShadow = host.contains(node) || (node.getRootNode && node.getRootNode() === shadow);
      if (!inShadow) return false;
      // Check if the selection is inside the briefing content area.
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (el && (el.closest('.gs-body') || el.closest('.gs-text'))) return false; // allow
      return true; // block — it's on a control/header
    }

    function currentBriefingText() {
      const textEls = body.querySelectorAll('.gs-text');
      return [...textEls].map(el => el.textContent).join('\n').trim();
    }

    async function handleAnnotateRequest(term, rect) {
      // Stop the pulse ring after first use and dismiss the hint.
      annotateSwitch.classList.remove('gs-pulse-ring');
      annotateHint.classList.add('hidden');
      chrome.storage.local.set({ [hintKey]: true });

      const key = term.toLowerCase();
      if (annotateCache.has(key)) {
        renderTooltipExplanation(term, annotateCache.get(key), rect);
        return;
      }
      renderTooltipLoading(term, rect);
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'GEOSIGNAL_REQUEST_ANNOTATION',
          term,
          headline: article.title,
          briefingText: currentBriefingText()
        });
        if (!resp || !resp.ok) {
          renderTooltipError(term, resp?.error, rect);
          return;
        }
        annotateCache.set(key, resp.explanation);
        renderTooltipExplanation(term, resp.explanation, rect);
      } catch (err) {
        renderTooltipError(term, err?.message || String(err), rect);
      }
    }

    // Shared handler for text selection — works for both page and shadow DOM.
    function handleSelectionEvent(getSel) {
      if (!annotateOn) return;
      setTimeout(() => {
        const sel = getSel();
        if (!sel || sel.isCollapsed) return;
        if (selectionIsOnControls(sel)) return;
        const term = sel.toString().replace(/\s+/g, ' ').trim();
        if (term.length < 2 || term.length > 120) return;

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;

        handleAnnotateRequest(term, rect);
      }, 10);
    }

    // Listen on the main page for article text selections.
    document.addEventListener('mouseup', () => {
      handleSelectionEvent(() => window.getSelection());
    });

    // Listen inside the shadow root for briefing text selections.
    shadow.addEventListener('mouseup', () => {
      handleSelectionEvent(() => shadow.getSelection ? shadow.getSelection() : document.getSelection());
    });

    // Dismiss tooltip on outside click / escape / scroll.
    document.addEventListener('mousedown', (e) => {
      if (tooltip.style.display === 'none') return;
      // Clicks inside the shadow root don't bubble here with composed targets,
      // but selection mouseup fires after — hide now and let the selection
      // handler re-show if needed.
      if (!host.contains(e.target)) hideTooltip();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideTooltip();
    });
    window.addEventListener('scroll', hideTooltip, { passive: true });

    // First-visit arrow pointing at the GS button.
    const arrowHint = document.createElement('div');
    arrowHint.className = 'gs-arrow-hint';
    arrowHint.innerHTML = `
      <div class="gs-arrow-label">Click here for your briefing</div>
      <div class="gs-arrow-icon">→</div>
      <button class="gs-arrow-dismiss" type="button" aria-label="Dismiss">✕</button>
    `;
    arrowHint.style.display = 'none';

    // Show arrow on first-ever article page visit.
    const arrowKey = 'gs_arrow_hint_seen';
    chrome.storage.local.get(arrowKey).then(({ [arrowKey]: seen }) => {
      if (!seen) {
        arrowHint.style.display = 'flex';
        // Auto-dismiss after 8 seconds.
        setTimeout(() => {
          arrowHint.style.display = 'none';
          chrome.storage.local.set({ [arrowKey]: true });
        }, 8000);
      }
    });
    arrowHint.querySelector('.gs-arrow-dismiss').addEventListener('click', () => {
      arrowHint.style.display = 'none';
      chrome.storage.local.set({ [arrowKey]: true });
    });
    // Also dismiss when user clicks the GS button.
    btn.addEventListener('click', () => {
      arrowHint.style.display = 'none';
      chrome.storage.local.set({ [arrowKey]: true });
    });

    // Toolbar arrow — points at the extension icon in the toolbar.
    const toolbarHint = document.createElement('div');
    toolbarHint.className = 'gs-toolbar-hint';
    toolbarHint.innerHTML = `
      <div class="gs-toolbar-arrow">↑</div>
      <div class="gs-toolbar-label">Set up your profile for analysis tailored to your role and sector →</div>
      <button class="gs-toolbar-dismiss" type="button" aria-label="Dismiss">✕</button>
    `;
    toolbarHint.style.display = 'none';

    const toolbarKey = 'gs_toolbar_hint_seen';
    chrome.storage.local.get(toolbarKey).then(({ [toolbarKey]: seen }) => {
      if (!seen) {
        // Show after a short delay so the bottom arrow gets attention first.
        setTimeout(() => { toolbarHint.style.display = 'flex'; }, 3000);
        setTimeout(() => {
          toolbarHint.style.display = 'none';
          chrome.storage.local.set({ [toolbarKey]: true });
        }, 12000);
      }
    });
    toolbarHint.querySelector('.gs-toolbar-dismiss').addEventListener('click', () => {
      toolbarHint.style.display = 'none';
      chrome.storage.local.set({ [toolbarKey]: true });
    });

    shadow.append(style, btn, panel, tooltip, arrowHint, toolbarHint);
    document.documentElement.appendChild(host);

    // ---------- Auto-open (Feed tab) ----------
    // If the popup launched this tab for analysis, open the panel and
    // trigger the briefing automatically. Two independent triggers:
    //   (a) a short-lived flag in chrome.storage.local
    //   (b) a GEOSIGNAL_AUTO_OPEN message from the background
    function openAndBrief() {
      panel.classList.add('gs-open');
      ensureBriefing();
    }

    function urlMatches(a, b) {
      if (!a || !b) return false;
      if (a === b) return true;
      try {
        const ua = new URL(a), ub = new URL(b);
        return ua.hostname === ub.hostname && ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
      } catch { return false; }
    }

    chrome.storage.local.get('gs_auto_open').then(({ gs_auto_open = [] }) => {
      const now = Date.now();
      const match = gs_auto_open.find(e => e && now - e.ts < 60_000 && urlMatches(e.url, location.href));
      if (!match) return;
      const remaining = gs_auto_open.filter(e => e !== match);
      chrome.storage.local.set({ gs_auto_open: remaining });
      openAndBrief();
    }).catch(() => {});

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'GEOSIGNAL_AUTO_OPEN') openAndBrief();
    });
  }

  // ---------- Source recognition badge ----------

  // Tier → label + editorial palette. Government sources get the amber
  // Official badge; the four prompt-named tiers (Mainstream, Think tank,
  // Independent, Official) lead, with sensible colours for the rest.
  const TIER_CONFIG = {
    'mainstream':          { label: 'Mainstream',  color: '#0F6E56', bg: 'rgba(15,110,86,0.10)',  border: 'rgba(15,110,86,0.28)'  },
    'independent-left':    { label: 'Independent', color: '#2E5D8A', bg: 'rgba(46,93,138,0.10)',  border: 'rgba(46,93,138,0.28)'  },
    'independent-right':   { label: 'Independent', color: '#8A3A1F', bg: 'rgba(138,58,31,0.10)',  border: 'rgba(138,58,31,0.28)'  },
    'think-tank-academic': { label: 'Think tank',  color: '#6B4E71', bg: 'rgba(107,78,113,0.10)', border: 'rgba(107,78,113,0.30)' },
    'government-official': { label: 'Official',    color: '#9C4A1A', bg: 'rgba(196,98,45,0.14)',  border: 'rgba(196,98,45,0.32)'  },
    'business':            { label: 'Business',    color: '#475569', bg: 'rgba(71,85,105,0.10)',  border: 'rgba(71,85,105,0.28)'  },
    'regional':            { label: 'Regional',    color: '#78716C', bg: 'rgba(120,113,108,0.10)',border: 'rgba(120,113,108,0.28)' }
  };

  function mountSourceBadge(meta) {
    const config = TIER_CONFIG[meta.tier];
    if (!config) return;

    const host = document.createElement('div');
    host.id = 'geosignal-badge-host';
    host.style.all = 'initial';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .gs-badge {
        position: fixed; top: 14px; right: 14px;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 11px 5px 9px;
        border-radius: 999px;
        background: ${config.bg};
        color: ${config.color};
        border: 1px solid ${config.border};
        backdrop-filter: saturate(140%) blur(4px);
        -webkit-backdrop-filter: saturate(140%) blur(4px);
        font: 600 10.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "DM Sans", sans-serif;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        z-index: 2147483645;
        cursor: default;
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity 220ms ease, transform 220ms ease;
        user-select: none;
      }
      .gs-badge.gs-show { opacity: 1; transform: translateY(0); }
      .gs-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: ${config.color};
        opacity: 0.9;
      }
      .gs-badge-name {
        font-family: 'Lora', 'Georgia', serif;
        font-size: 11px; font-weight: 600; font-style: italic;
        text-transform: none; letter-spacing: 0;
        color: ${config.color};
        opacity: 0.85;
        margin-left: 4px;
        padding-left: 6px;
        border-left: 1px solid ${config.border};
      }
    `;

    const badge = document.createElement('div');
    badge.className = 'gs-badge';
    badge.setAttribute('title', `${meta.name || 'Known source'} — ${config.label}`);
    badge.innerHTML = `
      <span class="gs-dot"></span>
      <span>${config.label}</span>
      ${meta.name ? `<span class="gs-badge-name">${escapeHtmlSafe(meta.name)}</span>` : ''}
    `;

    shadow.append(style, badge);
    document.documentElement.appendChild(host);
    requestAnimationFrame(() => badge.classList.add('gs-show'));
  }

  function escapeHtmlSafe(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function detectAndMountBadge() {
    try {
      const domain = location.hostname.replace(/^www\./, '');
      if (!domain) return;
      const resp = await chrome.runtime.sendMessage({ type: 'GEOSIGNAL_DETECT_SOURCE', domain });
      if (resp?.ok && resp.meta) mountSourceBadge(resp.meta);
    } catch (_) { /* background unavailable — silently skip */ }
  }

  // ---------- Headline relevance highlights (non-article pages) ----------

  function scanHeadlines() {
    const seen = new Set();
    const results = [];
    // Broad selector: any anchor that looks like an article link.
    // First pass: semantic containers and headings.
    // Second pass: any anchor with headline-length text.
    const selectors = [
      'article a[href]', 'section a[href]', '[role="feed"] a[href]',
      'h1 a[href]', 'h2 a[href]', 'h3 a[href]', 'h4 a[href]',
      'a[href] h1', 'a[href] h2', 'a[href] h3', 'a[href] h4',
      '.story a[href]', '.card a[href]', '.post a[href]',
      '[class*="headline"] a[href]', '[class*="title"] a[href]',
      'a[href][class*="headline"]', 'a[href][class*="title"]', 'a[href][class*="story"]'
    ];
    const allAnchors = new Set();
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const a = el.tagName === 'A' ? el : el.closest('a[href]');
          if (a) allAnchors.add(a);
        }
      } catch { /* invalid selector on some pages */ }
    }
    // Fallback: scan all anchors on the page with headline-ish text.
    if (allAnchors.size < 5) {
      for (const a of document.querySelectorAll('a[href]')) {
        const t = (a.textContent || '').trim();
        if (t.length >= 30 && t.length <= 180) allAnchors.add(a);
      }
    }
    for (const a of allAnchors) {
      if (results.length >= 200) break;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 20 || text.length > 200) continue;
      const href = a.href;
      if (!href || href.startsWith('javascript:') || href === '#') continue;
      try {
        const u = new URL(href);
        if (u.pathname === '/' || u.pathname === '') continue;
      } catch { continue; }
      // Skip nav / footer links.
      if (a.closest('nav, footer, [role="navigation"], [role="contentinfo"]')) continue;
      const norm = href.split('?')[0].split('#')[0];
      if (seen.has(norm)) continue;
      seen.add(norm);
      results.push({ element: a, text, url: href });
    }
    return results;
  }

  // ── Full scoring function (ported from web app's scoreArticle) ──

  function scoreHeadline(text, data) {
    const headline = text.toLowerCase();

    // Junk filter — return -1 to flag for removal.
    for (const pat of (data.junkPatterns || [])) {
      try { if (new RegExp(pat, 'i').test(text)) return -1; } catch {}
    }
    if (text.length < 15) return -1;

    let score = 0;

    // ── Region relevance (0-30) ──
    // Match against user's country and its region peers.
    const pCountry = (data.profile?.country || '').toLowerCase();
    let userRegion = null;
    if (pCountry && pCountry !== 'global') {
      for (const [reg, countries] of Object.entries(data.regionCountries || {})) {
        if (countries.some(c => c.toLowerCase() === pCountry)) { userRegion = reg; break; }
      }
    }
    if (userRegion) {
      const countries = (data.regionCountries[userRegion] || []);
      let countryMatches = 0;
      for (const c of countries) {
        if (headline.includes(c.toLowerCase())) countryMatches++;
      }
      if (countryMatches >= 3) score += 30;
      else if (countryMatches >= 2) score += 25;
      else if (countryMatches === 1) score += 18;

      // Skip region penalty if headline matches user's sector/concern.
      if (countryMatches === 0) {
        const concern = (data.profile?.concern || '').toLowerCase();
        const sector = (data.profile?.sector || '').toLowerCase();
        const profileWords = (concern + ' ' + sector).split(/[\s&\/,]+/).filter(w => w.length > 2);
        const relevant = profileWords.some(w => headline.includes(w));
        if (!relevant) score -= 10;
      }
    }

    // Direct country name match in headline.
    if (pCountry && pCountry !== 'global' && headline.includes(pCountry)) {
      score += 8;
    }

    // ── Sector relevance (0-35) ──
    const pSector = data.profile?.sector;
    const activeSectors = pSector ? [pSector, ...(data.topHistorySectors || [])] : (data.topHistorySectors || []);
    const uniqueSectors = [...new Set(activeSectors)];

    if (uniqueSectors.length > 0) {
      const sectorKws = data.sectorKeywords || {};
      let matchScore = 0;
      const matchedSectors = new Set();

      for (const sec of uniqueSectors) {
        const kws = sectorKws[sec] || [];
        const multiWord = kws.filter(k => k.includes(' '));
        const singleWord = kws.filter(k => !k.includes(' '));
        for (const phrase of multiWord) {
          if (headline.includes(phrase.toLowerCase())) {
            matchScore += 12; matchedSectors.add(sec);
          }
        }
        for (const word of singleWord) {
          if (headline.includes(word.toLowerCase())) {
            matchScore += 5; matchedSectors.add(sec);
          }
        }
      }
      if (matchedSectors.size >= 2) matchScore += 10;
      score += Math.min(matchScore, 35);
    }

    // ── Significance boost (0-15) ──
    let sigMatches = 0;
    for (const word of (data.significanceWords || [])) {
      if (headline.includes(word.toLowerCase())) {
        sigMatches++;
        if (sigMatches >= 3) break;
      }
    }
    if (sigMatches >= 3) score += 15;
    else if (sigMatches >= 2) score += 10;
    else if (sigMatches === 1) score += 5;

    // ── Headline quality ──
    const hasNumbers = /\d/.test(text);
    const wordCount = text.split(/\s+/).length;
    if (hasNumbers) score += 3;
    if (wordCount >= 8 && wordCount <= 20) score += 2;

    // Low-value penalty.
    for (const pat of (data.lowValuePatterns || [])) {
      try { if (new RegExp(pat, 'i').test(text)) { score -= 5; break; } } catch {}
    }

    // ── User profile match (0-35) ──
    // Occupation keywords.
    const occupation = (data.profile?.occupation || '').toLowerCase();
    if (occupation) {
      const occWords = occupation.split(/[\s&\/,]+/).filter(w => w.length > 3);
      let occHits = 0;
      for (const w of occWords) { if (headline.includes(w)) occHits++; }
      score += Math.min(occHits * 8, 15);
    }

    // Concern/focus keywords.
    const concern = (data.profile?.concern || '').toLowerCase();
    if (concern) {
      const focusWords = concern.split(/[\s,]+/).filter(w => w.length > 3);
      let focusHits = 0;
      for (const w of focusWords) { if (headline.includes(w)) focusHits++; }
      score += Math.min(focusHits * 10, 20);
    }

    // ── History region affinity (0-10) ──
    for (const reg of (data.topHistoryRegions || [])) {
      if (reg === userRegion) continue; // already scored above
      const countries = (data.regionCountries || {})[reg] || [];
      if (countries.some(c => headline.includes(c.toLowerCase()))) { score += 10; break; }
    }

    return Math.max(Math.min(score, 100), 0);
  }

  // ── Build human-readable reason for a match ──

  function buildReason(text, data) {
    const lower = text.toLowerCase();
    const reasons = [];
    const pSector = data.profile?.sector;
    const sectorKws = data.sectorKeywords || {};

    // Check profile sector.
    if (pSector && sectorKws[pSector]) {
      if (sectorKws[pSector].some(kw => lower.includes(kw.toLowerCase()))) reasons.push(pSector);
    }
    // Country.
    const pCountry = data.profile?.country || '';
    if (pCountry && lower.includes(pCountry.toLowerCase())) reasons.push(pCountry);
    // Concern words.
    const concern = data.profile?.concern || '';
    if (concern) {
      const words = concern.split(/[\s,]+/).filter(w => w.length > 3);
      if (words.some(w => lower.includes(w.toLowerCase()))) reasons.push('Your focus');
    }
    // History sectors.
    for (const sec of (data.topHistorySectors || [])) {
      if (sec === pSector) continue;
      if (sectorKws[sec] && sectorKws[sec].some(kw => lower.includes(kw.toLowerCase()))) reasons.push(sec);
    }
    // Significance.
    const sigHits = (data.significanceWords || []).filter(w => lower.includes(w.toLowerCase()));
    if (sigHits.length >= 2) reasons.push('High significance');

    return [...new Set(reasons)].slice(0, 3).join(', ') || 'Relevant to your profile';
  }

  // ── Highlight UI: pills per headline + floating summary card ──

  function mountHeadlineHighlights(highlights) {
    const host = document.createElement('div');
    host.id = 'geosignal-highlights-host';
    host.style.all = 'initial';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; margin: 0; padding: 0; }

      /* Per-headline pill */
      .gs-pill-layer {
        position: fixed; top: 0; left: 0;
        width: 0; height: 0;
        pointer-events: none;
        z-index: 2147483644;
      }
      .gs-pill {
        position: fixed;
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px;
        background: rgba(15,110,86,0.12);
        border: 1px solid rgba(15,110,86,0.30);
        border-radius: 999px;
        font: 600 10px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #0F6E56;
        letter-spacing: 0.3px;
        white-space: nowrap;
        pointer-events: auto;
        cursor: pointer;
        transition: background 150ms ease, transform 150ms ease;
      }
      .gs-pill:hover { background: rgba(15,110,86,0.22); }
      .gs-pill-dot {
        width: 6px; height: 6px; border-radius: 50%; background: #0F6E56;
        flex-shrink: 0;
      }
      @keyframes gs-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(15,110,86,0.35); }
        50% { box-shadow: 0 0 0 6px rgba(15,110,86,0); }
      }
      .gs-pill.gs-pulse { animation: gs-pulse 0.8s ease 2; }

      /* Floating summary card (bottom-left) */
      .gs-summary-btn {
        position: fixed; bottom: 24px; left: 24px;
        display: flex; align-items: center; gap: 7px;
        padding: 8px 14px;
        background: #1C1917; color: #FAF8F5;
        border: none; border-radius: 999px;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        z-index: 2147483646;
        transition: transform 150ms ease, box-shadow 150ms ease;
        pointer-events: auto;
      }
      .gs-summary-btn:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(0,0,0,0.32); }
      .gs-summary-count {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; height: 20px; border-radius: 50%;
        background: #0F6E56; color: #FAF8F5;
        font-size: 11px; font-weight: 700;
      }

      .gs-summary-panel {
        position: fixed; bottom: 68px; left: 24px;
        width: 340px; max-height: 400px;
        background: #FAF8F5; color: #1C1917;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.18);
        display: flex; flex-direction: column;
        z-index: 2147483646;
        transform: translateY(12px); opacity: 0;
        transition: transform 200ms ease, opacity 200ms ease;
        pointer-events: none;
      }
      .gs-summary-panel.gs-open {
        transform: translateY(0); opacity: 1; pointer-events: auto;
      }
      .gs-sp-header {
        padding: 14px 16px 10px;
        font: 700 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #0F6E56;
        border-bottom: 1px solid rgba(28,25,23,0.08);
      }
      .gs-sp-list {
        flex: 1; overflow-y: auto; padding: 6px 0;
      }
      .gs-sp-item {
        padding: 10px 16px;
        cursor: pointer;
        transition: background 100ms ease;
        border-bottom: 1px solid rgba(28,25,23,0.04);
      }
      .gs-sp-item:hover { background: rgba(15,110,86,0.06); }
      .gs-sp-item:last-child { border-bottom: none; }
      .gs-sp-title {
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1C1917;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .gs-sp-reason {
        font: 400 10px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #0F6E56; margin-top: 3px;
      }
    `;

    const pillLayer = document.createElement('div');
    pillLayer.className = 'gs-pill-layer';

    // Summary button (collapsed state).
    const summaryBtn = document.createElement('button');
    summaryBtn.className = 'gs-summary-btn';
    summaryBtn.type = 'button';
    summaryBtn.innerHTML = `<span class="gs-summary-count">${highlights.length}</span> Relevant for you`;

    // Summary panel (expanded).
    const summaryPanel = document.createElement('div');
    summaryPanel.className = 'gs-summary-panel';
    summaryPanel.innerHTML = `
      <div class="gs-sp-header">Relevant for you (${highlights.length})</div>
      <div class="gs-sp-list"></div>
    `;
    const spList = summaryPanel.querySelector('.gs-sp-list');

    const pills = [];

    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];

      // Per-headline pill.
      const pill = document.createElement('div');
      pill.className = 'gs-pill';
      pill.innerHTML = `<span class="gs-pill-dot"></span>For you`;
      pill.title = h.reason;
      pills.push({ pill, element: h.element });
      pillLayer.appendChild(pill);

      // Summary list item.
      const item = document.createElement('div');
      item.className = 'gs-sp-item';
      const safeTitle = h.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeReason = h.reason.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      item.innerHTML = `<div class="gs-sp-title">${safeTitle}</div><div class="gs-sp-reason">${safeReason}</div>`;
      item.addEventListener('click', () => {
        h.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        summaryPanel.classList.remove('gs-open');
        // Pulse the pill.
        pill.classList.remove('gs-pulse');
        void pill.offsetWidth; // reflow
        pill.classList.add('gs-pulse');
      });
      spList.appendChild(item);
    }

    // Toggle summary panel.
    let panelOpen = false;
    summaryBtn.addEventListener('click', () => {
      panelOpen = !panelOpen;
      summaryPanel.classList.toggle('gs-open', panelOpen);
    });

    // Position pills relative to their headline.
    function positionPills() {
      for (const { pill, element } of pills) {
        const r = element.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) { pill.style.display = 'none'; continue; }
        pill.style.display = '';
        pill.style.left = Math.max(4, r.left) + 'px';
        pill.style.top = (r.top - 18) + 'px';
      }
    }

    let rafId = 0;
    function scheduleReposition() {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(positionPills);
    }

    shadow.append(style, pillLayer, summaryBtn, summaryPanel);
    document.documentElement.appendChild(host);

    requestAnimationFrame(positionPills);
    window.addEventListener('scroll', scheduleReposition, { passive: true });
    window.addEventListener('resize', scheduleReposition, { passive: true });
  }

  async function maybeHighlightHeadlines() {
    // Wait for dynamic content to settle.
    await new Promise(r => setTimeout(r, 600));

    const headlines = scanHeadlines();
    if (headlines.length === 0) return;

    // Primary: Perplexity-powered relevance — sends headlines + profile for smart ranking.
    let perplexityWorked = false;
    try {
      const headlineTexts = headlines.slice(0, 40).map(h => h.text);
      const resp = await chrome.runtime.sendMessage({
        type: 'GEOSIGNAL_PERPLEXITY_RELEVANCE',
        headlines: headlineTexts
      });

      if (resp?.ok && resp.results && resp.results.length > 0) {
        const matches = [];
        for (const r of resp.results) {
          const idx = (r.index || 0) - 1;
          if (idx >= 0 && idx < headlines.length && (r.score || 0) >= 5) {
            matches.push({
              ...headlines[idx],
              score: (r.score || 5) * 10,
              reason: r.reason || 'Relevant to your profile'
            });
          }
        }
        if (matches.length > 0) {
          matches.sort((a, b) => b.score - a.score);
          mountHeadlineHighlights(matches);
          perplexityWorked = true;
        }
      }
    } catch {}

    // Fallback: local keyword scoring if Perplexity failed or returned nothing.
    if (!perplexityWorked) {
      let data;
      try {
        data = await chrome.runtime.sendMessage({ type: 'GEOSIGNAL_GET_SCORING_DATA' });
        if (!data?.ok) return;
      } catch { return; }

      const scored = headlines
        .map(h => ({
          ...h,
          score: scoreHeadline(h.text, data),
          reason: buildReason(h.text, data)
        }))
        .filter(h => h.score >= 15);

      scored.sort((a, b) => b.score - a.score);
      if (scored.length > 0) mountHeadlineHighlights(scored);
    }
  }

  // ---------- Boot ----------

  // Run the qualification check once. Cache the result.
  const pageQualifies = isQualifyingPage();

  // Notify background so it can toggle the icon state.
  try {
    chrome.runtime.sendMessage({ type: 'GEOSIGNAL_PAGE_STATUS', active: pageQualifies });
  } catch {}

  // If the page doesn't qualify, stop here — inject nothing.
  if (!pageQualifies) return;

  // Always try to mount the source badge — known sources get recognised
  // even on non-article pages (home page, section pages, etc.).
  detectAndMountBadge();

  // Detect if this is an index/listing page (many article links) vs a
  // single-article page. Homepages often pass isArticlePage() because
  // they contain <article> tags, so we use a heuristic: if the page has
  // many outgoing article-like links, treat it as an index page too.
  const looksLikeIndex = document.querySelectorAll('a[href]').length > 30;

  if (isArticlePage() && !looksLikeIndex) {
    const article = extractArticle();
    window.__geosignalArticle = article;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => mountUi(article), { once: true });
    } else {
      mountUi(article);
    }
  } else if (isArticlePage() && looksLikeIndex) {
    const article = extractArticle();
    window.__geosignalArticle = article;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => mountUi(article), { once: true });
    } else {
      mountUi(article);
    }
    maybeHighlightHeadlines();
  } else {
    maybeHighlightHeadlines();
  }
})();
