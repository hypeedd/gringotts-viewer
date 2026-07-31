/* search.js — command palette: fuzzy quick-open + server full-text search. */

let notes = [];
let onOpen = () => {};
let overlay, input, resultsEl;
let results = [];      // current rendered results
let sel = 0;
let searchSeq = 0;
let debounceTimer = null;

/* Subsequence fuzzy scorer: rewards contiguous, start-of-word, early matches. */
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length * 0.1;
  const idx = t.indexOf(q);
  if (idx !== -1) return 500 - idx * 2 - t.length * 0.1;
  // subsequence
  let qi = 0, score = 0, prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += (ti === prev + 1) ? 6 : 2;          // contiguity bonus
      if (ti === 0 || /[\s/\-_]/.test(t[ti - 1])) score += 4; // word-start bonus
      prev = ti; qi++;
    }
  }
  return qi === q.length ? score : -1;
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) +
    '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' +
    escapeHtml(text.slice(idx + query.length));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function quickOpen(query) {
  const scored = [];
  for (const n of notes) {
    const s = fuzzyScore(query, n.title);
    const sp = fuzzyScore(query, n.rel);
    const best = Math.max(s, sp * 0.6);
    if (best > 0) scored.push({ note: n, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map(({ note }) => ({
    kind: 'note', rel: note.rel, title: note.title, folder: note.folder, type: note.type,
  }));
}

function render(query) {
  resultsEl.innerHTML = '';
  if (!results.length) {
    resultsEl.innerHTML = `<div class="palette-empty">${query ? 'No matches. Try fewer letters.' : 'Type to search the vault.'}</div>`;
    return;
  }
  results.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'presult' + (i === sel ? ' sel' : '');
    const badge = r.kind === 'text' ? '<span class="p-kind">text</span>' : '';
    const snip = r.snippet ? `<div class="p-snip">${highlightSnippet(r.snippet, query)}</div>` : '';
    el.innerHTML =
      `<div class="p-body"><div class="p-title">${highlight(r.title, query)}</div>` +
      `<div class="p-sub">${r.folder || 'vault'}${r.type ? ' · ' + r.type : ''}</div>${snip}</div>${badge}`;
    el.addEventListener('click', () => choose(i));
    el.addEventListener('mousemove', () => { if (sel !== i) { sel = i; paintSel(); } });
    resultsEl.appendChild(el);
  });
}

function highlightSnippet(snippet, query) {
  if (!query) return escapeHtml(snippet);
  const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return escapeHtml(snippet).replace(new RegExp(escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'),
    (m) => `<mark>${m}</mark>`);
}

function paintSel() {
  [...resultsEl.children].forEach((el, i) => el.classList.toggle('sel', i === sel));
  const cur = resultsEl.children[sel];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const r = results[i];
  if (!r) return;
  close();
  onOpen(r.rel);
}

async function runSearch(query) {
  const q = query.trim();
  sel = 0;
  if (!q) { results = []; render(q); return; }

  // Immediate: fuzzy title quick-open.
  results = quickOpen(q);
  render(q);

  // Debounced: server full-text, merged in.
  clearTimeout(debounceTimer);
  const seq = ++searchSeq;
  debounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (seq !== searchSeq) return; // stale
      const have = new Set(results.map((r) => r.rel));
      const textHits = data.results
        .filter((r) => !have.has(r.rel))
        .map((r) => ({ kind: 'text', rel: r.rel, title: r.title, folder: r.folder, type: r.type, snippet: r.snippet }));
      results = results.concat(textHits).slice(0, 30);
      render(q);
    } catch (_) {}
  }, 130);
}

export function initPalette(opts) {
  notes = opts.notes;
  onOpen = opts.onOpen;
  overlay = document.getElementById('palette');
  input = document.getElementById('palette-input');
  resultsEl = document.getElementById('palette-results');

  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paintSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
}

export function updateNotes(list) { notes = list; }

export function open(prefill = '') {
  overlay.hidden = false;
  input.value = prefill;
  runSearch(prefill);
  requestAnimationFrame(() => input.focus());
}
export function close() {
  overlay.hidden = true;
  input.value = '';
  results = [];
}
export function isOpen() { return !overlay.hidden; }
