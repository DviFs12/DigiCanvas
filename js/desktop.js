/**
 * desktop.js v6 — REFATORADO
 * ────────────────────────────
 * Usa State manager para modo de interação e viewport.
 * Máquina de estados para modos: draw | move | resize
 *
 * RESPONSABILIDADES:
 *  - PDFViewer (zoom, páginas)
 *  - AnnotationEngine (draw no desktop)
 *  - Controle do viewport indicator (move/resize)
 *  - WebRTC (host)
 *  - UI (toolbar, painel, temas, recentes)
 */

import { generateCode }        from './signaling.js';
import { DigiPeer, ConnState } from './webrtc.js';
import { PDFViewer }           from './pdf-viewer.js';
import { AnnotationEngine }    from './annotation.js';
import { toast, showLoading, hideLoading } from './toast.js';
import { shortcuts }           from './shortcuts.js';
import { State }               from './state.js';
import { getTheme, setTheme, applyTheme, getPrefs, setPref,
         getRecents, addRecent, removeRecent, clearRecents } from './store.js';

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);

const canvasWrapper     = $('canvas-wrapper');
const pdfCanvas         = $('pdf-canvas');
const annotationCanvas  = $('annotation-canvas');
const remoteCanvas      = $('remote-canvas');
const gridCanvas        = $('grid-canvas');
const viewportIndicator = $('viewport-indicator');

// ── Core ────────────────────────────────────────────────────────────────────
let viewer      = null;
let annotation  = null;
let peer        = null;
let sessionCode = null;
let strokeId    = 0;
let currentFile = null;

// ── Init ────────────────────────────────────────────────────────────────────
applyTheme();
renderRecents();
applyPrefsToUI();

// ── Escuta mudanças de modo para ajustar cursores e handlers ────────────────
State.on('pcMode', applyModeToUI);

// ══════════════════════════════════════════════════════════════════════════
// ABERTURA DE PDF
// ══════════════════════════════════════════════════════════════════════════

on('file-input',        'change', async e => { const f=e.target.files[0]; if (f) await openPDF(f); });
on('btn-demo',          'click',  openDemo);
on('file-input-change', 'change', async e => { const f=e.target.files[0]; if (f) await openPDF(f); });
on('btn-change-pdf',    'click',  () => $('file-input-change')?.click());

async function openPDF(file) {
  showLoading('Carregando PDF…');
  try {
    const buffer = await file.arrayBuffer();
    currentFile  = { name: file.name, size: file.size, buffer };
    showMain();
    if (!annotation) initCanvases();
    await viewer.loadFromBuffer(buffer);
    $('pdf-filename').textContent = file.name;
    const thumb = await viewer.getThumbnail(120);
    addRecent({ name: file.name, size: file.size, thumb });
    renderRecents();
  } catch (err) {
    toast('Erro ao abrir: ' + err.message, 'error');
  } finally { hideLoading(); }
}

function openDemo() {
  showMain();
  if (!annotation) initCanvases();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(794 * dpr), H = Math.round(1123 * dpr);
  [pdfCanvas, annotationCanvas, remoteCanvas, gridCanvas].forEach(c => {
    if (!c) return;
    c.width = W; c.height = H;
    c.style.width = '794px'; c.style.height = '1123px';
  });
  const ctx = pdfCanvas.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.fillStyle='#1a1a2e'; ctx.font='bold 30px sans-serif'; ctx.textAlign='center';
  ctx.fillText('DigiCanvas — Modo Demo', 397, 88);
  ctx.font='14px sans-serif'; ctx.fillStyle='#666';
  ctx.fillText('Conecte o celular para começar', 397, 128);
  ctx.restore();
  $('pdf-filename').textContent = 'Demo';
  $('page-info').textContent    = '1 / 1';
  annotation?.onCanvasResize();
  drawGrid();
  broadcastPdfInfo();
}

