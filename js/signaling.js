/**
 * signaling.js
 * ────────────
 * Gerencia a troca de sinais WebRTC (offer, answer, ICE candidates)
 * usando Firebase Realtime Database como servidor de sinalização.
 *
 * Estrutura no Firebase:
 *   /sessions/{code}/
 *     offer:       RTCSessionDescription
 *     answer:      RTCSessionDescription
 *     hostICE:     { [id]: RTCIceCandidate }
 *     guestICE:    { [id]: RTCIceCandidate }
 *     createdAt:   timestamp
 */

import { FIREBASE_CONFIG, DEMO_MODE } from './firebase-config.js';

// ── Inicialização dinâmica do Firebase SDK ──────────────────────────────────

let db = null;
let isFirebaseReady = false;

async function initFirebase() {
  if (isFirebaseReady || DEMO_MODE) return;

  try {
    // Carrega Firebase dinamicamente via CDN
    const { initializeApp } = await import(
      'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'
    );
    const { getDatabase, ref, set, get, onValue, push, off } = await import(
      'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js'
    );

    const app = initializeApp(FIREBASE_CONFIG);
    db = getDatabase(app);
    isFirebaseReady = true;

    // Re-exporta funções do RTDB para uso neste módulo
    window.__fbDB = { ref, set, get, onValue, push, off, db };

    console.log('[Signaling] Firebase inicializado');
  } catch (err) {
    console.error('[Signaling] Erro ao inicializar Firebase:', err);
    throw new Error('Falha ao conectar ao Firebase. Verifique firebase-config.js');
  }
}

// ── Gerador de código ───────────────────────────────────────────────────────

export function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Listeners ativos (para cleanup) ────────────────────────────────────────
const activeListeners = new Map();

function offRef(key) {
  if (activeListeners.has(key)) {
    const { ref: r, cb } = activeListeners.get(key);
    window.__fbDB?.off(r, 'value', cb);
    activeListeners.delete(key);
  }
}

// ── Classe principal ────────────────────────────────────────────────────────

export class SignalingChannel {
  constructor(code, role) {
    this.code   = code;
    this.role   = role; // 'host' | 'guest'
    this.prefix = `/sessions/${code}`;
  }

  async init() {
    if (DEMO_MODE) return; // modo demo não precisa de Firebase
    await initFirebase();
  }

  // Cria a sessão no Firebase (chamado pelo host)
  async createSession() {
    if (DEMO_MODE) { this._setupDemoMode(); return; }

    const { ref, set, db } = window.__fbDB;
    await set(ref(db, `${this.prefix}/createdAt`), Date.now());
    await set(ref(db, `${this.prefix}/status`), 'waiting');
    console.log(`[Signaling] Sessão criada: ${this.code}`);
  }

  // Verifica se sessão existe (chamado pelo guest)
  async sessionExists() {
    if (DEMO_MODE) return true;

    const { ref, get, db } = window.__fbDB;
    const snap = await get(ref(db, `${this.prefix}/createdAt`));
    return snap.exists();
  }

  // Publica offer (host)
  async sendOffer(sdp) {
    if (DEMO_MODE) { this._demoSend('offer', sdp); return; }

    const { ref, set, db } = window.__fbDB;
    await set(ref(db, `${this.prefix}/offer`), sdp);
  }

  // Ouve offer (guest)
  onOffer(callback) {
    if (DEMO_MODE) { this._demoOn('offer', callback); return () => {}; }

    const { ref: fbRef, onValue, db } = window.__fbDB;
    const r = fbRef(db, `${this.prefix}/offer`);
    const cb = (snap) => { if (snap.exists()) callback(snap.val()); };
    onValue(r, cb);
    activeListeners.set('offer', { ref: r, cb });
    return () => offRef('offer');
  }

  // Publica answer (guest)
  async sendAnswer(sdp) {
    if (DEMO_MODE) { this._demoSend('answer', sdp); return; }

    const { ref, set, db } = window.__fbDB;
    await set(ref(db, `${this.prefix}/answer`), sdp);
  }

  // Ouve answer (host)
  onAnswer(callback) {
    if (DEMO_MODE) { this._demoOn('answer', callback); return () => {}; }

    const { ref: fbRef, onValue, db } = window.__fbDB;
    const r = fbRef(db, `${this.prefix}/answer`);
    const cb = (snap) => { if (snap.exists()) callback(snap.val()); };
    onValue(r, cb);
    activeListeners.set('answer', { ref: r, cb });
    return () => offRef('answer');
  }

  // Envia ICE candidate
  async sendICE(candidate) {
    if (DEMO_MODE) { this._demoSend('ice-' + this.role, candidate); return; }

    const { ref, push, db } = window.__fbDB;
    const key = this.role === 'host' ? 'hostICE' : 'guestICE';
    await push(ref(db, `${this.prefix}/${key}`), candidate);
  }

  // Ouve ICE candidates do outro lado
  onICE(callback) {
    if (DEMO_MODE) {
      const key = this.role === 'host' ? 'ice-guest' : 'ice-host';
      this._demoOn(key, callback);
      return () => {};
    }

    const { ref: fbRef, onValue, db } = window.__fbDB;
    const key = this.role === 'host' ? 'guestICE' : 'hostICE';
    const r = fbRef(db, `${this.prefix}/${key}`);
    const seen = new Set();

    const cb = (snap) => {
      if (!snap.exists()) return;
      snap.forEach((child) => {
        if (!seen.has(child.key)) {
          seen.add(child.key);
          callback(child.val());
        }
      });
    };

    onValue(r, cb);
    activeListeners.set('ice', { ref: r, cb });
    return () => offRef('ice');
  }

  // Remove sessão do Firebase
  async cleanup() {
    activeListeners.forEach((_, key) => offRef(key));
    if (DEMO_MODE) return;

    try {
      const { ref, set, db } = window.__fbDB;
      await set(ref(db, this.prefix), null);
    } catch { /* ignora erros no cleanup */ }
  }

  // ── MODO DEMO (BroadcastChannel para mesma aba) ───────────────────────────
  _setupDemoMode() {
    if (!window.__demoChannels) window.__demoChannels = {};
    if (!window.__demoChannels[this.code]) {
      window.__demoChannels[this.code] = {};
    }
  }

  _demoSend(key, value) {
    this._setupDemoMode();
    const ch = window.__demoChannels[this.code];
    ch[key] = value;
    // Notifica listeners
    ch[`_cb_${key}`]?.forEach(fn => fn(value));
  }

  _demoOn(key, callback) {
    this._setupDemoMode();
    const ch = window.__demoChannels[this.code];
    if (!ch[`_cb_${key}`]) ch[`_cb_${key}`] = [];
    ch[`_cb_${key}`].push(callback);
    // Se já existe valor, chama imediatamente
    if (ch[key]) callback(ch[key]);
  }
}
