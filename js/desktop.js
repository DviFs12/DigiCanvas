/**
 * desktop.js — Controller principal do PC
 *
 * FIXES:
 * 1. initCanvas(): removido guard "if (annot) return" que impedia criar viewer
 *    quando o usuário abria um PDF após clicar em Modo Demo.
 * 2. viewer.onRender: agora chama positionVP() após cada re-render, corrigindo
 *    o indicador de viewport que sumia ao trocar zoom/página.
 * 3. Semântica clear corrigida: clear:pc / clear:mobile (perspectiva-independente).
 *    clearPC() e clearMobile() em vez de clearLocal() / clearRemote().
 * 4. handleMsg: recebe 'clear:mobile' do celular → chama annot.clearMobile().
 * 5. exportAnnotatedPDF(): exporta PDF com traços sobrepostos via pdf-lib.
 *
 * PROTOCOLO DE MENSAGENS:
 *   PC → Celular:
 *     pdf:size  { w, h }
 *     pdf:thumb { data: jpegDataURL }
 *     pdf:page  { page, total }
 *     pdf:swapping
 *     stroke:start/move/end  { id, tool, color, size, nx, ny, page }
 *     clear:pc    { page? }   — limpa traços do PC
 *     clear:mobile { page? }  — limpa traços do celular
 *     clear:all
 *     undo / redo
 *     state:sync { zoomLocked, gridEnabled }
 *     viewport:set { nx, ny }
 *
 *   Celular → PC:
 *     stroke:start/move/end  { id, tool, color, size, nx, ny, page }
 *     clear:mobile { page? } — celular limpou os próprios traços
 *     clear:all
 *     undo
 *     viewport { nx, ny, nw, nh, zoom }
 *     state:sync { zoomLocked }
 *     request:pdf
 */

import { generateCode }    from './signaling.js';
import { Peer, CS }        from './webrtc.js';
import { PDFViewer }       from './pdfviewer.js';
import { Annotation }      from './annotation.js';
import {
  getTheme, setTheme, applyTheme, cycleTheme,
  getPrefs, setPref,
  getRecents, addRecent, removeRecent, clearRecents,
  toast, showLoading, hideLoading,
} from './utils.js';

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const on  = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
const qsa = sel => document.querySelectorAll(sel);

// ── Canvas elements ────────────────────────────────────────────────────────────
const cWrapper = $('canvas-wrapper');
const cPDF     = $('pdf-canvas');
const cAnnot   = $('annotation-canvas');
const cRemote  = $('remote-canvas');
const cGrid    = $('grid-canvas');
const cVP      = $('vp-indicator');

// ── Core state ─────────────────────────────────────────────────────────────────
let viewer   = null;
let annot    = null;
let peer     = null;
let code     = null;
let strokeId = 0;

// Viewport do celular (normalizado)
let vpState  = { nx: 0, ny: 0, nw: 1, nh: 1, zoom: 1 };
let followVP = true;
let pcMode   = 'draw'; // 'draw' | 'move'

// ── Init ───────────────────────────────────────────────────────────────────────
applyTheme();
renderRecents();
restorePrefs();

// ══════════════════════════════════════════════════════════════════════════════
// ABERTURA DE PDF
// ══════════════════════════════════════════════════════════════════════════════

on('file-input',        'change', e => openPDF(e.target.files[0]));
on('file-input-change', 'change', e => openPDF(e.target.files[0]));

