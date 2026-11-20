import { postMicEvent, postMicRecovered } from './api.js';

const CAUSES = new Set([
  'no_mic', 'chrome_block', 'os_block', 'busy', 'hw_mute',
  'dead_device', 'device_lost', 'too_quiet', 'overconstrained',
]);

const DEDUPE_MS = 5 * 60 * 1000;
const episodes = Object.create(null);
let pageSessionId = '';

function browserFamily() {
  const ua = navigator.userAgent || '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

function osFamily() {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Mac OS|Macintosh/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

export function micPageSessionId() {
  if (!pageSessionId) {
    try {
      pageSessionId = (crypto.randomUUID || (() => `m${Date.now()}`))()
        .replace(/[^A-Za-z0-9-]/g, '')
        .slice(0, 64);
    } catch (_) {
      pageSessionId = `m${Date.now()}`;
    }
  }
  return pageSessionId;
}

export async function classifyMicFailure(err, track) {
  const name = String((err && (err.name || err.code)) || '');
  const message = String((err && err.message) || err || '');
  let perm = '';
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'microphone' });
      perm = String(status?.state || '');
    }
  } catch (_) {}

  if (name === 'NotFoundError' || /requested device not found|no microphone/i.test(message)) {
    return 'no_mic';
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || perm === 'denied') {
    return 'chrome_block';
  }
  if (name === 'NotReadableError' || /could not start audio source|busy/i.test(message)) {
    return 'busy';
  }
  if (name === 'OverconstrainedError') return 'overconstrained';
  if (track && (track.muted === true || track.readyState === 'ended')) return 'hw_mute';
  if (/os|system/i.test(message) && /permission|denied|block/i.test(message)) return 'os_block';
  return 'chrome_block';
}

function openEpisode(cause, now) {
  const open = episodes[cause];
  if (!open || open.recovered) return null;
  if ((now - open.startedAt) >= DEDUPE_MS) return null;
  return open;
}

function hebrewHint(cause) {
  const map = {
    no_mic: 'לא נמצא מיקרופון. חברו מיקרופון ונסו שוב.',
    chrome_block: 'Chrome חוסם את המיקרופון. אפשרו גישה למיקרופון בהרחבה ובאתר.',
    os_block: 'מערכת ההפעלה חוסמת את המיקרופון. בדקו את הרשאות הפרטיות.',
    busy: 'המיקרופון בשימוש באפליקציה אחרת.',
    hw_mute: 'המיקרופון מושתק בחומרה.',
    dead_device: 'המיקרופון הפסיק לעבוד.',
    device_lost: 'המיקרופון נותק.',
    too_quiet: 'האודיו חלש מדי — בדקו את המיקרופון.',
    overconstrained: 'המכשיר השמור אינו זמין. בחרו מיקרופון אחר.',
  };
  return map[cause] || 'בעיית מיקרופון. נסו שוב.';
}

export function micUserMessage(cause) {
  return hebrewHint(cause);
}

export function logMicEvent(cause, phase, deviceLabel = '') {
  if (!CAUSES.has(cause) || (phase !== 'start' && phase !== 'recording')) return;
  const now = Date.now();
  if (openEpisode(cause, now)) return;
  if (phase === 'recording' && cause !== 'device_lost' && openEpisode('device_lost', now)) return;

  const episode = {
    id: '',
    startedAt: now,
    phase,
    recovered: false,
    recoverySent: false,
    pendingRecovery: false,
    recoverySeconds: 0,
  };
  episodes[cause] = episode;

  void (async () => {
    try {
      const data = await postMicEvent({
        cause,
        phase,
        browser_family: browserFamily(),
        os_family: osFamily(),
        device_label: String(deviceLabel || '').slice(0, 120) || null,
        session_id: micPageSessionId(),
      });
      const id = data?.id ? String(data.id) : '';
      if (!id || episodes[cause] !== episode) return;
      episode.id = id;
      if (episode.pendingRecovery) sendRecovery(episode);
    } catch (_) {}
  })();
}

function sendRecovery(episode) {
  if (!episode || !episode.id || episode.recoverySent) return;
  episode.recoverySent = true;
  void postMicRecovered(episode.id, episode.recoverySeconds).catch(() => {});
}

export function markMicRecovered() {
  const now = Date.now();
  Object.keys(episodes).forEach((cause) => {
    const open = episodes[cause];
    if (!open || open.recovered || open.phase !== 'recording') return;
    open.recovered = true;
    open.recoverySeconds = Math.max(0, Math.round((now - open.startedAt) / 1000));
    if (open.id) sendRecovery(open);
    else open.pendingRecovery = true;
  });
}