function showMain() {
  $('screen-welcome').classList.remove('active');
  const sm = $('screen-main');
  sm.classList.add('active'); sm.style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════════════
// CANVAS / VIEWER / ANNOTATION
// ══════════════════════════════════════════════════════════════════════════

function initCanvases() {
  annotation = new AnnotationEngine(
    annotationCanvas, remoteCanvas,
    () => ({ w: pdfCanvas.width / (window.devicePixelRatio||1), h: pdfCanvas.height / (window.devicePixelRatio||1) })
  );
  annotation.clearMode = getPrefs().clearMode || 'shared';

  // Callbacks: stroke local → envia ao celular com coordenadas NORMALIZADAS
  annotation.onStrokeStart = ({ tool, color, size, nx, ny }) => {
    strokeId++;
    annotation._curId = `h${strokeId}`;
    peer?.send({ type:'stroke:start', id:annotation._curId, tool, color, size, nx, ny });
  };
  annotation.onStrokeMove = ({ nx, ny }) => {
    peer?.send({ type:'stroke:move', id:annotation._curId, nx, ny });
  };
  annotation.onStrokeEnd = () => {
    peer?.send({ type:'stroke:end', id:annotation._curId });
  };

  viewer = new PDFViewer(pdfCanvas);
  viewer.onLoading = b => b ? showLoading('Renderizando…') : hideLoading();
  viewer.onRender  = async (page, total) => {
    $('page-info').textContent  = `${page} / ${total}`;
    $('zoom-level').textContent = Math.round(viewer.scale * 100) + '%';
    annotation.onCanvasResize();
    drawGrid();
    broadcastPdfInfo();
  };

  // Aplica modo inicial
  applyModeToUI(State.get('pcMode'));
  applyPrefsToUI();
}

// ── Grid ──────────────────────────────────────────────────────────────────

function drawGrid() {
  if (!gridCanvas) return;
  const ctx = gridCanvas.getContext('2d');
  ctx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
  if (!getPrefs().gridEnabled) return;
  const dpr = window.devicePixelRatio || 1;
  const step = 40 * dpr, W = gridCanvas.width, H = gridCanvas.height;
  ctx.strokeStyle = 'rgba(124,106,247,0.18)'; ctx.lineWidth = 1;
  for (let x=0; x<W; x+=step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y=0; y<H; y+=step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
}

// ── Broadcast PDF ─────────────────────────────────────────────────────────

async function broadcastPdfInfo() {
  if (!peer || peer.state !== ConnState.CONNECTED) return;
  const dpr = window.devicePixelRatio || 1;
  const w   = pdfCanvas.width / dpr, h = pdfCanvas.height / dpr;
  peer.send({ type:'pdf:size', w, h });
  State.set('pdfSize', { w, h });
  try {
    const thumb = viewer?.pdfDoc
      ? await viewer.getThumbnail(420)
      : canvasToJpeg(pdfCanvas, 420);
    if (thumb) peer.send({ type:'pdf:thumb', data: thumb });
  } catch { /**/ }
}

function canvasToJpeg(canvas, maxW) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.width/dpr, ch = canvas.height/dpr;
  const sc = Math.min(1, maxW/cw);
  const tmp = document.createElement('canvas');
  tmp.width  = Math.round(cw*sc*dpr);
  tmp.height = Math.round(ch*sc*dpr);
  tmp.getContext('2d').drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL('image/jpeg', 0.72);
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROLES PDF
// ══════════════════════════════════════════════════════════════════════════

on('btn-prev-page', 'click', () => viewer?.prevPage());
on('btn-next-page', 'click', () => viewer?.nextPage());
on('btn-zoom-in',   'click', () => viewer?.zoomIn());
on('btn-zoom-out',  'click', () => viewer?.zoomOut());
on('btn-zoom-fit',  'click', () => viewer?.fitToContainer(canvasWrapper));

canvasWrapper?.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  e.deltaY < 0 ? viewer?.zoomIn(0.1) : viewer?.zoomOut(0.1);
}, { passive:false });

