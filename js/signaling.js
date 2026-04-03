/**
 * signaling.js  (v2 — revisado)
 * ──────────────────────────────
 * Troca de sinais WebRTC via Firebase Realtime Database.
 *
 * BUGS CORRIGIDOS em relação à versão anterior:
 *
 * BUG 1 — initializeApp() chamado múltiplas vezes causava "app duplicado"
 *          → usa getApp() se já existir, via getApps().length check.
 *
 * BUG 2 — window.__fbDB compartilhado globalmente entre instâncias
 *          → SDK e db encapsulados em this._fb por instância.
 *
 * BUG 3 — createSession() fazia dois set() separados em sub-paths
 *          → único set() atômico no nó raiz da sessão.
 *
 * BUG 4 — sessionExists() lia /createdAt; se o host ainda não tivesse
 *          gravado (timing race), retornava false prematuramente.
 *          → lê o nó raiz + retry com backoff exponencial (3 tentativas).
 *
 * BUG 5 — offRef() usava a API off() do SDK v8 (incompatível com v9+)
 *          → usa unsubscribe() retornado por onValue() do SDK v9.
 *
 * BUG 6 — path com barra inicial "/sessions/..." inválido no SDK v9
 *          → removida a barra inicial, path correto: "sessions/{code}".
 *
 * BUG 7 — código com espaços ou caracteres não-numéricos gerava 404
 *          → sanitizeCode() normaliza para string de 6 dígitos.
 *
 * BUG 8 — databaseURL ausente ou com typo levava getDatabase() a usar
 *          banco errado silenciosamente
 *          → validação explícita com mensagens de erro acionáveis.
 */

import { FIREBASE_CONFIG, DEMO_MODE } from './firebase-config.js';

// ── Singleton do app Firebase ──────────────────────────────────────────────

let _app         = null;  // FirebaseApp
let _initPromise = null;  // Promise em andamento (evita dupla inicialização)

async function getOrInitApp() {
  if (_app) return _app;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // Validação antecipada — falha rápido com mensagem clara
    const { apiKey, databaseURL, projectId } = FIREBASE_CONFIG;

    if (!apiKey || apiKey.startsWith('YOUR_')) {
      throw new Error(
        '[Firebase] Configuração inválida: apiKey não foi preenchido.\n' +
        'Edite js/firebase-config.js com os dados do seu projeto.'
      );
    }
    if (!databaseURL || databaseURL.includes('YOUR_PROJECT')) {
      throw new Error(
        '[Firebase] Configuração inválida: databaseURL não foi preenchido.\n' +
        'Exemplo: "https://SEU-PROJETO-default-rtdb.firebaseio.com"\n' +
        'Encontre este valor em Firebase Console → Build → Realtime Database.'
      );
    }
    if (!databaseURL.startsWith('https://') || !databaseURL.includes('firebaseio.com')) {
      throw new Error(
        `[Firebase] databaseURL com formato inesperado: "${databaseURL}"\n` +
        'Deve começar com https:// e conter firebaseio.com'
      );
    }

    console.log(`[Firebase] Inicializando — projeto: ${projectId}, db: ${databaseURL}`);

    const [{ initializeApp, getApps, getApp }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js'),
    ]);

    // Reutiliza app existente (seguro em hot-reload e módulos reimportados)
    _app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);

    console.log('[Firebase] App pronto:', _app.options.projectId);
    return _app;
  })();

  try {
    return await _initPromise;
  } catch (err) {
    _initPromise = null; // permite retry após erro
    throw err;
  }
}

// ── Utilitários ────────────────────────────────────────────────────────────

