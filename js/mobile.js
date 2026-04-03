/**
 * mobile.js — Controller do celular
 * ──────────────────────────────────
 * Coordenadas normalizadas, pan/zoom, ferramentas, temas, grade
 */

import { DigiPeer, ConnState } from './webrtc.js';
import { toast }               from './toast.js';
import { applyTheme, getTheme, setTheme, getPrefs, setPref } from './store.js';

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screenConnect = $('screen-connect');
const screenDraw    = $('screen-draw');
const mobileCanvas  = $('mobile-canvas');
const gridCanvasMob = $('grid-canvas-mob');

// ── Conexão ──────────────────────────────────────────────────────────────
let peer = null;

// ── Canvas ───────────────────────────────────────────────────────────────
let ctx  = null, gCtx = null;
let canvasW = 0, canvasH = 0;

// ── Viewport ──────────────────────────────────────────────────────────────
let vpX = 0, vpY = 0, vpZ = 1.0;
let pdfDocW = 1000, pdfDocH = 1414;
let zoomLocked = false;

// ── Fundo ──────────────────────────────────────────────────────────────────
let pdfThumb = null;
let bgMode   = getPrefs().bgMode || 'pdf';
let gridEnabled = getPrefs().gridEnabled || false;

// ── Ferramentas ────────────────────────────────────────────────────────────
let currentTool  = 'pen';
let currentColor = '#e63946';
let currentSize  = 3;
let isPanMode    = false;
let palmReject   = getPrefs().palmReject ?? true;

// ── Stroke ─────────────────────────────────────────────────────────────────
let isDrawing = false, strokeId = 0, currentId = null;
let lastX = 0, lastY = 0;

// ── Gestos ─────────────────────────────────────────────────────────────────
let lastPinchDist = null, lastPanX = null, lastPanY = null;

// ── Histórico local ─────────────────────────────────────────────────────────
const localStrokes = [];
let   activeStroke = null;

// ── Broadcast timer ────────────────────────────────────────────────────────
let _vpTimer = null;

// ── TOOLS config ────────────────────────────────────────────────────────────
const TOOLS = {
  pen:         { opacity: 1.0,  widthMul: 1,   blend: 'source-over'   },
  marker:      { opacity: 1.0,  widthMul: 2,   blend: 'source-over'   },
  highlighter: { opacity: 0.35, widthMul: 8,   blend: 'multiply'      },
  eraser:      { opacity: 1.0,  widthMul: 5,   blend: 'destination-out'},
};

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

applyTheme();

// ══════════════════════════════════════════════════════════════════════════
// CANVAS
// ══════════════════════════════════════════════════════════════════════════

function resizeCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const hud  = $('mobile-hud');
  const bar  = $('mobile-toolbar');
  const hudH = hud?.offsetHeight ?? 52;
  const barH = bar?.offsetHeight ?? 100;
  canvasW = window.innerWidth;
  canvasH = window.innerHeight - hudH - barH;

  [mobileCanvas, gridCanvasMob].forEach(c => {
    if (!c) return;
    c.width  = canvasW * dpr; c.height = canvasH * dpr;
    c.style.width  = canvasW + 'px'; c.style.height = canvasH + 'px';
    c.style.top    = hudH + 'px';
  });

  ctx  = mobileCanvas.getContext('2d');
  gCtx = gridCanvasMob?.getContext('2d');
  const dprScale = () => { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  dprScale();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (gCtx) { gCtx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  redrawAll();
}

window.addEventListener('resize', () => { if (screenDraw.classList.contains('active')) resizeCanvas(); });

// ══════════════════════════════════════════════════════════════════════════
// COORDENADAS NORMALIZADAS
// ══════════════════════════════════════════════════════════════════════════

function toNorm(cx, cy)  { return { nx: (vpX + cx / vpZ) / pdfDocW, ny: (vpY + cy / vpZ) / pdfDocH }; }
function fromNorm(nx, ny){ return { x: (nx * pdfDocW - vpX) * vpZ,  y: (ny * pdfDocH - vpY) * vpZ }; }

function clampViewport() {
  const visW = canvasW / vpZ, visH = canvasH / vpZ;
  vpX = Math.max(0, Math.min(vpX, Math.max(0, pdfDocW - visW)));
  vpY = Math.max(0, Math.min(vpY, Math.max(0, pdfDocH - visH)));
}

// ══════════════════════════════════════════════════════════════════════════
// REDRAW
// ══════════════════════════════════════════════════════════════════════════

function redrawAll() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvasW, canvasH);
  drawBackground();
  redrawStrokes();
  drawGridLayer();
}

