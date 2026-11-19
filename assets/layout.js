// Tree layout: generations are rows (oldest at the top). Every person sits in
// a "unit" with their partner(s); a person with no known partner gets a
// placeholder card ("Partener necunoscut"). Children hang from the junction
// between their two parents.

export const CARD_W = 200;
export const CARD_H = 88;
export const PH_W = 132;      // placeholder card width
const GAP_IN = 28;            // gap between partners inside a unit
const GAP_UNIT = 44;          // gap between units in a row
export const ROW_GAP = 132;   // vertical gap between generations

// ── model ────────────────────────────────────────────────────────────
export function buildModel(data) {
  const people = new Map();
  for (const p of data.people) {
    people.set(p.id, { ...p, foto: p.foto || [], parents: [], children: [], couples: [] });
  }
  const couples = [];
  const coupleKey = (a, b) => [a, b || ''].sort().join('|');
  const byKey = new Map();
  const addCouple = (c) => {
    const k = coupleKey(c.a, c.b);
    if (byKey.has(k)) return byKey.get(k);
    const cp = { ...c, b: c.b || null };
    couples.push(cp);
    byKey.set(k, cp);
    people.get(cp.a).couples.push(cp);
    if (cp.b) people.get(cp.b).couples.push(cp);
    return cp;
  };
  for (const c of data.couples) {
    if (!people.has(c.a) || (c.b && !people.has(c.b))) continue;
    addCouple(c);
  }
  for (const p of people.values()) {
    for (const k of ['mama', 'tata']) {
      if (p[k] && people.has(p[k])) { p.parents.push(p[k]); people.get(p[k]).children.push(p.id); }
      else p[k] = null;
    }
    // every child hangs from a couple: real one, implied one, or "parent + unknown"
    if (p.mama && p.tata) p.fromCouple = addCouple({ id: `auto:${p.mama}+${p.tata}`, a: p.tata, b: p.mama, auto: true });
    else if (p.mama || p.tata) p.fromCouple = addCouple({ id: `auto:${p.mama || p.tata}+?`, a: p.mama || p.tata, b: null, auto: true });
  }
  computeGenerations(people);
  return { people, couples };
}

function computeGenerations(people) {
  for (const p of people.values()) p.g = Number.isFinite(p.gen) && p.gen > 0 ? p.gen : null;
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const p of people.values()) {
      if (p.g != null) continue;
      const pg = p.parents.map((id) => people.get(id).g).filter((g) => g != null);
      const partnerG = p.couples.map((c) => people.get(c.a === p.id ? c.b : c.a)?.g).filter((g) => g != null);
      const cg = p.children.map((id) => people.get(id).g).filter((g) => g != null);
      if (pg.length) p.g = Math.max(...pg) + 1;
      else if (partnerG.length) p.g = partnerG[0];
      else if (cg.length) p.g = Math.min(...cg) - 1;
      if (p.g != null) changed = true;
    }
    if (!changed) break;
  }
  for (const p of people.values()) if (p.g == null) p.g = 1;
  const min = Math.min(...[...people.values()].map((p) => p.g));
  for (const p of people.values()) p.g = p.g - min + 1;
}

