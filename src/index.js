// ════════════════════════════════════════════════════════════════════════
// 🌉 Passerelle Oh API Day — Worker personnel (V3.1)
// ════════════════════════════════════════════════════════════════════════
//
// UN SEUL Worker qui donne à son propriétaire tout Oh API Day :
//   ─── IA + Galaxy ─────────────────────────────
//   /ai                      cascade LLM (Cloudflare AI, Groq, Cerebras…)
//   /galaxy/embed            vecteur bge-m3
//   /galaxy/search           top-k étoiles par similarité
//   /galaxy/save             sauvegarde étoile + vecteur
//   /galaxy/pull             récupère toutes les étoiles
//   /galaxy/star/:id (DELETE) supprime une étoile
//   ─── Activation extension ────────────────────
//   /ext/mint                l'app crée un accès QR+PIN
//   /ext/activate            l'extension échange code+PIN contre jeton
//   /ext/events              journal d'activations
//   ─── Proxy web + co-navigation ───────────────
//   /proxy-web               proxifie un site pour Astrid Navig
//   /proxy-asset             proxifie un asset (image, CSS, JS…)
//   /conav/create /join /poll /send /leave
//   /heartbeat               ping anonyme
//   /heartbeat/stats         stats agrégées (une clé unique, low-read)
//   /health                  statut du Worker
//
// ─── ZÉRO RATE LIMIT ───────────────────────────────────────────────────
// C'est TON Worker. Tu fais ce que tu veux avec.
// Le RATELIMIT public (30 pages/jour) vit uniquement dans passerelle-astrid
// public partagé — le teaser destiné à ceux qui n'ont pas encore installé.
//
// ─── SÉCURITÉ ──────────────────────────────────────────────────────────
// Le proxy web n'est appelable QUE depuis la PWA Oh API Day, par défaut.
// L'origin autorisée peut être changée via ALLOWED_ORIGIN.
// Pour ouvrir à tout : ALLOWED_ORIGIN = "*".
//
// ─── SECRETS À DÉFINIR (Settings > Variables and Secrets > "Secret") ───
//   AI_TOKEN              (obligatoire)  Auth des routes /galaxy/* et /ai
//   APP_SECRET            (obligatoire)  Auth de l'app pour /ext/mint
//   ASTRID_SHARED_SECRET  (obligatoire)  HMAC pour /conav/* (unique à toi)
//   GROQ_KEY              (au moins 1)   Clés LLM
//   GEMINI_KEY, CEREBRAS_KEY, MISTRAL_KEY, OPENROUTER_KEY
//
// ─── VARIABLES (Settings > Variables > "Plain text") ───────────────────
//   ALLOWED_ORIGIN        (optionnel, défaut: https://ohapi-day-f37288.gitlab.io)
//                         "*" pour ouvrir à tout
//
// ─── BINDINGS ──────────────────────────────────────────────────────────
//   AI               (Workers AI)   Llama + embeddings BGE-M3
//   GALAXY           (KV Namespace) étoiles + vecteurs + activations
//   CONAV_SESSIONS   (KV Namespace) sessions co-nav + heartbeat
//
// ─── CONVENTIONS KV (préfixe versionné) ────────────────────────────────
//   v1:secret:{sha256(APP_SECRET)}     → ownerId (dérivé du secret)
//   v1:owner:{ownerId}                 → {createdAt, ...}
//   v1:actv:{code}                     → {ownerId, profileLabel, scopes,
//                                          pinHash, salt, tries, createdAt} TTL 600s
//   v1:ext:{token}                     → {ownerId, profileLabel, scopes,
//                                          installId, spent, createdAt, lastSeen}
//   v1:event:{ownerId}:{ts}            → {type, profileLabel, ...} TTL 90j
//   s:{code}                           → session co-nav (KV CONAV_SESSIONS) TTL 1h
//   hb:{day}:{event}:{outcome}         → agrégat heartbeat TTL 7j
//   hb:stats:daily:latest              → agrégat unique lisible d'un seul get
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_SCOPES = ['read', 'tts', 'guard'];
const KNOWN_SCOPES   = ['read', 'tts', 'guard', 'navig', 'relay', 'vault', 'record'];
const PIN_MIN_LEN = 4;
const PIN_MAX_LEN = 8;
const ACTIVATION_TTL = 600;
const EVENT_TTL      = 60 * 60 * 24 * 90;
const EMBED_MODEL    = '@cf/baai/bge-m3';

const CONAV_TTL_SECONDS = 3600;
const CONAV_MAX_EVENTS  = 200;
const CONAV_CODE_LENGTH = 6;

const DEFAULT_ALLOWED_ORIGIN = 'https://ohapi-day-f37288.gitlab.io';