function drawBackground() {
  if (bgMode === 'light') { ctx.fillStyle = '#f8f8f5'; ctx.fillRect(0,0,canvasW,canvasH); return; }
  if (bgMode === 'dark')  { ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0,0,canvasW,canvasH); return; }
  if (bgMode === 'amoled'){ ctx.fillStyle = '#000000'; ctx.fillRect(0,0,canvasW,canvasH); return; }
  // pdf
  if (pdfThumb) {
    ctx.drawImage(pdfThumb, -vpX * vpZ, -vpY * vpZ, pdfDocW * vpZ, pdfDocH * vpZ);
  } else {
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0,0,canvasW,canvasH);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let x = 0; x < canvasW; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvasH); ctx.stroke(); }
    for (let y = 0; y < canvasH; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvasW,y); ctx.stroke(); }
  }
}

function drawGridLayer() {
  if (!gCtx || !gridEnabled) {
    if (gCtx) gCtx.clearRect(0, 0, canvasW, canvasH);
    return;
  }
  gCtx.clearRect(0, 0, canvasW, canvasH);
  const step = 40 * vpZ;
  const offX  = (-vpX * vpZ) % step;
  const offY  = (-vpY * vpZ) % step;
  gCtx.strokeStyle = 'rgba(124,106,247,0.2)';
  gCtx.lineWidth   = 0.5;
  for (let x = offX; x < canvasW; x += step) { gCtx.beginPath(); gCtx.moveTo(x,0); gCtx.lineTo(x,canvasH); gCtx.stroke(); }
  for (let y = offY; y < canvasH; y += step) { gCtx.beginPath(); gCtx.moveTo(0,y); gCtx.lineTo(canvasW,y); gCtx.stroke(); }
}

// ── Strokes locais ────────────────────────────────────────────────────────

function redrawStrokes() {
  for (const s of localStrokes) drawFullStroke(s);
}

