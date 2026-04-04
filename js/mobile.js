/**
 * mobile.js v5 — Controller do celular
 * ──────────────────────────────────────
 * CORREÇÕES:
 *  #1  clampViewport robusto — zoom mínimo, resize de viewport, troca de PDF
 *  #3  resize do viewport via toque (handles nos cantos)
 *  #4  slider de espessura contínuo (1–100)
 *  #5  fundo xadrez (checkerboard)
 *  #6  "Desgrudar" — syncScroll independente do viewport
 *  #10 bidirecionalidade: traços do PC aparecem no celular
 *  #11 borracha não apaga fundo — usa canvas de overlay separado
 */

import { DigiPeer, ConnState } from './webrtc.js';
import { toast }               from './toast.js';
import { applyTheme, getTheme, setTheme, getPrefs, setPref } from './store.js';

const $ = id => document.getElementById(id);

// ── Canvas ───────────────────────────────────────────────────────────────
// CAMADAS (de baixo pra cima):
//  bgCanvas      — fundo (checkerboard / sólido)
//  thumbCanvas   — miniatura do PDF
//  remoteCanvas  — traços do PC (overlay do celular)   [Bug #10]
//  gridCanvasMob — grade de referência
//  mobileCanvas  — traços do celular + interface
const bgCanvas     = $('bg-canvas');
const thumbCanvas  = $('thumb-canvas');
const remoteCanvasMob = $('remote-canvas-mob'); // Bug #10
const gridCanvasMob= $('grid-canvas-mob');
const mobileCanvas = $('mobile-canvas');

const screenConnect = $('screen-connect');
const screenDraw    = $('screen-draw');

let peer = null;
let bgCtx = null, thumbCtx = null, remCtx = null, gCtx = null, ctx = null;
let canvasW = 0, canvasH = 0;

// ── Viewport ──────────────────────────────────────────────────────────────
let vpX = 0, vpY = 0, vpZ = 1.0;
let pdfDocW = 1000, pdfDocH = 1414;
let zoomLocked = false;
// Tamanho normalizado do viewport (controlável pelo PC via resize)
let vpNW = 1.0, vpNH = 1.0; // porção do doc visível

// ── Fundo ──────────────────────────────────────────────────────────────────
let pdfThumb   = null;
let bgMode     = getPrefs().bgMode || 'pdf';
let gridEnabled = getPrefs().gridEnabled || false;

// ── Ferramentas ────────────────────────────────────────────────────────────
const TOOLS = {
  pen:         { opacity:1.0,  widthMul:1,  blend:'source-over'    },
  marker:      { opacity:1.0,  widthMul:2,  blend:'source-over'    },
  highlighter: { opacity:0.35, widthMul:6,  blend:'source-over'    },
  eraser:      { opacity:1.0,  widthMul:5,  blend:'destination-out'},
};
let currentTool  = 'pen';
let currentColor = '#e63946';
let currentSize  = 3;   // px lógico
let isPanMode    = false;
let palmReject   = getPrefs().palmReject ?? true;

// ── Stroke ─────────────────────────────────────────────────────────────────
let isDrawing = false, strokeId = 0, currentId = null;

// ── Gestos ─────────────────────────────────────────────────────────────────
let lastPinchDist = null, lastPanX = null, lastPanY = null;

// ── Histórico local ─────────────────────────────────────────────────────────
const localStrokes   = [];
const remoteStrokes  = {}; // strokes em andamento do PC
const remoteHistory  = []; // histórico para undo remoto
let   activeStroke   = null;

// ── Resize do viewport (#3) ────────────────────────────────────────────────
let isResizeMode  = false;
let resizeCorner  = null; // 'br' | null
let resizeDrag    = { active:false, startX:0, startY:0, startW:0, startH:0 };

// ── Broadcast timer ────────────────────────────────────────────────────────
let _vpTimer = null;

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

applyTheme();

// ══════════════════════════════════════════════════════════════════════════
// CANVAS RESIZE
// ══════════════════════════════════════════════════════════════════════════

function resizeCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const hud  = $('mobile-hud');
  const bar  = $('mobile-toolbar');
  const hudH = hud?.offsetHeight ?? 52;
  const barH = bar?.offsetHeight ?? 100;
  canvasW = window.innerWidth;
  canvasH = window.innerHeight - hudH - barH;

  [bgCanvas, thumbCanvas, remoteCanvasMob, gridCanvasMob, mobileCanvas].forEach(c => {
    if (!c) return;
    c.width  = canvasW * dpr; c.height = canvasH * dpr;
    c.style.width  = canvasW + 'px'; c.style.height = canvasH + 'px';
    c.style.top    = hudH + 'px';
  });

  bgCtx    = bgCanvas?.getContext('2d');
  thumbCtx = thumbCanvas?.getContext('2d');
  remCtx   = remoteCanvasMob?.getContext('2d');
  gCtx     = gridCanvasMob?.getContext('2d');
  ctx      = mobileCanvas?.getContext('2d');

  const applyDpr = c => c?.setTransform(dpr, 0, 0, dpr, 0, 0);
  [bgCtx, thumbCtx, remCtx, gCtx, ctx].forEach(applyDpr);
  if (ctx) { ctx.lineCap = 'round'; ctx.lineJoin = 'round'; }

  redrawAll();
}

window.addEventListener('resize', () => {
  if (screenDraw.classList.contains('active')) resizeCanvas();
});

// ══════════════════════════════════════════════════════════════════════════
// CLAMP DE VIEWPORT — Bug #1
// ══════════════════════════════════════════════════════════════════════════

function clampViewport() {
  // Zoom mínimo: garante que pelo menos 10% do doc seja visível
  const minZ = Math.max(0.05,
    Math.min(canvasW / pdfDocW, canvasH / pdfDocH) * 0.1
  );
  vpZ = Math.max(minZ, Math.min(12.0, vpZ));

  // Viewport visível em px do documento
  const visW = canvasW / vpZ;
  const visH = canvasH / vpZ;

  // Se a tela é maior que o doc, ancora no início (sem scroll negativo)
  if (visW >= pdfDocW) {
    vpX = 0;
  } else {
    vpX = Math.max(0, Math.min(vpX, pdfDocW - visW));
  }
  if (visH >= pdfDocH) {
    vpY = 0;
  } else {
    vpY = Math.max(0, Math.min(vpY, pdfDocH - visH));
  }
}

// Atualiza vpNW/vpNH a partir do vpZ atual
function syncViewportNorm() {
  vpNW = Math.min(1, canvasW / (vpZ * pdfDocW));
  vpNH = Math.min(1, canvasH / (vpZ * pdfDocH));
}

// ══════════════════════════════════════════════════════════════════════════
// COORDENADAS
// ══════════════════════════════════════════════════════════════════════════

function toNorm(cx, cy)   { return { nx: (vpX + cx/vpZ) / pdfDocW, ny: (vpY + cy/vpZ) / pdfDocH }; }
function fromNorm(nx, ny) { return { x: (nx*pdfDocW - vpX)*vpZ,    y: (ny*pdfDocH - vpY)*vpZ    }; }

// ══════════════════════════════════════════════════════════════════════════
// REDRAW
// ══════════════════════════════════════════════════════════════════════════

function redrawAll() {
  drawBackground();
  drawThumb();
  redrawRemoteStrokes(); // Bug #10
  drawGridLayer();
  redrawLocalStrokes();
  if (isResizeMode) drawResizeHandles();
}