// ═════════════════════════════════════════════════════════════════════
//  ROUTEUR
// ═════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    // ── HEALTH ───────────────────────────────────────────────────
    if (path === '/health' || path === '/') {
      return json({
        ok: true,
        worker: 'passerelle-oh-api-day',
        version: '3.1',
        ai:         !!env.AI,
        embeddings: !!env.AI,
        galaxy:     !!env.GALAXY,
        conav:      !!env.CONAV_SESSIONS,
        activation: !!env.GALAXY && !!env.APP_SECRET,
        proxy: true,
        allowedOrigin: env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN,
        providers: [
          env.AI ? 'CLOUDFLARE_AI (binding)' : null,
          ...['GROQ_KEY','GEMINI_KEY','CEREBRAS_KEY','MISTRAL_KEY','OPENROUTER_KEY'].filter(k => !!env[k])
        ].filter(Boolean),
        secured: !!env.AI_TOKEN
      });
    }

    // ── IA CASCADE ──────────────────────────────────────────────
    if (path === '/ai' && request.method === 'POST') {
      return await handleAi(request, env);
    }

    // ── GALAXY ──────────────────────────────────────────────────
    if (path.startsWith('/galaxy/')) {
      const authErr = checkAuth(request, env);
      if (authErr) return authErr;
      if (!env.AI) return json({ error: 'Workers AI binding manquant' }, 503);

      if (path === '/galaxy/embed'  && request.method === 'POST') return await handleGalaxyEmbed(request, env);
      if (path === '/galaxy/search' && request.method === 'POST') return await handleGalaxySearch(request, env);
      if (path === '/galaxy/save'   && request.method === 'POST') return await handleGalaxySave(request, env);
      if (path === '/galaxy/pull'   && request.method === 'GET')  return await handleGalaxyPull(request, env);
      if (path.startsWith('/galaxy/star/') && request.method === 'DELETE') {
        return await handleGalaxyDelete(request, env, path.substring('/galaxy/star/'.length));
      }
    }

    // ── ACTIVATION EXTENSION ────────────────────────────────────
    if (path === '/ext/mint'     && request.method === 'POST') return await handleExtMint(request, env);
    if (path === '/ext/activate' && request.method === 'POST') return await handleExtActivate(request, env);
    if (path === '/ext/events'   && request.method === 'GET')  return await handleExtEvents(request, env);

    // ── PROXY WEB + ASSETS ──────────────────────────────────────
    // Restriction Origin : uniquement la PWA, sauf ALLOWED_ORIGIN="*"
    if (path === '/proxy-web' || path === '/proxy-web/') {
      const originErr = checkOrigin(request, env);
      if (originErr) return originErr;
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing ?url=', { status: 400, headers: cors() });
      return await proxyRequest(target, url.origin, request, ctx);
    }
    if (path === '/proxy-asset' || path === '/proxy-asset/') {
      const originErr = checkOrigin(request, env);
      if (originErr) return originErr;
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing ?url=', { status: 400, headers: cors() });
      return await proxyAsset(target, ctx);
    }

    // ── CO-NAVIGATION ───────────────────────────────────────────
    if (path.startsWith('/conav/')) {
      if (!env.CONAV_SESSIONS) return json({ error: 'KV CONAV_SESSIONS manquant' }, 503);
      try {
        if (path === '/conav/create' && request.method === 'POST') return await conavCreate(env, request);
        if (path === '/conav/join'   && request.method === 'POST') return await conavJoin(request, env);
        if (path === '/conav/poll'   && request.method === 'GET')  return await conavPoll(request, env);
        if (path === '/conav/send'   && request.method === 'POST') return await conavSend(request, env);
        if (path === '/conav/leave'  && request.method === 'POST') return await conavLeave(request, env);
        return json({ error: 'Route conav inconnue' }, 404);
      } catch (e) {
        return json({ error: e.message || 'Erreur interne conav' }, 500);
      }
    }

    // ── HEARTBEAT ───────────────────────────────────────────────
    if (path === '/heartbeat' && request.method === 'POST') {
      return await heartbeatReceive(request, env);
    }
    if (path === '/heartbeat/stats' && request.method === 'GET') {
      return await heartbeatStats(env);
    }

    return new Response('Not found', { status: 404, headers: cors() });
  },

  // ── CRON : agrège les stats heartbeat une fois par jour ────────
  async scheduled(controller, env, ctx) {
    if (!env.CONAV_SESSIONS) return;
    try {
      await rebuildHeartbeatAggregate(env);
    } catch (e) {
      console.error('cron heartbeat aggregate failed', e);
    }
  }
};

// ═════════════════════════════════════════════════════════════════════
//  SÉCURITÉ : Origin check pour le proxy
// ═════════════════════════════════════════════════════════════════════
function checkOrigin(request, env) {
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  if (allowed === '*') return null;
  const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
  // Referer inclut le path, Origin est juste le schema://host
  if (origin === allowed) return null;
  if (origin.startsWith(allowed + '/')) return null;
  return json({
    error: 'origin_forbidden',
    message: 'Ce Worker n\'accepte que les requêtes venant de ' + allowed,
    hint: 'Pour ouvrir à d\'autres, mets ALLOWED_ORIGIN="*" dans Variables.'
  }, 403);
}

// ═════════════════════════════════════════════════════════════════════
//  IA CASCADE (identique à V2, sans rate limit)
// ═════════════════════════════════════════════════════════════════════
async function handleAi(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { messages, sys, user, max_tokens } = body;

  const finalMessages = messages || [
    ...(sys ? [{ role: 'system', content: sys }] : []),
    { role: 'user', content: user || '' }
  ];
  const maxTokens = max_tokens || 800;

  if (env.AI) {
    try {
      const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        { messages: finalMessages, max_tokens: maxTokens });
      const text = r.response || r.result?.response || '';
      if (text) return json({ text, provider: 'cloudflare-ai', model: 'llama-3.3-70b' });
    } catch (e) { /* fallback */ }
  }

  const providers = [
    { id: 'groq',       key: env.GROQ_KEY,       url: 'https://api.groq.com/openai/v1/chat/completions',   model: 'llama-3.3-70b-versatile' },
    { id: 'cerebras',   key: env.CEREBRAS_KEY,   url: 'https://api.cerebras.ai/v1/chat/completions',       model: 'llama-3.3-70b' },
    { id: 'mistral',    key: env.MISTRAL_KEY,    url: 'https://api.mistral.ai/v1/chat/completions',        model: 'mistral-small-latest' },
    { id: 'openrouter',    key: env.OPENROUTER_KEY, url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    { id: 'openrouter-gm', key: env.OPENROUTER_KEY, url: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemini-2.5-flash-lite:free' }
  ];

  for (const p of providers) {
    if (!p.key) continue;
    try {
      const r = await fetch(p.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${p.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: p.model, messages: finalMessages, max_tokens: maxTokens })
      });
      if (r.ok) {
        const data = await r.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (text) return json({ text, provider: p.id, model: p.model });
      }
    } catch (e) { /* essai suivant */ }
  }

  if (env.GEMINI_KEY) {
    try {
      const text = await callGemini(env.GEMINI_KEY, finalMessages, maxTokens);
      if (text) return json({ text, provider: 'gemini', model: 'gemini-2.5-flash' });
    } catch (e) {}
  }

  return json({ error: 'all_providers_failed' }, 502);
}

async function callGemini(key, messages, maxTokens) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '' }]
  }));
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } }) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ═════════════════════════════════════════════════════════════════════
//  GALAXY (identique à V2, sans rate limit)
// ═════════════════════════════════════════════════════════════════════
function compressVector(vec) {
  if (!Array.isArray(vec)) return vec;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = Math.round(vec[i] * 10000) / 10000;
  return out;
}

async function handleGalaxyEmbed(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const text = String(body.text || '').slice(0, 4000);
  if (!text) return json({ error: 'text_required' }, 400);
  const r = await env.AI.run(EMBED_MODEL, { text: [text] });
  const vec = r.data?.[0] || r.result?.data?.[0];
  if (!vec) return json({ error: 'no_vector' }, 502);
  return json({ vector: compressVector(vec), dims: vec.length });
}