function drawFullStroke(s) {
  if (!s.points.length) return;
  const t = TOOLS[s.tool] || TOOLS.pen;
  ctx.save();
  ctx.lineCap  = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = t.blend;
  ctx.globalAlpha = t.opacity;
  ctx.strokeStyle = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
  ctx.fillStyle   = ctx.strokeStyle;
  ctx.lineWidth   = s.size * t.widthMul * vpZ;

  if (s.points.length === 1) {
    const p = fromNorm(s.points[0].nx, s.points[0].ny);
    ctx.beginPath(); ctx.arc(p.x, p.y, ctx.lineWidth/2, 0, Math.PI*2); ctx.fill();
  } else {
    ctx.beginPath();
    const p0 = fromNorm(s.points[0].nx, s.points[0].ny);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < s.points.length; i++) {
      const p = fromNorm(s.points[i].nx, s.points[i].ny);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawSegmentIncremental(s, prevPt, currPt) {
  const a = fromNorm(prevPt.nx, prevPt.ny);
  const b = fromNorm(currPt.nx, currPt.ny);
  const t = TOOLS[s.tool] || TOOLS.pen;
  ctx.save();
  ctx.lineCap  = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = t.blend;
  ctx.globalAlpha = t.opacity;
  ctx.strokeStyle = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
  ctx.lineWidth   = s.size * t.widthMul * vpZ;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.restore();
}

function handlePanZoom() {
  clampViewport();
  redrawAll();
}

// ══════════════════════════════════════════════════════════════════════════
// VIEWPORT BROADCAST
// ══════════════════════════════════════════════════════════════════════════

function startViewportBroadcast() {
  if (_vpTimer) return;
  _vpTimer = setInterval(() => {
    if (peer?.state !== ConnState.CONNECTED) return;
    const visW = canvasW / vpZ, visH = canvasH / vpZ;
    peer.send({ type: 'viewport', nx: vpX / pdfDocW, ny: vpY / pdfDocH, nw: visW / pdfDocW, nh: visH / pdfDocH, zoom: vpZ, locked: zoomLocked });
  }, 33);
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

const getCode  = () => codeChars.map(i => i.value).join('');
const checkCode = () => { const b = $('btn-connect'); if (b) b.disabled = getCode().length < 6; };

;(function autoFill() {
  const code = new URLSearchParams(location.search).get('code');
  if (code && /^\d{6}$/.test(code)) {
    code.split('').forEach((c,i) => { if (codeChars[i]) { codeChars[i].value = c; codeChars[i].classList.add('filled'); } });
    checkCode();
    setTimeout(() => $('btn-connect')?.click(), 500);
  }
})();

// ══════════════════════════════════════════════════════════════════════════
// CONEXÃO
// ══════════════════════════════════════════════════════════════════════════

$('btn-connect')?.addEventListener('click', async () => {
  const code = getCode(); if (code.length < 6) return;
  setStatus('connecting', 'Conectando…');
  $('btn-connect').disabled = true;
  peer = new DigiPeer({ role: 'guest', code, onStateChange: handleStateChange, onMessage: handleMessage });
  try { await peer.startAsGuest(); }
  catch (err) { setStatus('error', err.message.split('\n')[0]); $('btn-connect').disabled = false; }
});

function handleStateChange(state) {
  if (state === ConnState.CONNECTED) {
    setStatus('success', 'Conectado!');
    setTimeout(showDrawScreen, 500);
  } else if (state === ConnState.DISCONNECTED) {
    $('mobile-status-text') && ($('mobile-status-text').textContent = 'Desconectado');
    $('mobile-status-dot')?.classList.replace('connected','disconnected');
    if (screenDraw.classList.contains('active')) {
      toast('Conexão perdida', 'error');
      setTimeout(() => {
        screenDraw.classList.remove('active'); screenDraw.style.display = '';
        screenConnect.classList.add('active');
        $('btn-connect').disabled = false; setStatus('','');
      }, 1500);
    }
  } else if (state === ConnState.ERROR) {
    setStatus('error','Falha na conexão'); $('btn-connect').disabled = false;
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;
  switch (msg.type) {
    case 'pdf:size':
      pdfDocW = msg.w; pdfDocH = msg.h;
      vpX = 0; vpY = 0; vpZ = 1; clampViewport(); handlePanZoom(); break;
    case 'pdf:thumb':
      loadThumb(msg.data); break;
    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        zoomLocked = msg.zoomLocked;
        const el = $('toggle-zoom-lock'); if (el) el.checked = zoomLocked;
        toast(zoomLocked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
      }
      if (typeof msg.gridEnabled === 'boolean') {
        gridEnabled = msg.gridEnabled;
        const el = $('toggle-grid-mob'); if (el) el.checked = gridEnabled;
        drawGridLayer();
      }
      break;
    case 'clear':
      localStrokes.length = 0; activeStroke = null; redrawAll(); break;
    case 'undo': case 'redo':
      // Notificação visual apenas no celular
      toast(msg.type === 'undo' ? '↩ Undo do PC' : '↪ Redo do PC', 'info', 1200); break;
    case 'viewport:set':
      // PC arrastou o indicador → teletransporta viewport
      vpX = msg.nx * pdfDocW; vpY = msg.ny * pdfDocH;
      clampViewport(); handlePanZoom(); break;
  }
}

function loadThumb(dataUrl) {
  const img = new Image();
  img.onload = () => { pdfThumb = img; if (bgMode === 'pdf') handlePanZoom(); };
  img.src = dataUrl;
}

function setStatus(type, text) {
  const s = $('connect-status'); if (s) s.className = `connect-status ${type}`;
  const m = $('connect-msg');    if (m) m.textContent = text;
}

function showDrawScreen() {
  screenConnect.classList.remove('active');
  screenDraw.classList.add('active'); screenDraw.style.display = 'flex';
  const st = $('mobile-status-text'); if (st) st.textContent = 'Conectado';
  const sd = $('mobile-status-dot');  if (sd) sd.className = 'status-dot connected';
  // Pede info do PDF imediatamente
  peer?.send({ type: 'request:pdf' });
  resizeCanvas(); bindDrawEvents(); startViewportBroadcast();
}

// ══════════════════════════════════════════════════════════════════════════
// TOOLBAR MOBILE
// ══════════════════════════════════════════════════════════════════════════

// Mapa de tool → cor de accent para preview
const TOOL_COLORS = { pen: '#7c6af7', marker: '#4cc9f0', highlighter: '#f7c559', eraser: '#8888aa' };

document.querySelectorAll('.mob-tool[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tool === 'pan') {
      isPanMode = !isPanMode;
      btn.classList.toggle('active', isPanMode);
      document.querySelectorAll('.mob-tool[data-tool]:not([data-tool="pan"])').forEach(b => { if (isPanMode) b.classList.remove('active'); else if (b.dataset.tool === currentTool) b.classList.add('active'); });
      const ml = $('mobile-mode-label'); if (ml) ml.textContent = isPanMode ? 'Navegar' : 'Desenho';
      return;
    }
    isPanMode = false;
    document.querySelector('.mob-tool[data-tool="pan"]')?.classList.remove('active');
    document.querySelectorAll('.mob-tool[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
    const ml = $('mobile-mode-label'); if (ml) ml.textContent = 'Desenho';
    updateToolPreview();
  });
});

function updateToolPreview() {
  const preview = $('tool-preview');
  if (preview) { preview.style.background = currentColor; preview.dataset.tool = currentTool; }
}

// Espessuras
document.querySelectorAll('.mob-size').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mob-size').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSize = parseInt(btn.dataset.size);
  });
});

