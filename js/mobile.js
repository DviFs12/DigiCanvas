/**
 * mobile.js
 * ─────────
 * Controller principal do lado celular (celular.html).
 * Gerencia:
 *  - Conexão WebRTC como guest
 *  - Canvas de desenho com toque
 *  - Pan & zoom do viewport (enviado ao host)
 *  - Palm rejection básico
 */

import { DigiPeer, ConnState } from './webrtc.js';
import { toast } from './toast.js';

// ── Elementos DOM ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const screenConnect    = $('screen-connect');
const screenDraw       = $('screen-draw');
const codeChars        = Array.from(document.querySelectorAll('.code-char'));
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

// ── Estado ─────────────────────────────────────────────────────────────────

let peer        = null;
let ctx         = null;
let strokeId    = 0;
let currentId   = null;
let isDrawing   = false;
let lastX       = 0;
let lastY       = 0;

let currentTool  = 'pen';
let currentColor = '#e63946';
let currentSize  = 2;

// Viewport (pan & zoom no celular)
let vpX   = 0;
let vpY   = 0;
let vpZ   = 1.0;  // zoom do viewport (não afeta PDF no desktop)

// Pan com dois dedos
let lastPinchDist = null;
let lastPanX      = null;
let lastPanY      = null;
let isPanMode     = false;

// Palm rejection: ignora toques com área grande
let palmReject = true;

// Histórico para undo local
const history = [];
const MAX_HIST = 20;

// ── Canvas setup ───────────────────────────────────────────────────────────

function resizeCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const hud  = $('mobile-hud');
  const bar  = $('mobile-toolbar');
  const hudH = hud ? hud.offsetHeight : 52;
  const barH = bar ? bar.offsetHeight : 110;
  const w    = window.innerWidth;
  const h    = window.innerHeight - hudH - barH;

  mobileCanvas.width  = w * dpr;
  mobileCanvas.height = h * dpr;
  mobileCanvas.style.width  = w + 'px';
  mobileCanvas.style.height = h + 'px';
  mobileCanvas.style.top    = hudH + 'px';

  ctx = mobileCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
}

window.addEventListener('resize', resizeCanvas);

// ── Auto-preenche código via URL param (?code=XXXXXX) ─────────────────────
(function autoFillCode() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  if (code && /^\d{6}$/.test(code)) {
    code.split('').forEach((char, i) => {
      if (codeChars[i]) {
        codeChars[i].value = char;
        codeChars[i].classList.add('filled');
      }
    });
    checkCodeComplete();
    // Pequeno delay para a UI montar
    setTimeout(() => btnConnect.click(), 400);
  }
})();

// ── Code input ─────────────────────────────────────────────────────────────

codeChars.forEach((input, idx) => {
  input.addEventListener('input', (e) => {
    const val = e.target.value.replace(/\D/, '');
    input.value = val;
    input.classList.toggle('filled', val !== '');

    if (val && idx < codeChars.length - 1) {
      codeChars[idx + 1].focus();
    }

    checkCodeComplete();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && idx > 0) {
      codeChars[idx - 1].focus();
      codeChars[idx - 1].value = '';
      codeChars[idx - 1].classList.remove('filled');
    }
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    text.split('').forEach((char, i) => {
      if (codeChars[i]) {
        codeChars[i].value = char;
        codeChars[i].classList.add('filled');
      }
    });
    checkCodeComplete();
  });
});

function getCode() {
  return codeChars.map(i => i.value).join('');
}

function checkCodeComplete() {
  const code = getCode();
  btnConnect.disabled = code.length < 6;
}

// ── Conexão ────────────────────────────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
  const code = getCode();
  if (code.length < 6) return;

  setConnectStatus('connecting', 'Conectando...');
  btnConnect.disabled = true;

  peer = new DigiPeer({
    role:          'guest',
    code,
    onStateChange: handleStateChange,
    onMessage:     handleMessage,
  });

  try {
    await peer.startAsGuest();
  } catch (err) {
    setConnectStatus('error', err.message);
    btnConnect.disabled = false;
  }
});