// Fundo sólido / checkerboard (#5) — bgCanvas
function drawBackground() {
  if (!bgCtx) return;
  bgCtx.clearRect(0, 0, canvasW, canvasH);
  if (bgMode === 'checkerboard') {
    const sz = 12, c1 = '#ccc', c2 = '#fff';
    for (let y = 0; y < canvasH; y += sz) {
      for (let x = 0; x < canvasW; x += sz) {
        bgCtx.fillStyle = ((x/sz + y/sz) % 2 === 0) ? c1 : c2;
        bgCtx.fillRect(x, y, sz, sz);
      }
    }
  } else if (bgMode === 'light')   { bgCtx.fillStyle='#f8f8f5'; bgCtx.fillRect(0,0,canvasW,canvasH); }
  else if (bgMode === 'amoled')    { bgCtx.fillStyle='#000';    bgCtx.fillRect(0,0,canvasW,canvasH); }
  else { // dark (default)
    bgCtx.fillStyle='#1a1a2e'; bgCtx.fillRect(0,0,canvasW,canvasH);
  }
}

// Miniatura do PDF — thumbCanvas
function drawThumb() {
  if (!thumbCtx) return;
  thumbCtx.clearRect(0, 0, canvasW, canvasH);
  if (bgMode === 'pdf' && pdfThumb) {
    thumbCtx.drawImage(pdfThumb, -vpX*vpZ, -vpY*vpZ, pdfDocW*vpZ, pdfDocH*vpZ);
  }
}

// Grade — gridCanvasMob
function drawGridLayer() {
  if (!gCtx) return;
  gCtx.clearRect(0, 0, canvasW, canvasH);
  if (!gridEnabled) return;
  const step = 40 * vpZ;
  const offX = (-vpX*vpZ) % step, offY = (-vpY*vpZ) % step;
  gCtx.strokeStyle = 'rgba(124,106,247,0.2)'; gCtx.lineWidth = 0.5;
  for (let x = offX; x < canvasW; x += step) { gCtx.beginPath(); gCtx.moveTo(x,0); gCtx.lineTo(x,canvasH); gCtx.stroke(); }
  for (let y = offY; y < canvasH; y += step) { gCtx.beginPath(); gCtx.moveTo(0,y); gCtx.lineTo(canvasW,y); gCtx.stroke(); }
}

// Traços remotos (PC) — remoteCanvasMob  [Bug #10]
function redrawRemoteStrokes() {
  if (!remCtx) return;
  remCtx.clearRect(0, 0, canvasW, canvasH);
  const dpr = window.devicePixelRatio || 1;
  for (const s of remoteHistory) drawFullStrokeOnCtx(remCtx, s, dpr, true);
}

// Traços locais — mobileCanvas
function redrawLocalStrokes() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvasW, canvasH);
  const dpr = window.devicePixelRatio || 1;
  for (const s of localStrokes) drawFullStrokeOnCtx(ctx, s, dpr, false);
}

function drawFullStrokeOnCtx(c, s, dpr, isRemote) {
  if (!s.points.length) return;
  const t = TOOLS[s.tool] || TOOLS.pen;
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';
  // Bug #11: eraser usa destination-out somente no canvas de overlay
  // não toca em bgCanvas ou thumbCanvas
  c.globalCompositeOperation = t.blend;
  c.globalAlpha = t.opacity;
  c.strokeStyle = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
  c.fillStyle   = c.strokeStyle;
  c.lineWidth   = s.size * t.widthMul * vpZ * dpr;

  if (s.points.length === 1) {
    const p = fromNorm(s.points[0].nx, s.points[0].ny);
    c.beginPath(); c.arc(p.x*dpr, p.y*dpr, Math.max(1, c.lineWidth/2), 0, Math.PI*2); c.fill();
  } else {
    c.beginPath();
    const p0 = fromNorm(s.points[0].nx, s.points[0].ny);
    c.moveTo(p0.x*dpr, p0.y*dpr);
    for (let i = 1; i < s.points.length; i++) {
      const p = fromNorm(s.points[i].nx, s.points[i].ny);
      c.lineTo(p.x*dpr, p.y*dpr);
    }
    c.stroke();
  }
  c.restore();
}