// Cores rápidas
document.querySelectorAll('.quick-color').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quick-color').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = btn.dataset.color;
    const inp = $('mob-color'); if (inp) inp.value = currentColor;
    updateToolPreview();
  });
});

$('mob-color')?.addEventListener('input', e => {
  currentColor = e.target.value; updateToolPreview();
  document.querySelectorAll('.quick-color').forEach(b => b.classList.remove('active'));
});

// Undo / Clear
$('btn-mob-undo')?.addEventListener('click', () => {
  if (localStrokes.length) { localStrokes.pop(); redrawAll(); peer?.send({ type: 'undo' }); }
});
$('btn-mob-clear')?.addEventListener('click', () => {
  localStrokes.length = 0; activeStroke = null; redrawAll(); peer?.send({ type: 'clear' });
});
$('btn-mob-disconnect')?.addEventListener('click', async () => {
  clearInterval(_vpTimer); _vpTimer = null;
  await peer?.disconnect();
  screenDraw.classList.remove('active'); screenDraw.style.display = '';
  screenConnect.classList.add('active');
  codeChars.forEach(i => { i.value = ''; i.classList.remove('filled'); });
  checkCode(); setStatus('',''); localStrokes.length = 0;
});

// Menu lateral
$('btn-mobile-menu')?.addEventListener('click', () => { const m = $('mobile-menu'); m?.classList.remove('hidden'); m?.classList.add('open'); });
$('btn-close-menu')?.addEventListener('click',  () => { const m = $('mobile-menu'); m?.classList.add('hidden'); m?.classList.remove('open'); });

// Toggles do menu
$('toggle-zoom-lock')?.addEventListener('change', e => {
  zoomLocked = e.target.checked; setPref('zoomLocked', zoomLocked);
  peer?.send({ type: 'state:sync', zoomLocked });
  toast(zoomLocked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});

$('toggle-grid-mob')?.addEventListener('change', e => {
  gridEnabled = e.target.checked; setPref('gridEnabled', gridEnabled);
  drawGridLayer();
});

$('toggle-palm')?.addEventListener('change', e => { palmReject = e.target.checked; setPref('palmReject', palmReject); });
$('toggle-haptic')?.addEventListener('change', e => setPref('haptic', e.target.checked));

$('pan-sensitivity')?.addEventListener('input', e => setPref('panSensitivity', parseFloat(e.target.value)));

$('bg-select')?.addEventListener('change', e => {
  bgMode = e.target.value; setPref('bgMode', bgMode); handlePanZoom();
});

// Temas mobile
document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.themeBtn);
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.toggle('active', b === btn));
    toast('Tema: ' + btn.dataset.themeBtn, 'info');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TOUCH EVENTS