async function handleGalaxySearch(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { userId, query, topK = 5 } = body;
  if (!userId || !query) return json({ error: 'userId_and_query_required' }, 400);
  if (!env.GALAXY) return json({ error: 'KV GALAXY manquant' }, 503);

  const raw = await env.GALAXY.get('galaxy:' + userId);
  if (!raw) return json({ ok: true, matches: [] });
  const stars = JSON.parse(raw);

  const rEmbed = await env.AI.run(EMBED_MODEL, { text: [query] });
  const qVec = rEmbed.data?.[0] || rEmbed.result?.data?.[0];
  if (!qVec) return json({ error: 'no_query_vector' }, 502);

  const scored = stars.map(s => ({ ...s, score: cosine(qVec, s.vector) }))
                      .sort((a, b) => b.score - a.score).slice(0, topK);
  return json({ ok: true, matches: scored });
}

async function handleGalaxySave(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { userId, star } = body;
  if (!userId || !star) return json({ error: 'userId_and_star_required' }, 400);
  if (!env.GALAXY) return json({ error: 'KV GALAXY manquant' }, 503);

  const raw = await env.GALAXY.get('galaxy:' + userId);
  const stars = raw ? JSON.parse(raw) : [];

  if (star.vector) star.vector = compressVector(star.vector);
  else if (star.text) {
    const r = await env.AI.run(EMBED_MODEL, { text: [star.text.slice(0, 4000)] });
    const vec = r.data?.[0] || r.result?.data?.[0];
    if (vec) star.vector = compressVector(vec);
  }

  const idx = stars.findIndex(s => s.id === star.id);
  if (idx >= 0) stars[idx] = { ...stars[idx], ...star };
  else stars.push({ ...star, id: star.id || crypto.randomUUID(), createdAt: Date.now() });

  await env.GALAXY.put('galaxy:' + userId, JSON.stringify(stars));
  return json({ ok: true, count: stars.length });
}

async function handleGalaxyPull(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId) return json({ error: 'userId_required' }, 400);
  if (!env.GALAXY) return json({ error: 'KV GALAXY manquant' }, 503);
  const raw = await env.GALAXY.get('galaxy:' + userId);
  return json({ ok: true, stars: raw ? JSON.parse(raw) : [] });
}

