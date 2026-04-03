/**
 * desktop.js  (v3 — coordenadas normalizadas + sincronização de estado)
 * ────────────────────────────────────────────────────────────────────────
 * ARQUITETURA DE COORDENADAS:
 *
 *  O desktop é a fonte de verdade do tamanho do documento.
 *  Ao carregar/renderizar um PDF, envia ao celular:
 *    { type: 'pdf:size', w: canvas.width, h: canvas.height }
 *    { type: 'pdf:thumb', data: <dataURL 400px> }
 *
 *  Todos os strokes trafegam em coordenadas normalizadas (nx, ny ∈ 0–1).
 *  No desktop:  nx * pdfCanvas.width  → px do canvas
 *  No celular:  nx * pdfDocW          → px do espaço do doc
 *
 * VIEWPORT:
 *  O celular envia { nx, ny, nw, nh } normalizados.
 *  O indicador no desktop: x = nx * pdfCanvas.width, etc.
 *
 * SINCRONIZAÇÃO DE ESTADO:
 *  { type: 'state:sync', zoomLocked: bool } — bidirecional
 */

import { generateCode }    from './signaling.js';
import { DigiPeer, ConnState } from './webrtc.js';
import { PDFViewer }        from './pdf-viewer.js';
import { AnnotationEngine } from './annotation.js';
import { toast }            from './toast.js';

// ── DOM ────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const screenWelcome     = $('screen-welcome');
const screenMain        = $('screen-main');
const fileInput         = $('file-input');
const canvasWrapper     = $('canvas-wrapper');
const pdfCanvas         = $('pdf-canvas');
const annotationCanvas  = $('annotation-canvas');
const remoteCanvas      = $('remote-canvas');
const viewportIndicator = $('viewport-indicator');
const pageInfo          = $('page-info');
const zoomLevel         = $('zoom-level');
const pdfFilename       = $('pdf-filename');
const statusDot         = $('status-dot');
const btnGenerateCode   = $('btn-generate-code');
const codeDisplay       = $('code-display');
const codeDigits        = $('code-digits');
const connSetup         = $('conn-setup');
const connStatus        = $('conn-status');
const btnDisconnect     = $('btn-disconnect');
const elVpX             = $('vp-x');
const elVpY             = $('vp-y');
const elVpZoom          = $('vp-zoom');
const toggleRemote      = $('toggle-remote-strokes');
const toggleSync        = $('toggle-sync-scroll');
const toggleZoomLock    = $('toggle-zoom-lock-desktop');
const strokeColor       = $('stroke-color');

// ── Estado ─────────────────────────────────────────────────────────────────

let viewer      = null;
let annotation  = null;
let peer        = null;
let sessionCode = null;
let strokeId    = 0;
let zoomLocked  = false;

// ══════════════════════════════════════════════════════════════════════════
// TELAS
// ══════════════════════════════════════════════════════════════════════════

function showMain() {
  screenWelcome.classList.remove('active');
  screenMain.classList.add('active');
  screenMain.style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════════════
// PDF
// ══════════════════════════════════════════════════════════════════════════

$('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  pdfFilename.textContent = file.name;
  showMain();
  initCanvases();
  const buf = await file.arrayBuffer();
  await viewer.loadFromBuffer(buf);
});