function sanitizeCode(raw) {
  // Remove espaços, hífens e não-dígitos; garante 6 chars numéricos
  const clean = String(raw ?? '').trim().replace(/[\s\-]/g, '').replace(/\D/g, '');
  if (clean.length !== 6) {
    throw new Error(
      `Código inválido: recebido "${raw}" → limpo: "${clean}".\n` +
      'O código deve ter exatamente 6 dígitos numéricos.'
    );
  }
  return clean;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── API pública ────────────────────────────────────────────────────────────

export function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Classe SignalingChannel ────────────────────────────────────────────────

export class SignalingChannel {
  constructor(code, role) {
    this.code   = sanitizeCode(code);
    this.role   = role;              // 'host' | 'guest'

    // BUG 6 FIX: sem barra inicial — SDK v9 rejeita paths com "/" no início
    this.prefix = `sessions/${this.code}`;

    this._fb     = null; // { db, ref, set, get, onValue, push }
    this._unsubs = [];   // funções de unsubscribe (SDK v9 retorna de onValue)
  }

  // ── init ────────────────────────────────────────────────────────────────────

  async init() {
    if (DEMO_MODE) { this._setupDemo(); return; }

    await getOrInitApp();

    // Importa funções individuais — tree-shakable, sem namespace global
    const { getDatabase, ref, set, get, onValue, push } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js'
    );

    const db = getDatabase(_app);

    // BUG 8 FIX: loga o URL real que o SDK está usando
    console.log('[Signaling] DB URL em uso:', db.app.options.databaseURL);

    this._fb = { db, ref, set, get, onValue, push };
  }

  // ── createSession (HOST) ────────────────────────────────────────────────────

  async createSession() {
    if (DEMO_MODE) return;
    this._ready();

    const { db, ref, set } = this._fb;

    // BUG 3 FIX: set() único no nó raiz — atômico, sem corrida entre sub-paths
    const data = {
      createdAt: Date.now(),
      status:    'waiting',
    };

    try {
      await set(ref(db, this.prefix), data);
      console.log('[Signaling] Sessão criada:', { path: this.prefix, ...data });
    } catch (err) {
      console.error('[Signaling] Falha ao criar sessão.', err);
      throw new Error('Não foi possível criar a sessão no Firebase: ' + err.message);
    }

    // Auto-verificação: lê de volta para confirmar que gravou
    await this._verifyCreation(data.createdAt);
  }

  async _verifyCreation(expectedTs) {
    const { db, ref, get } = this._fb;
    try {
      const snap = await get(ref(db, `${this.prefix}/createdAt`));
      if (snap.exists() && snap.val() === expectedTs) {
        console.log('[Signaling] ✓ Sessão verificada no servidor');
      } else {
        console.warn(
          '[Signaling] ⚠ Verificação falhou após createSession.\n' +
          '  snap.val()  =', snap.val(), '\n' +
          '  esperado    =', expectedTs, '\n' +
          '  Verifique as regras do RTDB e o databaseURL.'
        );
      }
    } catch (err) {
      console.warn('[Signaling] Verificação lançou erro:', err.message);
    }
  }

  // ── sessionExists (GUEST) ───────────────────────────────────────────────────

  /**
   * BUG 4 FIX: até 3 tentativas com backoff (300 ms, 600 ms).
   * Lê o nó raiz (não sub-path) para diagnóstico completo.
   */
  async sessionExists(maxAttempts = 3) {
    if (DEMO_MODE) return true;
    this._ready();

    const { db, ref, get } = this._fb;

    for (let i = 1; i <= maxAttempts; i++) {
      console.log(`[Signaling] Verificando sessão "${this.code}" (tentativa ${i}/${maxAttempts})`);

      try {
        const snap = await get(ref(db, this.prefix));

        if (snap.exists()) {
          console.log('[Signaling] ✓ Sessão encontrada:', snap.val());
          return true;
        }

        // Log diagnóstico detalhado
        console.warn(
          `[Signaling] ✗ Sessão não encontrada (tentativa ${i}).\n` +
          `  path  : ${this.prefix}\n` +
          `  db    : ${db.app.options.databaseURL}\n` +
          `  val   : ${JSON.stringify(snap.val())}\n` +
          (i < maxAttempts ? `  → Retry em ${300 * i}ms...` : '  → Sem mais tentativas.')
        );

      } catch (err) {
        console.error(`[Signaling] Erro ao ler sessão (tentativa ${i}):`, err);
        if (i === maxAttempts) throw err;
      }

      if (i < maxAttempts) await sleep(300 * i);
    }

    return false;
  }

  // ── Offer ───────────────────────────────────────────────────────────────────

  async sendOffer(sdp) {
    if (DEMO_MODE) { this._demoSend('offer', sdp); return; }
    this._ready();
    const { db, ref, set } = this._fb;
    await set(ref(db, `${this.prefix}/offer`), sdp);
    console.log('[Signaling] offer enviado');
  }

  onOffer(callback) {
    if (DEMO_MODE) { this._demoOn('offer', callback); return () => {}; }
    this._ready();
    return this._watch(`${this.prefix}/offer`, callback);
  }

  // ── Answer ──────────────────────────────────────────────────────────────────

  async sendAnswer(sdp) {
    if (DEMO_MODE) { this._demoSend('answer', sdp); return; }
    this._ready();
    const { db, ref, set } = this._fb;
    await set(ref(db, `${this.prefix}/answer`), sdp);
    console.log('[Signaling] answer enviado');
  }

  onAnswer(callback) {
    if (DEMO_MODE) { this._demoOn('answer', callback); return () => {}; }
    this._ready();
    return this._watch(`${this.prefix}/answer`, callback);
  }

  // ── ICE candidates ──────────────────────────────────────────────────────────

  async sendICE(candidate) {
    if (DEMO_MODE) { this._demoSend(`ice-${this.role}`, candidate); return; }
    this._ready();
    const { db, ref, push } = this._fb;
    const bucket = this.role === 'host' ? 'hostICE' : 'guestICE';
    await push(ref(db, `${this.prefix}/${bucket}`), candidate);
  }

  onICE(callback) {
    if (DEMO_MODE) {
      this._demoOn(this.role === 'host' ? 'ice-guest' : 'ice-host', callback);
      return () => {};
    }
    this._ready();

    const { db, ref, onValue } = this._fb;
    const bucket = this.role === 'host' ? 'guestICE' : 'hostICE';
    const seen   = new Set();

    // BUG 5 FIX: onValue retorna a função de unsubscribe no SDK v9
    const unsub = onValue(
      ref(db, `${this.prefix}/${bucket}`),
      (snap) => {
        if (!snap.exists()) return;
        snap.forEach((child) => {
          if (!seen.has(child.key)) {
            seen.add(child.key);
            callback(child.val());
          }
        });
      },
      (err) => console.error('[Signaling] Erro ao ouvir ICE:', err)
    );

    this._unsubs.push(unsub);
    return unsub;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  async cleanup() {
    // BUG 5 FIX: desinscreve via função retornada por onValue
    this._unsubs.forEach(fn => { try { fn(); } catch { /**/ } });
    this._unsubs = [];

    if (DEMO_MODE || !this._fb) return;

    try {
      const { db, ref, set } = this._fb;
      await set(ref(db, this.prefix), null);
      console.log('[Signaling] Sessão removida do RTDB');
    } catch { /* ignora — cleanup best-effort */ }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Assina um path; dispara callback apenas quando o dado existir */
  _watch(path, callback) {
    const { db, ref, onValue } = this._fb;

    const unsub = onValue(
      ref(db, path),
      (snap) => { if (snap.exists()) callback(snap.val()); },
      (err) => console.error(`[Signaling] Erro ao ouvir "${path}":`, err)
    );

    this._unsubs.push(unsub);
    return unsub; // retornado para quem quiser cancelar manualmente
  }

  _ready() {
    if (!this._fb) throw new Error(
      '[Signaling] Canal não inicializado — chame await channel.init() primeiro.'
    );
  }

  // ── Demo mode (sem Firebase, mesma aba) ─────────────────────────────────────

  _setupDemo() {
    window.__demo ??= {};
    window.__demo[this.code] ??= {};
  }

  _demoSend(key, value) {
    this._setupDemo();
    const ch = window.__demo[this.code];
    ch[key] = value;
    // Microtask simula a latência de rede
    (ch[`_cb_${key}`] ?? []).forEach(fn => Promise.resolve().then(() => fn(value)));
  }

  _demoOn(key, callback) {
    this._setupDemo();
    const ch = window.__demo[this.code];
    (ch[`_cb_${key}`] ??= []).push(callback);
    if (ch[key] !== undefined) {
      Promise.resolve().then(() => callback(ch[key]));
    }
  }
}
