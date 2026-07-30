// ════════════════════════════════════════════════════════════════════════
// 🌉 Passerelle Oh API Day — Worker personnel (V3.2)
// ════════════════════════════════════════════════════════════════════════
//
//  CE QUI CHANGE DEPUIS LA V3.1
//  ─────────────────────────────
//  ✓ Contrat /ai aligné sur la PWA (systemPrompt/userPrompt/maxTokens, ok:true)
//  ✓ Contrat /galaxy/search aligné (results au lieu de matches, k accepté)
//  ✓ HMAC co-nav : fallback sur le secret par défaut de la PWA
//  ✓ 5 modes d'orchestration : single, cascade, parallel, review, battle
//  ✓ GET /providers — le catalogue que l'user voit dans son app
//  ✓ Moteur BYO — n'importe quel provider décrit par l'user
//  ✓ Compteurs de quota par provider, lus dans les headers quand ils existent
//  ✓ Apprentissage du comportement : hard / soft / unknown
//  ✓ Garde-fou 402 : on s'arrête au gratuit sur les providers qui facturent
//  ✓ Support des images en entrée de /ai
//  ✓ tokensUsed renvoyé pour que le Budget Guardian voie clair
//
//  LES 5 MODES
//  ───────────
//  single    { provider }                     une IA choisie, pas de fallback
//  cascade   { providers: [...] }             l'ordre de l'user, bascule si limite
//  parallel  { providers, synthesizer }       plusieurs en même temps + synthèse
//  review    { worker, reviewer }             une travaille, une corrige
//  battle    { providers }                    réponses brutes, l'user vote
//
//  ROUTES
//  ──────
//  GET    /health              statut
//  GET    /providers           catalogue avec quotas et état
//  POST   /providers/custom    enregistre un provider BYO
//  DELETE /providers/custom/:id
//  POST   /ai                  les 5 modes
//  POST   /galaxy/embed        vecteur bge-m3
//  POST   /galaxy/search       top-k étoiles
//  POST   /galaxy/save         sauvegarde étoile
//  GET    /galaxy/pull         sync
//  DELETE /galaxy/star/:id
//  POST   /ext/mint            crée un accès QR+PIN
//  POST   /ext/activate        échange code+PIN contre jeton
//  GET    /ext/events          journal d'activations
//  GET    /proxy-web           proxy pour Navig
//  GET    /proxy-asset         assets, avec cache 24 h
//  POST   /conav/*             co-navigation
//  POST   /heartbeat           stats anonymes
//  GET    /heartbeat/stats     agrégat, une seule lecture KV
//
//  SECRETS (Settings > Variables and Secrets > "Secret")
//  ─────────────────────────────────────────────────────
//  AI_TOKEN               obligatoire   auth des routes /ai, /galaxy, /providers
//  APP_SECRET             obligatoire   auth de l'app pour /ext/mint
//  ASTRID_SHARED_SECRET   optionnel     HMAC co-nav (fallback si absent)
//  GROQ_KEY, GEMINI_KEY, CEREBRAS_KEY, MISTRAL_KEY, OPENROUTER_KEY,
//  OPENAI_KEY, ANTHROPIC_KEY, DEEPSEEK_KEY, TOGETHER_KEY,
//  GITHUB_KEY, SAMBANOVA_KEY, XAI_KEY, NVIDIA_KEY
//
//  VARIABLES (Plain text)
//  ──────────────────────
//  ALLOWED_ORIGIN         défaut https://ohapi-day-f37288.gitlab.io, "*" pour ouvrir
//  ALLOW_OVERAGE          "true" pour autoriser le dépassement payant
//  OVERAGE_CAP_CALLS      plafond d'appels payants par jour (défaut 0)
//
//  BINDINGS
//  ────────
//  AI               Workers AI
//  GALAXY           KV — étoiles, activations, providers custom, quotas
//  CONAV_SESSIONS   KV — co-nav et heartbeat
//
//  CONVENTIONS KV
//  ──────────────
//  v1:owner:{ownerId}                  profil
//  v1:actv:{code}                      activation en attente, TTL 600 s
//  v1:ext:{token}                      sceau d'extension
//  v1:event:{ownerId}:{ts}             journal, TTL 90 j
//  v1:custom:{id}                      provider BYO
//  v1:quota:{provider}:{jour}          compteur d'appels
//  v1:learn:{provider}                 ce qu'on a observé du provider
//  galaxy:{userId}                     étoiles
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_ALLOWED_ORIGIN = 'https://ohapi-day-f37288.gitlab.io';
const DEFAULT_SHARED_SECRET  = 'astrid-default-secret-change-in-prod-v1';

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

// Plafond de sécurité pour un provider dont on ne connaît pas les limites
const UNKNOWN_PROVIDER_DAILY_CAP = 200;

// ════════════════════════════════════════════════════════════════════════
//  CATALOGUE DES PROVIDERS CONNUS
//  billing: 'hard'    refuse au-delà du quota, aucun risque financier
//           'soft'    continue et facture — c'est le dangereux
//           'paid'    payant d'emblée, l'user le sait
//           'unknown' on ne sait pas encore, on apprend
// ════════════════════════════════════════════════════════════════════════
const CATALOG = {
  'cloudflare-workers-ai': {
    name: 'Workers AI (Llama 3.3 70B)', family: 'Cloudflare',
    billing: 'soft', vision: false, binding: true,
    freeQuota: { unit: 'neurons', limit: 10000, period: 'day' },
    overageRate: '0.011 $ / 1000 neurons'
  },
  'groq-llama': {
    name: 'Groq Llama 3.3 70B', family: 'Meta', keyEnv: 'GROQ_KEY',
    billing: 'hard', vision: false,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    freeQuota: { unit: 'requests', limit: 14400, period: 'day' }
  },
  'gemini-text': {
    name: 'Gemini 2.5 Flash', family: 'Google', keyEnv: 'GEMINI_KEY',
    billing: 'hard', vision: true, kind: 'gemini',
    model: 'gemini-2.5-flash',
    freeQuota: { unit: 'requests', limit: 1500, period: 'day' }
  },
  'gemini-pro': {
    name: 'Gemini 2.5 Pro', family: 'Google', keyEnv: 'GEMINI_KEY',
    billing: 'hard', vision: true, kind: 'gemini',
    model: 'gemini-2.5-pro',
    freeQuota: { unit: 'requests', limit: 50, period: 'day' }
  },
  'cerebras-text': {
    name: 'Cerebras Llama 3.3 70B', family: 'Meta', keyEnv: 'CEREBRAS_KEY',
    billing: 'hard', vision: false,
    url: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'llama-3.3-70b',
    freeQuota: { unit: 'requests', limit: 14400, period: 'day' }
  },
  'mistral-text': {
    name: 'Mistral Small', family: 'Mistral', keyEnv: 'MISTRAL_KEY',
    billing: 'hard', vision: false,
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
    freeQuota: { unit: 'requests', limit: 1000, period: 'day' }
  },
  'deepseek-text': {
    name: 'DeepSeek Chat', family: 'DeepSeek', keyEnv: 'DEEPSEEK_KEY',
    billing: 'paid', vision: false,
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat'
  },
  'together-text': {
    name: 'Together Llama', family: 'Meta', keyEnv: 'TOGETHER_KEY',
    billing: 'soft', vision: false,
    url: 'https://api.together.xyz/v1/chat/completions',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
  },
  'openrouter': {
    name: 'OpenRouter (Llama 3.3 free)', family: 'Meta', keyEnv: 'OPENROUTER_KEY',
    billing: 'soft', vision: false,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    freeQuota: { unit: 'requests', limit: 50, period: 'day' }
  },
  'openrouter-gemini': {
    name: 'OpenRouter (Gemini Flash Lite free)', family: 'Google', keyEnv: 'OPENROUTER_KEY',
    billing: 'soft', vision: true,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'google/gemini-2.5-flash-lite:free',
    freeQuota: { unit: 'requests', limit: 50, period: 'day' }
  },
  'openai-gpt': {
    name: 'GPT-4o', family: 'OpenAI', keyEnv: 'OPENAI_KEY',
    billing: 'paid', vision: true,
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o'
  },
  'anthropic': {
    name: 'Claude Haiku 4.5', family: 'Anthropic', keyEnv: 'ANTHROPIC_KEY',
    billing: 'paid', vision: true, kind: 'anthropic',
    model: 'claude-haiku-4-5-20251001'
  },
  'github-gpt': {
    name: 'GitHub Models — GPT-4o', family: 'OpenAI', keyEnv: 'GITHUB_KEY',
    billing: 'hard', vision: true,
    url: 'https://models.inference.ai.azure.com/chat/completions',
    model: 'gpt-4o',
    freeQuota: { unit: 'requests', limit: 150, period: 'day' }
  },
  'sambanova-llama': {
    name: 'SambaNova Llama 405B', family: 'Meta', keyEnv: 'SAMBANOVA_KEY',
    billing: 'hard', vision: false,
    url: 'https://api.sambanova.ai/v1/chat/completions',
    model: 'Meta-Llama-3.1-405B-Instruct',
    freeQuota: { unit: 'requests', limit: 1000, period: 'day' }
  },
  'xai-grok': {
    name: 'xAI Grok', family: 'xAI', keyEnv: 'XAI_KEY',
    billing: 'paid', vision: true,
    url: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-3-mini'
  },
  'nvidia-llama': {
    name: 'NVIDIA Llama 70B', family: 'Meta', keyEnv: 'NVIDIA_KEY',
    billing: 'hard', vision: false,
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'meta/llama-3.3-70b-instruct',
    freeQuota: { unit: 'requests', limit: 1000, period: 'day' }
  }
};

// ════════════════════════════════════════════════════════════════════════
//  ROUTEUR
// ════════════════════════════════════════════════════════════════════════
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
        version: '3.2',
        contract: '3.2',
        ai:         !!env.AI,
        embeddings: !!env.AI,
        galaxy:     !!env.GALAXY,
        conav:      !!env.CONAV_SESSIONS,
        activation: !!env.GALAXY && !!env.APP_SECRET,
        proxy: true,
        modes: ['single', 'cascade', 'parallel', 'review', 'battle'],
        allowedOrigin: env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN,
        providers: listAvailableIds(env),
        secured: !!env.AI_TOKEN
      });
    }

    // ── PROVIDERS ────────────────────────────────────────────────
    if (path === '/providers' && request.method === 'GET') {
      const authErr = checkAuth(request, env);
      if (authErr) return authErr;
      return await handleProvidersList(env);
    }
    if (path === '/providers/custom' && request.method === 'POST') {
      const authErr = checkAuth(request, env);
      if (authErr) return authErr;
      return await handleCustomAdd(request, env);
    }
    if (path.startsWith('/providers/custom/') && request.method === 'DELETE') {
      const authErr = checkAuth(request, env);
      if (authErr) return authErr;
      return await handleCustomDelete(env, path.substring('/providers/custom/'.length));
    }

    // ── IA ───────────────────────────────────────────────────────
    if (path === '/ai' && request.method === 'POST') {
      return await handleAi(request, env, ctx);
    }

    // ── GALAXY ───────────────────────────────────────────────────
    if (path.startsWith('/galaxy/')) {
      const authErr = checkAuth(request, env);
      if (authErr) return authErr;
      if (!env.AI) return json({ ok: false, error: 'Workers AI binding manquant' }, 503);

      if (path === '/galaxy/embed'  && request.method === 'POST') return await handleGalaxyEmbed(request, env);
      if (path === '/galaxy/search' && request.method === 'POST') return await handleGalaxySearch(request, env);
      if (path === '/galaxy/save'   && request.method === 'POST') return await handleGalaxySave(request, env);
      if (path === '/galaxy/pull'   && request.method === 'GET')  return await handleGalaxyPull(request, env);
      if (path.startsWith('/galaxy/star/') && request.method === 'DELETE') {
        return await handleGalaxyDelete(request, env, path.substring('/galaxy/star/'.length));
      }
    }

    // ── ACTIVATION EXTENSION ─────────────────────────────────────
    if (path === '/ext/mint'     && request.method === 'POST') return await handleExtMint(request, env);
    if (path === '/ext/activate' && request.method === 'POST') return await handleExtActivate(request, env);
    if (path === '/ext/events'   && request.method === 'GET')  return await handleExtEvents(request, env);

    // ── PROXY ────────────────────────────────────────────────────
    if (path === '/proxy-web' || path === '/proxy-web/') {
      const originErr = checkOrigin(request, env);
      if (originErr) return originErr;
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing ?url=', { status: 400, headers: cors() });
      return await proxyRequest(target, url.origin, request, env);
    }
    if (path === '/proxy-asset' || path === '/proxy-asset/') {
      const originErr = checkOrigin(request, env);
      if (originErr) return originErr;
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing ?url=', { status: 400, headers: cors() });
      return await proxyAsset(target);
    }

    // ── CO-NAVIGATION ────────────────────────────────────────────
    if (path.startsWith('/conav/')) {
      if (!env.CONAV_SESSIONS) return json({ ok: false, error: 'KV CONAV_SESSIONS manquant' }, 503);
      try {
        if (path === '/conav/create' && request.method === 'POST') return await conavCreate(env, request);
        if (path === '/conav/join'   && request.method === 'POST') return await conavJoin(request, env);
        if (path === '/conav/poll'   && request.method === 'GET')  return await conavPoll(request, env);
        if (path === '/conav/send'   && request.method === 'POST') return await conavSend(request, env);
        if (path === '/conav/leave'  && request.method === 'POST') return await conavLeave(request, env);
        return json({ ok: false, error: 'Route conav inconnue' }, 404);
      } catch (e) {
        return json({ ok: false, error: e.message || 'Erreur interne conav' }, 500);
      }
    }

    // ── HEARTBEAT ────────────────────────────────────────────────
    if (path === '/heartbeat' && request.method === 'POST') return await heartbeatReceive(request, env);
    if (path === '/heartbeat/stats' && request.method === 'GET') return await heartbeatStats(env);

    return new Response('Not found', { status: 404, headers: cors() });
  },

  async scheduled(controller, env, ctx) {
    if (!env.CONAV_SESSIONS) return;
    try { await rebuildHeartbeatAggregate(env); }
    catch (e) { console.error('cron heartbeat', e); }
  }
};

// ════════════════════════════════════════════════════════════════════════
//  PROVIDERS — catalogue, disponibilité, BYO
// ════════════════════════════════════════════════════════════════════════

function listAvailableIds(env) {
  const out = [];
  for (const [id, p] of Object.entries(CATALOG)) {
    if (p.binding && env.AI) { out.push(id); continue; }
    if (p.keyEnv && env[p.keyEnv]) out.push(id);
  }
  return out;
}

async function getCustomProviders(env) {
  if (!env.GALAXY) return [];
  try {
    const list = await env.GALAXY.list({ prefix: 'v1:custom:', limit: 100 });
    const out = [];
    for (const k of list.keys) {
      const raw = await env.GALAXY.get(k.name);
      if (raw) out.push(JSON.parse(raw));
    }
    return out;
  } catch (e) { return []; }
}

async function handleProvidersList(env) {
  const today = dayKey();
  const out = [];

  for (const [id, p] of Object.entries(CATALOG)) {
    const hasKey = p.binding ? !!env.AI : !!(p.keyEnv && env[p.keyEnv]);
    const used   = hasKey ? await getQuotaUsed(env, id, today) : 0;
    const learned = hasKey ? await getLearned(env, id) : null;

    out.push({
      id,
      name: p.name,
      family: p.family,
      hasKey,
      billing: (learned && learned.billing) || p.billing,
      vision: !!p.vision,
      custom: false,
      freeQuota: p.freeQuota || null,
      overageRate: p.overageRate || null,
      quota: hasKey ? {
        used,
        limit: p.freeQuota ? p.freeQuota.limit : null,
        unit:  p.freeQuota ? p.freeQuota.unit  : 'requests',
        resetIn: secondsUntilMidnightUTC()
      } : null,
      confidence: learned ? learned.confidence : (p.freeQuota ? 'catalog' : 'low'),
      observed: learned ? learned.observed : null
    });
  }

  for (const c of await getCustomProviders(env)) {
    const used = await getQuotaUsed(env, 'custom-' + c.id, today);
    const learned = await getLearned(env, 'custom-' + c.id);
    out.push({
      id: 'custom-' + c.id,
      name: c.name || c.id,
      family: 'Perso',
      hasKey: true,
      billing: (learned && learned.billing) || c.billing || 'unknown',
      vision: false,
      custom: true,
      freeQuota: null,
      userCap: c.cap || UNKNOWN_PROVIDER_DAILY_CAP,
      quota: {
        used,
        limit: c.cap || UNKNOWN_PROVIDER_DAILY_CAP,
        unit: 'requests',
        resetIn: secondsUntilMidnightUTC()
      },
      confidence: learned ? learned.confidence : 'low',
      observed: learned ? learned.observed : null
    });
  }

  return json({ ok: true, providers: out, day: today });
}

async function handleCustomAdd(request, env) {
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const id = String(body.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!id) return json({ ok: false, error: 'id_requis' }, 400);
  if (!body.url || !/^https:\/\//.test(body.url)) {
    return json({ ok: false, error: 'url_https_requise' }, 400);
  }

  const entry = {
    id,
    name: String(body.name || id).slice(0, 80),
    url: body.url,
    method: (body.method === 'GET' ? 'GET' : 'POST'),
    auth: String(body.auth || '').slice(0, 400),
    body: String(body.body || '{"prompt":"{prompt}"}').slice(0, 2000),
    returnPath: String(body.returnPath || '').slice(0, 120),  // ex: "choices.0.message.content"
    billing: ['hard','soft','paid','unknown'].includes(body.billing) ? body.billing : 'unknown',
    cap: Math.max(1, Math.min(100000, parseInt(body.cap) || UNKNOWN_PROVIDER_DAILY_CAP)),
    createdAt: Date.now()
  };

  await env.GALAXY.put('v1:custom:' + id, JSON.stringify(entry));
  return json({ ok: true, provider: { ...entry, auth: entry.auth ? '***' : '' } });
}

async function handleCustomDelete(env, id) {
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return json({ ok: false, error: 'id_requis' }, 400);
  await env.GALAXY.delete('v1:custom:' + clean);
  return json({ ok: true, deleted: clean });
}

// ════════════════════════════════════════════════════════════════════════
//  QUOTAS — compteurs, apprentissage, garde-fou
// ════════════════════════════════════════════════════════════════════════

function dayKey() { return new Date().toISOString().slice(0, 10); }

function secondsUntilMidnightUTC() {
  const now = Date.now();
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T23:59:59Z').getTime();
  return Math.max(0, Math.floor((midnight - now) / 1000));
}

async function getQuotaUsed(env, providerId, day) {
  if (!env.GALAXY) return 0;
  try {
    const raw = await env.GALAXY.get(`v1:quota:${providerId}:${day}`);
    return raw ? (JSON.parse(raw).used || 0) : 0;
  } catch (e) { return 0; }
}