async function handleGalaxyDelete(request, env, id) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId || !id) return json({ error: 'userId_and_id_required' }, 400);
  if (!env.GALAXY) return json({ error: 'KV GALAXY manquant' }, 503);
  const raw = await env.GALAXY.get('galaxy:' + userId);
  if (!raw) return json({ ok: true, deleted: 0 });
  const stars = JSON.parse(raw).filter(s => s.id !== id);
  await env.GALAXY.put('galaxy:' + userId, JSON.stringify(stars));
  return json({ ok: true, deleted: 1 });
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// ═════════════════════════════════════════════════════════════════════
//  ACTIVATION EXTENSION
// ═════════════════════════════════════════════════════════════════════
async function handleExtMint(request, env) {
  if (!env.APP_SECRET) return json({ error: 'APP_SECRET manquant côté Worker' }, 503);
  if (!env.GALAXY)     return json({ error: 'KV GALAXY manquant' }, 503);

  const ownerId = await appAuth(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const profileLabel = (body.profileLabel && String(body.profileLabel).trim())
    || `Appareil ${new Date().toLocaleDateString('fr-FR')}`;

  const pin = String(body.pin || '');
  if (pin.length < PIN_MIN_LEN || pin.length > PIN_MAX_LEN || !/^\d+$/.test(pin)) {
    return json({ error: 'pin_invalide', min: PIN_MIN_LEN, max: PIN_MAX_LEN }, 400);
  }

  let scopes = Array.isArray(body.scopes) ? body.scopes : [];
  scopes = scopes.filter(s => KNOWN_SCOPES.includes(s));
  if (scopes.length === 0) scopes = DEFAULT_SCOPES.slice();

  const code = randomCode(8);
  const salt = crypto.randomUUID();
  const pinHash = await hashPin(pin, salt);

  await env.GALAXY.put(
    `v1:actv:${code}`,
    JSON.stringify({
      ownerId, profileLabel, scopes, pinHash, salt, tries: 0,
      createdAt: Date.now()
    }),
    { expirationTtl: ACTIVATION_TTL }
  );

  return json({
    ok: true, code, profileLabel, scopes,
    expiresIn: ACTIVATION_TTL,
    workerUrl: new URL(request.url).origin
  });
}

async function handleExtActivate(request, env) {
  if (!env.GALAXY) return json({ error: 'KV GALAXY manquant' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const code = String(body.code || '').trim().toUpperCase();
  const pin  = String(body.pin  || '');
  const installId = String(body.installId || '').slice(0, 128) || crypto.randomUUID();
  if (!code || !pin) return json({ error: 'code_ou_pin_manquant' }, 400);

  const raw = await env.GALAXY.get(`v1:actv:${code}`);
  if (!raw) return json({ error: 'code_invalide_ou_expire' }, 400);
  const actv = JSON.parse(raw);

  const candidateHash = await hashPin(pin, actv.salt);
  const ok = timingSafeEqualHex(candidateHash, actv.pinHash);

  if (!ok) {
    actv.tries = (actv.tries || 0) + 1;
    if (actv.tries >= 3) {
      await env.GALAXY.delete(`v1:actv:${code}`);
      return json({ error: 'code_brule', tries: actv.tries }, 403);
    }
    // TTL calculé depuis createdAt pour ne pas recharger la fenêtre
    const remainingSec = Math.max(60, ACTIVATION_TTL - Math.floor((Date.now() - actv.createdAt) / 1000));
    await env.GALAXY.put(`v1:actv:${code}`, JSON.stringify(actv), { expirationTtl: remainingSec });
    return json({ error: 'pin_faux', restants: 3 - actv.tries }, 403);
  }

  await env.GALAXY.delete(`v1:actv:${code}`);

  const token = crypto.randomUUID();
  const now = Date.now();
  await env.GALAXY.put(`v1:ext:${token}`, JSON.stringify({
    ownerId: actv.ownerId,
    profileLabel: actv.profileLabel,
    scopes: actv.scopes,
    installId, spent: 0, createdAt: now, lastSeen: now
  }));

  await env.GALAXY.put(
    `v1:event:${actv.ownerId}:${now}`,
    JSON.stringify({
      type: 'activation',
      profileLabel: actv.profileLabel,
      installId, scopes: actv.scopes, at: now
    }),
    { expirationTtl: EVENT_TTL }
  );

  return json({
    ok: true, token,
    ownerId: actv.ownerId,
    profileLabel: actv.profileLabel,
    scopes: actv.scopes,
    workerUrl: new URL(request.url).origin
  });
}

async function handleExtEvents(request, env) {
  if (!env.GALAXY) return json({ error: 'KV GALAXY manquant' }, 503);
  const ownerId = await appAuth(request, env);
  if (!ownerId) return json({ error: 'unauthorized' }, 401);
  const list = await env.GALAXY.list({ prefix: `v1:event:${ownerId}:`, limit: 100 });
  const events = [];
  for (const k of list.keys) {
    const raw = await env.GALAXY.get(k.name);
    if (raw) events.push({ key: k.name, ...JSON.parse(raw) });
  }
  events.sort((a, b) => (b.at || 0) - (a.at || 0));
  return json({ ok: true, events });
}

// Réutilisable par les futures routes /ext/xxx
async function seal(request, env) {
  const t = request.headers.get('X-Astrid-Ext');
  if (!t) return null;
  const raw = await env.GALAXY.get(`v1:ext:${t}`);
  if (!raw) return null;
  const s = JSON.parse(raw);
  s.lastSeen = Date.now();
  await env.GALAXY.put(`v1:ext:${t}`, JSON.stringify(s));
  return s;
}

// ═════════════════════════════════════════════════════════════════════
//  AUTH & CRYPTO
// ═════════════════════════════════════════════════════════════════════
async function appAuth(request, env) {
  const raw = request.headers.get('X-App-Auth');
  if (!raw) return null;
  const ok = await timingSafeCompareStrings(raw, env.APP_SECRET);
  if (!ok) return null;
  // ownerId dérivé du secret, pas de bootstrap négociable.
  // Séparation de domaine : préfixe 'owner:' pour que le hash ne serve
  // qu'à cet usage. Un autre hash dérivé du même secret (ex. pour une
  // future clé de session) utilisera son propre préfixe.
  const h = await sha256Hex('owner:' + raw);
  const ownerId = 'own_' + h.slice(0, 32);
  // Enregistre le profil owner à la première fois
  const key = `v1:owner:${ownerId}`;
  const existing = await env.GALAXY.get(key);
  if (!existing) {
    await env.GALAXY.put(key, JSON.stringify({ createdAt: Date.now() }));
  }
  return ownerId;
}

async function sha256Hex(str) {
  const enc = new TextEncoder();
  const h = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function timingSafeCompareStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// PBKDF2 210k iter → aligné sur ton QR chiffré
async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 210000, hash: 'SHA-256' },
    k, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

function checkAuth(request, env) {
  if (!env.AI_TOKEN) return null;
  const auth = request.headers.get('Authorization') || '';
  if (auth.replace(/^Bearer\s+/i, '').trim() !== env.AI_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════
//  PROXY WEB — anti-SSRF + réécriture HTML + bridge injecté
// ═════════════════════════════════════════════════════════════════════
function securityCheck(target) {
  let url;
  try { url = new URL(target); } catch (e) { return 'URL invalide'; }
  if (url.protocol !== 'https:') return 'HTTPS requis (' + url.protocol + ' bloqué)';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    return 'Hostname local interdit';
  if (host.endsWith('.onion')) return 'Réseau Tor non supporté';
  if (host === '' || host === '.') return 'Hostname vide';
  if (/^\d+$/.test(host)) return 'IP décimale bloquée';
  if (/^0x[0-9a-f]+$/i.test(host)) return 'IP hexa bloquée';
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = +ipv4[1], b = +ipv4[2];
    if (a === 0)   return 'IP 0.x bloquée';
    if (a === 10)  return 'IP privée 10.x bloquée';
    if (a === 127) return 'Localhost bloqué';
    if (a === 169 && b === 254) return 'IP link-local bloquée';
    if (a === 172 && b >= 16 && b <= 31) return 'IP privée 172.16-31.x bloquée';
    if (a === 192 && b === 168) return 'IP privée 192.168.x bloquée';
    if (a >= 224) return 'IP multicast bloquée';
  }
  if (host.includes(':') || host.startsWith('[')) {
    const v6 = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (v6 === '::1' || v6 === '::') return 'IPv6 loopback bloqué';
    if (v6.startsWith('fe80')) return 'IPv6 link-local bloqué';
    if (v6.startsWith('fc') || v6.startsWith('fd')) return 'IPv6 unique-local bloqué';
    if (v6.startsWith('ff')) return 'IPv6 multicast bloqué';
    if (/^::ffff:/.test(v6)) return 'IPv6 mappant IPv4 bloqué';
  }
  if (host === '100.64.0.0' || host.startsWith('100.6')) return 'CGN range bloqué';
  return null;
}

async function proxyRequest(targetUrl, proxyOrigin, originalRequest, ctx) {
  if (targetUrl && targetUrl.toLowerCase().startsWith('http://')) {
    targetUrl = 'https://' + targetUrl.substring(7);
  }
  const secError = securityCheck(targetUrl);
  if (secError) {
    return new Response('🔒 ' + secError, {
      status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors() }
    });
  }
  try {
    const response = await fetch(targetUrl, {
      method: originalRequest.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      let html = await response.text();
      html = rewriteHtml(html, targetUrl, proxyOrigin);
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src https: data: blob:; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
            "style-src 'self' 'unsafe-inline' https: data:; " +
            "img-src https: data: blob:; " +
            "font-src https: data:; " +
            "connect-src https: wss:; " +
            "frame-ancestors 'self' https:; " +
            "block-all-mixed-content; " +
            "upgrade-insecure-requests",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          ...cors(),
        },
      });
    }
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': contentType, ...cors() },
    });
  } catch (e) {
    const msg = e.message || '';
    let userMsg = 'Erreur proxy : ' + msg;
    if (/cert|ssl|tls|https/i.test(msg)) {
      userMsg = '🔒 Ce site n\'a pas de certificat HTTPS valide.';
    } else if (/refused|timeout|dns|enotfound/i.test(msg)) {
      userMsg = '⚠️ Site inaccessible. Vérifie l\'adresse ou réessaye plus tard.';
    }
    return new Response(userMsg, {
      status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors() }
    });
  }
}

// Cache Cloudflare : les assets déjà téléchargés sont servis sans refetch
async function proxyAsset(targetUrl, ctx) {
  const secError = securityCheck(targetUrl);
  if (secError) return new Response(secError, { status: 403, headers: cors() });

  const cacheKey = new Request('https://cache.oapi/' + encodeURIComponent(targetUrl));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36' },
      redirect: 'follow',
    });
    const headers = new Headers();
    const ct = response.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=86400');
    const body = await response.arrayBuffer();
    const resp = new Response(body, { status: response.status, headers });
    if (response.ok && ctx) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response('Asset proxy error', { status: 502, headers: cors() });
  }
}

