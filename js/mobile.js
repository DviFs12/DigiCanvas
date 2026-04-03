/**
 * mobile.js  (v3 — coordenadas normalizadas)
 * ────────────────────────────────────────────
 * ARQUITETURA DE COORDENADAS:
 *
 *  Tudo que sai do celular viaja em coordenadas NORMALIZADAS (0–1)
 *  relativas ao tamanho do documento PDF (não à tela).
 *
 *    normX = (vpX + canvasX / vpZ) / pdfDocW
 *    normY = (vpY + canvasY / vpZ) / pdfDocH
 *
 *  O desktop recebe coordenadas normalizadas e converte para px do canvas:
 *    pxX = normX * pdfCanvas.width
 *    pxY = normY * pdfCanvas.height
 *
 *  Isso garante que os traços ficam fixos no PDF independente de zoom
 *  ou resolução de tela em qualquer dispositivo.
 *
 *  O viewport também é enviado normalizado:
 *    { x: vpX/pdfW, y: vpY/pdfH, w: visibleW/pdfW, h: visibleH/pdfH }
 *
 * FUNDO DO CANVAS:
 *  O canvas exibe uma miniatura (thumbnail) do PDF atual recebida do
 *  desktop via mensagem 'pdf:thumb', renderizada como fundo.
 *  O usuário pode alternar entre fundo escuro, claro ou PDF.
 */

import { DigiPeer, ConnState } from './webrtc.js';
import { toast } from './toast.js';

// ── DOM ────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const screenConnect    = $('screen-connect');
const screenDraw       = $('screen-draw');
const codeChars        = [...document.querySelectorAll('.code-char')];
const btnConnect       = $('btn-connect');
const connectStatus    = $('connect-status');
const connectMsg       = $('connect-msg');
const mobileCanvas     = $('mobile-canvas');
const mobileDot        = $('mobile-status-dot');
const mobileStatusText = $('mobile-status-text');
const modeLabel        = $('mobile-mode-label');
const btnPanMode       = $('btn-pan-mode');
const mobColor         = $('mob-color');
const btnMobUndo       = $('btn-mob-undo');
const btnMobClear      = $('btn-mob-clear');
const btnMobDisconnect = $('btn-mob-disconnect');
const btnMobileMenu    = $('btn-mobile-menu');
const btnCloseMenu     = $('btn-close-menu');
const mobileMenu       = $('mobile-menu');
const toggleHaptic     = $('toggle-haptic');
const togglePalm       = $('toggle-palm');
const panSensitivity   = $('pan-sensitivity');
const toggleZoomLock   = $('toggle-zoom-lock');
const bgSelect         = $('bg-select');

// ── Estado de conexão ──────────────────────────────────────────────────────

let peer = null;

// ── Estado do canvas ───────────────────────────────────────────────────────

let ctx        = null;
let canvasW    = 0;   // largura CSS do canvas
let canvasH    = 0;   // altura CSS do canvas

// ── Viewport — posição e zoom sobre o documento PDF ───────────────────────
// vpX, vpY = canto superior esquerdo do viewport em px do espaço do documento
// vpZ      = fator de zoom (1 = 1px tela = 1px doc; 2 = tela é 2× mais detalhada)
// pdfDocW, pdfDocH = dimensões do documento em px (recebidas do desktop)

let vpX     = 0;
let vpY     = 0;
let vpZ     = 1.0;
let pdfDocW = 1000;   // valor padrão até o desktop enviar o tamanho real
let pdfDocH = 1414;
let zoomLocked  = false;  // travar zoom (sincronizado com desktop)

// ── Thumbnail do PDF (fundo do canvas) ────────────────────────────────────

let pdfThumb     = null;   // HTMLImageElement com a miniatura
let bgMode       = 'pdf';  // 'pdf' | 'dark' | 'light' | 'grid'

// ── Ferramentas de desenho ─────────────────────────────────────────────────

let currentTool  = 'pen';
let currentColor = '#e63946';
let currentSize  = 2;
let isPanMode    = false;
let palmReject   = true;

// ── Stroke em andamento ────────────────────────────────────────────────────

