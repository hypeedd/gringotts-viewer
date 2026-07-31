/* app.js — orchestrator: data load, routing, note view, filters, theme, graph. */

import { renderMarkdown } from './render.js';
import * as sidebar from './sidebar.js';
import * as palette from './search.js';
import { createGraph } from './graph.js';

const state = {
  index: null,
  nameIndex: new Map(),   // basename(lower) -> [rel]
  relLower: new Map(),    // rel(lower, no .md) -> rel
  adj: new Map(),         // rel -> Set(neighbor rel)
  filters: { type: new Set(), status: new Set(), tag: new Set() },
  currentRel: null,
  fullGraph: null,
  localGraph: null,
};

const $ = (id) => document.getElementById(id);
const doc = $('doc');
const reader = $('reader');

/* ---- boot ---------------------------------------------------------------- */

initTheme();
bootstrap();

async function bootstrap() {
  doc.innerHTML = `<div class="loading"><span class="spin"></span> Opening the vault…</div>`;
  try {
    const res = await fetch('/api/index');
    state.index = await res.json();
  } catch (e) {
    doc.innerHTML = `<div class="loading">Could not reach the server. Is it still running?</div>`;
    return;
  }
  buildIndexes();
  $('note-count').textContent = state.index.count;
  document.title = `${state.index.vaultName} — Vault`;

  sidebar.initFacetCollapse();
  sidebar.renderFacets(state.index.facets, state.filters, onFacetToggle);
  refreshTree();

  palette.initPalette({ notes: state.index.notes, onOpen: openNote });
  wireChrome();
  route();
}

function buildIndexes() {
  for (const n of state.index.notes) {
    state.nameIndex.set(n.name.toLowerCase(), [...(state.nameIndex.get(n.name.toLowerCase()) || []), n.rel]);
    state.relLower.set(n.rel.toLowerCase().replace(/\.md$/, ''), n.rel);
  }
  for (const [a, b] of state.index.edges) {
    if (!state.adj.has(a)) state.adj.set(a, new Set());
    if (!state.adj.has(b)) state.adj.set(b, new Set());
    state.adj.get(a).add(b); state.adj.get(b).add(a);
  }
}

function noteByRel(rel) { return state.index.notes.find((n) => n.rel === rel); }

function resolveGlobal(name) {
  if (!name) return null;
  const key = name.toLowerCase().replace(/\.md$/, '');
  if (state.relLower.has(key)) return state.relLower.get(key);
  const base = key.split('/').pop();
  const cands = state.nameIndex.get(base);
  if (cands) return cands.slice().sort((a, b) => (a.split('/').length - b.split('/').length) || a.length - b.length)[0];
  return null;
}

/* ---- filters + tree ------------------------------------------------------ */

function filteredNotes() {
  const { type, status, tag } = state.filters;
  return state.index.notes.filter((n) =>
    (!type.size || type.has(n.type)) &&
    (!status.size || status.has(n.status)) &&
    (!tag.size || n.tags.some((t) => tag.has(t))));
}

function onFacetToggle(kind, value) {
  const set = state.filters[kind];
  set.has(value) ? set.delete(value) : set.add(value);
  sidebar.refreshFacetSelection(state.filters);
  refreshTree();
  const anyActive = state.filters.type.size || state.filters.status.size || state.filters.tag.size;
  $('clear-filters').hidden = !anyActive;
  if (state.fullGraph) rebuildFullGraph();
}

function clearFilters() {
  state.filters.type.clear(); state.filters.status.clear(); state.filters.tag.clear();
  sidebar.refreshFacetSelection(state.filters);
  refreshTree();
  $('clear-filters').hidden = true;
  if (state.fullGraph) rebuildFullGraph();
}

function refreshTree() {
  sidebar.renderTree($('tree'), filteredNotes(), { activeRel: state.currentRel, onOpen: openNote });
}

/* ---- routing ------------------------------------------------------------- */

function openNote(rel) { location.hash = `#/note/${encodeURIComponent(rel)}`; closeMobileNav(); }
function goHome() { location.hash = '#/'; }

function route() {
  const h = location.hash;
  if (h.startsWith('#/note/')) {
    const rel = decodeURIComponent(h.slice('#/note/'.length));
    showNote(rel);
  } else if (h === '#/graph') {
    if (!state.currentRel) renderHome();
    openGraph();
  } else {
    renderHome();
  }
}
window.addEventListener('hashchange', route);

/* ---- home ---------------------------------------------------------------- */

