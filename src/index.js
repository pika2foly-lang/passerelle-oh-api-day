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
  return `<