function drawSegmentIncremental(stroke, prevPt, currPt) {
  if (!ctx) return;
  const a = fromNorm(prevPt.nx, prevPt.ny);
  const b = fromNorm(currPt.nx, currPt.ny);
  const dpr = window.devicePixelRatio || 1;
  const t = TOOLS[stroke.tool] || TOOLS.pen;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = t.blend;
  ctx.globalAlpha = t.opacity;
  ctx.strokeStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : stroke.color;
  ctx.lineWidth   = stroke.size * t.widthMul * vpZ * dpr;
  ctx.beginPath(); ctx.moveTo(a.x*dpr, a.y*dpr); ctx.lineTo(b.x*dpr, b.y*dpr); ctx.stroke();
  ctx.restore();
}

// Handles de resize (#3)
function drawResizeHandles() {
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const visW = canvasW / vpZ, visH = canvasH / vpZ;
  // corner handle bottom-right
  const px = (pdfDocW - vpX) * vpZ * dpr;
  const py = (pdfDocH - vpY) * vpZ * dpr;
  ctx.save();
  ctx.fillStyle = 'rgba(124,106,247,0.9)';
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * dpr;
  const sz = 14 * dpr;
  ctx.fillRect(Math.min(canvasW*dpr - sz, px) - sz/2, Math.min(canvasH*dpr - sz, py) - sz/2, sz, sz);
  ctx.strokeRect(Math.min(canvasW*dpr - sz, px) - sz/2, Math.min(canvasH*dpr - sz, py) - sz/2, sz, sz);
  ctx.restore();
}

function handlePanZoom() {
  clampViewport();
  syncViewportNorm();
  redrawAll();
}

// ══════════════════════════════════════════════════════════════════════════
// VIEWPORT BROADCAST
// ══════════════════════════════════════════════════════════════════════════

