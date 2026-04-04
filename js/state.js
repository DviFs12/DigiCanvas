/**
 * state.js — State Manager Central (pub/sub)
 * ────────────────────────────────────────────
 * Fonte única de verdade para:
 *  - Viewport do celular (posição + zoom)
 *  - Modo de interação do PC
 *  - Preferências
 *  - Estado da conexão
 *
 * Uso:
 *   State.set('viewport', { x, y, zoom })
 *   State.on('viewport', handler)
 *   State.get('viewport')
 */

const _state = {};
const _listeners = {};

export const State = {
  /** Define uma chave e notifica listeners */
  set(key, value) {
    _state[key] = value;
    (_listeners[key] ?? []).forEach(fn => {
      try { fn(value); } catch(e) { console.error(`[State] handler error for "${key}":`, e); }
    });
  },

  /** Retorna o valor atual (imutável por referência — não modifique diretamente) */
  get(key) { return _state[key]; },

  /** Registra um listener; retorna função de unsubscribe */
  on(key, fn) {
    (_listeners[key] ??= []).push(fn);
    return () => { _listeners[key] = (_listeners[key] ?? []).filter(f => f !== fn); };
  },

  /** Atualiza parcialmente um objeto existente */
  merge(key, partial) {
    this.set(key, { ..._state[key], ...partial });
  },
};

// ── Estado inicial ─────────────────────────────────────────────────────────

State.set('pcMode', 'draw'); // 'draw' | 'move' | 'resize'

/** Viewport do celular em coordenadas NORMALIZADAS (0–1 relativo ao PDF).
 *  nx,ny = canto superior esquerdo; nw,nh = largura/altura visível. */
State.set('viewport', { nx: 0, ny: 0, nw: 1, nh: 1, zoom: 1, locked: false });

/** Dimensões do documento PDF em px CSS (1× DPR) */
State.set('pdfSize', { w: 794, h: 1123 });

/** Conexão */
State.set('connected', false);

/** Camada de limpeza */
State.set('clearMode', 'shared'); // 'shared' | 'separate'

/** Follow viewport */
State.set('followViewport', true);

/** Grid */
State.set('gridEnabled', false);
