/**
 * firebase-config.js
 * ──────────────────
 * Configuração do Firebase. Substitua os valores abaixo
 * pelos dados do seu projeto Firebase (veja firebase-setup.md).
 *
 * Para GitHub Pages, NUNCA exponha chaves privadas aqui.
 * As chaves do Firebase SDK (apiKey, etc.) são chaves públicas
 * destinadas ao uso no frontend — são seguras de expor.
 */

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SUBSTITUA ESTES VALORES PELAS SUAS CREDENCIAIS DO FIREBASE             │
// └─────────────────────────────────────────────────────────────────────────┘
export const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCyJa0sf4E1AJo9S2J0NWbx-f2eFuymE-A",
  authDomain:        "digicanvas-prod.firebaseapp.com",
  databaseURL:       "https://digicanvas-prod-default-rtdb.firebaseio.com",
  projectId:         "digicanvas-prod",
  storageBucket:     "digicanvas-prod.firebasestorage.app",
  messagingSenderId: "558187707397",
  appId:             "1:558187707397:web:30edb68e4442df017fb06c",
};

// Modo offline para testes locais sem Firebase real
// Quando true, usa simulação local (mesma aba). Útil para desenvolvimento.
export const DEMO_MODE = false;
