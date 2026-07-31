/* render.js — Markdown → HTML with the Obsidian dialect.
   Wraps `marked` (global) and post-processes wikilinks, embeds, and callouts.  */

const CALLOUT_ICONS = {
  note: '✎', info: 'ℹ', tip: '✷', success: '✓', check: '✓',
  warning: '△', caution: '△', important: '❖', attention: '!', danger: '!',
  error: '✕', bug: '❁', definition: '§', quote: '❝', abstract: '≡',
  example: '❯', todo: '☐', question: '?', failure: '✕', danger2: '!',
};

const CALLOUT_ALIASES = {
  caution: 'warning', check: 'success', danger: 'attention', error: 'attention',
  fail: 'attention', failure: 'attention', bug: 'attention', hint: 'tip',
  question: 'info', help: 'info', faq: 'info', abstract: 'definition',
  summary: 'definition', tldr: 'definition', quote: 'definition',
  cite: 'definition', example: 'definition', todo: 'note',
};

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

let _slugCounts;
function slugify(text) {
  const base = String(text).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-') || 'section';
  const n = _slugCounts.get(base) || 0;
  _slugCounts.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

// Configure marked once.
let configured = false;
function configureMarked() {
  if (configured) return;
  configured = true;
  marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: false,
    mangle: false,
    highlight(code, lang) {
      try {
        if (lang && window.hljs && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang, ignoreIllegal: true }).value;
        }
        if (window.hljs) return hljs.highlightAuto(code).value;
      } catch (_) {}
      return null; // marked will escape
    },
  });

  // Heading renderer: stable slugs + hover anchor.
  const renderer = new marked.Renderer();
  const origCode = renderer.code.bind(renderer);
  renderer.heading = (text, level) => {
    const slug = slugify(text.replace(/<[^>]+>/g, ''));
    const anchor = level <= 4
      ? `<a class="h-anchor" href="#h-${slug}" aria-label="Link to section">¶</a>`
      : '';
    return `<h${level} id="h-${slug}">${text}${anchor}</h${level}>`;
  };
  renderer.code = (code, infostring, escaped) => {
    const html = origCode(code, infostring, escaped);
    const lang = (infostring || '').match(/\S*/)[0];
    const tag = lang ? `<span class="code-lang">${escAttr(lang)}</span>` : '';
    return html.replace('<pre>', `<pre>${tag}<button class="copy-btn" type="button">Copy</button>`);
  };
  marked.use({ renderer });
}

/* ---- Pre-processing: callouts & embeds (before markdown) ------------------ */

// Convert Obsidian callout blockquotes into fenced HTML we can style.
// > [!warning] Title
// > body...
function transformCallouts(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/);
    if (m) {
      const rawType = m[1].toLowerCase();
      const type = CALLOUT_ALIASES[rawType] || rawType;
      const titleText = m[3].trim();
      const body = [];
      i++;
      while (i < lines.length && /^>/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const icon = CALLOUT_ICONS[rawType] || CALLOUT_ICONS[type] || '❖';
      const title = titleText || (rawType.charAt(0).toUpperCase() + rawType.slice(1));
      // Marker tokens survive markdown; we split the callout back out afterwards.
      out.push(`\n\x01CALLOUT:${type}:${icon}:${encodeURIComponent(title)}\x01\n`);
      out.push(body.join('\n'));
      out.push(`\n\x02ENDCALLOUT\x02\n`);
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

// Replace ![[embed]] BEFORE markdown so images/pdfs are handled by us.
function transformEmbeds(src, ctx) {
  return src.replace(/!\[\[([^\]]+?)\]\]/g, (_, inner) => {
    const target = inner.split('|')[0].split('#')[0].trim();
    const rel = ctx.resolve(target);
    if (!rel) return `\n\x03EMBED-MISSING:${encodeURIComponent(target)}\x03\n`;
    const ext = rel.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
      return `\n\x03EMBED-IMG:${encodeURIComponent(rel)}:${encodeURIComponent(target)}\x03\n`;
    }
    if (ext === 'pdf') return `\n\x03EMBED-PDF:${encodeURIComponent(rel)}:${encodeURIComponent(target)}\x03\n`;
    if (['mp4', 'webm'].includes(ext)) return `\n\x03EMBED-VID:${encodeURIComponent(rel)}\x03\n`;
    return `\n\x03EMBED-MISSING:${encodeURIComponent(target)}\x03\n`;
  });
}