function rewriteHtml(html, targetUrl, proxyOrigin) {
  const baseUrl = new URL(targetUrl);
  const baseHref = baseUrl.protocol + '//' + baseUrl.host;
  html = html.replace(/<meta\s+http-equiv\s*=\s*["']?X-Frame-Options["']?[^>]*>/gi, '');
  html = html.replace(/<meta\s+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, '');
  const escapedHost = baseUrl.host.replace(/\./g, '\\.');
  const hostPattern = new RegExp('https?://(www\\.)?' + escapedHost + '([^"\'\\s)]*)', 'g');
  html = html.replace(hostPattern, (match) => proxyOrigin + '/proxy-web?url=' + encodeURIComponent(match));
  const bridge = '\n<base href="' + baseHref + '/">\n' + buildBridgeScript(proxyOrigin, baseUrl.host);
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (match) => match + bridge);
  } else {
    html = bridge + html;
  }
  return html;
}

// Bridge injecté — repris de passerelle-astrid tel quel
function buildBridgeScript(proxyOrigin, targetHost) {
  return `<script>
(function(){
  var PROXY_ORIGIN = '${proxyOrigin}';
  var TARGET_HOST = '${targetHost}';
  var HIGHLIGHT_ID = '__oapi_highlight__';

  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    if (href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
    if (a.getAttribute('target') === '_blank') return;
    if (a.hasAttribute('download')) return;
    var absoluteUrl;
    try { absoluteUrl = new URL(href, document.baseURI).href; } catch (err) { return; }
    if (absoluteUrl.indexOf(PROXY_ORIGIN) === 0) return;
    if (absoluteUrl.indexOf(TARGET_HOST) !== -1 || a.hasAttribute('data-internal')) {
      e.preventDefault();
      window.location.href = PROXY_ORIGIN + '/proxy-web?url=' + encodeURIComponent(absoluteUrl);
    } else {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }, true);

  function sendReady() {
    try {
      window.parent.postMessage({
        source: 'ohapiday-bridge', type: 'ready',
        url: window.location.href, title: document.title
      }, '*');
    } catch (e) {}
  }

  function sanitizeLabel(label) {
    if (!label) return '';
    var s = String(label);
    if (s.length > 80) s = s.substring(0, 80);
    s = s.replace(/[\u0000-\u001F\u007F]+/g, ' ');
    s = s.replace(/["\`]/g, "'");
    var bad = /\\b(ignore|disregard|forget)\\s+(all|previous|tout)\\b|\\b(you are now|tu es maintenant|jailbreak)\\b|\\[INST\\]|<\\|.+?\\|>/i;
    if (bad.test(s)) return '[filtered]';
    return s.replace(/\\s+/g, ' ').trim();
  }

  function extractDOM() {
    var sel = 'a, button, input, select, textarea, [role="button"], [role="link"]';
    var nodes = document.querySelectorAll(sel);
    var elements = [];
    var MAX = 80;
    for (var i = 0; i < nodes.length && elements.length < MAX; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      var rawLabel = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      var label = sanitizeLabel(rawLabel);
      if (!label || label.length < 2 || label === '[filtered]') continue;
      var selector;
      if (el.id) {
        try { selector = '#' + CSS.escape(el.id); }
        catch(e) { selector = '#' + el.id; }
      } else {
        var navId = 'navel-' + i + '-' + Date.now().toString(36);
        el.setAttribute('data-nav-id', navId);
        selector = '[data-nav-id="' + navId + '"]';
      }
      elements.push({ tag: el.tagName.toLowerCase(), label: label, selector: selector });
    }
    return {
      title: sanitizeLabel(document.title || ''),
      elements: elements,
      isLimited: nodes.length > MAX,
      totalInteractive: nodes.length
    };
  }

  function findByText(searchText) {
    if (!searchText) return null;
    var target = String(searchText).toLowerCase().trim();
    if (target.length < 2) return null;
    var sel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [onclick]';
    var nodes = document.querySelectorAll(sel);
    var bestExact = null, bestContains = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      var label = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (!label) continue;
      var labelLower = label.toLowerCase();
      if (labelLower === target) { bestExact = { el: el, label: label.substring(0, 80) }; break; }
      if (!bestContains && labelLower.indexOf(target) !== -1) bestContains = { el: el, label: label.substring(0, 80) };
    }
    var match = bestExact || bestContains;
    if (!match) {
      var allNodes = document.querySelectorAll('*');
      for (var j = 0; j < allNodes.length && j < 5000; j++) {
        var el2 = allNodes[j];
        var cs2 = window.getComputedStyle(el2);
        if (cs2.cursor !== 'pointer') continue;
        var rect2 = el2.getBoundingClientRect();
        if (rect2.width === 0 || rect2.height === 0) continue;
        var l2 = (el2.textContent || '').trim();
        if (l2.toLowerCase().indexOf(target) !== -1 && l2.length < 100) {
          match = { el: el2, label: l2.substring(0, 80) };
          break;
        }
      }
    }
    if (!match) return null;
    var selector;
    if (match.el.id) {
      try { selector = '#' + CSS.escape(match.el.id); }
      catch(e) { selector = '#' + match.el.id; }
    } else {
      var navId = 'navfind-' + Date.now().toString(36);
      match.el.setAttribute('data-nav-id', navId);
      selector = '[data-nav-id="' + navId + '"]';
    }
    return { selector: selector, label: match.label };
  }

  function clickElement(selector) {
    if (!selector) return false;
    var el;
    try { el = document.querySelector(selector); } catch (e) { return false; }
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.disabled) return false;
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    }
    try {
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return true;
    } catch (e) {
      try {
        var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(evt);
        return true;
      } catch (e2) { return false; }
    }
  }

  function detectDarkPatterns() {
    var warnings = [];
    try {
      var checkedBoxes = document.querySelectorAll('input[type="checkbox"][checked], input[type="checkbox"]:checked');
      var suspiciousChecks = 0;
      checkedBoxes.forEach(function(cb) {
        var label = '';
        if (cb.id) { var lbl = document.querySelector('label[for="' + cb.id + '"]'); if (lbl) label = lbl.textContent || ''; }
        if (!label && cb.parentElement) label = cb.parentElement.textContent || '';
        label = label.toLowerCase().substring(0, 200);
        if (/newsletter|partenaire|offre|publicit|marketing|tiers|sponsor|inscrire|recevoir/.test(label)) suspiciousChecks++;
      });
      if (suspiciousChecks > 0) {
        warnings.push({ level: 'info', text: suspiciousChecks + ' case(s) cochée(s) par défaut sur cette page. Vérifie chacune avant de valider.' });
      }
      var allBtns = document.querySelectorAll('button, a[role="button"], [class*="accept"], [class*="agree"]');
      var bigAccept = null, smallReject = null;
      allBtns.forEach(function(b) {
        var txt = (b.textContent || '').toLowerCase().trim().substring(0, 50);
        var r = b.getBoundingClientRect();
        var area = r.width * r.height;
        if (area === 0) return;
        if (/^(accepter|tout accepter|accept all|j'accepte|ok|continuer)/.test(txt) && area > 6000) {
          if (!bigAccept || area > bigAccept.area) bigAccept = { el: b, area: area, txt: txt };
        }
        if (/^(refuser|continuer sans|tout refuser|reject|non merci|paramétrer|gérer)/.test(txt) && area < 4000) {
          if (!smallReject || area < smallReject.area) smallReject = { el: b, area: area, txt: txt };
        }
      });
      if (bigAccept && smallReject && bigAccept.area > smallReject.area * 1.8) {
        warnings.push({ level: 'info', text: 'Sur cette page, le bouton "' + bigAccept.txt + '" est nettement plus grand que "' + smallReject.txt + '". Prends ton temps pour choisir.' });
      }
      var bodyText = (document.body.textContent || '').toLowerCase();
      if (/plus que \\d+ (place|article|en stock|disponible)/.test(bodyText) ||
          /offre se termine dans/.test(bodyText) ||
          /(\\d{1,2}:\\d{2}:\\d{2})/.test(bodyText)) {
        var timers = document.querySelectorAll('[class*="countdown"], [class*="timer"], [id*="countdown"]');
        if (timers.length > 0) warnings.push({ level: 'info', text: 'Compte à rebours visible. Pas besoin de te précipiter.' });
      }
      allBtns.forEach(function(b) {
        var txt = (b.textContent || '').toLowerCase().trim().substring(0, 100);
        if (/non merci.*(payer|prix fort|cher)|je ne veux pas (économiser|gagner)/.test(txt)) {
          warnings.push({ level: 'info', text: 'Texte à lire attentivement : "' + (b.textContent || '').trim().substring(0, 80) + '". Choisis selon ce que tu veux vraiment.' });
        }
      });
    } catch (e) {}
    return warnings;
  }

  function highlightElement(selector, label, safeBottom, largeMode) {
    var existing = document.getElementById(HIGHLIGHT_ID);
    if (existing) existing.remove();
    var el;
    try { el = document.querySelector(selector); } catch (e) { return false; }
    if (!el) return false;
    safeBottom = parseInt(safeBottom) || 0;
    var visibleHeight = window.innerHeight - safeBottom;
    if (visibleHeight < 200) visibleHeight = window.innerHeight;
    var targetY = Math.max(80, visibleHeight * 0.35);
    var rect = el.getBoundingClientRect();
    var scrollDelta = rect.top - targetY;
    try {
      if (Math.abs(scrollDelta) > 20) window.scrollBy({ top: scrollDelta, behavior: 'smooth' });
    } catch (e) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch(_) {}
    }
    var BORDER_W = largeMode ? '6px' : '5px';
    var INSET = largeMode ? '-10px' : '-6px';
    var BORDER_RAD = largeMode ? '14px' : '10px';
    var SHADOW_BASE = largeMode
      ? '0 0 0 8px rgba(255,106,0,0.45),0 0 44px 10px rgba(255,140,0,0.95),0 0 80px 20px rgba(255,90,0,0.6)'
      : '0 0 0 5px rgba(255,106,0,0.45),0 0 36px 8px rgba(255,140,0,0.95),0 0 64px 16px rgba(255,90,0,0.55)';
    var LABEL_FONT = largeMode ? '16px' : '12px';
    var LABEL_PAD = largeMode ? '11px 18px' : '7px 12px';
    var LABEL_RAD = largeMode ? '12px' : '9px';
    var LABEL_MAXW = largeMode ? '320px' : '240px';
    var overlay = document.createElement('div');
    overlay.id = HIGHLIGHT_ID;
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;transition:transform .2s ease;';
    overlay.innerHTML = (
      '<div style="position:absolute;inset:' + INSET + ';border:' + BORDER_W + ' solid #FF6A00;border-radius:' + BORDER_RAD + ';' +
      'box-shadow:' + SHADOW_BASE + ';animation:oapiHighlightPulse 1.4s ease-in-out infinite"></div>' +
      (label ? ('<div style="position:absolute;left:50%;transform:translateX(-50%);top:100%;margin-top:' + (largeMode ? '18px' : '14px') + ';' +
      'background:#1F1135;color:#FFE8B5;padding:' + LABEL_PAD + ';border-radius:' + LABEL_RAD + ';font-size:' + LABEL_FONT + ';font-weight:' + (largeMode ? '800' : '700') + ';' +
      'font-family:system-ui,sans-serif;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,0.3);' +
      'max-width:' + LABEL_MAXW + ';overflow:hidden;text-overflow:ellipsis">👆 ' +
      String(label).replace(/</g, '&lt;') + '</div>') : '')
    );
    if (!document.getElementById('oapi-highlight-style')) {
      var st = document.createElement('style');
      st.id = 'oapi-highlight-style';
      st.textContent = '@keyframes oapiHighlightPulse{0%,100%{box-shadow:0 0 0 5px rgba(255,106,0,0.45),0 0 36px 8px rgba(255,140,0,0.95),0 0 64px 16px rgba(255,90,0,0.55)}50%{box-shadow:0 0 0 10px rgba(255,106,0,0.3),0 0 48px 14px rgba(255,150,0,1),0 0 90px 26px rgba(255,90,0,0.7)}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(overlay);
    var startTs = Date.now();
    function reposition() {
      if (Date.now() - startTs > 12000) { if (overlay.parentNode) overlay.remove(); return; }
      if (!overlay.parentNode || !el.isConnected) return;
      var r = el.getBoundingClientRect();
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
      requestAnimationFrame(reposition);
    }
    reposition();
    function onClickTarget() {
      if (overlay.parentNode) overlay.remove();
      el.removeEventListener('click', onClickTarget);
      try { window.parent.postMessage({ source: 'ohapiday-bridge', type: 'target-clicked', selector: selector, label: label || '' }, '*'); } catch (e) {}
    }
    el.addEventListener('click', onClickTarget);
    return true;
  }

  window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.source !== 'ohapiday-app') return;
    if (d.type === 'extract-dom') {
      var dom = extractDOM();
      try { dom.heuristicWarnings = detectDarkPatterns(); } catch (e) { dom.heuristicWarnings = []; }
      try { window.parent.postMessage({ source: 'ohapiday-bridge', type: 'dom', requestId: d.requestId, dom: dom }, '*'); } catch (e) {}
    }
    else if (d.type === 'highlight') {
      var ok = highlightElement(d.selector, d.label, d.safeBottom, d.largeMode);
      try { window.parent.postMessage({ source: 'ohapiday-bridge', type: 'highlight-result', requestId: d.requestId, ok: ok }, '*'); } catch (e) {}
    }
    else if (d.type === 'find-by-text') {
      var found = findByText(d.text);
      try { window.parent.postMessage({ source: 'ohapiday-bridge', type: 'find-result', requestId: d.requestId, found: found }, '*'); } catch (e) {}
    }
    else if (d.type === 'click') {
      var ok = clickElement(d.selector);
      try { window.parent.postMessage({ source: 'ohapiday-bridge', type: 'click-result', requestId: d.requestId, ok: ok }, '*'); } catch (e) {}
      if (ok) {
        setTimeout(function() {
          try { window.parent.postMessage({ source: 'ohapiday-bridge', type: 'target-clicked', selector: d.selector }, '*'); } catch (e) {}
        }, 200);
      }
    }
  });

  if (document.readyState === 'complete') sendReady();
  else window.addEventListener('load', sendReady);
  setTimeout(sendReady, 500);
  setTimeout(sendReady, 1500);
})();
</script>
`;
}

