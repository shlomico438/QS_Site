/** Side panel mic prompts are flaky — open a tiny grant window when needed. */

let grantInFlight = null;

export async function ensureMicPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('media_devices_unavailable');
    err.name = 'NotAllowedError';
    throw err;
  }

  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
      new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error('mic_prompt_timeout'), { name: 'NotAllowedError' })), 2500);
      }),
    ]);
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (_) {
    // Fall through to popup grant flow.
  }

  if (grantInFlight) return grantInFlight;

  grantInFlight = (async () => {
    const url = chrome.runtime.getURL('permission.html');
    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: 420,
      height: 240,
      focused: true,
    });
    const windowId = win?.id;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 60000);
      const onRemoved = (id) => {
        if (id !== windowId) return;
        clearTimeout(timer);
        chrome.windows.onRemoved.removeListener(onRemoved);
        resolve();
      };
      chrome.windows.onRemoved.addListener(onRemoved);
    });

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  })().finally(() => {
    grantInFlight = null;
  });

  return grantInFlight;
}
