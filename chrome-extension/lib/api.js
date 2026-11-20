import { API_BASE, EXTENSION_VERSION, STORAGE_KEYS } from '../config.js';
import { requireAccessToken } from './auth.js';

/** Origin only — never include paths like /medical. */
export function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (!/^https?:$/i.test(url.protocol)) return '';
    return url.origin;
  } catch (_) {
    return raw.replace(/\/$/, '').replace(/\/medical\/?$/i, '');
  }
}

export async function resolveApiBase() {
  const row = await chrome.storage.local.get(STORAGE_KEYS.apiBase);
  const custom = normalizeApiBase(row[STORAGE_KEYS.apiBase] || '');
  return custom || API_BASE;
}

export async function setApiBase(origin) {
  const value = normalizeApiBase(origin);
  if (!value) {
    await chrome.storage.local.remove(STORAGE_KEYS.apiBase);
    return '';
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.apiBase]: value });
  return value;
}

async function authHeaders(extra = {}) {
  const token = await requireAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    // Duplicate for stacks that drop Authorization on chrome-extension origins.
    'X-QS-Access-Token': token,
    ...extra,
  };
}

function friendlyHttpError(status, data, url) {
  const raw = String(data?.error || data?.message || '').trim();
  if (raw === 'extension_origin_not_allowed') {
    return `השרת לא מאשר את ההרחבה. הוסיפו ל-MEDICAL_EXTENSION_IDS את: ${chrome.runtime.id}`;
  }
  if (raw === 'medical_auth_required' || status === 401) {
    return (
      'אין הרשאת התחברות לשרת (medical_auth_required). '
      + 'לחצו «ייבא מהאתר הפתוח» מחדש כש־QuickScribe מחובר, או התחברו ידנית. '
      + `API base צריך להיות רק המקור, למשל http://127.0.0.1:8000 (בלי /medical).`
    );
  }
  if (status === 404) {
    return (
      `הנתיב לא נמצא בשרת (${url}). `
      + 'API base חייב להיות origin בלבד, למשל http://127.0.0.1:8000 — בלי /medical. '
      + 'אם זה פרודקשן, ה־API של ההרחבה עדיין לא מפורסם שם.'
    );
  }
  if (raw && !/requested URL was not found/i.test(raw)) return raw;
  return `http_${status}${url ? ` @ ${url}` : ''}`;
}

async function parseJson(res, url = '') {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(friendlyHttpError(res.status, data, url || res.url || ''));
    err.status = res.status;
    err.payload = data;
    err.url = url || res.url || '';
    throw err;
  }
  return data;
}

async function fetchWithTimeout(url, options, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`timeout_${options?.method || 'GET'}_${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiGet(path) {
  const base = await resolveApiBase();
  const url = `${base}${path}`;
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: await authHeaders(),
    cache: 'no-store',
  });
  return parseJson(res, url);
}

export async function apiPostJson(path, body, { timeoutMs = 20000 } = {}) {
  const base = await resolveApiBase();
  const url = `${base}${path}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
    cache: 'no-store',
  }, timeoutMs);
  return parseJson(res, url);
}

export async function fetchClientConfig() {
  return apiGet('/api/medical/client/v1/config');
}

export async function signMedicalUpload({ filename, filetype }) {
  return apiPostJson('/api/sign-s3', {
    filename,
    filetype,
    isMedical: true,
    language: 'he',
  });
}

export async function archiveRecording({ jobId, s3Key, file, filetype }) {
  const base = await resolveApiBase();
  const token = await requireAccessToken();
  const form = new FormData();
  form.append('jobId', jobId);
  form.append('s3Key', s3Key);
  form.append('filetype', filetype || file.type || 'audio/webm');
  form.append('file', file, file.name || 'recording.webm');
  const res = await fetchWithTimeout(`${base}/api/medical/archive_recording`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-QS-Access-Token': token,
    },
    body: form,
  }, 120000);
  return parseJson(res);
}

export async function recoverGaps(payload) {
  // Server gap stream can take 20–160s; keep client above that.
  return apiPostJson('/api/medical/transcribe_gaps', payload, { timeoutMs: 180000 });
}

export async function finalizeVisit(payload) {
  return apiPostJson('/api/medical/client/v1/finalize', payload, { timeoutMs: 120000 });
}

export async function processTranscript(payload) {
  return apiPostJson('/api/medical/client/v1/process', payload, { timeoutMs: 120000 });
}

export async function postMicEvent(fields) {
  return apiPostJson('/api/medical/mic-event', {
    ...fields,
    client_source: 'extension',
    client_version: EXTENSION_VERSION,
  });
}

export async function postMicRecovered(eventId, recoverySeconds) {
  return apiPostJson(`/api/medical/mic-event/${encodeURIComponent(eventId)}/recovered`, {
    recovery_seconds: recoverySeconds,
  });
}

export function socketIoUrlFromApiBase(apiBase) {
  return String(apiBase || API_BASE).replace(/\/$/, '');
}
