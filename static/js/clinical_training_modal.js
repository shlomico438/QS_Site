/**
 * ClinicalTrainingModal  — premium AI-style loader
 * -------------------------------------------------
 * Public API:
 *   showClinicalTrainingModal()   — mounts and starts the modal
 *   hideClinicalTrainingModal()   — removes the modal (fade-out)
 */

(function (global) {
    'use strict';

    const MODAL_ID        = 'qs-clinical-training-modal';
    const PHRASE_INTERVAL = 17000;   // ms between phrase rotations
    const FADE_DURATION   = 600;     // ms for phrase fade transition

    const PHRASES = [
        'ברוב המקרים, סבב למידה אחד מספיק להשגת דיוק מרבי.',
        'ניתן להוסיף סבבי למידה בעתיד כדי להמשיך ולדייק את המערכת.',
        'מנתח את מבנה המסמך והמונחים הקליניים...',
        'מזהה את דפוסי הכתיבה הייחודיים לך...',
        'לומד את העדפות הניסוח והדגשים המקצועיים שלך...',
        'מבצע סנכרון בין המידע הרפואי לסגנון התיעוד המבוקש...',
        'מייצר מודל שפה מותאם אישית כדי לחסוך לך זמן בהמשך...',
        'מבצע דיוק אחרון לניסוח...',
    ];

    /* ------------------------------------------------------------------ */
    /* CSS                                                                   */
    /* ------------------------------------------------------------------ */
    const CSS = `
#${MODAL_ID} {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
        radial-gradient(circle at 48% 38%, rgba(20,184,166,0.14), transparent 34%),
        rgba(4, 18, 30, 0.58);
    backdrop-filter: blur(20px) saturate(170%);
    -webkit-backdrop-filter: blur(20px) saturate(170%);
    animation: qs-ctm-overlay-in 0.3s cubic-bezier(0.22,1,0.36,1) both;
}
@keyframes qs-ctm-overlay-in {
    from { opacity: 0; }
    to   { opacity: 1; }
}

/* ── Glass card ─────────────────────────────────────────────────────────── */
#${MODAL_ID} .qs-ctm-box {
    background: rgba(255,255,255,0.68);
    backdrop-filter: blur(30px) saturate(190%);
    -webkit-backdrop-filter: blur(30px) saturate(190%);
    border: 1px solid rgba(255,255,255,0.52);
    border-radius: 26px;
    padding: 50px 44px 44px;
    max-width: 430px;
    width: 90vw;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;
    direction: rtl;
    text-align: center;
    animation: qs-ctm-card-in 0.4s cubic-bezier(0.22,1,0.36,1) both;
    animation-delay: 0.05s;
}
@keyframes qs-ctm-card-in {
    from { opacity: 0; transform: translateY(16px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)   scale(1);    }
}

/* ── Title ──────────────────────────────────────────────────────────────── */
#${MODAL_ID} .qs-ctm-title {
    font-size: 1.13rem;
    font-weight: 700;
    color: #0f766e;
    line-height: 1.5;
    letter-spacing: -0.01em;
}

/* ── Luminous AI orb ────────────────────────────────────────────────────── */
#${MODAL_ID} .qs-ctm-spinner-wrap {
    position: relative;
    width: 118px;
    height: 118px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    filter: drop-shadow(0 0 18px rgba(20,184,166,0.34));
}

#${MODAL_ID} .qs-ctm-orb {
    position: absolute;
    inset: 5px;
    border-radius: 48% 52% 56% 44% / 45% 55% 45% 55%;
    overflow: hidden;
    animation:
        qs-ctm-orb-breathe 4.2s cubic-bezier(0.45,0,0.2,1) infinite,
        qs-ctm-orb-shape 7.5s cubic-bezier(0.45,0,0.2,1) infinite;
}

#${MODAL_ID} .qs-ctm-orb::before {
    content: '';
    position: absolute;
    inset: -34%;
    background:
        conic-gradient(
            from 0deg,
            rgba(15,118,110,0.04) 0deg,
            rgba(94,234,212,0.76) 86deg,
            rgba(15,118,110,0.92) 150deg,
            rgba(167,243,208,0.30) 230deg,
            rgba(15,118,110,0.05) 360deg
        );
    filter: blur(18px);
    animation:
        qs-ctm-orb-rotate 9s cubic-bezier(0.65,0,0.35,1) infinite,
        qs-ctm-orb-fill ${PHRASE_INTERVAL}ms cubic-bezier(0.22,1,0.36,1) infinite;
}

#${MODAL_ID} .qs-ctm-orb::after {
    content: '';
    position: absolute;
    inset: 12%;
    border-radius: inherit;
    background:
        radial-gradient(circle at 34% 28%, rgba(255,255,255,0.90), transparent 18%),
        radial-gradient(circle at 62% 68%, rgba(94,234,212,0.48), transparent 44%),
        radial-gradient(circle at 50% 50%, rgba(15,118,110,0.34), rgba(15,118,110,0.10) 58%, transparent 74%);
    filter: blur(5px);
    opacity: 0.96;
}

#${MODAL_ID} .qs-ctm-orb-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0.82;
    mix-blend-mode: screen;
    animation: qs-ctm-svg-drift 6s cubic-bezier(0.45,0,0.2,1) infinite;
}

#${MODAL_ID} .qs-ctm-pulse-dot {
    position: absolute;
    width: 5px;
    height: 5px;
    border-radius: 999px;
    background: rgba(255,255,255,0.94);
    filter: drop-shadow(0 0 10px rgba(20,184,166,0.78));
    animation: qs-ctm-dot-pulse 4.2s cubic-bezier(0.45,0,0.2,1) infinite;
}

@keyframes qs-ctm-orb-breathe {
    0%,100% { transform: scale(0.94); opacity: 0.78; }
    50%     { transform: scale(1.06); opacity: 1; }
}
@keyframes qs-ctm-orb-shape {
    0%,100% { border-radius: 48% 52% 56% 44% / 45% 55% 45% 55%; }
    33%     { border-radius: 57% 43% 46% 54% / 52% 40% 60% 48%; }
    66%     { border-radius: 43% 57% 52% 48% / 40% 58% 42% 60%; }
}
@keyframes qs-ctm-orb-rotate {
    0%   { transform: rotate(0deg) scale(0.98); }
    48%  { transform: rotate(190deg) scale(1.04); }
    100% { transform: rotate(360deg) scale(0.98); }
}
@keyframes qs-ctm-orb-fill {
    0%   { opacity: 0.52; clip-path: circle(42% at 50% 50%); }
    55%  { opacity: 0.86; clip-path: circle(58% at 50% 50%); }
    100% { opacity: 0.62; clip-path: circle(74% at 50% 50%); }
}
@keyframes qs-ctm-svg-drift {
    0%,100% { transform: translate3d(-2px, 1px, 0) scale(0.98); opacity: 0.72; }
    50%     { transform: translate3d(2px, -2px, 0) scale(1.04); opacity: 0.92; }
}
@keyframes qs-ctm-dot-pulse {
    0%,100% { transform: scale(0.82); opacity: 0.56; }
    50%     { transform: scale(1.32); opacity: 1; }
}

/* ── Phrase area ────────────────────────────────────────────────────────── */
#${MODAL_ID} .qs-ctm-phrase-wrap {
    min-height: 3.4em;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
}
#${MODAL_ID} .qs-ctm-phrase {
    font-size: 0.875rem;
    color: #334155;
    line-height: 1.7;
    transition: opacity ${FADE_DURATION}ms ease;
}
#${MODAL_ID} .qs-ctm-phrase-hidden {
    opacity: 0 !important;
}
`;

    /* ------------------------------------------------------------------ */
    /* Luminous orb markup                                                   */
    /* ------------------------------------------------------------------ */
    const ORB_MARKUP = `
<div class="qs-ctm-orb" aria-hidden="true">
  <svg class="qs-ctm-orb-svg" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="qs-ctm-orb-light" cx="40%" cy="32%" r="66%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
        <stop offset="38%" stop-color="#5eead4" stop-opacity="0.58"/>
        <stop offset="72%" stop-color="#0f766e" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="#0f766e" stop-opacity="0"/>
      </radialGradient>
      <filter id="qs-ctm-orb-blur" x="-35%" y="-35%" width="170%" height="170%">
        <feGaussianBlur stdDeviation="11"/>
      </filter>
    </defs>
    <path
      d="M61 11C82 12 104 29 108 53C112 76 95 102 69 108C43 115 17 99 12 72C7 46 24 14 61 11Z"
      fill="url(#qs-ctm-orb-light)"
      filter="url(#qs-ctm-orb-blur)"
    />
  </svg>
</div>
<div class="qs-ctm-pulse-dot" aria-hidden="true"></div>
`;

    /* ------------------------------------------------------------------ */
    /* Style injection                                                       */
    /* ------------------------------------------------------------------ */
    function _injectStyles() {
        if (document.getElementById('qs-ctm-styles')) return;
        const style = document.createElement('style');
        style.id = 'qs-ctm-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ */
    /* Build DOM                                                             */
    /* ------------------------------------------------------------------ */
    function _buildModal() {
        const overlay = document.createElement('div');
        overlay.id = MODAL_ID;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'מגבשים את סגנון הסיכום האישי שלך');

        overlay.innerHTML = `
            <div class="qs-ctm-box">
                <div class="qs-ctm-title">מגבשים את סגנון הסיכום האישי שלך...</div>
                <div class="qs-ctm-spinner-wrap">${ORB_MARKUP}</div>
                <div class="qs-ctm-phrase-wrap">
                    <div class="qs-ctm-phrase">${PHRASES[0]}</div>
                </div>
            </div>`;
        return overlay;
    }

    /* ------------------------------------------------------------------ */
    /* Phrase rotation                                                       */
    /* ------------------------------------------------------------------ */
    let _phraseIndex = 0;
    let _rotateTimer = null;

    function _startPhraseRotation(overlay) {
        const phraseEl = overlay.querySelector('.qs-ctm-phrase');
        _phraseIndex = 0;

        _rotateTimer = setInterval(() => {
            if (!phraseEl) return;
            phraseEl.classList.add('qs-ctm-phrase-hidden');

            setTimeout(() => {
                _phraseIndex = (_phraseIndex + 1) % PHRASES.length;
                phraseEl.textContent = PHRASES[_phraseIndex];
                phraseEl.classList.remove('qs-ctm-phrase-hidden');
            }, FADE_DURATION);
        }, PHRASE_INTERVAL);
    }

    function _stopPhraseRotation() {
        if (_rotateTimer) { clearInterval(_rotateTimer); _rotateTimer = null; }
    }

    /* ------------------------------------------------------------------ */
    /* Public API                                                            */
    /* ------------------------------------------------------------------ */
    global.showClinicalTrainingModal = function showClinicalTrainingModal() {
        if (document.getElementById(MODAL_ID)) return;
        _injectStyles();
        const overlay = _buildModal();
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        _startPhraseRotation(overlay);
    };

    global.hideClinicalTrainingModal = function hideClinicalTrainingModal() {
        _stopPhraseRotation();
        const overlay = document.getElementById(MODAL_ID);
        if (!overlay) return;
        overlay.style.transition = 'opacity 0.35s ease';
        overlay.style.opacity = '0';
        setTimeout(() => {
            const el = document.getElementById(MODAL_ID);
            if (el) el.remove();
            document.body.style.overflow = '';
        }, 350);
    };

})(window);