// ═════════════════════════════════════════════════════════════════════
//  CO-NAVIGATION (repris de passerelle-astrid, adapté)
// ═════════════════════════════════════════════════════════════════════
function genCode() {
  var c = '';
  for (var i = 0; i < CONAV_CODE_LENGTH; i++) c += Math.floor(Math.random() * 10);
  return c;
}

function genToken() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

async function loadSession(env, code) {
  const raw = await env.CONAV_SESSIONS.get('s:' + code);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function saveSession(env, session) {
  session.lastActivity = Date.now();
  await env.CONAV_SESSIONS.put('s:' + session.code, JSON.stringify(session), {
    expirationTtl: CONAV_TTL_SECONDS
  });
}

async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyClientToken(request, env) {
  const auth = request.headers.get('X-Astrid-Auth');
  if (!auth) return { ok: false, reason: 'Token manquant' };
  const parts = auth.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'Format token invalide' };
  const [tsStr, signature] = parts;
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return { ok: false, reason: 'Timestamp invalide' };
  const now = Date.now();
  if (now - ts > 5 * 60 * 1000) return { ok: false, reason: 'Token expiré' };
  if (ts - now > 60 * 1000) return { ok: false, reason: 'Token futur' };
  const secret = env.ASTRID_SHARED_SECRET;
  if (!secret) return { ok: false, reason: 'ASTRID_SHARED_SECRET manquant côté Worker' };
  const expected = await hmacSha256(secret, tsStr);
  if (signature !== expected) return { ok: false, reason: 'Signature invalide' };
  return { ok: true };
}

