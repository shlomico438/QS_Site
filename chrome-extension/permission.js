const statusEl = document.getElementById('status');
const btn = document.getElementById('allow');

async function grant() {
  statusEl.textContent = 'מבקש הרשאה…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());
    statusEl.textContent = 'אושר — סוגר…';
    setTimeout(() => window.close(), 400);
  } catch (err) {
    statusEl.textContent = err?.message || 'ההרשאה נדחתה';
  }
}

btn.addEventListener('click', () => { void grant(); });
// Auto-attempt once; if Chrome needs a gesture, the button remains.
void grant();