async function bumpQuota(env, providerId, day, amount) {
  if (!env.GALAXY) return;
  try {
    const key = `v1:quota:${providerId}:${day}`;
    const raw = await env.GALAXY.get(key);
    const cur = raw ? JSON.parse(raw) : { used: 0 };
    cur.used += (amount || 1);
    cur.last = Date.now();
    await env.GALAXY.put(key, JSON.stringify(cur), { expirationTtl: 172800 });
  } catch (e) { /* silencieux */ }
}

async function getLearned(env, providerId) {
  if (!env.GALAXY) return null;
  try {
    const raw = await env.GALAXY.get(`v1:learn:${providerId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Enregistre ce qu'on a observé du provider : headers, 429, plafond réel
async function learnFromResponse(env, providerId, resp, callsToday) {
  if (!env.GALAXY) return;
  try {
    const key = `v1:learn:${providerId}`;
    const raw = await env.GALAXY.get(key);
    const rec = raw ? JSON.parse(raw) : {
      billing: 'unknown', confidence: 'low',
      observed: { calls: 0, first: Date.now(), last429: null, limitObserved: null, headers: [] }
    };

    rec.observed.calls = (rec.observed.calls || 0) + 1;
    rec.observed.maxCallsInOneDay = Math.max(rec.observed.maxCallsInOneDay || 0, callsToday || 0);

    // Lecture des headers de rate limit — ils donnent la vérité gratuitement
    const rl = readRateLimitHeaders(resp);
    if (rl.limit != null) {
      rec.observed.limitObserved = rl.limit;
      rec.observed.remaining = rl.remaining;
      rec.observed.resetIn = rl.resetIn;
      if (!rec.observed.headers.includes(rl.source)) rec.observed.headers.push(rl.source);
      rec.confidence = 'high';
      if (rec.billing === 'unknown') rec.billing = 'hard';   // il annonce un quota, donc il refuse
    }

    // Un 429 prouve qu'il y a un mur : bonne nouvelle
    if (resp.status === 429) {
      rec.observed.last429 = Date.now();
      rec.billing = 'hard';
      rec.confidence = 'high';
      if (rec.observed.limitObserved == null) rec.observed.limitObserved = callsToday;
    }

    // Un 402 prouve qu'il facture
    if (resp.status === 402) {
      rec.billing = 'paid';
      rec.confidence = 'high';
    }

    await env.GALAXY.put(key, JSON.stringify(rec));
  } catch (e) { /* silencieux */ }
}

function readRateLimitHeaders(resp) {
  const h = resp.headers;
  const pick = (...names) => {
    for (const n of names) { const v = h.get(n); if (v != null) return v; }
    return null;
  };
  const limit = pick('x-ratelimit-limit-requests', 'x-ratelimit-limit', 'ratelimit-limit');
  const rem   = pick('x-ratelimit-remaining-requests', 'x-ratelimit-remaining', 'ratelimit-remaining');
  const reset = pick('x-ratelimit-reset-requests', 'x-ratelimit-reset', 'ratelimit-reset', 'retry-after');
  return {
    limit: limit != null ? parseInt(String(limit).replace(/[^\d]/g, '')) || null : null,
    remaining: rem != null ? parseInt(String(rem).replace(/[^\d]/g, '')) || 0 : null,
    resetIn: reset != null ? parseDuration(String(reset)) : null,
    source: limit != null ? 'headers' : 'none'
  };
}

function parseDuration(s) {
  if (/^\d+$/.test(s)) {
    const n = parseInt(s);
    return n > 1e9 ? Math.max(0, n - Math.floor(Date.now() / 1000)) : n;  // epoch ou secondes
  }
  let total = 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g) || [];
  for (const part of m) {
    const [, val, unit] = part.match(/(\d+(?:\.\d+)?)\s*(h|m|s|ms)/);
    const v = parseFloat(val);
    total += unit === 'h' ? v * 3600 : unit === 'm' ? v * 60 : unit === 's' ? v : v / 1000;
  }
  return Math.round(total) || null;
}

// Le garde-fou : est-ce qu'on a le droit d'appeler ce provider maintenant ?
async function checkAllowance(env, providerId, spec) {
  const day = dayKey();
  const used = await getQuotaUsed(env, providerId, day);
  const learned = await getLearned(env, providerId);
  const billing = (learned && learned.billing) || spec.billing || 'unknown';

  // Provider inconnu ou custom : plafond déclaré par l'user
  if (spec.custom || billing === 'unknown') {
    const cap = spec.cap || UNKNOWN_PROVIDER_DAILY_CAP;
    if (used >= cap) {
      return {
        allowed: false, code: 402, error: 'user_cap_reached',
        used, cap, confidence: learned ? learned.confidence : 'low',
        message: "Tu as atteint le plafond que tu as fixé pour ce provider. On ne connaît pas encore ses vraies limites."
      };
    }
    return { allowed: true, used };
  }

  // Provider qui facture au-delà du gratuit : on s'arrête, sauf autorisation
  if (billing === 'soft' && spec.freeQuota) {
    const overageAllowed = env.ALLOW_OVERAGE === 'true';
    const overageCap = parseInt(env.OVERAGE_CAP_CALLS || '0') || 0;
    const estimate = spec.freeQuota.unit === 'neurons' ? used : used;
    if (estimate >= spec.freeQuota.limit) {
      if (!overageAllowed || (overageCap > 0 && used >= spec.freeQuota.limit + overageCap)) {
        return {
          allowed: false, code: 402, error: 'free_quota_reached',
          used, limit: spec.freeQuota.limit, unit: spec.freeQuota.unit,
          resetIn: secondsUntilMidnightUTC(),
          overage: { possible: true, rate: spec.overageRate || null, allowed: overageAllowed },
          message: `Ton gratuit ${spec.name} est épuisé. Au-delà, c'est facturé.`
        };
      }
    }
    return { allowed: true, used };
  }

  // Provider à quota dur : on peut y aller, il refusera tout seul si besoin
  if (billing === 'hard' && spec.freeQuota && used >= spec.freeQuota.limit) {
    return {
      allowed: false, code: 429, error: 'quota_reached',
      used, limit: spec.freeQuota.limit,
      resetIn: secondsUntilMidnightUTC(),
      message: `${spec.name} a atteint sa limite gratuite du jour.`
    };
  }

  return { allowed: true, used };
}

// ════════════════════════════════════════════════════════════════════════
//  /ai — LES 5 MODES
// ════════════════════════════════════════════════════════════════════════
async function handleAi(request, env, ctx) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  // Contrat souple : les trois formats acceptés
  const systemPrompt = body.systemPrompt || body.sys || '';
  const userPrompt   = body.userPrompt   || body.user || body.prompt || '';
  const maxTokens    = Math.min(parseInt(body.maxTokens || body.max_tokens) || 800, 8000);
  const image        = body.image || body.imageBase64 || null;
  const messages     = body.messages || null;

  const req = { systemPrompt, userPrompt, maxTokens, image, messages };

  // Providers custom envoyés à la volée, en plus de ceux enregistrés
  const inlineCustom = Array.isArray(body.customProviders) ? body.customProviders : [];

  const mode = body.mode || (body.provider ? 'single' : 'cascade');

  try {
    if (mode === 'single')   return await modeSingle(env, req, body, inlineCustom);
    if (mode === 'cascade')  return await modeCascade(env, req, body, inlineCustom);
    if (mode === 'parallel') return await modeParallel(env, req, body, inlineCustom);
    if (mode === 'review')   return await modeReview(env, req, body, inlineCustom);
    if (mode === 'battle')   return await modeBattle(env, req, body, inlineCustom);
    return json({ ok: false, error: 'mode_inconnu', modes: ['single','cascade','parallel','review','battle'] }, 400);
  } catch (e) {
    return json({ ok: false, error: 'erreur_interne', details: String(e && e.message || e).slice(0, 300) }, 500);
  }
}

// ─── single : une IA choisie, pas de fallback ────────────────────
async function modeSingle(env, req, body, inlineCustom) {
  const id = body.provider;
  if (!id) return json({ ok: false, error: 'provider_requis' }, 400);

  const spec = await resolveProvider(env, id, inlineCustom);
  if (!spec) return json({ ok: false, error: 'provider_inconnu', provider: id }, 400);
  if (!spec.available) return json({ ok: false, error: 'provider_sans_cle', provider: id }, 400);

  const allow = await checkAllowance(env, id, spec);
  if (!allow.allowed) {
    return json({
      ok: false, error: allow.error, provider: id,
      ...allow, alternatives: await suggestAlternatives(env, id, req)
    }, allow.code);
  }

  const r = await callProvider(env, spec, req);
  await bumpQuota(env, id, dayKey(), r.quotaUnits || 1);

  if (!r.ok) {
    return json({
      ok: false, error: 'provider_echec', provider: id,
      details: r.error, status: r.status,
      alternatives: await suggestAlternatives(env, id, req)
    }, 502);
  }

  return json({
    ok: true, text: r.text, provider: id, model: spec.model || null,
    tokensUsed: r.tokensUsed, quota: await quotaSnapshot(env, id, spec)
  });
}

// ─── cascade : l'ordre de l'user, bascule si limite ──────────────
async function modeCascade(env, req, body, inlineCustom) {
  let ids = Array.isArray(body.providers) && body.providers.length
    ? body.providers
    : listAvailableIds(env);

  if (!ids.length) return json({ ok: false, error: 'aucun_provider' }, 503);

  const tried = [];
  for (const id of ids) {
    const spec = await resolveProvider(env, id, inlineCustom);
    if (!spec || !spec.available) { tried.push({ provider: id, reason: 'sans_cle' }); continue; }

    const allow = await checkAllowance(env, id, spec);
    if (!allow.allowed) { tried.push({ provider: id, reason: allow.error, used: allow.used }); continue; }

    const r = await callProvider(env, spec, req);
    await bumpQuota(env, id, dayKey(), r.quotaUnits || 1);

    if (r.ok) {
      return json({
        ok: true, text: r.text, provider: id, model: spec.model || null,
        tokensUsed: r.tokensUsed, tried,
        quota: await quotaSnapshot(env, id, spec)
      });
    }
    tried.push({ provider: id, reason: r.status === 429 ? 'rate_limit_429' : 'echec', status: r.status });
  }

  return json({ ok: false, error: 'tous_les_providers_ont_echoue', tried }, 502);
}

// ─── parallel : plusieurs en même temps + synthèse ───────────────
async function modeParallel(env, req, body, inlineCustom) {
  const ids = Array.isArray(body.providers) ? body.providers : [];
  if (ids.length < 2) return json({ ok: false, error: 'au_moins_deux_providers' }, 400);

  const specs = [];
  for (const id of ids) {
    const s = await resolveProvider(env, id, inlineCustom);
    if (s && s.available) {
      const allow = await checkAllowance(env, id, s);
      if (allow.allowed) specs.push({ id, spec: s });
    }
  }
  if (!specs.length) return json({ ok: false, error: 'aucun_provider_disponible' }, 503);

  const settled = await Promise.allSettled(
    specs.map(({ spec }) => callProvider(env, spec, req))
  );

  const sources = [];
  let totalTokens = 0;
  for (let i = 0; i < settled.length; i++) {
    const id = specs[i].id;
    const res = settled[i];
    await bumpQuota(env, id, dayKey(),
      (res.status === 'fulfilled' && res.value.quotaUnits) || 1);
    if (res.status === 'fulfilled' && res.value.ok) {
      sources.push({ provider: id, text: res.value.text, tokensUsed: res.value.tokensUsed });
      totalTokens += res.value.tokensUsed || 0;
    } else {
      sources.push({ provider: id, error: true, reason: res.status === 'rejected' ? 'exception' : res.value.error });
    }
  }

  const valides = sources.filter(s => !s.error);
  if (!valides.length) return json({ ok: false, error: 'toutes_les_reponses_ont_echoue', sources }, 502);
  if (valides.length === 1) {
    return json({ ok: true, text: valides[0].text, provider: valides[0].provider,
      sources, tokensUsed: totalTokens, synthesizer: null });
  }

  // Synthèse par le provider choisi par l'user
  const synthId = body.synthesizer || valides[0].provider;
  const synthSpec = await resolveProvider(env, synthId, inlineCustom);
  if (!synthSpec || !synthSpec.available) {
    return json({ ok: true, text: valides[0].text, provider: valides[0].provider,
      sources, tokensUsed: totalTokens, synthesizer: null,
      note: 'synthetiseur_indisponible' });
  }

  const synthPrompt =
    `Voici ${valides.length} réponses de plusieurs IA à la même question.\n` +
    `Produis UNE synthèse claire qui prend le meilleur de chaque réponse et corrige les erreurs.\n\n` +
    `QUESTION : ${req.userPrompt}\n\n` +
    valides.map((v, i) => `RÉPONSE ${i + 1} (${v.provider}) :\n${v.text}`).join('\n\n---\n\n') +
    `\n\nÉcris la synthèse finale, sans méta-commentaire :`;

  const synth = await callProvider(env, synthSpec, {
    systemPrompt: req.systemPrompt || 'Tu produis des synthèses claires et fidèles.',
    userPrompt: synthPrompt, maxTokens: req.maxTokens
  });
  await bumpQuota(env, synthId, dayKey(), synth.quotaUnits || 1);

  if (!synth.ok) {
    return json({ ok: true, text: valides[0].text, provider: valides[0].provider,
      sources, tokensUsed: totalTokens, synthesizer: null, note: 'synthese_echouee' });
  }

  return json({
    ok: true, text: synth.text, provider: 'synthese',
    synthesizer: synthId, sources,
    tokensUsed: totalTokens + (synth.tokensUsed || 0)
  });
}

// ─── review : une travaille, une corrige ─────────────────────────
async function modeReview(env, req, body, inlineCustom) {
  const workerId   = body.worker;
  const reviewerId = body.reviewer;
  if (!workerId || !reviewerId) {
    return json({ ok: false, error: 'worker_et_reviewer_requis' }, 400);
  }

  const wSpec = await resolveProvider(env, workerId, inlineCustom);
  const rSpec = await resolveProvider(env, reviewerId, inlineCustom);
  if (!wSpec || !wSpec.available) return json({ ok: false, error: 'worker_indisponible', provider: workerId }, 400);
  if (!rSpec || !rSpec.available) return json({ ok: false, error: 'reviewer_indisponible', provider: reviewerId }, 400);

  const wAllow = await checkAllowance(env, workerId, wSpec);
  if (!wAllow.allowed) return json({ ok: false, error: wAllow.error, provider: workerId, ...wAllow }, wAllow.code);

  // 1. L'ouvrier produit
  const draft = await callProvider(env, wSpec, req);
  await bumpQuota(env, workerId, dayKey(), draft.quotaUnits || 1);
  if (!draft.ok) {
    return json({ ok: false, error: 'ouvrier_echec', provider: workerId, details: draft.error }, 502);
  }

  const rAllow = await checkAllowance(env, reviewerId, rSpec);
  if (!rAllow.allowed) {
    return json({ ok: true, text: draft.text, draft: draft.text, verdict: 'NON_RELU',
      worker: workerId, reviewer: null, tokensUsed: draft.tokensUsed,
      note: 'correcteur_indisponible : ' + rAllow.error });
  }

  // 2. Le contremaître juge
  const reviewSys =
    'Tu es le CONTREMAÎTRE. Tu ne refais pas le travail : tu le JUGES et tu le corriges si besoin. ' +
    'Réponds UNIQUEMENT en JSON : ' +
    '{"verdict":"OK"|"CORRECT"|"BLOQUANT","correction":"la leçon en une phrase","texte":"la version corrigée"}. ' +
    'OK = rien à changer, recopie le texte tel quel dans "texte". ' +
    'CORRECT = corrige et explique la leçon. BLOQUANT = explique pourquoi c\'est inutilisable.';
  const reviewUsr =
    `DEMANDE INITIALE :\n${req.userPrompt}\n\n` +
    `RÉPONSE DE L'OUVRIER :\n${draft.text}\n\nTon verdict en JSON :`;

  const review = await callProvider(env, rSpec, {
    systemPrompt: reviewSys, userPrompt: reviewUsr, maxTokens: req.maxTokens
  });
  await bumpQuota(env, reviewerId, dayKey(), review.quotaUnits || 1);

  if (!review.ok) {
    return json({ ok: true, text: draft.text, draft: draft.text, verdict: 'NON_RELU',
      worker: workerId, reviewer: reviewerId, tokensUsed: draft.tokensUsed,
      note: 'relecture_echouee' });
  }

  const parsed = extractJson(review.text);
  const verdict    = (parsed && parsed.verdict) || 'OK';
  const correction = (parsed && parsed.correction) || null;
  const finalText  = (parsed && parsed.texte) || draft.text;

  return json({
    ok: true,
    text: finalText,
    draft: draft.text,
    verdict, correction,
    worker: workerId, reviewer: reviewerId,
    tokensUsed: (draft.tokensUsed || 0) + (review.tokensUsed || 0)
  });
}

// ─── battle : réponses brutes, l'user vote ───────────────────────
async function modeBattle(env, req, body, inlineCustom) {
  const ids = Array.isArray(body.providers) ? body.providers : [];
  if (ids.length < 2) return json({ ok: false, error: 'au_moins_deux_providers' }, 400);

  const specs = [];
  for (const id of ids) {
    const s = await resolveProvider(env, id, inlineCustom);
    if (s && s.available) {
      const allow = await checkAllowance(env, id, s);
      if (allow.allowed) specs.push({ id, spec: s });
      else specs.push({ id, spec: s, blocked: allow });
    }
  }

  const runnable = specs.filter(s => !s.blocked);
  if (!runnable.length) return json({ ok: false, error: 'aucun_provider_disponible', specs: specs.map(s => s.id) }, 503);

  const t0 = Date.now();
  const settled = await Promise.allSettled(runnable.map(({ spec }) => callProvider(env, spec, req)));

  const results = [];
  for (let i = 0; i < settled.length; i++) {
    const id = runnable[i].id;
    const res = settled[i];
    await bumpQuota(env, id, dayKey(),
      (res.status === 'fulfilled' && res.value.quotaUnits) || 1);
    if (res.status === 'fulfilled' && res.value.ok) {
      results.push({ provider: id, text: res.value.text, tokensUsed: res.value.tokensUsed,
        latencyMs: Date.now() - t0 });
    } else {
      results.push({ provider: id, error: true,
        reason: res.status === 'rejected' ? 'exception' : res.value.error });
    }
  }
  for (const s of specs.filter(x => x.blocked)) {
    results.push({ provider: s.id, error: true, reason: s.blocked.error, blocked: true });
  }

  return json({ ok: true, results, count: results.filter(r => !r.error).length });
}

// ════════════════════════════════════════════════════════════════════════
//  MOTEUR D'APPEL — un seul chemin pour tous les providers
// ════════════════════════════════════════════════════════════════════════

