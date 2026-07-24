# Passerelle Oh API Day

**Le serveur (Worker Cloudflare) qui fait fonctionner Oh API Day dans son intégralité — IA, Galaxy, activation d'extension, proxy web, co-navigation.**

Une seule installation, tout est débloqué.

---

## 🎯 À quoi sert ce serveur ?

Oh API Day est une application qui rend le web accessible et intelligent grâce à l'IA. Elle a besoin d'un petit serveur pour :

- **Faire tourner les IA** — cascade de providers gratuits (Cloudflare AI, Groq, Cerebras, Mistral, Gemini) sans dépendre d'un compte
- **Stocker la Galaxy** — la mémoire vectorielle personnelle où vivent les souvenirs, les leçons, les parcours
- **Activer l'extension** — créer un QR + PIN pour connecter une extension à ton profil
- **Proxifier les sites web** — pour qu'Astrid puisse pointer directement dedans (Navig)
- **Faire la co-navigation** — un proche peut t'aider à distance
- **Recevoir les statistiques anonymes** — santé de l'app, sans données personnelles

**Tu déploies ta propre Passerelle, gratuit, en 5 minutes.**

---

## 🚀 Déploiement en 1 clic (recommandé)

1. Clique sur **Deploy to Cloudflare** ci-dessous *(le bouton sera fourni une fois le dépôt en ligne)*
2. Connecte-toi à Cloudflare (ou crée un compte, gratuit, 1 minute)
3. Connecte-toi à GitLab/GitHub (ou crée un compte)
4. Cloudflare provisionne tout automatiquement :
   - Crée un nouveau repo `passerelle-oh-api-day` dans ton compte
   - Crée 2 KV namespaces (`GALAXY` + `CONAV_SESSIONS`)
   - Branche Workers AI
   - Déploie le Worker et te donne son URL
5. Récupère l'URL `https://passerelle-oh-api-day.TONUSER.workers.dev`
6. Colle-la dans l'app Oh API Day → ⚙️ Réglages → 🏗️ Ma Passerelle

**Total : 5 minutes.**

---

## 🔑 Secrets à définir après le déploiement

Cloudflare Dashboard → ton Worker → **Settings** → **Variables and Secrets**

### Obligatoires

| Nom | Rôle |
|---|---|
| `AI_TOKEN` | Auth pour les routes `/galaxy/*` et `/ai`. Une longue chaîne aléatoire. |
| `APP_SECRET` | Auth de l'app pour créer des accès extension. Une longue chaîne aléatoire, différente de `AI_TOKEN`. |
| `ASTRID_SHARED_SECRET` | HMAC pour la co-navigation. Une longue chaîne aléatoire, unique à toi. |

### Au moins une clé IA

Ta cascade LLM fonctionne dès qu'au moins une clé est présente. Ordre recommandé :

