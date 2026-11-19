// Decrypts data/tree.enc and photos/*.enc in the browser (Web Crypto).
// Format written by tools/publish.mjs: PBKDF2-SHA256 → AES-256-GCM.

const KEY_STORE = 'starovnic.key';
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

let envelope = null;
let aesKey = null;

export async function loadEnvelope() {
  const res = await fetch('data/tree.enc', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Nu găsesc datele arborelui (data/tree.enc).');
  envelope = await res.json();
  return envelope;
}

async function decryptTree(key) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(envelope.iv) }, key, b64(envelope.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Returns the tree, or null when the password is wrong.
export async function unlockWithPassword(password, remember) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(envelope.salt), iterations: envelope.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt'],
  );
  let tree;
  try { tree = await decryptTree(key); } catch { return null; }
  aesKey = key;
  if (remember) {
    try {
      const raw = await crypto.subtle.exportKey('raw', key);
      localStorage.setItem(KEY_STORE, JSON.stringify({ salt: envelope.salt, key: toB64(raw) }));
    } catch { /* storage unavailable: just don't remember */ }
  }
  return tree;
}

// Tries the key remembered on this device. Returns the tree or null.
export async function unlockWithRemembered() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(KEY_STORE) || 'null'); } catch { return null; }
  if (!stored || stored.salt !== envelope.salt) { forget(); return null; }
  try {
    const key = await crypto.subtle.importKey('raw', b64(stored.key), 'AES-GCM', false, ['decrypt']);
    const tree = await decryptTree(key);
    aesKey = key;
    return tree;
  } catch { forget(); return null; }
}

export function forget() {
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}

const photoCache = new Map();
export function photoUrl(file, type) {
  if (!photoCache.has(file)) {
    photoCache.set(file, (async () => {
      const res = await fetch('photos/' + encodeURIComponent(file));
      if (!res.ok) throw new Error('foto lipsă');
      const bytes = new Uint8Array(await res.arrayBuffer());
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, aesKey, bytes.slice(12));
      return URL.createObjectURL(new Blob([plain], { type }));
    })());
  }
  return photoCache.get(file);
}