async function conavCreate(env, request) {
  const auth = await verifyClientToken(request, env);
  if (!auth.ok) return json({ error: 'Auth requise : ' + auth.reason }, 401);

  let code = null;
  for (let i = 0; i < 5; i++) {
    const c = genCode();
    const existing = await env.CONAV_SESSIONS.get('s:' + c);
    if (!existing) { code = c; break; }
  }
  if (!code) return json({ error: 'Impossible de générer un code unique' }, 503);

  const session = {
    code, hostToken: genToken(), guestToken: null,
    currentUrl: '', events: [],
    hostName: 'Hôte', guestName: null,
    createdAt: Date.now(), lastActivity: Date.now()
  };
  await saveSession(env, session);
  return json({
    ok: true, code, hostToken: session.hostToken,
    formatted: code.substring(0,3) + '-' + code.substring(3)
  });
}

async function conavJoin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  if (code.length !== CONAV_CODE_LENGTH) return json({ error: 'Code invalide (6 chiffres)' }, 400);
  const session = await loadSession(env, code);
  if (!session) return json({ error: 'Session introuvable ou expirée' }, 404);
  if (session.guestToken) return json({ error: 'Session déjà rejointe' }, 409);

  session.guestToken = genToken();
  session.guestName = body.name ? String(body.name).substring(0, 30) : 'Invité';
  session.events.push({
    id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    type: 'guest-joined', from: 'system', name: session.guestName, ts: Date.now()
  });
  await saveSession(env, session);
  return json({
    ok: true, guestToken: session.guestToken,
    currentUrl: session.currentUrl, hostName: session.hostName
  });
}

async function conavPoll(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').replace(/[^0-9]/g, '');
  const token = url.searchParams.get('token') || '';
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const session = await loadSession(env, code);
  if (!session) return json({ error: 'Session expirée' }, 404);
  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return json({ error: 'Token invalide' }, 403);
  const newEvents = (session.events || []).filter(e => e.ts > since && e.from !== role);
  const peerConnected = role === 'host' ? !!session.guestToken : true;
  return json({
    ok: true, events: newEvents,
    serverTs: Date.now(), currentUrl: session.currentUrl,
    peerName: role === 'host' ? session.guestName : session.hostName,
    peerConnected
  });
}

async function conavSend(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  const token = String(body.token || '');
  const type = String(body.type || '');
  if (!code || !token || !type) return json({ error: 'code/token/type requis' }, 400);
  const session = await loadSession(env, code);
  if (!session) return json({ error: 'Session expirée' }, 404);
  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return json({ error: 'Token invalide' }, 403);
  const validTypes = ['message', 'url-change', 'highlight', 'click-request', 'click-result', 'set-name', 'ping'];
  if (!validTypes.includes(type)) return json({ error: 'Type invalide' }, 400);

  if (type === 'click-request' || type === 'highlight') {
    const now = Date.now();
    const lastKey = '_last_' + type + '_' + role;
    const last = session[lastKey] || 0;
    const minInterval = type === 'click-request' ? 3000 : 1000;
    if (now - last < minInterval) {
      return json({ error: 'Trop rapide, attends ' + Math.ceil((minInterval - (now - last))/1000) + 's' }, 429);
    }
    session[lastKey] = now;
  }
  if (type === 'set-name') {
    const name = String(body.name || '').substring(0, 30);
    if (role === 'host') session.hostName = name || 'Hôte';
    else session.guestName = name || 'Invité';
  }
  if (type === 'url-change' && body.url && role === 'host') {
    session.currentUrl = String(body.url).substring(0, 500);
  }
  const evt = {
    id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    type, from: role, ts: Date.now()
  };
  ['text', 'url', 'selector', 'label', 'safeBottom', 'largeMode', 'name', 'ok'].forEach(k => {
    if (body[k] !== undefined) evt[k] = body[k];
  });
  session.events = (session.events || []).concat([evt]);
  if (session.events.length > CONAV_MAX_EVENTS) {
    session.events = session.events.slice(-CONAV_MAX_EVENTS);
  }
  await saveSession(env, session);
  return json({ ok: true, eventId: evt.id });
}

