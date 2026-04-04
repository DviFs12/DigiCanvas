/**
 * mobile.js v6 — REFATORADO
 * ───────────────────────────
 * Usa: Viewport (math), MobileRenderer (rAF), State (pub/sub)
 *
 * RESPONSABILIDADES DESTE ARQUIVO:
 *  - Input (pointer events unificados)
 *  - Conexão WebRTC
 *  - Toolbar / Menu
 *
 * NÃO faz rendering diretamente — delega ao MobileRenderer.
 * NÃO faz math de coordenadas — delega ao Viewport.
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

// Canvases (z-index definido no HTML)
const canvases = {
  bg:    $('bg-canvas'),
  thumb: $('thumb-canvas'),
  rem:   $('remote-canvas-mob'),
  grid:  $('grid-canvas-mob'),
  draw:  $('mobile-canvas'),
};

// ── Core objects ────────────────────────────────────────────────────────
let vp  = null;  // Viewport
let ren = null;  // MobileRenderer
let peer = null; // DigiPeer

// ── State derivado ──────────────────────────────────────────────────────
let canvasW = 0, canvasH = 0;
const DPR = () => window.devicePixelRatio || 1;

// Ferramentas
let currentTool  = 'pen';
let currentColor = '#e63946';
let currentSize  = 3;
let isPanMode    = false;
let isResizeMode = false;
let palmReject   = true;

// Input state
let activePointerId = null;
let gestureState    = 'idle'; // 'idle' | 'draw' | 'pan' | 'pinch'
let strokeId        = 0;
let currentStrokeId = null;

// Pinch state
let pinchIds     = [];
let pinchPrev    = { dist: 0, midX: 0, midY: 0 };

// Resize drag
let resizeDragActive = false;
let resizeDragStart  = { x: 0, y: 0, docW: 0, docH: 0 };

// VP broadcast timer
let _vpTimer = null;

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

applyTheme();

// Inicializa VP e Renderer com dimensões padrão — serão corrigidas no resize
vp  = new Viewport(794, 1123, window.innerWidth, 500);
ren = new MobileRenderer(canvases, vp);

// Aplica prefs
const prefs = getPrefs();
palmReject = prefs.palmReject ?? true;
ren.setBgMode(prefs.bgMode || 'pdf');
ren.setGridEnabled(prefs.gridEnabled || false);

// ── Escuta State para sincronização ──────────────────────────────────────

State.on('pdfSize', ({ w, h }) => {
  vp.setDocSize(w, h);
  ren.markDirty();
});

// ══════════════════════════════════════════════════════════════════════════
// CANVAS RESIZE
// ══════════════════════════════════════════════════════════════════════════

function resizeCanvas() {
  const hud  = $('mobile-hud');
  const bar  = $('mobile-toolbar');
  const hudH = hud?.offsetHeight ?? 52;
  const barH = bar?.offsetHeight ?? 100;

  canvasW = window.innerWidth;
  canvasH = window.innerHeight - hudH - barH;

  // Posiciona todos os canvas sobre a área de desenho
  for (const c of Object.values(canvases)) {
    if (!c) continue;
    c.style.top = hudH + 'px';
  }

  vp.setScrSize(canvasW, canvasH);
  ren.resize(canvasW, canvasH, DPR());
}

window.addEventListener('resize', () => {
  if (screenDraw.classList.contains('active')) resizeCanvas();
});

// ══════════════════════════════════════════════════════════════════════════
// POINTER EVENTS (unificado — mouse + touch)
// ══════════════════════════════════════════════════════════════════════════

function bindInputEvents() {
  const c = canvases.draw;
  c.addEventListener('pointerdown',   onPointerDown,   { passive: false });
  c.addEventListener('pointermove',   onPointerMove,   { passive: false });
  c.addEventListener('pointerup',     onPointerUp,     { passive: false });
  c.addEventListener('pointercancel', onPointerCancel, { passive: false });
}

function getCanvasPos(e) {
  const rect = canvases.draw.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function isPalmEvent(e) {
  return palmReject && e.pointerType === 'touch' &&
    ((e.width > 50 || e.height > 50) || e.pressure > 0.85);
}

// ── Pointer Down ──────────────────────────────────────────────────────────

function onPointerDown(e) {
  e.preventDefault();
  if (isPalmEvent(e)) return;

  const active = getActivePointers();

  if (active.length === 0) {
    // Primeiro dedo
    canvases.draw.setPointerCapture(e.pointerId);
    active.push(e);

    if (isResizeMode) {
      startResizeDrag(e);
      gestureState = 'resize';
    } else if (isPanMode) {
      gestureState = 'pan';
    } else {
      gestureState = 'draw';
      startDrawStroke(e);
    }
  } else if (active.length === 1 && e.pointerType === 'touch') {
    // Segundo dedo — inicia pinch, cancela qualquer stroke em andamento
    if (gestureState === 'draw') {
      ren.cancelStroke();
      if (currentStrokeId) peer?.send({ type:'stroke:end', id:currentStrokeId });
    }
    gestureState = 'pinch';
    pinchIds = [active[0].pointerId, e.pointerId];
    updatePinchRef(active[0], e);
  }

  _trackPointer(e);
}

// ── Pointer Move ──────────────────────────────────────────────────────────

function onPointerMove(e) {
  e.preventDefault();
  _trackPointer(e);

  if (gestureState === 'draw' && e.pointerId === activeDrawPointerId()) {
    continueDrawStroke(e);
  } else if (gestureState === 'pan' && e.pointerId === activeDrawPointerId()) {
    doPan(e);
  } else if (gestureState === 'pinch') {
    doPinch();
  } else if (gestureState === 'resize') {
    doResizeDrag(e);
  }
}

// ── Pointer Up ────────────────────────────────────────────────────────────

function onPointerUp(e) {
  e.preventDefault();
  _removePointer(e);

  const remaining = getActivePointers();

  if (gestureState === 'draw') {
    commitDrawStroke();
    gestureState = 'idle';
  } else if (gestureState === 'pinch' && remaining.length <= 1) {
    gestureState = remaining.length === 1 ? 'pan' : 'idle';
    pinchIds = [];
  } else if (gestureState === 'pan' && remaining.length === 0) {
    gestureState = 'idle';
  } else if (gestureState === 'resize') {
    resizeDragActive = false;
    gestureState = 'idle';
  }
}

function onPointerCancel(e) {
  _removePointer(e);
  if (gestureState === 'draw') { ren.cancelStroke(); if (currentStrokeId) peer?.send({ type:'stroke:end', id:currentStrokeId }); }
  gestureState = 'idle'; pinchIds = [];
}

// ── Pointer tracking ──────────────────────────────────────────────────────

const _pointers = new Map();
function _trackPointer(e)  { _pointers.set(e.pointerId, e); }
function _removePointer(e) { _pointers.delete(e.pointerId); }
function getActivePointers() { return [..._pointers.values()]; }
function activeDrawPointerId() { return getActivePointers()[0]?.pointerId ?? null; }

// ── Draw ──────────────────────────────────────────────────────────────────

function startDrawStroke(e) {
  const { x, y } = getCanvasPos(e);
  strokeId++;
  currentStrokeId = `m${strokeId}`;
  const { nx, ny } = ren.startStroke(currentTool, currentColor, currentSize, x, y);
  peer?.send({ type:'stroke:start', id:currentStrokeId, tool:currentTool, color:currentColor, size:currentSize, nx, ny });
  if (getPrefs().haptic && navigator.vibrate) navigator.vibrate(8);
}

function continueDrawStroke(e) {
  const { x, y } = getCanvasPos(e);
  const norm = ren.continueStroke(x, y);
  if (norm) peer?.send({ type:'stroke:move', id:currentStrokeId, nx:norm.nx, ny:norm.ny });
}

function commitDrawStroke() {
  ren.commitStroke();
  if (currentStrokeId) { peer?.send({ type:'stroke:end', id:currentStrokeId }); currentStrokeId = null; }
}

// ── Pan ───────────────────────────────────────────────────────────────────

let _panLast = { x: 0, y: 0 };
function doPan(e) {
  const { x, y } = getCanvasPos(e);
  const prev = _panLast;
  if (prev.x !== 0 || prev.y !== 0) {
    const sens = getPrefs().panSensitivity || 1;
    vp.panBy((x - prev.x) * sens, (y - prev.y) * sens);
    ren.rebake();
  }
  _panLast = { x, y };
}

canvases.draw?.addEventListener('pointerdown', e => { _panLast = getCanvasPos(e); });

// ── Pinch (zoom centrado no midpoint) ────────────────────────────────────

function updatePinchRef(e1, e2) {
  const dist = Math.hypot(e1.clientX-e2.clientX, e1.clientY-e2.clientY);
  const midX = (e1.clientX+e2.clientX)/2 - canvases.draw.getBoundingClientRect().left;
  const midY = (e1.clientY+e2.clientY)/2 - canvases.draw.getBoundingClientRect().top;
  pinchPrev = { dist, midX, midY };
}

function doPinch() {
  const ps = getActivePointers().filter(p => pinchIds.includes(p.pointerId));
  if (ps.length < 2) return;
  const [p1, p2] = ps;
  const rect = canvases.draw.getBoundingClientRect();
  const dist = Math.hypot(p1.clientX-p2.clientX, p1.clientY-p2.clientY);
  const midX = (p1.clientX+p2.clientX)/2 - rect.left;
  const midY = (p1.clientY+p2.clientY)/2 - rect.top;

  if (!State.get('viewport')?.locked) {
    if (pinchPrev.dist > 0) {
      const newZ = vp.z * (dist / pinchPrev.dist);
      vp.zoomAt(newZ, midX, midY);
    }
  }
  // Pan pelo mid
  if (pinchPrev.midX !== undefined) {
    const sens = getPrefs().panSensitivity || 1;
    vp.panBy((midX - pinchPrev.midX) * sens, (midY - pinchPrev.midY) * sens);
  }

  pinchPrev = { dist, midX, midY };
  ren.rebake();
}

// ── Resize drag ───────────────────────────────────────────────────────────

function startResizeDrag(e) {
  const { x, y } = getCanvasPos(e);
  resizeDragActive = true;
  resizeDragStart  = { x, y, docW: vp.docW, docH: vp.docH };
}

function doResizeDrag(e) {
  if (!resizeDragActive) return;
  const { x, y } = getCanvasPos(e);
  const dx = x - resizeDragStart.x;
  const dy = y - resizeDragStart.y;

  // O drag muda o "tamanho visível" — equivale a ajustar o zoom
  // Aumentar drag → ver mais → zoom out; diminuir → zoom in
  const newVisW = Math.max(50, canvasW + dx);
  const newVisH = Math.max(50, canvasH + dy);
  const zFromW  = canvasW / newVisW;
  const zFromH  = canvasH / newVisH;

  if (!State.get('viewport')?.locked) {
    vp.zoomAt(Math.min(zFromW, zFromH), canvasW / 2, canvasH / 2);
    ren.rebake();
    broadcastVP();
    peer?.send({ type:'viewport:resize', ...vp.toNormState() });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// VP BROADCAST
// ══════════════════════════════════════════════════════════════════════════

function broadcastVP() {
  if (peer?.state === ConnState.CONNECTED) {
    peer.send({ type:'viewport', ...vp.toNormState() });
  }
}

function startViewportBroadcast() {
  if (_vpTimer) return;
  _vpTimer = setInterval(broadcastVP, 40); // ~25fps para posição
}

// ══════════════════════════════════════════════════════════════════════════
// CODE INPUT
// ══════════════════════════════════════════════════════════════════════════

const codeChars = [...document.querySelectorAll('.code-char')];
codeChars.forEach((inp, i) => {
  inp.addEventListener('input', e => {
    const v = e.target.value.replace(/\D/,''); inp.value = v;
    inp.classList.toggle('filled', !!v);
    if (v && i < codeChars.length-1) codeChars[i+1].focus();
    checkCode();
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !inp.value && i > 0) {
      codeChars[i-1].focus(); codeChars[i-1].value = ''; codeChars[i-1].classList.remove('filled');
    }
  });
  inp.addEventListener('paste', e => {
    e.preventDefault();
    const t = e.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);
    t.split('').forEach((c,j) => { if (codeChars[j]) { codeChars[j].value = c; codeChars[j].classList.add('filled'); } });
    checkCode();
  });
});

const getCode   = () => codeChars.map(i => i.value).join('');
const checkCode = () => { const b=$('btn-connect'); if (b) b.disabled = getCode().length < 6; };

;(function autoFill() {
  const code = new URLSearchParams(location.search).get('code');
  if (code && /^\d{6}$/.test(code)) {
    code.split('').forEach((c,i) => { if (codeChars[i]) { codeChars[i].value=c; codeChars[i].classList.add('filled'); } });
    checkCode();
    setTimeout(() => $('btn-connect')?.click(), 500);
  }
})();

// ══════════════════════════════════════════════════════════════════════════
// CONEXÃO
// ══════════════════════════════════════════════════════════════════════════

$('btn-connect')?.addEventListener('click', async () => {
  const code = getCode(); if (code.length < 6) return;
  setStatus('connecting','Conectando…'); $('btn-connect').disabled = true;
  peer = new DigiPeer({ role:'guest', code, onStateChange:handleStateChange, onMessage:handleMessage });
  try { await peer.startAsGuest(); }
  catch (err) { setStatus('error', err.message.split('\n')[0]); $('btn-connect').disabled = false; }
});

function handleStateChange(state) {
  State.set('connected', state === ConnState.CONNECTED);
  if (state === ConnState.CONNECTED) {
    setStatus('success','Conectado!');
    setTimeout(showDrawScreen, 400);
  } else if (state === ConnState.DISCONNECTED) {
    const st=$('mobile-status-text'); if (st) st.textContent='Desconectado';
    $('mobile-status-dot')?.classList.replace('connected','disconnected');
    if (screenDraw.classList.contains('active')) {
      toast('Conexão perdida','error');
      setTimeout(() => {
        screenDraw.classList.remove('active'); screenDraw.style.display='';
        screenConnect.classList.add('active'); $('btn-connect').disabled=false; setStatus('','');
      }, 1500);
    }
  } else if (state === ConnState.ERROR) {
    setStatus('error','Falha na conexão'); $('btn-connect').disabled=false;
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;
  switch (msg.type) {

    // ── Traços do PC → aparecem no celular ──────────────────────────────
    case 'stroke:start':
      ren.remoteStart(msg.id, msg.tool, msg.color, msg.size, msg.nx, msg.ny); break;
    case 'stroke:move':
      ren.remoteMove(msg.id, msg.nx, msg.ny); break;
    case 'stroke:end':
      ren.remoteEnd(msg.id); break;

    // ── Limpeza ──────────────────────────────────────────────────────────
    case 'clear:all':    ren.clearAll();    break;
    case 'clear:local':  ren.clearMobile(); break; // PC pede que celular limpe seus traços
    case 'clear:remote': ren.clearPC();     break; // PC limpou traços remotos (celular visualmente)
    case 'clear':        ren[State.get('clearMode')==='shared'?'clearAll':'clearMobile'](); break;

    // ── Undo/Redo do PC ──────────────────────────────────────────────────
    case 'undo': ren.undoPC();  toast('↩ PC desfez','info',1200); break;
    case 'redo': ren.markDirty(); toast('↪ PC refez','info',1200); break;

    // ── PDF info ─────────────────────────────────────────────────────────
    case 'pdf:size':
      State.set('pdfSize', { w: msg.w, h: msg.h });
      vp.setDocSize(msg.w, msg.h);
      ren.markDirty();
      break;
    case 'pdf:thumb':
      const img = new Image();
      img.onload = () => { ren.setThumb(img); };
      img.src = msg.data;
      break;

    // ── Controle de estado ───────────────────────────────────────────────
    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        State.merge('viewport', { locked: msg.zoomLocked });
        const el=$('toggle-zoom-lock'); if (el) el.checked=msg.zoomLocked;
        toast(msg.zoomLocked?'🔒 Zoom travado':'🔓 Zoom liberado','info');
      }
      if (typeof msg.gridEnabled === 'boolean') {
        ren.setGridEnabled(msg.gridEnabled);
        const el=$('toggle-grid-mob'); if (el) el.checked=msg.gridEnabled;
      }
      if (msg.clearMode) State.set('clearMode', msg.clearMode);
      break;

    // ── Teleporte do viewport (PC arrastou indicador) ────────────────────
    case 'viewport:set':
      vp.moveTo(msg.nx * vp.docW, msg.ny * vp.docH);
      ren.rebake(); break;

    // ── PC redimensionou o viewport ───────────────────────────────────────
    case 'viewport:resize':
      if (!State.get('viewport')?.locked && msg.nw > 0 && msg.nh > 0) {
        vp.fromNormState(msg);
        ren.rebake();
      }
      break;
  }
}

function setStatus(type, text) {
  const s=$('connect-status'); if (s) s.className=`connect-status ${type}`;
  const m=$('connect-msg');    if (m) m.textContent=text;
}

function showDrawScreen() {
  screenConnect.classList.remove('active');
  screenDraw.classList.add('active'); screenDraw.style.display='flex';
  const st=$('mobile-status-text'); if (st) st.textContent='Conectado';
  const sd=$('mobile-status-dot');  if (sd) sd.className='status-dot connected';
  peer?.send({ type:'request:pdf' });
  resizeCanvas();
  bindInputEvents();
  startViewportBroadcast();
  applyMenuPrefs();
}

function applyMenuPrefs() {
  const p = getPrefs();
  const s=$('bg-select');      if (s) s.value = p.bgMode||'pdf';
  const r=$('size-slider');    if (r) { r.value = p.size||3; updateSizeLabel(p.size||3); }
  const ps=$('pan-sensitivity'); if (ps) ps.value = p.panSensitivity||1;
  const hp=$('toggle-haptic'); if (hp) hp.checked = p.haptic??true;
  const pl=$('toggle-palm');   if (pl) pl.checked = p.palmReject??true;
  const gl=$('toggle-zoom-lock'); if (gl) gl.checked = State.get('viewport')?.locked??false;
  const gm=$('toggle-grid-mob'); if (gm) gm.checked = p.gridEnabled??false;
}

// ══════════════════════════════════════════════════════════════════════════
// TOOLBAR
// ══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.mob-tool[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;

    if (tool === 'pan') {
      isPanMode = !isPanMode; isResizeMode = false;
      btn.classList.toggle('active', isPanMode);
      $('btn-resize-mode')?.classList.remove('active');
      document.querySelectorAll('.mob-tool[data-tool]:not([data-tool="pan"])').forEach(b =>
        b.classList.toggle('active', !isPanMode && b.dataset.tool === currentTool)
      );
      const ml=$('mobile-mode-label'); if (ml) ml.textContent = isPanMode?'Navegar':'Desenho';
      return;
    }

    isPanMode=false; isResizeMode=false;
    document.querySelector('.mob-tool[data-tool="pan"]')?.classList.remove('active');
    $('btn-resize-mode')?.classList.remove('active');
    document.querySelectorAll('.mob-tool[data-tool]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentTool=tool;
    const ml=$('mobile-mode-label'); if (ml) ml.textContent='Desenho';
  });
});

$('btn-resize-mode')?.addEventListener('click', () => {
  isResizeMode = !isResizeMode; isPanMode=false;
  $('btn-resize-mode')?.classList.toggle('active', isResizeMode);
  if (isResizeMode) document.querySelectorAll('.mob-tool[data-tool]').forEach(b=>b.classList.remove('active'));
  const ml=$('mobile-mode-label'); if (ml) ml.textContent=isResizeMode?'Resize':'Desenho';
  toast(isResizeMode?'📐 Arraste para redimensionar viewport':'Modo de desenho','info',1500);
});

document.querySelectorAll('.quick-color').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quick-color').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); currentColor=btn.dataset.color;
    const inp=$('mob-color'); if (inp) inp.value=currentColor;
  });
});
$('mob-color')?.addEventListener('input', e => {
  currentColor=e.target.value;
  document.querySelectorAll('.quick-color').forEach(b=>b.classList.remove('active'));
});

function updateSizeLabel(v) {
  const lbl=$('size-slider-label'); if (lbl) lbl.textContent=v;
  const dot=$('size-preview-dot');
  if (dot) { const px=Math.min(48,Math.max(2,v)); dot.style.width=px+'px'; dot.style.height=px+'px'; }
}
$('size-slider')?.addEventListener('input', e => {
  currentSize=parseInt(e.target.value); updateSizeLabel(currentSize); setPref('size',currentSize);
});

$('btn-mob-undo')?.addEventListener('click', () => {
  if (ren.undoMobile()) peer?.send({ type:'undo' });
});
$('btn-mob-clear')?.addEventListener('click', () => {
  ren.clearMobile(); peer?.send({ type:'clear:local' });
});
$('btn-mob-disconnect')?.addEventListener('click', async () => {
  clearInterval(_vpTimer); _vpTimer=null;
  await peer?.disconnect();
  screenDraw.classList.remove('active'); screenDraw.style.display='';
  screenConnect.classList.add('active');
  codeChars.forEach(i=>{i.value='';i.classList.remove('filled');}); checkCode(); setStatus('','');
  ren.clearAll();
});

$('btn-mobile-menu')?.addEventListener('click', ()=>$('mobile-menu')?.classList.remove('hidden'));
$('btn-close-menu')?.addEventListener('click',  ()=>$('mobile-menu')?.classList.add('hidden'));

$('toggle-zoom-lock')?.addEventListener('change', e => {
  State.merge('viewport', { locked: e.target.checked });
  setPref('zoomLocked', e.target.checked);
  peer?.send({ type:'state:sync', zoomLocked:e.target.checked });
  toast(e.target.checked?'🔒 Zoom travado':'🔓 Zoom liberado','info');
});
$('toggle-grid-mob')?.addEventListener('change', e => {
  ren.setGridEnabled(e.target.checked); setPref('gridEnabled',e.target.checked);
});
$('toggle-palm')?.addEventListener('change', e => { palmReject=e.target.checked; setPref('palmReject',palmReject); });
$('toggle-haptic')?.addEventListener('change', e => setPref('haptic',e.target.checked));
$('pan-sensitivity')?.addEventListener('input', e => setPref('panSensitivity',parseFloat(e.target.value)));
$('bg-select')?.addEventListener('change', e => { ren.setBgMode(e.target.value); setPref('bgMode',e.target.value); });

document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  btn.addEventListener('click', ()=>{
    setTheme(btn.dataset.themeBtn);
    document.querySelectorAll('[data-theme-btn]').forEach(b=>b.classList.toggle('active',b===btn));
    toast('Tema: '+btn.dataset.themeBtn,'info');
  });
});
