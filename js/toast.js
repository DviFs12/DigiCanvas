/**
 * toast.js
 * ────────
 * Sistema leve de notificações toast.
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

/**
 * Exibe uma notificação toast.
 * @param {string} message  Texto da mensagem
 * @param {'info'|'success'|'error'} type  Tipo visual
 * @param {number} duration  Duração em ms (padrão: 3000)
 */
export function toast(message, type = 'info', duration = 3000) {
  const c  = getContainer();
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = message;
  c.appendChild(el);

  setTimeout(() => {
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Se a animação não disparar (ex: visibilidade oculta), remove manualmente
    setTimeout(() => el.remove(), 400);
  }, duration);
}
