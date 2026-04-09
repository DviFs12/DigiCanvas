/**
 * mobile.js v7 — ESTÁVEL
 * ──────────────────────
 * Gestos simplificados e previsíveis:
 *   1 toque → desenha
 *   2 toques → pan + zoom (pinch)
 *   Botão "Navegar" → força 1 toque = pan
 *
 * SEM resize de viewport — tamanho fixo baseado na tela.
 * Pointer events unificados, sem conflito de listeners.
 */

import { DigiPeer, ConnState } from './webrtc.js';
import { toast }               from './toast.js';
import { applyTheme, setTheme, getPrefs, setPref } from './store.js';
import { Viewport }            from './viewport.js';
import { MobileRenderer }      from './renderer.js';
import { State }               from './state.js';

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screenConnect = $('screen-connect');
const screenDraw    = $('screen-draw');

const CANVASES = {
  bg:    $('bg-canvas'),
  thumb: $('thumb-canvas'),
  rem:   $('remote-canvas-mob'),
  grid:  $('grid-canvas-mob'),
  draw:  $('mobile-canvas'),
};

// ── Core ─────────────────────────────────────────────────────────────────
const vp  = new Viewport(794, 1123, window.innerWidth, 500);
const ren = new MobileRenderer(CANVASES, vp);
let peer  = null;

// ── Canvas dimensions ────────────────────────────────────────────────────
let canvasW = 0, canvasH = 0;

// ── Tool state ───────────────────────────────────────────────────────────
let currentTool  = 'pen';
let currentColor = '#e63946';
let currentSize  = 3;
let palmReject   = true;

// ── Mode: 'draw' | 'pan' ─────────────────────────────────────────────────
// 'draw'  → 1 toque desenha, 2 toques fazem pan+zoom
// 'pan'   → 1 toque faz pan, 2 toques fazem pan+zoom
let mode = 'draw';

// ── Gesture state machine ─────────────────────────────────────────────────
// 'idle' | 'drawing' | 'panning' | 'pinching'
let gesture = 'idle';

// Stroke em andamento
let strokeId        = 0;
let currentStrokeId = null;

// Pan — último ponto registrado
let panLastX = 0, panLastY = 0;

// Pinch — estado anterior
let pinchLastDist = 0, pinchLastMidX = 0, pinchLastMidY = 0;

// Broadcast timer
let _vpTimer = null;

// Página atual do PDF no desktop — usada para indexar strokes por página
let currentPdfPage = 1;

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

applyTheme();

// Aplica prefs salvas
;(() => {
  const p = getPrefs();
  palmReject = p.palmReject ?? true;
  ren.setBgMode(p.bgMode || 'pdf');
  ren.setGridEnabled(p.gridEnabled || false);
  currentSize = p.size || 3;
})();

// Sincroniza tamanho do doc ao receber do desktop
State.on('pdfSize', ({ w, h }) => {
  vp.setDocSize(w, h);
  ren.rebake();
});

// ══════════════════════════════════════════════════════════════════════════
// CANVAS RESIZE
// ══════════════════════════════════════════════════════════════════════════

function resizeCanvas() {
  const hud  = $('mobile-hud');
  const bar  = $('mobile-toolbar');
  const hudH = hud  ? hud.getBoundingClientRect().height  : 52;
  const barH = bar  ? bar.getBoundingClientRect().height  : 100;

  canvasW = window.innerWidth;
  canvasH = Math.max(100, window.innerHeight - hudH - barH);

  const dpr = window.devicePixelRatio || 1;
  const top  = hudH + 'px';

  for (const c of Object.values(CANVASES)) {
    if (!c) continue;
    c.style.position = 'absolute';
    c.style.left = '0px';
    c.style.top  = top;
  }

  vp.setScrSize(canvasW, canvasH);
  ren.resize(canvasW, canvasH, dpr);
}

window.addEventListener('resize', () => {
  if (screenDraw.classList.contains('active')) resizeCanvas();
});

// ══════════════════════════════════════════════════════════════════════════
// POINTER EVENTS — fonte única de verdade para input
// ══════════════════════════════════════════════════════════════════════════

// Rastreamento de ponteiros ativos
const ptrs = new Map(); // pointerId → {clientX, clientY, ...}

