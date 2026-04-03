/**
 * firebase-config.js
 * ──────────────────
 * INSTRUÇÕES:
 *
 * 1. Acesse https://console.firebase.google.com
 * 2. Selecione seu projeto → Configurações do projeto (ícone de engrenagem)
 * 3. Role até "Seus aplicativos" → clique no app web → "Configuração do SDK"
 * 4. Copie o objeto firebaseConfig e cole abaixo
 *
 * ATENÇÃO — databaseURL:
 *   • Deve ser a URL do Realtime Database, NÃO do Firestore.
 *   • Encontre em: Build → Realtime Database → painel principal → URL no topo
 *   • Formato correto:  https://SEU-PROJETO-default-rtdb.firebaseio.com
 *   • Formato errado:   https://SEU-PROJETO.firebaseio.com  (sem -default-rtdb)
 *   • Regiões fora de us-central1 têm URLs como:
 *     https://SEU-PROJETO-default-rtdb.europe-west1.firebasedatabase.app
 *
 * SEGURANÇA:
 *   As chaves abaixo são PÚBLICAS por design (Firebase SDK para frontend).
 *   Proteja o banco configurando as Regras de Segurança no console Firebase,
 *   não escondendo as chaves.
 */

export const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCyJa0sf4E1AJo9S2J0NWbx-f2eFuymE-A",
  authDomain:        "digicanvas-prod.firebaseapp.com",
  databaseURL:       "https://digicanvas-prod-default-rtdb.firebaseio.com",
  projectId:         "digicanvas-prod",
  storageBucket:     "digicanvas-prod.firebasestorage.app",
  messagingSenderId: "558187707397",
  appId:             "1:558187707397:web:30edb68e4442df017fb06c",
};

/**
 * DEMO_MODE = true  → roda sem Firebase (comunicação na mesma aba)
 *                     útil para testar o canvas e as ferramentas localmente
 * DEMO_MODE = false → usa Firebase real (necessário para celular ↔ desktop)
 */
export const DEMO_MODE = false;