// ══════════════════════════════════════════════════════════════════════════
// MÁQUINA DE ESTADOS: draw | move | resize  (#3)
// ══════════════════════════════════════════════════════════════════════════

/** Define o modo e atualiza UI/handlers */
function setMode(mode) {
  State.set('pcMode', mode);
}

function applyModeToUI(mode) {
  document.querySelectorAll('[data-pc-mode]').forEach(b =>
    b.classList.toggle('active', b.dataset.pcMode === mode)
  );
  const label = $('pc-mode-label');
  if (label) label.textContent = { draw:'Desenhar', move:'Mover caixa' }[mode] ?? mode;

  // Annotation recebe eventos SOMENTE no modo draw
  annotation?.setActive(mode === 'draw');

  // Cursor no canvas de anotação
  if (annotationCanvas) {
    annotationCanvas.style.cursor = mode === 'draw' ? 'crosshair' : 'default';
  }
  // Cursor no indicator
  if (viewportIndicator) {
    viewportIndicator.style.cursor = mode === 'move' ? 'grab' : 'default';
    // Pointer-events: só mode move/resize captura eventos no indicator
    viewportIndicator.style.pointerEvents = mode === 'move' ? 'all' : 'none';
  }
}

document.querySelectorAll('[data-pc-mode]').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.pcMode));
});

// Atalhos de modo (D = draw, V = move, R = resize)
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'd') setMode('draw');
  if (e.key === 'v') setMode('move');
});

// ── Viewport Indicator: Move e Resize (pointer events robustos) ────────────

let vpInteraction = null; // { type:'move'|'resize', startX, startY, startNX, startNY, startNW, startNH }

viewportIndicator?.addEventListener('pointerdown', e => {
  const mode = State.get('pcMode');
  if (mode !== 'move') return;
  e.preventDefault(); e.stopPropagation();
  viewportIndicator.setPointerCapture(e.pointerId);

  const vp = State.get('viewport');
  vpInteraction = {
    type: mode,
    startX: e.clientX, startY: e.clientY,
    startNX: vp.nx, startNY: vp.ny,
    startNW: vp.nw, startNH: vp.nh,
  };
  if (mode === 'move') viewportIndicator.style.cursor = 'grabbing';
});

viewportIndicator?.addEventListener('pointermove', e => {
  if (!vpInteraction) return;
  e.preventDefault();

  const dpr = window.devicePixelRatio || 1;
  const W   = pdfCanvas.width / dpr;
  const H   = pdfCanvas.height / dpr;
  if (!W || !H) return;

  const dx = e.clientX - vpInteraction.startX;
  const dy = e.clientY - vpInteraction.startY;

  if (vpInteraction.type === 'move') {
    // Bug #1: clamp correto — nx ∈ [0, 1-nw], ny ∈ [0, 1-nh]
    const nw = vpInteraction.startNW;
    const nh = vpInteraction.startNH;
    const nx = clamp(vpInteraction.startNX + dx/W, 0, Math.max(0, 1 - nw));
    const ny = clamp(vpInteraction.startNY + dy/H, 0, Math.max(0, 1 - nh));
    const newVP = { ...State.get('viewport'), nx, ny };
    State.set('viewport', newVP);
    positionIndicator(newVP);
    peer?.send({ type:'viewport:set', nx, ny });

  }
});

viewportIndicator?.addEventListener('pointerup', e => {
  vpInteraction = null;
  if (State.get('pcMode') === 'move') viewportIndicator.style.cursor = 'grab';
});