function bindInput() {
  const c = CANVASES.draw;
  // Garante que não adiciona listeners duplicados
  c.removeEventListener('pointerdown',   handleDown);
  c.removeEventListener('pointermove',   handleMove);
  c.removeEventListener('pointerup',     handleUp);
  c.removeEventListener('pointercancel', handleCancel);

  c.addEventListener('pointerdown',   handleDown,   { passive: false });
  c.addEventListener('pointermove',   handleMove,   { passive: false });
  c.addEventListener('pointerup',     handleUp,     { passive: false });
  c.addEventListener('pointercancel', handleCancel, { passive: false });
}

function isPalm(e) {
  return palmReject && e.pointerType === 'touch' && (e.width > 60 || e.height > 60);
}

function canvasXY(e) {
  const r = CANVASES.draw.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ── Down ──────────────────────────────────────────────────────────────────

function handleDown(e) {
  e.preventDefault();
  if (isPalm(e)) return;

  ptrs.set(e.pointerId, e);
  CANVASES.draw.setPointerCapture(e.pointerId);

  const count = ptrs.size;

  if (count === 1) {
    // Primeiro toque
    if (gesture === 'idle') {
      const { x, y } = canvasXY(e);
      if (mode === 'draw') {
        gesture = 'drawing';
        beginStroke(x, y);
      } else {
        gesture = 'panning';
        panLastX = e.clientX;
        panLastY = e.clientY;
      }
    }
  } else if (count === 2) {
    // Segundo toque — cancela desenho se houver, inicia pinch/pan
    if (gesture === 'drawing') {
      // Cancela stroke local imediatamente
      ren.cancelStroke();
      if (currentStrokeId) {
        peer?.send({ type: 'stroke:end', id: currentStrokeId });
        currentStrokeId = null;
      }
    }
    gesture = 'pinching';
    const [a, b] = [...ptrs.values()];
    initPinch(a, b);
  }
}

// ── Move ──────────────────────────────────────────────────────────────────

function handleMove(e) {
  e.preventDefault();
  ptrs.set(e.pointerId, e); // atualiza posição

  if (gesture === 'drawing') {
    // Só o ponteiro que iniciou o stroke
    if (e.pointerId === getFirstPointerId()) {
      const { x, y } = canvasXY(e);
      continueStroke(x, y);
    }

  } else if (gesture === 'panning') {
    if (e.pointerId === getFirstPointerId()) {
      const sens = getPrefs().panSensitivity || 1;
      const dx = e.clientX - panLastX;
      const dy = e.clientY - panLastY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      // panBy subtrai: mover dedo pra direita → conteúdo vai pra direita → vpX diminui
      vp.panBy(dx * sens, dy * sens);
      ren.rebake();
    }

  } else if (gesture === 'pinching') {
    if (ptrs.size >= 2) {
      doPinch();
    }
  }
}

// ── Up ────────────────────────────────────────────────────────────────────

function handleUp(e) {
  e.preventDefault();
  ptrs.delete(e.pointerId);

  const count = ptrs.size;

  if (gesture === 'drawing' && count === 0) {
    finishStroke();
    gesture = 'idle';

  } else if (gesture === 'panning' && count === 0) {
    gesture = 'idle';

  } else if (gesture === 'pinching') {
    if (count === 1) {
      // Voltou pra 1 dedo — continua como pan até levantar
      gesture = 'panning';
      const remaining = ptrs.values().next().value;
      panLastX = remaining.clientX;
      panLastY = remaining.clientY;
    } else if (count === 0) {
      gesture = 'idle';
    }
  }
}

function handleCancel(e) {
  ptrs.delete(e.pointerId);
  if (gesture === 'drawing') {
    ren.cancelStroke();
    if (currentStrokeId) { peer?.send({ type: 'stroke:end', id: currentStrokeId }); currentStrokeId = null; }
  }
  if (ptrs.size === 0) gesture = 'idle';
}

function getFirstPointerId() {
  return ptrs.keys().next().value ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
// STROKE (desenho)
// ══════════════════════════════════════════════════════════════════════════

function beginStroke(x, y) {
  strokeId++;
  currentStrokeId = `m${strokeId}`;
  const { nx, ny } = ren.startStroke(currentTool, currentColor, currentSize, x, y);
  peer?.send({ type: 'stroke:start', id: currentStrokeId,
    tool: currentTool, color: currentColor, size: currentSize,
    nx, ny, page: currentPdfPage });
  if (getPrefs().haptic && navigator.vibrate) navigator.vibrate(8);
}

function continueStroke(x, y) {
  const norm = ren.continueStroke(x, y);
  if (norm && currentStrokeId) {
    peer?.send({ type: 'stroke:move', id: currentStrokeId, nx: norm.nx, ny: norm.ny });
  }
}

function finishStroke() {
  ren.commitStroke();
  if (currentStrokeId) {
    peer?.send({ type: 'stroke:end', id: currentStrokeId });
    currentStrokeId = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PINCH / PAN com 2 dedos
// ══════════════════════════════════════════════════════════════════════════

function initPinch(a, b) {
  pinchLastDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  pinchLastMidX = (a.clientX + b.clientX) / 2;
  pinchLastMidY = (a.clientY + b.clientY) / 2;
}

function doPinch() {
  const [a, b] = [...ptrs.values()];
  const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const midX = (a.clientX + b.clientX) / 2;
  const midY = (a.clientY + b.clientY) / 2;
  const rect = CANVASES.draw.getBoundingClientRect();
  const fX   = midX - rect.left;
  const fY   = midY - rect.top;

  // Zoom (somente se não travado)
  if (!State.get('viewport')?.locked && pinchLastDist > 0) {
    const ratio = dist / pinchLastDist;
    vp.zoomAt(vp.z * ratio, fX, fY);
  }

  // Pan via midpoint
  if (pinchLastMidX !== 0 || pinchLastMidY !== 0) {
    const sens = getPrefs().panSensitivity || 1;
    vp.panBy((midX - pinchLastMidX) * sens, (midY - pinchLastMidY) * sens);
  }

  pinchLastDist = dist;
  pinchLastMidX = midX;
  pinchLastMidY = midY;

  ren.rebake();
}

// ══════════════════════════════════════════════════════════════════════════
// VP BROADCAST
// ══════════════════════════════════════════════════════════════════════════

function broadcastVP() {
  if (peer?.state === ConnState.CONNECTED) {
    peer.send({ type: 'viewport', ...vp.toNormState() });
  }
}

function startViewportBroadcast() {
  if (_vpTimer) return;
  _vpTimer = setInterval(broadcastVP, 40);
}

// ══════════════════════════════════════════════════════════════════════════
// CODE INPUT
// ══════════════════════════════════════════════════════════════════════════

const codeChars = [...document.querySelectorAll('.code-char')];
codeChars.forEach((inp, i) => {
  inp.addEventListener('input', e => {
    const v = e.target.value.replace(/\D/, ''); inp.value = v;
    inp.classList.toggle('filled', !!v);
    if (v && i < codeChars.length - 1) codeChars[i + 1].focus();
    checkCode();
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !inp.value && i > 0) {
      codeChars[i - 1].focus();
      codeChars[i - 1].value = '';
      codeChars[i - 1].classList.remove('filled');
    }
  });
  inp.addEventListener('paste', e => {
    e.preventDefault();
    const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    t.split('').forEach((c, j) => {
      if (codeChars[j]) { codeChars[j].value = c; codeChars[j].classList.add('filled'); }
    });
    checkCode();
  });
});

const getCode   = () => codeChars.map(i => i.value).join('');
const checkCode = () => { const b = $('btn-connect'); if (b) b.disabled = getCode().length < 6; };

;(function autoFill() {
  const code = new URLSearchParams(location.search).get('code');
  if (code && /^\d{6}$/.test(code)) {
    code.split('').forEach((c, i) => {
      if (codeChars[i]) { codeChars[i].value = c; codeChars[i].classList.add('filled'); }
    });
    checkCode();
    setTimeout(() => $('btn-connect')?.click(), 500);
  }
})();

// ══════════════════════════════════════════════════════════════════════════
// CONEXÃO
// ══════════════════════════════════════════════════════════════════════════

$('btn-connect')?.addEventListener('click', async () => {
  const code = getCode();
  if (code.length < 6) return;
  setStatus('connecting', 'Conectando…');
  $('btn-connect').disabled = true;
  peer = new DigiPeer({ role: 'guest', code, onStateChange: onConnState, onMessage: onMsg });
  try { await peer.startAsGuest(); }
  catch (err) { setStatus('error', err.message.split('\n')[0]); $('btn-connect').disabled = false; }
});

function onConnState(state) {
  State.set('connected', state === ConnState.CONNECTED);
  if (state === ConnState.CONNECTED) {
    setStatus('success', 'Conectado!');
    setTimeout(showDrawScreen, 400);
  } else if (state === ConnState.DISCONNECTED) {
    setText('mobile-status-text', 'Desconectado');
    $('mobile-status-dot')?.classList.replace('connected', 'disconnected');
    if (screenDraw.classList.contains('active')) {
      toast('Conexão perdida', 'error');
      setTimeout(() => {
        screenDraw.classList.remove('active'); screenDraw.style.display = '';
        screenConnect.classList.add('active');
        $('btn-connect').disabled = false; setStatus('', '');
      }, 1500);
    }
  } else if (state === ConnState.ERROR) {
    setStatus('error', 'Falha na conexão');
    $('btn-connect').disabled = false;
  }
}

function onMsg(msg) {
  if (!msg?.type) return;
  switch (msg.type) {
    // Traços do PC → celular
    case 'stroke:start': ren.remoteStart(msg.id, msg.tool, msg.color, msg.size, msg.nx, msg.ny); break;
    case 'stroke:move':  ren.remoteMove(msg.id, msg.nx, msg.ny);  break;
    case 'stroke:end':   ren.remoteEnd(msg.id);                   break;

    // Limpeza
    case 'clear:all':    ren.clearAll();    break;
    case 'clear:local':  ren.clearMobile(); break;
    case 'clear:remote': ren.clearPC();     break;
    case 'clear':        ren.clearAll();    break;

    // Undo/Redo do PC
    case 'undo': ren.undoPC();    toast('↩ PC', 'info', 1000); break;
    case 'redo': ren.rebake();    toast('↪ PC', 'info', 1000); break;

    // PDF
    case 'pdf:size':
      State.set('pdfSize', { w: msg.w, h: msg.h });
      vp.setDocSize(msg.w, msg.h); // faz fit automático internamente
      ren.resize(canvasW, canvasH, window.devicePixelRatio || 1); // reconstrói contextos
      ren.rebake();
      break;
    case 'pdf:thumb': {
      const img = new Image();
      img.onload = () => ren.setThumb(img);
      img.src = msg.data;
      break;
    }
    // PC está trocando de PDF durante sessão ativa
    case 'pdf:swapping':
      ren.clearPC();
      toast('📄 Novo PDF chegando…', 'info', 1500);
      break;
    // Página atual do PDF no desktop
    case 'pdf:page':
      currentPdfPage = msg.page ?? 1;
      // Mostra brevemente qual página o PC está vendo no HUD
      setText('mobile-mode-label', `Pág. ${msg.page}${msg.total ? '/' + msg.total : ''}`);
      setTimeout(() => setText('mobile-mode-label',
        mode === 'pan' ? 'Navegar' : 'Desenho'), 2000);
      break;

    // Sync de estado
    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        State.merge('viewport', { locked: msg.zoomLocked });
        const el = $('toggle-zoom-lock'); if (el) el.checked = msg.zoomLocked;
        toast(msg.zoomLocked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
      }
      if (typeof msg.gridEnabled === 'boolean') {
        ren.setGridEnabled(msg.gridEnabled);
        const el = $('toggle-grid-mob'); if (el) el.checked = msg.gridEnabled;
      }
      if (msg.clearMode) State.set('clearMode', msg.clearMode);
      break;

    // PC moveu o indicador
    case 'viewport:set':
      vp.moveTo(msg.nx * vp.docW, msg.ny * vp.docH);
      ren.rebake();
      break;
  }
}

function setStatus(type, text) {
  const s = $('connect-status'); if (s) s.className = `connect-status ${type}`;
  const m = $('connect-msg');    if (m) m.textContent = text;
}

function setText(id, text) {
  const el = $(id); if (el) el.textContent = text;
}

function showDrawScreen() {
  screenConnect.classList.remove('active');
  screenDraw.classList.add('active');
  screenDraw.style.display = 'flex';
  setText('mobile-status-text', 'Conectado');
  const sd = $('mobile-status-dot');
  if (sd) sd.className = 'status-dot connected';
  peer?.send({ type: 'request:pdf' });
  resizeCanvas();
  bindInput();
  startViewportBroadcast();
  applyMenuPrefs();
  // Dica de uso na primeira vez
  setTimeout(() => toast('1 dedo = desenha | 2 dedos = move/zoom', 'info', 3000), 800);
}

function applyMenuPrefs() {
  const p = getPrefs();
  const s = $('bg-select');       if (s)  s.value   = p.bgMode || 'pdf';
  const r = $('size-slider');     if (r)  r.value   = p.size || 3; updateSizeLabel(p.size || 3);
  const ps = $('pan-sensitivity');if (ps) ps.value  = p.panSensitivity || 1;
  const hp = $('toggle-haptic'); if (hp) hp.checked = p.haptic ?? true;
  const pl = $('toggle-palm');   if (pl) pl.checked = p.palmReject ?? true;
  const gl = $('toggle-zoom-lock'); if (gl) gl.checked = State.get('viewport')?.locked ?? false;
  const gm = $('toggle-grid-mob');  if (gm) gm.checked = p.gridEnabled ?? false;
}

// ══════════════════════════════════════════════════════════════════════════
// TOOLBAR
// ══════════════════════════════════════════════════════════════════════════

// Ferramentas de desenho
document.querySelectorAll('.mob-tool[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;

    if (tool === 'pan') {
      // Toggle pan mode
      mode = (mode === 'pan') ? 'draw' : 'pan';
      btn.classList.toggle('active', mode === 'pan');
      document.querySelectorAll('.mob-tool[data-tool]:not([data-tool="pan"])').forEach(b =>
        b.classList.toggle('active', mode === 'draw' && b.dataset.tool === currentTool)
      );
      setText('mobile-mode-label', mode === 'pan' ? 'Navegar' : 'Desenho');
      return;
    }

    // Ferramenta de desenho
    mode = 'draw';
    document.querySelectorAll('.mob-tool[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = tool;
    setText('mobile-mode-label', 'Desenho');
  });
});

// Cores rápidas
document.querySelectorAll('.quick-color').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quick-color').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = btn.dataset.color;
    const inp = $('mob-color'); if (inp) inp.value = currentColor;
  });
});
$('mob-color')?.addEventListener('input', e => {
  currentColor = e.target.value;
  document.querySelectorAll('.quick-color').forEach(b => b.classList.remove('active'));
});

