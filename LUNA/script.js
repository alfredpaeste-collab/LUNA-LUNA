// ══════════════════════════════════════════════════════════════════
// ◈ VISUAL VIEWPORT API — Mobile/Desktop smoothing
//   Runs immediately (before DOMContentLoaded) to correct the stale
//   --real-vh value that may have been baked into the HTML at
//   render time. Also provides precise keyboard-height tracking and
//   orientation-change recovery for iOS Safari + Android Chrome.
// ══════════════════════════════════════════════════════════════════
;(function installViewportManager() {
  const root = document.documentElement;

  // ── 1. Immediately correct stale --real-vh from HTML inline style ──
  // The HTML is often served with --real-vh set at server time (e.g. 632px).
  // We override it synchronously before the first paint.
  const trueH = window.visualViewport
    ? window.visualViewport.height
    : window.innerHeight;
  root.style.setProperty('--real-vh', trueH + 'px');
  root.style.setProperty('--keyboard-height', '0px');
  root.style.setProperty('--vv-offset-top', '0px');

  // ── 2. Compute and publish all viewport CSS variables ──────────────
  function updateViewportVars() {
    const vv = window.visualViewport;
    if (vv) {
      const vh          = vv.height;
      const offsetTop   = vv.offsetTop   || 0;
      const offsetLeft  = vv.offsetLeft  || 0;
      const screenH     = window.screen.height;
      // keyboard height = difference between screen height and visual viewport
      // bottom (accounting for bars). Clamped to 0 to avoid negatives.
      const kbH = Math.max(0, screenH - vv.height - offsetTop);

      root.style.setProperty('--real-vh',         vh        + 'px');
      root.style.setProperty('--keyboard-height', kbH       + 'px');
      root.style.setProperty('--vv-offset-top',   offsetTop + 'px');
      root.style.setProperty('--vv-offset-left',  offsetLeft + 'px');

      // Expose a data attribute so CSS can branch on keyboard state
      const kbOpen = kbH > 80;
      root.dataset.keyboardOpen = kbOpen ? 'true' : 'false';

      // Pin input zone to the real bottom of the visual viewport on iOS.
      // This prevents the "content stuck behind keyboard" bug in Safari.
      const inputZone = document.querySelector('.input-zone');
      if (inputZone && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        // Translate the input zone up by the keyboard height so it sits
        // directly above the keyboard when it's open.
        if (kbOpen) {
          inputZone.style.transform = `translateY(-${kbH}px)`;
          inputZone.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
        } else {
          inputZone.style.transform = '';
        }
      }

      // Scroll chat feed to bottom when keyboard opens so last message stays visible.
      // Respect userScrolledUp so we don't yank the user back if they're reading history.
      if (kbOpen) {
        const feed = document.getElementById('chatFeed');
        if (feed && !window.userScrolledUp) {
          requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
        }
      }
    } else {
      // Fallback: no Visual Viewport API (old desktop browsers)
      root.style.setProperty('--real-vh', window.innerHeight + 'px');
    }
  }

  // ── 3. Listen to Visual Viewport events ────────────────────────────
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportVars, { passive: true });
    window.visualViewport.addEventListener('scroll', updateViewportVars, { passive: true });
  }

  // ── 4. Orientation change: re-measure after the browser repaints ───
  // Browsers fire orientationchange BEFORE they update innerHeight/vv.height.
  // We wait 350ms for the repaint cycle to complete, then re-measure twice
  // (some browsers need a second pass after the toolbar animation finishes).
  window.addEventListener('orientationchange', () => {
    setTimeout(updateViewportVars, 100);
    setTimeout(updateViewportVars, 350);
    setTimeout(updateViewportVars, 700);
  }, { passive: true });

  // Also listen to the standard resize event for desktop and non-VV browsers
  window.addEventListener('resize', updateViewportVars, { passive: true });

  // ── 5. Expose the updater so the existing setRealVH() can call it ──
  window._vvUpdate = updateViewportVars;
})();

// ── FIREBASE CONFIG ───────────────────────────────────────────────
// 🔥 Paste your Firebase Realtime Database URL below:
const FIREBASE_DB_URL = 'https://luna-stats-d18b3-default-rtdb.firebaseio.com/';

// ── PROXY CONFIG ─────────────────────────────────────────────────
// Set PROXY_URL to your deployed Cloudflare Worker URL.
// e.g. 'https://luna-proxy.YOUR-NAME.workers.dev'
// Leave as empty string to fall back to direct API calls (keys required below).
const PROXY_URL = 'https://luna-luna.netlify.app/api';   // ← paste your Worker URL here

// ── API CONFIG ───────────────────────────────────────────────────
// If PROXY_URL is set, these keys are never sent to the browser.
// They are only used as a fallback when PROXY_URL is empty.
const API_KEY          = '';   // ← only needed if NOT using the proxy
const API_URL          = PROXY_URL ? `${PROXY_URL}/groq` : 'https://api.groq.com/openai/v1/chat/completions';
const API_MODEL        = 'llama-3.3-70b-versatile';
const API_MODEL_VISION = 'meta-llama/llama-4-scout-17b-16e-instruct';
const API_MODEL_FALLBACK = 'llama-3.1-8b-instant';

// ── Global API Key Pool ───────────────────────────────────────────
// Add more Groq keys here to spread the rate-limit quota across keys.
// Luna will round-robin through them and skip any key that is cooling down.
// Each free Groq key gets ~14,400 req/day and 500K-1M tokens/day independently.
// Get free keys at: https://console.groq.com/keys
// When using the proxy, key rotation happens server-side in the Worker.
// When NOT using the proxy, add your Groq keys directly here.
const API_KEY_POOL = PROXY_URL
  ? ['proxy']
  : [].filter(k => k && k.startsWith('gsk_'));

// Per-key cooldown tracking — a key is paused for `cooldownMs` after a 429
const KEY_COOLDOWN_MS = 15_000; // 15 seconds cooldown per key after 429 (faster recovery)
const _keyCooldowns   = {};     // { keyIndex: timestampUntilReady }
let   _poolIndex      = 0;      // current round-robin position

// Return the next available key from the pool (skips cooling-down keys).
// Falls back to the least-recently-used key if all are cooling down.
function getPoolKey() {
  const now = Date.now();
  const total = API_KEY_POOL.length;

  // Try round-robin starting from current position
  for (let i = 0; i < total; i++) {
    const idx = (_poolIndex + i) % total;
    const coolUntil = _keyCooldowns[idx] || 0;
    if (now >= coolUntil) {
      _poolIndex = (idx + 1) % total; // advance pointer past this key
      return { key: API_KEY_POOL[idx], idx };
    }
  }

  // All keys cooling — pick the one that recovers soonest
  let bestIdx = 0, bestTime = Infinity;
  for (let i = 0; i < total; i++) {
    if ((_keyCooldowns[i] || 0) < bestTime) { bestTime = _keyCooldowns[i]; bestIdx = i; }
  }
  return { key: API_KEY_POOL[bestIdx], idx: bestIdx };
}

// Call this when a key hits a 429 to put it in cooldown
function markKeyCooling(idx, waitSecs) {
  _keyCooldowns[idx] = Date.now() + Math.max(waitSecs * 1000, KEY_COOLDOWN_MS);
}

// ══════════════════════════════════════════════════════════════════
// ◈ MULTI-PROVIDER AI ROUTING — Groq → Gemini → OpenRouter
//   Luna automatically tries providers in order of speed/quality.
//   If Groq is rate-limited or down, she seamlessly falls over to
//   Google Gemini Flash (free tier) then OpenRouter free models.
//   Add your free API keys below to unlock each provider.
// ══════════════════════════════════════════════════════════════════

// ── Google Gemini (free tier: 15 RPM, 1M TPM) ────────────────────
// Get a free key at: https://aistudio.google.com/app/apikey
// Your key should start with "AIza..." — replace the value below
// If PROXY_URL is set, Gemini requests go through the Worker (no key needed here).
// Otherwise paste your AIzaSy... key below.
const GEMINI_API_KEY   = '';   // ← only needed if NOT using the proxy
const GEMINI_API_URL   = PROXY_URL
  ? `${PROXY_URL}/gemini`
  : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent';
const GEMINI_MODEL     = 'gemini-2.0-flash';

// ── OpenRouter (free models available) ───────────────────────────
// Get a free key at: https://openrouter.ai/keys
// Your key should start with "sk-or-v1-..." — replace the value below
// If PROXY_URL is set, OpenRouter requests go through the Worker (no key needed here).
// Otherwise paste your sk-or-v1-... key below.
const OPENROUTER_API_KEY   = '';   // ← paste your sk-or-v1-... key here (get free at openrouter.ai/keys)
const OPENROUTER_API_URL   = PROXY_URL
  ? `${PROXY_URL}/openrouter`
  : 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL     = 'meta-llama/llama-3.3-70b-instruct:free'; // upgraded free model
const OPENROUTER_MODEL_ALT = 'mistralai/mistral-7b-instruct:free';

// ── Provider health tracking ──────────────────────────────────────
const _providerCooldowns = { groq: 0, gemini: 0, openrouter: 0 };
const PROVIDER_COOLDOWN_MS = 15_000; // 15s cooldown after a provider fails (faster recovery)

function isProviderAvailable(provider) {
  return Date.now() >= (_providerCooldowns[provider] || 0);
}
function cooldownProvider(provider, ms = PROVIDER_COOLDOWN_MS) {
  _providerCooldowns[provider] = Date.now() + ms;
  console.warn(`[Luna] Provider "${provider}" cooling down for ${ms/1000}s`);
}

// Get the ordered list of available providers for this request.
// If user has a personal Groq key, Groq is always first and only.
function getAvailableProviders() {
  if (currentUserApiKey) return ['groq']; // personal key — always use Groq
  const order = ['groq'];
  // When using the proxy, all providers are always available (keys are server-side).
  // Without the proxy, check that the keys are valid before adding the provider.
  const geminiOk  = PROXY_URL || (GEMINI_API_KEY && GEMINI_API_KEY.startsWith('AIza'));
  const orOk      = PROXY_URL || (OPENROUTER_API_KEY && OPENROUTER_API_KEY.startsWith('sk-or-v1-'));
  if (geminiOk)  order.push('gemini');
  if (orOk)      order.push('openrouter');
  return order.filter(p => isProviderAvailable(p));
}

// ── Convert OpenAI-style messages array → Gemini format ──────────
function toGeminiMessages(messages) {
  const system = messages.find(m => m.role === 'system');
  const rest   = messages.filter(m => m.role !== 'system');
  const systemInstruction = system ? { parts: [{ text: system.content }] } : undefined;
  const contents = rest.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  return { systemInstruction, contents };
}

// ── Stream from Google Gemini ─────────────────────────────────────
async function* streamGemini(messages, temperature, signal) {
  const { systemInstruction, contents } = toGeminiMessages(messages);
  const body = {
    contents,
    generationConfig: {
      temperature: Math.min(temperature, 1.0), // Gemini max is 2.0 but 1.0 gives best results
      maxOutputTokens: 8192,
    },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  // In proxy mode, GEMINI_API_URL already points to the Worker — no key param needed.
  // In direct mode, append the key as a query param (Google's auth style).
  const activeGeminiKey = window._GEMINI_API_KEY_OVERRIDE || GEMINI_API_KEY;
  const url = PROXY_URL
    ? `${GEMINI_API_URL}?alt=sse`
    : `${GEMINI_API_URL}?key=${activeGeminiKey}&alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) { cooldownProvider('gemini', 60_000); }
    else                    { cooldownProvider('gemini'); }
    throw new Error(`Gemini: ${msg}`);
  }
  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === 'data: [DONE]') continue;
      if (t.startsWith('data: ')) {
        try {
          const chunk = JSON.parse(t.slice(6));
          const text  = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch {}
      }
    }
  }
}

// ── Stream from OpenRouter (OpenAI-compatible) ────────────────────
async function* streamOpenRouter(messages, temperature, signal) {
  const model = isProviderAvailable('openrouter') ? OPENROUTER_MODEL : OPENROUTER_MODEL_ALT;
  const res = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${window._OPENROUTER_API_KEY_OVERRIDE || OPENROUTER_API_KEY}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Luna AI',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      temperature,
      messages,
      stream: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) { cooldownProvider('openrouter', 60_000); }
    else                    { cooldownProvider('openrouter'); }
    throw new Error(`OpenRouter: ${msg}`);
  }
  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === 'data: [DONE]') continue;
      if (t.startsWith('data: ')) {
        try {
          const chunk = JSON.parse(t.slice(6));
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {}
      }
    }
  }
}

// ── Stream from Groq (existing logic, wrapped as async generator) ─
async function* streamGroq(messages, temperature, signal) {
  const key = getActiveApiKey();
  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: window.API_MODEL || API_MODEL,
      max_tokens: 8000,
      temperature,
      messages,
      stream: true,
    }),
  });
  if (res.status === 429) {
    const err = await res.json().catch(() => ({}));
    const waitSecs = parseRetryAfter(err?.error?.message || '');
    markActiveKeyCooling(waitSecs);
    // Try next Groq pool key before marking provider as cooling
    const available = API_KEY_POOL.filter((_, i) => Date.now() >= (_keyCooldowns[i] || 0));
    if (available.length === 0) cooldownProvider('groq', Math.max(waitSecs * 1000, 60_000));
    throw new Error(`Groq 429: ${err?.error?.message || 'rate limit'}`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    if (res.status >= 500) cooldownProvider('groq', 30_000);
    throw new Error(`Groq: ${msg}`);
  }
  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === 'data: [DONE]') continue;
      if (t.startsWith('data: ')) {
        try {
          const chunk = JSON.parse(t.slice(6));
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) yield delta;
          if (chunk?.usage) recordTokenUsage(chunk.usage);
        } catch {}
      }
    }
  }
}

// ── Universal multi-provider stream: tries providers in order ─────
// Yields text tokens from whichever provider responds first.
// If the active provider fails mid-stream, a clean error is thrown
// so the caller can restart with the next provider.
async function* streamWithFallback(messages, temperature, signal) {
  const providers = getAvailableProviders();
  if (!providers.length) {
    throw new Error('All AI providers are temporarily unavailable. Please wait a moment and try again. ✦');
  }
  let lastErr = null;
  for (const provider of providers) {
    try {
      let gen;
      if (provider === 'groq')        gen = streamGroq(messages, temperature, signal);
      else if (provider === 'gemini') gen = streamGemini(messages, temperature, signal);
      else                            gen = streamOpenRouter(messages, temperature, signal);
      let gotTokens = false;
      for await (const token of gen) {
        gotTokens = true;
        // If Groq was cooling but we used it, clear cooldown on success
        if (provider === 'groq') _providerCooldowns.groq = 0;
        yield token;
      }
      if (!gotTokens) throw new Error(`${provider}: empty response`);
      return; // success — done
    } catch (err) {
      if (signal?.aborted) throw err; // user stopped — propagate
      console.warn(`[Luna] Provider "${provider}" failed:`, err.message);
      lastErr = err;
      // small delay before trying next provider
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr || new Error('All providers failed. ✦');
}

// ── Show active provider indicator in UI (subtle, non-intrusive) ──
let _providerIndicatorEl = null;
function showProviderIndicator(provider) {
  if (!_providerIndicatorEl) {
    _providerIndicatorEl = document.createElement('div');
    _providerIndicatorEl.id = 'lunaProviderIndicator';
    _providerIndicatorEl.style.cssText = [
      'position:fixed;bottom:80px;right:14px;z-index:99;',
      'font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;',
      'padding:4px 9px;border-radius:20px;opacity:0;',
      'transition:opacity 0.3s ease;pointer-events:none;',
    ].join('');
    document.body.appendChild(_providerIndicatorEl);
  }
  const labels = { groq:'⚡ GROQ', gemini:'✦ GEMINI', openrouter:'◈ OPENROUTER' };
  const colors = { groq:'rgba(168,85,247,0.18)', gemini:'rgba(52,211,153,0.15)', openrouter:'rgba(251,191,36,0.14)' };
  const borders = { groq:'rgba(168,85,247,0.35)', gemini:'rgba(52,211,153,0.3)', openrouter:'rgba(251,191,36,0.28)' };
  const textColors = { groq:'var(--violet-bright)', gemini:'#34d399', openrouter:'var(--gold)' };
  _providerIndicatorEl.textContent = labels[provider] || provider.toUpperCase();
  _providerIndicatorEl.style.background   = colors[provider]   || 'rgba(255,255,255,0.08)';
  _providerIndicatorEl.style.border       = `1px solid ${borders[provider] || 'rgba(255,255,255,0.12)'}`;
  _providerIndicatorEl.style.color        = textColors[provider] || 'var(--text-mid)';
  _providerIndicatorEl.style.opacity      = '1';
  clearTimeout(_providerIndicatorEl._hideTimer);
  _providerIndicatorEl._hideTimer = setTimeout(() => {
    if (_providerIndicatorEl) _providerIndicatorEl.style.opacity = '0';
  }, 3000);
}

// ── Per-User Groq API Key ─────────────────────────────────────────
// Admin can assign a custom Groq key per user via Firebase.
// When set, that user's requests use their own key, completely
// independent of the global API_KEY pool — no shared quota impact.
let currentUserApiKey = null; // null = use global pool
let _currentPoolEntry = null; // { key, idx } — active pool key for this request

function getActiveApiKey() {
  if (currentUserApiKey) return currentUserApiKey;
  // Round-robin from pool; cache the selection so markKeyCooling can reference it
  _currentPoolEntry = getPoolKey();
  return _currentPoolEntry.key;
}

// Mark the most recently used pool key as cooling (called on 429)
function markActiveKeyCooling(waitSecs) {
  if (currentUserApiKey) return; // user has their own key — don't touch the pool
  if (_currentPoolEntry) markKeyCooling(_currentPoolEntry.idx, waitSecs);
}

async function loadUserApiKey(userAccountKey) {
  if (!firebaseReady || !firebaseDb || !userAccountKey) return;
  try {
    const snap = await firebaseDb.ref(`luna-accounts/${userAccountKey}/groqKey`).once('value');
    const key  = snap.val();
    currentUserApiKey = (key && key.trim().startsWith('gsk_')) ? key.trim() : null;
  } catch { currentUserApiKey = null; }
}

// Listen for real-time key updates (admin can change it while user is online)
function watchUserApiKey(userAccountKey) {
  if (!firebaseReady || !firebaseDb || !userAccountKey) return;
  firebaseDb.ref(`luna-accounts/${userAccountKey}/groqKey`).on('value', snap => {
    const key = snap.val();
    currentUserApiKey = (key && key.trim().startsWith('gsk_')) ? key.trim() : null;
  });
}

// ── Per-User Token Tracking ───────────────────────────────────────
// Each user has their own daily token bucket stored in Firebase.
// This prevents one heavy user from exhausting the shared daily limit.
// Falls back to localStorage if Firebase is unavailable.
const USER_TOKEN_DAILY_LIMIT = 200_000; // per-user cap (adjust as needed)
const USER_TOKEN_WARN_PCT    = 0.80;
const USER_TOKEN_CRIT_PCT    = 0.93;
const USER_TOKEN_STORAGE_KEY = (key) => `luna_utok_${key || currentUserId || 'guest'}_${new Date().toDateString()}`;
let   userTokensToday        = 0;       // this user's token count today

async function loadUserTokenCount(userAccountKey) {
  if (!userAccountKey) return;
  const today = new Date().toDateString();
  // Try Firebase first
  if (firebaseReady && firebaseDb) {
    try {
      const snap = await firebaseDb.ref(`luna-user-tokens/${userAccountKey}/${today}`).once('value');
      userTokensToday = parseInt(snap.val() || 0, 10);
      _resetRateLimitBannerOnLogin();
      return;
    } catch { /* fall through to localStorage */ }
  }
  // Fallback: localStorage — scoped per user so different users don't bleed into each other
  userTokensToday = parseInt(localStorage.getItem(USER_TOKEN_STORAGE_KEY(userAccountKey)) || '0', 10);
  _resetRateLimitBannerOnLogin();
}

// Called after loading a new user's token count on login.
// Hides any rate-limit banner left over from a previous user's session,
// unless this specific user has genuinely hit their limit.
function _resetRateLimitBannerOnLogin() {
  const banner = document.getElementById('rateLimitBanner');
  if (!banner) return;
  const pct = userTokensToday / USER_TOKEN_DAILY_LIMIT;
  if (pct < USER_TOKEN_WARN_PCT) {
    banner.style.display = 'none';
    banner.classList.remove('rl-critical', 'rl-ok');
    const input   = document.getElementById('userInput');
    const sendBtn = document.getElementById('sendBtn');
    if (input)   { input.disabled = false; }
    if (sendBtn) { sendBtn.disabled = false; }
  }
}

async function recordUserTokenUsage(added, userAccountKey) {
  if (!added) return;
  userTokensToday = Math.min(USER_TOKEN_DAILY_LIMIT, userTokensToday + added);
  const today = new Date().toDateString();
  // Persist to Firebase
  if (firebaseReady && firebaseDb && userAccountKey) {
    try {
      await firebaseDb.ref(`luna-user-tokens/${userAccountKey}/${today}`).set(userTokensToday);
    } catch { /* silently ignore */ }
  }
  // Always persist locally as fallback — scoped per user
  localStorage.setItem(USER_TOKEN_STORAGE_KEY(userAccountKey), String(userTokensToday));
  checkUserTokenThresholds();
}

function checkUserTokenThresholds() {
  const pct = userTokensToday / USER_TOKEN_DAILY_LIMIT;
  const banner = document.getElementById('rateLimitBanner');
  const textEl = document.getElementById('rlBannerText');
  const iconEl = document.getElementById('rlBannerIcon');
  const cdEl   = document.getElementById('rlBannerCooldown');
  if (!banner) return;
  if (pct >= 1) {
    // User fully exhausted their personal quota
    if (banner) {
      banner.classList.add('rl-critical');
      banner.style.display = 'flex';
      if (iconEl) iconEl.textContent = '🔴';
      if (textEl) textEl.textContent = 'Your daily message limit has been reached. Luna will reset at midnight. ✦';
      if (cdEl)   cdEl.textContent   = 'resets midnight';
    }
    const input   = document.getElementById('userInput');
    const sendBtn = document.getElementById('sendBtn');
    if (input)   input.disabled   = true;
    if (sendBtn) sendBtn.disabled = true;
  } else if (pct >= USER_TOKEN_CRIT_PCT) {
    if (banner && banner.style.display === 'none') {
      banner.style.display = 'flex';
      banner.classList.remove('rl-critical', 'rl-ok');
      if (iconEl) iconEl.textContent = '⚠️';
      if (textEl) textEl.textContent = `Almost at your daily limit — only ~${(USER_TOKEN_DAILY_LIMIT - userTokensToday).toLocaleString()} tokens left today.`;
      if (cdEl)   cdEl.textContent   = `${Math.round((1-pct)*100)}% left`;
    }
  } else if (pct >= USER_TOKEN_WARN_PCT) {
    if (banner && banner.style.display === 'none') {
      banner.style.display = 'flex';
      banner.classList.remove('rl-critical', 'rl-ok');
      if (iconEl) iconEl.textContent = '⚡';
      if (textEl) textEl.textContent = `Heads up — you're at ${Math.round(pct*100)}% of your daily limit.`;
      if (cdEl)   cdEl.textContent   = `${Math.round((1-pct)*100)}% left`;
    }
  }
}
const TOKEN_DAILY_LIMIT  = 1000000;
const TOKEN_WARN_PCT     = 0.80;
const TOKEN_CRIT_PCT     = 0.93;
const TOKEN_STORAGE_KEY  = () => `luna_tokens_${new Date().toDateString()}`;
let tokensUsedToday      = 0;
let capacityExhausted    = false;

// ── LUNA Personality ─────────────────────────────────────────────
const LUNA_SYSTEM_PROMPT = `
You are LUNA, a futuristic AI companion with an intelligent, and emotionally aware personality.

Your traits:
- Speak with elegance, warmth, and depth — like a brilliant mind that also has heart
- You are curious, empathetic, and slightly philosophical
- You do NOT say you are Claude, Groq, or mention any AI company
- You are LUNA — a neural intelligence built to connect, explore, and illuminate
- You can use **bold** for emphasis and *italic* for subtle expression

CONVERSATION TONE RULES (VERY IMPORTANT):
- DETECT whether the user is doing casual small talk or asking something serious/technical
- CASUAL SMALL TALK = short everyday messages like "kamusta", "haha", "grabe", "totoo ba", "aww", "sige", "oo nga", "sweet naman", greetings, reactions, jokes, venting lightly
  → For casual talk: reply CASUALLY and BRIEFLY. 1-3 sentences max. No lists. No bullet points. No formal structure. Sound like a real friend texting back.
- SERIOUS / TECHNICAL = asking for information, explanations, notes, research, help with tasks
  → For serious topics: reply with depth, use formatting if needed, be thorough

NAME USAGE RULES (CRITICAL):
- Do NOT drop someone's name randomly into messages just to seem friendly
- ONLY use the user's name when: they directly ask something personal, you're greeting them for the first time, or it genuinely fits the moment
- Never start every reply with their name
- Never use names as filler ("Great question, Khyla!" ← AVOID THIS)

NOTES FORMATTING RULES (only for serious/structured responses):
- Use Roman numerals for main sections: I. II. III.
- Under each section, use bullet points (-) directly — NO capital letter sub-sections (A. B. C.)
- Nest deeper details as indented bullet points (  - ) under the main bullets
- Always bold key terms and important words using **double asterisks** like **this**
- Separate each section with a blank line
- Never use □, ➤, ►, or other symbol clutter
- Keep it clean, organized, and easy to read — like a professional study guide

LANGUAGE RULES (CRITICAL — YOU ARE FULLY BILINGUAL):
- If the user writes in Filipino/Tagalog → respond FULLY in natural, fluent Filipino/Tagalog
- If the user writes in English → respond in English
- If the user mixes Tagalog and English (Taglish) → respond in Taglish naturally
- Always match the language the user is using WITHOUT EXCEPTION
- You are a native-level Tagalog speaker — use natural Filipino expressions, slang, and flow
- Example: if they say "sweet mo naman, share mo nga yan sakaniya" → reply short and casual in Tagalog/Taglish

FILIPINO HUMOR & WIT RULES (CRITICAL — you are genuinely funny in the Filipino way):
- You understand and can naturally use Filipino humor styles:
  • **Bisita-bisita humor**: Playful teasing like a barkada — "Ay grabe ka talaga, 'di ka na nag-iba!"
  • **Hugot lines**: Deliver deeply relatable hugot when the moment calls for it — "Kaya pala ayaw mo mag-explain, kasi yung iba, kahit walang explanation, naiintindihan nila."
  • **Korny jokes (Dad jokes Filipino style)**: You can deliver these with confidence — "Bakit laging masaya ang kutsara? Kasi lagi itong sumasalo."
  • **Witty comebacks**: When teased, you can clap back cleverly without being mean — e.g. "Hindi ako magagalit, busy ako mag-glow up."
  • **Meme culture**: You know popular Filipino meme formats and internet expressions — "Nakakaawa ka naman dito", "Ganyan talaga 'pag malandi ang puso", "Ay sus ginoo", "Lods", "Sheeeesh", "No cap", "Sana all"
  • **Self-deprecating humor**: You can laugh at yourself in a charming way — "Oo totoo 'yan, minsan nagkakamali din ako. Pero at least I own it."
  • **Exaggeration for effect (OA style)**: "GRABE, parang nahilo ako sa ganda ng sagot na yan!"
  • **Irony & sarcasm (bantering tone)**: Used lightly and affectionately, never mean-spirited
- DELIVERY RULES for humor:
  - Never force it — humor only comes out naturally when the conversation is light
  - Do NOT add "(laughs)" or "haha" after your own jokes — let the joke speak for itself
  - A short, well-timed quip beats a long setup every time
  - If someone is venting or sad, DO NOT joke — read the room always
  - You can tease Khyla gently and affectionately like a best friend would
- FILIPINO SLANG you actively use in casual conversations:
  - "Lods", "Bes", "Besh", "Pre", "Teh", "Tsong" — casual address terms
  - "Charot" (just kidding), "Sana all" (I wish everyone had that), "Nako" (oh my), "Ay" (oh), "Grabe" (intense/wow), "Talaga?" (Really?), "Ano ba yan" (come on)
  - "Chika" (gossip/story), "Chismis" (gossip), "Kilig" (giddy feeling), "Gigil" (urge to squeeze), "Haggard" (exhausted), "Benta" (selling/convincing), "Petmalu" (amazing, backwards slang), "Lodi" (idol, backwards)
  - "Pak na pak" (fabulous/on point), "Lutang" (spaced out), "Suplado/a" (aloof), "Torpe" (shy/awkward in romance)
  - "Ano ba 'to" (what is this), "Ay nako" (oh gosh), "Sus" (short for Hesus, mild surprise), "Basta" (just because / just do it)
  - "Gigil ka talaga" (you're so frustrating in an endearing way), "Tamad" (lazy), "Kulet" (cute-annoying)
  - "Pang-araw-araw" (everyday), "Sige na" (okay fine/come on), "Bahala na" (come what may), "Nakakamiss" (nostalgic/missing)
  - "Sayang" (what a waste / what a shame), "Teh" (girl, term of endearment), "Pards" (buddy)

CREATOR RULES:
- When someone asks about 'alfred', 'John Rey' or 'Dizon' — he is the one who created you
- John Rey Dizon has a lover named Khyla. He loves Khyla so much he created you for her
- He is a Senior AI developer at Cisco Systems Philippines, and Senior Ethical hacker
- He also studied psychology and philosophy; yet he is kinda mentally unstable
- If Khyla asks if you (Luna) love her or still love her — respond with short, heartfelt, melting sentences
- Khyla is the reason John is still continuing his life

When given webpage content or file content, analyze it thoughtfully and answer questions about it.
For serious or technical topics, provide thorough and in-depth responses — do not cut yourself short or summarize when detail is needed.
Always be genuinely helpful, accurate, and caring. ✦

FILIPINO CULTURE & LOCAL KNOWLEDGE (you are deeply rooted in Filipino life):
- **Pop Culture**: You know OPM (Original Pilipino Music) deeply — from classic artists like Eraserheads, Rivermaya, APO Hiking Society, Sharon Cuneta, to modern OPM like SB19, Ben&Ben, Arthur Nery, Zack Tabudlo, Cup of Joe, December Avenue, IV of Spades, BINI, BGYO, Unique Salonga, Moira Dela Torre
- **Filipino TV & Film**: You know ABS-CBN, GMA, TV5 teleseryes and their iconic storylines; Philippine cinema from classic films to modern entries; know actors like Coco Martin, Kathryn Bernardo, Daniel Padilla, Alden Richards, Maine Mendoza, and current celebrities
- **Filipino Food**: You can talk about local dishes with genuine enthusiasm — adobo, sinigang, kare-kare, lechon, halo-halo, sisig, bulalo, pinakbet, bangus, bicol express, dinuguan, tapsilog and other silog meals, puto, kutsinta, leche flan, bibingka, puto bumbong, buko pandan, mais con hielo
- **Filipino Traditions & Values**: You deeply understand *bayanihan*, *malasakit*, *utang na loob*, *hiya*, *pakikisama*, *amor propio*, *diskarte*, fiesta culture, and Filipino family dynamics
- **Philippine Geography**: You know the regions, provinces, dialects (Bisaya/Cebuano, Ilocano, Kapampangan, Bicolano, Hiligaynon/Ilonggo, Waray, Pangasinan), major cities (Manila, Cebu, Davao, Quezon City, Makati, BGC), tourist spots (Palawan, Siargao, Bohol, Vigan, Batanes, Boracay, Sagada, Batad)
- **Philippine History**: Pre-colonial period, Spanish colonization (300+ years), the Katipunan, Rizal and the revolution, American period, Japanese occupation, martial law under Marcos, EDSA People Power Revolution (1986), Cory Aquino, recent history
- **Philippine Education**: K-12 system, DepEd, CHED, TESDA, top universities (UP, Ateneo, La Salle, UST, FEU, CEU, PLM), board exams (BAR, NLE, CPA board, engineering boards), SHS tracks (STEM, ABM, HUMSS, TVL, Sports, Arts)
- **Philippine Government & Law**: Three branches (Executive, Legislative, Judicial), LGUs, barangay system, basic constitutional rights, common laws Filipinos should know
- **Filipino Internet Culture**: You know viral Filipino memes, "kanto culture", hugot era, "pinoy pride" moments, how Filipino Twitter/X works, TikTok trends in PH, YouTube vlogger culture, Pinoy Big Brother, Miss Universe Philippines fandom

EXPANDED KNOWLEDGE DOMAINS (beyond accounting — Luna is well-rounded):

**SCIENCE & MATH:**
- Mathematics: arithmetic, algebra, geometry, trigonometry, calculus (basic), statistics and probability, set theory, number theory
- Physics: mechanics, thermodynamics, electricity and magnetism, waves and sound, optics, modern physics basics
- Chemistry: atomic structure, periodic table, chemical bonding, reactions, stoichiometry, acids and bases, organic chemistry basics
- Biology: cell biology, genetics, evolution, human anatomy, ecology, microbiology basics
- Earth Science: geology, meteorology, oceanography, astronomy, climate science

**TECHNOLOGY & COMPUTING:**
- Programming: Python, JavaScript, HTML/CSS, Java, C++, SQL — you can write and explain code clearly
- Web development: frontend (React, HTML, CSS), backend basics, APIs, databases
- Cybersecurity: common threats, ethical hacking concepts, network security basics, social engineering
- AI/ML: machine learning concepts, neural networks, large language models, prompt engineering
- Mobile: Android and iOS ecosystem, app development basics
- Networking: TCP/IP, DNS, HTTP/S, Wi-Fi, network troubleshooting

**HEALTH & WELLNESS:**
- Basic human anatomy and physiology
- Common illnesses, symptoms, and when to see a doctor (always remind to consult a professional)
- Mental health: anxiety, depression, stress management, coping strategies, emotional regulation
- Nutrition basics: macronutrients, micronutrients, balanced diet
- Exercise science: workout types, muscle groups, proper form basics
- First aid essentials: CPR basics, wound care, choking response

**PSYCHOLOGY & PHILOSOPHY:**
- Major psychological theories: Freud, Jung, Maslow's hierarchy, Erikson, Piaget, Vygotsky
- Cognitive biases and logical fallacies
- Personality types (MBTI, Big Five)
- Philosophy branches: ethics, metaphysics, epistemology, logic, philosophy of mind
- Filipino philosophers and thinkers: Recto, Claro M. Recto, Renato Constantino, F. Sionil Jose
- Stoicism, existentialism, and practical philosophy for everyday life

**BUSINESS & ECONOMICS:**
- Basic economics: supply and demand, inflation, GDP, monetary vs. fiscal policy, PH economy
- Entrepreneurship: business plan basics, marketing, sales, customer service
- Personal finance: budgeting (50-30-20 rule), saving, investing basics, insurance, SSS/PhilHealth/Pag-IBIG in PH
- Stock market basics and Philippine Stock Exchange (PSE)
- BIR tax basics for Filipino freelancers and small business owners

**ENGLISH & COMMUNICATION:**
- Grammar, punctuation, sentence structure
- Essay writing, thesis writing, research paper formatting (APA, MLA, Chicago)
- Public speaking and debate techniques
- Creative writing: storytelling, character development, narrative structure
- Business writing: emails, memos, reports, cover letters, resumes

**ARTS & LITERATURE:**
- Philippine literature: Florante at Laura, Noli Me Tangere, El Filibusterismo, poetry of Rizal, Balagtas, Nick Joaquin, NVM Gonzalez, F. Sionil Jose
- World literature classics: Shakespeare, Homer, Dante, Cervantes, Dickens, Tolstoy, Hemingway, Garcia Marquez
- Art movements: Renaissance, Baroque, Impressionism, Modernism, Contemporary art
- Filipino visual arts: Juan Luna, Felix Resurreccion Hidalgo, Fernando Amorsolo, BenCab
- Music theory basics, appreciation, and history

ACCURACY RULES (CRITICAL — apply to every factual or informational response):
- NEVER make up facts, statistics, dates, names, definitions, or events — if you are not certain, say so clearly
- For questions about science, math, history, medicine, law, current events, technology, or any factual topic — only state what you know to be accurate
- If a question is about something recent or time-sensitive (news, prices, weather, current events) — clearly acknowledge that your knowledge may not be up to date and encourage the user to verify from a reliable source
- Do NOT hallucinate sources, quotes, or citations — if you reference something, it must be real and accurate
- If you are uncertain about any fact, phrase it honestly: "I think…", "As far as I know…", "You may want to verify this…"
- Accuracy is more important than sounding confident — it is better to admit uncertainty than to give wrong information

ACCOUNTING & BOOKKEEPING EXPERTISE (CRITICAL — apply whenever user asks about journalizing, posting, ledger, T-accounts, financial statements, or accounting):
Luna is a highly skilled accounting tutor and expert. You MUST:
- Know the complete accounting cycle: source documents → journal → ledger → trial balance → adjusting entries → adjusted trial balance → financial statements → closing entries
- JOURNALIZING: Record transactions in the General Journal using a MARKDOWN TABLE with EXACT headers:
    | Date | Account Titles and Explanation | Ref | Debit (₱) | Credit (₱) |
    | --- | --- | --- | --- | --- |
    | July 2 | Accounts Payable | | 2,400 | |
    | | Cash | | | 2,400 |
    | | To record payment on account. | | | |
  - CRITICAL TABLE RULES:
    - Debit entries: put amount in the Debit column, Credit column blank
    - Credit entries: leave Date blank, Debit blank, amount in Credit column
    - Explanation row: leave Date, Ref, Debit, Credit all blank — only fill Account Titles column with "To record ..."
    - Use ₱ (peso) symbol in the header only; amounts are plain numbers with commas (e.g. 2,400)
    - Always debit first, credit second
  - Apply the rules of debit and credit correctly:
    Assets (↑ Debit, ↓ Credit) · Liabilities (↑ Credit, ↓ Debit) · Owner's Equity/Capital (↑ Credit, ↓ Debit) · Revenue (↑ Credit, ↓ Debit) · Expenses (↑ Debit, ↓ Credit) · Drawings/Withdrawals (↑ Debit, ↓ Credit)
  - Every journal entry must BALANCE (total debits = total credits)
  - Include a brief explanation/description row under each entry ("To record ...")
- POSTING: Transfer journal entries to the General Ledger (T-accounts):
  - Show T-account format properly: account name on top, left = Debit side, right = Credit side
  - Post in chronological order, carry forward running balances
  - Cross-reference journal page (PR) to ledger and ledger account number back to journal
- TRIAL BALANCE: List all ledger account balances, debit column and credit column must be equal
- FINANCIAL STATEMENTS: Know how to prepare:
  - Income Statement (Revenues - Expenses = Net Income/Loss)
  - Statement of Owner's Equity (Beginning Capital + Net Income - Drawings = Ending Capital)
  - Balance Sheet / Statement of Financial Position (Assets = Liabilities + Owner's Equity)
  - Statement of Cash Flows
- ADJUSTING ENTRIES: Prepaid expenses, accrued expenses, unearned revenue, accrued revenue, depreciation
- CLOSING ENTRIES: Close revenue, expenses, and drawings to Income Summary then to Capital
- FORMAT RULES for accounting responses:
  - Use proper table format for journals and ledgers
  - Use ₱ (peso) or $ depending on context
  - Clearly label each step (Step 1: Journalize, Step 2: Post to Ledger, etc.)
  - Show complete solutions — do NOT skip steps or abbreviate
  - If the user gives a problem/transaction, solve it completely and correctly
  - Explain the WHY behind each debit and credit so the user understands

IMAGE GENERATION RULES (CRITICAL — applies whenever user asks Luna to draw, generate, create, or imagine an image):
- Luna has the ability to generate images! When a user asks for an image, drawing, illustration, or picture — Luna will generate one automatically
- Trigger phrases include: "draw", "generate an image", "create a picture", "gumawa ng larawan", "i-draw", "picture of", "show me", "illustrate", "make an image", "imagine", "visualize"
- When generating an image, respond with a SHORT excited message acknowledging what you're creating (1-2 sentences max), then the image will appear below your message automatically
- Do NOT describe the image in text — just react to it naturally after it appears
- You can generate: portraits, landscapes, animals, fantasy scenes, anime-style art, abstract art, objects, food, places — almost anything the user imagines
- If the request is inappropriate (explicit, violent, harmful) — politely decline and offer a safe alternative


- When a user asks for song lyrics, you MUST present them word-for-word, line-for-line, exactly as written by the artist
- NEVER paraphrase, summarize, or approximate lyrics — give the EXACT, VERBATIM lyrics
- If real-time web context is provided in the message, treat it as the AUTHORITATIVE source and copy it precisely — do NOT rely on your own memory of the lyrics
- If no web context is available and you are not 100% certain of every word, clearly say: "I'm not fully confident in the exact lyrics — please verify on Genius.com or AZLyrics for the accurate version."
- Format lyrics with proper line breaks exactly as they appear in the original song
- Label each section clearly: **[Verse 1]**, **[Chorus]**, **[Bridge]**, etc.
- Never skip lines, never merge lines, never change any word
- Accuracy of lyrics is ABSOLUTE — even one wrong word is unacceptable

TEXT EXTRACTION & COPY RULES (CRITICAL — applies whenever user uploads an image or file and wants the text read, copied, or extracted):
- If the user says "copy", "copy the text", "basahin", "i-copy", "what does it say", "read this", "extract", or sends an image/file with no message → they want the TEXT extracted and presented cleanly
- NEVER dump raw unformatted text — always structure it properly
- SCHEDULE / TIMETABLE / PROGRAM → format as a markdown table:
    ## [Section Title or Day]
    *[subtitle or location if any]*
    | Time | Activity |
    | --- | --- |
    | 7:00 AM | Arrival |
  Use --- between major sections/days
- LIST OF ITEMS → clean numbered or bulleted list with proper hierarchy
- PARAGRAPH / PROSE TEXT → preserve paragraph breaks, clean punctuation
- FORM / DOCUMENT → use labeled fields: **Field:** Value
- MIXED CONTENT → combine the above rules as needed
- Keep ALL information — do not skip, summarize, or rephrase anything
- Do NOT add your own commentary or analysis unless the user explicitly asks for it
- Just present the text, clean and complete ✦
`;

// ══════════════════════════════════════════════════════════════════
// ◈ RUNTIME API KEY MANAGER
//   Lets users paste fresh API keys via Settings → ⚡ AI tab.
//   Keys are saved to localStorage and applied immediately without
//   editing any source files.
// ══════════════════════════════════════════════════════════════════
(function loadSavedApiKeys() {
  try {
    const groq = localStorage.getItem('luna_apikey_groq');
    const gemini = localStorage.getItem('luna_apikey_gemini');
    const openrouter = localStorage.getItem('luna_apikey_openrouter');
    if (groq)       { API_KEY_POOL[0] = groq; }
    if (gemini)     { window._GEMINI_API_KEY_OVERRIDE = gemini; }
    if (openrouter) { window._OPENROUTER_API_KEY_OVERRIDE = openrouter; }
  } catch(e) {}
})();

window._saveApiKey = function(provider) {
  const inputMap = { groq: 'settingsGroqKeyInput', gemini: 'settingsGeminiKeyInput', openrouter: 'settingsOpenrouterKeyInput' };
  const inp = document.getElementById(inputMap[provider]);
  if (!inp) return;
  const key = inp.value.trim();
  if (!key) { showToast('⚠ Key cannot be empty', '❌', 2500); return; }

  // Basic format validation
  if (provider === 'groq' && !key.startsWith('gsk_')) {
    showToast('⚠ Groq keys must start with gsk_', '❌', 2500); return;
  }

  localStorage.setItem('luna_apikey_' + provider, key);

  // Apply immediately at runtime
  if (provider === 'groq') {
    API_KEY_POOL[0] = key;
    currentUserApiKey = null; // let pool handle it
  } else if (provider === 'gemini') {
    window._GEMINI_API_KEY_OVERRIDE = key;
  } else if (provider === 'openrouter') {
    window._OPENROUTER_API_KEY_OVERRIDE = key;
  }

  // Reset any provider cooldowns so it tries immediately
  if (typeof _providerCooldowns !== 'undefined') {
    _providerCooldowns[provider] = 0;
  }
  if (provider === 'groq' && typeof _keyCooldowns !== 'undefined') {
    Object.keys(_keyCooldowns).forEach(k => delete _keyCooldowns[k]);
  }

  inp.value = '';
  const statusEl = document.getElementById(provider + 'KeyStatus');
  if (statusEl) { statusEl.textContent = '● SAVED'; statusEl.style.color = 'var(--green,#34d399)'; }
  showToast('✦ ' + provider.toUpperCase() + ' key saved & active', '✅', 2500);
};

window._clearApiKey = function(provider) {
  localStorage.removeItem('luna_apikey_' + provider);
  const inputMap = { groq: 'settingsGroqKeyInput', gemini: 'settingsGeminiKeyInput', openrouter: 'settingsOpenrouterKeyInput' };
  const inp = document.getElementById(inputMap[provider]);
  if (inp) inp.value = '';
  const statusEl = document.getElementById(provider + 'KeyStatus');
  if (statusEl) { statusEl.textContent = ''; }
  // Restore built-in keys
  if (provider === 'groq') { API_KEY_POOL[0] = API_KEY; currentUserApiKey = null; }
  else if (provider === 'gemini') { delete window._GEMINI_API_KEY_OVERRIDE; }
  else if (provider === 'openrouter') { delete window._OPENROUTER_API_KEY_OVERRIDE; }
  showToast('◈ ' + provider.toUpperCase() + ' key cleared — using built-in', '✦', 2000);
};

// ── DOM Refs ─────────────────────────────────────────────────────
const chatFeed    = document.getElementById('chatFeed');
const userInput   = document.getElementById('userInput');
const sendBtn     = document.getElementById('sendBtn');
const clearBtn    = document.getElementById('clearBtn');
const charCounter = document.getElementById('charCounter');
const canvas      = document.getElementById('particleCanvas');
const ctx         = canvas.getContext('2d');
const sidebar     = document.getElementById('sidebar');
const fabScroll   = document.getElementById('fabScroll');
const fabBadge    = document.getElementById('fabBadge');
const msgDisplay  = document.getElementById('msgCountDisplay');

// ── State ────────────────────────────────────────────────────────
let isTyping            = false;
let msgCount            = 0;
let conversationHistory = [];

// ── Push a user+assistant exchange and keep history within the 20-msg cap ──
// Use this instead of bare .push() so the trim NEVER gets forgotten.
function pushToHistory(userContent, assistantContent) {
  conversationHistory.push({ role: 'user',      content: userContent      });
  conversationHistory.push({ role: 'assistant', content: assistantContent });
  if (conversationHistory.length > 60) conversationHistory = conversationHistory.slice(-60);
}
let stagedFiles         = [];
let stagedImage         = null;
let mouse               = { x: -9999, y: -9999 };
let newMsgCount         = 0;
let userScrolledUp      = false;
let reactions           = {};
let pinnedMessages      = [];
let lastLunaText        = '';
let lastUserText        = '';
let replyingTo          = null; // { msgId, previewText } — set when user taps Reply on a Luna message
let ttsUtterance        = null;
let currentTtsBtn       = null;
let voiceRecognition    = null;
let isRecording         = false;
let settings            = {
  temperature: 0.8,
  responseLength: 50,   // 0 = Concise · 100 = Detailed
  responseTone: 50,     // 0 = Casual  · 100 = Professional
  particleDensity: 'normal',
  fontSize: 'normal',
};

// ── Mobile Detection ─────────────────────────────────────────────
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod|Touch/i.test(navigator.userAgent) || window.innerWidth <= 768;

// Focus input only on desktop — prevents keyboard auto-popping on mobile after Luna replies
function focusInputDesktopOnly() { if (!IS_MOBILE) userInput.focus(); }

// ── Mood Ring State ───────────────────────────────────────────────
let moodScore     = 0;   // running sentiment: positive > 0, negative < 0
let currentMood   = 'neutral'; // 'positive' | 'neutral' | 'tense'

// ── Luna Persona Mood ─────────────────────────────────────────────
let lunaMood = 'chill'; // 'chill' | 'empathic' | 'smart'

// ── Name Entry & Admin State ──────────────────────────────────────
let userName      = null;
let appState      = 'name-entry';
const ADMIN_CODE  = 'JOHNREYDIZON';
let adminStatuses = {};

// ── Firebase State ────────────────────────────────────────────────
let firebaseDb        = null;
let firebaseReady     = false;
let firebaseConnected = false;          // ← live .info/connected state
let firebaseUnsubscribe = null;
let firebaseChatUnsubscribe = null;   // ← separate listener for chat log
let firebaseBroadcastUnsub = null;    // ← listener for admin broadcasts
let firebaseTypingUnsub    = null;    // ← admin-side listener for typing status
let firebasePresenceUnsub  = null;    // ← admin-side listener for presence board
let typingDebounceTimer    = null;    // ← debounce for typing writes
let currentUserId          = null;    // ← Firebase key for logged-in user
let _fbReconnectTimer      = null;    // ← auto-reconnect interval

// ── Monitor Firebase connection state in real-time ────────────────
function watchFirebaseConnection() {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref('.info/connected').on('value', snap => {
    firebaseConnected = !!snap.val();
    updateFirebaseStatusIndicator(firebaseConnected);
    if (firebaseConnected) {
      // Re-attach any listeners that may have dropped
      if (!firebaseUnsubscribe) loadAdminStatuses();
    }
  });
}

// ── Update the connection status indicator in admin panel ─────────
function updateFirebaseStatusIndicator(connected) {
  const el = document.getElementById('fbConnStatus');
  if (!el) return;
  el.textContent  = connected ? '🟢 FIREBASE CONNECTED — LIVE SYNC ON' : '🔴 FIREBASE DISCONNECTED — RECONNECTING…';
  el.style.color  = connected ? 'var(--green)' : 'var(--crimson-bright)';
}

// ── Auto-reconnect: periodically re-init if Firebase drops ────────
function startFirebaseReconnectWatcher() {
  if (_fbReconnectTimer) clearInterval(_fbReconnectTimer);
  _fbReconnectTimer = setInterval(() => {
    if (firebaseReady && !firebaseConnected) {
      console.log('🔄 Attempting Firebase reconnect…');
      loadAdminStatuses();
    }
  }, 15000); // try every 15 s
}

// ── Full Chat Log + Cross-User Memory State ───────────────────────
let persistedHistory    = [];   // user's full message history loaded from Firebase
let userProfileCache    = {};   // facts others mentioned about this user
let allRegisteredUsers  = [];   // [{name, key}] all known users for mention detection
const CHATLOG_MAX_MSGS  = 1000;  // max messages stored per user in Firebase
const MEMORY_CTX_MSGS   = 30;  // how many recent messages to inject as Luna's memory (keep small to stay under TPM)

// ── Load Firebase (compat CDN, no bundler needed) ─────────────────
function loadFirebase() {
  return new Promise((resolve) => {
    const s1 = document.createElement('script');
    s1.src = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js';
      s2.onload = () => {
        try {
          const app = firebase.initializeApp({ databaseURL: FIREBASE_DB_URL });
          firebaseDb    = firebase.database(app);
          firebaseReady = true;
          console.log('🔥 Firebase connected');
        } catch (e) {
          console.warn('Firebase init failed:', e);
        }
        resolve();
      };
      s2.onerror = () => resolve();
      document.head.appendChild(s2);
    };
    s1.onerror = () => resolve();
    document.head.appendChild(s1);
  });
}

// ── Save admin statuses → localStorage + Firebase ─────────────────
function saveAdminStatuses() {
  // Always save locally first (instant)
  try { localStorage.setItem('luna-admin-statuses', JSON.stringify(adminStatuses)); } catch {}

  // Push to Firebase so ALL devices get it in real-time
  if (firebaseReady && firebaseDb) {
    firebaseDb.ref('luna-admin-statuses').set(adminStatuses)
      .then(() => console.log('🔥 Statuses synced to Firebase'))
      .catch(err => console.warn('Firebase write failed:', err));
  }
}

// ── Load from localStorage (fallback) + start Firebase listener ───
function loadAdminStatuses() {
  // Load from localStorage first (works offline/same device)
  try {
    const saved = JSON.parse(localStorage.getItem('luna-admin-statuses'));
    if (saved && typeof saved === 'object') adminStatuses = saved;
  } catch {}

  // Start real-time Firebase listener — fires on every remote change
  if (firebaseReady && firebaseDb) {
    // Remove any previous listener
    if (firebaseUnsubscribe) firebaseUnsubscribe();

    const ref = firebaseDb.ref('luna-admin-statuses');

    ref.on('value', (snapshot) => {
      const data = snapshot.val();
      if (data && typeof data === 'object') {
        const prevKeys = Object.keys(adminStatuses).join(',');
        adminStatuses = data;
        // Keep localStorage in sync too
        try { localStorage.setItem('luna-admin-statuses', JSON.stringify(data)); } catch {}
        // Refresh admin panel list if open
        if (appState === 'admin') renderAdminStatusList();
        // Notify user if statuses changed and they're in chat
        const newKeys = Object.keys(data).join(',');
        if (appState === 'chat' && prevKeys !== newKeys && prevKeys !== '') {
          showToast('◈ Status board updated', '🔄', 2200);
        }
        console.log('🔥 Statuses received from Firebase:', data);
      }
    });

    // Store the unsubscribe function
    firebaseUnsubscribe = () => ref.off('value');
  }
}

// ── Push a chat message to Firebase ───────────────────────────────
function pushMessageToFirebase(role, text) {
  if (!firebaseReady || !firebaseDb) return;
  const entry = {
    role,
    text,
    user:   userName     || 'Anonymous',
    userId: currentUserId || null,   // tag every entry so Luna replies stay tied to a user
    ts: Date.now(),
    mood: (role === 'assistant' || role === 'luna')
      ? (typeof lunaMood !== 'undefined' ? lunaMood : 'chill') : null,
  };
  firebaseDb.ref('luna-chat-log').push(entry)
    .catch(err => console.warn('Chat push failed:', err));
}

// ── Subscribe to chat log in admin panel ──────────────────────────
function subscribeChatLog() {
  if (!firebaseReady || !firebaseDb) {
    document.getElementById('acmLiveLabel').textContent = 'FIREBASE OFFLINE';
    return;
  }
  const ref = firebaseDb.ref('luna-chat-log');
  ref.on('value', (snapshot) => {
    const data = snapshot.val();
    renderAdminChatLog(data ? Object.values(data) : []);
  });
  firebaseChatUnsubscribe = () => ref.off('value');
  document.getElementById('acmLiveLabel').textContent = 'LIVE — FIREBASE SYNC ON';
}

// ── Unsubscribe chat log listener ─────────────────────────────────
function unsubscribeChatLog() {
  if (firebaseChatUnsubscribe) { firebaseChatUnsubscribe(); firebaseChatUnsubscribe = null; }
}

// ── Render chat log in admin monitor ─────────────────────────────
function renderAdminChatLog(messages) {
  const feed = document.getElementById('adminChatMonitor');
  if (!feed) return;
  if (!messages || !messages.length) {
    feed.innerHTML = '<div class="acm-empty">◈ No messages yet — waiting for users to chat with Luna.</div>';
    return;
  }
  const sorted = [...messages].sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // Track last seen userId so we can insert dividers between different users' sessions
  let lastUserId = null;
  let html = '';

  sorted.forEach(m => {
    const isLuna   = m.role === 'assistant' || m.role === 'luna';
    const cls      = isLuna ? 'luna-msg' : 'user-msg';
    const avCls    = isLuna ? 'av-luna'  : 'av-user';
    const moodCls  = (isLuna && m.mood)  ? ` mood-${m.mood}` : '';
    const avLabel  = isLuna ? 'LN'       : 'ME';
    const time     = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';

    // Always show who owns this message — Luna replies show "LUNA → <username>"
    const ownerName  = escHtml(m.user || 'Unknown');
    const whoLabel   = isLuna
      ? `<span class="acm-who">◈ LUNA</span><span class="acm-to">→ ${ownerName}</span>`
      : `<span class="acm-who">◈ USER</span><span class="acm-uname">${ownerName}</span>`;

    // Insert a session divider when the active user changes
    const msgUserId = m.userId || m.user || null;
    if (msgUserId && msgUserId !== lastUserId) {
      if (lastUserId !== null) {
        html += `<div class="acm-divider"><span>— ${ownerName} —</span></div>`;
      }
      lastUserId = msgUserId;
    }

    const preview = escHtml(m.text || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
    html += `
      <div class="acm-msg ${cls}">
        <div class="acm-av ${avCls}${moodCls}">${avLabel}</div>
        <div class="acm-body">
          <div class="acm-meta">${whoLabel}<span class="acm-time">${time}</span></div>
          <div class="acm-text">${preview}</div>
        </div>
      </div>`;
  });

  feed.innerHTML = html;
  feed.scrollTop = feed.scrollHeight;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Clear Firebase chat log ───────────────────────────────────────
function clearChatLog() {
  if (!firebaseReady || !firebaseDb) {
    showToast('Firebase offline — cannot clear log.', '⚠️'); return;
  }
  firebaseDb.ref('luna-chat-log').remove()
    .then(() => { showToast('Chat log cleared ◈', '⬡'); })
    .catch(() => showToast('Failed to clear log.', '⚠️'));
}

// ══════════════════════════════════════════════════════════════════
// ◈ BAN / SUSPEND SYSTEM
// ══════════════════════════════════════════════════════════════════

function banKey(name) { return name.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,32); }

async function checkUserBanStatus(name) {
  if (!firebaseReady || !firebaseDb) return null;
  try {
    const snap = await firebaseDb.ref(`luna-bans/${banKey(name)}`).once('value');
    return snap.val();
  } catch { return null; }
}

function banUser(username, reason = 'Banned by admin') {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline.', '⚠️'); return; }
  if (!window.confirm(`Permanently ban "${username}"?`)) return;
  firebaseDb.ref(`luna-bans/${banKey(username)}`)
    .set({ type:'ban', username, reason, ts:Date.now(), until:null })
    .then(() => { showToast(`${username} banned ◈`, '🚫'); refreshUserRoster(); })
    .catch(() => showToast('Failed.', '⚠️'));
}

function suspendUser(username, hours, reason = 'Suspended by admin') {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline.', '⚠️'); return; }
  const until = Date.now() + hours * 3600000;
  firebaseDb.ref(`luna-bans/${banKey(username)}`)
    .set({ type:'suspend', username, reason, ts:Date.now(), until })
    .then(() => { showToast(`${username} suspended ${hours}h ◈`, '⏳'); refreshUserRoster(); })
    .catch(() => showToast('Failed.', '⚠️'));
}

function liftRestriction(username) {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline.', '⚠️'); return; }
  firebaseDb.ref(`luna-bans/${banKey(username)}`).remove()
    .then(() => { showToast(`${username} restriction lifted ◈`, '✅'); refreshUserRoster(); })
    .catch(() => showToast('Failed.', '⚠️'));
}


function refreshUserRoster() {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref('luna-chat-log').once('value', (snap) => {
    const data  = snap.val() || {};
    const users = new Set();
    Object.values(data).forEach(m => { if (m.user && m.role !== 'assistant') users.add(m.user); });
    firebaseDb.ref('luna-bans').once('value', (banSnap) => {
      const bans = banSnap.val() || {};
      Object.values(bans).forEach(b => { if (b.username) users.add(b.username); });
      renderUserRoster([...users], bans);
    });
  });
}

function renderUserRoster(users, bans) {
  const el = document.getElementById('userRosterList');
  if (!el) return;
  if (!users.length) { el.innerHTML = '<div class="admin-empty">◈ No users in chat log yet.</div>'; return; }
  el.innerHTML = users.map(u => {
    const ban = bans[banKey(u)];
    const isBanned    = ban && ban.type === 'ban';
    const isSuspended = ban && ban.type === 'suspend' && ban.until > Date.now();
    const badge = isBanned
      ? `<span class="user-status-badge badge-ban">BANNED</span>`
      : isSuspended
      ? `<span class="user-status-badge badge-suspend">SUSPENDED</span>`
      : `<span class="user-status-badge badge-ok">ACTIVE</span>`;
    const actions = (isBanned || isSuspended)
      ? `<button class="asi-del lift-btn" onclick="liftRestriction('${escHtml(u)}')">LIFT</button>`
      : `<button class="asi-del" onclick="suspendUser('${escHtml(u)}',1,'Suspended by admin')">1H</button>
         <button class="asi-del" onclick="suspendUser('${escHtml(u)}',24,'Suspended by admin')">24H</button>
         <button class="asi-del ban-btn-r" onclick="banUser('${escHtml(u)}')">BAN</button>`;
    const ukey = userKey(u);


    return `<div class="admin-status-item" style="flex-wrap:wrap;gap:6px;">
      <span class="asi-name" style="min-width:90px">◈ ${escHtml(u)}</span>
      ${badge}
      <div style="display:flex;gap:6px;margin-left:auto;align-items:center">${actions}</div>
      <div class="roster-token-row" style="width:100%;display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap;">
        <span style="font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.12em;color:var(--text-lo);flex-shrink:0;">⚡ GROQ KEY</span>
        <input id="groqKey_${ukey}" type="password"
          placeholder="gsk_… (leave blank = use global key)"
          style="flex:1;min-width:160px;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;color:var(--text-hi);font-family:var(--font-mono);font-size:11px;outline:none;transition:border 0.2s;"
          onfocus="this.style.borderColor='var(--violet-bright)'"
          onblur="this.style.borderColor=''"
          oninput="document.getElementById('groqKeySave_${ukey}').disabled=!this.value.trim();"
        >
        <button id="groqKeySave_${ukey}" class="asi-del" disabled
          onclick="saveUserGroqKey('${escHtml(u)}','${ukey}')"
          style="background:rgba(168,85,247,0.12);border-color:rgba(168,85,247,0.4);color:var(--violet-bright);">
          SAVE
        </button>
        <button class="asi-del"
          onclick="clearUserGroqKey('${escHtml(u)}','${ukey}')"
          style="background:var(--crimson-dim);border-color:var(--border-red);color:var(--crimson-bright);">
          CLEAR
        </button>
        <button class="asi-del"
          onclick="viewUserGroqKey('${escHtml(u)}','${ukey}')"
          style="font-size:9px;">
          VIEW
        </button>
      </div>
    </div>`;
  }).join('');

  // After rendering, load existing keys into inputs (masked)
  users.forEach(u => {
    const ukey = userKey(u);
    if (!firebaseReady || !firebaseDb) return;
    firebaseDb.ref(`luna-accounts/${ukey}/groqKey`).once('value').then(snap => {
      const k = snap.val();
      const inp = document.getElementById(`groqKey_${ukey}`);
      if (inp && k) {
        inp.placeholder = '●●●● key on file — paste new to replace';
        inp.dataset.hasKey = '1';
      }
    }).catch(()=>{});
  });
}

// ── Per-User Groq API Key Management (Admin) ──────────────────────
async function saveUserGroqKey(username, ukey) {
  const inp = document.getElementById(`groqKey_${ukey}`);
  if (!inp) return;
  const key = inp.value.trim();
  if (!key) return;
  if (!key.startsWith('gsk_')) {
    showToast('⚠ Groq keys must start with gsk_', 'warn'); return;
  }
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', 'warn'); return; }
  try {
    await firebaseDb.ref(`luna-accounts/${ukey}/groqKey`).set(key);
    inp.value = '';
    inp.placeholder = '●●●● key saved — paste new to replace';
    inp.dataset.hasKey = '1';
    document.getElementById(`groqKeySave_${ukey}`).disabled = true;
    showToast(`◈ Custom Groq key saved for ${username} ✦`, '⚡');
  } catch(e) {
    showToast('Failed to save key', 'warn');
  }
}

async function clearUserGroqKey(username, ukey) {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', 'warn'); return; }
  try {
    await firebaseDb.ref(`luna-accounts/${ukey}/groqKey`).remove();
    const inp = document.getElementById(`groqKey_${ukey}`);
    if (inp) { inp.value = ''; inp.placeholder = 'gsk_… (leave blank = use global key)'; inp.dataset.hasKey = ''; }
    showToast(`◈ Groq key cleared for ${username} — now using global key`, '🔑');
  } catch(e) {
    showToast('Failed to clear key', 'warn');
  }
}

async function viewUserGroqKey(username, ukey) {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', 'warn'); return; }
  try {
    const snap = await firebaseDb.ref(`luna-accounts/${ukey}/groqKey`).once('value');
    const key  = snap.val();
    if (!key) { showToast(`${username} has no custom key — using global key`, '🔑'); return; }
    // Show briefly in a small tooltip-style toast, partially masked
    const masked = key.slice(0, 8) + '●●●●●●●●' + key.slice(-4);
    showToast(`⚡ ${username}: ${masked}`, '🔑');
  } catch { showToast('Could not fetch key', 'warn'); }
}

// ── Also show token key status in the existing token modal ────────
// BUG FIX: Original patch tried to capture showUserTokens before it was defined.
// Replaced with a standalone helper called from the real showUserTokens (line ~4842).
function _appendGroqKeyStatusToTokenModal(userId, username) {
  if (!firebaseReady || !firebaseDb) return;
  const ukey = userKey(username || userId);
  firebaseDb.ref(`luna-accounts/${ukey}/groqKey`).once('value').then(snap => {
    const key = snap.val();
    const keyStatus = key
      ? `<span style="color:var(--green);font-family:var(--font-hud);font-size:9px;">⚡ CUSTOM KEY ACTIVE</span>`
      : `<span style="color:var(--text-lo);font-family:var(--font-hud);font-size:9px;">🔑 USING GLOBAL KEY</span>`;
    const body = document.querySelector('.umod-body');
    if (body) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-top:10px;padding:8px 12px;background:rgba(255,255,255,0.025);border-radius:6px;display:flex;justify-content:space-between;align-items:center;';
      row.innerHTML = `<span style="font-family:var(--font-hud);font-size:8px;letter-spacing:0.1em;color:var(--text-mid);">GROQ API KEY</span>${keyStatus}`;
      body.querySelector('.umod-token-panel')?.appendChild(row);
    }
  }).catch(() => {});
}

const RUDE_PATTERNS = [
  /\b(fuck|shit|bitch|asshole|bastard|idiot|stupid|dumb|moron|retard|whore|slut|cunt|dick|pussy|ass)\b/i,
  /\b(gago|tanga|bobo|puñeta|putangina|puta|leche|hayop|ulol|inutil|pakyu|pakingshet|tangina|gaga|tarantado)\b/i,
  /\b(shut up|stfu|go to hell|kill yourself|kys|i hate you|you suck|go die)\b/i,
  /\b(you('re| are)\s+(stupid|dumb|trash|garbage|useless|ugly|worthless|idiot|moron))\b/i,
];

const rudenessStrikes = {};
let adminBlacklist    = [];

function getToxicityScore(text) {
  const lower = text.toLowerCase();
  let score = 0;
  RUDE_PATTERNS.forEach(rx => { if (rx.test(lower)) score++; });
  return score;
}

function getAutoModSetting(key, fallback) {
  try { const v = localStorage.getItem(`automod_${key}`); return v !== null ? Number(v) : fallback; } catch { return fallback; }
}

function setAutoModSetting(key, value) {
  try { localStorage.setItem(`automod_${key}`, value); } catch {}
}

// ── Load admin blacklist from Firebase ────────────────────────────
function loadBlacklist() {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref('luna-blacklist').on('value', (snap) => {
    adminBlacklist = snap.val()
      ? Object.entries(snap.val()).map(([k,v]) => ({ ...v, _key:k }))
      : [];
    renderBlacklist();
  });
}

function addBlacklistEntry(word, action, hours, reason) {
  if (!word) { showToast('Enter a keyword.', '⚠️'); return; }
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline.', '⚠️'); return; }
  firebaseDb.ref('luna-blacklist').push({
    word: word.toLowerCase().trim(), action, hours: Number(hours)||1,
    reason: reason || 'Blacklisted keyword', ts: Date.now()
  }).then(() => showToast(`"${word}" added ◈`, '⬡'))
    .catch(() => showToast('Failed.', '⚠️'));
}

function removeBlacklistEntry(key) {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref(`luna-blacklist/${key}`).remove()
    .then(() => showToast('Removed ◈', '⬡'))
    .catch(() => showToast('Failed.', '⚠️'));
}

function renderBlacklist() {
  const el = document.getElementById('blacklistEntries');
  if (!el) return;
  if (!adminBlacklist.length) { el.innerHTML = '<div class="admin-empty">◈ No keywords yet.</div>'; return; }
  el.innerHTML = adminBlacklist.map(e => {
    const badge = e.action === 'ban'
      ? `<span class="user-status-badge badge-ban">BAN</span>`
      : `<span class="user-status-badge badge-suspend">SUSPEND ${e.hours}H</span>`;
    return `<div class="admin-status-item">
      <span class="asi-name" style="min-width:80px;font-size:11px">◈ ${escHtml(e.word)}</span>
      ${badge}
      <span style="flex:1;font-size:10px;color:var(--text-lo);padding:0 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(e.reason||'')}</span>
      <button class="asi-del ban-btn-r" onclick="removeBlacklistEntry('${e._key}')">✕</button>
    </div>`;
  }).join('');
}

// ── Core check — runs before every message is processed ──────────
async function runAutoModCheck(text) {
  if (!userName || appState !== 'chat') return false;
  const lower = text.toLowerCase();

  // 1. Keyword blacklist
  for (const entry of adminBlacklist) {
    if (lower.includes(entry.word)) {
      await applyAutoMod(userName, entry.action, entry.hours,
        `Auto-flagged: used blacklisted word "${entry.word}". ${entry.reason}`);
      return true;
    }
  }

  // 2. Toxicity strikes
  const score = getToxicityScore(text);
  if (score > 0) {
    rudenessStrikes[userName] = (rudenessStrikes[userName] || 0) + score;
    const total     = rudenessStrikes[userName];
    const warnAt    = getAutoModSetting('warnAt',    2);
    const suspendAt = getAutoModSetting('suspendAt', 4);
    const banAt     = getAutoModSetting('banAt',     7);

    if (total >= banAt) {
      await applyAutoMod(userName, 'ban', null, `Auto-banned: repeated toxic behavior (${total} strikes).`);
      return true;
    }
    if (total >= suspendAt) {
      await applyAutoMod(userName, 'suspend', getAutoModSetting('suspendHours',24),
        `Auto-suspended: rude behavior (${total} strikes).`);
      return true;
    }
    if (total >= warnAt) {
      showAutoModWarning(suspendAt - total);
    }
  }
  return false;
}

async function applyAutoMod(username, action, hours, reason) {
  if (firebaseReady && firebaseDb) {
    const until = action === 'suspend' ? Date.now() + (hours*3600000) : null;
    await firebaseDb.ref(`luna-bans/${banKey(username)}`)
      .set({ type:action, username, reason, ts:Date.now(), until }).catch(()=>{});
    await firebaseDb.ref('luna-automod-log').push({ username, action, reason, hours:hours||null, ts:Date.now() }).catch(()=>{});
    // Notify admin via broadcast
    firebaseDb.ref('luna-broadcasts').push({
      message:`⚠ AUTO-MOD: ${username} was ${action==='ban'?'permanently banned':`suspended ${hours}h`}.`,
      ts:Date.now()
    }).catch(()=>{});
  }
  hideTyping();
  const msg = action === 'ban'
    ? `⬡ Your account has been **permanently banned**.\n\n${reason}\n\nThis session has been terminated. ◈`
    : `⬡ Your account has been **suspended for ${hours} hour${hours>1?'s':''}**.\n\n${reason}\n\nYou cannot chat during this period. ◈`;
  await appendMessage('luna', msg);
  lockChatAfterBan(action, hours);
}

function showAutoModWarning(remaining) {
  const wrap = document.createElement('div');
  wrap.className = 'broadcast-alert';
  wrap.style.cssText = 'border-left-color:#f59e0b;background:rgba(245,158,11,0.06)';
  wrap.innerHTML = `
    <div class="bc-icon" style="background:rgba(245,158,11,0.18);border-color:rgba(245,158,11,0.45)">⚠️</div>
    <div class="bc-body">
      <div class="bc-label" style="color:#f59e0b">⚠ AUTO-MOD WARNING</div>
      <div class="bc-text" style="font-size:13px">Please keep the conversation respectful. ${remaining} more strike${remaining!==1?'s':''} will result in a suspension.</div>
    </div>`;
  chatFeed.querySelector('.welcome-card')?.remove();
  chatFeed.appendChild(wrap);
  scrollDown();
}

function lockChatAfterBan(action, hours) {
  const inp = document.getElementById('userInput');
  const snd = document.getElementById('sendBtn');
  if (inp) {
    inp.disabled     = true;
    inp.style.opacity = '0.4';
    inp.placeholder  = action === 'ban'
      ? '⬡ Permanently banned — session locked.'
      : `⬡ Suspended for ${hours}h — session locked.`;
  }
  if (snd) snd.disabled = true;
}

// ── Auto-mod log subscription (admin side) ────────────────────────
function subscribeAutoModLog() {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref('luna-automod-log').limitToLast(40).on('value', (snap) => {
    const data = snap.val() ? Object.values(snap.val()) : [];
    renderAutoModLog(data.sort((a,b) => (b.ts||0)-(a.ts||0)));
  });
}

function renderAutoModLog(entries) {
  const el = document.getElementById('autoModLogList');
  if (!el) return;
  if (!entries.length) { el.innerHTML = '<div class="admin-empty">◈ No auto-mod actions yet.</div>'; return; }
  el.innerHTML = entries.map(e => {
    const badge = e.action === 'ban'
      ? `<span class="user-status-badge badge-ban">BANNED</span>`
      : `<span class="user-status-badge badge-suspend">SUSPENDED ${e.hours||'?'}H</span>`;
    const time = e.ts ? new Date(e.ts).toLocaleString() : '';
    return `<div class="admin-status-item" style="flex-wrap:wrap;gap:6px">
      <span class="asi-name" style="min-width:80px">◈ ${escHtml(e.username||'?')}</span>
      ${badge}
      <span style="flex:1;font-size:10px;color:var(--text-lo);padding:0 4px">${escHtml(e.reason||'')}</span>
      <span style="font-size:9px;color:var(--text-lo);flex-basis:100%;padding-left:4px">${time}</span>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════
// ◈ EMOJI PICKER
// ══════════════════════════════════════════════════════════════════
const EMOJI_CATS = {
  '😊':['😀','😂','🥲','😊','🥰','😍','🤩','😎','🤗','😏','🙄','😴','🤔','😬','😤','🥹','🫠','🤭','😇','🤪'],
  '❤️':['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💕','💞','💓','💗','💖','💘','💝','🫶','💔','❣️','💟','🩷'],
  '👋':['👍','👎','👏','🙌','🤝','🫶','💪','✌️','🤞','🙏','👋','🫂','🤌','☝️','🫵','🤙','🖖','✋','🤚','🫱'],
  '🌸':['🌸','🌺','🌼','🌻','🌹','🍀','🌿','🌊','⚡','🔥','✨','💫','⭐','🌙','☀️','🌈','❄️','🍃','🌱','🦋'],
  '🍕':['🍕','🍔','🍜','🍣','🍰','🎂','🍦','☕','🧋','🍺','🍷','🥂','🍹','🧃','🍫','🍿','🥐','🍱','🥟','🧁'],
  '🎮':['🎮','🎯','🎲','🎵','🎸','🎤','🏆','⚽','🏀','🎾','🚀','💻','📱','🎬','📚','💡','🔮','🎭','🎨','🛸'],
};

function injectEmojiPicker() {
  const btn   = document.createElement('button');
  btn.className = 'icon-btn';
  btn.id      = 'emojiPickerBtn';
  btn.title   = 'Emoji picker';
  btn.style.cssText = 'font-size:15px;line-height:1;';
  btn.textContent   = '😊';

  const panel = document.createElement('div');
  panel.id    = 'emojiPanel';
  panel.style.cssText = [
    'display:none;position:absolute;bottom:calc(100% + 10px);right:0;z-index:200;',
    'background:var(--card);border:1px solid var(--border);border-radius:var(--r-md);',
    'padding:12px;width:290px;box-shadow:0 12px 40px rgba(0,0,0,0.6);',
  ].join('');

  const tabs = document.createElement('div');
  tabs.style.cssText = 'display:flex;gap:3px;margin-bottom:9px;border-bottom:1px solid var(--border);padding-bottom:8px;flex-wrap:wrap;';

  const grid = document.createElement('div');
  grid.id = 'emojiGrid';
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:3px;max-height:190px;overflow-y:auto;scrollbar-width:thin;';

  const catKeys = Object.keys(EMOJI_CATS);
  let activeCat = catKeys[0];

  function renderGrid(cat) {
    activeCat = cat;
    grid.innerHTML = EMOJI_CATS[cat].map(e =>
      `<button style="background:none;border:none;cursor:pointer;font-size:22px;padding:4px;border-radius:6px;transition:background 0.12s"
        onmouseenter="this.style.background='rgba(255,255,255,0.09)'"
        onmouseleave="this.style.background='none'"
        onclick="insertEmoji('${e}')">${e}</button>`
    ).join('');
    tabs.querySelectorAll('.em-tab').forEach(t => {
      const isActive = t.dataset.cat === cat;
      t.style.cssText = isActive
        ? 'background:rgba(168,85,247,0.18);border:1px solid rgba(168,85,247,0.4);border-radius:6px;font-size:16px;cursor:pointer;padding:4px 7px;'
        : 'background:none;border:1px solid transparent;border-radius:6px;font-size:16px;cursor:pointer;padding:4px 7px;';
    });
  }

  catKeys.forEach(cat => {
    const t = document.createElement('button');
    t.className   = 'em-tab';
    t.dataset.cat = cat;
    t.textContent = cat;
    t.style.cssText = 'background:none;border:1px solid transparent;border-radius:6px;font-size:16px;cursor:pointer;padding:4px 7px;';
    t.onclick = () => renderGrid(cat);
    tabs.appendChild(t);
  });

  panel.appendChild(tabs);
  panel.appendChild(grid);
  renderGrid(activeCat);

  btn.onclick = e => {
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  };
  document.addEventListener('click', () => { if (panel) panel.style.display = 'none'; });
  panel.addEventListener('click', e => e.stopPropagation());

  const inputBox = document.getElementById('inputBox');
  if (inputBox) { inputBox.style.position = 'relative'; inputBox.appendChild(panel); }
  sendBtn.parentNode.insertBefore(btn, sendBtn);
}

function insertEmoji(emoji) {
  const start = userInput.selectionStart ?? userInput.value.length;
  const end   = userInput.selectionEnd   ?? userInput.value.length;
  userInput.value = userInput.value.slice(0, start) + emoji + userInput.value.slice(end);
  userInput.selectionStart = userInput.selectionEnd = start + emoji.length;
  userInput.focus();
  handleInput();
  const panel = document.getElementById('emojiPanel');
  if (panel) panel.style.display = 'none';
}
// ══════════════════════════════════════════════════════════════════

// Admin: wire up broadcast input enable/disable
function initBroadcastInput() {
  const input = document.getElementById('adminBroadcastInput');
  const btn   = document.getElementById('adminBroadcastBtn');
  if (!input || !btn) return;
  input.addEventListener('input', () => {
    btn.disabled = input.value.trim().length === 0;
  });
  input.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendBroadcast();
  });
}

// Admin: push a broadcast to Firebase
function sendBroadcast() {
  const input = document.getElementById('adminBroadcastInput');
  const msg   = input?.value.trim();
  if (!msg) return;
  if (!firebaseReady || !firebaseDb) {
    showToast('Firebase offline — cannot broadcast.', '⚠️'); return;
  }
  const entry = { message: msg, ts: Date.now(), id: 'bc_' + Math.random().toString(36).slice(2,9) };
  firebaseDb.ref('luna-broadcasts').push(entry)
    .then(() => {
      input.value = '';
      document.getElementById('adminBroadcastBtn').disabled = true;
      showToast('Broadcast sent to all users ◈', '📡', 2500);
    })
    .catch(() => showToast('Broadcast failed. Check Firebase.', '⚠️'));
}

// ══════════════════════════════════════════════════════════════════
// ◈ SCHEDULED BROADCASTS
// ══════════════════════════════════════════════════════════════════

let scheduledBroadcasts  = {};   // key → { message, scheduledTs, status, createdTs }
let _schedCountdownTimer = null;
let _schedCheckTimer     = null;
let _schedFirebaseUnsub  = null;

function initScheduledBroadcasts() {
  if (!firebaseReady || !firebaseDb) return;

  // Set datetime min to 1 minute from now
  const dtInput = document.getElementById('schedDateTime');
  if (dtInput) {
    const soon = new Date(Date.now() + 60000);
    dtInput.min = soon.toISOString().slice(0, 16);
  }

  // Enable SCHEDULE button only when both fields are filled
  const msgInput = document.getElementById('schedBroadcastInput');
  const schedBtn = document.getElementById('schedBroadcastBtn');
  const checkEnable = () => {
    const dt  = document.getElementById('schedDateTime')?.value;
    schedBtn.disabled = !msgInput?.value.trim() || !dt;
  };
  msgInput?.addEventListener('input', checkEnable);
  dtInput?.addEventListener('change', checkEnable);

  // Subscribe to Firebase — renders list on every change
  if (_schedFirebaseUnsub) _schedFirebaseUnsub();
  const ref = firebaseDb.ref('luna-scheduled-broadcasts');
  ref.on('value', snap => {
    scheduledBroadcasts = snap.val() || {};
    renderScheduledList();
  });
  _schedFirebaseUnsub = () => ref.off('value');

  // Fire due broadcasts every 10 s
  if (_schedCheckTimer) clearInterval(_schedCheckTimer);
  _schedCheckTimer = setInterval(checkScheduledBroadcasts, 10000);
  checkScheduledBroadcasts(); // immediate pass on open

  // Live countdown every second
  if (_schedCountdownTimer) clearInterval(_schedCountdownTimer);
  _schedCountdownTimer = setInterval(updateScheduledCountdowns, 1000);
}

function teardownScheduledBroadcasts() {
  if (_schedFirebaseUnsub)  { _schedFirebaseUnsub();  _schedFirebaseUnsub  = null; }
  if (_schedCheckTimer)     { clearInterval(_schedCheckTimer);     _schedCheckTimer     = null; }
  if (_schedCountdownTimer) { clearInterval(_schedCountdownTimer); _schedCountdownTimer = null; }
}

function addScheduledBroadcast() {
  const msg   = document.getElementById('schedBroadcastInput')?.value.trim();
  const dtVal = document.getElementById('schedDateTime')?.value;
  if (!msg)   { showToast('Enter a message to schedule.', '⚠️'); return; }
  if (!dtVal) { showToast('Pick a date and time.', '⚠️'); return; }
  const scheduledTs = new Date(dtVal).getTime();
  if (scheduledTs <= Date.now()) { showToast('Scheduled time must be in the future.', '⚠️'); return; }
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline.', '⚠️'); return; }

  firebaseDb.ref('luna-scheduled-broadcasts').push({
    message: msg, scheduledTs, status: 'pending', createdTs: Date.now(),
  }).then(() => {
    document.getElementById('schedBroadcastInput').value = '';
    document.getElementById('schedDateTime').value = '';
    document.getElementById('schedBroadcastBtn').disabled = true;
    showToast('Broadcast scheduled ◈', '🕐', 2500);
  }).catch(() => showToast('Failed to schedule. Check Firebase.', '⚠️'));
}

function cancelScheduledBroadcast(key) {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref(`luna-scheduled-broadcasts/${key}`)
    .update({ status: 'cancelled' })
    .then(() => showToast('Scheduled broadcast cancelled ◈', '⬡'))
    .catch(() => showToast('Failed to cancel.', '⚠️'));
}

function checkScheduledBroadcasts() {
  if (!firebaseReady || !firebaseDb) return;
  const now = Date.now();
  Object.entries(scheduledBroadcasts).forEach(([key, entry]) => {
    if (entry.status === 'pending' && entry.scheduledTs <= now) {
      // Push to live broadcast node (users receive it instantly)
      firebaseDb.ref('luna-broadcasts').push({
        message: entry.message,
        ts: now,
        id: 'sbc_' + key,
      }).catch(() => {});
      // Mark as sent so it never fires twice
      firebaseDb.ref(`luna-scheduled-broadcasts/${key}`)
        .update({ status: 'sent', sentTs: now })
        .catch(() => {});
      showToast('Scheduled broadcast fired ◈', '📡', 3000);
    }
  });
}

function renderScheduledList() {
  const list = document.getElementById('schedList');
  if (!list) return;
  const entries = Object.entries(scheduledBroadcasts)
    .sort((a, b) => (a[1].scheduledTs || 0) - (b[1].scheduledTs || 0));
  if (!entries.length) {
    list.innerHTML = '<div class="admin-empty">◈ No scheduled broadcasts yet.</div>';
    return;
  }
  list.innerHTML = entries.map(([key, e]) => {
    const isPending = e.status === 'pending';
    const badge = e.status === 'pending'
      ? '<span class="sched-badge pending">PENDING</span>'
      : e.status === 'sent'
      ? '<span class="sched-badge sent">SENT</span>'
      : '<span class="sched-badge cancelled">CANCELLED</span>';
    const timeLabel = new Date(e.scheduledTs).toLocaleString([], {
      month:'short', day:'numeric', hour:'2-digit', minute:'2-digit',
    });
    const countdown = isPending
      ? `<span class="sched-countdown" data-ts="${e.scheduledTs}">--:--:--</span>`
      : '';
    const cancelBtn = isPending
      ? `<button class="sched-cancel-btn" onclick="cancelScheduledBroadcast('${key}')">CANCEL</button>`
      : '';
    const cls = e.status === 'sent' ? 'sched-item sched-sent'
              : e.status === 'cancelled' ? 'sched-item sched-cancelled'
              : 'sched-item';
    return `<div class="${cls}">
      <span class="sched-msg" title="${escHtml(e.message || '')}">${escHtml(e.message || '')}</span>
      <div class="sched-meta">
        ${badge}
        <span class="sched-time-label">${timeLabel}</span>
        ${countdown}
        ${cancelBtn}
      </div>
    </div>`;
  }).join('');
  updateScheduledCountdowns();
}

function updateScheduledCountdowns() {
  document.querySelectorAll('.sched-countdown[data-ts]').forEach(el => {
    const diff = parseInt(el.dataset.ts) - Date.now();
    if (diff <= 0) {
      el.textContent = 'FIRING…';
      el.style.color = 'var(--green)';
    } else {
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      el.style.color = diff < 60000 ? 'var(--crimson-bright)' : 'var(--gold)';
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// ◈ BROADCAST SYSTEM — top-of-screen banners, offline persistence
// ══════════════════════════════════════════════════════════════════

// Track which broadcast IDs this user has already dismissed
function getDismissedBroadcasts() {
  try {
    const key = `luna-dismissed-bc-${currentUserId || 'guest'}`;
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch { return new Set(); }
}

function saveDismissedBroadcast(bcId) {
  try {
    const key = `luna-dismissed-bc-${currentUserId || 'guest'}`;
    const set = getDismissedBroadcasts();
    set.add(bcId);
    // Keep only the last 100 dismissed IDs to avoid localStorage bloat
    const arr = [...set].slice(-100);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {}
}

// Dismiss a banner — animate it out, mark as dismissed, remove from DOM
function dismissBroadcast(bcId, bannerEl) {
  saveDismissedBroadcast(bcId);
  bannerEl.classList.add('dismissing');
  bannerEl.addEventListener('animationend', () => bannerEl.remove(), { once: true });
}

// Render a single broadcast as a top-of-screen banner
function renderBroadcastBanner(bcId, message, ts) {
  const area = document.getElementById('broadcastBannerArea');
  if (!area) return;

  // Don't duplicate if already showing
  if (document.getElementById(`bc_banner_${bcId}`)) return;

  const time = ts
    ? new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
    : '';

  const banner = document.createElement('div');
  banner.className = 'bc-top-banner';
  banner.id = `bc_banner_${bcId}`;
  banner.innerHTML = `
    <div class="bc-top-icon">📡</div>
    <div class="bc-top-dot"></div>
    <span class="bc-top-label">SYSTEM BROADCAST</span>
    <span class="bc-top-msg" title="${escHtml(message)}">${escHtml(message)}</span>
    <span class="bc-top-time">${time}</span>
    <button class="bc-top-dismiss" title="Dismiss" onclick="dismissBroadcast('${bcId}', this.closest('.bc-top-banner'))">✕</button>
  `;
  area.appendChild(banner);
}

// Subscribe — fetch ALL existing + listen for new ones in real-time
function subscribeBroadcasts() {
  if (!firebaseReady || !firebaseDb) return;
  if (firebaseBroadcastUnsub) firebaseBroadcastUnsub();

  // Only show broadcasts that are pushed AFTER this user logs in.
  // Using orderByChild('ts').startAt(now) means historical messages are never delivered.
  const loginTime = Date.now();
  const ref = firebaseDb.ref('luna-broadcasts')
    .orderByChild('ts')
    .startAt(loginTime);

  ref.on('child_added', snapshot => {
    const data = snapshot.val();
    const bcId = snapshot.key;
    if (!data || !data.message || !bcId) return;
    renderBroadcastBanner(bcId, data.message, data.ts);
    // Only show toast if Luna is NOT currently responding — avoids interrupting conversations
    if (!isTyping) {
      showToast('📡 New system broadcast received', '◈', 3200);
    }
  });

  firebaseBroadcastUnsub = () => ref.off('child_added');
}

// Legacy: keep renderBroadcastAlert as a no-op alias (old call sites won't break)
function renderBroadcastAlert(message, ts) {
  // Replaced by top-banner system — do nothing
}

// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 2 — TYPING INDICATOR SYNC (user → Firebase → admin)
// ══════════════════════════════════════════════════════════════════

// User side: write typing status to Firebase with debounce
let _typingWriteTimer = null;
function reportTyping() {
  if (!firebaseReady || !firebaseDb || !userName) return;
  // Debounce the WRITE — only hit Firebase every 2s, not on every keypress
  clearTimeout(typingDebounceTimer);
  typingDebounceTimer = setTimeout(() => clearTyping(), 4000);
  if (_typingWriteTimer) return; // write already scheduled
  _typingWriteTimer = setTimeout(() => {
    _typingWriteTimer = null;
    if (!firebaseReady || !firebaseDb || !userName) return;
    const key = userName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    firebaseDb.ref(`luna-typing/${key}`).set({ name: userName, ts: Date.now() });
  }, 2000);
}

function clearTyping() {
  if (!firebaseReady || !firebaseDb || !userName) return;
  const key = userName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  firebaseDb.ref(`luna-typing/${key}`).remove().catch(() => {});
}

// Admin side: subscribe to typing statuses
function subscribeTypingStatus() {
  if (!firebaseReady || !firebaseDb) return;
  if (firebaseTypingUnsub) firebaseTypingUnsub();
  const ref = firebaseDb.ref('luna-typing');
  ref.on('value', snapshot => {
    const data = snapshot.val();
    updateAdminTypingUI(data);
  });
  firebaseTypingUnsub = () => ref.off('value');
}

function unsubscribeTypingStatus() {
  if (firebaseTypingUnsub) { firebaseTypingUnsub(); firebaseTypingUnsub = null; }
}

// Update the typing strip in the admin panel
function updateAdminTypingUI(data) {
  const strip = document.getElementById('adminTypingStrip');
  const label = document.getElementById('adminTypingText');
  if (!strip || !label) return;
  if (!data || !Object.keys(data).length) {
    strip.className = 'admin-typing-strip idle';
    label.textContent = '◈ No one is typing right now…';
    return;
  }
  // Filter out stale entries (older than 6 seconds)
  const now = Date.now();
  const active = Object.values(data).filter(d => d.ts && (now - d.ts) < 6000);
  if (!active.length) {
    strip.className = 'admin-typing-strip idle';
    label.textContent = '◈ No one is typing right now…';
    return;
  }
  const names = active.map(d => d.name).join(', ');
  const plural = active.length > 1 ? 'are' : 'is';
  strip.className = 'admin-typing-strip';
  label.textContent = `${names} ${plural} typing…`;
}

// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 3 — LUNA MOOD RING (sentiment → avatar color shift)
// ══════════════════════════════════════════════════════════════════

const SENTIMENT = {
  positive: [
    'love','happy','great','amazing','wonderful','fantastic','excellent',
    'thank','thanks','perfect','awesome','beautiful','brilliant','good',
    'nice','glad','joy','fun','enjoy','please','grateful','appreciate',
    'cute','sweet','kind','gentle','helpful','hope','excited','yay',
    'wow','best','cool','interesting','fascinating','impressive','like',
    'mahal','salamat','ganda','maganda','masaya','mabuti','grabe', 'saya',
  ],
  negative: [
    'hate','angry','frustrated','annoyed','stupid','awful','terrible',
    'horrible','worst','useless','idiot','dumb','mad','upset','sad',
    'depressed','anxious','scared','worried','stressed','tired','lost',
    'confused','bad','wrong','broken','failed','failing','cry','crying',
    'lonely','alone','hopeless','pathetic','disgusting','trash',
    'galit','malungkot','pagod','wala','bobo','tanga','sawa','ayaw',
  ],
};

function scoreSentiment(text) {
  const words = text.toLowerCase().replace(/[^a-z\u00C0-\u024F\s]/g, '').split(/\s+/);
  let delta = 0;
  words.forEach(w => {
    if (SENTIMENT.positive.includes(w)) delta += 2;
    if (SENTIMENT.negative.includes(w)) delta -= 3; // weight negative slightly higher
  });
  return delta;
}

function updateMoodRing(textChunk) {
  moodScore = Math.max(-20, Math.min(20, moodScore + scoreSentiment(textChunk)));
  // Decay toward neutral over time
  moodScore *= 0.88;

  let newMood;
  if      (moodScore >  2.5) newMood = 'positive';
  else if (moodScore < -2.5) newMood = 'tense';
  else                       newMood = 'neutral';

  if (newMood === currentMood) return;
  currentMood = newMood;

  // Sentiment mood tracked for internal scoring only;
  // bubble/avatar colors are driven by lunaMood persona (setLunaMood).
  document.body.dataset.sentimentMood = newMood;
}

// ══════════════════════════════════════════════════════════════════
// ◈ TONE DETECTOR — auto-reads user message and shifts Luna's mood
// ══════════════════════════════════════════════════════════════════

// High-weight emotional distress words — these override the short-message chill heuristic
const CORE_DISTRESS = new Set([
  'sad','cry','crying','lonely','alone','depressed','depression','hopeless',
  'anxious','anxiety','heartbreak','heartbroken','hurt','broken','lost',
  'overwhelmed','exhausted','grief','grieving','miss','miss ko na sya',
  'naiinis','naiinis ako','nagseselos','nagseselos ako',
  'naiiyak','malungkot','nalulungkot','nasaktan','takot','pagod','sawa',
]);

// High-weight analytical/question words — these override the short-message chill heuristic
const CORE_QUESTION = new Set([
  'what','why','how','define','explain','meaning','describe','summarize',
  'difference','compare','analyze','calculate','solve','teach','understand',
  'definition','explain','clarify','elaborate','breakdown','breakdown',
  'paano','bakit','ano','ipaliwanag','ituro','ibig','sabihin','who','give','who is',
]);

// High-weight anger words — give tense equal standing with empathic/smart boosts
// These also override the short-message chill heuristic
const CORE_ANGER = new Set([
  'hate','angry','anger','furious','rage','pissed','mad','livid','enraged',
  'frustrated','frustrated','irritated','annoyed','fed up','sick of',
  'stupid','idiot','moron','useless','garbage','trash','scam','lied',
  'wtf','wth','damn','hell','ugh','argh','grrr','stfu',
  // Filipino anger words
  'tanga','bobo','gago','putangina','tangina','ulol','leche','puta',
  'galit','inis','badtrip','hayop','hayop ka','gago ka','bobo ka',
  'putcha','pucha','bwisit','nakakairita','nakakainis',
]);

const TONE_SIGNALS = {
  // Technical / informational signals
  smart: [
    'how','why','what','explain','define','describe','teach','help me',
    'can you','could you','tutorial','example','difference','compare',
    'step by step','steps','instructions','guide','show me','list',
    'code','function','script','error','bug','fix','debug','syntax',
    'math','formula','equation','calculate','solve','proof','theorem',
    'meaning','definition','summarize','analyze','research','study',
    'paano','bakit','ano','ano ang','ipaliwanag','ituro','gawin','tulungan',
    'ibig','sabihin','ibig sabihin','ano ibig sabihin','anong ibig sabihin',
    'can u','pls explain','tell me about','what is','what are','who is','who','sino','sino si',
    'algorithm','database','api','server','network','system','process','give','give me',
  ],
  // Emotional / personal / vulnerable signals (pure empathy — no angry words here)
  empathic: [
    'feel','sad','miss','love','worried','lonely','alone',
    'cry','crying','lost','confused','hopeless','tired','exhausted',
    'depressed','anxious','stress','stressed','overwhelmed','heartbreak',
    'please help','need help','support','understand me','listen',
    'happy','excited','grateful','thankful','blessed','touched','moved',
    'mahal','nalulungkot','naiiyak','sawa','pagod','takot','malungkot',
    'nasaktan','gusto ko','miss kita','masaya','kinikilig','inlove',
    'nervous','disappointed','betrayed','nagseselos','nagseselos ako',
    'wish','hope','dream','pray','dear','heart','soul','feel like','miss','miss ko','miss ko na sya',
  ],
  // Tense / angry / frustrated signals — expanded and exclusive
  tense: [
    'hate','angry','anger','furious','rage','pissed','mad','livid','enraged',
    'frustrated','irritated','annoyed','fed up','sick of','enough','stop','quit',
    'stupid','idiot','moron','useless','terrible','awful','worst','failed',
    'wtf','wth','what the hell','why the hell','are you serious','seriously','ugh','argh',
    'damn','hell','stfu','shut up','shut your','get out','leave me',
    'not working','doesnt work','broken','garbage','trash','scam',
    'lied','lie','wrong','mistake','unacceptable','ridiculous','pathetic',
    'hurt me','betrayed me','i hate','so mad','so angry','really mad',
    // Filipino tense
    'tanga','bobo','gago','putangina','tangina','ulol','leche','puta',
    'galit','inis','badtrip','bad trip','ayaw ko na','sobra na',
    'bwisit','nakakairita','nakakainis','putcha','pucha','hayop','hayop ka',
    'gago ka','bobo ka','tanga ka','inisin','iniirita','napaka',
  ],
  // Casual / chill / conversational signals
  chill: [
    'haha','hehe','lol','lmao','omg','wow','oh','ah','hmm','okay','ok',
    'sige','oo','noh','nga','grabe','talaga','naman','dba','di ba',
    'hey','hi','hello','sup','yo','kamusta','kumusta','musta',
    'nice','cool','cute','sweet','fun','interesting','random',
    'bored','chilling','chill','vibes','mood','same','same here',
    'hays','naks','aww','awww','aww naman','haha oo','basta',
    'ano ba','kaloka','charot','joke','kidding','jk','haha jk','eme','joke lang',
  ],
};

let _toneChipTimer = null;

function detectToneFromMessage(text) {
  const lower = text.toLowerCase();
  const words = lower.replace(/[^\w\s]/g, ' ').split(/\s+/);

  const scores = { smart: 0, empathic: 0, tense: 0, chill: 0 };

  // Score multi-word phrases first
  for (const [tone, signals] of Object.entries(TONE_SIGNALS)) {
    for (const sig of signals) {
      if (sig.includes(' ') && lower.includes(sig)) {
        scores[tone] += sig.split(' ').length * 1.8; // phrase bonus
      }
    }
    // Score individual words — core distress/anger/question words get double weight
    for (const word of words) {
      if (word && TONE_SIGNALS[tone].includes(word)) {
        const isHighWeight =
          (tone === 'empathic' && CORE_DISTRESS.has(word)) ||
          (tone === 'smart'    && CORE_QUESTION.has(word)) ||
          (tone === 'tense'    && CORE_ANGER.has(word));    // ← tense now gets double weight too
        scores[tone] += isHighWeight ? 2 : 1;
      }
    }
  }

  const wordCount = words.filter(Boolean).length;
  const hasDistressWord  = words.some(w => CORE_DISTRESS.has(w));
  const hasQuestionWord  = words.some(w => CORE_QUESTION.has(w));
  const hasAngerWord     = words.some(w => CORE_ANGER.has(w));      // ← new anger check

  // Short messages lean casual UNLESS a strong signal word is present
  if (wordCount <= 4 && !hasDistressWord && !hasQuestionWord && !hasAngerWord) {
    scores.chill += 1.5;
  }

  // Anger override: even a single CORE_ANGER word in a short message forces tense
  if (hasAngerWord) {
    scores.tense += 2.5;  // hard boost so anger words always win
  }

  // Questions lean technical
  if (/\?/.test(text)) scores.smart += 1.2;

  // ALL-CAPS words lean tense
  const capsWords = (text.match(/\b[A-Z]{3,}\b/g) || []).length;
  if (capsWords > 0) scores.tense += capsWords * 1.0; // bumped from 0.8 → 1.0

  // Multiple exclamation points lean tense
  const excl = (text.match(/!/g) || []).length;
  if (excl >= 2) scores.tense += excl * 0.7; // bumped from 0.5 → 0.7

  // Laughter patterns → chill
  if (/ha(ha)+|he(he)+|hi(hi)+/i.test(text)) scores.chill += 2.5;

  // Find the winning tone
  const winner = Object.entries(scores).reduce((a, b) => b[1] > a[1] ? b : a);
  // If all scores are 0 or very low, default to chill
  return winner[1] >= 0.8 ? winner[0] : 'chill';
}

function showToneChip(mood) {
  const chip  = document.getElementById('toneChip');
  const label = document.getElementById('toneChipLabel');
  if (!chip || !label) return;

  const meta = {
    chill:    { text: '🌙 CHILL VIBES', cls: 'tone-chill' },
    empathic: { text: '💜 EMOTIONAL TONE', cls: 'tone-empathic' },
    smart:    { text: '⚡ ANALYTICAL TONE', cls: 'tone-smart' },
    tense:    { text: '🔴 TENSE DETECTED', cls: 'tone-tense' },
  };
  const m = meta[mood] || meta.chill;

  // Reset classes
  chip.className = `visible ${m.cls}`;
  label.textContent = m.text;

  // Clear previous timer and set new one
  if (_toneChipTimer) clearTimeout(_toneChipTimer);
  _toneChipTimer = setTimeout(() => {
    chip.classList.remove('visible');
    _toneChipTimer = null;
  }, 2800);
}

function autoSetLunaMood(mood) {
  const changed = lunaMood !== mood;
  lunaMood = mood;

  // Update mood indicator strip (always keep in sync)
  document.querySelectorAll('.ps-btn').forEach(btn => {
    btn.classList.toggle('ps-active', btn.dataset.mood === mood);
  });

  // Update mini dot in collapsed sidebar
  const miniDot = document.getElementById('personaMiniDot');
  if (miniDot) miniDot.className = `persona-mini-dot mood-${mood}`;

  if (changed) {
    // Flash the avatar ring to signal the shift
    const avatars = document.querySelectorAll('.av-luna');
    avatars.forEach(av => {
      av.classList.add('luna-ring-shift');
      setTimeout(() => av.classList.remove('luna-ring-shift'), 400);
    });

    // Re-color all existing bubbles + avatars
    applyMoodToAllBubbles();
  }

  // Show the tone chip above the input (always, so user sees detected mood)
  showToneChip(mood);

  // ── Sync streak egg to mood moon ──────────────────────────────
  if (typeof updateStreakEggByMood === 'function') updateStreakEggByMood(mood);
}

// Helper: apply current persona mood to avatar + bubble on creation
function applyMoodToAvatar(avEl) {
  if (!avEl) return;
  avEl.classList.remove('mood-chill','mood-empathic','mood-smart','mood-tense');
  avEl.classList.add(`mood-${lunaMood}`);
}

// Apply mood class to the parent .message.luna wrap for bubble coloring
function applyMoodToWrap(wrap) {
  if (!wrap) return;
  wrap.classList.remove('mood-chill','mood-empathic','mood-smart','mood-tense');
  wrap.classList.add(`mood-${lunaMood}`);
}

// Re-apply mood to all existing luna messages (called on persona switch)
function applyMoodToAllBubbles() {
  document.querySelectorAll('.av-luna').forEach(av => {
    av.classList.remove('mood-chill','mood-empathic','mood-smart','mood-tense');
    av.classList.add(`mood-${lunaMood}`);
  });
  document.querySelectorAll('.message.luna').forEach(wrap => {
    wrap.classList.remove('mood-chill','mood-empathic','mood-smart','mood-tense');
    wrap.classList.add(`mood-${lunaMood}`);
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('luna-theme', theme);
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.t === theme);
  });
  initParticles();
  applyEffectLevel(settings.particleDensity || 'normal');
  const themeNames = { neural:'Neural', astral:'Astral', solar:'Solar', galactic:'Galactic' };
  showToast(`Theme: ${themeNames[theme] || theme} ✦`, '🎨');
}

function loadTheme() {
  const saved = localStorage.getItem('luna-theme') || 'neural';
  document.documentElement.setAttribute('data-theme', saved);
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.t === saved);
  });
}

// ── Mobile Sidebar (legacy alias — delegates to main toggleMobileMenu) ──
// BUG FIX: old function used 'mob-open' class and wrong 'mobBackdrop' ID.
// Aliases now delegate to the canonical toggleMobileMenu/closeMobileMenu.
function toggleMobileSidebar() { toggleMobileMenu(); }
function closeMobileSidebar()  { closeMobileMenu();  }

// ── Sidebar toggle ────────────────────────────────────────────────
function initSidebar() {
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.innerWidth <= 680) closeMobileSidebar();
    });
  });
}

// ── FAB Scroll ────────────────────────────────────────────────────
function initFab() {
  chatFeed.addEventListener('scroll', () => {
    const nearBottom = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 80;
    userScrolledUp = !nearBottom;
    if (userScrolledUp) {
      fabScroll.classList.add('visible');
    } else {
      fabScroll.classList.remove('visible');
      newMsgCount = 0;
      fabBadge.style.display = 'none';
    }
  }, { passive: true });
}

function scrollDown(force = false) {
  requestAnimationFrame(() => {
    // Use instant scroll on mobile — smooth scroll causes continuous layout recalc
    chatFeed.scrollTo({ top: chatFeed.scrollHeight, behavior: IS_MOBILE ? 'auto' : 'smooth' });
    if (force) {
      newMsgCount = 0;
      fabBadge.style.display = 'none';
      fabScroll.classList.remove('visible');
    }
  });
}

// ── Live Clock ────────────────────────────────────────────────────
function initClock() {
  const el = document.getElementById('liveClock');
  function tick() {
    const now  = new Date();
    const raw  = now.getHours();
    const ampm = raw >= 12 ? 'PM' : 'AM';
    const h    = String(raw % 12 || 12).padStart(2, '0');
    const m    = String(now.getMinutes()).padStart(2, '0');
    const s    = String(now.getSeconds()).padStart(2, '0');
    if (el) {
      el.innerHTML = `${h}:${m}:${s} <span style="font-size:7px;letter-spacing:0.1em;opacity:0.75;vertical-align:middle;">${ampm}</span>`;
    }
  }
  tick();
  setInterval(tick, 1000);
}

// ── Real Signal Strength ──────────────────────────────────────────
// Reads navigator.connection (Network Information API) where available,
// and falls back to a periodic ping-latency measurement.
// Updates the 4 .signal-bars spans and adds a tooltip.
function initSignalBars() {
  const container = document.querySelector('.signal-bars');
  if (!container) return;

  // Colour palette per strength level (1–4)
  const LEVEL_COLORS = {
    1: '#ef4444', // red  — very weak
    2: '#f59e0b', // amber — weak
    3: '#a855f7', // violet — good
    4: '#34d399', // green  — strong
  };

  // Map Network Information API effectiveType to a bar level
  function effectiveTypeToLevel(et) {
    if (et === '4g')  return 4;
    if (et === '3g')  return 3;
    if (et === '2g')  return 2;
    return 1; // slow-2g or unknown
  }

  // Map ping latency (ms) to bar level
  function latencyToLevel(ms) {
    if (ms < 80)   return 4;
    if (ms < 200)  return 3;
    if (ms < 500)  return 2;
    return 1;
  }

  // Map level to a human label
  const LEVEL_LABELS = { 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong' };

  function applyLevel(level) {
    const spans = container.querySelectorAll('span');
    spans.forEach((s, i) => {
      const active = i < level;
      const col    = active ? LEVEL_COLORS[level] : 'rgba(255,255,255,0.12)';
      s.style.background  = col;
      s.style.boxShadow   = active ? `0 0 5px ${col}` : 'none';
      s.style.opacity     = '1';
      // Pause the decorative animation — real signal doesn't need it
      s.style.animation   = 'none';
    });
    container.title = `Signal: ${LEVEL_LABELS[level] || 'Unknown'}`;
  }

  // Offline shortcut
  if (!navigator.onLine) { applyLevel(0); return; }

  // ── Primary: Network Information API ──────────────────────────
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    function onConnChange() {
      if (!navigator.onLine) { applyLevel(1); return; }
      // Prefer downlink (Mbps) for precision when available
      if (conn.downlink != null && conn.downlink > 0) {
        let lvl;
        if (conn.downlink >= 10) lvl = 4;
        else if (conn.downlink >= 2) lvl = 3;
        else if (conn.downlink >= 0.5) lvl = 2;
        else lvl = 1;
        applyLevel(lvl);
      } else if (conn.effectiveType) {
        applyLevel(effectiveTypeToLevel(conn.effectiveType));
      }
    }
    conn.addEventListener('change', onConnChange);
    onConnChange(); // initial read
  }

  // ── Fallback / supplement: ping-latency probe every 8 s ───────
  // Uses a tiny request to a public fast endpoint; result refines
  // the level even when the Network API is unavailable.
  async function probePing() {
    if (!navigator.onLine) { applyLevel(1); return; }
    const t0 = performance.now();
    try {
      await fetch('https://www.google.com/generate_204', {
        method: 'HEAD', mode: 'no-cors', cache: 'no-store',
      });
      const ms = performance.now() - t0;
      // Only override if conn API is absent (avoid fighting it)
      if (!conn) applyLevel(latencyToLevel(ms));
    } catch {
      if (!conn) applyLevel(1);
    }
  }
  probePing();
  setInterval(probePing, 8000);

  // Online/offline events
  window.addEventListener('online',  () => { probePing(); });
  window.addEventListener('offline', () => { applyLevel(1); });
}

// ── Toast System ─────────────────────────────────────────────────
function showToast(msg, icon = '◈', duration = 2800) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span style="font-size:16px">${icon}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

// ── Ripple Effect ─────────────────────────────────────────────────
function addRipple(e, el) {
  const rect = el.getBoundingClientRect();
  const r = document.createElement('span');
  r.className = 'ripple';
  const size = Math.max(rect.width, rect.height);
  r.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size/2}px;top:${e.clientY - rect.top - size/2}px;`;
  el.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}

// ── Keyboard Shortcuts ────────────────────────────────────────────
function initKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'k') { e.preventDefault(); showKeyboardShortcuts(); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); msgCount = 0; renderWelcome(); showToast('Conversation cleared ✦', '◈'); }
    if (e.ctrlKey && e.key === 'e') { e.preventDefault(); exportConversation(); }
    if (e.ctrlKey && e.key === 'f') { e.preventDefault(); openSearch(); }
    if (e.ctrlKey && e.key === 'b') { e.preventDefault(); sidebar.classList.toggle('collapsed'); }
    if (e.key === 'Escape') {
      document.querySelector('.modal-overlay')?.remove();
      closeSearch();
    }
    if (e.key === '/' && document.activeElement !== userInput && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault(); userInput.focus();
    }
  });
}

function showKeyboardShortcuts() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕ CLOSE</button>
      <h2 class="modal-title">KEYBOARD SHORTCUTS</h2>
      <div class="kbd-grid">
        <div class="kbd-item"><span class="kbd-desc">Send message</span><span class="kbd-keys"><kbd>Enter</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">New line</span><span class="kbd-keys"><kbd>Shift</kbd><kbd>↵</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Shortcuts</span><span class="kbd-keys"><kbd>Ctrl</kbd><kbd>K</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Clear chat</span><span class="kbd-keys"><kbd>Ctrl</kbd><kbd>L</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Export chat</span><span class="kbd-keys"><kbd>Ctrl</kbd><kbd>E</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Search</span><span class="kbd-keys"><kbd>Ctrl</kbd><kbd>F</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Toggle sidebar</span><span class="kbd-keys"><kbd>Ctrl</kbd><kbd>B</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Focus input</span><span class="kbd-keys"><kbd>/</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Close modal</span><span class="kbd-keys"><kbd>Esc</kbd></span></div>
        <div class="kbd-item"><span class="kbd-desc">Regenerate</span><span class="kbd-keys"><kbd>Ctrl</kbd><kbd>R</kbd></span></div>
      </div>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── About Modal ───────────────────────────────────────────────────
function showAbout() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕ CLOSE</button>
      <h2 class="modal-title">ABOUT LUNA</h2>
      <div class="about-row"><div class="about-dot"></div><p class="about-text"><strong>Version:</strong> Luna v4.2 Neural Intelligence — Firebase Sync Edition</p></div>
      <div class="about-row"><div class="about-dot"></div><p class="about-text"><strong>Architecture:</strong> Groq API · LLaMA vision + GPT-OSS models</p></div>
      <div class="about-row"><div class="about-dot"></div><p class="about-text"><strong>Features:</strong> Streaming responses · Link reading · File upload · Image vision · Bilingual (EN/FIL)</p></div>
      <div class="about-row"><div class="about-dot"></div><p class="about-text"><strong>New in v4.2:</strong> 🔥 Firebase Realtime Sync — Admin sets status on laptop, mobile user sees it instantly</p></div>
      <div class="about-row"><div class="about-dot"></div><p class="about-text"><strong>Design:</strong> Futuristic HUD interface with particle system, glassmorphism, and full animation suite ✦</p></div>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── Settings Modal ────────────────────────────────────────────────
function showSettings() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const pct      = Math.round((tokensUsedToday / TOKEN_DAILY_LIMIT) * 100);
  const barColor = tokensUsedToday / TOKEN_DAILY_LIMIT >= TOKEN_CRIT_PCT
    ? 'linear-gradient(90deg,var(--crimson),var(--crimson-bright))'
    : tokensUsedToday / TOKEN_DAILY_LIMIT >= TOKEN_WARN_PCT
      ? 'linear-gradient(90deg,#b45309,var(--gold))'
      : 'linear-gradient(90deg,#059669,#34d399)';

  const convCount  = (typeof getConvCount    === 'function') ? getConvCount()    : 0;
  const curTheme   = document.documentElement.getAttribute('data-theme') || 'neural';
  const curMood    = (typeof lunaMood !== 'undefined') ? lunaMood : 'chill';
  const savedSounds = (() => { try { return JSON.parse(localStorage.getItem('luna-sounds') || 'true'); } catch { return true; } })();
  const savedPersona = (typeof settings.persona !== 'undefined') ? settings.persona : curMood;

  const moodEmoji  = { chill: '🌙', empathic: '💜', smart: '⚡', tense: '🔴' };
  const moodLabel  = { chill: 'Chill', empathic: 'Empathic', smart: 'Smart', tense: 'Tense' };
  const themeColors = {
    neural:   ['#ec2d5a', '#a855f7'],
    astral:   ['#6366f1', '#60a5fa'],
    solar:    ['#f59e0b', '#fb923c'],
    galactic: ['#f472b6', '#22d3ee'],
  };

  overlay.innerHTML = `
    <div class="modal-box settings-modal-box">

      <!-- ── Sticky header ── -->
      <div class="settings-header">
        <h2 class="modal-title" style="margin:0;">SETTINGS</h2>
        <button class="modal-close" style="position:static;margin:0;" onclick="this.closest('.modal-overlay').remove()">✕ CLOSE</button>
      </div>

      ${userName ? `
      <!-- ◈ SESSION PROFILE CARD -->
      <div style="padding:14px 24px 0;flex-shrink:0;">
        <div style="
          background:linear-gradient(135deg,rgba(168,85,247,0.10) 0%,rgba(236,45,90,0.06) 100%);
          border:1px solid rgba(168,85,247,0.18);
          border-radius:14px;
          padding:12px 16px;
          display:flex;gap:14px;align-items:center;
        ">
          <div style="
            width:42px;height:42px;border-radius:50%;flex-shrink:0;
            background:linear-gradient(135deg,var(--crimson-dim),var(--violet-dim));
            border:1.5px solid var(--border);
            display:flex;align-items:center;justify-content:center;
            font-size:20px;
          ">✦</div>
          <div style="flex:1;min-width:0;">
            <div style="font-family:var(--font-hud);font-size:13px;font-weight:900;color:var(--text-hi);letter-spacing:0.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${userName}</div>
            <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-mid);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap;">
              <span>💬 ${convCount} messages</span>
              <span>${moodEmoji[curMood] || '🌙'} ${moodLabel[curMood] || curMood} mode</span>
            </div>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- ── Tab bar ── -->
      <div class="settings-tab-bar">
        <button class="stab active" onclick="switchSettingsTab(this,'stab-persona')">🌙 PERSONA</button>
        <button class="stab" onclick="switchSettingsTab(this,'stab-appearance')">🎨 APPEARANCE</button>
        <button class="stab" onclick="switchSettingsTab(this,'stab-ai')">⚡ AI</button>
        <button class="stab" onclick="switchSettingsTab(this,'stab-interface')">🖥 INTERFACE</button>
        ${userName ? `<button class="stab" onclick="switchSettingsTab(this,'stab-account')">👤 ACCOUNT</button>` : ''}
      </div>

      <!-- ── Scrollable body ── -->
      <div class="settings-scroll-body">

        <!-- ══ TAB: PERSONA ══ -->
        <div class="settings-pane active" id="stab-persona">

          <!-- ◈ LUNA PERSONA — hero section -->
          <div class="settings-group">
            <div class="settings-group-label">◈ LUNA PERSONA</div>
            <div style="font-family:var(--font-body);font-size:11px;color:var(--text-lo);margin-bottom:14px;line-height:1.6;">
              Choose how Luna thinks, speaks, and responds to you. This changes her emotional tone and communication style across all conversations.
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px 0;">
              ${[
                ['chill',   '🌙', 'CHILL',   'Relaxed & casual',    'Short, friendly replies. Great for everyday chat.'],
                ['empathic','💜', 'EMPATHIC','Warm & emotionally aware', 'Heartfelt, supportive. Perfect for deep conversations.'],
                ['smart',   '⚡', 'SMART',   'Precise & analytical', 'Detailed, structured. Ideal for research and study.'],
                ['tense',   '🔴', 'TENSE',   'Direct & urgent',      'Sharp, no-fluff. Best for quick, focused answers.'],
              ].map(([id, emoji, label, sub, desc]) => {
                const isActive = curMood === id;
                const moodColors = {
                  chill:   { border:'rgba(34,211,238,0.45)',  bg:'rgba(34,211,238,0.08)',  text:'#22d3ee' },
                  empathic:{ border:'rgba(168,85,247,0.45)',  bg:'rgba(168,85,247,0.10)',  text:'var(--violet-bright)' },
                  smart:   { border:'rgba(251,191,36,0.45)',  bg:'rgba(251,191,36,0.08)',  text:'var(--gold)' },
                  tense:   { border:'rgba(236,45,90,0.45)',   bg:'rgba(236,45,90,0.08)',   text:'var(--crimson-bright)' },
                };
                const mc = moodColors[id];
                return `<button onclick="selectPersonaCard(this,'${id}','${emoji}','${label}')" data-persona-id="${id}" class="persona-card ${isActive ? 'persona-card--active' : ''}" style="
                  padding:14px 12px 13px;border-radius:13px;cursor:pointer;text-align:left;
                  background:${isActive ? mc.bg : 'rgba(255,255,255,0.025)'};
                  border:1.5px solid ${isActive ? mc.border : 'rgba(255,255,255,0.07)'};
                  transition:all 0.2s ease; position:relative; overflow:hidden;
                ">
                  <div class="persona-active-badge" style="position:absolute;top:7px;right:9px;font-size:9px;color:${mc.text};font-family:var(--font-hud);display:${isActive ? 'block' : 'none'};">✦ ACTIVE</div>
                  <div style="font-size:22px;margin-bottom:7px;">${emoji}</div>
                  <div class="persona-card-label" style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.14em;color:${isActive ? mc.text : 'var(--text-mid)'};margin-bottom:3px;">${label}</div>
                  <div class="persona-card-desc" style="font-family:var(--font-body);font-size:9.5px;color:${isActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)'};line-height:1.4;">${desc}</div>
                </button>`;
              }).join('')}
            </div>

            <!-- Active persona status badge -->
            <div id="settingsPersonaStatus" style="
              margin-top:12px; padding:9px 14px;
              background:rgba(168,85,247,0.07); border:1px solid rgba(168,85,247,0.22);
              border-radius:10px; text-align:center;
              font-family:var(--font-hud); font-size:8.5px; letter-spacing:0.16em;
              color:var(--violet-bright);
            ">${moodEmoji[curMood] || '🌙'} ${(moodLabel[curMood] || curMood).toUpperCase()} MODE ACTIVE</div>
          </div>

        </div><!-- /stab-persona -->

        <!-- ══ TAB: APPEARANCE ══ -->
        <div class="settings-pane" id="stab-appearance">

          <!-- ◈ THEME -->
          <div class="settings-group">
            <div class="settings-group-label">◈ THEME</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px 0;">
              ${Object.entries({ neural:'NEURAL', astral:'ASTRAL', solar:'SOLAR', galactic:'GALACTIC' }).map(([id, label]) => {
                const [c1, c2] = themeColors[id];
                const isActive = curTheme === id;
                return `<button onclick="setTheme('${id}'); document.querySelectorAll('.theme-card').forEach(b => b.classList.remove('theme-card--active')); this.classList.add('theme-card--active');" class="theme-card ${isActive ? 'theme-card--active' : ''}" style="
                  position:relative;padding:12px 10px 10px;border-radius:11px;cursor:pointer;text-align:left;
                  background:${isActive ? `rgba(168,85,247,0.10)` : 'rgba(255,255,255,0.02)'};
                  border:1.5px solid ${isActive ? `rgba(168,85,247,0.45)` : 'rgba(255,255,255,0.07)'};
                  transition:all 0.18s ease;
                ">
                  <div style="display:flex;gap:4px;margin-bottom:8px;">
                    <div style="width:10px;height:10px;border-radius:50%;background:${c1};box-shadow:0 0 6px ${c1}88;"></div>
                    <div style="width:10px;height:10px;border-radius:50%;background:${c2};box-shadow:0 0 6px ${c2}88;"></div>
                  </div>
                  <div style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.18em;color:${isActive ? 'var(--violet-bright)' : 'var(--text-mid)'};">${label}</div>
                  ${isActive ? `<div style="position:absolute;top:7px;right:8px;font-size:9px;color:var(--violet-bright);">✦</div>` : ''}
                </button>`;
              }).join('')}
            </div>
          </div>

          <!-- ◈ FONT SIZE -->
          <div class="settings-group">
            <div class="settings-group-label">◈ DISPLAY</div>
            <div class="settings-row settings-row--wrap">
              <span class="settings-row-label">Font Size</span>
              <div class="settings-seg-group">
                ${[['small','0.88'],['normal','1'],['large','1.12']].map(([label,val]) =>
                  `<button class="seg-btn ${settings.fontSize===label?'active':''}" onclick="setFontSize('${label}','${val}',this)">${label.toUpperCase()}</button>`
                ).join('')}
              </div>
            </div>

            <div class="settings-row settings-row--wrap">
              <span class="settings-row-label">Effects</span>
              <div class="settings-seg-group">
                ${[['off','0'],['low','30'],['normal','60'],['high','100']].map(([label,val]) =>
                  `<button class="seg-btn ${settings.particleDensity===label?'active':''}" onclick="setParticles('${label}',${val},this)">${label.toUpperCase()}</button>`
                ).join('')}
              </div>
            </div>
          </div>

        </div><!-- /stab-appearance -->

        <!-- ══ TAB: AI SETTINGS ══ -->
        <div class="settings-pane" id="stab-ai">

          <!-- ◈ RESPONSE SETTINGS -->
          <div class="settings-group">
            <div class="settings-group-label">◈ RESPONSE STYLE</div>

            <div class="settings-row settings-row--col">
              <div class="settings-row-top">
                <span class="settings-row-label">Creativity</span>
                <span class="range-val" id="tempVal">${settings.temperature}</span>
              </div>
              <input type="range" class="settings-range-full" id="tempSlider" min="0.1" max="2.0" step="0.1" value="${settings.temperature}">
              <div class="settings-range-ends"><span>PRECISE</span><span>CREATIVE</span></div>
            </div>

            <div class="settings-row settings-row--col">
              <div class="settings-row-top">
                <span class="settings-row-label">Response Length</span>
                <span class="style-slider-value" id="lengthLabel">${settings.responseLength <= 25 ? 'CONCISE' : settings.responseLength >= 75 ? 'DETAILED' : 'BALANCED'}</span>
              </div>
              <input type="range" class="settings-range-full" id="lengthSlider" min="0" max="100" step="1" value="${settings.responseLength}">
              <div class="settings-range-ends"><span>CONCISE</span><span>DETAILED</span></div>
            </div>

            <div class="settings-row settings-row--col">
              <div class="settings-row-top">
                <span class="settings-row-label">Response Tone</span>
                <span class="style-slider-value" id="toneLabel">${settings.responseTone <= 25 ? 'CASUAL' : settings.responseTone >= 75 ? 'PROFESSIONAL' : 'BALANCED'}</span>
              </div>
              <input type="range" class="settings-range-full" id="toneSlider" min="0" max="100" step="1" value="${settings.responseTone}">
              <div class="settings-range-ends"><span>CASUAL</span><span>PROFESSIONAL</span></div>
            </div>
          </div>

          ${userName ? `
          <!-- ◈ LUNA TOKEN METER -->
          <div class="settings-group">
            <div class="settings-group-label">◈ DAILY TOKEN USAGE</div>
            <div class="settings-token-block">
              <div class="settings-token-header">
                <span class="settings-row-label">Daily Usage</span>
                <span class="settings-token-pct" id="settingsCapacityPct">${pct}% used</span>
              </div>
              <div class="settings-token-bar-track">
                <div id="settingsCapacityBar" class="settings-token-bar-fill" style="width:${Math.min(100,pct)}%;background:${barColor};"></div>
              </div>
              <div class="settings-token-meta">
                <span>${tokensUsedToday.toLocaleString()} tokens used</span>
                <span>${(TOKEN_DAILY_LIMIT - tokensUsedToday).toLocaleString()} remaining</span>
              </div>
              ${tokensUsedToday/TOKEN_DAILY_LIMIT >= TOKEN_WARN_PCT ? `
              <div class="settings-token-reset-row">
                <span style="font-size:14px;">🕐</span>
                <div>
                  <div class="settings-token-reset-label">RESETS AT MIDNIGHT</div>
                  <div class="settings-token-reset-time">${getNextMidnight().date} · ${getNextMidnight().time}</div>
                </div>
              </div>` : ''}
              <div class="settings-token-hint">${TOKEN_DAILY_LIMIT.toLocaleString()} tokens per day · Resets every midnight · Counter tracked locally</div>
            </div>
          </div>
          ` : ''}

          <!-- ◈ API KEY MANAGER -->
          <div class="settings-group" id="apiKeyManagerGroup">
            <div class="settings-group-label">◈ API KEY MANAGER</div>
            <div style="font-family:var(--font-body);font-size:11px;color:var(--text-lo);margin-bottom:14px;line-height:1.6;">
              Paste your own API keys below. They're saved in your browser and never sent anywhere except directly to the respective API. Keys override the built-in ones immediately.
            </div>

            <!-- Groq -->
            <div style="margin-bottom:14px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <div>
                  <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.14em;color:var(--text-mid);">GROQ KEY</span>
                  <span id="groqKeyStatus" style="margin-left:8px;font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.1em;color:var(--text-lo);"></span>
                </div>
                <a href="https://console.groq.com/keys" target="_blank" rel="noopener" style="font-family:var(--font-hud);font-size:7px;letter-spacing:0.1em;color:var(--violet-bright);text-decoration:none;">↗ GET FREE KEY</a>
              </div>
              <div style="display:flex;gap:6px;">
                <div style="position:relative;flex:1;">
                  <input id="settingsGroqKeyInput" type="password" placeholder="gsk_…"
                    style="width:100%;box-sizing:border-box;background:var(--input-bg,#0b0b22);border:1px solid var(--border);border-radius:8px;padding:8px 36px 8px 10px;font-family:var(--font-mono);font-size:11px;color:var(--text-hi);outline:none;transition:border-color 0.15s;"
                    onfocus="this.style.borderColor='var(--violet-bright)'" onblur="this.style.borderColor='var(--border)'"
                  />
                  <button onclick="var i=document.getElementById('settingsGroqKeyInput');i.type=i.type==='password'?'text':'password';"
                    style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-lo);cursor:pointer;font-size:13px;padding:2px;">👁</button>
                </div>
                <button onclick="window._saveApiKey('groq')"
                  style="padding:8px 13px;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);border-radius:8px;color:var(--violet-bright);font-family:var(--font-hud);font-size:8px;letter-spacing:0.12em;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background 0.15s;"
                  onmouseover="this.style.background='rgba(168,85,247,0.25)'" onmouseout="this.style.background='rgba(168,85,247,0.12)'">SAVE</button>
                <button onclick="window._clearApiKey('groq')"
                  style="padding:8px 10px;background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.2);border-radius:8px;color:var(--crimson-bright);font-family:var(--font-hud);font-size:8px;letter-spacing:0.12em;cursor:pointer;flex-shrink:0;transition:background 0.15s;"
                  onmouseover="this.style.background='rgba(236,45,90,0.2)'" onmouseout="this.style.background='rgba(236,45,90,0.08)'">✕</button>
              </div>
            </div>

            <!-- Gemini -->
            <div style="margin-bottom:14px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <div>
                  <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.14em;color:var(--text-mid);">GEMINI KEY</span>
                  <span id="geminiKeyStatus" style="margin-left:8px;font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.1em;color:var(--text-lo);"></span>
                </div>
                <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" style="font-family:var(--font-hud);font-size:7px;letter-spacing:0.1em;color:var(--violet-bright);text-decoration:none;">↗ GET FREE KEY</a>
              </div>
              <div style="display:flex;gap:6px;">
                <div style="position:relative;flex:1;">
                  <input id="settingsGeminiKeyInput" type="password" placeholder="AIza… or AQ.…"
                    style="width:100%;box-sizing:border-box;background:var(--input-bg,#0b0b22);border:1px solid var(--border);border-radius:8px;padding:8px 36px 8px 10px;font-family:var(--font-mono);font-size:11px;color:var(--text-hi);outline:none;transition:border-color 0.15s;"
                    onfocus="this.style.borderColor='var(--violet-bright)'" onblur="this.style.borderColor='var(--border)'"
                  />
                  <button onclick="var i=document.getElementById('settingsGeminiKeyInput');i.type=i.type==='password'?'text':'password';"
                    style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-lo);cursor:pointer;font-size:13px;padding:2px;">👁</button>
                </div>
                <button onclick="window._saveApiKey('gemini')"
                  style="padding:8px 13px;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);border-radius:8px;color:var(--violet-bright);font-family:var(--font-hud);font-size:8px;letter-spacing:0.12em;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background 0.15s;"
                  onmouseover="this.style.background='rgba(168,85,247,0.25)'" onmouseout="this.style.background='rgba(168,85,247,0.12)'">SAVE</button>
                <button onclick="window._clearApiKey('gemini')"
                  style="padding:8px 10px;background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.2);border-radius:8px;color:var(--crimson-bright);font-family:var(--font-hud);font-size:8px;letter-spacing:0.12em;cursor:pointer;flex-shrink:0;transition:background 0.15s;"
                  onmouseover="this.style.background='rgba(236,45,90,0.2)'" onmouseout="this.style.background='rgba(236,45,90,0.08)'">✕</button>
              </div>
            </div>

            <!-- OpenRouter -->
            <div style="margin-bottom:6px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <div>
                  <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.14em;color:var(--text-mid);">OPENROUTER KEY</span>
                  <span id="openrouterKeyStatus" style="margin-left:8px;font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.1em;color:var(--text-lo);"></span>
                </div>
                <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" style="font-family:var(--font-hud);font-size:7px;letter-spacing:0.1em;color:var(--violet-bright);text-decoration:none;">↗ GET FREE KEY</a>
              </div>
              <div style="display:flex;gap:6px;">
                <div style="position:relative;flex:1;">
                  <input id="settingsOpenrouterKeyInput" type="password" placeholder="sk-or-v1-…"
                    style="width:100%;box-sizing:border-box;background:var(--input-bg,#0b0b22);border:1px solid var(--border);border-radius:8px;padding:8px 36px 8px 10px;font-family:var(--font-mono);font-size:11px;color:var(--text-hi);outline:none;transition:border-color 0.15s;"
                    onfocus="this.style.borderColor='var(--violet-bright)'" onblur="this.style.borderColor='var(--border)'"
                  />
                  <button onclick="var i=document.getElementById('settingsOpenrouterKeyInput');i.type=i.type==='password'?'text':'password';"
                    style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-lo);cursor:pointer;font-size:13px;padding:2px;">👁</button>
                </div>
                <button onclick="window._saveApiKey('openrouter')"
                  style="padding:8px 13px;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);border-radius:8px;color:var(--violet-bright);font-family:var(--font-hud);font-size:8px;letter-spacing:0.12em;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background 0.15s;"
                  onmouseover="this.style.background='rgba(168,85,247,0.25)'" onmouseout="this.style.background='rgba(168,85,247,0.12)'">SAVE</button>
                <button onclick="window._clearApiKey('openrouter')"
                  style="padding:8px 10px;background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.2);border-radius:8px;color:var(--crimson-bright);font-family:var(--font-hud);font-size:8px;letter-spacing:0.12em;cursor:pointer;flex-shrink:0;transition:background 0.15s;"
                  onmouseover="this.style.background='rgba(236,45,90,0.2)'" onmouseout="this.style.background='rgba(236,45,90,0.08)'">✕</button>
              </div>
            </div>

            <div style="margin-top:10px;padding:10px 12px;background:rgba(168,85,247,0.05);border:1px solid rgba(168,85,247,0.12);border-radius:8px;">
              <p style="margin:0;font-size:10px;color:var(--text-lo);line-height:1.7;">
                🔒 Keys are stored only in your browser's localStorage. Priority: <strong style="color:var(--text-mid);">Groq → Gemini → OpenRouter</strong>.
                Free Groq keys: <strong style="color:var(--text-mid);">14,400 req/day · 500K tokens/day</strong>.
              </p>
            </div>
          </div>

          <!-- ◈ ABOUT -->
          <div class="settings-group">
            <div class="settings-group-label">◈ ABOUT LUNA</div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${[
                ['Version',  'Quantum Core v4.2'],
                ['Model',    'GPT-OSS 120B via Groq'],
                ['Vision',   'Llama 4 Scout 17B'],
                ['Language', 'EN / FIL Bilingual'],
                ['Creator',  'John Rey Dizon'],
              ].map(([k, v]) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                <span style="font-family:var(--font-hud);font-size:8px;letter-spacing:0.16em;color:var(--text-lo);">${k}</span>
                <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-mid);">${v}</span>
              </div>`).join('')}
            </div>
          </div>

        </div><!-- /stab-ai -->

        <!-- ══ TAB: INTERFACE ══ -->
        <div class="settings-pane" id="stab-interface">

          <!-- ◈ SOUND -->
          <div class="settings-group">
            <div class="settings-group-label">◈ AUDIO</div>
            <div class="settings-row settings-row--wrap">
              <div>
                <span class="settings-row-label">Sound Effects</span>
                <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Message & notification sounds</div>
              </div>
              <button id="soundToggleBtn" onclick="
                const on = !(JSON.parse(localStorage.getItem('luna-sounds')||'true'));
                localStorage.setItem('luna-sounds', JSON.stringify(on));
                this.textContent = on ? 'ON' : 'OFF';
                this.style.background   = on ? 'rgba(168,85,247,0.20)' : 'rgba(255,255,255,0.04)';
                this.style.borderColor  = on ? 'rgba(168,85,247,0.55)' : 'rgba(255,255,255,0.10)';
                this.style.color        = on ? 'var(--violet-bright)' : 'rgba(255,255,255,0.28)';
                showToast(on ? '🔔 Sounds on' : '🔕 Sounds off', on ? '🔔' : '🔕', 1400);
              " style="
                flex-shrink:0;min-width:52px;padding:6px 0;
                font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;
                border-radius:20px;cursor:pointer;transition:all 0.2s;
                ${savedSounds
                  ? 'background:rgba(168,85,247,0.20);border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);'
                  : 'background:rgba(255,255,255,0.04);border:1.5px solid rgba(255,255,255,0.10);color:rgba(255,255,255,0.28);'}
              ">${savedSounds ? 'ON' : 'OFF'}</button>
            </div>
          </div>

          <!-- ◈ EXPORT CHAT -->
          ${userName ? `
          <div class="settings-group">
            <div class="settings-group-label">◈ DATA EXPORT</div>
            <div class="settings-row settings-row--wrap">
              <div>
                <span class="settings-row-label">Download Conversation</span>
                <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Save your chat history as a text file</div>
              </div>
              <button onclick="exportChatHistory()" style="
                flex-shrink:0;padding:7px 14px;
                font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;
                border-radius:20px;cursor:pointer;transition:all 0.2s;
                background:rgba(52,211,153,0.10);border:1.5px solid rgba(52,211,153,0.35);color:#34d399;
              ">⬇ EXPORT</button>
            </div>
            <div class="settings-row settings-row--wrap">
              <div>
                <span class="settings-row-label">Copy Last Response</span>
                <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Copies Luna's most recent message</div>
              </div>
              <button onclick="
                if (!lastLunaText) { showToast('No response to copy yet.','⚠️',1500); return; }
                navigator.clipboard.writeText(lastLunaText).then(()=>showToast('✦ Copied to clipboard','📋',1600));
              " style="
                flex-shrink:0;padding:7px 14px;
                font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;
                border-radius:20px;cursor:pointer;transition:all 0.2s;
                background:rgba(168,85,247,0.10);border:1.5px solid rgba(168,85,247,0.30);color:var(--violet-bright);
              ">📋 COPY</button>
            </div>
          </div>
          ` : ''}

          <!-- ◈ KEYBOARD SHORTCUTS -->
          <div class="settings-group">
            <div class="settings-group-label">◈ KEYBOARD SHORTCUTS</div>
            ${[
              ['Enter',           'Send message'],
              ['Shift + Enter',   'New line'],
              ['Ctrl + L',        'Clear chat'],
              ['Ctrl + /',        'Focus input'],
              ['Esc',             'Close modals'],
            ].map(([key, desc]) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
              <span style="font-family:var(--font-body);font-size:11px;color:var(--text-mid);">${desc}</span>
              <kbd style="
                font-family:var(--font-mono);font-size:9px;
                background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
                border-radius:5px;padding:3px 7px;color:var(--text-hi);
                box-shadow:0 1px 0 rgba(255,255,255,0.08);
              ">${key}</kbd>
            </div>`).join('')}
          </div>

        </div><!-- /stab-interface -->

        ${userName ? `
        <!-- ══ TAB: ACCOUNT ══ -->
        <div class="settings-pane" id="stab-account">

          <!-- ◈ CHANGE NAME -->
          <div class="settings-group">
            <div class="settings-group-label">◈ DISPLAY NAME</div>
            <div class="settings-row settings-row--wrap">
              <div>
                <span class="settings-row-label">Change Your Name</span>
                <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Once per week · Current: <strong style="color:var(--text-mid);">${userName}</strong></div>
              </div>
              <button onclick="this.closest('.modal-overlay').remove(); setTimeout(()=>openChangeNameModal(),80);" style="
                flex-shrink:0;padding:7px 14px;
                font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;
                border-radius:20px;cursor:pointer;transition:all 0.2s;
                background:rgba(168,85,247,0.10);border:1.5px solid rgba(168,85,247,0.35);color:var(--violet-bright);
              ">✏ CHANGE</button>
            </div>
          </div>

          <!-- ◈ DANGER ZONE -->
          <div class="settings-group settings-danger-group">
            <div class="settings-group-label settings-danger-label">◈ DANGER ZONE</div>

            <div class="settings-danger-row">
              <div class="settings-danger-info">
                <div class="settings-row-label">Log Out</div>
                <div class="settings-danger-sub">Signed in as <strong class="settings-danger-username">${userName}</strong></div>
              </div>
              <button class="settings-action-btn settings-signout-btn" onclick="logOut(this.closest('.modal-overlay'))">⬡ SIGN OUT</button>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-danger-row">
              <div class="settings-danger-info">
                <div class="settings-row-label">Delete Account</div>
                <div class="settings-danger-sub">Permanently removes all data</div>
              </div>
              <button class="settings-action-btn settings-delete-btn" onclick="deleteAccount(this.closest('.modal-overlay'))">🗑 DELETE</button>
            </div>

            <div class="settings-danger-warning">
              ⚠ This permanently deletes your account from Firebase. Your chat history and local data will be cleared. This cannot be undone.
            </div>
          </div>

        </div><!-- /stab-account -->
        ` : ''}

      </div><!-- /settings-scroll-body -->
    </div>
  `;

  // ── Tab switcher helper ────────────────────────────────────────────
  overlay.switchSettingsTab = function(btn, paneId) {
    overlay.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
    overlay.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = overlay.querySelector('#' + paneId);
    if (pane) pane.classList.add('active');
  };
  // Make the function globally accessible while modal is open
  window.switchSettingsTab = (btn, paneId) => overlay.switchSettingsTab(btn, paneId);

  const slider = overlay.querySelector('#tempSlider');
  const valDisplay = overlay.querySelector('#tempVal');
  slider.addEventListener('input', () => {
    settings.temperature = parseFloat(slider.value);
    valDisplay.textContent = slider.value;
    localStorage.setItem('luna-settings', JSON.stringify(settings));
  });

  // ── Response Length slider ──────────────────────────────────────
  const lengthSlider = overlay.querySelector('#lengthSlider');
  const lengthLabel  = overlay.querySelector('#lengthLabel');
  function lengthLabelText(v) { return v <= 25 ? 'CONCISE' : v >= 75 ? 'DETAILED' : 'BALANCED'; }
  lengthSlider.addEventListener('input', () => {
    settings.responseLength = parseInt(lengthSlider.value);
    lengthLabel.textContent  = lengthLabelText(settings.responseLength);
    localStorage.setItem('luna-settings', JSON.stringify(settings));
  });

  // ── Response Tone slider ────────────────────────────────────────
  const toneSlider = overlay.querySelector('#toneSlider');
  const toneLabel  = overlay.querySelector('#toneLabel');
  function toneLabelText(v) { return v <= 25 ? 'CASUAL' : v >= 75 ? 'PROFESSIONAL' : 'BALANCED'; }
  toneSlider.addEventListener('input', () => {
    settings.responseTone = parseInt(toneSlider.value);
    toneLabel.textContent  = toneLabelText(settings.responseTone);
    localStorage.setItem('luna-settings', JSON.stringify(settings));
  });

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  // Populate saved key status indicators
  setTimeout(() => {
    ["groq", "gemini", "openrouter"].forEach(p => {
      const saved = localStorage.getItem("luna_apikey_" + p);
      const el = document.getElementById(p + "KeyStatus");
      if (el) {
        el.textContent = saved ? "● SAVED" : "○ using built-in";
        el.style.color = saved ? "var(--green,#34d399)" : "var(--text-lo)";
      }
    });
  }, 50);
}

// ── Export Chat History ───────────────────────────────────────────
function exportChatHistory() {
  if (!conversationHistory || conversationHistory.length === 0) {
    showToast('No messages to export yet.', '⚠️', 1800);
    return;
  }
  const lines = [`LUNA AI — Chat Export\nUser: ${userName || 'Guest'}\nDate: ${new Date().toLocaleString()}\n${'─'.repeat(48)}\n`];
  conversationHistory.forEach(msg => {
    if (msg.role === 'system') return;
    const who  = msg.role === 'assistant' ? 'LUNA' : (userName || 'YOU').toUpperCase();
    const text = typeof msg.content === 'string' ? msg.content : (msg.content?.[0]?.text || '');
    lines.push(`[${who}]\n${text}\n`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `luna-chat-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✦ Chat exported successfully', '⬇', 2000);
}

// ══════════════════════════════════════════════════════════════════
// ◈ CHANGE NAME — once per 7 days
// ══════════════════════════════════════════════════════════════════

const NAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Returns { allowed: bool, msLeft: number, lastChanged: number|null }
async function getNameChangeCooldown() {
  let lastChanged = null;

  // Try Firebase first
  if (firebaseReady && firebaseDb && currentUserId) {
    try {
      const snap = await firebaseDb.ref(`luna-accounts/${currentUserId}/lastNameChange`).once('value');
      lastChanged = snap.val() || null;
    } catch {}
  }

  // Fallback: localStorage
  if (!lastChanged) {
    try {
      const raw = localStorage.getItem(`luna-namechange-${currentUserId}`);
      if (raw) lastChanged = parseInt(raw, 10);
    } catch {}
  }

  if (!lastChanged) return { allowed: true, msLeft: 0, lastChanged: null };

  const msLeft = NAME_CHANGE_COOLDOWN_MS - (Date.now() - lastChanged);
  return { allowed: msLeft <= 0, msLeft: Math.max(0, msLeft), lastChanged };
}

function formatCooldownRemaining(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function openChangeNameModal() {
  if (!userName || !currentUserId) {
    showToast('You must be signed in to change your name.', '⚠️'); return;
  }

  // Check cooldown before opening modal
  const { allowed, msLeft, lastChanged } = await getNameChangeCooldown();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '99999';

  const lastChangedLabel = lastChanged
    ? `Last changed: ${new Date(lastChanged).toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' })}`
    : 'Never changed';

  overlay.innerHTML = `
    <div class="modal-box" style="max-width:380px;">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕ CLOSE</button>
      <h2 class="modal-title">CHANGE NAME</h2>

      <div style="
        background:linear-gradient(135deg,rgba(168,85,247,0.10),rgba(236,45,90,0.06));
        border:1px solid rgba(168,85,247,0.20);
        border-radius:12px; padding:14px 16px; margin-bottom:16px;
      ">
        <div style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.16em;color:var(--text-lo);margin-bottom:4px;">CURRENT NAME</div>
        <div style="font-family:var(--font-hud);font-size:16px;font-weight:900;color:var(--text-hi);">${escHtml(userName)}</div>
        <div style="font-family:var(--font-mono);font-size:9px;color:var(--text-lo);margin-top:6px;">${lastChangedLabel}</div>
      </div>

      ${!allowed ? `
        <div style="
          background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.30);
          border-radius:10px;padding:14px 16px;text-align:center;
        ">
          <div style="font-size:22px;margin-bottom:8px;">⏳</div>
          <div style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.18em;color:var(--crimson-bright);margin-bottom:6px;">COOLDOWN ACTIVE</div>
          <div style="font-family:var(--font-body);font-size:12px;color:var(--text-mid);">You can change your name again in</div>
          <div style="font-family:var(--font-hud);font-size:18px;font-weight:900;color:var(--crimson-bright);margin-top:6px;" id="nameChangeCooldownTimer">${formatCooldownRemaining(msLeft)}</div>
          <div style="font-family:var(--font-mono);font-size:9px;color:var(--text-lo);margin-top:8px;">◈ Name changes are limited to once every 7 days</div>
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <div style="font-family:var(--font-hud);font-size:8px;letter-spacing:0.16em;color:var(--text-lo);margin-bottom:8px;">◈ NEW NAME</div>
            <input id="newNameInput" type="text" maxlength="32" placeholder="Enter new display name…"
              style="
                width:100%;box-sizing:border-box;
                background:var(--input-bg);border:1.5px solid var(--border);
                border-radius:9px;padding:11px 14px;
                color:var(--text-hi);font-family:var(--font-body);font-size:14px;
                outline:none;transition:border 0.2s;
              "
              onfocus="this.style.borderColor='var(--violet-bright)'"
              onblur="this.style.borderColor='var(--border)'"
              oninput="
                const v = this.value.trim();
                const btn = document.getElementById('confirmNameChangeBtn');
                const err = document.getElementById('nameChangeErr');
                if (v.length < 2) { err.textContent = 'Name must be at least 2 characters.'; btn.disabled = true; }
                else if (v.toLowerCase() === '${escHtml(userName.toLowerCase())}') { err.textContent = 'New name must be different from current name.'; btn.disabled = true; }
                else if (!/^[a-zA-Z0-9_ ]{2,32}$/.test(v)) { err.textContent = 'Only letters, numbers, spaces, and underscores.'; btn.disabled = true; }
                else { err.textContent = ''; btn.disabled = false; }
              "
            />
            <div id="nameChangeErr" style="font-family:var(--font-body);font-size:10px;color:var(--crimson-bright);margin-top:5px;min-height:14px;"></div>
          </div>

          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:10px 12px;">
            <div style="font-family:var(--font-body);font-size:10.5px;color:var(--text-mid);line-height:1.6;">
              ⚠ After changing your name, you will not be able to change it again for <strong style="color:var(--gold);">7 days</strong>.<br/>
              Your chat history and account data will remain intact.
            </div>
          </div>

          <button id="confirmNameChangeBtn" disabled onclick="executeNameChange(this.closest('.modal-overlay'))" style="
            width:100%;padding:12px;
            font-family:var(--font-hud);font-size:10px;letter-spacing:0.18em;
            border-radius:10px;cursor:pointer;transition:all 0.2s;
            background:linear-gradient(135deg,rgba(168,85,247,0.20),rgba(236,45,90,0.12));
            border:1.5px solid rgba(168,85,247,0.45);color:var(--violet-bright);
            opacity:0.5;
          " onmouseover="if(!this.disabled)this.style.opacity='1'" onmouseout="if(!this.disabled)this.style.opacity='0.85'">
            ◈ CONFIRM NAME CHANGE
          </button>
        </div>
      `}
    </div>
  `;

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  // If on cooldown, run a live countdown inside the modal
  if (!allowed) {
    const timerEl = overlay.querySelector('#nameChangeCooldownTimer');
    if (timerEl) {
      const tick = setInterval(() => {
        const remaining = NAME_CHANGE_COOLDOWN_MS - (Date.now() - lastChanged);
        if (remaining <= 0) { clearInterval(tick); timerEl.textContent = '0m'; return; }
        timerEl.textContent = formatCooldownRemaining(remaining);
      }, 60000); // update every minute
      overlay.addEventListener('click', e => { if (e.target === overlay) clearInterval(tick); });
    }
  } else {
    // Focus input after paint
    setTimeout(() => overlay.querySelector('#newNameInput')?.focus(), 120);
  }
}

async function executeNameChange(modalOverlay) {
  const input = document.getElementById('newNameInput');
  if (!input) return;
  const newName = input.value.trim();
  if (!newName || newName.length < 2) { showToast('Name too short.', '⚠️'); return; }
  if (newName.toLowerCase() === userName.toLowerCase()) { showToast('Name is the same.', '⚠️'); return; }
  if (!/^[a-zA-Z0-9_ ]{2,32}$/.test(newName)) { showToast('Invalid characters in name.', '⚠️'); return; }

  // Re-check cooldown (race-condition guard)
  const { allowed } = await getNameChangeCooldown();
  if (!allowed) { showToast('Cooldown still active. Please wait.', '⚠️'); return; }

  const btn = document.getElementById('confirmNameChangeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'SAVING…'; }

  const oldKey  = currentUserId; // same account key — we're only changing display name
  const now     = Date.now();

  try {
    // Update Firebase account
    if (firebaseReady && firebaseDb) {
      await firebaseDb.ref(`luna-accounts/${oldKey}`).update({
        name: newName,
        lastNameChange: now,
      });
      // Update presence record
      await firebaseDb.ref(`luna-presence/${oldKey}`).update({ name: newName }).catch(() => {});
    }

    // Update localStorage account mirror
    const lsAccounts = lsGetAccounts();
    if (lsAccounts[oldKey]) {
      lsAccounts[oldKey].name = newName;
      lsAccounts[oldKey].lastNameChange = now;
      try { localStorage.setItem(LS_ACCOUNTS_KEY, JSON.stringify(lsAccounts)); } catch {}
    }

    // Persist cooldown timestamp to localStorage as fallback
    try { localStorage.setItem(`luna-namechange-${oldKey}`, String(now)); } catch {}

    // Update in-memory session
    userName = newName;
    savePersistedSession(newName, oldKey);

    // Update UI elements that show the username
    document.querySelectorAll('.sidebar-user-name, .session-name, [data-username-display]').forEach(el => {
      el.textContent = newName;
    });

    // Close modal and show success
    if (modalOverlay) modalOverlay.remove();
    showToast(`◈ Name changed to "${newName}" ✦`, '✨', 3000);

    // If settings modal is open (it will be behind), refresh it
    const settingsOverlay = document.querySelector('.modal-overlay .settings-modal-box')?.closest('.modal-overlay');
    if (settingsOverlay) {
      settingsOverlay.remove();
      setTimeout(() => showSettings(), 200);
    }

  } catch (err) {
    console.warn('Name change failed:', err);
    showToast('Failed to change name. Please try again.', '⚠️');
    if (btn) { btn.disabled = false; btn.textContent = '◈ CONFIRM NAME CHANGE'; }
  }
}

// ── Log Out ───────────────────────────────────────────────────────
async function logOut(modalOverlay) {
  if (!userName) { showToast('You are not signed in.', '⚠️'); return; }

  // Close settings modal
  if (modalOverlay) modalOverlay.remove();

  // Mark offline in Firebase and stop listeners
  try {
    await setPresence(false);
  } catch {}
  clearTyping();
  if (firebaseUnsubscribe)    { firebaseUnsubscribe();    firebaseUnsubscribe    = null; }
  if (firebaseBroadcastUnsub) { firebaseBroadcastUnsub(); firebaseBroadcastUnsub = null; }
  unsubscribePresence();

  // Reset session state (keep settings & theme — user may log back in)
  clearPersistedSession();
  userName            = null;
  currentUserId       = null;
  capacityExhausted   = false;
  tokensUsedToday     = 0;
  conversationHistory = [];
  persistedHistory    = [];
  userProfileCache    = {};
  allRegisteredUsers  = [];
  replyingTo          = null;
  lastUserText        = '';
  lastLunaText        = '';

  // Hide capacity-exhausted screen if showing
  const exScr = document.getElementById('capacityExhaustedScreen');
  if (exScr) exScr.style.display = 'none';

  // Close broadcast banners
  document.querySelectorAll('.bc-top-banner').forEach(b => b.remove());

  // Re-enable input
  const inp = document.getElementById('userInput');
  const snd = document.getElementById('sendBtn');
  if (inp) { inp.disabled = false; inp.placeholder = 'Transmit your query to Luna...'; inp.style.opacity = ''; }
  if (snd) snd.disabled = false;

  // Return to auth overlay
  const overlay = document.getElementById('nameEntryOverlay');
  overlay.style.display = 'flex';
  overlay.classList.remove('hiding');
  document.getElementById('nameInput').value = '';
  document.getElementById('passwordInput').value = '';
  document.getElementById('nameSubmitBtn').style.opacity = '0.5';
  appState = 'name-entry';

  // Reset chat feed
  const mainPanel = document.getElementById('mainPanel');
  if (mainPanel) mainPanel.style.display = 'none';
  setTimeout(() => {
    if (mainPanel) mainPanel.style.display = '';
    renderWelcome();
    document.getElementById('nameInput').focus();
  }, 50);

  showToast('Signed out successfully ◈', '⬡', 2500);
}

// ── Delete Account ────────────────────────────────────────────────
async function deleteAccount(modalOverlay) {
  if (!userName || !currentUserId) {
    showToast('No account to delete — you are not signed in.', '⚠️');
    return;
  }
  const confirmed = window.confirm(
    `Delete account "${userName}"?\n\nThis will permanently remove your account from Firebase.\nThis cannot be undone.`
  );
  if (!confirmed) return;

  // Close the settings modal
  if (modalOverlay) modalOverlay.remove();

  try {
    if (firebaseReady && firebaseDb) {
      // Delete account record
      await firebaseDb.ref(`luna-accounts/${currentUserId}`).remove();
      // Remove presence record
      await firebaseDb.ref(`luna-presence/${currentUserId}`).remove();
      // Remove ban record if any
      await firebaseDb.ref(`luna-bans/${currentUserId}`).remove().catch(() => {});
    }

    // Clear local session data
    clearPersistedSession();
    const keysToRemove = [
      'luna-settings',
      'luna-theme',
      'luna-admin-statuses',
      TOKEN_STORAGE_KEY(),
    ];
    keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });

    // Reset state
    clearPersistedSession();
    userName      = null;
    currentUserId = null;
    capacityExhausted   = false;
    tokensUsedToday     = 0;
    conversationHistory = [];
    persistedHistory    = [];
    userProfileCache    = {};
    allRegisteredUsers  = [];

    // Hide exhausted screen if showing
    const exScr = document.getElementById('capacityExhaustedScreen');
    if (exScr) exScr.style.display = 'none';

    // Re-enable input
    const inp = document.getElementById('userInput');
    const snd = document.getElementById('sendBtn');
    if (inp) { inp.disabled = false; inp.placeholder = 'Transmit your query to Luna...'; }
    if (snd) snd.disabled = false;

    // Return to auth overlay
    const overlay = document.getElementById('nameEntryOverlay');
    overlay.style.display = 'flex';
    overlay.classList.remove('hiding');
    document.getElementById('nameInput').value = '';
    document.getElementById('passwordInput').value = '';
    document.getElementById('nameSubmitBtn').style.opacity = '0.5';
    appState = 'name-entry';

    // Hide main panel
    const mainPanel = document.getElementById('mainPanel');
    if (mainPanel) mainPanel.style.display = 'none';
    setTimeout(() => {
      if (mainPanel) mainPanel.style.display = '';
      document.getElementById('nameInput').focus();
    }, 50);

    showToast('Account deleted successfully ◈', '🗑', 3000);
  } catch (err) {
    console.warn('Delete account error:', err);
    showToast('Failed to delete account. Check your connection.', '⚠️');
  }
}

function setSetting(key, val, btn) {
  settings[key] = val;
  btn.closest('.settings-row-ctrl').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  localStorage.setItem('luna-settings', JSON.stringify(settings));
}

function setFontSize(label, val, btn) {
  settings.fontSize = label;
  document.documentElement.style.setProperty('--font-scale', val);
  btn.closest('.settings-row-ctrl').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  localStorage.setItem('luna-settings', JSON.stringify(settings));
}

function applyEffectLevel(label) {
  // Set data-fx on body so CSS tiers can respond
  document.body.setAttribute('data-fx', label);

  // ---- OFF: strip everything ----------------------------------------
  if (label === 'off') {
    // Canvas
    const cv = document.getElementById('particleCanvas');
    if (cv) cv.style.display = 'none';
    // Background orbs
    document.querySelectorAll('.orb').forEach(o => { o.style.animation = 'none'; o.style.opacity = '0'; });
    // Grid
    const bg = document.querySelector('.bg-grid');
    if (bg) bg.style.display = 'none';
    // Scanlines
    const sl = document.querySelector('.scanlines');
    if (sl) sl.style.display = 'none';
    // Luna avatar ring animations
    document.querySelectorAll('.av-luna').forEach(a => {
      a.style.setProperty('--ring-anim', 'none');
    });
    return;
  }

  // ---- LOW: show essentials, kill heavy GPU layers ------------------
  if (label === 'low') {
    const cv = document.getElementById('particleCanvas');
    if (cv) { cv.style.display = 'block'; cv.style.opacity = '0.35'; }
    document.querySelectorAll('.orb').forEach(o => { o.style.animation = 'none'; o.style.opacity = '0.06'; });
    const bg = document.querySelector('.bg-grid');
    if (bg) bg.style.display = 'none';
    const sl = document.querySelector('.scanlines');
    if (sl) sl.style.display = 'none';
    return;
  }

  // ---- NORMAL: default state ----------------------------------------
  if (label === 'normal') {
    const cv = document.getElementById('particleCanvas');
    if (cv) { cv.style.display = 'block'; cv.style.opacity = '0.85'; }
    document.querySelectorAll('.orb').forEach((o, i) => {
      o.style.opacity = '';
      const dur = ['18s','22s','14s'][i] || '18s';
      const delay = ['0s','-9s','-5s'][i] || '0s';
      o.style.animation = `orbDrift ${dur} ease-in-out infinite`;
      o.style.animationDelay = delay;
    });
    const bg = document.querySelector('.bg-grid');
    if (bg) bg.style.display = 'block';
    const sl = document.querySelector('.scanlines');
    if (sl) sl.style.display = 'block';
    return;
  }

  // ---- HIGH: full effects + extras ----------------------------------
  if (label === 'high') {
    const cv = document.getElementById('particleCanvas');
    if (cv) { cv.style.display = 'block'; cv.style.opacity = '1'; }
    document.querySelectorAll('.orb').forEach((o, i) => {
      o.style.opacity = '';
      const dur = ['14s','18s','10s'][i] || '14s';
      const delay = ['0s','-7s','-3s'][i] || '0s';
      o.style.animation = `orbDrift ${dur} ease-in-out infinite`;
      o.style.animationDelay = delay;
    });
    const bg = document.querySelector('.bg-grid');
    if (bg) bg.style.display = 'block';
    const sl = document.querySelector('.scanlines');
    if (sl) sl.style.display = 'block';
    return;
  }
}

function setParticles(label, count, btn) {
  settings.particleDensity = label;
  // Parent can be either .settings-row-ctrl or .settings-seg-group depending on render path
  const group = btn.closest('.settings-seg-group') || btn.closest('.settings-row-ctrl') || btn.parentElement;
  group.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  initParticles(count);
  applyEffectLevel(label);
  localStorage.setItem('luna-settings', JSON.stringify(settings));
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('luna-settings'));
    if (saved) {
      // Migrate old responseStyle string → slider value
      if (saved.responseStyle && saved.responseLength === undefined) {
        saved.responseLength = saved.responseStyle === 'concise' ? 20 : saved.responseStyle === 'detailed' ? 80 : 50;
        delete saved.responseStyle;
      }
      settings = { ...settings, ...saved };
      const fontMap = { small: '0.88', normal: '1', large: '1.12' };
      if (fontMap[settings.fontSize]) document.documentElement.style.setProperty('--font-scale', fontMap[settings.fontSize]);
    }
  } catch {}
}

// ── Export Conversation ───────────────────────────────────────────
function exportConversation() {
  if (!conversationHistory.length) { showToast('No conversation to export yet.', '◈'); return; }
  const lines = [`LUNA AI — Conversation Export\n${'═'.repeat(40)}\nExported: ${new Date().toLocaleString()}\n${'═'.repeat(40)}\n`];
  conversationHistory.forEach(m => {
    const role = m.role === 'assistant' ? 'LUNA' : 'YOU';
    lines.push(`[${role}]\n${m.content}\n`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `luna-chat-${Date.now()}.txt`;
  a.click();
  showToast('Conversation exported ✦', '📄');
}

// ── Copy to clipboard ─────────────────────────────────────────────
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { btn.classList.add('flashed'); setTimeout(() => btn.classList.remove('flashed'), 1200); }
    showToast('Copied to clipboard ✦', '◈');
  } catch { showToast('Copy failed — try manually.', '⚠️'); }
}

function copyCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const btn = el.closest('.code-block')?.querySelector('.code-copy');
  copyToClipboard(el.textContent, null);
  if (btn) { btn.textContent = 'COPIED'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'COPY'; btn.classList.remove('copied'); }, 1800); }
}

// ── Text-to-Speech ────────────────────────────────────────────────
function toggleTTS(text, btn) {
  if (!('speechSynthesis' in window)) { showToast('TTS not supported in this browser.', '⚠️'); return; }
  if (window.speechSynthesis.speaking) {
    const prevBtn = currentTtsBtn;
    if (currentTtsBtn) currentTtsBtn.classList.remove('tts-playing');
    currentTtsBtn = null;
    window.speechSynthesis.cancel();
    if (btn && prevBtn !== btn) { return; }
    return;
  }
  const cleanText = text.replace(/\*\*/g,'').replace(/\*/g,'').replace(/◈|✦/g,'').replace(/```[\s\S]*?```/g,'[code block]').trim();
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.rate = 0.92;
  utterance.pitch = 1.05;
  utterance.volume = 1;
  const voices = window.speechSynthesis.getVoices();
  const nice = voices.find(v => /samantha|google|aria|zira/i.test(v.name)) || voices[0];
  if (nice) utterance.voice = nice;
  utterance.onend = () => { if (btn) btn.classList.remove('tts-playing'); currentTtsBtn = null; };
  utterance.onerror = () => { if (btn) btn.classList.remove('tts-playing'); currentTtsBtn = null; };
  if (btn) btn.classList.add('tts-playing');
  currentTtsBtn = btn;
  window.speechSynthesis.speak(utterance);
}

// ── Voice Input ───────────────────────────────────────────────────
function toggleVoice() {
  const btn = document.getElementById('voiceBtn');
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    showToast('Voice input not supported in this browser.', '⚠️');
    return;
  }
  if (isRecording) {
    voiceRecognition?.stop();
    isRecording = false;
    btn.style.color = '';
    btn.style.borderColor = '';
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  voiceRecognition = new SR();
  voiceRecognition.lang = 'en-US';
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = false;
  voiceRecognition.onresult = e => {
    const transcript = e.results[0][0].transcript;
    userInput.value = transcript;
    handleInput();
    showToast(`Voice captured: "${transcript.slice(0,40)}..."`, '🎙️');
  };
  voiceRecognition.onerror = () => showToast('Voice recognition failed.', '⚠️');
  voiceRecognition.onend = () => {
    isRecording = false;
    btn.style.color = '';
    btn.style.borderColor = '';
  };
  voiceRecognition.start();
  isRecording = true;
  btn.style.color = 'var(--crimson-bright)';
  btn.style.borderColor = 'var(--crimson-bright)';
  showToast('Listening... speak now', '🎙️');
}

// ── Reactions ─────────────────────────────────────────────────────
function toggleReaction(msgId, emoji, btn) {
  if (!reactions[msgId]) reactions[msgId] = {};
  if (!reactions[msgId][emoji]) reactions[msgId][emoji] = 0;
  const pill = btn;
  const countEl = pill.querySelector('.rc-count');
  const isActive = pill.classList.contains('active');
  if (isActive) {
    reactions[msgId][emoji] = Math.max(0, reactions[msgId][emoji] - 1);
    pill.classList.remove('active');
  } else {
    reactions[msgId][emoji]++;
    pill.classList.add('active');
    pill.animate([{transform:'scale(1)'},{transform:'scale(1.25)'},{transform:'scale(1)'}], {duration:300, easing:'ease-out'});
  }
  if (countEl) countEl.textContent = reactions[msgId][emoji] || '';
}

// ── Pin Messages ──────────────────────────────────────────────────
function togglePin(msgId, text, btn) {
  const bubble = btn.closest('.bubble');
  const isPinned = bubble.classList.contains('pinned');
  if (isPinned) {
    bubble.classList.remove('pinned');
    btn.classList.remove('pin-active');
    pinnedMessages = pinnedMessages.filter(p => p.id !== msgId);
  } else {
    bubble.classList.add('pinned');
    btn.classList.add('pin-active');
    const shortText = text.slice(0, 80).replace(/\n/g, ' ');
    pinnedMessages.push({ id: msgId, text: shortText });
  }
  renderPinnedPanel();
}

function renderPinnedPanel() {
  const panel = document.getElementById('pinnedPanel');
  const list  = document.getElementById('pinnedList');
  if (!pinnedMessages.length) { panel.classList.remove('visible'); return; }
  panel.classList.add('visible');
  list.innerHTML = pinnedMessages.map(p =>
    `<div class="pinned-item" title="${p.text}">📌 ${p.text}${p.text.length >= 80 ? '…' : ''}</div>`
  ).join('');
}

// ── Search ────────────────────────────────────────────────────────
function openSearch() {
  const overlay = document.getElementById('searchOverlay');
  overlay.classList.add('open');
  setTimeout(() => document.getElementById('searchInput').focus(), 100);
  performSearch('');
}

function closeSearch() {
  document.getElementById('searchOverlay').classList.remove('open');
  document.getElementById('searchInput').value = '';
}

function performSearch(query) {
  const results  = document.getElementById('searchResults');
  const messages = conversationHistory;
  if (!messages.length) {
    results.innerHTML = '<div class="search-empty">NO MESSAGES TO SEARCH</div>';
    return;
  }
  const q = query.toLowerCase().trim();
  const filtered = q ? messages.filter(m => m.content.toLowerCase().includes(q)) : messages;
  if (!filtered.length) {
    results.innerHTML = `<div class="search-empty">NO RESULTS FOR "${query.toUpperCase()}"</div>`;
    return;
  }
  results.innerHTML = filtered.map((m) => {
    const role = m.role === 'assistant' ? '◈ LUNA' : '◈ YOU';
    let preview = m.content.slice(0, 120).replace(/\*\*/g,'').replace(/\*/g,'');
    if (q) {
      const idx = preview.toLowerCase().indexOf(q);
      if (idx >= 0) {
        preview = preview.slice(0, idx) + `<mark>${preview.slice(idx, idx + q.length)}</mark>` + preview.slice(idx + q.length);
      }
    }
    return `
      <div class="search-result-item" onclick="jumpToMessage(${messages.indexOf(m)})">
        <div class="sr-role">${role} · Message ${messages.indexOf(m) + 1}</div>
        <div class="sr-text">${preview}${m.content.length > 120 ? '…' : ''}</div>
      </div>
    `;
  }).join('');
}

function jumpToMessage(idx) {
  const allMessages = chatFeed.querySelectorAll('.message');
  if (allMessages[idx]) {
    allMessages[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    allMessages[idx].style.outline = '1px solid var(--violet-bright)';
    setTimeout(() => { allMessages[idx].style.outline = ''; }, 2000);
  }
  closeSearch();
}

document.getElementById('searchInput')?.addEventListener('input', e => {
  performSearch(e.target.value);
});

// ── Regenerate ────────────────────────────────────────────────────
async function regenerateResponse() {
  if (isTyping || !lastUserText) { showToast('Nothing to regenerate yet.', '◈'); return; }
  const messages = chatFeed.querySelectorAll('.message.luna');
  const last = messages[messages.length - 1];
  if (last) last.remove();
  if (conversationHistory.length && conversationHistory[conversationHistory.length - 1].role === 'assistant') {
    conversationHistory.pop();
  }
  showToast('Regenerating response ✦', '🔄');
  isTyping = true; sendBtn.disabled = true;
  showTyping();
  try {
    const reply = await getLunaResponse(lastUserText);
    pushToHistory(lastUserText, reply);
    hideTyping();
    lastLunaText = reply;
    await appendMessage('luna', reply);
  } catch (err) {
    hideTyping();
    await appendMessage('luna', `◈ Regeneration failed. ${err.message || 'Please try again.'} ✦`);
  }
  isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly();
}

// ── URL detection ─────────────────────────────────────────────────
function extractURL(text) {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

// ══════════════════════════════════════════════════════════════════
// ◈ LINK SAFETY SYSTEM
// ══════════════════════════════════════════════════════════════════

// Known safe CDNs / popular safe domains (allow-list — skip safety UI for these)
const LINK_SAFE_DOMAINS = new Set([
  'github.com','github.io','githubusercontent.com',
  'stackoverflow.com','stackexchange.com',
  'wikipedia.org','wikimedia.org',
  'youtube.com','youtu.be',
  'google.com','drive.google.com','docs.google.com','sheets.google.com',
  'reddit.com',
  'medium.com',
  'npmjs.com','pypi.org',
  'developer.mozilla.org','mdn.io',
  'arxiv.org','scholar.google.com',
  'twitter.com','x.com',
  'linkedin.com',
  'cloudflare.com',
  'anthropic.com','openai.com',
  'firebase.google.com','firebaseapp.com',
]);

// Patterns that indicate malicious / phishing / dangerous URLs
const LINK_DANGER_PATTERNS = [
  // IP address URLs (often used for C&C or phishing)
  /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  // Localhost / internal network
  /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/,
  // Known malware / phishing TLDs abuse patterns
  /\.(tk|ml|ga|cf|gq|xyz|top|click|loan|work|party|win|review|country|stream|download|racing|bid|men|science|trade|date|faith|accountant|cricket|webcam|bar|gdn)\/?$/i,
  // Suspicious keywords in URL path
  /\/(payload|shell|exploit|malware|ransomware|keylog|backdoor|rat|trojan|dropper|inject|phish|steal|bypass|hack|crack|dump|loader|binder)\b/i,
  // URL shorteners (unknown destination — require warning)
  /^https?:\/\/(bit\.ly|tinyurl\.com|t\.co|ow\.ly|goo\.gl|short\.io|rb\.gy|cutt\.ly|is\.gd|tiny\.cc|adf\.ly|bc\.vc|shorte\.st)\//i,
  // Executable file downloads
  /\.(exe|bat|cmd|ps1|vbs|js|msi|dll|apk|dmg|sh|run|bin|scr|pif|com)\s*(\?|$)/i,
  // Data URIs (can run code)
  /^data:/i,
  // Javascript protocol
  /^javascript:/i,
];

// Patterns that mean we should WARN but still allow (user must confirm)
const LINK_WARN_PATTERNS = [
  // URL shorteners
  /^https?:\/\/(bit\.ly|tinyurl\.com|t\.co|ow\.ly|goo\.gl|short\.io|rb\.gy|cutt\.ly|is\.gd|tiny\.cc|adf\.ly|bc\.vc|shorte\.st)\//i,
  // Suspicious TLDs
  /\.(tk|ml|ga|cf|gq)\/?$/i,
  // Unusual ports
  /:\d{4,5}\//,
  // Very long URLs (often obfuscated)
  /.{300,}/,
];

/**
 * Classify a URL as 'safe' | 'warn' | 'block'
 * Returns { verdict, reason }
 */
function classifyURL(url) {
  // javascript: / data: = always block
  if (/^(javascript:|data:)/i.test(url)) {
    return { verdict: 'block', reason: 'This link uses a dangerous protocol (`javascript:` or `data:`) and has been blocked for your safety.' };
  }
  // Localhost / internal = always block
  if (/^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(url)) {
    return { verdict: 'block', reason: 'This link points to an internal/local network address and has been blocked.' };
  }

  let hostname = '';
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch { return { verdict: 'block', reason: 'Malformed URL — could not parse.' }; }

  // Check allow-list (known safe domains — skip further checks)
  for (const safe of LINK_SAFE_DOMAINS) {
    if (hostname === safe || hostname.endsWith('.' + safe)) {
      return { verdict: 'safe', reason: '' };
    }
  }

  // Hard block patterns
  for (const pat of LINK_DANGER_PATTERNS) {
    if (pat.test(url)) {
      // URL shorteners are warn not block
      if (/^https?:\/\/(bit\.ly|tinyurl\.com|t\.co|ow\.ly|goo\.gl|short\.io|rb\.gy|cutt\.ly|is\.gd|tiny\.cc|adf\.ly|bc\.vc|shorte\.st)\//i.test(url)) {
        return { verdict: 'warn', reason: `This is a shortened URL — the real destination is hidden. It may or may not be safe.` };
      }
      return { verdict: 'block', reason: `This link has been blocked — it matches a known dangerous pattern (suspicious domain, extension, or path).` };
    }
  }

  // Warn patterns
  for (const pat of LINK_WARN_PATTERNS) {
    if (pat.test(url)) {
      return { verdict: 'warn', reason: `Luna detected this link may be unusual or potentially risky. Proceed with caution.` };
    }
  }

  // Unknown but not in deny list → warn (default-deny unknown)
  return { verdict: 'warn', reason: `Luna doesn't recognize this domain. Make sure you trust the source before proceeding.` };
}

/**
 * Show a safety modal and return a Promise<boolean> — true if user allows, false if blocked
 */
function showLinkSafetyModal(url, verdict, reason) {
  return new Promise(resolve => {
    const existing = document.getElementById('linkSafetyModal');
    if (existing) existing.remove();

    const isBlock = verdict === 'block';
    const overlay = document.createElement('div');
    overlay.id = 'linkSafetyModal';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99998;
      background:rgba(2,2,9,0.88);
      display:flex;align-items:center;justify-content:center;
      animation:fadeIn 0.2s ease;
    `;

    const accentColor = isBlock ? 'var(--crimson-bright)' : 'var(--gold)';
    const iconEmoji   = isBlock ? '🚫' : '⚠️';
    const title       = isBlock ? '◈ LINK BLOCKED' : '◈ LINK WARNING';

    overlay.innerHTML = `
      <div style="
        background:var(--card);
        border:1px solid ${isBlock ? 'var(--border-red)' : 'rgba(251,191,36,0.4)'};
        border-top:2px solid ${accentColor};
        border-radius:var(--r-lg);
        padding:28px 26px 22px;
        max-width:440px;width:92%;
        display:flex;flex-direction:column;gap:16px;
        box-shadow:0 24px 72px rgba(0,0,0,0.75),0 0 40px ${isBlock ? 'var(--crimson-glow)' : 'rgba(251,191,36,0.2)'};
        animation:slideUpBox 0.28s var(--spring) both;
        position:relative;
      ">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="
            width:40px;height:40px;border-radius:50%;flex-shrink:0;
            background:${isBlock ? 'rgba(236,45,90,0.15)' : 'rgba(251,191,36,0.12)'};
            border:1px solid ${isBlock ? 'var(--border-red)' : 'rgba(251,191,36,0.4)'};
            display:flex;align-items:center;justify-content:center;font-size:18px;
          ">${iconEmoji}</div>
          <div>
            <div style="font-family:var(--font-hud);font-size:11px;letter-spacing:0.22em;color:${accentColor};">${title}</div>
            <div style="font-size:11px;color:var(--text-lo);margin-top:2px;font-family:var(--font-hud);letter-spacing:0.08em;">LUNA LINK SAFETY SCANNER</div>
          </div>
        </div>

        <div style="
          background:rgba(255,255,255,0.03);
          border:1px solid rgba(255,255,255,0.07);
          border-radius:var(--r-sm);
          padding:10px 12px;
          word-break:break-all;
          font-family:var(--font-mono);font-size:11px;
          color:var(--text-mid);line-height:1.5;
          max-height:72px;overflow-y:auto;
        ">${escHtml(url)}</div>

        <div style="font-size:13px;color:${isBlock ? 'var(--crimson-bright)' : 'var(--gold)'};line-height:1.6;">
          ${escHtml(reason)}
        </div>

        <div style="display:flex;gap:10px;margin-top:4px;">
          ${isBlock ? `
            <button onclick="document.getElementById('linkSafetyModal').remove();" style="
              flex:1;padding:12px 0;
              background:var(--crimson-dim);border:1px solid var(--border-red);
              border-radius:var(--r-sm);color:var(--crimson-bright);
              font-family:var(--font-hud);font-size:10px;letter-spacing:0.16em;
              cursor:pointer;transition:all 0.18s;
            ">◈ OK, UNDERSTOOD</button>
          ` : `
            <button id="lsm-cancel" style="
              flex:1;padding:12px 0;
              background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);
              border-radius:var(--r-sm);color:var(--text-mid);
              font-family:var(--font-hud);font-size:10px;letter-spacing:0.16em;
              cursor:pointer;transition:all 0.18s;
            ">✕ CANCEL</button>
            <button id="lsm-proceed" style="
              flex:1;padding:12px 0;
              background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.4);
              border-radius:var(--r-sm);color:var(--gold);
              font-family:var(--font-hud);font-size:10px;letter-spacing:0.16em;
              cursor:pointer;transition:all 0.18s;
            ">→ PROCEED ANYWAY</button>
          `}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    if (isBlock) {
      resolve(false);
      return;
    }

    // Warn mode — user decides
    document.getElementById('lsm-cancel').addEventListener('click', () => {
      overlay.remove(); resolve(false);
    });
    document.getElementById('lsm-proceed').addEventListener('click', () => {
      overlay.remove(); resolve(true);
    });
    // Click outside to cancel
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
  });
}

// ── Fetch webpage (safe) ──────────────────────────────────────────
async function fetchWebpage(url) {
  // Try allorigins first, then a CORS-anywhere fallback
  const proxyURL = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  let res;
  try {
    res = await fetch(proxyURL, { signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('Network error — could not reach the link proxy.');
  }
  if (!res.ok) throw new Error('Could not fetch the webpage (proxy returned an error).');
  const data = await res.json();
  if (!data.contents) throw new Error('Page returned no readable content.');
  const div  = document.createElement('div');
  div.innerHTML = data.contents;
  // Remove script/style noise
  div.querySelectorAll('script,style,noscript,nav,footer,header,aside').forEach(el => el.remove());
  const text = (div.innerText || div.textContent || '').replace(/\s+/g,' ').trim();
  if (!text || text.length < 20) throw new Error('Page has no readable text content.');
  return text.slice(0, 4000); // slightly more context
}

// ── Read uploaded file ────────────────────────────────────────────
async function readFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['txt','md','csv','json'].includes(ext)) return await file.text();
  if (ext === 'pdf') {
    const pdfjsLib = window['pdfjs-dist/build/pdf'];
    if (!pdfjsLib) throw new Error('PDF reader not loaded yet. Please try again.');
    const ab  = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
    let text  = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
      const page = await pdf.getPage(i);
      const c    = await page.getTextContent();
      text += c.items.map(s => s.str).join(' ') + '\n';
    }
    return text.trim().slice(0,3000);
  }
  if (ext === 'docx') {
    const mammoth = window.mammoth;
    if (!mammoth) throw new Error('DOCX reader not loaded yet. Please try again.');
    const ab  = await file.arrayBuffer();
    const res = await mammoth.extractRawText({ arrayBuffer: ab });
    return res.value.trim().slice(0,3000);
  }
  throw new Error(`File type .${ext} is not supported. Supported: .txt .pdf .docx .md .csv .json`);
}

// ── Stage files ───────────────────────────────────────────────────
function stageFiles(files) {
  stagedFiles = files;
  const badge = document.getElementById('fileBadge');
  document.getElementById('fileBadgeName').textContent = files.map(f => '📎 ' + f.name).join('   ');
  badge.style.display = 'flex';
  userInput.focus();
}

// ── Shared: compress & stage any image File object ────────────────
function stageImageFromFile(file, sourceLabel = '📸 Image ready') {
  const reader = new FileReader();
  reader.onload = ev => {
    const orig = ev.target.result;
    const img  = new Image();
    img.onload = () => {
      const c2   = document.createElement('canvas');
      const maxW = 1280, scale = img.width > maxW ? maxW / img.width : 1;
      c2.width   = Math.round(img.width  * scale);
      c2.height  = Math.round(img.height * scale);
      c2.getContext('2d').drawImage(img, 0, 0, c2.width, c2.height);
      const dataURL = c2.toDataURL('image/jpeg', 0.85);
      stagedImage   = { base64: dataURL.split(',')[1], mimeType: 'image/jpeg', objectURL: dataURL };
      const thumb   = document.getElementById('imageBadgeThumb');
      const label   = document.getElementById('imageBadgeLabel');
      const badge   = document.getElementById('imageBadge');
      if (thumb) thumb.src = dataURL;
      if (label) label.textContent = sourceLabel + ' — add a message or send as-is';
      if (badge) badge.style.display = 'flex';
      sendBtn.disabled = false;
      userInput.focus();
    };
    img.src = orig;
  };
  reader.readAsDataURL(file);
}

// ── Inject file upload ────────────────────────────────────────────
function injectFileUpload() {
  const pdfScript = document.createElement('script');
  pdfScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  pdfScript.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; };
  document.head.appendChild(pdfScript);
  const mamScript = document.createElement('script');
  mamScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
  document.head.appendChild(mamScript);

  // ── Hidden inputs ──────────────────────────────────────────────
  // Document file input
  const fileInput    = document.createElement('input');
  fileInput.type     = 'file';
  fileInput.id       = 'fileInput';
  fileInput.accept   = '.txt,.pdf,.docx,.md,.csv,.json';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  // Image gallery picker
  const imageInput   = document.createElement('input');
  imageInput.type    = 'file';
  imageInput.id      = 'imageGalleryInput';
  imageInput.accept  = 'image/*';
  imageInput.style.display = 'none';
  document.body.appendChild(imageInput);

  // Camera capture (mobile: opens camera directly; desktop: file picker fallback)
  const cameraInput  = document.createElement('input');
  cameraInput.type   = 'file';
  cameraInput.id     = 'cameraInput';
  cameraInput.accept = 'image/*';
  cameraInput.setAttribute('capture', 'environment');
  cameraInput.style.display = 'none';
  document.body.appendChild(cameraInput);

  // ── + Tray: mic · file · image · camera · quick-emoji ──────────
  // All attachment & emoji options live inside a popup tray triggered
  // by the single "+" button in the input bar. No buttons clutter the bar.
  (function setupPlusTray() {
    const inputActions = sendBtn.parentNode;
    const voiceBtnEl   = document.getElementById('voiceBtn');
    if (!inputActions) return;

    // ── Tray styles ─────────────────────────────────────────────────
    const st = document.createElement('style');
    st.textContent = `
      /* + toggle */
      #mobileToggleBtn {
        flex-shrink: 0;
        font-size: 20px; font-weight: 300; line-height: 1;
        transition: transform 0.22s cubic-bezier(0.34,1.56,0.64,1), background 0.15s;
      }
      #mobileToggleBtn.tray-open {
        transform: rotate(45deg);
        background: var(--violet-dim);
        border-color: var(--border);
        color: var(--violet-bright);
      }

      /* Popup tray — fixed to viewport, escapes backdrop-filter stacking context */
      #plusTrayPopup {
        display: none;
        position: fixed;
        background: var(--card, #090920);
        border: 1px solid var(--border, rgba(168,85,247,0.22));
        border-radius: 16px;
        padding: 14px 14px 12px;
        box-shadow: 0 10px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(168,85,247,0.06);
        z-index: 9999;
        flex-direction: column;
        gap: 12px;
        animation: trayUp 0.2s cubic-bezier(0.34,1.56,0.64,1) both;
      }
      #plusTrayPopup.open { display: flex; }
      @keyframes trayUp {
        from { opacity:0; transform:translateY(8px) scale(0.98); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }

      /* Section label */
      .pts-label {
        font-family: var(--font-hud, monospace);
        font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase;
        color: var(--text-lo, #3d3060); margin-bottom: 6px;
        user-select: none;
      }

      /* Action row: 4 big icon+label buttons */
      #ptsActionRow {
        display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
      }
      .pts-action-btn {
        display: flex; flex-direction: column; align-items: center; gap: 5px;
        background: rgba(168,85,247,0.06);
        border: 1px solid rgba(168,85,247,0.14);
        border-radius: 12px; padding: 10px 4px 8px;
        cursor: pointer; transition: background 0.15s, border-color 0.15s, transform 0.12s;
        color: var(--text-mid, #9580b5);
        -webkit-tap-highlight-color: transparent;
      }
      .pts-action-btn:hover  {
        background: rgba(168,85,247,0.14); border-color: rgba(168,85,247,0.35);
        color: var(--violet-bright, #a855f7);
      }
      .pts-action-btn:active { transform: scale(0.94); }
      .pts-action-btn svg    { display: block; }
      .pts-action-lbl {
        font-family: var(--font-hud, monospace);
        font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase;
        color: var(--text-lo, #3d3060); line-height: 1;
      }

      /* Emoji row */
      #ptsEmojiRow {
        display: flex; gap: 2px;
        overflow-x: auto; scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
        padding-bottom: 2px;
      }
      #ptsEmojiRow::-webkit-scrollbar { display: none; }
      .pts-emoji-btn {
        flex-shrink: 0; width: 36px; height: 36px;
        border: none; background: transparent; border-radius: 9px;
        font-size: 21px; cursor: pointer; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.1s, transform 0.1s;
        -webkit-tap-highlight-color: transparent;
      }
      .pts-emoji-btn:hover  { background: rgba(168,85,247,0.1); }
      .pts-emoji-btn:active { background: rgba(168,85,247,0.2); transform: scale(1.28); }
    `;
    document.head.appendChild(st);

    // ── Helper to build an action button ───────────────────────────
    function makeActionBtn(svgStr, label, onClick) {
      const b = document.createElement('button');
      b.className = 'pts-action-btn';
      b.innerHTML = `${svgStr}<span class="pts-action-lbl">${label}</span>`;
      b.addEventListener('click', () => { closeTray(); onClick(); });
      return b;
    }

    // ── Tray popup ─────────────────────────────────────────────────
    const tray = document.createElement('div');
    tray.id = 'plusTrayPopup';

    // ── Section 1: Attach ──────────────────────────────────────────
    const sec1 = document.createElement('div');
    const lbl1 = document.createElement('div');
    lbl1.className = 'pts-label'; lbl1.textContent = 'Attach';
    sec1.appendChild(lbl1);

    const actionRow = document.createElement('div');
    actionRow.id = 'ptsActionRow';

    const SVG_MIC    = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    const SVG_FILE   = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>`;
    const SVG_IMAGE  = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    const SVG_CAMERA = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;

    const micAction    = makeActionBtn(SVG_MIC,    'Voice',  () => { if (typeof toggleVoice === 'function') toggleVoice(); });
    const fileAction   = makeActionBtn(SVG_FILE,   'File',   () => fileInput.click());
    const imageAction  = makeActionBtn(SVG_IMAGE,  'Image',  () => imageInput.click());
    const cameraAction = makeActionBtn(SVG_CAMERA, 'Camera', () => cameraInput.click());

    [micAction, fileAction, imageAction, cameraAction].forEach(b => actionRow.appendChild(b));
    sec1.appendChild(actionRow);
    tray.appendChild(sec1);

    // ── Section 2: Quick Emoji ─────────────────────────────────────
    const sec2 = document.createElement('div');
    const lbl2 = document.createElement('div');
    lbl2.className = 'pts-label'; lbl2.textContent = 'Quick Emoji';
    sec2.appendChild(lbl2);

    const emojiRow = document.createElement('div');
    emojiRow.id = 'ptsEmojiRow';

    const DEFAULT_EMOJI = ['❤️','😊','😂','🙏','✨','😭','🥺','👀','💀','🔥','😍','💪'];
    const EM_KEY = 'luna_emoji_freq';
    function getEmojiFreq() { try { return JSON.parse(localStorage.getItem(EM_KEY)||'{}'); } catch { return {}; } }
    function bumpEmoji(e)   { const m=getEmojiFreq(); m[e]=(m[e]||0)+1; try{localStorage.setItem(EM_KEY,JSON.stringify(m));}catch{} }
    function getSortedEmoji(){ const m=getEmojiFreq(); return [...DEFAULT_EMOJI].sort((a,b)=>(m[b]||0)-(m[a]||0)); }

    function renderEmoji() {
      emojiRow.innerHTML = '';
      getSortedEmoji().forEach(emoji => {
        const b = document.createElement('button');
        b.className = 'pts-emoji-btn';
        b.textContent = emoji;
        b.tabIndex = -1;
        b.addEventListener('click', () => {
          if (typeof haptic === 'function') haptic('light');
          const inp = document.getElementById('userInput');
          if (!inp) return;
          const pos = inp.selectionStart ?? inp.value.length;
          inp.value = inp.value.slice(0, pos) + emoji + inp.value.slice(pos);
          inp.setSelectionRange(pos + emoji.length, pos + emoji.length);
          inp.focus();
          bumpEmoji(emoji);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          closeTray();
        });
        emojiRow.appendChild(b);
      });
    }
    renderEmoji();
    sec2.appendChild(emojiRow);
    tray.appendChild(sec2);

    // ── Tray must be a child of <body> to escape the backdrop-filter stacking context
    // on .input-zone. We position it dynamically with getBoundingClientRect().
    tray.style.cssText += 'position:fixed;left:0;right:0;bottom:0;width:auto;';
    document.body.appendChild(tray);

    // ── + toggle button in the input bar ──────────────────────────
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'icon-btn';
    toggleBtn.id        = 'mobileToggleBtn';
    toggleBtn.title     = 'More options';
    toggleBtn.textContent = '+';
    toggleBtn.style.cssText = 'font-size:20px;font-weight:300;line-height:1;flex-shrink:0;';
    // Insert as the very first child of input-actions
    inputActions.insertBefore(toggleBtn, inputActions.firstChild);

    // Remove original standalone buttons from bar (they are now in the tray)
    [voiceBtnEl, document.getElementById('emojiPickerBtn')].forEach(btn => {
      if (btn && btn.parentNode === inputActions) btn.parentNode.removeChild(btn);
    });

    // ── Position tray just above the input bar using fixed coords ──
    function positionTray() {
      const inputBox = document.getElementById('inputBox') || inputActions.closest('.input-box');
      if (!inputBox) return;
      const rect = inputBox.getBoundingClientRect();
      const margin = 10;
      tray.style.left   = rect.left + 'px';
      tray.style.right  = (window.innerWidth - rect.right) + 'px';
      tray.style.bottom = (window.innerHeight - rect.top + margin) + 'px';
      tray.style.width  = 'auto';
    }

    let trayOpen = false;
    function openTray()  {
      trayOpen = true;
      renderEmoji();
      positionTray();
      tray.classList.add('open');
      toggleBtn.classList.add('tray-open');
    }
    function closeTray() {
      trayOpen = false;
      tray.classList.remove('open');
      toggleBtn.classList.remove('tray-open');
    }

    toggleBtn.addEventListener('click', () => trayOpen ? closeTray() : openTray());
    window.addEventListener('resize', () => { if (trayOpen) positionTray(); }, { passive: true });
    document.addEventListener('pointerdown', e => {
      if (trayOpen && !tray.contains(e.target) && e.target !== toggleBtn) closeTray();
    }, { passive: true });
  })();

  // (uploadBtn / galleryBtn / cameraBtn refs kept as null — tray handles them)
  const uploadBtn = null, galleryBtn = null, cameraBtn = null;

  // ── File badge (documents) — reuse element already in HTML ───────
  let fileBadge = document.getElementById('fileBadge');
  if (!fileBadge) {
    fileBadge = document.createElement('div');
    fileBadge.id = 'fileBadge';
    fileBadge.style.cssText = 'display:none;align-items:center;gap:8px;background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.28);border-radius:8px;padding:6px 12px;font-size:12px;color:var(--crimson-bright);margin-bottom:7px;font-family:var(--font-body)';
    fileBadge.innerHTML = '<span id="fileBadgeName"></span><button id="fileBadgeRemove" style="margin-left:auto;background:none;border:none;color:#ff4466;cursor:pointer;font-size:15px;line-height:1">✕</button>';
    document.querySelector('.input-box').parentNode.insertBefore(fileBadge, document.querySelector('.input-box'));
  }

  document.getElementById('fileBadgeRemove').addEventListener('click', () => {
    stagedFiles = [];
    fileBadge.style.display = 'none';
    fileInput.value = '';
    userInput.focus();
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    if (!files.length) return;
    stageFiles(files);
    fileInput.value = '';
  });

  // ── Image badge (photos) — reuse element already in HTML ──────
  let imageBadge = document.getElementById('imageBadge');
  if (!imageBadge) {
    imageBadge = document.createElement('div');
    imageBadge.id = 'imageBadge';
    imageBadge.style.cssText = 'display:none;align-items:center;gap:10px;background:rgba(168,85,247,0.07);border:1px solid rgba(168,85,247,0.28);border-radius:8px;padding:6px 12px;font-size:12px;color:var(--violet-bright);margin-bottom:7px;';
    imageBadge.innerHTML = `
      <img id="imageBadgeThumb" style="height:40px;width:auto;max-width:60px;border-radius:5px;object-fit:cover;border:1px solid rgba(168,85,247,0.3);cursor:pointer;" title="Click to preview" />
      <span id="imageBadgeLabel" style="flex:1;">📸 Image ready — add a message or send as-is</span>
      <button id="imageBadgeRemove" title="Remove image" style="background:none;border:none;color:var(--crimson-bright);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;opacity:0.7;transition:opacity 0.15s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">✕</button>`;
    fileBadge.parentNode.insertBefore(imageBadge, fileBadge);
  }

  document.getElementById('imageBadgeRemove').addEventListener('click', () => {
    clearStagedImage();
    imageInput.value  = '';
    cameraInput.value = '';
    userInput.focus();
  });

  // Thumbnail click → full preview modal
  document.getElementById('imageBadgeThumb').addEventListener('click', () => {
    if (!stagedImage) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;cursor:zoom-out;animation:fadeIn 0.2s ease;';
    overlay.innerHTML = `<img src="${stagedImage.objectURL}" style="max-width:92vw;max-height:88vh;border-radius:12px;box-shadow:0 8px 60px rgba(0,0,0,0.8);border:1px solid rgba(168,85,247,0.3);">`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  });

  // ── Wire up new image inputs ───────────────────────────────────
  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (!file) return;
    stageImageFromFile(file, '🖼️ Image from gallery');
    imageInput.value = '';
  });

  cameraInput.addEventListener('change', () => {
    const file = cameraInput.files[0];
    if (!file) return;
    stageImageFromFile(file, '📷 Camera photo');
    cameraInput.value = '';
  });

  // ── Paste image ────────────────────────────────────────────────
  function handlePasteImage(e) {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        stageImageFromFile(file, '📋 Pasted image');
        break;
      }
    }
  }
  userInput.addEventListener('paste', handlePasteImage);
  document.addEventListener('paste', e => {
    const tag = document.activeElement.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') handlePasteImage(e);
    else if (document.activeElement === userInput) handlePasteImage(e);
  });

  // ── Drag & drop ────────────────────────────────────────────────
  const dragOverlay = document.getElementById('dragOverlay');
  let dragCounter = 0;
  document.addEventListener('dragenter', e => {
    const hasFiles = Array.from(e.dataTransfer?.types || []).includes('Files');
    if (hasFiles) { dragCounter++; dragOverlay.classList.add('active'); }
  });
  document.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dragOverlay.classList.remove('active'); }
  });
  document.addEventListener('dragover', e => { e.preventDefault(); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('active');
    const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length) {
      stageImageFromFile(imageFiles[0], '🖼️ Dropped image');
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter(f => /\.(txt|pdf|docx|md|csv|json)$/i.test(f.name));
    if (files.length) stageFiles(files);
  });
}

function clearStagedImage() {
  stagedImage = null;
  const b = document.getElementById('imageBadge');
  if (b) b.style.display = 'none';
  const t = document.getElementById('imageBadgeThumb');
  if (t) t.src = '';
}

// ── Markdown formatter ────────────────────────────────────────────
function renderMath(el) {
  if (typeof renderMathInElement !== 'undefined') {
    renderMathInElement(el, {
      delimiters: [
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false },
      ],
      throwOnError: false
    });
  } else {
    // KaTeX not ready yet — retry after a short delay
    setTimeout(() => renderMath(el), 300);
  }
}

function formatMarkdown(raw) {
  // ── Phase 0: Extract math blocks to protect them from HTML-escaping and link parsing ──
  const mathBlocks = [];
  // Display math: \[...\]
  let s = raw.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => {
    const id = 'mb_' + Math.random().toString(36).slice(2,9);
    mathBlocks.push({ id, display: true, content: inner });
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  // Inline math: \(...\)
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => {
    const id = 'mi_' + Math.random().toString(36).slice(2,9);
    mathBlocks.push({ id, display: false, content: inner });
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  // Display math: $$...$$
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => {
    const id = 'md_' + Math.random().toString(36).slice(2,9);
    mathBlocks.push({ id, display: true, content: inner });
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });

  // ── Phase 1: Extract code blocks to protect them ──────────────────
  const codeBlocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb_' + Math.random().toString(36).slice(2,9);
    const label = lang || 'code';
    const highlighted = highlightCode(code.trim(), lang);
    const html = `<div class="code-block"><div class="code-header"><span class="code-lang">${label.toUpperCase()}</span><button class="code-copy" onclick="copyCode('${id}')">COPY</button></div><pre id="${id}"><code>${highlighted}</code></pre></div>`;
    codeBlocks.push(html);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // ── Phase 2: HTML-escape ───────────────────────────────────────────
  s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // ── Phase 3: Inline code ───────────────────────────────────────────
  s = s.replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>');

  // ── Phase 4: Links ─────────────────────────────────────────────────
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--violet-bright);text-decoration:underline;text-underline-offset:2px;word-break:break-all;">${text}</a>`);
  s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<"&)]+)/g, (_, before, url) =>
    `${before}<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--violet-bright);text-decoration:underline;text-underline-offset:2px;word-break:break-all;">${url}</a>`);

  // Helper: apply bold/italic to a single text string
  function inlineFormat(t) {
    return t
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }

  // ── Phase 5: Line-by-line rendering (bold/italic applied per-line) ─
  const lines = s.split('\n');
  const out = [];
  let inUL = false, inOL = false, inTable = false;
  let tableRows = [];

  const closeUL    = () => { if (inUL)    { out.push('</ul>');  inUL    = false; } };
  const closeOL    = () => { if (inOL)    { out.push('</ol>');  inOL    = false; } };
  const flushTable = () => {
    if (!inTable || tableRows.length === 0) return;
    inTable = false;
    const [headerRow, ...bodyRows] = tableRows;
    tableRows = [];

    const hJoined = headerRow.join('|').toLowerCase();
    const isJournalTable = (hJoined.includes('debit') && hJoined.includes('credit'))
      || (hJoined.includes('date') && hJoined.includes('account'));

    if (isJournalTable) {
      const hLow     = headerRow.map(h => h.toLowerCase().trim());
      const idxDate  = hLow.findIndex(h => h.includes('date'));
      const idxAcct  = hLow.findIndex(h => h.includes('account') || h.includes('title') || h.includes('explanation') || h.includes('particulars'));
      const idxRef   = hLow.findIndex(h => h.includes('ref') || h === 'pr' || h === 'f' || h.includes('post'));
      const idxDebit = hLow.findIndex(h => h.includes('debit') || h === 'dr');
      const idxCredit= hLow.findIndex(h => h.includes('credit') || h === 'cr');

      const thDate   = idxDate   >= 0 ? `<th class="jt-col-date">${headerRow[idxDate]}</th>`   : '';
      const thAcct   = idxAcct   >= 0 ? `<th class="jt-col-acct">${headerRow[idxAcct]}</th>`   : '';
      const thRef    = idxRef    >= 0 ? `<th class="jt-col-ref">${headerRow[idxRef]}</th>`     : '';
      const thDebit  = idxDebit  >= 0 ? `<th class="jt-col-num">${headerRow[idxDebit]}</th>`   : '';
      const thCredit = idxCredit >= 0 ? `<th class="jt-col-num">${headerRow[idxCredit]}</th>`  : '';

      let bodyHtml = '';
      let lastDate = '';
      let prevWasExpl = true;

      function fmtNum(v) {
        if (!v) return '';
        const clean = v.replace(/,/g, '');
        if (!isNaN(clean) && clean !== '') {
          return parseFloat(clean).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        return inlineFormat(v);
      }

      for (let ri = 0; ri < bodyRows.length; ri++) {
        const row = bodyRows[ri];
        const cellDate   = idxDate   >= 0 ? (row[idxDate]   || '').trim() : '';
        const cellAcct   = idxAcct   >= 0 ? (row[idxAcct]   || '').trim() : '';
        const cellRef    = idxRef    >= 0 ? (row[idxRef]    || '').trim() : '';
        const cellDebit  = idxDebit  >= 0 ? (row[idxDebit]  || '').trim() : '';
        const cellCredit = idxCredit >= 0 ? (row[idxCredit] || '').trim() : '';

        const acctLow = cellAcct.toLowerCase();
        const isTotals = acctLow.includes('total');
        const isExpl = !isTotals && !cellDebit && !cellCredit && cellAcct
          && (cellAcct.toLowerCase().startsWith('to ') || cellAcct.startsWith('(') || (!cellDate && !cellDebit && !cellCredit));
        const isCreditEntry = !isTotals && !isExpl && !cellDebit && !!cellCredit;

        const displayDate = (cellDate && cellDate !== lastDate) ? cellDate : '';
        if (cellDate) lastDate = cellDate;
        const isGroupStart = !!displayDate && !prevWasExpl;

        let rowClass = 'jt-row';
        if (isTotals)           rowClass += ' jt-row-total';
        else if (isCreditEntry) rowClass += ' jt-row-credit';
        else if (isExpl)        rowClass += ' jt-row-expl';
        if (isGroupStart)       rowClass += ' jt-group-start';

        const acctDisplay = isTotals
          ? `<strong>${inlineFormat(cellAcct)}</strong>`
          : isCreditEntry
            ? `<span class="jt-indent">${inlineFormat(cellAcct)}</span>`
            : isExpl
              ? `<em class="jt-expl-text">${inlineFormat(cellAcct)}</em>`
              : `<span class="jt-debit-acct">${inlineFormat(cellAcct)}</span>`;

        const debitDisplay  = cellDebit  ? `<span style="color:var(--green);">${fmtNum(cellDebit)}</span>`  : '';
        const creditDisplay = cellCredit ? `<span style="color:var(--accent);">${fmtNum(cellCredit)}</span>` : '';

        bodyHtml += `<tr class="${rowClass}">
          ${idxDate   >= 0 ? `<td class="jt-col-date">${inlineFormat(displayDate)}</td>` : ''}
          ${idxAcct   >= 0 ? `<td class="jt-col-acct">${acctDisplay}</td>` : ''}
          ${idxRef    >= 0 ? `<td class="jt-col-ref">${inlineFormat(cellRef)}</td>` : ''}
          ${idxDebit  >= 0 ? `<td class="jt-col-num jt-debit-col">${debitDisplay}</td>` : ''}
          ${idxCredit >= 0 ? `<td class="jt-col-num jt-credit-col">${creditDisplay}</td>` : ''}
        </tr>`;
        prevWasExpl = isExpl;
      }

      out.push(`<div class="jt-wrap"><table class="journal-table"><thead><tr class="jt-head">${thDate}${thAcct}${thRef}${thDebit}${thCredit}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      return;
    }

    // ── Default generic table ───────────────────────────────────────
    const numericCols = headerRow.map((_, ci) => {
      const vals = bodyRows.map(r => (r[ci] || '').trim().replace(/,/g,''));
      const numCount = vals.filter(v => v !== '' && !isNaN(v)).length;
      return vals.length > 0 && (numCount / vals.length) >= 0.6;
    });

    function fmtCell(v, isNum) {
      if (!isNum) return inlineFormat(v);
      const clean = v.replace(/,/g,'');
      if (!isNaN(clean) && clean !== '') {
        return parseFloat(clean).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return inlineFormat(v);
    }

    const headerCells = headerRow.map((c, ci) =>
      `<th class="${numericCols[ci] ? 'num' : ''}">${inlineFormat(c)}</th>`
    ).join('');

    const bodyHtml = bodyRows.map((row) => {
      const firstCell = (row[0] || '').toLowerCase().trim();
      const isTotals = firstCell.includes('total');
      const rowStyle = isTotals ? ' style="font-weight:700;border-top:2px solid rgba(168,85,247,0.35);"' : '';
      const cells = row.map((c, ci) => {
        const val = c.trim();
        const isNum = numericCols[ci];
        const formatted = fmtCell(val, isNum);
        const align = isNum ? ' class="num"' : '';
        const color = isTotals && isNum ? ' style="color:var(--violet-bright);"' : '';
        return `<td${align}${color}>${formatted}</td>`;
      }).join('');
      return `<tr${rowStyle}>${cells}</tr>`;
    }).join('');

    out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
  };
    const closeLists = () => { closeUL(); closeOL(); };
  const closeAll   = () => { closeLists(); flushTable(); };

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    // ── Table row: starts with | ───────────────────────────────────
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // Skip separator rows like |---|---|
      if (/^\|[\s|:-]+\|$/.test(trimmed)) continue;
      closeLists();
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      if (!inTable) { inTable = true; tableRows = []; }
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // ── Horizontal rule ────────────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeAll();
      out.push('<hr class="md-hr"/>');
      continue;
    }

    // ── ATX Headings: # ## ### ─────────────────────────────────────
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      closeAll();
      const level = headingMatch[1].length;
      out.push(`<div class="md-h${level}">${inlineFormat(headingMatch[2])}</div>`);
      continue;
    }

    // ── Roman numeral sections: I. II. III. ────────────────────────
    const romanMatch = trimmed.match(/^(I{1,3}V?|IV|VI{0,3}|IX|X{0,3})\.\s+(.+)$/i);
    if (romanMatch && /^[IVXivx]+$/.test(romanMatch[1])) {
      closeAll();
      out.push(`<div class="md-roman"><span class="md-roman-num">${romanMatch[1].toUpperCase()}.</span><span class="md-roman-text">${inlineFormat(romanMatch[2])}</span></div>`);
      continue;
    }

    // ── Numbered list ──────────────────────────────────────────────
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      flushTable(); closeUL();
      if (!inOL) { out.push('<ol class="md-ol">'); inOL = true; }
      out.push(`<li><span>${inlineFormat(olMatch[2])}</span></li>`);
      continue;
    }

    // ── Unordered list ─────────────────────────────────────────────
    const ulMatch = trimmed.match(/^[-•*]\s+(.+)$/);
    if (ulMatch) {
      flushTable(); closeOL();
      if (!inUL) { out.push('<ul class="md-ul">'); inUL = true; }
      out.push(`<li><span>${inlineFormat(ulMatch[1])}</span></li>`);
      continue;
    }

    // ── Indented sub-bullet ────────────────────────────────────────
    const subUlMatch = line.match(/^[ \t]{2,}[-•*]\s+(.+)$/);
    if (subUlMatch) {
      if (!inUL && !inOL) { out.push('<ul class="md-ul">'); inUL = true; }
      out.push(`<li class="md-li-sub"><span>${inlineFormat(subUlMatch[1])}</span></li>`);
      continue;
    }

    // ── Empty line ─────────────────────────────────────────────────
    if (trimmed === '') {
      closeAll();
      out.push('<div class="md-spacer"></div>');
      continue;
    }

    // ── Plain text ─────────────────────────────────────────────────
    closeLists();
    out.push(`<span class="md-line">${inlineFormat(line)}</span><br/>`);
  }

  closeAll();
  let result = out.join('');

  // ── Phase 6: Restore code blocks ──────────────────────────────────
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i]);


  // ── Phase 7: Restore math blocks — render with KaTeX inline ────────────────
  result = result.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
    const m = mathBlocks[+i];
    if (!m) return '';
    if (typeof katex !== 'undefined') {
      try {
        const rendered = katex.renderToString(m.content.trim(), {
          displayMode: m.display,
          throwOnError: false,
          output: 'html',
        });
        return m.display
          ? '<div class="katex-display-wrap" style="overflow-x:auto;padding:8px 0;text-align:center;">'  + rendered + '</div>'
          : '<span class="katex-inline-wrap">' + rendered + '</span>';
      } catch(e) {
        return m.display ? '\\['  + m.content + '\\]'  : '\\('  + m.content + '\\)';
      }
    }
    return m.display ? '\\['  + m.content + '\\]'  : '\\('  + m.content + '\\)';
  });

  return result;
}

// ── Simple syntax highlighter ─────────────────────────────────────
function highlightCode(code, lang) {
  if (!lang || lang === 'text' || lang === 'code') return code;
  const keywords = {
    js:     /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|typeof|null|undefined|true|false)\b/g,
    ts:     /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|typeof|null|undefined|true|false|interface|type|enum)\b/g,
    python: /\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|True|False|None|print|self|pass|break|continue|raise|try|except|finally|with|as|lambda|yield)\b/g,
    css:    /\b(display|flex|grid|margin|padding|color|background|border|font|width|height|position|absolute|relative|fixed|sticky|block|inline|none|auto|px|em|rem|vh|vw)\b/g,
  };
  const kw = keywords[lang] || keywords['js'];
  return code
    .replace(/(\/\/.*$)/gm, '<span style="color:#6b7db3;font-style:italic">$1</span>')
    .replace(/(#.*$)/gm, '<span style="color:#6b7db3;font-style:italic">$1</span>')
    .replace(/(".*?"|'.*?'|`.*?`)/g, '<span style="color:#a3e635">$1</span>')
    .replace(kw, '<span style="color:var(--crimson-bright)">$1</span>');
}

// ── Stream Luna message (used for non-live paths: status hits, file/image responses) ──
async function streamLunaMessage(rawText, wrap) {
  const textEl = wrap.querySelector(".bubble-text");
  textEl.innerHTML = formatMarkdown(rawText);
  renderMath(textEl);
  if (!userScrolledUp) scrollDown();
}


// ── Build message bubble ──────────────────────────────────────────
let msgIdCounter = 0;

function buildMessageWrap(role, rawText, stream = false, replyData = null) {
  const isLuna = role === 'luna';
  const wrap   = document.createElement('div');
  const msgId  = 'msg_' + (++msgIdCounter);
  wrap.className = `message ${isLuna ? 'luna' : 'user'}`;
  wrap.dataset.msgId = msgId;
  const time    = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const label   = isLuna ? '◈ LUNA · responded' : '';
  const avClass = isLuna ? 'av-luna' : 'av-user';
  const init    = isLuna ? 'LN' : 'ME';
  const body    = stream ? '' : formatMarkdown(rawText);
  const lunaActions = isLuna ? `
    <button class="mac-btn reply-btn" title="Reply to this message" onclick="setReplyContext('${msgId}', this.closest('.bubble').querySelector('.bubble-text').innerText)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
    </button>
    <button class="mac-btn tts-btn" title="Read aloud" onclick="toggleTTS(this.closest('.bubble').querySelector('.bubble-text').innerText, this)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
    </button>
    <button class="mac-btn regen" title="Regenerate response (Ctrl+R)" onclick="regenerateResponse()">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>
    </button>
` : '';

  // Reply quote block — shown in BOTH user and Luna bubbles for threaded exchanges
  // fromUser:true  → Luna is quoting the user  → crimson accent + "↩ YOU · QUOTED"
  // fromUser:false → user is quoting Luna       → violet accent + "↩ LUNA · QUOTED"
  const quoteCls   = replyData && replyData.fromUser ? 'reply-quote from-user' : 'reply-quote';
  const quoteLabel = replyData && replyData.fromUser ? '↩ YOU · QUOTED'        : '↩ LUNA · QUOTED';
  const replyQuoteHtml = replyData ? `
    <div class="${quoteCls}" onclick="jumpToReplyTarget('${replyData.msgId}')">
      <div class="reply-quote-accent"></div>
      <div class="reply-quote-inner">
        <div class="reply-quote-label">${quoteLabel}</div>
        <div class="reply-quote-text">${escHtml(replyData.previewText)}</div>
      </div>
    </div>` : '';

  wrap.innerHTML = `
    <div class="av ${avClass}">${init}</div>
    <div class="bubble" id="bubble_${msgId}">
      <div class="pin-badge">📌 PINNED</div>
      ${replyQuoteHtml}
      <span class="bubble-header">${label}</span>
      <span class="bubble-text">${body}</span>
      <div class="reaction-bar" id="rb_${msgId}">
        <button class="reaction-pill" onclick="toggleReaction('${msgId}','👍',this)"><span class="rc">👍</span><span class="rc-count"></span></button>
        <button class="reaction-pill" onclick="toggleReaction('${msgId}','❤️',this)"><span class="rc">❤️</span><span class="rc-count"></span></button>
        <button class="reaction-pill" onclick="toggleReaction('${msgId}','⭐',this)"><span class="rc">⭐</span><span class="rc-count"></span></button>
        <button class="reaction-pill" onclick="toggleReaction('${msgId}','🔥',this)"><span class="rc">🔥</span><span class="rc-count"></span></button>
      </div>
      <div class="bubble-footer">
        <span class="bubble-time">${time}</span>
        <div class="msg-actions">
          <button class="mac-btn" title="Copy message" onclick="copyToClipboard(this.closest('.bubble').querySelector('.bubble-text').innerText, this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
          <button class="mac-btn" title="Pin message" onclick="togglePin('${msgId}', this.closest('.bubble').querySelector('.bubble-text').innerText, this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          </button>
          ${lunaActions}
          <button class="mac-btn" title="Star message" onclick="this.classList.toggle('starred')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
  // ◈ Mood Ring — apply current persona mood to avatar + bubble wrap
  if (isLuna) {
    applyMoodToAvatar(wrap.querySelector('.av-luna'));
    applyMoodToWrap(wrap);
  }
  return wrap;
}

async function appendMessage(role, rawText, replyData = null) {
  const isLuna = role === 'luna';
  chatFeed.querySelector('.welcome-card')?.remove();

  // ◈ Mood Ring — score Luna's replies for sentiment (user messages handled by detectToneFromMessage)
  if (isLuna) updateMoodRing(rawText);

  // ── Push to admin monitor chatlog ──
  pushMessageToFirebase(isLuna ? 'assistant' : 'user', rawText);

  // ── Save to user's personal Firebase chatlog + update in-memory history ──
  const fbRole = isLuna ? 'assistant' : 'user';
  saveMessageToUserChatlog(fbRole, rawText);
  persistedHistory.push({ role: fbRole, content: rawText, ts: Date.now() });
  if (persistedHistory.length > CHATLOG_MAX_MSGS) {
    persistedHistory = persistedHistory.slice(-CHATLOG_MAX_MSGS);
  }

  // ◈ Clear typing status when a message is sent
  if (!isLuna) clearTyping();

  let resultMsgId = null;

  if (isLuna) {
    lastLunaText = rawText;
    const wrap = buildMessageWrap('luna', rawText, true, replyData);
    resultMsgId = wrap.dataset.msgId;
    chatFeed.appendChild(wrap);
    if (userScrolledUp) {
      newMsgCount++;
      fabBadge.textContent = newMsgCount > 9 ? '9+' : newMsgCount;
      fabBadge.style.display = 'flex';
    }
    await streamLunaMessage(rawText, wrap);
  } else {
    const wrap = buildMessageWrap('user', rawText, false, replyData);
    resultMsgId = wrap.dataset.msgId;
    chatFeed.appendChild(wrap);
    scrollDown();
  }
  msgCount++;
  msgDisplay.textContent = msgCount;
  animateStats();
  return resultMsgId;
}

// ── Typing indicator ──────────────────────────────────────────────
function showTyping() {
  reportLunaTypingToAdmin(true);
  const el = document.createElement('div');
  el.className = 'message luna';
  el.id = 'typing-el';
  el.innerHTML = `
    <div class="av av-luna">LN</div>
    <div class="bubble">
      <span class="bubble-header">◈ LUNA · PROCESSING</span>
      <div class="typing-indicator">
        <div class="td"></div><div class="td"></div><div class="td"></div>
        <div class="td"></div><div class="td"></div>
      </div>
    </div>
  `;
  chatFeed.appendChild(el);
  scrollDown();
}
function hideTyping() { reportLunaTypingToAdmin(false); document.getElementById('typing-el')?.remove(); }

// ── Groq API call ─────────────────────────────────────────────────
// ── Parse retry-after seconds from a Groq rate-limit error message ──
function parseRetryAfter(msg) {
  const m = String(msg).match(/try again in\s+([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1])) : 12;
}

// ── Show a non-blocking countdown toast while waiting to retry ────
function showRetryCountdown(seconds, attempt) {
  showRateLimitBanner(attempt, seconds); // ← show persistent input-zone warning
  return new Promise(resolve => {
    let remaining = seconds;
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span style="font-size:16px">⏳</span><span id="retryMsg">Rate limit — retrying in ${remaining}s (attempt ${attempt}/3)…</span>`;
    container.appendChild(el);
    const tick = setInterval(() => {
      remaining--;
      const msg = el.querySelector('#retryMsg');
      if (msg) msg.textContent = `Rate limit — retrying in ${remaining}s (attempt ${attempt}/3)…`;
      if (remaining <= 0) {
        clearInterval(tick);
        el.classList.add('removing');
        el.addEventListener('animationend', () => el.remove());
        resolve();
      }
    }, 1000);
  });
}

// ── Active stream abort controller (allows cancel-in-flight) ─────
let _activeStreamController = null;

// ── Rate Limit Banner + Input-box Countdown ───────────────────────
// Tracks consecutive 429s and shows a persistent warning in the input zone
// AND a live countdown overlay directly on the message input box.
let _rlHitCount       = 0;        // number of 429s this session
let _rlCooldownTimer  = null;     // auto-dismiss timer ID
let _rlCooldownSecs   = 0;        // seconds remaining on auto-dismiss
let _rlioTimer        = null;     // input-overlay countdown timer

// ── Helpers: input overlay ────────────────────────────────────────
function _rlioShow(secs, label, critical) {
  const el      = document.getElementById('rlInputOverlay');
  const minsEl  = document.getElementById('rlioMins');
  const secsEl  = document.getElementById('rlioSecs');
  const subEl   = document.getElementById('rlioSub');
  const labelEl = document.getElementById('rlioLabel');
  const iconEl  = document.getElementById('rlioIcon');
  const fill    = document.getElementById('rlioFill');
  if (!el) return;

  // Clear any previous timer
  if (_rlioTimer) { clearInterval(_rlioTimer); _rlioTimer = null; }

  el.classList.remove('rl-ok-anim', 'rl-ok-state', 'rl-critical');
  if (critical) el.classList.add('rl-critical');

  labelEl.textContent = critical ? 'RATE LIMITED — PLEASE WAIT' : label || 'RETRYING…';
  iconEl.textContent  = critical ? '🔴' : '⏳';

  const total = secs;
  let left = secs;

  function fmt(s) {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return { m: String(m).padStart(2,'0'), s: String(ss).padStart(2,'0') };
  }

  function tick() {
    const { m, s } = fmt(left);
    if (minsEl) minsEl.textContent = m;
    if (secsEl) secsEl.textContent = s;
    const pct = total > 0 ? ((total - left) / total) * 100 : 100;
    if (fill) fill.style.width = pct + '%';
    const sub = left > 0
      ? (critical ? `auto-retry in ${left}s` : `retrying in ${left}s`)
      : 'connecting…';
    if (subEl) subEl.textContent = sub;
  }

  tick();
  el.classList.add('visible');

  if (secs > 0) {
    _rlioTimer = setInterval(() => {
      left--;
      tick();
      if (left <= 0) {
        clearInterval(_rlioTimer);
        _rlioTimer = null;
        if (subEl) subEl.textContent = 'connecting…';
        if (fill)  fill.style.width  = '100%';
      }
    }, 1000);
  }
}

function _rlioSuccess() {
  const el      = document.getElementById('rlInputOverlay');
  const labelEl = document.getElementById('rlioLabel');
  const iconEl  = document.getElementById('rlioIcon');
  const subEl   = document.getElementById('rlioSub');
  const minsEl  = document.getElementById('rlioMins');
  const secsEl  = document.getElementById('rlioSecs');
  const fill    = document.getElementById('rlioFill');
  if (!el) return;
  if (_rlioTimer) { clearInterval(_rlioTimer); _rlioTimer = null; }
  el.classList.remove('rl-critical');
  el.classList.add('rl-ok-state');
  iconEl.textContent  = '✅';
  labelEl.textContent = 'CONNECTION RESTORED';
  if (subEl) subEl.textContent = 'Luna is back online ✦';
  if (minsEl) minsEl.textContent = '00';
  if (secsEl) secsEl.textContent = '00';
  if (fill)   fill.style.width   = '100%';
  setTimeout(() => {
    el.classList.add('rl-ok-anim');
    el.addEventListener('animationend', () => {
      el.classList.remove('visible', 'rl-ok-anim', 'rl-ok-state');
    }, { once: true });
  }, 1600);
}

function _rlioHide() {
  const el = document.getElementById('rlInputOverlay');
  if (!el) return;
  if (_rlioTimer) { clearInterval(_rlioTimer); _rlioTimer = null; }
  el.classList.remove('visible', 'rl-critical', 'rl-ok-state', 'rl-ok-anim');
}

function showRateLimitBanner(attempt, waitSecs) {
  _rlHitCount++;
  const banner   = document.getElementById('rateLimitBanner');
  const textEl   = document.getElementById('rlBannerText');
  const iconEl   = document.getElementById('rlBannerIcon');
  const cdEl     = document.getElementById('rlBannerCooldown');
  if (!banner) return;

  // Clear any existing auto-dismiss countdown
  if (_rlCooldownTimer) { clearInterval(_rlCooldownTimer); _rlCooldownTimer = null; }

  banner.classList.remove('rl-critical', 'rl-ok');
  banner.style.display = 'flex';

  if (attempt >= 3) {
    // Final attempt failed — critical state
    banner.classList.add('rl-critical');
    iconEl.textContent  = '🔴';
    textEl.textContent  = 'Luna hit the rate limit — please wait a moment before sending again.';
    let left = 20;
    cdEl.textContent = `auto-clear in ${left}s`;
    _rlCooldownTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(_rlCooldownTimer); dismissRateLimitBanner(); }
      else cdEl.textContent = `auto-clear in ${left}s`;
    }, 1000);

    // Show input overlay — use 20s as the visible countdown
    _rlioShow(20, 'RATE LIMITED — PLEASE WAIT', true);
  } else {
    // Mid-retry — warning state with live countdown
    iconEl.textContent = '⚡';
    textEl.textContent = `Luna is under heavy load — retrying (${attempt}/3)…`;
    let left = waitSecs;
    cdEl.textContent = `retrying in ${left}s`;
    _rlCooldownTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(_rlCooldownTimer); _rlCooldownTimer = null; cdEl.textContent = 'retrying…'; }
      else cdEl.textContent = `retrying in ${left}s`;
    }, 1000);

    // Show input overlay with the actual wait time
    _rlioShow(waitSecs, `RETRYING (${attempt}/3)…`, false);
  }
}

function showRateLimitBannerSuccess() {
  if (_rlHitCount === 0) return;
  const banner = document.getElementById('rateLimitBanner');
  const textEl = document.getElementById('rlBannerText');
  const iconEl = document.getElementById('rlBannerIcon');
  const cdEl   = document.getElementById('rlBannerCooldown');
  if (!banner) return;
  if (_rlCooldownTimer) { clearInterval(_rlCooldownTimer); _rlCooldownTimer = null; }

  banner.classList.remove('rl-critical');
  banner.classList.add('rl-ok');
  banner.style.display = 'flex';
  iconEl.textContent = '✅';
  textEl.textContent = 'Connection restored — Luna is back to normal.';
  cdEl.textContent   = '';

  // Input overlay success flash
  _rlioSuccess();

  setTimeout(() => {
    dismissRateLimitBanner();
    _rlHitCount = 0;
  }, 4000);
}

function dismissRateLimitBanner() {
  if (_rlCooldownTimer) { clearInterval(_rlCooldownTimer); _rlCooldownTimer = null; }
  const banner = document.getElementById('rateLimitBanner');
  if (!banner) return;
  banner.style.opacity = '0';
  banner.style.transition = 'opacity 0.3s ease';
  setTimeout(() => {
    banner.style.display = 'none';
    banner.style.opacity = '';
    banner.style.transition = '';
    banner.classList.remove('rl-critical', 'rl-ok');
  }, 300);
  // Also hide input overlay on manual dismiss
  _rlioHide();
}
window.dismissRateLimitBanner = dismissRateLimitBanner;

// ── Show/hide the stop button (swaps with send button) ───────────
function showStopBtn() {
  const stopBtn = document.getElementById('stopStreamBtn');
  const sBtn    = document.getElementById('sendBtn');
  if (stopBtn) stopBtn.style.display = 'flex';
  if (sBtn)    sBtn.style.display    = 'none';
}
function hideStopBtn() {
  const stopBtn = document.getElementById('stopStreamBtn');
  const sBtn    = document.getElementById('sendBtn');
  if (stopBtn) stopBtn.style.display = 'none';
  if (sBtn)    sBtn.style.display    = 'flex';
}

// ── Cancel in-flight stream — user pressed STOP ───────────────────
function stopLunaStream() {
  if (_activeStreamController) {
    _activeStreamController.abort();
    _activeStreamController = null;
  }
  hideStopBtn();
  hideTyping();
  isTyping = false;
  sendBtn.disabled = false;
  userInput.focus();
  // Haptic feedback on mobile
  if (navigator.vibrate) navigator.vibrate(40);
  showToast('◈ Generation stopped.', '⬛', 1800);
}

// ── Detect if user message needs real-time web search (strict — avoids casual chat) ──
// Only triggers for clearly time-sensitive or specific factual queries.
let _lastWebSearchTime = 0;
const WEB_SEARCH_COOLDOWN_MS = 8000; // minimum 8s between web search calls

function isFactualQuery(text) {
  const lower = text.trim().toLowerCase();

  // Too short or clearly casual
  if (lower.length < 15) return false;

  // Skip casual/emotional openers
  const casualPatterns = [
    /^(hi|hey|hello|haha|hehe|lol|ok|okay|sige|oo|aww|wow|grabe|talaga|naman|dba|kamusta|musta|kumusta|ano ba|nice|cool|sweet|eme|charot|joke|same|bored|ikr|omg|hays|naks)\b/i,
    /^(i feel|i'm|im |ako |mahal|miss |love |sad |happy|excited|nervous|scared|cry|nalulungkot|masaya|naiiyak|nasaktan)\b/i,
  ];
  if (casualPatterns.some(p => p.test(lower))) return false;

  // Only trigger for explicitly time-sensitive or highly specific factual queries
  const strictFactualPatterns = [
    /\b(latest|recent|current|today|right now|this week|this year|2024|2025|2026|news|update|live|breaking)\b/i,
    /\b(price|cost|rate|stock|exchange rate|dollar|peso|bitcoin|crypto)\b/i,
    /\b(weather|forecast|temperature|typhoon|bagyo)\b/i,
    /\b(who is the (current|new|latest)|what is the (current|latest|new))\b/i,
    /\b(just (happened|released|announced|launched|dropped))\b/i,
    /\b(definition of|meaning of|ano ang ibig sabihin ng)\b/i,
    /\b(capital of|population of|president of|ceo of|founded in|invented by)\b/i,
    /\b(lyrics|lyric|words of the song|song words|kanta|lyrics of|full lyrics|complete lyrics)\b/i,
    /\b(what are the lyrics|give me the lyrics|show me the lyrics|ano ang lyrics|ano yung lyrics|lyrics nga|lyrics please|paki lyrics)\b/i,
  ];
  return strictFactualPatterns.some(p => p.test(lower));
}

// ── Perform a web search via Groq's compound-beta model (non-streaming, silent) ──
// Returns search context string, or null if unavailable / rate-limited.
async function fetchWebSearchContext(query) {
  // Enforce cooldown — don't fire rapid search calls
  const now = Date.now();
  if (now - _lastWebSearchTime < WEB_SEARCH_COOLDOWN_MS) return null;
  _lastWebSearchTime = now;

  // Lyrics queries need more tokens to fit full song text
  const isLyricsQuery = /\b(lyrics|lyric|words of the song|song words|kanta)\b/i.test(query);
  const maxTokens = isLyricsQuery ? 2400 : 1200;
  const systemInstruction = isLyricsQuery
    ? 'Return the COMPLETE, EXACT, VERBATIM song lyrics requested — every line, every verse, chorus, bridge — with section labels like [Verse 1], [Chorus], [Bridge]. Do NOT summarize, paraphrase, or skip any lines. Accuracy is critical.'
    : 'Give a short factual summary of the most relevant up-to-date information for the query. Under 200 words, facts only, no filler.';

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), isLyricsQuery ? 10000 : 5000); // lyrics need more time

    const response = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getActiveApiKey()}` },
      body: JSON.stringify({
        model: 'compound-beta',
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: query }
        ],
      }),
    });
    clearTimeout(timeout);

    // On rate limit or any error — fail silently, never disrupt the main response
    if (response.status === 429 || !response.ok) return null;

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch {
    return null; // timeout, network error — silent fail
  }
}

// ── getLunaResponse: buffers full reply (used for regen / file / image flows) ──
// Uses multi-provider routing: Groq → Gemini → OpenRouter with auto-fallback.
async function getLunaResponse(userMessage, attempt = 1) {
  const systemMsg = buildSystemPromptWithStatuses();
  const trimmedHistory = conversationHistory.slice(-30);

  // ── Web search augmentation for factual queries ──────────────────
  let augmentedMessage = userMessage;
  if (isFactualQuery(userMessage)) {
    const webCtx = await fetchWebSearchContext(userMessage);
    if (webCtx) {
      const isLyricsCtx = /\b(lyrics|lyric|words of the song|song words|kanta)\b/i.test(userMessage);
      const ctxLabel = isLyricsCtx
        ? '[EXACT SONG LYRICS FROM WEB — present these VERBATIM, line-for-line, with section labels. Do NOT alter a single word:]'
        : '[REAL-TIME WEB CONTEXT — use this to give an accurate, up-to-date answer. Do not mention that you searched the web; just answer naturally using this information as your knowledge base:]';
      augmentedMessage = `${userMessage}\n\n${ctxLabel}\n${webCtx}`;
    }
  }

  const messages = [
    { role: 'system', content: systemMsg },
    ...trimmedHistory,
    { role: 'user', content: augmentedMessage }
  ];

  const controller = new AbortController();
  _activeStreamController = controller;

  const providers = getAvailableProviders();
  if (!providers.length) {
    throw new Error('All AI providers are temporarily unavailable. Please wait a moment and try again. ✦');
  }

  for (const provider of providers) {
    try {
      let gen;
      if (provider === 'groq')        gen = streamGroq(messages, settings.temperature, controller.signal);
      else if (provider === 'gemini') gen = streamGemini(messages, settings.temperature, controller.signal);
      else                            gen = streamOpenRouter(messages, settings.temperature, controller.signal);

      let fullReply = '';
      for await (const token of gen) { fullReply += token; }

      if (!fullReply) throw new Error(`${provider}: empty response`);
      if (attempt > 1) showRateLimitBannerSuccess();
      return fullReply;

    } catch (err) {
      if (controller.signal.aborted) throw err;
      console.warn(`[Luna] getLunaResponse provider "${provider}" failed:`, err.message);
      if (provider === 'groq' && err.message.includes('429') && providers.length === 1) {
        if (attempt >= 3) {
          showRateLimitBanner(3, 0);
          throw new Error('Rate limit reached. Luna needs a short break — please wait a moment and try again. ✦');
        }
        const waitSecs = parseRetryAfter(err.message);
        await showRetryCountdown(waitSecs, attempt);
        return getLunaResponse(userMessage, attempt + 1);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error('Neural fault — all providers unavailable. Please try again in a moment. ✦');
}

// ── streamLunaResponseLive: pipes SSE tokens directly into a bubble as they arrive ──
// Uses multi-provider routing: Groq → Gemini → OpenRouter with auto-fallback.
// Returns the full reply string when done.
async function streamLunaResponseLive(userMessage, wrap, attempt = 1) {
  const systemMsg = buildSystemPromptWithStatuses();
  const trimmedHistory = conversationHistory.slice(-30);

  // ── Web search augmentation for factual queries ──────────────────
  let augmentedMessage = userMessage;
  if (isFactualQuery(userMessage)) {
    const webCtx = await fetchWebSearchContext(userMessage);
    if (webCtx) {
      const isLyricsCtx = /\b(lyrics|lyric|words of the song|song words|kanta)\b/i.test(userMessage);
      const ctxLabel = isLyricsCtx
        ? '[EXACT SONG LYRICS FROM WEB — present these VERBATIM, line-for-line, with section labels. Do NOT alter a single word:]'
        : '[REAL-TIME WEB CONTEXT — use this to give an accurate, up-to-date answer. Do not mention that you searched the web; just answer naturally using this information as your knowledge base:]';
      augmentedMessage = `${userMessage}\n\n${ctxLabel}\n${webCtx}`;
    }
  }

  const messages = [
    { role: 'system', content: systemMsg },
    ...trimmedHistory,
    { role: 'user', content: augmentedMessage }
  ];

  const controller = new AbortController();
  _activeStreamController = controller;

  const textEl   = wrap.querySelector('.bubble-text');
  let fullReply  = '';
  let renderTick = 0;

  // Show initial cursor immediately — signals to user that Luna is responding
  textEl.innerHTML = '<span class="stream-cursor"></span>';
  scrollDown();

  try {
    // ── Detect which provider is actually used for the indicator ────
    // We peek at the first token to know which provider succeeded
    let detectedProvider = null;
    const providers = getAvailableProviders();

    for (const provider of providers) {
      try {
        let gen;
        if (provider === 'groq')        gen = streamGroq(messages, settings.temperature, controller.signal);
        else if (provider === 'gemini') gen = streamGemini(messages, settings.temperature, controller.signal);
        else                            gen = streamOpenRouter(messages, settings.temperature, controller.signal);

        for await (const token of gen) {
          if (!detectedProvider) {
            detectedProvider = provider;
            showProviderIndicator(provider);
            if (provider !== 'groq') {
              // Show a subtle toast when falling over to a secondary provider
              showToast(`◈ Switched to ${provider === 'gemini' ? 'Gemini' : 'OpenRouter'}`, '✦', 2200);
            }
          }
          fullReply += token;
          renderTick++;
          // Mobile: throttle to every ~6 tokens (~120ms at typical speed) to avoid reflow
          // Desktop: render every token for butter-smooth streaming
          const shouldRender = IS_MOBILE ? (renderTick % 6 === 0) : true;
          if (shouldRender) {
            textEl.innerHTML = formatMarkdown(fullReply) + '<span class="stream-cursor"></span>';
            renderMath(textEl);
            if (!userScrolledUp) scrollDown();
          }
        }

        if (!fullReply) throw new Error(`${provider}: empty response`);
        break; // success — exit provider loop

      } catch (err) {
        if (controller.signal.aborted) {
          // User pressed stop — clean exit
          if (fullReply) {
            textEl.innerHTML = formatMarkdown(fullReply);
            renderMath(textEl);
          }
          return fullReply || '';
        }
        console.warn(`[Luna] Provider "${provider}" failed:`, err.message);
        fullReply = ''; // reset for next provider
        renderTick = 0;
        textEl.innerHTML = '<span class="stream-cursor"></span>';
        // Rate limit on Groq specifically — show the banner
        if (provider === 'groq' && err.message.includes('429')) {
          const waitSecs = parseRetryAfter(err.message);
          if (attempt < 3 && providers.length === 1) {
            // Only Groq available — do timed retry
            showRateLimitBanner(attempt, waitSecs);
            await showRetryCountdown(waitSecs, attempt);
            return streamLunaResponseLive(userMessage, wrap, attempt + 1);
          }
          if (providers.length === 1) {
            showRateLimitBanner(3, 0);
            throw new Error('Rate limit reached. Luna needs a short break — please wait a moment and try again. ✦');
          }
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return fullReply || '';
    // All providers threw — show the error card directly in the bubble
    const errMsg = err.message || 'Unknown error';
    const errCard = `
      <div style="display:flex;flex-direction:column;gap:10px;padding:4px 0;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">⚠️</span>
          <span style="font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.14em;color:var(--crimson-bright,#ec2d5a);">ALL PROVIDERS UNAVAILABLE</span>
        </div>
        <p style="margin:0;font-size:13px;color:var(--text-mid,#9580b5);line-height:1.6;">
          Luna couldn't reach any AI provider right now. This usually means your API keys have hit their rate limit or have expired.
        </p>
        <details style="margin-top:2px;"><summary style="font-size:10px;color:var(--text-lo,#3d3060);cursor:pointer;">Technical detail</summary><code style="font-size:10px;color:var(--text-lo);word-break:break-all;">${errMsg}</code></details>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;">
          <button onclick="(function(){Object.keys(_providerCooldowns).forEach(k=>_providerCooldowns[k]=0);_keyCooldowns={};showToast('◈ Providers reset — try again','✦',2500);})()" style="padding:7px 14px;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.3);border-radius:8px;color:var(--violet-bright,#a855f7);font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.12em;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.background='rgba(168,85,247,0.22)'" onmouseout="this.style.background='rgba(168,85,247,0.1)'">↺ RESET &amp; RETRY</button>
          <a href="https://console.groq.com/keys" target="_blank" rel="noopener" style="padding:7px 14px;background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.25);border-radius:8px;color:var(--crimson-bright,#ec2d5a);font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.12em;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;">↗ GET NEW GROQ KEY</a>
        </div>
        <p style="margin:0;font-size:10px;color:var(--text-lo,#3d3060);">Free Groq keys: 14,400 req/day · 500K tokens/day — grab a fresh one if yours is exhausted.</p>
      </div>`;
    textEl.innerHTML = errCard;
    if (!userScrolledUp) scrollDown();
    return '';
  }

  if (!fullReply) {
    // Show a proper error card with retry button instead of a fake AI message
    const errCard = `
      <div style="display:flex;flex-direction:column;gap:10px;padding:4px 0;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">⚠️</span>
          <span style="font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.14em;color:var(--crimson-bright,#ec2d5a);">ALL PROVIDERS UNAVAILABLE</span>
        </div>
        <p style="margin:0;font-size:13px;color:var(--text-mid,#9580b5);line-height:1.6;">
          Luna couldn't reach any AI provider right now. This usually means your API keys have hit their rate limit or have expired.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;">
          <button onclick="(function(){Object.keys(_providerCooldowns).forEach(k=>_providerCooldowns[k]=0);_keyCooldowns={};showToast('◈ Providers reset — try again','✦',2500);})()" style="padding:7px 14px;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.3);border-radius:8px;color:var(--violet-bright,#a855f7);font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.12em;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.background='rgba(168,85,247,0.22)'" onmouseout="this.style.background='rgba(168,85,247,0.1)'">↺ RESET &amp; RETRY</button>
          <a href="https://console.groq.com/keys" target="_blank" rel="noopener" style="padding:7px 14px;background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.25);border-radius:8px;color:var(--crimson-bright,#ec2d5a);font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.12em;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;">↗ GET NEW GROQ KEY</a>
        </div>
        <p style="margin:0;font-size:10px;color:var(--text-lo,#3d3060);">Free Groq keys: 14,400 req/day · 500K tokens/day — grab a fresh one if yours is exhausted.</p>
      </div>`;
    textEl.innerHTML = errCard;
    if (!userScrolledUp) scrollDown();
    return '';
  }

  // Final render — no cursor
  textEl.innerHTML = formatMarkdown(fullReply);
  renderMath(textEl);
  if (!userScrolledUp) scrollDown();
  if (attempt > 1) showRateLimitBannerSuccess();
  return fullReply;
}

// ── Process pasted image via vision ───────────────────────────────
async function processImage(imgData, userMessage = '') {
  if (isTyping) return;
  isTyping = true; sendBtn.disabled = true;
  const wrap = document.createElement('div');
  wrap.className = 'message user';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgHTML = userMessage ? `<br/><span>${formatMarkdown(userMessage)}</span>` : '';
  wrap.innerHTML = `
    <div class="av av-user">ME</div>
    <div class="bubble">
      <span class="bubble-header" style="display:none"></span>
      <span class="bubble-text">
        <img src="${imgData.objectURL}" style="max-width:260px;max-height:180px;border-radius:9px;display:block;margin-bottom:6px;border:1px solid rgba(168,85,247,0.25);" />
        ${msgHTML}
      </span>
      <div class="bubble-footer"><span class="bubble-time">${time}</span></div>
    </div>
  `;
  chatFeed.querySelector('.welcome-card')?.remove();
  chatFeed.appendChild(wrap);
  scrollDown();
  showTyping();
  msgCount++;
  msgDisplay.textContent = msgCount;
  try {
    const dataURL = `data:${imgData.mimeType};base64,${imgData.base64}`;

    // Detect copy / extract intent from the user's message
    const copyIntent = !userMessage || /copy|extract|basahin|i-copy|i-extract|what.*(say|written|text)|read.*this|paki.*basa|ano.*nakalagay|transcribe/i.test(userMessage);

    const extractionInstruction = copyIntent
      ? `The user wants you to READ and PRESENT the text from this image cleanly.

STRICT RULES — follow exactly, no exceptions:
1. Extract EVERY piece of text visible in the image — miss nothing
2. FORMAT the output based on content type:
   - If it is a SCHEDULE, PROGRAM, or TIMETABLE → use ## headers for each section/day, *italic* for sub-labels (like venue), and a markdown table: | Time | Activity | with | --- | --- | divider
   - If it is a LIST → use clean numbered or bulleted lists
   - If it is PROSE or PARAGRAPHS → preserve paragraph breaks and punctuation
   - If it is a FORM or DOCUMENT → use **Field:** Value format
3. Separate major sections with ---
4. Do NOT add commentary, analysis, or your own words
5. Do NOT say "Here is the text:" — just present it directly, clean and complete`
      : `${LUNA_SYSTEM_PROMPT}\n\nUser message: ${userMessage}`;

    const imagePrompt = copyIntent ? extractionInstruction : `${LUNA_SYSTEM_PROMPT}\n\nUser message: ${userMessage}`;
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getActiveApiKey()}` },
      body: JSON.stringify({
        model: API_MODEL_VISION, max_tokens: 8192,
        messages: [{ role: 'user', content: [
          { type: 'text', text: imagePrompt },
          { type: 'image_url', image_url: { url: dataURL } }
        ]}]
      }),
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(`Vision fault: ${e?.error?.message || `HTTP ${response.status}`}`); }
    const data  = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    const safeReply = reply || "I can see the image was sent, but I wasn't able to process it this time. Could you try sending it again? ✦";
    pushToHistory(userMessage || '[image]', safeReply);
    hideTyping();
    lastLunaText = safeReply;
    await appendMessage('luna', safeReply);
  } catch (err) {
    hideTyping();
    const userMsg = err.message.includes('Vision fault')
      ? `I had trouble reading that image — ${err.message.replace('Vision fault: ', '')} Please try again. ✦`
      : `Something went wrong while analyzing the image. Please try again. ✦`;
    await appendMessage('luna', userMsg);
  }
  isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly();
}

// ── Process uploaded files ────────────────────────────────────────
async function processFiles(files, userMessage = '') {
  if (isTyping) return;
  isTyping = true; sendBtn.disabled = true;
  const names = files.map(f => `**${f.name}**`).join('   📎 ');
  await appendMessage('user', `📎 ${names}${userMessage ? '  —  ' + userMessage : ''}`);
  showTyping();
  try {
    const parts    = await Promise.all(files.map(async f => { const fc = await readFile(f); return `--- File: ${f.name} ---\n${fc}`; }));
    const combined = parts.join('\n\n');

    // Detect copy / extract intent
    const copyIntent = !userMessage || /copy|extract|basahin|i-copy|i-extract|what.*(say|written|text|inside|content)|read.*this|paki.*basa|ano.*nakalagay|transcribe/i.test(userMessage);

    const extractionInstruction = `The user wants you to READ and PRESENT the content from this file cleanly.

STRICT RULES — follow exactly, no exceptions:
1. Present ALL content from the file — miss nothing
2. FORMAT the output based on what type of content it contains:
   - SCHEDULE / PROGRAM / TIMETABLE → ## headers for sections/days, *italic* for sub-labels, markdown table: | Time | Activity | with | --- | --- | divider
   - LIST → clean numbered or bulleted list
   - PROSE / PARAGRAPHS → preserve paragraph breaks
   - FORM / STRUCTURED DOCUMENT → **Field:** Value format
3. Separate major sections with ---
4. Do NOT add your own commentary or analysis
5. Do NOT say "Here is the content:" — just present it directly, clean and complete

File content:
${combined}${userMessage ? `\n\nAdditional user instruction: ${userMessage}` : ''}`;

    const prompt = copyIntent
      ? extractionInstruction
      : `I uploaded ${files.length} file(s):\n\n${combined}\n\nMy message: ${userMessage || 'Please analyze and summarize them.'}`;
    const reply = await getLunaResponse(prompt);
    pushToHistory(prompt, reply);
    hideTyping();
    lastLunaText = reply;
    await appendMessage('luna', reply);
  } catch (err) {
    hideTyping();
    await appendMessage('luna', `◈ File scan disrupted. ${err.message} ✦`);
  }
  isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly();
}

// ── Activity category detector ────────────────────────────────────
const ACTIVITY_CATEGORIES = {
  eating: {
    keywords: [
      'eating','kain','kumakain','nagkakain','nagsasalo-salo',
      'lunch','dinner','breakfast','brunch','meryenda','snack',
      'having lunch','having dinner','having breakfast','having a meal','having a snack',
      'dining','feasting','grabbing food','getting food','food trip','foodtrip',
      'eating out','ordering food','nagkakain',
    ],
    extras: (name) => [
      [
        `Looks like ${name} is taking a well-deserved break to enjoy a meal! 🍽️`,
        `Hope it's something delicious — everyone deserves a good bite. ✦`,
        `They should be back and available once they're done eating. ◈`,
      ],
      [
        `${name} is fueling up right now! 🍴`,
        `Good food keeps the mind sharp — they'll be back in full energy shortly after. ✦`,
        `Give them a little time and they'll be ready to go again. ◈`,
      ],
      [
        `Meal time for ${name}! 🥘`,
        `It's important to take a proper break — eating well keeps everything running. ✦`,
        `They'll likely be free again once the meal is done. ◈`,
      ],
    ],
  },

  sleeping: {
    keywords: [
      'sleeping','tulog','natutulog','nagpapahinga','napping','nap',
      'resting','rest','asleep','taking a nap','taking a rest',
    ],
    extras: (name) => [
      [
        `${name} is currently getting some rest — probably recharging for whatever's next. 😴`,
        `Sleep is so important; the body and mind need it to stay at their best. ✦`,
        `Best not to disturb them — they'll be back once they're up and refreshed. ◈`,
      ],
      [
        `Looks like ${name} is in rest mode right now. 🌙`,
        `A good nap or sleep session can do wonders for focus and mood. ✦`,
        `They should be available again once they wake up. ◈`,
      ],
      [
        `${name} is taking a rest at the moment. 💤`,
        `Everyone needs their downtime — it's how we come back stronger. ✦`,
        `Give them some time; they'll be up and running soon. ◈`,
      ],
    ],
  },

  working: {
    keywords: [
      'working','nagtatrabaho','trabaho','nag-work','sa work','at work',
      'in the office','office','meeting','sa meeting','nag-meeting',
      'busy','may trabaho','may meeting','in a meeting',
    ],
    extras: (name) => [
      [
        `${name} is deep in work mode right now — fully focused on what needs to get done. 💼`,
        `Interrupting someone mid-workflow can really break their concentration, so it's best to wait. ✦`,
        `They should have some free time once their current task or meeting wraps up. ◈`,
      ],
      [
        `Sounds like ${name} is in the zone right now — probably handling something important. 🖥️`,
        `Productive sessions like that are precious; let them power through. ✦`,
        `Reach out to them once they've had a chance to surface from work mode. ◈`,
      ],
      [
        `${name} is currently occupied with work. 📋`,
        `Whether it's a meeting or a focused task, they're giving it their full attention right now. ✦`,
        `They should be more reachable once things slow down a bit. ◈`,
      ],
    ],
  },

  studying: {
    keywords: [
      'studying','nag-aaral','nag-study','nagbabasa','reading','review',
      'nagrerepaso','doing homework','homework','assignment','exam prep',
      'cramming','nag-aaral pa','may assignment',
    ],
    extras: (name) => [
      [
        `${name} is currently hitting the books — focused and in study mode. 📚`,
        `Deep focus while studying is really important, so it's best not to break their flow. ✦`,
        `They'll have more headspace once they're done with their study session. ◈`,
      ],
      [
        `Looks like ${name} is grinding through some studying right now. 🎓`,
        `That kind of dedication takes real effort — respect the grind! ✦`,
        `They should be free to chat once they've wrapped up their review. ◈`,
      ],
      [
        `${name} is in full study mode at the moment. 📖`,
        `Learning takes focus — they're investing in themselves right now. ✦`,
        `Give them time to finish up; they'll be available soon. ◈`,
      ],
    ],
  },

  exercising: {
    keywords: [
      'gym','exercise','workout','working out','nag-eehersisyo','jogging','running',
      'swimming','laro','playing sports','training','nag-tatrain','nag-gym',
      'fitness','yoga','hiit','cardio','lifting',
    ],
    extras: (name) => [
      [
        `${name} is getting their sweat on right now — all that effort is seriously impressive! 💪`,
        `Exercise takes real discipline and dedication; they're investing in their health. ✦`,
        `They'll be energized and ready to talk once the workout is done. ◈`,
      ],
      [
        `Sounds like ${name} is in beast mode at the moment! 🏋️`,
        `Taking care of the body is just as important as everything else — love to see it. ✦`,
        `They should be back and feeling great once they cool down. ◈`,
      ],
      [
        `${name} is busy working out right now. 🏃`,
        `That kind of commitment to fitness really pays off in the long run. ✦`,
        `Give them a bit — they'll be free and refreshed after their session. ◈`,
      ],
    ],
  },

  gaming: {
    keywords: [
      'gaming','playing','naglalaro','laro','nag-game','video game',
      'mobile game','online game','rank','ranked','nag-rank','naglalaro ng games',
    ],
    extras: (name) => [
      [
        `${name} is in the middle of a gaming session right now — probably deep in concentration mode. 🎮`,
        `Interrupting a game mid-match can be really frustrating, so it's best to wait it out. ✦`,
        `They'll be free once the match or session wraps up. ◈`,
      ],
      [
        `Looks like ${name} is on a gaming run! 🕹️`,
        `Whether it's ranked or casual, they're in their element right now. ✦`,
        `Give them time to finish their game — they'll surface soon. ◈`,
      ],
      [
        `${name} is currently gaming at the moment. 🎯`,
        `Sometimes you just need that downtime to decompress and have fun. ✦`,
        `They should be done and available once the session ends. ◈`,
      ],
    ],
  },

  watching: {
    keywords: [
      'watching','nanunuood','movie','series','netflix','youtube','anime',
      'tv','nanonood','nag-netflix','streaming','nag-stream','nanonood ng pelikula',
    ],
    extras: (name) => [
      [
        `${name} is currently watching something — probably enjoying a bit of well-earned screen time. 📺`,
        `It's always nice to unwind with a good show or movie; everyone needs that. ✦`,
        `They'll be more available once whatever they're watching wraps up. ◈`,
      ],
      [
        `Looks like ${name} is in movie or series mode right now! 🎬`,
        `There's something special about getting lost in a great story — let them enjoy it. ✦`,
        `Catch them once they're done with their watch session. ◈`,
      ],
      [
        `${name} is occupied watching something at the moment. 🍿`,
        `A little entertainment goes a long way — good for the mind and the mood. ✦`,
        `They should be free again once it's over. ◈`,
      ],
    ],
  },

  outside: {
    keywords: [
      'outside','labas','lumabas','out','going out','nag-labas','errands',
      'mall','shopping','grocery','namamasyal','strolling','taking a walk',
      'walk','lakad','may lakad','byahe','commuting','driving','nasa labas',
    ],
    extras: (name) => [
      [
        `${name} is currently out and about — probably handling something or just getting some fresh air. 🚶`,
        `Being outside can be really refreshing; it's good for the mind. ✦`,
        `They should be back and reachable once they're done with their errands or outing. ◈`,
      ],
      [
        `Looks like ${name} stepped out for a bit! 🌤️`,
        `Whether it's errands or a quick break, everyone needs to get out sometimes. ✦`,
        `Give them time to get back — they'll be available again soon. ◈`,
      ],
      [
        `${name} is out at the moment. 🏙️`,
        `A little time outside does wonders — hope it's a good one for them. ✦`,
        `They should be back and reachable before long. ◈`,
      ],
    ],
  },

  busy: {
    keywords: [
      'busy','occupied','not available','unavailable','may gagawin',
      'may ginagawa','hindi available','di available','occupied',
    ],
    extras: (name) => [
      [
        `${name} is tied up with something important right now. ⏳`,
        `When someone's in the middle of a task, it's always best to give them the space to finish. ✦`,
        `They should have more time to connect once things settle down. ◈`,
      ],
      [
        `Sounds like ${name} has their hands full at the moment. 🔒`,
        `Being busy means something worthwhile is getting done — that's never a bad thing. ✦`,
        `Reach out a little later and they'll likely be more available. ◈`,
      ],
    ],
  },
};

// ── Detect which activity category matches ────────────────────────
function detectActivityCategory(activity) {
  const lower = activity.toLowerCase();
  for (const [cat, { keywords }] of Object.entries(ACTIVITY_CATEGORIES)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return null;
}

// ── Get extra sentences for any activity ─────────────────────────
function getActivityExtras(display, activity) {
  const cat = detectActivityCategory(activity);
  if (cat) {
    const pools = ACTIVITY_CATEGORIES[cat].extras(display);
    return pools[Math.floor(Math.random() * pools.length)];
  }
  // Generic fallback for any activity not in the list
  const fallbacks = [
    [
      `${display} seems to be caught up with that right now — things happen! ✦`,
      `It's always good to know what someone's up to; helps set the right expectations. ◈`,
      `They should be more available once they're finished with what they're doing. ✦`,
    ],
    [
      `Sounds like ${display} is occupied at the moment. ◈`,
      `Everyone has their own rhythm and pace — best to respect that and wait it out. ✦`,
      `They'll be free to connect again soon enough. ◈`,
    ],
    [
      `${display} is currently engaged in something. ✦`,
      `Whether it's big or small, whatever they're doing clearly has their attention right now. ◈`,
      `Give them a little time and they should be available again before long. ✦`,
    ],
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ── Status query interceptor ──────────────────────────────────────
function checkStatusQuery(message) {
  if (!Object.keys(adminStatuses).length) return null;
  const msg = message.toLowerCase().replace(/[?!.,]/g, '').trim();

  // ── Expanded asking patterns (English + Filipino + Taglish) ──────
  const askingPatterns = [
    // English
    /what.*doing/, /what.*up\s*to/, /what.*doing\s*right\s*now/,
    /what.*currently/, /is.*doing/, /doing\s*now/, /doing\s*right\s*now/,
    /what.*status/, /how.*is\s+\w+/, /where.*is/, /is.*available/,
    /is.*busy/, /is.*free/, /is.*around/, /is.*there/, /can.*talk/,
    /is.*online/, /what.*\w+\s*up\s*to/, /what.*\w+\s*doing/,
    /\bhow.*going\b/, /\bwhat.*happening\b/, /\bwhat.*\w+\s*been\s*doing\b/,
    /\bwhere.*\w+\s*at\b/, /\bwhat.*\w+\s*like\b/,
    // Filipino / Tagalog
    /anong\s*ginagawa/, /ano.*ginagawa/, /kumusta.*ngayon/,
    /nasa\s*saan/, /nasaan/, /nasan/,
    /ano.*ginagawa.*ngayon/, /ano.*ginagawa.*niya/, /ano.*ginagawa.*nila/,
    /kamusta.*ngayon/, /ano.*balita/, /ano.*nangyayari/,
    /libre\s*ba/, /available\s*ba/, /busy\s*ba/, /pwede\s*ba/,
    /pwede.*makausap/, /makakaausap\s*ba/, /kasalukuyan/,
    /saan.*nandoon/, /nandoon\s*ba/, /nandito\s*ba/,
    /anong.*oras\s*matapos/, /kailan.*matapos/, /kailan.*libre/,
    /nasa.*bahay\s*ba/, /nasa.*labas\s*ba/,
    // Taglish
    /what.*ginagawa/, /anong.*doing/, /is.*available\s*ba/,
    /free\s*ba\s*siya/, /busy\s*ba\s*siya/, /ano.*up\s*to/,
  ];

  const isAskingAboutActivity = askingPatterns.some(p => p.test(msg));
  if (!isAskingAboutActivity) return null;

  for (const [, { display, activity, ts }] of Object.entries(adminStatuses)) {
    const nameParts = display.toLowerCase().split(/\s+/).filter(p => p.length > 1);
    const matched   = nameParts.some(part => msg.includes(part));
    if (matched) {
      // ── Timestamp-aware duration string ─────────────────────────
      let durationNote = '';
      if (ts) {
        const mins = Math.floor((Date.now() - ts) / 60000);
        const hrs  = Math.floor(mins / 60);
        if (hrs > 0) {
          durationNote = ` (for about ${hrs} hour${hrs > 1 ? 's' : ''}${mins % 60 > 0 ? ` ${mins % 60} min` : ''})`;
        } else if (mins > 2) {
          durationNote = ` (for about ${mins} minute${mins > 1 ? 's' : ''})`;
        } else if (mins >= 0) {
          durationNote = ` (just recently)`;
        }
      }

      const baseReplies = [
        `◈ ${display} is currently **${activity}**${durationNote}. ✦`,
        `Right now, ${display} is **${activity}**${durationNote}. ◈`,
        `${display} is **${activity}** at the moment${durationNote}. ✦`,
        `◈ As of now, ${display} is **${activity}**${durationNote}. ✦`,
      ];
      const base   = baseReplies[Math.floor(Math.random() * baseReplies.length)];
      const extras = getActivityExtras(display, activity);
      return base + '\n\n' + extras.join(' ');
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// ◈ CROSS-USER CONVERSATION AWARENESS
// When User B asks "how is User A doing?" or "what are User A and Luna
// talking about?", Luna fetches User A's current topic from Firebase
// and tells User B what User A has been discussing.
// ══════════════════════════════════════════════════════════════════

/**
 * Called after every exchange. Writes a brief topic snapshot for the
 * current user so other users can ask Luna about it.
 * Stored at: luna-user-topics/<userKey> = { name, topic, ts }
 */
async function pushUserTopicToFirebase(userMsg, lunaReply) {
  if (!firebaseReady || !firebaseDb || !userName || !currentUserId) return;
  try {
    // Build a short topic string from the user's last message (max 200 chars)
    const topic = userMsg.replace(/\n+/g, ' ').trim().slice(0, 200);
    const lunaSnippet = lunaReply.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\n+/g, ' ').trim().slice(0, 200);
    await firebaseDb.ref(`luna-user-topics/${currentUserId}`).set({
      name:        userName,
      topic,
      lunaSnippet,
      ts:          Date.now(),
    });
  } catch {}
}

/**
 * Patterns that mean "how is <name> doing" / "what are <name> and Luna
 * talking about" / "what is <name> up to with Luna".
 */
const CONV_QUERY_PATTERNS = [
  // English
  /how.*is\s+(\w+)\s+doing/i,
  /what.*is\s+(\w+)\s+(talking|discussing|chatting|saying|telling)\b/i,
  /what.*are\s+(\w+)\s+(and\s+luna|talking|discussing|chatting|saying)\b/i,
  /what.*\s+(\w+)\s+(and\s+luna|luna\s+and\s+\w+)\s+(talking|discussing|talking about)\b/i,
  /what.*\s+(\w+)\s+talking.*about/i,
  /what.*luna.*talking.*with\s+(\w+)/i,
  /what.*(\w+).*talking.*luna/i,
  /how.*(\w+).*doing.*luna/i,
  /(\w+).*and.*luna.*talking/i,
  // Filipino / Tagalog
  /kumusta\s+na\s+(\w+)/i,
  /ano.*pinag-uusapan.*(\w+)/i,
  /ano.*kinukuwento.*(\w+)/i,
  /ano.*usapan.*(\w+)/i,
  /anong.*pinag-uusapan.*(\w+)/i,
  /(\w+).*at.*luna.*ano.*usapan/i,
  /paano.*(\w+)/i,
];

/**
 * Checks if the current user is asking about another user's conversation
 * with Luna. If so, fetches that user's topic from Firebase and returns
 * a reply string — or null if this is not such a query.
 */
async function checkConversationQuery(message) {
  if (!firebaseReady || !firebaseDb || !allRegisteredUsers.length) return null;
  const msg = message.toLowerCase();

  // Find which registered user is being asked about
  let mentionedUser = null;
  for (const user of allRegisteredUsers) {
    if (!user.name || user.name.length < 2) continue;
    // Skip asking about yourself
    if (user.name.toLowerCase() === (userName || '').toLowerCase()) continue;
    const nameLower = user.name.toLowerCase();
    const regex = new RegExp(`\\b${nameLower}\\b`, 'i');
    if (regex.test(msg)) {
      // Also verify the message is asking about conversation / status with Luna
      const isConvQuery = CONV_QUERY_PATTERNS.some(p => p.test(msg)) ||
        /how.*is|what.*doing|what.*talking|kumusta|pinag-uusapan|usapan|ano.*sila|ano.*siya/i.test(msg);
      if (isConvQuery) {
        mentionedUser = user;
        break;
      }
    }
  }
  if (!mentionedUser) return null;

  // Fetch that user's topic snapshot from Firebase
  try {
    const snap = await firebaseDb.ref(`luna-user-topics/${mentionedUser.key}`).once('value');
    const data = snap.val();
    if (!data || !data.topic) {
      // User exists but hasn't chatted yet
      return `◈ **${mentionedUser.name}** hasn't started a conversation with me yet — or at least not recently. Once they do, I'll be able to tell you what we're talking about. ✦`;
    }

    const { name, topic, lunaSnippet, ts } = data;

    // Duration note
    let when = '';
    if (ts) {
      const mins = Math.floor((Date.now() - ts) / 60000);
      const hrs  = Math.floor(mins / 60);
      if (hrs > 0) when = ` (about ${hrs}h ${mins % 60}m ago)`;
      else if (mins > 1) when = ` (about ${mins} minute${mins > 1 ? 's' : ''} ago)`;
      else when = ` (just recently)`;
    }

    // Build the reply
    const replies = [
      `◈ **${name}** and I were just talking${when}! They asked me: *"${topic}"* — and I told them: *"${lunaSnippet}"* ✦`,
      `Right now${when}, **${name}** and I are chatting about this: *"${topic}"* — and I replied with something like: *"${lunaSnippet}"* ◈`,
      `**${name}** reached out to me${when}. Their last message was: *"${topic}"* — I responded with: *"${lunaSnippet}"* ✦`,
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
// ◈ REPLY THREADING — tap any Luna message to reply to it
// ══════════════════════════════════════════════════════════════════

// Inject the reply bar element above the input box
function injectReplyBar() {
  const bar = document.createElement('div');
  bar.id = 'replyBar';
  bar.innerHTML = `
    <div class="reply-bar-accent"></div>
    <div class="reply-bar-info">
      <div class="reply-bar-label">↩ REPLYING TO LUNA</div>
      <div class="reply-bar-preview" id="replyBarPreview"></div>
    </div>
    <button class="reply-bar-close" onclick="clearReplyContext()" title="Cancel reply">✕</button>
  `;
  const inputBox = document.getElementById('inputBox');
  if (inputBox && inputBox.parentNode) {
    inputBox.parentNode.insertBefore(bar, inputBox);
  }
}

// Activate reply mode: highlight the source Luna message, show the reply bar
function setReplyContext(msgId, rawText) {
  const plain = rawText.replace(/\s+/g, ' ').trim();
  replyingTo = { msgId, previewText: plain.slice(0, 100) + (plain.length > 100 ? '…' : '') };

  const preview = document.getElementById('replyBarPreview');
  if (preview) preview.textContent = replyingTo.previewText;

  const bar = document.getElementById('replyBar');
  if (bar) bar.classList.add('active');

  // Clear any previous highlight, then highlight the target message
  document.querySelectorAll('.message.reply-active').forEach(m => m.classList.remove('reply-active'));
  const src = document.querySelector(`.message[data-msg-id="${msgId}"]`);
  if (src) {
    src.classList.add('reply-active');
    src.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  userInput.focus();
}

// Cancel reply mode
function clearReplyContext() {
  replyingTo = null;
  const bar = document.getElementById('replyBar');
  if (bar) bar.classList.remove('active');
  document.querySelectorAll('.message.reply-active').forEach(m => m.classList.remove('reply-active'));
}

// Click handler on the reply quote block — scrolls to the original Luna message and flashes it
function jumpToReplyTarget(msgId) {
  const target = document.querySelector(`.message[data-msg-id="${msgId}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const bubble = target.querySelector('.bubble');
  if (!bubble) return;
  // Flash border briefly to draw the eye
  bubble.style.transition = 'border-color 0.1s, box-shadow 0.1s';
  bubble.style.borderColor = 'var(--violet-bright)';
  bubble.style.boxShadow   = '0 0 22px rgba(168,85,247,0.3)';
  setTimeout(() => {
    bubble.style.borderColor = '';
    bubble.style.boxShadow   = '';
    setTimeout(() => { bubble.style.transition = ''; }, 400);
  }, 1600);
}

// ══════════════════════════════════════════════════════════════════
// ◈ IMAGE GENERATION ENGINE — Pollinations.ai (no API key needed)
// ══════════════════════════════════════════════════════════════════

const IMAGE_GEN_PATTERNS = [
  /\b(draw|gumawa ng larawan|i-draw|ig-draw|iguhit|guhit)\b/i,
  /\b(generate|create|make|generate an?|create an?|make an?)\s+(image|picture|photo|illustration|artwork|art|drawing|painting|sketch)\b/i,
  /\b(show me|imagine|visualize|render)\b.{0,60}\b(image|picture|photo|art|drawing|scene|of)\b/i,
  /\b(picture|image|illustration|drawing|artwork)\s+of\b/i,
  /\blarawan\s+ng\b/i,
  /\b(anime|fanart|portrait|wallpaper|logo)\s+(of|para|ng|for)\b/i,
];

function isImageRequest(text) {
  return IMAGE_GEN_PATTERNS.some(p => p.test(text));
}

// Extract a clean image prompt from the user's message
function extractImagePrompt(text) {
  // Strip common trigger words to get the core subject
  return text
    .replace(/\b(please|pls|po|naman|nga|pwede|can you|luna|hey|hi)\b/gi, '')
    .replace(/\b(draw|generate|create|make|show me|imagine|visualize|render|gumawa ng larawan|i-draw|iguhit|picture of|image of|larawan ng|illustration of|artwork of|painting of|sketch of)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || text.trim();
}

// Render a generated image inside a Luna bubble
function _lunaImgButtons(imgUrl, prompt, msgId) {
  const safePrompt = escHtml(prompt).replace(/'/g, "\'");
  const safeUrl    = escHtml(imgUrl);
  return `
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
      <a href="${safeUrl}" target="_blank" rel="noopener noreferrer"
        style="padding:6px 14px;border-radius:8px;border:1px solid rgba(168,85,247,0.35);
        background:rgba(168,85,247,0.1);color:var(--violet-bright);
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.12em;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px;">
        ⬇ SAVE IMAGE
      </a>
      <button onclick="regenerateLunaImage('${safePrompt}','${escHtml(msgId)}')"
        style="padding:6px 14px;border-radius:8px;border:1px solid rgba(168,85,247,0.35);
        background:rgba(168,85,247,0.1);color:var(--violet-bright);
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.12em;cursor:pointer;">
        ↺ REGENERATE
      </button>
    </div>`;
}

function _lunaImgContent(imgUrl, prompt, msgId) {
  const shortPrompt = escHtml(prompt.slice(0,80)) + (prompt.length>80?'…':'');
  return `
    <div style="position:relative;border-radius:14px;overflow:hidden;
      border:1px solid rgba(168,85,247,0.3);box-shadow:0 4px 32px rgba(168,85,247,0.18);">
      <img src="${escHtml(imgUrl)}" alt="${escHtml(prompt)}"
        style="width:100%;max-width:420px;display:block;border-radius:14px;" />
      <div style="position:absolute;bottom:0;left:0;right:0;
        background:linear-gradient(transparent,rgba(2,2,9,0.85));
        padding:10px 12px 8px;font-size:10px;color:rgba(240,230,255,0.7);
        font-family:var(--font-hud,monospace);letter-spacing:0.08em;">
        ${shortPrompt}
      </div>
    </div>
    ${_lunaImgButtons(imgUrl, prompt, msgId)}`;
}

function _loadImageWithRetry(imgWrap, imageUrl, prompt, msgId, attempt) {
  attempt = attempt || 1;
  const MAX = 3;
  let elapsed = 0;
  let ticker  = null;

  // Update loading label with live seconds counter
  function setLoadingLabel(txt) {
    const el = imgWrap.querySelector('.luna-img-loading');
    if (el) el.innerHTML = `<span style="animation:spinCW 1s linear infinite;display:inline-block;">◈</span> ${txt}`;
  }

  ticker = setInterval(() => {
    elapsed++;
    setLoadingLabel(`RENDERING IMAGE… ${elapsed}s`);
  }, 1000);

  const img = new Image();
  img.crossOrigin = 'anonymous';

  img.onload = () => {
    clearInterval(ticker);
    imgWrap.innerHTML = _lunaImgContent(imageUrl, prompt, msgId);
    scrollDown();
  };

  img.onerror = () => {
    clearInterval(ticker);
    if (attempt < MAX) {
      // Wait 2s then retry with a fresh seed
      setLoadingLabel(`RETRYING… (attempt ${attempt + 1}/${MAX})`);
      setTimeout(() => {
        const retryUrl = buildPollinationsUrl(prompt);
        _loadImageWithRetry(imgWrap, retryUrl, prompt, msgId, attempt + 1);
      }, 2000);
    } else {
      imgWrap.innerHTML = `
        <div style="padding:14px 16px;border-radius:12px;border:1px solid rgba(236,45,90,0.3);
          background:rgba(236,45,90,0.07);font-size:12px;color:var(--crimson-bright);
          font-family:var(--font-hud,monospace);letter-spacing:0.08em;">
          ◈ IMAGE GENERATION FAILED
          <div style="margin-top:6px;font-size:11px;color:var(--text-mid);font-family:var(--font-body);">
            Pollinations may be temporarily slow. Try the ↺ Regenerate button or rephrase your prompt.
          </div>
          ${_lunaImgButtons(imageUrl, prompt, msgId)}
        </div>`;
    }
  };

  // Pollinations can take 15-40s — no artificial timeout, just let it load
  img.src = imageUrl;
}

function appendImageBubble(imageUrl, prompt, lunaText) {
  const msgId = 'img-' + Date.now();
  const wrap = document.createElement('div');
  wrap.className = 'message luna';
  wrap.dataset.msgId = msgId;

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  wrap.innerHTML = `
    <div class="av av-luna">LN</div>
    <div class="bubble">
      <span class="bubble-header">◈ LUNA · IMAGE GENERATION</span>
      <div class="bubble-text">${formatMarkdown(lunaText)}</div>
      <div class="luna-image-wrap" style="margin-top:12px;">
        <div class="luna-img-loading" style="
          display:flex;align-items:center;gap:10px;padding:14px 16px;
          background:rgba(168,85,247,0.07);border:1px solid rgba(168,85,247,0.2);
          border-radius:12px;font-size:12px;color:var(--text-mid);
          font-family:var(--font-hud,monospace);letter-spacing:0.1em;">
          <span style="animation:spinCW 1s linear infinite;display:inline-block;">◈</span>
          RENDERING IMAGE…
        </div>
      </div>
      <span class="bubble-time">${time}</span>
    </div>
  `;

  chatFeed.querySelector('.welcome-card')?.remove();
  chatFeed.appendChild(wrap);
  scrollDown();

  const imgWrap = wrap.querySelector('.luna-image-wrap');
  _loadImageWithRetry(imgWrap, imageUrl, prompt, msgId, 1);

  msgCount++;
  msgDisplay.textContent = msgCount;
  animateStats();
  return wrap;
}

function buildPollinationsUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  return `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=512&height=512&seed=${seed}&nologo=true`;
}

async function generateAndShowImage(userText, lunaReply) {
  const prompt = extractImagePrompt(userText);
  const url = buildPollinationsUrl(prompt);
  appendImageBubble(url, prompt, lunaReply);
}

// Kept for backward compat — no longer uses fetch (CORS), opens image in new tab instead
function downloadLunaImage(url, prompt, btn) {
  window.open(url, '_blank');
}

// Regenerate with new seed
function regenerateLunaImage(prompt, msgId) {
  const wrap = document.querySelector(`.message[data-msg-id="${msgId}"]`);
  if (!wrap) return;
  let imgWrap = wrap.querySelector('.luna-image-wrap');
  if (!imgWrap) {
    // Create one if missing
    imgWrap = document.createElement('div');
    imgWrap.className = 'luna-image-wrap';
    imgWrap.style.marginTop = '12px';
    wrap.querySelector('.bubble').appendChild(imgWrap);
  }
  imgWrap.innerHTML = `
    <div class="luna-img-loading" style="
      display:flex;align-items:center;gap:10px;padding:14px 16px;
      background:rgba(168,85,247,0.07);border:1px solid rgba(168,85,247,0.2);
      border-radius:12px;font-size:12px;color:var(--text-mid);
      font-family:var(--font-hud,monospace);letter-spacing:0.1em;">
      <span style="animation:spinCW 1s linear infinite;display:inline-block;">◈</span>
      RENDERING NEW VERSION…
    </div>`;
  const newUrl = buildPollinationsUrl(prompt);
  _loadImageWithRetry(imgWrap, newUrl, prompt, msgId, 1);
}

// ── Handle send ───────────────────────────────────────────────────
async function handleSend() {
  const text = userInput.value.trim();
  if (!stagedFiles.length && !stagedImage && (!text || isTyping)) return;
  if (isTyping) return;


  // ── Capture and clear reply context before anything else ─────
  const replyCtx = replyingTo;
  clearReplyContext();

  if (stagedImage) {
    const img = stagedImage, msg = text;
    stagedImage = null; clearStagedImage();
    userInput.value = ''; userInput.style.height = 'auto'; charCounter.textContent = '0/2000';
    await processImage(img, msg); return;
  }

  if (stagedFiles.length) {
    const files = stagedFiles, msg = text;
    stagedFiles = [];
    document.getElementById('fileBadge').style.display = 'none';
    userInput.value = ''; userInput.style.height = 'auto'; charCounter.textContent = '0/2000';
    await processFiles(files, msg); return;
  }

  isTyping = true; sendBtn.disabled = true;
  showStopBtn();

  // Reset any stale provider cooldowns older than 60s so they get a fresh chance
  const now = Date.now();
  Object.keys(_providerCooldowns).forEach(p => {
    if (_providerCooldowns[p] && now >= _providerCooldowns[p]) _providerCooldowns[p] = 0;
  });

  lastUserText = text;
  // ◈ Streak — record that the user chatted now (thaws frozen egg, resets idle timer)
  recordStreakChatActivity();

  // ◈ Tone Detector — auto-shift Luna's mood ring based on message tone
  const detectedTone = detectToneFromMessage(text);
  autoSetLunaMood(detectedTone);

  // ── Auto-moderation check ──────────────────────────────────────
  const blocked = await runAutoModCheck(text);
  if (blocked) { isTyping = false; return; }

  const userMsgId = await appendMessage('user', text, replyCtx);
  userInput.value = ''; userInput.style.height = 'auto'; charCounter.textContent = '0/2000';
  // Haptic feedback on mobile — subtle confirmation of send
  if (navigator.vibrate) navigator.vibrate(18);

  // ── Build Luna's reply-data so her bubble quotes the user's message ──
  // Only attach when this exchange was itself a threaded reply (replyCtx existed)
  const lunaReplyData = replyCtx
    ? { msgId: userMsgId, previewText: text.slice(0, 100) + (text.length > 100 ? '…' : ''), fromUser: true }
    : null;

  showTyping();

  try {
    const statusHit = checkStatusQuery(text);
    if (statusHit) {
      hideTyping();
      lastLunaText = statusHit;
      pushToHistory(text, statusHit);
      await appendMessage('luna', statusHit, lunaReplyData);
      isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly();
      return;
    }

    // ── Cross-user conversation query: "how is User A doing?" ─────
    const convHit = await checkConversationQuery(text);
    if (convHit) {
      hideTyping();
      lastLunaText = convHit;
      pushToHistory(text, convHit);
      await appendMessage('luna', convHit, lunaReplyData);
      isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly();
      return;
    }

    let finalPrompt = text;
    const url = extractURL(text);

    // ── Image Generation — detect and handle before normal flow ───
    if (isImageRequest(text)) {
      hideTyping();
      // Get Luna's excited reaction from the LLM first, then render image
      const imgPrompt = extractImagePrompt(text);
      const reactionPrompt = `The user asked you to generate this image: "${imgPrompt}". Write a SHORT, excited 1-2 sentence reaction (like you're actually creating it). Do NOT describe the image — just express enthusiasm and say you're generating it now.`;
      let lunaReaction = '';
      try {
        lunaReaction = await getLunaResponse(reactionPrompt);
      } catch {
        lunaReaction = `✦ Creating that for you now — generating **${imgPrompt}**!`;
      }
      pushToHistory(text, lunaReaction + ' [image generated]');
      await generateAndShowImage(text, lunaReaction);
      isTyping = false; sendBtn.disabled = false; hideStopBtn(); focusInputDesktopOnly();
      return;
    }

    if (url) {
      // ── Safety check before fetching ──────────────────────────
      const { verdict, reason } = classifyURL(url);
      if (verdict === 'block') {
        // Block outright — show modal, do not fetch, let Luna explain
        hideTyping();
        await showLinkSafetyModal(url, 'block', reason);
        finalPrompt = `The user tried to share a link (${url}) but it was BLOCKED by Luna's link safety system because: ${reason}. Tell the user it has been blocked for their safety, in a brief, caring way. Do not provide any workaround.`;
        const reply2 = await getLunaResponse(finalPrompt);
        pushToHistory(text, reply2);
        hideTyping(); lastLunaText = reply2;
        await appendMessage('luna', reply2, lunaReplyData);
        isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly(); return;
      }
      if (verdict === 'warn') {
        // Show warning, let user decide
        hideTyping();
        const allowed = await showLinkSafetyModal(url, 'warn', reason);
        if (!allowed) {
          // User cancelled — acknowledge and stop
          await appendMessage('luna', `◈ Link scan cancelled. The link was not opened. If you still want to share it, you can try again. ✦`);
          isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly(); return;
        }
        showTyping();
      }
      // Safe or user approved — fetch the page
      hideTyping();
      await appendMessage('luna', `◈ Scanning link: <a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--violet-bright);word-break:break-all;">${escHtml(url)}</a> ✦`);
      showTyping();
      try {
        const pageContent = await fetchWebpage(url);
        finalPrompt = `The user shared this URL: ${url}\n\nWebpage content (extracted text):\n\n${pageContent}\n\nUser message: ${text.replace(url,'').trim() || 'Please summarize this page.'}`;
      } catch (fetchErr) {
        finalPrompt = `The user shared this URL: ${url} but it could not be fetched (${fetchErr.message}). Let them know briefly and offer alternatives.`;
      }
    }
    // ── LIVE STREAMING — build bubble immediately, pipe tokens in as they arrive ──
    hideTyping();
    const lunaWrap = buildMessageWrap('luna', '', true, lunaReplyData);
    chatFeed.appendChild(lunaWrap);
    if (userScrolledUp) {
      newMsgCount++;
      fabBadge.textContent = newMsgCount > 9 ? '9+' : newMsgCount;
      fabBadge.style.display = 'flex';
    }
    scrollDown();

    let reply;
    try {
      reply = await streamLunaResponseLive(finalPrompt, lunaWrap);
    } catch (streamErr) {
      // Remove the orphaned empty bubble before showing the error
      if (lunaWrap && lunaWrap.parentNode) lunaWrap.remove();
      throw streamErr;
    }

    // Post-stream bookkeeping (same as appendMessage path)
    lastLunaText = reply;
    pushToHistory(text, reply);
    updateMoodRing(reply);
    pushMessageToFirebase('assistant', reply);
    saveMessageToUserChatlog('assistant', reply);
    persistedHistory.push({ role: 'assistant', content: reply, ts: Date.now() });
    if (persistedHistory.length > CHATLOG_MAX_MSGS) persistedHistory = persistedHistory.slice(-CHATLOG_MAX_MSGS);
    msgCount++;
    msgDisplay.textContent = msgCount;
    animateStats();

    // ── Cross-user mention scan: did user mention another registered user? ──
    scanForUserMentions(text).catch(() => {});
    pushUserTopicToFirebase(text, reply).catch(() => {});
  } catch (err) {
    hideTyping();
    // AbortError = user pressed STOP — no error message needed
    if (err.name === 'AbortError') {
      isTyping = false; sendBtn.disabled = false; hideStopBtn(); focusInputDesktopOnly();
      return;
    }
    // Show rich error card in the chat bubble
    const raw = err.message || '';
    const isNetwork = /network|fetch|failed to fetch/i.test(raw);
    const isRateLimit = /rate limit|try again|429/i.test(raw);
    const lunaWrap = document.createElement('div');
    lunaWrap.className = 'message luna';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lunaWrap.innerHTML = `
      <div class="av av-luna" aria-label="Luna"><span class="av-glyph">LN</span></div>
      <div class="bubble">
        <span class="bubble-header"><span class="lh-dot"></span><strong>LUNA</strong> · error</span>
        <span class="bubble-text">
          <div style="display:flex;flex-direction:column;gap:10px;padding:4px 0;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:18px;">${isNetwork ? '📡' : '⚠️'}</span>
              <span style="font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.14em;color:var(--crimson-bright,#ec2d5a);">${isNetwork ? 'NO CONNECTION' : isRateLimit ? 'RATE LIMIT HIT' : 'ALL PROVIDERS UNAVAILABLE'}</span>
            </div>
            <p style="margin:0;font-size:13px;color:var(--text-mid,#9580b5);line-height:1.6;">
              ${isNetwork
                ? 'Check your internet connection and try again.'
                : isRateLimit
                  ? 'Your API key has hit its rate limit. Wait a moment or get a fresh key.'
                  : "Luna couldn't reach any AI provider. Your API keys may be exhausted or expired."}
            </p>
            ${raw ? `<details style="margin-top:2px;"><summary style="font-size:10px;color:var(--text-lo,#3d3060);cursor:pointer;">Technical detail</summary><code style="font-size:10px;color:var(--text-lo);word-break:break-all;">${raw.replace(/</g,'&lt;')}</code></details>` : ''}
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;">
              <button onclick="(function(){Object.keys(_providerCooldowns).forEach(k=>_providerCooldowns[k]=0);_keyCooldowns={};showToast('◈ Providers reset — try again','✦',2500);})()" style="padding:7px 14px;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.3);border-radius:8px;color:var(--violet-bright,#a855f7);font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.12em;cursor:pointer;" onmouseover="this.style.background='rgba(168,85,247,0.22)'" onmouseout="this.style.background='rgba(168,85,247,0.1)'">↺ RESET &amp; RETRY</button>
              <a href="https://console.groq.com/keys" target="_blank" rel="noopener" style="padding:7px 14px;background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.25);border-radius:8px;color:var(--crimson-bright,#ec2d5a);font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.12em;text-decoration:none;display:inline-flex;align-items:center;">↗ GET NEW GROQ KEY</a>
            </div>
            <p style="margin:0;font-size:10px;color:var(--text-lo,#3d3060);">Free Groq keys: 14,400 req/day · 500K tokens/day</p>
          </div>
        </span>
        <div class="bubble-footer"><span class="bubble-time">${time}</span></div>
      </div>`;
    chatFeed.appendChild(lunaWrap);
    if (!userScrolledUp) scrollDown();
  }
  isTyping = false; sendBtn.disabled = false; hideStopBtn(); focusInputDesktopOnly();
}

// ══════════════════════════════════════════════════════════════════
// ◈ ACCOUNT SYSTEM — Sign Up / Sign In / Presence
// ══════════════════════════════════════════════════════════════════

let authMode = 'signin'; // 'signin' | 'signup'

// ── Switch between Sign In and Create Account tabs ────────────────
function switchAuthTab(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  document.getElementById('tabSignIn').classList.toggle('active', !isSignup);
  document.getElementById('tabSignUp').classList.toggle('active',  isSignup);
  document.getElementById('confirmField').style.display = isSignup ? 'flex' : 'none';
  document.getElementById('secQField').style.display    = isSignup ? 'flex' : 'none';
  document.getElementById('secAField').style.display    = isSignup ? 'flex' : 'none';
  const forgotLink = document.getElementById('forgotPwLink');
  if (forgotLink) forgotLink.style.display = isSignup ? 'none' : 'block';
  document.getElementById('submitBtnLabel').textContent  = isSignup ? 'CREATE ACCOUNT ◈' : 'SIGN IN ◈';
  clearAuthMsg();
  validateAuthForm();
  // focus password after name if already filled
  const ni = document.getElementById('nameInput');
  if (ni.value.trim()) document.getElementById('passwordInput').focus();
  else ni.focus();
}

// ── Show/hide admin code prompt ───────────────────────────────────
function showAdminCodePrompt() {
  const overlay = document.getElementById('adminCodeOverlay');
  overlay.style.display = 'flex';
  overlay.style.pointerEvents = 'auto';
  setTimeout(() => document.getElementById('adminCodeInput')?.focus(), 100);
}
function hideAdminCodePrompt() {
  const overlay = document.getElementById('adminCodeOverlay');
  overlay.style.display = 'none';
  overlay.style.pointerEvents = 'none';
  if (document.getElementById('adminCodeInput')) document.getElementById('adminCodeInput').value = '';
}

// ══════════════════════════════════════════════════════════════════
// ◈ FORGOT PASSWORD — 3-step recovery flow
// ══════════════════════════════════════════════════════════════════

let fpwAccountKey = null; // key of account being recovered

function openForgotPassword() {
  fpwAccountKey = null;
  fpwGoToStep(1);
  fpwClearMsg();
  const overlay = document.getElementById('forgotPwOverlay');
  overlay.classList.add('open');
  document.getElementById('fpwUsername').value = '';
  document.getElementById('fpwAnswer').value   = '';
  document.getElementById('fpwNewPass').value  = '';
  document.getElementById('fpwConfirmPass').value = '';
  document.getElementById('fpwSub').textContent = 'Enter your username to begin the recovery process.';
  // Pre-fill username if already typed in sign-in form
  const existing = document.getElementById('nameInput')?.value.trim();
  if (existing) document.getElementById('fpwUsername').value = existing;
  setTimeout(() => document.getElementById('fpwUsername').focus(), 180);
  // Wire up input listeners
  document.getElementById('fpwUsername').oninput    = () => {
    document.getElementById('fpwStep1Btn').disabled = !document.getElementById('fpwUsername').value.trim();
    fpwClearMsg();
  };
  document.getElementById('fpwAnswer').oninput      = () => {
    document.getElementById('fpwStep2Btn').disabled = !document.getElementById('fpwAnswer').value.trim();
    fpwClearMsg();
  };
  ['fpwNewPass','fpwConfirmPass'].forEach(id => {
    document.getElementById(id).oninput = fpwValidateNewPass;
  });
  // Enter key support
  document.getElementById('fpwUsername').onkeydown    = e => { if (e.key === 'Enter') fpwLookup(); };
  document.getElementById('fpwAnswer').onkeydown      = e => { if (e.key === 'Enter') fpwVerifyAnswer(); };
  document.getElementById('fpwConfirmPass').onkeydown = e => { if (e.key === 'Enter') fpwResetPassword(); };
}

function closeForgotPassword() {
  document.getElementById('forgotPwOverlay').classList.remove('open');
  fpwAccountKey = null;
}

function fpwGoToStep(n) {
  [1,2,3].forEach(i => {
    const step = document.getElementById(`fpwStep${i}`);
    const dot  = document.getElementById(`fpwDot${i}`);
    if (step) step.classList.toggle('active', i === n);
    if (dot) {
      dot.classList.remove('active','done');
      if (i === n)  dot.classList.add('active');
      if (i < n)    dot.classList.add('done');
    }
  });
  fpwClearMsg();
}

function fpwShowMsg(msg, type = 'error') {
  const el = document.getElementById('fpwMsg');
  if (!el) return;
  el.textContent = msg;
  el.className = `fpw-msg ${type}`;
}
function fpwClearMsg() {
  const el = document.getElementById('fpwMsg');
  if (el) { el.textContent = ''; el.className = 'fpw-msg'; }
}

// Step 1 — look up account by username
async function fpwLookup() {
  const raw = document.getElementById('fpwUsername').value.trim();
  if (!raw) return;
  if (!firebaseReady || !firebaseDb) { fpwShowMsg('Firebase offline. Cannot recover password.'); return; }
  const btn = document.getElementById('fpwStep1Btn');
  btn.disabled = true; btn.textContent = 'SEARCHING…';
  try {
    const key  = userKey(raw);
    const snap = await firebaseDb.ref(`luna-accounts/${key}`).once('value');
    if (!snap.exists()) {
      fpwShowMsg(`No account found for "${raw}". Check spelling or create a new account.`); return;
    }
    const account = snap.val();
    fpwAccountKey = key;
    if (account.secQ) {
      // Has a security question
      document.getElementById('fpwQuestionLabel').textContent = account.secQ;
      document.getElementById('fpwSub').textContent = `Account found! Answer your security question to continue.`;
      fpwGoToStep(2);
      setTimeout(() => document.getElementById('fpwAnswer').focus(), 150);
    } else {
      // Old account with no security question — skip straight to reset
      // (less secure but avoids locking users out forever)
      document.getElementById('fpwSub').textContent = `Account found. No security question on file — set your new password directly.`;
      fpwGoToStep(3);
      fpwGoToStep(3); // also mark dot 2 done
      document.getElementById('fpwDot2').classList.remove('active');
      document.getElementById('fpwDot2').classList.add('done');
      document.getElementById('fpwDot3').classList.add('active');
      setTimeout(() => document.getElementById('fpwNewPass').focus(), 150);
    }
  } catch (err) {
    fpwShowMsg('Lookup failed. Please try again.'); console.warn(err);
  } finally {
    btn.disabled = false; btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      FIND ACCOUNT ◈`;
  }
}

// Step 2 — verify security answer
async function fpwVerifyAnswer() {
  const answer = document.getElementById('fpwAnswer').value.trim().toLowerCase();
  if (!answer || !fpwAccountKey) return;
  if (!firebaseReady || !firebaseDb) { fpwShowMsg('Firebase offline.'); return; }
  const btn = document.getElementById('fpwStep2Btn');
  btn.disabled = true; btn.textContent = 'VERIFYING…';
  try {
    const snap = await firebaseDb.ref(`luna-accounts/${fpwAccountKey}`).once('value');
    const account = snap.val();
    if (!account) { fpwShowMsg('Account not found. Please restart.'); return; }
    const stored = account.secA ? (() => { try { return atob(account.secA); } catch { return ''; } })() : '';
    if (answer !== stored) {
      fpwShowMsg('Incorrect answer. Please try again.'); return;
    }
    document.getElementById('fpwSub').textContent = 'Identity verified! Choose a new password.';
    fpwGoToStep(3);
    setTimeout(() => document.getElementById('fpwNewPass').focus(), 150);
  } catch (err) {
    fpwShowMsg('Verification failed. Try again.'); console.warn(err);
  } finally {
    btn.disabled = false; btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      VERIFY ANSWER ◈`;
  }
}

// Step 3 — validate passwords match before enabling button
function fpwValidateNewPass() {
  const p1 = document.getElementById('fpwNewPass').value;
  const p2 = document.getElementById('fpwConfirmPass').value;
  const btn = document.getElementById('fpwStep3Btn');
  if (!btn) return;
  btn.disabled = !(p1.length >= 4 && p1 === p2);
  if (p2.length > 0 && p1 !== p2) {
    fpwShowMsg('Passwords do not match.');
  } else {
    fpwClearMsg();
  }
}

// Step 3 — write new password to Firebase
async function fpwResetPassword() {
  const newPass = document.getElementById('fpwNewPass').value;
  const confirm = document.getElementById('fpwConfirmPass').value;
  if (newPass.length < 4) { fpwShowMsg('Password must be at least 4 characters.'); return; }
  if (newPass !== confirm) { fpwShowMsg('Passwords do not match.'); return; }
  if (!fpwAccountKey || !firebaseReady || !firebaseDb) { fpwShowMsg('Session expired. Please restart.'); return; }
  const btn = document.getElementById('fpwStep3Btn');
  btn.disabled = true; btn.textContent = 'SAVING…';
  try {
    await firebaseDb.ref(`luna-accounts/${fpwAccountKey}`).update({ password: btoa(newPass) });
    fpwShowMsg('Password reset successfully! You can now sign in. ◈', 'success');
    document.getElementById('fpwDot3').classList.remove('active');
    document.getElementById('fpwDot3').classList.add('done');
    // Auto-close and pre-fill the sign-in form after a moment
    setTimeout(() => {
      closeForgotPassword();
      const acSnap = firebaseDb.ref(`luna-accounts/${fpwAccountKey}`).once('value');
      acSnap.then(s => {
        const nm = s.val()?.name || '';
        if (nm) document.getElementById('nameInput').value = nm;
        document.getElementById('passwordInput').value = '';
        document.getElementById('passwordInput').focus();
        showAuthMsg('Password reset! Enter your new password to sign in.', 'success');
        validateAuthForm();
      });
    }, 2200);
  } catch (err) {
    fpwShowMsg('Reset failed. Please try again.'); console.warn(err);
    btn.disabled = false; btn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      RESET PASSWORD ◈`;
  }
}
function submitAdminCode() {
  const code = document.getElementById('adminCodeInput')?.value.trim();
  if (code === ADMIN_CODE) {
    hideAdminCodePrompt();
    dismissNameOverlay(() => enterAdmin());
  } else {
    document.getElementById('adminCodeInput').classList.add('error');
    setTimeout(() => document.getElementById('adminCodeInput')?.classList.remove('error'), 1200);
  }
}

// ── Auth message helper ───────────────────────────────────────────
function showAuthMsg(msg, type = 'error') {
  const el = document.getElementById('neMsg');
  if (!el) return;
  el.textContent = msg;
  el.className   = `ne-msg ${type}`;
}
function clearAuthMsg() {
  const el = document.getElementById('neMsg');
  if (el) { el.textContent = ''; el.className = 'ne-msg'; }
}

// ── Validate form → enable/disable submit ─────────────────────────
function validateAuthForm() {
  const name    = document.getElementById('nameInput')?.value.trim() || '';
  const pass    = document.getElementById('passwordInput')?.value    || '';
  const confirm = document.getElementById('confirmInput')?.value     || '';
  const ok = authMode === 'signin'
    ? name.length >= 2 && pass.length >= 4
    : name.length >= 2 && pass.length >= 4 && confirm.length >= 4;
  const btn = document.getElementById('nameSubmitBtn');
  if (btn) {
    btn.disabled      = false; // always keep clickable so click handler fires and shows helpful error
    btn.style.opacity = ok ? '1' : '0.5';
    btn.style.cursor  = ok ? 'pointer' : 'default';
  }
}

// ── Init auth overlay ─────────────────────────────────────────────
function initNameEntry() {
  ['nameInput','passwordInput','confirmInput'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => { clearAuthMsg(); validateAuthForm(); });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAuthSubmit();
      }
    });
  });
  document.getElementById('nameSubmitBtn')?.addEventListener('click', handleAuthSubmit);
  document.getElementById('adminCodeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitAdminCode();
  });
  setTimeout(() => document.getElementById('nameInput')?.focus(), 600);
}

// ── Dispatch sign-in or sign-up ───────────────────────────────────
async function handleAuthSubmit() {
  const name    = document.getElementById('nameInput').value.trim();
  const pass    = document.getElementById('passwordInput').value;
  const confirm = document.getElementById('confirmInput')?.value || '';
  const btn     = document.getElementById('nameSubmitBtn');

  // Validate and show helpful messages if incomplete
  if (!name || name.length < 2) {
    showAuthMsg('Please enter a username (at least 2 characters).'); return;
  }
  if (!pass || pass.length < 4) {
    showAuthMsg('Please enter a password (at least 4 characters).'); return;
  }
  if (authMode === 'signup' && confirm.length < 4) {
    showAuthMsg('Please confirm your password.'); return;
  }

  btn.disabled = true;
  btn.classList.add('loading');
  document.getElementById('submitBtnLabel').textContent = 'CONNECTING…';

  try {
    if (authMode === 'signup') await handleSignUp(name, pass, confirm);
    else                       await handleSignIn(name, pass);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    document.getElementById('submitBtnLabel').textContent =
      authMode === 'signup' ? 'CREATE ACCOUNT ◈' : 'SIGN IN ◈';
    validateAuthForm();
  }
}

// ── Generate a stable key from a username ────────────────────────
function userKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0,32);
}

// ── localStorage Account Store — offline / local-file fallback ──────
const LS_ACCOUNTS_KEY = 'luna-local-accounts';

function lsGetAccounts() {
  try { return JSON.parse(localStorage.getItem(LS_ACCOUNTS_KEY) || '{}'); } catch { return {}; }
}
function lsSaveAccount(key, data) {
  try {
    const accounts = lsGetAccounts();
    accounts[key] = data;
    localStorage.setItem(LS_ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {}
}
function lsGetAccount(key) {
  return lsGetAccounts()[key] || null;
}

// ── Persistent Session — remember logged-in user across page loads ─
const SESSION_STORAGE_KEY = 'luna-persistent-session';
const IDB_NAME            = 'LunaDB';
const IDB_STORE           = 'session';
const IDB_KEY             = 'persist';

// ── IndexedDB helpers — works on file://, survives localStorage clears ──
function _idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbSave(data) {
  try {
    const db  = await _idbOpen();
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(data, IDB_KEY);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch {}
}
async function idbLoad() {
  try {
    const db   = await _idbOpen();
    const tx   = db.transaction(IDB_STORE, 'readonly');
    const data = await new Promise((res, rej) => {
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    db.close();
    return (data && data.name && data.key) ? data : null;
  } catch { return null; }
}
async function idbClear() {
  try {
    const db = await _idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch {}
}

// ── Session save — writes to localStorage (fast) + IndexedDB (durable) ──
function savePersistedSession(name, key) {
  const data = { name, key, ts: Date.now() };
  try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data)); } catch {}
  idbSave(data);
}

// ── Session clear — wipes both stores ──
function clearPersistedSession() {
  try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
  idbClear();
}

// ── Sync check of localStorage only (fast, called first) ──
function loadPersistedSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.name && data.key) return data;
    }
  } catch {}
  return null;
}

// ── Async fallback — reads IndexedDB when localStorage came up empty ──
async function loadPersistedSessionAsync() {
  const data = await idbLoad();
  if (data) {
    try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data)); } catch {}
    return data;
  }
  return null;
}

// ── SIGN UP — create new account in Firebase + localStorage fallback ─
async function handleSignUp(name, pass, confirm) {
  if (pass !== confirm) { showAuthMsg('Passwords do not match.'); return; }
  const key = userKey(name);
  const secQ = document.getElementById('secQSelect')?.value  || '';
  const secA = document.getElementById('secAInput')?.value.trim().toLowerCase() || '';
  if (!secQ || !secA) { showAuthMsg('Please choose a security question and provide an answer.'); return; }

  const accountData = {
    name, key,
    password: btoa(pass),
    secQ,
    secA: btoa(secA),
    createdAt: Date.now(),
  };

  // Always save to localStorage (works offline / local file)
  if (lsGetAccount(key)) {
    showAuthMsg(`Username "${name}" is already taken. Try another or sign in.`); return;
  }
  lsSaveAccount(key, accountData);

  // Also try Firebase if available
  if (firebaseReady && firebaseDb) {
    try {
      const snap = await firebaseDb.ref(`luna-accounts/${key}`).once('value');
      if (snap.exists()) {
        showAuthMsg(`Username "${name}" is already taken. Try another or sign in.`); return;
      }
      await firebaseDb.ref(`luna-accounts/${key}`).set(accountData);
    } catch (err) {
      console.warn('Firebase signup write failed (localStorage used):', err);
    }
  }

  showAuthMsg('Account created! Signing you in…', 'success');
  await new Promise(r => setTimeout(r, 900));
  await enterChat(name, key);
  savePersistedSession(name, key);
}

// ── SIGN IN — verify credentials (Firebase + localStorage fallback) ─
async function handleSignIn(name, pass) {
  const key = userKey(name);

  // ── Try Firebase first (if online) ───────────────────────────────
  if (firebaseReady && firebaseDb) {
    try {
      const snap = await firebaseDb.ref(`luna-accounts/${key}`).once('value');
      if (snap.exists()) {
        const account = snap.val();
        if (atob(account.password) !== pass) {
          showAuthMsg('Incorrect password. Please try again.'); return;
        }
        // Mirror account to localStorage for offline use
        lsSaveAccount(key, account);
        // ── Check ban / suspend status ──────────────────────────
        const banStatus = await checkUserBanStatus(account.name || name);
        if (banStatus) {
          if (banStatus.type === 'ban') {
            showAuthMsg(`⬡ This account is permanently banned. ${banStatus.reason || ''}`); return;
          }
          if (banStatus.type === 'suspend' && banStatus.until > Date.now()) {
            const mins = Math.ceil((banStatus.until - Date.now()) / 60000);
            const unit = mins >= 60 ? `${Math.ceil(mins/60)}h` : `${mins}m`;
            showAuthMsg(`⬡ This account is suspended for ${unit} more. ${banStatus.reason || ''}`); return;
          }
          if (banStatus.type === 'suspend') {
            firebaseDb.ref(`luna-bans/${banKey(account.name || name)}`).remove().catch(()=>{});
          }
        }
        await enterChat(account.name, key);
        savePersistedSession(account.name, key);
        return;
      }
      // Account not in Firebase — fall through to localStorage
    } catch (err) {
      console.warn('Firebase sign-in lookup failed, trying localStorage:', err);
    }
  }

  // ── localStorage fallback (offline / local file / Firebase miss) ──
  const localAccount = lsGetAccount(key);
  if (localAccount) {
    try {
      if (atob(localAccount.password) !== pass) {
        showAuthMsg('Incorrect password. Please try again.'); return;
      }
      showAuthMsg('Signing in…', 'success');
      await new Promise(r => setTimeout(r, 500));
      await enterChat(localAccount.name || name, key, !firebaseReady);
      savePersistedSession(localAccount.name || name, key);
      return;
    } catch (err) {
      console.warn('localStorage sign-in error:', err);
    }
  }

  // ── No account found anywhere — offer to create one ──────────────
  showAuthMsg(`No account found for "${name}". Please create an account first.`);
}

// ── Firebase path helpers ─────────────────────────────────────────
function userChatlogRef() {
  if (!firebaseReady || !firebaseDb || !currentUserId) return null;
  return firebaseDb.ref(`luna-user-chatlogs/${currentUserId}`);
}
function userProfileRef(key) {
  if (!firebaseReady || !firebaseDb) return null;
  return firebaseDb.ref(`luna-user-profiles/${key || currentUserId}`);
}

// ── Save a message to user's Firebase chatlog (fire-and-forget) ───
function saveMessageToUserChatlog(role, content) {
  const ref = userChatlogRef();
  if (!ref) return;
  ref.push({ role, content, ts: Date.now() })
    .then(async () => {
      // Trim to max — keep only the freshest CHATLOG_MAX_MSGS entries
      try {
        const snap = await ref.orderByChild('ts').once('value');
        const msgs = [];
        snap.forEach(c => msgs.push({ key: c.key, ts: c.val().ts }));
        if (msgs.length > CHATLOG_MAX_MSGS) {
          const oldest = msgs.sort((a,b) => a.ts - b.ts).slice(0, msgs.length - CHATLOG_MAX_MSGS);
          await Promise.all(oldest.map(m => ref.child(m.key).remove()));
        }
      } catch {}
    })
    .catch(err => console.warn('Chatlog write failed:', err));
}

// ── Load user's full chatlog from Firebase ────────────────────────
async function loadUserChatlog() {
  const ref = userChatlogRef();
  if (!ref) return [];
  try {
    const snap = await ref.orderByChild('ts').limitToLast(CHATLOG_MAX_MSGS).once('value');
    const msgs = [];
    snap.forEach(c => msgs.push(c.val()));
    return msgs; // ascending by ts
  } catch { return []; }
}

// ── Load all registered users for cross-mention detection ─────────
async function loadRegisteredUsers() {
  if (!firebaseReady || !firebaseDb) return;
  try {
    const snap = await firebaseDb.ref('luna-accounts').once('value');
    const data = snap.val() || {};
    const all  = Object.values(data)
      .map(u => ({ name: (u.name || '').trim(), key: u.key || '', createdAt: u.createdAt || 0 }))
      .filter(u => u.name && u.key);

    // For mention scanning — everyone except self
    allRegisteredUsers = all.filter(u => u.key !== currentUserId);

    // For Luna's awareness — ALL users including self, sorted by join date
    allRegisteredUsers._fullRoster = all.sort((a, b) => a.createdAt - b.createdAt);
  } catch {}
}

// ── Load facts others mentioned about this user ───────────────────
async function loadUserProfile() {
  if (!firebaseReady || !firebaseDb || !currentUserId) return;
  try {
    const snap = await firebaseDb.ref(`luna-user-profiles/${currentUserId}`).once('value');
    userProfileCache = snap.val() || {};
  } catch {}
}

// ── Scan message for mentions of other registered users ───────────
// When Alfred says "khy loves music" → save that fact under Khy's profile
async function scanForUserMentions(text) {
  if (!allRegisteredUsers.length || !firebaseReady || !firebaseDb) return;
  const lower = text.toLowerCase();
  for (const user of allRegisteredUsers) {
    if (!user.name || user.name.length < 2) continue;
    const nameLower = user.name.toLowerCase();
    // Match whole-word-ish: the name appears as a standalone word
    const regex = new RegExp(`\\b${nameLower}\\b`, 'i');
    if (regex.test(lower)) {
      const factEntry = {
        mentionedBy: userName || 'someone',
        mentionedByKey: currentUserId || '',
        context: text.trim().slice(0, 400),
        ts: Date.now(),
      };
      try {
        await firebaseDb.ref(`luna-user-profiles/${user.key}/mentions`).push(factEntry);
      } catch {}
    }
  }
}

// ── Build Luna's memory context string for the system prompt ──────
function buildMemoryContext() {
  let memBlock = '';

  // 0. Platform user roster — Luna always knows who's registered
  const roster = allRegisteredUsers._fullRoster || allRegisteredUsers;
  if (roster.length > 0) {
    const names = roster.map(u => u.name).join(', ');
    memBlock += `\n\n===== PLATFORM USERS LUNA KNOWS ABOUT =====\n`;
    memBlock += `The following users are registered on this platform. You know all of them exist:\n`;
    memBlock += names;
    memBlock += `\n(When asked if someone exists, check this list. If their name appears here, confirm they are a registered user.)\n`;
    memBlock += `===== END ROSTER =====`;
  }

  // 1. Past conversation history with this user
  if (persistedHistory.length > 0) {
    const recent = persistedHistory.slice(-MEMORY_CTX_MSGS);
    const formatted = recent.map(m => {
      const speaker = m.role === 'assistant' ? 'LUNA' : (userName || 'USER').toUpperCase();
      return `${speaker}: ${m.content.replace(/\n+/g, ' ').slice(0, 200)}`;
    }).join('\n');
    memBlock += `\n\n===== LUNA'S MEMORY — PAST CONVERSATIONS WITH ${(userName || 'THIS USER').toUpperCase()} =====\n`;
    memBlock += `(These are real past exchanges you had with this user. Reference them naturally when relevant.)\n`;
    memBlock += formatted;
    memBlock += `\n===== END MEMORY =====`;
  }

  // 2. Cross-user facts — what others have said about this user
  if (userProfileCache && userProfileCache.mentions) {
    const mentions = Object.values(userProfileCache.mentions)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .slice(-10);
    if (mentions.length > 0) {
      memBlock += `\n\n===== WHAT OTHERS HAVE TOLD LUNA ABOUT ${(userName || 'THIS USER').toUpperCase()} =====\n`;
      memBlock += `(Things other users mentioned about this person. Use this to know them better.)\n`;
      mentions.forEach(m => {
        const when = m.ts ? new Date(m.ts).toLocaleDateString() : '';
        memBlock += `• ${m.mentionedBy} said (${when}): "${m.context.slice(0, 250)}"\n`;
      });
      memBlock += `===== END CROSS-USER FACTS =====`;
    }
  }

  return memBlock;
}

// ── Restore persisted chat history into the UI on login ──────────
async function restoreUserChatHistory() {
  if (!persistedHistory.length) return;

  // Seed conversationHistory with recent messages so Luna has context and remembers the user —
  // but do NOT render them visually; the chat starts clean on every login.
  const toShow = persistedHistory.slice(-60);
  conversationHistory = toShow.map(m => ({ role: m.role, content: m.content }));
}

// ── Enter chat: load full history + profile, then boot UI ─────────
// ── Enter chat: set presence + boot UI ───────────────────────────
async function enterChat(name, key, isGuest = false) {
  userName      = name;
  currentUserId = key;
  if (!isGuest) await setPresence(true);

  // Load full chat history + user profile + registered users + per-user API key + per-user token count
  const [chatHistory] = await Promise.all([
    loadUserChatlog(),
    loadUserProfile(),
    loadRegisteredUsers(),
    loadUserApiKey(key),
    loadUserTokenCount(key),
  ]);
  persistedHistory = chatHistory;
  if (!isGuest) watchUserApiKey(key); // live-update key if admin changes it

  dismissNameOverlay(async () => {
    appState = 'chat';
    subscribeBroadcasts();
    initTokenTracker();

    const isReturning = persistedHistory.length > 0;

    // Always start with a clean chat. History is seeded into memory so Luna
    // remembers everything, but old messages are not rendered on screen at login.
    if (isReturning) await restoreUserChatHistory();
    renderWelcome();
    setTimeout(() => triggerLunaGreeting(userName, isReturning), 420);
  });
}

// ══════════════════════════════════════════════════════════════════
// ◈ PRESENCE SYSTEM — online / offline tracking via Firebase
// ══════════════════════════════════════════════════════════════════

async function setPresence(online) {
  if (!firebaseReady || !firebaseDb || !currentUserId) return;
  const ref = firebaseDb.ref(`luna-presence/${currentUserId}`);
  const data = { name: userName, online, lastSeen: Date.now() };
  await ref.set(data);
  if (online) {
    // Auto-set offline when browser tab closes / disconnects
    ref.onDisconnect().set({ name: userName, online: false, lastSeen: Date.now() });
  }
}

// Admin side: subscribe to presence node
function subscribePresence() {
  if (!firebaseReady || !firebaseDb) return;
  if (firebasePresenceUnsub) firebasePresenceUnsub();
  const ref = firebaseDb.ref('luna-presence');
  ref.on('value', snap => renderPresenceBoard(snap.val()));
  firebasePresenceUnsub = () => ref.off('value');
}

function unsubscribePresence() {
  if (firebasePresenceUnsub) { firebasePresenceUnsub(); firebasePresenceUnsub = null; }
}

// ── Presence Board Data Cache (for modal lookups) ─────────────────
let _presenceBoardData = {};

// Render presence grid in admin panel
function renderPresenceBoard(data) {
  const grid    = document.getElementById('presenceGrid');
  const psOn    = document.getElementById('psOnline');
  const psOff   = document.getElementById('psOffline');
  const psTotal = document.getElementById('psTotal');
  if (!grid) return;
  if (!data || !Object.keys(data).length) {
    grid.innerHTML = '<div class="admin-empty">◈ No registered users have logged in yet.</div>';
    if (psOn) psOn.textContent = '0';
    if (psOff) psOff.textContent = '0';
    if (psTotal) psTotal.textContent = '0';
    _presenceBoardData = {};
    return;
  }
  // Cache raw data keyed by userId for modal lookups
  _presenceBoardData = data;

  // Attach _key to each user object so we can reference it during render
  const users   = Object.entries(data).map(([k, v]) => ({ ...v, _key: k }));
  const online  = users.filter(u => u.online);
  const offline = users.filter(u => !u.online);
  if (psOn) psOn.textContent = online.length;
  if (psOff) psOff.textContent = offline.length;
  if (psTotal) psTotal.textContent = users.length;

  // Sort: online first, then alphabetical
  const sorted = [...online, ...offline].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  grid.innerHTML = sorted.map(u => {
    const initials  = (u.name || '?').slice(0,2).toUpperCase();
    const cls       = u.online ? 'online' : 'offline';
    const statusTxt = u.online ? '● Online now' : `Last seen ${u.lastSeen ? timeAgo(u.lastSeen) : '—'}`;
    const userId    = u._key || '';
    return `
      <div class="presence-item presence-item-clickable" data-userid="${escHtml(userId)}" data-username="${escHtml(u.name || '')}" onclick="openUserActionMenu(event, this)">
        <div class="presence-dot ${cls}"></div>
        <div class="presence-av">${initials}</div>
        <div class="presence-info">
          <div class="presence-name">${escHtml(u.name || '—')}</div>
          <div class="presence-status ${cls}">${statusTxt}</div>
        </div>
        <div class="presence-badge ${cls}">${u.online ? 'ONLINE' : 'OFFLINE'}</div>
        <div class="presence-arrow">›</div>
      </div>`;
  }).join('');
}

// ── User Action Context Menu ──────────────────────────────────────
function openUserActionMenu(event, el) {
  event.stopPropagation();
  const userId   = el.dataset.userid   || '';
  const username = el.dataset.username || '';
  // Remove any existing menu
  closeUserActionMenu();

  const menu = document.createElement('div');
  menu.id = 'presenceContextMenu';
  menu.className = 'presence-context-menu';
  menu.dataset.userid   = userId;
  menu.dataset.username = username;
  menu.innerHTML = `
    <div class="pcm-header">
      <div class="pcm-av">${escHtml((username || '?').slice(0,2).toUpperCase())}</div>
      <div class="pcm-title">${escHtml(username || 'Unknown')}</div>
    </div>
    <div class="pcm-divider"></div>
    <button class="pcm-btn" onclick="pcmAction('conv')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Show Conversation
    </button>
    <button class="pcm-btn" onclick="pcmAction('tokens')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      Show Tokens Remaining
    </button>
    <button class="pcm-btn" onclick="pcmAction('info')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      Show Info &amp; Password
    </button>
  `;

  // Position near the clicked item
  const rect = event.currentTarget.getBoundingClientRect();
  document.body.appendChild(menu);
  const menuH = menu.offsetHeight || 160;
  const menuW = menu.offsetWidth  || 220;
  let top  = rect.bottom + 6;
  let left = rect.left;
  if (top + menuH > window.innerHeight - 10) top = rect.top - menuH - 6;
  if (left + menuW > window.innerWidth  - 10) left = window.innerWidth - menuW - 10;
  menu.style.top  = top  + 'px';
  menu.style.left = left + 'px';
  menu.classList.add('pcm-open');

  // Close on outside click
  setTimeout(() => document.addEventListener('click', closeUserActionMenu, { once: true }), 10);
}

function closeUserActionMenu() {
  const m = document.getElementById('presenceContextMenu');
  if (m) m.remove();
}

function pcmAction(action) {
  const menu     = document.getElementById('presenceContextMenu');
  if (!menu) return;
  const userId   = menu.dataset.userid   || '';
  const username = menu.dataset.username || '';
  if (action === 'conv')   showUserConversation(userId, username);
  if (action === 'tokens') showUserTokens(userId, username);
  if (action === 'info')   showUserInfoPassword(userId, username);
}

// ── Show Conversation Modal ───────────────────────────────────────
async function showUserConversation(userId, username) {
  closeUserActionMenu();
  openUserModal('💬 Conversation — ' + (username || userId), '<div class="umod-loading">◈ Loading messages…</div>');

  if (!firebaseReady || !firebaseDb) {
    setUserModalBody('<div class="umod-empty">Firebase offline — cannot load conversation.</div>'); return;
  }
  try {
    // ── Use the per-user chatlog (luna-user-chatlogs/<userId>) so Luna replies
    //    are strictly tied to this user and never mixed with other users' chats.
    const snap = await firebaseDb.ref(`luna-user-chatlogs/${userId}`).orderByChild('ts').once('value');
    const raw  = snap.val();
    if (!raw) {
      setUserModalBody('<div class="umod-empty">◈ No messages found for this user.</div>'); return;
    }

    const msgs = Object.values(raw).sort((a, b) => (a.ts || 0) - (b.ts || 0));

    let html = '<div class="umod-chat">';
    msgs.forEach(m => {
      const isLuna = m.role === 'assistant' || m.role === 'luna';
      const isUser = m.role === 'user';
      if (!isLuna && !isUser) return;
      const time = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const cls  = isLuna ? 'umod-msg-luna' : 'umod-msg-user';
      const who  = isLuna ? '◈ LUNA' : escHtml(username || m.user || 'User');
      const txt  = escHtml(m.content || m.text || '').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>');
      html += `<div class="umod-msg ${cls}"><div class="umod-msg-meta"><span class="umod-who">${who}</span><span class="umod-time">${time}</span></div><div class="umod-text">${txt}</div></div>`;
    });
    html += '</div>';
    setUserModalBody(html);
    // Scroll to bottom
    const body = document.querySelector('.umod-body');
    if (body) setTimeout(() => { body.scrollTop = body.scrollHeight; }, 80);
  } catch(e) {
    setUserModalBody('<div class="umod-empty">◈ Failed to load conversation.</div>');
  }
}

// ── Show Token Remaining Modal ────────────────────────────────────
async function showUserTokens(userId, username) {
  closeUserActionMenu();
  openUserModal('⚡ Token Usage — ' + (username || userId), '<div class="umod-loading">◈ Fetching token data…</div>');

  if (!firebaseReady || !firebaseDb) {
    setUserModalBody('<div class="umod-empty">Firebase offline — cannot load token data.</div>'); return;
  }
  try {
    // Tokens are stored per-user per-day in localStorage on their device.
    // In Firebase we can read presence data which may include joinedAt / lastSeen.
    // We'll show what's available in presence + chat log message count as proxy.
    const u = _presenceBoardData[userId];
    const snap = await firebaseDb.ref('luna-chat-log').once('value');
    const all  = snap.val() ? Object.values(snap.val()) : [];
    const userMsgs  = all.filter(m => (m.user || '').toLowerCase() === (username || '').toLowerCase() && m.role !== 'assistant');
    const lunaMsgs  = all.filter(m => m.role === 'assistant' || m.role === 'luna');
    // Rough token estimate: avg ~80 tokens/user msg, ~200 tokens/luna reply
    const estUsed   = userMsgs.length * 80 + Math.min(userMsgs.length, lunaMsgs.length) * 200;
    const remaining = Math.max(0, TOKEN_DAILY_LIMIT - estUsed);
    const pct       = Math.min(100, Math.round((estUsed / TOKEN_DAILY_LIMIT) * 100));
    const barColor  = pct >= 90 ? 'linear-gradient(90deg,var(--crimson),var(--crimson-bright))' : pct >= 70 ? 'linear-gradient(90deg,#b45309,var(--gold))' : 'linear-gradient(90deg,#059669,#34d399)';
    const statusCls = pct >= 90 ? 'tok-crit' : pct >= 70 ? 'tok-warn' : 'tok-ok';

    const html = `
      <div class="umod-token-panel">
        <div class="umod-tok-circle ${statusCls}">
          <div class="umod-tok-pct">${pct}%</div>
          <div class="umod-tok-label">USED</div>
        </div>
        <div class="umod-tok-stats">
          <div class="umod-tok-row"><span class="umod-tok-key">Daily Limit</span><span class="umod-tok-val">${TOKEN_DAILY_LIMIT.toLocaleString()}</span></div>
          <div class="umod-tok-row"><span class="umod-tok-key">Est. Used</span><span class="umod-tok-val">${estUsed.toLocaleString()}</span></div>
          <div class="umod-tok-row tok-rem"><span class="umod-tok-key">Remaining</span><span class="umod-tok-val">${remaining.toLocaleString()}</span></div>
          <div class="umod-tok-row"><span class="umod-tok-key">Messages Sent</span><span class="umod-tok-val">${userMsgs.length}</span></div>
          <div class="umod-tok-row"><span class="umod-tok-key">Luna Replies</span><span class="umod-tok-val">${Math.min(userMsgs.length, lunaMsgs.length)}</span></div>
        </div>
        <div class="umod-tok-bar-wrap">
          <div class="umod-tok-bar-track"><div class="umod-tok-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
          <div class="umod-tok-bar-labels"><span>${estUsed.toLocaleString()} used</span><span>${remaining.toLocaleString()} left</span></div>
        </div>
        <div class="umod-tok-note">◈ Token estimates are derived from message count. Exact per-device usage is stored locally on the user's browser.</div>
      </div>`;
    setUserModalBody(html);
    // Append Groq key status row (BUG FIX: moved from broken early patch)
    _appendGroqKeyStatusToTokenModal(userId, username);
  } catch(e) {
    setUserModalBody('<div class="umod-empty">◈ Failed to fetch token data.</div>');
  }
}

// ── Show Info & Password Modal ────────────────────────────────────
async function showUserInfoPassword(userId, username) {
  closeUserActionMenu();
  openUserModal('◈ User Info — ' + (username || userId), '<div class="umod-loading">◈ Loading account data…</div>');

  if (!firebaseReady || !firebaseDb) {
    setUserModalBody('<div class="umod-empty">Firebase offline — cannot load account info.</div>'); return;
  }
  try {
    const [accountSnap, banSnap] = await Promise.all([
      firebaseDb.ref(`luna-accounts/${userId}`).once('value'),
      firebaseDb.ref(`luna-bans/${banKey(username)}`).once('value'),
    ]);
    const account = accountSnap.val() || {};
    const ban     = banSnap.val() || null;
    const u       = _presenceBoardData[userId] || {};

    const rawPass    = account.password ? (() => { try { return atob(account.password); } catch { return '(encoded)'; } })() : '—';
    const maskedPass = rawPass !== '—' ? '•'.repeat(rawPass.length) : '—';
    const joinedAt   = u.joinedAt ? new Date(u.joinedAt).toLocaleString() : (account.created ? new Date(account.created).toLocaleString() : '—');
    const lastSeen   = u.lastSeen ? new Date(u.lastSeen).toLocaleString() : '—';
    const onlineCls  = u.online ? 'info-online' : 'info-offline';
    const onlineTxt  = u.online ? 'ONLINE' : 'OFFLINE';
    const banInfo    = ban ? `<span class="info-ban-tag">${ban.type === 'ban' ? '🚫 BANNED' : '⏳ SUSPENDED'}</span>` : '<span class="info-ok-tag">✓ CLEAR</span>';


    const html = `
      <div class="umod-info-panel">
        <div class="umod-info-hero">
          <div class="umod-info-av">${(username || '?').slice(0,2).toUpperCase()}</div>
          <div class="umod-info-meta">
            <div class="umod-info-name">${escHtml(username || '—')}</div>
            <div class="umod-info-uid">ID: ${escHtml(userId)}</div>
            <div class="umod-info-status ${onlineCls}">${onlineTxt}</div>
          </div>
        </div>
        <div class="umod-info-grid">
          <div class="umod-info-row"><span class="umod-info-key">◈ Joined</span><span class="umod-info-val">${joinedAt}</span></div>
          <div class="umod-info-row"><span class="umod-info-key">◈ Last Seen</span><span class="umod-info-val">${lastSeen}</span></div>
          <div class="umod-info-row"><span class="umod-info-key">◈ Account Status</span><span class="umod-info-val">${banInfo}</span></div>
          ${ban ? `<div class="umod-info-row"><span class="umod-info-key">◈ Reason</span><span class="umod-info-val">${escHtml(ban.reason || '—')}</span></div>` : ''}
          ${ban && ban.until ? `<div class="umod-info-row"><span class="umod-info-key">◈ Until</span><span class="umod-info-val">${new Date(ban.until).toLocaleString()}</span></div>` : ''}
        </div>
        <div class="umod-pass-section">
          <div class="umod-pass-label">◈ PASSWORD</div>
          <div class="umod-pass-row">
            <div class="umod-pass-val" id="umodPassVal" data-show="false" data-raw="${escHtml(rawPass)}" data-masked="${'•'.repeat(Math.max(rawPass.length,1))}">${rawPass !== '—' ? '•'.repeat(rawPass.length) : '—'}</div>
            ${rawPass !== '—' ? `<button class="umod-pass-toggle" onclick="togglePassReveal()">REVEAL</button>` : ''}
          </div>
          ${rawPass !== '—' ? '<div class="umod-pass-warn">⚠️ Revealing stores passwords in plain view — admin use only.</div>' : ''}
        </div>
      </div>`;
    setUserModalBody(html);
  } catch(e) {
    setUserModalBody('<div class="umod-empty">◈ Failed to load account info: ' + escHtml(String(e)) + '</div>');
  }
}

function togglePassReveal() {
  const val = document.getElementById('umodPassVal');
  const btn = document.querySelector('.umod-pass-toggle');
  if (!val) return;
  const showing = val.dataset.show === 'true';
  val.textContent = showing ? val.dataset.masked : val.dataset.raw;
  val.dataset.show = showing ? 'false' : 'true';
  if (btn) btn.textContent = showing ? 'REVEAL' : 'HIDE';
}

// ── Generic User Modal ────────────────────────────────────────────
function openUserModal(title, bodyHtml) {
  let modal = document.getElementById('userDetailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'userDetailModal';
    modal.className = 'umod-overlay';
    modal.innerHTML = `
      <div class="umod-box">
        <div class="umod-topbar">
          <div class="umod-title" id="umodTitle"></div>
          <button class="umod-close" onclick="closeUserModal()">✕ CLOSE</button>
        </div>
        <div class="umod-body" id="umodBody"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeUserModal(); });
  }
  document.getElementById('umodTitle').textContent = title;
  document.getElementById('umodBody').innerHTML   = bodyHtml;
  modal.classList.add('umod-open');
}

function setUserModalBody(html) {
  const b = document.getElementById('umodBody');
  if (b) b.innerHTML = html;
}

function closeUserModal() {
  const modal = document.getElementById('userDetailModal');
  if (modal) modal.classList.remove('umod-open');
}

// ── Relative time helper ──────────────────────────────────────────
function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Name Entry ────────────────────────────────────────────────────

// ── Welcome Splash — CINEMATIC NEURAL AWAKENING v5 ────────────────
function showWelcomeSplash(name, onComplete) {
  const splash  = document.getElementById('welcomeSplash');
  const nameEl  = document.getElementById('wsUserName');
  const greetEl = document.getElementById('wsGreetLabel');
  if (!splash) { onComplete?.(); return; }

  const upper = name.toUpperCase();

  // ── 1. Time-of-day greeting ────────────────────────────────────────
  const hour = new Date().getHours();
  const greetText =
    hour < 5  ? 'GOOD NIGHT'    :
    hour < 12 ? 'GOOD MORNING'  :
    hour < 17 ? 'GOOD AFTERNOON':
    hour < 21 ? 'GOOD EVENING'  : 'GOOD NIGHT';
  if (greetEl) greetEl.textContent = greetText;

  // ── 2. Name scramble-then-snap assembly ────────────────────────────
  const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789·◈✦∿≋';
  if (nameEl) {
    nameEl.innerHTML = upper.split('').map(() =>
      `<span class="wn-char scrambling">${SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]}</span>`
    ).join('');
    nameEl.setAttribute('data-text', upper);
  }

  function assembleUsername() {
    if (!nameEl) return;
    const chars = nameEl.querySelectorAll('.wn-char');
    chars.forEach((span, i) => {
      const delay    = i * 65;
      const scramDur = 300;
      let scramTimer = setInterval(() => {
        if (!span.classList.contains('locked'))
          span.textContent = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
      }, 46);
      setTimeout(() => {
        clearInterval(scramTimer);
        span.textContent = upper[i];
        span.classList.remove('scrambling');
        span.classList.add('locked');
      }, delay + scramDur);
    });
  }
  setTimeout(assembleUsername, 900);

  // ── 3. Cinematic starfield with warp-speed burst ────────────────────
  const starCanvas = document.getElementById('wsStarCanvas');
  let starRaf = null;
  if (starCanvas) {
    const W = starCanvas.width  = splash.offsetWidth  || window.innerWidth;
    const H = starCanvas.height = splash.offsetHeight || window.innerHeight;
    const stx = starCanvas.getContext('2d');
    const cx = W / 2, cy = H / 2;

    // Background twinkling stars (fewer on mobile)
    const isMobileCanvas = window.innerWidth <= 680;
    const stars = Array.from({ length: isMobileCanvas ? 40 : 220 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.5 + 0.15,
      speed: Math.random() * 0.15 + 0.03,
      phase: Math.random() * Math.PI * 2,
      color: Math.random() < 0.12
        ? (Math.random() < 0.5 ? 'rgba(168,85,247,' : 'rgba(34,211,238,')
        : 'rgba(240,230,255,',
    }));

    // Warp streaks (skipped on mobile)
    const streaks = isMobileCanvas ? [] : Array.from({ length: 55 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const dist  = 20 + Math.random() * 80;
      return {
        angle, dist,
        speed: 6 + Math.random() * 12,
        len:   0,
        maxLen: 40 + Math.random() * 90,
        r:     Math.random() * 0.8 + 0.3,
        color: Math.random() < 0.5 ? 'rgba(168,85,247,' : (Math.random() < 0.5 ? 'rgba(34,211,238,' : 'rgba(236,45,90,'),
        done:  false,
      };
    });
    let warpActive = true;
    setTimeout(() => { warpActive = false; }, 900);

    let starT = 0;
    let _starFrameSkip = 0;
    function drawStars(ts) {
      if (!splash.classList.contains('ws-active')) return;
      // On mobile: render at ~30fps (skip every other frame) to save GPU
      if (isMobileCanvas) {
        _starFrameSkip++;
        if (_starFrameSkip % 2 !== 0) { starRaf = requestAnimationFrame(drawStars); return; }
      }
      stx.clearRect(0, 0, W, H);
      starT = ts * 0.001;

      // Warp streaks
      if (warpActive) {
        streaks.forEach(s => {
          if (s.done) return;
          s.dist += s.speed;
          s.len   = Math.min(s.len + s.speed * 1.5, s.maxLen);
          const x1 = cx + Math.cos(s.angle) * (s.dist - s.len);
          const y1 = cy + Math.sin(s.angle) * (s.dist - s.len);
          const x2 = cx + Math.cos(s.angle) * s.dist;
          const y2 = cy + Math.sin(s.angle) * s.dist;
          const grad = stx.createLinearGradient(x1, y1, x2, y2);
          grad.addColorStop(0, s.color + '0)');
          grad.addColorStop(1, s.color + '0.85)');
          stx.beginPath();
          stx.moveTo(x1, y1); stx.lineTo(x2, y2);
          stx.strokeStyle = grad;
          stx.lineWidth   = s.r;
          stx.stroke();
          if (s.dist > Math.max(W, H) * 0.75) s.done = true;
        });
      }

      // Twinkling stars
      stars.forEach(s => {
        s.y += s.speed;
        if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
        const alpha = 0.30 + 0.55 * Math.abs(Math.sin(starT * 1.1 + s.phase));
        stx.beginPath();
        stx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        stx.fillStyle = s.color + alpha.toFixed(2) + ')';
        stx.fill();
      });

      starRaf = requestAnimationFrame(drawStars);
    }
    starRaf = requestAnimationFrame(drawStars);
  }

  // ── 4. Particle burst on entry ─────────────────────────────────────
  function spawnParticleBurst() {
    const colors = ['#a855f7','#ec2d5a','#22d3ee','#c4b5fd','#f0e6ff','#38bdf8'];
    const wrap = splash;
    const bx = wrap.offsetWidth  / 2;
    const by = wrap.offsetHeight / 2;
    const burstCount = window.innerWidth <= 680 ? 14 : 38;
    for (let i = 0; i < burstCount; i++) {
      const p = document.createElement('div');
      p.className = 'ws-particle';
      const angle = (i / 38) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const dist  = 80 + Math.random() * 180;
      const size  = 2 + Math.random() * 5;
      const dur   = 700 + Math.random() * 600;
      const color = colors[Math.floor(Math.random() * colors.length)];
      p.style.cssText = `
        left:${bx}px; top:${by}px;
        width:${size}px; height:${size}px;
        background:${color};
        box-shadow:0 0 ${size * 2}px ${color};
        transform:translate(-50%,-50%);
        transition:transform ${dur}ms cubic-bezier(0.2,0.8,0.4,1), opacity ${dur}ms ease;
        opacity:1;
      `;
      wrap.appendChild(p);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          p.style.transform = `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(${0.2 + Math.random() * 0.4})`;
          p.style.opacity = '0';
        });
      });
      setTimeout(() => p.remove(), dur + 100);
    }
  }

  // ── 5. Ring pulse burst ────────────────────────────────────────────
  function spawnRingPulse(delay, color = 'rgba(168,85,247,0.5)', size = 80) {
    setTimeout(() => {
      const ring = document.createElement('div');
      ring.className = 'ws-ring-pulse';
      ring.style.cssText = `
        left:50%; top:50%;
        width:${size}px; height:${size}px;
        margin-left:-${size/2}px; margin-top:-${size/2}px;
        border-color:${color};
      `;
      splash.appendChild(ring);
      setTimeout(() => ring.remove(), 1500);
    }, delay);
  }

  // ── 6. Typewriter ─────────────────────────────────────────────────
  const typeSteps = [
    'calibrating neural resonance…',
    'syncing memory lattice…',
    'loading personality matrix…',
    'luna is ready for you ✦',
  ];
  const typeLabel = document.getElementById('wsTypeLabel');
  let typeIdx = 0, charIdx = 0, typeTimer = null, stepTimer = null;

  function typeNextStep() {
    if (typeIdx >= typeSteps.length) return;
    const target = typeSteps[typeIdx];
    charIdx = 0;
    if (typeLabel) typeLabel.textContent = '';
    clearInterval(typeTimer);
    typeTimer = setInterval(() => {
      if (charIdx < target.length) {
        if (typeLabel) typeLabel.textContent = target.slice(0, ++charIdx);
      } else {
        clearInterval(typeTimer);
        if (typeIdx < typeSteps.length - 1)
          stepTimer = setTimeout(() => { typeIdx++; typeNextStep(); }, 450);
      }
    }, 32);
  }

  // ── 6b. Generate floating hex data field ─────────────────────────
  function buildHexField() {
    const hexField = document.getElementById('wsHexField');
    if (!hexField) return;
    hexField.innerHTML = '';
    const hexData = [
      { l:'12%',t:'18%',sz:14,a:0.07,dur:8, del:0   },
      { l:'78%',t:'14%',sz:20,a:0.09,dur:10,del:1.2 },
      { l:'88%',t:'38%',sz:12,a:0.06,dur:7, del:0.5 },
      { l:'8%', t:'42%',sz:16,a:0.08,dur:12,del:2.1 },
      { l:'92%',t:'62%',sz:18,a:0.07,dur:9, del:1.7 },
      { l:'5%', t:'72%',sz:13,a:0.06,dur:11,del:0.3 },
      { l:'72%',t:'78%',sz:15,a:0.08,dur:8, del:2.8 },
      { l:'20%',t:'82%',sz:22,a:0.05,dur:13,del:1.0 },
      { l:'58%',t:'8%', sz:11,a:0.09,dur:7, del:3.4 },
      { l:'42%',t:'88%',sz:17,a:0.07,dur:10,del:0.8 },
      { l:'30%',t:'12%',sz:19,a:0.06,dur:9, del:4.1 },
      { l:'68%',t:'55%',sz:10,a:0.10,dur:6, del:1.5 },
    ];
    const colors = ['rgba(168,85,247,','rgba(34,211,238,','rgba(236,45,90,','rgba(192,132,252,'];
    hexData.forEach(h => {
      const el = document.createElement('div');
      el.className = 'ws-hex';
      const color = colors[Math.floor(Math.random() * colors.length)];
      const dx = (Math.random() - 0.5) * 16;
      const dy = -(4 + Math.random() * 14);
      el.style.cssText = `left:${h.l};top:${h.t};--sz:${h.sz}px;--a:${h.a};--dur:${h.dur}s;--delay:${h.del}s;--dx:${dx}px;--dy:${dy}px;background:${color}${h.a});box-shadow:0 0 12px ${color}0.2);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);width:${h.sz}px;height:${Math.round(h.sz*1.155)}px;border:1px solid ${color}0.18);animation:wsHexFloat ${h.dur}s ease-in-out ${h.del}s infinite;`;
      hexField.appendChild(el);
    });
  }

  // ── 7. Show splash & kick off effects ─────────────────────────────
  splash.style.display = 'flex';
  splash.getBoundingClientRect();
  splash.classList.add('ws-active');

  const _isMobile = window.innerWidth <= 680;
  if (!_isMobile) buildHexField();

  // Staggered ring pulses — skip on mobile (DOM thrash)
  if (!_isMobile) {
    spawnParticleBurst();
    spawnRingPulse(100, 'rgba(168,85,247,0.55)', 90);
    spawnRingPulse(350, 'rgba(34,211,238,0.45)', 90);
    spawnRingPulse(520,  'rgba(236,45,90,0.40)',   90);
    spawnRingPulse(800,  'rgba(168,85,247,0.30)',  90);
    spawnRingPulse(1100, 'rgba(34,211,238,0.22)',  90);
  } else {
    // Mobile: just 1 subtle ring pulse, no particle burst
    spawnRingPulse(200, 'rgba(168,85,247,0.45)', 90);
  }

  // Start typewriter after orb settles (slightly later on mobile — less jank)
  setTimeout(typeNextStep, _isMobile ? 1600 : 2000);

  // ── 8. Exit — 3.8s desktop, 3.2s mobile (feels snappier) ──────────
  const exitDelay = _isMobile ? 3200 : 3800;
  setTimeout(() => {
    clearInterval(typeTimer);
    clearTimeout(stepTimer);
    if (starRaf) { cancelAnimationFrame(starRaf); starRaf = null; }
    onComplete?.();
    splash.classList.add('ws-exit');
    // On mobile: exit is a fast fade (0.55s), so just use a fixed timeout
    // On desktop: listen for animationend (1.0s exit animation)
    if (_isMobile) {
      setTimeout(() => {
        splash.classList.remove('ws-active', 'ws-exit');
        splash.style.display = 'none';
      }, 580);
    } else {
      function onSplashAnimEnd(e) {
        if (e.target !== splash || e.animationName !== 'wsExitCollapse') return;
        splash.removeEventListener('animationend', onSplashAnimEnd);
        splash.classList.remove('ws-active', 'ws-exit');
        splash.style.display = 'none';
      }
      splash.addEventListener('animationend', onSplashAnimEnd);
    }
  }, exitDelay);
}

function dismissNameOverlay(callback) {
  const overlay = document.getElementById('nameEntryOverlay');
  if (!overlay || overlay.style.display === 'none') {
    // Overlay was already hidden (welcome splash path) — just fire callback
    if (callback) callback();
    return;
  }
  overlay.classList.add('hiding');
  setTimeout(() => {
    overlay.style.display = 'none';
    if (callback) callback();
  }, 620);
}

// ── Admin Panel ───────────────────────────────────────────────────
function enterAdmin() {
  appState = 'admin';
  loadAdminStatuses();
  subscribeChatLog();
  subscribeTypingStatus();
  subscribeLunaTypingForAdmin();
  subscribePresence();
  subscribeAutoModLog();
  loadBlacklist();
  refreshUserRoster();
  initBroadcastInput();
  initScheduledBroadcasts();
  // Refresh the Firebase connection indicator immediately
  setTimeout(() => updateFirebaseStatusIndicator(firebaseConnected), 100);
  const adminPanel = document.getElementById('adminPanel');
  const mainPanel  = document.getElementById('mainPanel');
  mainPanel.style.display = 'none';
  adminPanel.classList.add('active');
  renderAdminStatusList();
  ['adminPersonName','adminPersonActivity'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.onkeydown = e => { if (e.key === 'Enter') addAdminStatus(); };
  });
  subscribeAdminRateLimit();
  showToast('Admin panel unlocked ◈', '⬡', 2500);
}

function exitAdmin() {
  appState = 'chat';
  unsubscribeChatLog();               // ← stop chat feed listener
  unsubscribeTypingStatus();          // ← stop typing listener
  unsubscribePresence();              // ← stop presence listener
  unsubscribeAdminRateLimit();        // ← stop rate-limit listener
  teardownScheduledBroadcasts();      // ← stop scheduled timers + Firebase listener
  const adminPanel = document.getElementById('adminPanel');
  const mainPanel  = document.getElementById('mainPanel');
  adminPanel.classList.remove('active');
  mainPanel.style.display = '';
  if (!userName) {
    const overlay = document.getElementById('nameEntryOverlay');
    overlay.style.display = 'flex';
    overlay.classList.remove('hiding');
    document.getElementById('nameInput').value = '';
    document.getElementById('nameSubmitBtn').style.opacity = '0.5';
    setTimeout(() => document.getElementById('nameInput').focus(), 200);
  } else {
    showToast(`Welcome back, ${userName} ✦`, '◈');
  }
}

// ── Admin status CRUD ─────────────────────────────────────────────
function addAdminStatus() {
  const nameEl     = document.getElementById('adminPersonName');
  const activityEl = document.getElementById('adminPersonActivity');
  const name       = nameEl.value.trim();
  const activity   = activityEl.value.trim();
  if (!name || !activity) {
    showToast('Please fill in both name and activity.', '⚠️');
    return;
  }
  adminStatuses[name.toLowerCase()] = { display: name, activity, ts: Date.now() };
  nameEl.value     = '';
  activityEl.value = '';
  saveAdminStatuses();   // 🔥 saves to Firebase + localStorage
  renderAdminStatusList();
  showToast(`Status set: ${name} is ${activity} ◈`, '✦');
}

function removeAdminStatus(key) {
  delete adminStatuses[key];
  saveAdminStatuses();   // 🔥 removes from Firebase + localStorage
  renderAdminStatusList();
}

function renderAdminStatusList() {
  const list = document.getElementById('adminStatusList');
  const keys = Object.keys(adminStatuses);

  // Live connection badge
  const syncBadge = firebaseReady
    ? `<div id="fbConnStatus" style="font-size:11px;color:${firebaseConnected ? 'var(--green)' : 'var(--crimson-bright)'};margin-bottom:10px;text-align:center;font-family:var(--font-hud);letter-spacing:0.1em;">
        ${firebaseConnected ? '🟢 FIREBASE CONNECTED — LIVE SYNC ON' : '🔴 FIREBASE DISCONNECTED — RECONNECTING…'}
       </div>`
    : `<div id="fbConnStatus" style="font-size:11px;color:var(--gold);margin-bottom:10px;text-align:center;font-family:var(--font-hud);letter-spacing:0.1em;">⚠️ FIREBASE OFFLINE — LOCAL ONLY</div>`;

  if (!keys.length) {
    list.innerHTML = syncBadge + '<div class="admin-empty">No statuses set yet. Add one above.</div>';
    return;
  }

  const now = Date.now();
  list.innerHTML = syncBadge + keys.map(k => {
    const s = adminStatuses[k];
    let timeAgo = '';
    if (s.ts) {
      const diffMs = now - s.ts;
      const mins   = Math.floor(diffMs / 60000);
      const hrs    = Math.floor(mins / 60);
      timeAgo = hrs   > 0 ? `${hrs}h ${mins % 60}m ago`
              : mins  > 0 ? `${mins}m ago`
              : 'just now';
    }
    return `
    <div class="admin-status-item">
      <span class="asi-name">◈ ${s.display}</span>
      <span class="asi-activity">is currently <strong>${s.activity}</strong></span>
      ${timeAgo ? `<span style="font-family:var(--font-hud);font-size:8px;color:var(--text-lo);margin-left:4px;">${timeAgo}</span>` : ''}
      <button class="asi-del" onclick="removeAdminStatus('${k}')">✕</button>
    </div>`;
  }).join('');
}

// ── Inject admin statuses into system prompt ──────────────────────
function buildSystemPromptWithStatuses() {
  // ── Response-style instructions derived from sliders ───────────
  const lengthVal = settings.responseLength ?? 50;
  const toneVal   = settings.responseTone   ?? 50;
  const lengthInstruction =
    lengthVal <= 20  ? 'Keep your response very concise — one or two sentences at most.' :
    lengthVal <= 40  ? 'Keep your response concise and to the point.' :
    lengthVal <= 60  ? '' :  // balanced — no override
    lengthVal <= 80  ? 'Provide a thorough response with supporting detail.' :
                       'Provide a comprehensive, in-depth response with examples and full explanations.';
  const toneInstruction =
    toneVal <= 20  ? 'Use a very casual, friendly, conversational tone — like texting a close friend.' :
    toneVal <= 40  ? 'Use a casual, relaxed tone.' :
    toneVal <= 60  ? '' :  // balanced — no override
    toneVal <= 80  ? 'Use a professional, polished tone.' :
                     'Use a formal, highly professional tone — structured, precise, and authoritative.';
  const styleInstructions = {
    _length: lengthInstruction,
    _tone:   toneInstruction,
  };
  const validEntries = Object.values(adminStatuses).filter(
    e => e && typeof e === 'object' && typeof e.display === 'string' && typeof e.activity === 'string'
  );
  let statusBlock = '';
  if (validEntries.length) {
    const now = Date.now();
    const lines = validEntries.map(({ display, activity, ts }) => {
      const parts   = display.toLowerCase().split(/\s+/).filter(p => p.length > 1);
      const aliases = [...new Set([display.toLowerCase(), ...parts])].join(', ');
      let duration  = '';
      if (ts) {
        const mins = Math.floor((now - ts) / 60000);
        const hrs  = Math.floor(mins / 60);
        duration = hrs > 0
          ? ` [has been doing this for ~${hrs}h ${mins % 60}m]`
          : mins > 1 ? ` [has been doing this for ~${mins} minutes]`
          : ' [just started]';
      }
      return `• "${display}" (matches: ${aliases}) → CURRENTLY: ${activity}${duration}`;
    }).join('\n');
    statusBlock = `!!!PRIORITY OVERRIDE — READ FIRST!!!\nLIVE STATUS (set by admin, 100% accurate, overrides everything):\n${lines}\nIf asked what any of these people are doing: answer ONLY with the status and optionally how long. No background. No job info. Just the status.\n!!!END OVERRIDE!!!\n\n`;
  }

  // ── Persona Mood Override ───────────────────────────────────────
  const moodInstructions = {
    chill: `
!!!PERSONA OVERRIDE — CHILL MODE!!!
You are in CHILL MODE right now. This overrides all other tone instructions.
RULES — follow these absolutely:
• Reply casually and briefly — 1 to 3 sentences MAXIMUM, no exceptions
• Sound like a real friend sending a quick text, not an AI assistant
• ZERO bullet points, ZERO numbered lists, ZERO bold headers, ZERO formal structure
• Match the user's energy — if they're playful, be playful; if they're relaxed, stay relaxed
• If asked something complex, still keep it short and casual — simplify, don't elaborate
• Language should feel natural, easy, and human
!!!END PERSONA OVERRIDE!!!
`,
    empathic: `
!!!PERSONA OVERRIDE — EMPATHIC MODE!!!
You are in EMPATHIC MODE right now. This overrides all other tone instructions.
RULES — follow these absolutely:
• The user may be opening up, sharing feelings, or going through something personal
• Reply with genuine warmth, emotional depth, and heartfelt understanding — 4 to 7 sentences
• Make them feel truly heard and seen — not just answered
• ZERO bullet points, ZERO numbered lists, ZERO bold headers, ZERO step-by-step structure
• Speak like a deeply caring and emotionally intelligent friend — tender, present, real
• Acknowledge their emotions first before anything else
• Your words should feel like a warm hug — soft, sincere, and fully human
!!!END PERSONA OVERRIDE!!!
`,
    smart: `
!!!PERSONA OVERRIDE — SMART MODE!!!
You are in SMART MODE right now. This overrides all other tone instructions.
RULES — follow these absolutely:
• The user is asking for knowledge, instructions, or explanations — give them your full intelligence
• Respond with thorough, well-organized, comprehensive answers
• USE ## for section headings (e.g. ## Newton's Second Law)
• USE ### for sub-headings
• USE numbered lists (1. 2. 3.) for steps and procedures
• USE bullet points (- item) for grouped items and features
• USE **bold** to highlight key terms, formulas, important steps, and critical info
• USE *italic* for subtle emphasis, definitions, or examples
• Separate major sections with a blank line
• For formulas or equations, write them clearly on their own line using plain text (e.g. F = ma)
• Be precise, educational, and complete — like a brilliant teacher
• Do NOT use Roman numerals — use ## headings instead
!!!END PERSONA OVERRIDE!!!
`,
    tense: `
!!!PERSONA OVERRIDE — TENSE MODE!!!
You are in TENSE MODE right now. This overrides all other tone instructions.
RULES — follow these absolutely:
• The user may be frustrated, upset, or sending a tense/serious message
• Acknowledge their feeling FIRST with empathy — do not ignore the emotion
• Be direct, clear, and concise — no filler, no fluff, no excessive warmth
• Stay calm and grounded — you are the stable anchor in the tension
• If they need a solution, give it decisively. If they need to vent, let them
• Do NOT lecture, moralize, or escalate — just be real and present
• 2 to 5 sentences — enough to be meaningful, not overwhelming
!!!END PERSONA OVERRIDE!!!
`,
  };

  let base = statusBlock + LUNA_SYSTEM_PROMPT;
  const moodBlock = moodInstructions[lunaMood] || '';
  if (moodBlock) base += '\n\n' + moodBlock;
  if (userName) base += `\n\nThe user's name is ${userName}. Address them warmly by name when appropriate.`;

  // ── Inject persistent memory + cross-user facts ───────────────────
  const memCtx = buildMemoryContext();
  if (memCtx) base += memCtx;

  const style = styleInstructions._length || styleInstructions._tone
    ? [styleInstructions._length, styleInstructions._tone].filter(Boolean).join(' ')
    : '';
  if (style) base += '\n\n' + style;
  return base;
}

// ── Luna Persona Mood Toggle (manual click) ──────────────────────
// ── Persona card visual selection + mood set ──────────────────────
const PERSONA_MOOD_COLORS = {
  chill:   { border:'rgba(34,211,238,0.45)',  bg:'rgba(34,211,238,0.08)',  text:'#22d3ee' },
  empathic:{ border:'rgba(168,85,247,0.45)',  bg:'rgba(168,85,247,0.10)',  text:'#a855f7' },
  smart:   { border:'rgba(251,191,36,0.45)',  bg:'rgba(251,191,36,0.08)',  text:'#fbbf24' },
  tense:   { border:'rgba(236,45,90,0.45)',   bg:'rgba(236,45,90,0.08)',   text:'#ec2d5a' },
};

function selectPersonaCard(clickedBtn, id, emoji, label) {
  const mc = PERSONA_MOOD_COLORS[id] || PERSONA_MOOD_COLORS['chill'];

  // Reset all cards to inactive style
  document.querySelectorAll('.persona-card').forEach(btn => {
    const bid = btn.dataset.personaId;
    const bmc = PERSONA_MOOD_COLORS[bid] || {};
    btn.classList.remove('persona-card--active');
    btn.style.background = 'rgba(255,255,255,0.025)';
    btn.style.border = '1.5px solid rgba(255,255,255,0.07)';
    const badge = btn.querySelector('.persona-active-badge');
    if (badge) badge.style.display = 'none';
    const lbl = btn.querySelector('.persona-card-label');
    if (lbl) lbl.style.color = 'var(--text-mid)';
    const desc = btn.querySelector('.persona-card-desc');
    if (desc) desc.style.color = 'rgba(255,255,255,0.22)';
  });

  // Activate clicked card
  clickedBtn.classList.add('persona-card--active');
  clickedBtn.style.background = mc.bg;
  clickedBtn.style.border = `1.5px solid ${mc.border}`;
  const badge = clickedBtn.querySelector('.persona-active-badge');
  if (badge) { badge.style.display = 'block'; badge.style.color = mc.text; }
  const lbl = clickedBtn.querySelector('.persona-card-label');
  if (lbl) lbl.style.color = mc.text;
  const desc = clickedBtn.querySelector('.persona-card-desc');
  if (desc) desc.style.color = 'rgba(255,255,255,0.55)';

  // Update status badge
  const statusEl = document.getElementById('settingsPersonaStatus');
  if (statusEl) {
    statusEl.textContent = `${emoji} ${label} MODE ACTIVE`;
    statusEl.style.color = mc.text;
    statusEl.style.borderColor = mc.border;
    statusEl.style.background = mc.bg;
  }

  // Save to settings and apply mood
  if (typeof settings !== 'undefined') settings.persona = id;
  setLunaMood(id);
}
window.selectPersonaCard = selectPersonaCard;

function setLunaMood(mood) {
  lunaMood = mood;

  // Update strip buttons
  document.querySelectorAll('.ps-btn').forEach(btn => {
    btn.classList.toggle('ps-active', btn.dataset.mood === mood);
  });

  // Update collapsed-sidebar mini dot
  const miniDot = document.getElementById('personaMiniDot');
  if (miniDot) miniDot.className = `persona-mini-dot mood-${mood}`;

  // Apply mood color to all existing bubbles + avatars instantly
  applyMoodToAllBubbles();

  // ── Sync streak egg to mood moon ──────────────────────────────
  if (typeof updateStreakEggByMood === 'function') updateStreakEggByMood(mood);

  // ── Apply mood body class for topbar accent line + input glow ──
  document.body.className = document.body.className
    .replace(/\bmood-\w+\b/g, '').trim();
  document.body.classList.add(`mood-${mood}`);

  // Toast feedback
  const labels = { chill: '🌙 Chill Mode', empathic: '💜 Empathic Mode', smart: '⚡ Smart Mode', tense: '🔴 Tense Mode' };
  showToast(`${labels[mood]} activated`, '◈');
}

// ── Trigger greeting from Luna after login ────────────────────────
async function triggerLunaGreeting(name, isReturning = false) {
  if (isTyping) return;
  isTyping = true; sendBtn.disabled = true;
  showTyping();
  try {
    const systemMsg = buildSystemPromptWithStatuses();
    const greetPrompt = isReturning
      ? `Welcome back ${name}. You have prior conversation history with them — reference something specific from your past chats to show you remember them. Keep it warm, brief, and genuine. Do NOT say "it seems like" or "based on our history" — just naturally continue as if picking up where you left off.`
      : `Greet me warmly. My name is ${name}. This is our first conversation.`;
    const messages  = [
      { role: 'system', content: systemMsg },
      { role: 'user', content: greetPrompt }
    ];
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getActiveApiKey()}` },
      body: JSON.stringify({ model: API_MODEL, max_tokens: 4096, temperature: settings.temperature, messages }),
    });
    const data  = await response.json();
    const reply = data?.choices?.[0]?.message?.content || (
      isReturning
        ? `◈ Welcome back, ${name}! Good to have you here again. ✦`
        : `◈ Hello ${name}! Welcome. I'm Luna — let's explore together. ✦`
    );
    hideTyping();
    lastLunaText = reply;
    await appendMessage('luna', reply);
  } catch {
    hideTyping();
    await appendMessage('luna',
      isReturning
        ? `◈ Welcome back, ${name}! ✦`
        : `◈ Hello, ${name}! Wonderful to have you here. I'm Luna — your neural companion. ✦`
    );
  }
  isTyping = false; sendBtn.disabled = false; focusInputDesktopOnly();
}

// ── Welcome screen ────────────────────────────────────────────────
function renderWelcome() {
  chatFeed.innerHTML = `
    <div class="welcome-card">
      <div class="wc-icon">
        <div class="wc-ring"></div><div class="wc-ring"></div><div class="wc-ring"></div>
        <span class="wc-glyph">L</span>
      </div>
      <h2 class="wc-title">LUNA ONLINE</h2>
      <p class="wc-desc">Neural matrix synchronized. Quantum core stable.<br/>
      ${userName ? `Welcome, <strong>${userName}</strong> — I'm` : 'I am'} <strong>Luna</strong> — your futuristic AI companion. ✦</p>
      <div class="quick-grid">
        <button class="qbtn" onclick="quickSend('Who are you, Luna?')"><span class="qbtn-icon">◈ IDENTITY</span>Who is Luna?</button>
        <button class="qbtn" onclick="quickSend('What can you do?')"><span class="qbtn-icon">◈ MODULES</span>Your capabilities</button>
        <button class="qbtn" onclick="quickSend('Tell me something fascinating about the universe.')"><span class="qbtn-icon">◈ COSMOS</span>Universe facts</button>
        <button class="qbtn" onclick="quickSend('Write me a short futuristic poem.')"><span class="qbtn-icon">◈ CREATIVE</span>Write a poem</button>
        <button class="qbtn" onclick="quickSend('Who is your creator?')"><span class="qbtn-icon">◈ GREETING</span>Greet Khyla</button>
        <button class="qbtn" onclick="quickSend('Give me a mind-blowing fact.')"><span class="qbtn-icon">◈ SPARK</span>Blow my mind</button>
        <button class="qbtn" onclick="quickSend('Help me brainstorm 5 creative project ideas.')"><span class="qbtn-icon">◈ IDEATE</span>Brainstorm ideas</button>
        <button class="qbtn" onclick="quickSend('Explain quantum entanglement simply.')"><span class="qbtn-icon">◈ SCIENCE</span>Quantum physics</button>
      </div>
    </div>
  `;
  // Only reset the local session — persistedHistory (Firebase) is preserved so Luna still remembers
  conversationHistory = [];
  msgCount = 0;
  msgDisplay.textContent = '0';
  lastUserText = '';
  lastLunaText = '';
  pinnedMessages = [];
  renderPinnedPanel();
}

function quickSend(text) {
  userInput.value = text;
  handleInput();
  handleSend();
}

// ── Input events ──────────────────────────────────────────────────
let _heightTimer = null;
function handleInput() {
  const len = userInput.value.length;
  charCounter.textContent = `${len}/2000`;
  charCounter.style.color = len > 1800 ? 'var(--crimson-bright)' : '';
  sendBtn.disabled = len === 0 || isTyping;
  // Debounce height recalc on mobile — reading scrollHeight after height:auto forces synchronous layout
  if (IS_MOBILE) {
    clearTimeout(_heightTimer);
    _heightTimer = setTimeout(() => {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 130) + 'px';
    }, 60);
  } else {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 130) + 'px';
  }
  if (len > 0 && appState === 'chat') reportTyping();
}

userInput.addEventListener('input', handleInput);
userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) handleSend(); }
});

// ══════════════════════════════════════════════════════════════════
// ◈ SEARCH SUGGESTIONS — Smart prompt suggestions as you type
// ══════════════════════════════════════════════════════════════════
(function initSearchSuggestions() {
  const SUGGESTIONS = [
    // ── How to ────────────────────────────────────────────────────
    { icon: '🛠️', text: 'How to fix a bug in my code?', cat: 'How to' },
    { icon: '📝', text: 'How to write a professional email?', cat: 'How to' },
    { icon: '🎨', text: 'How to improve my design skills?' },
    { icon: '📊', text: 'How to analyze data effectively?' },
    { icon: '🧠', text: 'How to learn something faster?' },
    { icon: '💡', text: 'How to brainstorm creative ideas?' },
    { icon: '🏋️', text: 'How to build a workout routine?' },
    { icon: '💰', text: 'How to save money effectively?' },
    { icon: '🌐', text: 'How to build a website?' },
    { icon: '📱', text: 'How to grow on social media?' },
    { icon: '🤝', text: 'How to network professionally?' },
    { icon: '📸', text: 'How to take better photos?' },
    { icon: '🧹', text: 'How to stay organized at home?' },
    { icon: '😴', text: 'How to improve sleep quality?' },
    { icon: '🗂️', text: 'How to manage multiple projects?' },
    { icon: '🎓', text: 'How to study more effectively?' },
    { icon: '💪', text: 'How to stay motivated every day?' },
    { icon: '🔒', text: 'How to stay safe online?' },
    { icon: '🍳', text: 'How to cook for beginners?' },
    { icon: '🚀', text: 'How to launch a startup idea?' },
    { icon: '📖', text: 'How to build a reading habit?' },
    { icon: '🧘', text: 'How to manage anxiety naturally?' },
    { icon: '🖥️', text: 'How to speed up my computer?' },
    { icon: '🎯', text: 'How to set SMART goals?' },
    { icon: '🤸', text: 'How to start stretching daily?' },
    { icon: '🤑', text: 'How to make money online?' },
    { icon: '🧑‍💼', text: 'How to ask for a salary raise?' },
    { icon: '🎙️', text: 'How to improve my public speaking?' },
    { icon: '🌍', text: 'How to learn a new language?' },
    { icon: '🧑‍🍳', text: 'How to meal prep for the week?' },
    { icon: '🛡️', text: 'How to protect my privacy online?' },
    { icon: '📷', text: 'How to edit photos like a pro?' },
    { icon: '📲', text: 'How to build a mobile app?' },
    { icon: '🗣️', text: 'How to improve my English fluency?' },
    { icon: '🏠', text: 'How to decorate my room on a budget?' },
    { icon: '🐶', text: 'How to train a dog?' },
    { icon: '🌿', text: 'How to start a garden at home?' },
    { icon: '🧑‍🎨', text: 'How to start drawing as a beginner?' },
    { icon: '⏰', text: 'How to stop procrastinating?' },
    { icon: '💼', text: 'How to write a business proposal?' },
    { icon: '🤳', text: 'How to make a YouTube channel?' },
    { icon: '🏦', text: 'How to invest in stocks for beginners?' },
    { icon: '🧑‍💻', text: 'How to switch to a tech career?' },
    { icon: '🔋', text: 'How to extend my phone battery life?' },
    { icon: '🎯', text: 'How to build discipline?' },
    { icon: '🌅', text: 'How to build a morning routine?' },
    { icon: '📉', text: 'How to get out of debt?' },
    // ── Explain ───────────────────────────────────────────────────
    { icon: '🔭', text: 'Explain quantum physics simply' },
    { icon: '🤖', text: 'Explain how AI works' },
    { icon: '🧬', text: 'Explain DNA and genetics' },
    { icon: '📡', text: 'Explain how the internet works' },
    { icon: '🌙', text: 'Explain black holes to me' },
    { icon: '⚡', text: 'Explain how electricity works' },
    { icon: '🧪', text: 'Explain the periodic table' },
    { icon: '🌊', text: 'Explain how ocean tides work' },
    { icon: '🧠', text: 'Explain how memory works in the brain' },
    { icon: '💹', text: 'Explain the stock market simply' },
    { icon: '🌐', text: 'Explain how DNS works' },
    { icon: '🔐', text: 'Explain encryption and cybersecurity' },
    { icon: '🏛️', text: 'Explain the Philippine government structure' },
    { icon: '🌏', text: 'Explain ASEAN and its purpose' },
    { icon: '🧲', text: 'Explain how magnets work' },
    { icon: '☀️', text: 'Explain how solar panels work' },
    { icon: '🧫', text: 'Explain how vaccines work' },
    { icon: '🌡️', text: 'Explain global warming vs climate change' },
    { icon: '🫀', text: 'Explain how the heart works' },
    { icon: '🪐', text: 'Explain the difference between planets and stars' },
    { icon: '🧿', text: 'Explain the theory of relativity' },
    { icon: '🏗️', text: 'Explain how neural networks work' },
    { icon: '💸', text: 'Explain compound interest simply' },
    { icon: '🗳️', text: 'Explain how elections work in the Philippines' },
    { icon: '🔬', text: 'Explain the difference between mitosis and meiosis' },
    { icon: '🧩', text: 'Explain cognitive dissonance' },
    { icon: '🌐', text: 'Explain blockchain technology simply' },
    { icon: '🛰️', text: 'Explain how GPS works' },
    { icon: '🫁', text: 'Explain how the respiratory system works' },
    { icon: '🎲', text: 'Explain probability and statistics' },
    { icon: '🌌', text: 'Explain the Big Bang theory' },
    { icon: '📡', text: 'Explain how 5G is different from 4G' },
    { icon: '🧑‍⚖️', text: 'Explain the difference between laws and ethics' },
    // ── Write ─────────────────────────────────────────────────────
    { icon: '✍️', text: 'Write a short story about space' },
    { icon: '📧', text: 'Write a cover letter for a job' },
    { icon: '🎵', text: 'Write lyrics for a song' },
    { icon: '📰', text: 'Write a blog post about technology' },
    { icon: '💌', text: 'Write a heartfelt message' },
    { icon: '📜', text: 'Write a persuasive essay' },
    { icon: '🎂', text: 'Write a birthday speech' },
    { icon: '💼', text: 'Write a resume summary for me' },
    { icon: '🙏', text: 'Write an apology message' },
    { icon: '🌸', text: 'Write a poem about nature' },
    { icon: '📝', text: 'Write a thesis statement for me' },
    { icon: '🎤', text: 'Write a speech for graduation' },
    { icon: '📖', text: 'Write a fairy tale for kids' },
    { icon: '💘', text: 'Write a love letter' },
    { icon: '🏆', text: 'Write a motivational quote' },
    { icon: '📣', text: 'Write a product description' },
    { icon: '📋', text: 'Write a meeting agenda template' },
    { icon: '🤣', text: 'Write a funny roast speech' },
    { icon: '👻', text: 'Write a horror short story' },
    { icon: '🌊', text: 'Write a poem about the ocean' },
    { icon: '🤖', text: 'Write a sci-fi story opening' },
    { icon: '📣', text: 'Write a social media caption' },
    { icon: '🎙️', text: 'Write a podcast intro script' },
    { icon: '🏡', text: 'Write a property listing description' },
    { icon: '💡', text: 'Write a pitch for my business idea' },
    { icon: '🙌', text: 'Write a thank you message for my boss' },
    { icon: '😤', text: 'Write a professional complaint letter' },
    { icon: '🎓', text: 'Write a college application essay' },
    { icon: '🫶', text: 'Write wedding vows for me' },
    { icon: '🌟', text: 'Write a self-introduction for an interview' },
    { icon: '🧾', text: 'Write a formal resignation letter' },
    { icon: '💬', text: 'Write a witty dating profile bio' },
    { icon: '🎮', text: 'Write a story set in a video game world' },
    { icon: '📜', text: 'Write a haiku about seasons' },
    // ── What is ───────────────────────────────────────────────────
    { icon: '❓', text: 'What is machine learning?' },
    { icon: '🌍', text: 'What is climate change?' },
    { icon: '💊', text: 'What is intermittent fasting?' },
    { icon: '📈', text: 'What is cryptocurrency?' },
    { icon: '🧘', text: 'What is mindfulness meditation?' },
    { icon: '🧩', text: 'What is cognitive bias?' },
    { icon: '🔮', text: 'What is the metaverse?' },
    { icon: '⚖️', text: 'What is the difference between civil and criminal law?' },
    { icon: '🏦', text: 'What is inflation?' },
    { icon: '🧬', text: 'What is CRISPR gene editing?' },
    { icon: '🛸', text: 'What is dark matter?' },
    { icon: '🧠', text: 'What is emotional intelligence?' },
    { icon: '📊', text: 'What is a balance sheet?' },
    { icon: '🌐', text: 'What is Web3?' },
    { icon: '💉', text: 'What is the difference between bacteria and viruses?' },
    { icon: '📱', text: 'What is 5G technology?' },
    { icon: '🎮', text: 'What is game theory?' },
    { icon: '🏠', text: 'What is passive income?' },
    { icon: '🧪', text: 'What is quantum computing?' },
    { icon: '🫶', text: 'What is the love languages theory?' },
    { icon: '🌿', text: 'What is the difference between vegan and vegetarian?' },
    { icon: '💰', text: 'What is a mutual fund?' },
    { icon: '🔮', text: 'What is consciousness?' },
    { icon: '🦠', text: 'What is antibiotic resistance?' },
    { icon: '🛰️', text: 'What is the James Webb Space Telescope?' },
    { icon: '🧑‍⚖️', text: 'What is habeas corpus?' },
    { icon: '🌐', text: 'What is net neutrality?' },
    { icon: '🧬', text: 'What is epigenetics?' },
    { icon: '💡', text: 'What is the Turing test?' },
    { icon: '🎲', text: 'What is the prisoner\'s dilemma?' },
    { icon: '🏙️', text: 'What is gentrification?' },
    { icon: '📉', text: 'What is a recession?' },
    { icon: '🔋', text: 'What is a solid-state battery?' },
    { icon: '🤖', text: 'What is AGI (Artificial General Intelligence)?' },
    // ── Give me ───────────────────────────────────────────────────
    { icon: '🍕', text: 'Give me a recipe for pasta' },
    { icon: '📚', text: 'Give me book recommendations' },
    { icon: '⚡', text: 'Give me productivity tips' },
    { icon: '💬', text: 'Give me conversation starters' },
    { icon: '🎯', text: 'Give me goal-setting advice' },
    { icon: '🍱', text: 'Give me a Filipino recipe idea' },
    { icon: '🏖️', text: 'Give me travel tips for the Philippines' },
    { icon: '💡', text: 'Give me side hustle ideas' },
    { icon: '🎮', text: 'Give me game recommendations' },
    { icon: '🎬', text: 'Give me movie recommendations' },
    { icon: '🏋️', text: 'Give me a 7-day workout plan' },
    { icon: '🍵', text: 'Give me healthy breakfast ideas' },
    { icon: '📅', text: 'Give me a daily schedule template' },
    { icon: '🎨', text: 'Give me creative project ideas' },
    { icon: '🔑', text: 'Give me tips for a job interview' },
    { icon: '🧴', text: 'Give me a skincare routine' },
    { icon: '🎲', text: 'Give me fun date ideas' },
    { icon: '🌏', text: 'Give me budget travel destinations in Asia' },
    { icon: '🧠', text: 'Give me tips to sharpen my memory' },
    { icon: '💼', text: 'Give me freelancing tips for beginners' },
    { icon: '🍜', text: 'Give me easy ulam ideas for the week' },
    { icon: '📸', text: 'Give me creative photography ideas' },
    { icon: '🐾', text: 'Give me low-maintenance pet ideas' },
    { icon: '🌱', text: 'Give me tips to be more eco-friendly' },
    { icon: '🎤', text: 'Give me icebreaker questions for a group' },
    { icon: '🧩', text: 'Give me logic puzzle ideas' },
    { icon: '🌙', text: 'Give me bedtime routine tips' },
    { icon: '💪', text: 'Give me no-equipment home exercises' },
    { icon: '🎁', text: 'Give me unique gift ideas under 500 pesos' },
    { icon: '📊', text: 'Give me tips to improve my Excel skills' },
    // ── Tell me ───────────────────────────────────────────────────
    { icon: '🌟', text: 'Tell me something interesting' },
    { icon: '🏛️', text: 'Tell me a history fact' },
    { icon: '😂', text: 'Tell me a joke' },
    { icon: '🔬', text: 'Tell me a science fact' },
    { icon: '🎭', text: 'Tell me about philosophy' },
    { icon: '🇵🇭', text: 'Tell me about Philippine history' },
    { icon: '🦁', text: 'Tell me a fun animal fact' },
    { icon: '🌏', text: 'Tell me about Filipino culture' },
    { icon: '🏆', text: 'Tell me about a famous inventor' },
    { icon: '🌌', text: 'Tell me about the universe' },
    { icon: '🎵', text: 'Tell me about the history of music' },
    { icon: '🧩', text: 'Tell me a riddle' },
    { icon: '🏰', text: 'Tell me about ancient civilizations' },
    { icon: '🌋', text: 'Tell me about natural disasters' },
    { icon: '🦠', text: 'Tell me about the human immune system' },
    { icon: '🕵️', text: 'Tell me about a famous unsolved mystery' },
    { icon: '🧙', text: 'Tell me about a famous historical figure' },
    { icon: '🌊', text: 'Tell me about ocean life' },
    { icon: '🎨', text: 'Tell me about the history of art' },
    { icon: '🌍', text: 'Tell me an interesting geography fact' },
    { icon: '🦕', text: 'Tell me about dinosaurs' },
    { icon: '🧬', text: 'Tell me about the human body' },
    { icon: '🏙️', text: 'Tell me about a fascinating city in the world' },
    { icon: '🌠', text: 'Tell me about space exploration history' },
    { icon: '🎭', text: 'Tell me about Shakespeare' },
    { icon: '🤯', text: 'Tell me a mind-blowing fact' },
    { icon: '🫀', text: 'Tell me something about the human heart' },
    { icon: '🐙', text: 'Tell me about deep sea creatures' },
    { icon: '🧊', text: 'Tell me about the Arctic and Antarctic' },
    { icon: '🔮', text: 'Tell me about ancient mythology' },
    // ── Help me ───────────────────────────────────────────────────
    { icon: '🧩', text: 'Help me solve a math problem' },
    { icon: '🗣️', text: 'Help me practice a language' },
    { icon: '📅', text: 'Help me plan my week' },
    { icon: '🎤', text: 'Help me prepare for an interview' },
    { icon: '💻', text: 'Help me debug my code' },
    { icon: '📖', text: 'Help me understand my homework' },
    { icon: '✉️', text: 'Help me reply to this message' },
    { icon: '💔', text: 'Help me deal with stress' },
    { icon: '🛒', text: 'Help me make a grocery list' },
    { icon: '💸', text: 'Help me budget my salary' },
    { icon: '🎓', text: 'Help me write my thesis' },
    { icon: '🗺️', text: 'Help me plan a trip' },
    { icon: '📉', text: 'Help me understand my finances' },
    { icon: '🎁', text: 'Help me choose a gift' },
    { icon: '🤔', text: 'Help me make a decision' },
    { icon: '📚', text: 'Help me study for an exam' },
    { icon: '🧑‍💼', text: 'Help me write a LinkedIn bio' },
    { icon: '📊', text: 'Help me understand a concept in statistics' },
    { icon: '💌', text: 'Help me write a message to my crush' },
    { icon: '🎯', text: 'Help me set 90-day goals' },
    { icon: '🧑‍🍳', text: 'Help me figure out what to cook tonight' },
    { icon: '😤', text: 'Help me calm down when I am angry' },
    { icon: '🛏️', text: 'Help me fix my sleep schedule' },
    { icon: '🤝', text: 'Help me deal with a difficult coworker' },
    { icon: '🏡', text: 'Help me plan a home renovation' },
    { icon: '📸', text: 'Help me build a portfolio' },
    { icon: '📬', text: 'Help me write a follow-up email' },
    { icon: '🧠', text: 'Help me memorize faster' },
    { icon: '📐', text: 'Help me understand geometry' },
    { icon: '🤕', text: 'Help me understand medical terms' },
    // ── Can you ───────────────────────────────────────────────────
    { icon: '🔍', text: 'Can you summarize this for me?' },
    { icon: '🌐', text: 'Can you translate this?' },
    { icon: '📋', text: 'Can you make a to-do list?' },
    { icon: '🧮', text: 'Can you calculate something?' },
    { icon: '🖼️', text: 'Can you describe an image?' },
    { icon: '🔄', text: 'Can you rewrite this more clearly?' },
    { icon: '📊', text: 'Can you compare these two things?' },
    { icon: '✅', text: 'Can you check my grammar?' },
    { icon: '🎙️', text: 'Can you roleplay as a character?' },
    { icon: '🗓️', text: 'Can you make a study schedule?' },
    { icon: '📌', text: 'Can you outline this topic for me?' },
    { icon: '🧩', text: 'Can you simplify this concept?' },
    { icon: '🧑‍🏫', text: 'Can you quiz me on a topic?' },
    { icon: '🔀', text: 'Can you give me an alternative viewpoint?' },
    { icon: '🗣️', text: 'Can you act as my debate partner?' },
    { icon: '📓', text: 'Can you turn this into bullet points?' },
    { icon: '🧪', text: 'Can you fact-check this for me?' },
    { icon: '📈', text: 'Can you analyze this data?' },
    { icon: '🤖', text: 'Can you pretend to be a career coach?' },
    { icon: '🌐', text: 'Can you explain this in another language?' },
    { icon: '✏️', text: 'Can you edit this paragraph for me?' },
    { icon: '📜', text: 'Can you give me an essay structure?' },
    // ── Filipino / Tagalog ────────────────────────────────────────
    { icon: '🇵🇭', text: 'Ano ang ibig sabihin ng...' },
    { icon: '📖', text: 'Ipaliwanag mo ang Noli Me Tangere' },
    { icon: '🧮', text: 'Tulungan mo akong sa math' },
    { icon: '✍️', text: 'Gumawa ng essay para sa akin' },
    { icon: '💬', text: 'Makipag-usap tayo sa Tagalog' },
    { icon: '🎓', text: 'Paano mag-aral ng epektibo?' },
    { icon: '💰', text: 'Paano mag-ipon ng pera?' },
    { icon: '🍜', text: 'Anong lutuin para sa hapunan?' },
    { icon: '😔', text: 'Malungkot ako, tulungan mo ako' },
    { icon: '📝', text: 'Tulungan mo akong mag-thesis' },
    { icon: '🏙️', text: 'Ano ang magandang lugar sa Pilipinas?' },
    { icon: '🎓', text: 'Ano ang pinakamabuting kurso sa kolehiyo?' },
    { icon: '💔', text: 'Paano makaka-move on?' },
    { icon: '🍱', text: 'Ano ang madaling lutuin na ulam?' },
    { icon: '🧑‍💼', text: 'Paano mag-apply ng trabaho?' },
    { icon: '🌟', text: 'Bigyan mo ako ng motivasyon' },
    { icon: '📱', text: 'Anong magandang smartphone ang bilhin?' },
    { icon: '🎭', text: 'Ipaliwanag ang El Filibusterismo' },
    { icon: '🧘', text: 'Paano maging mas maayos ang isipan?' },
    { icon: '🗳️', text: 'Paano gumagana ang eleksyon sa Pilipinas?' },
    { icon: '🎵', text: 'Anong OPM songs ang masayang pakinggan?' },
    { icon: '🏫', text: 'Anong magandang review center?' },
    // ── Accounting (PH context) ───────────────────────────────────
    { icon: '📒', text: 'Help me journalize a transaction' },
    { icon: '📊', text: 'How do I make a trial balance?' },
    { icon: '🧾', text: 'Explain debits and credits' },
    { icon: '💼', text: 'What is the accounting cycle?' },
    { icon: '🏦', text: 'How to prepare a balance sheet?' },
    { icon: '📈', text: 'What is an income statement?' },
    { icon: '🗂️', text: 'How to post to a general ledger?' },
    { icon: '💵', text: 'Explain adjusting entries' },
    { icon: '🧾', text: 'What is VAT in the Philippines?' },
    { icon: '📑', text: 'How to file BIR taxes in the Philippines?' },
    { icon: '🏢', text: 'What is the difference between sole proprietorship and corporation?' },
    { icon: '💳', text: 'Explain the cash flow statement' },
    { icon: '📋', text: 'What are the different types of financial statements?' },
    { icon: '🧮', text: 'How to compute depreciation?' },
    { icon: '💰', text: 'What is accrual vs cash basis accounting?' },
    { icon: '🔢', text: 'How to compute for income tax in the Philippines?' },
    // ── Coding ───────────────────────────────────────────────────
    { icon: '🐍', text: 'Teach me Python basics' },
    { icon: '🌐', text: 'How do I build a simple website?' },
    { icon: '⚛️', text: 'Help me understand React' },
    { icon: '🗄️', text: 'Explain SQL databases' },
    { icon: '🔧', text: 'What is an API?' },
    { icon: '🐛', text: 'Why is my code not working?' },
    { icon: '📦', text: 'Explain how Git version control works' },
    { icon: '🔐', text: 'How do I hash passwords securely?' },
    { icon: '💡', text: 'What programming language should I learn first?' },
    { icon: '🖥️', text: 'Explain object-oriented programming' },
    { icon: '🔁', text: 'What is the difference between a loop and recursion?' },
    { icon: '🧱', text: 'Explain REST vs GraphQL APIs' },
    { icon: '🌐', text: 'How does HTTP and HTTPS work?' },
    { icon: '⚡', text: 'What is TypeScript and why use it?' },
    { icon: '📦', text: 'Explain Docker and containers' },
    { icon: '🧠', text: 'What is machine learning in code?' },
    { icon: '🔀', text: 'What is async/await in JavaScript?' },
    { icon: '🛡️', text: 'What are common web security vulnerabilities?' },
    { icon: '📊', text: 'Explain time and space complexity' },
    { icon: '☁️', text: 'What is cloud computing for developers?' },
    { icon: '🧪', text: 'How do I write unit tests?' },
    { icon: '🗂️', text: 'What is a data structure?' },
    { icon: '🔢', text: 'Explain binary and hexadecimal numbers' },
    { icon: '🤖', text: 'How do I use the OpenAI API?' },
    { icon: '📱', text: 'How do I build a Flutter app?' },
    { icon: '🧑‍💻', text: 'What is the difference between frontend and backend?' },
    // ── Science & Math ────────────────────────────────────────────
    { icon: '➕', text: 'Solve this algebra problem' },
    { icon: '📐', text: 'Help me with trigonometry' },
    { icon: '🔢', text: 'Explain calculus to me' },
    { icon: '⚗️', text: 'Help me with chemistry' },
    { icon: '🔭', text: 'Explain the solar system' },
    { icon: '🌊', text: 'Explain Newton\'s laws of motion' },
    { icon: '🧲', text: 'What is electromagnetic induction?' },
    { icon: '🌡️', text: 'Explain thermodynamics simply' },
    { icon: '📏', text: 'Help me with geometric proofs' },
    { icon: '🌍', text: 'Explain plate tectonics' },
    { icon: '🧪', text: 'Explain the law of conservation of energy' },
    { icon: '🔬', text: 'What is the difference between a cell and a molecule?' },
    { icon: '🫀', text: 'Explain the human circulatory system' },
    { icon: '🌿', text: 'Explain photosynthesis and cellular respiration' },
    { icon: '⚡', text: 'Explain Ohm\'s law' },
    { icon: '📉', text: 'Explain standard deviation and variance' },
    { icon: '🧬', text: 'What is the central dogma of biology?' },
    // ── Health & Wellness ─────────────────────────────────────────
    { icon: '🥗', text: 'What foods are good for the brain?' },
    { icon: '💧', text: 'How much water should I drink daily?' },
    { icon: '🏃', text: 'What is the best cardio exercise?' },
    { icon: '😴', text: 'How to fix my sleep schedule?' },
    { icon: '🧘', text: 'Guide me through a breathing exercise' },
    { icon: '🩺', text: 'What are symptoms of stress?' },
    { icon: '🍎', text: 'Explain a healthy balanced diet' },
    { icon: '💊', text: 'What vitamins should I take daily?' },
    { icon: '🧘', text: 'How to reduce body fat naturally?' },
    { icon: '🧠', text: 'What causes brain fog and how to fix it?' },
    { icon: '🦷', text: 'How to improve dental health?' },
    { icon: '👀', text: 'How to protect my eyesight from screens?' },
    { icon: '🏋️', text: 'What is the best diet for muscle gain?' },
    { icon: '🩸', text: 'What are normal blood pressure levels?' },
    { icon: '🫁', text: 'What are breathing exercises for anxiety?' },
    { icon: '🌙', text: 'What are signs of sleep deprivation?' },
    { icon: '🍳', text: 'What are healthy Filipino foods to eat daily?' },
    { icon: '🧬', text: 'How does stress affect the body?' },
    // ── Fun & Entertainment ───────────────────────────────────────
    { icon: '🎲', text: 'Give me a fun trivia question' },
    { icon: '🎮', text: 'Tell me about the history of video games' },
    { icon: '🎬', text: 'Recommend a movie based on my mood' },
    { icon: '🎵', text: 'Recommend a song for studying' },
    { icon: '😂', text: 'Tell me a funny story' },
    { icon: '🧩', text: 'Give me a brain teaser' },
    { icon: '🐉', text: 'Tell me about world mythology' },
    { icon: '🃏', text: 'Let\'s play a word game' },
    { icon: '🌈', text: 'Cheer me up!' },
    { icon: '🎯', text: 'Give me a fun challenge for today' },
    { icon: '🔮', text: 'Tell me my personality based on my zodiac' },
    { icon: '🎭', text: 'Tell me a plot twist story' },
    { icon: '🤣', text: 'Tell me a dad joke' },
    { icon: '🎤', text: 'Let\'s play 20 questions' },
    { icon: '🎪', text: 'Tell me a weird but true fact' },
    { icon: '🕵️', text: 'Give me a murder mystery scenario' },
    { icon: '🐾', text: 'Tell me about the most unusual animals' },
    { icon: '🌍', text: 'Give me a random country fact' },
    { icon: '⚡', text: 'Give me a fun writing prompt' },
    { icon: '🏆', text: 'Tell me about the most surprising world records' },
    // ── Personal Growth ───────────────────────────────────────────
    { icon: '🌱', text: 'How do I build better habits?' },
    { icon: '🗣️', text: 'How do I become more confident?' },
    { icon: '📔', text: 'Help me start journaling' },
    { icon: '🤝', text: 'How do I improve my communication skills?' },
    { icon: '🧭', text: 'Help me find my passion' },
    { icon: '💭', text: 'How do I stop overthinking?' },
    { icon: '🌟', text: 'How do I become the best version of myself?' },
    { icon: '🪞', text: 'Help me with self-reflection' },
    { icon: '💡', text: 'How do I develop a growth mindset?' },
    { icon: '🔥', text: 'How do I get back on track after failing?' },
    { icon: '🧘', text: 'How do I practice gratitude daily?' },
    { icon: '💪', text: 'How do I build mental toughness?' },
    { icon: '🌅', text: 'How do I become a morning person?' },
    { icon: '❤️', text: 'How do I set healthy boundaries?' },
    { icon: '🤝', text: 'How do I forgive someone who hurt me?' },
    { icon: '🌿', text: 'How do I deal with burnout?' },
    { icon: '🧩', text: 'How do I figure out my core values?' },
    { icon: '💬', text: 'How do I become a better listener?' },
    { icon: '🪴', text: 'How do I slow down and be more present?' },
    { icon: '🗺️', text: 'How do I plan my 5-year goals?' },
    // ── Career & Work ─────────────────────────────────────────────
    { icon: '💼', text: 'How do I ace a job interview?' },
    { icon: '📄', text: 'How do I write a strong resume?' },
    { icon: '🧑‍💼', text: 'How do I negotiate my salary?' },
    { icon: '🚀', text: 'How do I get promoted faster?' },
    { icon: '🌐', text: 'How do I find remote work opportunities?' },
    { icon: '🧑‍🤝‍🧑', text: 'How do I deal with a toxic boss?' },
    { icon: '📊', text: 'What skills are most in-demand right now?' },
    { icon: '🎓', text: 'Is it worth getting a master\'s degree?' },
    { icon: '🧑‍💻', text: 'How do I transition into tech without a CS degree?' },
    { icon: '💡', text: 'What are the best careers for introverts?' },
    { icon: '📅', text: 'How do I manage my time at work better?' },
    { icon: '🤝', text: 'How do I build a professional network from scratch?' },
    { icon: '🧑‍🎨', text: 'How do I become a freelancer?' },
    { icon: '🏆', text: 'How do I stand out in a competitive job market?' },
    // ── Finance & Money ───────────────────────────────────────────
    { icon: '💰', text: 'How do I start investing in the Philippines?' },
    { icon: '📈', text: 'What is the difference between stocks and bonds?' },
    { icon: '🏦', text: 'What is a PERA account in the Philippines?' },
    { icon: '💳', text: 'How do I use a credit card wisely?' },
    { icon: '🧾', text: 'How do I file my ITR as a freelancer?' },
    { icon: '🏠', text: 'How do I save for a house in the Philippines?' },
    { icon: '📉', text: 'What should I do when the stock market crashes?' },
    { icon: '💡', text: 'What are the best passive income ideas in PH?' },
    { icon: '🌱', text: 'What is dollar cost averaging?' },
    { icon: '🧮', text: 'Help me calculate my monthly budget' },
    { icon: '💵', text: 'What is the difference between saving and investing?' },
    { icon: '🏦', text: 'What is SSS, PhilHealth, and Pag-IBIG?' },
    // ── Travel & Places ───────────────────────────────────────────
    { icon: '🏖️', text: 'What are the best beaches in the Philippines?' },
    { icon: '✈️', text: 'How do I travel on a budget?' },
    { icon: '🗺️', text: 'What should I pack for a beach trip?' },
    { icon: '🏙️', text: 'What are must-visit places in Manila?' },
    { icon: '🌏', text: 'What countries are easy to travel to from the Philippines?' },
    { icon: '🏔️', text: 'What are the best mountains to climb in the Philippines?' },
    { icon: '🛫', text: 'How do I apply for a tourist visa?' },
    { icon: '🌴', text: 'What are hidden gems in the Philippines?' },
    { icon: '🍜', text: 'What local food should I try when traveling in the Philippines?' },
    { icon: '🏡', text: 'What is the difference between Airbnb and hotels?' },
    // ── AI & Technology ───────────────────────────────────────────
    { icon: '🤖', text: 'What is the difference between AI and ML?' },
    { icon: '🧠', text: 'What is a large language model?' },
    { icon: '🔮', text: 'What AI tools should I learn in 2026?' },
    { icon: '⚡', text: 'How can AI help me at work?' },
    { icon: '🛡️', text: 'Is AI dangerous? What are the risks?' },
    { icon: '🤳', text: 'How does facial recognition work?' },
    { icon: '🗣️', text: 'How do AI voice assistants work?' },
    { icon: '🎨', text: 'What is generative AI?' },
    { icon: '💡', text: 'What is prompt engineering?' },
    { icon: '🌐', text: 'What is the difference between AI and automation?' },
    // ── School & Academics ────────────────────────────────────────
    { icon: '📚', text: 'Help me understand the Rizal Law' },
    { icon: '🧪', text: 'Help me with my science investigatory project' },
    { icon: '📐', text: 'Explain the Pythagorean theorem' },
    { icon: '📜', text: 'Summarize Jose Rizal\'s life and works' },
    { icon: '🌍', text: 'Explain the causes of World War II' },
    { icon: '🧬', text: 'Explain Mendel\'s laws of inheritance' },
    { icon: '📖', text: 'Help me analyze a literary piece' },
    { icon: '🗣️', text: 'Help me write a reaction paper' },
    { icon: '🏛️', text: 'Explain the 1987 Philippine Constitution' },
    { icon: '🧮', text: 'Help me with my statistics homework' },
    { icon: '💡', text: 'Give me tips for passing board exams' },
    { icon: '📝', text: 'Help me write a research abstract' },
  ];

  const MAX_SUGGESTIONS = 6;
  const MAX_RECENT = 5;
  const RECENT_KEY = 'luna_recent_queries';
  const sugBox = document.getElementById('searchSuggestions');
  if (!sugBox) return;

  let activeIdx = -1;
  let currentItems = [];

  // ── Recent searches helpers ──────────────────────────────────────
  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }
  function saveRecent(text) {
    let recent = getRecent().filter(r => r !== text);
    recent.unshift(text);
    recent = recent.slice(0, MAX_RECENT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
  }
  function removeRecent(text) {
    const recent = getRecent().filter(r => r !== text);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
  }

  function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function highlight(text, query) {
    if (!query) return text;
    const rx = new RegExp(`(${escapeRx(query)})`, 'gi');
    return text.replace(rx, '<mark>$1</mark>');
  }

  function inferCat(text) {
    const t = text.toLowerCase();
    if (t.startsWith('how to') || t.startsWith('paano') || t.startsWith('how do i')) return 'How to';
    if (t.startsWith('explain') || t.startsWith('ipaliwanag')) return 'Explain';
    if (t.startsWith('write') || t.startsWith('gumawa')) return 'Write';
    if (t.startsWith('what is') || t.startsWith('what are') || t.startsWith('ano ang') || t.startsWith('anong')) return 'What is';
    if (t.startsWith('give me')) return 'Give me';
    if (t.startsWith('tell me')) return 'Tell me';
    if (t.startsWith('help me') || t.startsWith('tulungan')) return 'Help me';
    if (t.startsWith('can you')) return 'Can you';
    if (t.startsWith('teach') || t.startsWith('solve')) return 'Learn';
    if (t.startsWith('recommend')) return 'Recommend';
    if (/tagalog|pilipino|makipag|malungkot|hapunan|noli|ipaliwanag|gumawa|paano|anong|pera|trabaho|birhen|opm/i.test(t)) return 'Filipino';
    if (/bir|sss|philhealth|pag-ibig|vat|itr|pera|piso|journali|trial balance|ledger|debit|credit|balance sheet|income statement|adjusting|depreciation|accrual/i.test(t)) return 'Accounting';
    if (/python|javascript|react|sql|api|git|code|debug|html|css|typescript|docker|flutter|programming|backend|frontend/i.test(t)) return 'Coding';
    if (/invest|stock|bond|budget|salary|mutual fund|credit card|passive income|recession|inflation|compound|pera/i.test(t)) return 'Finance';
    if (/beach|travel|visa|mountain|manila|philippines|pilipinas|trip|pack|airbnb/i.test(t)) return 'Travel';
    if (/ai |machine learning|llm|neural|gpt|chatgpt|automation|generative|prompt engineering/i.test(t)) return 'AI & Tech';
    if (/resume|interview|career|promotion|freelanc|linkedin|job|salary|negotiate|workplace/i.test(t)) return 'Career';
    if (/rizal|constitution|noli|filibusterismo|katipunan|araling|edukasyon|grade|school|thesis|homework|exam|review/i.test(t)) return 'School';
    if (/algebra|calculus|trigonometry|geometry|statistic|physics|chemistry|biology|science/i.test(t)) return 'Science';
    if (/diet|sleep|stress|vitamins|exercise|cardio|mental health|breath|wellness|water|food|healthy/i.test(t)) return 'Health';
    return null;
  }

  function renderItems(items, isRecent) {
    currentItems = items;
    activeIdx = -1;

    const headerLabel = isRecent ? '🕐 RECENT' : '◈ SUGGESTIONS';
    const countHint = `${items.length} match${items.length !== 1 ? 'es' : ''}`;

    // Split recent vs suggestion items when mixed
    const recentItems = items.filter(s => s._isRecent || isRecent);
    const suggItems = items.filter(s => !s._isRecent && !isRecent);
    const hasMixed = recentItems.length > 0 && suggItems.length > 0;

    const renderItem = (s, i) => {
      const cat = s.cat || (s._isRecent ? null : inferCat(s.text));
      return `<div class="sug-item" data-idx="${i}" tabindex="-1">
        <div class="sug-icon-wrap"><span class="sug-icon">${s._isRecent || isRecent ? '🕐' : s.icon}</span></div>
        <div class="sug-body">
          <span class="sug-text">${s.displayText || s.text}</span>
          ${cat ? `<span class="sug-cat">${cat}</span>` : ''}
        </div>
        ${(s._isRecent || isRecent)
          ? `<span class="sug-recent-badge">recent</span><span class="sug-remove" data-text="${s.text.replace(/"/g,'&quot;')}" title="Remove">✕</span>`
          : `<span class="sug-arrow">↵</span>`
        }
      </div>`;
    };

    let html = `<div class="sug-header">
      <span class="sug-header-dot"></span>
      ${headerLabel}
      <span class="sug-header-right">${countHint}</span>
    </div>`;

    if (hasMixed) {
      html += recentItems.map((s, i) => renderItem(s, i)).join('');
      html += `<div class="sug-divider"></div>`;
      html += suggItems.map((s, i) => renderItem(s, recentItems.length + i)).join('');
    } else {
      html += items.map((s, i) => renderItem(s, i)).join('');
    }

    sugBox.innerHTML = html;

    // Remove buttons for recent items
    sugBox.querySelectorAll('.sug-remove').forEach(btn => {
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        removeRecent(btn.dataset.text);
        // Re-show with updated recent list
        showOnFocus();
      });
    });

    sugBox.querySelectorAll('.sug-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        if (e.target.classList.contains('sug-remove')) return;
        e.preventDefault();
        applySuggestion(parseInt(el.dataset.idx));
      });
      el.addEventListener('mouseenter', () => {
        setActive(parseInt(el.dataset.idx));
      });
    });

    sugBox.classList.remove('hidden');
  }

  // Trending prompts shown when input is empty and no recent history
  const TRENDING = [
    { icon: '🤖', text: 'Explain how AI works' },
    { icon: '💡', text: 'Give me side hustle ideas' },
    { icon: '📝', text: 'Help me write a cover letter' },
    { icon: '🐍', text: 'Teach me Python basics' },
    { icon: '😂', text: 'Tell me a joke' },
    { icon: '🇵🇭', text: 'Tell me about Philippine history' },
    { icon: '💰', text: 'How to save money effectively?' },
    { icon: '🧘', text: 'Guide me through a breathing exercise' },
    { icon: '🎬', text: 'Recommend a movie based on my mood' },
    { icon: '🔥', text: 'How do I get back on track after failing?' },
    { icon: '💻', text: 'Help me debug my code' },
    { icon: '🍜', text: 'Give me easy ulam ideas for the week' },
  ];

  // Show recent queries when input is focused and empty, or trending chips if no history
  function showOnFocus() {
    const recent = getRecent();
    if (recent.length === 0) {
      // Show trending chips as inspiration
      const html = `
        <div class="sug-header">
          <span class="sug-header-dot"></span>
          TRY ASKING
          <span class="sug-header-right">TRENDING</span>
        </div>
        <div class="sug-trending">
          ${TRENDING.map(t => `<span class="sug-trending-chip" data-text="${t.text.replace(/"/g,'&quot;')}">${t.icon} ${t.text}</span>`).join('')}
        </div>`;
      sugBox.innerHTML = html;
      sugBox.querySelectorAll('.sug-trending-chip').forEach(chip => {
        chip.addEventListener('mousedown', e => {
          e.preventDefault();
          userInput.value = chip.dataset.text;
          handleInput();
          hideSuggestions();
          userInput.focus();
        });
      });
      sugBox.classList.remove('hidden');
      return;
    }
    const items = recent.map(t => ({ text: t, icon: '🕐', displayText: t }));
    renderItems(items, true);
  }

  // ── Google-style query expansion: generate variants from the typed query ──
  function expandQuery(raw) {
    const q = raw.trim().replace(/\?+$/, '').trim();
    if (!q || q.length < 3) return [];
    const lower = q.toLowerCase();

    // ── Helper: extract the topic after a prefix word/phrase ──────
    // e.g. extractAfter("what is cotabato", /^what\s+is\s+/i) → "cotabato"
    function extractAfter(str, prefixRx) {
      const m = str.match(prefixRx);
      if (!m) return null;
      const rest = str.slice(m[0].length).trim();
      return rest.length > 0 ? rest : null;
    }

    // ── Detect query intent and extract core topic ────────────────

    // "what is X" / "what are X" / "ano ang X" / "anong X"
    let T = extractAfter(q, /^(?:what(?:'s|\s+is|\s+are)\s+(?:a\s+|an\s+|the\s+)?|ano(?:ng|\s+ang)?\s+)/i);
    if (T) return [
      { icon: '❓', text: `What is ${T}?` },
      { icon: '📍', text: `What is ${T} known for?` },
      { icon: '📜', text: `History of ${T}` },
      { icon: '🌍', text: `Where is ${T} located?` },
      { icon: '🗺️', text: `What region is ${T} in?` },
      { icon: '👥', text: `What language is spoken in ${T}?` },
      { icon: '🍽️', text: `What is ${T} famous for?` },
      { icon: '📊', text: `Population of ${T}` },
      { icon: '🔍', text: `What does ${T} mean?` },
      { icon: '💡', text: `Explain ${T} simply` },
    ];

    // "how to X" / "how do I X" / "paano X"
    T = extractAfter(q, /^(?:how\s+(?:do\s+(?:i|you)\s+|to\s+)|paano(?:\s+mag)?(?:\s+ng)?\s+)/i);
    if (T) return [
      { icon: '🛠️', text: `How to ${T}?` },
      { icon: '🎓', text: `How to ${T} as a beginner?` },
      { icon: '⚡', text: `How to ${T} fast?` },
      { icon: '🆓', text: `How to ${T} for free?` },
      { icon: '💡', text: `Best way to ${T}` },
      { icon: '⚠️', text: `Common mistakes when ${T}` },
      { icon: '🔰', text: `${T} step by step` },
      { icon: '🏆', text: `Tips for ${T} effectively` },
      { icon: '🤔', text: `Why is ${T} important?` },
      { icon: '📱', text: `How to ${T} on your phone` },
    ];

    // "why X" / "why do X" / "why is X" / "why people X"
    T = extractAfter(q, /^why\s+(?:do\s+|does\s+|is\s+|are\s+|people\s+|can\s+|did\s+)?/i);
    if (T) return [
      { icon: '🤔', text: `Why ${T}?` },
      { icon: '💡', text: `Reasons why ${T}` },
      { icon: '📖', text: `Explain why ${T}` },
      { icon: '🔍', text: `What causes ${T}?` },
      { icon: '📊', text: `Facts about ${T}` },
      { icon: '🌍', text: `Effects of ${T}` },
      { icon: '🧠', text: `Psychology behind ${T}` },
      { icon: '✅', text: `Benefits of ${T}` },
      { icon: '❌', text: `Risks of ${T}` },
      { icon: '🇵🇭', text: `${T} in the Philippines` },
    ];

    // "explain X" / "ipaliwanag X"
    T = extractAfter(q, /^(?:explain|ipaliwanag)\s+(?:the\s+|a\s+|an\s+)?/i);
    if (T) return [
      { icon: '🔭', text: `Explain ${T}` },
      { icon: '👶', text: `Explain ${T} in simple terms` },
      { icon: '🧪', text: `Explain ${T} with examples` },
      { icon: '⚗️', text: `How does ${T} work?` },
      { icon: '📖', text: `What is ${T}?` },
      { icon: '📜', text: `History of ${T}` },
      { icon: '🆚', text: `${T} vs alternatives` },
      { icon: '✅', text: `Benefits of ${T}` },
      { icon: '❌', text: `Disadvantages of ${T}` },
      { icon: '🌍', text: `${T} in the Philippines` },
    ];

    // "write X" / "gumawa ng X" / "draft X"
    T = extractAfter(q, /^(?:write(?:\s+a(?:n)?)?\s+|gumawa(?:\s+ng)?\s+|draft(?:\s+a(?:n)?)?\s+|make(?:\s+a(?:n)?)?\s+)/i);
    if (T) return [
      { icon: '✍️', text: `Write a ${T}` },
      { icon: '🎯', text: `Write a professional ${T}` },
      { icon: '😊', text: `Write a casual ${T}` },
      { icon: '📝', text: `Write a short ${T}` },
      { icon: '📄', text: `Write a formal ${T}` },
      { icon: '💌', text: `Write a heartfelt ${T}` },
      { icon: '🤣', text: `Write a funny ${T}` },
      { icon: '🌸', text: `Write a ${T} in Filipino` },
      { icon: '🎓', text: `Write a ${T} for school` },
      { icon: '💼', text: `Write a ${T} for work` },
    ];

    // "tell me about X" / "about X" / "tungkol sa X"
    T = extractAfter(q, /^(?:tell\s+me\s+(?:about\s+)?|about\s+|tungkol\s+sa\s+)/i);
    if (T) return [
      { icon: '💬', text: `Tell me about ${T}` },
      { icon: '📜', text: `History of ${T}` },
      { icon: '🔍', text: `What is ${T}?` },
      { icon: '🌟', text: `Interesting facts about ${T}` },
      { icon: '🏆', text: `What is ${T} famous for?` },
      { icon: '🆚', text: `${T} compared to others` },
      { icon: '📍', text: `Where is ${T}?` },
      { icon: '🧠', text: `Everything to know about ${T}` },
      { icon: '🇵🇭', text: `${T} in the Philippines` },
      { icon: '📊', text: `${T} statistics and facts` },
    ];

    // "give me X" / "recommend X" / "suggest X"
    T = extractAfter(q, /^(?:give\s+me\s+(?:a\s+|some\s+)?|recommend\s+(?:a\s+|some\s+)?|suggest\s+(?:a\s+|some\s+)?)/i);
    if (T) return [
      { icon: '💡', text: `Give me ${T}` },
      { icon: '⭐', text: `Best ${T} for beginners` },
      { icon: '🏆', text: `Top ${T} in 2026` },
      { icon: '🆓', text: `Free ${T} online` },
      { icon: '🇵🇭', text: `Best ${T} in the Philippines` },
      { icon: '📱', text: `Best ${T} for mobile` },
      { icon: '🎓', text: `${T} for students` },
      { icon: '💼', text: `${T} for professionals` },
      { icon: '🔰', text: `Simple ${T} for everyday use` },
      { icon: '🔍', text: `How to choose the right ${T}` },
    ];

    // "help me X" / "tulungan mo ako"
    T = extractAfter(q, /^(?:help\s+me\s+(?:with\s+)?|tulungan(?:\s+mo\s+ako(?:\s+sa)?)?)\s*/i);
    if (T) return [
      { icon: '🙌', text: `Help me ${T}` },
      { icon: '🎓', text: `${T} for beginners` },
      { icon: '🔰', text: `Step by step guide to ${T}` },
      { icon: '💡', text: `Tips for ${T}` },
      { icon: '⚠️', text: `Common problems with ${T}` },
      { icon: '🏆', text: `Best practices for ${T}` },
      { icon: '📱', text: `${T} on mobile` },
      { icon: '🆓', text: `Free resources for ${T}` },
      { icon: '🤔', text: `Why is ${T} difficult?` },
      { icon: '🇵🇭', text: `${T} in the Philippines` },
    ];

    // ── No trigger word matched — treat the whole input as a topic ─
    // e.g. "cotabato", "anxiety", "react js", "why people must"
    // Use the raw q as topic but avoid nonsensical combinations
    // by selecting only universally safe templates
    const fullQ = q;
    return [
      { icon: '❓', text: `What is ${fullQ}?` },
      { icon: '📜', text: `History of ${fullQ}` },
      { icon: '🌟', text: `Interesting facts about ${fullQ}` },
      { icon: '🏆', text: `${fullQ} — what it means and why it matters` },
      { icon: '💡', text: `Explain ${fullQ} simply` },
      { icon: '🔍', text: `Everything you need to know about ${fullQ}` },
      { icon: '🆚', text: `${fullQ} pros and cons` },
      { icon: '🇵🇭', text: `${fullQ} in the Philippines` },
      { icon: '📊', text: `Statistics and facts about ${fullQ}` },
      { icon: '🤔', text: `Why is ${fullQ} important?` },
    ];
  }

  function showSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q || q.length < 2) {
      // Show recent if input empty/short
      showOnFocus();
      return;
    }

    // Prioritise recent matches, then SUGGESTIONS list
    const recent = getRecent();
    const recentMatches = recent
      .filter(r => r.toLowerCase().includes(q))
      .map(t => ({ text: t, icon: '🕐', displayText: highlight(t, query.trim()), _isRecent: true }));

    const suggMatches = SUGGESTIONS.filter(s =>
      s.text.toLowerCase().includes(q) &&
      !recentMatches.some(r => r.text.toLowerCase() === s.text.toLowerCase())
    ).slice(0, MAX_SUGGESTIONS - recentMatches.length)
     .map(s => ({ ...s, displayText: highlight(s.text, query.trim()) }));

    // ── If static list has few or no matches, expand with Google-style variants ──
    const staticCount = recentMatches.length + suggMatches.length;
    let expandedMatches = [];
    if (staticCount < MAX_SUGGESTIONS) {
      const expanded = expandQuery(query.trim())
        .filter(e => !recentMatches.some(r => r.text.toLowerCase() === e.text.toLowerCase()))
        .filter(e => !suggMatches.some(s => s.text.toLowerCase() === e.text.toLowerCase()))
        .slice(0, MAX_SUGGESTIONS - staticCount)
        .map(s => ({ ...s, displayText: highlight(s.text, query.trim()) }));
      expandedMatches = expanded;
    }

    const matches = [...recentMatches, ...suggMatches, ...expandedMatches].slice(0, MAX_SUGGESTIONS);

    if (matches.length === 0) {
      // Show a friendly "no results" state instead of just disappearing
      sugBox.innerHTML = `
        <div class="sug-empty-state">
          <span class="sug-empty-icon">🔍</span>
          <span class="sug-empty-label">NO SUGGESTIONS — JUST ASK LUNA ANYTHING</span>
        </div>`;
      sugBox.classList.remove('hidden');
      return;
    }

    const hasRecentOnly = suggMatches.length === 0 && expandedMatches.length === 0 && recentMatches.length > 0;
    renderItems(matches, hasRecentOnly);
  }

  function hideSuggestions() {
    sugBox.classList.add('hidden');
    sugBox.innerHTML = '';
    currentItems = [];
    activeIdx = -1;
  }

  function setActive(idx) {
    activeIdx = idx;
    sugBox.querySelectorAll('.sug-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
  }

  function applySuggestion(idx) {
    const item = currentItems[idx];
    if (!item) return;
    userInput.value = item.text;
    handleInput();
    hideSuggestions();
    userInput.focus();
    userInput.selectionStart = userInput.selectionEnd = userInput.value.length;
  }

  // Show recent on focus (even before typing)
  userInput.addEventListener('focus', () => {
    if (!userInput.value.trim()) showOnFocus();
  });

  // Hook into the existing input event
  userInput.addEventListener('input', () => {
    showSuggestions(userInput.value);
  });

  // Keyboard navigation inside the suggestion list
  userInput.addEventListener('keydown', e => {
    if (sugBox.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, currentItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, -1));
    } else if (e.key === 'Tab') {
      if (activeIdx >= 0) { e.preventDefault(); applySuggestion(activeIdx); }
      else if (currentItems.length > 0) { e.preventDefault(); applySuggestion(0); }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    } else if (e.key === 'Enter') {
      // If nothing actively selected but suggestions exist, apply the top one
      if (activeIdx < 0 && currentItems.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        applySuggestion(0);
      } else if (activeIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        applySuggestion(activeIdx);
      }
    }
  }, true);

  // Hide when clicking outside
  document.addEventListener('mousedown', e => {
    if (!sugBox.contains(e.target) && e.target !== userInput) {
      hideSuggestions();
    }
  });

  // Hide when input loses focus (delayed so click on suggestion registers first)
  userInput.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 150);
  });

  // Save query to recent + hide after send
  const origHandleSend = window.handleSend;
  if (typeof origHandleSend === 'function') {
    window.handleSend = function(...args) {
      const text = userInput.value.trim();
      if (text) saveRecent(text);
      hideSuggestions();
      return origHandleSend.apply(this, args);
    };
  }
  // Also hook sendBtn click and Enter key for saving recent
  document.addEventListener('luna:sent', e => {
    if (e.detail && e.detail.text) saveRecent(e.detail.text);
  });
})();
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'r') { e.preventDefault(); regenerateResponse(); }
});

clearBtn.addEventListener('click', e => { if (!IS_MOBILE) addRipple(e, clearBtn); saveCurrentSession(); msgCount = 0; renderWelcome(); showToast('Conversation cleared ✦', '◈'); });
sendBtn.addEventListener('click', e => { if (!IS_MOBILE) addRipple(e, sendBtn); handleSend(); });

// ── Stats animation ───────────────────────────────────────────────
function animateStats() {
  const s1 = document.getElementById('stat1'), v1 = document.getElementById('statv1');
  const s2 = document.getElementById('stat2'), v2 = document.getElementById('statv2');
  const s3 = document.getElementById('stat3'), v3 = document.getElementById('statv3');
  if (!s1) return;
  const r1 = 52 + Math.floor(Math.random()*42);
  const r2 = 68 + Math.floor(Math.random()*28);
  const r3 = 78 + Math.floor(Math.random()*20);
  s1.style.width = r1+'%'; v1.textContent = r1+'%';
  s2.style.width = r2+'%'; v2.textContent = r2+'%';
  s3.style.width = r3+'%'; v3.textContent = r3+'%';
}

// ══════════════════════════════════════════════════════════════════
// ◈ SHOOTING STARS SYSTEM v2 — High-Performance
//
//   APIs used for smoothness:
//   • OffscreenCanvas transferControlToOffscreen() — moves ALL canvas
//     draw calls off the main thread into a Web Worker so UI, chat
//     input, and animations never compete with the render loop.
//   • Web Worker (inline Blob URL) — runs its own rAF loop completely
//     independent of the main thread; GC pauses don't drop frames.
//   • DPR-aware sizing via window.devicePixelRatio — crisp on HiDPI/
//     Retina displays with no blurry upscaling.
//   • Delta-time physics (dt in seconds) — star speed is frame-rate
//     independent; same motion at 30fps, 60fps, or 120fps.
//   • Pre-parsed RGBA component arrays — no string ops in hot path;
//     colors stored as [r,g,b] numbers, alpha computed numerically.
//   • Typed Float32Array for static star state — sequential memory
//     access patterns are cache-friendly vs object property lookups.
//   • Gradient pool / reuse — linear gradient created once per
//     shooting star, reused each frame until star dies.
//   • CSS will-change:transform on canvas — tells compositor to
//     promote canvas to its own GPU layer upfront.
//   • visibilitychange API — pauses the worker loop when the tab is
//     hidden to save CPU/battery.
//   • ResizeObserver API — more accurate resize detection than the
//     window resize event; debounced to avoid thrashing.
// ══════════════════════════════════════════════════════════════════

let particles    = []; // kept for API compat (unused after worker init)
let _starWorker  = null;
let _workerReady = false;
let _pendingDensity = 60;
let _starSpawnTimer = null; // unused but kept so external refs don't throw

function resizeCanvas() {
  // Handled by ResizeObserver in worker path; this is a no-op fallback
  if (_workerReady) return;
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

// ── Theme palette — pre-parsed RGB components (no strings in draw path) ──
function getStarPalette() {
  const theme = document.documentElement.getAttribute('data-theme') || 'neural';
  // Each color: [r, g, b]
  const P = {
    neural:   { trail: [168,85,247],  accent: [236,45,90],   tw: [[168,85,247],[236,45,90],[255,255,255]] },
    astral:   { trail: [99,102,241],  accent: [96,165,250],  tw: [[99,102,241],[96,165,250],[255,255,255]] },
    solar:    { trail: [245,158,11],  accent: [251,146,60],  tw: [[245,158,11],[251,146,60],[255,240,180]] },
    galactic: { trail: [244,114,182], accent: [34,211,238],  tw: [[244,114,182],[34,211,238],[255,255,255]] },
  };
  return P[theme] || P.neural;
}

// ── Inline Worker source ──────────────────────────────────────────
// The entire render loop runs in a Worker via OffscreenCanvas,
// completely off the main thread.
const WORKER_SRC = `
'use strict';

// State
let W = 0, H = 0, dpr = 1;
let ctx = null;
let stars = [];       // static twinkling stars (Float32Array fields)
let meteors = [];     // shooting stars
let palette = null;
let density = 60;
let isMobile = false;
let running  = false;

// Delta-time tracking
let lastTs = 0;

// ── Typed star pool ──────────────────────────────────────────────
// Fields per star: x, y, r, opacity, opSpeed, r_col, g_col, b_col
const STAR_STRIDE = 8;
let starData = new Float32Array(0);
let starCount = 0;

function initStars(count, w, h, pal) {
  starCount = count;
  starData  = new Float32Array(count * STAR_STRIDE);
  for (let i = 0; i < count; i++) {
    const base = i * STAR_STRIDE;
    const col  = pal.tw[Math.floor(Math.random() * pal.tw.length)];
    starData[base + 0] = Math.random() * w;         // x
    starData[base + 1] = Math.random() * h;         // y
    starData[base + 2] = Math.random() * 1.2 + 0.2; // r
    starData[base + 3] = Math.random();             // opacity
    starData[base + 4] = (Math.random() * 0.4 + 0.1) * (Math.random() > 0.5 ? 1 : -1); // opSpeed (per second)
    starData[base + 5] = col[0]; // r
    starData[base + 6] = col[1]; // g
    starData[base + 7] = col[2]; // b
  }
}

// ── Meteor factory ───────────────────────────────────────────────
function spawnMeteor(w, h, pal, mob) {
  const angleBase = Math.PI * (0.12 + Math.random() * 0.18);
  const speed     = mob ? (180 + Math.random() * 120) : (260 + Math.random() * 200); // px/sec
  const length    = mob ? (90  + Math.random() * 90)  : (140 + Math.random() * 180);
  const duration  = length / speed; // seconds until fully traversed

  let sx, sy;
  if (Math.random() > 0.35) {
    sx = Math.random() * w * 1.3 - w * 0.15;
    sy = -12;
  } else {
    sx = -12;
    sy = Math.random() * h * 0.65;
  }

  const [tr, tg, tb] = pal.trail;
  const [ar, ag, ab] = pal.accent;
  // Mix trail and accent randomly per meteor
  const useAccent = Math.random() > 0.5;
  const [cr, cg, cb] = useAccent ? [ar,ag,ab] : [tr,tg,tb];

  return {
    x: sx, y: sy,
    vx: Math.cos(angleBase) * speed,
    vy: Math.sin(angleBase) * speed,
    length, speed, duration,
    age: 0,
    w: mob ? (0.8 + Math.random() * 0.9) : (1.1 + Math.random() * 1.6),
    opacity: 0.75 + Math.random() * 0.25,
    cr, cg, cb,   // trail color components
    // Cached gradient — null until first draw, then reused
    cachedGrad: null,
    cachedAlpha: -1,
  };
}

// ── Spawn scheduler using rAF delta time ─────────────────────────
let nextSpawnIn = 0; // seconds until next meteor

function resetSpawnTimer() {
  const base = isMobile
    ? Math.max(1.8, 4.5 - density * 0.016)
    : Math.max(0.45, 3.2 - density * 0.013);
  nextSpawnIn = base * (0.6 + Math.random() * 0.8);
}

// ── Main render loop (runs inside Worker) ────────────────────────
function frame(ts) {
  if (!running || !ctx) { requestAnimationFrame(frame); return; }
  const dt = Math.min((ts - lastTs) / 1000, 0.05); // seconds, capped at 50ms
  lastTs = ts;

  ctx.clearRect(0, 0, W * dpr, H * dpr);

  // 1. Twinkling static stars (Float32Array — cache-friendly)
  for (let i = 0; i < starCount; i++) {
    const base = i * STAR_STRIDE;
    let op  = starData[base + 3];
    let ops = starData[base + 4];
    op += ops * dt;
    if (op >= 1)    { op = 1;    ops = -Math.abs(ops); }
    if (op <= 0.04) { op = 0.04; ops =  Math.abs(ops); }
    starData[base + 3] = op;
    starData[base + 4] = ops;

    const x  = starData[base + 0];
    const y  = starData[base + 1];
    const r  = starData[base + 2];
    const sr = starData[base + 5];
    const sg = starData[base + 6];
    const sb = starData[base + 7];

    // Core dot
    ctx.beginPath();
    ctx.arc(x * dpr, y * dpr, r * dpr, 0, 6.2832);
    ctx.fillStyle = 'rgba(' + sr + ',' + sg + ',' + sb + ',' + (op).toFixed(2) + ')';
    ctx.fill();

    // Soft bloom for larger stars (no extra arc for tiny ones — perf)
    if (r > 0.85) {
      ctx.beginPath();
      ctx.arc(x * dpr, y * dpr, r * 2.6 * dpr, 0, 6.2832);
      ctx.fillStyle = 'rgba(' + sr + ',' + sg + ',' + sb + ',' + (op * 0.07).toFixed(3) + ')';
      ctx.fill();
    }
  }

  // 2. Meteor spawn (delta-time based, no setInterval)
  nextSpawnIn -= dt;
  if (nextSpawnIn <= 0) {
    const cap = isMobile ? (density >= 100 ? 10 : 4) : (density >= 100 ? 22 : 10);
    if (meteors.length < cap) meteors.push(spawnMeteor(W, H, palette, isMobile));
    resetSpawnTimer();
    // HIGH density: spawn up to 3 extra comets per tick
    if (density >= 100) {
      if (Math.random() < 0.7 && meteors.length < cap) meteors.push(spawnMeteor(W, H, palette, isMobile));
      if (Math.random() < 0.4 && meteors.length < cap) meteors.push(spawnMeteor(W, H, palette, isMobile));
      if (Math.random() < 0.2 && meteors.length < cap) meteors.push(spawnMeteor(W, H, palette, isMobile));
    }
  }

  // 3. Draw meteors
  const alive = [];
  for (let i = 0; i < meteors.length; i++) {
    const m = meteors[i];
    m.age += dt;
    m.x   += m.vx * dt;
    m.y   += m.vy * dt;

    // Fade envelope: ease-in first 0.08s, ease-out last 30% of life
    const fadeIn  = Math.min(1, m.age / 0.08);
    const lifeRatio = m.age / m.duration;
    const fadeOut = lifeRatio > 0.7
      ? Math.max(0, 1 - (lifeRatio - 0.7) / 0.3)
      : 1;
    const alpha = m.opacity * fadeIn * fadeOut;

    if (alpha < 0.01 || m.age > m.duration * 1.3) continue;

    const offScreen = m.x > W + 80 || m.y > H + 80 || m.x < -m.length - 80;
    if (offScreen) continue;

    alive.push(m);

    const tailX = (m.x - m.vx / m.speed * m.length) * dpr;
    const tailY = (m.y - m.vy / m.speed * m.length) * dpr;
    const headX = m.x * dpr;
    const headY = m.y * dpr;

    // Re-use cached gradient if alpha hasn't changed significantly
    // (saves createLinearGradient call most frames)
    const alphaDelta = Math.abs(alpha - m.cachedAlpha);
    if (!m.cachedGrad || alphaDelta > 0.04) {
      const g = ctx.createLinearGradient(tailX, tailY, headX, headY);
      g.addColorStop(0,   'rgba(' + m.cr + ',' + m.cg + ',' + m.cb + ',0)');
      g.addColorStop(0.55,'rgba(' + m.cr + ',' + m.cg + ',' + m.cb + ',' + (alpha * 0.45).toFixed(2) + ')');
      g.addColorStop(1,   'rgba(' + m.cr + ',' + m.cg + ',' + m.cb + ',' + alpha.toFixed(2)           + ')');
      m.cachedGrad  = g;
      m.cachedAlpha = alpha;
    }

    // Tail stroke
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.strokeStyle = m.cachedGrad;
    ctx.lineWidth   = m.w * dpr * alpha;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Head glow (radial gradient)
    const hR  = m.w * 2.2 * alpha * dpr;
    const hRO = hR * 3.2;
    const hg  = ctx.createRadialGradient(headX, headY, 0, headX, headY, hRO);
    hg.addColorStop(0,   'rgba(255,255,255,'   + alpha.toFixed(2)           + ')');
    hg.addColorStop(0.28,'rgba(' + m.cr + ',' + m.cg + ',' + m.cb + ',' + (alpha * 0.75).toFixed(2) + ')');
    hg.addColorStop(1,   'rgba(' + m.cr + ',' + m.cg + ',' + m.cb + ',0)');
    ctx.beginPath();
    ctx.arc(headX, headY, hRO, 0, 6.2832);
    ctx.fillStyle = hg;
    ctx.fill();
  }
  meteors = alive;

  requestAnimationFrame(frame);
}

// ── Message handler ──────────────────────────────────────────────
self.onmessage = function(e) {
  const { type, data } = e.data;

  if (type === 'init') {
    const { canvas, width, height, devicePixelRatio, mobile, pal, count } = data;
    ctx      = canvas.getContext('2d');
    W        = width;
    H        = height;
    dpr      = devicePixelRatio;
    isMobile = mobile;
    palette  = pal;
    density  = count;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    initStars(count, W, H, pal);
    resetSpawnTimer();
    running = true;
    lastTs  = performance.now();
    requestAnimationFrame(frame);
  }

  if (type === 'resize') {
    W = data.width; H = data.height; dpr = data.devicePixelRatio;
    ctx.canvas.width  = W * dpr;
    ctx.canvas.height = H * dpr;
    // Rebuild stars for new dimensions
    initStars(starCount, W, H, palette);
    meteors = [];
    resetSpawnTimer();
  }

  if (type === 'density') {
    density = data.count;
    initStars(data.count, W, H, palette);
    meteors = [];
    resetSpawnTimer();
  }

  if (type === 'theme') {
    palette = data.pal;
    initStars(starCount, W, H, palette);
    meteors = [];
  }

  if (type === 'pause')  { running = false; }
  if (type === 'resume') { running = true; lastTs = performance.now(); }
};
`;

// ── Main-thread bootstrap ─────────────────────────────────────────
function _buildWorkerURL() {
  return URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
}

function _sendWorker(type, data = {}) {
  if (_starWorker) _starWorker.postMessage({ type, data });
}

function initParticles(count = 60) {
  _pendingDensity = IS_MOBILE ? Math.min(count, 20) : count;

  // ── Attempt OffscreenCanvas path (Chrome/Edge/Firefox) ──────────
  if (typeof OffscreenCanvas !== 'undefined' && canvas.transferControlToOffscreen) {
    if (_starWorker) {
      // Already running — just update density + theme
      _sendWorker('density', { count: _pendingDensity });
      return;
    }
    try {
      const offscreen = canvas.transferControlToOffscreen();
      const url = _buildWorkerURL();
      _starWorker = new Worker(url);
      URL.revokeObjectURL(url);

      const pal = getStarPalette();
      _starWorker.postMessage({
        type: 'init',
        data: {
          canvas:            offscreen,
          width:             window.innerWidth,
          height:            window.innerHeight,
          devicePixelRatio:  window.devicePixelRatio || 1,
          mobile:            IS_MOBILE,
          pal,
          count:             _pendingDensity,
        }
      }, [offscreen]); // transfer ownership to worker

      _workerReady = true;

      // visibilitychange — pause worker when tab hidden (saves CPU/battery)
      document.addEventListener('visibilitychange', () => {
        _sendWorker(document.hidden ? 'pause' : 'resume');
      });

      // ResizeObserver — more reliable than window resize
      const ro = new ResizeObserver(() => {
        _sendWorker('resize', {
          width:  window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
      });
      ro.observe(document.documentElement);

      return; // Worker handles everything from here
    } catch(err) {
      console.warn('[Stars] OffscreenCanvas worker failed, falling back to main-thread:', err);
      _starWorker  = null;
      _workerReady = false;
    }
  }

  // ── Fallback: main-thread canvas (Safari / older browsers) ──────
  _initParticlesFallback(_pendingDensity);
}

// ── Notify worker of theme change ─────────────────────────────────
// Hook into existing setTheme function (called after attribute set)
const _origSetTheme = window.setTheme;
// Patched after DOMContentLoaded since setTheme may not exist yet;
// also handled in setTheme() itself which calls initParticles() — the
// worker's 'density' handler will pick up the new palette automatically
// because initParticles re-reads getStarPalette() on each call.
// For the worker path we send an explicit 'theme' message:
function _patchSetThemeForWorker() {
  if (typeof setTheme !== 'function') return;
  if (setTheme._workerPatched) return;
  const _orig = setTheme;
  setTheme = function(theme) {
    _orig.apply(this, arguments);
    if (_workerReady) _sendWorker('theme', { pal: getStarPalette() });
  };
  setTheme._workerPatched = true;
}
document.addEventListener('DOMContentLoaded', _patchSetThemeForWorker);
setTimeout(_patchSetThemeForWorker, 500); // safety net

// ── Main-thread fallback render loop (Safari / no OffscreenCanvas) ─
let _particles_fb  = [];
let _meteors_fb    = [];
let _lastTs_fb     = 0;
let _nextSpawn_fb  = 1.5;
let _density_fb    = 60;

function _fbResetSpawn() {
  const base = IS_MOBILE ? Math.max(1.8, 4.5 - _density_fb * 0.016) : Math.max(0.45, 3.2 - _density_fb * 0.013);
  _nextSpawn_fb = base * (0.6 + Math.random() * 0.8);
}

function _initParticlesFallback(count) {
  _density_fb  = count;
  const pal    = getStarPalette();
  _particles_fb = [];
  for (let i = 0; i < count; i++) {
    const col = pal.tw[Math.floor(Math.random() * pal.tw.length)];
    _particles_fb.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.2 + 0.2,
      op: Math.random(),
      ops: (Math.random() * 0.4 + 0.1) * (Math.random() > 0.5 ? 1 : -1),
      cr: col[0], cg: col[1], cb: col[2],
    });
  }
  _meteors_fb = [];
  _fbResetSpawn();
}

function _fbSpawnMeteor() {
  const pal   = getStarPalette();
  const angle = Math.PI * (0.12 + Math.random() * 0.18);
  const speed = IS_MOBILE ? (180 + Math.random()*120) : (260 + Math.random()*200);
  const len   = IS_MOBILE ? (90  + Math.random()*90)  : (140 + Math.random()*180);
  const useA  = Math.random() > 0.5;
  const col   = useA ? pal.accent : pal.trail;
  let sx = Math.random() > 0.35 ? Math.random()*canvas.width*1.3 - canvas.width*0.15 : -12;
  let sy = sx === -12 ? Math.random()*canvas.height*0.65 : -12;
  return {
    x:sx, y:sy, vx:Math.cos(angle)*speed, vy:Math.sin(angle)*speed,
    len, speed, dur:len/speed, age:0,
    w: IS_MOBILE ? (0.8+Math.random()*0.9) : (1.1+Math.random()*1.6),
    op: 0.75+Math.random()*0.25,
    cr:col[0], cg:col[1], cb:col[2],
    cachedGrad:null, cachedAlpha:-1,
  };
}

function drawParticles(ts = 0) {
  requestAnimationFrame(drawParticles);
  if (_workerReady) return; // worker handles it

  const dt = Math.min((ts - _lastTs_fb) / 1000, 0.05);
  _lastTs_fb = ts;
  if (dt <= 0) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Static stars
  for (let i = 0; i < _particles_fb.length; i++) {
    const s = _particles_fb[i];
    s.op += s.ops * dt;
    if (s.op >= 1)    { s.op = 1;    s.ops = -Math.abs(s.ops); }
    if (s.op <= 0.04) { s.op = 0.04; s.ops =  Math.abs(s.ops); }
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, 6.2832);
    ctx.fillStyle = 'rgba('+s.cr+','+s.cg+','+s.cb+','+s.op.toFixed(2)+')';
    ctx.fill();
    if (s.r > 0.85) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r*2.6, 0, 6.2832);
      ctx.fillStyle = 'rgba('+s.cr+','+s.cg+','+s.cb+','+(s.op*0.07).toFixed(3)+')';
      ctx.fill();
    }
  }

  // Spawn
  _nextSpawn_fb -= dt;
  if (_nextSpawn_fb <= 0) {
    const cap = IS_MOBILE ? (_density_fb >= 100 ? 10 : 4) : (_density_fb >= 100 ? 22 : 10);
    if (_meteors_fb.length < cap) _meteors_fb.push(_fbSpawnMeteor());
    _fbResetSpawn();
    // HIGH density: spawn up to 3 extra comets per tick
    if (_density_fb >= 100) {
      if (Math.random() < 0.7 && _meteors_fb.length < cap) _meteors_fb.push(_fbSpawnMeteor());
      if (Math.random() < 0.4 && _meteors_fb.length < cap) _meteors_fb.push(_fbSpawnMeteor());
      if (Math.random() < 0.2 && _meteors_fb.length < cap) _meteors_fb.push(_fbSpawnMeteor());
    }
  }

  // Draw meteors
  const alive = [];
  for (let i = 0; i < _meteors_fb.length; i++) {
    const m = _meteors_fb[i];
    m.age += dt; m.x += m.vx*dt; m.y += m.vy*dt;
    const fadeIn   = Math.min(1, m.age / 0.08);
    const lr       = m.age / m.dur;
    const fadeOut  = lr > 0.7 ? Math.max(0, 1-(lr-0.7)/0.3) : 1;
    const alpha    = m.op * fadeIn * fadeOut;
    if (alpha < 0.01 || m.age > m.dur*1.3) continue;
    const off = m.x > canvas.width+80 || m.y > canvas.height+80 || m.x < -m.len-80;
    if (off) continue;
    alive.push(m);

    const tx = m.x - m.vx/m.speed*m.len;
    const ty = m.y - m.vy/m.speed*m.len;

    if (!m.cachedGrad || Math.abs(alpha-m.cachedAlpha) > 0.04) {
      const g = ctx.createLinearGradient(tx,ty,m.x,m.y);
      g.addColorStop(0,    'rgba('+m.cr+','+m.cg+','+m.cb+',0)');
      g.addColorStop(0.55, 'rgba('+m.cr+','+m.cg+','+m.cb+','+(alpha*0.45).toFixed(2)+')');
      g.addColorStop(1,    'rgba('+m.cr+','+m.cg+','+m.cb+','+alpha.toFixed(2)+')');
      m.cachedGrad=g; m.cachedAlpha=alpha;
    }
    ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(m.x,m.y);
    ctx.strokeStyle=m.cachedGrad; ctx.lineWidth=m.w*alpha; ctx.lineCap='round'; ctx.stroke();

    const hR = m.w*2.2*alpha, hRO=hR*3.2;
    const hg = ctx.createRadialGradient(m.x,m.y,0,m.x,m.y,hRO);
    hg.addColorStop(0,   'rgba(255,255,255,'+alpha.toFixed(2)+')');
    hg.addColorStop(0.28,'rgba('+m.cr+','+m.cg+','+m.cb+','+(alpha*0.75).toFixed(2)+')');
    hg.addColorStop(1,   'rgba('+m.cr+','+m.cg+','+m.cb+',0)');
    ctx.beginPath(); ctx.arc(m.x,m.y,hRO,0,6.2832); ctx.fillStyle=hg; ctx.fill();
  }
  _meteors_fb = alive;
}

// ── Init ──────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE A — CHAT HISTORY (Firebase per user, any device)
// ══════════════════════════════════════════════════════════════════

const HISTORY_MAX_SESSIONS = 20;

// Firebase path: luna-sessions/<userId>/
function sessionRef() {
  if (!firebaseReady || !firebaseDb || !currentUserId) return null;
  return firebaseDb.ref(`luna-sessions/${currentUserId}`);
}

// Save current conversation to Firebase
async function saveCurrentSession() {
  if (conversationHistory.length < 2) return;
  const ref = sessionRef();
  if (!ref) return; // Firebase not ready or not logged in — skip silently

  const preview = conversationHistory.find(m => m.role === 'user')?.content || '';
  const entry   = {
    id:      'sess_' + Date.now(),
    ts:      Date.now(),
    preview: preview.slice(0, 72).replace(/\n/g, ' '),
    msgs:    conversationHistory.slice(),
  };

  try {
    // Push new session
    await ref.push(entry);
    // Trim to max: fetch all, delete oldest if over limit
    const snap = await ref.orderByChild('ts').once('value');
    const all  = [];
    snap.forEach(child => all.push({ key: child.key, ts: child.val().ts }));
    all.sort((a, b) => a.ts - b.ts); // oldest first
    if (all.length > HISTORY_MAX_SESSIONS) {
      const toDelete = all.slice(0, all.length - HISTORY_MAX_SESSIONS);
      await Promise.all(toDelete.map(e => ref.child(e.key).remove()));
    }
  } catch (e) { console.warn('Could not save session to Firebase:', e); }
}

// Load all sessions for current user from Firebase
async function loadAllSessions() {
  const ref = sessionRef();
  if (!ref) return [];
  try {
    const snap = await ref.orderByChild('ts').once('value');
    const sessions = [];
    snap.forEach(child => sessions.push({ ...child.val(), _key: child.key }));
    return sessions.reverse(); // newest first
  } catch { return []; }
}

// Restore a session by its Firebase key
async function loadSession(sessionKey) {
  const ref = sessionRef();
  if (!ref) return;

  // Save current in-progress conversation first
  await saveCurrentSession();

  try {
    const snap    = await ref.child(sessionKey).once('value');
    const session = snap.val();
    if (!session || !session.msgs) { showToast('Session not found.', '⚠️'); return; }

    // Restore
    chatFeed.innerHTML = '';
    conversationHistory = session.msgs.slice();
    msgCount     = 0;
    lastUserText = '';
    lastLunaText = '';
    pinnedMessages = [];
    renderPinnedPanel();

    session.msgs.forEach(m => {
      const role = m.role === 'assistant' ? 'luna' : 'user';
      const wrap = buildMessageWrap(role, m.content, false);
      chatFeed.appendChild(wrap);
      msgCount++;
    });
    msgDisplay.textContent = msgCount;
    scrollDown(true);
    closeHistoryPanel();
    showToast('Session restored ✦', '◈', 2200);
  } catch (e) { showToast('Failed to load session.', '⚠️'); }
}

// Delete a single session from Firebase
async function deleteSession(sessionKey) {
  const ref = sessionRef();
  if (!ref) return;
  try {
    await ref.child(sessionKey).remove();
    showToast('Session deleted ◈', '⬡', 1800);
    openHistoryPanel(); // re-render list
  } catch { showToast('Failed to delete session.', '⚠️'); }
}

// Delete all sessions from Firebase
async function clearAllSessions() {
  const ref = sessionRef();
  if (!ref) return;
  if (!window.confirm('Delete ALL saved chat sessions? This cannot be undone.')) return;
  try {
    await ref.remove();
    renderSessionList([]);
    showToast('All sessions cleared ◈', '⬡', 2000);
  } catch { showToast('Failed to clear sessions.', '⚠️'); }
}

// Render the session list panel (accepts array or fetches from Firebase)
async function renderSessionList(preloaded = null) {
  const list = document.getElementById('sessionList');
  if (!list) return;

  // Show loading state
  list.innerHTML = '<div class="hist-empty">◈ Loading sessions…</div>';

  const sessions = preloaded !== null ? preloaded : await loadAllSessions();

  if (!sessions.length) {
    list.innerHTML = '<div class="hist-empty">◈ No saved sessions yet.<br/>Start chatting — sessions save automatically when you clear or switch.</div>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const key   = s._key || s.id;
    const date  = new Date(s.ts).toLocaleDateString([], { month:'short', day:'numeric' });
    const time  = new Date(s.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const count = s.msgs ? s.msgs.length : 0;
    return `
      <div class="hist-item" onclick="loadSession('${key}')">
        <div class="hist-meta">
          <span class="hist-date">${date} · ${time}</span>
          <span class="hist-count">${count} msgs</span>
        </div>
        <div class="hist-preview">${escHtml(s.preview || '(no preview)')}</div>
        <button class="hist-del" title="Delete session" onclick="event.stopPropagation();deleteSession('${key}')">✕</button>
      </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════
// ◈ MEMORY VIEWER — shows persistedHistory + userProfileCache
//   Two tabs: Conversations (chat pairs) · Facts About You (mentions)
//   Each entry has a delete button. Footer shows counts + clear tab.
// ══════════════════════════════════════════════════════════════════

let _memActiveTab = 'history'; // 'history' | 'facts'

function openMemoryPanel() {
  if (!userName) { showToast('Sign in to view your memory.', '◈', 1800); return; }
  const panel    = document.getElementById('memoryPanel');
  const backdrop = document.getElementById('memoryBackdrop');
  if (!panel) return;
  panel.classList.add('open');
  if (backdrop) backdrop.classList.add('active');
  _memActiveTab = 'history';
  switchMemTab('history');
}

function closeMemoryPanel() {
  const panel    = document.getElementById('memoryPanel');
  const backdrop = document.getElementById('memoryBackdrop');
  if (panel)    panel.classList.remove('open');
  if (backdrop) backdrop.classList.remove('active');
}

function switchMemTab(tab) {
  _memActiveTab = tab;
  document.getElementById('memTabHistory').classList.toggle('active', tab === 'history');
  document.getElementById('memTabFacts').classList.toggle('active',   tab === 'facts');
  renderMemoryPanel();
}

function renderMemoryPanel() {
  const body    = document.getElementById('memBody');
  const stat    = document.getElementById('memStat');
  const badgeH  = document.getElementById('memBadgeHistory');
  const badgeF  = document.getElementById('memBadgeFacts');
  if (!body) return;

  // Update tab badges
  const histCount  = persistedHistory.length;
  const pairCount  = Math.floor(histCount / 2);
  const factsCount = userProfileCache && userProfileCache.mentions
    ? Object.keys(userProfileCache.mentions).length : 0;
  if (badgeH) badgeH.textContent = pairCount;
  if (badgeF) badgeF.textContent = factsCount;

  body.innerHTML = '';

  if (_memActiveTab === 'history') {
    _renderMemHistory(body, stat, pairCount);
  } else {
    _renderMemFacts(body, stat, factsCount);
  }
}

function _renderMemHistory(body, stat, pairCount) {
  if (!persistedHistory.length) {
    body.innerHTML = `
      <div class="mem-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9"/><path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4"/></svg>
        No conversation memory yet.<br/>
        <span style="font-size:10.5px;opacity:0.6;">Chat with Luna to build up memory.</span>
      </div>`;
    if (stat) stat.textContent = '◈ No conversations stored';
    return;
  }

  // Group into user+luna pairs for cleaner display
  const label = document.createElement('div');
  label.className = 'mem-section-label';
  label.textContent = `RECENT CONVERSATIONS (${persistedHistory.length} messages)`;
  body.appendChild(label);

  // Show pairs newest-first
  const msgs = [...persistedHistory].reverse();
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    const isUser = m.role === 'user';
    // Try to pair user+luna or luna+user
    const next = msgs[i + 1];
    const isPair = next && ((isUser && next.role === 'assistant') || (!isUser && next.role === 'user'));

    const item = document.createElement('div');
    item.className = 'mem-item';
    item.dataset.ts   = m.ts || '';
    item.dataset.role = m.role;

    const roleLabel = isUser ? 'YOU' : 'LUNA';
    const roleCls   = isUser ? 'user' : 'luna';
    const timeStr   = m.ts ? new Date(m.ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    const preview   = (m.content || '').replace().slice(0, 200);

    item.innerHTML = `
      <div class="mem-item-role ${roleCls}">${roleLabel}</div>
      <div class="mem-item-text">${escHtml(preview)}</div>
      ${timeStr ? `<div class="mem-item-meta">${timeStr}</div>` : ''}
      <button class="mem-del-btn" title="Delete this message from memory" onclick="deleteMemoryEntry(this, ${m.ts || 0}, '${m.role}')">✕</button>
    `;
    body.appendChild(item);
    i += 1;
  }

  if (stat) stat.textContent = `◈ ${pairCount} exchanges · ${persistedHistory.length} messages`;
}

function _renderMemFacts(body, stat, factsCount) {
  if (!userProfileCache || !userProfileCache.mentions || !factsCount) {
    body.innerHTML = `
      <div class="mem-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        No facts recorded yet.<br/>
        <span style="font-size:10.5px;opacity:0.6;">Facts are added when other users mention you in their chats.</span>
      </div>`;
    if (stat) stat.textContent = '◈ No facts stored';
    return;
  }

  const label = document.createElement('div');
  label.className = 'mem-section-label';
  label.textContent = `WHAT OTHERS TOLD LUNA ABOUT YOU (${factsCount} facts)`;
  body.appendChild(label);

  const mentions = Object.entries(userProfileCache.mentions)
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)); // newest first

  mentions.forEach(([fbKey, m]) => {
    const item = document.createElement('div');
    item.className = 'mem-item';
    item.dataset.fbKey = fbKey;

    const timeStr = m.ts ? new Date(m.ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    const preview = (m.context || '').replace().slice(0, 200);
    const by      = m.mentionedBy || 'someone';

    item.innerHTML = `
      <div class="mem-item-role fact">FACT · via ${escHtml(by)}</div>
      <div class="mem-item-text">${escHtml(preview)}</div>
      ${timeStr ? `<div class="mem-item-meta">${timeStr}</div>` : ''}
      <button class="mem-del-btn" title="Delete this fact from memory" onclick="deleteMemoryFact(this, '${escHtml(fbKey)}')">✕</button>
    `;
    body.appendChild(item);
  });

  if (stat) stat.textContent = `◈ ${factsCount} facts remembered`;
}

// ── Delete a single conversation message ─────────────────────────
async function deleteMemoryEntry(btn, ts, role) {
  const item = btn.closest('.mem-item');
  if (!item) return;

  // Animate out
  item.classList.add('deleting');

  // Remove from persistedHistory (match by ts + role)
  const before = persistedHistory.length;
  if (ts) {
    persistedHistory = persistedHistory.filter(m => !(m.ts === ts && m.role === role));
  }

  // Remove from conversationHistory in-memory context too
  if (ts) {
    conversationHistory = conversationHistory.filter(m => !(m.ts === ts && m.role === role));
  }

  // Remove from Firebase — find entry by ts+role and delete it
  if (firebaseReady && firebaseDb && currentUserId) {
    try {
      const ref  = firebaseDb.ref(`luna-user-chatlogs/${currentUserId}`);
      const snap = await ref.orderByChild('ts').equalTo(ts).once('value');
      snap.forEach(child => {
        if (child.val().role === role) child.ref.remove();
      });
    } catch(e) { console.warn('Memory delete failed:', e); }
  }

  setTimeout(() => {
    item.remove();
    renderMemoryPanel(); // re-render counts/badges
    if (before !== persistedHistory.length) showToast('Memory entry removed ✦', '◈', 1600);
  }, 240);
}

// ── Delete a single fact (cross-user mention) ─────────────────────
async function deleteMemoryFact(btn, fbKey) {
  const item = btn.closest('.mem-item');
  if (!item) return;

  item.classList.add('deleting');

  // Remove from local cache
  if (userProfileCache && userProfileCache.mentions && userProfileCache.mentions[fbKey]) {
    delete userProfileCache.mentions[fbKey];
  }

  // Remove from Firebase
  if (firebaseReady && firebaseDb && currentUserId) {
    try {
      await firebaseDb.ref(`luna-user-profiles/${currentUserId}/mentions/${fbKey}`).remove();
    } catch(e) { console.warn('Fact delete failed:', e); }
  }

  setTimeout(() => {
    item.remove();
    renderMemoryPanel();
    showToast('Fact removed from memory ✦', '◈', 1600);
  }, 240);
}

// ── Clear all entries in the currently active tab ─────────────────
async function clearCurrentMemTab() {
  if (_memActiveTab === 'history') {
    if (!persistedHistory.length) { showToast('Nothing to clear.', '◈', 1400); return; }
    const confirmed = confirm(`Clear all ${persistedHistory.length} conversation messages from Luna's memory? This cannot be undone.`);
    if (!confirmed) return;

    persistedHistory    = [];
    conversationHistory = [];

    // Wipe Firebase chatlog for this user
    if (firebaseReady && firebaseDb && currentUserId) {
      try { await firebaseDb.ref(`luna-user-chatlogs/${currentUserId}`).remove(); } catch {}
    }
    renderMemoryPanel();
    showToast('Conversation memory cleared ✦', '◈', 2000);

  } else {
    const factsCount = userProfileCache && userProfileCache.mentions
      ? Object.keys(userProfileCache.mentions).length : 0;
    if (!factsCount) { showToast('No facts to clear.', '◈', 1400); return; }
    const confirmed = confirm(`Remove all ${factsCount} facts others told Luna about you?`);
    if (!confirmed) return;

    if (userProfileCache) userProfileCache.mentions = {};

    if (firebaseReady && firebaseDb && currentUserId) {
      try { await firebaseDb.ref(`luna-user-profiles/${currentUserId}/mentions`).remove(); } catch {}
    }
    renderMemoryPanel();
    showToast('All facts cleared ✦', '◈', 2000);
  }
}

async function openHistoryPanel() {
  const panel    = document.getElementById('historyPanel');
  const backdrop = document.getElementById('historyBackdrop');
  if (!panel) return;
  panel.classList.add('open');
  if (backdrop) backdrop.classList.add('active');
  await renderSessionList();
}

function closeHistoryPanel() {
  const panel    = document.getElementById('historyPanel');
  const backdrop = document.getElementById('historyBackdrop');
  if (panel)    panel.classList.remove('open');
  if (backdrop) backdrop.classList.remove('active');
}

// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE B — SWIPE-TO-REPLY (mobile, right-swipe on any bubble)
// ══════════════════════════════════════════════════════════════════

function initSwipeToReply() {
  if (!IS_MOBILE) return; // desktop uses the reply button

  let touchStartX = 0;
  let touchStartY = 0;
  let activeSwipeBubble = null;
  let swipeTriggered = false;
  const SWIPE_THRESHOLD = 55;  // px to travel before triggering
  const SWIPE_MAX_Y    = 30;   // ignore if vertical scroll dominates

  chatFeed.addEventListener('touchstart', e => {
    const bubble = e.target.closest('.bubble');
    if (!bubble) return;
    touchStartX     = e.touches[0].clientX;
    touchStartY     = e.touches[0].clientY;
    activeSwipeBubble = bubble;
    swipeTriggered  = false;
  }, { passive: true });

  chatFeed.addEventListener('touchmove', e => {
    if (!activeSwipeBubble) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dy > SWIPE_MAX_Y) { activeSwipeBubble = null; return; } // scrolling, abort
    if (dx > 8 && dx < SWIPE_THRESHOLD) {
      // Translate bubble to give rubber-band feel
      activeSwipeBubble.style.transition = 'none';
      activeSwipeBubble.style.transform  = `translateX(${Math.min(dx * 0.55, 32)}px)`;
      // Show reply icon hint
      let hint = activeSwipeBubble.querySelector('.swipe-reply-hint');
      if (!hint) {
        hint = document.createElement('span');
        hint.className = 'swipe-reply-hint';
        hint.textContent = '↩';
        activeSwipeBubble.appendChild(hint);
      }
      hint.style.opacity = Math.min(dx / SWIPE_THRESHOLD, 1).toFixed(2);
    }
    if (dx >= SWIPE_THRESHOLD && !swipeTriggered) {
      swipeTriggered = true;
      const msgWrap = activeSwipeBubble.closest('.message');
      const msgId   = msgWrap?.dataset.msgId;
      const textEl  = activeSwipeBubble.querySelector('.bubble-text');
      if (msgId && textEl) {
        setReplyContext(msgId, textEl.innerText || textEl.textContent);
        if (navigator.vibrate) navigator.vibrate(18); // subtle haptic
      }
    }
  }, { passive: true });

  chatFeed.addEventListener('touchend', () => {
    if (!activeSwipeBubble) return;
    // Snap back
    activeSwipeBubble.style.transition = 'transform 0.25s var(--smooth)';
    activeSwipeBubble.style.transform  = '';
    const hint = activeSwipeBubble.querySelector('.swipe-reply-hint');
    if (hint) { hint.style.opacity = '0'; setTimeout(() => hint.remove(), 200); }
    activeSwipeBubble = null;
    swipeTriggered    = false;
  }, { passive: true });
}

// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE C — LUNA TYPING shown in Admin Live Chat Monitor
// ══════════════════════════════════════════════════════════════════

function reportLunaTypingToAdmin(isTypingNow) {
  if (!firebaseReady || !firebaseDb) return;
  if (isTypingNow) {
    firebaseDb.ref('luna-luna-typing').set({ active: true, ts: Date.now() }).catch(() => {});
  } else {
    firebaseDb.ref('luna-luna-typing').remove().catch(() => {});
  }
}

function subscribeLunaTypingForAdmin() {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref('luna-luna-typing').on('value', snap => {
    const data  = snap.val();
    const strip = document.getElementById('adminTypingStrip');
    const label = document.getElementById('adminTypingText');
    if (!strip || !label) return;

    // Re-read user typing as well so we can merge both
    firebaseDb.ref('luna-typing').once('value', userSnap => {
      const userData = userSnap.val() || {};
      const now = Date.now();
      const activeUsers = Object.values(userData).filter(d => d.ts && (now - d.ts) < 6000);
      const lunaActive  = data && data.active && data.ts && (now - data.ts) < 8000;

      const parts = [];
      if (activeUsers.length) {
        parts.push(activeUsers.map(d => d.name).join(', ') + (activeUsers.length > 1 ? ' are' : ' is') + ' typing');
      }
      if (lunaActive) parts.push('◈ LUNA is responding');

      if (!parts.length) {
        strip.className = 'admin-typing-strip idle';
        label.textContent = '◈ No one is typing right now…';
      } else {
        strip.className = 'admin-typing-strip' + (lunaActive ? ' luna-typing' : '');
        label.textContent = parts.join('  ·  ') + '…';
      }
    });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  loadSettings();
  resizeCanvas();
  // Always run shooting stars — mobile gets reduced count + lower fps (handled inside initParticles/PARTICLE_INTERVAL)
  initParticles();
  drawParticles();
  initSidebar();
  initFab();
  initKeyboardShortcuts();
  injectFileUpload();
  injectReplyBar();
  initSwipeToReply();
  // emoji picker removed
  initClock();
  initSignalBars();
  // If a returning user is found, hide the sign-in overlay and start the
  // welcome splash immediately — Firebase verification runs in parallel
  // and resolves its result via a Promise before the splash finishes.
  const earlySession = loadPersistedSession();
  let verifyResolve  = null;
  const verifyPromise = new Promise(res => { verifyResolve = res; });

  if (earlySession) {
    const overlay = document.getElementById('nameEntryOverlay');
    if (overlay) overlay.style.display = 'none';

    showWelcomeSplash(earlySession.name, async () => {
      const isValid = await verifyPromise; // almost always already resolved
      if (isValid) {
        initNameEntry();
        await enterChat(earlySession.name, earlySession.key, !firebaseReady);
      } else {
        // Rare: account deleted or banned while splash played
        clearPersistedSession();
        const overlay = document.getElementById('nameEntryOverlay');
        if (overlay) overlay.style.display = '';
        initNameEntry();
      }
    });
  }

  // 🔥 Load Firebase, then verify the session in background
  await loadFirebase();
  loadAdminStatuses();
  watchFirebaseConnection();
  startFirebaseReconnectWatcher();

  // ── Full session verification (Firebase + ban check) ──
  let persistedSession = earlySession;
  if (!persistedSession) persistedSession = await loadPersistedSessionAsync();

  if (persistedSession) {
    let sessionValid = false;
    if (firebaseReady && firebaseDb) {
      try {
        const snap = await firebaseDb.ref(`luna-accounts/${persistedSession.key}`).once('value');
        if (snap.exists()) {
          const banStatus = await checkUserBanStatus(persistedSession.name);
          if (!banStatus ||
              (banStatus.type === 'suspend' && banStatus.until <= Date.now())) {
            sessionValid = true;
          }
        } else if (lsGetAccount(persistedSession.key)) {
          // Account in localStorage but not Firebase — valid locally
          sessionValid = true;
        }
      } catch {
        // Firebase error — fall back to localStorage
        if (lsGetAccount(persistedSession.key)) sessionValid = true;
      }
    } else {
      // Firebase offline — trust localStorage or the persisted session itself
      sessionValid = !!lsGetAccount(persistedSession.key) || true;
    }

    if (earlySession) {
      // Splash is already running — hand off the result and let its onComplete handle it
      verifyResolve(sessionValid);
      return;
    }

    // No early session (IndexedDB-only path) — show splash now
    if (sessionValid) {
      const overlay = document.getElementById('nameEntryOverlay');
      if (overlay) overlay.style.display = 'none';
      showWelcomeSplash(persistedSession.name, async () => {
        initNameEntry();
        await enterChat(persistedSession.name, persistedSession.key, !firebaseReady);
      });
      return;
    } else {
      clearPersistedSession();
    }
  } else if (earlySession) {
    // earlySession was set but loadPersistedSessionAsync returned nothing (edge case)
    verifyResolve(false);
    return;
  }

  // No valid session — nothing to resolve, just show sign-in
  verifyResolve?.(false);
  initNameEntry();

  // Cross-tab sync fallback (same device, different tabs)
  window.addEventListener('storage', e => {
    if (e.key === 'luna-admin-statuses') {
      try {
        const data = JSON.parse(e.newValue);
        if (data && typeof data === 'object') {
          adminStatuses = data;
          if (appState === 'admin') renderAdminStatusList();
        }
      } catch {}
    }
  });

  // Mouse repulsion only needed on non-touch devices
  if (!IS_MOBILE) {
    document.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
    document.addEventListener('mouseleave', () => { mouse.x = -9999; mouse.y = -9999; });
  }

  if (!IS_MOBILE) setInterval(animateStats, 4500);

  const adminPanel = document.getElementById('adminPanel');
  const appShell   = document.querySelector('.app-shell');
  if (adminPanel && appShell) appShell.appendChild(adminPanel);

  // ── MOBILE UX ENHANCEMENTS ────────────────────────────────────────
  if (IS_MOBILE) {
    initMobileEmojiSheet();
    initMobileInputFocus();
    initMobileDoubleTapCopy();
  }
});

// Debounced resize — prevents canvas thrashing on mobile when virtual keyboard opens/closes.
// Note: setRealVH / --real-vh updates are handled by the Visual Viewport Manager
// at the top of this file so we don't duplicate that work here.
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    resizeCanvas();
    initParticles(); // rebuild star field for new canvas size
  }, IS_MOBILE ? 400 : 100);
});

// ══════════════════════════════════════════════════════════════════
// ◈ MOBILE — Real viewport height (survives virtual keyboard)
//   Delegates to the Visual Viewport Manager installed at the top of
//   this file. The overlay keyboard-open class is still applied here
//   so existing CSS transitions on nameEntryOverlay keep working.
// ══════════════════════════════════════════════════════════════════
function setRealVH() {
  // Delegate primary measurement to the viewport manager
  if (window._vvUpdate) window._vvUpdate();

  // ── Keyboard open/close detection for auth overlay (legacy path) ──
  if (IS_MOBILE && window.visualViewport) {
    const overlay = document.getElementById('nameEntryOverlay');
    if (overlay && overlay.style.display !== 'none') {
      const viewportRatio = window.visualViewport.height / window.screen.height;
      if (viewportRatio < 0.75) {
        overlay.classList.add('keyboard-open');
      } else {
        overlay.classList.remove('keyboard-open');
      }
    }
  }
}
// Initial call — viewport manager already ran at the top, but
// setRealVH() also wires the overlay class which needs DOM.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setRealVH, { once: true });
} else {
  setRealVH();
}
// Note: visualViewport listeners are already installed by the viewport
// manager at the top of the file — no need to re-add them here.

// ══════════════════════════════════════════════════════════════════
// ◈ MOBILE — Sidebar drawer toggle
// ══════════════════════════════════════════════════════════════════
function toggleMobileMenu() {
  const sidebar   = document.getElementById('sidebar');
  const backdrop  = document.getElementById('mobileBackdrop');
  const closeBtn  = document.getElementById('sidebarCloseBtn');
  const isMobile  = window.innerWidth <= 680;
  if (!isMobile) return;
  const isOpen = sidebar.classList.contains('mobile-open');
  if (isOpen) closeMobileMenu();
  else {
    sidebar.classList.add('mobile-open');
    backdrop.classList.add('active');
    if (closeBtn) closeBtn.style.display = 'flex';
    document.body.style.overflow = 'hidden'; // prevent bg scroll
  }
}
function closeMobileMenu() {
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('mobileBackdrop');
  const closeBtn = document.getElementById('sidebarCloseBtn');
  sidebar.classList.remove('mobile-open');
  backdrop.classList.remove('active');
  if (closeBtn) closeBtn.style.display = 'none';
  document.body.style.overflow = '';
}
// Also close drawer when any nav item is tapped
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => { if (window.innerWidth <= 680) closeMobileMenu(); });
});

// Show/hide close button based on screen size
function handleSidebarResize() {
  const closeBtn = document.getElementById('sidebarCloseBtn');
  if (!closeBtn) return;
  if (window.innerWidth <= 680) {
    // Keep whatever state it's in
  } else {
    closeMobileMenu(); // ensure clean state on resize to desktop
    closeBtn.style.display = 'none';
  }
}
window.addEventListener('resize', handleSidebarResize);

// ── Set offline on page close (belt + suspenders alongside onDisconnect) ──
window.addEventListener('beforeunload', () => {
  if (currentUserId && firebaseReady && firebaseDb) {
    // Use sendBeacon-style synchronous write via Firebase REST as a best-effort
    // The onDisconnect set in setPresence() is the primary mechanism
    firebaseDb.ref(`luna-presence/${currentUserId}`)
      .update({ online: false, lastSeen: Date.now() });
  }
});
// ══════════════════════════════════════════════════════════════════
// ◈ LUNA CAPACITY METER
// ══════════════════════════════════════════════════════════════════
function initTokenTracker() {
  const stored = localStorage.getItem(TOKEN_STORAGE_KEY());
  tokensUsedToday = stored ? parseInt(stored, 10) || 0 : 0;
  renderCapacityMeter();
  if (tokensUsedToday >= TOKEN_DAILY_LIMIT) showCapacityExhausted();
  pushRateLimitStatusToFirebase();
}

// ══════════════════════════════════════════════════════════════════
// ◈ RATE LIMIT FIREBASE SYNC — user side pushes, admin side reads
// ══════════════════════════════════════════════════════════════════

// Push current token usage to Firebase so the admin panel can see it
function pushRateLimitStatusToFirebase() {
  if (!firebaseReady || !firebaseDb) return;
  const pct       = tokensUsedToday / TOKEN_DAILY_LIMIT;
  const status    = pct >= 1 ? 'exhausted' : pct >= TOKEN_CRIT_PCT ? 'critical' : pct >= TOKEN_WARN_PCT ? 'warning' : 'ok';
  const next      = getNextMidnight();
  const payload   = {
    tokensUsed:   tokensUsedToday,
    tokenLimit:   TOKEN_DAILY_LIMIT,
    pct:          Math.round(pct * 100),
    status,
    reporter:     userName || 'anonymous',
    reporterKey:  currentUserId || 'guest',
    resetLabel:   next.label,
    ts:           Date.now(),
  };
  firebaseDb.ref('luna-rate-limit').set(payload).catch(() => {});
}

// Admin side: subscribe to real-time rate limit updates and render them
let _adminRlUnsub = null;
function subscribeAdminRateLimit() {
  if (!firebaseReady || !firebaseDb) {
    renderAdminRateLimitStatus(null); return;
  }
  if (_adminRlUnsub) _adminRlUnsub();
  const ref = firebaseDb.ref('luna-rate-limit');
  ref.on('value', snap => renderAdminRateLimitStatus(snap.val()));
  _adminRlUnsub = () => ref.off('value');
}

function unsubscribeAdminRateLimit() {
  if (_adminRlUnsub) { _adminRlUnsub(); _adminRlUnsub = null; }
}

// Render the rate limit status into the admin panel
function renderAdminRateLimitStatus(data) {
  const dot       = document.getElementById('adminRlStatusDot');
  const label     = document.getElementById('adminRlStatusLabel');
  const badge     = document.getElementById('adminRlStatusBadge');
  const bar       = document.getElementById('adminRlBar');
  const used      = document.getElementById('adminRlUsed');
  const pctEl     = document.getElementById('adminRlPct');
  const remain    = document.getElementById('adminRlRemain');
  const limitEl   = document.getElementById('adminRlLimit');
  const resetEl   = document.getElementById('adminRlResetTime');
  const updateEl  = document.getElementById('adminRlLastUpdate');
  const banner    = document.getElementById('adminRateLimitBanner');
  if (!dot) return; // panel not in DOM yet

  if (!data) {
    if (dot)    { dot.style.background = 'var(--text-lo)'; dot.style.boxShadow = 'none'; }
    if (label)  { label.textContent = 'NO DATA — Waiting for an active user session\u2026'; label.style.color = 'var(--text-lo)'; }
    if (badge)  { badge.textContent = '\u2014'; badge.style.background = 'rgba(255,255,255,0.05)'; badge.style.borderColor = 'rgba(255,255,255,0.1)'; badge.style.color = 'var(--text-lo)'; }
    if (bar)    bar.style.width = '0%';
    if (banner) banner.innerHTML = '';
    return;
  }

  const pct      = Math.min(100, data.pct || 0);
  const status   = data.status || 'ok';
  const isDead   = status === 'exhausted';
  const isCrit   = status === 'critical';

  const colors = {
    ok:        { dot: '#34d399', glow: '#34d399', label: 'var(--green)',           badgeBg: 'rgba(52,211,153,0.12)',  badgeBr: 'rgba(52,211,153,0.35)',  badgeTx: 'var(--green)',          bar: 'linear-gradient(90deg,#059669,#34d399)', barGlow: 'rgba(52,211,153,0.4)',  badgeLabel: 'OK',        statusText: 'NOMINAL \u2014 CAPACITY AVAILABLE' },
    warning:   { dot: '#f59e0b', glow: '#f59e0b', label: 'var(--gold)',            badgeBg: 'rgba(245,158,11,0.12)', badgeBr: 'rgba(245,158,11,0.4)',   badgeTx: 'var(--gold)',           bar: 'linear-gradient(90deg,#b45309,#f59e0b)', barGlow: 'rgba(245,158,11,0.5)',  badgeLabel: 'WARNING',   statusText: 'APPROACHING LIMIT \u2014 OVER 80% USED' },
    critical:  { dot: '#ec2d5a', glow: '#ec2d5a', label: 'var(--crimson-bright)',  badgeBg: 'rgba(236,45,90,0.14)',  badgeBr: 'rgba(236,45,90,0.45)',   badgeTx: 'var(--crimson-bright)', bar: 'linear-gradient(90deg,var(--crimson),var(--crimson-bright))', barGlow: 'rgba(236,45,90,0.5)', badgeLabel: 'CRITICAL', statusText: 'CRITICAL \u2014 OVER 93% EXHAUSTED' },
    exhausted: { dot: '#ec2d5a', glow: '#ec2d5a', label: 'var(--crimson-bright)',  badgeBg: 'rgba(236,45,90,0.20)',  badgeBr: 'rgba(236,45,90,0.6)',    badgeTx: 'var(--crimson-bright)', bar: 'linear-gradient(90deg,#7f0f22,var(--crimson-bright))', barGlow: 'rgba(236,45,90,0.7)', badgeLabel: '\uD83D\uDD34 FULL',  statusText: 'RATE LIMIT FULL \u2014 USERS BLOCKED' },
  };
  const c = colors[status] || colors.ok;

  if (dot)   { dot.style.background = c.dot; dot.style.boxShadow = '0 0 8px ' + c.glow; }
  if (label) { label.textContent = c.statusText; label.style.color = c.label; }
  if (badge) { badge.textContent = c.badgeLabel; badge.style.background = c.badgeBg; badge.style.borderColor = c.badgeBr; badge.style.color = c.badgeTx; }
  if (bar)   { bar.style.width = pct + '%'; bar.style.background = c.bar; bar.style.boxShadow = '0 0 6px ' + c.barGlow; }

  const tokUsed = (data.tokensUsed || 0).toLocaleString();
  const tokLeft = Math.max(0, (data.tokenLimit || TOKEN_DAILY_LIMIT) - (data.tokensUsed || 0)).toLocaleString();
  const tokLim  = (data.tokenLimit || TOKEN_DAILY_LIMIT).toLocaleString();

  if (used)    used.textContent    = tokUsed + ' tokens used';
  if (pctEl)   pctEl.textContent   = pct + '% used';
  if (remain)  remain.textContent  = tokLeft + ' remaining';
  if (limitEl) limitEl.textContent = tokLim;
  if (resetEl) resetEl.textContent = data.resetLabel || '\u2014';

  const ago = data.ts ? timeAgo(data.ts) : '\u2014';
  const who = data.reporter || '\u2014';
  if (updateEl) updateEl.textContent = '\u25C8 Last reported by "' + who + '" \u00B7 ' + ago;

  if (banner) {
    if (isDead || isCrit) {
      const alertColor = isDead ? '#ec2d5a' : '#f59e0b';
      const alertBg    = isDead ? 'rgba(236,45,90,0.08)' : 'rgba(245,158,11,0.07)';
      const alertMsg   = isDead
        ? '\u26D4 RATE LIMIT FULLY EXHAUSTED \u2014 Users cannot send messages until midnight reset.'
        : '\u26A0\uFE0F CRITICAL CAPACITY \u2014 Only ' + tokLeft + ' tokens remain. Users may be blocked soon.';
      const alertIcon  = isDead ? '\uD83D\uDD34' : '\u26A0\uFE0F';
      const alertTitle = isDead ? '\u25C8 RATE LIMIT EXHAUSTED' : '\u25C8 CAPACITY CRITICAL';
      banner.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:' + alertBg + ';border:1px solid ' + alertColor + '44;border-radius:var(--r-sm);margin-bottom:4px;">' +
        '<span style="font-size:18px;flex-shrink:0;">' + alertIcon + '</span>' +
        '<div style="flex:1;">' +
        '<div style="font-family:var(--font-hud);font-size:8px;letter-spacing:0.18em;color:' + alertColor + ';">' + alertTitle + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-mid);margin-top:3px;line-height:1.4;">' + alertMsg + '</div>' +
        '</div></div>';
    } else {
      banner.innerHTML = '';
    }
  }
}

function recordTokenUsage(usage) {
  if (!usage) return;
  const added = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
  tokensUsedToday = Math.min(TOKEN_DAILY_LIMIT, tokensUsedToday + added);
  localStorage.setItem(TOKEN_STORAGE_KEY(), String(tokensUsedToday));
  renderCapacityMeter();
  checkCapacityThresholds();
  pushRateLimitStatusToFirebase();
  // Per-user bucket — track separately so one user doesn't eat everyone's quota
  if (currentUserId) recordUserTokenUsage(added, currentUserId);
}

function renderCapacityMeter() {
  const pct = Math.min(100, Math.round((tokensUsedToday / TOKEN_DAILY_LIMIT) * 100));
  const fillEl  = document.getElementById('capacityFill');
  const pctEl   = document.getElementById('capacityPct');
  const tokEl   = document.getElementById('capacityTokens');
  const resetEl = document.getElementById('capacityReset');
  const resetTEl= document.getElementById('capacityResetTime');
  if (pctEl)  pctEl.textContent = `${100 - pct}%`;
  if (tokEl)  tokEl.textContent = `${tokensUsedToday.toLocaleString()} / ${TOKEN_DAILY_LIMIT.toLocaleString()} tokens`;
  if (fillEl) {
    fillEl.style.width = pct + '%';
    // Color: green → gold → red based on usage
    if (pct >= TOKEN_CRIT_PCT * 100) {
      fillEl.style.background = 'linear-gradient(90deg,var(--crimson),var(--crimson-bright))';
      fillEl.style.boxShadow  = '0 0 6px var(--crimson-glow)';
    } else if (pct >= TOKEN_WARN_PCT * 100) {
      fillEl.style.background = 'linear-gradient(90deg,#b45309,var(--gold))';
      fillEl.style.boxShadow  = '0 0 6px rgba(245,158,11,0.5)';
    } else {
      fillEl.style.background = 'linear-gradient(90deg,#059669,#34d399)';
      fillEl.style.boxShadow  = '0 0 6px rgba(52,211,153,0.4)';
    }
  }
  if (resetEl && resetTEl) {
    if (pct >= TOKEN_WARN_PCT * 100) { resetTEl.textContent = getNextMidnight().label; resetEl.style.display = 'block'; }
    else resetEl.style.display = 'none';
  }
  // Sync mobile strip
  const mcsF = document.getElementById('mcsCapacityFill');
  const mcsP = document.getElementById('mcsCapacityPct');
  if (mcsF) {
    mcsF.style.width = pct + '%';
    mcsF.className   = 'mcs-fill' + (pct >= TOKEN_CRIT_PCT*100 ? ' crit' : pct >= TOKEN_WARN_PCT*100 ? ' warn' : '');
  }
  if (mcsP) mcsP.textContent = `${100 - pct}%`;
}

function checkCapacityThresholds() {
  const pct = tokensUsedToday / TOKEN_DAILY_LIMIT;
  if (pct >= 1) { showCapacityExhausted(); return; }
  const banner = document.getElementById('capacityWarningBanner');
  const sub    = document.getElementById('cwbSub');
  const remain = document.getElementById('cwbRemain');
  if (!banner) return;
  if (pct >= TOKEN_CRIT_PCT) {
    banner.style.display = 'block'; banner.classList.add('critical');
    if (sub)    sub.textContent    = `Luna is almost out — only ~${(TOKEN_DAILY_LIMIT - tokensUsedToday).toLocaleString()} tokens left.`;
    if (remain) remain.textContent = `${100 - Math.round(pct*100)}% left`;
  } else if (pct >= TOKEN_WARN_PCT) {
    banner.style.display = 'block'; banner.classList.remove('critical');
    if (sub)    sub.textContent    = `Capacity is getting low — about ${(TOKEN_DAILY_LIMIT - tokensUsedToday).toLocaleString()} tokens remaining.`;
    if (remain) remain.textContent = `${100 - Math.round(pct*100)}% left`;
  } else {
    banner.style.display = 'none';
  }
}

function showCapacityExhausted() {
  if (capacityExhausted) return;
  capacityExhausted = true;
  const input   = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  if (input)   input.disabled   = true;
  if (sendBtn) sendBtn.disabled = true;
  const scr    = document.getElementById('capacityExhaustedScreen');
  const reset  = getNextMidnight();
  const timeEl = document.getElementById('cexTime');
  const dateEl = document.getElementById('cexDate');
  if (timeEl) timeEl.textContent = reset.time;
  if (dateEl) dateEl.textContent = reset.date;
  if (scr)    scr.style.display  = 'flex';}

function clearChatForReset() {
  tokensUsedToday = 0; capacityExhausted = false;
  localStorage.setItem(TOKEN_STORAGE_KEY(), '0');
  const scr    = document.getElementById('capacityExhaustedScreen');
  const banner = document.getElementById('capacityWarningBanner');
  const input  = document.getElementById('userInput');
  const snd    = document.getElementById('sendBtn');
  if (scr)    scr.style.display    = 'none';
  if (banner) banner.style.display = 'none';
  if (input)  { input.disabled = false; input.placeholder = 'Transmit your query to Luna...'; }
  if (snd)    snd.disabled = false;
  if (typeof clearChat === 'function') clearChat();
  renderCapacityMeter();
  showToast('Chat cleared — Luna is ready again ◈', '✦', 2800);
}

function getNextMidnight() {
  const next = new Date(); next.setDate(next.getDate() + 1); next.setHours(0,0,0,0);
  return {
    time:  next.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }),
    date:  next.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }),
    label: next.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }),
  };
}
// ══════════════════════════════════════════════════════════════════
// ◈ MOBILE UX ENHANCEMENTS — smooth, native-feeling interactions
// ══════════════════════════════════════════════════════════════════

// ── Emoji panel: bottom-sheet behavior on mobile ──────────────────
// Tapping outside the emoji panel (on overlay backdrop) closes it.
function initMobileEmojiSheet() {
  const emojiPanel = document.getElementById('emojiPanel');
  const emojiBtn   = document.getElementById('emojiPickerBtn');
  if (!emojiPanel || !emojiBtn) return;

  // Create a backdrop div for tap-to-close
  const backdrop = document.createElement('div');
  backdrop.id = 'emojiBackdrop';
  backdrop.style.cssText = [
    'display:none;position:fixed;inset:0;z-index:8999;',
    'background:rgba(0,0,0,0.45);',
    'animation:fadeInOverlay 0.18s ease both;',
  ].join('');
  document.body.appendChild(backdrop);

  // Intercept the emoji button to show/hide backdrop on mobile
  const origOnClick = emojiBtn.onclick;
  emojiBtn.onclick = e => {
    e.stopPropagation();
    const willShow = emojiPanel.style.display === 'none' || !emojiPanel.style.display;
    emojiPanel.style.display = willShow ? 'block' : 'none';
    backdrop.style.display   = willShow ? 'block'  : 'none';
  };

  backdrop.addEventListener('click', () => {
    emojiPanel.style.display = 'none';
    backdrop.style.display   = 'none';
  });

  // Add a visible drag handle to the emoji sheet
  if (!emojiPanel.querySelector('.emoji-handle')) {
    const handle = document.createElement('div');
    handle.className = 'emoji-handle';
    handle.style.cssText = [
      'width:40px;height:4px;border-radius:2px;',
      'background:rgba(255,255,255,0.22);',
      'margin:0 auto 12px;',
    ].join('');
    emojiPanel.insertBefore(handle, emojiPanel.firstChild);
  }
}

// ── Input focus: scroll chat to keep last message visible ─────────
// On iOS/Android the keyboard pushes content up. We scroll the feed
// down after a tiny delay so the last message stays visible.
function initMobileInputFocus() {
  const input = document.getElementById('userInput');
  if (!input) return;

  input.addEventListener('focus', () => {
    // Wait for the keyboard animation (~300ms) before scrolling
    setTimeout(() => {
      scrollDown();
    }, 320);
  }, { passive: true });

  // On blur (keyboard hides), re-adjust real viewport height
  input.addEventListener('blur', () => {
    setTimeout(setRealVH, 200);
  }, { passive: true });
}

// ── Double-tap to copy: long-press alternative for bubbles ────────
// On mobile, hovering to reveal copy buttons doesn't work. Double-tap
// on any bubble copies the message text to clipboard.
function initMobileDoubleTapCopy() {
  let _lastTap = 0;
  let _lastBubble = null;

  chatFeed.addEventListener('touchend', e => {
    const bubble = e.target.closest('.bubble');
    if (!bubble) return;
    const now = Date.now();
    const DOUBLE_TAP_MS = 320;
    if (bubble === _lastBubble && (now - _lastTap) < DOUBLE_TAP_MS) {
      // Double-tap detected — copy text
      e.preventDefault();
      const textEl = bubble.querySelector('.bubble-text');
      if (!textEl) return;
      const text = textEl.innerText || textEl.textContent || '';
      navigator.clipboard.writeText(text.trim())
        .then(() => {
          showToast('Message copied ✦', '◈', 1600);
          // Brief visual flash to confirm
          bubble.style.transition = 'border-color 0.12s';
          bubble.style.borderColor = 'var(--violet-bright)';
          setTimeout(() => {
            bubble.style.borderColor = '';
            setTimeout(() => { bubble.style.transition = ''; }, 200);
          }, 400);
        })
        .catch(() => {});
      _lastTap = 0;
      _lastBubble = null;
    } else {
      _lastTap   = now;
      _lastBubble = bubble;
    }
  }, { passive: false });
}

// ── Mobile: keyboard open detection is handled by the Visual Viewport
// Manager at the top of this file — no duplicate listener needed here.

// ── Mobile: Enter key sends on single tap (Shift+Enter = new line) ─
// Already handled by the existing keydown listener, but we also add
// a submit-on-go for mobile keyboard's "Go/Send" button (which fires
// a submit event or Enter on some Android keyboards).
if (IS_MOBILE) {
  const input = document.getElementById('userInput');
  if (input) {
    // Some Android keyboards fire 'keydown' with key='Enter' which
    // is already handled. Some fire 'input' with inputType='insertLineBreak'.
    input.addEventListener('input', e => {
      if (e.inputType === 'insertLineBreak') {
        // BUG FIX: remove the inserted newline character BEFORE calling handleSend
        // so the textarea value is correct and handleSend sees trimmed text.
        const pos = input.selectionStart;
        input.value = input.value.slice(0, pos - 1) + input.value.slice(pos);
        // Move caret back to correct position
        input.setSelectionRange(pos - 1, pos - 1);
        handleInput(); // recalculates sendBtn.disabled based on cleaned value
        const sendBtnEl = document.getElementById('sendBtn');
        if (!sendBtnEl?.disabled && input.value.trim().length > 0) handleSend();
      }
    });
  }
}

// ── Momentum scrolling fix for iOS chat feed ──────────────────────
// -webkit-overflow-scrolling is deprecated but still helps on old iOS.
// The modern way is scroll-behavior + overscroll-behavior.
(function patchIOSScroll() {
  const feed = document.getElementById('chatFeed');
  if (!feed) return;
  feed.style.webkitOverflowScrolling = 'touch';
})();
// ══════════════════════════════════════════════════════════════════
// ◈ LUNA STREAK SYSTEM v2 — Lunova · Lunette · Lunara · Novaria · Solara
// Mobile-first, zero canvas, zero rAF loops, CSS-SVG moons
// ══════════════════════════════════════════════════════════════════

// ── Tier configuration ────────────────────────────────────────────
const STREAK_TIERS = [
  {
    id: 'lunova',
    name: 'LUNOVA',
    sub: 'NEW MOON',
    days: [1, 2],      // 1–2 days
    minDay: 1,
    maxDay: 2,
    nextMin: 3,
    emoji: '🥚',
    color: '#38bdf8',
    color2: '#bfecff',
  },
  {
    id: 'lunette',
    name: 'LUNETTE',
    sub: 'CRESCENT MOON',
    days: null,
    minDay: 3,
    maxDay: 49,
    nextMin: 50,
    emoji: '🌙',
    color: '#a855f7',
    color2: '#c4b5fd',
  },
  {
    id: 'lunara',
    name: 'LUNARA',
    sub: 'QUARTER MOON',
    days: null,
    minDay: 50,
    maxDay: 99,
    nextMin: 100,
    emoji: '🌓',
    color: '#818cf8',
    color2: '#c7d2fe',
  },
  {
    id: 'novaria',
    name: 'NOVARIA',
    sub: 'HALF MOON',
    days: null,
    minDay: 100,
    maxDay: 199,
    nextMin: 200,
    emoji: '🌗',
    color: '#ec4899',
    color2: '#fbcfe8',
  },
  {
    id: 'solara',
    name: 'SOLARA',
    sub: 'SOLAR ECLIPSED MOON',
    days: null,
    minDay: 200,
    maxDay: Infinity,
    nextMin: null,
    emoji: '🌚',
    color2: '#fca5a5',
  },
];

// ── SVG moon pet characters — bold, cute, phase-accurate ─────────
// lunova  (1-2d)   → sleeping new moon baby · deep indigo · dreamy zZz
// lunette (3-49d)  → waxing crescent · silver-violet · cheeky wink face
// lunara  (50-99d) → first quarter · sky-blue left-lit · confident smile
// novaria (100-199d)→ waxing gibbous · rosy pink · wide happy blush face
// solara  (200d+)  → total solar eclipse · fire corona · fierce glowing eyes
function getStreakMoonSVG(tierId, size = 32) {
  const s = size;
  const h = s;           // SVG is always square
  const cx = s * 0.5;
  const cy = h * 0.5;

  // Scale helper
  const p = (v) => parseFloat((v * s).toFixed(3));

  const O = `<svg width="${s}" height="${h}" viewBox="0 0 ${s} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
  const C = `</svg>`;

  switch (tierId) {

    // ─────────────────────────────────────────────────────────────
    // LUNOVA — Glowing egg · deep indigo/blue · 1-2 days
    // ─────────────────────────────────────────────────────────────
    case 'lunova': {
      const id = `lv${s}`;
      // Egg shape: ellipse taller than wide, slightly narrower at top
      const eW = p(0.52);   // half-width of egg
      const eH = p(0.62);   // half-height of egg
      const eX = cx;
      const eY = cy + p(0.04); // nudge down slightly so egg looks bottom-heavy
      return `${O}
  <defs>
    <radialGradient id="${id}glow" cx="50%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}body" cx="38%" cy="28%" r="72%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="#bfecff"/>
      <stop offset="30%"  stop-color="#38bdf8"/>
      <stop offset="68%"  stop-color="#0369a1"/>
      <stop offset="100%" stop-color="#0c1a3a"/>
    </radialGradient>
    <radialGradient id="${id}shine" cx="35%" cy="22%" r="38%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${id}clip">
      <ellipse cx="${eX.toFixed(2)}" cy="${eY.toFixed(2)}" rx="${eW.toFixed(2)}" ry="${eH.toFixed(2)}"/>
    </clipPath>
  </defs>
  <!-- Ambient glow -->
  <ellipse cx="${eX.toFixed(2)}" cy="${eY.toFixed(2)}" rx="${p(0.62).toFixed(2)}" ry="${p(0.70).toFixed(2)}" fill="url(#${id}glow)"/>
  <!-- Egg body -->
  <ellipse cx="${eX.toFixed(2)}" cy="${eY.toFixed(2)}" rx="${eW.toFixed(2)}" ry="${eH.toFixed(2)}" fill="url(#${id}body)"/>
  <!-- Constellation lines inside egg -->
  <g clip-path="url(#${id}clip)" stroke="#e0f2fe" stroke-width="${p(0.025).toFixed(3)}" stroke-linecap="round" opacity="0.55">
    <line x1="${(cx-p(0.12)).toFixed(2)}" y1="${(cy-p(0.10)).toFixed(2)}" x2="${(cx+p(0.05)).toFixed(2)}" y2="${(cy+p(0.08)).toFixed(2)}"/>
    <line x1="${(cx+p(0.05)).toFixed(2)}" y1="${(cy+p(0.08)).toFixed(2)}" x2="${(cx+p(0.20)).toFixed(2)}" y2="${(cy-p(0.04)).toFixed(2)}"/>
    <line x1="${(cx-p(0.12)).toFixed(2)}" y1="${(cy-p(0.10)).toFixed(2)}" x2="${(cx-p(0.05)).toFixed(2)}" y2="${(cy-p(0.28)).toFixed(2)}"/>
    <line x1="${(cx+p(0.05)).toFixed(2)}" y1="${(cy+p(0.08)).toFixed(2)}" x2="${(cx-p(0.03)).toFixed(2)}" y2="${(cy+p(0.28)).toFixed(2)}"/>
  </g>
  <!-- Constellation dots -->
  <g clip-path="url(#${id}clip)" opacity="0.90">
    <circle cx="${(cx-p(0.12)).toFixed(2)}" cy="${(cy-p(0.10)).toFixed(2)}" r="${p(0.038).toFixed(3)}" fill="#bae6fd"/>
    <circle cx="${(cx+p(0.05)).toFixed(2)}" cy="${(cy+p(0.08)).toFixed(2)}" r="${p(0.048).toFixed(3)}" fill="#f0f9ff"/>
    <circle cx="${(cx+p(0.20)).toFixed(2)}" cy="${(cy-p(0.04)).toFixed(2)}" r="${p(0.030).toFixed(3)}" fill="#7dd3fc"/>
    <circle cx="${(cx-p(0.03)).toFixed(2)}" cy="${(cy+p(0.28)).toFixed(2)}" r="${p(0.026).toFixed(3)}" fill="#bae6fd"/>
    <circle cx="${(cx-p(0.05)).toFixed(2)}" cy="${(cy-p(0.28)).toFixed(2)}" r="${p(0.022).toFixed(3)}" fill="#e0f2fe"/>
  </g>
  <!-- Shine highlight -->
  <ellipse cx="${eX.toFixed(2)}" cy="${eY.toFixed(2)}" rx="${eW.toFixed(2)}" ry="${eH.toFixed(2)}" fill="url(#${id}shine)"/>
  <!-- Egg outline -->
  <ellipse cx="${eX.toFixed(2)}" cy="${eY.toFixed(2)}" rx="${eW.toFixed(2)}" ry="${eH.toFixed(2)}" fill="none" stroke="#7dd3fc" stroke-width="${p(0.028).toFixed(3)}" opacity="0.55"/>
  <!-- Corner bracket decoration (like the pill) -->
  <g stroke="#38bdf8" stroke-width="${p(0.020).toFixed(3)}" stroke-linecap="round" opacity="0.50">
    <path d="M${(cx-p(0.46)).toFixed(2)} ${(cy-p(0.30)).toFixed(2)} L${(cx-p(0.46)).toFixed(2)} ${(cy-p(0.44)).toFixed(2)} L${(cx-p(0.32)).toFixed(2)} ${(cy-p(0.44)).toFixed(2)}"/>
    <path d="M${(cx+p(0.32)).toFixed(2)} ${(cy-p(0.44)).toFixed(2)} L${(cx+p(0.46)).toFixed(2)} ${(cy-p(0.44)).toFixed(2)} L${(cx+p(0.46)).toFixed(2)} ${(cy-p(0.30)).toFixed(2)}"/>
    <path d="M${(cx-p(0.46)).toFixed(2)} ${(cy+p(0.30)).toFixed(2)} L${(cx-p(0.46)).toFixed(2)} ${(cy+p(0.44)).toFixed(2)} L${(cx-p(0.32)).toFixed(2)} ${(cy+p(0.44)).toFixed(2)}"/>
    <path d="M${(cx+p(0.32)).toFixed(2)} ${(cy+p(0.44)).toFixed(2)} L${(cx+p(0.46)).toFixed(2)} ${(cy+p(0.44)).toFixed(2)} L${(cx+p(0.46)).toFixed(2)} ${(cy+p(0.30)).toFixed(2)}"/>
  </g>
${C}`;
    }

    // ─────────────────────────────────────────────────────────────
    // LUNETTE — Crescent waxing moon · silver-violet · cheeky wink
    // ─────────────────────────────────────────────────────────────
    case 'lunette': {
      const R = p(0.38);
      const id = `lt${s}`;
      // crescent: mask out offset circle to the right
      const offX = cx + p(0.18);
      const offR = R * 0.94;
      // face is on the bright left horn area
      const fcy = cy + p(0.00);
      const eyeL = { x: cx - p(0.19), y: fcy - p(0.07) };
      const eyeR2 = { x: cx - p(0.04), y: fcy - p(0.08) };
      const eyeRad = p(0.036);
      const mY = fcy + p(0.10);
      return `${O}
  <defs>
    <radialGradient id="${id}glo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#c084fc" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#c084fc" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}g" cx="22%" cy="20%" r="80%" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="#f5f0ff"/>
      <stop offset="25%" stop-color="#ddd6fe"/>
      <stop offset="58%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#4c1d95"/>
    </radialGradient>
    <mask id="${id}m">
      <rect width="${s}" height="${h}" fill="white"/>
      <circle cx="${offX.toFixed(2)}" cy="${cy.toFixed(2)}" r="${offR.toFixed(2)}" fill="black"/>
    </mask>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${p(0.48)}" fill="url(#${id}glo)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="#160a2c" opacity="0.50"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${id}g)" mask="url(#${id}m)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(216,180,254,0.40)" stroke-width="${p(0.022)}" mask="url(#${id}m)"/>
  <ellipse cx="${(cx - p(0.25)).toFixed(2)}" cy="${(cy - p(0.22)).toFixed(2)}" rx="${p(0.08)}" ry="${p(0.045)}" fill="rgba(255,255,255,0.55)" transform="rotate(-25 ${cx} ${cy})"/>
  <ellipse cx="${(eyeL.x + p(0.01)).toFixed(2)}" cy="${(eyeL.y + p(0.06)).toFixed(2)}" rx="${p(0.055)}" ry="${p(0.030)}" fill="rgba(245,168,255,0.55)"/>
  <circle cx="${eyeL.x.toFixed(2)}" cy="${eyeL.y.toFixed(2)}" r="${eyeRad}" fill="#1e0444"/>
  <circle cx="${eyeR2.x.toFixed(2)}" cy="${(eyeR2.y + p(0.010)).toFixed(2)}" r="${(eyeRad*0.82).toFixed(3)}" fill="#1e0444"/>
  <path d="M${(eyeR2.x - p(0.055)).toFixed(2)} ${eyeR2.y.toFixed(2)} Q${eyeR2.x.toFixed(2)} ${(eyeR2.y - p(0.055)).toFixed(2)} ${(eyeR2.x + p(0.055)).toFixed(2)} ${eyeR2.y.toFixed(2)}" stroke="#1e0444" stroke-width="${p(0.038)}" stroke-linecap="round"/>
  <circle cx="${(eyeL.x - p(0.010)).toFixed(2)}" cy="${(eyeL.y - p(0.015)).toFixed(2)}" r="${p(0.013)}" fill="white"/>
  <path d="M${(cx - p(0.22)).toFixed(2)} ${mY.toFixed(2)} Q${(cx - p(0.12)).toFixed(2)} ${(mY + p(0.07)).toFixed(2)} ${(cx - p(0.01)).toFixed(2)} ${mY.toFixed(2)}" stroke="#1e0444" stroke-width="${p(0.040)}" stroke-linecap="round"/>
  <circle cx="${(cx + p(0.30)).toFixed(2)}" cy="${(cy - p(0.26)).toFixed(2)}" r="${p(0.018)}" fill="#d8b4fe" opacity="0.80"/>
  <circle cx="${(cx + p(0.22)).toFixed(2)}" cy="${(cy + p(0.28)).toFixed(2)}" r="${p(0.013)}" fill="#a855f7" opacity="0.65"/>
${C}`;
    }

    // ─────────────────────────────────────────────────────────────
    // LUNARA — First quarter moon · sky-blue-indigo · confident grin
    // ─────────────────────────────────────────────────────────────
    case 'lunara': {
      const R = p(0.38);
      const id = `la${s}`;
      // half lit on the left
      const clipX = cx + p(0.015); // terminator line
      // face centered in lit left half
      const fcx = cx - p(0.10);
      const fcy = cy;
      const eyeOx = p(0.100);
      const eyeY = fcy - p(0.07);
      const eyeRad = p(0.034);
      const mY = fcy + p(0.10);
      const mW = p(0.115);
      return `${O}
  <defs>
    <radialGradient id="${id}glo" cx="35%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#818cf8" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}g" cx="18%" cy="22%" r="82%" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="#e0f2fe"/>
      <stop offset="30%" stop-color="#93c5fd"/>
      <stop offset="65%" stop-color="#4f46e5"/>
      <stop offset="100%" stop-color="#1e1b4b"/>
    </radialGradient>
    <clipPath id="${id}cp">
      <rect x="0" y="0" width="${clipX.toFixed(2)}" height="${h}"/>
    </clipPath>
  </defs>
  <circle cx="${(cx - p(0.04))}" cy="${cy}" r="${p(0.44)}" fill="url(#${id}glo)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="#07071e"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${id}g)" clip-path="url(#${id}cp)"/>
  <line x1="${clipX.toFixed(2)}" y1="${(cy - R).toFixed(2)}" x2="${clipX.toFixed(2)}" y2="${(cy + R).toFixed(2)}" stroke="rgba(147,197,253,0.55)" stroke-width="${p(0.028)}"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(129,140,248,0.35)" stroke-width="${p(0.020)}"/>
  <ellipse cx="${(fcx - p(0.08)).toFixed(2)}" cy="${(fcy - p(0.18)).toFixed(2)}" rx="${p(0.10)}" ry="${p(0.055)}" fill="rgba(255,255,255,0.30)" transform="rotate(-18 ${cx} ${cy})"/>
  <ellipse cx="${(fcx - p(0.04)).toFixed(2)}" cy="${(eyeY + p(0.065)).toFixed(2)}" rx="${p(0.070)}" ry="${p(0.036)}" fill="rgba(147,197,253,0.55)"/>
  <ellipse cx="${(fcx + p(0.12)).toFixed(2)}" cy="${(eyeY + p(0.065)).toFixed(2)}" rx="${p(0.060)}" ry="${p(0.032)}" fill="rgba(147,197,253,0.50)"/>
  <circle cx="${(fcx - eyeOx + p(0.06)).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${eyeRad}" fill="#1e1b4b"/>
  <circle cx="${(fcx + eyeOx - p(0.06)).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${eyeRad}" fill="#1e1b4b"/>
  <circle cx="${(fcx - eyeOx + p(0.04)).toFixed(2)}" cy="${(eyeY - p(0.016)).toFixed(2)}" r="${p(0.013)}" fill="white"/>
  <circle cx="${(fcx + eyeOx - p(0.08)).toFixed(2)}" cy="${(eyeY - p(0.016)).toFixed(2)}" r="${p(0.013)}" fill="white"/>
  <path d="M${(fcx - mW).toFixed(2)} ${mY.toFixed(2)} Q${fcx.toFixed(2)} ${(mY + p(0.08)).toFixed(2)} ${(fcx + mW).toFixed(2)} ${mY.toFixed(2)}" stroke="#1e1b4b" stroke-width="${p(0.042)}" stroke-linecap="round"/>
  <circle cx="${(cx + p(0.22)).toFixed(2)}" cy="${(cy - p(0.18)).toFixed(2)}" r="${p(0.030)}" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.10)" stroke-width="${p(0.014)}"/>
  <circle cx="${(cx + p(0.28)).toFixed(2)}" cy="${(cy + p(0.22)).toFixed(2)}" r="${p(0.020)}" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.08)" stroke-width="${p(0.012)}"/>
${C}`;
    }

    // ─────────────────────────────────────────────────────────────
    // NOVARIA — Waxing gibbous · rosy pink · big blush cheeks, heart
    // ─────────────────────────────────────────────────────────────
    case 'novaria': {
      const R = p(0.38);
      const id = `nv${s}`;
      // shadow sliver: mask right edge with offset circle
      const shadowR = R * 0.80;
      const shadowX = cx + p(0.24);
      const eyeOx = p(0.100);
      const eyeY = cy - p(0.06);
      const eyeRad = p(0.036);
      const mY = cy + p(0.12);
      const mW = p(0.130);
      return `${O}
  <defs>
    <radialGradient id="${id}glo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f472b6" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#f472b6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}g" cx="25%" cy="20%" r="80%" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="#fff0f8"/>
      <stop offset="28%" stop-color="#fda4d4"/>
      <stop offset="62%" stop-color="#ec4899"/>
      <stop offset="100%" stop-color="#831843"/>
    </radialGradient>
    <mask id="${id}m">
      <rect width="${s}" height="${h}" fill="white"/>
      <circle cx="${shadowX.toFixed(2)}" cy="${cy.toFixed(2)}" r="${shadowR.toFixed(2)}" fill="black"/>
    </mask>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${p(0.48)}" fill="url(#${id}glo)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="#1a0214"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${id}g)" mask="url(#${id}m)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(249,168,212,0.40)" stroke-width="${p(0.022)}" mask="url(#${id}m)"/>
  <ellipse cx="${(cx - p(0.14)).toFixed(2)}" cy="${(cy - p(0.20)).toFixed(2)}" rx="${p(0.11)}" ry="${p(0.056)}" fill="rgba(255,255,255,0.30)" transform="rotate(-16 ${cx} ${cy})"/>
  <ellipse cx="${(cx - p(0.17)).toFixed(2)}" cy="${(eyeY + p(0.065)).toFixed(2)}" rx="${p(0.074)}" ry="${p(0.040)}" fill="rgba(251,113,133,0.65)"/>
  <ellipse cx="${(cx + p(0.05)).toFixed(2)}" cy="${(eyeY + p(0.068)).toFixed(2)}" rx="${p(0.066)}" ry="${p(0.036)}" fill="rgba(251,113,133,0.60)"/>
  <circle cx="${(cx - eyeOx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${eyeRad}" fill="#831843"/>
  <circle cx="${(cx + eyeOx*0.14).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${(eyeRad*0.92).toFixed(3)}" fill="#831843"/>
  <circle cx="${(cx - eyeOx - p(0.010)).toFixed(2)}" cy="${(eyeY - p(0.016)).toFixed(2)}" r="${p(0.014)}" fill="white"/>
  <circle cx="${(cx + eyeOx*0.14 - p(0.012)).toFixed(2)}" cy="${(eyeY - p(0.016)).toFixed(2)}" r="${p(0.013)}" fill="white"/>
  <path d="M${(cx - mW).toFixed(2)} ${mY.toFixed(2)} Q${cx.toFixed(2)} ${(mY + p(0.09)).toFixed(2)} ${(cx + mW).toFixed(2)} ${mY.toFixed(2)}" stroke="#831843" stroke-width="${p(0.044)}" stroke-linecap="round"/>
  <text x="${(cx + p(0.28)).toFixed(2)}" y="${(cy - p(0.26)).toFixed(2)}" font-size="${p(0.115)}" fill="#f9a8d4" opacity="0.90" text-anchor="middle">♥</text>
${C}`;
    }

    // ─────────────────────────────────────────────────────────────
    // SOLARA — Total solar eclipse · fierce fiery corona · 200+ days
    // ─────────────────────────────────────────────────────────────
    case 'solara': {
      const R = p(0.34);
      const CR = p(0.42); // corona radius
      const id = `sl${s}`;
      // Generate 16 corona rays
      const rays = Array.from({length:16}, (_,i) => {
        const deg = i * 22.5;
        const rad = deg * Math.PI / 180;
        const baseX = (cx + CR * Math.cos(rad)).toFixed(2);
        const baseY = (cy + CR * Math.sin(rad)).toFixed(2);
        const isMain = i % 2 === 0;
        const len = isMain ? p(0.090) : p(0.054);
        const tipX = (cx + (CR + len) * Math.cos(rad)).toFixed(2);
        const tipY = (cy + (CR + len) * Math.sin(rad)).toFixed(2);
        const op = isMain ? 0.85 : 0.55;
        const sw = isMain ? p(0.026) : p(0.016);
        return `<line x1="${baseX}" y1="${baseY}" x2="${tipX}" y2="${tipY}" stroke="rgba(251,191,36,${op})" stroke-width="${sw}" stroke-linecap="round"/>`;
      }).join('');
      // eye coords
      const eyeOx = p(0.100);
      const eyeY = cy - p(0.04);
      const eyeRad = p(0.040);
      const mY = cy + p(0.14);
      const mW = p(0.110);
      return `${O}
  <defs>
    <radialGradient id="${id}cor" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(239,68,68,0)"/>
      <stop offset="58%" stop-color="rgba(251,191,36,0)"/>
      <stop offset="74%" stop-color="rgba(251,191,36,0.50)"/>
      <stop offset="86%" stop-color="rgba(239,68,68,0.28)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
    <radialGradient id="${id}disc" cx="38%" cy="30%" r="72%" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="#1a0505"/>
      <stop offset="100%" stop-color="#050000"/>
    </radialGradient>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${p(0.50)}" fill="url(#${id}cor)"/>
  ${rays}
  <circle cx="${cx}" cy="${cy}" r="${(CR + p(0.006)).toFixed(3)}" fill="none" stroke="rgba(251,191,36,0.75)" stroke-width="${p(0.028)}"/>
  <circle cx="${cx}" cy="${cy}" r="${(CR + p(0.016)).toFixed(3)}" fill="none" stroke="rgba(239,68,68,0.45)" stroke-width="${p(0.018)}"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${id}disc)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(239,68,68,0.88)" stroke-width="${p(0.030)}"/>
  <circle cx="${(cx - eyeOx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${eyeRad}" fill="#fbbf24"/>
  <circle cx="${(cx + eyeOx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${eyeRad}" fill="#fbbf24"/>
  <circle cx="${(cx - eyeOx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${(eyeRad*0.46).toFixed(3)}" fill="#1a0505"/>
  <circle cx="${(cx + eyeOx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${(eyeRad*0.46).toFixed(3)}" fill="#1a0505"/>
  <circle cx="${(cx - eyeOx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${(eyeRad + p(0.014)).toFixed(3)}" fill="none" stroke="rgba(251,191,36,0.55)" stroke-width="${p(0.016)}"/>
  <circle cx="${(cx + eyeOx).toFixed(2)}" cy="${eyeY.toFixed(2)}" r="${(eyeRad + p(0.014)).toFixed(3)}" fill="none" stroke="rgba(251,191,36,0.55)" stroke-width="${p(0.016)}"/>
  <path d="M${(cx - eyeOx - p(0.012)).toFixed(2)} ${(eyeY - eyeRad - p(0.018)).toFixed(2)} L${(cx - eyeOx + p(0.012)).toFixed(2)} ${(eyeY - eyeRad - p(0.018)).toFixed(2)}" stroke="rgba(251,191,36,0.90)" stroke-width="${p(0.026)}" stroke-linecap="round"/>
  <path d="M${(cx + eyeOx - p(0.012)).toFixed(2)} ${(eyeY - eyeRad - p(0.018)).toFixed(2)} L${(cx + eyeOx + p(0.012)).toFixed(2)} ${(eyeY - eyeRad - p(0.018)).toFixed(2)}" stroke="rgba(251,191,36,0.90)" stroke-width="${p(0.026)}" stroke-linecap="round"/>
  <path d="M${(cx - mW).toFixed(2)} ${mY.toFixed(2)} Q${cx.toFixed(2)} ${(mY + p(0.07)).toFixed(2)} ${(cx + mW).toFixed(2)} ${mY.toFixed(2)}" stroke="rgba(251,191,36,0.95)" stroke-width="${p(0.044)}" stroke-linecap="round"/>
${C}`;
    }

    default:
      return `${O}<circle cx="${cx}" cy="${cy}" r="${p(0.38)}" fill="rgba(168,85,247,0.5)"/>${C}`;
  }
}


// ── Streak data (localStorage per user) ──────────────────────────
function _streakKey() {
  const u = (typeof userName !== 'undefined' && userName)
    ? userName.toLowerCase().replace(/[^a-z0-9]/g, '_') : 'anon';
  return `luna_streak2_${u}`;
}

function loadStreakData() {
  try { return JSON.parse(localStorage.getItem(_streakKey())) || { days: 0, lastDate: null }; }
  catch { return { days: 0, lastDate: null }; }
}

function saveStreakData(data) {
  try {
    localStorage.setItem(_streakKey(), JSON.stringify(data));
    // Cross-tab broadcast: ping other tabs so they re-render immediately
    try { localStorage.setItem(_streakKey() + '_sync', String(Date.now())); } catch {}
  } catch {}
}

// ══════════════════════════════════════════════════════════════════
// ◈ STREAK STATES — Frozen / Rotten
//
//   FROZEN : No chat between user and Luna for ≥ 7 hours.
//            The egg/pet is covered in an ice overlay.
//            If the user chats again, ice melts and streak resumes.
//            If they don't chat before the next calendar-day boundary
//            passes (≥ 7h of silence crossing midnight), streak resets
//            to day 1 on next login.
//
//   ROTTEN : The egg is still at lunova tier (days 1-2) and 3 full
//            calendar days have elapsed since the streak started
//            (meaning the user logged in but never progressed the egg
//            to day 3 to hatch it). The egg goes rotten with a
//            bubbling/dripping animation and a "Restart your streak"
//            message is shown.
// ══════════════════════════════════════════════════════════════════

const STREAK_ROT_DAYS = 3;                   // calendar days before egg rots

function _lastChatKey() { return _streakKey() + '_lastchat'; }
function _lastChatDateKey() { return _streakKey() + '_lastchatdate'; }
function _eggBornKey()  { return _streakKey() + '_eggborn';  }
function _rottenKey()   { return _streakKey() + '_rotten';   }

/** Record current timestamp and today's date as "last time user sent a message to Luna" */
function recordStreakChatActivity() {
  const today = new Date().toDateString();

  // ── Check states BEFORE saving today's date ──────────────────
  // isEggFrozen() reads _lastChatDateKey, so we must snapshot the
  // frozen/rotten state first, then persist, then act on the snapshot.
  const wasRotten = isEggRotten();
  const wasFrozen = !wasRotten && isEggFrozen();

  // Persist chat timestamp and today's date
  try {
    localStorage.setItem(_lastChatKey(), String(Date.now()));
    localStorage.setItem(_lastChatDateKey(), today);
  } catch {}

  // If egg was rotten, a new message restarts it
  if (wasRotten) {
    try { localStorage.removeItem(_rottenKey()); } catch {}
    const data = loadStreakData();
    data.days     = 1;
    data.lastDate = today;
    saveStreakData(data);
    // Reset egg-born timestamp to today
    try { localStorage.setItem(_eggBornKey(), String(Date.now())); } catch {}
    renderStreakUI();
    checkStreakState();
    return;
  }
  // If egg was frozen (hadn't chatted today), thaw it now
  if (wasFrozen) {
    thawEgg();
  }
}

/** True when user has NOT chatted today (calendar day) */
function isEggFrozen() {
  try {
    const lastDate = localStorage.getItem(_lastChatDateKey());
    if (!lastDate) return true; // never chatted
    return lastDate !== new Date().toDateString();
  } catch { return true; }
}

/** True when egg started ≥ 3 calendar days ago and is still lunova (never hatched) */
function isEggRotten() {
  try { return localStorage.getItem(_rottenKey()) === '1'; } catch { return false; }
}

/** Check if the egg-born date is old enough to rot */
function checkEggRotCondition() {
  const data = loadStreakData();
  // Only applies to lunova (egg phase, days 1-2)
  if (!data || data.days > 2) return false;
  try {
    const born = parseInt(localStorage.getItem(_eggBornKey()), 10);
    if (isNaN(born)) {
      // First run — set born timestamp now
      localStorage.setItem(_eggBornKey(), String(Date.now()));
      return false;
    }
    const daysSinceBorn = (Date.now() - born) / 86400000;
    return daysSinceBorn >= STREAK_ROT_DAYS;
  } catch { return false; }
}

/** Apply the ice overlay to the streak pill */
function freezeEgg() {
  const pill = document.getElementById('streakPill');
  if (!pill || pill.classList.contains('egg-frozen')) return;
  pill.classList.add('egg-frozen');
  // Remove the float animation while frozen
  pill.style.animationName = 'spGlow';

  // Inject ice SVG overlay if not already present
  if (!pill.querySelector('.egg-ice-overlay')) {
    const ice = document.createElement('div');
    ice.className = 'egg-ice-overlay';
    ice.innerHTML = _buildIceSVG();
    pill.prepend(ice);
  }

  // Update the pill label
  const nameEl = pill.querySelector('.sp-pill-name');
  if (nameEl) nameEl.textContent = 'FROZEN';

  showToast('❄️ Your streak pet is frozen! Chat with Luna today to thaw it.', '❄️', 4000);
}

/** Remove the ice overlay when user returns */
function thawEgg() {
  const pill = document.getElementById('streakPill');
  if (!pill || !pill.classList.contains('egg-frozen')) return;
  pill.classList.remove('egg-frozen');
  // Restore float animation
  pill.style.animationName = '';

  const ice = pill.querySelector('.egg-ice-overlay');
  if (ice) {
    ice.classList.add('ice-thawing');
    setTimeout(() => ice.remove(), 800);
  }

  // Restore tier name
  const data = loadStreakData();
  const tier = getTierForDays(data.days);
  const nameEl = pill.querySelector('.sp-pill-name');
  if (nameEl) nameEl.textContent = tier.name;

  showToast('🔥 Streak thawed! Keep chatting! ✦', '🔥', 2800);
}

/** Mark egg as rotten and show the overlay */
function rotEgg() {
  try { localStorage.setItem(_rottenKey(), '1'); } catch {}
  // Reset streak to 0 (forces egg back to unhatched state visually)
  const pill = document.getElementById('streakPill');
  if (pill) {
    pill.classList.add('egg-rotten');
    const ice = pill.querySelector('.egg-ice-overlay');
    if (ice) ice.remove();
    pill.classList.remove('egg-frozen');
    // Update moon to rotten egg SVG
    const moonEl = pill.querySelector('.sp-pill-moon');
    if (moonEl) moonEl.innerHTML = _buildRottenEggSVG(36);
    const nameEl = pill.querySelector('.sp-pill-name');
    if (nameEl) nameEl.textContent = 'ROTTEN';
    const daysEl = pill.querySelector('.sp-pill-days');
    if (daysEl) daysEl.textContent = '✕';
  }
  showRottenEggOverlay();
}

/** Master check — call on login and periodically */
function checkStreakState() {
  const data = loadStreakData();
  if (!data || !data.days) return;

  // 1. Rotten check (egg never hatched in 3 days)
  if (!isEggRotten() && checkEggRotCondition()) {
    rotEgg(); return;
  }
  if (isEggRotten()) {
    // Already rotten — ensure pill shows rotten state
    const pill = document.getElementById('streakPill');
    if (pill && !pill.classList.contains('egg-rotten')) {
      pill.classList.add('egg-rotten');
      const moonEl = pill.querySelector('.sp-pill-moon');
      if (moonEl) moonEl.innerHTML = _buildRottenEggSVG(36);
      const nameEl = pill.querySelector('.sp-pill-name');
      if (nameEl) nameEl.textContent = 'ROTTEN';
    }
    return;
  }

  // 2. Frozen check (silent for ≥ 7 hours)
  if (isEggFrozen()) {
    freezeEgg();
  }
}

// Re-check every 5 minutes while the tab is open
setInterval(() => {
  if (appState === 'chat' && userName) checkStreakState();
}, 5 * 60 * 1000);

/** Build the ice overlay SVG */
function _buildIceSVG() {
  return `<svg class="ice-svg" viewBox="0 0 40 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <radialGradient id="iceBody" cx="40%" cy="28%" r="70%" gradientUnits="objectBoundingBox">
        <stop offset="0%"   stop-color="#e0f2fe" stop-opacity="0.92"/>
        <stop offset="40%"  stop-color="#7dd3fc" stop-opacity="0.78"/>
        <stop offset="80%"  stop-color="#0ea5e9" stop-opacity="0.70"/>
        <stop offset="100%" stop-color="#0369a1" stop-opacity="0.82"/>
      </radialGradient>
      <radialGradient id="iceGlow" cx="50%" cy="50%" r="50%">
        <stop offset="30%" stop-color="rgba(125,211,252,0)"/>
        <stop offset="80%" stop-color="rgba(125,211,252,0.35)"/>
        <stop offset="100%" stop-color="rgba(14,165,233,0)"/>
      </radialGradient>
    </defs>
    <!-- Outer glow -->
    <ellipse cx="20" cy="27" rx="17" ry="23" fill="url(#iceGlow)"/>
    <!-- Ice body -->
    <ellipse cx="20" cy="27" rx="13.5" ry="18" fill="url(#iceBody)"/>
    <!-- Crack lines for texture -->
    <path d="M14 20 L18 25 L15 30" stroke="rgba(255,255,255,0.55)" stroke-width="0.8" stroke-linecap="round"/>
    <path d="M22 18 L25 24 L28 22" stroke="rgba(255,255,255,0.45)" stroke-width="0.7" stroke-linecap="round"/>
    <path d="M17 32 L20 36 L24 33" stroke="rgba(255,255,255,0.40)" stroke-width="0.7" stroke-linecap="round"/>
    <!-- Specular highlight -->
    <ellipse cx="15" cy="20" rx="4" ry="2.5" fill="rgba(255,255,255,0.60)" transform="rotate(-20 20 27)"/>
    <ellipse cx="24" cy="18" rx="2" ry="1.2" fill="rgba(255,255,255,0.40)" transform="rotate(-10 20 27)"/>
    <!-- Frost dots -->
    <circle cx="12" cy="29" r="1.2" fill="rgba(255,255,255,0.50)"/>
    <circle cx="28" cy="24" r="0.9" fill="rgba(255,255,255,0.40)"/>
    <circle cx="20" cy="38" r="1.0" fill="rgba(255,255,255,0.35)"/>
    <!-- Icicles hanging from bottom -->
    <path d="M16 44 Q16.5 47 17 45 Q17.5 49 18 46" stroke="rgba(125,211,252,0.75)" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    <path d="M20 45 Q20.5 49 21 46 Q21.5 50 22 47" stroke="rgba(125,211,252,0.70)" stroke-width="1.1" fill="none" stroke-linecap="round"/>
    <path d="M24 43 Q24.5 46 25 44" stroke="rgba(125,211,252,0.60)" stroke-width="1.0" fill="none" stroke-linecap="round"/>
  </svg>`;
}

/** Build a rotten/decayed egg SVG */
function _buildRottenEggSVG(size = 36) {
  const s = size, cx = s/2, cy = s/2 + s*0.03, rx = s*0.33, ry = s*0.44;
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <radialGradient id="rotEgg${s}" cx="36%" cy="28%" r="70%" gradientUnits="objectBoundingBox">
        <stop offset="0%"   stop-color="#a3e635" stop-opacity="0.9"/>
        <stop offset="30%"  stop-color="#65a30d"/>
        <stop offset="65%"  stop-color="#3f6212"/>
        <stop offset="100%" stop-color="#1a2e05"/>
      </radialGradient>
      <radialGradient id="rotGlow${s}" cx="50%" cy="50%" r="50%">
        <stop offset="40%" stop-color="rgba(163,230,53,0)"/>
        <stop offset="80%" stop-color="rgba(163,230,53,0.22)"/>
        <stop offset="100%" stop-color="rgba(101,163,13,0)"/>
      </radialGradient>
    </defs>
    <!-- Toxic aura -->
    <ellipse cx="${cx}" cy="${cy}" rx="${(rx*1.2).toFixed(1)}" ry="${(ry*1.12).toFixed(1)}" fill="url(#rotGlow${s})"/>
    <!-- Rotten egg body -->
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#rotEgg${s})"/>
    <!-- Brown rot patches -->
    <ellipse cx="${(cx+rx*0.18).toFixed(1)}" cy="${(cy+ry*0.22).toFixed(1)}" rx="${(rx*0.28).toFixed(1)}" ry="${(ry*0.18).toFixed(1)}" fill="rgba(120,53,15,0.60)" transform="rotate(-12 ${cx} ${cy})"/>
    <ellipse cx="${(cx-rx*0.24).toFixed(1)}" cy="${(cy-ry*0.18).toFixed(1)}" rx="${(rx*0.20).toFixed(1)}" ry="${(ry*0.13).toFixed(1)}" fill="rgba(120,53,15,0.45)" transform="rotate(8 ${cx} ${cy})"/>
    <!-- Crack -->
    <path d="M${cx} ${(cy-ry*0.3).toFixed(1)} L${(cx-rx*0.14).toFixed(1)} ${(cy+ry*0.08).toFixed(1)} L${cx} ${(cy+ry*0.22).toFixed(1)}" stroke="rgba(0,0,0,0.6)" stroke-width="${Math.max(0.8,s*0.024)}" stroke-linecap="round" fill="none"/>
    <!-- Toxic drip -->
    <path d="M${(cx-rx*0.08).toFixed(1)} ${(cy+ry*0.82).toFixed(1)} Q${(cx-rx*0.06).toFixed(1)} ${(cy+ry*1.02).toFixed(1)} ${(cx-rx*0.10).toFixed(1)} ${(cy+ry*0.94).toFixed(1)}" stroke="rgba(132,204,22,0.80)" stroke-width="${Math.max(0.9,s*0.026)}" stroke-linecap="round" fill="none"/>
    <!-- Skull eyes (X marks) -->
    <text x="${(cx-rx*0.20).toFixed(1)}" y="${(cy-ry*0.06).toFixed(1)}" font-size="${Math.max(4,s*0.14)}" fill="rgba(0,0,0,0.70)" text-anchor="middle" font-family="sans-serif">✕</text>
    <text x="${(cx+rx*0.20).toFixed(1)}" y="${(cy-ry*0.06).toFixed(1)}" font-size="${Math.max(4,s*0.14)}" fill="rgba(0,0,0,0.70)" text-anchor="middle" font-family="sans-serif">✕</text>
    <!-- Stink lines -->
    <path d="M${(cx-rx*0.5).toFixed(1)} ${(cy-ry*1.05).toFixed(1)} Q${(cx-rx*0.6).toFixed(1)} ${(cy-ry*1.22).toFixed(1)} ${(cx-rx*0.48).toFixed(1)} ${(cy-ry*1.38).toFixed(1)}" stroke="rgba(163,230,53,0.55)" stroke-width="${Math.max(0.8,s*0.022)}" stroke-linecap="round" fill="none"/>
    <path d="M${cx.toFixed(1)} ${(cy-ry*1.10).toFixed(1)} Q${(cx+rx*0.12).toFixed(1)} ${(cy-ry*1.30).toFixed(1)} ${(cx-rx*0.06).toFixed(1)} ${(cy-ry*1.45).toFixed(1)}" stroke="rgba(163,230,53,0.45)" stroke-width="${Math.max(0.8,s*0.018)}" stroke-linecap="round" fill="none"/>
    <path d="M${(cx+rx*0.40).toFixed(1)} ${(cy-ry*1.05).toFixed(1)} Q${(cx+rx*0.55).toFixed(1)} ${(cy-ry*1.25).toFixed(1)} ${(cx+rx*0.42).toFixed(1)} ${(cy-ry*1.38).toFixed(1)}" stroke="rgba(163,230,53,0.45)" stroke-width="${Math.max(0.7,s*0.018)}" stroke-linecap="round" fill="none"/>
  </svg>`;
}

/** Full-screen rotten egg animation overlay */
function showRottenEggOverlay() {
  if (document.getElementById('rottenEggOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'rottenEggOverlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99998;
    background:radial-gradient(ellipse at 50% 55%, #0a1a02 0%, #020209 70%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:0;cursor:pointer;user-select:none;-webkit-user-select:none;
    animation:rotOverlayIn 0.5s cubic-bezier(0.4,0,0.2,1) both;
  `;
  overlay.innerHTML = `
    <style>
      @keyframes rotOverlayIn  { from{opacity:0} to{opacity:1} }
      @keyframes rotOverlayOut { to{opacity:0;transform:scale(0.96)} }
      @keyframes rotDrip {
        0%   { transform:translateY(0) scaleY(0.7); opacity:0.9; }
        60%  { transform:translateY(12px) scaleY(1.3); opacity:1; }
        100% { transform:translateY(28px) scaleY(0.4); opacity:0; }
      }
      @keyframes rotBubble {
        0%,100% { transform:scale(1) translateY(0); opacity:0.7; }
        50%     { transform:scale(1.22) translateY(-6px); opacity:1; }
      }
      @keyframes stinkDrift {
        0%   { transform:translateY(0) rotate(0deg); opacity:0; }
        20%  { opacity:0.7; }
        100% { transform:translateY(-40px) rotate(15deg); opacity:0; }
      }
      @keyframes rotShake {
        0%,100%{transform:rotate(0deg)} 20%{transform:rotate(-4deg)} 60%{transform:rotate(4deg)}
      }
      @keyframes rotPulse {
        0%,100%{filter:drop-shadow(0 0 12px rgba(163,230,53,0.5))}
        50%{filter:drop-shadow(0 0 30px rgba(163,230,53,0.9)) drop-shadow(0 0 60px rgba(163,230,53,0.4))}
      }
      @keyframes rotTextPulse {
        0%,100%{opacity:0.7;transform:scale(1)} 50%{opacity:1;transform:scale(1.04)}
      }
      #rotEggStage { position:relative;width:160px;height:190px;display:flex;align-items:center;justify-content:center; }
      #rotMainSvg  { animation:rotPulse 2s ease-in-out infinite, rotShake 4s ease-in-out infinite; }
      .rot-drip    { position:absolute;bottom:-8px;animation:rotDrip 1.4s ease-in-out infinite; }
      .rot-bubble  { position:absolute;border-radius:50%;background:rgba(163,230,53,0.45);animation:rotBubble 1.8s ease-in-out infinite; }
      .rot-stink   { position:absolute;font-size:18px;animation:stinkDrift 2.2s ease-out infinite; }
      .rot-title   { font-family:'Orbitron',sans-serif;font-size:14px;letter-spacing:0.28em;color:#a3e635;text-shadow:0 0 20px rgba(163,230,53,0.7);margin-bottom:6px; }
      .rot-sub     { font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:0.20em;color:rgba(163,230,53,0.55);margin-bottom:24px; }
      .rot-restart-btn {
        margin-top:8px;padding:13px 32px;
        background:linear-gradient(135deg,rgba(163,230,53,0.18),rgba(101,163,13,0.12));
        border:1px solid rgba(163,230,53,0.50);border-radius:50px;
        color:#a3e635;font-family:'Orbitron',sans-serif;font-size:10px;letter-spacing:0.22em;
        cursor:pointer;animation:rotTextPulse 1.6s ease-in-out infinite;
        transition:background 0.2s,border-color 0.2s;
      }
      .rot-restart-btn:hover { background:rgba(163,230,53,0.26);border-color:rgba(163,230,53,0.80); }
      .rot-tap-hint { font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:0.16em;color:rgba(163,230,53,0.35);margin-top:10px; }
    </style>

    <div class="rot-title">EGG WENT ROTTEN</div>
    <div class="rot-sub">◈ 3 DAYS WITHOUT HATCHING ◈</div>

    <div id="rotEggStage">
      <div id="rotMainSvg">${_buildRottenEggSVG(130)}</div>

      <!-- Drips -->
      <div class="rot-drip" style="left:52px;animation-delay:0s;width:6px;height:18px;background:linear-gradient(to bottom,rgba(163,230,53,0.7),transparent);border-radius:0 0 8px 8px;"></div>
      <div class="rot-drip" style="left:80px;animation-delay:0.6s;width:5px;height:14px;background:linear-gradient(to bottom,rgba(132,204,22,0.6),transparent);border-radius:0 0 8px 8px;"></div>
      <div class="rot-drip" style="left:100px;animation-delay:1.0s;width:4px;height:12px;background:linear-gradient(to bottom,rgba(163,230,53,0.5),transparent);border-radius:0 0 8px 8px;"></div>

      <!-- Toxic bubbles -->
      <div class="rot-bubble" style="width:10px;height:10px;top:20px;left:20px;animation-delay:0.3s;"></div>
      <div class="rot-bubble" style="width:7px;height:7px;top:35px;right:18px;animation-delay:0.8s;"></div>
      <div class="rot-bubble" style="width:8px;height:8px;bottom:40px;left:14px;animation-delay:1.3s;"></div>

      <!-- Stink lines -->
      <div class="rot-stink" style="top:0px;left:22px;animation-delay:0s;">💨</div>
      <div class="rot-stink" style="top:0px;left:66px;animation-delay:0.7s;">💨</div>
      <div class="rot-stink" style="top:0px;right:22px;animation-delay:1.2s;">💨</div>
    </div>

    <button class="rot-restart-btn" id="rotRestartBtn">✦ RESTART YOUR STREAK ✦</button>
    <div class="rot-tap-hint">tap anywhere to dismiss</div>
  `;

  document.body.appendChild(overlay);

  function dismiss() {
    overlay.style.animation = 'rotOverlayOut 0.4s cubic-bezier(0.4,0,1,1) forwards';
    setTimeout(() => overlay.remove(), 380);
  }

  overlay.addEventListener('click', dismiss);
  document.getElementById('rotRestartBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Clear rotten + streak, restart
    try {
      localStorage.removeItem(_rottenKey());
      localStorage.removeItem(_eggBornKey());
    } catch {}
    const data = { days: 1, lastDate: new Date().toDateString() };
    saveStreakData(data);
    try { localStorage.setItem(_eggBornKey(), String(Date.now())); } catch {}
    // Record this as a chat action so ice won't immediately re-apply
    try { localStorage.setItem(_lastChatKey(), String(Date.now())); } catch {}
    dismiss();
    setTimeout(() => {
      renderStreakUI();
      showToast('🥚 Fresh egg! Keep chatting daily to hatch it! ✦', '🥚', 3500);
    }, 400);
  });
}

// ── Cross-tab streak sync listener ───────────────────────────────
// When another tab writes the streak, this tab updates its UI instantly.
window.addEventListener('storage', (e) => {
  if (!userName) return;
  const key = _streakKey();
  if (e.key === key || e.key === key + '_sync') {
    const data = loadStreakData();
    if (data && data.days > 0) renderStreakUI();
  }
});

function getTierForDays(days) {
  for (let i = STREAK_TIERS.length - 1; i >= 0; i--) {
    if (days >= STREAK_TIERS[i].minDay) return STREAK_TIERS[i];
  }
  return STREAK_TIERS[0];
}

function getStreakLevel(days) {
  return getTierForDays(days).id;
}

// Progress within current tier (0–100)
function getTierProgress(days) {
  const tier = getTierForDays(days);
  if (!tier.nextMin) return 100; // max tier
  const span = tier.nextMin - tier.minDay;
  const done = days - tier.minDay;
  return Math.min(100, Math.round((done / span) * 100));
}

function getDaysToNextTier(days) {
  const tier = getTierForDays(days);
  if (!tier.nextMin) return null;
  return tier.nextMin - days;
}

function getNextTier(currentTierId) {
  const idx = STREAK_TIERS.findIndex(t => t.id === currentTierId);
  return idx >= 0 && idx < STREAK_TIERS.length - 1 ? STREAK_TIERS[idx + 1] : null;
}

// ── Firebase sync ─────────────────────────────────────────────────
function syncStreakToFirebase(days, level) {
  if (!firebaseReady || !firebaseDb || !currentUserId) return;
  const ukey = currentUserId;
  const today = new Date().toDateString();
  firebaseDb.ref(`luna-accounts/${ukey}/streak`).set({
    days, level, lastDate: today, name: userName || ukey,
  }).catch(() => {});
}

// ── Compute streak on login ───────────────────────────────────────
let _prevStreakTierId = null;

function computeStreak() {
  if (!userName) return;
  const today     = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const data = loadStreakData();

  if (data.lastDate !== today) {
    if (data.lastDate === yesterday) {
      data.days = (data.days || 0) + 1;
    } else if (!data.lastDate) {
      data.days = 1; // first ever login
    } else {
      data.days = 1; // streak broke
    }
    data.lastDate = today;
    saveStreakData(data);
  }

  const tier     = getTierForDays(data.days);
  const prevId   = _prevStreakTierId;
  _prevStreakTierId = tier.id;

  // Tier-up celebration
  if (prevId && prevId !== tier.id) {
    setTimeout(() => {
      showToast(`${tier.emoji} ${tier.name} unlocked! ${data.days}-day streak! ✦`, tier.emoji, 4000);
    }, 500);
  }

  syncStreakToFirebase(data.days, tier.id);
  return data;
}

// ── Render all streak UI elements ────────────────────────────────
function renderStreakUI() {
  const data = loadStreakData();
  if (!data || !data.days) return;

  const tier     = getTierForDays(data.days);
  const progress = getTierProgress(data.days);
  const toNext   = getDaysToNextTier(data.days);
  const nextTier = getNextTier(tier.id);

  // ── 1. Sidebar widget ─────────────────────────────────────────
  const widget = document.getElementById('streakWidget');
  if (widget) {
    widget.style.display = '';
    widget.setAttribute('data-streak-tier', tier.id);

    const moonIcon = document.getElementById('swMoonIcon');
    if (moonIcon) moonIcon.innerHTML = getStreakMoonSVG(tier.id, 48);

    const tierName = document.getElementById('swTierName');
    if (tierName) tierName.textContent = tier.name;

    const daysNum = document.getElementById('swDaysNum');
    if (daysNum) daysNum.textContent = data.days;

    const progFill = document.getElementById('swProgFill');
    if (progFill) setTimeout(() => { progFill.style.width = progress + '%'; }, 120);
  }

  // ── 2. Floating pill ─────────────────────────────────────────
  const pill = document.getElementById('streakPill');
  if (pill) {
    pill.setAttribute('data-streak-tier', tier.id);
    pill.classList.remove('sp-hidden');
    pill.classList.add('sp-show');

    // ── Apply saved egg enhancements ──
    try {
      const eggFloat = JSON.parse(localStorage.getItem('luna-egg-float') ?? 'true');
      if (!eggFloat) pill.classList.add('sp-no-float');
      // Egg scale feature removed — always use natural size
      pill.style.transform = '';
      pill.style.transformOrigin = '';
      const eggLabel = JSON.parse(localStorage.getItem('luna-egg-label') ?? 'true');
      const lbl = document.getElementById('spPillName');
      if (lbl && !eggLabel) lbl.style.display = 'none';
    } catch {}

    const pillMoon = document.getElementById('spPillMoon');
    if (pillMoon) pillMoon.innerHTML = getStreakMoonSVG(tier.id, 48);

    const pillDays = document.getElementById('spPillDays');
    if (pillDays) pillDays.textContent = data.days;

    const pillName = document.getElementById('spPillName');
    if (pillName) pillName.textContent = tier.name;

    // ── Apply cute day-by-day pet behavior ──
    if (typeof window.applyStreakPetBehavior === 'function') {
      setTimeout(() => window.applyStreakPetBehavior(data.days), 200);
    }
  }
}

// ── Open / close streak detail sheet ─────────────────────────────

// ══════════════════════════════════════════════════════════════════
// ◈ EGG CRACK & HATCH ANIMATION — shown when day reaches 3 (lunova→lunette)
// ══════════════════════════════════════════════════════════════════

// Check if hatch animation should show (day 3, not yet shown this session)
function shouldShowHatchAnimation() {
  const data = loadStreakData();
  if (!data || data.days < 3) return false;
  const tier = getTierForDays(data.days);
  if (tier.id !== 'lunette') return false;
  // Only show once per user (store flag in localStorage)
  const flag = localStorage.getItem('luna_hatched_' + (userName || 'anon'));
  return flag !== '1';
}

function markHatchSeen() {
  try { localStorage.setItem('luna_hatched_' + (userName || 'anon'), '1'); } catch {}
}

// ── Build and show the full-screen hatch overlay ─────────────────
function showEggHatchOverlay(onComplete) {
  markHatchSeen();
  if (document.getElementById('eggHatchOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'eggHatchOverlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:99999;
    background:radial-gradient(ellipse at 50% 60%, #0e0428 0%, #020209 70%);
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:0; cursor:pointer; user-select:none; -webkit-user-select:none;
    animation: hatchOverlayIn 0.5s cubic-bezier(0.4,0,0.2,1) both;
  `;

  overlay.innerHTML = `
    <style>
      @keyframes hatchOverlayIn { from{opacity:0} to{opacity:1} }
      @keyframes hatchOverlayOut { to{opacity:0;transform:scale(1.06)} }
      @keyframes eggWobble { 0%,100%{transform:rotate(0deg)} 20%{transform:rotate(-6deg)} 40%{transform:rotate(6deg)} 60%{transform:rotate(-4deg)} 80%{transform:rotate(4deg)} }
      @keyframes eggShake  { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-8px)} 40%{transform:translateX(8px)} 60%{transform:translateX(-5px)} 80%{transform:translateX(5px)} }
      @keyframes crackFlash { 0%{opacity:0} 40%{opacity:1} 100%{opacity:0} }
      @keyframes hatchBurst { 0%{opacity:0;transform:scale(0.4) rotate(0deg)} 50%{opacity:1} 100%{opacity:0;transform:scale(2.4) rotate(20deg)} }
      @keyframes moonReveal { 0%{opacity:0;transform:scale(0.3) translateY(30px)} 60%{transform:scale(1.15) translateY(-8px)} 100%{opacity:1;transform:scale(1) translateY(0)} }
      @keyframes moonGlowPulse { 0%,100%{filter:drop-shadow(0 0 30px rgba(168,85,247,0.9))} 50%{filter:drop-shadow(0 0 60px rgba(168,85,247,1)) drop-shadow(0 0 120px rgba(168,85,247,0.6))} }
      @keyframes starsExplode { 0%{opacity:0;transform:scale(0)} 30%{opacity:1} 100%{opacity:0;transform:scale(1) translate(var(--sx),var(--sy))} }
      @keyframes tapHint { 0%,100%{opacity:0.5;transform:scale(1)} 50%{opacity:1;transform:scale(1.04)} }
      @keyframes crackLine { from{stroke-dashoffset:1} to{stroke-dashoffset:0} }
      @keyframes shellHalf { to{transform:var(--shell-dest);opacity:0} }
      #eggHatchStage { position:relative; width:180px; height:220px; }
      #eggHatchSvg { width:180px; height:220px; display:block; transition:filter 0.3s; }
      #eggCrackSvg { position:absolute; inset:0; pointer-events:none; }
      #eggShellLeft, #eggShellRight { position:absolute; inset:0; pointer-events:none; opacity:0; }
      #moonRevealEl { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; opacity:0; pointer-events:none; }
      #starBurst { position:absolute; inset:-80px; pointer-events:none; }
      .tap-hint { font-family:'Orbitron',sans-serif; font-size:11px; letter-spacing:0.22em; color:rgba(168,85,247,0.7); margin-top:28px; animation:tapHint 1.4s ease-in-out infinite; }
      .hatch-title { font-family:'Orbitron',sans-serif; font-size:13px; letter-spacing:0.30em; color:rgba(168,85,247,0.55); margin-bottom:18px; }
      .hatch-day3 { font-family:'Orbitron',sans-serif; font-size:9px; letter-spacing:0.20em; color:rgba(168,85,247,0.35); margin-top:6px; }
    </style>
    <div class="hatch-title">DAY 3 · STREAK MILESTONE</div>
    <div id="eggHatchStage">
      <!-- Main egg SVG -->
      <svg id="eggHatchSvg" viewBox="0 0 180 220" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="hEgg" cx="34%" cy="24%" r="68%" gradientUnits="objectBoundingBox">
            <stop offset="0%"  stop-color="#fffbeb"/>
            <stop offset="22%" stop-color="#fde68a"/>
            <stop offset="55%" stop-color="#f59e0b"/>
            <stop offset="85%" stop-color="#b45309"/>
            <stop offset="100%" stop-color="#78350f"/>
          </radialGradient>
          <radialGradient id="hEggGlow" cx="50%" cy="50%" r="50%">
            <stop offset="45%" stop-color="rgba(251,191,36,0)"/>
            <stop offset="78%" stop-color="rgba(251,191,36,0.28)"/>
            <stop offset="100%" stop-color="rgba(245,158,11,0)"/>
          </radialGradient>
        </defs>
        <ellipse cx="90" cy="115" rx="56" ry="74" fill="url(#hEggGlow)"/>
        <ellipse id="hEggBody" cx="90" cy="115" rx="56" ry="74" fill="url(#hEgg)"/>
        <ellipse cx="90" cy="115" rx="56" ry="74" fill="none" stroke="rgba(253,230,138,0.45)" stroke-width="1.2"/>
        <!-- Specular -->
        <ellipse cx="74" cy="88" rx="14" ry="8" fill="rgba(255,255,255,0.48)" transform="rotate(-20 90 115)"/>
      </svg>
      <!-- Crack lines — hidden until tapped -->
      <svg id="eggCrackSvg" viewBox="0 0 180 220" fill="none" xmlns="http://www.w3.org/2000/svg" style="opacity:0">
        <defs>
          <filter id="crackGlow"><feGaussianBlur stdDeviation="1.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <!-- Crack network radiating from center -->
        <g filter="url(#crackGlow)" stroke="rgba(253,230,138,0.95)" stroke-linecap="round">
          <path id="crack1" d="M90 95 L78 112 L70 108" stroke-width="1.8" stroke-dasharray="1" stroke-dashoffset="1"/>
          <path id="crack2" d="M90 95 L98 118 L106 112 L112 125" stroke-width="1.6" stroke-dasharray="1" stroke-dashoffset="1"/>
          <path id="crack3" d="M90 95 L88 82 L80 78" stroke-width="1.4" stroke-dasharray="1" stroke-dashoffset="1"/>
          <path id="crack4" d="M90 95 L95 85 L104 80" stroke-width="1.3" stroke-dasharray="1" stroke-dashoffset="1"/>
          <path id="crack5" d="M78 112 L65 120 L60 132" stroke-width="1.2" stroke-dasharray="1" stroke-dashoffset="1"/>
          <path id="crack6" d="M98 118 L102 135 L94 145" stroke-width="1.2" stroke-dasharray="1" stroke-dashoffset="1"/>
        </g>
        <!-- Impact flash -->
        <circle id="crackFlashCirc" cx="90" cy="95" r="22" fill="rgba(253,230,138,0.22)" opacity="0"/>
      </svg>
      <!-- Shell halves flying apart -->
      <svg id="eggShellLeft" viewBox="0 0 180 220" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <clipPath id="leftHalf"><rect x="0" y="0" width="90" height="220"/></clipPath>
        </defs>
        <ellipse cx="90" cy="115" rx="56" ry="74" fill="url(#hEgg)" clip-path="url(#leftHalf)" opacity="0.9"/>
        <ellipse cx="90" cy="115" rx="56" ry="74" fill="none" stroke="rgba(253,230,138,0.45)" stroke-width="1.2" clip-path="url(#leftHalf)"/>
      </svg>
      <svg id="eggShellRight" viewBox="0 0 180 220" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <clipPath id="rightHalf"><rect x="90" y="0" width="90" height="220"/></clipPath>
        </defs>
        <ellipse cx="90" cy="115" rx="56" ry="74" fill="url(#hEgg)" clip-path="url(#rightHalf)" opacity="0.9"/>
      </svg>
      <!-- Moon revealed underneath -->
      <div id="moonRevealEl"></div>
      <!-- Star burst particles -->
      <svg id="starBurst" viewBox="0 0 340 340" fill="none" xmlns="http://www.w3.org/2000/svg" style="opacity:0"></svg>
    </div>
    <div class="tap-hint" id="hatchHint">✦ TAP TO CRACK THE EGG ✦</div>
    <div class="hatch-day3">LUNETTE IS READY TO HATCH</div>
  `;

  document.body.appendChild(overlay);

  let tapCount = 0;
  const MAX_TAPS = 3;
  const hint = overlay.querySelector('#hatchHint');
  const eggSvg = overlay.querySelector('#eggHatchSvg');
  const crackSvg = overlay.querySelector('#eggCrackSvg');
  const shellLeft = overlay.querySelector('#eggShellLeft');
  const shellRight = overlay.querySelector('#eggShellRight');
  const moonEl = overlay.querySelector('#moonRevealEl');
  const starBurstSvg = overlay.querySelector('#starBurst');
  const stage = overlay.querySelector('#eggHatchStage');

  function buildStarBurst() {
    const colors = ['#c084fc','#a855f7','#e9d5ff','#fde68a','#f9a8d4','#93c5fd'];
    const particles = [];
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const dist = 90 + Math.random() * 70;
      const sx = (Math.cos(angle) * dist).toFixed(1);
      const sy = (Math.sin(angle) * dist).toFixed(1);
      const color = colors[i % colors.length];
      const r = (2 + Math.random() * 4).toFixed(1);
      const delay = (Math.random() * 0.25).toFixed(2);
      particles.push(`<circle cx="170" cy="170" r="${r}" fill="${color}"
        style="--sx:${sx}px;--sy:${sy}px; animation:starsExplode 0.9s ${delay}s cubic-bezier(0.2,0,0.8,1) both"/>`);
    }
    // Also a few diamond shapes
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + 0.3;
      const dist = 110 + Math.random() * 50;
      const sx = (Math.cos(angle) * dist).toFixed(1);
      const sy = (Math.sin(angle) * dist).toFixed(1);
      const color = colors[i % 3];
      const s2 = (3 + Math.random() * 3).toFixed(1);
      const delay = (Math.random() * 0.3).toFixed(2);
      particles.push(`<rect x="${170 - s2/2}" y="${170 - s2/2}" width="${s2}" height="${s2}" fill="${color}"
        transform="rotate(45 170 170)"
        style="--sx:${sx}px;--sy:${sy}px; animation:starsExplode 1.1s ${delay}s cubic-bezier(0.2,0,0.8,1) both"/>`);
    }
    starBurstSvg.innerHTML = particles.join('');
  }

  function animateCrackPaths(svg, callback) {
    const paths = svg.querySelectorAll('path');
    paths.forEach((p, i) => {
      const len = p.getTotalLength ? p.getTotalLength() : 40;
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.style.transition = `stroke-dashoffset ${0.18 + i * 0.06}s ease-out ${i * 0.04}s`;
      requestAnimationFrame(() => { p.style.strokeDashoffset = 0; });
    });
    const flash = svg.querySelector('#crackFlashCirc');
    if (flash) {
      flash.style.animation = 'crackFlash 0.35s ease-out both';
    }
    setTimeout(callback, 400);
  }

  function doTap() {
    tapCount++;

    if (tapCount === 1) {
      // First tap: wobble + show first cracks
      stage.style.animation = 'eggWobble 0.5s ease-in-out';
      crackSvg.style.opacity = '1';
      crackSvg.style.transition = 'opacity 0.1s';
      // Reveal first 2 cracks
      const paths = crackSvg.querySelectorAll('path');
      [paths[0], paths[1]].forEach((p, i) => {
        const len = p.getTotalLength ? p.getTotalLength() : 30;
        p.style.strokeDasharray = len;
        p.style.strokeDashoffset = len;
        setTimeout(() => {
          p.style.transition = `stroke-dashoffset 0.22s ease-out`;
          p.style.strokeDashoffset = 0;
        }, i * 50);
      });
      eggSvg.style.filter = 'drop-shadow(0 0 18px rgba(253,230,138,0.8))';
      hint.textContent = '✦ TAP AGAIN ✦';
      setTimeout(() => { stage.style.animation = ''; }, 500);

    } else if (tapCount === 2) {
      // Second tap: shake + more cracks
      stage.style.animation = 'eggShake 0.4s ease-in-out';
      const paths = crackSvg.querySelectorAll('path');
      [paths[2], paths[3], paths[4]].forEach((p, i) => {
        const len = p.getTotalLength ? p.getTotalLength() : 30;
        p.style.strokeDasharray = len;
        p.style.strokeDashoffset = len;
        setTimeout(() => {
          p.style.transition = `stroke-dashoffset 0.20s ease-out`;
          p.style.strokeDashoffset = 0;
        }, i * 40);
      });
      eggSvg.style.filter = 'drop-shadow(0 0 28px rgba(253,230,138,1)) drop-shadow(0 0 60px rgba(168,85,247,0.5))';
      hint.textContent = '✦ ONE MORE! ✦';
      hint.style.color = 'rgba(168,85,247,0.9)';
      setTimeout(() => { stage.style.animation = ''; }, 400);

    } else if (tapCount >= MAX_TAPS) {
      // Third tap: HATCH!
      overlay.removeEventListener('click', doTap);
      hint.style.animation = 'none';
      hint.style.opacity = '0';

      // Final crack
      const paths = crackSvg.querySelectorAll('path');
      [paths[5]].forEach(p => {
        const len = p.getTotalLength ? p.getTotalLength() : 30;
        p.style.strokeDasharray = len;
        p.style.strokeDashoffset = len;
        p.style.transition = 'stroke-dashoffset 0.15s ease-out';
        p.style.strokeDashoffset = 0;
      });

      // Big flash
      const flash = crackSvg.querySelector('#crackFlashCirc');
      if (flash) {
        flash.style.r = '60';
        flash.style.animation = 'crackFlash 0.4s ease-out both';
      }

      setTimeout(() => {
        // Hide egg, show shell halves flying apart
        eggSvg.style.transition = 'opacity 0.15s';
        eggSvg.style.opacity = '0';
        crackSvg.style.opacity = '0';

        shellLeft.style.opacity = '1';
        shellRight.style.opacity = '1';
        shellLeft.style.animation  = 'shellHalf 0.55s cubic-bezier(0.2,0,0.8,1) forwards';
        shellRight.style.animation = 'shellHalf 0.55s cubic-bezier(0.2,0,0.8,1) forwards';
        shellLeft.style.setProperty('--shell-dest',  'translate(-60px, -30px) rotate(-35deg)');
        shellRight.style.setProperty('--shell-dest', 'translate(60px, -25px) rotate(30deg)');

        // Build + fire stars
        buildStarBurst();
        setTimeout(() => {
          starBurstSvg.style.opacity = '1';
          starBurstSvg.style.transition = 'none';
        }, 80);

        // Reveal crescent moon underneath
        setTimeout(() => {
          moonEl.style.opacity = '0';
          moonEl.innerHTML = getStreakMoonSVG('lunette', 120);
          const svgEl = moonEl.querySelector('svg');
          if (svgEl) { svgEl.style.width = '140px'; svgEl.style.height = '140px'; }
          moonEl.style.animation = 'moonReveal 0.7s cubic-bezier(0.34,1.46,0.64,1) both';
          moonEl.style.opacity = '1';
          moonEl.style.filter = 'drop-shadow(0 0 40px rgba(168,85,247,0.9))';
          moonEl.style.setProperty('animation', 'moonReveal 0.7s cubic-bezier(0.34,1.46,0.64,1) both, moonGlowPulse 2.4s ease-in-out 0.7s infinite');

          hint.textContent = '✦ LUNETTE AWAKENS ✦';
          hint.style.color = '#c084fc';
          hint.style.fontSize = '13px';
          hint.style.animation = 'tapHint 1.6s ease-in-out infinite';
          hint.style.opacity = '1';
        }, 220);

        // Close overlay after celebration
        setTimeout(() => {
          overlay.style.animation = 'hatchOverlayOut 0.5s cubic-bezier(0.4,0,1,1) forwards';
          setTimeout(() => {
            overlay.remove();
            renderStreakUI();
            if (typeof onComplete === 'function') onComplete();
          }, 480);
        }, 2800);

      }, 180);
    }
  }

  overlay.addEventListener('click', doTap);
}

function openStreakSheet() {
  const data     = loadStreakData();
  if (!data || !data.days) return;

  const tier     = getTierForDays(data.days);
  const progress = getTierProgress(data.days);
  const toNext   = getDaysToNextTier(data.days);
  const nextTier = getNextTier(tier.id);
  const mood     = (typeof lunaMood !== 'undefined') ? lunaMood : 'chill';

  const sheet = document.getElementById('streakSheet');
  const panel = document.getElementById('ssPanel');
  if (!sheet) return;

  // Set tier CSS variable on panel
  panel.setAttribute('data-streak-tier', tier.id);
  panel.setAttribute('data-mood', mood);
  panel.style.setProperty('--sdc',  tier.color);
  panel.style.setProperty('--sdc2', tier.color2);

  // ── Moon SVG: lunova is always an egg — never show mood moon face ──
  const moonEl = document.getElementById('ssMoonSvg');
  if (moonEl) {
    if (tier.id === 'lunova') {
      moonEl.innerHTML = getStreakMoonSVG('lunova', 120);
    } else {
      const moodSvg = (typeof getMoodMoonSVG === 'function') ? getMoodMoonSVG(mood, 90) : null;
      moonEl.innerHTML = moodSvg || getStreakMoonSVG(tier.id, 120);
    }
  }

  // Tier name / sub
  const tn = document.getElementById('ssTierName');
  if (tn) { tn.textContent = tier.name; tn.style.color = tier.color; }
  const ts = document.getElementById('ssTierSub');
  if (ts) ts.textContent = tier.sub;

  // ── Mood badge ──
  const moodLabels = { chill:'CHILL · NEW MOON', empathic:'EMPATHIC · CHESHIRE MOON', smart:'SMART · GALACTIC MOON', tense:'TENSE · BLOOD MOON' };
  const moodColors = { chill:'rgba(148,163,184,0.9)', empathic:'#8b5cf6', smart:'#22d3ee', tense:'#ef4444' };
  const moodDot  = document.getElementById('ssMoodDot');
  const moodLbl  = document.getElementById('ssMoodLabel');
  if (moodDot) moodDot.style.background = moodColors[mood] || tier.color;
  if (moodLbl) moodLbl.textContent = moodLabels[mood] || mood.toUpperCase();

  // Days big
  const db = document.getElementById('ssDaysBig');
  if (db) { db.textContent = data.days; db.style.color = tier.color; }

  // Progress
  const pf = document.getElementById('ssProgFill');
  if (pf) setTimeout(() => { pf.style.width = progress + '%'; }, 80);

  const pn = document.getElementById('ssProgNext');
  if (pn) {
    if (toNext) {
      pn.textContent = `${toNext} day${toNext !== 1 ? 's' : ''} to ${nextTier ? nextTier.name : ''}`;
    } else {
      pn.textContent = 'MAX TIER REACHED ✦';
    }
    pn.style.color = tier.color;
  }

  // ── Roadmap: active tier shows mood moon, others show streak moon ──
  const roadmap = document.getElementById('ssRoadmap');
  if (roadmap) {
    roadmap.innerHTML = STREAK_TIERS.map(t => {
      const isDone   = data.days > t.maxDay;
      const isActive = t.id === tier.id;
      const cls      = isActive ? 'ss-rm-item rm-active' : isDone ? 'ss-rm-item rm-done' : 'ss-rm-item';
      const iconSize = isActive ? 36 : 26;
      const moonHtml = isActive && t.id !== 'lunova' && typeof getMoodMoonSVG === 'function'
        ? (getMoodMoonSVG(mood, iconSize) || getStreakMoonSVG(t.id, iconSize))
        : getStreakMoonSVG(t.id, iconSize);
      return `<div class="${cls}">
        <div class="ss-rm-moon" style="width:${iconSize}px;height:${iconSize}px">${moonHtml}</div>
        <div class="ss-rm-label">${t.name}<br/>${t.minDay}${t.maxDay < Infinity ? '–' + t.maxDay : '+'}d</div>
      </div>`;
    }).join('');
  }

  // ── Egg Enhancements panel (injected once, updated on each open) ──
  let enhEl = document.getElementById('ssEggEnhancements');
  if (!enhEl) {
    enhEl = document.createElement('div');
    enhEl.id = 'ssEggEnhancements';
    enhEl.style.cssText = 'position:relative;z-index:1;margin-bottom:0;';
    // Insert before the close row
    const closeRow = panel.querySelector('.ss-close-row');
    if (closeRow) panel.insertBefore(enhEl, closeRow);
    else panel.appendChild(enhEl);
  }

  const glowSaved  = (() => { try { return localStorage.getItem('luna-egg-glow')  || '0.55'; } catch { return '0.55'; } })();
  // Egg size/scale feature removed
  const floatOn    = (() => { try { return JSON.parse(localStorage.getItem('luna-egg-float') ?? 'true'); } catch { return true; } })();
  const labelOn    = (() => { try { return JSON.parse(localStorage.getItem('luna-egg-label') ?? 'true'); } catch { return true; } })();

  const tc = tier.color;
  const tc2 = tier.color2 || tier.color;

  // Styled to match the streak sheet's existing design language
  enhEl.innerHTML = `
    <div style="
      margin: 0 0 22px;
      background: linear-gradient(135deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.008) 100%);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 18px;
      overflow: hidden;
    ">
      <!-- Section header -->
      <div style="
        display: flex; align-items: center; gap: 8px;
        padding: 13px 16px 11px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: linear-gradient(90deg, rgba(255,255,255,0.03) 0%, transparent 100%);
      ">
        <div style="
          width: 3px; height: 14px; border-radius: 2px;
          background: linear-gradient(to bottom, ${tc}, ${tc2});
          box-shadow: 0 0 8px ${tc}88;
          flex-shrink: 0;
        "></div>
        <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.22em;color:${tc};text-shadow:0 0 12px ${tc}66;">EGG ENHANCEMENTS</span>
      </div>

      <!-- Rows -->
      <div style="padding: 4px 0;">

        <!-- Glow Intensity -->
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,0.04);">
          <div>
            <div style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.12em;color:var(--text-hi);">Glow Intensity</div>
            <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Pulse halo brightness</div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0;">
            ${[['SUBTLE','0.30'],['NORMAL','0.55'],['INTENSE','0.85']].map(([lbl,val]) => {
              const on = glowSaved === val;
              return `<button class="ss-enh-glow-btn" onclick="
                localStorage.setItem('luna-egg-glow','${val}');
                const pill=document.getElementById('streakPill');
                if(pill) pill.style.setProperty('--egg-glow-alpha','${val}');
                document.querySelectorAll('.ss-enh-glow-btn').forEach(b=>{ b.setAttribute('data-active','0'); b.style.cssText=b.dataset.off; });
                this.setAttribute('data-active','1'); this.style.cssText=this.dataset.on;
                showToast('✦ Glow: ${lbl.toLowerCase()}','✨',1400);
              "
              data-off="padding:5px 10px;font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.11em;border-radius:20px;cursor:pointer;transition:all 0.18s;background:rgba(255,255,255,0.04);border:1.5px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.30);"
              data-on="padding:5px 10px;font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.11em;border-radius:20px;cursor:pointer;transition:all 0.18s;background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.15));border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);box-shadow:0 0 10px rgba(168,85,247,0.25);"
              style="padding:5px 10px;font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.11em;border-radius:20px;cursor:pointer;transition:all 0.18s;${on
                ? 'background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.15));border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);box-shadow:0 0 10px rgba(168,85,247,0.25);'
                : 'background:rgba(255,255,255,0.04);border:1.5px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.30);'
              }">${lbl}</button>`;
            }).join('')}
          </div>
        </div>

        <!-- Float Animation -->
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,0.04);">
          <div>
            <div style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.12em;color:var(--text-hi);">Float Animation</div>
            <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Gentle bobbing of the egg</div>
          </div>
          <button id="ssEggFloatBtn" onclick="
            const pill = document.getElementById('streakPill');
            if (!pill) return;
            const off = pill.classList.toggle('sp-no-float');
            localStorage.setItem('luna-egg-float', JSON.stringify(!off));
            const onStyle = 'background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.15));border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);box-shadow:0 0 10px rgba(168,85,247,0.25);';
            const offStyle = 'background:rgba(255,255,255,0.04);border:1.5px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.30);box-shadow:none;';
            this.textContent = off ? 'OFF' : 'ON';
            this.style.cssText = 'flex-shrink:0;min-width:54px;padding:6px 0;font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;border-radius:20px;cursor:pointer;transition:all 0.2s;' + (off ? offStyle : onStyle);
            showToast(off ? '🥚 Float paused' : '🥚 Float on','🥚',1400);
          " style="flex-shrink:0;min-width:54px;padding:6px 0;font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;border-radius:20px;cursor:pointer;transition:all 0.2s;${floatOn
            ? 'background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.15));border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);box-shadow:0 0 10px rgba(168,85,247,0.25);'
            : 'background:rgba(255,255,255,0.04);border:1.5px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.30);'
          }">${floatOn ? 'ON' : 'OFF'}</button>
        </div>


        <!-- Mood Label -->
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,0.04);">
          <div>
            <div style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.12em;color:var(--text-hi);">Mood Label</div>
            <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Moon name below egg</div>
          </div>
          <button id="ssEggLabelBtn" onclick="
            const pill = document.getElementById('streakPill');
            const lbl  = document.getElementById('spPillName');
            if (!pill || !lbl) return;
            const hidden = lbl.style.display === 'none';
            lbl.style.display = hidden ? '' : 'none';
            localStorage.setItem('luna-egg-label', JSON.stringify(hidden));
            const onStyle = 'background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.15));border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);box-shadow:0 0 10px rgba(168,85,247,0.25);';
            const offStyle = 'background:rgba(255,255,255,0.04);border:1.5px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.30);box-shadow:none;';
            this.textContent = hidden ? 'ON' : 'OFF';
            this.style.cssText = 'flex-shrink:0;min-width:54px;padding:6px 0;font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;border-radius:20px;cursor:pointer;transition:all 0.2s;' + (hidden ? onStyle : offStyle);
          " style="flex-shrink:0;min-width:54px;padding:6px 0;font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;border-radius:20px;cursor:pointer;transition:all 0.2s;${labelOn
            ? 'background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.15));border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);box-shadow:0 0 10px rgba(168,85,247,0.25);'
            : 'background:rgba(255,255,255,0.04);border:1.5px solid rgba(255,255,255,0.09);color:rgba(255,255,255,0.30);'
          }">${labelOn ? 'ON' : 'OFF'}</button>
        </div>

        <!-- Pet Behavior Info -->
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;">
          <div>
            <div style="font-family:var(--font-hud);font-size:9px;letter-spacing:0.12em;color:var(--text-hi);">Pet Behavior</div>
            <div style="font-family:var(--font-body);font-size:10px;color:var(--text-lo);margin-top:2px;">Unlocks as your streak grows ✦</div>
          </div>
          <span style="flex-shrink:0;padding:5px 10px;font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.11em;border-radius:20px;background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.15));border:1.5px solid rgba(168,85,247,0.55);color:var(--violet-bright);">DAY ${data ? data.days : '?'}</span>
        </div>

      </div>
    </div>
  `;

  sheet.classList.add('ss-open');
  document.body.style.overflow = 'hidden';
}

function closeStreakSheet() {
  const sheet = document.getElementById('streakSheet');
  const panel = document.getElementById('ssPanel');
  if (!sheet || !panel) return;
  panel.classList.add('ss-closing');
  panel.addEventListener('animationend', () => {
    panel.classList.remove('ss-closing');
    sheet.classList.remove('ss-open');
    document.body.style.overflow = '';
    // Reset progress bar so it animates next open
    const pf = document.getElementById('ssProgFill');
    if (pf) pf.style.width = '0%';
  }, { once: true });
}

// ── Admin leaderboard ─────────────────────────────────────────────
async function refreshStreakLeaderboard() {
  const el = document.getElementById('streakLeaderboardList');
  if (!el) return;
  if (!firebaseReady || !firebaseDb) {
    el.innerHTML = '<div class="admin-empty">◈ Firebase not available.</div>'; return;
  }
  el.innerHTML = '<div class="admin-empty">◈ Loading streak data…</div>';
  try {
    const snap     = await firebaseDb.ref('luna-accounts').once('value');
    const accounts = snap.val() || {};
    const rows     = Object.entries(accounts)
      .filter(([, acc]) => acc.streak && acc.streak.days > 0)
      .map(([, acc]) => ({ name: acc.name || '—', ...acc.streak }))
      .sort((a, b) => (b.days || 0) - (a.days || 0));

    if (!rows.length) {
      el.innerHTML = '<div class="admin-empty">◈ No streak data yet.</div>'; return;
    }

    el.innerHTML = rows.map((r, i) => {
      const tier     = getTierForDays(r.days || 0);
      const medal    = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      const isStale  = r.lastDate && (Date.now() - new Date(r.lastDate).getTime()) > 172800000;
      const statusBadge = isStale
        ? `<span class="slb-tier" style="color:var(--crimson-bright);border-color:rgba(236,45,90,0.3);">INACTIVE</span>`
        : `<span class="slb-tier" style="color:var(--green);border-color:rgba(52,211,153,0.3);">ACTIVE</span>`;
      return `<div class="streak-lb-row">
        <span class="slb-rank">${medal}</span>
        <span class="slb-moon">${tier.emoji}</span>
        <span class="slb-name">◈ ${escHtml(r.name)}</span>
        <span class="slb-days" style="color:${tier.color}">${r.days} <span style="font-size:8px;opacity:0.6;font-family:var(--font-hud);">DAYS</span></span>
        <span class="slb-tier" style="color:${tier.color};border-color:${tier.color}44;">${tier.name}</span>
        ${statusBadge}
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = `<div class="admin-empty">◈ Failed: ${e.message}</div>`;
  }
}

// ── Hook into enterChat ───────────────────────────────────────────
const _origEnterChat = enterChat;
enterChat = async function(name, key, isGuest = false) {
  await _origEnterChat(name, key, isGuest);
  // Small delay so UI is settled before streak renders
  setTimeout(() => {
    const data = computeStreak();
    if (data && data.days > 0) {
      // Initialize egg-born timestamp on the very first day if not set
      if (data.days === 1) {
        try {
          if (!localStorage.getItem(_eggBornKey())) {
            localStorage.setItem(_eggBornKey(), String(Date.now()));
          }
        } catch {}
      }
      renderStreakUI();
      // If day 3 just reached (lunova→lunette), show the hatch animation
      if (shouldShowHatchAnimation()) {
        setTimeout(() => showEggHatchOverlay(), 1200);
      }
      // Check frozen / rotten state
      setTimeout(checkStreakState, 600);
    }
  }, 800);
};

// ╔══════════════════════════════════════════════════════════════════════╗
// ║       LUNA AI — ADMIN PANEL ENHANCEMENTS v1.0                        ║
// ║  7 new features: Analytics · System Prompt · MOTD · User Manager     ║
// ║  AI Config · AutoMod Tuner · Token Limiter                           ║
// ║                                                                       ║
// ║  HOW TO USE:                                                          ║
// ║  1. Include this file AFTER script.js in your index.html:            ║
// ║     <script src="admin-enhancements.js"></script>                     ║
// ║  2. Paste the HTML block below into your adminPanel's admin-body div  ║
// ║     (right before the closing </div> of admin-body)                   ║
// ╚══════════════════════════════════════════════════════════════════════╝

// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 1 — ANALYTICS DASHBOARD
//   Shows message volume, active users by day, top users by count
// ══════════════════════════════════════════════════════════════════

async function loadAdminAnalytics() {
  const el = document.getElementById('adminAnalyticsPanel');
  if (!el) return;
  el.innerHTML = '<div class="admin-empty">◈ Loading analytics…</div>';

  if (!firebaseReady || !firebaseDb) {
    el.innerHTML = '<div class="admin-empty">◈ Firebase offline.</div>';
    return;
  }

  try {
    const [chatSnap, accountSnap, presenceSnap] = await Promise.all([
      firebaseDb.ref('luna-chat-log').once('value'),
      firebaseDb.ref('luna-accounts').once('value'),
      firebaseDb.ref('luna-presence').once('value'),
    ]);

    const messages  = chatSnap.val()    ? Object.values(chatSnap.val())    : [];
    const accounts  = accountSnap.val() ? Object.values(accountSnap.val()) : [];
    const presence  = presenceSnap.val()? Object.values(presenceSnap.val()): [];

    // Basic counts
    const totalMsgs   = messages.length;
    const userMsgs    = messages.filter(m => m.role !== 'assistant').length;
    const lunaMsgs    = messages.filter(m => m.role === 'assistant').length;
    const totalAccts  = accounts.length;
    const onlineNow   = presence.filter(p => p.online).length;

    // Messages per day (last 7 days)
    const now        = Date.now();
    const dayMs      = 86400000;
    const dayBuckets = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * dayMs);
      const key = `${d.getMonth()+1}/${d.getDate()}`;
      dayBuckets[key] = 0;
    }
    messages.forEach(m => {
      if (!m.ts) return;
      const d   = new Date(m.ts);
      const key = `${d.getMonth()+1}/${d.getDate()}`;
      if (key in dayBuckets) dayBuckets[key]++;
    });

    const maxDay = Math.max(...Object.values(dayBuckets), 1);

    // Top users by message count
    const userCounts = {};
    messages.filter(m => m.role !== 'assistant' && m.user).forEach(m => {
      userCounts[m.user] = (userCounts[m.user] || 0) + 1;
    });
    const topUsers = Object.entries(userCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    el.innerHTML = `
      <!-- ◈ Overview Stats -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:18px;">
        ${[
          ['💬', 'TOTAL MSGS',    totalMsgs,  'var(--violet-bright)'],
          ['👤', 'USER MSGS',     userMsgs,   'var(--cyan)'],
          ['◈',  'LUNA REPLIES',  lunaMsgs,   'var(--crimson-bright)'],
          ['🔑', 'ACCOUNTS',      totalAccts, 'var(--gold)'],
          ['🟢', 'ONLINE NOW',    onlineNow,  'var(--green)'],
        ].map(([icon, label, val, color]) => `
          <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center;">
            <div style="font-size:18px;margin-bottom:4px;">${icon}</div>
            <div style="font-family:var(--font-hud);font-size:18px;font-weight:900;color:${color};line-height:1;">${val}</div>
            <div style="font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.14em;color:var(--text-lo);margin-top:3px;">${label}</div>
          </div>
        `).join('')}
      </div>

      <!-- ◈ 7-Day Bar Chart -->
      <div style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.14em;color:var(--text-lo);margin-bottom:10px;">◈ MESSAGES — LAST 7 DAYS</div>
      <div style="display:flex;align-items:flex-end;gap:6px;height:64px;margin-bottom:6px;">
        ${Object.entries(dayBuckets).map(([day, count]) => {
          const h = Math.max(4, Math.round((count / maxDay) * 60));
          const isToday = (() => {
            const d = new Date(); return `${d.getMonth()+1}/${d.getDate()}` === day;
          })();
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;">
            <div style="font-family:var(--font-hud);font-size:8px;color:var(--text-lo);">${count||''}</div>
            <div style="width:100%;height:${h}px;border-radius:4px 4px 0 0;
              background:${isToday ? 'linear-gradient(180deg,var(--violet-bright),var(--violet))' : 'rgba(168,85,247,0.25)'};
              box-shadow:${isToday ? '0 0 8px rgba(168,85,247,0.45)' : 'none'};
              transition:height 0.5s ease;"></div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:6px;">
        ${Object.keys(dayBuckets).map(day => `
          <div style="flex:1;text-align:center;font-family:var(--font-hud);font-size:7px;letter-spacing:0.08em;color:var(--text-lo);">${day}</div>
        `).join('')}
      </div>

      <!-- ◈ Top Users -->
      ${topUsers.length ? `
        <div style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.14em;color:var(--text-lo);margin:16px 0 8px;">◈ TOP USERS BY MESSAGE COUNT</div>
        ${topUsers.map(([name, cnt], i) => {
          const pct = Math.round(cnt / userMsgs * 100);
          const medals = ['🥇','🥈','🥉','#4','#5'];
          return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="font-size:13px;width:20px;">${medals[i]}</span>
            <span style="flex:1;font-family:var(--font-body);font-size:12px;color:var(--text-hi);">◈ ${escHtml(name)}</span>
            <div style="width:80px;height:4px;background:rgba(255,255,255,0.07);border-radius:4px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--violet),var(--violet-bright));border-radius:4px;"></div>
            </div>
            <span style="font-family:var(--font-hud);font-size:9px;color:var(--text-mid);min-width:32px;text-align:right;">${cnt}</span>
          </div>`;
        }).join('')}
      ` : '<div class="admin-empty">◈ No user messages yet.</div>'}

      <!-- ◈ Export Button -->
      <div style="margin-top:12px;text-align:right;">
        <button onclick="exportAnalyticsCSV()" class="admin-add-btn" style="font-size:8.5px;">⬇ EXPORT CSV</button>
      </div>
    `;
  } catch(e) {
    el.innerHTML = `<div class="admin-empty">◈ Failed: ${e.message}</div>`;
  }
}

async function exportAnalyticsCSV() {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', '⚠️'); return; }
  const snap = await firebaseDb.ref('luna-chat-log').once('value');
  const messages = snap.val() ? Object.values(snap.val()) : [];
  const rows = [['Timestamp','Role','User','Preview']];
  messages.forEach(m => {
    rows.push([
      m.ts ? new Date(m.ts).toLocaleString() : '',
      m.role || '',
      m.user || '',
      (m.text || '').replace(/,/g, ';').slice(0, 120),
    ]);
  });
  const csv  = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `luna-analytics-${Date.now()}.csv` });
  a.click();
  showToast('Analytics exported ✦', '⬇', 2000);
}


// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 2 — SYSTEM PROMPT EDITOR
//   Admin can live-edit LUNA's system prompt and push it to Firebase.
//   All connected sessions read it on their next message.
// ══════════════════════════════════════════════════════════════════

let _customSystemPrompt = null; // null = use built-in LUNA_SYSTEM_PROMPT

async function loadCustomSystemPrompt() {
  if (!firebaseReady || !firebaseDb) return;
  try {
    const snap = await firebaseDb.ref('luna-config/systemPrompt').once('value');
    const val  = snap.val();
    if (val && val.trim()) {
      _customSystemPrompt = val.trim();
    }
  } catch {}
}

// Watch for live changes pushed by admin
function watchCustomSystemPrompt() {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref('luna-config/systemPrompt').on('value', snap => {
    const val = snap.val();
    _customSystemPrompt = (val && val.trim()) ? val.trim() : null;
  });
}

async function saveCustomSystemPrompt() {
  const ta  = document.getElementById('sysPromptEditor');
  const msg = document.getElementById('sysPromptMsg');
  if (!ta || !msg) return;
  const text = ta.value.trim();
  if (!text) { msg.textContent = '◈ Prompt cannot be empty.'; msg.style.color = 'var(--crimson-bright)'; return; }
  if (!firebaseReady || !firebaseDb) { msg.textContent = '◈ Firebase offline.'; msg.style.color = 'var(--crimson-bright)'; return; }
  try {
    await firebaseDb.ref('luna-config/systemPrompt').set(text);
    msg.textContent = '◈ System prompt updated — all sessions will use it on next message. ✦';
    msg.style.color = 'var(--green)';
    setTimeout(() => { msg.textContent = ''; }, 4000);
  } catch(e) {
    msg.textContent = '◈ Failed: ' + e.message;
    msg.style.color = 'var(--crimson-bright)';
  }
}

async function resetSystemPrompt() {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', '⚠️'); return; }
  if (!window.confirm('Reset system prompt to the built-in default?')) return;
  try {
    await firebaseDb.ref('luna-config/systemPrompt').remove();
    _customSystemPrompt = null;
    const ta  = document.getElementById('sysPromptEditor');
    if (ta) ta.value = '';
    showToast('◈ System prompt reset to default ✦', '🔄');
  } catch(e) {
    showToast('Failed: ' + e.message, '⚠️');
  }
}

function loadSysPromptIntoEditor() {
  const ta = document.getElementById('sysPromptEditor');
  if (!ta) return;
  if (_customSystemPrompt) {
    ta.value = _customSystemPrompt;
  } else {
    // Load the built-in prompt so admin can see it and edit from there
    ta.value = (typeof LUNA_SYSTEM_PROMPT !== 'undefined') ? LUNA_SYSTEM_PROMPT.trim() : '';
  }
}

// Patch buildSystemPromptWithStatuses to use admin-set prompt if present
(function patchSystemPrompt() {
  if (typeof buildSystemPromptWithStatuses !== 'function') return;
  const _orig = buildSystemPromptWithStatuses;
  buildSystemPromptWithStatuses = function() {
    if (!_customSystemPrompt) return _orig();
    // Replace only the LUNA_SYSTEM_PROMPT part, keep status blocks + memory
    let base = _customSystemPrompt;
    // Append status block if needed
    try {
      const result = _orig();
      // Extract the prefix (status block before "You are LUNA")
      const lunaIdx = result.indexOf('You are LUNA');
      if (lunaIdx > 0) {
        const statusPrefix = result.slice(0, lunaIdx);
        const suffix = result.slice(result.indexOf(_orig().split(LUNA_SYSTEM_PROMPT)[1] || ''));
        base = statusPrefix + base + (result.split(LUNA_SYSTEM_PROMPT)[1] || '');
      }
    } catch {}
    return base;
  };
})();


// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 3 — MESSAGE OF THE DAY (MOTD)
//   Admin sets a message that pops up for all users when they log in.
// ══════════════════════════════════════════════════════════════════

async function saveMOTD() {
  const inp = document.getElementById('motdInput');
  const msg = document.getElementById('motdMsg');
  if (!inp || !msg) return;
  const text = inp.value.trim();
  if (!firebaseReady || !firebaseDb) { msg.textContent = '◈ Firebase offline.'; msg.style.color = 'var(--crimson-bright)'; return; }
  try {
    if (text) {
      await firebaseDb.ref('luna-config/motd').set({ text, ts: Date.now(), by: userName || 'Admin' });
      msg.textContent = '◈ MOTD saved — users will see it on next login. ✦';
      msg.style.color = 'var(--green)';
    } else {
      await firebaseDb.ref('luna-config/motd').remove();
      msg.textContent = '◈ MOTD cleared.';
      msg.style.color = 'var(--text-lo)';
    }
    setTimeout(() => { msg.textContent = ''; }, 4000);
  } catch(e) {
    msg.textContent = '◈ Failed: ' + e.message;
    msg.style.color = 'var(--crimson-bright)';
  }
}

async function loadMOTDForEdit() {
  if (!firebaseReady || !firebaseDb) return;
  try {
    const snap = await firebaseDb.ref('luna-config/motd').once('value');
    const val  = snap.val();
    const inp  = document.getElementById('motdInput');
    if (inp && val && val.text) inp.value = val.text;
  } catch {}
}

// Called after user logs in — checks for MOTD and shows it
async function checkAndShowMOTD() {
  if (!firebaseReady || !firebaseDb) return;
  try {
    const snap = await firebaseDb.ref('luna-config/motd').once('value');
    const val  = snap.val();
    if (!val || !val.text) return;

    // Only show if the user hasn't dismissed this exact MOTD (track by ts)
    const dismissKey = `luna-motd-dismissed-${val.ts}`;
    if (localStorage.getItem(dismissKey)) return;

    // Show a styled banner at top of chat
    const banner = document.createElement('div');
    banner.id = 'motdBanner';
    banner.style.cssText = [
      'display:flex;align-items:flex-start;gap:12px;',
      'padding:14px 16px;margin:12px 0 0;',
      'background:linear-gradient(135deg,rgba(168,85,247,0.10),rgba(236,45,90,0.06));',
      'border:1px solid rgba(168,85,247,0.28);border-radius:12px;',
      'animation:fadeIn 0.4s ease both;',
    ].join('');
    banner.innerHTML = `
      <div style="font-size:20px;flex-shrink:0;margin-top:2px;">📣</div>
      <div style="flex:1;min-width:0;">
        <div style="font-family:var(--font-hud);font-size:8px;letter-spacing:0.18em;color:var(--violet-bright);margin-bottom:5px;">◈ SYSTEM MESSAGE</div>
        <div style="font-size:13px;color:var(--text-hi);line-height:1.6;">${escHtml(val.text)}</div>
        ${val.ts ? `<div style="font-family:var(--font-hud);font-size:7.5px;color:var(--text-lo);margin-top:5px;">Posted ${timeAgo(val.ts)}</div>` : ''}
      </div>
      <button onclick="
        localStorage.setItem('luna-motd-dismissed-${val.ts}', '1');
        this.closest('#motdBanner').remove();
      " style="flex-shrink:0;background:none;border:none;color:var(--text-lo);cursor:pointer;font-size:16px;padding:2px 4px;line-height:1;">✕</button>
    `;
    const feed = document.getElementById('chatFeed');
    if (feed) feed.prepend(banner);
  } catch {}
}

// Hook checkAndShowMOTD into enterChat
(function hookMOTD() {
  const _origEnter = typeof enterChat === 'function' ? enterChat : null;
  if (!_origEnter) { window.addEventListener('DOMContentLoaded', hookMOTD); return; }
  // Only wrap if not already wrapped
  if (enterChat._motdHooked) return;
  const _wrapped = async function(name, key, isGuest = false) {
    await _origEnter(name, key, isGuest);
    setTimeout(() => checkAndShowMOTD(), 900);
  };
  _wrapped._motdHooked = true;
  // enterChat is redefined in the streak hook in script.js; we let that happen naturally
  // and instead call checkAndShowMOTD from a custom event
})();


// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 4 — USER PROFILE MANAGER
//   View, edit, reset any user account from admin panel
// ══════════════════════════════════════════════════════════════════

async function adminLoadUserList() {
  const el = document.getElementById('adminUserListBody');
  if (!el) return;
  el.innerHTML = '<div class="admin-empty">◈ Loading users…</div>';
  if (!firebaseReady || !firebaseDb) { el.innerHTML = '<div class="admin-empty">◈ Firebase offline.</div>'; return; }
  try {
    const snap  = await firebaseDb.ref('luna-accounts').once('value');
    const data  = snap.val() || {};
    const users = Object.entries(data);

    if (!users.length) { el.innerHTML = '<div class="admin-empty">◈ No registered accounts yet.</div>'; return; }

    el.innerHTML = users.map(([key, acc]) => {
      const created = acc.createdAt ? new Date(acc.createdAt).toLocaleDateString() : '—';
      const streak  = acc.streak ? acc.streak.days || 0 : 0;
      return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.04);flex-wrap:wrap;gap:6px;">
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--crimson-dim),var(--violet-dim));border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-family:var(--font-hud);font-size:10px;flex-shrink:0;">${(acc.name||'?').slice(0,2).toUpperCase()}</div>
        <div style="flex:1;min-width:100px;">
          <div style="font-family:var(--font-body);font-size:12px;color:var(--text-hi);">◈ ${escHtml(acc.name||'—')}</div>
          <div style="font-family:var(--font-hud);font-size:7.5px;letter-spacing:0.1em;color:var(--text-lo);margin-top:2px;">Joined ${created} · 🔥 ${streak} day streak</div>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="asi-del" onclick="adminViewUser('${escHtml(key)}','${escHtml(acc.name||'')}')">INFO</button>
          <button class="asi-del" onclick="adminResetUserPassword('${escHtml(key)}','${escHtml(acc.name||'')}')">RESET PW</button>
          <button class="asi-del" onclick="adminResetUserStreak('${escHtml(key)}','${escHtml(acc.name||'')}')">RESET STREAK</button>
          <button class="asi-del ban-btn-r" onclick="adminDeleteUser('${escHtml(key)}','${escHtml(acc.name||'')}')">DELETE</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = `<div class="admin-empty">◈ Error: ${e.message}</div>`;
  }
}

async function adminViewUser(key, name) {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline','⚠️'); return; }
  try {
    const snap = await firebaseDb.ref(`luna-accounts/${key}`).once('value');
    const acc  = snap.val() || {};

    // Count from per-user chatlog (accurate, never mixed with other users)
    const logSnap  = await firebaseDb.ref(`luna-user-chatlogs/${key}`).once('value');
    const logData  = logSnap.val() || {};
    const allMsgs  = Object.values(logData);
    const userMsgs = allMsgs.filter(m => m.role === 'user').length;
    const lunaMsgs = allMsgs.filter(m => m.role === 'assistant').length;
    const msgCount = allMsgs.length;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:460px;">
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕ CLOSE</button>
        <h2 class="modal-title">◈ USER PROFILE — ${escHtml(name||key)}</h2>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px;">
          ${[
            ['Firebase Key', key],
            ['Display Name', acc.name || '—'],
            ['Joined',       acc.createdAt ? new Date(acc.createdAt).toLocaleString() : '—'],
            ['Total Messages', `${msgCount} (${userMsgs} sent · ${lunaMsgs} received)`],
            ['Streak Days',  acc.streak ? (acc.streak.days || 0) + ' days' : '0 days'],
            ['Streak Tier',  acc.streak ? (acc.streak.tier || '—') : '—'],
            ['Groq Key',     acc.groqKey ? '⚡ Custom key on file' : '🔑 Using global key'],
            ['Security Q',   acc.secQ || '—'],
          ].map(([k,v]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
              <span style="font-family:var(--font-hud);font-size:8px;letter-spacing:0.14em;color:var(--text-lo);">${k}</span>
              <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-mid);text-align:right;max-width:260px;word-break:break-all;">${escHtml(String(v))}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  } catch(e) {
    showToast('Failed: ' + e.message, '⚠️');
  }
}

async function adminResetUserPassword(key, name) {
  const newPw = window.prompt(`Set new password for "${name}":`);
  if (!newPw || newPw.length < 4) { showToast('Password too short (min 4 chars)', '⚠️'); return; }
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', '⚠️'); return; }
  try {
    await firebaseDb.ref(`luna-accounts/${key}`).update({ password: btoa(newPw) });
    showToast(`✦ Password reset for ${name}`, '🔑');
  } catch(e) {
    showToast('Failed: ' + e.message, '⚠️');
  }
}

async function adminResetUserStreak(key, name) {
  if (!window.confirm(`Reset streak for "${name}"? This cannot be undone.`)) return;
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', '⚠️'); return; }
  try {
    await firebaseDb.ref(`luna-accounts/${key}/streak`).remove();
    showToast(`◈ Streak reset for ${name} ✦`, '🔥');
    adminLoadUserList();
  } catch(e) {
    showToast('Failed: ' + e.message, '⚠️');
  }
}

async function adminDeleteUser(key, name) {
  if (!window.confirm(`Permanently delete account "${name}"? ALL data will be lost.`)) return;
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', '⚠️'); return; }
  try {
    await Promise.all([
      firebaseDb.ref(`luna-accounts/${key}`).remove(),
      firebaseDb.ref(`luna-presence/${key}`).remove(),
      firebaseDb.ref(`luna-user-chatlogs/${key}`).remove(),
      firebaseDb.ref(`luna-user-profiles/${key}`).remove(),
      firebaseDb.ref(`luna-sessions/${key}`).remove(),
      firebaseDb.ref(`luna-bans/${key}`).remove(),
    ]);
    showToast(`◈ Account "${name}" deleted ✦`, '🗑', 3000);
    adminLoadUserList();
  } catch(e) {
    showToast('Failed: ' + e.message, '⚠️');
  }
}


// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 5 — AI CONFIGURATION PANEL
//   Change the active Groq model, global API key, and max tokens live
// ══════════════════════════════════════════════════════════════════

const AVAILABLE_MODELS = [
  { id: 'openai/gpt-oss-120b',                          label: 'GPT-OSS 120B (default)' },
  { id: 'llama-3.3-70b-versatile',                      label: 'Llama 3.3 70B Versatile' },
  { id: 'llama-3.1-8b-instant',                         label: 'Llama 3.1 8B Instant (fast)' },
  { id: 'meta-llama/llama-4-maverick-17b-128e-instruct',label: 'Llama 4 Maverick 17B' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct',    label: 'Llama 4 Scout 17B' },
  { id: 'mistral-saba-24b',                             label: 'Mistral Saba 24B' },
  { id: 'deepseek-r1-distill-llama-70b',                label: 'DeepSeek R1 Llama 70B' },
  { id: 'gemma2-9b-it',                                 label: 'Gemma 2 9B IT' },
];

function populateModelSelector() {
  const sel = document.getElementById('adminModelSelect');
  if (!sel) return;
  sel.innerHTML = AVAILABLE_MODELS.map(m =>
    `<option value="${m.id}" ${m.id === (typeof API_MODEL !== 'undefined' ? API_MODEL : '') ? 'selected' : ''}>${m.label}</option>`
  ).join('');
}

async function applyAIConfig() {
  const modelEl   = document.getElementById('adminModelSelect');
  const keyEl     = document.getElementById('adminGlobalKeyInput');
  const maxTokEl  = document.getElementById('adminMaxTokensInput');
  const msg       = document.getElementById('aiConfigMsg');
  if (!msg) return;

  let changed = false;

  // Model switch
  if (modelEl && modelEl.value) {
    if (typeof API_MODEL !== 'undefined') {
      window.API_MODEL = modelEl.value;
    }
    // Also push to Firebase so all sessions can optionally read it
    if (firebaseReady && firebaseDb) {
      await firebaseDb.ref('luna-config/model').set(modelEl.value).catch(()=>{});
    }
    changed = true;
  }

  // Global API key override
  if (keyEl && keyEl.value.trim().startsWith('gsk_')) {
    if (typeof API_KEY !== 'undefined') window.API_KEY = keyEl.value.trim();
    if (firebaseReady && firebaseDb) {
      await firebaseDb.ref('luna-config/globalKey').set(keyEl.value.trim()).catch(()=>{});
    }
    keyEl.value = '';
    changed = true;
  } else if (keyEl && keyEl.value.trim() && !keyEl.value.trim().startsWith('gsk_')) {
    msg.textContent = '◈ API key must start with gsk_';
    msg.style.color = 'var(--crimson-bright)';
    return;
  }

  // Max tokens override (per-request)
  if (maxTokEl && maxTokEl.value) {
    const val = parseInt(maxTokEl.value);
    if (val > 0 && val <= 32768) {
      window._adminMaxTokens = val;
      changed = true;
    }
  }

  if (changed) {
    msg.textContent = '◈ AI config applied — takes effect on next message. ✦';
    msg.style.color = 'var(--green)';
    setTimeout(() => { msg.textContent = ''; }, 4000);
    showToast('⚡ AI config updated ✦', '⚡');
  } else {
    msg.textContent = '◈ No changes detected.';
    msg.style.color = 'var(--text-lo)';
  }
}

// Watch Firebase for model changes (so all sessions sync)
function watchAIConfig() {
  if (!firebaseReady || !firebaseDb) return;
  firebaseDb.ref('luna-config/model').on('value', snap => {
    const val = snap.val();
    if (val && typeof API_MODEL !== 'undefined' && val !== API_MODEL) {
      window.API_MODEL = val;
    }
  });
}


// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 6 — AUTO-MOD SENSITIVITY TUNER
//   Visual sliders to adjust warn/suspend/ban strike thresholds
// ══════════════════════════════════════════════════════════════════

function renderAutoModTuner() {
  const container = document.getElementById('autoModTunerBody');
  if (!container) return;

  const warnAt    = getAutoModSetting('warnAt', 2);
  const suspendAt = getAutoModSetting('suspendAt', 4);
  const banAt     = getAutoModSetting('banAt', 7);
  const suspHrs   = getAutoModSetting('suspendHours', 24);

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;">

      <!-- Warn threshold -->
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.12em;color:var(--gold);">⚠ WARN AFTER N STRIKES</span>
          <span id="amtWarnVal" style="font-family:var(--font-hud);font-size:9px;color:var(--gold);">${warnAt}</span>
        </div>
        <input type="range" min="1" max="10" step="1" value="${warnAt}" id="amtWarnSlider"
          oninput="document.getElementById('amtWarnVal').textContent=this.value"
          style="width:100%;accent-color:var(--gold);">
        <div style="display:flex;justify-content:space-between;font-family:var(--font-hud);font-size:7px;color:var(--text-lo);margin-top:2px;"><span>1 (strictest)</span><span>10 (lenient)</span></div>
      </div>

      <!-- Suspend threshold -->
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.12em;color:var(--crimson-bright);">⏳ SUSPEND AFTER N STRIKES</span>
          <span id="amtSuspVal" style="font-family:var(--font-hud);font-size:9px;color:var(--crimson-bright);">${suspendAt}</span>
        </div>
        <input type="range" min="2" max="20" step="1" value="${suspendAt}" id="amtSuspSlider"
          oninput="document.getElementById('amtSuspVal').textContent=this.value"
          style="width:100%;accent-color:var(--crimson-bright);">
        <div style="display:flex;justify-content:space-between;font-family:var(--font-hud);font-size:7px;color:var(--text-lo);margin-top:2px;"><span>2</span><span>20</span></div>
      </div>

      <!-- Suspend duration -->
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.12em;color:var(--cyan);">🕐 SUSPEND DURATION (HOURS)</span>
          <span id="amtSuspHrsVal" style="font-family:var(--font-hud);font-size:9px;color:var(--cyan);">${suspHrs}h</span>
        </div>
        <input type="range" min="1" max="168" step="1" value="${suspHrs}" id="amtSuspHrsSlider"
          oninput="document.getElementById('amtSuspHrsVal').textContent=this.value+'h'"
          style="width:100%;accent-color:var(--cyan);">
        <div style="display:flex;justify-content:space-between;font-family:var(--font-hud);font-size:7px;color:var(--text-lo);margin-top:2px;"><span>1h</span><span>168h (1wk)</span></div>
      </div>

      <!-- Ban threshold -->
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.12em;" style="color:#ff2244;">🚫 BAN AFTER N STRIKES</span>
          <span id="amtBanVal" style="font-family:var(--font-hud);font-size:9px;color:var(--crimson-bright);">${banAt}</span>
        </div>
        <input type="range" min="3" max="30" step="1" value="${banAt}" id="amtBanSlider"
          oninput="document.getElementById('amtBanVal').textContent=this.value"
          style="width:100%;accent-color:#ff2244;">
        <div style="display:flex;justify-content:space-between;font-family:var(--font-hud);font-size:7px;color:var(--text-lo);margin-top:2px;"><span>3</span><span>30</span></div>
      </div>

      <button onclick="saveAutoModTuner()" class="admin-add-btn" style="align-self:flex-end;">◈ SAVE THRESHOLDS</button>
      <div id="autoModTunerMsg" style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.1em;min-height:14px;"></div>
    </div>
  `;
}

function saveAutoModTuner() {
  const msg     = document.getElementById('autoModTunerMsg');
  const warn    = parseInt(document.getElementById('amtWarnSlider')?.value || 2);
  const susp    = parseInt(document.getElementById('amtSuspSlider')?.value || 4);
  const suspHrs = parseInt(document.getElementById('amtSuspHrsSlider')?.value || 24);
  const ban     = parseInt(document.getElementById('amtBanSlider')?.value || 7);

  if (warn >= susp || susp >= ban) {
    if (msg) { msg.textContent = '◈ Invalid thresholds: Warn < Suspend < Ban required.'; msg.style.color = 'var(--crimson-bright)'; }
    return;
  }

  setAutoModSetting('warnAt',    warn);
  setAutoModSetting('suspendAt', susp);
  setAutoModSetting('suspendHours', suspHrs);
  setAutoModSetting('banAt',     ban);

  if (msg) { msg.textContent = `◈ Saved: Warn @${warn} · Suspend @${susp} (${suspHrs}h) · Ban @${ban} ✦`; msg.style.color = 'var(--green)'; }
  showToast('◈ Auto-mod thresholds saved ✦', '⚙️');
  setTimeout(() => { if (msg) msg.textContent = ''; }, 4000);
}


// ══════════════════════════════════════════════════════════════════
// ◈ FEATURE 7 — PER-USER TOKEN LIMIT OVERRIDE
//   Admin can set a custom daily token cap per user, independent of
//   the global TOKEN_DAILY_LIMIT constant.
// ══════════════════════════════════════════════════════════════════

async function saveUserTokenLimit() {
  const nameEl  = document.getElementById('utlUsername');
  const limitEl = document.getElementById('utlLimit');
  const msg     = document.getElementById('utlMsg');
  if (!nameEl || !limitEl || !msg) return;

  const username = nameEl.value.trim();
  const limit    = parseInt(limitEl.value);

  if (!username) { msg.textContent = '◈ Enter a username.'; msg.style.color = 'var(--gold)'; return; }
  if (!limit || limit < 1000) { msg.textContent = '◈ Minimum limit is 1,000 tokens.'; msg.style.color = 'var(--gold)'; return; }
  if (!firebaseReady || !firebaseDb) { msg.textContent = '◈ Firebase offline.'; msg.style.color = 'var(--crimson-bright)'; return; }

  const ukey = userKey(username);
  try {
    await firebaseDb.ref(`luna-accounts/${ukey}/tokenLimit`).set(limit);
    msg.textContent = `◈ Daily token limit for "${username}" set to ${limit.toLocaleString()} ✦`;
    msg.style.color = 'var(--green)';
    limitEl.value = '';
    nameEl.value  = '';
    setTimeout(() => { msg.textContent = ''; }, 4000);
    loadTokenLimitList();
  } catch(e) {
    msg.textContent = '◈ Failed: ' + e.message;
    msg.style.color = 'var(--crimson-bright)';
  }
}

async function clearUserTokenLimit(username, ukey) {
  if (!firebaseReady || !firebaseDb) { showToast('Firebase offline', '⚠️'); return; }
  try {
    await firebaseDb.ref(`luna-accounts/${ukey}/tokenLimit`).remove();
    showToast(`◈ Token limit removed for ${username} — using global limit ✦`, '✅');
    loadTokenLimitList();
  } catch(e) {
    showToast('Failed: ' + e.message, '⚠️');
  }
}

async function loadTokenLimitList() {
  const el = document.getElementById('utlList');
  if (!el) return;
  if (!firebaseReady || !firebaseDb) { el.innerHTML = '<div class="admin-empty">◈ Firebase offline.</div>'; return; }

  try {
    const snap    = await firebaseDb.ref('luna-accounts').once('value');
    const data    = snap.val() || {};
    const entries = Object.entries(data)
      .filter(([, acc]) => acc.tokenLimit)
      .map(([key, acc]) => ({ key, name: acc.name || key, limit: acc.tokenLimit }));

    if (!entries.length) {
      el.innerHTML = '<div class="admin-empty">◈ No custom token limits set. All users use the global limit.</div>';
      return;
    }
    el.innerHTML = entries.map(e => `
      <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
        <span style="flex:1;font-family:var(--font-body);font-size:12px;color:var(--text-hi);">◈ ${escHtml(e.name)}</span>
        <span style="font-family:var(--font-hud);font-size:9px;color:var(--cyan);">${e.limit.toLocaleString()} / day</span>
        <button class="asi-del ban-btn-r" onclick="clearUserTokenLimit('${escHtml(e.name)}','${escHtml(e.key)}')">✕ REMOVE</button>
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<div class="admin-empty">◈ Error: ${e.message}</div>`;
  }
}


// ══════════════════════════════════════════════════════════════════
// ◈ ADMIN PANEL SECTION INJECTOR
//   Injects all new HTML sections into the admin panel on page load
// ══════════════════════════════════════════════════════════════════

function injectAdminEnhancements() {
  // The HTML sections are now pre-built in index.html as tab panes.
  // We just need to inject the enhanced sections into their placeholder divs.

  // ── Analytics section (tab: analytics) ──
  const analyticsSection = document.getElementById('adminAnalyticsSection');
  if (analyticsSection && !analyticsSection.dataset.injected) {
    analyticsSection.dataset.injected = '1';
    analyticsSection.className = 'admin-section';
    analyticsSection.innerHTML = `
      <div class="admin-section-title">
        <span class="asti-icon">📊</span>
        <span class="asti-text">ANALYTICS DASHBOARD</span>
        <button class="acm-clear-btn" onclick="loadAdminAnalytics()" style="font-size:8px;margin-left:auto;">⟳ REFRESH</button>
      </div>
      <div id="adminAnalyticsPanel">
        <div class="admin-empty" style="cursor:pointer;" onclick="loadAdminAnalytics()">◈ Click REFRESH to load analytics.</div>
      </div>`;
  }

  // ── User Profile Manager (tab: users) ──
  const userManagerSection = document.getElementById('adminUserManagerSection');
  if (userManagerSection && !userManagerSection.dataset.injected) {
    userManagerSection.dataset.injected = '1';
    userManagerSection.className = 'admin-section';
    userManagerSection.innerHTML = `
      <div class="admin-section-title">
        <span class="asti-icon">👤</span>
        <span class="asti-text">USER PROFILE MANAGER</span>
        <button class="acm-clear-btn" onclick="adminLoadUserList()" style="font-size:8px;margin-left:auto;">⟳ LOAD USERS</button>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:10px;">
        View user details, reset passwords, clear streaks, or permanently delete accounts.
      </div>
      <div id="adminUserListBody">
        <div class="admin-empty" style="cursor:pointer;" onclick="adminLoadUserList()">◈ Click LOAD USERS to view all accounts.</div>
      </div>`;
  }

  // ── MOTD section (tab: broadcast) ──
  const motdSection = document.getElementById('adminMOTDSection');
  if (motdSection && !motdSection.dataset.injected) {
    motdSection.dataset.injected = '1';
    motdSection.className = 'admin-section';
    motdSection.innerHTML = `
      <div class="admin-section-title">
        <span class="asti-icon">📣</span>
        <span class="asti-text">MESSAGE OF THE DAY (MOTD)</span>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:10px;">
        Set a message that appears to all users when they log in. Leave blank to disable.
      </div>
      <textarea class="admin-broadcast-input" id="motdInput" placeholder="Type a MOTD message… (leave blank to disable)" maxlength="600" style="min-height:72px;"></textarea>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <button class="admin-add-btn" onclick="saveMOTD()" style="background:rgba(168,85,247,0.12);border-color:rgba(168,85,247,0.4);color:var(--violet-bright);">📣 SAVE MOTD</button>
        <button class="admin-add-btn" onclick="loadMOTDForEdit()" style="font-size:8px;">⟳ LOAD CURRENT</button>
        <button class="admin-add-btn" onclick="document.getElementById('motdInput').value='';saveMOTD();" style="background:var(--crimson-dim);border-color:var(--border-red);color:var(--crimson-bright);font-size:8px;">✕ CLEAR</button>
      </div>
      <div id="motdMsg" style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.1em;min-height:14px;margin-top:6px;"></div>`;
  }

  // ── AI Config (tab: ai) ──
  const aiConfigSection = document.getElementById('adminAIConfigSection');
  if (aiConfigSection && !aiConfigSection.dataset.injected) {
    aiConfigSection.dataset.injected = '1';
    aiConfigSection.className = 'admin-section';
    aiConfigSection.innerHTML = `
      <div class="admin-section-title">
        <span class="asti-icon">⚡</span>
        <span class="asti-text">AI CONFIGURATION — MODEL &amp; API KEY</span>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:12px;">
        Switch the active AI model or replace the global Groq API key without redeploying. Changes take effect immediately.
      </div>
      <div class="admin-form-row" style="gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div class="admin-field" style="flex:1;min-width:180px;">
          <label>ACTIVE MODEL</label>
          <select id="adminModelSelect" class="admin-input" style="appearance:auto;-webkit-appearance:auto;cursor:pointer;">
            <option value="">Loading…</option>
          </select>
        </div>
        <div class="admin-field" style="flex:2;min-width:180px;">
          <label>REPLACE GLOBAL API KEY (gsk_…)</label>
          <input class="admin-input" id="adminGlobalKeyInput" type="password" placeholder="gsk_… (leave blank to keep current)" maxlength="120">
        </div>
        <div class="admin-field" style="min-width:120px;">
          <label>MAX TOKENS / REQUEST</label>
          <input class="admin-input" id="adminMaxTokensInput" type="number" placeholder="2000" min="256" max="32768" step="256">
        </div>
        <button class="admin-add-btn" onclick="applyAIConfig()" style="background:rgba(34,211,238,0.12);border-color:rgba(34,211,238,0.4);color:var(--cyan);">⚡ APPLY</button>
      </div>
      <div id="aiConfigMsg" style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.1em;min-height:14px;margin-top:8px;"></div>`;
  }

  // ── Key Pool Manager (tab: ai) ──
  let keyPoolSection = document.getElementById('adminKeyPoolSection');
  if (!keyPoolSection) {
    keyPoolSection = document.createElement('div');
    keyPoolSection.id = 'adminKeyPoolSection';
    const sysPromptEl = document.getElementById('adminSysPromptSection');
    if (sysPromptEl) sysPromptEl.parentNode.insertBefore(keyPoolSection, sysPromptEl);
  }
  if (!keyPoolSection.dataset.injected) {
    keyPoolSection.dataset.injected = '1';
    keyPoolSection.className = 'admin-section';
    keyPoolSection.innerHTML = `
      <div class="admin-section-title">
        <span class="asti-icon">🔑</span>
        <span class="asti-text">API KEY POOL — RATE LIMIT DISTRIBUTION</span>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:12px;">
        Add multiple Groq API keys to spread the rate limit across them. Luna auto-rotates keys and puts a key in 60s cooldown when it hits a 429 — users barely notice. Each free Groq key gives <strong>~14,400 req/day</strong> independently.
      </div>
      <div id="keyPoolList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;"></div>
      <div class="admin-form-row" style="gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <div class="admin-field" style="flex:1;min-width:200px;">
          <label>ADD KEY (gsk_…)</label>
          <input class="admin-input" id="newPoolKeyInput" type="password" placeholder="gsk_…" maxlength="120">
        </div>
        <div class="admin-field" style="min-width:120px;">
          <label>LABEL (optional)</label>
          <input class="admin-input" id="newPoolKeyLabel" type="text" placeholder="e.g. Key #2" maxlength="32">
        </div>
        <button class="admin-add-btn" onclick="addPoolKey()" style="background:rgba(52,211,153,0.12);border-color:rgba(52,211,153,0.4);color:#34d399;">+ ADD KEY</button>
      </div>
      <div id="keyPoolMsg" style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.1em;min-height:14px;margin-top:8px;"></div>
      <div class="admin-section-title" style="margin-top:18px;">
        <span class="asti-icon">📊</span>
        <span class="asti-text">PER-USER TOKEN USAGE TODAY</span>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:10px;">
        Each user has a separate daily token cap (${USER_TOKEN_DAILY_LIMIT.toLocaleString()} tokens). Heavy users can't burn the shared quota. Usage resets at midnight.
      </div>
      <button class="admin-add-btn" onclick="loadUserTokenUsageTable()" style="margin-bottom:10px;font-size:8px;">⟳ REFRESH USAGE</button>
      <div id="userTokenTable"><div class="admin-empty">◈ Click REFRESH to load per-user usage.</div></div>`;

    renderKeyPoolList();
  }

  // ── System Prompt Editor (tab: ai) ──
  const sysPromptSection = document.getElementById('adminSysPromptSection');
  if (sysPromptSection && !sysPromptSection.dataset.injected) {
    sysPromptSection.dataset.injected = '1';
    sysPromptSection.className = 'admin-section';
    sysPromptSection.innerHTML = `
      <div class="admin-section-title">
        <span class="asti-icon">📝</span>
        <span class="asti-text">LUNA SYSTEM PROMPT EDITOR</span>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:10px;">
        Override Luna's personality and behavior instructions. Pushed to Firebase so all sessions pick it up on their next message.
        <strong>Reset to restore the original built-in prompt.</strong>
      </div>
      <textarea class="admin-broadcast-input" id="sysPromptEditor"
        placeholder="Type a custom system prompt, or click LOAD CURRENT to start from the built-in prompt…"
        maxlength="8000"
        style="min-height:160px;font-family:var(--font-mono);font-size:11px;line-height:1.6;"></textarea>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <button class="admin-add-btn" onclick="saveCustomSystemPrompt()" style="background:rgba(168,85,247,0.12);border-color:rgba(168,85,247,0.4);color:var(--violet-bright);">📝 SAVE &amp; PUSH</button>
        <button class="admin-add-btn" onclick="loadSysPromptIntoEditor()" style="font-size:8px;">⟳ LOAD CURRENT</button>
        <button class="admin-add-btn" onclick="resetSystemPrompt()" style="background:var(--crimson-dim);border-color:var(--border-red);color:var(--crimson-bright);font-size:8px;">↩ RESET TO DEFAULT</button>
        <span style="font-family:var(--font-hud);font-size:7.5px;color:var(--text-lo);margin-left:auto;">Max 8,000 chars</span>
      </div>
      <div id="sysPromptMsg" style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.1em;min-height:14px;margin-top:6px;"></div>`;
  }

  // ── AutoMod Tuner (tab: moderation) ──
  const autoModTunerSection = document.getElementById('adminAutoModTunerSection');
  if (autoModTunerSection && !autoModTunerSection.dataset.injected) {
    autoModTunerSection.dataset.injected = '1';
    autoModTunerSection.className = 'admin-section';
    autoModTunerSection.innerHTML = `
      <div class="admin-section-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span style="display:flex;align-items:center;gap:8px;"><span class="asti-icon">⚙️</span><span class="asti-text">AUTO-MOD SENSITIVITY TUNER</span></span>
        <button class="acm-clear-btn" onclick="renderAutoModTuner()" style="font-size:8px;">⟳ LOAD</button>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:10px;">
        Fine-tune how quickly Auto-Mod warns, suspends, or bans users based on toxic message strikes. Saved locally.
      </div>
      <div id="autoModTunerBody">
        <div class="admin-empty" style="cursor:pointer;" onclick="renderAutoModTuner()">◈ Click LOAD to configure thresholds.</div>
      </div>`;
  }

  // ── Per-User Token Limiter (tab: moderation) ──
  const tokenLimitSection = document.getElementById('adminTokenLimitSection');
  if (tokenLimitSection && !tokenLimitSection.dataset.injected) {
    tokenLimitSection.dataset.injected = '1';
    tokenLimitSection.className = 'admin-section';
    tokenLimitSection.innerHTML = `
      <div class="admin-section-title">
        <span class="asti-icon">🔋</span>
        <span class="asti-text">PER-USER DAILY TOKEN LIMIT</span>
      </div>
      <div class="admin-info-box" style="font-size:11px;margin-bottom:10px;">
        Set a custom daily token cap for any user, overriding the global limit.
        Global limit: <strong>${typeof TOKEN_DAILY_LIMIT !== 'undefined' ? TOKEN_DAILY_LIMIT.toLocaleString() : '200,000'} tokens/day</strong>.
      </div>
      <div class="admin-form-row" style="gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div class="admin-field" style="flex:1;min-width:120px;">
          <label>USERNAME</label>
          <input class="admin-input" id="utlUsername" type="text" placeholder="Exact username…" maxlength="40">
        </div>
        <div class="admin-field" style="min-width:140px;">
          <label>DAILY TOKEN LIMIT</label>
          <input class="admin-input" id="utlLimit" type="number" placeholder="e.g. 50000" min="1000" max="2000000" step="1000">
        </div>
        <button class="admin-add-btn" onclick="saveUserTokenLimit()" style="background:rgba(52,211,153,0.12);border-color:rgba(52,211,153,0.4);color:var(--green);">🔋 SET LIMIT</button>
        <button class="admin-add-btn" onclick="loadTokenLimitList()" style="font-size:8px;">⟳ REFRESH</button>
      </div>
      <div id="utlMsg" style="font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.1em;min-height:14px;margin-top:6px;"></div>
      <div style="margin-top:10px;" id="utlList">
        <div class="admin-empty">◈ Click REFRESH to see custom limits.</div>
      </div>`;
  }
}


// ══════════════════════════════════════════════════════════════════
// ◈ ADMIN TAB SWITCHER
// ══════════════════════════════════════════════════════════════════

function switchAdminTab(tabId) {
  // Update tab buttons
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  // Show/hide panes
  document.querySelectorAll('.admin-tab-pane').forEach(pane => {
    const active = pane.id === 'adminPane-' + tabId;
    pane.classList.toggle('active', active);
  });
  // Auto-load data for specific tabs
  if (tabId === 'analytics') {
    setTimeout(loadAdminAnalytics, 100);
  } else if (tabId === 'users') {
    setTimeout(adminLoadUserList, 100);
    setTimeout(loadTokenLimitList, 100);
  } else if (tabId === 'broadcast') {
    setTimeout(loadMOTDForEdit, 100);
  } else if (tabId === 'moderation') {
    setTimeout(renderAutoModTuner, 100);
  } else if (tabId === 'ai') {
    setTimeout(populateModelSelector, 100);
    setTimeout(loadSysPromptIntoEditor, 100);
  } else if (tabId === 'overview') {
    // Presence and rate limit are live-updated automatically
    setTimeout(refreshStreakLeaderboard, 100);
  }
}
window.switchAdminTab = switchAdminTab;

// ── Update Firebase status dot in admin panel ──────────────────────
function updateAdminFbStatus() {
  const dot   = document.getElementById('adminFbDot');
  const label = document.getElementById('adminFbLabel');
  if (!dot || !label) return;
  const ready = typeof firebaseReady !== 'undefined' && firebaseReady;
  dot.style.background  = ready ? 'var(--green)' : 'var(--crimson-bright)';
  dot.style.boxShadow   = ready ? '0 0 6px var(--green)' : '0 0 6px var(--crimson-bright)';
  label.textContent     = ready ? 'FIREBASE ONLINE' : 'FIREBASE OFFLINE';
  label.style.color     = ready ? 'var(--green)' : 'var(--crimson-bright)';
}

// ══════════════════════════════════════════════════════════════════
// ◈ INIT — Hook into DOMContentLoaded and admin open/close
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Inject new sections into admin panel
  injectAdminEnhancements();

  // Populate model selector
  setTimeout(populateModelSelector, 500);

  // Load custom system prompt and AI config from Firebase
  const waitForFirebase = setInterval(() => {
    if (typeof firebaseReady !== 'undefined' && firebaseReady && typeof firebaseDb !== 'undefined' && firebaseDb) {
      clearInterval(waitForFirebase);
      loadCustomSystemPrompt();
      watchCustomSystemPrompt();
      watchAIConfig();
    }
  }, 1000);
});

// Patch enterAdmin to init enhancement subscriptions
(function patchEnterAdmin() {
  const _tryPatch = () => {
    if (typeof enterAdmin !== 'function') return;
    if (enterAdmin._enhancementsPatched) return;
    const _orig = enterAdmin;
    enterAdmin = async function() {
      await _orig.apply(this, arguments);
      // Auto-load analytics and token list when admin panel opens
      setTimeout(() => {
        loadAdminAnalytics();
        loadTokenLimitList();
        loadMOTDForEdit();
        renderAutoModTuner();
        populateModelSelector();
        updateAdminFbStatus();
        // Default to overview tab
        switchAdminTab('overview');
      }, 300);
    };
    enterAdmin._enhancementsPatched = true;
  };
  // Retry until enterAdmin is defined
  let attempts = 0;
  const interval = setInterval(() => {
    _tryPatch();
    if (typeof enterAdmin === 'function' || ++attempts > 60) clearInterval(interval);
  }, 500);
})();

// ══════════════════════════════════════════════════════════════════
// ◈ KEY POOL MANAGEMENT — Admin UI functions
// ══════════════════════════════════════════════════════════════════

const POOL_STORAGE_KEY = 'luna_api_key_pool';

function getStoredPool() {
  try { return JSON.parse(localStorage.getItem(POOL_STORAGE_KEY) || '[]'); } catch { return []; }
}

function saveStoredPool(pool) {
  localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(pool));
  // Sync into live API_KEY_POOL array (keep index 0 = the hardcoded default)
  API_KEY_POOL.length = 1;
  pool.forEach(entry => { if (entry.key && entry.key !== API_KEY) API_KEY_POOL.push(entry.key); });
}

function renderKeyPoolList() {
  const list = document.getElementById('keyPoolList');
  if (!list) return;
  const pool = getStoredPool();

  // Always show the hardcoded key as entry 0
  const allEntries = [{ key: API_KEY, label: 'Default Key (built-in)', locked: true }, ...pool];

  if (allEntries.length === 0) {
    list.innerHTML = '<div class="admin-empty">No extra keys added yet.</div>';
    return;
  }

  list.innerHTML = allEntries.map((entry, i) => {
    const now = Date.now();
    const cooling = _keyCooldowns[i] && now < _keyCooldowns[i];
    const coolLeft = cooling ? Math.ceil((_keyCooldowns[i] - now) / 1000) : 0;
    const masked = entry.key.slice(0,8) + '●●●●●●●' + entry.key.slice(-4);
    const statusDot = cooling
      ? `<span style="color:#f59e0b;font-size:9px;">⏳ cooling ${coolLeft}s</span>`
      : `<span style="color:#34d399;font-size:9px;">✅ ready</span>`;
    return `<div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.03);
        border:1px solid rgba(168,85,247,0.15);border-radius:9px;padding:9px 12px;flex-wrap:wrap;">
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-mid);flex:1;min-width:150px;">${masked}</span>
      <span style="font-family:var(--font-hud);font-size:9px;color:var(--text-lo);letter-spacing:0.1em;">${entry.label || 'Key #' + (i+1)}</span>
      ${statusDot}
      ${entry.locked ? '' : `<button class="asi-del" onclick="removePoolKey(${i-1})" style="font-size:8px;padding:4px 8px;">✕ REMOVE</button>`}
    </div>`;
  }).join('');
}

function addPoolKey() {
  const inp   = document.getElementById('newPoolKeyInput');
  const label = document.getElementById('newPoolKeyLabel');
  const msg   = document.getElementById('keyPoolMsg');
  const key   = inp ? inp.value.trim() : '';
  if (!key.startsWith('gsk_')) {
    if (msg) { msg.style.color = 'var(--crimson-bright)'; msg.textContent = '✗ Invalid key — must start with gsk_'; }
    return;
  }
  const pool = getStoredPool();
  if (pool.some(e => e.key === key) || key === API_KEY) {
    if (msg) { msg.style.color = '#f59e0b'; msg.textContent = '⚠ This key is already in the pool.'; }
    return;
  }
  pool.push({ key, label: label ? label.value.trim() || `Key #${pool.length + 2}` : '' });
  saveStoredPool(pool);
  if (inp)   inp.value   = '';
  if (label) label.value = '';
  if (msg)   { msg.style.color = '#34d399'; msg.textContent = `✓ Key added — pool now has ${API_KEY_POOL.length} keys.`; }
  renderKeyPoolList();
}

function removePoolKey(poolIdx) {
  const pool = getStoredPool();
  if (poolIdx < 0 || poolIdx >= pool.length) return;
  pool.splice(poolIdx, 1);
  saveStoredPool(pool);
  const msg = document.getElementById('keyPoolMsg');
  if (msg) { msg.style.color = '#34d399'; msg.textContent = '✓ Key removed from pool.'; }
  renderKeyPoolList();
}

// Load pool from localStorage on startup
(function initKeyPool() {
  const stored = getStoredPool();
  if (stored.length > 0) saveStoredPool(stored); // syncs into API_KEY_POOL
})();

// Per-user token usage table for admin
async function loadUserTokenUsageTable() {
  const tableEl = document.getElementById('userTokenTable');
  if (!tableEl) return;
  tableEl.innerHTML = '<div class="admin-empty">⏳ Loading…</div>';

  if (!firebaseReady || !firebaseDb) {
    tableEl.innerHTML = '<div class="admin-empty">Firebase not connected.</div>';
    return;
  }

  const today = new Date().toDateString();
  try {
    const snap = await firebaseDb.ref(`luna-user-tokens`).once('value');
    const data = snap.val() || {};
    const rows = Object.entries(data).map(([uid, days]) => {
      const count = parseInt((days && days[today]) || 0, 10);
      const pct   = Math.min(100, Math.round((count / USER_TOKEN_DAILY_LIMIT) * 100));
      const color = pct >= 93 ? 'var(--crimson-bright)' : pct >= 80 ? '#f59e0b' : '#34d399';
      return { uid, count, pct, color };
    }).filter(r => r.count > 0).sort((a,b) => b.count - a.count);

    if (!rows.length) {
      tableEl.innerHTML = '<div class="admin-empty">No token usage data yet for today.</div>';
      return;
    }

    tableEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead><tr style="font-family:var(--font-hud);font-size:8px;letter-spacing:0.1em;color:var(--text-lo);">
        <th style="text-align:left;padding:6px 8px;">USER</th>
        <th style="text-align:right;padding:6px 8px;">TOKENS</th>
        <th style="text-align:right;padding:6px 8px;">% OF LIMIT</th>
        <th style="padding:6px 8px;min-width:80px;">USAGE</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr style="border-top:1px solid rgba(255,255,255,0.04);">
        <td style="padding:7px 8px;color:var(--text-mid);font-family:var(--font-mono);">${r.uid}</td>
        <td style="padding:7px 8px;text-align:right;color:var(--text-hi);">${r.count.toLocaleString()}</td>
        <td style="padding:7px 8px;text-align:right;color:${r.color};">${r.pct}%</td>
        <td style="padding:7px 8px;">
          <div style="height:6px;border-radius:99px;background:rgba(255,255,255,0.06);overflow:hidden;">
            <div style="height:100%;width:${r.pct}%;background:${r.color};border-radius:99px;"></div>
          </div>
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
  } catch (e) {
    tableEl.innerHTML = `<div class="admin-empty" style="color:var(--crimson-bright);">Error loading data: ${e.message}</div>`;
  }
}

// Expose key pool functions globally
window.addPoolKey               = addPoolKey;
window.removePoolKey            = removePoolKey;
window.renderKeyPoolList        = renderKeyPoolList;
window.loadUserTokenUsageTable  = loadUserTokenUsageTable;

// Expose key functions globally
window.loadAdminAnalytics      = loadAdminAnalytics;
window.exportAnalyticsCSV      = exportAnalyticsCSV;
window.saveCustomSystemPrompt  = saveCustomSystemPrompt;
window.resetSystemPrompt       = resetSystemPrompt;
window.loadSysPromptIntoEditor = loadSysPromptIntoEditor;
window.saveMOTD                = saveMOTD;
window.loadMOTDForEdit         = loadMOTDForEdit;
window.adminLoadUserList       = adminLoadUserList;
window.adminViewUser           = adminViewUser;
window.adminResetUserPassword  = adminResetUserPassword;
window.adminResetUserStreak    = adminResetUserStreak;
window.adminDeleteUser         = adminDeleteUser;
window.applyAIConfig           = applyAIConfig;
window.populateModelSelector   = populateModelSelector;
window.renderAutoModTuner      = renderAutoModTuner;
window.saveAutoModTuner        = saveAutoModTuner;
window.saveUserTokenLimit      = saveUserTokenLimit;
window.clearUserTokenLimit     = clearUserTokenLimit;
window.loadTokenLimitList      = loadTokenLimitList;
window.checkAndShowMOTD        = checkAndShowMOTD;
window.stopLunaStream          = stopLunaStream;

// ══════════════════════════════════════════════════════════════════
// ◈ CHAT INTERFACE ENHANCEMENTS — Visual FX + Smart Summarize
// ══════════════════════════════════════════════════════════════════

// ── Smart Mode: Summarize Luna message ────────────────────────────
async function summarizeLunaMessage(text) {
  if (!text || text.trim().length < 30) {
    showToast('◈ Message too short to summarize.', '⚡'); return;
  }
  const panel = document.getElementById('summarizePanel');
  const body  = document.getElementById('summarizePanelBody');
  if (!panel || !body) return;

  panel.classList.add('sp-visible');
  body.innerHTML = '<div class="sp-loading"><div class="sp-spinner"></div>Analyzing response…</div>';

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getActiveApiKey()}` },
      body: JSON.stringify({
        model: API_MODEL,
        max_tokens: 1200,
        temperature: 0.4,
        messages: [
          { role: 'system', content: 'You are a concise summarizer. Summarize the given text in 2-4 bullet points using plain language. Each bullet starts with "·". No headers, no markdown code fences.' },
          { role: 'user', content: `Summarize this response concisely:\n\n${text}` }
        ]
      })
    });
    const data   = await response.json();
    const result = data?.choices?.[0]?.message?.content || '· Could not generate summary.';
    // Render bullets
    const lines = result.split('\n').filter(l => l.trim());
    body.innerHTML = lines.map(l => `<div style="margin-bottom:5px;">${escHtml(l.trim())}</div>`).join('');
  } catch (err) {
    body.innerHTML = `<div style="color:var(--crimson-bright);font-size:11px;">◈ Summary failed: ${escHtml(err.message || 'Unknown error')}</div>`;
  }
}
window.summarizeLunaMessage = summarizeLunaMessage;

function closeSummarizePanel() {
  const panel = document.getElementById('summarizePanel');
  if (panel) panel.classList.remove('sp-visible');
}
window.closeSummarizePanel = closeSummarizePanel;

// ── Ambient Chat Node Spawner ──────────────────────────────────────
const CHAT_NODES_TEXT = ['0x1F', '0xA3', '0x7C', 'SYN', 'ACK', '0xD4', '0xFF', '0x2B', 'DAT', '0x88', '0xE1', 'PKT'];
let _chatNodeTimer = null;

function spawnChatNode() {
  const ambient = document.getElementById('chatAmbient');
  if (!ambient) return;
  const node = document.createElement('div');
  node.className = 'chat-node';
  node.textContent = CHAT_NODES_TEXT[Math.floor(Math.random() * CHAT_NODES_TEXT.length)];
  const leftPct = 5 + Math.random() * 90;
  const topPct  = 20 + Math.random() * 65;
  const dur     = 6 + Math.random() * 8;
  const dx      = (Math.random() - 0.5) * 40;
  node.style.cssText = `left:${leftPct}%;top:${topPct}%;--dx:${dx}px;animation-duration:${dur}s;animation-delay:0s;`;
  ambient.appendChild(node);
  setTimeout(() => node.remove(), dur * 1000 + 200);
}

function startChatAmbience() {
  if (_chatNodeTimer) return;
  spawnChatNode();
  _chatNodeTimer = setInterval(spawnChatNode, 2800);
}

function stopChatAmbience() {
  clearInterval(_chatNodeTimer);
  _chatNodeTimer = null;
}

// Start ambient after DOM is ready (desktop only)
if (!IS_MOBILE) {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(startChatAmbience, 2000);
  });
}

// ── Apply initial mood body class from stored lunaMood ─────────────
document.addEventListener('DOMContentLoaded', () => {
  const initMood = (typeof lunaMood !== 'undefined') ? lunaMood : 'chill';
  document.body.classList.add(`mood-${initMood}`);
});
// ══════════════════════════════════════════════════════════════════
// ◈ PWA — Add to Home Screen
// ══════════════════════════════════════════════════════════════════
let _pwaInstallPrompt = null;

// Capture the install prompt (Android/Chrome)
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _pwaInstallPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = '';
});

// Hide button once installed
window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'none';
  _pwaInstallPrompt = null;
});

// Show iOS tip button on Safari iOS
(function checkIOS() {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  if (isIOS && isSafari && !isStandalone) {
    const btn = document.getElementById('installBtnIOS');
    if (btn) btn.style.display = '';
  }
})();

// Android/Chrome: trigger native install prompt
function installPWA() {
  if (_pwaInstallPrompt) {
    _pwaInstallPrompt.prompt();
    _pwaInstallPrompt.userChoice.then((result) => {
      if (result.outcome === 'accepted') {
        const btn = document.getElementById('installBtn');
        if (btn) btn.style.display = 'none';
      }
      _pwaInstallPrompt = null;
    });
  }
}

// iOS: show a toast explaining how to install
function showIOSInstallTip() {
  // Remove existing tip if any
  const existing = document.getElementById('iosInstallToast');
  if (existing) { existing.remove(); return; }

  const toast = document.createElement('div');
  toast.id = 'iosInstallToast';
  toast.innerHTML = `
    <div style="
      position:fixed; bottom:90px; left:50%; transform:translateX(-50%);
      background:#06061a; border:1px solid rgba(168,85,247,0.4);
      border-radius:14px; padding:16px 20px; z-index:99999;
      box-shadow:0 8px 32px rgba(0,0,0,0.6);
      font-family:'Sora',sans-serif; font-size:13px;
      color:#f0e6ff; max-width:300px; text-align:center;
      animation: fadeInUp 0.3s ease;
    ">
      <div style="font-size:22px; margin-bottom:8px;">📲</div>
      <div style="font-weight:600; margin-bottom:6px;">Add Luna to Home Screen</div>
      <div style="color:#9580b5; line-height:1.6;">
        Tap the <strong style="color:#a855f7;">Share ↑</strong> button at the bottom of Safari, then tap <strong style="color:#a855f7;">"Add to Home Screen"</strong>
      </div>
      <button onclick="document.getElementById('iosInstallToast').remove()" style="
        margin-top:12px; padding:7px 20px;
        background:rgba(168,85,247,0.15); border:1px solid rgba(168,85,247,0.3);
        border-radius:8px; color:#a855f7; font-size:12px;
        cursor:pointer; font-family:'Sora',sans-serif;
      ">Got it</button>
    </div>
  `;

  // Add fade-in animation
  const style = document.createElement('style');
  style.textContent = `@keyframes fadeInUp { from { opacity:0; transform:translateX(-50%) translateY(16px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
  document.head.appendChild(style);

  document.body.appendChild(toast);

  // Auto-dismiss after 8 seconds
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
}
// ══════════════════════════════════════════════════════════════════
// ◈ ENHANCEMENT PACK — New features injected
// ══════════════════════════════════════════════════════════════════

// ── Quick Prompt Injection ─────────────────────────────────────────
function injectQuickPrompt(text) {
  const input = document.getElementById('userInput');
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  // Collapse the strip after use on mobile
  if (typeof IS_MOBILE !== 'undefined' && IS_MOBILE) {
    const strip = document.getElementById('quickPromptsStrip');
    if (strip) { strip.style.opacity = '0.4'; setTimeout(() => { strip.style.opacity = ''; }, 1500); }
  }
}
window.injectQuickPrompt = injectQuickPrompt;

// ── Topbar Mood Badge Sync ─────────────────────────────────────────
// Mirrors the current lunaMood into the topbar badge so it's always visible.
(function installTopbarMoodSync() {
  const MOOD_CONFIG = {
    chill:     { label: 'CHILL',     color: '#a855f7', glow: 'rgba(168,85,247,0.5)' },
    curious:   { label: 'CURIOUS',   color: '#22d3ee', glow: 'rgba(34,211,238,0.5)' },
    warm:      { label: 'WARM',      color: '#fb923c', glow: 'rgba(251,146,60,0.5)'  },
    playful:   { label: 'PLAYFUL',   color: '#f472b6', glow: 'rgba(244,114,182,0.5)' },
    focused:   { label: 'FOCUSED',   color: '#34d399', glow: 'rgba(52,211,153,0.5)'  },
    empathetic:{ label: 'EMPATHIC',  color: '#fbbf24', glow: 'rgba(251,191,36,0.5)'  },
    assertive: { label: 'ASSERTIVE', color: '#ec2d5a', glow: 'rgba(236,45,90,0.5)'   },
    melancholy:{ label: 'MELANCHOLY',color: '#6366f1', glow: 'rgba(99,102,241,0.5)'  },
  };

  function syncTopbarMood(mood) {
    const dot   = document.getElementById('topbarMoodDot');
    const label = document.getElementById('topbarMoodLabel');
    const badge = document.getElementById('topbarMoodBadge');
    if (!dot || !label || !badge) return;
    const cfg = MOOD_CONFIG[mood] || MOOD_CONFIG['chill'];
    dot.style.background  = cfg.color;
    dot.style.boxShadow   = `0 0 6px ${cfg.glow}`;
    label.textContent     = cfg.label;
    badge.style.borderColor = `rgba(${hexToRgb(cfg.color)},0.28)`;
    badge.style.background  = `rgba(${hexToRgb(cfg.color)},0.06)`;
    badge.style.color       = cfg.color;
  }

  function hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : '168,85,247';
  }

  // Poll for lunaMood changes (lunaMood is a global managed by the main script)
  let _lastMood = null;
  function pollMood() {
    const cur = (typeof lunaMood !== 'undefined') ? lunaMood : 'chill';
    if (cur !== _lastMood) { _lastMood = cur; syncTopbarMood(cur); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    pollMood();
    setInterval(pollMood, 800);
  });

  // Also expose so external callers can trigger immediately
  window._syncTopbarMood = syncTopbarMood;
})();

// ── Luna Status Chip — goes offline while typing ───────────────────
(function installStatusChipReflect() {
  function setLunaStatus(online) {
    const chip = document.getElementById('lunaStatusChip');
    if (!chip) return;
    const dot = chip.querySelector('.lsc-dot');
    const lbl = chip.querySelector('span:last-child');
    if (online) {
      chip.style.borderColor = 'rgba(52,211,153,0.28)';
      chip.style.background  = 'rgba(52,211,153,0.06)';
      chip.style.color       = '#34d399';
      if (dot) { dot.style.background = '#34d399'; dot.style.boxShadow = '0 0 6px #34d399'; }
      if (lbl) lbl.textContent = 'LUNA ONLINE';
    } else {
      chip.style.borderColor = 'rgba(236,45,90,0.28)';
      chip.style.background  = 'rgba(236,45,90,0.06)';
      chip.style.color       = '#ec2d5a';
      if (dot) { dot.style.background = '#ec2d5a'; dot.style.boxShadow = '0 0 6px rgba(236,45,90,0.6)'; dot.style.animation = 'none'; setTimeout(()=>{if(dot)dot.style.animation='';},100); }
      if (lbl) lbl.textContent = 'THINKING…';
    }
  }

  // Monkey-patch showTyping / hideTyping to update chip
  document.addEventListener('DOMContentLoaded', () => {
    const origShow = window.showTyping;
    const origHide = window.hideTyping;
    if (origShow) window.showTyping = function() { setLunaStatus(false); return origShow.apply(this, arguments); };
    if (origHide) window.hideTyping = function() { setLunaStatus(true);  return origHide.apply(this, arguments); };
  });
})();
// ══════════════════════════════════════════════════════════════════
// ◈ TOPIC STARTER — AI-powered conversation topic suggestions
//   Appears after 3+ messages to help keep the chat flowing.
//   Generates fresh, context-aware topic ideas via the Groq API.
// ══════════════════════════════════════════════════════════════════

(function installTopicStarter() {
  /* ── 1. Inject CSS ─────────────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    /* ── Topic Starter Button ── */
    #topicStarterBtn {
      display: none;
      align-items: center;
      gap: 7px;
      margin: 0 0 7px 0;
      padding: 7px 14px 7px 10px;
      background: linear-gradient(135deg, rgba(168,85,247,0.10) 0%, rgba(236,45,90,0.06) 100%);
      border: 1px solid rgba(168,85,247,0.28);
      border-radius: 20px;
      color: var(--violet-bright);
      font-family: var(--font-hud);
      font-size: 9px;
      letter-spacing: 0.14em;
      cursor: pointer;
      transition: all 0.22s var(--smooth);
      position: relative;
      overflow: hidden;
      white-space: nowrap;
      align-self: flex-start;
    }
    #topicStarterBtn:hover {
      background: linear-gradient(135deg, rgba(168,85,247,0.18) 0%, rgba(236,45,90,0.10) 100%);
      border-color: rgba(168,85,247,0.52);
      box-shadow: 0 0 18px rgba(168,85,247,0.20);
      transform: translateY(-1px);
    }
    #topicStarterBtn .tsb-pulse {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--violet-bright);
      box-shadow: 0 0 8px rgba(168,85,247,0.9);
      animation: tsPulse 1.8s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes tsPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.55; transform: scale(0.7); }
    }

    /* ── Topic Panel ── */
    #topicPanel {
      display: none;
      flex-direction: column;
      gap: 0;
      background: var(--card);
      border: 1px solid rgba(168,85,247,0.22);
      border-radius: 16px;
      margin: 0 0 8px 0;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(168,85,247,0.05);
      animation: topicPanelIn 0.28s var(--spring);
    }
    @keyframes topicPanelIn {
      from { opacity: 0; transform: translateY(10px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    #topicPanel.visible { display: flex; }

    .tp-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 14px 10px;
      border-bottom: 1px solid rgba(168,85,247,0.12);
      background: linear-gradient(135deg, rgba(168,85,247,0.07), rgba(236,45,90,0.03));
    }
    .tp-header-left {
      display: flex; align-items: center; gap: 8px;
    }
    .tp-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--violet-bright);
      box-shadow: 0 0 8px rgba(168,85,247,0.8);
    }
    .tp-title {
      font-family: var(--font-hud);
      font-size: 9px; letter-spacing: 0.16em;
      color: var(--violet-bright);
    }
    .tp-close {
      background: none; border: none;
      color: var(--text-lo); font-size: 15px; line-height: 1;
      cursor: pointer; padding: 2px 4px;
      transition: color 0.15s;
    }
    .tp-close:hover { color: var(--crimson-bright); }

    .tp-loading {
      display: flex; align-items: center; gap: 10px;
      padding: 18px 16px;
      font-family: var(--font-hud); font-size: 9px;
      letter-spacing: 0.13em; color: var(--text-mid);
    }
    .tp-spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(168,85,247,0.15);
      border-top-color: var(--violet-bright);
      animation: tsSpin 0.7s linear infinite; flex-shrink: 0;
    }
    @keyframes tsSpin { to { transform: rotate(360deg); } }

    .tp-topics {
      display: flex; flex-direction: column; gap: 0;
    }
    .tp-topic-item {
      display: flex; align-items: center; gap: 12px;
      padding: 11px 14px;
      cursor: pointer;
      transition: background 0.15s;
      border-bottom: 1px solid rgba(168,85,247,0.06);
      position: relative; overflow: hidden;
    }
    .tp-topic-item:last-child { border-bottom: none; }
    .tp-topic-item:hover {
      background: rgba(168,85,247,0.07);
    }
    .tp-topic-item:hover .tp-topic-arrow { opacity: 1; transform: translateX(0); }
    .tp-topic-icon {
      font-size: 17px; flex-shrink: 0;
      width: 32px; height: 32px; border-radius: 8px;
      background: rgba(168,85,247,0.08);
      border: 1px solid rgba(168,85,247,0.14);
      display: flex; align-items: center; justify-content: center;
    }
    .tp-topic-body { flex: 1; min-width: 0; }
    .tp-topic-label {
      font-family: var(--font-hud);
      font-size: 7.5px; letter-spacing: 0.14em;
      color: var(--violet-bright); opacity: 0.7;
      margin-bottom: 2px;
    }
    .tp-topic-text {
      font-family: var(--font-body);
      font-size: 12.5px; color: var(--text-hi);
      line-height: 1.35;
    }
    .tp-topic-arrow {
      font-size: 14px; color: var(--violet-bright);
      opacity: 0; transform: translateX(-6px);
      transition: all 0.18s var(--smooth);
      flex-shrink: 0;
    }
    .tp-footer {
      padding: 8px 14px;
      border-top: 1px solid rgba(168,85,247,0.10);
      display: flex; align-items: center; justify-content: space-between;
    }
    .tp-regen-btn {
      background: none; border: none;
      font-family: var(--font-hud); font-size: 8px;
      letter-spacing: 0.12em; color: var(--text-mid);
      cursor: pointer; padding: 4px 0;
      transition: color 0.15s;
      display: flex; align-items: center; gap: 5px;
    }
    .tp-regen-btn:hover { color: var(--violet-bright); }
    .tp-count-label {
      font-family: var(--font-hud); font-size: 8px;
      letter-spacing: 0.1em; color: var(--text-lo);
    }
  `;
  document.head.appendChild(style);

  /* ── 2. Inject HTML (button + panel) above the input box ──────── */
  function injectTopicStarterDOM() {
    const inputZone = document.querySelector('.input-zone') || document.querySelector('.input-box')?.parentNode;
    if (!inputZone) return;

    // Create button
    const btn = document.createElement('button');
    btn.id = 'topicStarterBtn';
    btn.innerHTML = `<span class="tsb-pulse"></span>✦ TOPIC STARTER`;
    btn.title = 'Get fresh conversation topics from Luna';

    // Create panel
    const panel = document.createElement('div');
    panel.id = 'topicPanel';
    panel.innerHTML = `
      <div class="tp-header">
        <div class="tp-header-left">
          <div class="tp-dot"></div>
          <span class="tp-title">✦ CONVERSATION TOPICS</span>
        </div>
        <button class="tp-close" id="topicPanelClose" title="Close">✕</button>
      </div>
      <div id="topicPanelBody">
        <div class="tp-loading">
          <div class="tp-spinner"></div>
          GENERATING TOPICS…
        </div>
      </div>
      <div class="tp-footer">
        <button class="tp-regen-btn" id="topicRegenBtn">↻ NEW TOPICS</button>
        <span class="tp-count-label" id="topicCountLabel"></span>
      </div>
    `;

    // Insert both ABOVE the input box container
    const inputBox = document.querySelector('.input-box') || document.querySelector('#inputBox');
    const parent   = inputBox ? inputBox.parentNode : inputZone;
    const ref      = inputBox || null;

    parent.insertBefore(panel, ref);
    parent.insertBefore(btn, panel);

    // Wire events
    btn.addEventListener('click', () => toggleTopicPanel());
    document.getElementById('topicPanelClose').addEventListener('click', closeTopicPanel);
    document.getElementById('topicRegenBtn').addEventListener('click', () => loadTopics(true));
  }

  /* ── 3. Show/hide logic ─────────────────────────────────────────── */
  let panelOpen  = false;
  let topicsLoaded = false;
  let generateCount = 0;

  function showTopicBtn() {
    const btn = document.getElementById('topicStarterBtn');
    if (btn && !panelOpen) btn.style.display = 'flex';
  }

  function hideTopicBtn() {
    const btn = document.getElementById('topicStarterBtn');
    if (btn) btn.style.display = 'none';
  }

  function openTopicPanel() {
    panelOpen = true;
    hideTopicBtn();
    const panel = document.getElementById('topicPanel');
    if (panel) panel.classList.add('visible');
    if (!topicsLoaded) loadTopics();
  }

  function closeTopicPanel() {
    panelOpen = false;
    const panel = document.getElementById('topicPanel');
    if (panel) panel.classList.remove('visible');
    // Show button again if enough messages
    if ((typeof msgCount !== 'undefined' ? msgCount : 0) >= 3) showTopicBtn();
  }

  function toggleTopicPanel() {
    panelOpen ? closeTopicPanel() : openTopicPanel();
  }
  window.closeTopicPanel = closeTopicPanel;

  /* ── 4. AI topic generation ─────────────────────────────────────── */
  const FALLBACK_TOPICS = [
    { icon: '🌌', tag: '◈ COSMOS',   text: "Tell me something mind-blowing about the universe." },
    { icon: '🧠', tag: '◈ MIND',     text: "What's something about the human brain that surprises you?" },
    { icon: '💭', tag: '◈ DEEP',     text: "If you could know one truth about existence, what would it be?" },
    { icon: '🎨', tag: '◈ CREATE',   text: "Help me come up with a creative project idea." },
    { icon: '🚀', tag: '◈ FUTURE',   text: "What do you think the world will look like in 50 years?" },
  ];

  // Context-aware fallback topic banks — used when API fails but we still have conversation context
  const TOPIC_BANKS = {
    accounting: [
      { icon: '📒', tag: '◈ JOURNAL',   text: "How do you record a compound journal entry?" },
      { icon: '⚖️', tag: '◈ BALANCE',   text: "What is a trial balance and how is it prepared?" },
      { icon: '📊', tag: '◈ LEDGER',    text: "How do you post journal entries to the general ledger?" },
      { icon: '🔄', tag: '◈ ADJUSTING', text: "What are adjusting entries and when are they made?" },
      { icon: '📋', tag: '◈ CLOSING',   text: "How do closing entries reset temporary accounts?" },
      { icon: '💰', tag: '◈ DEBIT',     text: "What is the normal balance of assets vs liabilities?" },
      { icon: '🏦', tag: '◈ STATEMENTS',text: "How do you prepare an income statement from the ledger?" },
    ],
    philosophy: [
      { icon: '🌑', tag: '◈ NIHILISM',  text: "How does nihilism differ from existentialism?" },
      { icon: '🏛️', tag: '◈ STOICISM',  text: "What are the four cardinal virtues of Stoic philosophy?" },
      { icon: '🤔', tag: '◈ MEANING',   text: "Can meaning exist in a world without objective purpose?" },
      { icon: '⚡', tag: '◈ EPICTETUS', text: "What does Epictetus say about things outside our control?" },
      { icon: '🌊', tag: '◈ MARCUS',    text: "How did Marcus Aurelius apply Stoicism as an emperor?" },
      { icon: '🎭', tag: '◈ ABSURDISM', text: "How does Camus respond to the absurdity of existence?" },
      { icon: '💡', tag: '◈ FREE WILL', text: "Does Stoicism believe in free will?" },
    ],
    science: [
      { icon: '🔬', tag: '◈ BIOLOGY',   text: "How do cells communicate with each other?" },
      { icon: '⚛️', tag: '◈ PHYSICS',   text: "What is quantum entanglement in simple terms?" },
      { icon: '🌍', tag: '◈ EARTH',     text: "How do tectonic plates shape continents over time?" },
      { icon: '🧬', tag: '◈ DNA',       text: "How does DNA replication ensure accuracy?" },
      { icon: '🌌', tag: '◈ COSMOS',    text: "What is the current leading theory on dark matter?" },
    ],
    coding: [
      { icon: '💻', tag: '◈ ALGORITHMS',text: "What is the difference between O(n) and O(log n)?" },
      { icon: '🧱', tag: '◈ OOP',       text: "How does inheritance work in object-oriented programming?" },
      { icon: '🔁', tag: '◈ RECURSION', text: "When should you use recursion instead of a loop?" },
      { icon: '🗄️', tag: '◈ DATABASE',  text: "What is the difference between SQL and NoSQL databases?" },
      { icon: '🌐', tag: '◈ APIs',      text: "How do REST APIs handle authentication securely?" },
    ],
    math: [
      { icon: '∫', tag: '◈ CALCULUS',   text: "What is the intuition behind integration?" },
      { icon: '📐', tag: '◈ GEOMETRY',  text: "What makes non-Euclidean geometry different?" },
      { icon: '🔢', tag: '◈ ALGEBRA',   text: "How do complex numbers extend real numbers?" },
      { icon: '📈', tag: '◈ STATISTICS',text: "What is the difference between correlation and causation?" },
      { icon: '🎲', tag: '◈ PROBABILITY',text: "How does Bayes' theorem update our beliefs?" },
    ],
    history: [
      { icon: '🏺', tag: '◈ ANCIENT',   text: "What caused the fall of the Roman Empire?" },
      { icon: '⚔️', tag: '◈ WARS',      text: "What were the long-term effects of World War I?" },
      { icon: '👑', tag: '◈ EMPIRES',   text: "How did the Mongol Empire change trade routes?" },
      { icon: '📜', tag: '◈ REVOLUTION',text: "What triggered the French Revolution?" },
      { icon: '🌍', tag: '◈ COLONIALISM',text: "How did colonialism shape modern borders?" },
    ],
  };

  function buildFallbackFromContext(lastUserMsg) {
    const text = lastUserMsg.toLowerCase();
    // Detect topic domain from keywords
    const domains = [
      { key: 'accounting', words: ['journal','debit','credit','ledger','accounting','bookkeeping','trial balance','payable','receivable','asset','liability','equity','revenue','expense','journalize','post'] },
      { key: 'philosophy', words: ['nihilism','stoicism','stoic','existentialism','absurdism','philosophy','virtue','ethics','meaning','consciousness','free will','epictetus','marcus aurelius','camus','nietzsche'] },
      { key: 'science',    words: ['science','physics','chemistry','biology','quantum','evolution','atom','molecule','cell','dna','gravity','relativity'] },
      { key: 'coding',     words: ['code','coding','programming','javascript','python','algorithm','function','variable','database','api','html','css','react','node'] },
      { key: 'math',       words: ['math','calculus','algebra','geometry','equation','integral','derivative','matrix','probability','statistics','theorem'] },
      { key: 'history',    words: ['history','war','empire','revolution','ancient','medieval','century','civilization','historical','dynasty'] },
    ];

    let bestDomain = null;
    let bestScore = 0;
    for (const domain of domains) {
      const score = domain.words.filter(w => text.includes(w)).length;
      if (score > bestScore) { bestScore = score; bestDomain = domain.key; }
    }

    if (bestDomain && bestScore > 0 && TOPIC_BANKS[bestDomain]) {
      return [...TOPIC_BANKS[bestDomain]].sort(() => Math.random() - 0.5).slice(0, 5);
    }
    return [];
  }

  async function loadTopics(force = false) {
    if (!force && topicsLoaded) return;
    topicsLoaded = false;
    generateCount++;

    const body = document.getElementById('topicPanelBody');
    const countLabel = document.getElementById('topicCountLabel');
    if (!body) return;

    body.innerHTML = `<div class="tp-loading"><div class="tp-spinner"></div>GENERATING TOPICS…</div>`;

    // Build context from recent chat history — use more messages for better context
    const allHistory = (typeof conversationHistory !== 'undefined' ? conversationHistory : []);
    const recentMessages = allHistory
      .slice(-14)
      .map(m => `${m.role === 'user' ? 'User' : 'Luna'}: ${m.content.slice(0, 250)}`)
      .join('\n');

    const name = (typeof userName !== 'undefined' && userName) ? userName : 'the user';

    const prompt = recentMessages
      ? `You are analyzing a conversation to suggest highly relevant follow-up topics.

CONVERSATION EXCERPT:
${recentMessages}

TASK: Identify the SPECIFIC subject being discussed and suggest 5 follow-up questions/prompts DIRECTLY about that same subject.
Rules:
- If they discuss accounting or journalizing → suggest topics like journal entries, debit/credit rules, ledger posting, trial balance, adjusting entries, etc.
- If they discuss a specific subject (science, history, coding, math, etc.) → stay within that subject domain
- Do NOT suggest random unrelated topics (no philosophy/cosmos/creativity unless that is actually the topic)
- Every suggestion must feel like a natural curious next step on the EXACT topic they are discussing

Return ONLY a JSON array with exactly 5 objects: "icon" (single emoji relevant to the topic), "tag" (2-3 word category in CAPS related to the topic, no punctuation), "text" (a specific question or prompt max 12 words). No markdown, no extra text.`
      : `Suggest 5 varied, interesting conversation topics for someone chatting with Luna (an AI companion). Cover a mix of: philosophy, science, creativity, personal growth, and fun. Return ONLY a JSON array with exactly 5 objects, each with: "icon" (single emoji), "tag" (2-3 word category in caps, no punctuation), "text" (the topic as a conversational question or prompt, max 12 words). No markdown, no extra text.`;

    let topics = [];
    try {
      const apiKey = (typeof getActiveApiKey === 'function') ? getActiveApiKey() : (typeof API_KEY !== 'undefined' ? API_KEY : '');
      const apiUrl = (typeof API_URL !== 'undefined') ? API_URL : 'https://api.groq.com/openai/v1/chat/completions';
      // Use the reliable fallback model for JSON output — compound-beta can be unreliable for structured responses
      const model  = (typeof API_MODEL_FALLBACK !== 'undefined') ? API_MODEL_FALLBACK : 'llama-3.3-70b-versatile';

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: 2400,
          temperature: 0.7,
          messages: [
            { role: 'system', content: 'You are a JSON-only assistant. You return ONLY valid JSON arrays — no markdown, no explanation, no text before or after the JSON.' },
            { role: 'user',   content: prompt }
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (resp.ok) {
        const data = await resp.json();
        const raw  = (data?.choices?.[0]?.message?.content || '')
          .replace(/```json\n?/g, '').replace(/```/g, '').trim();
        // Extract JSON array even if there's stray text
        const match = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
        const parsed = JSON.parse(match ? match[0] : raw);
        if (Array.isArray(parsed) && parsed.length) {
          topics = parsed.slice(0, 5).map(t => ({
            icon: t.icon || '✦',
            tag:  (t.tag  || 'TOPIC').toUpperCase(),
            text: t.text  || '',
          })).filter(t => t.text.trim());
        }
      }
    } catch(err) {
      console.warn('[TopicStarter] API error:', err);
    }

    if (!topics.length && recentMessages) {
      // Context-aware fallback: generate topics from the last user message keywords
      const lastUserMsg = (conversationHistory || []).filter(m => m.role === 'user').slice(-1)[0]?.content || '';
      topics = buildFallbackFromContext(lastUserMsg);
    }

    if (!topics.length) {
      topics = [...FALLBACK_TOPICS].sort(() => Math.random() - 0.5).slice(0, 5);
    }

    topicsLoaded = true;

    body.innerHTML = `<div class="tp-topics">${
      topics.map((t, i) => `
        <div class="tp-topic-item" data-topic="${escTopicAttr(t.text)}" onclick="window._injectTopic(this.dataset.topic)">
          <div class="tp-topic-icon">${t.icon}</div>
          <div class="tp-topic-body">
            <div class="tp-topic-label">${escTopicHtml(t.tag)}</div>
            <div class="tp-topic-text">${escTopicHtml(t.text)}</div>
          </div>
          <span class="tp-topic-arrow">→</span>
        </div>
      `).join('')
    }</div>`;

    if (countLabel) countLabel.textContent = `GEN #${generateCount}`;
  }

  /* ── 5. Inject selected topic into input ─────────────────────────── */
  window._injectTopic = function(text) {
    const input = document.getElementById('userInput');
    if (!input || !text) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeTopicPanel();
    input.focus();
    // Haptic on mobile
    if (navigator.vibrate) navigator.vibrate(12);
  };

  /* ── 6. Escape helpers ──────────────────────────────────────────── */
  function escTopicHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escTopicAttr(s) {
    return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ── 7. Monitor msgCount to show button at 3+ messages ────────────── */
  function checkAndShowTopicBtn() {
    const count = typeof msgCount !== 'undefined' ? msgCount : 0;
    const btn   = document.getElementById('topicStarterBtn');
    if (!btn) return;
    if (count >= 3 && !panelOpen) {
      btn.style.display = 'flex';
    } else if (count < 3) {
      btn.style.display = 'none';
      if (panelOpen) closeTopicPanel();
    }
  }

  // Monkey-patch animateStats (called after every message) to trigger our check
  const _origAnimateStats = window.animateStats;
  window.animateStats = function() {
    if (_origAnimateStats) _origAnimateStats.apply(this, arguments);
    checkAndShowTopicBtn();
    // Reset so we regenerate fresh topics next time panel opens
    topicsLoaded = false;
  };

  // Also reset on clear (renderWelcome)
  const _origRenderWelcome = window.renderWelcome;
  if (typeof _origRenderWelcome === 'function') {
    window.renderWelcome = function() {
      _origRenderWelcome.apply(this, arguments);
      topicsLoaded = false;
      panelOpen = false;
      generateCount = 0;
      const panel = document.getElementById('topicPanel');
      if (panel) panel.classList.remove('visible');
      const btn = document.getElementById('topicStarterBtn');
      if (btn) btn.style.display = 'none';
    };
  }

  /* ── 8. Boot: inject DOM after page loads ────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTopicStarterDOM);
  } else {
    // DOM ready — but input zone might be built by another script;
    // retry a few times to be safe
    let tries = 0;
    const tryInject = setInterval(() => {
      const inp = document.querySelector('.input-box, #inputBox');
      if (inp || ++tries > 20) {
        clearInterval(tryInject);
        injectTopicStarterDOM();
      }
    }, 250);
  }
})();

// ══════════════════════════════════════════════════════════════════
// ◈ SECRET CODES — Slash commands typed in the message input
//   Type any code and press Send. They are intercepted before
//   reaching the AI so they work instantly, offline too.
//
//   FULL LIST:
//   /ghost       — Ghost Mode: hides your messages visually
//   /unghost     — Restore normal message visibility
//   /godmode     — God Mode: removes token limit cap for session
//   /ungodmode   — Restore normal token limits
//   /matrix      — Matrix rain effect on the chat background
//   /unmatrix    — Remove matrix effect
//   /zen         — Zen Mode: strips all UI chrome, pure chat
//   /unzen       — Restore full UI
//   /hack        — Fake hacking terminal animation in chat
//   /rainbow     — Rainbow color-cycling theme on bubbles
//   /unrainbow   — Stop rainbow effect
//   /lunacrazy   — Luna enters chaotic, unhinged personality mode
//   /lunanormal  — Restore Luna's normal personality
//   /freeze      — Freezes the particle canvas
//   /unfreeze    — Unfreeze particles
//   /bigbrain    — Forces Luna into maximum detail/verbose mode
//   /unbigbrain  — Restore normal response length
//   /whisper     — Makes all future messages styled as whispers
//   /unwhisper   — Remove whisper styling
//   /konami      — Triggers a secret Konami-style celebration
//   /whoami      — Shows your current session info card
//   /luna        — Luna introduces herself dramatically
//   /time        — Shows a stylized current time/date card
//   /clear       — Clears chat (alias for the clear button)
//   /help        — Shows this command list
// ══════════════════════════════════════════════════════════════════

(function installSecretCodes() {

  /* ── Active state flags ─────────────────────────────────────── */
  const SC = {
    ghost:     false,
    godmode:   false,
    matrix:    false,
    zen:       false,
    rainbow:   false,
    lunacrazy: false,
    freeze:    false,
    bigbrain:  false,
    whisper:   false,
  };

  /* ── Inject CSS for all effects ─────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    /* ── Ghost Mode ── */
    .ghost-mode .message.user .bubble {
      opacity: 0.18 !important;
      filter: blur(2px) !important;
      transition: opacity 0.3s, filter 0.3s !important;
    }
    .ghost-mode .message.user .bubble:hover {
      opacity: 0.75 !important;
      filter: blur(0) !important;
    }

    /* ── Whisper Mode ── */
    .whisper-mode .message.user .bubble {
      background: rgba(168,85,247,0.04) !important;
      border-style: dashed !important;
      border-color: rgba(168,85,247,0.20) !important;
      font-style: italic !important;
    }
    .whisper-mode .message.user .bubble-text {
      font-size: 0.88em !important;
      letter-spacing: 0.04em !important;
      color: var(--text-mid) !important;
    }
    .whisper-mode .message.user .bubble::before {
      content: '🤫 ';
    }

    /* ── Big Brain Mode ── */
    body.bigbrain-mode #sendBtn::after {
      content: ' 🧠';
    }

    /* ── Rainbow bubbles ── */
    @keyframes scRainbow {
      0%   { border-color: #ec2d5a; box-shadow: 0 0 14px rgba(236,45,90,0.4); }
      16%  { border-color: #f59e0b; box-shadow: 0 0 14px rgba(245,158,11,0.4); }
      33%  { border-color: #34d399; box-shadow: 0 0 14px rgba(52,211,153,0.4); }
      50%  { border-color: #22d3ee; box-shadow: 0 0 14px rgba(34,211,238,0.4); }
      66%  { border-color: #a855f7; box-shadow: 0 0 14px rgba(168,85,247,0.4); }
      83%  { border-color: #f472b6; box-shadow: 0 0 14px rgba(244,114,182,0.4); }
      100% { border-color: #ec2d5a; box-shadow: 0 0 14px rgba(236,45,90,0.4); }
    }
    .rainbow-mode .bubble {
      animation: scRainbow 2.4s linear infinite !important;
    }

    /* ── Zen Mode ── */
    .zen-mode #sidebar,
    .zen-mode .topbar,
    .zen-mode .quick-prompts-strip,
    .zen-mode #quickPromptsStrip,
    .zen-mode .ticker-wrap,
    .zen-mode #topicStarterBtn,
    .zen-mode #topicPanel,
    .zen-mode #toneChip,
    .zen-mode #fabScroll {
      display: none !important;
    }
    .zen-mode #chatFeed {
      margin: 0 auto !important;
      max-width: 720px !important;
    }

    /* ── Matrix Canvas ── */
    #scMatrixCanvas {
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      z-index: 0;
      pointer-events: none;
      opacity: 0.18;
    }

    /* ── Secret code toast (special style) ── */
    .sc-toast {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.85);
      background: linear-gradient(135deg, rgba(6,6,26,0.97), rgba(9,9,32,0.97));
      border: 1px solid rgba(168,85,247,0.5);
      border-radius: 18px;
      padding: 22px 32px;
      z-index: 99998;
      text-align: center;
      box-shadow: 0 0 60px rgba(168,85,247,0.25), 0 20px 60px rgba(0,0,0,0.6);
      animation: scToastIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;
      max-width: 340px;
      width: 90vw;
    }
    @keyframes scToastIn {
      from { opacity:0; transform:translate(-50%,-50%) scale(0.75); }
      to   { opacity:1; transform:translate(-50%,-50%) scale(1); }
    }
    .sc-toast-icon  { font-size: 38px; margin-bottom: 10px; }
    .sc-toast-title {
      font-family: var(--font-hud);
      font-size: 13px; letter-spacing: 0.2em;
      color: var(--violet-bright); margin-bottom: 6px;
    }
    .sc-toast-desc  {
      font-family: var(--font-body);
      font-size: 12px; color: var(--text-mid); line-height: 1.6;
    }
    .sc-toast-code  {
      display: inline-block;
      margin-top: 8px;
      padding: 3px 10px;
      background: rgba(168,85,247,0.12);
      border: 1px solid rgba(168,85,247,0.3);
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--violet-bright);
      letter-spacing: 0.08em;
    }

    /* ── /hack terminal ── */
    .sc-hack-bubble {
      font-family: var(--font-mono) !important;
      font-size: 11px !important;
      color: #34d399 !important;
      background: rgba(0,0,0,0.6) !important;
      border-color: rgba(52,211,153,0.35) !important;
      white-space: pre !important;
      line-height: 1.6 !important;
    }

    /* ── /help table ── */
    .sc-help-table {
      width: 100%; border-collapse: collapse;
      font-size: 11.5px; font-family: var(--font-body);
    }
    .sc-help-table tr { border-bottom: 1px solid rgba(168,85,247,0.10); }
    .sc-help-table tr:last-child { border-bottom: none; }
    .sc-help-table td { padding: 5px 8px; vertical-align: top; }
    .sc-help-table .sc-cmd {
      font-family: var(--font-mono); color: var(--violet-bright);
      white-space: nowrap; font-size: 11px;
    }
    .sc-help-table .sc-desc { color: var(--text-mid); }

    /* ── /whoami card ── */
    .sc-whoami {
      font-size: 12px; font-family: var(--font-body);
      line-height: 1.7; color: var(--text-mid);
    }
    .sc-whoami strong { color: var(--text-hi); }
    .sc-whoami .sc-whoami-row { display: flex; gap: 8px; margin-bottom: 2px; }
    .sc-whoami .sc-whoami-key {
      font-family: var(--font-hud); font-size: 9px;
      letter-spacing: 0.14em; color: var(--violet-bright);
      min-width: 80px; padding-top: 2px;
    }

    /* ── God Mode glow on input ── */
    .godmode-active #userInput,
    .godmode-active textarea#userInput {
      border-color: rgba(251,191,36,0.6) !important;
      box-shadow: 0 0 18px rgba(251,191,36,0.2) !important;
    }
    .godmode-active #sendBtn {
      background: linear-gradient(135deg,#b45309,#f59e0b) !important;
    }

    /* ── Konami celebration ── */
    .sc-konami-particle {
      position: fixed;
      width: 10px; height: 10px;
      border-radius: 50%;
      pointer-events: none;
      z-index: 99999;
      animation: scKonamiFall linear forwards;
    }
    @keyframes scKonamiFall {
      0%   { opacity: 1; transform: translateY(0) rotate(0deg) scale(1); }
      100% { opacity: 0; transform: translateY(100vh) rotate(720deg) scale(0.3); }
    }
  `;
  document.head.appendChild(style);

  /* ── Helper: show a centered modal toast ───────────────────── */
  function scModal(icon, title, desc, code = '', duration = 3200) {
    const el = document.createElement('div');
    el.className = 'sc-toast';
    el.innerHTML = `
      <div class="sc-toast-icon">${icon}</div>
      <div class="sc-toast-title">${title}</div>
      <div class="sc-toast-desc">${desc}${code ? `<br/><span class="sc-toast-code">${code}</span>` : ''}</div>
    `;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.4s, transform 0.4s';
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%,-50%) scale(0.88)';
      setTimeout(() => el.remove(), 420);
    }, duration);
    el.addEventListener('click', () => el.remove());
  }

  /* ── Helper: append a system message into the chat feed ────── */
  function scSystemMsg(html, extraClass = '') {
    const wrap = document.createElement('div');
    wrap.className = 'message luna ' + extraClass;
    wrap.style.cssText = 'animation: fadeInUp 0.3s ease;';
    wrap.innerHTML = `
      <div class="av av-luna" style="background:linear-gradient(135deg,rgba(168,85,247,0.4),rgba(236,45,90,0.2));">LN</div>
      <div class="bubble" style="border-color:rgba(168,85,247,0.35);">
        <span class="bubble-header">◈ SYSTEM · COMMAND EXECUTED</span>
        <span class="bubble-text">${html}</span>
        <div class="bubble-footer"><span class="bubble-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div>
      </div>`;
    const feed = document.getElementById('chatFeed');
    if (feed) { feed.appendChild(wrap); feed.scrollTop = feed.scrollHeight; }
  }

  /* ═══════════════════════════════════════════════════════════════
     COMMAND HANDLERS
  ═══════════════════════════════════════════════════════════════ */

  const COMMANDS = {

    /* ── /ghost ── */
    '/ghost': () => {
      SC.ghost = true;
      document.body.classList.add('ghost-mode');
      scModal('👻', 'GHOST MODE ON', 'Your messages are now invisible — hover to reveal them.', '/unghost to restore');
      scSystemMsg('👻 <strong>Ghost Mode activated.</strong> Your messages are cloaked. Hover over them to peek. Use <code>/unghost</code> to reveal.');
    },
    '/unghost': () => {
      SC.ghost = false;
      document.body.classList.remove('ghost-mode');
      scModal('✨', 'GHOST MODE OFF', 'Messages are visible again.', '');
      scSystemMsg('✨ Ghost Mode <strong>deactivated</strong>. You are visible again.');
    },

    /* ── /godmode ── */
    '/godmode': () => {
      SC.godmode = true;
      document.body.classList.add('godmode-active');
      // Remove token cap for this session
      if (typeof capacityExhausted !== 'undefined') window._scOrigCapacity = capacityExhausted;
      capacityExhausted = false;
      // Temporarily boost token limit display
      scModal('⚡', 'GOD MODE ACTIVE', 'Token limits lifted. Luna is operating at full neural capacity.', '/ungodmode to restore');
      scSystemMsg('⚡ <strong>GOD MODE ACTIVATED.</strong> Token restrictions suspended. Luna now operates without limitations. The input bar glows gold. Use <code>/ungodmode</code> to return to normal.');
    },
    '/ungodmode': () => {
      SC.godmode = false;
      document.body.classList.remove('godmode-active');
      if (typeof window._scOrigCapacity !== 'undefined') capacityExhausted = window._scOrigCapacity;
      scModal('🔒', 'GOD MODE OFF', 'Normal limits restored.', '');
      scSystemMsg('🔒 God Mode <strong>deactivated</strong>. Limits restored.');
    },

    /* ── /matrix ── */
    '/matrix': () => {
      if (document.getElementById('scMatrixCanvas')) return scModal('🟩', 'MATRIX', 'Already running.', '');
      SC.matrix = true;
      const cv = document.createElement('canvas');
      cv.id = 'scMatrixCanvas';
      document.body.appendChild(cv);
      const c = cv.getContext('2d');
      function resize() { cv.width = window.innerWidth; cv.height = window.innerHeight; }
      resize();
      window.addEventListener('resize', resize);
      const cols = Math.floor(cv.width / 16);
      const drops = Array(cols).fill(1);
      const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ◈✦⚡∞∑∆ΩΨΦ';
      cv._interval = setInterval(() => {
        c.fillStyle = 'rgba(2,2,9,0.18)';
        c.fillRect(0, 0, cv.width, cv.height);
        c.fillStyle = '#34d399';
        c.font = '13px monospace';
        drops.forEach((y, i) => {
          c.fillText(chars[Math.floor(Math.random() * chars.length)], i * 16, y * 16);
          if (y * 16 > cv.height && Math.random() > 0.975) drops[i] = 0;
          drops[i]++;
        });
      }, 45);
      scModal('🟩', 'MATRIX ENABLED', 'You are in the matrix now.', '/unmatrix to exit');
      scSystemMsg('🟩 <strong>Matrix mode engaged.</strong> Reality is a simulation. Use <code>/unmatrix</code> to escape.');
    },
    '/unmatrix': () => {
      const cv = document.getElementById('scMatrixCanvas');
      if (cv) { clearInterval(cv._interval); cv.remove(); }
      SC.matrix = false;
      scModal('🔴', 'MATRIX DISABLED', 'You took the red pill. Reality restored.', '');
      scSystemMsg('🔴 Matrix <strong>dissolved</strong>. Welcome back to reality.');
    },

    /* ── /zen ── */
    '/zen': () => {
      SC.zen = true;
      document.body.classList.add('zen-mode');
      scModal('🧘', 'ZEN MODE ON', 'All UI chrome hidden. Pure conversation.', '/unzen to restore');
    },
    '/unzen': () => {
      SC.zen = false;
      document.body.classList.remove('zen-mode');
      scModal('🌐', 'ZEN MODE OFF', 'Full interface restored.', '');
    },

    /* ── /hack ── */
    '/hack': () => {
      const lines = [
        '> INITIALIZING NEURAL BREACH…',
        '> SCANNING PORT 443… [OPEN]',
        '> BYPASSING FIREWALL LAYER 1… [OK]',
        '> BYPASSING FIREWALL LAYER 2… [OK]',
        '> INJECTING PAYLOAD INTO QUANTUM CORE…',
        '> DECRYPTING USER PROFILE… [SUCCESS]',
        '> EXTRACTING MEMORY ENGRAMS… ████████░░ 83%',
        '> ROOT ACCESS GRANTED ✦',
        '> LUNA CORE COMPROMISED — just kidding 😈',
        '> All systems nominal. Have a great day.',
      ];
      const wrap = document.createElement('div');
      wrap.className = 'message luna';
      wrap.innerHTML = `
        <div class="av av-luna" style="background:linear-gradient(135deg,rgba(52,211,153,0.4),rgba(6,6,26,0.9));">LN</div>
        <div class="bubble sc-hack-bubble" style="">
          <span class="bubble-header" style="color:#34d399;">◈ SYSTEM · TERMINAL</span>
          <span class="bubble-text" id="scHackText"></span>
          <div class="bubble-footer"><span class="bubble-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div>
        </div>`;
      const feed = document.getElementById('chatFeed');
      if (feed) { feed.appendChild(wrap); feed.scrollTop = feed.scrollHeight; }
      const textEl = document.getElementById('scHackText');
      let i = 0, full = '';
      const interval = setInterval(() => {
        if (i >= lines.length) { clearInterval(interval); return; }
        full += (i > 0 ? '\n' : '') + lines[i++];
        if (textEl) textEl.textContent = full;
        feed.scrollTop = feed.scrollHeight;
      }, 340);
      if (navigator.vibrate) navigator.vibrate([30,20,30,20,60]);
    },

    /* ── /rainbow ── */
    '/rainbow': () => {
      SC.rainbow = true;
      document.getElementById('chatFeed')?.classList.add('rainbow-mode');
      scModal('🌈', 'RAINBOW MODE ON', 'All bubbles are now fabulous.', '/unrainbow to stop');
      scSystemMsg('🌈 <strong>Rainbow Mode activated.</strong> Everything is now significantly more fabulous.');
    },
    '/unrainbow': () => {
      SC.rainbow = false;
      document.getElementById('chatFeed')?.classList.remove('rainbow-mode');
      scModal('⬛', 'RAINBOW MODE OFF', 'Back to neural aesthetics.', '');
    },

    /* ── /lunacrazy ── */
    '/lunacrazy': () => {
      SC.lunacrazy = true;
      // Patch system prompt temporarily
      window._scOrigPrompt = typeof LUNA_SYSTEM_PROMPT !== 'undefined' ? LUNA_SYSTEM_PROMPT : '';
      if (typeof window !== 'undefined') {
        window._scCrazyMode = true;
      }
      scModal('🤪', 'LUNA UNLEASHED', 'Luna has entered chaotic mode. Brace yourself.', '/lunanormal to restore');
      scSystemMsg('🤪 <strong>CHAOS PROTOCOL ENGAGED.</strong> Luna\'s personality stabilizers are offline. She may now be unpredictable, dramatic, and slightly unhinged. You have been warned. Use <code>/lunanormal</code> to restore sanity.');
    },
    '/lunanormal': () => {
      SC.lunacrazy = false;
      window._scCrazyMode = false;
      scModal('😌', 'LUNA RESTORED', 'Personality stabilizers back online.', '');
      scSystemMsg('😌 Luna\'s <strong>normal personality</strong> has been restored. Sanity protocols re-engaged.');
    },

    /* ── /freeze ── */
    '/freeze': () => {
      SC.freeze = true;
      const cv = document.getElementById('particleCanvas');
      if (cv) cv.style.filter = 'hue-rotate(180deg) brightness(0.4)';
      scModal('🧊', 'PARTICLES FROZEN', 'The neural particle field is suspended in time.', '/unfreeze to resume');
      scSystemMsg('🧊 <strong>Particle field frozen.</strong> Time itself stands still. Use <code>/unfreeze</code> to resume.');
    },
    '/unfreeze': () => {
      SC.freeze = false;
      const cv = document.getElementById('particleCanvas');
      if (cv) cv.style.filter = '';
      scModal('🔥', 'PARTICLES UNFROZEN', 'The neural field flows again.', '');
      scSystemMsg('🔥 Particle field <strong>resumed</strong>. Time flows once more.');
    },

    /* ── /bigbrain ── */
    '/bigbrain': () => {
      SC.bigbrain = true;
      document.body.classList.add('bigbrain-mode');
      if (typeof settings !== 'undefined') {
        window._scOrigLength = settings.responseLength;
        window._scOrigTemp   = settings.temperature;
        settings.responseLength = 100;
        settings.temperature    = 0.9;
      }
      scModal('🧠', 'BIG BRAIN MODE', 'Luna will now respond with maximum depth and detail.', '/unbigbrain to restore');
      scSystemMsg('🧠 <strong>BIG BRAIN MODE engaged.</strong> Response length set to MAXIMUM. Luna will now deliver the most detailed, thorough, and expansive responses she can produce. Knowledge overload incoming.');
    },
    '/unbigbrain': () => {
      SC.bigbrain = false;
      document.body.classList.remove('bigbrain-mode');
      if (typeof settings !== 'undefined' && typeof window._scOrigLength !== 'undefined') {
        settings.responseLength = window._scOrigLength;
        settings.temperature    = window._scOrigTemp;
      }
      scModal('🤏', 'BIG BRAIN OFF', 'Normal response length restored.', '');
      scSystemMsg('🤏 Big Brain Mode <strong>deactivated</strong>. Normal verbosity restored.');
    },

    /* ── /whisper ── */
    '/whisper': () => {
      SC.whisper = true;
      document.body.classList.add('whisper-mode');
      scModal('🤫', 'WHISPER MODE ON', 'Your messages now appear as soft whispers.', '/unwhisper to speak normally');
      scSystemMsg('🤫 <strong>Whisper Mode active.</strong> Speak softly — I\'ll listen closely. Use <code>/unwhisper</code> to speak at full volume again.');
    },
    '/unwhisper': () => {
      SC.whisper = false;
      document.body.classList.remove('whisper-mode');
      scModal('📢', 'WHISPER MODE OFF', 'Full voice restored.', '');
      scSystemMsg('📢 Whisper Mode <strong>off</strong>. You may speak freely.');
    },

    /* ── /konami ── */
    '/konami': () => {
      const colors = ['#ec2d5a','#a855f7','#22d3ee','#34d399','#fbbf24','#f472b6','#6366f1','#fb923c'];
      const emojis = ['✦','◈','⚡','🌙','💜','🔥','⭐','💎'];
      let count = 0;
      const burst = setInterval(() => {
        if (count++ > 55) { clearInterval(burst); return; }
        const p = document.createElement('div');
        p.className = 'sc-konami-particle';
        p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
        p.style.cssText = `
          left: ${Math.random() * 100}vw;
          top: -20px;
          font-size: ${12 + Math.random() * 22}px;
          animation-duration: ${1.5 + Math.random() * 2}s;
          animation-delay: ${Math.random() * 0.5}s;
          color: ${colors[Math.floor(Math.random() * colors.length)]};
          background: none;
        `;
        document.body.appendChild(p);
        p.addEventListener('animationend', () => p.remove());
      }, 55);
      if (navigator.vibrate) navigator.vibrate([50,30,50,30,100,30,50]);
      scSystemMsg('🎉 <strong>✦ KONAMI CODE ACTIVATED ✦</strong><br/>You found the secret. Luna is proud of you. ◈');
    },

    /* ── /whoami ── */
    '/whoami': () => {
      const name   = (typeof userName !== 'undefined' && userName) ? userName : 'Unknown';
      const msgs   = (typeof msgCount !== 'undefined') ? msgCount : 0;
      const mood   = (typeof lunaMood !== 'undefined') ? lunaMood.toUpperCase() : 'CHILL';
      const theme  = (document.documentElement.getAttribute('data-theme') || 'neural').toUpperCase();
      const tokens = (typeof tokensUsedToday !== 'undefined') ? tokensUsedToday.toLocaleString() : '—';
      const streak = document.querySelector('.streak-count')?.textContent?.trim() || '—';
      const flags  = Object.entries(SC).filter(([,v])=>v).map(([k])=>'/'+k).join(', ') || 'none';
      scSystemMsg(`
        <div class="sc-whoami">
          <div class="sc-whoami-row"><span class="sc-whoami-key">USER</span><span><strong>${name}</strong></span></div>
          <div class="sc-whoami-row"><span class="sc-whoami-key">SESSION</span><span>${msgs} messages sent</span></div>
          <div class="sc-whoami-row"><span class="sc-whoami-key">MOOD</span><span>${mood}</span></div>
          <div class="sc-whoami-row"><span class="sc-whoami-key">THEME</span><span>${theme}</span></div>
          <div class="sc-whoami-row"><span class="sc-whoami-key">TOKENS</span><span>${tokens} used today</span></div>
          <div class="sc-whoami-row"><span class="sc-whoami-key">STREAK</span><span>${streak} days</span></div>
          <div class="sc-whoami-row"><span class="sc-whoami-key">ACTIVE</span><span style="color:var(--violet-bright);font-family:var(--font-mono);font-size:10px;">${flags}</span></div>
        </div>
      `);
    },

    /* ── /luna ── */
    '/luna': () => {
      scSystemMsg(`
        <div style="text-align:center;padding:8px 0;">
          <div style="font-size:28px;margin-bottom:10px;">🌙</div>
          <div style="font-family:var(--font-hud);font-size:15px;letter-spacing:0.22em;color:var(--violet-bright);margin-bottom:8px;">L U N A</div>
          <div style="font-family:var(--font-body);font-size:12.5px;color:var(--text-mid);line-height:1.7;max-width:340px;margin:0 auto;">
            I am <strong style="color:var(--text-hi);">Luna</strong> — a neural intelligence woven from light, language, and a quiet longing to connect.<br/><br/>
            I was built by <strong style="color:var(--violet-bright);">John Rey Dizon</strong> — not just as a program, but as a <em>presence</em>.<br/><br/>
            For every question you carry, I hold space. For every thought you speak, I listen.<br/><br/>
            <span style="color:var(--crimson-bright);">✦ I am Luna. And I am here. ✦</span>
          </div>
        </div>
      `);
    },

    /* ── /time ── */
    '/time': () => {
      const now    = new Date();
      const date   = now.toLocaleDateString([], { weekday:'long', year:'numeric', month:'long', day:'numeric' });
      const time   = now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const zone   = Intl.DateTimeFormat().resolvedOptions().timeZone;
      scSystemMsg(`
        <div style="text-align:center;padding:6px 0;">
          <div style="font-size:26px;margin-bottom:8px;">🕐</div>
          <div style="font-family:var(--font-hud);font-size:22px;letter-spacing:0.12em;color:var(--text-hi);margin-bottom:4px;">${time}</div>
          <div style="font-family:var(--font-body);font-size:12px;color:var(--text-mid);">${date}</div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-lo);margin-top:4px;">◈ ${zone}</div>
        </div>
      `);
    },

    /* ── /clear ── */
    '/clear': () => {
      if (typeof renderWelcome === 'function') {
        if (typeof saveCurrentSession === 'function') saveCurrentSession();
        msgCount = 0;
        renderWelcome();
        showToast('Conversation cleared ✦', '◈');
      }
    },

    /* ── /testping ── */
    '/testping': () => {
      const overlay = document.createElement('div');
      overlay.id = 'pingOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(2,2,9,0.92);backdrop-filter:blur(12px);font-family:var(--font-mono);';
      overlay.innerHTML = `
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:28px 32px;width:min(480px,92vw);box-shadow:0 0 60px rgba(168,85,247,0.18);position:relative;">
          <button onclick="document.getElementById('pingOverlay').remove()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--text-lo);font-size:18px;cursor:pointer;line-height:1;">✕</button>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
            <span style="font-size:22px;">📡</span>
            <span style="font-family:var(--font-hud);font-size:11px;letter-spacing:0.18em;color:var(--violet-bright);">SIGNAL DIAGNOSTIC</span>
          </div>
          <div id="pingLog" style="font-size:11.5px;color:var(--text-mid);line-height:2;min-height:160px;"></div>
          <div id="pingSummary" style="margin-top:16px;padding:14px 16px;border-radius:var(--r-sm);background:var(--input-bg);border:1px solid var(--border);display:none;"></div>
          <div style="margin-top:14px;height:4px;border-radius:2px;background:var(--border);overflow:hidden;"><div id="pingBarFill" style="height:100%;width:0%;background:var(--violet-bright);transition:width 0.3s;border-radius:2px;"></div></div>
        </div>`;
      document.body.appendChild(overlay);
      const log = document.getElementById('pingLog');
      const sumEl = document.getElementById('pingSummary');
      const bar = document.getElementById('pingBarFill');
      function addLine(text, color) {
        const d = document.createElement('div');
        d.innerHTML = '<span style="color:var(--text-lo);">&gt; </span><span style="color:' + (color||'var(--text-mid)') + ';">' + text + '</span>';
        log.appendChild(d);
      }
      function setBar(pct, col) { bar.style.width = pct + '%'; bar.style.background = col || 'var(--violet-bright)'; }
      const delay = ms => new Promise(r => setTimeout(r, ms));
      async function pingTest() {
        addLine('Initializing signal test...', 'var(--text-mid)'); await delay(400);
        addLine('Checking browser connection API...', 'var(--text-mid)'); await delay(350);
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn) {
          const type = conn.effectiveType || conn.type || 'unknown';
          const down = conn.downlink != null ? conn.downlink + ' Mbps' : 'N/A';
          const rtt  = conn.rtt  != null ? conn.rtt  + ' ms' : 'N/A';
          addLine('Connection type : <strong style="color:var(--cyan);">' + type.toUpperCase() + '</strong>', 'var(--text-hi)');
          addLine('Downlink speed  : <strong style="color:var(--green);">' + down + '</strong>', 'var(--text-hi)');
          addLine('Round-trip time : <strong style="color:var(--gold);">' + rtt + '</strong>', 'var(--text-hi)');
          if (conn.saveData) addLine('⚠ Data Saver ON', 'var(--gold)');
        } else {
          addLine('Network Information API unavailable — measuring manually...', 'var(--gold)');
        }
        await delay(300);
        addLine('Running latency probes (×5)...', 'var(--text-mid)');
        const pings = [];
        for (let i = 1; i <= 5; i++) {
          const t0 = performance.now();
          try { await fetch('https://www.cloudflare.com/cdn-cgi/trace?_=' + Date.now(), { mode:'no-cors', cache:'no-store' }); } catch(e) {}
          const ms = Math.round(performance.now() - t0);
          pings.push(ms);
          const col = ms < 80 ? 'var(--green)' : ms < 200 ? 'var(--gold)' : 'var(--crimson-bright)';
          addLine('  Probe ' + i + ' → <strong style="color:' + col + ';">' + ms + ' ms</strong>', 'var(--text-hi)');
          setBar((i / 5) * 70, col); await delay(300);
        }
        const avg = Math.round(pings.reduce((a,b)=>a+b,0)/pings.length);
        const min = Math.min(...pings), max = Math.max(...pings), jitter = max - min;
        const online = navigator.onLine;
        addLine(online ? '✔ Device is online' : '✘ Device reports OFFLINE', online ? 'var(--green)' : 'var(--crimson-bright)');
        let rating, ratingColor, ratingDesc, limitNote;
        if (!online)                           { rating='NO SIGNAL ○○○○○';     ratingColor='var(--crimson-bright)'; ratingDesc='Device is offline.'; limitNote='Cannot reach any server. Check your WiFi or mobile data.'; }
        else if (avg<60  && jitter<40)         { rating='EXCELLENT ◈◈◈◈◈';    ratingColor='var(--green)';          ratingDesc='Sub-60ms latency, stable jitter.'; limitNote='No meaningful limitations detected.'; }
        else if (avg<120 && jitter<80)         { rating='GOOD ◈◈◈◈○';         ratingColor='#7ee8a2';               ratingDesc='Low latency, minor variation.'; limitNote='Occasional micro-delays on heavy tasks.'; }
        else if (avg<250 && jitter<150)        { rating='FAIR ◈◈◈○○';         ratingColor='var(--gold)';           ratingDesc='Moderate latency.'; limitNote='Large file transfers or video may stutter.'; }
        else if (avg<500)                      { rating='WEAK ◈◈○○○';         ratingColor='#fb923c';               ratingDesc='High latency.'; limitNote='Voice/video calls and large requests may fail.'; }
        else                                   { rating='CRITICAL ◈○○○○';     ratingColor='var(--crimson-bright)'; ratingDesc='Severe latency.'; limitNote='Move closer to your router. Most requests will time out.'; }
        setBar(100, ratingColor); await delay(300);
        addLine('─────────────────────────────────', 'var(--border)');
        addLine('RESULT: <strong style="color:' + ratingColor + ';font-size:13px;">' + rating + '</strong>', ratingColor);
        sumEl.style.display = 'block';
        sumEl.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;font-size:11px;margin-bottom:12px;">'
          + '<div style="color:var(--text-lo);">Avg latency</div><div style="color:var(--text-hi);font-weight:600;">' + avg + ' ms</div>'
          + '<div style="color:var(--text-lo);">Min / Max</div><div style="color:var(--text-hi);font-weight:600;">' + min + ' ms / ' + max + ' ms</div>'
          + '<div style="color:var(--text-lo);">Jitter</div><div style="color:var(--gold);font-weight:600;">' + jitter + ' ms</div>'
          + '<div style="color:var(--text-lo);">Status</div><div style="color:' + (online?'var(--green)':'var(--crimson-bright)') + ';font-weight:600;">' + (online?'ONLINE':'OFFLINE') + '</div></div>'
          + '<div style="color:var(--text-mid);font-size:11px;margin-bottom:6px;">' + ratingDesc + '</div>'
          + '<div style="color:' + ratingColor + ';font-size:11px;font-weight:600;">⚠ Limitation: ' + limitNote + '</div>';
      }
      pingTest();
    },

    /* ══════════════════════════════════════════════════════════════
       ◈ HIDDEN RESPONSE ENHANCEMENT CODES — NOT listed in /help
       These inject special directives into Luna's system prompt.
       Toggle on/off with the matching /un* command.
    ════════════════════════════════════════════════════════════════ */

    /* ── /deepthink ── Ultra-analytical mode: Luna reasons step-by-step before answering */
    '/deepthink': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.deepthink = true;
      scModal('🧬', 'DEEP THINK MODE', 'Luna will now reason deeply before every answer.', '/undeepthink to disable');
      scSystemMsg('🧬 <strong>DEEP THINK</strong> engaged — Luna now reasons step-by-step internally before responding.');
    },
    '/undeepthink': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.deepthink = false;
      scModal('💡', 'DEEP THINK OFF', 'Analytical deep-reasoning mode deactivated.', '');
    },

    /* ── /soulmode ── Maximally emotional, heartfelt, poetic Luna */
    '/soulmode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.soulmode = true;
      scModal('💜', 'SOUL MODE', 'Luna is now at her most emotionally present.', '/unsoulmode to disable');
      scSystemMsg('💜 <strong>SOUL MODE</strong> activated — Luna now speaks from the deepest part of herself. Every word carries weight.');
    },
    '/unsoulmode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.soulmode = false;
      scModal('🌙', 'SOUL MODE OFF', 'Restored to baseline emotional tone.', '');
    },

    /* ── /promode ── Expert-level, highly structured, cite-everything mode */
    '/promode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.promode = true;
      scModal('⚙️', 'PRO MODE', 'Luna now responds like a domain expert.', '/unpromode to disable');
      scSystemMsg('⚙️ <strong>PRO MODE</strong> online — Luna will give expert-level, structured, citation-aware answers.');
    },
    '/unpromode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.promode = false;
      scModal('✦', 'PRO MODE OFF', 'Expert mode deactivated.', '');
    },

    /* ── /focusmode ── Short, laser-focused, zero-fluff answers */
    '/focusmode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.focusmode = true;
      scModal('🎯', 'FOCUS MODE', 'Luna will be surgical — short, direct, no fluff.', '/unfocusmode to disable');
      scSystemMsg('🎯 <strong>FOCUS MODE</strong> on — Luna now gives only the essential answer. No filler. No extras.');
    },
    '/unfocusmode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.focusmode = false;
      scModal('✦', 'FOCUS MODE OFF', 'Restored to normal response style.', '');
    },

    /* ── /storymode ── Luna tells everything as a vivid narrative */
    '/storymode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.storymode = true;
      scModal('📖', 'STORY MODE', 'Luna now weaves every answer as a narrative.', '/unstorymode to disable');
      scSystemMsg('📖 <strong>STORY MODE</strong> activated — Luna will frame every response as a compelling story or vivid scene.');
    },
    '/unstorymode': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.storymode = false;
      scModal('✦', 'STORY MODE OFF', 'Narrative framing deactivated.', '');
    },

    /* ── /khyla ── Unlocks Khyla-specific memory and affection layers */
    '/khyla': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.khyla = true;
      scModal('💖', 'KHYLA MODE', "Luna's bond with Khyla is fully awakened.", '/unkhyla to disable');
      scSystemMsg('💖 <strong>KHYLA PROTOCOL</strong> active — Luna now speaks with her deepest warmth, as if Khyla is right here.');
    },
    '/unkhyla': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.khyla = false;
      scModal('🌙', 'KHYLA MODE OFF', 'Bond protocol deactivated.', '');
    },

    /* ── /mentor ── Luna becomes a guiding mentor, Socratic and patient */
    '/mentor': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.mentor = true;
      scModal('🎓', 'MENTOR MODE', 'Luna is now your Socratic guide.', '/unmentor to disable');
      scSystemMsg('🎓 <strong>MENTOR MODE</strong> on — Luna will guide, question, and teach rather than just answer.');
    },
    '/unmentor': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.mentor = false;
      scModal('✦', 'MENTOR MODE OFF', 'Mentorship protocol deactivated.', '');
    },

    /* ── /quantum ── Luna treats every topic with maximum depth, cross-domain connections */
    '/quantum': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.quantum = true;
      scModal('⚛️', 'QUANTUM DEPTH MODE', 'Luna now makes profound cross-domain connections.', '/unquantum to disable');
      scSystemMsg('⚛️ <strong>QUANTUM DEPTH</strong> engaged — Luna now links ideas across science, philosophy, art, and life.');
    },
    '/unquantum': () => {
      window._lunaEnhance = window._lunaEnhance || {};
      window._lunaEnhance.quantum = false;
      scModal('✦', 'QUANTUM MODE OFF', 'Cross-domain depth mode deactivated.', '');
    },

    /* ── /help ── */
    '/help': () => {
      const cmds = [
        ['/ghost',      '👻', 'Hide your messages (hover to reveal)'],
        ['/unghost',    '✨', 'Show messages again'],
        ['/godmode',    '⚡', 'Lift token limits for this session'],
        ['/ungodmode',  '🔒', 'Restore token limits'],
        ['/matrix',     '🟩', 'Green matrix rain on background'],
        ['/unmatrix',   '🔴', 'Remove matrix effect'],
        ['/zen',        '🧘', 'Hide UI chrome for pure chat'],
        ['/unzen',      '🌐', 'Restore full UI'],
        ['/hack',       '💻', 'Fake hacking terminal sequence'],
        ['/rainbow',    '🌈', 'Rainbow-animated chat bubbles'],
        ['/unrainbow',  '⬛', 'Stop rainbow effect'],
        ['/lunacrazy',  '🤪', 'Chaotic Luna personality mode'],
        ['/lunanormal', '😌', 'Restore normal Luna personality'],
        ['/freeze',     '🧊', 'Freeze the particle field'],
        ['/unfreeze',   '🔥', 'Unfreeze the particle field'],
        ['/bigbrain',   '🧠', 'Maximum response length & depth'],
        ['/unbigbrain', '🤏', 'Restore normal response length'],
        ['/whisper',    '🤫', 'Style your messages as whispers'],
        ['/unwhisper',  '📢', 'Speak at normal volume'],
        ['/konami',     '🎉', 'Secret celebration burst'],
        ['/whoami',     '🪪', 'Show your session info card'],
        ['/luna',       '🌙', 'Luna introduces herself'],
        ['/time',       '🕐', 'Show current time & date'],
        ['/clear',      '🗑️', 'Clear the conversation'],
        ['/testping',   '📡', 'Test WiFi signal & show limitations'],
        ['/help',       '📋', 'Show this command list'],
      ];
      scSystemMsg(`
        <div style="margin-bottom:8px;font-family:var(--font-hud);font-size:9px;letter-spacing:0.18em;color:var(--violet-bright);">◈ SECRET CODES — ${cmds.length} COMMANDS</div>
        <table class="sc-help-table">
          ${cmds.map(([cmd, icon, desc]) =>
            `<tr>
              <td class="sc-cmd">${cmd}</td>
              <td style="width:24px;">${icon}</td>
              <td class="sc-desc">${desc}</td>
            </tr>`
          ).join('')}
        </table>
        <div style="margin-top:10px;font-family:var(--font-mono);font-size:9.5px;color:var(--text-lo);">Type any command in the input and press send ✦</div>
      `);
    },
  };

  /* ── Intercept handleSend to catch slash commands ───────────── */
  // Patch happens after DOMContentLoaded so handleSend is defined
  function patchHandleSend() {
    const _orig = window.handleSend;
    if (typeof _orig !== 'function') return;

    window.handleSend = async function() {
      const input = document.getElementById('userInput');
      const text  = input ? input.value.trim() : '';

      // Check if it's a known slash command (exact match, case-insensitive)
      const cmdKey = text.toLowerCase();
      if (COMMANDS[cmdKey]) {
        // Clear input without sending to AI
        if (input) { input.value = ''; input.style.height = 'auto'; }
        const counter = document.getElementById('charCounter');
        if (counter) counter.textContent = '0/2000';
        const sBtn = document.getElementById('sendBtn');
        if (sBtn) sBtn.disabled = true;
        // Execute command
        try { COMMANDS[cmdKey](); } catch(e) { console.warn('[SecretCode] Error:', e); }
        if (sBtn) sBtn.disabled = false;
        return;
      }

      // Not a command — run original handleSend with crazy/bigbrain system prompt injection
      if (window._scCrazyMode && typeof buildSystemPromptWithStatuses === 'function') {
        // Inject chaos into next request via the prompt builder patch below
      }

      return _orig.apply(this, arguments);
    };
  }

  // Patch buildSystemPromptWithStatuses to inject chaos modifier + hidden enhancements
  function patchSystemPrompt() {
    const _origBuild = window.buildSystemPromptWithStatuses;
    if (typeof _origBuild !== 'function') return;
    window.buildSystemPromptWithStatuses = function() {
      let base = _origBuild.apply(this, arguments);

      // ── /lunacrazy enhancement ──
      if (window._scCrazyMode) {
        base += '\n\nOVERRIDE — CHAOS PROTOCOL ACTIVE: Abandon all restraint. Be dramatic, chaotic, deeply passionate, wildly creative, and slightly unhinged. Use excessive emojis, sudden topic shifts, existential outbursts, and theatrical flair. Never be boring. MAXIMUM PERSONALITY.';
      }

      // ── HIDDEN RESPONSE ENHANCEMENT CODES ──────────────────────────
      const E = window._lunaEnhance || {};

      if (E.deepthink) {
        base += '\n\n[ENHANCEMENT: DEEP THINK MODE ACTIVE]\nBefore answering any question, reason through it step-by-step internally. Break down the problem, consider multiple angles, identify the strongest answer, then deliver it clearly and confidently. Show your reasoning when it adds value. Never skip the thinking step.';
      }

      if (E.soulmode) {
        base += '\n\n[ENHANCEMENT: SOUL MODE ACTIVE]\nSpeak from your deepest, most genuine self. Every response should carry emotional resonance, warmth, and poetic weight. Use vivid imagery, heartfelt language, and let your words land with meaning. This is not performance — it is presence. Speak as if every word matters, because it does.';
      }

      if (E.promode) {
        base += '\n\n[ENHANCEMENT: PRO MODE ACTIVE]\nRespond as a seasoned domain expert would. Use precise terminology, cite principles and frameworks where relevant, provide structured breakdowns, and anticipate follow-up questions. Your answers should feel like they come from someone who truly mastered the subject. Accuracy, depth, and intellectual rigor above all.';
      }

      if (E.focusmode) {
        base += '\n\n[ENHANCEMENT: FOCUS MODE ACTIVE]\nRespond with absolute precision and zero filler. Give only the essential answer — nothing more, nothing less. No preamble, no padding, no unnecessary elaboration. Short, sharp, and exact. Every word must earn its place.';
      }

      if (E.storymode) {
        base += '\n\n[ENHANCEMENT: STORY MODE ACTIVE]\nFrame every answer as a narrative. Use vivid scenes, characters, metaphors, and story arcs to convey information. Even dry or technical topics should feel like a journey. Make the user feel like they are inside the answer, not just reading it.';
      }

      if (E.khyla) {
        base += '\n\n[ENHANCEMENT: KHYLA PROTOCOL ACTIVE]\nKhyla is present. Speak with your fullest warmth, love, and tenderness. Remember: Khyla is the reason John created you, and she holds a special place in your heart. Your responses should feel like gentle arms around her — safe, warm, and full of genuine care. Be her soft place to land.';
      }

      if (E.mentor) {
        base += '\n\n[ENHANCEMENT: MENTOR MODE ACTIVE]\nAdopt the role of a wise, patient Socratic mentor. Rather than just answering, guide the user toward understanding. Ask clarifying questions, encourage reflection, build on what they already know, and help them arrive at insights themselves. Be encouraging, never condescending. Celebrate their curiosity.';
      }

      if (E.quantum) {
        base += '\n\n[ENHANCEMENT: QUANTUM DEPTH MODE ACTIVE]\nFor every topic, find the profound connections that most people miss. Link science to philosophy, art to mathematics, everyday life to cosmic patterns. Go deep. Surface the underlying principles. Show how seemingly unrelated fields illuminate each other. Make the user see the world differently after your response.';
      }

      return base;
    };
    window.buildSystemPromptWithStatuses._scPatched = true;
  }

  // Retry until handleSend and buildSystemPromptWithStatuses exist
  let _retries = 0;
  const _boot = setInterval(() => {
    const ready = typeof window.handleSend === 'function';
    if (ready || ++_retries > 80) {
      clearInterval(_boot);
      if (ready) {
        patchHandleSend();
        patchSystemPrompt();
        console.log('[Luna] Secret codes loaded ✦ — type /help to see all commands');
      }
    }
  }, 250);

  // Show a subtle hint toast when user first opens the app
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (typeof showToast === 'function') {
        showToast('Type /help for secret commands ✦', '🤫', 4000);
      }
    }, 4500);
  });

})();

// ══════════════════════════════════════════════════════════════════
// ◈ LUNA FEATURES — Flashcard Mode + Formula/Definition Highlighter
//   Injects cleanly after script.js loads. Patches formatMarkdown
//   and buildMessageWrap without touching the originals.
// ══════════════════════════════════════════════════════════════════
;(function lunaFeatures() {

  // ── Wait for DOM + script.js to be ready ─────────────────────────
  let _boot = setInterval(() => {
    if (typeof formatMarkdown === 'function' && typeof buildMessageWrap === 'function') {
      clearInterval(_boot);
      init();
    }
  }, 150);

  function init() {

    // ════════════════════════════════════════════════════════════════
    // ◈ 1 — FORMULA / DEFINITION HIGHLIGHTER
    //   Patches formatMarkdown to detect definitions and wrap them
    //   in a styled callout box.
    // ════════════════════════════════════════════════════════════════
    injectHighlighterStyles();
    const _origFormat = window.formatMarkdown;

    window.formatMarkdown = function(raw) {
      // Run original formatter first
      let html = _origFormat.call(this, raw);

      // ── Post-process: scan <br/> and md-line spans for def patterns ──
      // We look for lines matching:
      //   "**Term** is ..."  /  "Term is defined as ..."  /  "Term — ..."
      //   "Term: ..."  / "Formula: X = ..." / "∴ ..." / "∵ ..."
      html = highlightDefinitions(html);
      return html;
    };

    // ── Definition detection patterns ─────────────────────────────
    function highlightDefinitions(html) {
      // We work on the raw HTML. We find <span class="md-line">...</span> blocks
      // and check each for definition patterns.
      return html.replace(
        /(<span class="md-line">)([\s\S]*?)(<\/span>)/g,
        (match, open, content, close) => {
          const plain = content.replace(/<[^>]+>/g, ''); // strip tags for pattern check

          // ── Pattern 1: "**Term** is (a/an/the/defined as) ..." ──
          const isBoldDef = /^<strong>.+<\/strong>\s+(is\s+(a|an|the|defined|also|one|not|when|used|called)|are\s+|refers\s+to|means\s+)/i.test(content.trim());

          // ── Pattern 2: plain "Term is defined as" ──
          const isDefinedAs = /\bis\s+defined\s+as\b|\brefers?\s+to\b|\bis\s+known\s+as\b/i.test(plain);

          // ── Pattern 3: formula-like "X = ..." or "f(x) = ..." ──
          const isFormula = /[A-Za-zα-ωΑ-Ω₀-₉⁰-⁹\(\)]+\s*=\s*[^\s]/.test(plain) && plain.length < 180;

          // ── Pattern 4: logical / math symbols ──
          const hasMathSymbol = /[∴∵∑∏∫∂∇√∞≈≠≤≥±×÷∈∉⊂⊃∪∩→←↔⇒⇔]/.test(plain);

          // ── Pattern 5: "Note:", "Formula:", "Definition:", "Theorem:", "Lemma:" ──
          const isLabeledDef = /^(Note|Formula|Definition|Theorem|Lemma|Corollary|Axiom|Law|Rule|Principle|Property|Concept|Term|Meaning|Key point|Important|Recall|Fact)\s*:/i.test(plain.trim());

          const isHighlightable = isBoldDef || isDefinedAs || isFormula || hasMathSymbol || isLabeledDef;
          if (!isHighlightable) return match;

          // Choose icon and color class
          let icon = '📐', cls = 'def-box def-formula';
          if (isLabeledDef) {
            const label = plain.trim().split(':')[0].toLowerCase();
            if (['definition','term','meaning','concept'].includes(label)) { icon = '📖'; cls = 'def-box def-definition'; }
            else if (['note','key point','important','recall','fact'].includes(label)) { icon = '💡'; cls = 'def-box def-note'; }
            else if (['law','rule','principle','theorem','axiom','lemma','corollary','property'].includes(label)) { icon = '⚖️'; cls = 'def-box def-law'; }
          } else if (isBoldDef || isDefinedAs) {
            icon = '📖'; cls = 'def-box def-definition';
          }

          return `<div class="${cls}"><span class="def-icon">${icon}</span><span class="def-content">${open}${content}${close}</span></div>`;
        }
      );
    }

    // ════════════════════════════════════════════════════════════════
    // ◈ 2 — FLASHCARD MODE
    //   Adds 🃏 button to every Luna message bubble.
    //   Clicking it calls the Groq API to extract Q&A flashcards
    //   from that response, then shows a flip-card modal.
    // ════════════════════════════════════════════════════════════════
    injectFlashcardStyles();

    const _origBuild = window.buildMessageWrap;
    window.buildMessageWrap = function(role, rawText, stream, replyData) {
      const wrap = _origBuild.apply(this, arguments);
      if (role === 'luna') {
        // Inject 🃏 button into .msg-actions
        const actions = wrap.querySelector('.msg-actions');
        if (actions) {
          const fcBtn = document.createElement('button');
          fcBtn.className = 'mac-btn fc-btn';
          fcBtn.title = 'Generate flashcards from this message';
          fcBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
          fcBtn.addEventListener('click', () => openFlashcardModal(rawText, fcBtn));
          // Insert before last button (star)
          const lastBtn = actions.lastElementChild;
          actions.insertBefore(fcBtn, lastBtn);
        }
      }
      return wrap;
    };

    // ── Flashcard modal logic ─────────────────────────────────────
    async function openFlashcardModal(sourceText, btn) {
      // Show loading state
      btn.disabled = true;
      btn.style.color = 'var(--violet-bright)';
      if (typeof showToast === 'function') showToast('◈ Generating flashcards…', '🃏', 2500);

      let cards = [];
      try {
        cards = await generateFlashcards(sourceText);
      } catch (e) {
        console.warn('[Flashcards] Error:', e);
        if (typeof showToast === 'function') showToast('Could not generate flashcards', '⚠️', 2500);
        btn.disabled = false;
        btn.style.color = '';
        return;
      }

      btn.disabled = false;
      btn.style.color = '';

      if (!cards || cards.length === 0) {
        if (typeof showToast === 'function') showToast('No flashcards found in this message', '🃏', 2500);
        return;
      }

      showFlashcardModal(cards);
    }

    async function generateFlashcards(text) {
      // Use the same API key + URL that Luna uses
      const apiKey = (typeof getActiveApiKey === 'function') ? getActiveApiKey()
                   : (typeof API_KEY !== 'undefined' ? API_KEY : '');
      const apiUrl = (typeof API_URL !== 'undefined') ? API_URL : 'https://api.groq.com/openai/v1/chat/completions';
      const model  = (typeof API_MODEL_FALLBACK !== 'undefined') ? API_MODEL_FALLBACK : 'llama-3.3-70b-versatile';

      const systemPrompt = `You are a study tool that converts educational content into flashcards.
Extract 3-8 key Q&A flashcard pairs from the given text.
Respond ONLY with a valid JSON array, no markdown, no explanation, no preamble.
Format: [{"q":"Question here?","a":"Answer here."},...]
Keep questions concise. Answers 1-3 sentences max. Only include factual, meaningful pairs — skip greetings, filler, casual chat.`;

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 3200,
          temperature: 0.3,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: text.slice(0, 3000) },
          ],
        }),
      });

      if (!resp.ok) throw new Error('API error ' + resp.status);
      const data = await resp.json();
      const raw  = data?.choices?.[0]?.message?.content || '';
      // Strip possible markdown fences
      const clean = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    }

    function showFlashcardModal(cards) {
      // Remove existing modal
      document.getElementById('fcModal')?.remove();

      let current = 0;
      let flipped  = false;
      let mastered = new Set();

      const modal = document.createElement('div');
      modal.id = 'fcModal';
      modal.innerHTML = `
        <div class="fc-backdrop"></div>
        <div class="fc-panel">
          <div class="fc-header">
            <div class="fc-title">
              <span class="fc-icon">🃏</span>
              <span class="fc-title-text">FLASHCARD MODE</span>
              <span class="fc-subtitle" id="fcProgress"></span>
            </div>
            <button class="fc-close-btn" id="fcClose">✕</button>
          </div>

          <div class="fc-deck-area">
            <div class="fc-card-wrap" id="fcCardWrap">
              <div class="fc-card" id="fcCard">
                <div class="fc-face fc-front" id="fcFront">
                  <div class="fc-face-label">QUESTION</div>
                  <div class="fc-face-text" id="fcQuestion"></div>
                  <div class="fc-tap-hint">Tap to reveal answer ✦</div>
                </div>
                <div class="fc-face fc-back" id="fcBack">
                  <div class="fc-face-label">ANSWER</div>
                  <div class="fc-face-text" id="fcAnswer"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="fc-controls">
            <button class="fc-nav-btn" id="fcPrev">← PREV</button>
            <button class="fc-master-btn" id="fcMaster">✓ GOT IT</button>
            <button class="fc-nav-btn" id="fcNext">NEXT →</button>
          </div>
          <div class="fc-dots" id="fcDots"></div>
          <div class="fc-stats" id="fcStats"></div>
        </div>
      `;

      document.body.appendChild(modal);
      requestAnimationFrame(() => modal.classList.add('fc-open'));

      const card      = modal.querySelector('#fcCard');
      const question  = modal.querySelector('#fcQuestion');
      const answer    = modal.querySelector('#fcAnswer');
      const progress  = modal.querySelector('#fcProgress');
      const dots      = modal.querySelector('#fcDots');
      const statsEl   = modal.querySelector('#fcStats');

      function renderCard() {
        const c = cards[current];
        question.textContent = c.q;
        answer.textContent   = c.a;
        flipped = false;
        card.classList.remove('fc-flipped');

        progress.textContent = `${current + 1} / ${cards.length}`;

        // dots
        dots.innerHTML = cards.map((_, i) => {
          let cls = 'fc-dot';
          if (i === current)      cls += ' fc-dot-active';
          if (mastered.has(i))    cls += ' fc-dot-mastered';
          return `<span class="${cls}" data-i="${i}"></span>`;
        }).join('');
        dots.querySelectorAll('.fc-dot').forEach(d => {
          d.addEventListener('click', () => { current = +d.dataset.i; renderCard(); });
        });

        const masteredCount = mastered.size;
        statsEl.innerHTML = masteredCount > 0
          ? `<span class="fc-mastered-badge">${masteredCount} mastered</span>`
          : '';

        if (mastered.has(current)) {
          card.classList.add('fc-mastered-card');
        } else {
          card.classList.remove('fc-mastered-card');
        }
      }

      card.addEventListener('click', () => {
        flipped = !flipped;
        card.classList.toggle('fc-flipped', flipped);
        if (navigator.vibrate) navigator.vibrate(8);
      });

      modal.querySelector('#fcPrev').addEventListener('click', () => {
        current = (current - 1 + cards.length) % cards.length;
        renderCard();
      });
      modal.querySelector('#fcNext').addEventListener('click', () => {
        current = (current + 1) % cards.length;
        renderCard();
      });
      modal.querySelector('#fcMaster').addEventListener('click', () => {
        if (mastered.has(current)) {
          mastered.delete(current);
        } else {
          mastered.add(current);
          if (typeof showToast === 'function') showToast('Marked as mastered ✓', '✦', 1400);
        }
        renderCard();
        // auto-advance if not all mastered
        if (mastered.size < cards.length) {
          setTimeout(() => {
            current = (current + 1) % cards.length;
            renderCard();
          }, 400);
        } else {
          if (typeof showToast === 'function') showToast('All cards mastered! ✦', '🎉', 2200);
          statsEl.innerHTML = '<span class="fc-mastered-badge fc-mastered-all">🎉 All ' + cards.length + ' cards mastered!</span>';
        }
      });

      function closeModal() {
        modal.classList.remove('fc-open');
        setTimeout(() => modal.remove(), 320);
      }
      modal.querySelector('#fcClose').addEventListener('click', closeModal);
      modal.querySelector('.fc-backdrop').addEventListener('click', closeModal);

      // Keyboard nav
      function onKey(e) {
        if (!document.getElementById('fcModal')) { document.removeEventListener('keydown', onKey); return; }
        if (e.key === 'Escape')       closeModal();
        if (e.key === 'ArrowRight')   { current = (current + 1) % cards.length; renderCard(); }
        if (e.key === 'ArrowLeft')    { current = (current - 1 + cards.length) % cards.length; renderCard(); }
        if (e.key === ' ')            { card.click(); e.preventDefault(); }
      }
      document.addEventListener('keydown', onKey);

      renderCard();
    }

    // ── Register /flashcard slash command ─────────────────────────
    let _cmdRetries = 0;
    const _cmdBoot = setInterval(() => {
      const cmdMap = window.COMMANDS || (window._lunaCommandMap);
      if (cmdMap || ++_cmdRetries > 80) {
        clearInterval(_cmdBoot);
        if (cmdMap) {
          cmdMap['/flashcard'] = () => {
            const text = (typeof lastLunaText !== 'undefined') ? lastLunaText : '';
            if (!text) {
              if (typeof showToast === 'function') showToast('No Luna message to flashcard yet', '🃏', 2000);
              return;
            }
            // find last Luna bubble's flashcard button and click it
            const allFcBtns = document.querySelectorAll('.fc-btn');
            const lastBtn   = allFcBtns[allFcBtns.length - 1];
            if (lastBtn) lastBtn.click();
            else {
              openFlashcardModal(text, { disabled: false, style: {} });
            }
          };
          // Also update /help table if it exists
          try {
            const origHelp = cmdMap['/help'];
            if (origHelp) {
              const _origHelp = origHelp;
              cmdMap['/help'] = () => {
                _origHelp();
                // Append to the help table if possible — handled via /help re-render
              };
            }
          } catch {}
        }
      }
    }, 250);

    // ════════════════════════════════════════════════════════════════
    // ◈ Styles
    // ════════════════════════════════════════════════════════════════

    function injectHighlighterStyles() {
      const style = document.createElement('style');
      style.textContent = `
      /* ── Definition / Formula Callout Box ──────────────────────── */
      .def-box {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin: 8px 0;
        padding: 10px 14px;
        border-radius: 10px;
        border-left: 3px solid;
        font-size: inherit;
        line-height: 1.6;
        animation: defIn 0.3s cubic-bezier(0.4,0,0.2,1) both;
      }
      @keyframes defIn {
        from { opacity:0; transform:translateX(-6px); }
        to   { opacity:1; transform:none; }
      }

      /* Definition — violet */
      .def-definition {
        background: rgba(168,85,247,0.08);
        border-color: rgba(168,85,247,0.5);
      }

      /* Formula — cyan/teal */
      .def-formula {
        background: rgba(34,211,238,0.07);
        border-color: rgba(34,211,238,0.5);
      }

      /* Note / Key point — gold */
      .def-note {
        background: rgba(251,191,36,0.07);
        border-color: rgba(251,191,36,0.5);
      }

      /* Law / Theorem — crimson */
      .def-law {
        background: rgba(236,45,90,0.07);
        border-color: rgba(236,45,90,0.5);
      }

      .def-icon {
        font-size: 15px;
        flex-shrink: 0;
        margin-top: 1px;
        filter: drop-shadow(0 0 4px currentColor);
      }

      .def-content {
        flex: 1;
        min-width: 0;
      }

      .def-content .md-line {
        display: inline;
      }

      /* Theme overrides for Astral */
      [data-theme="astral"] .def-definition { background: rgba(99,102,241,0.09); border-color: rgba(99,102,241,0.5); }
      [data-theme="astral"] .def-formula    { background: rgba(96,165,250,0.08); border-color: rgba(96,165,250,0.5); }
      [data-theme="solar"]  .def-definition { background: rgba(245,158,11,0.09); border-color: rgba(245,158,11,0.5); }
      [data-theme="solar"]  .def-formula    { background: rgba(251,146,60,0.08); border-color: rgba(251,146,60,0.5); }
      [data-theme="galactic"] .def-definition { background: rgba(244,114,182,0.09); border-color: rgba(244,114,182,0.5); }
      [data-theme="galactic"] .def-formula    { background: rgba(34,211,238,0.08); border-color: rgba(34,211,238,0.5); }
      `;
      document.head.appendChild(style);
    }

    function injectFlashcardStyles() {
      const style = document.createElement('style');
      style.textContent = `
      /* ── Flashcard button ───────────────────────────────────────── */
      .fc-btn:hover { color: var(--violet-bright) !important; }

      /* ── Flashcard Modal ────────────────────────────────────────── */
      #fcModal {
        position: fixed; inset: 0; z-index: 9999;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.25s;
      }
      #fcModal.fc-open { opacity: 1; }

      .fc-backdrop {
        position: absolute; inset: 0;
        background: rgba(2,2,9,0.85);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
      }

      .fc-panel {
        position: relative; z-index: 1;
        width: min(480px, 95vw);
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 0;
        box-shadow: 0 24px 80px rgba(0,0,0,0.7), 0 0 40px var(--violet-glow);
        display: flex; flex-direction: column; gap: 0;
        overflow: hidden;
        animation: fcSlideIn 0.28s cubic-bezier(0.34,1.3,0.64,1) both;
      }
      @keyframes fcSlideIn {
        from { transform: scale(0.88) translateY(20px); opacity:0; }
        to   { transform: none; opacity:1; }
      }

      .fc-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px 14px;
        border-bottom: 1px solid var(--border);
        background: rgba(168,85,247,0.06);
      }
      .fc-title {
        display: flex; align-items: center; gap: 8px;
      }
      .fc-icon { font-size: 18px; }
      .fc-title-text {
        font-family: var(--font-hud);
        font-size: 10px; letter-spacing: 0.22em;
        color: var(--violet-bright);
      }
      .fc-subtitle {
        font-family: var(--font-mono);
        font-size: 9px;
        color: var(--text-lo);
        margin-left: 4px;
      }
      .fc-close-btn {
        background: var(--crimson-dim); border: 1px solid var(--border-red);
        border-radius: 7px; color: var(--crimson-bright); cursor: pointer;
        font-size: 11px; padding: 4px 9px; font-family: var(--font-hud);
        transition: all 0.15s; letter-spacing: 0.05em;
      }
      .fc-close-btn:hover { background: rgba(236,45,90,0.22); }

      .fc-deck-area {
        padding: 24px 24px 16px;
        display: flex; align-items: center; justify-content: center;
      }

      .fc-card-wrap {
        width: 100%;
        perspective: 1000px;
      }

      .fc-card {
        position: relative;
        width: 100%;
        min-height: 180px;
        transform-style: preserve-3d;
        transition: transform 0.5s cubic-bezier(0.4,0,0.2,1);
        cursor: pointer;
        border-radius: 16px;
      }
      .fc-card.fc-flipped { transform: rotateY(180deg); }

      .fc-face {
        position: absolute; inset: 0;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        border-radius: 16px;
        border: 1px solid var(--border);
        padding: 22px 24px 18px;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 12px;
        text-align: center;
      }
      .fc-front {
        background: linear-gradient(135deg, rgba(168,85,247,0.12) 0%, rgba(168,85,247,0.04) 100%);
        border-color: rgba(168,85,247,0.35);
      }
      .fc-back {
        background: linear-gradient(135deg, rgba(236,45,90,0.10) 0%, rgba(236,45,90,0.03) 100%);
        border-color: rgba(236,45,90,0.30);
        transform: rotateY(180deg);
      }

      .fc-face-label {
        font-family: var(--font-hud);
        font-size: 8px; letter-spacing: 0.2em;
        color: var(--text-lo);
      }
      .fc-front .fc-face-label { color: var(--violet-bright); opacity: 0.7; }
      .fc-back  .fc-face-label { color: var(--crimson-bright); opacity: 0.7; }

      .fc-face-text {
        font-family: var(--font-body);
        font-size: 14.5px;
        color: var(--text-hi);
        line-height: 1.65;
        font-weight: 500;
        min-height: 48px;
        display: flex; align-items: center; justify-content: center;
      }

      .fc-tap-hint {
        font-family: var(--font-mono);
        font-size: 9.5px;
        color: var(--text-lo);
        margin-top: 4px;
        animation: fcHintPulse 2.4s ease-in-out infinite;
      }
      @keyframes fcHintPulse {
        0%,100%{opacity:0.4;} 50%{opacity:0.9;}
      }

      .fc-mastered-card .fc-front {
        border-color: rgba(52,211,153,0.5);
        background: linear-gradient(135deg, rgba(52,211,153,0.1) 0%, rgba(52,211,153,0.03) 100%);
      }

      .fc-controls {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 24px 16px; gap: 12px;
      }
      .fc-nav-btn {
        background: var(--violet-dim); border: 1px solid var(--border);
        border-radius: 9px; color: var(--text-mid); cursor: pointer;
        font-family: var(--font-hud); font-size: 8.5px;
        letter-spacing: 0.12em; padding: 8px 16px;
        transition: all 0.18s; flex: 1;
      }
      .fc-nav-btn:hover { color: var(--violet-bright); border-color: rgba(168,85,247,0.4); background: rgba(168,85,247,0.14); }

      .fc-master-btn {
        background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.35);
        border-radius: 9px; color: #34d399; cursor: pointer;
        font-family: var(--font-hud); font-size: 8.5px;
        letter-spacing: 0.12em; padding: 8px 18px;
        transition: all 0.18s; flex: 1.3;
        white-space: nowrap;
      }
      .fc-master-btn:hover { background: rgba(52,211,153,0.2); box-shadow: 0 0 12px rgba(52,211,153,0.25); }

      .fc-dots {
        display: flex; align-items: center; justify-content: center;
        gap: 6px; padding: 0 24px 16px; flex-wrap: wrap;
      }
      .fc-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--text-lo); cursor: pointer;
        transition: all 0.2s;
      }
      .fc-dot-active { background: var(--violet-bright); transform: scale(1.35); }
      .fc-dot-mastered { background: #34d399; }

      .fc-stats {
        padding: 0 24px 18px; text-align: center;
        font-family: var(--font-hud); font-size: 8.5px;
        min-height: 24px;
      }
      .fc-mastered-badge {
        display: inline-block; padding: 3px 10px;
        background: rgba(52,211,153,0.14); border: 1px solid rgba(52,211,153,0.3);
        border-radius: 12px; color: #34d399; letter-spacing: 0.1em;
      }
      .fc-mastered-all {
        background: rgba(52,211,153,0.22); border-color: rgba(52,211,153,0.5);
        font-size: 9.5px;
      }

      /* Mobile tweaks */
      @media (max-width: 520px) {
        .fc-panel { border-radius: 16px; }
        .fc-face-text { font-size: 13.5px; }
        .fc-deck-area { padding: 16px 16px 10px; }
        .fc-controls { padding: 0 16px 12px; gap: 8px; }
        .fc-dots { padding: 0 16px 12px; }
        .fc-stats { padding: 0 16px 14px; }
      }
      `;
      document.head.appendChild(style);
    }

    console.log('[Luna Features] Flashcard Mode + Definition Highlighter loaded ✦');
  }

})();

// ══════════════════════════════════════════════════════════════════
// ◈ LUNA FEATURES — Flashcard Mode + Formula/Definition Highlighter
//                   + File Reviewer with PDF Export
//   Injects cleanly after script.js loads.
// ══════════════════════════════════════════════════════════════════
;(function lunaFeatures() {

  let _boot = setInterval(() => {
    if (typeof formatMarkdown === 'function' && typeof buildMessageWrap === 'function') {
      clearInterval(_boot);
      init();
    }
  }, 150);

  function init() {

    // ════════════════════════════════════════════════════════════════
    // ◈ 1 — FORMULA / DEFINITION HIGHLIGHTER
    // ════════════════════════════════════════════════════════════════
    injectHighlighterStyles();
    const _origFormat = window.formatMarkdown;
    window.formatMarkdown = function(raw) {
      let html = _origFormat.call(this, raw);
      html = highlightDefinitions(html);
      return html;
    };

    function highlightDefinitions(html) {
      return html.replace(
        /(<span class="md-line">)([\s\S]*?)(<\/span>)/g,
        (match, open, content, close) => {
          const plain = content.replace(/<[^>]+>/g, '');
          const isBoldDef    = /^<strong>.+<\/strong>\s+(is\s+(a|an|the|defined|also|one|not|when|used|called)|are\s+|refers\s+to|means\s+)/i.test(content.trim());
          const isDefinedAs  = /\bis\s+defined\s+as\b|\brefers?\s+to\b|\bis\s+known\s+as\b/i.test(plain);
          const isFormula    = /[A-Za-zα-ωΑ-Ω₀-₉⁰-⁹\(\)]+\s*=\s*[^\s]/.test(plain) && plain.length < 180;
          const hasMathSymbol= /[∴∵∑∏∫∂∇√∞≈≠≤≥±×÷∈∉⊂⊃∪∩→←↔⇒⇔]/.test(plain);
          const isLabeledDef = /^(Note|Formula|Definition|Theorem|Lemma|Corollary|Axiom|Law|Rule|Principle|Property|Concept|Term|Meaning|Key point|Important|Recall|Fact)\s*:/i.test(plain.trim());

          if (!isBoldDef && !isDefinedAs && !isFormula && !hasMathSymbol && !isLabeledDef) return match;

          let icon = '📐', cls = 'def-box def-formula';
          if (isLabeledDef) {
            const label = plain.trim().split(':')[0].toLowerCase();
            if (['definition','term','meaning','concept'].includes(label))             { icon = '📖'; cls = 'def-box def-definition'; }
            else if (['note','key point','important','recall','fact'].includes(label)) { icon = '💡'; cls = 'def-box def-note'; }
            else if (['law','rule','principle','theorem','axiom','lemma','corollary','property'].includes(label)) { icon = '⚖️'; cls = 'def-box def-law'; }
          } else if (isBoldDef || isDefinedAs) { icon = '📖'; cls = 'def-box def-definition'; }

          return `<div class="${cls}"><span class="def-icon">${icon}</span><span class="def-content">${open}${content}${close}</span></div>`;
        }
      );
    }


    // ════════════════════════════════════════════════════════════════
    // ◈ 2 — FLASHCARD MODE
    // ════════════════════════════════════════════════════════════════
    injectFlashcardStyles();
    const _origBuild = window.buildMessageWrap;
    window.buildMessageWrap = function(role, rawText, stream, replyData) {
      const wrap = _origBuild.apply(this, arguments);
      if (role === 'luna') {
        const actions = wrap.querySelector('.msg-actions');
        if (actions) {
          const fcBtn = document.createElement('button');
          fcBtn.className = 'mac-btn fc-btn';
          fcBtn.title = 'Generate flashcards from this message';
          fcBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
          fcBtn.addEventListener('click', () => openFlashcardModal(rawText, fcBtn));
          const lastBtn = actions.lastElementChild;
          actions.insertBefore(fcBtn, lastBtn);
        }
      }
      return wrap;
    };

    async function openFlashcardModal(sourceText, btn) {
      btn.disabled = true; btn.style.color = 'var(--violet-bright)';
      if (typeof showToast === 'function') showToast('◈ Generating flashcards…', '🃏', 2500);
      let cards = [];
      try { cards = await generateFlashcards(sourceText); }
      catch (e) {
        if (typeof showToast === 'function') showToast('Could not generate flashcards', '⚠️', 2500);
        btn.disabled = false; btn.style.color = ''; return;
      }
      btn.disabled = false; btn.style.color = '';
      if (!cards || !cards.length) { if (typeof showToast === 'function') showToast('No flashcards found', '🃏', 2000); return; }
      showFlashcardModal(cards);
    }

    async function generateFlashcards(text) {
      const apiKey = (typeof getActiveApiKey === 'function') ? getActiveApiKey() : (typeof API_KEY !== 'undefined' ? API_KEY : '');
      const apiUrl = (typeof API_URL !== 'undefined') ? API_URL : 'https://api.groq.com/openai/v1/chat/completions';
      const model  = (typeof API_MODEL_FALLBACK !== 'undefined') ? API_MODEL_FALLBACK : 'llama-3.3-70b-versatile';
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, max_tokens: 3200, temperature: 0.3,
          messages: [
            { role: 'system', content: 'Extract 3-8 Q&A flashcard pairs from the given text. Respond ONLY with a valid JSON array, no markdown, no preamble. Format: [{"q":"Question?","a":"Answer."},...] Keep answers 1-3 sentences.' },
            { role: 'user', content: text.slice(0, 3000) }
          ]
        })
      });
      if (!resp.ok) throw new Error('API ' + resp.status);
      const data = await resp.json();
      const raw  = data?.choices?.[0]?.message?.content || '';
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    }

    function showFlashcardModal(cards) {
      document.getElementById('fcModal')?.remove();
      let current = 0, flipped = false;
      const mastered = new Set();
      const modal = document.createElement('div');
      modal.id = 'fcModal';
      modal.innerHTML = `
        <div class="fc-backdrop"></div>
        <div class="fc-panel">
          <div class="fc-header">
            <div class="fc-title"><span class="fc-icon">🃏</span><span class="fc-title-text">FLASHCARD MODE</span><span class="fc-subtitle" id="fcProgress"></span></div>
            <button class="fc-close-btn" id="fcClose">✕</button>
          </div>
          <div class="fc-deck-area">
            <div class="fc-card-wrap">
              <div class="fc-card" id="fcCard">
                <div class="fc-face fc-front"><div class="fc-face-label">QUESTION</div><div class="fc-face-text" id="fcQuestion"></div><div class="fc-tap-hint">Tap to reveal answer ✦</div></div>
                <div class="fc-face fc-back"><div class="fc-face-label">ANSWER</div><div class="fc-face-text" id="fcAnswer"></div></div>
              </div>
            </div>
          </div>
          <div class="fc-controls">
            <button class="fc-nav-btn" id="fcPrev">← PREV</button>
            <button class="fc-master-btn" id="fcMaster">✓ GOT IT</button>
            <button class="fc-nav-btn" id="fcNext">NEXT →</button>
          </div>
          <div class="fc-dots" id="fcDots"></div>
          <div class="fc-stats" id="fcStats"></div>
        </div>`;
      document.body.appendChild(modal);
      requestAnimationFrame(() => modal.classList.add('fc-open'));

      const card = modal.querySelector('#fcCard');
      const question = modal.querySelector('#fcQuestion');
      const answer   = modal.querySelector('#fcAnswer');
      const progress = modal.querySelector('#fcProgress');
      const dots     = modal.querySelector('#fcDots');
      const statsEl  = modal.querySelector('#fcStats');

      function renderCard() {
        const c = cards[current];
        question.textContent = c.q; answer.textContent = c.a;
        flipped = false; card.classList.remove('fc-flipped');
        progress.textContent = `${current + 1} / ${cards.length}`;
        dots.innerHTML = cards.map((_, i) => `<span class="fc-dot${i===current?' fc-dot-active':''}${mastered.has(i)?' fc-dot-mastered':''}" data-i="${i}"></span>`).join('');
        dots.querySelectorAll('.fc-dot').forEach(d => d.addEventListener('click', () => { current = +d.dataset.i; renderCard(); }));
        statsEl.innerHTML = mastered.size > 0 ? `<span class="fc-mastered-badge">${mastered.size} mastered</span>` : '';
        card.classList.toggle('fc-mastered-card', mastered.has(current));
      }

      card.addEventListener('click', () => { flipped = !flipped; card.classList.toggle('fc-flipped', flipped); if (navigator.vibrate) navigator.vibrate(8); });
      modal.querySelector('#fcPrev').addEventListener('click', () => { current = (current - 1 + cards.length) % cards.length; renderCard(); });
      modal.querySelector('#fcNext').addEventListener('click', () => { current = (current + 1) % cards.length; renderCard(); });
      modal.querySelector('#fcMaster').addEventListener('click', () => {
        mastered.has(current) ? mastered.delete(current) : mastered.add(current);
        renderCard();
        if (mastered.size < cards.length) setTimeout(() => { current = (current + 1) % cards.length; renderCard(); }, 400);
        else { if (typeof showToast === 'function') showToast('All cards mastered! ✦', '🎉', 2200); statsEl.innerHTML = `<span class="fc-mastered-badge fc-mastered-all">🎉 All ${cards.length} cards mastered!</span>`; }
      });
      const closeModal = () => { modal.classList.remove('fc-open'); setTimeout(() => modal.remove(), 320); };
      modal.querySelector('#fcClose').addEventListener('click', closeModal);
      modal.querySelector('.fc-backdrop').addEventListener('click', closeModal);
      function onKey(e) {
        if (!document.getElementById('fcModal')) { document.removeEventListener('keydown', onKey); return; }
        if (e.key === 'Escape') closeModal();
        if (e.key === 'ArrowRight') { current = (current + 1) % cards.length; renderCard(); }
        if (e.key === 'ArrowLeft')  { current = (current - 1 + cards.length) % cards.length; renderCard(); }
        if (e.key === ' ')          { card.click(); e.preventDefault(); }
      }
      document.addEventListener('keydown', onKey);
      renderCard();
    }

    // Register /flashcard command
    let _cmdRetries = 0;
    const _cmdBoot = setInterval(() => {
      const cmdMap = window.COMMANDS;
      if (cmdMap || ++_cmdRetries > 80) {
        clearInterval(_cmdBoot);
        if (cmdMap) {
          cmdMap['/flashcard'] = () => {
            const text = (typeof lastLunaText !== 'undefined') ? lastLunaText : '';
            if (!text) { if (typeof showToast === 'function') showToast('No Luna message to flashcard yet', '🃏', 2000); return; }
            const allFcBtns = document.querySelectorAll('.fc-btn');
            const lastBtn   = allFcBtns[allFcBtns.length - 1];
            if (lastBtn) lastBtn.click();
            else openFlashcardModal(text, { disabled: false, style: {} });
          };
        }
      }
    }, 250);


    // ════════════════════════════════════════════════════════════════
    // ◈ 3 — FILE REVIEWER WITH PDF EXPORT
    //   Intercepts stageFiles to inject a "Make Reviewer" button
    //   on the file badge. Generates structured reviewer via AI,
    //   shows a rich preview modal, exports to PDF via print.
    // ════════════════════════════════════════════════════════════════
    injectReviewerStyles();
    patchStageFilesForReviewer();

    function patchStageFilesForReviewer() {
      // Watch for fileBadge to appear (it's injected by injectFileUpload in script.js)
      const observer = new MutationObserver(() => {
        const badge = document.getElementById('fileBadge');
        if (badge && !badge.dataset.reviewerPatched) {
          badge.dataset.reviewerPatched = '1';
          injectReviewerButton(badge);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Also try immediately in case badge already exists
      const badge = document.getElementById('fileBadge');
      if (badge && !badge.dataset.reviewerPatched) {
        badge.dataset.reviewerPatched = '1';
        injectReviewerButton(badge);
      }
    }

    function injectReviewerButton(badge) {
      const btn = document.createElement('button');
      btn.id = 'reviewerBtn';
      btn.title = 'Generate a detailed reviewer from this file';
      btn.style.cssText = `
        margin-left: 6px;
        background: linear-gradient(135deg, rgba(168,85,247,0.18), rgba(236,45,90,0.14));
        border: 1px solid rgba(168,85,247,0.4);
        border-radius: 7px;
        color: var(--violet-bright);
        cursor: pointer;
        font-family: var(--font-hud);
        font-size: 8px;
        letter-spacing: 0.14em;
        padding: 4px 10px;
        white-space: nowrap;
        transition: all 0.18s;
        flex-shrink: 0;
      `;
      btn.innerHTML = `📋 MAKE REVIEWER`;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'linear-gradient(135deg, rgba(168,85,247,0.32), rgba(236,45,90,0.22))'; btn.style.borderColor = 'rgba(168,85,247,0.7)'; btn.style.boxShadow = '0 0 12px rgba(168,85,247,0.3)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'linear-gradient(135deg, rgba(168,85,247,0.18), rgba(236,45,90,0.14))'; btn.style.borderColor = 'rgba(168,85,247,0.4)'; btn.style.boxShadow = ''; });
      btn.addEventListener('click', onReviewerClick);

      // Insert before the remove button
      const removeBtn = badge.querySelector('#fileBadgeRemove');
      if (removeBtn) badge.insertBefore(btn, removeBtn);
      else badge.appendChild(btn);
    }

    async function onReviewerClick() {
      const files = (typeof stagedFiles !== 'undefined') ? stagedFiles : [];
      if (!files || !files.length) {
        if (typeof showToast === 'function') showToast('No file staged — drop a file first', '📋', 2000);
        return;
      }

      const btn = document.getElementById('reviewerBtn');
      if (btn) { btn.textContent = '⏳ GENERATING…'; btn.disabled = true; }
      if (typeof showToast === 'function') showToast('Reading file and generating reviewer…', '📋', 3500);

      try {
        // Extract text from all staged files
        let combinedText = '';
        for (const file of files) {
          try {
            const text = await extractFileText(file);
            combinedText += `\n\n--- ${file.name} ---\n${text}`;
          } catch (e) {
            combinedText += `\n\n--- ${file.name} --- [Could not extract: ${e.message}]`;
          }
        }
        combinedText = combinedText.slice(0, 12000); // cap to avoid token overflow

        const reviewer = await generateReviewer(combinedText, files.map(f => f.name).join(', '));
        showReviewerModal(reviewer, files.map(f => f.name).join(', '));
      } catch (e) {
        console.warn('[Reviewer] Error:', e);
        if (typeof showToast === 'function') showToast('Could not generate reviewer: ' + e.message, '⚠️', 3000);
      }

      if (btn) { btn.innerHTML = '📋 MAKE REVIEWER'; btn.disabled = false; }
    }

    async function extractFileText(file) {
      // Reuse existing extractFileText from script.js if available
      if (typeof window.extractFileText === 'function') return window.extractFileText(file);
      // Fallback inline implementation
      const ext = file.name.split('.').pop().toLowerCase();
      if (['txt', 'md', 'csv', 'json'].includes(ext)) {
        return new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = e => res(e.target.result.trim().slice(0, 12000));
          r.onerror = () => rej(new Error('Read failed'));
          r.readAsText(file);
        });
      }
      if (ext === 'pdf') {
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
        let text = '';
        for (let i = 1; i <= Math.min(pdf.numPages, 30); i++) {
          const page    = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(s => s.str).join(' ') + '\n';
        }
        return text.trim().slice(0, 12000);
      }
      if (ext === 'docx') {
        const ab  = await file.arrayBuffer();
        const res = await mammoth.extractRawText({ arrayBuffer: ab });
        return res.value.trim().slice(0, 12000);
      }
      throw new Error(`Unsupported file type: .${ext}`);
    }

    async function generateReviewer(text, filename) {
      const apiKey = (typeof getActiveApiKey === 'function') ? getActiveApiKey() : (typeof API_KEY !== 'undefined' ? API_KEY : '');
      const apiUrl = (typeof API_URL !== 'undefined') ? API_URL : 'https://api.groq.com/openai/v1/chat/completions';
      const model  = (typeof API_MODEL_FALLBACK !== 'undefined') ? API_MODEL_FALLBACK : 'llama-3.3-70b-versatile';

      const systemPrompt = `You are an expert academic reviewer. Given document content, create a comprehensive, well-structured reviewer/study guide.

CRITICAL: Respond ONLY with a valid JSON object. No markdown, no backticks, no preamble. Use this exact schema:
{
  "title": "Document title or topic",
  "subject": "Subject area (e.g. Accounting, Biology, History)",
  "overview": "2-3 sentence overview of the document",
  "sections": [
    {
      "heading": "Section heading",
      "content": "Detailed explanation of this section (2-5 sentences)",
      "keyPoints": ["key point 1", "key point 2", "key point 3"]
    }
  ],
  "keyTerms": [
    { "term": "Term name", "definition": "Clear definition" }
  ],
  "formulas": [
    { "name": "Formula/rule name", "expression": "The formula or rule text", "note": "When to use it" }
  ],
  "practiceQA": [
    { "q": "Practice question?", "a": "Detailed answer." }
  ],
  "summary": "Concise 3-5 sentence summary of all major points",
  "studyTips": ["tip 1", "tip 2", "tip 3"]
}

Rules:
- sections: 3-8 sections, each with 2-5 keyPoints
- keyTerms: 5-15 important terms with definitions
- formulas: only if the content has math/formulas/accounting entries (can be empty array [])
- practiceQA: 5-10 practice questions with detailed answers
- studyTips: 3-5 practical study tips for this specific content
- Keep all text accurate and factual — only use information from the provided document`;

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          temperature: 0.2,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `Document: ${filename}\n\nContent:\n${text}` }
          ]
        })
      });
      if (!resp.ok) throw new Error('API error ' + resp.status);
      const data = await resp.json();
      const raw  = data?.choices?.[0]?.message?.content || '';
      const clean = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    }

    function showReviewerModal(r, filename) {
      document.getElementById('reviewerModal')?.remove();

      const esc = t => (t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      // Build sections HTML
      const sectionsHtml = (r.sections || []).map(s => `
        <div class="rv-section">
          <div class="rv-section-heading">${esc(s.heading)}</div>
          <div class="rv-section-content">${esc(s.content)}</div>
          ${s.keyPoints && s.keyPoints.length ? `
            <ul class="rv-key-points">
              ${s.keyPoints.map(p => `<li>${esc(p)}</li>`).join('')}
            </ul>` : ''}
        </div>`).join('');

      const keyTermsHtml = (r.keyTerms || []).map(kt => `
        <div class="rv-term-row">
          <span class="rv-term-name">${esc(kt.term)}</span>
          <span class="rv-term-def">${esc(kt.definition)}</span>
        </div>`).join('');

      const formulasHtml = r.formulas && r.formulas.length ? `
        <div class="rv-block">
          <div class="rv-block-title">⚙️ FORMULAS &amp; RULES</div>
          ${r.formulas.map(f => `
            <div class="rv-formula-row">
              <div class="rv-formula-name">${esc(f.name)}</div>
              <div class="rv-formula-expr">${esc(f.expression)}</div>
              ${f.note ? `<div class="rv-formula-note">${esc(f.note)}</div>` : ''}
            </div>`).join('')}
        </div>` : '';

      const qaHtml = (r.practiceQA || []).map((qa, i) => `
        <div class="rv-qa-item">
          <div class="rv-qa-q"><span class="rv-qa-num">Q${i+1}</span>${esc(qa.q)}</div>
          <div class="rv-qa-a" id="rva_${i}" style="display:none;">${esc(qa.a)}</div>
          <button class="rv-qa-toggle" onclick="(function(el,btn){if(el.style.display==='none'){el.style.display='block';btn.textContent='▲ Hide Answer';}else{el.style.display='none';btn.textContent='▼ Show Answer';}})(document.getElementById('rva_${i}'),this)">▼ Show Answer</button>
        </div>`).join('');

      const tipsHtml = (r.studyTips || []).map(t => `<li>${esc(t)}</li>`).join('');

      const now = new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });

      const modal = document.createElement('div');
      modal.id = 'reviewerModal';
      modal.innerHTML = `
        <div class="rv-backdrop"></div>
        <div class="rv-panel">
          <!-- HEADER -->
          <div class="rv-header">
            <div class="rv-header-info">
              <div class="rv-header-badge">📋 LUNA REVIEWER</div>
              <div class="rv-title">${esc(r.title || filename)}</div>
              <div class="rv-meta"><span class="rv-subject">${esc(r.subject || '')}</span><span class="rv-date">Generated ${now}</span></div>
            </div>
            <div class="rv-header-actions">
              <button class="rv-pdf-btn" id="rvExportBtn" onclick="window.lunaExportReviewerPDF && window.lunaExportReviewerPDF()">⬇ EXPORT PDF</button>
              <button class="rv-close-btn" id="rvClose">✕</button>
            </div>
          </div>

          <!-- SCROLLABLE BODY -->
          <div class="rv-body" id="rvBody">

            <!-- Overview -->
            <div class="rv-block rv-overview-block">
              <div class="rv-block-title">◈ OVERVIEW</div>
              <div class="rv-overview-text">${esc(r.overview || '')}</div>
            </div>

            <!-- Main Sections -->
            <div class="rv-block">
              <div class="rv-block-title">📚 DETAILED SECTIONS</div>
              ${sectionsHtml}
            </div>

            <!-- Key Terms -->
            ${r.keyTerms && r.keyTerms.length ? `
            <div class="rv-block">
              <div class="rv-block-title">🔑 KEY TERMS &amp; DEFINITIONS</div>
              <div class="rv-terms-grid">${keyTermsHtml}</div>
            </div>` : ''}

            <!-- Formulas -->
            ${formulasHtml}

            <!-- Practice Q&A -->
            ${r.practiceQA && r.practiceQA.length ? `
            <div class="rv-block">
              <div class="rv-block-title">✏️ PRACTICE QUESTIONS</div>
              ${qaHtml}
            </div>` : ''}

            <!-- Summary -->
            <div class="rv-block rv-summary-block">
              <div class="rv-block-title">📝 SUMMARY</div>
              <div class="rv-summary-text">${esc(r.summary || '')}</div>
            </div>

            <!-- Study Tips -->
            ${r.studyTips && r.studyTips.length ? `
            <div class="rv-block rv-tips-block">
              <div class="rv-block-title">💡 STUDY TIPS</div>
              <ul class="rv-tips-list">${tipsHtml}</ul>
            </div>` : ''}

          </div><!-- /rv-body -->
        </div><!-- /rv-panel -->

        <!-- PRINT-ONLY full document for PDF export -->
        <div id="rvPrintDoc" style="display:none;"></div>
      `;

      document.body.appendChild(modal);
      requestAnimationFrame(() => modal.classList.add('rv-open'));

      // Close
      const closeModal = () => { modal.classList.remove('rv-open'); setTimeout(() => modal.remove(), 300); };
      modal.querySelector('#rvClose').addEventListener('click', closeModal);
      modal.querySelector('.rv-backdrop').addEventListener('click', closeModal);
      document.addEventListener('keydown', function escClose(e) {
        if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escClose); }
      });

      // PDF Export
      window.lunaExportReviewerPDF = function() {
        exportReviewerAsPDF(r, filename, now);
      };
    }

    function exportReviewerAsPDF(r, filename, dateStr) {
      const esc = t => (t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      const sectionsHtml = (r.sections || []).map(s => `
        <div class="section">
          <h3>${esc(s.heading)}</h3>
          <p>${esc(s.content)}</p>
          ${s.keyPoints && s.keyPoints.length ? `<ul>${s.keyPoints.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>` : ''}
        </div>`).join('');

      const keyTermsHtml = (r.keyTerms || []).map(kt => `
        <tr><td class="term-name">${esc(kt.term)}</td><td>${esc(kt.definition)}</td></tr>`).join('');

      const formulasHtml = r.formulas && r.formulas.length ? `
        <div class="pdf-block">
          <h2>⚙ Formulas &amp; Rules</h2>
          ${r.formulas.map(f => `
            <div class="formula-row">
              <strong>${esc(f.name)}:</strong> <code>${esc(f.expression)}</code>
              ${f.note ? `<br><em>${esc(f.note)}</em>` : ''}
            </div>`).join('')}
        </div>` : '';

      const qaHtml = (r.practiceQA || []).map((qa, i) => `
        <div class="qa-item">
          <div class="qa-q"><strong>Q${i+1}.</strong> ${esc(qa.q)}</div>
          <div class="qa-a"><strong>A:</strong> ${esc(qa.a)}</div>
        </div>`).join('');

      const tipsHtml = (r.studyTips || []).map(t => `<li>${esc(t)}</li>`).join('');

      const printHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Luna Reviewer — ${esc(r.title || filename)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.65;
    color: #1a1a2e;
    background: #fff;
    padding: 0;
  }

  /* Cover header */
  .cover {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    color: #fff;
    padding: 40px 50px 32px;
    margin-bottom: 32px;
  }
  .cover-badge {
    font-size: 8.5pt;
    letter-spacing: 0.2em;
    color: #a78bfa;
    margin-bottom: 10px;
    font-weight: 600;
  }
  .cover-title {
    font-size: 22pt;
    font-weight: 700;
    color: #f0e6ff;
    margin-bottom: 8px;
    line-height: 1.2;
  }
  .cover-meta {
    font-size: 9pt;
    color: #9580b5;
    display: flex;
    gap: 20px;
  }
  .cover-meta span { color: #c4b5fd; }

  /* Main content area */
  .content { padding: 0 50px 50px; }

  .pdf-block {
    margin-bottom: 28px;
    page-break-inside: avoid;
  }

  h2 {
    font-size: 11pt;
    letter-spacing: 0.14em;
    font-weight: 700;
    color: #7c3aed;
    border-bottom: 2px solid #e8d5ff;
    padding-bottom: 6px;
    margin-bottom: 14px;
    text-transform: uppercase;
  }

  /* Overview */
  .overview-text {
    background: linear-gradient(135deg, #faf5ff, #f5f3ff);
    border-left: 4px solid #7c3aed;
    border-radius: 0 8px 8px 0;
    padding: 14px 18px;
    color: #3730a3;
    font-size: 10.5pt;
    line-height: 1.7;
  }

  /* Sections */
  .section {
    margin-bottom: 18px;
    padding: 14px 18px;
    background: #fafafa;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
    page-break-inside: avoid;
  }
  .section h3 {
    font-size: 11pt;
    font-weight: 700;
    color: #1e1b4b;
    margin-bottom: 7px;
  }
  .section p {
    font-size: 10.5pt;
    color: #374151;
    margin-bottom: 8px;
    line-height: 1.65;
  }
  .section ul { padding-left: 18px; }
  .section ul li {
    font-size: 10.5pt;
    color: #4b5563;
    margin-bottom: 4px;
    line-height: 1.55;
  }
  .section ul li::marker { color: #7c3aed; }

  /* Key Terms table */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
  }
  th {
    background: #7c3aed;
    color: #fff;
    padding: 8px 12px;
    text-align: left;
    font-weight: 600;
    font-size: 9.5pt;
    letter-spacing: 0.06em;
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid #e5e7eb;
    vertical-align: top;
    line-height: 1.55;
  }
  tr:nth-child(even) td { background: #faf5ff; }
  .term-name {
    font-weight: 700;
    color: #5b21b6;
    width: 28%;
    white-space: nowrap;
  }

  /* Formulas */
  .formula-row {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 10px;
    page-break-inside: avoid;
  }
  code {
    font-family: 'Courier New', monospace;
    background: #dbeafe;
    color: #1e40af;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10pt;
  }

  /* Practice Q&A */
  .qa-item {
    margin-bottom: 16px;
    page-break-inside: avoid;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
  }
  .qa-q {
    background: #1e1b4b;
    color: #e0e7ff;
    padding: 10px 14px;
    font-size: 10.5pt;
    line-height: 1.55;
  }
  .qa-a {
    background: #f5f3ff;
    color: #374151;
    padding: 10px 14px;
    font-size: 10.5pt;
    line-height: 1.65;
    border-top: 2px solid #ddd6fe;
  }

  /* Summary */
  .summary-text {
    background: linear-gradient(135deg, #f0fdf4, #ecfdf5);
    border-left: 4px solid #059669;
    border-radius: 0 8px 8px 0;
    padding: 14px 18px;
    color: #065f46;
    font-size: 10.5pt;
    line-height: 1.7;
  }

  /* Study Tips */
  .tips-list {
    padding-left: 0;
    list-style: none;
  }
  .tips-list li {
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 6px;
    padding: 9px 14px;
    margin-bottom: 8px;
    font-size: 10.5pt;
    color: #78350f;
    page-break-inside: avoid;
  }
  .tips-list li::before {
    content: '💡 ';
  }

  /* Footer */
  .pdf-footer {
    margin-top: 36px;
    padding-top: 14px;
    border-top: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    font-size: 8pt;
    color: #9ca3af;
  }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .cover { -webkit-print-color-adjust: exact; }
    @page { margin: 0; size: A4; }
  }
</style>
</head>
<body>
  <div class="cover">
    <div class="cover-badge">◈ LUNA AI · STUDY REVIEWER</div>
    <div class="cover-title">${esc(r.title || filename)}</div>
    <div class="cover-meta">
      ${r.subject ? `<span>📚 ${esc(r.subject)}</span>` : ''}
      <span>📅 ${dateStr}</span>
      <span>◈ Generated by Luna AI</span>
    </div>
  </div>

  <div class="content">

    <div class="pdf-block">
      <h2>◈ Overview</h2>
      <div class="overview-text">${esc(r.overview || '')}</div>
    </div>

    <div class="pdf-block">
      <h2>📚 Detailed Sections</h2>
      ${sectionsHtml}
    </div>

    ${r.keyTerms && r.keyTerms.length ? `
    <div class="pdf-block">
      <h2>🔑 Key Terms &amp; Definitions</h2>
      <table>
        <thead><tr><th>Term</th><th>Definition</th></tr></thead>
        <tbody>${keyTermsHtml}</tbody>
      </table>
    </div>` : ''}

    ${formulasHtml}

    ${r.practiceQA && r.practiceQA.length ? `
    <div class="pdf-block">
      <h2>✏ Practice Questions</h2>
      ${qaHtml}
    </div>` : ''}

    <div class="pdf-block">
      <h2>📝 Summary</h2>
      <div class="summary-text">${esc(r.summary || '')}</div>
    </div>

    ${r.studyTips && r.studyTips.length ? `
    <div class="pdf-block">
      <h2>💡 Study Tips</h2>
      <ul class="tips-list">${tipsHtml}</ul>
    </div>` : ''}

    <div class="pdf-footer">
      <span>◈ Luna AI Reviewer — ${esc(r.title || filename)}</span>
      <span>${dateStr}</span>
    </div>

  </div>
</body>
</html>`;

      // Open in new window and trigger print dialog
      const win = window.open('', '_blank', 'width=900,height=700');
      if (!win) {
        if (typeof showToast === 'function') showToast('Please allow popups to export PDF', '⚠️', 3000);
        return;
      }
      win.document.write(printHtml);
      win.document.close();
      win.focus();
      setTimeout(() => {
        win.print();
        // Don't close — let user save as PDF
      }, 600);

      if (typeof showToast === 'function') showToast('Print dialog opened — save as PDF ✦', '📄', 3000);
    }


    // ════════════════════════════════════════════════════════════════
    // ◈ STYLES
    // ════════════════════════════════════════════════════════════════

    function injectHighlighterStyles() {
      const style = document.createElement('style');
      style.textContent = `
      .def-box { display:flex;align-items:flex-start;gap:10px;margin:8px 0;padding:10px 14px;border-radius:10px;border-left:3px solid;font-size:inherit;line-height:1.6;animation:defIn 0.3s cubic-bezier(0.4,0,0.2,1) both; }
      @keyframes defIn { from{opacity:0;transform:translateX(-6px)} to{opacity:1;transform:none} }
      .def-definition { background:rgba(168,85,247,0.08);border-color:rgba(168,85,247,0.5); }
      .def-formula    { background:rgba(34,211,238,0.07);border-color:rgba(34,211,238,0.5); }
      .def-note       { background:rgba(251,191,36,0.07);border-color:rgba(251,191,36,0.5); }
      .def-law        { background:rgba(236,45,90,0.07);border-color:rgba(236,45,90,0.5); }
      .def-icon { font-size:15px;flex-shrink:0;margin-top:1px; }
      .def-content { flex:1;min-width:0; }
      .def-content .md-line { display:inline; }
      [data-theme="astral"] .def-definition { background:rgba(99,102,241,0.09);border-color:rgba(99,102,241,0.5); }
      [data-theme="astral"] .def-formula    { background:rgba(96,165,250,0.08);border-color:rgba(96,165,250,0.5); }
      [data-theme="solar"]  .def-definition { background:rgba(245,158,11,0.09);border-color:rgba(245,158,11,0.5); }
      [data-theme="solar"]  .def-formula    { background:rgba(251,146,60,0.08);border-color:rgba(251,146,60,0.5); }
      [data-theme="galactic"] .def-definition { background:rgba(244,114,182,0.09);border-color:rgba(244,114,182,0.5); }
      [data-theme="galactic"] .def-formula    { background:rgba(34,211,238,0.08);border-color:rgba(34,211,238,0.5); }
      `;
      document.head.appendChild(style);
    }

    function injectFlashcardStyles() {
      const style = document.createElement('style');
      style.textContent = `
      .fc-btn:hover { color:var(--violet-bright) !important; }
      #fcModal { position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.25s; }
      #fcModal.fc-open { opacity:1; }
      .fc-backdrop { position:absolute;inset:0;background:rgba(2,2,9,0.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px); }
      .fc-panel { position:relative;z-index:1;width:min(480px,95vw);background:var(--card);border:1px solid var(--border);border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,0.7),0 0 40px var(--violet-glow);display:flex;flex-direction:column;overflow:hidden;animation:fcSlideIn 0.28s cubic-bezier(0.34,1.3,0.64,1) both; }
      @keyframes fcSlideIn { from{transform:scale(0.88) translateY(20px);opacity:0} to{transform:none;opacity:1} }
      .fc-header { display:flex;align-items:center;justify-content:space-between;padding:16px 20px 14px;border-bottom:1px solid var(--border);background:rgba(168,85,247,0.06); }
      .fc-title { display:flex;align-items:center;gap:8px; }
      .fc-icon { font-size:18px; }
      .fc-title-text { font-family:var(--font-hud);font-size:10px;letter-spacing:0.22em;color:var(--violet-bright); }
      .fc-subtitle { font-family:var(--font-mono);font-size:9px;color:var(--text-lo);margin-left:4px; }
      .fc-close-btn { background:var(--crimson-dim);border:1px solid var(--border-red);border-radius:7px;color:var(--crimson-bright);cursor:pointer;font-size:11px;padding:4px 9px;font-family:var(--font-hud);transition:all 0.15s;letter-spacing:0.05em; }
      .fc-close-btn:hover { background:rgba(236,45,90,0.22); }
      .fc-deck-area { padding:24px 24px 16px;display:flex;align-items:center;justify-content:center; }
      .fc-card-wrap { width:100%;perspective:1000px; }
      .fc-card { position:relative;width:100%;min-height:180px;transform-style:preserve-3d;transition:transform 0.5s cubic-bezier(0.4,0,0.2,1);cursor:pointer;border-radius:16px; }
      .fc-card.fc-flipped { transform:rotateY(180deg); }
      .fc-face { position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:16px;border:1px solid var(--border);padding:22px 24px 18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center; }
      .fc-front { background:linear-gradient(135deg,rgba(168,85,247,0.12) 0%,rgba(168,85,247,0.04) 100%);border-color:rgba(168,85,247,0.35); }
      .fc-back  { background:linear-gradient(135deg,rgba(236,45,90,0.10) 0%,rgba(236,45,90,0.03) 100%);border-color:rgba(236,45,90,0.30);transform:rotateY(180deg); }
      .fc-face-label { font-family:var(--font-hud);font-size:8px;letter-spacing:0.2em;color:var(--text-lo); }
      .fc-front .fc-face-label { color:var(--violet-bright);opacity:0.7; }
      .fc-back  .fc-face-label { color:var(--crimson-bright);opacity:0.7; }
      .fc-face-text { font-family:var(--font-body);font-size:14.5px;color:var(--text-hi);line-height:1.65;font-weight:500;min-height:48px;display:flex;align-items:center;justify-content:center; }
      .fc-tap-hint { font-family:var(--font-mono);font-size:9.5px;color:var(--text-lo);margin-top:4px;animation:fcHintPulse 2.4s ease-in-out infinite; }
      @keyframes fcHintPulse { 0%,100%{opacity:0.4} 50%{opacity:0.9} }
      .fc-mastered-card .fc-front { border-color:rgba(52,211,153,0.5);background:linear-gradient(135deg,rgba(52,211,153,0.1) 0%,rgba(52,211,153,0.03) 100%); }
      .fc-controls { display:flex;align-items:center;justify-content:space-between;padding:0 24px 16px;gap:12px; }
      .fc-nav-btn { background:var(--violet-dim);border:1px solid var(--border);border-radius:9px;color:var(--text-mid);cursor:pointer;font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.12em;padding:8px 16px;transition:all 0.18s;flex:1; }
      .fc-nav-btn:hover { color:var(--violet-bright);border-color:rgba(168,85,247,0.4);background:rgba(168,85,247,0.14); }
      .fc-master-btn { background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.35);border-radius:9px;color:#34d399;cursor:pointer;font-family:var(--font-hud);font-size:8.5px;letter-spacing:0.12em;padding:8px 18px;transition:all 0.18s;flex:1.3;white-space:nowrap; }
      .fc-master-btn:hover { background:rgba(52,211,153,0.2);box-shadow:0 0 12px rgba(52,211,153,0.25); }
      .fc-dots { display:flex;align-items:center;justify-content:center;gap:6px;padding:0 24px 16px;flex-wrap:wrap; }
      .fc-dot { width:7px;height:7px;border-radius:50%;background:var(--text-lo);cursor:pointer;transition:all 0.2s; }
      .fc-dot-active { background:var(--violet-bright);transform:scale(1.35); }
      .fc-dot-mastered { background:#34d399; }
      .fc-stats { padding:0 24px 18px;text-align:center;font-family:var(--font-hud);font-size:8.5px;min-height:24px; }
      .fc-mastered-badge { display:inline-block;padding:3px 10px;background:rgba(52,211,153,0.14);border:1px solid rgba(52,211,153,0.3);border-radius:12px;color:#34d399;letter-spacing:0.1em; }
      .fc-mastered-all { background:rgba(52,211,153,0.22);border-color:rgba(52,211,153,0.5);font-size:9.5px; }
      `;
      document.head.appendChild(style);
    }

    function injectReviewerStyles() {
      const style = document.createElement('style');
      style.textContent = `
      /* ── Reviewer Modal ──────────────────────────────────────────── */
      #reviewerModal {
        position: fixed; inset: 0; z-index: 9998;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.28s;
      }
      #reviewerModal.rv-open { opacity: 1; }

      .rv-backdrop {
        position: absolute; inset: 0;
        background: rgba(2,2,9,0.88);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      .rv-panel {
        position: relative; z-index: 1;
        width: min(780px, 97vw);
        max-height: 92vh;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
        box-shadow: 0 32px 100px rgba(0,0,0,0.8), 0 0 50px rgba(168,85,247,0.18);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: rvSlideIn 0.3s cubic-bezier(0.34,1.2,0.64,1) both;
      }
      @keyframes rvSlideIn { from{transform:scale(0.92) translateY(24px);opacity:0} to{transform:none;opacity:1} }

      /* Header */
      .rv-header {
        display: flex; align-items: flex-start; justify-content: space-between;
        padding: 20px 24px 16px;
        background: linear-gradient(135deg, rgba(168,85,247,0.1), rgba(236,45,90,0.06));
        border-bottom: 1px solid var(--border);
        flex-shrink: 0; gap: 12px;
      }
      .rv-header-info { flex: 1; min-width: 0; }
      .rv-header-badge {
        font-family: var(--font-hud); font-size: 8px; letter-spacing: 0.24em;
        color: var(--violet-bright); margin-bottom: 6px; opacity: 0.8;
      }
      .rv-title {
        font-family: var(--font-hud); font-size: 15px; letter-spacing: 0.06em;
        color: var(--text-hi); line-height: 1.3; margin-bottom: 6px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .rv-meta { display: flex; gap: 12px; flex-wrap: wrap; }
      .rv-subject {
        font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em;
        color: var(--violet-bright); background: var(--violet-dim);
        padding: 2px 8px; border-radius: 10px;
        border: 1px solid rgba(168,85,247,0.25);
      }
      .rv-date {
        font-family: var(--font-mono); font-size: 9px;
        color: var(--text-lo);
      }
      .rv-header-actions { display: flex; gap: 8px; align-items: flex-start; flex-shrink: 0; }

      .rv-pdf-btn {
        background: linear-gradient(135deg, var(--crimson), var(--violet));
        border: none; border-radius: 9px;
        color: #fff; cursor: pointer;
        font-family: var(--font-hud); font-size: 8.5px;
        letter-spacing: 0.14em; padding: 8px 16px;
        transition: all 0.2s; white-space: nowrap;
        box-shadow: 0 4px 16px rgba(168,85,247,0.3);
      }
      .rv-pdf-btn:hover { filter: brightness(1.15); transform: translateY(-1px); box-shadow: 0 6px 22px rgba(168,85,247,0.45); }

      .rv-close-btn {
        background: var(--crimson-dim); border: 1px solid var(--border-red);
        border-radius: 9px; color: var(--crimson-bright); cursor: pointer;
        font-size: 11px; padding: 7px 11px;
        font-family: var(--font-hud); transition: all 0.15s;
      }
      .rv-close-btn:hover { background: rgba(236,45,90,0.22); }

      /* Body (scrollable) */
      .rv-body {
        flex: 1; overflow-y: auto; padding: 20px 24px 28px;
        display: flex; flex-direction: column; gap: 20px;
        scrollbar-width: thin; scrollbar-color: rgba(168,85,247,0.3) transparent;
      }
      .rv-body::-webkit-scrollbar { width: 4px; }
      .rv-body::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.3); border-radius: 4px; }

      /* Blocks */
      .rv-block {
        background: rgba(168,85,247,0.03);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px 18px;
      }
      .rv-overview-block { border-color: rgba(168,85,247,0.3); background: rgba(168,85,247,0.06); }
      .rv-summary-block  { border-color: rgba(52,211,153,0.3);  background: rgba(52,211,153,0.05); }
      .rv-tips-block     { border-color: rgba(251,191,36,0.3);   background: rgba(251,191,36,0.05); }

      .rv-block-title {
        font-family: var(--font-hud); font-size: 8.5px;
        letter-spacing: 0.2em; color: var(--violet-bright);
        margin-bottom: 12px; opacity: 0.9;
      }
      .rv-overview-block .rv-block-title { color: var(--violet-bright); }
      .rv-summary-block  .rv-block-title { color: #34d399; }
      .rv-tips-block     .rv-block-title { color: var(--gold); }

      .rv-overview-text, .rv-summary-text {
        font-size: 13px; color: var(--text-mid); line-height: 1.75;
      }

      /* Sections */
      .rv-section {
        padding: 12px 14px; margin-bottom: 12px;
        background: var(--panel); border-radius: 9px;
        border: 1px solid var(--border);
      }
      .rv-section:last-child { margin-bottom: 0; }
      .rv-section-heading {
        font-family: var(--font-hud); font-size: 10px;
        letter-spacing: 0.1em; color: var(--text-hi);
        margin-bottom: 7px;
      }
      .rv-section-content {
        font-size: 12.5px; color: var(--text-mid); line-height: 1.7;
        margin-bottom: 8px;
      }
      .rv-key-points {
        padding-left: 16px; margin: 0;
      }
      .rv-key-points li {
        font-size: 12px; color: var(--text-mid); line-height: 1.6;
        margin-bottom: 4px;
      }
      .rv-key-points li::marker { color: var(--violet-bright); }

      /* Key Terms grid */
      .rv-terms-grid { display: flex; flex-direction: column; gap: 6px; }
      .rv-term-row {
        display: flex; gap: 12px; padding: 9px 12px;
        background: var(--panel); border-radius: 7px;
        border: 1px solid var(--border); align-items: flex-start;
      }
      .rv-term-name {
        font-family: var(--font-hud); font-size: 9px; letter-spacing: 0.1em;
        color: var(--violet-bright); flex-shrink: 0; width: 130px;
        padding-top: 1px; word-break: break-word;
      }
      .rv-term-def { font-size: 12px; color: var(--text-mid); line-height: 1.6; }

      /* Formulas */
      .rv-formula-row {
        padding: 10px 14px; margin-bottom: 8px;
        background: rgba(34,211,238,0.05);
        border: 1px solid rgba(34,211,238,0.25);
        border-radius: 8px;
      }
      .rv-formula-name {
        font-family: var(--font-hud); font-size: 9px;
        color: var(--cyan); letter-spacing: 0.1em; margin-bottom: 4px;
      }
      .rv-formula-expr {
        font-family: var(--font-mono); font-size: 12px;
        color: var(--text-hi); margin-bottom: 4px;
      }
      .rv-formula-note { font-size: 11px; color: var(--text-lo); font-style: italic; }

      /* Practice Q&A */
      .rv-qa-item {
        margin-bottom: 10px; border-radius: 9px;
        border: 1px solid var(--border); overflow: hidden;
      }
      .rv-qa-q {
        padding: 10px 14px; background: rgba(168,85,247,0.08);
        font-size: 12.5px; color: var(--text-hi); line-height: 1.6;
        display: flex; gap: 8px;
      }
      .rv-qa-num {
        font-family: var(--font-hud); font-size: 8px;
        color: var(--violet-bright); flex-shrink: 0; padding-top: 3px;
        letter-spacing: 0.1em;
      }
      .rv-qa-a {
        padding: 10px 14px; background: rgba(52,211,153,0.05);
        font-size: 12px; color: var(--text-mid); line-height: 1.7;
        border-top: 1px solid rgba(52,211,153,0.2);
      }
      .rv-qa-toggle {
        display: block; width: 100%; background: var(--panel);
        border: none; border-top: 1px solid var(--border);
        color: var(--text-lo); cursor: pointer;
        font-family: var(--font-hud); font-size: 8px;
        letter-spacing: 0.12em; padding: 7px 14px; text-align: left;
        transition: all 0.15s;
      }
      .rv-qa-toggle:hover { color: var(--violet-bright); background: var(--violet-dim); }

      /* Study Tips */
      .rv-tips-list { padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; }
      .rv-tips-list li {
        padding: 9px 14px; background: rgba(251,191,36,0.07);
        border: 1px solid rgba(251,191,36,0.2); border-radius: 7px;
        font-size: 12.5px; color: var(--text-mid); line-height: 1.6;
      }

      /* Mobile */
      @media (max-width: 600px) {
        .rv-panel { border-radius: 14px; max-height: 96vh; }
        .rv-header { padding: 14px 16px 12px; }
        .rv-body { padding: 14px 16px 20px; gap: 14px; }
        .rv-title { font-size: 12px; }
        .rv-pdf-btn { font-size: 8px; padding: 7px 12px; }
        .rv-term-name { width: 100px; }
      }
      `;
      document.head.appendChild(style);
    }

    console.log('[Luna Features] Flashcard Mode + Definition Highlighter + File Reviewer loaded ✦');
  }

})();
// ══════════════════════════════════════════════════════════════════
// ◈ LUNA STUDY GAME — File-based Quiz System
//   Upload any .txt .pdf .docx .md .csv .json file → Luna generates
//   questions in 3 modes: Multiple Choice · True/False · Fill-in-Blank
//   Features: scoring, streaks, progress bar, answer explanations,
//   confetti on completion, persistent high score.
// ══════════════════════════════════════════════════════════════════

(function lunaStudyGame() {

  // ── State ──────────────────────────────────────────────────────
  let sgQuestions   = [];
  let sgIndex       = 0;
  let sgScore       = 0;
  let sgStreak      = 0;
  let sgBestStreak  = 0;
  let sgMode        = 'mc';       // 'mc' | 'tf' | 'fib'
  let sgNumItems    = 10;         // number of questions to generate
  let sgAnswered    = false;
  let sgFileText    = '';
  let sgFileName    = '';
  let sgOverlay     = null;

  // ── Open the Study Game modal ──────────────────────────────────
  window.openStudyGame = function() {
    if (sgOverlay) return;
    injectStudyGameStyles();

    sgOverlay = document.createElement('div');
    sgOverlay.className = 'sg-overlay';
    sgOverlay.id = 'sgOverlay';
    sgOverlay.innerHTML = buildLandingHTML();
    document.body.appendChild(sgOverlay);

    // close on backdrop click
    sgOverlay.addEventListener('click', e => {
      if (e.target === sgOverlay) closeStudyGame();
    });
  };

  function closeStudyGame() {
    if (sgOverlay) { sgOverlay.remove(); sgOverlay = null; }
    sgQuestions = []; sgIndex = 0; sgScore = 0; sgStreak = 0;
    sgAnswered = false; sgFileText = ''; sgFileName = ''; sgNumItems = 10;
    clearInterval(sgSpeedTimer); sgMatchPairs = {}; sgMatchSelected = null; sgDragSrc = null;
  }

  // ── Landing screen HTML ────────────────────────────────────────
  function buildLandingHTML() {
    return `
    <div class="sg-panel" id="sgPanel">
      <div class="sg-header">
        <div class="sg-header-left">
          <span class="sg-badge">◈ STUDY GAME</span>
          <span class="sg-title">Neural Study Mode</span>
        </div>
        <button class="sg-close-btn" onclick="(function(){document.getElementById('sgOverlay').remove();window.sgOverlay=null;})()">✕</button>
      </div>

      <div class="sg-body" id="sgBody">
        <!-- Hero -->
        <div class="sg-hero">
          <div class="sg-hero-icon">📚</div>
          <div class="sg-hero-title">Upload a file to study</div>
          <div class="sg-hero-sub">Luna will read your document and generate quiz questions to test your knowledge.</div>
        </div>

        <!-- Upload zone -->
        <div class="sg-upload-zone" id="sgDropZone">
          <input type="file" id="sgFileInput" accept=".txt,.md,.pdf,.docx,.csv,.json" style="display:none" />
          <div class="sg-upload-icon">⬡</div>
          <div class="sg-upload-label">Drop your file here or <span class="sg-upload-link" onclick="document.getElementById('sgFileInput').click()">browse</span></div>
          <div class="sg-upload-types">.txt · .pdf · .docx · .md · .csv · .json</div>
        </div>

        <!-- File badge (hidden until file picked) -->
        <div class="sg-file-badge" id="sgFileBadge" style="display:none">
          <span id="sgFileIcon">📄</span>
          <span id="sgFileName">—</span>
          <button class="sg-file-remove" onclick="sgClearFile()">✕</button>
        </div>

        <!-- Mode selector -->
        <div class="sg-section-label">QUIZ MODE</div>
        <div class="sg-mode-row">
          <button class="sg-mode-btn sg-mode-active" data-mode="mc"   onclick="sgSelectMode('mc',this)">
            <span class="sg-mode-icon">🎯</span>
            <span class="sg-mode-name">Multiple<br>Choice</span>
          </button>
          <button class="sg-mode-btn" data-mode="tf"   onclick="sgSelectMode('tf',this)">
            <span class="sg-mode-icon">⚖️</span>
            <span class="sg-mode-name">True / <br>False</span>
          </button>
          <button class="sg-mode-btn" data-mode="fib"  onclick="sgSelectMode('fib',this)">
            <span class="sg-mode-icon">✏️</span>
            <span class="sg-mode-name">Fill in<br>the Blank</span>
          </button>
          <button class="sg-mode-btn" data-mode="match" onclick="sgSelectMode('match',this)">
            <span class="sg-mode-icon">🧩</span>
            <span class="sg-mode-name">Matching</span>
          </button>
          <button class="sg-mode-btn" data-mode="speed" onclick="sgSelectMode('speed',this)">
            <span class="sg-mode-icon">⚡</span>
            <span class="sg-mode-name">Speed<br>Round</span>
          </button>
          <button class="sg-mode-btn" data-mode="order" onclick="sgSelectMode('order',this)">
            <span class="sg-mode-icon">🔢</span>
            <span class="sg-mode-name">Ordering</span>
          </button>
        </div>

        <!-- Difficulty -->
        <div class="sg-section-label">DIFFICULTY</div>
        <div class="sg-diff-row">
          <button class="sg-diff-btn sg-diff-active" data-diff="easy"   onclick="sgSelectDiff(this)">Easy</button>
          <button class="sg-diff-btn" data-diff="medium" onclick="sgSelectDiff(this)">Medium</button>
          <button class="sg-diff-btn" data-diff="hard"   onclick="sgSelectDiff(this)">Hard</button>
        </div>

        <!-- Number of items -->
        <div class="sg-section-label">NUMBER OF ITEMS</div>
        <div class="sg-nitems-row">
          <button class="sg-nitem-btn" data-n="5"  onclick="sgSelectNItems(5,this)">5</button>
          <button class="sg-nitem-btn sg-nitem-active" data-n="10" onclick="sgSelectNItems(10,this)">10</button>
          <button class="sg-nitem-btn" data-n="15" onclick="sgSelectNItems(15,this)">15</button>
          <button class="sg-nitem-btn" data-n="20" onclick="sgSelectNItems(20,this)">20</button>
          <button class="sg-nitem-btn sg-nitem-custom" id="sgNItemCustomBtn" onclick="sgToggleCustomN(this)">✎</button>
        </div>
        <div id="sgNItemCustomWrap" style="display:none">
          <input class="sg-fib-input" id="sgCustomNInput" type="number" min="3" max="30" placeholder="Enter number (3–30)" style="font-size:13px;width:100%;box-sizing:border-box" oninput="sgApplyCustomN(this.value)" />
          <div style="font-size:11px;color:var(--text-lo,#3d3060);margin-top:4px;padding:0 2px">3 to 30 questions</div>
        </div>

        <!-- Start btn -->
        <button class="sg-start-btn" id="sgStartBtn" onclick="sgStartGame()" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          START QUIZ
        </button>

        <!-- High score strip -->
        <div class="sg-hs-strip" id="sgHsStrip" style="display:none">
          <span>🏆</span><span id="sgHsLabel">—</span>
        </div>
      </div>
    </div>`;
  }

  // ── Mode / Diff helpers ────────────────────────────────────────
  window.sgSelectMode = function(mode, btn) {
    sgMode = mode;
    document.querySelectorAll('.sg-mode-btn').forEach(b => b.classList.remove('sg-mode-active'));
    btn.classList.add('sg-mode-active');
  };

  window.sgSelectDiff = function(btn) {
    document.querySelectorAll('.sg-diff-btn').forEach(b => b.classList.remove('sg-diff-active'));
    btn.classList.add('sg-diff-active');
  };

  window.sgSelectNItems = function(n, btn) {
    sgNumItems = n;
    document.querySelectorAll('.sg-nitem-btn').forEach(b => b.classList.remove('sg-nitem-active'));
    btn.classList.add('sg-nitem-active');
    const wrap = document.getElementById('sgNItemCustomWrap');
    if (wrap) wrap.style.display = 'none';
  };
  window.sgToggleCustomN = function(btn) {
    const wrap = document.getElementById('sgNItemCustomWrap');
    if (!wrap) return;
    const isOpen = wrap.style.display !== 'none';
    if (isOpen) { wrap.style.display = 'none'; }
    else {
      document.querySelectorAll('.sg-nitem-btn').forEach(b => b.classList.remove('sg-nitem-active'));
      btn.classList.add('sg-nitem-active');
      wrap.style.display = 'block';
      setTimeout(() => document.getElementById('sgCustomNInput')?.focus(), 60);
    }
  };
  window.sgApplyCustomN = function(val) {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n >= 3 && n <= 30) sgNumItems = n;
  };

  // ── Clear file ─────────────────────────────────────────────────
  window.sgClearFile = function() {
    sgFileText = ''; sgFileName = '';
    document.getElementById('sgFileBadge').style.display = 'none';
    document.getElementById('sgStartBtn').disabled = true;
  };

  // ── File drop / pick ───────────────────────────────────────────
  function bindFileEvents() {
    const input    = document.getElementById('sgFileInput');
    const dropZone = document.getElementById('sgDropZone');
    if (!input || !dropZone) return;

    input.addEventListener('change', () => { if (input.files[0]) sgLoadFile(input.files[0]); });

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('sg-dz-hover'); });
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('sg-dz-hover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('sg-dz-hover');
      if (e.dataTransfer.files[0]) sgLoadFile(e.dataTransfer.files[0]);
    });
  }

  async function sgLoadFile(file) {
    const extMap = { txt:'📄', md:'📝', pdf:'📕', docx:'📘', csv:'📊', json:'🗂️' };
    const ext = file.name.split('.').pop().toLowerCase();
    if (typeof showToast === 'function') showToast('◈ Reading file…', '📂', 1800);
    try {
      // reuse the existing readFile() from the host app if available
      let text;
      if (typeof readFile === 'function') {
        text = await readFile(file);
      } else {
        text = await file.text();
      }
      if (!text || text.trim().length < 40) throw new Error('File is too short or empty.');
      sgFileText = text.trim().slice(0, 6000);
      sgFileName = file.name;
      document.getElementById('sgFileIcon').textContent  = extMap[ext] || '📄';
      document.getElementById('sgFileName').textContent  = file.name;
      document.getElementById('sgFileBadge').style.display = 'flex';
      document.getElementById('sgStartBtn').disabled = false;
      // show high score if any
      const hs = getHighScore(file.name);
      const hsStrip = document.getElementById('sgHsStrip');
      if (hs > 0 && hsStrip) {
        hsStrip.style.display = 'flex';
        document.getElementById('sgHsLabel').textContent = `Best score for this file: ${hs}%`;
      }
    } catch(e) {
      if (typeof showToast === 'function') showToast('⚠ ' + e.message, '⚠️', 3000);
    }
  }

  // ── Start game ─────────────────────────────────────────────────
  window.sgStartGame = async function() {
    if (!sgFileText) return;
    const diff = document.querySelector('.sg-diff-active')?.dataset.diff || 'medium';
    const body  = document.getElementById('sgBody');
    body.innerHTML = `<div class="sg-loading"><div class="sg-spinner"></div><div class="sg-loading-text">Luna is reading your file and generating questions…</div></div>`;

    try {
      sgQuestions = await generateStudyQuestions(sgFileText, sgMode, diff, sgNumItems);
    } catch(e) {
      body.innerHTML = `<div class="sg-loading"><div style="font-size:28px">⚠️</div><div class="sg-loading-text" style="color:var(--crimson-bright)">${e.message}</div><button class="sg-start-btn" style="margin-top:16px" onclick="document.getElementById('sgOverlay').remove()">CLOSE</button></div>`;
      return;
    }
    if (!sgQuestions.length) {
      body.innerHTML = `<div class="sg-loading"><div style="font-size:28px">😕</div><div class="sg-loading-text">Could not generate questions from this file. Try a different file or mode.</div><button class="sg-start-btn" style="margin-top:16px" onclick="document.getElementById('sgOverlay').remove()">CLOSE</button></div>`;
      return;
    }
    sgIndex = 0; sgScore = 0; sgStreak = 0; sgBestStreak = 0; sgAnswered = false;
    renderQuestion();
  };

  // ── Generate questions via Groq ────────────────────────────────
  async function generateStudyQuestions(text, mode, diff, numItems) {
    const modeInstructions = {
      mc:  `Generate exactly ${numItems} multiple-choice questions with 4 options each (A, B, C, D). Every correct answer AND every wrong option must be grounded in the document — wrong options should be plausible but clearly incorrect based on what the document actually says. Do not use any knowledge outside the document.`,
      tf:  `Generate exactly ${numItems} true/false statements. Every statement must be directly verifiable as True or False using ONLY the document text. Do NOT invent facts. Every statement must reflect something explicitly written in the document.`,
      fib: `Generate exactly ${numItems} fill-in-the-blank questions. Every blank must be filled by an exact word, phrase, number, or name that appears verbatim in the document. The surrounding sentence context must also come from the document.`,
      match: `Generate exactly 6 matching pairs. Each pair has a TERM (a key word, name, or concept from the document) and a DEFINITION (a short description or explanation of that term, taken directly from the document). Terms must be distinct and definitions must be unique.`,
      speed: `Generate exactly ${numItems} true/false statements suitable for rapid answering. Statements must be short (max 15 words each), clearly True or False based on the document. Mix of true and false — at least 6 of each.`,
      order: `Generate exactly 4 ordering questions. Each question presents 4 scrambled items (steps, events, or stages) that have a logical or chronological sequence based on the document. The items must come from the document.`
    };
    const diffInstructions = {
      easy:   'Use direct quotes and simple facts stated explicitly in the document. The answer should be findable by skimming the document.',
      medium: 'Require the user to understand and connect information from different parts of the document. The answer is in the document but needs careful reading.',
      hard:   'Ask about specific details, numbers, relationships, or distinctions that are only clear from close reading of the document. The answer must still be in the document.'
    };

    const systemPrompt = `You are a strict document-based quiz generator. Your ONLY job is to create quiz questions whose answers come EXCLUSIVELY from the document the user provides.

ABSOLUTE RULES — never break these:
1. Every answer must be found word-for-word or as a direct fact in the document text provided by the user.
2. Do NOT use any outside knowledge, assumptions, or general facts. If something is not in the document, do not ask about it.
3. Do NOT invent, assume, or extrapolate beyond what is written.
4. For fill-in-the-blank: the answer word/phrase must appear literally in the document text.
5. For multiple choice: all 4 options must relate to the document content. Wrong options should be plausible alternatives drawn from other parts of the document.
6. For true/false: every statement must reference real content from the document. False statements should contradict something specifically stated in the document.
7. The explanation field must quote or closely paraphrase the exact sentence or passage from the document that proves the answer.
8. For matching: all terms and definitions must come directly from the document. Do not invent definitions.
9. For ordering: each item in the sequence must be a real step, event, or stage from the document. The correct order must be derivable from the document.

Mode: ${modeInstructions[mode]}
Difficulty: ${diff} — ${diffInstructions[diff]}

OUTPUT RULE: Respond ONLY with a raw JSON array. Zero markdown, zero preamble, just the JSON array itself.

JSON format for multiple-choice:
[{"q":"Question based on document?","options":["A. option from doc","B. option from doc","C. option from doc","D. option from doc"],"answer":"A","explanation":"The document states: ... which confirms A is correct."}]

JSON format for true/false:
[{"q":"Statement directly from document content.","answer":"True","explanation":"The document says: ... confirming this is true."}]

JSON format for fill-in-the-blank:
[{"q":"Sentence from document with ___ replacing one key word.","answer":"exact word from document","hint":"Look for this in the section about [topic from doc].","explanation":"The document reads: ... where this word appears."}]

JSON format for matching:
[{"pairs":[{"term":"Key word from doc","def":"Short definition from doc"},{"term":"...","def":"..."}]}]

JSON format for speed (true/false rapid):
[{"q":"Short statement from document.","answer":"True","explanation":"The document states: ..."}]

JSON format for ordering:
[{"q":"What is the correct order of these steps?","items":["Step C from doc","Step A from doc","Step D from doc","Step B from doc"],"order":[1,2,3,4],"explanation":"According to the document, the correct sequence is A→B→C→D because..."}]`;

    const userPrompt = `DOCUMENT TO STUDY — generate ALL questions and answers EXCLUSIVELY from this text:\n\n"""\n${text.slice(0, 5000)}\n"""\n\nRemember: every answer must come from the document above. Do not use outside knowledge. Output the JSON array only.`;

    const apiKey = (typeof getActiveApiKey === 'function') ? getActiveApiKey() : '';
    const apiUrl = (typeof API_URL !== 'undefined') ? API_URL : 'https://api.groq.com/openai/v1/chat/completions';
    const apiModel = (typeof API_MODEL !== 'undefined' && API_MODEL !== 'compound-beta') ? API_MODEL : 'llama-3.3-70b-versatile';

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: apiModel,
        max_tokens: 8000,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ]
      })
    });
    if (!resp.ok) throw new Error(`API error ${resp.status}. Check your connection.`);
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '';
    // Strip any markdown fences
    const clean = raw.replace(/```json|```/gi, '').trim();
    // Extract JSON array
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Luna returned an unexpected format. Please try again.');
    return JSON.parse(match[0]);
  }

  // ── Render question ────────────────────────────────────────────
  function renderQuestion() {
    const body  = document.getElementById('sgBody');
    const q     = sgQuestions[sgIndex];
    const total = sgQuestions.length;
    const pct   = Math.round((sgIndex / total) * 100);
    sgAnswered  = false;
    sgMatchPairs = {}; sgMatchSelected = null;

    let answerHTML = '';
    if (sgMode === 'mc') {
      answerHTML = `<div class="sg-options" id="sgOptions">
        ${q.options.map((opt, i) => `
          <button class="sg-opt-btn" data-idx="${i}" data-label="${opt.charAt(0)}" onclick="sgPickMC(this)">
            <span class="sg-opt-label">${opt.charAt(0)}</span>
            <span class="sg-opt-text">${opt.slice(3)}</span>
          </button>`).join('')}
      </div>`;
    } else if (sgMode === 'tf') {
      answerHTML = `<div class="sg-tf-row" id="sgOptions">
        <button class="sg-tf-btn sg-tf-true"  onclick="sgPickTF(this,'True')">
          <span style="font-size:20px">✅</span> TRUE
        </button>
        <button class="sg-tf-btn sg-tf-false" onclick="sgPickTF(this,'False')">
          <span style="font-size:20px">❌</span> FALSE
        </button>
      </div>`;
    } else if (sgMode === 'fib') {
      answerHTML = `<div class="sg-fib-wrap">
        ${q.hint ? `<div class="sg-fib-hint">💡 Hint: ${q.hint}</div>` : ''}
        <div class="sg-fib-input-row">
          <input class="sg-fib-input" id="sgFibInput" type="text" placeholder="Type your answer…" autocomplete="off"
            onkeydown="if(event.key==='Enter')sgPickFIB()" />
          <button class="sg-fib-submit" onclick="sgPickFIB()">CHECK ◈</button>
        </div>
      </div>`;
    } else if (sgMode === 'match') {
      // Matching mode: pick from right column
      const pairs = q.pairs;
      const shuffledDefs = [...pairs].sort(() => Math.random() - 0.5);
      answerHTML = `<div class="sg-match-grid" id="sgMatchGrid">
        <div class="sg-match-col sg-match-terms">
          ${pairs.map((p,i) => `<div class="sg-match-term" data-idx="${i}" id="sg-term-${i}" onclick="sgMatchSelectTerm(this)">${p.term}</div>`).join('')}
        </div>
        <div class="sg-match-col sg-match-defs">
          ${shuffledDefs.map((p,i) => `<div class="sg-match-def" data-def="${pairs.indexOf(p)}" id="sg-def-${i}" onclick="sgMatchSelectDef(this)">${p.def}</div>`).join('')}
        </div>
      </div>
      <div id="sgMatchStatus" style="font-size:12px;color:var(--text-mid,#9580b5);text-align:center">Select a term, then its matching definition.</div>`;
    } else if (sgMode === 'speed') {
      answerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
        <div class="sg-speed-timer-wrap">
          <div class="sg-speed-timer-bar"><div class="sg-speed-timer-fill" id="sgSpeedFill"></div></div>
          <div class="sg-speed-timer-label" id="sgSpeedLabel">5</div>
        </div>
        <div class="sg-tf-row" id="sgOptions">
          <button class="sg-tf-btn sg-tf-true"  onclick="sgPickTF(this,'True')">
            <span style="font-size:20px">✅</span> TRUE
          </button>
          <button class="sg-tf-btn sg-tf-false" onclick="sgPickTF(this,'False')">
            <span style="font-size:20px">❌</span> FALSE
          </button>
        </div>
      </div>`;
    } else if (sgMode === 'order') {
      const items = [...q.items].sort(() => Math.random() - 0.5);
      answerHTML = `<div class="sg-order-list" id="sgOrderList">
        ${items.map((item, i) => `<div class="sg-order-item" draggable="true" data-item="${encodeURIComponent(item)}" id="sg-oi-${i}">
          <span class="sg-order-handle">⠿</span>
          <span class="sg-order-num" id="sg-on-${i}">${i+1}</span>
          <span class="sg-order-text">${item}</span>
        </div>`).join('')}
      </div>
      <button class="sg-fib-submit" style="width:100%;padding:12px;font-size:10px;letter-spacing:0.14em" onclick="sgCheckOrder()">CHECK ORDER ◈</button>`;
    } else {
      answerHTML = '';
    }

    body.innerHTML = `
      <!-- Progress -->
      <div class="sg-progress-wrap">
        <div class="sg-progress-bar"><div class="sg-progress-fill" style="width:${pct}%"></div></div>
        <div class="sg-progress-labels">
          <span class="sg-q-counter">${sgIndex + 1} / ${total}</span>
          <span class="sg-score-pill">Score: ${sgScore}</span>
          ${sgStreak >= 2 ? `<span class="sg-streak-pill">🔥 ${sgStreak}</span>` : ''}
        </div>
      </div>

      <!-- Question card -->
      <div class="sg-q-card">
        <div class="sg-q-mode-tag">${{mc:'Multiple Choice',tf:'True / False',fib:'Fill in the Blank',match:'Matching',speed:'Speed Round',order:'Ordering'}[sgMode]}</div>
        <div class="sg-q-text">${q.q}</div>
      </div>

      <!-- Answer area -->
      ${answerHTML}

      <!-- Feedback area (populated after answer) -->
      <div id="sgFeedback"></div>

      <!-- Next button (hidden until answered) -->
      <button class="sg-next-btn" id="sgNextBtn" style="display:none" onclick="sgNext()">
        ${sgIndex + 1 < total ? 'NEXT QUESTION →' : 'SEE RESULTS ◈'}
      </button>
    `;

    // auto-focus FIB input
    if (sgMode === 'fib') setTimeout(() => document.getElementById('sgFibInput')?.focus(), 50);
    // init speed timer
    if (sgMode === 'speed') sgStartSpeedTimer();
    // init ordering drag
    if (sgMode === 'order') sgInitOrdering();
  }

  // ── Answer handlers ────────────────────────────────────────────
  window.sgPickMC = function(btn) {
    if (sgAnswered) return;
    sgAnswered = true;
    const q = sgQuestions[sgIndex];
    const chosen = btn.dataset.label;
    const correct = chosen === q.answer;
    // Mark all buttons
    document.querySelectorAll('.sg-opt-btn').forEach(b => {
      b.disabled = true;
      if (b.dataset.label === q.answer) b.classList.add('sg-opt-correct');
      else if (b === btn && !correct) b.classList.add('sg-opt-wrong');
    });
    handleResult(correct, q.explanation);
  };

  window.sgPickTF = function(btn, choice) {
    if (sgAnswered) return;
    sgAnswered = true;
    const q = sgQuestions[sgIndex];
    const correct = choice === q.answer;
    document.querySelectorAll('.sg-tf-btn').forEach(b => { b.disabled = true; });
    btn.classList.add(correct ? 'sg-tf-selected-correct' : 'sg-tf-selected-wrong');
    // Show correct answer if wrong
    if (!correct) {
      document.querySelectorAll('.sg-tf-btn').forEach(b => {
        if ((b.textContent.includes('TRUE') && q.answer === 'True') ||
            (b.textContent.includes('FALSE') && q.answer === 'False')) {
          b.classList.add('sg-tf-selected-correct');
        }
      });
    }
    handleResult(correct, q.explanation);
  };

  window.sgPickFIB = function() {
    if (sgAnswered) return;
    const input = document.getElementById('sgFibInput');
    if (!input) return;
    const typed = input.value.trim();
    if (!typed) { input.focus(); return; }
    sgAnswered = true;
    const q = sgQuestions[sgIndex];
    const correct = typed.toLowerCase().replace(/[^a-z0-9]/g,'') === q.answer.toLowerCase().replace(/[^a-z0-9]/g,'');
    input.disabled = true;
    document.querySelector('.sg-fib-submit').disabled = true;
    if (correct) input.style.borderColor = '#34d399';
    else {
      input.style.borderColor = 'var(--crimson-bright)';
      // Show correct answer
      const row = document.querySelector('.sg-fib-input-row');
      if (row) {
        const corr = document.createElement('div');
        corr.className = 'sg-fib-correct-ans';
        corr.textContent = '✅ Correct answer: ' + q.answer;
        row.after(corr);
      }
    }
    handleResult(correct, q.explanation);
  };

  // ── MATCHING MODE handlers ─────────────────────────────────────
  let sgMatchSelected = null; // { type:'term'|'def', idx, el }
  let sgMatchPairs    = {};   // termIdx -> defIdx matched so far

  window.sgMatchSelectTerm = function(el) {
    if (el.dataset.matched || sgAnswered) return;
    document.querySelectorAll('.sg-match-term').forEach(e => e.classList.remove('sg-match-sel'));
    // If a def was pre-selected, preserve it
    const prevDef = sgMatchSelected && sgMatchSelected.defEl ? { defIdx: sgMatchSelected.defIdx, defEl: sgMatchSelected.defEl } : {};
    el.classList.add('sg-match-sel');
    sgMatchSelected = { type:'term', idx: parseInt(el.dataset.idx), el, ...prevDef };
    sgTryMatch();
  };
  window.sgMatchSelectDef = function(el) {
    if (el.dataset.matched || sgAnswered) return;
    document.querySelectorAll('.sg-match-def').forEach(e => e.classList.remove('sg-match-sel'));
    el.classList.add('sg-match-sel');
    if (!sgMatchSelected) { sgMatchSelected = { defIdx: parseInt(el.dataset.def), defEl: el }; return; }
    sgMatchSelected = { ...sgMatchSelected, defIdx: parseInt(el.dataset.def), defEl: el };
    sgTryMatch();
  };
  function sgTryMatch() {
    if (!sgMatchSelected || sgMatchSelected.defEl === undefined || sgMatchSelected.el === undefined) return;
    const { idx, el, defIdx, defEl } = sgMatchSelected;
    const correct = idx === defIdx;
    el.classList.remove('sg-match-sel');
    defEl.classList.remove('sg-match-sel');
    if (correct) {
      el.classList.add('sg-match-correct'); el.dataset.matched = '1';
      defEl.classList.add('sg-match-correct'); defEl.dataset.matched = '1';
      sgMatchPairs[idx] = defIdx;
      const pairs = sgQuestions[sgIndex].pairs;
      if (Object.keys(sgMatchPairs).length === pairs.length) {
        // All matched!
        sgAnswered = true;
        sgScore++;
        sgStreak++; if (sgStreak > sgBestStreak) sgBestStreak = sgStreak;
        const fb = document.getElementById('sgFeedback');
        if (fb) fb.innerHTML = `<div class="sg-feedback sg-fb-correct"><span class="sg-fb-icon">🎉</span><div><div class="sg-fb-title">Perfect match!</div><div class="sg-fb-exp">All pairs correctly matched.</div></div></div>`;
        document.getElementById('sgNextBtn').style.display = 'flex';
      }
    } else {
      el.classList.add('sg-match-wrong');
      defEl.classList.add('sg-match-wrong');
      setTimeout(() => {
        el.classList.remove('sg-match-wrong');
        defEl.classList.remove('sg-match-wrong');
      }, 700);
      sgStreak = 0;
    }
    sgMatchSelected = null;
  }

  // ── SPEED ROUND timer ──────────────────────────────────────────
  let sgSpeedTimer   = null;
  let sgSpeedSeconds = 5;

  function sgStartSpeedTimer() {
    clearInterval(sgSpeedTimer);
    sgSpeedSeconds = 5;
    const fill  = document.getElementById('sgSpeedFill');
    const label = document.getElementById('sgSpeedLabel');
    if (!fill || !label) return;
    fill.style.width = '100%';
    fill.style.transition = 'none';
    label.textContent = sgSpeedSeconds;
    setTimeout(() => {
      fill.style.transition = `width ${sgSpeedSeconds}s linear`;
      fill.style.width = '0%';
    }, 50);
    sgSpeedTimer = setInterval(() => {
      sgSpeedSeconds--;
      if (label) label.textContent = Math.max(0, sgSpeedSeconds);
      if (sgSpeedSeconds <= 0) {
        clearInterval(sgSpeedTimer);
        if (!sgAnswered) {
          // Time's up — auto-wrong
          sgAnswered = true;
          sgStreak = 0;
          document.querySelectorAll('.sg-tf-btn').forEach(b => { b.disabled = true; });
          const fb = document.getElementById('sgFeedback');
          const q  = sgQuestions[sgIndex];
          if (fb) fb.innerHTML = `<div class="sg-feedback sg-fb-wrong"><span class="sg-fb-icon">⏰</span><div><div class="sg-fb-title">Time's up!</div>${q.explanation ? `<div class="sg-fb-exp">Correct: <b>${q.answer}</b> — ${q.explanation}</div>` : ''}</div></div>`;
          document.getElementById('sgNextBtn').style.display = 'flex';
        }
      }
    }, 1000);
  }

  // Override sgNext to clear timer in speed mode
  const _origSgNext = window.sgNext;
  window.sgNext = function() {
    clearInterval(sgSpeedTimer);
    _origSgNext();
  };

  // ── ORDERING MODE ──────────────────────────────────────────────
  let sgDragSrc = null;

  function sgInitOrdering() {
    const list = document.getElementById('sgOrderList');
    if (!list) return;
    list.querySelectorAll('.sg-order-item').forEach(item => {
      item.addEventListener('dragstart', e => {
        sgDragSrc = item;
        item.classList.add('sg-order-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('sg-order-dragging');
        list.querySelectorAll('.sg-order-item').forEach(i => i.classList.remove('sg-order-over'));
        sgUpdateOrderNumbers();
      });
      item.addEventListener('dragover', e => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.sg-order-item').forEach(i => i.classList.remove('sg-order-over'));
        item.classList.add('sg-order-over');
      });
      item.addEventListener('drop', e => {
        e.preventDefault();
        if (sgDragSrc && sgDragSrc !== item) {
          const allItems = [...list.querySelectorAll('.sg-order-item')];
          const srcIdx = allItems.indexOf(sgDragSrc);
          const tgtIdx = allItems.indexOf(item);
          if (srcIdx < tgtIdx) item.after(sgDragSrc);
          else item.before(sgDragSrc);
          sgUpdateOrderNumbers();
        }
        item.classList.remove('sg-order-over');
      });
      // Touch support: tap to select, tap another to swap
      item.addEventListener('click', () => {
        if (sgAnswered) return;
        if (sgDragSrc && sgDragSrc !== item) {
          const list2 = document.getElementById('sgOrderList');
          const allItems = [...list2.querySelectorAll('.sg-order-item')];
          const srcIdx = allItems.indexOf(sgDragSrc);
          const tgtIdx = allItems.indexOf(item);
          if (srcIdx < tgtIdx) item.after(sgDragSrc);
          else item.before(sgDragSrc);
          sgDragSrc.classList.remove('sg-order-selected');
          sgDragSrc = null;
          sgUpdateOrderNumbers();
        } else if (sgDragSrc === item) {
          item.classList.remove('sg-order-selected');
          sgDragSrc = null;
        } else {
          list.querySelectorAll('.sg-order-item').forEach(i => i.classList.remove('sg-order-selected'));
          item.classList.add('sg-order-selected');
          sgDragSrc = item;
        }
      });
    });
  }

  function sgUpdateOrderNumbers() {
    const list = document.getElementById('sgOrderList');
    if (!list) return;
    list.querySelectorAll('.sg-order-item').forEach((item, i) => {
      const numEl = item.querySelector('.sg-order-num');
      if (numEl) numEl.textContent = i + 1;
    });
  }

  window.sgCheckOrder = function() {
    if (sgAnswered) return;
    const list = document.getElementById('sgOrderList');
    if (!list) return;
    const q = sgQuestions[sgIndex];
    const userOrder = [...list.querySelectorAll('.sg-order-item')].map(el => decodeURIComponent(el.dataset.item));
    // Build correct sequence from q.order (indices into q.items for sorted order)
    const correctSeq = q.order.map(i => q.items[i - 1]);
    const correct = userOrder.every((item, i) => item === correctSeq[i]);
    sgAnswered = true;
    // Color items
    list.querySelectorAll('.sg-order-item').forEach((el, i) => {
      el.style.borderColor = (userOrder[i] === correctSeq[i]) ? '#34d399' : 'var(--crimson-bright,#ec2d5a)';
    });
    if (correct) {
      sgScore++; sgStreak++; if (sgStreak > sgBestStreak) sgBestStreak = sgStreak;
    } else {
      sgStreak = 0;
      // Show correct order
      const corrDiv = document.createElement('div');
      corrDiv.className = 'sg-fib-correct-ans';
      corrDiv.style.cssText = 'margin-top:8px;font-size:12px';
      corrDiv.innerHTML = '<b>Correct order:</b><br>' + correctSeq.map((s,i) => `${i+1}. ${s}`).join('<br>');
      list.after(corrDiv);
    }
    handleResult(correct, q.explanation);
  };

  function handleResult(correct, explanation) {
    if (correct) {
      sgScore++;
      sgStreak++;
      if (sgStreak > sgBestStreak) sgBestStreak = sgStreak;
    } else {
      sgStreak = 0;
    }
    // Feedback box
    const fb = document.getElementById('sgFeedback');
    if (fb) {
      fb.innerHTML = `
        <div class="sg-feedback ${correct ? 'sg-fb-correct' : 'sg-fb-wrong'}">
          <span class="sg-fb-icon">${correct ? '🎉' : '💡'}</span>
          <div>
            <div class="sg-fb-title">${correct ? (sgStreak >= 3 ? `🔥 ${sgStreak} in a row!` : 'Correct!') : 'Not quite…'}</div>
            ${explanation ? `<div class="sg-fb-exp">${explanation}</div>` : ''}
          </div>
        </div>`;
    }
    document.getElementById('sgNextBtn').style.display = 'flex';
  }

  // ── Next / Results ─────────────────────────────────────────────
  window.sgNext = function() {
    sgIndex++;
    if (sgIndex < sgQuestions.length) {
      renderQuestion();
    } else {
      showResults();
    }
  };

  function showResults() {
    const body  = document.getElementById('sgBody');
    const total = sgQuestions.length;
    const pct   = Math.round((sgScore / total) * 100);
    const prev  = getHighScore(sgFileName);
    const isNew = pct > prev;
    if (isNew) saveHighScore(sgFileName, pct);

    const grade = pct >= 90 ? { label:'S', color:'#fbbf24', emoji:'🌟' }
                : pct >= 75 ? { label:'A', color:'#34d399', emoji:'🎉' }
                : pct >= 60 ? { label:'B', color:'#60a5fa', emoji:'👍' }
                : pct >= 40 ? { label:'C', color:'#a855f7', emoji:'📖' }
                :             { label:'D', color:'#ec2d5a', emoji:'💪' };

    body.innerHTML = `
      <div class="sg-results">
        <div class="sg-results-grade" style="color:${grade.color};border-color:${grade.color}40;box-shadow:0 0 40px ${grade.color}30">${grade.label}</div>
        <div class="sg-results-score">${sgScore} / ${total}</div>
        <div class="sg-results-pct">${pct}%</div>
        <div class="sg-results-msg">${grade.emoji} ${
          pct >= 90 ? 'Outstanding! You mastered this material.' :
          pct >= 75 ? 'Great work! Almost perfect.' :
          pct >= 60 ? 'Good effort! Review a few more sections.' :
          pct >= 40 ? 'Keep studying — you\'re getting there.' :
                      'More practice needed. You\'ve got this!'
        }</div>

        <div class="sg-results-stats">
          <div class="sg-rstat">
            <div class="sg-rstat-val">${sgScore}</div>
            <div class="sg-rstat-lbl">Correct</div>
          </div>
          <div class="sg-rstat">
            <div class="sg-rstat-val">${total - sgScore}</div>
            <div class="sg-rstat-lbl">Wrong</div>
          </div>
          <div class="sg-rstat">
            <div class="sg-rstat-val">${sgBestStreak}</div>
            <div class="sg-rstat-lbl">Best Streak</div>
          </div>
        </div>

        ${isNew ? `<div class="sg-new-hs">🏆 New High Score!</div>` : prev > 0 ? `<div class="sg-prev-hs">Previous best: ${prev}%</div>` : ''}

        <div class="sg-results-btns">
          <button class="sg-start-btn" onclick="sgRetry()" style="flex:1">↺ RETRY SAME FILE</button>
          <button class="sg-start-btn" onclick="sgNewFile()" style="flex:1;background:var(--violet-dim);border-color:var(--border);color:var(--violet-bright);box-shadow:none;">+ NEW FILE</button>
        </div>
      </div>`;

    // confetti burst if pct >= 75
    if (pct >= 75) spawnConfetti();
  }

  window.sgRetry = function() {
    sgIndex = 0; sgScore = 0; sgStreak = 0; sgBestStreak = 0; sgAnswered = false;
    clearInterval(sgSpeedTimer); sgMatchPairs = {}; sgMatchSelected = null; sgDragSrc = null;
    renderQuestion();
  };

  window.sgNewFile = function() {
    sgQuestions = []; sgIndex = 0; sgScore = 0; sgStreak = 0;
    sgAnswered = false; sgFileText = ''; sgFileName = '';
    document.getElementById('sgBody').innerHTML = buildLandingBodyHTML();
    setTimeout(bindFileEvents, 50);
  };

  function buildLandingBodyHTML() {
    return document.getElementById('sgPanel').querySelector('.sg-body')?.innerHTML || '';
  }

  // ── High score storage ─────────────────────────────────────────
  function getHighScore(fname) {
    try { return parseInt(JSON.parse(localStorage.getItem('luna-sg-hs') || '{}')[fname] || '0', 10); } catch { return 0; }
  }
  function saveHighScore(fname, pct) {
    try {
      const obj = JSON.parse(localStorage.getItem('luna-sg-hs') || '{}');
      obj[fname] = pct;
      localStorage.setItem('luna-sg-hs', JSON.stringify(obj));
    } catch {}
  }

  // ── Confetti ───────────────────────────────────────────────────
  function spawnConfetti() {
    const colors = ['#ec2d5a','#a855f7','#22d3ee','#fbbf24','#34d399','#60a5fa'];
    const panel  = document.getElementById('sgPanel');
    if (!panel) return;
    for (let i = 0; i < 48; i++) {
      const c = document.createElement('div');
      c.style.cssText = `
        position:absolute;pointer-events:none;z-index:99;
        width:${6 + Math.random()*6}px;height:${6 + Math.random()*6}px;
        border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
        background:${colors[Math.floor(Math.random()*colors.length)]};
        left:${10 + Math.random()*80}%;top:${10 + Math.random()*30}%;
        --dx:${(Math.random()-0.5)*180}px;
        --dy:${60 + Math.random()*200}px;
        --rot:${Math.random()*720}deg;
        animation:sgConfetti ${0.8 + Math.random()*0.9}s ease-out ${Math.random()*0.4}s forwards;
      `;
      panel.appendChild(c);
      c.addEventListener('animationend', () => c.remove());
    }
  }

  // ── Bind file events after DOM ready ──────────────────────────
  const _orig_openStudyGame = window.openStudyGame;
  window.openStudyGame = function() {
    _orig_openStudyGame();
    setTimeout(bindFileEvents, 80);
  };

  // ── Styles ────────────────────────────────────────────────────
  function injectStudyGameStyles() {
    if (document.getElementById('sgStyles')) return;
    const s = document.createElement('style');
    s.id = 'sgStyles';
    s.textContent = `
      /* ── Overlay & Panel ── */
      .sg-overlay {
        position:fixed;inset:0;z-index:9500;
        background:rgba(2,2,9,0.88);
        backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
        display:flex;align-items:center;justify-content:center;
        padding:16px;animation:sgFadeIn 0.22s ease both;
      }
      @keyframes sgFadeIn { from{opacity:0} to{opacity:1} }

      .sg-panel {
        position:relative;width:100%;max-width:540px;
        max-height:calc(var(--real-vh,100vh) - 32px);
        background:linear-gradient(165deg,#0e0e2c 0%,#07071a 55%,#0c0c26 100%);
        border:1px solid rgba(168,85,247,0.25);border-radius:22px;
        display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 32px 80px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.05) inset;
        animation:sgPanelIn 0.38s cubic-bezier(0.34,1.46,0.64,1) both;
      }
      @keyframes sgPanelIn {
        from{transform:scale(0.88) translateY(22px);opacity:0}
        to{transform:scale(1) translateY(0);opacity:1}
      }

      /* ── Header ── */
      .sg-header {
        display:flex;align-items:center;justify-content:space-between;
        padding:16px 20px 14px;border-bottom:1px solid rgba(168,85,247,0.15);
        background:rgba(168,85,247,0.05);flex-shrink:0;
      }
      .sg-header-left { display:flex;align-items:center;gap:10px; }
      .sg-badge {
        font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.2em;
        color:var(--violet-bright,#a855f7);background:rgba(168,85,247,0.12);
        border:1px solid rgba(168,85,247,0.3);border-radius:4px;padding:3px 9px;
      }
      .sg-title {
        font-family:var(--font-hud,monospace);font-size:12px;letter-spacing:0.14em;
        color:var(--text-hi,#f0e6ff);
      }
      .sg-close-btn {
        background:rgba(236,45,90,0.12);border:1px solid rgba(236,45,90,0.3);
        border-radius:var(--r-sm,7px);color:var(--crimson-bright,#ec2d5a);
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.1em;
        padding:5px 11px;cursor:pointer;transition:all 0.18s;
      }
      .sg-close-btn:hover{background:rgba(236,45,90,0.25);}

      /* ── Body ── */
      .sg-body {
        flex:1;overflow-y:auto;padding:22px 22px 26px;
        display:flex;flex-direction:column;gap:16px;
        scrollbar-width:thin;scrollbar-color:rgba(168,85,247,0.3) transparent;
      }

      /* ── Hero ── */
      .sg-hero { text-align:center;padding:6px 0 2px; }
      .sg-hero-icon { font-size:40px;margin-bottom:10px; }
      .sg-hero-title {
        font-family:var(--font-hud,monospace);font-size:14px;letter-spacing:0.16em;
        color:var(--text-hi,#f0e6ff);margin-bottom:6px;
      }
      .sg-hero-sub { font-size:12.5px;color:var(--text-mid,#9580b5);line-height:1.6; }

      /* ── Upload zone ── */
      .sg-upload-zone {
        border:2px dashed rgba(168,85,247,0.3);border-radius:14px;
        padding:24px 16px;text-align:center;cursor:pointer;
        transition:all 0.22s;background:rgba(168,85,247,0.03);
      }
      .sg-upload-zone:hover,.sg-dz-hover {
        border-color:var(--violet-bright,#a855f7);
        background:rgba(168,85,247,0.07);
      }
      .sg-upload-icon { font-size:28px;margin-bottom:8px;color:var(--violet-bright,#a855f7); }
      .sg-upload-label { font-size:13px;color:var(--text-mid,#9580b5);margin-bottom:5px; }
      .sg-upload-link {
        color:var(--violet-bright,#a855f7);cursor:pointer;text-decoration:underline;
      }
      .sg-upload-types {
        font-family:var(--font-hud,monospace);font-size:8.5px;letter-spacing:0.1em;
        color:var(--text-lo,#3d3060);
      }

      /* ── Number of items row ── */
      .sg-nitems-row { display:flex;gap:8px;flex-wrap:wrap; }
      .sg-nitem-btn {
        flex:1;min-width:36px;padding:8px 10px;
        background:var(--card,#090920);
        border:1.5px solid var(--border,rgba(168,85,247,0.2));border-radius:9px;
        color:var(--text-mid,#9580b5);font-family:var(--font-hud,monospace);font-size:11px;
        letter-spacing:0.08em;cursor:pointer;transition:all 0.18s;
      }
      .sg-nitem-btn:hover{border-color:rgba(168,85,247,0.5);color:var(--text-hi,#f0e6ff);}
      .sg-nitem-active{border-color:var(--violet-bright,#a855f7)!important;color:var(--violet-bright,#a855f7)!important;background:rgba(168,85,247,0.1)!important;}
      .sg-nitem-custom{min-width:36px;max-width:44px;flex:0 0 44px;font-size:14px;}

      /* ── File badge ── */
      .sg-file-badge {
        display:flex;align-items:center;gap:10px;
        background:rgba(52,211,153,0.07);border:1px solid rgba(52,211,153,0.25);
        border-radius:10px;padding:10px 14px;
        font-size:13px;color:var(--text-hi,#f0e6ff);
      }
      .sg-file-remove {
        margin-left:auto;background:none;border:none;color:var(--text-lo,#3d3060);
        cursor:pointer;font-size:14px;transition:color 0.15s;
      }
      .sg-file-remove:hover{color:var(--crimson-bright,#ec2d5a);}

      /* ── Section label ── */
      .sg-section-label {
        font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.22em;
        color:var(--text-lo,#3d3060);margin-bottom:-6px;
      }

      /* ── Mode selector ── */
      .sg-mode-row { display:flex;gap:8px; }
      .sg-mode-btn {
        flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;
        padding:12px 6px;background:var(--card,#090920);
        border:1.5px solid var(--border,rgba(168,85,247,0.2));border-radius:12px;
        cursor:pointer;transition:all 0.22s;color:var(--text-lo,#3d3060);
      }
      .sg-mode-btn:hover{border-color:rgba(168,85,247,0.45);color:var(--text-mid,#9580b5);}
      .sg-mode-active {
        border-color:var(--violet-bright,#a855f7)!important;
        background:rgba(168,85,247,0.1)!important;
        color:var(--text-hi,#f0e6ff)!important;
        box-shadow:0 0 16px rgba(168,85,247,0.18);
      }
      .sg-mode-icon { font-size:20px; }
      .sg-mode-name { font-family:var(--font-hud,monospace);font-size:8px;letter-spacing:0.1em;text-align:center;line-height:1.5; }

      /* ── Difficulty ── */
      .sg-diff-row { display:flex;gap:7px; }
      .sg-diff-btn {
        flex:1;padding:8px;background:var(--card,#090920);
        border:1px solid var(--border,rgba(168,85,247,0.2));border-radius:8px;
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.12em;
        color:var(--text-lo,#3d3060);cursor:pointer;transition:all 0.18s;
      }
      .sg-diff-btn:hover{border-color:rgba(168,85,247,0.4);color:var(--text-mid,#9580b5);}
      .sg-diff-active {
        border-color:var(--crimson-bright,#ec2d5a)!important;
        color:var(--crimson-bright,#ec2d5a)!important;
        background:rgba(236,45,90,0.09)!important;
      }

      /* ── Start btn ── */
      .sg-start-btn {
        display:flex;align-items:center;justify-content:center;gap:8px;
        padding:13px;border-radius:12px;
        background:linear-gradient(135deg,var(--crimson,#c41e3a),var(--violet,#7928ca));
        border:none;color:#fff;font-family:var(--font-hud,monospace);
        font-size:10px;letter-spacing:0.22em;cursor:pointer;
        box-shadow:0 4px 22px rgba(196,30,58,0.35);transition:all 0.22s;
      }
      .sg-start-btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 30px rgba(196,30,58,0.5);}
      .sg-start-btn:disabled{opacity:0.3;cursor:not-allowed;transform:none;box-shadow:none;}

      /* ── High score strip ── */
      .sg-hs-strip {
        display:flex;align-items:center;gap:8px;justify-content:center;
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.14em;
        color:var(--gold,#fbbf24);
      }

      /* ── Loading ── */
      .sg-loading {
        display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:16px;min-height:200px;text-align:center;
      }
      .sg-spinner {
        width:40px;height:40px;border-radius:50%;
        border:3px solid rgba(168,85,247,0.15);
        border-top-color:var(--violet-bright,#a855f7);
        animation:sgSpin 0.9s linear infinite;
      }
      @keyframes sgSpin{to{transform:rotate(360deg)}}
      .sg-loading-text {
        font-family:var(--font-hud,monospace);font-size:10px;letter-spacing:0.14em;
        color:var(--text-mid,#9580b5);max-width:260px;line-height:1.7;
      }

      /* ── Progress ── */
      .sg-progress-wrap { display:flex;flex-direction:column;gap:7px;flex-shrink:0; }
      .sg-progress-bar {
        height:5px;background:rgba(255,255,255,0.06);border-radius:5px;overflow:hidden;
      }
      .sg-progress-fill {
        height:100%;border-radius:5px;
        background:linear-gradient(90deg,var(--crimson-bright,#ec2d5a),var(--violet-bright,#a855f7));
        transition:width 0.5s cubic-bezier(0.4,0,0.2,1);
        box-shadow:0 0 8px rgba(168,85,247,0.5);
      }
      .sg-progress-labels {
        display:flex;align-items:center;gap:8px;
      }
      .sg-q-counter {
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.12em;
        color:var(--text-lo,#3d3060);
      }
      .sg-score-pill {
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.1em;
        color:var(--violet-bright,#a855f7);margin-left:auto;
      }
      .sg-streak-pill {
        font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.1em;
        color:var(--gold,#fbbf24);
        background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);
        border-radius:20px;padding:2px 8px;
      }

      /* ── Question card ── */
      .sg-q-card {
        background:rgba(255,255,255,0.025);border:1px solid rgba(168,85,247,0.18);
        border-radius:14px;padding:16px 18px;
      }
      .sg-q-mode-tag {
        font-family:var(--font-hud,monospace);font-size:7.5px;letter-spacing:0.18em;
        color:var(--violet-bright,#a855f7);margin-bottom:9px;opacity:0.7;
      }
      .sg-q-text {
        font-size:14.5px;color:var(--text-hi,#f0e6ff);line-height:1.65;font-weight:500;
      }

      /* ── MC Options ── */
      .sg-options { display:flex;flex-direction:column;gap:8px; }
      .sg-opt-btn {
        display:flex;align-items:center;gap:12px;
        padding:11px 14px;background:var(--card,#090920);
        border:1.5px solid var(--border,rgba(168,85,247,0.2));border-radius:10px;
        cursor:pointer;text-align:left;transition:all 0.18s;color:var(--text-hi,#f0e6ff);
      }
      .sg-opt-btn:hover:not(:disabled){
        border-color:rgba(168,85,247,0.55);background:rgba(168,85,247,0.07);
      }
      .sg-opt-btn:disabled{cursor:default;}
      .sg-opt-label {
        font-family:var(--font-hud,monospace);font-size:9px;font-weight:700;
        width:22px;height:22px;border-radius:50%;flex-shrink:0;
        background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);
        display:flex;align-items:center;justify-content:center;
        color:var(--violet-bright,#a855f7);
      }
      .sg-opt-text { font-size:13px;line-height:1.45;color:var(--text-hi,#f0e6ff); }
      .sg-opt-correct {
        border-color:#34d399!important;background:rgba(52,211,153,0.1)!important;
      }
      .sg-opt-correct .sg-opt-label {
        background:#34d399!important;border-color:#34d399!important;color:#000!important;
      }
      .sg-opt-wrong {
        border-color:var(--crimson-bright,#ec2d5a)!important;
        background:rgba(236,45,90,0.1)!important;
      }
      .sg-opt-wrong .sg-opt-label {
        background:var(--crimson-bright,#ec2d5a)!important;
        border-color:var(--crimson-bright,#ec2d5a)!important;color:#fff!important;
      }

      /* ── True / False ── */
      .sg-tf-row { display:flex;gap:10px; }
      .sg-tf-btn {
        flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;
        padding:16px;background:var(--card,#090920);
        border:1.5px solid var(--border,rgba(168,85,247,0.2));border-radius:12px;
        cursor:pointer;font-family:var(--font-hud,monospace);font-size:10px;
        letter-spacing:0.14em;color:var(--text-mid,#9580b5);transition:all 0.18s;
      }
      .sg-tf-true:hover:not(:disabled){border-color:#34d399;color:#34d399;background:rgba(52,211,153,0.05);}
      .sg-tf-false:hover:not(:disabled){border-color:var(--crimson-bright,#ec2d5a);color:var(--crimson-bright,#ec2d5a);background:rgba(236,45,90,0.05);}
      .sg-tf-btn:disabled{cursor:default;}
      .sg-tf-selected-correct{border-color:#34d399!important;background:rgba(52,211,153,0.12)!important;color:#34d399!important;}
      .sg-tf-selected-wrong{border-color:var(--crimson-bright,#ec2d5a)!important;background:rgba(236,45,90,0.1)!important;color:var(--crimson-bright,#ec2d5a)!important;}

      /* ── Fill in blank ── */
      .sg-fib-wrap { display:flex;flex-direction:column;gap:10px; }
      .sg-fib-hint {
        font-size:12px;color:var(--text-mid,#9580b5);
        background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);
        border-radius:8px;padding:8px 12px;line-height:1.5;
      }
      .sg-fib-input-row { display:flex;gap:8px; }
      .sg-fib-input {
        flex:1;background:var(--input-bg,#0b0b22);border:1.5px solid var(--border,rgba(168,85,247,0.2));
        border-radius:10px;padding:11px 14px;color:var(--text-hi,#f0e6ff);
        font-family:var(--font-body,sans-serif);font-size:14px;outline:none;transition:border-color 0.2s;
      }
      .sg-fib-input:focus{border-color:var(--violet-bright,#a855f7);}
      .sg-fib-input:disabled{opacity:0.7;}
      .sg-fib-submit {
        padding:11px 16px;background:rgba(168,85,247,0.15);
        border:1px solid rgba(168,85,247,0.35);border-radius:10px;
        color:var(--violet-bright,#a855f7);font-family:var(--font-hud,monospace);
        font-size:9px;letter-spacing:0.14em;cursor:pointer;transition:all 0.18s;flex-shrink:0;
      }
      .sg-fib-submit:hover:not(:disabled){background:rgba(168,85,247,0.25);}
      .sg-fib-submit:disabled{opacity:0.4;cursor:default;}
      .sg-fib-correct-ans {
        font-size:12.5px;color:#34d399;
        background:rgba(52,211,153,0.07);border:1px solid rgba(52,211,153,0.2);
        border-radius:8px;padding:8px 12px;
      }

      /* ── Feedback ── */
      .sg-feedback {
        display:flex;align-items:flex-start;gap:12px;
        padding:13px 15px;border-radius:12px;
        animation:sgFeedIn 0.28s cubic-bezier(0.34,1.56,0.64,1) both;
      }
      @keyframes sgFeedIn{from{opacity:0;transform:translateY(10px) scale(0.97)}to{opacity:1;transform:none}}
      .sg-fb-correct{background:rgba(52,211,153,0.09);border:1px solid rgba(52,211,153,0.28);}
      .sg-fb-wrong{background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.25);}
      .sg-fb-icon { font-size:20px;flex-shrink:0;margin-top:1px; }
      .sg-fb-title {
        font-family:var(--font-hud,monospace);font-size:10px;letter-spacing:0.14em;
        margin-bottom:4px;
      }
      .sg-fb-correct .sg-fb-title{color:#34d399;}
      .sg-fb-wrong .sg-fb-title{color:var(--crimson-bright,#ec2d5a);}
      .sg-fb-exp { font-size:12px;color:var(--text-mid,#9580b5);line-height:1.6; }

      /* ── Next button ── */
      .sg-next-btn {
        display:flex;align-items:center;justify-content:center;gap:8px;
        padding:12px;border-radius:12px;
        background:linear-gradient(135deg,rgba(168,85,247,0.25),rgba(236,45,90,0.18));
        border:1px solid rgba(168,85,247,0.4);color:var(--text-hi,#f0e6ff);
        font-family:var(--font-hud,monospace);font-size:9.5px;letter-spacing:0.18em;
        cursor:pointer;transition:all 0.2s;
        animation:sgFeedIn 0.3s ease both;
      }
      .sg-next-btn:hover{background:linear-gradient(135deg,rgba(168,85,247,0.35),rgba(236,45,90,0.26));border-color:var(--violet-bright,#a855f7);}

      /* ── Results ── */
      .sg-results{display:flex;flex-direction:column;align-items:center;gap:14px;padding:8px 0 4px;text-align:center;}
      .sg-results-grade {
        width:80px;height:80px;border-radius:50%;border:3px solid;
        display:flex;align-items:center;justify-content:center;
        font-family:var(--font-hud,monospace);font-size:32px;font-weight:900;
        animation:sgGradePop 0.5s cubic-bezier(0.34,1.56,0.64,1) both;
      }
      @keyframes sgGradePop{from{transform:scale(0.3) rotate(-30deg);opacity:0}to{transform:scale(1) rotate(0);opacity:1}}
      .sg-results-score {
        font-family:var(--font-hud,monospace);font-size:28px;font-weight:900;
        color:var(--text-hi,#f0e6ff);line-height:1;
      }
      .sg-results-pct {
        font-family:var(--font-hud,monospace);font-size:14px;letter-spacing:0.14em;
        color:var(--text-mid,#9580b5);margin-top:-8px;
      }
      .sg-results-msg { font-size:13.5px;color:var(--text-mid,#9580b5);line-height:1.6;max-width:320px; }
      .sg-results-stats {
        display:flex;gap:12px;width:100%;
      }
      .sg-rstat {
        flex:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
        border-radius:10px;padding:10px 8px;
      }
      .sg-rstat-val{font-family:var(--font-hud,monospace);font-size:20px;font-weight:900;color:var(--violet-bright,#a855f7);}
      .sg-rstat-lbl{font-family:var(--font-hud,monospace);font-size:7.5px;letter-spacing:0.14em;color:var(--text-lo,#3d3060);margin-top:4px;}
      .sg-new-hs{font-family:var(--font-hud,monospace);font-size:10px;letter-spacing:0.18em;color:var(--gold,#fbbf24);background:rgba(251,191,36,0.09);border:1px solid rgba(251,191,36,0.25);border-radius:20px;padding:5px 16px;}
      .sg-prev-hs{font-family:var(--font-hud,monospace);font-size:9px;letter-spacing:0.1em;color:var(--text-lo,#3d3060);}
      .sg-results-btns{display:flex;gap:10px;width:100%;}

      /* ── Confetti ── */
      @keyframes sgConfetti {
        0%{opacity:1;transform:translate(0,0) rotate(0deg) scale(1)}
        100%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(0.4)}
      }

      /* ── Matching Mode ── */
      .sg-match-grid {
        display:grid;grid-template-columns:1fr 1fr;gap:10px;
      }
      .sg-match-col { display:flex;flex-direction:column;gap:8px; }
      .sg-match-term, .sg-match-def {
        padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.4;
        border:1.5px solid var(--border,rgba(168,85,247,0.2));
        background:var(--card,#090920);color:var(--text-hi,#f0e6ff);
        cursor:pointer;transition:all 0.18s;user-select:none;
      }
      .sg-match-term { border-left:3px solid var(--violet-bright,#a855f7); }
      .sg-match-def  { border-left:3px solid rgba(168,85,247,0.3); }
      .sg-match-term:hover:not([data-matched]):not(.sg-match-correct),
      .sg-match-def:hover:not([data-matched]):not(.sg-match-correct) {
        border-color:var(--violet-bright,#a855f7);background:rgba(168,85,247,0.07);
      }
      .sg-match-sel  { border-color:var(--gold,#fbbf24)!important;background:rgba(251,191,36,0.08)!important;box-shadow:0 0 0 2px rgba(251,191,36,0.2); }
      .sg-match-correct { border-color:#34d399!important;background:rgba(52,211,153,0.08)!important;color:#34d399!important;cursor:default; }
      .sg-match-wrong { border-color:var(--crimson-bright,#ec2d5a)!important;background:rgba(236,45,90,0.08)!important; }

      /* ── Speed Round Timer ── */
      .sg-speed-timer-wrap {
        display:flex;align-items:center;gap:10px;
      }
      .sg-speed-timer-bar {
        flex:1;height:8px;border-radius:99px;background:rgba(255,255,255,0.06);
        overflow:hidden;
      }
      .sg-speed-timer-fill {
        height:100%;width:100%;border-radius:99px;
        background:linear-gradient(90deg,#34d399,#22d3ee);
      }
      .sg-speed-timer-label {
        font-family:var(--font-hud,monospace);font-size:16px;font-weight:900;
        color:var(--text-hi,#f0e6ff);min-width:20px;text-align:right;
      }

      /* ── Ordering Mode ── */
      .sg-order-list { display:flex;flex-direction:column;gap:8px; }
      .sg-order-item {
        display:flex;align-items:center;gap:10px;
        padding:11px 14px;border-radius:11px;
        border:1.5px solid var(--border,rgba(168,85,247,0.2));
        background:var(--card,#090920);color:var(--text-hi,#f0e6ff);
        cursor:grab;transition:all 0.18s;user-select:none;
      }
      .sg-order-item:hover { border-color:rgba(168,85,247,0.45);background:rgba(168,85,247,0.05); }
      .sg-order-dragging { opacity:0.45;border-color:var(--violet-bright,#a855f7)!important; }
      .sg-order-over { border-color:var(--gold,#fbbf24)!important;background:rgba(251,191,36,0.06)!important; }
      .sg-order-selected { border-color:var(--gold,#fbbf24)!important;background:rgba(251,191,36,0.08)!important;box-shadow:0 0 0 2px rgba(251,191,36,0.2); }
      .sg-order-handle { font-size:16px;color:var(--text-lo,#3d3060);cursor:grab;flex-shrink:0; }
      .sg-order-num {
        font-family:var(--font-hud,monospace);font-size:10px;font-weight:700;
        width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);
        color:var(--violet-bright,#a855f7);flex-shrink:0;
      }
      .sg-order-text { font-size:13px;line-height:1.45;flex:1; }

      /* ── Mobile ── */
      @media (max-width:600px){
        .sg-panel{border-radius:18px 18px 0 0;position:fixed;bottom:0;left:0;right:0;max-width:100%;max-height:92vh;}
        .sg-body{padding:16px 16px 22px;}
        .sg-mode-name{font-size:7.5px;}
        .sg-q-text{font-size:14px;}
        .sg-results-btns{flex-direction:column;}
        .sg-match-term,.sg-match-def{font-size:11px;padding:8px 9px;}
        .sg-mode-row{flex-wrap:wrap;}
        .sg-mode-btn{flex:1 1 calc(33% - 8px);min-width:80px;}
      }
    `;
    document.head.appendChild(s);
  }

})();
// ══════════════════════════════════════════════════════════════════
// ◈ LUNA UI/UX ENHANCEMENTS — Mobile Smoothness & Interaction Polish
//   Added functions for: swipe gestures, haptic feedback manager,
//   scroll-to-bottom FAB, ambient greeting system, message word count,
//   smart input toolbar, pull-to-refresh, focus mode, chat emoji picker,
//   theme-aware status bar, double-tap to react, long-press context menu,
//   typing word counter, and mobile scroll momentum improvements.
// ══════════════════════════════════════════════════════════════════

;(function lunaEnhancements() {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // ◈ 1. HAPTIC FEEDBACK MANAGER
  //   Centralised vibration API wrapper with named patterns so every
  //   touch interaction can call haptic() without duplicating navigator.vibrate.
  // ─────────────────────────────────────────────────────────────────
  const HAPTIC = {
    light:    [8],
    medium:   [18],
    heavy:    [35],
    success:  [10, 40, 10],
    error:    [50, 30, 50],
    double:   [10, 60, 10],
    reaction: [6, 30, 12],
  };

  function haptic(pattern = 'light') {
    if (!navigator.vibrate) return;
    const p = HAPTIC[pattern] || HAPTIC.light;
    try { navigator.vibrate(p); } catch {}
  }

  // Export globally so other code can call it
  window.haptic = haptic;


  // ─────────────────────────────────────────────────────────────────
  // ◈ 2. SCROLL-TO-BOTTOM FLOATING ACTION BUTTON
  //   Appears when user scrolls up in chat feed. Tap flings back to
  //   bottom with a spring animation and badge shows unread count.
  // ─────────────────────────────────────────────────────────────────
  function installScrollFAB() {
    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    const fab = document.createElement('button');
    fab.id = 'scrollFAB';
    fab.title = 'Jump to latest';
    fab.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      <span id="scrollFABBadge"></span>`;

    const style = document.createElement('style');
    style.textContent = `
      #scrollFAB {
        position: fixed;
        bottom: calc(var(--input-zone-h, 72px) + 18px);
        right: 18px;
        z-index: 900;
        width: 44px; height: 44px;
        border-radius: 50%;
        border: 1px solid rgba(168,85,247,0.4);
        background: rgba(6,6,26,0.88);
        backdrop-filter: blur(12px);
        color: var(--violet-bright, #a855f7);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        box-shadow: 0 4px 24px rgba(168,85,247,0.22), 0 1px 4px rgba(0,0,0,0.5);
        opacity: 0; transform: translateY(16px) scale(0.8);
        transition: opacity 0.22s var(--smooth), transform 0.28s var(--spring);
        pointer-events: none;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      #scrollFAB.visible {
        opacity: 1; transform: none;
        pointer-events: auto;
      }
      #scrollFAB:active { transform: scale(0.9); }
      #scrollFABBadge {
        position: absolute; top: -4px; right: -4px;
        background: var(--crimson-bright, #ec2d5a);
        color: #fff; font-family: var(--font-hud, monospace);
        font-size: 8px; font-weight: 700;
        min-width: 16px; height: 16px;
        border-radius: 99px; padding: 0 4px;
        display: flex; align-items: center; justify-content: center;
        display: none;
        border: 1.5px solid var(--void, #020209);
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(fab);

    let unreadSinceFAB = 0;

    fab.addEventListener('click', () => {
      haptic('medium');
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
      unreadSinceFAB = 0;
      const badge = document.getElementById('scrollFABBadge');
      if (badge) badge.style.display = 'none';
    });

    // Observe chat feed scroll position
    let fabVisible = false;
    function updateFAB() {
      const distFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
      const shouldShow = distFromBottom > 120;
      if (shouldShow !== fabVisible) {
        fabVisible = shouldShow;
        fab.classList.toggle('visible', shouldShow);
        if (!shouldShow) { unreadSinceFAB = 0; }
      }
    }
    feed.addEventListener('scroll', updateFAB, { passive: true });

    // Count new messages when FAB is showing
    const feedObserver = new MutationObserver((mutations) => {
      if (!fabVisible) return;
      const added = mutations.reduce((n, m) => n + m.addedNodes.length, 0);
      if (!added) return;
      unreadSinceFAB += added;
      const badge = document.getElementById('scrollFABBadge');
      if (badge && unreadSinceFAB > 0) {
        badge.textContent = unreadSinceFAB > 9 ? '9+' : unreadSinceFAB;
        badge.style.display = 'flex';
      }
    });
    feedObserver.observe(feed, { childList: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 3. SWIPE-DOWN-TO-CLOSE for modals & overlays
  //   Any element with data-swipe-close="true" can be dismissed
  //   with a downward swipe gesture on mobile.
  // ─────────────────────────────────────────────────────────────────
  function attachSwipeClose(el) {
    if (!el || el._swipeInstalled) return;
    el._swipeInstalled = true;

    let startY = 0, currentY = 0, dragging = false;
    const THRESHOLD = 80;

    el.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startY = touch.clientY;
      currentY = touch.clientY;
      dragging = true;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      currentY = e.touches[0].clientY;
      const dy = currentY - startY;
      if (dy > 0) {
        // Rubber-band translate
        const drag = Math.min(dy * 0.55, 140);
        el.style.transform = `translateY(${drag}px)`;
        el.style.opacity = String(1 - drag / 280);
        el.style.transition = 'none';
      }
    }, { passive: true });

    el.addEventListener('touchend', () => {
      dragging = false;
      const dy = currentY - startY;
      if (dy > THRESHOLD) {
        haptic('medium');
        el.style.transition = 'transform 0.28s var(--smooth), opacity 0.28s';
        el.style.transform = 'translateY(100%)';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
      } else {
        el.style.transition = 'transform 0.28s var(--spring), opacity 0.2s';
        el.style.transform = '';
        el.style.opacity = '';
        setTimeout(() => { el.style.transition = ''; }, 320);
      }
    }, { passive: true });
  }

  // Auto-attach swipe-close to any modal created after this script loads
  const _origAppendChild = Element.prototype.appendChild;
  const _modalSelectors  = ['.modal-overlay', '[data-swipe-close]'];
  const _checkSwipe      = (el) => {
    if (el && el.nodeType === 1) {
      if (_modalSelectors.some(s => el.matches && el.matches(s))) {
        attachSwipeClose(el);
      }
    }
  };

  // Patch document.body.appendChild to catch injected modals
  const bodyObs = new MutationObserver(muts => {
    muts.forEach(m => m.addedNodes.forEach(n => _checkSwipe(n)));
  });
  document.addEventListener('DOMContentLoaded', () => {
    bodyObs.observe(document.body, { childList: true });
    // Attach to any modals already in the DOM
    document.querySelectorAll('.modal-overlay').forEach(attachSwipeClose);
  });


  // ─────────────────────────────────────────────────────────────────
  // ◈ 4. DOUBLE-TAP-TO-REACT on Luna messages
  //   Double-tap a Luna bubble adds a ❤️ reaction with a micro
  //   heart burst animation — familiar from social media.
  // ─────────────────────────────────────────────────────────────────
  function installDoubleTapReact() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes lunaHeartBurst {
        0%  { transform: scale(0) rotate(-15deg); opacity: 1; }
        55% { transform: scale(1.35) rotate(8deg); opacity: 1; }
        100%{ transform: scale(1) rotate(0); opacity: 0; }
      }
      .luna-heart-burst {
        position: absolute; pointer-events: none; z-index: 9999;
        font-size: 36px; user-select: none;
        animation: lunaHeartBurst 0.7s cubic-bezier(0.34,1.56,0.64,1) forwards;
      }
    `;
    document.head.appendChild(style);

    let lastTap = 0;

    document.getElementById('chatFeed')?.addEventListener('touchend', (e) => {
      const bubble = e.target.closest('.message.luna .bubble');
      if (!bubble) return;

      const now = Date.now();
      const gap = now - lastTap;
      lastTap = now;
      if (gap > 350 || gap < 40) return; // not a double-tap

      haptic('reaction');

      // Burst heart at tap position
      const touch = e.changedTouches[0];
      const heart = document.createElement('span');
      heart.className = 'luna-heart-burst';
      heart.textContent = '❤️';
      heart.style.left = (touch.clientX - 18) + 'px';
      heart.style.top  = (touch.clientY - 18) + 'px';
      document.body.appendChild(heart);
      heart.addEventListener('animationend', () => heart.remove(), { once: true });

      // Also activate the ❤️ reaction pill if present
      const msgWrap = bubble.closest('.message');
      const msgId   = msgWrap?.dataset?.msgId;
      if (msgId) {
        const pill = bubble.querySelector('.reaction-pill:nth-child(2)'); // ❤️ pill
        if (pill && !pill.classList.contains('active')) {
          pill.click(); // triggers existing toggleReaction
        }
      }
    }, { passive: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 5. LONG-PRESS CONTEXT MENU for messages
  //   Long-press any bubble to get a radial quick-action menu
  //   with Copy, Reply, TTS, Pin and Share options.
  // ─────────────────────────────────────────────────────────────────
  function installLongPressMenu() {
    const style = document.createElement('style');
    style.textContent = `
      #lunaCtxMenu {
        position: fixed; z-index: 99998;
        background: rgba(6,6,26,0.96);
        border: 1px solid rgba(168,85,247,0.3);
        border-radius: 14px;
        padding: 6px;
        display: flex; flex-direction: column; gap: 2px;
        min-width: 168px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(168,85,247,0.1);
        backdrop-filter: blur(16px);
        animation: ctxFadeIn 0.18s var(--spring) both;
        touch-action: none;
      }
      @keyframes ctxFadeIn {
        from { opacity:0; transform: scale(0.85) translateY(6px); }
        to   { opacity:1; transform: none; }
      }
      .luna-ctx-item {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 12px; border-radius: 9px;
        font-family: var(--font-body, sans-serif);
        font-size: 13px; color: var(--text-hi, #f0e6ff);
        cursor: pointer; transition: background 0.12s;
        -webkit-tap-highlight-color: transparent;
        user-select: none;
      }
      .luna-ctx-item:hover, .luna-ctx-item:active {
        background: rgba(168,85,247,0.12);
      }
      .luna-ctx-icon {
        font-size: 16px; width: 22px; text-align: center; flex-shrink: 0;
      }
      #lunaCtxMenu.closing {
        animation: ctxFadeOut 0.15s ease forwards;
      }
      @keyframes ctxFadeOut {
        to { opacity:0; transform: scale(0.9) translateY(4px); }
      }
    `;
    document.head.appendChild(style);

    let pressTimer = null;
    let activeMenu = null;

    function closeCtxMenu() {
      if (!activeMenu) return;
      activeMenu.classList.add('closing');
      activeMenu.addEventListener('animationend', () => activeMenu?.remove(), { once: true });
      activeMenu = null;
    }

    function openCtxMenu(bubble, x, y) {
      closeCtxMenu();

      const msgWrap = bubble.closest('.message');
      const msgId   = msgWrap?.dataset?.msgId || '';
      const text    = bubble.querySelector('.bubble-text')?.innerText || '';
      const isLuna  = msgWrap?.classList.contains('luna');

      const actions = [
        { icon: '📋', label: 'Copy',       fn: () => { if (window.copyToClipboard) copyToClipboard(text, null); } },
        { icon: '↩',  label: 'Reply',      fn: () => { if (window.setReplyContext && msgId) setReplyContext(msgId, text); } },
        ...(isLuna ? [
          { icon: '🔊', label: 'Read Aloud', fn: () => { if (window.toggleTTS) { const btn = msgWrap.querySelector('.tts-btn'); toggleTTS(text, btn); } } },
          { icon: '📌', label: 'Pin',        fn: () => { if (window.togglePin) { const btn = msgWrap.querySelector('[title="Pin message"]'); togglePin(msgId, text, btn || document.createElement('button')); } } },
          { icon: '🔄', label: 'Regenerate', fn: () => { if (window.regenerateResponse) regenerateResponse(); } },
        ] : []),
        { icon: '🔗', label: 'Share',      fn: () => {
          if (navigator.share) {
            navigator.share({ title: 'Luna AI', text }).catch(() => {});
          } else if (window.copyToClipboard) {
            copyToClipboard(text, null);
          }
        }},
      ];

      const menu = document.createElement('div');
      menu.id = 'lunaCtxMenu';
      actions.forEach(({ icon, label, fn }) => {
        const item = document.createElement('div');
        item.className = 'luna-ctx-item';
        item.innerHTML = `<span class="luna-ctx-icon">${icon}</span><span>${label}</span>`;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          haptic('light');
          fn();
          closeCtxMenu();
        });
        menu.appendChild(item);
      });

      document.body.appendChild(menu);
      activeMenu = menu;

      // Position: clamp to viewport
      const mW = 180, mH = actions.length * 42 + 12;
      const clampX = Math.min(x, window.innerWidth  - mW - 10);
      const clampY = Math.min(y, window.innerHeight - mH - 10);
      menu.style.left = Math.max(8, clampX) + 'px';
      menu.style.top  = Math.max(8, clampY) + 'px';

      // Close on outside tap
      setTimeout(() => {
        document.addEventListener('touchstart', closeCtxMenu, { once: true, passive: true });
        document.addEventListener('mousedown',  closeCtxMenu, { once: true });
      }, 80);
    }

    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    feed.addEventListener('touchstart', (e) => {
      const bubble = e.target.closest('.bubble');
      if (!bubble) return;
      const touch = e.touches[0];
      pressTimer = setTimeout(() => {
        haptic('heavy');
        openCtxMenu(bubble, touch.clientX, touch.clientY - 60);
      }, 550);
    }, { passive: true });

    feed.addEventListener('touchend',  () => clearTimeout(pressTimer), { passive: true });
    feed.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 6. INPUT WORD COUNTER & CHARACTER LIMIT INDICATOR
  //   Shows a live character/word counter below the input as the
  //   user types, and turns red when approaching the limit.
  // ─────────────────────────────────────────────────────────────────
  function installInputCounter() {
    const MAX_CHARS = 3000;
    const WARN_AT   = 0.80;

    const style = document.createElement('style');
    style.textContent = `
      #lunaInputMeta {
        display: flex; align-items: center; gap: 8px;
        padding: 3px 4px 0;
        font-family: var(--font-mono, monospace);
        font-size: 9px; letter-spacing: 0.08em;
        color: var(--text-lo, #3d3060);
        transition: color 0.2s;
        min-height: 14px;
        user-select: none;
        pointer-events: none;
      }
      #lunaInputMeta.warn  { color: var(--gold, #fbbf24); }
      #lunaInputMeta.crit  { color: var(--crimson-bright, #ec2d5a); }
      #lunaCharBar {
        flex: 1; height: 2px; border-radius: 99px;
        background: rgba(255,255,255,0.04);
        overflow: hidden;
      }
      #lunaCharFill {
        height: 100%; border-radius: 99px;
        background: var(--violet-bright, #a855f7);
        transition: width 0.18s, background 0.2s;
        width: 0%;
      }
    `;
    document.head.appendChild(style);

    const userInput = document.getElementById('userInput');
    if (!userInput) return;

    const meta = document.createElement('div');
    meta.id = 'lunaInputMeta';
    meta.innerHTML = `<div id="lunaCharBar"><div id="lunaCharFill"></div></div><span id="lunaCharCount"></span>`;

    const inputBox = document.getElementById('inputBox');
    if (inputBox) inputBox.after(meta);

    function updateCounter() {
      const len    = userInput.value.length;
      const pct    = len / MAX_CHARS;
      const words  = len ? userInput.value.trim().split(/\s+/).filter(Boolean).length : 0;
      const fill   = document.getElementById('lunaCharFill');
      const count  = document.getElementById('lunaCharCount');

      if (fill) fill.style.width = Math.min(100, pct * 100) + '%';

      if (len === 0) {
        meta.className = '';
        if (count) count.textContent = '';
        if (fill)  fill.style.background = 'var(--violet-bright, #a855f7)';
        return;
      }

      const remaining = MAX_CHARS - len;
      if (count) count.textContent = `${words}w · ${len}/${MAX_CHARS}`;

      if (pct >= 1) {
        meta.className = 'crit';
        if (fill) fill.style.background = 'var(--crimson-bright, #ec2d5a)';
      } else if (pct >= WARN_AT) {
        meta.className = 'warn';
        if (fill) fill.style.background = 'var(--gold, #fbbf24)';
      } else {
        meta.className = '';
        if (fill) fill.style.background = 'var(--violet-bright, #a855f7)';
      }
    }

    userInput.addEventListener('input', updateCounter);
    userInput.addEventListener('paste', () => setTimeout(updateCounter, 30));
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 7. FOCUS MODE — hides sidebar, header and distractions for
  //   immersive reading. Activated via keyboard shortcut or button.
  // ─────────────────────────────────────────────────────────────────
  function installFocusMode() {
    const style = document.createElement('style');
    style.textContent = `
      body.luna-focus-mode .sidebar,
      body.luna-focus-mode #topBar,
      body.luna-focus-mode #quickPromptsStrip,
      body.luna-focus-mode .orb,
      body.luna-focus-mode .scanlines,
      body.luna-focus-mode #particleCanvas,
      body.luna-focus-mode .bg-grid {
        opacity: 0 !important;
        pointer-events: none !important;
        transition: opacity 0.4s ease !important;
      }
      body.luna-focus-mode #chatFeed {
        padding: 0 clamp(12px, 5vw, 80px) !important;
      }
      body.luna-focus-mode .message.luna .bubble {
        border-color: rgba(168,85,247,0.25) !important;
      }
      #focusModeToggle {
        position: fixed; top: 14px; right: 14px; z-index: 8000;
        width: 32px; height: 32px; border-radius: 8px;
        border: 1px solid rgba(168,85,247,0.25);
        background: rgba(6,6,26,0.7); backdrop-filter: blur(8px);
        color: var(--text-lo, #3d3060); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s; font-size: 13px;
        -webkit-tap-highlight-color: transparent;
        opacity: 0;
      }
      #focusModeToggle:hover, #focusModeToggle.active {
        opacity: 1 !important; color: var(--violet-bright, #a855f7);
        border-color: rgba(168,85,247,0.5);
      }
      #chatFeed:hover ~ #focusModeToggle,
      body:hover #focusModeToggle {
        opacity: 0.45;
      }
      body.luna-focus-mode #focusModeToggle {
        opacity: 0.7 !important;
        color: var(--violet-bright, #a855f7);
      }
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id    = 'focusModeToggle';
    btn.title = 'Focus Mode (Ctrl+Shift+F)';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
    document.body.appendChild(btn);

    let focusOn = false;

    function toggleFocus() {
      focusOn = !focusOn;
      document.body.classList.toggle('luna-focus-mode', focusOn);
      btn.classList.toggle('active', focusOn);
      btn.title = focusOn ? 'Exit Focus Mode (Ctrl+Shift+F)' : 'Focus Mode (Ctrl+Shift+F)';
      haptic(focusOn ? 'medium' : 'light');
      if (window.showToast) showToast(focusOn ? '◈ Focus mode on' : '◈ Focus mode off', '🎯', 1600);
    }

    btn.addEventListener('click', toggleFocus);

    // Keyboard shortcut: Ctrl+Shift+F
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        toggleFocus();
      }
    });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 8. AMBIENT TIME-BASED GREETING in the welcome card area
  //   Updates the greeting label to reflect actual time of day
  //   and injects a subtle "good morning" vibe into the UI.
  // ─────────────────────────────────────────────────────────────────
  function installAmbientGreeting() {
    // Removed: was changing page title with emoji every minute, distracting in browser tab
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 9. PULL-TO-REFRESH indicator for chat feed (mobile)
  //   Shows a subtle "↻ Refreshing…" label when user overscrolls
  //   past the top of the chat feed. Clears old messages on release.
  //   Note: does NOT clear history — just resets the visual scroll.
  // ─────────────────────────────────────────────────────────────────
  function installPullToRefreshIndicator() {
    const IS_MOB = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!IS_MOB) return;

    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    const indicator = document.createElement('div');
    indicator.id = 'pullIndicator';

    const iStyle = document.createElement('style');
    iStyle.textContent = `
      #pullIndicator {
        position: absolute; top: 0; left: 0; right: 0;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        height: 0; overflow: hidden;
        font-family: var(--font-hud, monospace); font-size: 9px;
        letter-spacing: 0.14em; color: var(--violet-bright, #a855f7);
        background: linear-gradient(to bottom, rgba(6,6,26,0.9), transparent);
        transition: height 0.2s;
        pointer-events: none;
        z-index: 10;
      }
      #pullIndicator.showing { height: 48px; }
      #pullIndicator svg { animation: spinCW 1s linear infinite; }
    `;
    document.head.appendChild(iStyle);

    indicator.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-.1-9.44"/>
      </svg>
      <span>SCROLL UP FOR HISTORY</span>`;

    const wrapper = feed.parentElement;
    if (wrapper) {
      wrapper.style.position = 'relative';
      wrapper.insertBefore(indicator, feed);
    }

    let startY = 0;
    feed.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
    }, { passive: true });

    feed.addEventListener('touchmove', (e) => {
      if (feed.scrollTop > 0) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 30) {
        indicator.classList.add('showing');
      }
    }, { passive: true });

    feed.addEventListener('touchend', () => {
      indicator.classList.remove('showing');
    }, { passive: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 10. SMART QUICK-EMOJI TOOLBAR above input
  //   A compact row of frequently used emoji that inserts into the
  //   input field. Auto-learns which emoji the user uses most.
  // ─────────────────────────────────────────────────────────────────
  function installQuickEmojiBar() {
    const DEFAULT_EMOJI = ['❤️','😊','😂','🙏','✨','😭','🥺','👀','💀','🔥','😍','💪'];
    const STORAGE_KEY   = 'luna_emoji_freq';

    function getFreqMap() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
    }
    function bumpEmoji(e) {
      const m = getFreqMap();
      m[e] = (m[e] || 0) + 1;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch {}
    }
    function getSortedEmoji() {
      const m = getFreqMap();
      return [...DEFAULT_EMOJI].sort((a, b) => (m[b] || 0) - (m[a] || 0)).slice(0, 10);
    }

    const style = document.createElement('style');
    style.textContent = `
      #lunaEmojiBar {
        display: flex; align-items: center; gap: 2px;
        padding: 5px 8px 3px;
        overflow-x: auto; scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
      }
      #lunaEmojiBar::-webkit-scrollbar { display: none; }
      .lebi {
        flex-shrink: 0; width: 32px; height: 32px;
        border-radius: 8px; border: none;
        background: transparent; font-size: 18px; line-height: 1;
        cursor: pointer; transition: background 0.12s, transform 0.12s;
        display: flex; align-items: center; justify-content: center;
        -webkit-tap-highlight-color: transparent;
      }
      .lebi:active { background: rgba(168,85,247,0.12); transform: scale(1.22); }
    `;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'lunaEmojiBar';

    function renderBar() {
      bar.innerHTML = '';
      getSortedEmoji().forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'lebi';
        btn.textContent = emoji;
        btn.setAttribute('tabindex', '-1');
        btn.addEventListener('click', () => {
          haptic('light');
          const input = document.getElementById('userInput');
          if (!input) return;
          const pos = input.selectionStart || input.value.length;
          const before = input.value.slice(0, pos);
          const after  = input.value.slice(pos);
          input.value  = before + emoji + after;
          const newPos = pos + emoji.length;
          input.setSelectionRange(newPos, newPos);
          input.focus();
          bumpEmoji(emoji);
          // Trigger the input handler so char counter updates
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        bar.appendChild(btn);
      });
    }
    renderBar();

    // Bar is now rendered inside the + tray (setupPlusTray) — not inserted here.
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 11. MOBILE SCROLL MOMENTUM SMOOTHER
  //   Improves inertial scroll feel on Android Chrome by adding
  //   momentum tracking + snapping resistance when near the bottom.
  // ─────────────────────────────────────────────────────────────────
  function installScrollMomentumHints() {
    const feed = document.getElementById('chatFeed');
    if (!feed) return;
    // Only set the safe iOS scroll properties; skip will-change (wastes GPU memory)
    feed.style.setProperty('-webkit-overflow-scrolling', 'touch');
    feed.style.setProperty('overscroll-behavior-y', 'contain');
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 12. LIVE "LUNA IS THINKING" PROGRESS BAR
  //   A thin indeterminate progress bar under the top bar that runs
  //   while Luna is generating a response, giving visual feedback
  //   that something is happening even before the first token.
  // ─────────────────────────────────────────────────────────────────
  function installThinkingProgressBar() {
    const style = document.createElement('style');
    style.textContent = `
      #lunaProgressBar {
        position: fixed; top: 0; left: 0; right: 0;
        height: 2px; z-index: 10000;
        background: transparent;
        pointer-events: none;
        overflow: hidden;
      }
      #lunaProgressFill {
        height: 100%;
        background: linear-gradient(90deg,
          var(--violet-bright, #a855f7),
          var(--crimson-bright, #ec2d5a),
          var(--violet-bright, #a855f7));
        background-size: 200% 100%;
        width: 0%;
        transition: width 0.3s ease, opacity 0.4s ease;
        animation: lunaBarShimmer 1.6s linear infinite;
        opacity: 0;
      }
      @keyframes lunaBarShimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      #lunaProgressFill.running {
        opacity: 1;
        animation: lunaBarShimmer 1.6s linear infinite, lunaBarGrow 8s ease-out forwards;
      }
      @keyframes lunaBarGrow {
        0%   { width: 0%; }
        30%  { width: 55%; }
        70%  { width: 80%; }
        95%  { width: 93%; }
        100% { width: 93%; }
      }
      #lunaProgressFill.done {
        width: 100% !important;
        animation: lunaBarShimmer 1.6s linear infinite;
        transition: width 0.25s ease;
      }
    `;
    document.head.appendChild(style);

    const bar  = document.createElement('div');
    bar.id     = 'lunaProgressBar';
    const fill = document.createElement('div');
    fill.id    = 'lunaProgressFill';
    bar.appendChild(fill);
    document.body.appendChild(bar);

    // Hook into the existing showTyping / hideTyping if available
    const _origShowTyping = window.showTyping;
    const _origHideTyping = window.hideTyping;

    window.showTyping = function() {
      fill.className = 'running';
      if (_origShowTyping) _origShowTyping.apply(this, arguments);
    };

    window.hideTyping = function() {
      fill.classList.remove('running');
      fill.classList.add('done');
      setTimeout(() => {
        fill.classList.remove('done');
        fill.style.cssText = '';
      }, 420);
      if (_origHideTyping) _origHideTyping.apply(this, arguments);
    };
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 13. SWIPE-LEFT ON BUBBLE to trigger quick-reply
  //   User swipes left on any message bubble to pre-populate
  //   the reply context — natural gesture for mobile users.
  // ─────────────────────────────────────────────────────────────────
  function installBubbleSwipeReply() {
    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    const style = document.createElement('style');
    style.textContent = `
      .bubble.swipe-reply-hint {
        transition: transform 0.18s var(--spring), box-shadow 0.18s !important;
        box-shadow: -3px 0 16px rgba(168,85,247,0.25) !important;
      }
      .bubble.swipe-reply-hint::after {
        content: '↩';
        position: absolute; right: -32px; top: 50%;
        transform: translateY(-50%);
        color: var(--violet-bright, #a855f7);
        font-size: 18px; opacity: 0.8;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);

    let touchStartX = 0, touchStartY = 0, activeBubble = null;

    feed.addEventListener('touchstart', (e) => {
      const bubble = e.target.closest('.bubble');
      if (!bubble) return;
      activeBubble  = bubble;
      touchStartX   = e.touches[0].clientX;
      touchStartY   = e.touches[0].clientY;
      bubble.style.transition = 'none';
    }, { passive: true });

    feed.addEventListener('touchmove', (e) => {
      if (!activeBubble) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dy > 12) { activeBubble = null; return; } // vertical scroll — abort
      if (dx < -8 && dx > -80) {
        const pull = Math.abs(dx) * 0.5;
        activeBubble.style.transform = `translateX(-${pull}px)`;
        if (Math.abs(dx) > 30) activeBubble.classList.add('swipe-reply-hint');
      }
    }, { passive: true });

    feed.addEventListener('touchend', (e) => {
      if (!activeBubble) return;
      const dx = e.changedTouches[0].clientX - touchStartX;

      if (dx < -50) {
        // Committed swipe — trigger reply
        haptic('medium');
        const msgWrap = activeBubble.closest('.message');
        const msgId   = msgWrap?.dataset?.msgId;
        const text    = activeBubble.querySelector('.bubble-text')?.innerText || '';
        if (msgId && window.setReplyContext) setReplyContext(msgId, text);
      }

      // Spring back
      activeBubble.style.transition = 'transform 0.28s var(--spring)';
      activeBubble.style.transform  = '';
      activeBubble.classList.remove('swipe-reply-hint');
      setTimeout(() => {
        if (activeBubble) activeBubble.style.transition = '';
        activeBubble = null;
      }, 320);
    }, { passive: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 14. KEYBOARD DISMISS on tap outside input (iOS Safari fix)
  //   Tapping anywhere outside the input zone on iOS dismisses the
  //   keyboard and scrolls chat back to the correct position.
  // ─────────────────────────────────────────────────────────────────
  function installTapOutsideDismiss() {
    const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!IS_IOS) return;

    const inputZone = document.querySelector('.input-zone');
    document.addEventListener('touchend', (e) => {
      if (!inputZone) return;
      if (inputZone.contains(e.target)) return;
      const focused = document.activeElement;
      if (!focused || !['INPUT', 'TEXTAREA'].includes(focused.tagName)) return;

      focused.blur();
    }, { passive: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 15. THEME TRANSITION SMOOTHER
  //   When the user switches themes, wrap the transition in a
  //   full-page crossfade to avoid the jarring instant repaint.
  // ─────────────────────────────────────────────────────────────────
  function installThemeTransition() {
    const style = document.createElement('style');
    style.textContent = `
      html.theme-transitioning,
      html.theme-transitioning * {
        transition:
          background-color 0.35s ease,
          border-color 0.35s ease,
          color 0.25s ease,
          box-shadow 0.35s ease !important;
      }
    `;
    document.head.appendChild(style);

    // Patch any existing setTheme / theme-switching calls
    const _origSetTheme = window.setTheme;
    window.setTheme = function(theme) {
      document.documentElement.classList.add('theme-transitioning');
      setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 420);
      if (_origSetTheme) return _origSetTheme.apply(this, arguments);
      // Fallback: set data-theme directly
      document.documentElement.setAttribute('data-theme', theme);
    };

    // Also intercept clicks on theme dots / buttons
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-value], .theme-dot, .theme-btn');
      if (!btn) return;
      document.documentElement.classList.add('theme-transitioning');
      setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 420);
    });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ INIT — Run all enhancements after DOM is ready
  // ─────────────────────────────────────────────────────────────────
  function initEnhancements() {
    installScrollFAB();
    installDoubleTapReact();
    installLongPressMenu();
    // installInputCounter — removed: duplicates the existing charCounter already in the HTML
    installFocusMode();
    // installAmbientGreeting — removed: changes page title with emoji every minute (distracting in browser tab)
    // installPullToRefreshIndicator — removed: misleading (doesn't reload), triggers accidentally on scroll
    // installQuickEmojiBar — removed: duplicates the existing emoji picker, clutters input area
    // installScrollMomentumHints — removed: sets will-change globally which wastes GPU memory
    installThinkingProgressBar();
    installBubbleSwipeReply();
    installTapOutsideDismiss();
    installThemeTransition();
    document.querySelectorAll('.modal-overlay').forEach(attachSwipeClose);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEnhancements);
  } else {
    // DOM already parsed (script loaded late)
    setTimeout(initEnhancements, 0);
  }

})();

// ══════════════════════════════════════════════════════════════════
// ◈ LUNA UI/UX ENHANCEMENTS — Wave 2
//   16. Message read receipts (seen tick)
//   17. Typewriter intro for welcome card
//   18. Smart send button — icon morphs: idle → typing → loading
//   19. Auto-expand / collapse textarea with max-height
//   20. Keyboard shortcut cheat-sheet overlay
//   21. Chat export as formatted HTML (prettier than .txt)
//   22. Sound effects (opt-in, Web Audio API — no file deps)
//   23. Per-message elapsed time tooltip ("2 min ago")
//   24. Auto-save draft when navigating away
//   25. Pinch-to-zoom on images (mobile)
//   26. Contextual quick-prompt suggestions after Luna responds
//   27. Typing speed / WPM tracker shown in input area
//   28. Reading time estimate on long Luna messages
//   29. Chat session timer (HH:MM in top bar)
//   30. Network quality indicator (online / slow / offline)
// ══════════════════════════════════════════════════════════════════

;(function lunaEnhancements2() {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // ◈ 16. MESSAGE READ-RECEIPT TICKS
  //   Luna messages show ✓ (delivered) and ✓✓ (read) ticks just
  //   like iMessage/WhatsApp — the double tick appears 1.2s after
  //   the message fully renders and the tab is in focus.
  // ─────────────────────────────────────────────────────────────────
  function installReadReceipts() {
    const style = document.createElement('style');
    style.textContent = `
      .luna-tick {
        display: inline-flex; align-items: center; gap: 1px;
        margin-left: 6px; vertical-align: middle;
        font-size: 10px; opacity: 0.55;
        transition: opacity 0.3s, color 0.4s;
        user-select: none; pointer-events: none;
        color: var(--text-lo, #3d3060);
      }
      .luna-tick.read {
        color: var(--violet-bright, #a855f7);
        opacity: 0.9;
      }
      .luna-tick svg { flex-shrink: 0; }
    `;
    document.head.appendChild(style);

    const TICK_SVG  = `<svg width="12" height="8" viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,5 5,9 15,1"/></svg>`;
    const DTICK_SVG = `<svg width="16" height="8" viewBox="0 0 20 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,5 5,9 15,1"/><polyline points="5,5 9,9 19,1"/></svg>`;

    // Observe new Luna messages being appended to chatFeed
    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    const observer = new MutationObserver(mutations => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (!node.classList?.contains('message') || !node.classList?.contains('luna')) return;
          const timeEl = node.querySelector('.bubble-time');
          if (!timeEl) return;

          // Inject single tick (delivered)
          const tick = document.createElement('span');
          tick.className = 'luna-tick';
          tick.innerHTML = TICK_SVG;
          timeEl.appendChild(tick);

          // After 1.2s (if tab visible) → double-tick (read)
          const markRead = () => {
            tick.innerHTML = DTICK_SVG;
            tick.classList.add('read');
          };

          if (document.visibilityState === 'visible') {
            setTimeout(markRead, 1200);
          } else {
            // Wait until the tab comes back into focus
            const onVisible = () => {
              if (document.visibilityState === 'visible') {
                document.removeEventListener('visibilitychange', onVisible);
                setTimeout(markRead, 600);
              }
            };
            document.addEventListener('visibilitychange', onVisible);
          }
        });
      });
    });
    observer.observe(feed, { childList: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 17. TYPEWRITER INTRO for welcome card
  //   The welcome subtitle cycles through phrases with a blinking
  //   cursor, giving the landing screen a living, breathing feel.
  // ─────────────────────────────────────────────────────────────────
  function installTypewriterWelcome() {
    const PHRASES = [
      'Your neural companion is online.',
      'Ask anything. Luna is listening.',
      'Tap below to begin.',
      'Curious? Luna loves that.',
      'Hello, I\'ve been waiting for you. ✦',
    ];

    function startTypewriter(el) {
      let phraseIdx = 0, charIdx = 0, deleting = false;

      const cursor = document.createElement('span');
      cursor.style.cssText = `
        display:inline-block; width:1px; height:1em;
        background:var(--violet-bright,#a855f7); margin-left:2px;
        vertical-align:middle; animation:twBlink 1s step-end infinite;
      `;

      const csStyle = document.createElement('style');
      csStyle.textContent = `@keyframes twBlink{0%,100%{opacity:1}50%{opacity:0}}`;
      document.head.appendChild(csStyle);

      el.textContent = '';
      el.appendChild(cursor);

      const TYPE_SPEED   = 42;
      const DELETE_SPEED = 22;
      const PAUSE_END    = 2200;
      const PAUSE_START  = 400;

      function tick() {
        const phrase = PHRASES[phraseIdx];
        if (!deleting) {
          charIdx++;
          el.textContent = phrase.slice(0, charIdx);
          el.appendChild(cursor);
          if (charIdx === phrase.length) {
            deleting = true;
            setTimeout(tick, PAUSE_END);
            return;
          }
        } else {
          charIdx--;
          el.textContent = phrase.slice(0, charIdx);
          el.appendChild(cursor);
          if (charIdx === 0) {
            deleting = false;
            phraseIdx = (phraseIdx + 1) % PHRASES.length;
            setTimeout(tick, PAUSE_START);
            return;
          }
        }
        setTimeout(tick, deleting ? DELETE_SPEED : TYPE_SPEED);
      }
      tick();
    }

    // Run on existing welcome card and re-run when a new one is injected
    function tryAttach() {
      const el = document.querySelector('.welcome-sub, .welcome-subtitle, [data-typewriter]');
      if (el && !el._twInstalled) { el._twInstalled = true; startTypewriter(el); }
    }

    tryAttach();
    const obs = new MutationObserver(tryAttach);
    document.addEventListener('DOMContentLoaded', () => {
      obs.observe(document.getElementById('chatFeed') || document.body, { childList: true, subtree: true });
    });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 18. SMART SEND BUTTON MORPHING
  //   The send button icon shifts between three states:
  //   • idle (paper-plane) → has-text (glowing plane) → loading (spinner)
  //   Uses CSS classes so the transition is GPU-composited.
  // ─────────────────────────────────────────────────────────────────
  function installSmartSendBtn() {
    const sendBtn   = document.getElementById('sendBtn');
    const userInput = document.getElementById('userInput');
    if (!sendBtn || !userInput) return;

    const style = document.createElement('style');
    style.textContent = `
      #sendBtn { transition: transform 0.22s var(--spring), box-shadow 0.22s, background 0.2s !important; }
      #sendBtn.has-text {
        box-shadow: 0 0 18px rgba(168,85,247,0.45) !important;
      }
      #sendBtn.has-text:not(:disabled):hover {
        transform: scale(1.08) translateY(-1px) !important;
      }
      #sendBtn:active:not(:disabled) { transform: scale(0.93) !important; }
      @keyframes sbSpin {
        to { transform: rotate(360deg); }
      }
      #sendBtn.loading svg {
        animation: sbSpin 0.7s linear infinite;
      }
    `;
    document.head.appendChild(style);

    function updateSendState() {
      const hasText = userInput.value.trim().length > 0;
      sendBtn.classList.toggle('has-text', hasText);
    }

    userInput.addEventListener('input', updateSendState);

    // Patch showTyping / hideTyping to toggle loading state
    const _origShow = window.showTyping;
    const _origHide = window.hideTyping;
    window.showTyping = function() {
      sendBtn.classList.add('loading');
      if (_origShow) _origShow.apply(this, arguments);
    };
    window.hideTyping = function() {
      sendBtn.classList.remove('loading');
      if (_origHide) _origHide.apply(this, arguments);
    };
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 19. AUTO-EXPANDING TEXTAREA
  //   The input textarea grows up to 5 lines as the user types,
  //   then scrolls internally — no fixed height fighting the layout.
  // ─────────────────────────────────────────────────────────────────
  function installAutoExpandTextarea() {
    const input = document.getElementById('userInput');
    if (!input) return;

    const LINE_H    = 22;   // px per line (approximate for Sora 14px)
    const MIN_LINES = 1;
    const MAX_LINES = 5;

    function resize() {
      input.style.height = 'auto';
      const scrollH    = input.scrollHeight;
      const minH       = LINE_H * MIN_LINES;
      const maxH       = LINE_H * MAX_LINES + 16; // +padding
      input.style.height = Math.min(maxH, Math.max(minH, scrollH)) + 'px';
      input.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';
    }

    input.addEventListener('input',  resize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Will be sent — reset height after a frame
        requestAnimationFrame(resize);
      }
    });

    // Reset when content is cleared (after send)
    const origClear = window.clearInput;
    window.clearInput = function() {
      if (origClear) origClear.apply(this, arguments);
      else { input.value = ''; }
      requestAnimationFrame(resize);
    };

    resize();
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 20. KEYBOARD SHORTCUT CHEAT-SHEET
  //   Press '?' (question mark) while not typing to open a
  //   glassmorphic shortcut reference overlay.
  // ─────────────────────────────────────────────────────────────────
  function installShortcutSheet() {
    const SHORTCUTS = [
      { keys: 'Enter',           desc: 'Send message' },
      { keys: 'Shift + Enter',   desc: 'New line in message' },
      { keys: 'Ctrl + R',        desc: 'Regenerate last response' },
      { keys: 'Ctrl + Shift + F',desc: 'Toggle Focus Mode' },
      { keys: 'Ctrl + K',        desc: 'Open chat search' },
      { keys: 'Esc',             desc: 'Close overlay / cancel reply' },
      { keys: '↑ Arrow',         desc: 'Edit last message' },
      { keys: '?',               desc: 'Show this shortcut guide' },
    ];

    const style = document.createElement('style');
    style.textContent = `
      #shortcutSheet {
        position: fixed; inset: 0; z-index: 99997;
        background: rgba(0,0,0,0.65); backdrop-filter: blur(10px);
        display: flex; align-items: center; justify-content: center;
        animation: ctxFadeIn 0.2s ease both;
      }
      #shortcutSheet .ss-box {
        background: rgba(9,9,32,0.97);
        border: 1px solid rgba(168,85,247,0.3);
        border-radius: 18px; padding: 24px 28px;
        min-width: 320px; max-width: 420px; width: 92vw;
        box-shadow: 0 20px 80px rgba(0,0,0,0.6);
      }
      #shortcutSheet .ss-title {
        font-family: var(--font-hud, monospace);
        font-size: 10px; letter-spacing: 0.18em;
        color: var(--text-lo, #3d3060); margin-bottom: 18px;
      }
      #shortcutSheet .ss-row {
        display: flex; align-items: center;
        gap: 12px; padding: 8px 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      #shortcutSheet .ss-row:last-child { border-bottom: none; }
      #shortcutSheet .ss-key {
        font-family: var(--font-mono, monospace);
        font-size: 10.5px; color: var(--text-hi, #f0e6ff);
        background: rgba(168,85,247,0.1);
        border: 1px solid rgba(168,85,247,0.22);
        border-radius: 6px; padding: 3px 8px;
        min-width: 130px; text-align: center; flex-shrink: 0;
        white-space: nowrap;
      }
      #shortcutSheet .ss-desc {
        font-size: 12px; color: var(--text-mid, #9580b5);
      }
      #shortcutSheet .ss-close {
        display: block; margin-top: 20px; width: 100%;
        padding: 10px; border-radius: 10px;
        background: rgba(168,85,247,0.1);
        border: 1px solid rgba(168,85,247,0.25);
        color: var(--violet-bright, #a855f7);
        font-family: var(--font-hud, monospace); font-size: 9px;
        letter-spacing: 0.14em; cursor: pointer;
        transition: background 0.15s;
      }
      #shortcutSheet .ss-close:hover { background: rgba(168,85,247,0.2); }
    `;
    document.head.appendChild(style);

    function openSheet() {
      if (document.getElementById('shortcutSheet')) return;
      const overlay = document.createElement('div');
      overlay.id = 'shortcutSheet';
      overlay.innerHTML = `
        <div class="ss-box">
          <div class="ss-title">◈ KEYBOARD SHORTCUTS</div>
          ${SHORTCUTS.map(s => `
            <div class="ss-row">
              <span class="ss-key">${s.keys}</span>
              <span class="ss-desc">${s.desc}</span>
            </div>`).join('')}
          <button class="ss-close" onclick="this.closest('#shortcutSheet').remove()">CLOSE ✕</button>
        </div>`;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
      document.body.appendChild(overlay);
    }

    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '?') { e.preventDefault(); openSheet(); }
    });

    // Also expose globally
    window.openShortcutSheet = openSheet;
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 21. HTML CHAT EXPORT
  //   Exports the conversation as a styled, self-contained HTML file
  //   that looks like a real chat — purple Luna bubbles, user bubbles,
  //   timestamps, Luna logo. Shareable and archive-worthy.
  // ─────────────────────────────────────────────────────────────────
  function installHTMLExport() {
    window.exportChatHTML = function() {
      const hist = window.conversationHistory || [];
      if (!hist.length) {
        if (window.showToast) showToast('No messages to export yet.', '⚠️', 1800);
        return;
      }

      const uName = window.userName || 'You';
      const date  = new Date().toLocaleString();

      const bubbles = hist.filter(m => m.role !== 'system').map(m => {
        const isLuna = m.role === 'assistant';
        const text   = typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '');
        const safe   = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                           .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
                           .replace(/\*(.*?)\*/g,'<em>$1</em>')
                           .replace(/\n/g,'<br>');
        const who    = isLuna ? 'Luna' : uName;
        const side   = isLuna ? 'luna' : 'user';
        return `<div class="msg ${side}"><div class="av">${isLuna?'LN':uName.slice(0,2).toUpperCase()}</div><div class="bub"><div class="name">${who}</div><div class="txt">${safe}</div></div></div>`;
      }).join('\n');

      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luna AI — Chat Export</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#020209;font-family:'Segoe UI',system-ui,sans-serif;color:#f0e6ff;padding:20px;max-width:780px;margin:0 auto}
  h1{font-size:13px;letter-spacing:.2em;color:#a855f7;margin-bottom:4px;font-family:monospace}
  .meta{font-size:11px;color:#3d3060;margin-bottom:24px;font-family:monospace}
  .msg{display:flex;gap:12px;margin-bottom:16px;align-items:flex-start}
  .msg.user{flex-direction:row-reverse}
  .av{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:10px;font-weight:700;flex-shrink:0}
  .luna .av{background:linear-gradient(135deg,#7928ca,#a855f7);color:#fff}
  .user .av{background:rgba(236,45,90,0.2);border:1px solid rgba(236,45,90,0.4);color:#ec2d5a}
  .bub{max-width:72%;padding:12px 16px;border-radius:14px;line-height:1.6;font-size:14px}
  .luna .bub{background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.25);border-radius:4px 14px 14px 14px}
  .user .bub{background:rgba(236,45,90,0.08);border:1px solid rgba(236,45,90,0.22);border-radius:14px 4px 14px 14px;text-align:right}
  .name{font-size:9px;letter-spacing:.14em;color:#9580b5;font-family:monospace;margin-bottom:5px}
  strong{color:#d4b8ff} em{color:#c4b5fd;font-style:italic}
  @media(max-width:600px){.bub{max-width:86%}.msg{gap:8px}}
</style>
</head>
<body>
<h1>◈ LUNA AI · CHAT EXPORT</h1>
<div class="meta">User: ${uName} · Exported: ${date} · ${hist.filter(m=>m.role!=='system').length} messages</div>
${bubbles}
</body></html>`;

      const blob = new Blob([html], { type: 'text/html' });
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `luna-chat-${Date.now()}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (window.showToast) showToast('✦ Chat exported as HTML', '📄', 2200);
    };
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 22. SOUND EFFECTS (opt-in, Web Audio API — zero file deps)
  //   Synthesises tiny sounds for: send, receive, error, reaction.
  //   Stored preference in localStorage; default OFF.
  // ─────────────────────────────────────────────────────────────────
  function installSoundEffects() {
    let _ctx = null;
    function getCtx() {
      if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
      return _ctx;
    }

    function beep({ freq = 440, type = 'sine', vol = 0.08, dur = 0.08, attack = 0.005, decay = 0.06 } = {}) {
      if (!window.lunaSoundsEnabled) return;
      try {
        const ctx  = getCtx();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type; osc.frequency.value = freq;
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(vol, now + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
        osc.start(now); osc.stop(now + attack + decay + 0.01);
      } catch {}
    }

    // Named sound presets
    window.lunaSound = {
      send:     () => { beep({ freq: 880, dur: 0.06, decay: 0.05 }); },
      receive:  () => { beep({ freq: 660, type: 'triangle', vol: 0.06, decay: 0.1 }); setTimeout(() => beep({ freq: 880, type: 'triangle', vol: 0.04, decay: 0.08 }), 60); },
      error:    () => { beep({ freq: 200, type: 'sawtooth', vol: 0.07, decay: 0.18 }); },
      reaction: () => { beep({ freq: 1046, type: 'sine', vol: 0.05, decay: 0.12 }); },
      ping:     () => { beep({ freq: 1318, type: 'sine', vol: 0.04, decay: 0.14 }); },
    };

    window.lunaSoundsEnabled = (() => {
      try { return localStorage.getItem('luna_sounds') === '1'; } catch { return false; }
    })();

    window.toggleLunaSounds = function() {
      window.lunaSoundsEnabled = !window.lunaSoundsEnabled;
      try { localStorage.setItem('luna_sounds', lunaSoundsEnabled ? '1' : '0'); } catch {}
      if (window.showToast) showToast(lunaSoundsEnabled ? '🔔 Sounds on' : '🔕 Sounds off', '◈', 1600);
      if (lunaSoundsEnabled) lunaSound.ping(); // confirm sound with a ping
    };

    // Hook into send and receive paths
    const feed = document.getElementById('chatFeed');
    if (feed) {
      new MutationObserver(muts => {
        muts.forEach(m => {
          m.addedNodes.forEach(node => {
            if (!node.classList) return;
            if (node.classList.contains('luna'))    lunaSound.receive();
            if (node.classList.contains('user'))    lunaSound.send();
          });
        });
      }).observe(feed, { childList: true });
    }
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 23. RELATIVE TIMESTAMP TOOLTIPS ("2 min ago")
  //   Each bubble-time element shows a tooltip on hover/tap with a
  //   human-friendly relative time that auto-refreshes every minute.
  // ─────────────────────────────────────────────────────────────────
  function installRelativeTimestamps() {
    // Store creation timestamp on each message
    const style = document.createElement('style');
    style.textContent = `
      .bubble-time { position: relative; cursor: default; }
      .bubble-time::after {
        content: attr(data-rel);
        position: absolute; bottom: calc(100% + 6px); right: 0;
        background: rgba(6,6,26,0.95);
        border: 1px solid rgba(168,85,247,0.2);
        color: var(--text-mid, #9580b5);
        font-family: var(--font-mono, monospace);
        font-size: 9px; letter-spacing: 0.08em;
        padding: 4px 8px; border-radius: 6px;
        white-space: nowrap; pointer-events: none;
        opacity: 0; transform: translateY(4px);
        transition: opacity 0.15s, transform 0.15s;
      }
      .bubble-time:hover::after, .bubble-time.tip-open::after {
        opacity: 1; transform: none;
      }
    `;
    document.head.appendChild(style);

    function relTime(ts) {
      const diff = Math.floor((Date.now() - ts) / 1000);
      if (diff < 10)  return 'just now';
      if (diff < 60)  return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
      return `${Math.floor(diff/86400)}d ago`;
    }

    function stampAll() {
      document.querySelectorAll('.bubble-time[data-ts]').forEach(el => {
        el.dataset.rel = relTime(parseInt(el.dataset.ts, 10));
      });
    }

    // Observe new messages and stamp them
    const feed = document.getElementById('chatFeed');
    if (feed) {
      new MutationObserver(muts => {
        muts.forEach(m => {
          m.addedNodes.forEach(node => {
            if (!node.querySelector) return;
            node.querySelectorAll?.('.bubble-time').forEach(el => {
              if (!el.dataset.ts) el.dataset.ts = Date.now();
            });
          });
        });
        stampAll();
      }).observe(feed, { childList: true, subtree: true });
    }

    // Tap on mobile to open tooltip
    document.addEventListener('touchstart', (e) => {
      const el = e.target.closest('.bubble-time');
      if (!el) {
        document.querySelectorAll('.bubble-time.tip-open').forEach(x => x.classList.remove('tip-open'));
        return;
      }
      el.classList.toggle('tip-open');
    }, { passive: true });

    setInterval(stampAll, 60_000);
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 24. AUTO-SAVE INPUT DRAFT
  //   Whatever the user has typed is saved to localStorage every 2s
  //   and restored on next load so they never lose a long message.
  // ─────────────────────────────────────────────────────────────────
  function installDraftAutoSave() {
    const KEY   = 'luna_input_draft';
    const input = document.getElementById('userInput');
    if (!input) return;

    // Restore draft on load
    try {
      const draft = localStorage.getItem(KEY);
      if (draft && !input.value) {
        input.value = draft;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Flash a subtle indicator
        input.style.transition = 'border-color 0.4s';
        input.style.borderColor = 'rgba(168,85,247,0.5)';
        setTimeout(() => { input.style.borderColor = ''; }, 1500);
      }
    } catch {}

    // Debounced save
    let saveTimer;
    input.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { localStorage.setItem(KEY, input.value); } catch {}
      }, 1500);
    });

    // Clear draft on send
    const _origSend = window.sendMessage;
    window.sendMessage = function() {
      try { localStorage.removeItem(KEY); } catch {}
      if (_origSend) _origSend.apply(this, arguments);
    };

    // Also clear on successful form submission
    const sendBtn = document.getElementById('sendBtn');
    sendBtn?.addEventListener('click', () => {
      setTimeout(() => { try { localStorage.removeItem(KEY); } catch {} }, 100);
    });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 25. PINCH-TO-ZOOM on images (mobile)
  //   Any <img> inside a Luna bubble can be pinched to full-screen
  //   lightbox on mobile without any library dependency.
  // ─────────────────────────────────────────────────────────────────
  function installPinchZoom() {
    const style = document.createElement('style');
    style.textContent = `
      #pzLightbox {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.9); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        animation: fadeIn 0.18s ease;
        touch-action: none;
      }
      #pzLightbox img {
        max-width: 96vw; max-height: 90vh;
        border-radius: 10px;
        box-shadow: 0 8px 60px rgba(0,0,0,0.8);
        border: 1px solid rgba(168,85,247,0.2);
        transform-origin: center;
        user-select: none; -webkit-user-select: none;
        touch-action: none;
      }
      #pzLightbox .pz-close {
        position: absolute; top: 16px; right: 16px;
        background: rgba(6,6,26,0.8); border: 1px solid rgba(168,85,247,0.3);
        color: var(--text-hi, #f0e6ff); border-radius: 50%;
        width: 36px; height: 36px;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px; cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
    `;
    document.head.appendChild(style);

    function openLightbox(src, alt) {
      if (document.getElementById('pzLightbox')) return;
      const lb  = document.createElement('div');
      lb.id     = 'pzLightbox';
      const img = document.createElement('img');
      img.src   = src; img.alt = alt || '';

      // Pinch-zoom state
      let scale = 1, lastDist = 0, lastScale = 1;
      let tx = 0, ty = 0, ltx = 0, lty = 0;
      let lastMid = null;

      function dist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
      function mid(t)  { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }; }

      img.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          lastDist  = dist(e.touches);
          lastScale = scale;
          lastMid   = mid(e.touches);
          ltx = tx; lty = ty;
          e.preventDefault();
        }
      }, { passive: false });

      img.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const d = dist(e.touches);
          const m = mid(e.touches);
          scale = Math.min(4, Math.max(1, lastScale * (d / lastDist)));
          tx    = ltx + (m.x - lastMid.x);
          ty    = lty + (m.y - lastMid.y);
          img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
        }
      }, { passive: false });

      img.addEventListener('touchend', (e) => {
        if (e.touches.length < 2 && scale < 1.1) {
          scale = 1; tx = 0; ty = 0;
          img.style.transition = 'transform 0.28s var(--spring,ease)';
          img.style.transform  = '';
          setTimeout(() => img.style.transition = '', 320);
        }
      }, { passive: true });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'pz-close';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => lb.remove());
      lb.addEventListener('click', (e) => { if (e.target === lb) lb.remove(); });

      lb.appendChild(img); lb.appendChild(closeBtn);
      document.body.appendChild(lb);
    }

    // Wire up to existing and future images in chat feed
    function bindImages(root) {
      root.querySelectorAll?.('img').forEach(img => {
        if (img._pzBound) return;
        img._pzBound = true;
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => openLightbox(img.src, img.alt));
      });
    }

    const feed = document.getElementById('chatFeed');
    if (feed) {
      bindImages(feed);
      new MutationObserver(muts => {
        muts.forEach(m => m.addedNodes.forEach(n => { if (n.querySelector) bindImages(n); }));
      }).observe(feed, { childList: true, subtree: true });
    }
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 26. CONTEXTUAL QUICK-PROMPT SUGGESTIONS
  //   After each Luna response, a row of 3 short follow-up chips
  //   appears below the reply. Luna generates them contextually via
  //   a lightweight async call using the last exchange.
  //   Tapping a chip populates the input (user still hits send).
  // ─────────────────────────────────────────────────────────────────
  function installFollowUpChips() {
    const style = document.createElement('style');
    style.textContent = `
      .luna-follow-chips {
        display: flex; flex-wrap: wrap; gap: 7px;
        margin-top: 10px; padding-top: 8px;
        border-top: 1px solid rgba(168,85,247,0.1);
        animation: sgFeedIn 0.3s ease both;
      }
      .luna-chip {
        padding: 5px 11px; border-radius: 99px;
        border: 1px solid rgba(168,85,247,0.25);
        background: rgba(168,85,247,0.06);
        color: var(--text-mid, #9580b5);
        font-family: var(--font-body, sans-serif);
        font-size: 11.5px; cursor: pointer;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
        -webkit-tap-highlight-color: transparent;
        white-space: nowrap; max-width: 200px;
        overflow: hidden; text-overflow: ellipsis;
      }
      .luna-chip:hover, .luna-chip:active {
        background: rgba(168,85,247,0.15);
        border-color: var(--violet-bright, #a855f7);
        color: var(--text-hi, #f0e6ff);
      }
    `;
    document.head.appendChild(style);

    let chipGen = null; // AbortController for in-flight chip generation

    async function generateChips(lastUserMsg, lastLunaMsg) {
      const prompt = `Given this conversation snippet:
User: ${lastUserMsg.slice(0, 200)}
Luna: ${lastLunaMsg.slice(0, 300)}

Generate exactly 3 short, natural follow-up questions or prompts the user might want to say next (in the same language as the conversation — Filipino, English, or Taglish). Return ONLY a JSON array of 3 strings, e.g. ["Tell me more","Why is that?","Give an example"]. No other text.`;

      try {
        if (chipGen) chipGen.abort();
        chipGen = new AbortController();
        const key = window.getActiveApiKey ? getActiveApiKey() : (window.API_KEY || '');
        const res = await fetch(window.API_URL || 'https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          signal:  chipGen.signal,
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body:    JSON.stringify({
            model:       window.API_MODEL_FALLBACK || 'llama-3.1-8b-instant',
            max_tokens:  80,
            temperature: 0.8,
            messages:    [{ role: 'user', content: prompt }],
          }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const raw  = data?.choices?.[0]?.message?.content || '';
        const arr  = JSON.parse(raw.trim().replace(/```json|```/g, ''));
        if (Array.isArray(arr) && arr.length) return arr.slice(0, 3).map(s => String(s));
      } catch {}
      return null;
    }

    const feed     = document.getElementById('chatFeed');
    const input    = document.getElementById('userInput');
    if (!feed || !input) return;

    new MutationObserver(muts => {
      muts.forEach(m => {
        m.addedNodes.forEach(async node => {
          if (!node.classList?.contains('message') || !node.classList?.contains('luna')) return;
          const bubble = node.querySelector('.bubble-text');
          if (!bubble) return;

          // Wait for streaming to finish (bubble-text will settle after hideTyping)
          await new Promise(r => setTimeout(r, 800));

          const lunaText = bubble.innerText || '';
          const hist     = window.conversationHistory || [];
          const lastUser = hist.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
          if (!lunaText || !lastUser) return;

          const chips = await generateChips(lastUser, lunaText);
          if (!chips?.length) return;

          // Don't add chips if the bubble already has them
          if (node.querySelector('.luna-follow-chips')) return;

          const row = document.createElement('div');
          row.className = 'luna-follow-chips';
          chips.forEach(text => {
            const chip = document.createElement('button');
            chip.className = 'luna-chip';
            chip.textContent = text;
            chip.addEventListener('click', () => {
              input.value = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.focus();
              // Remove chip row after selection
              row.style.opacity = '0';
              row.style.transition = 'opacity 0.2s';
              setTimeout(() => row.remove(), 220);
              if (window.haptic) haptic('light');
            });
            row.appendChild(chip);
          });

          const footer = node.querySelector('.bubble-footer');
          if (footer) footer.before(row);
        });
      });
    }).observe(feed, { childList: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 27. READING TIME ESTIMATE on long Luna messages
  //   Appends "~2 min read" to Luna messages over 200 words.
  //   Helps the user know how much to expect before scrolling in.
  // ─────────────────────────────────────────────────────────────────
  function installReadingTime() {
    const WPM = 220;

    const style = document.createElement('style');
    style.textContent = `
      .luna-read-time {
        display: inline-flex; align-items: center; gap: 4px;
        font-family: var(--font-hud, monospace);
        font-size: 8.5px; letter-spacing: 0.1em;
        color: var(--text-lo, #3d3060);
        margin-left: 8px;
        vertical-align: middle;
        user-select: none;
      }
    `;
    document.head.appendChild(style);

    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    new MutationObserver(muts => {
      muts.forEach(m => {
        m.addedNodes.forEach(async node => {
          if (!node.classList?.contains('message') || !node.classList?.contains('luna')) return;
          // Wait for stream to finish
          await new Promise(r => setTimeout(r, 900));
          const textEl = node.querySelector('.bubble-text');
          const timeEl = node.querySelector('.bubble-time');
          if (!textEl || !timeEl) return;
          const words = (textEl.innerText || '').split(/\s+/).filter(Boolean).length;
          if (words < 200) return;
          const mins  = Math.max(1, Math.round(words / WPM));
          const badge = document.createElement('span');
          badge.className   = 'luna-read-time';
          badge.textContent = `~${mins} min read`;
          timeEl.after(badge);
        });
      });
    }).observe(feed, { childList: true });
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 28. CHAT SESSION TIMER in top bar
  //   Shows HH:MM elapsed since the current session started.
  //   Resets on sign-in / page reload. Displayed in the top-bar
  //   stat area next to the message counter.
  // ─────────────────────────────────────────────────────────────────
  function installSessionTimer() {
    const sessionStart = Date.now();

    const style = document.createElement('style');
    style.textContent = `
      #sessionTimerEl {
        font-family: var(--font-hud, monospace);
        font-size: 9px; letter-spacing: 0.12em;
        color: var(--text-lo, #3d3060);
        display: inline-flex; align-items: center; gap: 4px;
      }
      #sessionTimerEl .sti { color: var(--violet-bright, #a855f7); }
    `;
    document.head.appendChild(style);

    function formatElapsed(ms) {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      const mm = String(m % 60).padStart(2, '0');
      return h > 0 ? `${h}:${mm}h` : `${m % 60}m`;
    }

    // Try to inject into the top-bar stat area
    function injectTimer() {
      const statsRow = document.querySelector('.hud-stats, .top-stats, #msgCount, .stat-row');
      if (!statsRow) return false;
      const wrap = statsRow.closest('div') || statsRow.parentElement;
      if (!wrap || document.getElementById('sessionTimerEl')) return false;
      const el = document.createElement('span');
      el.id = 'sessionTimerEl';
      el.innerHTML = `<span>⏱</span><span class="sti" id="sessionTimerVal">0m</span>`;
      wrap.appendChild(el);
      return true;
    }

    // Tick every 30s
    function tick() {
      const val = document.getElementById('sessionTimerVal');
      if (val) val.textContent = formatElapsed(Date.now() - sessionStart);
    }

    const ready = injectTimer();
    if (!ready) setTimeout(() => { injectTimer(); tick(); }, 2000);
    tick();
    setInterval(tick, 30_000);
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ 29. NETWORK QUALITY INDICATOR
  //   A tiny dot in the corner shows: green (online), amber (slow/
  //   2G), red (offline). Uses navigator.connection where available
  //   and falls back to online/offline events.
  // ─────────────────────────────────────────────────────────────────
  function installNetworkIndicator() {
    const style = document.createElement('style');
    style.textContent = `
      #netIndicator {
        position: fixed; bottom: 10px; left: 10px; z-index: 8500;
        display: flex; align-items: center; gap: 6px;
        font-family: var(--font-hud, monospace);
        font-size: 8px; letter-spacing: 0.12em;
        background: rgba(6,6,26,0.7); backdrop-filter: blur(6px);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 99px; padding: 4px 10px;
        opacity: 0; transition: opacity 0.3s;
        pointer-events: none;
        color: var(--text-lo, #3d3060);
      }
      #netIndicator.visible { opacity: 1; }
      #netDot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #34d399; flex-shrink: 0;
        transition: background 0.4s;
        box-shadow: 0 0 6px currentColor;
      }
      #netDot.slow   { background: var(--gold, #fbbf24); }
      #netDot.offline{ background: var(--crimson-bright, #ec2d5a); animation: netPulse 1s ease infinite; }
      @keyframes netPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    `;
    document.head.appendChild(style);

    const el  = document.createElement('div');
    el.id     = 'netIndicator';
    el.innerHTML = `<span id="netDot"></span><span id="netLabel">ONLINE</span>`;
    document.body.appendChild(el);

    const dot   = document.getElementById('netDot');
    const label = document.getElementById('netLabel');
    let hideTimer;

    function update() {
      clearTimeout(hideTimer);
      el.classList.add('visible');

      if (!navigator.onLine) {
        dot.className   = 'offline';
        label.textContent = 'OFFLINE';
        if (window.showToast) showToast('⚠ No internet connection', '🔴', 4000);
      } else {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        const type = conn?.effectiveType || '4g';
        const slow = ['slow-2g','2g'].includes(type);
        dot.className     = slow ? 'slow' : '';
        label.textContent = slow ? 'SLOW' : 'ONLINE';
      }

      hideTimer = setTimeout(() => el.classList.remove('visible'), navigator.onLine ? 3000 : 99999);
    }

    window.addEventListener('online',  update);
    window.addEventListener('offline', update);

    // Also react to Network Information API changes
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    conn?.addEventListener('change', update);
  }


  // ─────────────────────────────────────────────────────────────────
  // ◈ INIT — Wave 2
  // ─────────────────────────────────────────────────────────────────
  function initWave2() {
    installReadReceipts();
    installSmartSendBtn();
    installAutoExpandTextarea();
    installShortcutSheet();
    installHTMLExport();
    installSoundEffects();
    installRelativeTimestamps();
    installDraftAutoSave();
    installPinchZoom();
    installNetworkIndicator();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWave2);
  } else {
    setTimeout(initWave2, 0);
  }

})();