function renderHome() {
  state.currentRel = null;
  setRightRail(false);
  sidebar.markActive($('tree'), '__none__');
  const idx = state.index;
  const recent = [...idx.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 8);
  const mocs = idx.notes.filter((n) => n.type === 'moc').sort((a, b) => a.title.localeCompare(b.title));
  const topFolders = new Set(idx.notes.map((n) => (n.folder || '').split('/')[0]).filter(Boolean));

  const card = (n) => `<a class="ncard" href="#/note/${encodeURIComponent(n.rel)}">
      <div class="nc-type">${n.type || 'note'}</div>
      <div class="nc-title">${esc(n.title)}</div>
      <div class="nc-folder">${esc(n.folder || 'vault')}</div></a>`;

  doc.innerHTML = `
    <section class="home-hero">
      <div class="home-eyebrow">Knowledge Vault</div>
      <h1 class="home-title">Everything you<br>know, <em>kept safe.</em></h1>
      <p class="home-lede">A quiet place to read and roam ${idx.count} notes — follow the links, chase the backlinks, or press <kbd>⌘K</kbd> to jump anywhere.</p>
    </section>
    <div class="home-stats">
      <div class="stat"><div class="num">${idx.count}</div><div class="lbl">Notes</div></div>
      <div class="stat"><div class="num">${idx.edges.length}</div><div class="lbl">Links</div></div>
      <div class="stat"><div class="num">${topFolders.size}</div><div class="lbl">Sections</div></div>
      <div class="stat"><div class="num">${Object.keys(idx.facets.tags).length}</div><div class="lbl">Tags</div></div>
    </div>
    ${mocs.length ? `<div class="home-h">Maps of content</div><div class="card-grid">${mocs.slice(0, 8).map(card).join('')}</div>` : ''}
    <div class="home-h">Recently edited</div>
    <div class="card-grid">${recent.map(card).join('')}</div>`;
  reader.scrollTop = 0;
  setProgress(0);
}

/* ---- note view ----------------------------------------------------------- */

async function showNote(rel) {
  state.currentRel = rel;
  refreshTree();
  sidebar.markActive($('tree'), rel);
  doc.innerHTML = `<div class="loading"><span class="spin"></span> Reading…</div>`;
  reader.scrollTop = 0;

  let note;
  try {
    const res = await fetch(`/api/note?path=${encodeURIComponent(rel)}`);
    if (!res.ok) throw new Error('missing');
    note = await res.json();
  } catch (e) {
    doc.innerHTML = `<div class="loading">That note could not be found. <a href="#/">Back home</a>.</div>`;
    setRightRail(false);
    return;
  }

  const ctx = { resolve: (name) => (name in note.linkMap ? note.linkMap[name] : resolveGlobal(name)) };
  const body = renderMarkdown(note.markdown, ctx);

  const crumbs = buildCrumbs(note);
  const meta = buildMeta(note);
  doc.innerHTML = '';
  const head = document.createElement('div');
  head.innerHTML = `${crumbs}<h1 class="note-title">${esc(note.title)}</h1>${meta}<hr class="note-sep">`;
  doc.appendChild(head);
  doc.appendChild(body);

  enhanceCode(body);
  buildOutline(note, body);
  buildConnections(note);
  buildLocalGraph(rel);
  document.title = `${note.title} — Vault`;
  setProgress(0);
  observeHeadings();
}

function buildCrumbs(note) {
  const parts = (note.folder || '').split('/').filter(Boolean);
  let acc = [`<a href="#/">Vault</a>`];
  for (const p of parts) acc.push(`<span class="sep">›</span><span>${esc(p)}</span>`);
  return `<nav class="crumbs">${acc.join('')}</nav>`;
}

function buildMeta(note) {
  const pills = [];
  if (note.type) pills.push(`<span class="meta-pill type">${esc(note.type)}</span>`);
  if (note.status) pills.push(`<span class="meta-pill status ${esc(note.status)}">${esc(note.status)}</span>`);
  const date = note.mtime ? new Date(note.mtime * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  if (date) pills.push(`<span class="meta-pill">edited ${date}</span>`);
  const tags = note.tags.length
    ? `<div class="meta-tags">${note.tags.map((t) => `<span class="meta-tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>` : '';
  return `<div class="note-meta">${pills.join('')}</div>${tags}`;
}

function enhanceCode(container) {
  container.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.parentElement.querySelector('code');
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = 'Copied'; btn.classList.add('done');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
      } catch (_) { btn.textContent = 'Failed'; }
    });
  });
}