viewportIndicator?.addEventListener('pointercancel', () => { vpInteraction = null; });

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function positionIndicator(vp) {
  if (!viewportIndicator) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = pdfCanvas.width / dpr;
  const H   = pdfCanvas.height / dpr;
  if (!W || !H) return;
  const x = vp.nx * W;
  const y = vp.ny * H;
  const w = Math.max(8, vp.nw * W);
  const h = Math.max(8, vp.nh * H);
  // Clamp visual (indicator nunca sai do canvas)
  const cx = clamp(x, 0, W - w);
  const cy = clamp(y, 0, H - h);
  viewportIndicator.style.left   = cx + 'px';
  viewportIndicator.style.top    = cy + 'px';
  viewportIndicator.style.width  = w + 'px';
  viewportIndicator.style.height = h + 'px';
  viewportIndicator.style.display = 'block';
}

// ══════════════════════════════════════════════════════════════════════════
// FERRAMENTAS
// ══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    annotation?.setTool(btn.dataset.tool);
    setPref('tool', btn.dataset.tool);
    // Ao clicar em ferramenta → volta ao modo draw
    if (State.get('pcMode') !== 'draw') setMode('draw');
  });
});

on('stroke-size-slider', 'input', e => {
  const v = parseInt(e.target.value);
  annotation?.setSize(v);
  const lbl=$('stroke-size-label'); if (lbl) lbl.textContent=v;
  setPref('size', v);
});

on('stroke-color', 'input', e => annotation?.setColor(e.target.value));

on('btn-undo', 'click', () => { if (annotation?.undo()) peer?.send({ type:'undo' }); });
on('btn-redo', 'click', () => { if (annotation?.redo()) peer?.send({ type:'redo' }); });

// Split Limpar
on('btn-clear-all',    'click', () => { annotation?.clear();       peer?.send({ type:'clear:all' });    toast('Tudo limpo','info'); });
on('btn-clear-local',  'click', () => { annotation?.clearLocal();  peer?.send({ type:'clear:local' });  toast('PC limpo','info'); });
on('btn-clear-remote', 'click', () => { annotation?.clearRemote(); peer?.send({ type:'clear:remote' }); toast('Celular limpo','info'); });

// Split Export
on('btn-export-all',    'click', () => doExport({ includeLocal:true,  includeRemote:true  }, 'completo'));
on('btn-export-local',  'click', () => doExport({ includeLocal:true,  includeRemote:false }, 'pc'));
on('btn-export-remote', 'click', () => doExport({ includeLocal:false, includeRemote:true  }, 'celular'));

function doExport(opts, suffix) {
  if (!annotation) { toast('Nada para exportar','error'); return; }
  const a = document.createElement('a');
  a.href     = annotation.exportPNG(opts);
  a.download = (currentFile?.name?.replace('.pdf','') ?? 'digicanvas') + `-${suffix}.png`;
  a.click();
  toast('Exportado!', 'success');
}

// ══════════════════════════════════════════════════════════════════════════
// TOGGLES
// ══════════════════════════════════════════════════════════════════════════

on('toggle-remote-strokes', 'change', e => {
  if (annotation) annotation.showRemote = e.target.checked;
  if (remoteCanvas) remoteCanvas.style.display = e.target.checked ? '' : 'none';
  setPref('showRemote', e.target.checked);
});

on('toggle-follow-vp', 'change', e => {
  State.set('followViewport', e.target.checked);
  setPref('followViewport', e.target.checked);
});

on('toggle-zoom-lock-desktop', 'change', e => {
  State.merge('viewport', { locked: e.target.checked });
  setPref('zoomLocked', e.target.checked);
  peer?.send({ type:'state:sync', zoomLocked: e.target.checked });
  toast(e.target.checked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});

on('toggle-grid', 'change', e => {
  setPref('gridEnabled', e.target.checked);
  drawGrid();
});

on('select-clear-mode', 'change', e => {
  const mode = e.target.value;
  if (annotation) annotation.clearMode = mode;
  State.set('clearMode', mode);
  setPref('clearMode', mode);
});

document.querySelectorAll('[data-theme-btn]').forEach(btn => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.themeBtn);
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.toggle('active', b === btn));
    toast('Tema: ' + btn.dataset.themeBtn, 'info');
  });
});