// Slider de espessura
function updateSizeLabel(v) {
  const lbl = $('size-slider-label'); if (lbl) lbl.textContent = v;
  const dot = $('size-preview-dot');
  if (dot) { const px = Math.min(48, Math.max(2, v)); dot.style.width = px + 'px'; dot.style.height = px + 'px'; }
}
$('size-slider')?.addEventListener('input', e => {
  currentSize = parseInt(e.target.value);
  updateSizeLabel(currentSize);
  setPref('size', currentSize);
});

// Undo / Clear
$('btn-mob-undo')?.addEventListener('click', () => {
  if (ren.undoMobile()) {
    peer?.send({ type: 'undo' });
    if (navigator.vibrate) navigator.vibrate([10, 30, 10]);
    toast('↩ Desfeito', 'info', 800);
  } else {
    toast('Nada para desfazer', 'info', 800);
  }
});
$('btn-mob-clear')?.addEventListener('click', () => {
  if (!ren.layerMobile.length) { toast('Nada para limpar', 'info', 800); return; }
  if (confirm('Limpar seus traços?')) {
    ren.clearMobile();
    peer?.send({ type: 'clear:local' });
    toast('Traços limpos', 'info', 800);
  }
});

// Desconectar
$('btn-mob-disconnect')?.addEventListener('click', async () => {
  clearInterval(_vpTimer); _vpTimer = null;
  await peer?.disconnect();
  peer = null;
  screenDraw.classList.remove('active'); screenDraw.style.display = '';
  screenConnect.classList.add('active');
  codeChars.forEach(i => { i.value = ''; i.classList.remove('filled'); });
  checkCode(); setStatus('', '');
  ren.clearAll();
  gesture = 'idle'; ptrs.clear();
});

