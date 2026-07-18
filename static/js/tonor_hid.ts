/**
 * Tonor G11 (and compatible) WebHID mute-button helper.
 *
 * The mic keeps streaming; the hardware mute key sends a HID input report.
 * Example mute-press report (16 bytes):
 *   [8, 0, 0, 0, 0, 0, 0, 0, 0, 4, 15, 0, 0, 0, 0, 0]
 */

export type MuteToggleCallback = (muted: boolean) => void;

/** Tonor USB vendor / G11 product (from WebHID). */
export const TONOR_VENDOR_ID = 3468;
export const TONOR_G11_PRODUCT_ID = 308;

/** Known mute-button press report from Tonor G11. */
export const TONOR_MUTE_PRESS_REPORT = [
  8, 0, 0, 0, 0, 0, 0, 0, 0, 4, 15, 0, 0, 0, 0, 0,
] as const;

/** Ignore duplicate press reports within this window (ms). */
const MUTE_TOGGLE_DEBOUNCE_MS = 350;

type HIDDeviceLike = HIDDevice;

let device: HIDDeviceLike | null = null;
let muted = false;
let lastToggleAt = 0;
const listeners = new Set<MuteToggleCallback>();
let inputHandler: ((event: HIDInputReportEvent) => void) | null = null;

function reportToBytes(reportId: number, data: DataView): number[] {
  const payload: number[] = [];
  for (let i = 0; i < data.byteLength; i++) payload.push(data.getUint8(i));
  if (reportId && (payload.length === 0 || payload[0] !== reportId)) {
    return [reportId, ...payload];
  }
  return payload;
}

function bytesEqual(a: number[], b: readonly number[]): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True when this report is a mute-button press (not release / idle). */
export function isTonorMutePressReport(reportId: number, data: DataView): boolean {
  const bytes = reportToBytes(reportId, data);
  if (bytesEqual(bytes, TONOR_MUTE_PRESS_REPORT)) return true;
  if (reportId === 8) {
    const withoutId = TONOR_MUTE_PRESS_REPORT.slice(1);
    if (bytesEqual(Array.from({ length: data.byteLength }, (_, i) => data.getUint8(i)), withoutId)) {
      return true;
    }
  }
  if (bytes.length >= 11 && bytes[0] === 8 && bytes[9] === 4 && bytes[10] === 15) return true;
  return false;
}

function notify(nextMuted: boolean): void {
  muted = nextMuted;
  listeners.forEach((cb) => {
    try {
      cb(muted);
    } catch (err) {
      console.warn('[tonor-hid] mute callback error', err);
    }
  });
}

/**
 * G11 sends the same press report and may not send a distinct release.
 * Treat each debounced matching report as one toggle edge.
 */
function onInputReport(event: HIDInputReportEvent): void {
  if (!isTonorMutePressReport(event.reportId, event.data)) return;
  const now = Date.now();
  if (now - lastToggleAt < MUTE_TOGGLE_DEBOUNCE_MS) return;
  lastToggleAt = now;
  const next = !muted;
  console.info('[tonor-hid] mute toggle', { muted: next });
  notify(next);
}

function detachDevice(): void {
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
}

async function openDevice(dev: HIDDeviceLike): Promise<HIDDeviceLike> {
  if (!dev.opened) await dev.open();
  detachDevice();
  device = dev;
  inputHandler = onInputReport;
  device.addEventListener('inputreport', inputHandler);
  return device;
}

function isTonorDevice(d: HIDDeviceLike): boolean {
  if (!d) return false;
  if (Number(d.vendorId) === TONOR_VENDOR_ID) return true;
  return /tonor/i.test(String(d.productName || ''));
}

/**
 * Connect to a Tonor (or previously permitted) HID mute interface.
 * Uses getDevices() when already authorized; otherwise opens the chooser (needs a user gesture).
 */
export async function connectTonorHID(): Promise<HIDDeviceLike | null> {
  if (typeof navigator === 'undefined' || !navigator.hid) {
    console.warn('[tonor-hid] WebHID is not available in this browser');
    return null;
  }

  if (device && device.opened) return device;

  const existing = await navigator.hid.getDevices();
  const known =
    existing.find((d) => isTonorDevice(d)) ||
    (existing.length === 1 ? existing[0] : null);

  if (known) {
    try {
      return await openDevice(known);
    } catch (err) {
      console.warn('[tonor-hid] failed to reopen granted device', err);
    }
  }

  const filters: HIDDeviceFilter[] = [
    { vendorId: TONOR_VENDOR_ID, productId: TONOR_G11_PRODUCT_ID },
    { vendorId: TONOR_VENDOR_ID },
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

/** Register a listener. callback(true) = hardware mute ON, callback(false) = OFF. */
export function onMuteToggle(callback: MuteToggleCallback): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function isTonorMuted(): boolean {
  return muted;
}

export function isTonorHIDConnected(): boolean {
  return !!(device && device.opened);
}

export function getTonorHIDDevice(): HIDDeviceLike | null {
  return device;
}

export async function disconnectTonorHID(): Promise<void> {
  detachDevice();
}

/**
 * Reset internal mute latch without disconnecting (e.g. brand-new session).
 * Prefer not calling this on OS/track interrupt restarts — it desyncs from the physical LED.
 */
export function resetTonorMuteState(initialMuted = false): void {
  muted = !!initialMuted;
  lastToggleAt = 0;
}