function applyPrefsToUI() {
  const p = getPrefs();
  const chk = (id, v) => { const el=$(id); if (el) el.checked=v; };
  chk('toggle-remote-strokes', p.showRemote ?? true);
  chk('toggle-zoom-lock-desktop', p.zoomLocked ?? false);
  chk('toggle-grid',           p.gridEnabled ?? false);
  chk('toggle-follow-vp',      p.followViewport ?? true);

  const slider=$('stroke-size-slider'); if (slider) slider.value = p.size ?? 3;
  const slbl=$('stroke-size-label');    if (slbl)   slbl.textContent = p.size ?? 3;
  const cm=$('select-clear-mode');      if (cm)     cm.value = p.clearMode ?? 'shared';

  document.querySelectorAll('[data-theme-btn]').forEach(b =>
    b.classList.toggle('active', b.dataset.themeBtn === getTheme())
  );
}

// ══════════════════════════════════════════════════════════════════════════
// RECENTES
// ══════════════════════════════════════════════════════════════════════════

function renderRecents() {
  const c=$('recents-list'); if (!c) return;
  const list = getRecents();
  if (!list.length) { c.innerHTML='<p class="recents-empty">Nenhum arquivo recente</p>'; return; }
  c.innerHTML = list.map(r => `
    <div class="recent-item" data-name="${r.name}">
      <div class="recent-thumb">${r.thumb?`<img src="${r.thumb}" alt="" />`:'<div class="thumb-placeholder">PDF</div>'}</div>
      <div class="recent-info">
        <span class="recent-name" title="${r.name}">${r.name}</span>
        <span class="recent-size">${fmtSize(r.size)}</span>
      </div>
      <button class="recent-remove" data-name="${r.name}">×</button>
    </div>`).join('');
  c.querySelectorAll('.recent-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('recent-remove')) {
        e.stopPropagation(); removeRecent(e.target.dataset.name); renderRecents(); return;
      }
      toast('Use "Abrir PDF" para reabrir','info');
    });
  });
}
const fmtSize = b => !b?'': b<1024?b+'B': b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB';
on('btn-clear-recents','click',()=>{ clearRecents(); renderRecents(); });

// ══════════════════════════════════════════════════════════════════════════
// WEBRTC
// ══════════════════════════════════════════════════════════════════════════

on('btn-generate-code', 'click', async () => {
  if (peer) await peer.disconnect();
  sessionCode = generateCode();
  renderCode(sessionCode);
  $('code-display')?.classList.remove('hidden');
  peer = new DigiPeer({
    role:'host', code:sessionCode,
    onStateChange: handleStateChange,
    onMessage:     handleMessage,
  });
  try { await peer.startAsHost(); }
  catch (err) { toast('Erro: '+err.message,'error',6000); }
});

on('btn-disconnect','click', async () => {
  await peer?.disconnect(); peer=null;
  $('conn-status')?.classList.add('hidden');
  $('conn-setup').style.display='';
  $('code-display')?.classList.add('hidden');
  if (viewportIndicator) viewportIndicator.style.display='none';
  setStatusDot('disconnected');
  const sl=$('status-label'); if (sl) sl.textContent='Desconectado';
});

