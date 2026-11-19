// Publish — turns the Excel sheets `persoane` + `cupluri` into the encrypted
// files the website reads:
//   data/tree.enc      people, couples, owner's e-mail (one encrypted JSON)
//   photos/<x>.enc     each photo listed in the `Foto` column, encrypted
//
// Usage:  node tools/publish.mjs
// It asks for the family password (or reads env STAROVNIC_PAROLA).
// Settings live in tools/site.config.json (created on first run, never committed).

import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(root, 'tools', 'site.config.json');
const DATA_FILE = path.join(root, 'data', 'tree.enc');
const PHOTO_DIR_OUT = path.join(root, 'photos');
const ITERATIONS = 600_000;

const defaults = { email: '', excel: 'STAROVNIC WEBSITE (arbore).xlsx', fotoDir: 'foto' };
if (!fs.existsSync(CONFIG)) {
  fs.writeFileSync(CONFIG, JSON.stringify(defaults, null, 2) + '\n');
  console.log(`Am creat ${path.relative(root, CONFIG)} — completează "email" acolo.`);
}
// strip a byte-order mark: Windows editors (Notepad, PowerShell) often add one
const cfg = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')) };
const warnings = [];
const warn = (m) => warnings.push(m);
if (!cfg.email) warn('„email” e gol în tools/site.config.json — butonul de comentariu va fi dezactivat.');

// ── read the workbook ────────────────────────────────────────────────
const norm = (s) => String(s ?? '').replace(/\(.*?\)/g, '').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function cellString(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    const d = String(v.getUTCDate()).padStart(2, '0'), m = String(v.getUTCMonth() + 1).padStart(2, '0');
    return `${d}/${m}/${v.getUTCFullYear()}`;
  }
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellString(v.result);
    if (v.text) return String(v.text);
    return '';
  }
  return String(v).trim();
}

function readSheet(wb, name, wanted) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`Foaia „${name}” lipsește din ${cfg.excel}`);
  const col = {};
  ws.getRow(1).eachCell((c, i) => {
    const h = norm(cellString(c.value));
    for (const [key, header] of Object.entries(wanted)) if (h === header) col[key] = i;
  });
  for (const [key, header] of Object.entries(wanted)) {
    if (!col[key]) throw new Error(`Foaia „${name}”: nu găsesc coloana „${header}”`);
  }
  const rows = [];
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const o = { _row: r };
    for (const key of Object.keys(wanted)) o[key] = cellString(row.getCell(col[key]).value);
    if (o.id) rows.push(o);
  });
  return rows;
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.join(root, cfg.excel));

const people = readSheet(wb, 'persoane', {
  id: 'id', prenume: 'prenume', nume: 'nume', porecla: 'porecla', sex: 'sex',
  mama: 'mama id', tata: 'tata id', nascut: 'nascut', loc: 'loc nastere', decedat: 'decedat',
  gen: 'generatie', linie: 'linie', note: 'note', foto: 'foto', eticheta: 'eticheta', src: 'sursa',
});
const couples = readSheet(wb, 'cupluri', {
  id: 'id', a: 'partener 1 id', b: 'partener 2 id', tip: 'tip', data: 'data', loc: 'loc', ordine: 'ordine', note: 'note',
});

// ── validate ─────────────────────────────────────────────────────────
const byId = new Map();
for (const p of people) {
  if (byId.has(p.id)) warn(`ID dublat în persoane: ${p.id} (rândurile ${byId.get(p.id)._row} și ${p._row})`);
  byId.set(p.id, p);
}
for (const p of people) {
  if (p.sex && !['x', 'y'].includes(p.sex)) warn(`${p.id}: Sex „${p.sex}” (trebuie x sau y)`);
  for (const [k, want] of [['mama', 'x'], ['tata', 'y']]) {
    if (!p[k]) continue;
    const par = byId.get(p[k]);
    if (!par) { warn(`${p.id}: ${k === 'mama' ? 'Mama' : 'Tata'} ID ${p[k]} nu există — ignorat`); p[k] = ''; continue; }
    if (par.sex && par.sex !== want) warn(`${p.id}: ${k === 'mama' ? 'mama' : 'tatăl'} ${par.id} are Sex „${par.sex}”`);
  }
}
const goodCouples = couples.filter((c) => {
  if (!byId.has(c.a)) { warn(`Cuplul ${c.id}: Partener 1 ID ${c.a || '(gol)'} nu există — ignorat`); return false; }
  if (c.b && !byId.has(c.b)) { warn(`Cuplul ${c.id}: Partener 2 ID ${c.b} nu există — ignorat`); return false; }
  return true;
});