let isDrawing  = false;
let strokeId   = 0;
let currentId  = null;
let lastX      = 0;   // px CSS canvas
let lastY      = 0;

// Histórico de snapshots para undo local (o undo remoto envia msg separada)
const history  = [];
const MAX_HIST = 20;

// ── Gestos de dois dedos ───────────────────────────────────────────────────

let lastPinchDist = null;
let lastPanX      = null;
let lastPanY      = null;

// ── Fundo ──────────────────────────────────────────────────────────────────

const BG_STYLES = {
  pdf:   null,              // usa pdfThumb
  dark:  '#1a1a2e',
  light: '#f5f5f0',
  grid:  '__grid__',
};

// ══════════════════════════════════════════════════════════════════════════
// CANVAS
// ══════════════════════════════════════════════════════════════════════════

function resizeCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const hud  = $('mobile-hud');
  const bar  = $('mobile-toolbar');
  const hudH = hud?.offsetHeight ?? 52;
  const barH = bar?.offsetHeight ?? 110;

  canvasW = window.innerWidth;
  canvasH = window.innerHeight - hudH - barH;

  mobileCanvas.width  = canvasW * dpr;
  mobileCanvas.height = canvasH * dpr;
  mobileCanvas.style.width  = canvasW + 'px';
  mobileCanvas.style.height = canvasH + 'px';
  mobileCanvas.style.top    = hudH + 'px';

  ctx = mobileCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  redrawAll();
}

window.addEventListener('resize', () => {
  if (screenDraw.classList.contains('active')) resizeCanvas();
});

// ══════════════════════════════════════════════════════════════════════════
// NORMALIZAÇÃO DE COORDENADAS
// ══════════════════════════════════════════════════════════════════════════

/**
 * Converte posição CSS no canvas para coordenada normalizada (0–1)
 * no espaço do documento PDF.
 *
 *  docX = vpX + canvasX / vpZ   (px no doc)
 *  normX = docX / pdfDocW       (0–1)
 */
function toNorm(canvasX, canvasY) {
  return {
    nx: (vpX + canvasX / vpZ) / pdfDocW,
    ny: (vpY + canvasY / vpZ) / pdfDocH,
  };
}

/**
 * Converte coordenada normalizada de volta para px CSS no canvas atual.
 * Usada para re-renderizar o histórico local ao fazer pan/zoom.
 */
function fromNorm(nx, ny) {
  return {
    x: (nx * pdfDocW - vpX) * vpZ,
    y: (ny * pdfDocH - vpY) * vpZ,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// VIEWPORT — clamp e broadcast
// ══════════════════════════════════════════════════════════════════════════

/**
 * Clamp do viewport:
 *  - vpX não pode ser negativo
 *  - vpX não pode ultrapassar pdfDocW - visibleW (não rola para além do doc)
 *  - idem para vpY
 */
function clampViewport() {
  const visW = canvasW / vpZ;
  const visH = canvasH / vpZ;

  vpX = Math.max(0, Math.min(vpX, Math.max(0, pdfDocW - visW)));
  vpY = Math.max(0, Math.min(vpY, Math.max(0, pdfDocH - visH)));
}

/** Mensagem de viewport normalizada enviada ao desktop */
function buildViewportMsg() {
  const visW = canvasW / vpZ;
  const visH = canvasH / vpZ;
  return {
    type:   'viewport',
    // posição normalizada do canto superior esquerdo
    nx:     vpX / pdfDocW,
    ny:     vpY / pdfDocH,
    // tamanho normalizado da área visível
    nw:     visW / pdfDocW,
    nh:     visH / pdfDocH,
    zoom:   vpZ,
    locked: zoomLocked,
  };
}

let _vpBroadcastTimer = null;
function startViewportBroadcast() {
  if (_vpBroadcastTimer) return;
  _vpBroadcastTimer = setInterval(() => {
    if (peer?.state === ConnState.CONNECTED) {
      peer.send(buildViewportMsg());
    }
  }, 33); // ~30 fps
}

// ══════════════════════════════════════════════════════════════════════════
// FUNDO DO CANVAS
// ══════════════════════════════════════════════════════════════════════════

function redrawAll() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvasW, canvasH);
  drawBackground();
  // Os traços locais estão no canvas bitmap — re-renderizados via histórico
  // ao fazer pan/zoom (ver nota abaixo em handlePanZoom).
}