async function resolveProvider(env, id, inlineCustom) {
  // Provider custom envoyé dans la requête
  if (Array.isArray(inlineCustom)) {
    const found = inlineCustom.find(c => ('custom-' + c.id) === id || c.id === id);
    if (found) return { ...found, custom: true, available: true, kind: 'custom' };
  }
  // Provider custom enregistré
  if (String(id).startsWith('custom-') && env.GALAXY) {
    const raw = await env.GALAXY.get('v1:custom:' + String(id).substring(7));
    if (raw) {
      const c = JSON.parse(raw);
      return { ...c, custom: true, available: true, kind: 'custom' };
    }
  }
  // Provider du catalogue
  const p = CATALOG[id];
  if (!p) return null;
  const available = p.binding ? !!env.AI : !!(p.keyEnv && env[p.keyEnv]);
  return { ...p, id, available, key: p.keyEnv ? env[p.keyEnv] : null };
}

async function callProvider(env, spec, req) {
  try {
    if (spec.binding)             return await callWorkersAI(env, spec, req);
    if (spec.kind === 'gemini')   return await callGemini(spec, req);
    if (spec.kind === 'anthropic')return await callAnthropic(spec, req);
    if (spec.kind === 'custom')   return await callCustom(env, spec, req);
    return await callOpenAICompatible(env, spec, req);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200), status: 0 };
  }
}

function buildMessages(req) {
  if (req.messages) return req.messages;
  const out = [];
  if (req.systemPrompt) out.push({ role: 'system', content: req.systemPrompt });
  out.push({ role: 'user', content: req.userPrompt || '' });
  return out;
}

function estimateTokens(input, output) {
  return Math.ceil((String(input || '').length + String(output || '').length) / 4);
}

async function callWorkersAI(env, spec, req) {
  const messages = buildMessages(req);
  const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    { messages, max_tokens: req.maxTokens });
  const text = r.response || (r.result && r.result.response) || '';
  if (!text) return { ok: false, error: 'reponse_vide', status: 200 };
  const inChars = messages.map(m => m.content || '').join('').length;
  const tokIn = Math.ceil(inChars / 4), tokOut = Math.ceil(text.length / 4);
  // Estimation neurons — à recaler avec la mesure réelle du dashboard Cloudflare
  const neurons = Math.max(1, Math.ceil(tokIn * 0.026 + tokOut * 0.2));
  return { ok: true, text, tokensUsed: tokIn + tokOut, quotaUnits: neurons };
}

async function callOpenAICompatible(env, spec, req) {
  const messages = buildMessages(req);
  const payload = { model: spec.model, messages, max_tokens: req.maxTokens };

  if (req.image && spec.vision) {
    const last = messages[messages.length - 1];
    last.content = [
      { type: 'text', text: last.content },
      { type: 'image_url', image_url: { url: req.image } }
    ];
  }

  const resp = await fetch(spec.url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + spec.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const callsToday = await getQuotaUsed(env, spec.id, dayKey());
  await learnFromResponse(env, spec.id, resp, callsToday);

  if (!resp.ok) {
    const t = await resp.text();
    return { ok: false, error: t.slice(0, 200), status: resp.status };
  }
  const data = await resp.json();
  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  if (!text) return { ok: false, error: 'reponse_vide', status: resp.status };

  const usage = data.usage || {};
  return {
    ok: true, text,
    tokensUsed: (usage.total_tokens != null) ? usage.total_tokens
      : estimateTokens(JSON.stringify(messages), text)
  };
}

async function callGemini(spec, req) {
  const parts = [{ text: (req.systemPrompt ? req.systemPrompt + '\n\n' : '') + (req.userPrompt || '') }];
  if (req.image) {
    const m = String(req.image).match(/^data:([^;]+);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${spec.model}:generateContent?key=${spec.key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: req.maxTokens } }) }
  );
  if (!resp.ok) {
    const t = await resp.text();
    return { ok: false, error: t.slice(0, 200), status: resp.status };
  }
  const data = await resp.json();
  const text = data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    ? data.candidates[0].content.parts[0].text : '';
  if (!text) return { ok: false, error: 'reponse_vide', status: resp.status };
  const um = data.usageMetadata || {};
  return { ok: true, text,
    tokensUsed: um.totalTokenCount || estimateTokens(req.userPrompt, text) };
}

async function callAnthropic(spec, req) {
  const content = [];
  if (req.image) {
    const m = String(req.image).match(/^data:([^;]+);base64,(.+)$/);
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: req.userPrompt || '' });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': spec.key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: spec.model, max_tokens: req.maxTokens,
      system: req.systemPrompt || undefined,
      messages: [{ role: 'user', content }]
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    return { ok: false, error: t.slice(0, 200), status: resp.status };
  }
  const data = await resp.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (!text) return { ok: false, error: 'reponse_vide', status: resp.status };
  const u = data.usage || {};
  return { ok: true, text,
    tokensUsed: (u.input_tokens || 0) + (u.output_tokens || 0) };
}

// Moteur BYO — n'importe quelle API décrite par l'user
async function callCustom(env, spec, req) {
  const prompt = (req.systemPrompt ? req.systemPrompt + '\n\n' : '') + (req.userPrompt || '');
  const bodyStr = String(spec.body || '{"prompt":"{prompt}"}')
    .replace(/\{prompt\}/g, jsonEscape(prompt))
    .replace(/\{system\}/g, jsonEscape(req.systemPrompt || ''))
    .replace(/\{user\}/g, jsonEscape(req.userPrompt || ''))
    .replace(/\{maxTokens\}/g, String(req.maxTokens));

  const headers = { 'Content-Type': 'application/json' };
  const auth = String(spec.auth || '');
  if (auth) {
    if (/^bearer\s/i.test(auth)) headers['Authorization'] = auth;
    else if (auth.includes(':')) {
      const idx = auth.indexOf(':');
      headers[auth.slice(0, idx).trim()] = auth.slice(idx + 1).trim();
    } else headers['Authorization'] = 'Bearer ' + auth;
  }

  const resp = await fetch(spec.url, {
    method: spec.method || 'POST',
    headers,
    body: (spec.method === 'GET') ? undefined : bodyStr
  });

  const pid = 'custom-' + spec.id;
  const callsToday = await getQuotaUsed(env, pid, dayKey());
  await learnFromResponse(env, pid, resp, callsToday);

  const raw = await resp.text();
  if (!resp.ok) return { ok: false, error: raw.slice(0, 200), status: resp.status };

  // Extraction du texte : chemin déclaré, sinon heuristique
  let text = '';
  try {
    const data = JSON.parse(raw);
    if (spec.returnPath) {
      text = spec.returnPath.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    }
    if (!text) {
      text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
          || (data.choices && data.choices[0] && data.choices[0].text)
          || data.text || data.output || data.response || data.content || '';
    }
    if (typeof text !== 'string') text = JSON.stringify(text);
  } catch (e) {
    text = raw.slice(0, 8000);   // réponse non-JSON : on prend le texte brut
  }

  if (!text) return { ok: false, error: 'texte_introuvable_dans_la_reponse', status: resp.status };
  return { ok: true, text, tokensUsed: estimateTokens(prompt, text) };
}

function jsonEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function extractJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

async function quotaSnapshot(env, id, spec) {
  const used = await getQuotaUsed(env, id, dayKey());
  return {
    used,
    limit: spec.freeQuota ? spec.freeQuota.limit : (spec.cap || null),
    unit: spec.freeQuota ? spec.freeQuota.unit : 'requests',
    resetIn: secondsUntilMidnightUTC()
  };
}

async function suggestAlternatives(env, excludeId, req) {
  const out = [];
  for (const id of listAvailableIds(env)) {
    if (id === excludeId) continue;
    const spec = await resolveProvider(env, id, []);
    if (!spec || !spec.available) continue;
    if (req.image && !spec.vision) continue;
    const allow = await checkAllowance(env, id, spec);
    if (allow.allowed) out.push(id);
    if (out.length >= 4) break;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
//  GALAXY
// ════════════════════════════════════════════════════════════════════════
function compressVector(vec) {
  if (!Array.isArray(vec)) return vec;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = Math.round(vec[i] * 10000) / 10000;
  return out;
}

async function handleGalaxyEmbed(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const text = String(body.text || '').slice(0, 4000);
  if (!text) return json({ ok: false, error: 'text_required' }, 400);
  const r = await env.AI.run(EMBED_MODEL, { text: [text] });
  const vec = (r.data && r.data[0]) || (r.result && r.result.data && r.result.data[0]);
  if (!vec) return json({ ok: false, error: 'no_vector' }, 502);
  return json({ ok: true, vector: compressVector(vec), dims: vec.length });
}

async function handleGalaxySearch(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const userId = body.userId;
  const query  = body.query;
  const topK   = parseInt(body.k || body.topK) || 5;
  if (!userId || !query) return json({ ok: false, error: 'userId_and_query_required' }, 400);
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);

  const raw = await env.GALAXY.get('galaxy:' + userId);
  if (!raw) return json({ ok: true, results: [] });
  let stars = JSON.parse(raw);

  if (Array.isArray(body.tags) && body.tags.length) {
    stars = stars.filter(s => Array.isArray(s.tags) && body.tags.some(t => s.tags.includes(t)));
  }
  if (body.project) stars = stars.filter(s => s.project === body.project);
  if (!stars.length) return json({ ok: true, results: [] });

  const rEmbed = await env.AI.run(EMBED_MODEL, { text: [query] });
  const qVec = (rEmbed.data && rEmbed.data[0]) || (rEmbed.result && rEmbed.result.data && rEmbed.result.data[0]);
  if (!qVec) return json({ ok: false, error: 'no_query_vector' }, 502);

  const scored = stars
    .filter(s => Array.isArray(s.vector))
    .map(s => ({ ...s, score: cosine(qVec, s.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return json({ ok: true, results: scored, matches: scored });
}

async function handleGalaxySave(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const { userId, star } = body;
  if (!userId || !star) return json({ ok: false, error: 'userId_and_star_required' }, 400);
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);

  const raw = await env.GALAXY.get('galaxy:' + userId);
  const stars = raw ? JSON.parse(raw) : [];

  if (star.vector) star.vector = compressVector(star.vector);
  else if (star.text || star.desc) {
    try {
      const r = await env.AI.run(EMBED_MODEL, { text: [String(star.text || star.desc).slice(0, 4000)] });
      const vec = (r.data && r.data[0]) || (r.result && r.result.data && r.result.data[0]);
      if (vec) star.vector = compressVector(vec);
    } catch (e) { /* étoile sans vecteur, tant pis */ }
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
  if (!userId) return json({ ok: false, error: 'userId_required' }, 400);
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);
  const raw = await env.GALAXY.get('galaxy:' + userId);
  return json({ ok: true, stars: raw ? JSON.parse(raw) : [] });
}

async function handleGalaxyDelete(request, env, id) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');
  if (!userId || !id) return json({ ok: false, error: 'userId_and_id_required' }, 400);
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);
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

// ════════════════════════════════════════════════════════════════════════
//  ACTIVATION EXTENSION
// ════════════════════════════════════════════════════════════════════════
async function handleExtMint(request, env) {
  if (!env.APP_SECRET) return json({ ok: false, error: 'APP_SECRET manquant' }, 503);
  if (!env.GALAXY)     return json({ ok: false, error: 'KV GALAXY manquant' }, 503);

  const ownerId = await appAuth(request, env);
  if (!ownerId) return json({ ok: false, error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const profileLabel = (body.profileLabel && String(body.profileLabel).trim())
    || `Appareil ${new Date().toLocaleDateString('fr-FR')}`;

  const pin = String(body.pin || '');
  if (pin.length < PIN_MIN_LEN || pin.length > PIN_MAX_LEN || !/^\d+$/.test(pin)) {
    return json({ ok: false, error: 'pin_invalide', min: PIN_MIN_LEN, max: PIN_MAX_LEN }, 400);
  }

  let scopes = Array.isArray(body.scopes) ? body.scopes : [];
  scopes = scopes.filter(s => KNOWN_SCOPES.includes(s));
  if (!scopes.length) scopes = DEFAULT_SCOPES.slice();

  const code = randomCode(8);
  const salt = crypto.randomUUID();
  const pinHash = await hashPin(pin, salt);

  await env.GALAXY.put(`v1:actv:${code}`, JSON.stringify({
    ownerId, profileLabel, scopes, pinHash, salt, tries: 0, createdAt: Date.now()
  }), { expirationTtl: ACTIVATION_TTL });

  return json({ ok: true, code, profileLabel, scopes,
    expiresIn: ACTIVATION_TTL, workerUrl: new URL(request.url).origin });
}

async function handleExtActivate(request, env) {
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const code = String(body.code || '').trim().toUpperCase();
  const pin  = String(body.pin  || '');
  const installId = String(body.installId || '').slice(0, 128) || crypto.randomUUID();
  if (!code || !pin) return json({ ok: false, error: 'code_ou_pin_manquant' }, 400);

  const raw = await env.GALAXY.get(`v1:actv:${code}`);
  if (!raw) return json({ ok: false, error: 'code_invalide_ou_expire' }, 400);
  const actv = JSON.parse(raw);

  const candidate = await hashPin(pin, actv.salt);
  if (!timingSafeEqualHex(candidate, actv.pinHash)) {
    actv.tries = (actv.tries || 0) + 1;
    if (actv.tries >= 3) {
      await env.GALAXY.delete(`v1:actv:${code}`);
      return json({ ok: false, error: 'code_brule', tries: actv.tries }, 403);
    }
    const remaining = Math.max(60, ACTIVATION_TTL - Math.floor((Date.now() - actv.createdAt) / 1000));
    await env.GALAXY.put(`v1:actv:${code}`, JSON.stringify(actv), { expirationTtl: remaining });
    return json({ ok: false, error: 'pin_faux', restants: 3 - actv.tries }, 403);
  }

  await env.GALAXY.delete(`v1:actv:${code}`);

  const token = crypto.randomUUID();
  const now = Date.now();
  await env.GALAXY.put(`v1:ext:${token}`, JSON.stringify({
    ownerId: actv.ownerId, profileLabel: actv.profileLabel, scopes: actv.scopes,
    installId, spent: 0, createdAt: now, lastSeen: now
  }));
  await env.GALAXY.put(`v1:event:${actv.ownerId}:${now}`, JSON.stringify({
    type: 'activation', profileLabel: actv.profileLabel,
    installId, scopes: actv.scopes, at: now
  }), { expirationTtl: EVENT_TTL });

  return json({ ok: true, token, ownerId: actv.ownerId,
    profileLabel: actv.profileLabel, scopes: actv.scopes,
    workerUrl: new URL(request.url).origin });
}

async function handleExtEvents(request, env) {
  if (!env.GALAXY) return json({ ok: false, error: 'KV GALAXY manquant' }, 503);
  const ownerId = await appAuth(request, env);
  if (!ownerId) return json({ ok: false, error: 'unauthorized' }, 401);
  const list = await env.GALAXY.list({ prefix: `v1:event:${ownerId}:`, limit: 100 });
  const events = [];
  for (const k of list.keys) {
    const raw = await env.GALAXY.get(k.name);
    if (raw) events.push({ key: k.name, ...JSON.parse(raw) });
  }
  events.sort((a, b) => (b.at || 0) - (a.at || 0));
  return json({ ok: true, events });
}

async function seal(request, env) {
  const t = request.headers.get('X-Astrid-Ext');
  if (!t || !env.GALAXY) return null;
  const raw = await env.GALAXY.get(`v1:ext:${t}`);
  if (!raw) return null;
  const s = JSON.parse(raw);
  s.lastSeen = Date.now();
  await env.GALAXY.put(`v1:ext:${t}`, JSON.stringify(s));
  return s;
}

// ════════════════════════════════════════════════════════════════════════
//  AUTH & CRYPTO
// ════════════════════════════════════════════════════════════════════════
async function appAuth(request, env) {
  const raw = request.headers.get('X-App-Auth');
  if (!raw) return null;
  if (!(await timingSafeCompareStrings(raw, env.APP_SECRET))) return null;
  const h = await sha256Hex('owner:' + raw);
  const ownerId = 'own_' + h.slice(0, 32);
  const key = `v1:owner:${ownerId}`;
  if (env.GALAXY && !(await env.GALAXY.get(key))) {
    await env.GALAXY.put(key, JSON.stringify({ createdAt: Date.now() }));
  }
  return ownerId;
}

async function sha256Hex(str) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
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

async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 210000, hash: 'SHA-256' }, k, 256);
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
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  return null;
}

function checkOrigin(request, env) {
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  if (allowed === '*') return null;
  const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
  if (origin === allowed || origin.startsWith(allowed + '/')) return null;
  return json({
    ok: false, error: 'origin_forbidden',
    message: "Ce Worker n'accepte que les requêtes venant de " + allowed,
    hint: 'Mets ALLOWED_ORIGIN="*" dans Variables pour ouvrir.'
  }, 403);
}

// ════════════════════════════════════════════════════════════════════════
//  PROXY WEB
// ════════════════════════════════════════════════════════════════════════
// La V3.2 nomme cette fonction cors(). Le bloc proxy porte l'ancien nom :
// un alias evite de toucher 7 appels et de risquer une faute de frappe.
function corsHeaders(){ return cors(); }

function securityCheck(target) {
  let url;
  try {
    url = new URL(target);
  } catch (e) {
    return 'URL invalide';
  }
  if (url.protocol !== 'https:') {
    return 'HTTPS requis (' + url.protocol + ' bloqué)';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return 'Hostname local interdit (' + host + ')';
  }
  if (host.endsWith('.onion')) {
    return 'Réseau Tor non supporté';
  }
  if (host === '' || host === '.') {
    return 'Hostname vide';
  }
  if (/^\d+$/.test(host)) {
    return 'IP au format décimal bloquée';
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    return 'IP au format hexa bloquée';
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = +ipv4[1], b = +ipv4[2];
    if (a === 0) return 'IP 0.x bloquée';
    if (a === 10) return 'IP privée 10.x bloquée';
    if (a === 127) return 'Localhost bloqué';
    if (a === 169 && b === 254) return 'IP link-local (metadata) bloquée';
    if (a === 172 && b >= 16 && b <= 31) return 'IP privée 172.16-31.x bloquée';
    if (a === 192 && b === 168) return 'IP privée 192.168.x bloquée';
    if (a >= 224) return 'IP multicast/reserved bloquée';
  }
  if (host.includes(':') || host.startsWith('[')) {
    const v6 = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (v6 === '::1' || v6 === '::') return 'IPv6 loopback bloqué';
    if (v6.startsWith('fe80:') || v6.startsWith('fe80::')) return 'IPv6 link-local bloqué';
    if (v6.startsWith('fc') || v6.startsWith('fd')) return 'IPv6 unique-local bloqué';
    if (v6.startsWith('ff')) return 'IPv6 multicast bloqué';
    if (/^::ffff:/.test(v6)) return 'IPv6 mappant IPv4 bloqué';
  }
  if (host === '100.64.0.0' || host.startsWith('100.6')) {
    return 'CGN range bloqué';
  }
  return null;
}

// Construit le rewriter. `bridgeHtml` = la chaîne complète des <script>
// (ton bridge existant + les modules). `helpers.domaineRacine` = ta
// fonction déjà présente dans le Worker.
function makeRewriter(targetUrl, proxyOrigin, bridgeHtml, helpers) {
  const baseUrl  = new URL(targetUrl);
  const baseHref = baseUrl.protocol + '//' + baseUrl.host + '/';
  const racine   = helpers.domaineRacine(baseUrl.host);
  let injected = false;

  function sameRoot(host) {
    host = String(host).toLowerCase();
    return host === racine || host.endsWith('.' + racine);
  }

  // URL interne absolue -> URL proxy. Renvoie null si on ne doit PAS réécrire.
  function proxify(raw) {
    let abs;
    try { abs = new URL(raw, baseHref); } catch (e) { return null; }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return null;
    if (!sameRoot(abs.hostname)) return null;
    abs.protocol = 'https:'; // on ne sert que du HTTPS
    return proxyOrigin + '/proxy-web?url=' + encodeURIComponent(abs.href);
  }

  function injectInto(el) {
    if (injected) return;
    el.prepend('<base href="' + baseHref + '">', { html: true });
    el.append(bridgeHtml, { html: true });
    injected = true;
  }

  return new HTMLRewriter()
    // 1) neutraliser les protections anti-iframe posées en <meta>
    .on('meta', {
      element(el) {
        const eq = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (eq === 'x-frame-options' || eq === 'content-security-policy') {
          el.remove();
        }
      }
    })
    // 2) base + bridge, injectés au début du <head> (cas normal)
    .on('head', { element(el) { injectInto(el); } })
    // 3) filet de sécurité : si la page n'a pas de <head>, on injecte en tête de <body>
    .on('body', { element(el) { if (!injected) injectInto(el); } })
    // 4) liens internes -> proxy (les clics sont AUSSI captés par le bridge ;
    //    ceci sert au clic-molette / ouvrir dans un nouvel onglet)
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href) return;
        const low = href.trim().toLowerCase();
        if (low.startsWith('javascript:') || low.startsWith('mailto:') ||
            low.startsWith('tel:') || low.startsWith('#') || low.startsWith('data:')) return;
        if (el.getAttribute('target') === '_blank') return;
        const p = proxify(href);
        if (p) el.setAttribute('href', p);
      }
    });
}