$('btn-demo').addEventListener('click', () => {
  pdfFilename.textContent = 'Demo';
  showMain();
  initCanvases();

  // Página demo: A4 a 96dpi
  pdfCanvas.width  = 794;
  pdfCanvas.height = 1123;
  syncCanvasSizes();

  const ctx = pdfCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 794, 1123);
  ctx.fillStyle = '#1a1a2e';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('DigiCanvas — Modo Demo', 397, 90);
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText('Abra um PDF para usar como fundo', 397, 140);
  ctx.fillStyle = '#ddd'; ctx.fillRect(60, 170, 674, 1);
  ['Gere um código → conecte o celular', 'Desenhe no celular → aparece aqui', 'Use as ferramentas acima para anotar localmente'].forEach((t, i) => {
    ctx.fillStyle = '#888'; ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}. ${t}`, 80, 220 + i * 45);
  });

  pageInfo.textContent = '1 / 1';
  broadcastPdfInfo();
});

function initCanvases() {
  if (annotation) return;

  annotation = new AnnotationEngine(
    annotationCanvas,
    remoteCanvas,
    () => ({ w: pdfCanvas.width, h: pdfCanvas.height })
  );

  // Callbacks de stroke local → envia normalizado ao celular
  annotation.onStrokeStart = ({ tool, color, size, nx, ny }) => {
    strokeId++;
    annotation._currentStrokeId = `h${strokeId}`;
    peer?.send({ type: 'stroke:start', id: annotation._currentStrokeId, tool, color, size, nx, ny });
  };
  annotation.onStrokeMove = ({ nx, ny }) => {
    peer?.send({ type: 'stroke:move', id: annotation._currentStrokeId, nx, ny });
  };
  annotation.onStrokeEnd = () => {
    peer?.send({ type: 'stroke:end', id: annotation._currentStrokeId });
  };

  viewer = new PDFViewer(pdfCanvas);
  viewer.onRender = (page, total) => {
    pageInfo.textContent  = `${page} / ${total}`;
    zoomLevel.textContent = Math.round(viewer.scale * 100) + '%';
    syncCanvasSizes();
    annotation.onCanvasResize();
    broadcastPdfInfo();
  };
}

/** Garante que annotation e remoteCanvas têm sempre o mesmo tamanho do pdfCanvas */
function syncCanvasSizes() {
  [annotationCanvas, remoteCanvas].forEach(c => {
    c.width  = pdfCanvas.width;
    c.height = pdfCanvas.height;
  });
}

/**
 * Envia ao celular:
 *  1. O tamanho do documento (para normalização)
 *  2. Uma miniatura de ~400px para usar como fundo
 */
function broadcastPdfInfo() {
  if (!peer || peer.state !== ConnState.CONNECTED) return;
  if (!pdfCanvas.width) return;

  // Tamanho
  peer.send({ type: 'pdf:size', w: pdfCanvas.width, h: pdfCanvas.height });

  // Miniatura (max 400px de largura para não sobrecarregar o DataChannel)
  const THUMB_W = 400;
  const scale   = THUMB_W / pdfCanvas.width;
  const tw      = THUMB_W;
  const th      = Math.round(pdfCanvas.height * scale);
  const tmp     = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  tmp.getContext('2d').drawImage(pdfCanvas, 0, 0, tw, th);
  const dataUrl = tmp.toDataURL('image/jpeg', 0.7);
  peer.send({ type: 'pdf:thumb', data: dataUrl });
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROLES DE PDF
// ══════════════════════════════════════════════════════════════════════════

$('btn-prev-page').addEventListener('click', () => viewer?.prevPage());
$('btn-next-page').addEventListener('click', () => viewer?.nextPage());
$('btn-zoom-in').addEventListener('click',   () => viewer?.zoomIn());
$('btn-zoom-out').addEventListener('click',  () => viewer?.zoomOut());
$('btn-zoom-fit').addEventListener('click',  () => viewer?.fitToContainer(canvasWrapper));

// ── Ferramentas ────────────────────────────────────────────────────────────

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotation?.setTool(btn.dataset.tool);
  });
});

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotation?.setSize(parseInt(btn.dataset.size));
  });
});

strokeColor?.addEventListener('input', () => annotation?.setColor(strokeColor.value));

$('btn-undo').addEventListener('click', () => { annotation?.undo(); peer?.send({ type: 'undo' }); });
$('btn-clear-annotations').addEventListener('click', () => { annotation?.clear(); peer?.send({ type: 'clear' }); });
$('btn-export').addEventListener('click', () => {
  if (!annotation) return;
  const a = document.createElement('a');
  a.href = annotation.exportPNG();
  a.download = 'digicanvas.png';
  a.click();
});

// Ctrl+Z
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { annotation?.undo(); peer?.send({ type: 'undo' }); }
});

// ── Toggles ────────────────────────────────────────────────────────────────

toggleRemote?.addEventListener('change', () => {
  if (annotation) annotation.showRemote = toggleRemote.checked;
  remoteCanvas.style.display = toggleRemote.checked ? 'block' : 'none';
});

toggleZoomLock?.addEventListener('change', () => {
  zoomLocked = toggleZoomLock.checked;
  peer?.send({ type: 'state:sync', zoomLocked });
  toast(zoomLocked ? '🔒 Zoom do celular travado' : '🔓 Zoom liberado', 'info');
});

// ══════════════════════════════════════════════════════════════════════════
// WEBRTC / CONEXÃO
// ══════════════════════════════════════════════════════════════════════════

btnGenerateCode.addEventListener('click', async () => {
  if (peer) await peer.disconnect();

  sessionCode = generateCode();
  renderCode(sessionCode);
  codeDisplay.classList.remove('hidden');

  peer = new DigiPeer({
    role: 'host', code: sessionCode,
    onStateChange: handleStateChange,
    onMessage:     handleMessage,
  });

  try {
    await peer.startAsHost();
  } catch (err) {
    toast('Erro: ' + err.message, 'error', 6000);
    console.error('[Desktop]', err);
  }
});

btnDisconnect.addEventListener('click', async () => {
  await peer?.disconnect();
  peer = null;
  connStatus.classList.add('hidden');
  connSetup.style.display = '';
  codeDisplay.classList.add('hidden');
  viewportIndicator.style.display = 'none';
  setStatusDot('disconnected');
});

function renderCode(code) {
  codeDigits.innerHTML = '';
  code.split('').forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'digit';
    el.textContent = d;
    el.style.animationDelay = `${i * 60}ms`;
    codeDigits.appendChild(el);
  });
  renderQR(code);
}

function renderQR(code) {
  const qrEl = $('code-qr');
  if (!qrEl) return;
  const base = location.href.replace(/index\.html.*$/, '').replace(/\/$/, '');
  const url  = `${base}/celular.html?code=${code}`;
  const load = () => {
    qrEl.innerHTML = '';
    new QRCode(qrEl, { text: url, width: 120, height: 120, colorDark: '#7c6af7', colorLight: '#1e1e2e', correctLevel: QRCode.CorrectLevel.M });
  };
  if (!document.querySelector('script[src*="qrcode"]')) {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = load;
    document.head.appendChild(s);
  } else {
    load();
  }
}

function handleStateChange(state) {
  setStatusDot(
    state === ConnState.CONNECTED  ? 'connected'  :
    state === ConnState.CONNECTING ? 'connecting' : 'disconnected'
  );

  if (state === ConnState.CONNECTED) {
    connSetup.style.display = 'none';
    connStatus.classList.remove('hidden');
    viewportIndicator.style.display = 'block';
    toast('📱 Celular conectado!', 'success');
    // Envia imediatamente o tamanho do PDF e a miniatura
    setTimeout(broadcastPdfInfo, 300);
    // Envia estado atual
    peer?.send({ type: 'state:sync', zoomLocked });
  }

  if (state === ConnState.DISCONNECTED) {
    connStatus.classList.add('hidden');
    connSetup.style.display = '';
    viewportIndicator.style.display = 'none';
    if (peer) toast('Celular desconectado', 'error');
  }

  if (state === ConnState.ERROR) {
    connStatus.classList.add('hidden');
    connSetup.style.display = '';
    viewportIndicator.style.display = 'none';
    toast('Erro na conexão WebRTC', 'error');
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;

  switch (msg.type) {
    // Traços do celular — coordenadas normalizadas
    case 'stroke:start':
    case 'stroke:move':
    case 'stroke:end':
    case 'clear':
    case 'undo':
      annotation?.applyRemoteMessage(msg);
      break;

    // Viewport do celular — normalizado
    case 'viewport':
      updateViewport(msg);
      break;

    // Sincronização de estado (zoom lock pelo celular)
    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        zoomLocked = msg.zoomLocked;
        if (toggleZoomLock) toggleZoomLock.checked = zoomLocked;
        toast(zoomLocked ? '🔒 Zoom travado pelo celular' : '🔓 Zoom liberado', 'info');
        // Re-ecoa para o celular para confirmar
        peer?.send({ type: 'state:sync', zoomLocked });
      }
      break;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// VIEWPORT INDICATOR
// ══════════════════════════════════════════════════════════════════════════

function updateViewport(msg) {
  // msg: { nx, ny, nw, nh, zoom, locked }
  const { nx, ny, nw, nh, zoom } = msg;

  const W = pdfCanvas.width;
  const H = pdfCanvas.height;

  if (!W || !H) return;

  // Converte normalizado → px no canvas do desktop
  const indX = nx * W;
  const indY = ny * H;
  const indW = Math.max(20, nw * W);
  const indH = Math.max(20, nh * H);

  // Clamp para não sair dos limites do canvas
  const clampedX = Math.max(0, Math.min(indX, W - indW));
  const clampedY = Math.max(0, Math.min(indY, H - indH));

  viewportIndicator.style.left   = `${clampedX}px`;
  viewportIndicator.style.top    = `${clampedY}px`;
  viewportIndicator.style.width  = `${indW}px`;
  viewportIndicator.style.height = `${indH}px`;

  // Info no painel
  if (elVpX)    elVpX.textContent    = Math.round(nx * 100) + '%';
  if (elVpY)    elVpY.textContent    = Math.round(ny * 100) + '%';
  if (elVpZoom) elVpZoom.textContent = (zoom ?? 1).toFixed(2) + '×';

  // Auto-scroll (centra o viewport no wrapper)
  if (toggleSync?.checked) {
    const cx = clampedX - canvasWrapper.clientWidth  / 2 + indW / 2;
    const cy = clampedY - canvasWrapper.clientHeight / 2 + indH / 2;
    canvasWrapper.scrollTo({ left: cx, top: cy, behavior: 'smooth' });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function setStatusDot(s) {
  statusDot.className = `status-dot ${s}`;
}