function drawBackground() {
  const mode = bgMode;

  if (mode === 'dark') {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvasW, canvasH);
    return;
  }

  if (mode === 'light') {
    ctx.fillStyle = '#f8f8f5';
    ctx.fillRect(0, 0, canvasW, canvasH);
    return;
  }

  if (mode === 'grid') {
    ctx.fillStyle = '#0d0d0f';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.strokeStyle = 'rgba(124,106,247,0.2)';
    ctx.lineWidth = 0.5;
    const step = 30;
    for (let x = 0; x < canvasW; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvasH); ctx.stroke();
    }
    for (let y = 0; y < canvasH; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasW, y); ctx.stroke();
    }
    return;
  }

  // mode === 'pdf' — renderiza miniatura do PDF como fundo com pan/zoom
  if (pdfThumb) {
    ctx.save();
    // Mapeia o doc inteiro para o canvas com offset e zoom do viewport
    const scaleX = canvasW / pdfDocW;
    const scaleY = canvasH / pdfDocH;
    // Posição e tamanho da thumb no canvas
    const destX = -vpX * vpZ;
    const destY = -vpY * vpZ;
    const destW = pdfDocW * vpZ;
    const destH = pdfDocH * vpZ;
    ctx.drawImage(pdfThumb, destX, destY, destW, destH);
    ctx.restore();
  } else {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvasW, canvasH);
    // Placeholder grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvasW; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvasH); ctx.stroke();
    }
    for (let y = 0; y < canvasH; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasW, y); ctx.stroke();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TRAÇOS LOCAIS — armazenados em coordenadas normalizadas
// ══════════════════════════════════════════════════════════════════════════
// Para o celular exibir os próprios traços corretamente ao pan/zoom,
// armazenamos cada stroke como lista de pontos normalizados e
// re-renderizamos do zero ao mudar o viewport.

const localStrokes = [];    // [{ tool, color, size, points: [{nx,ny}] }]
let   activeStroke = null;  // stroke em andamento

function startLocalStroke(canvasX, canvasY) {
  const { nx, ny } = toNorm(canvasX, canvasY);
  activeStroke = { tool: currentTool, color: currentColor, size: currentSize, points: [{ nx, ny }] };
  localStrokes.push(activeStroke);
  if (localStrokes.length > 200) localStrokes.shift(); // limite de memória
}

function continueLocalStroke(canvasX, canvasY) {
  if (!activeStroke) return;
  const { nx, ny } = toNorm(canvasX, canvasY);
  activeStroke.points.push({ nx, ny });
  // Desenha apenas o segmento novo (incremental, eficiente)
  const pts = activeStroke.points;
  drawStrokeSegment(activeStroke, pts[pts.length - 2], pts[pts.length - 1]);
}

function endLocalStroke() {
  activeStroke = null;
}

/** Re-renderiza todos os traços locais (chamado após pan/zoom) */
function redrawLocalStrokes() {
  for (const s of localStrokes) {
    drawFullStroke(s);
  }
}

