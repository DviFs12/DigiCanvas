/**
 * shortcuts.js — Atalhos de teclado do desktop
 * ──────────────────────────────────────────────
 * Registra atalhos globais e os expõe via callbacks.
 * Uso: shortcuts.on('undo', fn)
 */

const listeners = {};

export const shortcuts = {
  on(event, fn) {
    (listeners[event] ??= []).push(fn);
    return () => { listeners[event] = listeners[event].filter(f => f !== fn); };
  },
  emit(event, ...args) {
    (listeners[event] ?? []).forEach(fn => fn(...args));
  },
};

// Mapa: key combo → event name
const MAP = {
  'ctrl+z':       'undo',
  'ctrl+shift+z': 'redo',
  'ctrl+shift+r': 'clear',
  'ctrl+e':       'export',
  'ctrl+o':       'open',
  'ctrl+s':       'save',
  'escape':       'escape',
  'arrowleft':    'prev-page',
  'arrowright':   'next-page',
  'p':            'tool:pen',
  'm':            'tool:marker',
  'h':            'tool:highlighter',
  'e':            'tool:eraser',
  'l':            'tool:line',
  'r':            'tool:rect',
  '+':            'zoom-in',
  '-':            'zoom-out',
  '0':            'zoom-fit',
  'f':            'zoom-fit',
  't':            'toggle-theme',
  'g':            'toggle-grid',
  'k':            'toggle-follow',
};

document.addEventListener('keydown', e => {
  // Ignora quando foco está em input/textarea
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey)   parts.push('alt');
  parts.push(e.key.toLowerCase());
  const combo = parts.join('+');

  const event = MAP[combo];
  if (event) {
    e.preventDefault();
    shortcuts.emit(event);
  }
});