// ────────────────────────────────────────────────────────────────
// REMPLACE ta fonction proxyRequest par celle-ci.
// Deux changements par rapport à la tienne :
//   (A) le corps des POST est transmis (avant, il était perdu -> login/form KO)
//   (B) le HTML passe par HTMLRewriter en streaming (au lieu de html.replace)
// Tout le reste (securityCheck, messages d'erreur) est identique.
// ────────────────────────────────────────────────────────────────
// Suit les redirections A LA MAIN, en revalidant securityCheck a chaque saut.
// Avec redirect:'follow', seule l'URL de depart etait verifiee : un site
// pouvait rediriger vers 169.254.169.254 et contourner toute la protection.
// Renvoie aussi l'URL FINALE, indispensable pour poser le bon <base href>.
// ═════════════════════════════════════════════════════════════════════
//  🍪 POT DE COOKIES — uniquement sur une Passerelle PERSONNELLE
// ═════════════════════════════════════════════════════════════════════
//  Sans cookies, aucune demarche en plusieurs pages ne fonctionne :
//  le site pose une session, ne la retrouve pas, et recharge en boucle.
//
//  Trois regles rendent la chose defendable :
//   1. Le pot vit dans le KV, JAMAIS dans le navigateur. Le JavaScript
//      d'une page ne peut donc pas lire document.cookie et repartir
//      avec la session.
//   2. Un compartiment par hote : les cookies d'ameli.fr ne partent
//      jamais ailleurs.
//   3. Ils ne s'attachent qu'aux NAVIGATIONS de page. Une page
//      malveillante qui ferait fetch('/proxy-web?url=...') envoie
//      Sec-Fetch-Dest: empty et ne recoit rien : elle obtient une page
//      deconnectee. C'est ce qui ferme le trou du proxy mono-origine.
//
//  Actif seulement si AI_TOKEN est defini : c'est le signal d'une
//  Passerelle personnelle. Sur le proxy partage, jamais.
const COOKIES_TTL = 30 * 86400;

function cookiesActifs(env) {
  return !!(env && env.AI_TOKEN && env.GALAXY);
}

// Une vraie navigation de page, pas un appel JavaScript depuis la page
function estNavigation(request) {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame';
  // Navigateur ancien sans Sec-Fetch-* : on se rabat sur Accept
  const acc = request.headers.get('Accept') || '';
  return acc.indexOf('text/html') !== -1;
}

async function lirePot(env, hote) {
  try {
    const brut = await env.GALAXY.get('v1:jar:' + hote);
    return brut ? JSON.parse(brut) : {};
  } catch (e) { return {}; }
}

async function ecrirePot(env, hote, pot) {
  try {
    await env.GALAXY.put('v1:jar:' + hote, JSON.stringify(pot), { expirationTtl: COOKIES_TTL });
  } catch (e) { /* le pot est un confort, jamais bloquant */ }
}

// Le domaine qui possede le cookie : ameli.fr couvre www.ameli.fr
function hotePot(host) {
  return domaineRacine(String(host).toLowerCase());
}

async function enTeteCookie(env, host) {
  const pot = await lirePot(env, hotePot(host));
  const maintenant = Date.now();
  const paires = [];
  for (const [nom, c] of Object.entries(pot)) {
    if (c && c.exp && c.exp < maintenant) continue;   // perime
    paires.push(nom + '=' + c.v);
  }
  return paires.join('; ');
}

async function absorberCookies(env, host, reponse) {
  let liste = [];
  try {
    if (typeof reponse.headers.getSetCookie === 'function') liste = reponse.headers.getSetCookie();
    else if (typeof reponse.headers.getAll === 'function')  liste = reponse.headers.getAll('Set-Cookie');
    else { const un = reponse.headers.get('Set-Cookie'); if (un) liste = [un]; }
  } catch (e) { return; }
  if (!liste || !liste.length) return;

  const hote = hotePot(host);
  const pot = await lirePot(env, hote);
  let touche = false;

  for (const brut of liste) {
    const parts = String(brut).split(';');
    const premier = parts[0].trim();
    const eq = premier.indexOf('=');
    if (eq < 1) continue;
    const nom = premier.slice(0, eq).trim();
    const val = premier.slice(eq + 1);

    let exp = 0;
    for (let i = 1; i < parts.length; i++) {
      const a = parts[i].trim().toLowerCase();
      if (a.startsWith('max-age=')) {
        const sec = parseInt(a.slice(8), 10);
        if (!isNaN(sec)) exp = sec <= 0 ? -1 : Date.now() + sec * 1000;
      } else if (a.startsWith('expires=')) {
        const t = Date.parse(parts[i].trim().slice(8));
        if (!isNaN(t)) exp = t;
      }
    }
    if (exp === -1) { delete pot[nom]; touche = true; continue; }   // suppression
    pot[nom] = { v: val, exp: exp || 0 };
    touche = true;
  }
  if (touche) await ecrirePot(env, hote, pot);
}

async function fetchSecurise(urlDepart, init, maxSauts = 5) {
  let courante = urlDepart;
  let options  = { ...init, redirect: 'manual' };

  for (let saut = 0; saut <= maxSauts; saut++) {
    const err = securityCheck(courante);
    if (err) return { erreur: err };

    const r = await fetch(courante, options);

    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('Location');
      if (!loc) return { reponse: r, urlFinale: courante };
      let suivante;
      try { suivante = new URL(loc, courante).href; }
      catch (e) { return { reponse: r, urlFinale: courante }; }
      // Comme un navigateur : apres une redirection, un POST repart en GET
      options  = { ...options, method: 'GET', body: undefined };
      courante = suivante;
      continue;
    }
    return { reponse: r, urlFinale: courante };
  }
  return { erreur: 'Trop de redirections' };
}

async function proxyRequest(targetUrl, proxyOrigin, originalRequest, env) {
  if (targetUrl && targetUrl.toLowerCase().startsWith('http://')) {
    targetUrl = 'https://' + targetUrl.substring(7);
  }
  const secError = securityCheck(targetUrl);
  if (secError) {
    return new Response('🔒 ' + secError, {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
    });
  }

  try {
    const init = {
      method: originalRequest.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      // les redirections sont suivies a la main par fetchSecurise
    };

    // (A) transmettre le corps des méthodes qui en ont un
    if (originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD') {
      init.body = await originalRequest.arrayBuffer();
      const ct = originalRequest.headers.get('content-type');
      if (ct) init.headers['Content-Type'] = ct;
    }

    // 🍪 On joint les cookies UNIQUEMENT sur une vraie navigation de page,
    //    et seulement si cette Passerelle est personnelle (AI_TOKEN pose).
    if (cookiesActifs(env) && estNavigation(originalRequest)) {
      try {
        const ck = await enTeteCookie(env, new URL(targetUrl).host);
        if (ck) init.headers['Cookie'] = ck;
      } catch (e) {}
    }

    const res = await fetchSecurise(targetUrl, init);
    if (res.erreur) {
      return new Response('🔒 ' + res.erreur, {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }
    const response = res.reponse;

    // On garde ce que le site a pose, pour la page suivante
    if (cookiesActifs(env)) {
      try { await absorberCookies(env, new URL(res.urlFinale || targetUrl).host, response); } catch (e) {}
    }

    // L'URL FINALE, pas celle de depart : apres un POST -> 302 -> GET,
    // la page affichee vient d'ailleurs et le <base href> doit la suivre.
    const urlFinale = res.urlFinale || targetUrl;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      // (B) réécriture en streaming
      const bridge   = buildFullBridge(proxyOrigin, domaineRacine(new URL(urlFinale).host));
      const rewriter = makeRewriter(urlFinale, proxyOrigin, bridge, { domaineRacine });
      const out      = rewriter.transform(response);

      return new Response(out.body, {
        status: response.status,
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
          ...corsHeaders(),
        },
      });
    }

    // non-HTML (images, JSON d'API, etc.) : passe-plat
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': contentType, ...corsHeaders() },
    });

  } catch (e) {
    const msg = e.message || '';
    let userMsg = 'Erreur proxy : ' + msg;
    if (/cert|ssl|tls|https/i.test(msg)) {
      userMsg = "🔒 Ce site n'a pas de certificat HTTPS valide. Astrid ne charge que les sites sécurisés (HTTPS).";
    } else if (/refused|timeout|dns|enotfound/i.test(msg)) {
      userMsg = "⚠️ Site inaccessible. Vérifie l'adresse ou réessaye plus tard.";
    }
    return new Response(userMsg, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
    });
  }
}