| Nom | Où obtenir |
|---|---|
| `GROQ_KEY` | [console.groq.com](https://console.groq.com) — gratuit et rapide |
| `GEMINI_KEY` | [aistudio.google.com](https://aistudio.google.com) — gratuit |
| `CEREBRAS_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai) — gratuit |
| `MISTRAL_KEY` | [console.mistral.ai](https://console.mistral.ai) — freemium |
| `OPENROUTER_KEY` | [openrouter.ai](https://openrouter.ai) — freemium |

Workers AI (Llama 70B + embeddings BGE-M3) est disponible **automatiquement** grâce au binding `AI` du `wrangler.toml`. Il sert de premier étage de la cascade.

### ⚠️ Variable ALLOWED_ORIGIN — À CONFIGURER SI TON APP N'EST PAS SUR L'URL PAR DÉFAUT

**Par défaut**, le Worker n'accepte les requêtes `/proxy-web` que depuis `https://ohapi-day-f37288.gitlab.io`. **Si tu héberges l'app ailleurs (ton propre domaine, une autre instance, en local), tu DOIS changer cette variable, sinon le premier appel à Navig échouera en 403 sans message clair.**

Cloudflare Dashboard → ton Worker → **Settings** → **Variables and Secrets** → Add variable (type **Plain text**, pas Secret) :

| Nom | Valeur | Quand |
|---|---|---|
| `ALLOWED_ORIGIN` | `https://ton-app.exemple.com` | Tu héberges l'app sur ton propre domaine |
| `ALLOWED_ORIGIN` | `*` | Tu veux ouvrir à toutes les origines (moins sûr, mais plus simple) |
| _(non défini)_ | _(par défaut)_ | Tu utilises l'app publique sur `ohapi-day-f37288.gitlab.io` |

**Symptôme si mal configuré** : les appels `/proxy-web` renvoient `{"error":"origin_forbidden"}` avec le status 403. Vérifie cette variable en premier.

---

## 📋 Routes disponibles

| Route | Méthode | Rôle |
|---|---|---|
| `/health` | GET | Statut du Worker |
| `/ai` | POST | Cascade LLM (auth `AI_TOKEN`) |
| `/galaxy/embed` | POST | Vecteur bge-m3 |
| `/galaxy/search` | POST | Top-k étoiles par similarité |
| `/galaxy/save` | POST | Sauvegarde étoile + vecteur |
| `/galaxy/pull` | GET | Récupère toutes les étoiles |
| `/galaxy/star/:id` | DELETE | Supprime une étoile |
| `/ext/mint` | POST | Crée un accès QR+PIN (auth `APP_SECRET`) |
| `/ext/activate` | POST | Échange code+PIN contre jeton |
| `/ext/events` | GET | Journal d'activations |
| `/proxy-web?url=` | GET | Proxifie une page pour Navig |
| `/proxy-asset?url=` | GET | Proxifie un asset (cache 24h) |
| `/conav/create` | POST | Crée une session de co-nav |
| `/conav/join` | POST | Rejoint une session |
| `/conav/poll` | GET | Récupère les événements |
| `/conav/send` | POST | Envoie un événement |
| `/conav/leave` | POST | Quitte la session |
| `/heartbeat` | POST | Ping anonyme |
| `/heartbeat/stats` | GET | Stats agrégées (une clé unique, low-read) |

---

## 🛡️ Sécurité

- **Anti-SSRF** : le proxy bloque les IPs privées, loopback, link-local, ULA, multicast, CGN, IPs raw (décimales/hex), IPv4-mapped-IPv6, hostnames locaux
- **HTTPS-only** : le proxy refuse HTTP, force upgrade côté serveur
- **CSP stricte** injectée dans les pages proxifiées
- **HMAC + anti-replay** sur la co-navigation (fenêtre 5 min)
- **PBKDF2 210k iter** sur les PIN d'activation extension
- **Timing-safe compare** sur toutes les authentifications
- **Origin check** sur `/proxy-web` — seul ton domaine autorisé par défaut
- **ownerId dérivé du secret** (`sha256(APP_SECRET)`) — pas de bootstrap négociable, pas de vol de compte possible

---

## 💰 Coût

**Gratuit** dans les limites du free tier Cloudflare :

- 100 000 requêtes Workers / jour
- 1 000 lectures + 1 000 écritures KV / jour (largement suffisant)
- 10 000 neurons Workers AI / jour
- Cache API illimité
- Cron Triggers illimités

Tu es le seul utilisateur de ta Passerelle. Ces limites tiennent des mois de navigation intensive.

---

## 🔧 Développement local

```bash
npm install
npm run dev     # démarre wrangler dev en local
npm run deploy  # déploie en prod
```

---

## 📝 Licence

MIT.

---

## 🌉 Deux Passerelles, deux rôles

Ce dépôt est **ta Passerelle personnelle**. Il vit chez toi et travaille pour toi seul.

Il existe aussi une passerelle publique partagée, [`passerelle-astrid`](https://github.com/TON_USER/passerelle-astrid), qui sert de **teaser** aux gens qui n'ont pas encore installé leur propre passerelle. Elle est limitée à 50 pages/jour/IP. Une fois que tu as ta Passerelle Oh API Day, ton app te route automatiquement dessus et tu n'as plus de plafond.

**Un jour tu pourras aussi installer ta propre `passerelle-astrid` personnelle** pour Astrid Navig standalone, mais si tu utilises l'app Oh API Day complète, cette Passerelle-ci suffit à tout.
