import { loadEnvelope, unlockWithPassword, unlockWithRemembered, forget, photoUrl } from './crypto.js';
import { buildModel, layout, CARD_H } from './layout.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
};
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let model, view, meta;
let selected = null;
let lineFilter = '';

// ── names ─────────────────────────────────────────────────────────────
function displayName(p) {
  if (p.prenume) return [p.prenume, p.nume].filter(Boolean).join(' ');
  if (p.nume && p.eticheta) return `${p.nume} (${p.eticheta})`;
  return p.nume || p.eticheta || 'Necunoscut';
}
const isUnnamed = (p) => !p.prenume;
function lifeLine(p) {
  const parts = [];
  if (p.nascut) parts.push('n. ' + p.nascut);
  if (p.loc) parts.push(p.loc);
  if (p.decedat) parts.push('† ' + p.decedat);
  return parts.join(' · ');
}

// ── unlock ────────────────────────────────────────────────────────────
async function start() {
  try { await loadEnvelope(); } catch (e) { $('lock-msg').textContent = e.message; $('unlock').disabled = true; return; }
  const tree = await unlockWithRemembered();
  if (tree) return open(tree);
  $('lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('unlock');
    btn.disabled = true; btn.textContent = 'Se deschide…'; $('lock-msg').textContent = '';
    const t = await unlockWithPassword($('pw').value, $('remember').checked);
    btn.disabled = false; btn.textContent = 'Intră';
    if (!t) { $('lock-msg').textContent = 'Parolă greșită.'; $('pw').select(); return; }
    open(t);
  });
  $('pw').focus();
}

function open(tree) {
  meta = tree.meta || {};
  model = buildModel(tree);
  view = layout(model);
  $('lock').hidden = true;
  $('app').hidden = false;
  $('pw').value = '';
  fillLines();
  render();
  initPanZoom();
  initSearch();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && model.people.has(fromHash)) select(fromHash, true);
  else {
    // start on the newest generation, the chart's focal point
    const newest = [...model.people.values()].sort((a, b) => b.g - a.g || (a.src ? 0 : 1) - (b.src ? 0 : 1))[0];
    centerOn(newest.id, 0.75, false);
  }
}

// ── render ────────────────────────────────────────────────────────────
const PAD = 160; // room for generation labels on the left
const cardEls = new Map();
let pathEls = [];