function drawFullStroke(stroke) {
  if (stroke.points.length === 0) return;
  ctx.save();
  applyStrokeStyle(ctx, stroke);

  if (stroke.points.length === 1) {
    // Ponto único: círculo
    const { x, y } = fromNorm(stroke.points[0].nx, stroke.points[0].ny);
    ctx.beginPath();
    ctx.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : stroke.color;
    ctx.fill();
  } else {
    ctx.beginPath();
    const p0 = fromNorm(stroke.points[0].nx, stroke.points[0].ny);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < stroke.points.length; i++) {
      const p = fromNorm(stroke.points[i].nx, stroke.points[i].ny);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawStrokeSegment(stroke, pA, pB) {
  if (!pA || !pB) return;
  const a = fromNorm(pA.nx, pA.ny);
  const b = fromNorm(pB.nx, pB.ny);
  ctx.save();
  applyStrokeStyle(ctx, stroke);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function applyStrokeStyle(c, stroke) {
  c.lineCap  = 'round';
  c.lineJoin = 'round';
  if (stroke.tool === 'eraser') {
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = 'rgba(0,0,0,1)';
    c.lineWidth   = stroke.size * 4 * vpZ;
    c.globalAlpha = 1;
  } else {
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = stroke.color;
    c.lineWidth   = (stroke.tool === 'marker' ? stroke.size * 3 : stroke.size) * vpZ;
    c.globalAlpha = stroke.tool === 'marker' ? 0.4 : 1;
  }
}

/** Aplica pan/zoom: redesenha fundo + todos os strokes locais */
function handlePanZoom() {
  clampViewport();
  redrawAll();
  redrawLocalStrokes();
  // Redo do stroke em andamento se existir
  if (activeStroke && activeStroke.points.length > 1) {
    drawFullStroke(activeStroke);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CODE INPUT
// ══════════════════════════════════════════════════════════════════════════

codeChars.forEach((input, idx) => {
  input.addEventListener('input', e => {
    const val = e.target.value.replace(/\D/, '');
    input.value = val;
    input.classList.toggle('filled', !!val);
    if (val && idx < codeChars.length - 1) codeChars[idx + 1].focus();
    checkCodeComplete();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !input.value && idx > 0) {
      codeChars[idx - 1].focus();
      codeChars[idx - 1].value = '';
      codeChars[idx - 1].classList.remove('filled');
    }
  });
  input.addEventListener('paste', e => {
    e.preventDefault();
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    text.split('').forEach((c, i) => {
      if (codeChars[i]) { codeChars[i].value = c; codeChars[i].classList.add('filled'); }
    });
    checkCodeComplete();
  });
});

const getCode          = () => codeChars.map(i => i.value).join('');
const checkCodeComplete = () => { btnConnect.disabled = getCode().length < 6; };

// Auto-fill via URL param
;(function autoFill() {
  const code = new URLSearchParams(location.search).get('code');
  if (code && /^\d{6}$/.test(code)) {
    code.split('').forEach((c, i) => {
      if (codeChars[i]) { codeChars[i].value = c; codeChars[i].classList.add('filled'); }
    });
    checkCodeComplete();
    setTimeout(() => btnConnect.click(), 400);
  }
})();

// ══════════════════════════════════════════════════════════════════════════
// CONEXÃO
// ══════════════════════════════════════════════════════════════════════════

btnConnect.addEventListener('click', async () => {
  const code = getCode();
  if (code.length < 6) return;
  setStatus('connecting', 'Conectando...');
  btnConnect.disabled = true;

  peer = new DigiPeer({
    role: 'guest', code,
    onStateChange: handleStateChange,
    onMessage:     handleMessage,
  });
  try {
    await peer.startAsGuest();
  } catch (err) {
    setStatus('error', err.message.split('\n')[0]);
    btnConnect.disabled = false;
  }
});

function handleStateChange(state) {
  if (state === ConnState.CONNECTED) {
    setStatus('success', 'Conectado!');
    setTimeout(showDrawScreen, 600);
  } else if (state === ConnState.DISCONNECTED) {
    mobileStatusText.textContent = 'Desconectado';
    mobileDot.className = 'status-dot disconnected';
    if (screenDraw.classList.contains('active')) {
      toast('Conexão perdida', 'error');
      setTimeout(() => {
        screenDraw.classList.remove('active');
        screenDraw.style.display = '';
        screenConnect.classList.add('active');
        btnConnect.disabled = false;
        setStatus('', '');
      }, 1500);
    }
  } else if (state === ConnState.CONNECTING) {
    setStatus('connecting', 'Aguardando resposta...');
  } else if (state === ConnState.ERROR) {
    setStatus('error', 'Falha na conexão');
    btnConnect.disabled = false;
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;

  switch (msg.type) {
    // Desktop envia dimensões do PDF para normalização
    case 'pdf:size':
      pdfDocW = msg.w;
      pdfDocH = msg.h;
      // Centra o viewport na página ao receber o tamanho
      vpX = 0; vpY = 0; vpZ = 1;
      clampViewport();
      handlePanZoom();
      break;

    // Desktop envia miniatura do PDF como data URL
    case 'pdf:thumb':
      loadThumb(msg.data);
      break;

    // Desktop sincroniza estado (zoom lock, etc.)
    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        zoomLocked = msg.zoomLocked;
        if (toggleZoomLock) toggleZoomLock.checked = zoomLocked;
        toast(zoomLocked ? '🔒 Zoom travado pelo PC' : '🔓 Zoom liberado', 'info');
      }
      break;

    // Desktop limpa anotações
    case 'clear':
      localStrokes.length = 0;
      activeStroke = null;
      redrawAll();
      break;
  }
}

function loadThumb(dataUrl) {
  const img = new Image();
  img.onload = () => {
    pdfThumb = img;
    if (bgMode === 'pdf') handlePanZoom();
  };
  img.src = dataUrl;
}

function setStatus(type, text) {
  connectStatus.className = `connect-status ${type}`;
  connectMsg.textContent  = text;
}

function showDrawScreen() {
  screenConnect.classList.remove('active');
  screenDraw.classList.add('active');
  screenDraw.style.display = 'flex';
  mobileStatusText.textContent = 'Conectado';
  mobileDot.className = 'status-dot connected';
  resizeCanvas();
  bindDrawEvents();
  startViewportBroadcast();
}

// ══════════════════════════════════════════════════════════════════════════
// FERRAMENTAS
// ══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.mob-tool').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.id === 'btn-pan-mode') {
      isPanMode = !isPanMode;
      btn.classList.toggle('active', isPanMode);
      if (isPanMode) {
        document.querySelectorAll('.mob-tool:not(#btn-pan-mode)').forEach(b => b.classList.remove('active'));
        modeLabel.textContent = 'Navegar';
      } else {
        document.querySelector(`.mob-tool[data-tool="${currentTool}"]`)?.classList.add('active');
        modeLabel.textContent = 'Desenho';
      }
      return;
    }
    isPanMode = false;
    btnPanMode.classList.remove('active');
    document.querySelectorAll('.mob-tool').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
    modeLabel.textContent = 'Desenho';
  });
});