async function conavLeave(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  const token = String(body.token || '');
  const session = await loadSession(env, code);
  if (!session) return json({ ok: true });
  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return json({ error: 'Token invalide' }, 403);
  session.events = (session.events || []).concat([{
    id: 'e_' + Date.now().toString(36),
    type: 'peer-left', from: role, ts: Date.now()
  }]);
  if (role === 'host') {
    await env.CONAV_SESSIONS.delete('s:' + code);
  } else {
    session.guestToken = null;
    session.guestName = null;
    await saveSession(env, session);
  }
  return json({ ok: true });
}

// ═════════════════════════════════════════════════════════════════════
//  HEARTBEAT — agrégat unique lu d'un seul get
// ═════════════════════════════════════════════════════════════════════
async function heartbeatReceive(request, env) {
  if (!env || !env.CONAV_SESSIONS) return json({ ok: false, reason: 'KV indispo' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'JSON invalide' }, 400); }

  let events = [];
  if (body && Array.isArray(body.batch)) events = body.batch.slice(0, 50);
  else if (body && body.event) events = [body];
  else return json({ error: 'Format invalide' }, 400);

  const buckets = new Map();
  for (const evt of events) {
    if (!evt) continue;
    const event = String(evt.event || '').substring(0, 32).replace(/[^a-z0-9_-]/gi, '');
    const success = evt.success === true || evt.success === false ? evt.success : null;
    const domain = String(evt.domain || '').substring(0, 80).replace(/[^a-z0-9.\-]/gi, '');
    const duration = typeof evt.duration === 'number' && evt.duration >= 0 && evt.duration < 600000
      ? Math.round(evt.duration) : null;
    if (!event) continue;
    const day = new Date(evt.ts || Date.now()).toISOString().substring(0, 10);
    const outcome = success === null ? 'na' : (success ? 'ok' : 'fail');
    const key = 'hb:' + day + ':' + event + ':' + outcome;
    if (!buckets.has(key)) buckets.set(key, { count: 0, domains: {}, durationSum: 0, durationCount: 0 });
    const b = buckets.get(key);
    b.count++;
    if (domain) b.domains[domain] = (b.domains[domain] || 0) + 1;
    if (duration !== null) { b.durationSum += duration; b.durationCount++; }
  }
  for (const [key, newAgg] of buckets) {
    try {
      const cur = await env.CONAV_SESSIONS.get(key);
      const agg = cur ? JSON.parse(cur) : { count: 0, domains: {}, durationSum: 0, durationCount: 0 };
      agg.count += newAgg.count;
      for (const [d, c] of Object.entries(newAgg.domains)) agg.domains[d] = (agg.domains[d] || 0) + c;
      agg.durationSum += newAgg.durationSum;
      agg.durationCount += newAgg.durationCount;
      const dKeys = Object.keys(agg.domains);
      if (dKeys.length > 100) {
        const sorted = dKeys.sort((a, b) => agg.domains[b] - agg.domains[a]).slice(0, 50);
        const trimmed = {};
        sorted.forEach(k => trimmed[k] = agg.domains[k]);
        agg.domains = trimmed;
      }
      await env.CONAV_SESSIONS.put(key, JSON.stringify(agg), { expirationTtl: 7 * 86400 });
    } catch (e) {}
  }
  return json({ ok: true, processed: events.length, buckets: buckets.size });
}

// GET /heartbeat/stats — lit UN SEUL agrégat (mis à jour par cron)
async function heartbeatStats(env) {
  if (!env || !env.CONAV_SESSIONS) return json({ error: 'KV indispo' }, 503);
  try {
    const cached = await env.CONAV_SESSIONS.get('hb:stats:daily:latest');
    if (cached) {
      const data = JSON.parse(cached);
      return json({ ok: true, stats: data.stats, generated: data.generated, cached: true });
    }
    // Premier appel avant que le cron ait tourné : construire à la volée
    const rebuilt = await rebuildHeartbeatAggregate(env);
    return json({ ok: true, stats: rebuilt.stats, generated: rebuilt.generated, cached: false });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// Reconstruit l'agrégat quotidien et l'écrit en une clé unique
async function rebuildHeartbeatAggregate(env) {
  const list = await env.CONAV_SESSIONS.list({ prefix: 'hb:', limit: 1000 });
  const stats = {};
  for (const k of list.keys) {
    if (k.name.startsWith('hb:stats:')) continue;
    const v = await env.CONAV_SESSIONS.get(k.name);
    if (!v) continue;
    const parts = k.name.split(':');
    if (parts.length !== 4) continue;
    const day = parts[1], event = parts[2], outcome = parts[3];
    stats[day] = stats[day] || {};
    stats[day][event] = stats[day][event] || { ok: 0, fail: 0, na: 0, durationAvgMs: null, topDomains: {} };
    try {
      const agg = JSON.parse(v);
      stats[day][event][outcome] = agg.count;
      if (agg.durationCount > 0) {
        stats[day][event].durationAvgMs = Math.round(agg.durationSum / agg.durationCount);
      }
      for (const [d, c] of Object.entries(agg.domains || {})) {
        stats[day][event].topDomains[d] = (stats[day][event].topDomains[d] || 0) + c;
      }
    } catch (e) {}
  }
  const result = { stats, generated: new Date().toISOString() };
  await env.CONAV_SESSIONS.put('hb:stats:daily:latest', JSON.stringify(result), { expirationTtl: 86400 * 8 });
  return result;
}

// ═════════════════════════════════════════════════════════════════════
//  UTILS
// ═════════════════════════════════════════════════════════════════════
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...cors() }
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-Auth, X-Astrid-Ext, X-Astrid-Auth'
  };
}