function render() {
  const cards = $('cards');
  cards.replaceChildren();
  cardEls.clear();
  for (const c of view.cards) {
    let node;
    if (c.kind === 'ph') {
      node = el('div', { class: 'card ph', 'aria-hidden': 'true' }, 'partener', el('br'), 'necunoscut');
    } else {
      const p = model.people.get(c.id);
      node = el('button', { class: 'card' + (p.sex ? ' sex-' + p.sex : ''), type: 'button', 'data-id': p.id, title: displayName(p) },
        el('span', { class: 'c-name' + (isUnnamed(p) ? ' unnamed' : ''), text: displayName(p) }),
        p.porecla ? el('span', { class: 'c-meta', text: `„${p.porecla}”` }) : null,
        lifeLine(p) ? el('span', { class: 'c-meta', text: lifeLine(p) }) : null,
      );
    }
    Object.assign(node.style, { left: c.x + PAD + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px' });
    node.dataset.slot = c.id;
    cards.append(node);
    cardEls.set(c.id, node);
  }
  for (const g of view.gens) {
    cards.append(el('div', { class: 'gen-label', text: `Generația ${g}`, style: `left:0;top:${view.rowY(g) + CARD_H / 2 - 12}px` }));
  }
  const svg = $('lines');
  svg.setAttribute('width', view.width + PAD * 2);
  svg.setAttribute('height', view.height + 40);
  svg.replaceChildren();
  pathEls = view.lines.map((l) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', l.d);
    path.setAttribute('transform', `translate(${PAD},0)`);
    if (l.dashed) path.classList.add('dashed');
    svg.append(path);
    return { path, ids: l.ids };
  });
  cards.onclick = (e) => {
    const b = e.target.closest('button.card');
    if (b && !pz.moved) select(b.dataset.id);
  };
  applyFilter();
}

function applyFilter() {
  const inLine = (id) => !lineFilter || String(model.people.get(id)?.linie || '').split(';').map((s) => s.trim()).includes(lineFilter);
  for (const c of view.cards) {
    const id = c.kind === 'ph' ? c.of : c.id;
    cardEls.get(c.id).classList.toggle('dim', !inLine(id));
  }
  for (const { path, ids } of pathEls) path.classList.toggle('dim', !ids.some(inLine));
}

function fillLines() {
  const lines = new Set();
  for (const p of model.people.values()) for (const l of String(p.linie || '').split(';')) if (l.trim()) lines.add(l.trim());
  const sel = $('line');
  for (const l of [...lines].sort()) sel.append(el('option', { value: l, text: l }));
  sel.addEventListener('change', () => { lineFilter = sel.value; applyFilter(); });
}

// ── pan & zoom ────────────────────────────────────────────────────────
const pz = { x: 0, y: 0, s: 1, moved: false };
function applyTransform(animate) {
  const w = $('world');
  w.classList.toggle('animate', !!animate);
  w.style.transform = `translate(${pz.x}px,${pz.y}px) scale(${pz.s})`;
}
const clampS = (s) => Math.min(2.5, Math.max(0.06, s));
function zoomAt(cx, cy, factor) {
  const r = $('viewport').getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const s = clampS(pz.s * factor);
  pz.x = px - ((px - pz.x) * s) / pz.s;
  pz.y = py - ((py - pz.y) * s) / pz.s;
  pz.s = s;
  applyTransform(false);
}
function fit() {
  const r = $('viewport').getBoundingClientRect();
  const w = view.width + PAD * 2, h = view.height + 80;
  pz.s = clampS(Math.min(r.width / w, r.height / h));
  pz.x = (r.width - w * pz.s) / 2;
  pz.y = (r.height - h * pz.s) / 2 + 20 * pz.s;
  applyTransform(true);
}
function centerOn(slotId, scale, animate = true) {
  const c = view.cards.find((k) => k.id === slotId);
  if (!c) return;
  // centre in the part of the tree the panel doesn't cover (beside it on desktop, above it on phones)
  const r = $('viewport').getBoundingClientRect();
  let visW = r.width, visH = r.height;
  if (!$('panel').hidden) {
    const pr = $('panel').getBoundingClientRect();
    if (pr.width < r.width - 10) visW = Math.max(120, pr.left - r.left);
    else visH = Math.max(120, pr.top - r.top);
  }
  if (scale) pz.s = clampS(scale);
  pz.x = visW / 2 - (c.x + PAD + c.w / 2) * pz.s;
  pz.y = visH / 2 - (c.y + c.h / 2) * pz.s;
  applyTransform(animate);
}

function initPanZoom() {
  const vp = $('viewport');
  const pointers = new Map();
  let last = null, pinch = null, downAt = null;
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zoom')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pz.moved = false;
    downAt = { x: e.clientX, y: e.clientY };
    last = { x: e.clientX, y: e.clientY };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
      pinch.d = d;
      pz.moved = true;
      return;
    }
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) { pz.moved = true; vp.classList.add('dragging'); }
    if (pz.moved) {
      pz.x += e.clientX - last.x;
      pz.y += e.clientY - last.y;
      applyTransform(false);
    }
    last = { x: e.clientX, y: e.clientY };
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) last = [...pointers.values()][0];
    if (!pointers.size) vp.classList.remove('dragging');
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  const r0 = () => $('viewport').getBoundingClientRect();
  $('zoom-in').onclick = () => { const r = r0(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.3); };
  $('zoom-out').onclick = () => { const r = r0(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.3); };
  $('fit').onclick = fit;
  $('brand').onclick = (e) => { e.preventDefault(); closePanel(); fit(); };
  $('logout').onclick = () => { forget(); location.hash = ''; location.reload(); };
}

// ── search ────────────────────────────────────────────────────────────
function initSearch() {
  const q = $('q'), list = $('results');
  const index = [...model.people.values()].map((p) => ({ p, hay: fold([displayName(p), p.porecla, p.nume, p.eticheta].join(' ')) }));
  let hits = [], active = 0;
  const close = () => { list.hidden = true; q.setAttribute('aria-expanded', 'false'); };
  const choose = (i) => { const h = hits[i]; if (!h) return; close(); q.value = ''; select(h.id); };
  const draw = () => {
    list.replaceChildren(...hits.map((p, i) => el('li', {
      role: 'option', id: 'r' + i, 'aria-selected': i === active ? 'true' : 'false',
      onmousedown: (e) => { e.preventDefault(); choose(i); },
    }, el('span', { text: displayName(p) }), el('span', { class: 'sub', text: [p.porecla && `„${p.porecla}”`, lifeLine(p), `Gen. ${p.g}`].filter(Boolean).join(' · ') }))));
    list.hidden = !hits.length;
    q.setAttribute('aria-expanded', String(!!hits.length));
    q.setAttribute('aria-activedescendant', hits.length ? 'r' + active : '');
  };
  q.addEventListener('input', () => {
    const terms = fold(q.value).split(/\s+/).filter(Boolean);
    hits = terms.length ? index.filter((x) => terms.every((t) => x.hay.includes(t))).slice(0, 10).map((x) => x.p) : [];
    active = 0;
    draw();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, hits.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  q.addEventListener('blur', () => setTimeout(close, 100));
}

// ── selection & panel ─────────────────────────────────────────────────
function select(id, fromLoad = false) {
  const p = model.people.get(id);
  if (!p) return;
  if (selected) cardEls.get(selected)?.classList.remove('selected');
  selected = id;
  cardEls.get(id)?.classList.add('selected');
  for (const { path, ids } of pathEls) path.classList.toggle('hl', ids.includes(id));
  history.replaceState(null, '', '#' + encodeURIComponent(id));
  renderPanel(p);
  $('panel').hidden = false;
  centerOn(id, Math.max(pz.s, 0.7), !fromLoad);
}
function closePanel() {
  $('panel').hidden = true;
  if (selected) cardEls.get(selected)?.classList.remove('selected');
  for (const { path } of pathEls) path.classList.remove('hl');
  selected = null;
  history.replaceState(null, '', location.pathname + location.search);
}
$('close').onclick = closePanel;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('lightbox').hidden) $('lightbox').hidden = true;
  else if (!$('panel').hidden) closePanel();
});