async function openPDF(file) {
  if (!file) return;
  const isSwap = !!viewer?.doc;
  showLoading('Carregando PDF…');
  try {
    const buf = await file.arrayBuffer();
    $('pdf-filename').textContent = file.name;
    showMain();
    initCanvas();

    if (isSwap && peer?.state === CS.CONNECTED) {
      peer.send({ type: 'pdf:swapping' });
      annot.clearMobile();
      toast('PDF trocado — conexão mantida ✓', 'success', 2500);
    }

    viewer.filename = file.name.replace(/\.pdf$/i, '');
    await viewer.load(buf);

    const thumb = await viewer.thumbnail(120);
    addRecent({ name: file.name, size: file.size, thumb });
    renderRecents();
  } catch (e) {
    toast('Erro ao abrir PDF: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

on('btn-demo', 'click', () => {
  showMain();
  initCanvas();
  const dpr = window.devicePixelRatio || 1;
  const W   = Math.round(794 * dpr);
  const H   = Math.round(1123 * dpr);
  [cPDF, cAnnot, cRemote, cGrid].forEach(c => {
    if (!c) return;
    c.width  = W; c.height = H;
    c.style.width  = '794px'; c.style.height = '1123px';
  });
  const ctx = cPDF.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('DigiCanvas — Modo Demo', 397, 80);
  ctx.font = '14px sans-serif'; ctx.fillStyle = '#888';
  ['Abra um PDF ou conecte o celular.', '1 dedo = desenha  |  2 dedos = move/zoom']
    .forEach((t, i) => ctx.fillText(t, 397, 130 + i * 28));
  ctx.restore();
  $('page-info').textContent = '1 / 1';
  annot?.onResize();
  drawGrid();
  broadcastPDF();
});

function showMain() {
  $('screen-welcome')?.classList.remove('active');
  const sm = $('screen-main');
  if (sm) { sm.classList.add('active'); sm.style.display = 'flex'; }
}

// ── Init canvas + viewer + annotation ─────────────────────────────────────────

/**
 * FIX: Guard reescrito para permitir:
 * - Criar annot apenas uma vez (reutilizável entre PDFs e demo)
 * - Criar viewer apenas quando ainda não existe (necessário após demo → PDF)
 */
function initCanvas() {
  // Annotation é reutilizável entre PDFs, cria apenas uma vez
  if (!annot) {
    annot = new Annotation(cAnnot, cRemote);
    annot.onStart = ({ tool, color, size, nx, ny, page }) => {
      strokeId++;
      annot._curId = `h${strokeId}`;
      peer?.send({ type: 'stroke:start', id: annot._curId, tool, color, size, nx, ny, page });
    };
    annot.onMove = ({ nx, ny }) => peer?.send({ type: 'stroke:move', id: annot._curId, nx, ny });
    annot.onEnd  = ()           => peer?.send({ type: 'stroke:end',  id: annot._curId });
  }

  // FIX: viewer sempre recriado ao abrir PDF real (demo não usa viewer)
  if (!viewer) {
    viewer = new PDFViewer(cPDF);
    viewer.onRender = (page, total) => {
      $('page-info').textContent  = `${page} / ${total}`;
      $('zoom-level').textContent = Math.round(viewer.scale * 100) + '%';

      // Sincroniza tamanho dos canvas overlay com o PDF
      [cAnnot, cRemote, cGrid].forEach(c => {
        if (!c) return;
        c.width        = cPDF.width;
        c.height       = cPDF.height;
        c.style.width  = cPDF.style.width;
        c.style.height = cPDF.style.height;
      });

      annot.setPage(page);
      annot.onResize();
      drawGrid();

      // FIX: atualiza indicador de viewport após mudança de tamanho do canvas
      positionVP();

      broadcastPDF();
      peer?.send({ type: 'pdf:page', page, total });
    };
  }
}

// ── Grid ───────────────────────────────────────────────────────────────────────

function drawGrid() {
  if (!cGrid) return;
  const ctx = cGrid.getContext('2d');
  ctx.clearRect(0, 0, cGrid.width, cGrid.height);
  if (!getPrefs().gridEnabled) return;
  const dpr  = window.devicePixelRatio || 1;
  const step = 40 * dpr;
  ctx.strokeStyle = 'rgba(124,106,247,0.18)';
  ctx.lineWidth   = 0.5;
  for (let x = 0; x < cGrid.width;  x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cGrid.height); ctx.stroke(); }
  for (let y = 0; y < cGrid.height; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cGrid.width, y);  ctx.stroke(); }
}

// ── Broadcast PDF ao celular ───────────────────────────────────────────────────

async function broadcastPDF() {
  if (!peer || peer.state !== CS.CONNECTED || !cPDF.width) return;
  const dpr = window.devicePixelRatio || 1;
  const w   = cPDF.width  / dpr;
  const h   = cPDF.height / dpr;
  peer.send({ type: 'pdf:size', w, h });

  try {
    let thumb;
    if (viewer?.doc) {
      thumb = await viewer.thumbnail(320);
    } else {
      // Demo mode: captura canvas direto
      const t = document.createElement('canvas');
      const s = Math.min(1, 320 / w);
      t.width  = Math.round(w * s);
      t.height = Math.round(h * s);
      t.getContext('2d').drawImage(cPDF, 0, 0, t.width, t.height);
      thumb = t.toDataURL('image/jpeg', 0.65);
    }
    if (thumb) peer.send({ type: 'pdf:thumb', data: thumb });
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLES DO PDF
// ══════════════════════════════════════════════════════════════════════════════

on('btn-prev',    'click', () => viewer?.prev());
on('btn-next',    'click', () => viewer?.next());
on('btn-zoom-in', 'click', () => viewer?.zoomIn());
on('btn-zoom-out','click', () => viewer?.zoomOut());
on('btn-fit',     'click', () => viewer?.fit(cWrapper));

cWrapper?.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  e.deltaY < 0 ? viewer?.zoomIn(0.1) : viewer?.zoomOut(0.1);
}, { passive: false });

// ══════════════════════════════════════════════════════════════════════════════
// MODOS: draw | move
// ══════════════════════════════════════════════════════════════════════════════

function setMode(m) {
  pcMode = m;
  qsa('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('mode-label').textContent = m === 'draw' ? 'Desenhar' : 'Mover VP';
  annot?.setEnabled(m === 'draw');
  if (cAnnot) cAnnot.style.cursor = m === 'draw' ? 'crosshair' : 'default';
  if (cVP)    cVP.style.pointerEvents = m === 'move' ? 'all' : 'none';
}

qsa('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// Drag do indicador de viewport
let _vpDrag = null;
cVP?.addEventListener('pointerdown', e => {
  if (pcMode !== 'move') return;
  e.preventDefault();
  cVP.setPointerCapture(e.pointerId);
  _vpDrag = { sx: e.clientX, sy: e.clientY, nx0: vpState.nx, ny0: vpState.ny };
  cVP.style.cursor = 'grabbing';
});
cVP?.addEventListener('pointermove', e => {
  if (!_vpDrag) return;
  e.preventDefault();
  const dpr = window.devicePixelRatio || 1;
  const W   = cPDF.width / dpr;
  const H   = cPDF.height / dpr;
  const dx  = e.clientX - _vpDrag.sx;
  const dy  = e.clientY - _vpDrag.sy;
  const nx  = Math.max(0, Math.min(_vpDrag.nx0 + dx / W, Math.max(0, 1 - vpState.nw)));
  const ny  = Math.max(0, Math.min(_vpDrag.ny0 + dy / H, Math.max(0, 1 - vpState.nh)));
  vpState   = { ...vpState, nx, ny };
  positionVP();
  peer?.send({ type: 'viewport:set', nx, ny });
});
cVP?.addEventListener('pointerup',     () => { _vpDrag = null; if (pcMode === 'move') cVP.style.cursor = 'grab'; });
cVP?.addEventListener('pointercancel', () => { _vpDrag = null; });

function positionVP() {
  if (!cVP) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = cPDF.width  / dpr;
  const H   = cPDF.height / dpr;
  if (!W || !H) return;
  const { nx, ny, nw, nh } = vpState;
  const x = nx * W;
  const y = ny * H;
  const w = Math.max(8, nw * W);
  const h = Math.max(8, nh * H);
  const cx = Math.max(0, Math.min(x, W - w));
  const cy = Math.max(0, Math.min(y, H - h));
  Object.assign(cVP.style, {
    display: 'block',
    left:    cx + 'px',
    top:     cy + 'px',
    width:   w  + 'px',
    height:  h  + 'px',
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// FERRAMENTAS DE ANOTAÇÃO
// ══════════════════════════════════════════════════════════════════════════════

qsa('[data-tool]').forEach(b => b.addEventListener('click', () => {
  qsa('[data-tool]').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  annot?.setTool(b.dataset.tool);
  setPref('tool', b.dataset.tool);
  if (pcMode !== 'draw') setMode('draw');
}));

on('stroke-color', 'input', e => { annot?.setColor(e.target.value); setPref('color', e.target.value); });
on('stroke-size',  'input', e => {
  const v = parseInt(e.target.value);
  annot?.setSize(v); setPref('size', v);
  const lbl = $('stroke-size-label'); if (lbl) lbl.textContent = v;
});

on('btn-undo', 'click', () => { if (annot?.undo()) peer?.send({ type: 'undo' }); });
on('btn-redo', 'click', () => { if (annot?.redo()) peer?.send({ type: 'redo' }); });

// FIX: semântica corrigida — clear:pc e clear:mobile em vez de local/remote
on('btn-clear-all',    'click', () => {
  annot?.clearAll();
  peer?.send({ type: 'clear:all' });
});
on('btn-clear-local',  'click', () => {
  annot?.clearPC();
  peer?.send({ type: 'clear:pc' });
});
on('btn-clear-remote', 'click', () => {
  annot?.clearMobile();
  peer?.send({ type: 'clear:mobile' });
});

// ── Export ────────────────────────────────────────────────────────────────────

on('btn-export', 'click', async () => {
  if (!annot) return;
  // Se tem PDF com anotações, exporta PDF completo; caso contrário, PNG da tela
  if (viewer?.doc && annot.getAnnotatedPages().length > 0) {
    await exportAnnotatedPDF();
  } else {
    const a = document.createElement('a');
    a.href     = annot.exportCurrentPagePNG(cPDF);
    a.download = (viewer?.filename || 'digicanvas') + '.png';
    a.click();
  }
});

/**
 * Exporta o PDF original com as anotações (PC + celular) sobrepostas como
 * camada PNG transparente em cada página anotada.
 * Usa pdf-lib via CDN — carregado dinamicamente na primeira chamada.
 */
async function exportAnnotatedPDF() {
  if (!viewer?.doc || !viewer.rawBuffer) {
    toast('Buffer do PDF não disponível. Reabra o arquivo.', 'error');
    return;
  }

  showLoading('Gerando PDF anotado…');

  try {
    // Importa pdf-lib dinamicamente
    const { PDFDocument } = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');

    const pdfDoc = await PDFDocument.load(viewer.rawBuffer);
    const pages  = pdfDoc.getPages();
    const tmp    = document.createElement('canvas');
    const ctx    = tmp.getContext('2d');
    const SCALE  = 2; // resolução 2× para qualidade

    let annotatedCount = 0;

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1;
      const strokes = annot.getStrokes(pageNum, 'all');
      if (!strokes.length) continue;
      annotatedCount++;

      const pdfPage = pages[i];
      const { width: pW, height: pH } = pdfPage.getSize();

      tmp.width  = Math.round(pW * SCALE);
      tmp.height = Math.round(pH * SCALE);

      // Fundo transparente — apenas os traços serão sobrepostos
      ctx.clearRect(0, 0, tmp.width, tmp.height);

      // Desenha todos os traços da página neste canvas de exportação
      _drawStrokesForExport(ctx, strokes, tmp.width, tmp.height, SCALE);

      // Converte para PNG (suporta transparência)
      const pngBytes = await new Promise((resolve, reject) => {
        tmp.toBlob(blob => {
          if (!blob) { reject(new Error('Falha ao gerar PNG da página ' + pageNum)); return; }
          blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
        }, 'image/png');
      });

      const pngImg = await pdfDoc.embedPng(pngBytes);

      // Sobrepõe a camada de anotação sobre a página original
      pdfPage.drawImage(pngImg, { x: 0, y: 0, width: pW, height: pH });
    }

    if (annotatedCount === 0) {
      toast('Nenhuma anotação encontrada no documento.', 'info');
      return;
    }

    const bytes    = await pdfDoc.save();
    const blob     = new Blob([bytes], { type: 'application/pdf' });
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    a.href         = url;
    a.download     = (viewer.filename || 'digicanvas') + '_anotado.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15_000);

    toast(`PDF exportado com ${annotatedCount} página(s) anotada(s) ✓`, 'success');
  } catch (e) {
    console.error('[Export]', e);
    toast('Erro ao exportar PDF: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Renderiza strokes num canvas de exportação (sem DPR — usa SCALE direto).
 * Mantida separada de Annotation._drawFull para não poluir a classe principal.
 */
function _drawStrokesForExport(ctx, strokes, W, H, SCALE) {
  const TOOLS_DEF = {
    pen:         { mul: 1.0, alpha: 1.0,  op: 'source-over'     },
    marker:      { mul: 2.5, alpha: 1.0,  op: 'source-over'     },
    highlighter: { mul: 8.0, alpha: 0.35, op: 'source-over'     },
    eraser:      { mul: 5.0, alpha: 1.0,  op: 'destination-out' },
    line:        { mul: 1.5, alpha: 1.0,  op: 'source-over'     },
    rect:        { mul: 1.5, alpha: 1.0,  op: 'source-over'     },
  };

  const n2x = nx => nx * W;
  const n2y = ny => ny * H;

  strokes.forEach(s => {
    const pts = s.points;
    if (!pts?.length) return;
    const t = TOOLS_DEF[s.tool] ?? TOOLS_DEF.pen;

    ctx.save();
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';
    ctx.globalCompositeOperation = t.op;
    ctx.globalAlpha  = t.alpha;
    ctx.strokeStyle  = s.tool === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
    ctx.fillStyle    = ctx.strokeStyle;
    ctx.lineWidth    = s.size * t.mul * SCALE;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(n2x(pts[0].nx), n2y(pts[0].ny), Math.max(0.5, ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (s.tool === 'line') {
      ctx.beginPath();
      ctx.moveTo(n2x(pts[0].nx),            n2y(pts[0].ny));
      ctx.lineTo(n2x(pts[pts.length-1].nx), n2y(pts[pts.length-1].ny));
      ctx.stroke();
    } else if (s.tool === 'rect') {
      const ax = n2x(pts[0].nx),            ay = n2y(pts[0].ny);
      const bx = n2x(pts[pts.length-1].nx), by = n2y(pts[pts.length-1].ny);
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
    } else {
      ctx.beginPath();
      ctx.moveTo(n2x(pts[0].nx), n2y(pts[0].ny));
      if (pts.length === 2) {
        ctx.lineTo(n2x(pts[1].nx), n2y(pts[1].ny));
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const cx = n2x(pts[i].nx),    cy = n2y(pts[i].ny);
          const nx = n2x(pts[i+1].nx),  ny = n2y(pts[i+1].ny);
          ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
        }
        ctx.lineTo(n2x(pts[pts.length-1].nx), n2y(pts[pts.length-1].ny));
      }
      ctx.stroke();
    }
    ctx.restore();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TOGGLES DO PAINEL
// ══════════════════════════════════════════════════════════════════════════════

on('toggle-remote', 'change', e => {
  if (annot) annot.showRemote = e.target.checked;
  if (cRemote) cRemote.style.display = e.target.checked ? '' : 'none';
  setPref('showRemote', e.target.checked);
});

on('toggle-grid', 'change', e => { setPref('gridEnabled', e.target.checked); drawGrid(); });

on('toggle-follow', 'change', e => {
  followVP = e.target.checked;
  setPref('followVP', followVP);
  syncFollowBtn();
});

on('toggle-zoom-lock', 'change', e => {
  setPref('zoomLocked', e.target.checked);
  peer?.send({ type: 'state:sync', zoomLocked: e.target.checked });
  toast(e.target.checked ? '🔒 Zoom travado' : '🔓 Zoom liberado', 'info');
});

on('btn-follow-toggle', 'click', () => {
  followVP = !followVP;
  setPref('followVP', followVP);
  const chk = $('toggle-follow'); if (chk) chk.checked = followVP;
  syncFollowBtn();
  toast(followVP ? '🔗 Acompanhando viewport' : '🔓 Viewport livre', 'info');
});

function syncFollowBtn() {
  const btn = $('btn-follow-toggle'); if (!btn) return;
  btn.classList.toggle('active', followVP);
  btn.title = followVP ? 'Viewport livre (K)' : 'Acompanhar viewport (K)';
}

qsa('[data-theme]').forEach(b => b.addEventListener('click', () => {
  setTheme(b.dataset.theme);
  qsa('[data-theme]').forEach(x => x.classList.toggle('active', x === b));
  toast('Tema: ' + b.dataset.theme, 'info');
}));

// ══════════════════════════════════════════════════════════════════════════════
// ATALHOS DE TECLADO
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  const key = (e.ctrlKey || e.metaKey ? 'c+' : '') + (e.shiftKey ? 's+' : '') + e.key.toLowerCase();
  const map = {
    'arrowleft': 'prev', 'arrowright': 'next',
    'c+z': 'undo', 'c+s+z': 'redo',
    'p': 'pen', 'm': 'marker', 'h': 'highlighter', 'e': 'eraser', 'l': 'line', 'r': 'rect',
    'd': 'draw', 'v': 'move', 'f': 'fit', 'g': 'grid', 'k': 'follow', 't': 'theme',
    '+': 'zoomin', '-': 'zoomout', 'c+e': 'export', 'c+o': 'open',
  };
  const act = map[key]; if (!act) return;
  e.preventDefault();
  ({
    prev:        () => viewer?.prev(),
    next:        () => viewer?.next(),
    undo:        () => { if (annot?.undo()) peer?.send({ type: 'undo' }); },
    redo:        () => { if (annot?.redo()) peer?.send({ type: 'redo' }); },
    pen:         () => document.querySelector('[data-tool="pen"]')?.click(),
    marker:      () => document.querySelector('[data-tool="marker"]')?.click(),
    highlighter: () => document.querySelector('[data-tool="highlighter"]')?.click(),
    eraser:      () => document.querySelector('[data-tool="eraser"]')?.click(),
    line:        () => document.querySelector('[data-tool="line"]')?.click(),
    rect:        () => document.querySelector('[data-tool="rect"]')?.click(),
    draw:        () => setMode('draw'),
    move:        () => setMode('move'),
    fit:         () => viewer?.fit(cWrapper),
    grid:        () => { const el = $('toggle-grid'); if (el) { el.checked = !el.checked; el.dispatchEvent(new Event('change')); } },
    follow:      () => $('btn-follow-toggle')?.click(),
    theme:       () => { const t = cycleTheme(); toast('Tema: ' + t, 'info'); },
    zoomin:      () => viewer?.zoomIn(),
    zoomout:     () => viewer?.zoomOut(),
    export:      () => $('btn-export')?.click(),
    open:        () => $('file-input')?.click(),
  })[act]?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// WEBRTC — HOST
// ══════════════════════════════════════════════════════════════════════════════

on('btn-generate', 'click', async () => {
  if (peer) await peer.disconnect();
  code = generateCode();
  renderCode(code);
  $('code-display')?.classList.remove('hidden');
  peer = new Peer({ role: 'host', code, onState: handleState, onMsg: handleMsg });
  try { await peer.startHost(); }
  catch (err) { toast('Erro ao criar sessão: ' + err.message, 'error', 5000); }
});

on('btn-disconnect', 'click', async () => {
  await peer?.disconnect();
  peer = null;
  $('conn-badge')?.classList.add('hidden');
  $('conn-setup').style.display = '';
  $('code-display')?.classList.add('hidden');
  if (cVP) cVP.style.display = 'none';
  setDot('disconnected');
});

function handleState(s) {
  setDot(s === CS.CONNECTED ? 'connected' : s === CS.CONNECTING ? 'connecting' : 'disconnected');

  if (s === CS.CONNECTED) {
    $('conn-setup').style.display = 'none';
    $('conn-badge')?.classList.remove('hidden');
    toast('📱 Celular conectado!', 'success');
    setTimeout(() => {
      broadcastPDF();
      peer?.send({ type: 'pdf:page', page: viewer?.page ?? 1, total: viewer?.total ?? 1 });
      peer?.send({
        type:        'state:sync',
        zoomLocked:  getPrefs().zoomLocked  ?? false,
        gridEnabled: getPrefs().gridEnabled ?? false,
      });
    }, 400);
  }

  if (s === CS.DISCONNECTED) {
    $('conn-badge')?.classList.add('hidden');
    $('conn-setup').style.display = '';
    if (cVP) cVP.style.display = 'none';
    if (peer) toast('Celular desconectado', 'error');
  }
}

function handleMsg(msg) {
  if (!msg?.type) return;
  switch (msg.type) {

    case 'stroke:start':
    case 'stroke:move':
    case 'stroke:end':
    case 'undo':
      annot?.applyMsg(msg);
      break;

    case 'clear:all':
      annot?.applyMsg(msg);
      break;

    // FIX: celular enviou 'clear:mobile' = limpou os próprios traços.
    // No PC, os traços do celular ficam em _remote → clearMobile()
    case 'clear:mobile':
      annot?.applyMsg(msg); // applyMsg sabe lidar com page opcional
      break;

    case 'viewport':
      receiveVP(msg);
      break;

    case 'state:sync':
      if (typeof msg.zoomLocked === 'boolean') {
        setPref('zoomLocked', msg.zoomLocked);
        const el = $('toggle-zoom-lock'); if (el) el.checked = msg.zoomLocked;
        toast(msg.zoomLocked ? '🔒 Zoom travado pelo celular' : '🔓 Zoom liberado', 'info');
        peer?.send({ type: 'state:sync', zoomLocked: msg.zoomLocked });
      }
      break;

    case 'request:pdf':
      broadcastPDF();
      peer?.send({ type: 'pdf:page', page: viewer?.page ?? 1, total: viewer?.total ?? 1 });
      break;
  }
}

function receiveVP({ nx, ny, nw, nh, zoom }) {
  const snw = Math.max(0.001, Math.min(1, nw));
  const snh = Math.max(0.001, Math.min(1, nh));
  const snx = Math.max(0, Math.min(nx, 1 - snw));
  const sny = Math.max(0, Math.min(ny, 1 - snh));
  vpState   = { nx: snx, ny: sny, nw: snw, nh: snh, zoom: zoom ?? 1 };
  positionVP();
  const vx = $('vp-x'), vy = $('vp-y'), vz = $('vp-zoom');
  if (vx) vx.textContent = Math.round(snx * 100) + '%';
  if (vy) vy.textContent = Math.round(sny * 100) + '%';
  if (vz) vz.textContent = (zoom ?? 1).toFixed(2) + '×';
  if (followVP && cWrapper) {
    const dpr = window.devicePixelRatio || 1;
    const W   = cPDF.width  / dpr;
    const H   = cPDF.height / dpr;
    cWrapper.scrollTo({
      left:     snx * W - cWrapper.clientWidth  / 2 + snw * W / 2,
      top:      sny * H - cWrapper.clientHeight / 2 + snh * H / 2,
      behavior: 'smooth',
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// QR CODE
// ══════════════════════════════════════════════════════════════════════════════

function renderCode(c) {
  const el = $('code-digits'); if (!el) return;
  el.innerHTML = '';
  c.split('').forEach((d, i) => {
    const s = document.createElement('div');
    s.className = 'digit'; s.textContent = d; s.style.animationDelay = (i * 60) + 'ms';
    el.appendChild(s);
  });

  const qrEl = $('code-qr'); if (!qrEl) return;
  qrEl.innerHTML = '';

  let url;
  try {
    const u = new URL(location.href);
    u.pathname = u.pathname.replace(/\/[^/]*$/, '/') + 'celular.html';
    u.search   = '';
    url        = u.href + '?code=' + c;
  } catch { url = './celular.html?code=' + c; }

  const lnk = $('qr-link'); if (lnk) lnk.textContent = url;

  const render = () => {
    qrEl.innerHTML = '';
    if (typeof QRCode === 'undefined') {
      qrEl.innerHTML = `<input readonly value="${url}" style="font-size:10px;width:100%;padding:4px"/>`;
      return;
    }
    try {
      new QRCode(qrEl, {
        text:         url,
        width:        120,
        height:       120,
        colorDark:    '#7c6af7',
        colorLight:   '#1e1e2e',
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch {}
  };

  if (typeof QRCode !== 'undefined') {
    render();
  } else {
    const s    = document.createElement('script');
    s.src      = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload   = render;
    s.onerror  = () => { if (lnk) lnk.style.fontWeight = 'bold'; }; // fallback: mostra link
    document.head.appendChild(s);
  }
}

function setDot(s) {
  const el = $('status-dot'); if (el) el.className = 'dot ' + s;
}

// ══════════════════════════════════════════════════════════════════════════════
// RECENTES
// ══════════════════════════════════════════════════════════════════════════════

function renderRecents() {
  const c    = $('recents-list'); if (!c) return;
  const list = getRecents();
  if (!list.length) {
    c.innerHTML = '<p class="recents-empty">Nenhum arquivo recente</p>';
    return;
  }
  c.innerHTML = list.map(r => `
    <div class="recent-item" data-name="${r.name}">
      <div class="recent-thumb">${r.thumb ? `<img src="${r.thumb}"/>` : '<div class="rec-ph">PDF</div>'}</div>
      <div class="recent-info">
        <span class="recent-name" title="${r.name}">${r.name}</span>
        <span class="recent-meta">${fmtSize(r.size)}</span>
      </div>
      <button class="recent-del" data-name="${r.name}">×</button>
    </div>`).join('');
  c.querySelectorAll('.recent-del').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); removeRecent(b.dataset.name); renderRecents();
  }));
  c.querySelectorAll('.recent-item').forEach(el => el.addEventListener('click', e => {
    if (e.target.classList.contains('recent-del')) return;
    toast('Use "Abrir PDF" para reabrir o arquivo', 'info');
  }));
}

const fmtSize = b => !b ? '' : b < 1024 ? b + 'B' : b < 1_048_576 ? (b / 1024).toFixed(1) + 'KB' : (b / 1_048_576).toFixed(1) + 'MB';
on('btn-clear-recents', 'click', () => { clearRecents(); renderRecents(); });

// ══════════════════════════════════════════════════════════════════════════════
// RESTORE PREFS
// ══════════════════════════════════════════════════════════════════════════════

function restorePrefs() {
  const p   = getPrefs();
  const chk = (id, v) => { const el = $(id); if (el) el.checked = v; };
  chk('toggle-remote',    p.showRemote  ?? true);
  chk('toggle-grid',      p.gridEnabled ?? false);
  chk('toggle-follow',    p.followVP    ?? true);
  chk('toggle-zoom-lock', p.zoomLocked  ?? false);
  followVP = p.followVP ?? true;
  syncFollowBtn();

  const ss = $('stroke-size');       if (ss) ss.value = p.size  ?? 3;
  const sl = $('stroke-size-label'); if (sl) sl.textContent = p.size ?? 3;
  const sc = $('stroke-color');      if (sc) sc.value = p.color ?? '#e63946';

  const toolBtn = document.querySelector(`[data-tool="${p.tool || 'pen'}"]`);
  if (toolBtn) { qsa('[data-tool]').forEach(x => x.classList.remove('active')); toolBtn.classList.add('active'); }

  qsa('[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === getTheme()));
}