// Menu lateral
$('btn-mobile-menu')?.addEventListener('click', () => $('mobile-menu')?.classList.remove('hidden'));
$('btn-close-menu')?.addEventListener('click',  () => $('mobile-menu')?.classList.add('hidden'));

// Toggles
$('toggle-zoom-lock')?.addEventListener('change', e => {
  State.merge('viewport', { locked: e.target.checked });
  setPref('zoomLocked', e.target.checked);
  peer?.send({ type: 'state:sync', zoomLocked: e.target.checked });
  toast(e.target.checked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});
$('toggle-grid-mob')?.addEventListener('change', e => {
  ren.setGridEnabled(e.target.checked);
  setPref('gridEnabled', e.target.checked);
});
$('toggle-palm')?.addEventListener('change',   e => { palmReject = e.target.checked; setPref('palmReject', palmReject); });
$('toggle-haptic')?.addEventListener('change', e => setPref('haptic', e.target.checked));
$('pan-sensitivity')?.addEventListener('input', e => setPref('panSensitivity', parseFloat(e.target.value)));
$('bg-select')?.addEventListener('change', e => { ren.setBgMode(e.target.value); setPref('bgMode', e.target.value); });

// Temas
document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.themeBtn);
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.toggle('active', b === btn));
    toast('Tema: ' + btn.dataset.themeBtn, 'info');
  });
});