function startViewportBroadcast() {
  if (_vpTimer) return;
  _vpTimer = setInterval(() => {
    if (peer?.state !== ConnState.CONNECTED) return;
    peer.send({
      type:'viewport',
      nx: vpX / pdfDocW, ny: vpY / pdfDocH,
      nw: Math.min(1, canvasW / (vpZ * pdfDocW)),
      nh: Math.min(1, canvasH / (vpZ * pdfDocH)),
      zoom: vpZ, locked: zoomLocked,
    });
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

const getCode   = () => codeChars.map(i => i.value).join('');
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
  setStatus('connecting','Conectando…'); $('btn-connect').disabled = true;
  peer = new DigiPeer({ role:'guest', code, onStateChange:handleStateChange, onMessage:handleMessage });
  try { await peer.startAsGuest(); }
  catch (err) { setStatus('error', err.message.split('\n')[0]); $('btn-connect').disabled = false; }
});

function handleStateChange(state) {
  if (state === ConnState.CONNECTED) {
    setStatus('success','Conectado!'); setTimeout(showDrawScreen, 500);
  } else if (state === ConnState.DISCONNECTED) {
    const st = $('mobile-status-text'); if (st) st.textContent = 'Desconectado';
    $('mobile-status-dot')?.classList.replace('connected','disconnected');
    if (screenDraw.classList.contains('active')) {
      toast('Conexão perdida','error');
      setTimeout(() => {
        screenDraw.classList.remove('active'); screenDraw.style.display = '';
        screenConnect.classList.add('active'); $('btn-connect').disabled = false; setStatus('','');
      }, 1500);
    }
  } else if (state === ConnState.ERROR) {
    setStatus('error','Falha na conexão'); $('btn-connect').disabled = false;
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;
  switch (msg.type) {
    // Bug #10: traços do PC aparecem no celular
    case 'stroke:start': {
      const s = { tool:msg.tool, color:msg.color, size:msg.size, lastNX:msg.nx, lastNY:msg.ny, points:[{nx:msg.nx, ny:msg.ny}] };
      remoteStrokes[msg.id] = s;
      remoteHistory.push(s);
      if (remoteHistory.length > 80) remoteHistory.shift();
      // Desenha ponto inicial no remCtx
      if (remCtx) {
        const dpr = window.devicePixelRatio||1, t = TOOLS[msg.tool]||TOOLS.pen;
        const p = fromNorm(msg.nx, msg.ny);
        remCtx.save();
        remCtx.globalCompositeOperation = t.blend; remCtx.globalAlpha = t.opacity;
        remCtx.fillStyle = msg.tool === 'eraser' ? 'rgba(0,0,0,1)' : msg.color;
        remCtx.lineWidth = msg.size * t.widthMul * vpZ * dpr;
        remCtx.beginPath(); remCtx.arc(p.x*dpr, p.y*dpr, Math.max(1,remCtx.lineWidth/2), 0, Math.PI*2); remCtx.fill();
        remCtx.restore();
      }
      break;
    }
    case 'stroke:move': {
      const s = remoteStrokes[msg.id]; if (!s) break;
      const prev = {nx:s.lastNX, ny:s.lastNY};
      s.points.push({nx:msg.nx, ny:msg.ny});
      // Desenha segmento incremental no remCtx
      if (remCtx) {
        const a = fromNorm(prev.nx, prev.ny), b = fromNorm(msg.nx, msg.ny);
        const dpr = window.devicePixelRatio||1, t = TOOLS[s.tool]||TOOLS.pen;
        remCtx.save();
        remCtx.lineCap='round'; remCtx.lineJoin='round';
        remCtx.globalCompositeOperation=t.blend; remCtx.globalAlpha=t.opacity;
        remCtx.strokeStyle = s.tool==='eraser'?'rgba(0,0,0,1)':s.color;
        remCtx.lineWidth = s.size * t.widthMul * vpZ * dpr;
        remCtx.beginPath(); remCtx.moveTo(a.x*dpr,a.y*dpr); remCtx.lineTo(b.x*dpr,b.y*dpr); remCtx.stroke();
        remCtx.restore();
      }
      s.lastNX = msg.nx; s.lastNY = msg.ny;
      break;
    }
    case 'stroke:end': delete remoteStrokes[msg.id]; break;

    // Limpar (#9 + #10)
    case 'clear:all':
      localStrokes.length = 0; remoteHistory.length = 0;
      Object.keys(remoteStrokes).forEach(k => delete remoteStrokes[k]);
      activeStroke = null; redrawAll(); break;
    case 'clear:local': // PC pediu que celular limpe os PRÓPRIOS traços
      localStrokes.length = 0; activeStroke = null; redrawLocalStrokes(); break;
    case 'clear:remote': // PC limpou os traços remotos (do celular no PC)
      toast('PC limpou traços remotos','info',1500); break;
    case 'clear': // legado
      localStrokes.length = 0; remoteHistory.length = 0; activeStroke = null; redrawAll(); break;

    // Undo do PC (#10): remove o último stroke do histórico remoto e redesenha
    case 'undo':
      if (remoteHistory.length) { remoteHistory.pop(); redrawRemoteStrokes(); }
      toast('↩ PC desfez','info',1200); break;
    case 'redo':
      toast('↪ PC refez','info',1200); break;

    case 'pdf:size':
      pdfDocW = msg.w; pdfDocH = msg.h;
      vpX = 0; vpY = 0; vpZ = 1;
      clampViewport(); syncViewportNorm(); handlePanZoom(); break;
    case 'pdf:thumb': loadThumb(msg.data); break;

    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        zoomLocked = msg.zoomLocked;
        const el = $('toggle-zoom-lock'); if (el) el.checked = zoomLocked;
        toast(zoomLocked ? '🔒 Zoom travado' : '🔓 Zoom liberado','info');
      }
      if (typeof msg.gridEnabled === 'boolean') {
        gridEnabled = msg.gridEnabled;
        const el = $('toggle-grid-mob'); if (el) el.checked = gridEnabled;
        drawGridLayer();
      }
      break;

    case 'viewport:set': // PC moveu a caixa
      vpX = msg.nx * pdfDocW; vpY = msg.ny * pdfDocH;
      clampViewport(); handlePanZoom(); break;

    case 'viewport:resize': // PC redimensionou a caixa (#3)
      // Ajusta vpZ para que a visão corresponda ao novo tamanho normalizado
      if (msg.nw > 0 && msg.nh > 0) {
        const zFromW = canvasW / (msg.nw * pdfDocW);
        const zFromH = canvasH / (msg.nh * pdfDocH);
        if (!zoomLocked) {
          vpZ = Math.min(zFromW, zFromH);
          clampViewport(); handlePanZoom();
        }
      }
      break;
  }
}

function loadThumb(dataUrl) {
  const img = new Image();
  img.onload = () => { pdfThumb = img; if (bgMode === 'pdf') { drawThumb(); redrawLocalStrokes(); } };
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
  peer?.send({ type:'request:pdf' });
  resizeCanvas(); bindDrawEvents(); startViewportBroadcast();
  applyMenuPrefs();
}

function applyMenuPrefs() {
  const prefs = getPrefs();
  const bgSel = $('bg-select'); if (bgSel) bgSel.value = prefs.bgMode || 'pdf';
  const slider = $('size-slider'); if (slider) { slider.value = prefs.size || 3; updateSizeLabel(prefs.size || 3); }
  const ps = $('pan-sensitivity'); if (ps) ps.value = prefs.panSensitivity || 1;
  const hp = $('toggle-haptic'); if (hp) hp.checked = prefs.haptic ?? true;
  const pl = $('toggle-palm'); if (pl) pl.checked = prefs.palmReject ?? true;
}

// ══════════════════════════════════════════════════════════════════════════
// TOOLBAR — ferramentas, cores, espessura slider (#4)
// ══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.mob-tool[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tool === 'pan') {
      isPanMode = !isPanMode;
      btn.classList.toggle('active', isPanMode);
      document.querySelectorAll('.mob-tool[data-tool]:not([data-tool="pan"])').forEach(b => {
        b.classList.toggle('active', !isPanMode && b.dataset.tool === currentTool);
      });
      const ml = $('mobile-mode-label'); if (ml) ml.textContent = isPanMode ? 'Navegar' : 'Desenho';
      return;
    }
    isPanMode = false;
    document.querySelector('.mob-tool[data-tool="pan"]')?.classList.remove('active');
    document.querySelectorAll('.mob-tool[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); currentTool = btn.dataset.tool;
    const ml = $('mobile-mode-label'); if (ml) ml.textContent = 'Desenho';
  });
});