function buildOutline(note, body) {
  const block = $('outline-block');
  const nav = $('outline');
  const heads = [...body.querySelectorAll('h1, h2, h3, h4')];
  if (heads.length < 2) { block.hidden = true; nav.innerHTML = ''; return; }
  block.hidden = false;
  nav.innerHTML = heads.map((h) => {
    const lvl = +h.tagName[1];
    return `<a class="lvl-${lvl}" href="#${h.id}" data-target="${h.id}">${esc(h.textContent.replace('¶', '').trim())}</a>`;
  }).join('');
  nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const t = document.getElementById(a.dataset.target);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function buildConnections(note) {
  // Related
  const relBlock = $('related-block'), relEl = $('related');
  if (note.related && note.related.length) {
    relBlock.hidden = false;
    relEl.innerHTML = note.related.map(linkItem).join('');
    wireLinkItems(relEl);
  } else { relBlock.hidden = true; relEl.innerHTML = ''; }

  // Backlinks
  const backBlock = $('backlinks-block'), backEl = $('backlinks');
  $('backlinks-count').textContent = note.backlinks.length || '';
  if (note.backlinks.length) {
    backBlock.hidden = false;
    backEl.innerHTML = note.backlinks.map(linkItem).join('');
    wireLinkItems(backEl);
  } else { backBlock.hidden = true; backEl.innerHTML = ''; }

  setRightRail(true);
}

function linkItem(item) {
  if (!item.rel) {
    return `<span class="linkitem dead" title="Unresolved"><span class="li-title">${esc(item.title)}</span></span>`;
  }
  return `<a class="linkitem" data-rel="${esc(item.rel)}" href="#/note/${encodeURIComponent(item.rel)}">
      <span class="li-title">${esc(item.title)}</span>
      <span class="li-folder">${esc(item.folder || 'vault')}</span></a>`;
}
function wireLinkItems(scope) { /* anchors already route via hash */ }

function buildLocalGraph(rel) {
  const block = $('localgraph-block');
  const neighbors = state.adj.get(rel) || new Set();
  if (neighbors.size === 0) { block.hidden = true; return; }
  block.hidden = false;
  const relset = new Set([rel, ...neighbors]);
  const nodes = [...relset].map((r) => { const n = noteByRel(r); return { rel: r, title: n ? n.title : r }; });
  const edges = [];
  for (const [a, b] of state.index.edges) if (relset.has(a) && relset.has(b)) edges.push([a, b]);

  if (state.localGraph) state.localGraph.stop();
  const canvas = $('localgraph');
  canvas.style.height = Math.min(120 + neighbors.size * 10, 300) + 'px';
  state.localGraph = createGraph(canvas, {
    nodes, edges, centerRel: rel, interactive: true, showLabels: true,
    colorFn: () => 'n', onSelect: openNote,
  });
}

/* ---- outline scroll-spy -------------------------------------------------- */

let headingObserver = null;
function observeHeadings() {
  if (headingObserver) headingObserver.disconnect();
  const heads = [...doc.querySelectorAll('h1, h2, h3, h4')];
  if (!heads.length) return;
  const links = new Map([...$('outline').querySelectorAll('a')].map((a) => [a.dataset.target, a]));
  headingObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        links.forEach((a) => a.classList.remove('current'));
        const a = links.get(e.target.id);
        if (a) a.classList.add('current');
      }
    }
  }, { root: reader, rootMargin: '0px 0px -75% 0px', threshold: 0 });
  heads.forEach((h) => headingObserver.observe(h));
}

/* ---- graph overlay ------------------------------------------------------- */

function openGraph() {
  const overlay = $('graph-overlay');
  overlay.hidden = false;
  const canvas = $('graph-canvas');
  requestAnimationFrame(() => rebuildFullGraph());
}
function closeGraph() {
  $('graph-overlay').hidden = true;
  if (state.fullGraph) { state.fullGraph.stop(); }
  if (location.hash === '#/graph') history.back();
}

function colorFnFor(mode) {
  return (n) => {
    const note = noteByRel(n.rel);
    if (!note) return '·';
    return mode === 'type' ? (note.type || 'untyped') : ((note.folder || 'root').split('/')[0] || 'root');
  };
}

function rebuildFullGraph() {
  const canvas = $('graph-canvas');
  const visible = new Set(filteredNotes().map((n) => n.rel));
  const nodes = filteredNotes().map((n) => ({ rel: n.rel, title: n.title }));
  const edges = state.index.edges.filter(([a, b]) => visible.has(a) && visible.has(b));
  const mode = $('graph-color').value;
  if (state.fullGraph) state.fullGraph.stop();
  state.fullGraph = createGraph(canvas, {
    nodes, edges, interactive: true, showLabels: true,
    colorFn: colorFnFor(mode), centerRel: null,
    onSelect: (rel) => { closeGraph(); openNote(rel); },
  });
  buildLegend();
}

