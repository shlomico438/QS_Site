/**
 * Tonor G11 (and compatible) WebHID mute-button helper.
 *
 * The mic keeps streaming; the hardware mute key sends a HID input report.
 * Example mute-press report (16 bytes):
 *   [8, 0, 0, 0, 0, 0, 0, 0, 0, 4, 15, 0, 0, 0, 0, 0]
 *
 * Source of truth: tonor_hid.ts
 */

/** @typedef {(muted: boolean) => void} MuteToggleCallback */

/** Known mute-button press report from Tonor G11. */
export const TONOR_MUTE_PRESS_REPORT = Object.freeze([
  8, 0, 0, 0, 0, 0, 0, 0, 0, 4, 15, 0, 0, 0, 0, 0,
]);

/** @type {HIDDevice | null} */
let device = null;
let muted = false;
let pressed = false;
/** @type {Set<MuteToggleCallback>} */
const listeners = new Set();
/** @type {((event: HIDInputReportEvent) => void) | null} */
let inputHandler = null;

/**
 * @param {number} reportId
 * @param {DataView} data
 * @returns {number[]}
 */
function reportToBytes(reportId, data) {
  const payload = [];
  for (let i = 0; i < data.byteLength; i++) payload.push(data.getUint8(i));
  if (reportId && (payload.length === 0 || payload[0] !== reportId)) {
    return [reportId, ...payload];
  }
  return payload;
}

/**
 * @param {number[]} a
 * @param {readonly number[]} b
 */
function bytesEqual(a, b) {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * True when this report is a mute-button press (not release / idle).
 * @param {number} reportId
 * @param {DataView} data
 */
export function isTonorMutePressReport(reportId, data) {
  const bytes = reportToBytes(reportId, data);
  if (bytesEqual(bytes, TONOR_MUTE_PRESS_REPORT)) return true;
  if (reportId === 8) {
    const withoutId = TONOR_MUTE_PRESS_REPORT.slice(1);
    const payload = [];
    for (let i = 0; i < data.byteLength; i++) payload.push(data.getUint8(i));
    if (bytesEqual(payload, withoutId)) return true;
  }
  if (bytes.length >= 11 && bytes[0] === 8 && bytes[9] === 4 && bytes[10] === 15) return true;
  return false;
}

/** @param {boolean} nextMuted */
function notify(nextMuted) {
  muted = nextMuted;
  listeners.forEach((cb) => {
    try {
      cb(muted);
    } catch (err) {
      console.warn('[tonor-hid] mute callback error', err);
    }
  });
}

/** @param {HIDInputReportEvent} event */
function onInputReport(event) {
  const isPress = isTonorMutePressReport(event.reportId, event.data);
  if (isPress) {
    if (pressed) return;
    pressed = true;
    notify(!muted);
    return;
  }
  pressed = false;
}

function detachDevice() {
  if (device && inputHandler) {
    try {
      device.removeEventListener('inputreport', inputHandler);
    } catch (_) {}
  }
  inputHandler = null;
  if (device && device.opened) {
    try {
      void device.close();
    } catch (_) {}
  }
  device = null;
  pressed = false;
}

/**
 * @param {HIDDevice} dev
 * @returns {Promise<HIDDevice>}
 */
async function openDevice(dev) {
  if (!dev.opened) await dev.open();
  detachDevice();
  device = dev;
  inputHandler = onInputReport;
  device.addEventListener('inputreport', inputHandler);
  return device;
}

/**
 * Connect to a Tonor (or previously permitted) HID mute interface.
 * Uses getDevices() when already authorized; otherwise opens the chooser (needs a user gesture).
 * @returns {Promise<HIDDevice | null>}
 */
export async function connectTonorHID() {
  if (typeof navigator === 'undefined' || !navigator.hid) {
    console.warn('[tonor-hid] WebHID is not available in this browser');
    return null;
  }

  if (device && device.opened) return device;

  const existing = await navigator.hid.getDevices();
  const known =
    existing.find((d) => /tonor/i.test(String(d.productName || ''))) ||
    (existing.length === 1 ? existing[0] : null);

  if (known) {
    try {
      return await openDevice(known);
    } catch (err) {
      console.warn('[tonor-hid] failed to reopen granted device', err);
    }
  }

  const filters = [
    { usagePage: 0x0b },
    { usagePage: 0x0c },
    { usagePage: 0xff00 },
  ];

  let picked = await navigator.hid.requestDevice({ filters });
  if (!picked || !picked.length) {
    picked = await navigator.hid.requestDevice({ filters: [] });
  }
  const chosen = picked && picked[0];
  if (!chosen) return null;
  return openDevice(chosen);
}

/**
 * Register a listener. callback(true) = hardware mute ON, callback(false) = OFF.
 * @param {MuteToggleCallback} callback
 * @returns {() => void} unsubscribe
 */
export function onMuteToggle(callback) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function isTonorMuted() {
  return muted;
}

export function getTonorHIDDevice() {
  return device;
}

export async function disconnectTonorHID() {
  detachDevice();
}

/**
 * Reset internal mute latch without disconnecting (e.g. new recording session).
 * @param {boolean} [initialMuted=false]
 */
export function resetTonorMuteState(initialMuted = false) {
  muted = !!initialMuted;
  pressed = false;
}
