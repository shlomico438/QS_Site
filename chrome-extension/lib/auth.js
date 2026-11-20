import { SITE_ORIGIN_PATTERNS, SUPABASE_ANON_KEY, SUPABASE_URL, STORAGE_KEYS } from '../config.js';

const AUTH_URL = `${SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
const PROJECT_REF = 'vojesnnvehecenjymrko';
const SITE_AUTH_STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

const SITE_HOST_HINTS = [
  'getquickscribe.com',
  'quickscribe.co.il',
  '127.0.0.1',
  'localhost',
];

async function readSession() {
  const row = await chrome.storage.local.get(STORAGE_KEYS.session);
  const raw = row[STORAGE_KEYS.session];
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

async function writeSession(session) {
  if (!session) {
    await chrome.storage.local.remove(STORAGE_KEYS.session);
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.session]: JSON.stringify(session) });
}

function authHeaders(token) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function jwtExpiryUnix(accessToken) {
  try {
    const part = String(accessToken || '').split('.')[1] || '';
    if (!part) return 0;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded));
    return Number(json?.exp || 0) || 0;
  } catch (_) {
    return 0;
  }
}

function normalizeImportedSession(session) {
  const access = String(session?.access_token || '').trim();
  const refresh = String(session?.refresh_token || '').trim();
  if (!access || !refresh) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: jwtExpiryUnix(access)
      || Number(session.expires_at || 0)
      || (Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600)),
    user: session.user || null,
    imported_from_website: true,
  };
}

function parseStoredAuth(raw) {
  if (!raw) return null;
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalizeImportedSession(data?.currentSession || data?.session || data);
  } catch (_) {
    return null;
  }
}

function isLikelySiteTab(tab) {
  try {
    const host = new URL(tab.url || '').hostname.toLowerCase();
    return SITE_HOST_HINTS.some((hint) => host === hint || host.endsWith(`.${hint}`));
  } catch (_) {
    return false;
  }
}

async function listCandidateTabs() {
  const found = new Map();
  try {
    const byPattern = await chrome.tabs.query({ url: SITE_ORIGIN_PATTERNS });
    for (const tab of byPattern || []) {
      if (tab?.id) found.set(tab.id, tab);
    }
  } catch (_) {}

  try {
    const all = await chrome.tabs.query({});
    for (const tab of all || []) {
      if (tab?.id && isLikelySiteTab(tab)) found.set(tab.id, tab);
    }
  } catch (_) {}

  return Array.from(found.values());
}

async function extractSessionFromTab(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (storageKey) => {
        const pick = (session) => {
          if (!session?.access_token || !session?.refresh_token) return null;
          return {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: session.expires_at || 0,
            expires_in: session.expires_in || 0,
            user: session.user || null,
          };
        };

        try {
          if (window.supabase?.auth?.getSession) {
            const { data } = await window.supabase.auth.getSession();
            const session = pick(data?.session);
            if (session) {
              return { ok: true, via: 'supabase', session, host: location.hostname };
            }
          }
        } catch (_) {}

        // Scan all sb-*-auth-token keys (project ref may differ in forks).
        const keys = [storageKey];
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const k = localStorage.key(i);
            if (k && /^sb-.*-auth-token$/.test(k) && !keys.includes(k)) keys.push(k);
          }
        } catch (_) {}

        for (const key of keys) {
          let raw = '';
          try { raw = localStorage.getItem(key) || ''; } catch (_) {}
          if (!raw) continue;
          try {
            const data = JSON.parse(raw);
            const session = pick(data?.currentSession || data?.session || data);
            if (session) {
              return { ok: true, via: `localStorage:${key}`, session, host: location.hostname, raw };
            }
          } catch (_) {}
        }

        return { ok: false, via: 'none', host: location.hostname };
      },
      args: [SITE_AUTH_STORAGE_KEY],
    });

    if (result?.session) {
      return {
        ok: true,
        session: normalizeImportedSession(result.session),
        host: result.host || '',
        via: result.via || 'supabase',
      };
    }
    if (result?.raw) {
      const session = parseStoredAuth(result.raw);
      return {
        ok: !!session,
        session,
        host: result.host || '',
        via: 'localStorage',
      };
    }
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/site-bridge.js'],
      });
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'qs_export_website_session' });
      return {
        ok: !!reply?.session,
        session: normalizeImportedSession(reply?.session),
        host: reply?.host || '',
        via: 'content_script',
        error: reply?.error || null,
      };
    } catch (err2) {
      return {
        ok: false,
        session: null,
        error: String(err2?.message || err?.message || err2 || err),
      };
    }
  }
  return { ok: false, session: null, error: 'empty_extract' };
}

async function refreshIfNeeded(session, { persist = true, clearOnFailure = true, forceRefresh = false } = {}) {
  if (!session?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = jwtExpiryUnix(session.access_token) || Number(session.expires_at || 0);
  if (!forceRefresh && expiresAt && expiresAt - now > 60) {
    const normalized = { ...session, expires_at: expiresAt };
    if (persist) await writeSession(normalized);
    return normalized;
  }
  if (!session.refresh_token) {
    if (clearOnFailure) await writeSession(null);
    return null;
  }
  const res = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (clearOnFailure) await writeSession(null);
    return null;
  }
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || session.refresh_token,
    expires_at: jwtExpiryUnix(data.access_token)
      || data.expires_at
      || (Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600)),
    user: data.user || session.user || null,
    imported_from_website: !!session.imported_from_website,
  };
  if (persist) await writeSession(next);
  return next;
}

/** Confirm the access token is accepted by Supabase Auth. */
export async function validateAccessToken(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const res = await fetch(`${AUTH_URL}/user`, {
      method: 'GET',
      headers: authHeaders(token),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, reason: `supabase_user_${res.status}` };
    }
    const user = await res.json().catch(() => null);
    return { ok: true, user };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * Prefer a live token from an open QuickScribe tab (same one the website is using).
 * Falls back to extension-stored session.
 */
export async function syncFreshSessionFromOpenSite() {
  const tabs = await listCandidateTabs();
  for (const tab of tabs) {
    if (!tab?.id) continue;
    const extracted = await extractSessionFromTab(tab.id);
    if (!extracted?.session?.access_token) continue;
    const validated = await validateAccessToken(extracted.session.access_token);
    if (!validated.ok) {
      // Try refresh using the imported refresh token.
      const refreshed = await refreshIfNeeded(extracted.session, {
        persist: true,
        clearOnFailure: false,
      });
      if (!refreshed?.access_token) continue;
      const recheck = await validateAccessToken(refreshed.access_token);
      if (!recheck.ok) continue;
      if (recheck.user) refreshed.user = recheck.user;
      await writeSession(refreshed);
      let origin = '';
      try { if (tab.url) origin = new URL(tab.url).origin; } catch (_) {}
      return { ok: true, session: refreshed, origin, via: extracted.via || 'refresh' };
    }
    const session = {
      ...extracted.session,
      user: validated.user || extracted.session.user || null,
    };
    await writeSession(session);
    let origin = '';
    try { if (tab.url) origin = new URL(tab.url).origin; } catch (_) {}
    return { ok: true, session, origin, via: extracted.via || 'tab' };
  }
  return { ok: false, reason: tabs.length ? 'no_valid_tab_session' : 'no_site_tab' };
}

export async function tryImportSessionFromOpenSite({ force = false } = {}) {
  if (!force) {
    const existing = await refreshIfNeeded(await readSession());
    if (existing?.access_token) {
      const check = await validateAccessToken(existing.access_token);
      if (check.ok) {
        return { imported: false, reason: 'already_signed_in', session: existing };
      }
    }
  }

  const synced = await syncFreshSessionFromOpenSite();
  if (synced.ok) {
    return {
      imported: true,
      reason: 'imported',
      session: synced.session,
      origin: synced.origin || '',
      via: synced.via || '',
      host: '',
    };
  }

  return {
    imported: false,
    reason: synced.reason === 'no_site_tab' ? 'no_site_tab' : 'no_website_session',
    detail: synced.reason || '',
    tabCount: (await listCandidateTabs()).length,
  };
}

export async function getAccessToken() {
  // Prefer a live token from an open QuickScribe tab (same JWT the website uses).
  try {
    const synced = await syncFreshSessionFromOpenSite();
    if (synced.ok && synced.session?.access_token) {
      return synced.session.access_token;
    }
  } catch (err) {
    console.warn('[qs-ext] syncFreshSessionFromOpenSite failed', err);
  }

  const session = await refreshIfNeeded(await readSession());
  if (!session?.access_token) return null;
  const check = await validateAccessToken(session.access_token);
  if (check.ok) return session.access_token;
  // Force refresh even if expires_at looks fine.
  const refreshed = await refreshIfNeeded(session, {
    persist: true,
    clearOnFailure: true,
    forceRefresh: true,
  });
  if (!refreshed?.access_token) return null;
  const again = await validateAccessToken(refreshed.access_token);
  return again.ok ? refreshed.access_token : null;
}

export async function requireAccessToken() {
  const token = await getAccessToken();
  if (!token) throw new Error('medical_auth_required');
  return token;
}

export async function signInWithPassword(email, password) {
  const res = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      email: String(email || '').trim(),
      password: String(password || ''),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || data.error || 'login_failed');
  }
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: jwtExpiryUnix(data.access_token)
      || data.expires_at
      || (Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600)),
    user: data.user || null,
  };
  const check = await validateAccessToken(session.access_token);
  if (!check.ok) {
    throw new Error(`login_token_rejected:${check.reason}`);
  }
  await writeSession(session);
  return { session, user: session.user };
}

export async function signOut() {
  const session = await readSession();
  try {
    if (session?.access_token) {
      await fetch(`${AUTH_URL}/logout`, {
        method: 'POST',
        headers: authHeaders(session.access_token),
      });
    }
  } catch (_) {}
  await writeSession(null);
}

export async function getCurrentUser() {
  const token = await getAccessToken();
  if (!token) return null;
  const session = await readSession();
  if (session?.user?.email || session?.user?.id) return session.user;
  const check = await validateAccessToken(token);
  if (check.ok && check.user) {
    const next = { ...(session || {}), access_token: token, user: check.user };
    await writeSession(next);
    return check.user;
  }
  return session?.user || { email: '' };
}
