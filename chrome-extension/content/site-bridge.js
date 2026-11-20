(() => {
  if (window.__qsMedicalSiteBridge) return;
  window.__qsMedicalSiteBridge = true;

  const PROJECT_REF = 'vojesnnvehecenjymrko';
  const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
  const COOKIE_PREFIX = 'qs_sb_auth_';

  function normalize(session, user) {
    if (!session?.access_token || !session?.refresh_token) return null;
    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: Number(session.expires_at || 0)
        || (Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600)),
      user: session.user || user || null,
      source: 'website',
    };
  }

  function parseSession(raw) {
    if (!raw) return null;
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return normalize(data?.currentSession || data?.session || data, data?.user);
    } catch (_) {
      return null;
    }
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    for (const part of String(document.cookie || '').split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) {
        try {
          return decodeURIComponent(trimmed.slice(prefix.length));
        } catch (_) {
          return trimmed.slice(prefix.length);
        }
      }
    }
    return null;
  }

  function readCookieChunks(key) {
    try {
      const encoded = encodeURIComponent(String(key || ''));
      const base = `${COOKIE_PREFIX}${encoded}`;
      const count = Number(readCookie(`${base}.chunks`) || 0);
      if (!Number.isFinite(count) || count <= 0 || count > 30) return '';
      let value = '';
      for (let i = 0; i < count; i += 1) {
        const chunk = readCookie(`${base}.${i}`);
        if (chunk == null) return '';
        value += chunk;
      }
      return value;
    } catch (_) {
      return '';
    }
  }

  async function exportWebsiteSession() {
    try {
      if (window.supabase?.auth?.getSession) {
        const { data } = await window.supabase.auth.getSession();
        const session = normalize(data?.session, data?.session?.user);
        if (session) {
          return { ok: true, session, host: location.hostname, via: 'supabase' };
        }
      }
    } catch (_) {}

    let raw = '';
    try { raw = localStorage.getItem(STORAGE_KEY) || ''; } catch (_) {}
    let session = parseSession(raw);
    if (!session) session = parseSession(readCookieChunks(STORAGE_KEY));
    return {
      ok: !!session,
      session,
      host: location.hostname,
      via: session ? 'storage' : 'none',
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'qs_export_website_session') return;
    exportWebsiteSession()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  });
})();
