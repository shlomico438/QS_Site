/**
 * Tonor G11 (and compatible) WebHID mute-button helper.
 *
 * The mic keeps streaming; the hardware mute key sends a HID input report.
 * Example mute-press report (16 bytes):
 *   [8, 0, 0, 0, 0, 0, 0, 0, 0, 4, 15, 0, 0, 0, 0, 0]
 */

export type MuteToggleCallback = (muted: boolean) => void;

/** Known mute-button press report from Tonor G11. */
export const TONOR_MUTE_PRESS_REPORT = [
  8, 0, 0, 0, 0, 0, 0, 0, 0, 4, 15, 0, 0, 0, 0, 0,
] as const;

type HIDDeviceLike = HIDDevice;

let device: HIDDeviceLike | null = null;
let muted = false;
let pressed = false;
const listeners = new Set<MuteToggleCallback>();
let inputHandler: ((event: HIDInputReportEvent) => void) | null = null;

function reportToBytes(reportId: number, data: DataView): number[] {
  const payload: number[] = [];
  for (let i = 0; i < data.byteLength; i++) payload.push(data.getUint8(i));
  // Some dumps include report id as byte 0; WebHID usually passes it separately.
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
  // reportId stripped: data alone matches the example without leading 8
  if (reportId === 8) {
    const withoutId = TONOR_MUTE_PRESS_REPORT.slice(1);
    if (bytesEqual(Array.from({ length: data.byteLength }, (_, i) => data.getUint8(i)), withoutId)) {
      return true;
    }
  }
  // Distinctive non-zero pair at example offsets 9/10 (with report id in buffer).
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

function onInputReport(event: HIDInputReportEvent): void {
  const isPress = isTonorMutePressReport(event.reportId, event.data);
  if (isPress) {
    if (pressed) return; // hold / repeat
    pressed = true;
    notify(!muted);
    return;
  }
  // Any other report (typically all-zero release) clears the press latch.
  pressed = false;
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
  pressed = false;
}

async function openDevice(dev: HIDDeviceLike): Promise<HIDDeviceLike> {
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
 */
export async function connectTonorHID(): Promise<HIDDeviceLike | null> {
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

  const filters: HIDDeviceFilter[] = [
    // Broad filters — Tonor often exposes vendor-specific + consumer collections.
    { usagePage: 0x0b }, // Telephony
    { usagePage: 0x0c }, // Consumer Control
    { usagePage: 0xff00 }, // Vendor-defined
  ];

  let picked = await navigator.hid.requestDevice({ filters });
  if (!picked || !picked.length) {
    // Fallback: show all HID devices if usage filters miss the G11 interface.
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

export function getTonorHIDDevice(): HIDDeviceLike | null {
  return device;
}

export async function disconnectTonorHID(): Promise<void> {
  detachDevice();
}

/** Reset internal mute latch without disconnecting (e.g. new recording session). */
export function resetTonorMuteState(initialMuted = false): void {
  muted = !!initialMuted;
  pressed = false;
}
