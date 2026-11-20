import { API_BASE, LOCAL_API_BASE, STORAGE_KEYS } from './config.js';
import {
  getCurrentUser,
  signInWithPassword,
  signOut,
  tryImportSessionFromOpenSite,
} from './lib/auth.js';
import { normalizeApiBase, resolveApiBase, setApiBase } from './lib/api.js';
import { VisitSession } from './lib/session.js';

const els = {
  authView: document.getElementById('auth-view'),
  appView: document.getElementById('app-view'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  loginBtn: document.getElementById('login-btn'),
  importBtn: document.getElementById('import-btn'),
  importStatus: document.getElementById('import-status'),
  logoutBtn: document.getElementById('logout-btn'),
  authError: document.getElementById('auth-error'),
  globalError: document.getElementById('global-error'),
  userEmail: document.getElementById('user-email'),
  status: document.getElementById('status'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  live: document.getElementById('live-transcript'),
  chief: document.getElementById('sec-chief'),
  exam: document.getElementById('sec-exam'),
  rec: document.getElementById('sec-rec'),
  fillBtn: document.getElementById('fill-btn'),
  fillStatus: document.getElementById('fill-status'),
  apiBase: document.getElementById('api-base'),
  saveApiBtn: document.getElementById('save-api-btn'),
  extId: document.getElementById('ext-id'),
  level: document.getElementById('level'),
};

let latestSections = null;
let session = null;

function showError(el, message) {
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setStatus(text) {
  els.status.textContent = text || '';
}

function setBusy(recording) {
  els.startBtn.disabled = recording;
  els.stopBtn.disabled = !recording;
}

function renderSections(sections) {
  latestSections = sections || null;
  els.chief.value = sections?.medical_chief_complaint || '';
  els.exam.value = sections?.medical_examination_transcript || '';
  els.rec.value = sections?.medical_patient_recommendations || '';
  els.fillBtn.disabled = !sections;
}

async function showApp(user) {
  els.authView.classList.add('hidden');
  els.appView.classList.remove('hidden');
  els.userEmail.textContent = user?.email || '';
  showError(els.authError, '');
  showError(els.globalError, '');
}

function showAuth() {
  els.appView.classList.add('hidden');
  els.authView.classList.remove('hidden');
  setBusy(false);
  renderSections(null);
  els.live.textContent = '';
}

async function refreshAuth({ tryImport = false, forceImport = false } = {}) {
  let user = forceImport ? null : await getCurrentUser();
  if ((!user && tryImport) || forceImport) {
    if (els.importStatus) els.importStatus.textContent = 'מחפש טאב QuickScribe פתוח…';
    let result;
    try {
      result = await tryImportSessionFromOpenSite({ force: forceImport });
    } catch (err) {
      result = { imported: false, reason: 'error', detail: String(err?.message || err) };
    }
    console.info('[qs-ext] import result', result);
    if (result.imported) {
      // Always point HTTP/Socket.IO at the same origin the session was imported from
      // (local simulation → 127.0.0.1:5000; production → getquickscribe.com).
      if (result.origin) {
        await setApiBase(result.origin);
        if (els.apiBase) els.apiBase.value = result.origin;
      }
      if (els.importStatus) {
        const base = await resolveApiBase();
        els.importStatus.textContent = `יובא מהאתר — API: ${base}`;
      }
      user = await getCurrentUser();
      if (!user && result.session) {
        user = result.session.user || { email: '' };
      }
    } else if (els.importStatus) {
      const hints = {
        no_site_tab: 'לא נמצא טאב QuickScribe פתוח. פתחו את האתר כשאתם מחוברים (אותו Chrome), ואז נסו שוב.',
        no_website_session: `נמצא טאב (${result.tabCount || 0}), אבל לא נמצאה התחברות פעילה. ודאו שאתם מחוברים באתר.${result.detail ? ` (${result.detail})` : ''}`,
        already_signed_in: '',
        error: `שגיאת ייבוא${result.detail ? `: ${result.detail}` : ''}`,
      };
      els.importStatus.textContent = hints[result.reason] || 'לא ניתן לייבא מהאתר.';
    }
  }
  if (user) await showApp(user);
  else showAuth();
}

els.importBtn?.addEventListener('click', async () => {
  showError(els.authError, '');
  els.importBtn.disabled = true;
  if (els.importStatus) els.importStatus.textContent = 'מייבא…';
  try {
    // Always re-pull from the open site so a stale extension token gets replaced.
    await refreshAuth({ tryImport: true, forceImport: true });
  } catch (err) {
    if (els.importStatus) {
      els.importStatus.textContent = `שגיאה: ${err?.message || err}`;
    }
  } finally {
    els.importBtn.disabled = false;
  }
});

els.loginBtn.addEventListener('click', async () => {
  showError(els.authError, '');
  els.loginBtn.disabled = true;
  try {
    await signInWithPassword(els.email.value, els.password.value);
    await refreshAuth();
  } catch (err) {
    showError(els.authError, err?.message || 'ההתחברות נכשלה');
  } finally {
    els.loginBtn.disabled = false;
  }
});

els.logoutBtn.addEventListener('click', async () => {
  await signOut();
  showAuth();
});

els.startBtn.addEventListener('click', async () => {
  showError(els.globalError, '');
  els.fillStatus.textContent = '';
  renderSections(null);
  els.live.textContent = '';
  setBusy(true);
  setStatus('מתחיל…');
  console.info('[qs-ext] start clicked', { apiBase: await resolveApiBase() });
  session = new VisitSession({
    onStatus: setStatus,
    onPartial: (text) => { els.live.textContent = text || ''; },
    onError: (msg) => showError(els.globalError, msg),
    onLevel: (info) => {
      const pct = Math.min(100, Math.round((info?.rms || 0) * 500));
      els.level.style.width = `${pct}%`;
    },
    onResult: (result) => {
      renderSections(result?.sections || null);
      if (result?.correctedTranscript) {
        els.live.textContent = result.correctedTranscript;
      }
    },
  });
  try {
    await session.start();
    console.info('[qs-ext] start ok');
  } catch (err) {
    console.error('[qs-ext] start failed', err);
    setBusy(false);
    setStatus('מוכן');
    showError(els.globalError, err?.message || 'לא ניתן להתחיל הקלטה');
    session = null;
  }
});

els.stopBtn.addEventListener('click', async () => {
  if (!session) return;
  els.stopBtn.disabled = true;
  try {
    await session.stop();
  } catch (err) {
    showError(els.globalError, err?.message || 'עצירה נכשלה');
    setStatus('שגיאה');
  } finally {
    setBusy(false);
    els.level.style.width = '0%';
    session = null;
  }
});

els.fillBtn.addEventListener('click', async () => {
  if (!latestSections) return;
  els.fillStatus.textContent = 'ממלא…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('no_active_tab');
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'qs_fill_clicks',
        sections: latestSections,
      });
    } catch (_) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content/clicks.js'],
      });
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'qs_fill_clicks',
        sections: latestSections,
      });
    }
    if (response?.ok) {
      const filled = response.filled || {};
      const okCount = Object.values(filled).filter(Boolean).length;
      els.fillStatus.textContent = `מולאו ${okCount} שדות בדף הפעיל.`;
    } else {
      els.fillStatus.textContent = 'לא נמצאו שדות תואמים בדף. בדקו ש-Clicks פתוח בטאב הפעיל, או העתיקו ידנית.';
    }
  } catch (err) {
    els.fillStatus.textContent = 'לא ניתן למלא את הדף. העתיקו את הטקסט ידנית.';
    console.warn('[qs-ext] fill failed', err);
  }
});

els.saveApiBtn.addEventListener('click', async () => {
  const value = await setApiBase(els.apiBase.value);
  if (els.apiBase) els.apiBase.value = value || API_BASE;
  setStatus(`API base: ${value || API_BASE}`);
});

document.getElementById('use-local-api-btn')?.addEventListener('click', async () => {
  const value = await setApiBase(LOCAL_API_BASE);
  if (els.apiBase) els.apiBase.value = value;
  setStatus(`API base: ${value}`);
});

document.getElementById('use-prod-api-btn')?.addEventListener('click', async () => {
  await setApiBase('');
  if (els.apiBase) els.apiBase.value = API_BASE;
  setStatus(`API base: ${API_BASE}`);
});

async function boot() {
  els.extId.textContent = `מזהה הרחבה: ${chrome.runtime.id}`;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.apiBase);
  const normalized = normalizeApiBase(stored[STORAGE_KEYS.apiBase] || '');
  if (normalized) {
    await setApiBase(normalized);
    els.apiBase.value = normalized;
  } else {
    els.apiBase.value = API_BASE;
  }
  await refreshAuth({ tryImport: true });
}

boot().catch((err) => {
  showError(els.globalError, err?.message || 'אתחול נכשל');
});