function chip(id) {
  const p = model.people.get(id);
  return el('button', { class: 'chip', type: 'button', onclick: () => select(id) }, displayName(p));
}
function relSection(title, ids, unknownText) {
  if (!ids.length && !unknownText) return null;
  return el('section', {},
    el('div', { class: 'label', text: title }),
    el('div', { class: 'chips' }, ids.map(chip), unknownText ? el('span', { class: 'chip unknown', text: unknownText }) : null));
}

function renderPanel(p) {
  const partners = p.couples.filter((c) => c.b).sort((a, b) => (a.ordine || 0) - (b.ordine || 0))
    .map((c) => (c.a === p.id ? c.b : c.a));
  const unknownPartner = !partners.length || p.couples.some((c) => !c.b);
  const siblings = new Set();
  for (const par of p.parents) for (const c of model.people.get(par).children) if (c !== p.id) siblings.add(c);
  const marriages = p.couples.filter((c) => c.b && (c.data || c.tip || c.loc || c.note));

  const facts = [
    ['Născut', [p.nascut, p.loc].filter(Boolean).join(', ')],
    ['Decedat', p.decedat],
    ['Generația', String(p.g)],
    ['Linia', String(p.linie || '').split(';').map((s) => s.trim()).filter(Boolean).join(' · ')],
  ].filter(([, v]) => v);

  const body = $('panel-body');
  body.replaceChildren(...[
    el('p', { class: 'eyebrow', text: `${p.id}${p.sex === 'x' ? ' · femeie' : p.sex === 'y' ? ' · bărbat' : ''}` }),
    el('h2', { id: 'p-name', text: displayName(p) }),
    p.porecla ? el('p', { class: 'nick', text: `„${p.porecla}”` }) : null,
    facts.length ? el('dl', {}, facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])) : null,
    relSection('Părinți', p.parents),
    relSection(partners.length > 1 ? 'Parteneri' : 'Partener', partners, unknownPartner ? 'Partener necunoscut' : null),
    marriages.length ? el('section', {}, el('div', { class: 'label', text: 'Căsătorie' }),
      marriages.map((c) => el('p', { class: 'note', text: [displayName(model.people.get(c.a === p.id ? c.b : c.a)), c.tip, c.data, c.loc, c.note].filter(Boolean).join(' · ') }))) : null,
    relSection('Copii', p.children),
    relSection('Frați și surori', [...siblings]),
    p.note ? el('section', {}, el('div', { class: 'label', text: 'Note' }), el('p', { class: 'note', text: p.note })) : null,
    p.foto.length ? photoSection(p) : null,
    commentSection(p),
  ].filter(Boolean));
  body.parentElement.scrollTop = 0;
}

function photoSection(p) {
  const grid = el('div', { class: 'photos' });
  for (const f of p.foto) {
    const img = el('img', { alt: `Fotografie: ${displayName(p)}` });
    const btn = el('button', { type: 'button', 'aria-label': 'Mărește fotografia', onclick: () => { $('lb-img').src = img.src; $('lb-img').alt = img.alt; $('lightbox').hidden = false; } }, img);
    photoUrl(f.file, f.type).then((u) => { img.src = u; }).catch(() => btn.remove());
    grid.append(btn);
  }
  return el('section', {}, el('div', { class: 'label', text: 'Fotografii' }), grid);
}
$('lb-close').onclick = () => { $('lightbox').hidden = true; };

function commentSection(p) {
  const name = displayName(p);
  const sec = el('section', { class: 'comment' }, el('div', { class: 'label', text: 'Știi ceva despre această persoană?' }));
  if (!meta.email) {
    sec.append(el('button', { class: 'btn', type: 'button', disabled: true, text: 'Adaugă un comentariu' }),
      el('p', { text: 'Adresa administratorului nu e setată încă.' }));
    return sec;
  }
  const subject = `Arbore Starovnic: comentariu despre ${name} (${p.id})`;
  const bodyText = `Persoana: ${name} (${p.id})\n\nComentariul meu (corectură, dată, amintire, poveste…):\n\n\n\nNumele meu:\n`;
  const href = `mailto:${meta.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
  sec.append(
    el('a', { class: 'btn btn-primary', href, text: 'Adaugă un comentariu' }),
    el('p', {}, 'Se deschide aplicația ta de e-mail. Administratorul verifică fiecare comentariu înainte să-l adauge în arbore. Dacă nu se deschide nimic, scrie la ',
      el('a', { class: 'plain', href: `mailto:${meta.email}`, text: meta.email }), ` și menționează ${p.id}.`),
  );
  return sec;
}

window.addEventListener('resize', () => { if (selected) centerOn(selected, null, false); });
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (model && id && id !== selected && model.people.has(id)) select(id);
});
start();