document.querySelectorAll('.quick-color').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quick-color').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); currentColor = btn.dataset.color;
    const inp = $('mob-color'); if (inp) inp.value = currentColor;
  });
});
$('mob-color')?.addEventListener('input', e => {
  currentColor = e.target.value;
  document.querySelectorAll('.quick-color').forEach(b => b.classList.remove('active'));
});

// Slider contínuo de espessura (#4)
function updateSizeLabel(v) {
  const lbl = $('size-slider-label'); if (lbl) lbl.textContent = v;
  const dot = $('size-preview-dot');
  if (dot) { const px = Math.min(48, Math.max(2, v)); dot.style.width = px+'px'; dot.style.height = px+'px'; }
}
$('size-slider')?.addEventListener('input', e => {
  currentSize = parseInt(e.target.value);
  updateSizeLabel(currentSize); setPref('size', currentSize);
});

// Undo / Clear
$('btn-mob-undo')?.addEventListener('click', () => {
  if (localStrokes.length) { localStrokes.pop(); redrawLocalStrokes(); peer?.send({ type:'undo' }); }
});
$('btn-mob-clear')?.addEventListener('click', () => {
  localStrokes.length = 0; activeStroke = null; redrawLocalStrokes();
  peer?.send({ type:'clear:local' }); // limpa só os traços do celular no PC
});

