/**
 * toast.js — Sistema de notificações + loading states
 */

let container = null;

function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function toast(message, type = 'info', duration = 3000) {
  const c  = getContainer();
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = message;
  c.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out 0.3s ease forwards';
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, duration);
}

// ── Loading overlay leve ───────────────────────────────────────────────────

let loadingEl = null;

export function showLoading(msg = 'Carregando…') {
  if (!loadingEl) {
    loadingEl = document.createElement('div');
    loadingEl.id = 'loading-overlay';
    loadingEl.innerHTML = `<div class="loading-box"><div class="spinner"></div><span id="loading-msg"></span></div>`;
    document.body.appendChild(loadingEl);
  }
  loadingEl.querySelector('#loading-msg').textContent = msg;
  loadingEl.classList.add('visible');
}

export function hideLoading() {
  loadingEl?.classList.remove('visible');
}
