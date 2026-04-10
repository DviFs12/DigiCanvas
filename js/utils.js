/**
 * utils.js — Funções compartilhadas entre desktop e celular
 * - Tema (dark/light/amoled)
 * - Preferências (localStorage)
 * - Recentes (localStorage)
 * - Toast
 */

// ── TEMA ─────────────────────────────────────────────────────────────────────

const THEMES = ['dark', 'light', 'amoled'];

export function getTheme()   { return localStorage.getItem('dc:theme') || 'dark'; }
export function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t || getTheme());
}
export function setTheme(t) {
  if (!THEMES.includes(t)) return;
  localStorage.setItem('dc:theme', t);
  applyTheme(t);
}
export function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  setTheme(next); return next;
}

// ── PREFS ────────────────────────────────────────────────────────────────────

const DEF = {
  showRemote: true, followVP: true, gridEnabled: false,
  zoomLocked: false, clearMode: 'shared',
  bgMode: 'pdf', panSens: 1, haptic: true, palmReject: true,
  tool: 'pen', color: '#e63946', size: 3,
};

export function getPrefs() {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem('dc:prefs') || '{}') }; }
  catch { return { ...DEF }; }
}
export function setPref(k, v) {
  const p = getPrefs(); p[k] = v;
  localStorage.setItem('dc:prefs', JSON.stringify(p));
}

// ── RECENTES ─────────────────────────────────────────────────────────────────
// Guarda: { name, size, thumb (dataURL 120px), ts }
// Não guarda o buffer do PDF — só metadados + miniatura

export function getRecents() {
  try { return JSON.parse(localStorage.getItem('dc:recents') || '[]'); } catch { return []; }
}
export function addRecent(r) {
  let list = getRecents().filter(x => x.name !== r.name);
  list.unshift({ ...r, ts: Date.now() });
  list = list.slice(0, 8);
  try { localStorage.setItem('dc:recents', JSON.stringify(list)); } catch {}
}
export function removeRecent(name) {
  localStorage.setItem('dc:recents', JSON.stringify(getRecents().filter(x => x.name !== name)));
}
export function clearRecents() { localStorage.removeItem('dc:recents'); }

// ── TOAST ────────────────────────────────────────────────────────────────────

let _container = null;
function _getC() {
  if (!_container) {
    _container = document.createElement('div');
    _container.id = 'toast-container';
    document.body.appendChild(_container);
  }
  return _container;
}

export function toast(msg, type = 'info', ms = 2800) {
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  _getC().appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out .3s ease forwards';
    setTimeout(() => el.remove(), 350);
  }, ms);
}

// ── LOADING ──────────────────────────────────────────────────────────────────

let _lov = null;
export function showLoading(msg = 'Carregando…') {
  if (!_lov) {
    _lov = document.createElement('div'); _lov.id = 'loading-overlay';
    _lov.innerHTML = '<div class="loading-box"><div class="spinner"></div><span id="loading-msg"></span></div>';
    document.body.appendChild(_lov);
  }
  _lov.querySelector('#loading-msg').textContent = msg;
  _lov.classList.add('visible');
}
export function hideLoading() { _lov?.classList.remove('visible'); }