// Disconnect
$('btn-mob-disconnect')?.addEventListener('click', async () => {
  clearInterval(_vpTimer); _vpTimer = null;
  await peer?.disconnect();
  screenDraw.classList.remove('active'); screenDraw.style.display = '';
  screenConnect.classList.add('active');
  codeChars.forEach(i => { i.value = ''; i.classList.remove('filled'); });
  checkCode(); setStatus('',''); localStrokes.length = 0;
});

// Menu lateral
$('btn-mobile-menu')?.addEventListener('click', () => { const m=$('mobile-menu'); m?.classList.remove('hidden'); });
$('btn-close-menu')?.addEventListener('click',  () => { const m=$('mobile-menu'); m?.classList.add('hidden'); });

// Toggles do menu
$('toggle-zoom-lock')?.addEventListener('change', e => {
  zoomLocked = e.target.checked; setPref('zoomLocked', zoomLocked);
  peer?.send({ type:'state:sync', zoomLocked }); toast(zoomLocked?'🔒 Zoom travado':'🔓 Zoom liberado','info');
});
$('toggle-grid-mob')?.addEventListener('change', e => { gridEnabled=e.target.checked; setPref('gridEnabled',gridEnabled); drawGridLayer(); });
$('toggle-palm')?.addEventListener('change', e => { palmReject=e.target.checked; setPref('palmReject',palmReject); });
$('toggle-haptic')?.addEventListener('change', e => setPref('haptic', e.target.checked));
$('pan-sensitivity')?.addEventListener('input', e => setPref('panSensitivity', parseFloat(e.target.value)));
$('bg-select')?.addEventListener('change', e => { bgMode=e.target.value; setPref('bgMode',bgMode); redrawAll(); });

// Temas
document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.themeBtn);
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.toggle('active', b===btn));
    toast('Tema: '+btn.dataset.themeBtn,'info');
  });
});

// Botão de resize mode (#3)
$('btn-resize-mode')?.addEventListener('click', () => {
  isResizeMode = !isResizeMode;
  $('btn-resize-mode')?.classList.toggle('active', isResizeMode);
  toast(isResizeMode ? '📐 Modo resize ativo — arraste o canto' : 'Resize desativado','info');
  if (!isResizeMode) redrawLocalStrokes(); else redrawAll();
});

// ══════════════════════════════════════════════════════════════════════════
// TOUCH EVENTS
// ══════════════════════════════════════════════════════════════════════════

function bindDrawEvents() {
  mobileCanvas.addEventListener('touchstart',  onTouchStart, { passive:false });
  mobileCanvas.addEventListener('touchmove',   onTouchMove,  { passive:false });
  mobileCanvas.addEventListener('touchend',    onTouchEnd,   { passive:false });
  mobileCanvas.addEventListener('touchcancel', onTouchEnd,   { passive:false });
}

const getPos    = t => { const r = mobileCanvas.getBoundingClientRect(); return { x:t.clientX-r.left, y:t.clientY-r.top }; };
const isPalm    = t => palmReject && (t.radiusX > 30 || t.radiusY > 30);
const pinchDist = ts => Math.hypot(ts[0].clientX-ts[1].clientX, ts[0].clientY-ts[1].clientY);
const pinchMid  = ts => ({ x:(ts[0].clientX+ts[1].clientX)/2, y:(ts[0].clientY+ts[1].clientY)/2 });

function onTouchStart(e) {
  e.preventDefault();
  if (e.touches.length >= 2) {
    if (isDrawing) { isDrawing = false; endStroke(); }
    lastPinchDist = pinchDist(e.touches);
    const m = pinchMid(e.touches); lastPanX=m.x; lastPanY=m.y;
    return;
  }
  const t = e.touches[0]; if (isPalm(t)) return;
  const {x,y} = getPos(t);

  // Handle de resize (#3): canto inferior direito
  if (isResizeMode) {
    const dpr = window.devicePixelRatio||1;
    const bx = Math.min(canvasW - 14, (pdfDocW - vpX)*vpZ) - 7;
    const by = Math.min(canvasH - 14, (pdfDocH - vpY)*vpZ) - 7;
    if (Math.abs(x - bx) < 20 && Math.abs(y - by) < 20) {
      resizeDrag = { active:true, startX:x, startY:y, startW:canvasW/vpZ, startH:canvasH/vpZ };
      return;
    }
  }

  if (isPanMode) { lastPanX=t.clientX; lastPanY=t.clientY; return; }

  isDrawing = true; strokeId++; currentId = `m${strokeId}`;
  const {nx,ny} = toNorm(x,y);
  activeStroke = { tool:currentTool, color:currentColor, size:currentSize, points:[{nx,ny}] };
  localStrokes.push(activeStroke);
  if (localStrokes.length > 400) localStrokes.shift();
  haptic();
  peer?.send({ type:'stroke:start', id:currentId, tool:currentTool, color:currentColor, size:currentSize, nx, ny });
}