// ── password & key ──────────────────────────────────────────────────
function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { rl.output.write(s.startsWith(question) ? question : s.replace(/[^\r\n]/g, '*')); };
    }
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}
const deriveKey = (pw, salt) => crypto.pbkdf2Sync(pw.normalize('NFC'), salt, ITERATIONS, 32, 'sha256');

function encrypt(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  return { iv, ct: Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]) };
}
function decrypt(key, iv, ctWithTag) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(ctWithTag.subarray(-16));
  return Buffer.concat([d.update(ctWithTag.subarray(0, -16)), d.final()]);
}

const previous = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null;
let password = process.env.STAROVNIC_PAROLA || (await ask('Parola familiei: ', true));
if (!password) throw new Error('Parola e goală.');

let salt, key;
if (previous) {
  const prevSalt = Buffer.from(previous.salt, 'base64');
  const prevKey = crypto.pbkdf2Sync(password.normalize('NFC'), prevSalt, previous.iter, 32, 'sha256');
  try {
    decrypt(prevKey, Buffer.from(previous.iv, 'base64'), Buffer.from(previous.ct, 'base64'));
    salt = prevSalt; key = prevKey; // same password as last time → keep salt (remembered logins keep working)
  } catch {
    if (process.env.STAROVNIC_PAROLA) {
      if (process.env.STAROVNIC_PAROLA_NOUA !== '1') throw new Error('Parola diferă de cea folosită ultima dată. Setează STAROVNIC_PAROLA_NOUA=1 dacă e intenționat.');
    } else {
      console.log('\nParola NU se potrivește cu cea folosită ultima dată.');
      const again = await ask('Dacă vrei o parolă NOUĂ, scrie-o încă o dată (altfel apasă Enter): ', true);
      if (again !== password) throw new Error('Oprit — nimic nu s-a schimbat.');
      console.log('Parolă nouă. Toată familia va trebui să o primească.');
    }
  }
} else if (!process.env.STAROVNIC_PAROLA) {
  const again = await ask('Repetă parola: ', true);
  if (again !== password) throw new Error('Parolele nu se potrivesc. Nimic nu s-a schimbat.');
}
if (!key) { salt = crypto.randomBytes(16); key = deriveKey(password, salt); }

// ── photos ───────────────────────────────────────────────────────────
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
fs.mkdirSync(PHOTO_DIR_OUT, { recursive: true });
const keepPhotos = new Set();
let photoCount = 0;
const fotoDir = path.join(root, cfg.fotoDir);
for (const p of people) {
  const names = p.foto.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  p.foto = [];
  for (const name of names) {
    const src = path.join(fotoDir, name);
    const mime = MIME[path.extname(name).toLowerCase()];
    if (!mime) { warn(`${p.id}: fotografia „${name}” nu e jpg/png/webp/gif — ignorată`); continue; }
    if (!fs.existsSync(src)) { warn(`${p.id}: fotografia „${name}” nu există în ${cfg.fotoDir}/ — ignorată`); continue; }
    // file name in the repo is a keyed hash, so it reveals nothing about who is in it
    const out = crypto.createHmac('sha256', key).update(name).digest('hex').slice(0, 32) + '.enc';
    if (!keepPhotos.has(out)) {
      const { iv, ct } = encrypt(key, fs.readFileSync(src));
      fs.writeFileSync(path.join(PHOTO_DIR_OUT, out), Buffer.concat([iv, ct]));
      keepPhotos.add(out);
      photoCount++;
    }
    p.foto.push({ file: out, type: mime });
  }
}
for (const f of fs.readdirSync(PHOTO_DIR_OUT)) {
  if (f.endsWith('.enc') && !keepPhotos.has(f)) fs.rmSync(path.join(PHOTO_DIR_OUT, f));
}

// ── write data/tree.enc ──────────────────────────────────────────────
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !k.startsWith('_') && v !== '' && !(Array.isArray(v) && !v.length)));
const payload = {
  meta: { email: cfg.email, publicat: new Date().toISOString() },
  people: people.map((p) => clean({ ...p, gen: p.gen ? Number(p.gen) : '' })),
  couples: goodCouples.map((c) => clean({ ...c, ordine: c.ordine ? Number(c.ordine) : '' })),
};
const { iv, ct } = encrypt(key, Buffer.from(JSON.stringify(payload), 'utf8'));
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.writeFileSync(DATA_FILE, JSON.stringify({
  v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS,
  salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'),
}));

console.log(`\nGata: ${payload.people.length} persoane, ${payload.couples.length} cupluri, ${photoCount} fotografii → data/tree.enc`);
if (warnings.length) console.log(`\nAtenție (${warnings.length}):\n  • ` + warnings.join('\n  • '));