document.querySelectorAll('.mob-size').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mob-size').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSize = parseInt(btn.dataset.size);
  });
});

mobColor?.addEventListener('input', () => { currentColor = mobColor.value; });

btnMobUndo?.addEventListener('click', () => {
  // Remove o último stroke do histórico local e redesenha
  if (localStrokes.length > 0) {
    localStrokes.pop();
    handlePanZoom();
    peer?.send({ type: 'undo' });
  }
});

btnMobClear?.addEventListener('click', () => {
  localStrokes.length = 0;
  activeStroke = null;
  redrawAll();
  peer?.send({ type: 'clear' });
});

btnMobDisconnect?.addEventListener('click', async () => {
  clearInterval(_vpBroadcastTimer);
  _vpBroadcastTimer = null;
  await peer?.disconnect();
  screenDraw.classList.remove('active');
  screenDraw.style.display = '';
  screenConnect.classList.add('active');
  codeChars.forEach(i => { i.value = ''; i.classList.remove('filled'); });
  checkCodeComplete();
  setStatus('', '');
  localStrokes.length = 0;
  activeStroke = null;
});

// ── Zoom lock ──────────────────────────────────────────────────────────────
toggleZoomLock?.addEventListener('change', () => {
  zoomLocked = toggleZoomLock.checked;
  peer?.send({ type: 'state:sync', zoomLocked });
  toast(zoomLocked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});

// ── Fundo ──────────────────────────────────────────────────────────────────
bgSelect?.addEventListener('change', () => {
  bgMode = bgSelect.value;
  handlePanZoom();
});

// ── Menu ───────────────────────────────────────────────────────────────────
btnMobileMenu?.addEventListener('click', () => mobileMenu.classList.remove('hidden'));
btnCloseMenu?.addEventListener('click',  () => mobileMenu.classList.add('hidden'));
togglePalm?.addEventListener('change',  () => { palmReject = togglePalm.checked; });

// ══════════════════════════════════════════════════════════════════════════
// EVENTOS DE TOQUE
// ══════════════════════════════════════════════════════════════════════════

function bindDrawEvents() {
  mobileCanvas.addEventListener('touchstart',  onTouchStart,  { passive: false });
  mobileCanvas.addEventListener('touchmove',   onTouchMove,   { passive: false });
  mobileCanvas.addEventListener('touchend',    onTouchEnd,    { passive: false });
  mobileCanvas.addEventListener('touchcancel', onTouchEnd,    { passive: false });
}

function getPos(touch) {
  const rect = mobileCanvas.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

function isPalm(t) {
  if (!palmReject) return false;
  if (t.radiusX > 30 || t.radiusY > 30) return true;
  return false;
}

function onTouchStart(e) {
  e.preventDefault();

  if (e.touches.length >= 2) {
    // Cancela desenho em andamento ao entrar em pan/zoom
    if (isDrawing) { isDrawing = false; endLocalStroke(); peer?.send({ type: 'stroke:end', id: currentId }); }
    lastPinchDist = pinchDist(e.touches);
    const m = pinchMid(e.touches);
    lastPanX = m.x; lastPanY = m.y;
    return;
  }

  const t = e.touches[0];
  if (isPalm(t)) return;

  const { x, y } = getPos(t);

  if (isPanMode) {
    lastPanX = t.clientX; lastPanY = t.clientY;
    return;
  }

  isDrawing = true;
  strokeId++;
  currentId = `m${strokeId}`;
  lastX = x; lastY = y;

  startLocalStroke(x, y);
  haptic();

  const { nx, ny } = toNorm(x, y);
  peer?.send({ type: 'stroke:start', id: currentId, tool: currentTool, color: currentColor, size: currentSize, nx, ny });
}

function onTouchMove(e) {
  e.preventDefault();

  if (e.touches.length >= 2) {
    handlePinch(e.touches);
    return;
  }

  const t = e.touches[0];
  if (isPalm(t)) return;
  const { x, y } = getPos(t);

  if (isPanMode) {
    const sens = parseFloat(panSensitivity?.value ?? '1');
    vpX -= (t.clientX - lastPanX) / vpZ * sens;
    vpY -= (t.clientY - lastPanY) / vpZ * sens;
    lastPanX = t.clientX; lastPanY = t.clientY;
    handlePanZoom();
    return;
  }

  if (!isDrawing) return;

  continueLocalStroke(x, y);
  lastX = x; lastY = y;

  const { nx, ny } = toNorm(x, y);
  peer?.send({ type: 'stroke:move', id: currentId, nx, ny });
}

function onTouchEnd(e) {
  e.preventDefault();
  lastPinchDist = null; lastPanX = null; lastPanY = null;

  if (!isDrawing) return;
  isDrawing = false;
  endLocalStroke();
  peer?.send({ type: 'stroke:end', id: currentId });
}

// ── Pinch ──────────────────────────────────────────────────────────────────

const pinchDist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
const pinchMid  = ts => ({ x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 });

function handlePinch(touches) {
  const dist = pinchDist(touches);
  const mid  = pinchMid(touches);

  if (!zoomLocked && lastPinchDist !== null) {
    const scale = dist / lastPinchDist;
    const prevZ = vpZ;
    vpZ = Math.min(Math.max(0.25, vpZ * scale), 10.0);

    // Zoom centrado no ponto médio dos dedos
    const focusX = (mid.x - mobileCanvas.getBoundingClientRect().left);
    const focusY = (mid.y - mobileCanvas.getBoundingClientRect().top);
    vpX += focusX / prevZ - focusX / vpZ;
    vpY += focusY / prevZ - focusY / vpZ;
  }

  if (lastPanX !== null) {
    const sens = parseFloat(panSensitivity?.value ?? '1');
    vpX -= (mid.x - lastPanX) / vpZ * sens;
    vpY -= (mid.y - lastPanY) / vpZ * sens;
  }

  lastPinchDist = dist;
  lastPanX = mid.x; lastPanY = mid.y;

  handlePanZoom();
}

// ── Haptic ─────────────────────────────────────────────────────────────────

function haptic() {
  if (toggleHaptic?.checked && navigator.vibrate) navigator.vibrate(8);
}