function onTouchMove(e) {
  e.preventDefault();
  if (e.touches.length >= 2) { handlePinch(e.touches); return; }
  const t = e.touches[0]; if (isPalm(t)) return;
  const {x,y} = getPos(t);

  if (resizeDrag.active) {
    const dw = x - resizeDrag.startX, dh = y - resizeDrag.startY;
    const newVisW = Math.max(100, resizeDrag.startW + dw);
    const newVisH = Math.max(100, resizeDrag.startH + dh);
    const zFromW = canvasW / newVisW;
    const zFromH = canvasH / newVisH;
    if (!zoomLocked) {
      vpZ = Math.min(zFromW, zFromH);
      clampViewport(); syncViewportNorm(); redrawAll();
      peer?.send({ type:'viewport:resize', nw: Math.min(1,canvasW/(vpZ*pdfDocW)), nh: Math.min(1,canvasH/(vpZ*pdfDocH)) });
    }
    return;
  }

  if (isPanMode) {
    const sens = getPrefs().panSensitivity || 1;
    vpX -= (t.clientX-lastPanX)/vpZ*sens; vpY -= (t.clientY-lastPanY)/vpZ*sens;
    lastPanX=t.clientX; lastPanY=t.clientY;
    handlePanZoom(); return;
  }
  if (!isDrawing) return;
  const {nx,ny} = toNorm(x,y);
  const prev = activeStroke?.points[activeStroke.points.length-1];
  activeStroke?.points.push({nx,ny});
  if (prev && activeStroke) drawSegmentIncremental(activeStroke, prev, {nx,ny});
  peer?.send({ type:'stroke:move', id:currentId, nx, ny });
}

function onTouchEnd(e) {
  e.preventDefault();
  lastPinchDist=null; lastPanX=null; lastPanY=null;
  if (resizeDrag.active) { resizeDrag.active=false; return; }
  if (!isDrawing) return;
  isDrawing=false; endStroke();
}

function endStroke() {
  activeStroke=null;
  peer?.send({ type:'stroke:end', id:currentId });
}

// Bug #1: zoom centrado no ponto médio dos dedos
function handlePinch(touches) {
  const dist = pinchDist(touches), mid = pinchMid(touches);
  if (!zoomLocked && lastPinchDist !== null) {
    const sc = dist / lastPinchDist, prevZ = vpZ;
    const newZ = Math.min(12.0, Math.max(0.05, vpZ * sc));
    // Zoom centrado no midpoint
    const r  = mobileCanvas.getBoundingClientRect();
    const fx = mid.x - r.left, fy = mid.y - r.top;
    vpX += fx/prevZ - fx/newZ;
    vpY += fy/prevZ - fy/newZ;
    vpZ = newZ;
  }
  if (lastPanX !== null) {
    const sens = getPrefs().panSensitivity || 1;
    vpX -= (mid.x-lastPanX)/vpZ*sens; vpY -= (mid.y-lastPanY)/vpZ*sens;
  }
  lastPinchDist=dist; lastPanX=mid.x; lastPanY=mid.y;
  handlePanZoom();
}

function haptic() {
  if (getPrefs().haptic && navigator.vibrate) navigator.vibrate(8);
}