// ══════════════════════════════════════════════════════════════════════════

function bindDrawEvents() {
  mobileCanvas.addEventListener('touchstart',  onTouchStart, { passive: false });
  mobileCanvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
  mobileCanvas.addEventListener('touchend',    onTouchEnd,   { passive: false });
  mobileCanvas.addEventListener('touchcancel', onTouchEnd,   { passive: false });
}

function getPos(t) { const r = mobileCanvas.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }
function isPalm(t) { return palmReject && (t.radiusX > 30 || t.radiusY > 30); }
const pinchDist = ts => Math.hypot(ts[0].clientX-ts[1].clientX, ts[0].clientY-ts[1].clientY);
const pinchMid  = ts => ({ x:(ts[0].clientX+ts[1].clientX)/2, y:(ts[0].clientY+ts[1].clientY)/2 });

function onTouchStart(e) {
  e.preventDefault();
  if (e.touches.length >= 2) {
    if (isDrawing) { isDrawing = false; endStroke(); }
    lastPinchDist = pinchDist(e.touches);
    const m = pinchMid(e.touches); lastPanX = m.x; lastPanY = m.y;
    return;
  }
  const t = e.touches[0]; if (isPalm(t)) return;
  const {x,y} = getPos(t);
  if (isPanMode) { lastPanX = t.clientX; lastPanY = t.clientY; return; }
  isDrawing = true; strokeId++; currentId = `m${strokeId}`;
  lastX = x; lastY = y;
  const {nx,ny} = toNorm(x,y);
  activeStroke = { tool:currentTool, color:currentColor, size:currentSize, points:[{nx,ny}] };
  localStrokes.push(activeStroke);
  if (localStrokes.length > 300) localStrokes.shift();
  haptic();
  peer?.send({ type:'stroke:start', id:currentId, tool:currentTool, color:currentColor, size:currentSize, nx, ny });
}

function onTouchMove(e) {
  e.preventDefault();
  if (e.touches.length >= 2) { handlePinch(e.touches); return; }
  const t = e.touches[0]; if (isPalm(t)) return;
  if (isPanMode) {
    const sens = getPrefs().panSensitivity || 1;
    vpX -= (t.clientX - lastPanX) / vpZ * sens;
    vpY -= (t.clientY - lastPanY) / vpZ * sens;
    lastPanX = t.clientX; lastPanY = t.clientY;
    handlePanZoom(); return;
  }
  if (!isDrawing) return;
  const {x,y} = getPos(t);
  const {nx,ny} = toNorm(x,y);
  const prev = activeStroke?.points[activeStroke.points.length-1];
  activeStroke?.points.push({nx,ny});
  if (prev && activeStroke) drawSegmentIncremental(activeStroke, prev, {nx,ny});
  lastX = x; lastY = y;
  peer?.send({ type:'stroke:move', id:currentId, nx, ny });
}

function onTouchEnd(e) {
  e.preventDefault();
  lastPinchDist = null; lastPanX = null; lastPanY = null;
  if (!isDrawing) return;
  isDrawing = false; endStroke();
}

function endStroke() {
  activeStroke = null;
  peer?.send({ type:'stroke:end', id:currentId });
}

function handlePinch(touches) {
  const dist = pinchDist(touches), mid = pinchMid(touches);
  if (!zoomLocked && lastPinchDist !== null) {
    const sc = dist / lastPinchDist, prevZ = vpZ;
    vpZ = Math.min(Math.max(0.2, vpZ * sc), 12.0);
    const r  = mobileCanvas.getBoundingClientRect();
    const fx = mid.x - r.left, fy = mid.y - r.top;
    vpX += fx/prevZ - fx/vpZ; vpY += fy/prevZ - fy/vpZ;
  }
  if (lastPanX !== null) {
    const sens = getPrefs().panSensitivity || 1;
    vpX -= (mid.x - lastPanX) / vpZ * sens;
    vpY -= (mid.y - lastPanY) / vpZ * sens;
  }
  lastPinchDist = dist; lastPanX = mid.x; lastPanY = mid.y;
  handlePanZoom();
}

function haptic() {
  if (getPrefs().haptic && navigator.vibrate) navigator.vibrate(8);
}