function handleStateChange(state) {
  setStatusDot(
    state===ConnState.CONNECTED?'connected': state===ConnState.CONNECTING?'connecting':'disconnected'
  );
  const sl=$('status-label');
  if (state===ConnState.CONNECTED) {
    $('conn-setup').style.display='none';
    $('conn-status')?.classList.remove('hidden');
    if (sl) sl.textContent='Conectado';
    toast('📱 Celular conectado!','success');
    State.set('connected', true);
    setTimeout(() => {
      broadcastPdfInfo();
      const prefs = getPrefs();
      peer?.send({ type:'state:sync', zoomLocked:prefs.zoomLocked??false, gridEnabled:prefs.gridEnabled??false, clearMode:prefs.clearMode??'shared' });
    }, 400);
  }
  if (state===ConnState.DISCONNECTED) {
    $('conn-status')?.classList.add('hidden');
    $('conn-setup').style.display='';
    if (viewportIndicator) viewportIndicator.style.display='none';
    if (sl) sl.textContent='Desconectado';
    if (peer) toast('Celular desconectado','error');
    State.set('connected', false);
  }
  if (state===ConnState.ERROR) {
    $('conn-status')?.classList.add('hidden');
    $('conn-setup').style.display='';
    if (sl) sl.textContent='Erro';
    toast('Erro WebRTC','error');
    State.set('connected', false);
  }
}

function handleMessage(msg) {
  if (!msg?.type) return;
  switch (msg.type) {
    // Traços do celular → remoteCanvas do desktop
    case 'stroke:start':
    case 'stroke:move':
    case 'stroke:end':
      annotation?.applyRemoteMessage(msg); break;

    // Limpeza
    case 'clear:all':    annotation?.clear();        break;
    case 'clear:local':  annotation?.clearRemote();  break; // celular limpou os dele → remove camada remota no desktop
    case 'clear:remote': annotation?.clearLocal();   break; // celular pediu que desktop limpe
    case 'clear':        annotation?.[annotation.clearMode==='shared'?'clear':'clearRemote'](); break;
    case 'undo':         annotation?.applyRemoteMessage({type:'undo'});  break;
    case 'redo':         annotation?.applyRemoteMessage({type:'redo:stroke'}); break;

    // Viewport report do celular
    case 'viewport':     receiveViewport(msg); break;

    // Sincronização de estado
    case 'state:sync':
      if (typeof msg.zoomLocked==='boolean') {
        State.merge('viewport',{locked:msg.zoomLocked});
        const el=$('toggle-zoom-lock-desktop'); if (el) el.checked=msg.zoomLocked;
        toast(msg.zoomLocked?'🔒 Zoom travado pelo celular':'🔓 Zoom liberado','info');
        peer?.send({type:'state:sync', zoomLocked:msg.zoomLocked}); // confirma
      }
      break;

    case 'request:pdf': broadcastPdfInfo(); break;
  }
}

// ── Recebe viewport do celular ────────────────────────────────────────────

