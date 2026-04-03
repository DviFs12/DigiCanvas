/**
 * store.js — Estado global + persistência localStorage
 * ─────────────────────────────────────────────────────
 * Centraliza temas, preferências e arquivos recentes.
 * Não depende de nenhum outro módulo do projeto.
 */

// ── Chaves localStorage ────────────────────────────────────────────────────
const KEY_THEME   = 'dc:theme';
const KEY_PREFS   = 'dc:prefs';
const KEY_RECENTS = 'dc:recents';

// ── Tema ───────────────────────────────────────────────────────────────────

export const THEMES = ['dark', 'light', 'amoled'];

export function getTheme() {
  return localStorage.getItem(KEY_THEME) || 'dark';
}

export function setTheme(name) {
  if (!THEMES.includes(name)) return;
  localStorage.setItem(KEY_THEME, name);
  applyTheme(name);
}

export function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name || getTheme());
}

// ── Preferências ───────────────────────────────────────────────────────────

const DEFAULT_PREFS = {
  zoomLocked:    false,
  showRemote:    true,
  syncScroll:    true,
  gridEnabled:   false,
  bgMode:        'pdf',
  panSensitivity: 1.0,
  haptic:        true,
  palmReject:    true,
};

export function getPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY_PREFS) || '{}') };
  } catch { return { ...DEFAULT_PREFS }; }
}

export function setPref(key, value) {
  const prefs = getPrefs();
  prefs[key] = value;
  localStorage.setItem(KEY_PREFS, JSON.stringify(prefs));
}

// ── Arquivos recentes ──────────────────────────────────────────────────────
// Armazenamos: { name, size, thumb (dataURL 120px), ts }
// Não armazenamos o conteúdo do PDF (limite localStorage)

const MAX_RECENTS = 8;

export function getRecents() {
  try {
    return JSON.parse(localStorage.getItem(KEY_RECENTS) || '[]');
  } catch { return []; }
}

export function addRecent(entry) {
  // entry: { name, size, thumb, ts }
  let list = getRecents().filter(r => r.name !== entry.name);
  list.unshift({ ...entry, ts: Date.now() });
  if (list.length > MAX_RECENTS) list = list.slice(0, MAX_RECENTS);
  localStorage.setItem(KEY_RECENTS, JSON.stringify(list));
}

export function removeRecent(name) {
  const list = getRecents().filter(r => r.name !== name);
  localStorage.setItem(KEY_RECENTS, JSON.stringify(list));
}

export function clearRecents() {
  localStorage.removeItem(KEY_RECENTS);
}
