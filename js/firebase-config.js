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
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

// Modo offline para testes locais sem Firebase real
// Quando true, usa simulação local (mesma aba). Útil para desenvolvimento.
export const DEMO_MODE = false;