async function proxyAsset(targetUrl) {
  try {
    // Cette route n'appelait AUCUN securityCheck : tout le blindage
    // anti-SSRF de /proxy-web etait contournable par /proxy-asset.
    const res = await fetchSecurise(targetUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36' }
    });
    if (res.erreur) {
      return new Response('🔒 ' + res.erreur, {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }
    const response = res.reponse;
    const headers = new Headers();
    const ct = response.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('Access-Control-Allow-Origin', '*');
    // Workers Cache se pilote par cet en-tete, y compris sur workers.dev.
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(response.body, { status: response.status, headers });
  } catch (e) {
    return new Response('Asset proxy error', { status: 502 });
  }
}

// Extrait le domaine enregistrable : player.canal.fr -> canal.fr
// Gere les suffixes composes courants (.co.uk, .gouv.fr, .com.br...).
function domaineRacine(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const composes = ['co.uk','org.uk','gov.uk','ac.uk','com.au','com.br','co.jp',
                    'gouv.fr','asso.fr','com.mx','co.nz','co.za'];
  const deux = parts.slice(-2).join('.');
  if (composes.includes(deux)) return parts.slice(-3).join('.');
  return deux;
}

// ════════════════════════════════════════════════════════════════
// SÉCURITÉ (serveur) — liste blanche officielle + assembleur du bridge
// ════════════════════════════════════════════════════════════════
const DOMAINES_OFFICIELS = new Set([
  'ameli.fr', 'assurance-maladie.ameli.fr',
  'impots.gouv.fr', 'service-public.fr',
  'caf.fr', 'msa.fr', 'urssaf.fr',
  'francetravail.fr', 'pole-emploi.fr',
  'laposte.fr', 'laposte.net',
  'ants.gouv.fr', 'franceconnect.gouv.fr',
  'mesdroitssociaux.gouv.fr', 'info-retraite.fr',
  'lassuranceretraite.fr', 'agirc-arrco.fr',
  'chorus-pro.gouv.fr', 'demarches-simplifiees.fr',
]);

function estOfficiel(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  if (host === 'gouv.fr' || host.endsWith('.gouv.fr')) return true;
  if (DOMAINES_OFFICIELS.has(host)) return true;
  return DOMAINES_OFFICIELS.has(domaineRacine(host));
}

// ════════════════════════════════════════════════════════════════
// 03 — GLOSSAIRE ADMIN (partagé : "Explique-moi" + futur multilingue)
// ════════════════════════════════════════════════════════════════
//
// Clés en minuscules, sans accent optionnel (on normalise à la lecture).
// Départ à ~35 termes : c'est la base la plus rentable. Étends-la
// librement — chaque ajout est gratuit et instantané (aucun appel IA).
//
// Ce même objet servira au module multilingue : tu ajouteras plus tard
// une table { terme -> { ar:'...', pt:'...' } }. Ne change pas la forme.

const GLOSSAIRE_ADMIN = {
  "attestation": "Un document officiel qui prouve quelque chose (par exemple que tu as bien des droits).",
  "ayant droit": "Une personne qui bénéficie de tes droits, comme ton conjoint ou tes enfants.",
  "forclusion": "Le délai est passé : tu ne peux plus faire cette démarche pour cette période.",
  "regime": "Le groupe qui gère ta protection sociale (salariés, indépendants, agriculteurs…).",
  "cotisation": "L'argent prélevé sur ton revenu pour financer la Sécurité sociale et la retraite.",
  "prelevement a la source": "L'impôt retiré directement sur ton salaire ou ta pension, chaque mois.",
  "avis d'imposition": "Le document qui indique combien d'impôt tu dois payer pour l'année.",
  "quotient familial": "Un calcul qui adapte ton impôt au nombre de personnes dans ton foyer.",
  "foyer fiscal": "L'ensemble des personnes déclarées ensemble pour les impôts.",
  "titulaire": "La personne principale, celle au nom de qui est le compte ou le dossier.",
  "beneficiaire": "La personne qui reçoit l'aide, le paiement ou la prestation.",
  "justificatif": "Un papier qui prouve ce que tu déclares (facture, quittance, attestation…).",
  "rib": "Relevé d'Identité Bancaire : les coordonnées de ton compte pour recevoir un virement.",
  "iban": "Le numéro international de ton compte bancaire, sur ton RIB.",
  "prestation": "Une aide ou un versement de l'administration (allocation, remboursement…).",
  "allocation": "Une somme versée régulièrement pour t'aider (logement, famille, etc.).",
  "echeance": "La date limite avant laquelle il faut agir ou payer.",
  "recours": "Une démarche pour contester une décision que tu juges injuste.",
  "notification": "Un message officiel qui t'informe d'une décision te concernant.",
  "affiliation": "Ton rattachement à un organisme (caisse d'assurance maladie, retraite…).",
  "carte vitale": "La carte verte qui prouve tes droits à l'Assurance Maladie.",
  "tiers payant": "Tu n'avances pas les frais : l'Assurance Maladie paie directement.",
  "ald": "Affection Longue Durée : une maladie grave prise en charge à 100 %.",
  "cpam": "Caisse Primaire d'Assurance Maladie : ton interlocuteur santé local.",
  "caf": "Caisse d'Allocations Familiales : elle verse les aides famille et logement.",
  "apl": "Aide Personnalisée au Logement : une aide pour payer ton loyer.",
  "trimestre": "Une période de 3 mois qui compte pour ta retraite.",
  "liquidation": "Le calcul et la mise en paiement de ta retraite (ce n'est pas une fermeture).",
  "usager": "Toi, en tant que personne qui utilise un service public.",
  "mandataire": "Une personne autorisée à agir à ta place pour une démarche.",
  "procuration": "L'autorisation que tu donnes à quelqu'un d'agir en ton nom.",
  "reclamation": "Une demande pour signaler un problème et obtenir une correction.",
  "franchise": "La petite part qui reste à ta charge sur certains soins ou médicaments.",
  "plafond": "La limite maximale (de revenu, de remboursement, d'aide…).",
  "declaration": "Le fait de communiquer officiellement tes informations à l'administration.",
};

// Assemble le bridge existant + les modules du lot 1 (chacun isolé).
// ════════════════════════════════════════════════════════════════
// GLOSSAIRES MULTILINGUES (lot 2) — termes d'interface + langues TTS
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// 09a — GLOSSAIRE MULTILINGUE (termes d'interface les plus fréquents)
// ════════════════════════════════════════════════════════════════
//
// On ne traduit JAMAIS la page. On traduit la COUCHE Astrid (volet
// lecture, étiquette du pointeur, voix), et on garde le terme officiel
// français à côté pour que la personne retrouve le vrai bouton.
//
// Ce table couvre les mots qui reviennent sur 80 % des boutons : ils
// sont traduits SANS aucun appel IA (instantané, gratuit). Le texte
// unique de la page, lui, part à l'IA via 'translate-request'.
//
// Clé = terme FR en minuscules. Étends librement.

const GLOSSAIRE_MULTI = {
  "valider":      { ar: "تأكيد",        pt: "Validar",     tr: "Onayla",     es: "Validar",     en: "Confirm" },
  "suivant":      { ar: "التالي",       pt: "Seguinte",    tr: "İleri",      es: "Siguiente",   en: "Next" },
  "precedent":    { ar: "السابق",       pt: "Anterior",    tr: "Geri",       es: "Anterior",    en: "Back" },
  "continuer":    { ar: "متابعة",       pt: "Continuar",   tr: "Devam et",   es: "Continuar",   en: "Continue" },
  "annuler":      { ar: "إلغاء",        pt: "Cancelar",    tr: "İptal",      es: "Cancelar",    en: "Cancel" },
  "envoyer":      { ar: "إرسال",        pt: "Enviar",      tr: "Gönder",     es: "Enviar",      en: "Send" },
  "rechercher":   { ar: "بحث",          pt: "Pesquisar",   tr: "Ara",        es: "Buscar",      en: "Search" },
  "se connecter": { ar: "تسجيل الدخول", pt: "Entrar",      tr: "Giriş yap",  es: "Iniciar sesión", en: "Log in" },
  "connexion":    { ar: "تسجيل الدخول", pt: "Ligação",     tr: "Giriş",      es: "Conexión",    en: "Login" },
  "s'inscrire":   { ar: "إنشاء حساب",   pt: "Inscrever-se",tr: "Kayıt ol",   es: "Registrarse", en: "Sign up" },
  "mot de passe": { ar: "كلمة المرور",  pt: "Palavra-passe",tr: "Şifre",     es: "Contraseña",  en: "Password" },
  "telecharger":  { ar: "تنزيل",        pt: "Descarregar", tr: "İndir",      es: "Descargar",   en: "Download" },
  "imprimer":     { ar: "طباعة",        pt: "Imprimir",    tr: "Yazdır",     es: "Imprimir",    en: "Print" },
  "payer":        { ar: "الدفع",        pt: "Pagar",       tr: "Öde",        es: "Pagar",       en: "Pay" },
  "accueil":      { ar: "الرئيسية",     pt: "Início",      tr: "Ana sayfa",  es: "Inicio",      en: "Home" },
  "menu":         { ar: "القائمة",      pt: "Menu",        tr: "Menü",       es: "Menú",        en: "Menu" },
  "fermer":       { ar: "إغلاق",        pt: "Fechar",      tr: "Kapat",      es: "Cerrar",      en: "Close" },
  "oui":          { ar: "نعم",          pt: "Sim",         tr: "Evet",       es: "Sí",          en: "Yes" },
  "non":          { ar: "لا",           pt: "Não",         tr: "Hayır",      es: "No",          en: "No" },
  "modifier":     { ar: "تعديل",        pt: "Modificar",   tr: "Değiştir",   es: "Modificar",   en: "Edit" },
  "confirmer":    { ar: "تأكيد",        pt: "Confirmar",   tr: "Onayla",     es: "Confirmar",   en: "Confirm" },
  "retour":       { ar: "رجوع",         pt: "Voltar",      tr: "Geri dön",   es: "Volver",      en: "Return" },
};

// codes de langue pour la synthèse vocale (TTS)
const LANG_TTS = { ar: "ar-SA", pt: "pt-PT", tr: "tr-TR", es: "es-ES", en: "en-US", fr: "fr-FR" };
const LANGUES_DISPO = [
  { code: "fr", nom: "Français" },
  { code: "ar", nom: "العربية" },
  { code: "pt", nom: "Português" },
  { code: "tr", nom: "Türkçe" },
  { code: "es", nom: "Español" },
  { code: "en", nom: "English" },
];

function buildFullBridge(proxyOrigin, targetRoot) {
  const cfg = {
    proxyOrigin: proxyOrigin,
    targetRoot: targetRoot,
    lang: 'fr-FR',
    officielsList: Array.from(DOMAINES_OFFICIELS),
    glossaire: GLOSSAIRE_ADMIN,
    glossaireMulti: GLOSSAIRE_MULTI,
    languesDispo: LANGUES_DISPO,
    langTts: LANG_TTS,
  };
  return [
    buildBridgeScript(proxyOrigin, targetRoot),
    '<script>' + featForms(cfg)        + '</script>',
    '<script>' + featSecurite(cfg)     + '</script>',
    '<script>' + featTTS(cfg)          + '</script>',
    '<script>' + featExplique(cfg)     + '</script>',
    '<script>' + featAntiAbandon(cfg)  + '</script>',
    '<script>' + featMultilingue(cfg)  + '</script>',
    '<script>' + featRemplissage(cfg)  + '</script>',
    '<script>' + featParcours(cfg)     + '</script>',
    '<script>' + featPreuve(cfg)       + '</script>',
    '<script>' + featVoixRelais(cfg)   + '</script>',
  ].join('\n');
}

function buildBridgeScript(proxyOrigin, targetRoot) {
  return `<script>
(function(){
  var PROXY_ORIGIN = '${proxyOrigin}';
  var TARGET_ROOT = '${targetRoot}';
  var HIGHLIGHT_ID = '__oapi_highlight__';
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    if (href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
    if (a.getAttribute('target') === '_blank') return;
    if (a.hasAttribute('download')) return;
    var absoluteUrl, absHost;
    try {
      var u = new URL(href, document.baseURI);
      absoluteUrl = u.href;
      absHost = u.host;
    } catch (err) { return; }
    if (absoluteUrl.indexOf(PROXY_ORIGIN) === 0) return;
    // meme domaine racine (sous-domaines compris) -> on reste dans le proxy
    var memeRacine = absHost === TARGET_ROOT || absHost.slice(-(TARGET_ROOT.length + 1)) === '.' + TARGET_ROOT;
    if (memeRacine || a.hasAttribute('data-internal')) {
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
        source: 'ohapiday-bridge',
        type: 'ready',
        url: window.location.href,
        title: document.title
      }, '*');
    } catch (e) {}
  }
  function sanitizeLabel(label) {
    if (!label) return '';
    var s = String(label);
    if (s.length > 80) s = s.substring(0, 80);
    s = s.replace(/[\u0000-\u001F\u007F]+/g, ' ');
    s = s.replace(/["\u0060]/g, "'");
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
    var interactiveSel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [onclick]';
    var nodes = document.querySelectorAll(interactiveSel);
    var bestExact = null;
    var bestContains = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      var label = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (!label) continue;
      var labelLower = label.toLowerCase();
      if (labelLower === target) {
        bestExact = { el: el, label: label.substring(0, 80) };
        break;
      }
      if (!bestContains && labelLower.indexOf(target) !== -1) {
        bestContains = { el: el, label: label.substring(0, 80) };
      }
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
  function detectDarkPatterns() {
    var warnings = [];
    try {
      var checkedBoxes = document.querySelectorAll('input[type="checkbox"][checked], input[type="checkbox"]:checked');
      var suspiciousChecks = 0;
      checkedBoxes.forEach(function(cb) {
        var label = '';
        if (cb.id) {
          var lbl = document.querySelector('label[for="' + cb.id + '"]');
          if (lbl) label = lbl.textContent || '';
        }
        if (!label && cb.parentElement) {
          label = cb.parentElement.textContent || '';
        }
        label = label.toLowerCase().substring(0, 200);
        if (/newsletter|partenaire|offre|publicit|marketing|tiers|sponsor|inscrire|recevoir/.test(label)) {
          suspiciousChecks++;
        }
      });
      if (suspiciousChecks > 0) {
        warnings.push({
          level: 'info',
          text: suspiciousChecks + ' case(s) cochée(s) par défaut sur cette page. Vérifie chacune avant de valider.'
        });
      }
      var allBtns = document.querySelectorAll('button, a[role="button"], [class*="accept"], [class*="agree"]');
      var bigAccept = null;
      var smallReject = null;
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
        warnings.push({
          level: 'info',
          text: 'Sur cette page, le bouton "' + bigAccept.txt + '" est nettement plus grand que "' + smallReject.txt + '". Prends ton temps pour choisir.'
        });
      }
      var bodyText = (document.body.textContent || '').toLowerCase();
      if (/plus que \\d+ (place|article|en stock|disponible)/.test(bodyText) ||
          /offre se termine dans/.test(bodyText) ||
          /(\\d{1,2}:\\d{2}:\\d{2})/.test(bodyText)) {
        var timers = document.querySelectorAll('[class*="countdown"], [class*="timer"], [id*="countdown"]');
        if (timers.length > 0) {
          warnings.push({
            level: 'info',
            text: 'Compte à rebours visible sur cette page. Pas besoin de te précipiter.'
          });
        }
      }
      allBtns.forEach(function(b) {
        var txt = (b.textContent || '').toLowerCase().trim().substring(0, 100);
        if (/non merci.*(payer|prix fort|cher)|je ne veux pas (économiser|gagner)/.test(txt)) {
          warnings.push({
            level: 'info',
            text: 'Texte du bouton à lire attentivement : "' + (b.textContent || '').trim().substring(0, 80) + '". Choisis selon ce que tu veux vraiment.'
          });
        }
      });
    } catch (e) {}
    return warnings;
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
        var evt = new MouseEvent('click', {
          bubbles: true, cancelable: true, view: window
        });
        el.dispatchEvent(evt);
        return true;
      } catch (e2) {
        return false;
      }
    }
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
      if (Math.abs(scrollDelta) > 20) {
        window.scrollBy({ top: scrollDelta, behavior: 'smooth' });
      }
    } catch (e) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch(_) {}
    }
    var BORDER_W   = largeMode ? '6px' : '5px';
    var INSET      = largeMode ? '-10px' : '-6px';
    var BORDER_RAD = largeMode ? '14px' : '10px';
    var SHADOW_BASE = largeMode
      ? '0 0 0 8px rgba(255,106,0,0.45),0 0 44px 10px rgba(255,140,0,0.95),0 0 80px 20px rgba(255,90,0,0.6)'
      : '0 0 0 5px rgba(255,106,0,0.45),0 0 36px 8px rgba(255,140,0,0.95),0 0 64px 16px rgba(255,90,0,0.55)';
    var LABEL_FONT  = largeMode ? '16px' : '12px';
    var LABEL_PAD   = largeMode ? '11px 18px' : '7px 12px';
    var LABEL_RAD   = largeMode ? '12px' : '9px';
    var LABEL_MAXW  = largeMode ? '320px' : '240px';
    var overlay = document.createElement('div');
    overlay.id = HIGHLIGHT_ID;
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;transition:transform .2s ease;';
    overlay.innerHTML = (
      '<div style="position:absolute;inset:' + INSET + ';border:' + BORDER_W + ' solid #FF6A00;border-radius:' + BORDER_RAD + ';' +
      'box-shadow:' + SHADOW_BASE + ';' +
      'animation:oapiHighlightPulse 1.4s ease-in-out infinite"></div>' +
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
      if (Date.now() - startTs > 12000) {
        if (overlay.parentNode) overlay.remove();
        return;
      }
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
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'target-clicked',
          selector: selector,
          label: label || ''
        }, '*');
      } catch (e) {}
    }
    el.addEventListener('click', onClickTarget);
    return true;
  }
  window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.source !== 'ohapiday-app') return;
    if (d.type === 'extract-dom') {
      var dom = extractDOM();
      try {
        dom.heuristicWarnings = detectDarkPatterns();
      } catch (e) {
        dom.heuristicWarnings = [];
      }
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'dom',
          requestId: d.requestId,
          dom: dom
        }, '*');
      } catch (e) {}
    }
    else if (d.type === 'highlight') {
      var ok = highlightElement(d.selector, d.label, d.safeBottom, d.largeMode);
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'highlight-result',
          requestId: d.requestId,
          ok: ok
        }, '*');
      } catch (e) {}
    }
    else if (d.type === 'find-by-text') {
      var found = findByText(d.text);
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'find-result',
          requestId: d.requestId,
          found: found
        }, '*');
      } catch (e) {}
    }
    else if (d.type === 'click') {
      var ok = clickElement(d.selector);
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'click-result',
          requestId: d.requestId,
          ok: ok
        }, '*');
      } catch (e) {}
      if (ok) {
        setTimeout(function() {
          try {
            window.parent.postMessage({
              source: 'ohapiday-bridge',
              type: 'target-clicked',
              selector: d.selector
            }, '*');
          } catch (e) {}
        }, 200);
      }
    }
  });
  if (document.readyState === 'complete') {
    sendReady();
  } else {
    window.addEventListener('load', sendReady);
  }
  setTimeout(sendReady, 500);
  setTimeout(sendReady, 1500);
})();
</script>
`;
}

function homePage(origin) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Passerelle Oh API Day</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:0 24px;color:#1F1135;line-height:1.6}
h1{color:#8B1A1A;font-size:28px;margin:0 0 6px}
.sub{color:#8B5A0B;font-weight:600;margin-bottom:24px}
code{background:#F5E6D3;padding:2px 8px;border-radius:6px;font-family:'Courier New',monospace;font-size:13px;word-break:break-all}
.ok{padding:14px 16px;background:#10b98115;border:1px solid #10b98140;border-radius:10px;color:#065f46;margin:18px 0}
a{color:#8B1A1A;font-weight:600}
</style></head>
<body>
<h1>🌉 Passerelle Web Active</h1>
<div class="sub">Worker Cloudflare déployé pour Oh API Day</div>
<div class="ok">✅ Tout fonctionne ! Tu peux maintenant utiliser cette URL dans Astrid Navig.</div>
<h3>URL à copier dans Astrid :</h3>
<code>${origin}</code>
<h3>Routes disponibles :</h3>
<ul>
  <li><code>${origin}/proxy-web?url=&lt;site&gt;</code> — proxifier une page</li>
  <li><code>${origin}/proxy-asset?url=&lt;asset&gt;</code> — proxifier un asset</li>
</ul>
<h3>Fonctionnalités du bridge :</h3>
<ul>
  <li>✓ X-Frame-Options stripped</li>
  <li>✓ Liens internes routés via proxy</li>
  <li>✓ Astrid peut pointer DANS la page (cercle orange + label)</li>
  <li>✓ Astrid peut lire les éléments interactifs de la page</li>
</ul>
<p style="margin-top:36px;color:#5a4030;font-size:13px">
Pour modifier : <a href="https://dash.cloudflare.com" target="_blank">dash.cloudflare.com</a>
</p>
</body></html>`;
}


function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
async function rateLimitByIP(env, ip, action, max, windowSec) {
  if (!env || !env.RATELIMIT || !ip) return false;
  const key = 'rl:' + action + ':' + ip;
  const cur = await env.RATELIMIT.get(key);
  const count = parseInt(cur, 10) || 0;
  if (count >= max) return true;
  await env.RATELIMIT.put(key, String(count + 1), { expirationTtl: windowSec });
  return false;
}
const HB_AGREGAT_CLE = 'hb:stats:daily:latest';

// Lit UNE cle au lieu de parcourir tout le prefixe.
// 1 lecture KV par visite au lieu de 1001.

// Parcourt les compteurs bruts et ecrit UN agregat consultable.
// Appelee par le cron (1x/jour) ou au premier appel apres deploiement.
async function reconstruireAgregatHeartbeat(env) {
  if (!env || !env.CONAV_SESSIONS) return {};
  const stats = {};
  let curseur = undefined;

  do {
    const lot = await env.CONAV_SESSIONS.list({ prefix: 'hb:20', limit: 1000, cursor: curseur });
    for (const k of lot.keys) {
      const parts = k.name.split(':');          // hb:AAAA-MM-JJ:evenement:issue
      if (parts.length !== 4) continue;
      const v = await env.CONAV_SESSIONS.get(k.name);
      if (!v) continue;
      const [, jour, evenement, issue] = parts;
      stats[jour] = stats[jour] || {};
      stats[jour][evenement] = stats[jour][evenement] ||
        { ok: 0, fail: 0, na: 0, durationAvgMs: null, topDomains: {} };
      try {
        const agg = JSON.parse(v);
        stats[jour][evenement][issue] = agg.count;
        if (agg.durationCount > 0) {
          stats[jour][evenement].durationAvgMs = Math.round(agg.durationSum / agg.durationCount);
        }
        for (const [d, c] of Object.entries(agg.domains || {})) {
          stats[jour][evenement].topDomains[d] = (stats[jour][evenement].topDomains[d] || 0) + c;
        }
      } catch (e) {}
    }
    curseur = lot.list_complete ? undefined : lot.cursor;
  } while (curseur);

  try {
    await env.CONAV_SESSIONS.put(
      HB_AGREGAT_CLE,
      JSON.stringify({ stats: stats, generated: new Date().toISOString() }),
      { expirationTtl: 8 * 86400 }
    );
  } catch (e) { /* l'agregat est un confort, jamais bloquant */ }

  return stats;
}



// ════════════════════════════════════════════════════════════════
// MODULES CLIENT (lot 1) — injectés dans la page via buildFullBridge
// Chacun est un <script> isolé. Pour désactiver l'un d'eux, retire sa
// ligne dans buildFullBridge ci-dessus.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// 05 — FORMULAIRES + FETCH (client, injecté)  [LE VRAI CORRECTIF]
// ════════════════════════════════════════════════════════════════
//
// Corrige : recherche, connexion, démarches -> le submit sortait du
// proxy et échouait. On l'intercepte et on le renvoie DANS le proxy.
//
// Détail important : un formulaire GET ajoute ses champs à la fin de
// l'URL d'action. Si on réécrivait l'action côté HTML, les champs se
// colleraient au mauvais endroit. On construit donc la vraie URL cible
// ici, avec ses paramètres, PUIS on la proxifie. C'est la seule façon
// correcte.
//
// Les formulaires SENSIBLES (mot de passe, RIB…) ne sont PAS proxifiés :
// on émet un événement que le module sécurité (04) rattrape pour
// proposer d'ouvrir le vrai site officiel.

function featForms(cfg) {
  const P = JSON.stringify(cfg.proxyOrigin);
  const R = JSON.stringify(cfg.targetRoot);
  return String.raw`(function(){
  var PROXY = ${P}, ROOT = ${R};
  function sameRoot(host){
    host = String(host).toLowerCase();
    return host === ROOT || host.slice(-(ROOT.length+1)) === '.' + ROOT;
  }
  function isSensitive(form){
    if (form.querySelector('input[type=password]')) return true;
    var risky = /rib|iban|carte|card|cvv|cvc|bancaire|paiement|mot.?de.?passe|password/i;
    var fields = form.querySelectorAll('input, select');
    for (var i = 0; i < fields.length; i++){
      var meta = (fields[i].name||'') + ' ' + (fields[i].id||'') + ' ' + (fields[i].getAttribute('autocomplete')||'');
      if (risky.test(meta)) return true;
    }
    return false;
  }
  document.addEventListener('submit', function(e){
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    var action;
    try { action = new URL(form.getAttribute('action') || location.href, document.baseURI); }
    catch(err){ return; }
    if (action.protocol !== 'https:' && action.protocol !== 'http:') return;
    if (!sameRoot(action.hostname)) return; // cross-domaine : on laisse le navigateur faire

    if (isSensitive(form)) {
      e.preventDefault();
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge', type: 'sensitive-submit', action: action.href
        }, '*');
      } catch(_){}
      // le module sécurité (04) prend le relais et propose le vrai site
      return;
    }

    e.preventDefault();
    var fd = new FormData(form);
    // inclure le bouton d'envoi cliqué s'il porte un name
    if (e.submitter && e.submitter.name) fd.append(e.submitter.name, e.submitter.value || '');

    if (method === 'get') {
      var qp = new URLSearchParams(action.search);
      fd.forEach(function(v, k){ if (typeof v === 'string') qp.set(k, v); });
      action.search = qp.toString();
      window.location.href = PROXY + '/proxy-web?url=' + encodeURIComponent(action.href);
    } else {
      // POST : on rejoue le formulaire vers le proxy (le Worker transmet le corps)
      var pf = document.createElement('form');
      pf.method = 'POST';
      pf.action = PROXY + '/proxy-web?url=' + encodeURIComponent(action.href);
      pf.style.display = 'none';
      fd.forEach(function(v, k){
        if (typeof v !== 'string') return; // pas de fichiers ici
        var inp = document.createElement('input');
        inp.type = 'hidden'; inp.name = k; inp.value = v;
        pf.appendChild(inp);
      });
      document.body.appendChild(pf);
      pf.submit();
    }
  }, true);

  // ---- fetch() de la page : re-router les appels internes via le proxy ----
  // Utile pour les sites dynamiques dont l'API est bloquée par CORS :
  // le proxy, lui, fetch côté serveur et contourne CORS.
  // (Module le plus "sensible" : si un site complexe se comporte mal,
  //  c'est le premier à désactiver — commente ce bloc.)
  try {
    var _fetch = window.fetch;
    if (typeof _fetch === 'function') {
      window.fetch = function(input, init){
        try {
          var url = (typeof input === 'string') ? input : (input && input.url);
          if (url) {
            var u = new URL(url, document.baseURI);
            if ((u.protocol === 'https:' || u.protocol === 'http:') &&
                sameRoot(u.hostname) && u.origin !== location.origin) {
              var prox = PROXY + '/proxy-web?url=' + encodeURIComponent(u.href);
              if (typeof input === 'string') input = prox;
              else input = new Request(prox, input);
            }
          }
        } catch(_){}
        return _fetch.call(this, input, init);
      };
    }
  } catch(_){}
})();`;
}

// ════════════════════════════════════════════════════════════════
// 04 — SÉCURITÉ (client, injecté) : badge officiel + garde anti-arnaque
// ════════════════════════════════════════════════════════════════
//
// Deux comportements :
//   1) Page sur un domaine OFFICIEL  -> petit badge vert rassurant.
//   2) Page qui demande login / RIB / paiement sur un domaine NON
//      vérifié -> bandeau : "ouvre plutôt le vrai site officiel".
//
// C'est TON différenciateur : au lieu d'apprendre à ton public à taper
// son mot de passe sur un domaine proxy (réflexe d'arnaque), Astrid le
// protège. Reçoit aussi 'sensitive-submit' émis par le module 05.

function featSecurite(cfg) {
  const OFF = JSON.stringify(cfg.officielsList || []);
  return String.raw`(function(){
  var OFFICIELS = ${OFF};
  function realUrl(){
    try { return new URLSearchParams(location.search).get('url') || document.baseURI; }
    catch(e){ return document.baseURI; }
  }
  function hostOf(u){ try { return new URL(u).hostname.toLowerCase().replace(/^www\./,''); } catch(e){ return ''; } }
  function racine(host){
    var parts = host.split('.');
    if (parts.length <= 2) return host;
    var composes = ['gouv.fr','asso.fr','co.uk','com.br'];
    var deux = parts.slice(-2).join('.');
    if (composes.indexOf(deux) !== -1) return parts.slice(-3).join('.');
    return deux;
  }
  function estOfficiel(host){
    if (!host) return false;
    if (host === 'gouv.fr' || /\.gouv\.fr$/.test(host)) return true;
    if (OFFICIELS.indexOf(host) !== -1) return true;
    return OFFICIELS.indexOf(racine(host)) !== -1;
  }
  var HOST = hostOf(realUrl());
  var OFFICIEL = estOfficiel(HOST);

  // --- badge officiel discret (en bas à gauche) ---
  function badge(){
    if (!OFFICIEL) return;
    if (document.getElementById('__astrid_badge__')) return;
    var b = document.createElement('div');
    b.id = '__astrid_badge__';
    b.textContent = '✅ Site officiel vérifié';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483646;'
      + 'background:#065f46;color:#fff;font:600 13px system-ui,sans-serif;'
      + 'padding:8px 12px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.25);'
      + 'pointer-events:none;opacity:.96';
    (document.body || document.documentElement).appendChild(b);
    setTimeout(function(){ if (b.parentNode){ b.style.transition='opacity .6s'; b.style.opacity='0'; setTimeout(function(){ b.remove(); },700); } }, 6000);
  }

  // --- bandeau d'alerte + bouton "ouvrir le vrai site" ---
  function alerte(msg){
    if (document.getElementById('__astrid_garde__')) return;
    var bar = document.createElement('div');
    bar.id = '__astrid_garde__';
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;'
      + 'background:#8B1A1A;color:#FFE8B5;font:700 16px system-ui,sans-serif;'
      + 'padding:16px 18px;box-shadow:0 4px 20px rgba(0,0,0,.35);'
      + 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
    var txt = document.createElement('span');
    txt.style.flex = '1 1 240px';
    txt.textContent = '⚠️ ' + msg;
    var btn = document.createElement('button');
    btn.textContent = 'Ouvrir le vrai site officiel';
    btn.style.cssText = 'background:#FFE8B5;color:#8B1A1A;border:0;border-radius:10px;'
      + 'padding:12px 18px;font:800 15px system-ui,sans-serif;cursor:pointer';
    btn.onclick = function(){ try { window.open(realUrl(), '_blank', 'noopener'); } catch(e){} };
    var close = document.createElement('button');
    close.textContent = 'Fermer';
    close.style.cssText = 'background:transparent;color:#FFE8B5;border:1px solid #FFE8B5;'
      + 'border-radius:10px;padding:12px 14px;font:700 14px system-ui,sans-serif;cursor:pointer';
    close.onclick = function(){ bar.remove(); };
    bar.appendChild(txt); bar.appendChild(btn); bar.appendChild(close);
    (document.body || document.documentElement).appendChild(bar);
  }

  // page sensible (mot de passe / RIB) sur domaine non officiel ?
  function scanSensible(){
    if (OFFICIEL) return; // sur un vrai site officiel, saisir est normal
    var hasPwd = !!document.querySelector('input[type=password]');
    var risky = document.querySelector('input[autocomplete*="cc-"], input[name*="rib" i], input[name*="iban" i], input[name*="carte" i]');
    if (hasPwd || risky) {
      alerte('Cette page demande une information sensible (mot de passe ou coordonnées). Par sécurité, fais-le sur le vrai site officiel.');
    }
  }

  // signal envoyé par le module formulaires quand un envoi sensible est bloqué
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'sensitive-submit') return;
    alerte('Cette démarche demande ta connexion. Pour ta sécurité, termine-la sur le vrai site officiel.');
  });

  function run(){ try { badge(); scanSensible(); } catch(e){} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  setTimeout(run, 1500); // re-scan si la page se remplit après coup
})();`;
}

// ════════════════════════════════════════════════════════════════
// 06 — LECTURE À VOIX HAUTE (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Bouton flottant "🔊 Lire". Lit la sélection si tu as surligné du
// texte, sinon le contenu principal de la page. Gratuit (SpeechSynthesis
// natif), aucune dépendance. Langue configurable via cfg.lang.
//
// Astuce accessibilité : gros bouton, contraste fort, un seul geste.

function featTTS(cfg) {
  const LANG = JSON.stringify(cfg.lang || 'fr-FR');
  return String.raw`(function(){
  if (!('speechSynthesis' in window)) return;
  var LANG = ${LANG};
  var speaking = false;

  function mainText(){
    var sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
    if (sel.length > 1) return sel;
    var el = document.querySelector('main, article, [role=main], #content, .content') || document.body;
    var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 9000); // borne raisonnable
  }
  function stop(){
    try { window.speechSynthesis.cancel(); } catch(e){}
    speaking = false; render();
  }
  function speak(){
    var text = mainText();
    if (!text) return;
    stop();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = LANG; u.rate = 0.95; u.pitch = 1;
    u.onend = function(){ speaking = false; render(); };
    u.onerror = function(){ speaking = false; render(); };
    speaking = true; render();
    try { window.speechSynthesis.speak(u); } catch(e){ speaking = false; render(); }
  }

  var btn = document.createElement('button');
  btn.id = '__astrid_tts__';
  btn.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;'
    + 'background:#1F1135;color:#FFE8B5;border:0;border-radius:14px;'
    + 'padding:14px 18px;font:800 16px system-ui,sans-serif;cursor:pointer;'
    + 'box-shadow:0 6px 18px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px';
  function render(){ btn.textContent = speaking ? '⏹ Arrêter la lecture' : '🔊 Lire la page'; }
  render();
  btn.onclick = function(){ speaking ? stop() : speak(); };

  function mount(){ if (!document.getElementById('__astrid_tts__')) (document.body||document.documentElement).appendChild(btn); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // arrête la lecture si on quitte la page
  window.addEventListener('beforeunload', stop);

  // permet à ton app de piloter la lecture (ex: lire l'explication d'Astrid)
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app') return;
    if (d.type === 'tts-speak' && d.text) {
      stop();
      var u = new SpeechSynthesisUtterance(String(d.text).slice(0, 4000));
      u.lang = d.lang || LANG; u.rate = 0.95;
      try { window.speechSynthesis.speak(u); } catch(e){}
    }
    if (d.type === 'tts-stop') stop();
  });
})();`;
}

// ════════════════════════════════════════════════════════════════
// 07 — EXPLIQUE-MOI CE MOT (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// L'utilisateur double-clique (ou appui long sur mobile) sur un mot
// difficile -> une bulle explique en français simple, SANS quitter la
// page. On cherche d'abord dans le glossaire (instantané, gratuit) ;
// si absent, on demande à ton app via postMessage 'explique-request'
// et on attend 'explique-response'.
//
// SEUL branchement nécessaire côté ton app (voir le guide) :
//   - écouter 'explique-request' {word, context}
//   - appeler Puter/Astrid : "Explique <word> en une phrase simple,
//     dans ce contexte : <context>"
//   - renvoyer postMessage 'explique-response' {word, text}

function featExplique(cfg) {
  const GLO = JSON.stringify(cfg.glossaire || {});
  return String.raw`(function(){
  var GLOSSAIRE = ${GLO};
  function norm(s){
    return String(s||'').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // enlève les accents
      .replace(/[^a-z' ]/g,'').trim();
  }
  // index normalisé du glossaire pour une recherche tolérante
  var IDX = {};
  Object.keys(GLOSSAIRE).forEach(function(k){ IDX[norm(k)] = GLOSSAIRE[k]; });

  function lookup(word){
    var n = norm(word);
    if (!n) return null;
    if (IDX[n]) return IDX[n];
    // essaie le mot au singulier grossier
    if (n.length > 4 && IDX[n.replace(/s$/,'')]) return IDX[n.replace(/s$/,'')];
    return null;
  }
  function sentenceAround(node, word){
    try {
      var t = (node && node.textContent) || document.body.innerText || '';
      var i = t.toLowerCase().indexOf(String(word).toLowerCase());
      if (i < 0) return '';
      var start = Math.max(0, i - 120), end = Math.min(t.length, i + 120);
      return t.slice(start, end).replace(/\s+/g,' ').trim();
    } catch(e){ return ''; }
  }

  var bulle = null;
  function fermer(){ if (bulle && bulle.parentNode){ bulle.remove(); } bulle = null; }
  function afficher(word, texte, x, y){
    fermer();
    bulle = document.createElement('div');
    bulle.style.cssText = 'position:fixed;z-index:2147483647;max-width:320px;'
      + 'background:#1F1135;color:#FFE8B5;font:600 16px/1.5 system-ui,sans-serif;'
      + 'padding:14px 16px;border-radius:14px;box-shadow:0 8px 26px rgba(0,0,0,.4)';
    var titre = document.createElement('div');
    titre.style.cssText = 'font-weight:800;margin-bottom:6px;color:#FF9A3D';
    titre.textContent = '💡 ' + word;
    var corps = document.createElement('div');
    corps.textContent = texte;
    var fx = document.createElement('button');
    fx.textContent = '✕';
    fx.style.cssText = 'position:absolute;top:6px;right:8px;background:transparent;border:0;color:#FFE8B5;font-size:18px;cursor:pointer';
    fx.onclick = fermer;
    bulle.appendChild(titre); bulle.appendChild(corps); bulle.appendChild(fx);
    bulle.style.left = Math.min(x, window.innerWidth - 340) + 'px';
    bulle.style.top  = Math.min(y + 12, window.innerHeight - 140) + 'px';
    (document.body||document.documentElement).appendChild(bulle);
    // lecture à voix haute de l'explication, si le module TTS est là
    try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: word + '. ' + texte }, '*'); } catch(e){}
  }

  function traiter(word, node, x, y){
    word = String(word||'').trim();
    if (word.length < 2 || word.length > 40) return;
    var hit = lookup(word);
    if (hit) { afficher(word, hit, x, y); return; }
    // pas dans le glossaire -> on demande à l'app
    afficher(word, '…', x, y);
    var ctx = sentenceAround(node, word);
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'explique-request', word: word, context: ctx }, '*');
    } catch(e){}
  }

  // réponse de l'app
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'explique-response' || !d.word) return;
    if (bulle) {
      var corps = bulle.childNodes[1];
      if (corps) corps.textContent = String(d.text||'').slice(0, 400) || 'Désolé, pas d\'explication trouvée.';
      try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: d.word + '. ' + (d.text||'') }, '*'); } catch(e){}
    }
  });

  // desktop : double-clic sélectionne le mot
  document.addEventListener('dblclick', function(e){
    var sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
    if (sel && sel.indexOf(' ') === -1) traiter(sel, e.target, e.clientX, e.clientY);
  });

  // mobile : appui long
  var lpTimer = null, lpXY = null;
  document.addEventListener('touchstart', function(e){
    var t = e.touches && e.touches[0]; if (!t) return;
    lpXY = { x: t.clientX, y: t.clientY };
    lpTimer = setTimeout(function(){
      var word = '';
      try {
        var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(lpXY.x, lpXY.y) : null;
        if (r && r.startContainer && r.startContainer.textContent){
          var txt = r.startContainer.textContent;
          var off = r.startOffset;
          var left = txt.slice(0, off).match(/[\p{L}'-]+$/u);
          var right = txt.slice(off).match(/^[\p{L}'-]+/u);
          word = ((left?left[0]:'') + (right?right[0]:'')).trim();
        }
      } catch(err){}
      if (word) traiter(word, (r&&r.startContainer), lpXY.x, lpXY.y);
    }, 550);
  }, { passive: true });
  function clearLP(){ if (lpTimer){ clearTimeout(lpTimer); lpTimer = null; } }
  document.addEventListener('touchend', clearLP, { passive: true });
  document.addEventListener('touchmove', clearLP, { passive: true });

  // fermer la bulle en cliquant ailleurs
  document.addEventListener('click', function(e){
    if (bulle && !bulle.contains(e.target)) fermer();
  }, true);
})();`;
}

// ════════════════════════════════════════════════════════════════
// 08 — ANTI-ABANDON (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Détecte les signaux de blocage SANS que l'utilisateur demande :
//   - inactivité prolongée (75 s sans interaction utile)
//   - même élément cliqué 3 fois de suite (bouton qui "ne marche pas")
//   - scroll qui oscille (cherche sans trouver)
// Puis émet UNE fois 'user-stuck' vers ton app (cooldown 60 s), pour
// qu'Astrid propose son aide. Un bandeau doux s'affiche en secours si
// ton app ne réagit pas.
//
// Le moment critique de ton public n'est pas quand il demande de l'aide,
// c'est quand il n'ose pas et ferme tout. Ce module attrape ça.

function featAntiAbandon(cfg) {
  return String.raw`(function(){
  var lastInteract = Date.now();
  var lastEmit = 0;
  var COOLDOWN = 60000;

  function emit(raison){
    var now = Date.now();
    if (now - lastEmit < COOLDOWN) return;
    lastEmit = now;
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'user-stuck', reason: raison }, '*');
    } catch(e){}
    secours();
  }

  // bandeau doux de secours (si l'app ne prend pas la main)
  function secours(){
    if (document.getElementById('__astrid_help__')) return;
    var box = document.createElement('div');
    box.id = '__astrid_help__';
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:80px;'
      + 'z-index:2147483646;background:#FF6A00;color:#1F1135;font:800 16px system-ui,sans-serif;'
      + 'padding:14px 18px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.3);'
      + 'display:flex;align-items:center;gap:12px;max-width:90vw';
    var t = document.createElement('span');
    t.textContent = 'Besoin d\'un coup de main sur cette page ?';
    var oui = document.createElement('button');
    oui.textContent = 'Oui, montre-moi';
    oui.style.cssText = 'background:#1F1135;color:#FFE8B5;border:0;border-radius:10px;padding:10px 14px;font:800 15px system-ui;cursor:pointer';
    oui.onclick = function(){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'help-requested' }, '*'); } catch(e){}
      box.remove();
    };
    var non = document.createElement('button');
    non.textContent = 'Ça va';
    non.style.cssText = 'background:transparent;color:#1F1135;border:1px solid #1F1135;border-radius:10px;padding:10px 12px;font:700 14px system-ui;cursor:pointer';
    non.onclick = function(){ box.remove(); };
    box.appendChild(t); box.appendChild(oui); box.appendChild(non);
    (document.body||document.documentElement).appendChild(box);
    setTimeout(function(){ if (box.parentNode) box.remove(); }, 15000);
  }

  // --- inactivité ---
  function touch(){ lastInteract = Date.now(); }
  ['click','keydown','input','pointerdown'].forEach(function(ev){
    document.addEventListener(ev, touch, { passive: true, capture: true });
  });
  setInterval(function(){
    if (document.hidden) return; // onglet en arrière-plan : on ne compte pas
    if (Date.now() - lastInteract > 75000) { emit('inactivite'); lastInteract = Date.now(); }
  }, 15000);

  // --- même élément cliqué 3x ---
  var lastEl = null, repeat = 0, lastClickTs = 0;
  document.addEventListener('click', function(e){
    var now = Date.now();
    if (e.target === lastEl && now - lastClickTs < 8000) repeat++;
    else repeat = 1;
    lastEl = e.target; lastClickTs = now;
    if (repeat >= 3) { emit('clics-repetes'); repeat = 0; }
  }, true);

  // --- scroll qui oscille ---
  var dirs = [], lastY = window.scrollY;
  window.addEventListener('scroll', function(){
    var y = window.scrollY;
    var d = y > lastY ? 1 : (y < lastY ? -1 : 0);
    lastY = y;
    if (d === 0) return;
    dirs.push({ d: d, t: Date.now() });
    dirs = dirs.filter(function(o){ return Date.now() - o.t < 8000; });
    var flips = 0;
    for (var i = 1; i < dirs.length; i++) if (dirs[i].d !== dirs[i-1].d) flips++;
    if (flips >= 6) { emit('scroll-agite'); dirs = []; }
  }, { passive: true });
})();`;
}


// ════════════════════════════════════════════════════════════════
// MODULES CLIENT (lot 2) — injectés via buildFullBridge
// IA : ces modules N'APPELLENT PAS l'IA. Ils émettent des demandes
// (translate-request, explique-request, proof-analyze-request…) que
// TON APPLICATION reçoit et traite avec Puter, puis renvoie la réponse.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// 09b — MULTILINGUE ADMIN (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Sélecteur de langue flottant. Quand une langue non-FR est choisie :
//   - chaque bouton/lien reçoit une petite bulle "traduction (Français)"
//     -> la personne lit dans sa langue, agit sur le vrai mot FR.
//   - le volet lecture peut être lu dans sa langue (via TTS lang).
// Les termes d'interface courants sont traduits par le glossaire
// (instantané). Le texte propre à la page part à ton IA.
//
// BRANCHEMENT APP (facultatif, pour le texte hors glossaire) :
//   écouter 'translate-request' {lang, texts:[...]} -> IA ->
//   renvoyer 'translate-response' {lang, translations:[...]} (même ordre)

function featMultilingue(cfg) {
  const MULTI  = JSON.stringify(cfg.glossaireMulti || {});
  const LANGS  = JSON.stringify(cfg.languesDispo || []);
  const TTSMAP = JSON.stringify(cfg.langTts || {});
  return String.raw`(function(){
  var MULTI = ${MULTI}, LANGS = ${LANGS}, TTSMAP = ${TTSMAP};
  var current = 'fr';

  function norm(s){
    return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  }
  function traduireTerme(txt, lang){
    var n = norm(txt);
    if (MULTI[n] && MULTI[n][lang]) return MULTI[n][lang];
    return null; // inconnu du glossaire -> IA
  }

  // éléments interactifs à étiqueter
  function cibles(){
    return Array.prototype.slice.call(
      document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], label')
    ).filter(function(el){
      var t = (el.innerText || el.value || '').trim();
      return t && t.length <= 40 && el.offsetParent !== null;
    });
  }

  function poserBulle(el, trad, orig){
    if (el.__astridTrad) el.__astridTrad.remove();
    var tag = document.createElement('span');
    tag.className = '__astrid_ml__';
    tag.dir = 'auto';
    tag.textContent = trad + ' (' + orig + ')';
    tag.style.cssText = 'display:inline-block;background:#1F1135;color:#FFE8B5;'
      + 'font:600 13px system-ui,sans-serif;padding:2px 8px;border-radius:8px;'
      + 'margin-left:6px;vertical-align:middle;white-space:nowrap';
    el.appendChild(tag);
    el.__astridTrad = tag;
  }
  function nettoyer(){
    Array.prototype.slice.call(document.querySelectorAll('.__astrid_ml__')).forEach(function(t){ t.remove(); });
    cibles().forEach(function(el){ el.__astridTrad = null; });
  }

  function appliquer(lang){
    current = lang;
    nettoyer();
    if (lang === 'fr') return;
    var manquants = [], refs = [];
    cibles().forEach(function(el){
      var orig = (el.innerText || el.value || '').trim().replace(/\s*\(.*/,'');
      var trad = traduireTerme(orig, lang);
      if (trad) { poserBulle(el, trad, orig); }
      else { manquants.push(orig); refs.push(el); }
    });
    // le reste -> IA
    if (manquants.length) {
      window.__astridMLpending = { lang: lang, refs: refs };
      try {
        window.parent.postMessage({ source:'ohapiday-bridge', type:'translate-request', lang: lang, texts: manquants }, '*');
      } catch(e){}
    }
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'translate-response' || !window.__astridMLpending) return;
    if (d.lang !== window.__astridMLpending.lang) return;
    var refs = window.__astridMLpending.refs, tr = d.translations || [];
    refs.forEach(function(el, i){
      var orig = (el.innerText || el.value || '').trim().replace(/\s*\(.*/,'');
      if (tr[i]) poserBulle(el, tr[i], orig);
    });
    window.__astridMLpending = null;
  });

  // sélecteur de langue
  function menu(){
    var wrap = document.createElement('div');
    wrap.id = '__astrid_langsel__';
    wrap.style.cssText = 'position:fixed;right:14px;top:14px;z-index:2147483646;'
      + 'background:#fff;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.25);'
      + 'padding:6px;display:flex;gap:4px;flex-wrap:wrap;max-width:70vw';
    LANGS.forEach(function(L){
      var b = document.createElement('button');
      b.textContent = L.nom;
      b.dir = 'auto';
      b.style.cssText = 'border:0;border-radius:8px;padding:8px 10px;cursor:pointer;'
        + 'font:700 14px system-ui,sans-serif;background:#F3EEFF;color:#1F1135';
      b.onclick = function(){
        Array.prototype.slice.call(wrap.children).forEach(function(x){ x.style.background='#F3EEFF'; x.style.color='#1F1135'; });
        b.style.background = '#FF6A00'; b.style.color = '#1F1135';
        appliquer(L.code);
      };
      wrap.appendChild(b);
    });
    (document.body||document.documentElement).appendChild(wrap);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', menu);
  else menu();

  // permet à ton app de lire le contenu dans la langue choisie
  window.__astridLangTTS = function(){ return TTSMAP[current] || 'fr-FR'; };
})();`;
}

// ════════════════════════════════════════════════════════════════
// 10 — REMPLISSAGE NARRÉ (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Ta valeur n'est PAS l'autofill silencieux (angoissant : "qui a rempli
// ça ?"). C'est le TEMPO et la CONFIANCE : un champ à la fois, à voix
// haute, avec une pause pour vérifier, et JAMAIS de validation
// automatique. Astrid remplit, montre, explique — la personne valide.
//
// L'app envoie un PLAN (les valeurs viennent de TON coffre côté app,
// jamais stockées ici) :
//   {source:'ohapiday-app', type:'fill-plan',
//    steps:[ {find:'nom', value:'Dupont', say:'ton nom de famille'},
//            {find:'email', value:'a@b.fr', say:'ton adresse mail'},
//            {find:'#pass', value:'****', say:'ton mot de passe', secret:true} ],
//    submitLabel:'Valider'}
//
// Le module remplit pas à pas, surligne, narre (sauf les champs secret),
// puis s'ARRÊTE sur le bouton d'envoi sans cliquer. Émet 'fill-done'.

function featRemplissage(cfg) {
  return String.raw`(function(){
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }

  // trouve un champ par sélecteur CSS, label associé, placeholder, name/id
  function trouverChamp(q){
    if (!q) return null;
    // 1) sélecteur CSS direct
    try { var el = document.querySelector(q); if (el) return el; } catch(e){}
    var n = norm(q);
    // 2) via <label>
    var labels = document.querySelectorAll('label');
    for (var i=0;i<labels.length;i++){
      if (norm(labels[i].textContent).indexOf(n) !== -1){
        var f = labels[i].getAttribute('for');
        if (f){ var t = document.getElementById(f); if (t) return t; }
        var inner = labels[i].querySelector('input,select,textarea'); if (inner) return inner;
      }
    }
    // 3) placeholder / aria-label / name / id
    var champs = document.querySelectorAll('input, select, textarea');
    for (var j=0;j<champs.length;j++){
      var meta = norm((champs[j].placeholder||'') + ' ' + (champs[j].getAttribute('aria-label')||'') + ' ' + (champs[j].name||'') + ' ' + (champs[j].id||''));
      if (meta.indexOf(n) !== -1) return champs[j];
    }
    return null;
  }

  function parler(txt){
    try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: txt }, '*'); } catch(e){}
  }
  function surligner(el){
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'fill-highlight',
        rect: el.getBoundingClientRect() && { x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top, w: el.offsetWidth, h: el.offsetHeight } }, '*');
    } catch(e){}
    try { el.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){}
    el.style.outline = '3px solid #FF6A00';
    el.style.outlineOffset = '2px';
    setTimeout(function(){ el.style.outline=''; }, 2600);
  }
  function poser(el, val){
    var proto = el.tagName === 'SELECT' ? null : Object.getPrototypeOf(el);
    try {
      var setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, val); else el.value = val;
    } catch(e){ el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  }

  function jouer(plan){
    var steps = plan.steps || [];
    var i = 0;
    function suite(){
      if (i >= steps.length){ terminer(plan); return; }
      var s = steps[i++];
      var el = trouverChamp(s.find);
      if (!el){
        // champ introuvable : on prévient et on continue
        try { window.parent.postMessage({ source:'ohapiday-bridge', type:'fill-miss', find: s.find }, '*'); } catch(e){}
        setTimeout(suite, 200); return;
      }
      surligner(el);
      var phrase = s.secret
        ? ('Là je saisis ' + (s.say || 'cette information') + ', que je ne dis pas à voix haute.')
        : ('Là je mets ' + (s.say || 'cette information') + ' : ' + s.value + '. Vérifie que c\'est bon.');
      parler(phrase);
      setTimeout(function(){ poser(el, s.value); setTimeout(suite, 1600); }, 900);
    }
    suite();
  }

  function terminer(plan){
    var btn = null;
    if (plan.submitLabel){
      var lbl = norm(plan.submitLabel);
      var cand = document.querySelectorAll('button, input[type=submit], [role=button]');
      for (var k=0;k<cand.length;k++){
        if (norm(cand[k].innerText || cand[k].value).indexOf(lbl) !== -1){ btn = cand[k]; break; }
      }
    }
    if (btn){
      surligner(btn);
      parler('Tout est rempli. Quand tu es prêt, clique sur le bouton en orange pour valider. Je ne valide pas à ta place.');
    } else {
      parler('Tout est rempli. Vérifie une dernière fois, puis valide toi-même.');
    }
    try { window.parent.postMessage({ source:'ohapiday-bridge', type:'fill-done' }, '*'); } catch(e){}
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app' || d.type !== 'fill-plan') return;
    jouer(d);
  });
})();`;
}

// ════════════════════════════════════════════════════════════════
// 11 — PARCOURS REJOUABLE (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Mémorise le CHEMIN d'une démarche réussie — jamais les données
// sensibles, seulement l'itinéraire : "sur cette page, clic sur ce
// bouton". La fois d'après, Astrid rejoue le chemin étape par étape.
//
// Robuste aux changements de mise en page : on mémorise le LIBELLÉ du
// bouton, pas ses coordonnées. findByText le retrouve même si la page a
// bougé.
//
// DEUX MODES pilotés par ton app :
//   - ENREGISTRER : {source:'ohapiday-app', type:'journey-record', on:true}
//        -> le bridge émet 'journey-step' {url, label, tag} à chaque clic.
//        -> ton app accumule et stocke le parcours (petit JSON).
//   - REJOUER : {source:'ohapiday-app', type:'replay-step', step:{label}}
//        -> le bridge surligne l'élément + narre "clique sur X".
//        -> quand la personne clique / la page change, ton app envoie
//           l'étape suivante.

function featParcours(cfg) {
  return String.raw`(function(){
  var recording = false;
  function realUrl(){ try { return new URLSearchParams(location.search).get('url') || document.baseURI; } catch(e){ return document.baseURI; } }
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
  function libelle(el){
    var t = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim();
    return t.replace(/\s+/g,' ').slice(0, 60);
  }
  function estCliquable(el){
    while (el && el !== document.body){
      var tag = el.tagName;
      if (tag === 'A' || tag === 'BUTTON' || el.getAttribute('role') === 'button' ||
          (tag === 'INPUT' && /submit|button/i.test(el.type||''))) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ENREGISTREMENT
  document.addEventListener('click', function(e){
    if (!recording) return;
    var el = estCliquable(e.target);
    if (!el) return;
    var lab = libelle(el);
    if (!lab) return; // pas de libellé -> inutile à rejouer
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'journey-step',
        url: realUrl(), label: lab, tag: el.tagName }, '*');
    } catch(err){}
  }, true);

  // REJEU : surligner l'étape courante
  function rejouerEtape(step){
    var cible = null, best = -1, lab = norm(step.label);
    var cand = document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button]');
    for (var i=0;i<cand.length;i++){
      if (cand[i].offsetParent === null) continue;
      var t = norm(cand[i].innerText || cand[i].value);
      if (!t) continue;
      var score = (t === lab) ? 100 : (t.indexOf(lab) !== -1 || lab.indexOf(t) !== -1 ? 50 : -1);
      if (score > best){ best = score; cible = cand[i]; }
    }
    if (!cible){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'replay-miss', label: step.label }, '*'); } catch(e){}
      return;
    }
    try { cible.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){}
    cible.style.outline = '4px solid #FF6A00';
    cible.style.outlineOffset = '3px';
    try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: 'Clique sur ' + step.label + '. Je te le montre en orange.' }, '*'); } catch(e){}
    // quand la personne clique dessus, on prévient l'app (étape suivante)
    var onClick = function(){
      cible.style.outline = '';
      cible.removeEventListener('click', onClick, true);
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'replay-advance', label: step.label }, '*'); } catch(e){}
    };
    cible.addEventListener('click', onClick, true);
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app') return;
    if (d.type === 'journey-record') recording = !!d.on;
    if (d.type === 'replay-step' && d.step) rejouerEtape(d.step);
  });
})();`;
}

// ════════════════════════════════════════════════════════════════
// 12 — PREUVE AUTOMATIQUE + ÉCHÉANCES (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Astrid lit chaque page et repère TOUTE SEULE :
//   - les échéances ("avant le 15 mars", "sous 15 jours")
//   - les numéros de dossier / références
//   - les pages de confirmation ("votre demande a bien été prise en compte")
//
// Sur une confirmation, elle propose de garder la preuve (texte propre +
// date + URL) et de créer un rappel tiré du texte même de la page.
// C'est le pont entre l'écran et la vie réelle — là où ton public décroche.
//
// ÉVÉNEMENTS émis vers ton app :
//   'proof-found'    {kind, action, date, reference, url, capturedAt, snapshot}
//   'deadline-found' {text, date, url}
// BRANCHEMENT IA (facultatif, pour fiabiliser l'extraction) :
//   'proof-analyze-request' {text} -> IA -> 'proof-analyze-response' {action,date,reference}
// Ton app : stocke la preuve, crée le rappel (calendrier / notification).

function featPreuve(cfg) {
  return String.raw`(function(){
  function realUrl(){ try { return new URLSearchParams(location.search).get('url') || document.baseURI; } catch(e){ return document.baseURI; } }
  function mainText(){
    var el = document.querySelector('main, article, [role=main], #content, .content') || document.body;
    return (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();
  }

  var MOIS = 'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre';
  var reEcheanceMois = new RegExp('(avant le|jusqu\'au|au plus tard le|d\'ici le)\\s+(\\d{1,2}\\s+(?:' + MOIS + ')(?:\\s+\\d{4})?)', 'i');
  var reEcheanceNum  = /(avant le|jusqu'au|au plus tard le|d'ici le)\s+(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})/i;
  var reDelai        = /sous\s+(\d{1,2})\s+(jours|semaines|mois)/i;
  var reReference    = /(?:dossier|référence|reference|récépissé|recepisse|numéro|numero|n[°o])\s*:?\s*(?:n[°o]\s*)?([A-Z0-9][A-Z0-9\-\/]{3,19})/i;
  function extraireRef(txt){ var m = reReference.exec(txt); if (!m) return null; var v = m[1].trim(); return /\d/.test(v) ? v : null; }
  var reConfirm      = /(a bien été (?:pris|prise|enregistr)|votre demande a été|confirmation de|récépissé|recepisse|accusé de réception|accuse de reception|est confirmée|est confirmee|merci.{0,20}votre demande)/i;

  function analyser(){
    var txt = mainText();
    if (!txt || txt.length < 40) return;

    // échéances (passif : même sans confirmation)
    var mEch = reEcheanceMois.exec(txt) || reEcheanceNum.exec(txt);
    if (mEch){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'deadline-found',
        text: mEch[0], date: mEch[2], url: realUrl() }, '*'); } catch(e){}
    } else {
      var mDel = reDelai.exec(txt);
      if (mDel){
        try { window.parent.postMessage({ source:'ohapiday-bridge', type:'deadline-found',
          text: mDel[0], date: null, url: realUrl() }, '*'); } catch(e){}
      }
    }

    // page de confirmation -> preuve
    if (reConfirm.test(txt)){
      var ref = extraireRef(txt);
      var snapshot = txt.slice(0, 600);
      var payload = {
        kind: 'confirmation',
        action: (reConfirm.exec(txt)||[])[0] || 'Demande confirmée',
        date: (mEch ? mEch[2] : null),
        reference: ref,
        url: realUrl(),
        capturedAt: new Date().toISOString(),
        snapshot: snapshot
      };
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'proof-found', proof: payload }, '*'); } catch(e){}
      // fiabilisation IA (facultative)
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'proof-analyze-request', text: snapshot }, '*'); } catch(e){}
      banniere();
    }
  }

  // petit bandeau proposant de garder la preuve
  function banniere(){
    if (document.getElementById('__astrid_preuve__')) return;
    var box = document.createElement('div');
    box.id = '__astrid_preuve__';
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:14px;'
      + 'z-index:2147483646;background:#065f46;color:#fff;font:700 15px system-ui,sans-serif;'
      + 'padding:14px 18px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.3);'
      + 'display:flex;align-items:center;gap:12px;max-width:92vw';
    var t = document.createElement('span');
    t.textContent = '✅ Démarche confirmée. Astrid peut garder la preuve.';
    var b = document.createElement('button');
    b.textContent = 'Garder la preuve';
    b.style.cssText = 'background:#FFE8B5;color:#065f46;border:0;border-radius:10px;padding:10px 14px;font:800 15px system-ui;cursor:pointer';
    b.onclick = function(){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'proof-save-confirmed' }, '*'); } catch(e){}
      box.remove();
    };
    var x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'background:transparent;color:#fff;border:0;font-size:18px;cursor:pointer';
    x.onclick = function(){ box.remove(); };
    box.appendChild(t); box.appendChild(b); box.appendChild(x);
    (document.body||document.documentElement).appendChild(box);
  }

  function run(){ try { analyser(); } catch(e){} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  setTimeout(run, 2000); // re-scan si la confirmation arrive après coup
})();`;
}

// ════════════════════════════════════════════════════════════════
// 15 — RELAIS VOCAL (client, injecté) — le pendant de 14 dans la page
// ════════════════════════════════════════════════════════════════
//
// Reçoit les ordres du module vocal (14) et agit dans la page :
//   'voice-point' {voiceId, label, click}  -> trouve, pointe, (clique)
//   'nav-back'                              -> page précédente
//   'tts-speak-page'                        -> lit le contenu principal
//   'explique-mot' {mot}                    -> demande l'explication
//   'voice-list-elements'                   -> renvoie les libellés cliquables
// Et signale 'page-ready' au chargement (pour enchaîner les étapes).

function featVoixRelais(cfg) {
  return String.raw`(function(){
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
  function versParent(msg){ try { window.parent.postMessage(Object.assign({ source:'ohapiday-bridge' }, msg), '*'); } catch(e){} }

  // Elements que l'on peut montrer ou activer.
  // L'ancienne version ne prenait que a/button/role=button : elle ratait
  // les champs de formulaire, les onglets, les elements custom, et
  // surtout tout ce qui est en position:fixed (offsetParent vaut null
  // pour eux, alors qu'ils sont parfaitement visibles).
  function estVisible(el){
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  function libelleDe(el){
    // On CUMULE toutes les sources au lieu de prendre la premiere :
    //  - un bouton icone a innerText = "🔍" (non vide) et le vrai
    //    libelle dans aria-label ;
    //  - un <select> a innerText = le texte des options, et son nom
    //    dans l'attribut name ou dans un <label for>.
    // Prendre la premiere source non vide ratait ces deux cas.
    var bouts = [];
    var tag = (el.tagName || '').toLowerCase();

    // Les champs de formulaire : leur propre texte n'est pas leur libelle
    if (tag !== 'select' && tag !== 'textarea' && tag !== 'input') {
      bouts.push(el.innerText || '');
    }
    ['aria-label','title','alt','name','placeholder'].forEach(function(a){
      var v = el.getAttribute && el.getAttribute(a);
      if (v) bouts.push(v);
    });
    if (el.value && tag === 'input') bouts.push(el.value);

    // Un <label for="..."> qui designe cet element
    if (el.id) {
      try {
        var lb = document.querySelector('label[for="' + el.id + '"]');
        if (lb && lb.innerText) bouts.push(lb.innerText);
      } catch(e){}
    }
    // Le label qui l'englobe
    var par = el.closest && el.closest('label');
    if (par && par.innerText) bouts.push(par.innerText);

    var vus = [];
    return bouts.map(function(b){ return String(b).replace(/\s+/g,' ').trim(); })
                .filter(function(b){ if (!b || vus.indexOf(b) !== -1) return false; vus.push(b); return true; })
                .join(' · ')
                .slice(0, 200);
  }

  function cliquables(){
    var sel = 'a[href], button, [role=button], [role=link], [role=menuitem], [role=tab],'
            + ' input[type=submit], input[type=button], input[type=radio], input[type=checkbox],'
            + ' input[type=text], input[type=email], input[type=tel], input[type=password],'
            + ' input[type=number], input[type=date], input[type=search],'
            + ' select, textarea, summary, label[for], [onclick], [tabindex]:not([tabindex="-1"])';
    var vus = [];
    var out = [];
    Array.prototype.slice.call(document.querySelectorAll(sel)).forEach(function(el){
      if (vus.indexOf(el) !== -1) return;
      vus.push(el);
      if (!estVisible(el)) return;
      if (!libelleDe(el)) return;
      out.push(el);
    });
    return out;
  }

  // Recherche par mots : « déclarer mes revenus » doit trouver « Déclarer ».
  // L'ancienne version n'acceptait qu'une inclusion exacte dans un sens ou
  // dans l'autre — elle echouait des que la phrase dictee etait plus riche
  // que le libelle, ce qui est le cas normal a l'oral.
  var MOTS_VIDES = ['le','la','les','un','une','des','de','du','sur','au','aux',
                    'mon','ma','mes','ton','ta','tes','ce','cet','cette','et',
                    'bouton','lien','case','champ','onglet','clique','cliquer',
                    'montre','montrer','appuie','appuyer','va','aller'];

  function motsUtiles(t){
    return norm(t).split(' ').filter(function(m){
      return m.length > 2 && MOTS_VIDES.indexOf(m) === -1;
    });
  }

  function trouver(label){
    var lab = norm(label);
    if (!lab) return null;
    var motsDits = motsUtiles(label);
    var best = -1, cible = null;

    cliquables().forEach(function(el){
      var brut = libelleDe(el);
      var t = norm(brut);
      if (!t) return;

      var score = -1;
      if (t === lab)                       score = 100;   // identique
      else if (t.indexOf(lab) !== -1)      score = 85;    // le libelle contient la phrase
      else if (lab.indexOf(t) !== -1 && t.length > 2) score = 75;  // la phrase contient le libelle
      else if (motsDits.length) {
        // combien des mots dits se retrouvent dans le libelle ?
        var motsEl = motsUtiles(brut);
        var communs = 0;
        motsDits.forEach(function(m){
          for (var i = 0; i < motsEl.length; i++){
            if (motsEl[i] === m || motsEl[i].indexOf(m) === 0 || m.indexOf(motsEl[i]) === 0){ communs++; break; }
          }
        });
        if (communs) score = Math.round(40 + 30 * (communs / motsDits.length));
      }
      if (score < 0) return;

      // A egalite, on prefere ce qui est deja a l'ecran
      var r = el.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight) score += 3;

      if (score > best){ best = score; cible = el; }
    });

    return best >= 55 ? cible : null;
  }

  function pointer(el, cliquer){
    try { el.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){}
    el.style.outline = '4px solid #FF6A00';
    el.style.outlineOffset = '3px';
    el.style.transition = 'outline-color .3s';
    var n = 0, iv = setInterval(function(){ el.style.outlineColor = (n++ % 2) ? '#FF6A00' : '#FFD08A'; if (n > 6){ clearInterval(iv); } }, 300);
    setTimeout(function(){ el.style.outline = ''; }, 2600);
    if (cliquer){ setTimeout(function(){ try { el.click(); } catch(e){} }, 900); }
  }

  var __resolvePending = {};
  function labelsCliquables(){
    // libelleDe() cumule texte, aria-label, title, name, placeholder et
    // <label for>. innerText seul ratait tous les boutons-icones et les
    // champs de formulaire : l'IA ne voyait qu'une partie de la page.
    return cliquables().map(function(el){ return libelleDe(el).slice(0, 50); })
      .filter(Boolean).slice(0, 60);
  }

  function imagesCliquables(){
    var out = [];
    var imgs = document.querySelectorAll('img[src]');
    for (var i = 0; i < imgs.length && out.length < 6; i++){
      var img = imgs[i];
      var r = img.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;           // ignore pixels/icônes minuscules
      var src = img.currentSrc || img.src || '';
      if (!src || src.indexOf('data:') === 0) continue;       // pas les data-URI (souvent illisibles)
      var clic = img.closest('a, button, [role="button"], [onclick]');
      var cs = window.getComputedStyle(img);
      if (!clic && cs.cursor !== 'pointer') continue;         // seulement si cliquable
      var cible = clic || img;
      var id = 'ocrimg-' + Date.now().toString(36) + '-' + out.length;
      cible.setAttribute('data-nav-id', id);
      out.push({ id: id, src: src });
    }
    return out;
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app') return;

    if (d.type === 'voice-point'){
      var el = trouver(d.label);
      if (el){
        pointer(el, !!d.click, d.label);
        versParent({ type:'voice-found', voiceId:d.voiceId });
      } else {
        // ÉTAPE 2 — findByText a échoué : on demande à l'IA de l'app de
        // relier ce que la personne a dit au vrai libellé d'un bouton.
        // (ex: "valider ma commande" -> "Finaliser l'achat")
        __resolvePending[d.voiceId] = { click: !!d.click, label: d.label };
        versParent({
          type: 'voice-resolve-request',
          voiceId: d.voiceId,
          label: d.label,
          elements: labelsCliquables()
        });
      }
    }
    else if (d.type === 'voice-resolve-response'){
      var pend = __resolvePending[d.voiceId];
      var cible = d.cible ? trouver(d.cible) : null;
      if (cible){
        delete __resolvePending[d.voiceId];
        pointer(cible, pend ? pend.click : false, d.cible);
        versParent({ type:'voice-found', voiceId:d.voiceId, resolvedBy:'ia' });
      } else {
        // ÉTAPE 3 — OCR : le libellé est peut-être écrit DANS une image
        // (bouton-image sans texte HTML). On envoie à l'app les images
        // cliquables ; elle les lit avec puter.ai.img2txt et nous dit
        // laquelle correspond.
        var imgs = imagesCliquables();
        if (imgs.length){
          versParent({
            type: 'voice-ocr-request',
            voiceId: d.voiceId,
            label: pend ? pend.label : d.cible,
            images: imgs
          });
        } else {
          delete __resolvePending[d.voiceId];
          versParent({ type:'voice-miss', voiceId:d.voiceId });
        }
      }
    }
    else if (d.type === 'voice-ocr-response'){
      var pend2 = __resolvePending[d.voiceId];
      delete __resolvePending[d.voiceId];
      var el2 = d.id ? document.querySelector('[data-nav-id="' + d.id + '"]') : null;
      if (el2){
        pointer(el2, pend2 ? pend2.click : false, pend2 ? pend2.label : '');
        versParent({ type:'voice-found', voiceId:d.voiceId, resolvedBy:'ocr' });
      } else {
        versParent({ type:'voice-miss', voiceId:d.voiceId });
      }
    }
    else if (d.type === 'nav-back'){ try { history.back(); } catch(e){} }
    else if (d.type === 'tts-speak-page'){
      var main = document.querySelector('main, article, [role=main], #content, .content') || document.body;
      var txt = (main.innerText || '').replace(/\s+/g,' ').trim().slice(0, 9000);
      try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: txt }, '*'); } catch(e){}
    }
    else if (d.type === 'explique-mot'){
      versParent({ type:'explique-request', word: d.mot, context: '' });
    }
    else if (d.type === 'voice-list-elements'){
      var labels = cliquables().map(function(el){ return (el.innerText || el.value || '').trim().slice(0, 50); })
        .filter(Boolean).slice(0, 60);
      versParent({ type:'voice-elements', elements: labels });
    }
  });

  // signale que la page est prête (pour enchaîner "va sur X puis...")
  function pret(){ versParent({ type:'page-ready', url: (function(){ try { return new URLSearchParams(location.search).get('url') || location.href; } catch(e){ return location.href; } })() }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pret);
  else pret();
})();`;
}

// ════════════════════════════════════════════════════════════════════════
//  CO-NAVIGATION
// ════════════════════════════════════════════════════════════════════════
function genCode() {
  let c = '';
  for (let i = 0; i < CONAV_CODE_LENGTH; i++) c += Math.floor(Math.random() * 10);
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
async function saveSession(env, s) {
  s.lastActivity = Date.now();
  await env.CONAV_SESSIONS.put('s:' + s.code, JSON.stringify(s), { expirationTtl: CONAV_TTL_SECONDS });
}
async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Fallback sur le secret par défaut : la PWA actuelle l'utilise en dur
async function verifyClientToken(request, env) {
  const auth = request.headers.get('X-Astrid-Auth');
  if (!auth) return { ok: false, reason: 'Token manquant' };
  const parts = auth.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'Format invalide' };
  const ts = parseInt(parts[0], 10);
  if (isNaN(ts)) return { ok: false, reason: 'Timestamp invalide' };
  const now = Date.now();
  if (now - ts > 5 * 60 * 1000) return { ok: false, reason: 'Token expiré' };
  if (ts - now > 60 * 1000) return { ok: false, reason: 'Token futur' };
  const secret = env.ASTRID_SHARED_SECRET || DEFAULT_SHARED_SECRET;
  const expected = await hmacSha256(secret, parts[0]);
  if (parts[1] !== expected) return { ok: false, reason: 'Signature invalide' };
  return { ok: true };
}

async function conavCreate(env, request) {
  const auth = await verifyClientToken(request, env);
  if (!auth.ok) return json({ ok: false, error: 'Auth requise : ' + auth.reason }, 401);
  let code = null;
  for (let i = 0; i < 5; i++) {
    const c = genCode();
    if (!(await env.CONAV_SESSIONS.get('s:' + c))) { code = c; break; }
  }
  if (!code) return json({ ok: false, error: 'Impossible de générer un code' }, 503);
  const session = { code, hostToken: genToken(), guestToken: null, currentUrl: '',
    events: [], hostName: 'Hôte', guestName: null, createdAt: Date.now(), lastActivity: Date.now() };
  await saveSession(env, session);
  return json({ ok: true, code, hostToken: session.hostToken,
    formatted: code.substring(0, 3) + '-' + code.substring(3) });
}

async function conavJoin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  if (code.length !== CONAV_CODE_LENGTH) return json({ ok: false, error: 'Code invalide' }, 400);
  const s = await loadSession(env, code);
  if (!s) return json({ ok: false, error: 'Session introuvable ou expirée' }, 404);
  if (s.guestToken) return json({ ok: false, error: 'Session déjà rejointe' }, 409);
  s.guestToken = genToken();
  s.guestName = body.name ? String(body.name).substring(0, 30) : 'Invité';
  s.events.push({ id: 'e_' + Date.now().toString(36), type: 'guest-joined',
    from: 'system', name: s.guestName, ts: Date.now() });
  await saveSession(env, s);
  return json({ ok: true, guestToken: s.guestToken, currentUrl: s.currentUrl, hostName: s.hostName });
}

async function conavPoll(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').replace(/[^0-9]/g, '');
  const token = url.searchParams.get('token') || '';
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const s = await loadSession(env, code);
  if (!s) return json({ ok: false, error: 'Session expirée' }, 404);
  const role = (token === s.hostToken) ? 'host' : (token === s.guestToken) ? 'guest' : null;
  if (!role) return json({ ok: false, error: 'Token invalide' }, 403);
  return json({ ok: true,
    events: (s.events || []).filter(e => e.ts > since && e.from !== role),
    serverTs: Date.now(), currentUrl: s.currentUrl,
    peerName: role === 'host' ? s.guestName : s.hostName,
    peerConnected: role === 'host' ? !!s.guestToken : true });
}

async function conavSend(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  const token = String(body.token || ''), type = String(body.type || '');
  if (!code || !token || !type) return json({ ok: false, error: 'code/token/type requis' }, 400);
  const s = await loadSession(env, code);
  if (!s) return json({ ok: false, error: 'Session expirée' }, 404);
  const role = (token === s.hostToken) ? 'host' : (token === s.guestToken) ? 'guest' : null;
  if (!role) return json({ ok: false, error: 'Token invalide' }, 403);
  const valid = ['message','url-change','highlight','click-request','click-result','set-name','ping','foreman'];
  if (!valid.includes(type)) return json({ ok: false, error: 'Type invalide' }, 400);

  if (type === 'click-request' || type === 'highlight') {
    const now = Date.now(), k = '_last_' + type + '_' + role;
    const min = type === 'click-request' ? 3000 : 1000;
    if (now - (s[k] || 0) < min) {
      return json({ ok: false, error: 'Trop rapide, attends ' + Math.ceil((min - (now - (s[k] || 0))) / 1000) + 's' }, 429);
    }
    s[k] = now;
  }
  if (type === 'set-name') {
    const n = String(body.name || '').substring(0, 30);
    if (role === 'host') s.hostName = n || 'Hôte'; else s.guestName = n || 'Invité';
  }
  if (type === 'url-change' && body.url && role === 'host') {
    s.currentUrl = String(body.url).substring(0, 500);
  }
  const evt = { id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    type, from: role, ts: Date.now() };
  ['text','url','selector','label','safeBottom','largeMode','name','ok','payload'].forEach(k => {
    if (body[k] !== undefined) evt[k] = body[k];
  });
  s.events = (s.events || []).concat([evt]);
  if (s.events.length > CONAV_MAX_EVENTS) s.events = s.events.slice(-CONAV_MAX_EVENTS);
  await saveSession(env, s);
  return json({ ok: true, eventId: evt.id });
}

async function conavLeave(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  const token = String(body.token || '');
  const s = await loadSession(env, code);
  if (!s) return json({ ok: true });
  const role = (token === s.hostToken) ? 'host' : (token === s.guestToken) ? 'guest' : null;
  if (!role) return json({ ok: false, error: 'Token invalide' }, 403);
  s.events = (s.events || []).concat([{ id: 'e_' + Date.now().toString(36),
    type: 'peer-left', from: role, ts: Date.now() }]);
  if (role === 'host') await env.CONAV_SESSIONS.delete('s:' + code);
  else { s.guestToken = null; s.guestName = null; await saveSession(env, s); }
  return json({ ok: true });
}

// ════════════════════════════════════════════════════════════════════════
//  HEARTBEAT
// ════════════════════════════════════════════════════════════════════════
async function heartbeatReceive(request, env) {
  if (!env.CONAV_SESSIONS) return json({ ok: false, error: 'KV indispo' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON invalide' }, 400); }

  let events = [];
  if (Array.isArray(body.batch)) events = body.batch.slice(0, 50);
  else if (body.event) events = [body];
  else return json({ ok: false, error: 'Format invalide' }, 400);

  const buckets = new Map();
  for (const evt of events) {
    if (!evt) continue;
    const event = String(evt.event || '').substring(0, 32).replace(/[^a-z0-9_-]/gi, '');
    if (!event) continue;
    const success = (evt.success === true || evt.success === false) ? evt.success : null;
    const domain = String(evt.domain || '').substring(0, 80).replace(/[^a-z0-9.\-]/gi, '');
    const dur = (typeof evt.duration === 'number' && evt.duration >= 0 && evt.duration < 600000)
      ? Math.round(evt.duration) : null;
    const day = new Date(evt.ts || Date.now()).toISOString().substring(0, 10);
    const outcome = success === null ? 'na' : (success ? 'ok' : 'fail');
    const key = 'hb:' + day + ':' + event + ':' + outcome;
    if (!buckets.has(key)) buckets.set(key, { count: 0, domains: {}, durationSum: 0, durationCount: 0 });
    const b = buckets.get(key);
    b.count++;
    if (domain) b.domains[domain] = (b.domains[domain] || 0) + 1;
    if (dur !== null) { b.durationSum += dur; b.durationCount++; }
  }
  for (const [key, agg] of buckets) {
    try {
      const cur = await env.CONAV_SESSIONS.get(key);
      const a = cur ? JSON.parse(cur) : { count: 0, domains: {}, durationSum: 0, durationCount: 0 };
      a.count += agg.count;
      for (const [d, c] of Object.entries(agg.domains)) a.domains[d] = (a.domains[d] || 0) + c;
      a.durationSum += agg.durationSum; a.durationCount += agg.durationCount;
      const dk = Object.keys(a.domains);
      if (dk.length > 100) {
        const top = dk.sort((x, y) => a.domains[y] - a.domains[x]).slice(0, 50);
        const t = {}; top.forEach(k => t[k] = a.domains[k]); a.domains = t;
      }
      await env.CONAV_SESSIONS.put(key, JSON.stringify(a), { expirationTtl: 7 * 86400 });
    } catch (e) {}
  }
  return json({ ok: true, processed: events.length, buckets: buckets.size });
}

async function heartbeatStats(env) {
  if (!env.CONAV_SESSIONS) return json({ ok: false, error: 'KV indispo' }, 503);
  try {
    const cached = await env.CONAV_SESSIONS.get('hb:stats:daily:latest');
    if (cached) {
      const d = JSON.parse(cached);
      return json({ ok: true, stats: d.stats, generated: d.generated, cached: true });
    }
    const r = await rebuildHeartbeatAggregate(env);
    return json({ ok: true, stats: r.stats, generated: r.generated, cached: false });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function rebuildHeartbeatAggregate(env) {
  const list = await env.CONAV_SESSIONS.list({ prefix: 'hb:', limit: 1000 });
  const stats = {};
  for (const k of list.keys) {
    if (k.name.startsWith('hb:stats:')) continue;
    const v = await env.CONAV_SESSIONS.get(k.name);
    if (!v) continue;
    const p = k.name.split(':');
    if (p.length !== 4) continue;
    const [, day, event, outcome] = p;
    stats[day] = stats[day] || {};
    stats[day][event] = stats[day][event] || { ok: 0, fail: 0, na: 0, durationAvgMs: null, topDomains: {} };
    try {
      const a = JSON.parse(v);
      stats[day][event][outcome] = a.count;
      if (a.durationCount > 0) stats[day][event].durationAvgMs = Math.round(a.durationSum / a.durationCount);
      for (const [d, c] of Object.entries(a.domains || {})) {
        stats[day][event].topDomains[d] = (stats[day][event].topDomains[d] || 0) + c;
      }
    } catch (e) {}
  }
  const result = { stats, generated: new Date().toISOString() };
  await env.CONAV_SESSIONS.put('hb:stats:daily:latest', JSON.stringify(result), { expirationTtl: 86400 * 8 });
  return result;
}

// ════════════════════════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════════════════════════
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