// Replace [[wikilink]] with a placeholder that we turn into an <a> post-render,
// so link targets can be resolved and styled (resolved vs. unresolved).
function transformWikilinks(src, ctx) {
  return src.replace(/(?<!!)\[\[([^\]]+?)\]\]/g, (_, inner) => {
    let [target, alias] = inner.split('|');
    target = target.trim();
    const display = (alias || target.split('#')[0].split('/').pop()).trim();
    const bare = target.split('#')[0].split('^')[0].trim();
    const rel = ctx.resolve(bare);
    const cls = rel ? 'wikilink' : 'wikilink unresolved';
    const data = rel ? `data-rel="${escAttr(rel)}"` : `data-unresolved="${escAttr(bare)}"`;
    const title = rel ? escAttr(bare) : `Unresolved: ${escAttr(bare)}`;
    return `\x04<a class="${cls}" ${data} title="${title}">${escAttr(display)}</a>\x04`;
  });
}

/* ---- Math (KaTeX) --------------------------------------------------------- *
   Pull $$…$$ and $…$ out BEFORE markdown so marked can't mangle the TeX
   (underscores, carets, backslashes), then render into placeholders after.   */

let _mathStore = [];

function protectMath(src) {
  _mathStore = [];
  // Keep escaped \$ literal — swap to a token that survives everything.
  src = src.replace(/\\\$/g, '\x06');
  // Block/display math first, then inline. Guards avoid matching currency ($5 … $9).
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    _mathStore.push({ tex: tex.trim(), display: true });
    return `\x05M${_mathStore.length - 1}\x05`;
  });
  src = src.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_, tex) => {
    _mathStore.push({ tex: tex.trim(), display: false });
    return `\x05M${_mathStore.length - 1}\x05`;
  });
  return src;
}

function restoreMath(container) {
  if (!_mathStore.length) {
    container.innerHTML = container.innerHTML.replace(/\x06/g, '$');
    return;
  }
  let html = container.innerHTML;
  html = html.replace(/\x05M(\d+)\x05/g, (_, i) => {
    const item = _mathStore[+i];
    if (!item) return '';
    try {
      return window.katex.renderToString(item.tex, {
        displayMode: item.display, throwOnError: false, output: 'html',
      });
    } catch (e) {
      const raw = (item.display ? '$$' : '$') + item.tex + (item.display ? '$$' : '$');
      return `<code class="math-error" title="${escAttr(String(e.message || e))}">${escAttr(raw)}</code>`;
    }
  });
  html = html.replace(/\x06/g, '$'); // restore escaped dollar signs
  container.innerHTML = html;
}

/* ---- Post-processing on the DOM ------------------------------------------ */

function finalizeDom(container) {
  // Restore callout markers.
  let html = container.innerHTML;
  html = html.replace(/\x01CALLOUT:([\w-]+):(.):([^\x01]+)\x01/g, (_, type, icon, title) =>
    `<div class="callout ${type}"><div class="callout-title"><span class="ci">${icon}</span><span>${decodeURIComponent(title)}</span></div><div class="callout-body">`);
  html = html.replace(/\x02ENDCALLOUT\x02/g, '</div></div>');

  // Embeds.
  html = html.replace(/\x03EMBED-IMG:([^:]+):([^\x03]+)\x03/g, (_, rel, name) =>
    `<img src="/api/asset?path=${encodeURIComponent(decodeURIComponent(rel))}" alt="${decodeURIComponent(name)}" loading="lazy">`);
  html = html.replace(/\x03EMBED-PDF:([^:]+):([^\x03]+)\x03/g, (_, rel, name) =>
    `<iframe class="embed-pdf" src="/api/asset?path=${encodeURIComponent(decodeURIComponent(rel))}#view=FitH" title="${decodeURIComponent(name)}"></iframe>`);
  html = html.replace(/\x03EMBED-VID:([^\x03]+)\x03/g, (_, rel) =>
    `<video class="embed-pdf" controls src="/api/asset?path=${encodeURIComponent(decodeURIComponent(rel))}"></video>`);
  html = html.replace(/\x03EMBED-MISSING:([^\x03]+)\x03/g, (_, name) =>
    `<span class="embed-missing">⌧ Embedded file not found: <code>${decodeURIComponent(name)}</code></span>`);

  // Wikilink guards (\x04 wrappers just protected them through markdown).
  html = html.replace(/\x04/g, '');
  container.innerHTML = html;
}

/* ---- Public API ---------------------------------------------------------- */

// ctx.resolve(name) -> rel|null  (from the note's linkMap, basename-aware)
export function renderMarkdown(md, ctx) {
  configureMarked();
  _slugCounts = new Map();
  let src = md;
  src = protectMath(src);          // pull TeX out before anything else touches it
  src = transformCallouts(src);
  src = transformEmbeds(src, ctx);
  src = transformWikilinks(src, ctx);
  const container = document.createElement('div');
  container.className = 'md';
  container.innerHTML = marked.parse(src);
  finalizeDom(container);
  restoreMath(container);          // render KaTeX into the placeholders
  return container;
}