function handleStateChange(state) {
  if (state === ConnState.CONNECTED) {
    setConnectStatus('success', 'Conectado!');
    setTimeout(showDrawScreen, 600);
  } else if (state === ConnState.DISCONNECTED) {
    mobileStatusText.textContent = 'Desconectado';
    mobileDot.className = 'status-dot disconnected';
    // Se estava na tela de desenho, avisa e volta para conexão
    if (screenDraw.classList.contains('active')) {
      toast('Conexão perdida', 'error');
      setTimeout(() => {
        screenDraw.classList.remove('active');
        screenDraw.style.display = '';
        screenConnect.classList.add('active');
        btnConnect.disabled = false;
        setConnectStatus('', '');
      }, 1500);
    }
  } else if (state === ConnState.CONNECTING) {
    setConnectStatus('connecting', 'Aguardando resposta...');
  } else if (state === ConnState.ERROR) {
    setConnectStatus('error', 'Falha na conexão');
    btnConnect.disabled = false;
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;

  // Aplica traços do desktop no canvas do celular
  if (msg.type === 'clear') {
    ctx?.clearRect(0, 0, mobileCanvas.width, mobileCanvas.height);
  }
}

function setConnectStatus(type, text) {
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

// ── Ferramentas ────────────────────────────────────────────────────────────

document.querySelectorAll('.mob-tool').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.id === 'btn-pan-mode') {
      isPanMode = !isPanMode;
      btn.classList.toggle('active', isPanMode);
      // Remove active de outros botões quando pan está ativo
      if (isPanMode) {
        document.querySelectorAll('.mob-tool:not(#btn-pan-mode)').forEach(b => b.classList.remove('active'));
        modeLabel.textContent = 'Viewport';
      } else {
        btn.classList.remove('active');
        modeLabel.textContent = 'Desenho';
        // Reativa a ferramenta atual
        document.querySelector(`.mob-tool[data-tool="${currentTool}"]`)?.classList.add('active');
      }
      return;
    }

    // Ferramenta de desenho normal
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

mobColor.addEventListener('input', () => { currentColor = mobColor.value; });

btnMobUndo.addEventListener('click', () => {
  if (history.length > 0) {
    const prev = history.pop();
    ctx.putImageData(prev, 0, 0);
    peer?.send({ type: 'undo' });
  }
});

btnMobClear.addEventListener('click', () => {
  ctx.clearRect(0, 0, mobileCanvas.width, mobileCanvas.height);
  history.length = 0;
  peer?.send({ type: 'clear' });
});

btnMobDisconnect.addEventListener('click', async () => {
  await peer?.disconnect();
  screenDraw.classList.remove('active');
  screenDraw.style.display = '';
  screenConnect.classList.add('active');
  codeChars.forEach(i => { i.value = ''; i.classList.remove('filled'); });
  checkCodeComplete();
  setConnectStatus('', '');
  history.length = 0;
});

// ── Menu lateral ──────────────────────────────────────────────────────────

btnMobileMenu.addEventListener('click', () => mobileMenu.classList.remove('hidden'));
btnCloseMenu.addEventListener('click',  () => mobileMenu.classList.add('hidden'));
togglePalm.addEventListener('change',   () => { palmReject = togglePalm.checked; });

// ── Eventos de toque ───────────────────────────────────────────────────────

function bindDrawEvents() {
  mobileCanvas.addEventListener('touchstart', onTouchStart, { passive: false });
  mobileCanvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
  mobileCanvas.addEventListener('touchend',   onTouchEnd,   { passive: false });
  mobileCanvas.addEventListener('touchcancel',onTouchEnd,   { passive: false });
}

function getCanvasPos(touch) {
  const rect = mobileCanvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  return {
    x: (touch.clientX - rect.left),   // em px CSS
    y: (touch.clientY - rect.top),
  };
}

function isPalm(touch) {
  if (!palmReject) return false;
  // Touch de palma geralmente tem radiusX/Y > 30 ou force > 0.8
  if (touch.radiusX > 30 || touch.radiusY > 30) return true;
  if (touch.touchType === 'direct' && touch.force > 0.8) return true;
  return false;
}

function onTouchStart(e) {
  e.preventDefault();

  if (e.touches.length === 2) {
    // Dois dedos: pan/zoom do viewport
    lastPinchDist = getPinchDist(e.touches);
    const mid = getPinchMid(e.touches);
    lastPanX = mid.x;
    lastPanY = mid.y;
    isDrawing = false;
    return;
  }

  const touch = e.touches[0];
  if (isPalm(touch)) return;

  if (isPanMode) {
    lastPanX = touch.clientX;
    lastPanY = touch.clientY;
    return;
  }

  isDrawing = true;
  strokeId++;
  currentId = `m${strokeId}`;

  const { x, y } = getCanvasPos(touch);
  lastX = x;
  lastY = y;

  // Salva estado no histórico
  const dpr = window.devicePixelRatio || 1;
  history.push(ctx.getImageData(0, 0, mobileCanvas.width, mobileCanvas.height));
  if (history.length > MAX_HIST) history.shift();

  ctx.beginPath();
  ctx.moveTo(x, y);

  haptic();

  // Envia ao desktop com coordenadas mapeadas para o documento
  peer?.send({
    type:  'stroke:start',
    id:    currentId,
    tool:  currentTool,
    color: currentColor,
    size:  currentSize,
    x:     toDocX(x),
    y:     toDocY(y),
  });
}

function onTouchMove(e) {
  e.preventDefault();

  if (e.touches.length === 2) {
    handlePinch(e.touches);
    return;
  }

  const touch = e.touches[0];
  if (isPalm(touch)) return;

  if (isPanMode) {
    const dx = (touch.clientX - lastPanX) * parseFloat(panSensitivity.value);
    const dy = (touch.clientY - lastPanY) * parseFloat(panSensitivity.value);
    vpX -= dx;
    vpY -= dy;
    vpX = Math.max(0, vpX);
    vpY = Math.max(0, vpY);
    lastPanX = touch.clientX;
    lastPanY = touch.clientY;
    return;
  }

  if (!isDrawing) return;

  const { x, y } = getCanvasPos(touch);
  drawSegment(x, y);
  lastX = x;
  lastY = y;

  peer?.send({ type: 'stroke:move', id: currentId, x: toDocX(x), y: toDocY(y) });
}

function onTouchEnd(e) {
  e.preventDefault();
  lastPinchDist = null;
  lastPanX = null;
  lastPanY = null;

  if (!isDrawing) return;
  isDrawing = false;

  peer?.send({ type: 'stroke:end', id: currentId });
}

// ── Desenho ────────────────────────────────────────────────────────────────

function drawSegment(x, y) {
  if (currentTool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = currentSize * 4;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = currentColor;
    ctx.lineWidth   = currentTool === 'marker' ? currentSize * 3 : currentSize;
    ctx.globalAlpha = currentTool === 'marker' ? 0.4 : 1;
  }

  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ── Pinch ─────────────────────────────────────────────────────────────────

function getPinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function getPinchMid(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function handlePinch(touches) {
  const dist = getPinchDist(touches);
  const mid  = getPinchMid(touches);

  if (lastPinchDist !== null) {
    const scale = dist / lastPinchDist;
    vpZ = Math.min(Math.max(0.5, vpZ * scale), 8.0);
  }

  if (lastPanX !== null) {
    const sens = parseFloat(panSensitivity.value);
    vpX -= (mid.x - lastPanX) * sens;
    vpY -= (mid.y - lastPanY) * sens;
    vpX  = Math.max(0, vpX);
    vpY  = Math.max(0, vpY);
  }

  lastPinchDist = dist;
  lastPanX      = mid.x;
  lastPanY      = mid.y;
}

// ── Viewport broadcast ────────────────────────────────────────────────────

// Envia posição do viewport ~30fps
function startViewportBroadcast() {
  setInterval(() => {
    if (!peer || peer.state !== ConnState.CONNECTED) return;
    peer.send({
      type:    'viewport',
      x:       vpX,
      y:       vpY,
      zoom:    vpZ,
      canvasW: mobileCanvas.width  / (window.devicePixelRatio || 1),
      canvasH: mobileCanvas.height / (window.devicePixelRatio || 1),
    });
  }, 33);
}

// ── Mapeamento de coordenadas ─────────────────────────────────────────────

// Converte coordenada do canvas do celular para coordenada no documento PDF
function toDocX(x) { return vpX + x / vpZ; }
function toDocY(y) { return vpY + y / vpZ; }

// ── Haptic ────────────────────────────────────────────────────────────────

function haptic() {
  if (toggleHaptic.checked && navigator.vibrate) {
    navigator.vibrate(8);
  }
}