function buildLegend() {
  const legend = $('graph-legend');
  const g = state.fullGraph;
  const groups = [...g.colorGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  legend.innerHTML = groups.map(([name, color]) =>
    `<div class="legend-item" data-group="${esc(name)}"><span class="sw" style="background:${color}"></span>${esc(name)}</div>`).join('');
  legend.querySelectorAll('.legend-item').forEach((el) => {
    el.addEventListener('click', () => {
      const group = el.dataset.group;
      const hidden = g.hiddenGroups;
      hidden.has(group) ? hidden.delete(group) : hidden.add(group);
      el.classList.toggle('off', hidden.has(group));
      g.setHiddenGroups(hidden);
    });
  });
}

/* ---- chrome: theme, shortcuts, mobile, progress -------------------------- */

function wireChrome() {
  $('omnibar').addEventListener('click', () => palette.open());
  $('btn-theme').addEventListener('click', toggleTheme);
  $('btn-graph').addEventListener('click', () => { location.hash = '#/graph'; });
  $('graph-close').addEventListener('click', closeGraph);
  $('graph-color').addEventListener('change', rebuildFullGraph);
  $('clear-filters').addEventListener('click', clearFilters);
  $('btn-menu').addEventListener('click', toggleMobileNav);
  $('scrim').addEventListener('click', closeMobileNav);

  // Delegated clicks inside rendered notes.
  doc.addEventListener('click', (e) => {
    const wl = e.target.closest('a.wikilink');
    if (wl && wl.dataset.rel) { e.preventDefault(); openNote(wl.dataset.rel); return; }
    const anchor = e.target.closest('a.h-anchor');
    if (anchor) {
      e.preventDefault();
      const id = anchor.getAttribute('href').slice(1);
      const t = document.getElementById(id);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const tag = e.target.closest('.meta-tag');
    if (tag) { e.preventDefault(); applyTagFilter(tag.dataset.tag); }
  });

  reader.addEventListener('scroll', () => {
    const max = reader.scrollHeight - reader.clientHeight;
    setProgress(max > 0 ? reader.scrollTop / max : 0);
  }, { passive: true });

  window.addEventListener('resize', debounce(() => {
    if (state.fullGraph && !$('graph-overlay').hidden) { state.fullGraph.resize(); state.fullGraph.reheat(); }
    if (state.localGraph) { state.localGraph.resize(); state.localGraph.draw(); }
  }, 150));

  document.addEventListener('keydown', onKey);
}

function applyTagFilter(tag) {
  state.filters.tag.clear(); state.filters.tag.add(tag);
  state.filters.type.clear(); state.filters.status.clear();
  sidebar.refreshFacetSelection(state.filters);
  refreshTree();
  $('clear-filters').hidden = false;
  goHome();
}

function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.open(); return; }
  if (palette.isOpen()) return;
  if (!$('graph-overlay').hidden && e.key === 'Escape') { closeGraph(); return; }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); palette.open(); }
  else if (e.key.toLowerCase() === 'g') { location.hash = '#/graph'; }
  else if (e.key.toLowerCase() === 'h') { goHome(); }
  else if (e.key.toLowerCase() === 't') { toggleTheme(); }
  else if (e.key === 'Escape') { closeMobileNav(); }
}

function setProgress(frac) { $('reading-progress').style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`; }

/* Theme */
function initTheme() {
  const saved = localStorage.getItem('gv-theme');
  const theme = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(theme);
}
function toggleTheme() { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('gv-theme', theme);
  const dark = $('hljs-dark'), light = $('hljs-light');
  if (dark && light) {
    dark.media = theme === 'dark' ? 'all' : 'not all';
    light.media = theme === 'light' ? 'all' : 'not all';
  }
  if (state.fullGraph) state.fullGraph.draw();
  if (state.localGraph) state.localGraph.draw();
}

/* Mobile nav */
function toggleMobileNav() { $('rail-left').classList.toggle('open'); $('scrim').hidden = !$('rail-left').classList.contains('open'); }
function closeMobileNav() { $('rail-left').classList.remove('open'); $('scrim').hidden = true; }

function setRightRail(show) {
  ['related-block', 'backlinks-block', 'localgraph-block', 'outline-block'].forEach((id) => {
    if (!show) $(id).hidden = true;
  });
}

/* utils */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
