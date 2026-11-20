(() => {
  if (window.__qsMedicalClicksBridge) return;
  window.__qsMedicalClicksBridge = true;

  const LABELS = {
    medical_chief_complaint: [
      'תלונה עיקרית', 'תלונה', 'סיבת פניה', 'סיבת הפניה', 'הנדון', 'אנמנזה',
      'chief complaint', 'reason for visit', 'presenting',
    ],
    medical_examination_transcript: [
      'בדיקה', 'בדיקה גופנית', 'ממצאים', 'בבדיקה', 'examination', 'findings', 'physical',
    ],
    medical_patient_recommendations: [
      'המלצות', 'המלצה', 'תוכנית', 'טיפול', 'recommendations', 'plan', 'follow',
    ],
  };

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function scoreLabel(haystack, needles) {
    const h = normalize(haystack);
    if (!h) return 0;
    let best = 0;
    for (const n of needles) {
      const needle = normalize(n);
      if (!needle) continue;
      if (h === needle) best = Math.max(best, 100);
      else if (h.includes(needle)) best = Math.max(best, 70 + Math.min(20, needle.length));
    }
    return best;
  }

  function candidateFields() {
    return Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]'))
      .filter((el) => {
        if (!el || el.disabled || el.readOnly) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
      });
  }

  function fieldContext(el) {
    const bits = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('title'),
    ];
    const label = el.closest('label');
    if (label) bits.push(label.textContent);
    const id = el.getAttribute('id');
    if (id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (forLabel) bits.push(forLabel.textContent);
    }
    const prev = el.previousElementSibling;
    if (prev) bits.push(prev.textContent);
    const parent = el.parentElement;
    if (parent) bits.push(parent.innerText?.slice(0, 200));
    return bits.filter(Boolean).join(' | ');
  }

  function setFieldValue(el, value) {
    const text = String(value || '');
    if (el.isContentEditable) {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    }
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function fillSections(sections) {
    const src = sections && typeof sections === 'object' ? sections : {};
    const fields = candidateFields();
    const filled = {};
    const used = new Set();

    Object.keys(LABELS).forEach((key) => {
      const value = String(src[key] || '').trim();
      if (!value) {
        filled[key] = false;
        return;
      }
      let best = null;
      let bestScore = 0;
      fields.forEach((el) => {
        if (used.has(el)) return;
        const score = scoreLabel(fieldContext(el), LABELS[key]);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      });
      if (best && bestScore >= 70) {
        setFieldValue(best, value);
        used.add(best);
        filled[key] = true;
      } else {
        filled[key] = false;
      }
    });

    return {
      ok: Object.values(filled).some(Boolean),
      filled,
      availableFields: fields.length,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'qs_fill_clicks') return;
    try {
      const result = fillSections(msg.sections || {});
      sendResponse(result);
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
    return true;
  });
})();