function receiveViewport({ nx, ny, nw, nh, zoom }) {
  // Clamp antes de tudo — garante invariante mesmo se celular enviar lixo
  const safe_nw = Math.min(Math.max(0.001, nw), 1);
  const safe_nh = Math.min(Math.max(0.001, nh), 1);
  const safe_nx = clamp(nx, 0, Math.max(0, 1 - safe_nw));
  const safe_ny = clamp(ny, 0, Math.max(0, 1 - safe_nh));

  const newVP = { nx:safe_nx, ny:safe_ny, nw:safe_nw, nh:safe_nh, zoom: zoom??1, locked: State.get('viewport')?.locked??false };
  State.set('viewport', newVP);
  positionIndicator(newVP);

  const vx=$('vp-x'); if (vx) vx.textContent=Math.round(safe_nx*100)+'%';
  const vy=$('vp-y'); if (vy) vy.textContent=Math.round(safe_ny*100)+'%';
  const vz=$('vp-zoom'); if (vz) vz.textContent=(zoom??1).toFixed(2)+'×';

  // followViewport (#8)
  if (State.get('followViewport') && canvasWrapper) {
    const dpr = window.devicePixelRatio || 1;
    const W = pdfCanvas.width/dpr, H = pdfCanvas.height/dpr;
    const cx = safe_nx*W, cy = safe_ny*H, iw = safe_nw*W, ih = safe_nh*H;
    canvasWrapper.scrollTo({
      left: cx - canvasWrapper.clientWidth/2  + iw/2,
      top:  cy - canvasWrapper.clientHeight/2 + ih/2,
      behavior: 'smooth',
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// QR CODE — robusto, com fallback (#7)
// ══════════════════════════════════════════════════════════════════════════

function renderCode(code) {
  const el=$('code-digits'); if (!el) return;
  el.innerHTML='';
  code.split('').forEach((d,i) => {
    const s=document.createElement('div');
    s.className='digit'; s.textContent=d;
    s.style.animationDelay=`${i*60}ms`;
    el.appendChild(s);
  });
  renderQR(code);
}

function renderQR(code) {
  const qrEl=$('code-qr'); if (!qrEl) return;
  qrEl.innerHTML='';

  // Constrói URL corretamente para qualquer host
  let url;
  try {
    const u = new URL(location.href);
    // Remove index.html e qualquer query/hash
    u.pathname = u.pathname.replace(/\/[^/]*$/, '/') + 'celular.html';
    u.search = ''; u.hash = '';
    url = u.toString() + '?code=' + code;
  } catch {
    url = './celular.html?code=' + code;
  }

  const linkEl=$('qr-link'); if (linkEl) linkEl.textContent=url;

  const render = () => {
    qrEl.innerHTML='';
    if (typeof QRCode==='undefined') { showQRFallback(qrEl, url); return; }
    try {
      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      new QRCode(qrEl, { // eslint-disable-line no-undef
        text: url, width:128, height:128,
        colorDark:'#7c6af7',
        colorLight: isDark ? '#1e1e2e' : '#ffffff',
        correctLevel: QRCode.CorrectLevel.M, // eslint-disable-line no-undef
      });
    } catch { showQRFallback(qrEl, url); }
  };

  if (typeof QRCode!=='undefined') { render(); return; }
  const s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  s.onload=render; s.onerror=()=>showQRFallback(qrEl, url);
  document.head.appendChild(s);
}

function showQRFallback(el, url) {
  el.innerHTML = `<div class="qr-fallback"><span>URL do celular:</span>
    <input readonly value="${url}" onclick="this.select()"
      style="font-size:9px;width:100%;margin-top:4px;padding:5px;
             background:var(--bg3);border:1px solid var(--border);
             border-radius:4px;color:var(--text);" /></div>`;
}

function setStatusDot(s) {
  const el=$('status-dot'); if (el) el.className=`status-dot ${s}`;
}

// ══════════════════════════════════════════════════════════════════════════
// ATALHOS
// ══════════════════════════════════════════════════════════════════════════

shortcuts.on('undo',    () => { if (annotation?.undo()) peer?.send({type:'undo'}); });
shortcuts.on('redo',    () => { if (annotation?.redo()) peer?.send({type:'redo'}); });
shortcuts.on('clear',   () => { annotation?.clear(); peer?.send({type:'clear:all'}); });
shortcuts.on('export',  () => doExport({includeLocal:true,includeRemote:true},'completo'));
shortcuts.on('open',    () => $('file-input')?.click());
shortcuts.on('zoom-in', () => viewer?.zoomIn());
shortcuts.on('zoom-out',() => viewer?.zoomOut());
shortcuts.on('zoom-fit',() => viewer?.fitToContainer(canvasWrapper));
shortcuts.on('prev-page',()=> viewer?.prevPage());
shortcuts.on('next-page',()=> viewer?.nextPage());
shortcuts.on('toggle-grid', () => {
  const el=$('toggle-grid'); if (el){el.checked=!el.checked; el.dispatchEvent(new Event('change'));}
});
shortcuts.on('toggle-theme', () => {
  const themes=['dark','light','amoled'];
  const next=themes[(themes.indexOf(getTheme())+1)%themes.length];
  setTheme(next); toast('Tema: '+next,'info');
});
['pen','marker','highlighter','eraser','line','rect'].forEach(t =>
  shortcuts.on(`tool:${t}`, () => document.querySelector(`.tool-btn[data-tool="${t}"]`)?.click())
);