// ── layout ───────────────────────────────────────────────────────────
export function layout(model) {
  const { people, couples } = model;
  const realCouples = couples.filter((c) => c.b);
  const needsPH = (p) => !p.couples.some((c) => c.b) || p.couples.some((c) => !c.b);
  const rowKey = (p) => (p.src ? Number(String(p.src).replace(/^[A-Z]+/i, '')) : null);

  // 1. units = connected groups of partners
  const parent = new Map([...people.keys()].map((id) => [id, id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const c of realCouples) parent.set(find(c.a), find(c.b));
  const groups = new Map();
  for (const id of people.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }

  const units = [];
  const unitOf = new Map();
  for (const ids of groups.values()) {
    let order;
    if (ids.length <= 2) order = ids;
    else {
      // one person with several partners: put them in the middle
      const deg = (id) => realCouples.filter((c) => c.a === id || c.b === id).length;
      const hub = ids.reduce((a, b) => (deg(b) > deg(a) ? b : a));
      const others = realCouples.filter((c) => c.a === hub || c.b === hub)
        .sort((x, y) => (x.ordine || 0) - (y.ordine || 0))
        .map((c) => (c.a === hub ? c.b : c.a));
      const rest = ids.filter((id) => id !== hub && !others.includes(id));
      const left = others.filter((_, i) => i % 2 === 1).reverse();
      const right = others.filter((_, i) => i % 2 === 0);
      order = [...left, hub, ...right, ...rest];
    }
    const g = Math.max(...ids.map((id) => people.get(id).g));
    const u = { id: 'u' + units.length, members: order, g, slots: [], x: 0, key: null };
    units.push(u);
    for (const id of ids) unitOf.set(id, u);
  }

  // 2. sort units within each generation, top-down, keeping the owner's chart order
  const rows = new Map();
  for (const u of units) {
    if (!rows.has(u.g)) rows.set(u.g, []);
    rows.get(u.g).push(u);
  }
  const gens = [...rows.keys()].sort((a, b) => a - b);
  const parentUnitKey = (p) => {
    const ks = p.parents.map((id) => unitOf.get(id).key).filter((k) => k != null);
    return ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : null;
  };
  for (const g of gens) {
    for (const u of rows.get(g)) {
      const own = u.members.map((id) => rowKey(people.get(id))).filter((k) => k != null);
      if (own.length) u.key = own.reduce((a, b) => a + b, 0) / own.length;
      else {
        const pk = u.members.map((id) => parentUnitKey(people.get(id))).filter((k) => k != null);
        if (pk.length) u.key = pk.reduce((a, b) => a + b, 0) / pk.length + 0.01;
      }
    }
  }
  for (const g of [...gens].reverse()) {
    for (const u of rows.get(g)) {
      if (u.key != null) continue;
      const ck = u.members.flatMap((id) => people.get(id).children).map((id) => unitOf.get(id).key).filter((k) => k != null);
      u.key = ck.length ? ck.reduce((a, b) => a + b, 0) / ck.length - 0.01 : 1e9;
    }
  }
  for (const g of gens) rows.get(g).sort((a, b) => a.key - b.key || a.members[0].localeCompare(b.members[0]));

  // 3. orient couples (partner whose family is further left goes left), add placeholders
  for (const u of units) {
    if (u.members.length === 2) {
      const k = (id) => parentUnitKey(people.get(id)) ?? rowKey(people.get(id)) ?? 0;
      u.members.sort((a, b) => k(a) - k(b));
    }
    const slots = [];
    u.members.forEach((id, i) => {
      const ph = needsPH(people.get(id)) ? { kind: 'ph', id: 'ph:' + id, of: id, w: PH_W } : null;
      const before = ph && i === 0 && u.members.length > 1; // first of a couple: placeholder on the outer (left) side
      if (before) slots.push(ph);
      slots.push({ kind: 'person', id, w: CARD_W });
      if (ph && !before) slots.push(ph);
    });
    let x = 0;
    for (const s of slots) { s.dx = x; x += s.w + GAP_IN; }
    u.slots = slots;
    u.w = x - GAP_IN;
  }

  // junctions: where children's lines start (between two partners)
  const slotOf = new Map();
  for (const u of units) for (const s of u.slots) slotOf.set(s.id, { u, s });
  const junctionDx = (aId, bId) => {
    const A = slotOf.get(aId), B = slotOf.get(bId);
    if (!A || !B || A.u !== B.u) return null;
    const [l, r] = A.s.dx < B.s.dx ? [A.s, B.s] : [B.s, A.s];
    return { u: A.u, dx: (l.dx + l.w + r.dx) / 2, adjacent: r.dx - (l.dx + l.w) <= GAP_IN + 0.5 };
  };
  const junctionOf = (c) => {
    if (c.b) return junctionDx(c.a, c.b) || { u: unitOf.get(c.a), dx: slotOf.get(c.a).s.dx + CARD_W / 2 };
    const ph = slotOf.get('ph:' + c.a);
    if (ph) return junctionDx(c.a, 'ph:' + c.a);
    return { u: unitOf.get(c.a), dx: slotOf.get(c.a).s.dx + CARD_W / 2 };
  };
  const families = []; // { couple, j: {u,dx}, children: [ids] }
  const famByCouple = new Map();
  for (const p of people.values()) {
    if (!p.fromCouple) continue;
    let f = famByCouple.get(p.fromCouple);
    if (!f) { f = { couple: p.fromCouple, j: junctionOf(p.fromCouple), children: [] }; famByCouple.set(p.fromCouple, f); families.push(f); }
    f.children.push(p.id);
  }

  // 4. x positions: start packed, then alternately pull rows toward parents / children
  for (const g of gens) {
    let x = 0;
    for (const u of rows.get(g)) { u.x = x; x += u.w + GAP_UNIT; }
  }
  const personCenter = (id) => { const { u, s } = slotOf.get(id); return u.x + s.dx + s.w / 2; };
  const famX = (f) => f.j.u.x + f.j.dx;

  function placeRow(list, desired, weight) {
    // closest positions to `desired` keeping order and spacing (weighted isotonic regression)
    const off = [0];
    for (let i = 1; i < list.length; i++) off[i] = off[i - 1] + list[i - 1].w + GAP_UNIT;
    const blocks = [];
    list.forEach((_, i) => {
      blocks.push({ s: (desired[i] - off[i]) * weight[i], w: weight[i], n: 1 });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.s / a.w <= b.s / b.w) break;
        blocks.splice(-2, 2, { s: a.s + b.s, w: a.w + b.w, n: a.n + b.n });
      }
    });
    let i = 0;
    for (const b of blocks) for (let k = 0; k < b.n; k++, i++) list[i].x = b.s / b.w + off[i];
  }

  const childFams = new Map(); // unit -> families whose junction is in it
  for (const f of families) {
    if (!childFams.has(f.j.u)) childFams.set(f.j.u, []);
    childFams.get(f.j.u).push(f);
  }
  const down = () => {
    for (const g of gens.slice(1)) {
      const list = rows.get(g);
      const des = [], wt = [];
      for (const u of list) {
        const ds = u.slots.filter((s) => s.kind === 'person' && people.get(s.id).fromCouple)
          .map((s) => famX(famByCouple.get(people.get(s.id).fromCouple)) - (s.dx + s.w / 2));
        des.push(ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : u.x);
        wt.push(ds.length ? 1 : 0.15);
      }
      placeRow(list, des, wt);
    }
  };
  const up = () => {
    for (const g of [...gens].reverse().slice(1)) {
      const list = rows.get(g);
      const des = [], wt = [];
      for (const u of list) {
        const ds = (childFams.get(u) || []).map((f) => {
          const cx = f.children.map(personCenter);
          return (Math.min(...cx) + Math.max(...cx)) / 2 - f.j.dx;
        });
        des.push(ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : u.x);
        wt.push(ds.length ? 1 : 0.15);
      }
      placeRow(list, des, wt);
    }
  };
  for (let i = 0; i < 8; i++) { down(); up(); }
  down();

  // 5. absolute coordinates
  const rowY = (g) => (g - 1) * (CARD_H + ROW_GAP);
  let minX = Infinity, maxX = -Infinity;
  for (const u of units) { minX = Math.min(minX, u.x); maxX = Math.max(maxX, u.x + u.w); }
  const cards = [];
  for (const u of units) {
    u.x -= minX;
    for (const s of u.slots) {
      cards.push({ ...s, x: u.x + s.dx, y: rowY(u.g), h: CARD_H });
    }
  }

  // 6. lines
  const lines = []; // { d, dashed, ids: [person ids involved] }
  for (const u of units) {
    for (let i = 0; i + 1 < u.slots.length; i++) {
      const l = u.slots[i], r = u.slots[i + 1];
      const y = rowY(u.g) + CARD_H / 2;
      const ph = l.kind === 'ph' || r.kind === 'ph';
      const ids = [l, r].filter((s) => s.kind === 'person').map((s) => s.id);
      if (ph || realCouples.some((c) => ids.includes(c.a) && ids.includes(c.b))) {
        lines.push({ d: `M${u.x + l.dx + l.w},${y}H${u.x + r.dx}`, dashed: ph, ids });
      }
    }
  }
  // buses: give overlapping sibling bars different heights so they don't merge
  const byRow = new Map();
  for (const f of families) {
    const jx = famX(f);
    const cx = f.children.map(personCenter);
    f.span = [Math.min(jx, ...cx), Math.max(jx, ...cx)];
    const g = f.j.u.g;
    if (!byRow.has(g)) byRow.set(g, []);
    byRow.get(g).push(f);
  }
  for (const [g, fs] of byRow) {
    fs.sort((a, b) => a.span[0] - b.span[0]);
    const levelEnd = [];
    for (const f of fs) {
      let lv = levelEnd.findIndex((end) => end < f.span[0] - 12);
      if (lv === -1) { lv = levelEnd.length; levelEnd.push(0); }
      levelEnd[lv] = f.span[1];
      f.level = lv;
    }
    const n = levelEnd.length;
    const step = Math.min(16, (ROW_GAP - 40) / Math.max(1, n));
    for (const f of fs) f.busY = rowY(g) + CARD_H + 20 + f.level * step;
  }
  // (unit x values were already shifted by -minX above, so no further offset here)
  for (const f of families) {
    const jx = famX(f);
    const jy = rowY(f.j.u.g) + (f.couple.b || slotOf.has('ph:' + f.couple.a) ? CARD_H / 2 : CARD_H);
    let d = `M${jx},${jy}V${f.busY}`;
    const xs = f.children.map(personCenter);
    const lo = Math.min(jx, ...xs), hi = Math.max(jx, ...xs);
    if (hi - lo > 0.5) d += `M${lo},${f.busY}H${hi}`;
    for (const id of f.children) {
      const c = slotOf.get(id);
      d += `M${personCenter(id)},${f.busY}V${rowY(c.u.g)}`;
    }
    lines.push({ d, ids: [f.couple.a, f.couple.b, ...f.children].filter(Boolean) });
  }

  const height = rowY(Math.max(...gens)) + CARD_H;
  return { cards, lines, width: maxX - minX, height, gens, rowY };
}
