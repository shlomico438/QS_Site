/**
 * Feature showcase carousel — shown in the transcript pane while upload/transcription runs.
 */
(function () {
    const AUTO_MS = 6500;
    const SLIDES = [
        {
            id: 'styling',
            file: 'subtitle-styling.png',
            titleKey: 'showcase_slide_styling_title',
            bodyKey: 'showcase_slide_styling_body',
            badgeKey: 'showcase_slide_styling_badge',
        },
        {
            id: 'editing',
            file: 'transcript-editing.png',
            titleKey: 'showcase_slide_editing_title',
            bodyKey: 'showcase_slide_editing_body',
            badgeKey: 'showcase_slide_editing_badge',
            mediaTall: true,
        },
        {
            id: 'translation',
            file: 'translation.png',
            titleKey: 'showcase_slide_translation_title',
            bodyKey: 'showcase_slide_translation_body',
            badgeKey: 'showcase_slide_translation_badge',
        },
        {
            id: 'export',
            file: 'export.png',
            titleKey: 'showcase_slide_export_title',
            bodyKey: 'showcase_slide_export_body',
            badgeKey: 'showcase_slide_export_badge',
        },
    ];

    let root = null;
    let dotsWrap = null;
    let index = 0;
    let timer = null;
    let bound = false;
    let running = false;

    function T(key, fallback) {
        try {
            if (typeof window.t === 'function') {
                const v = window.t(key);
                if (v && v !== key) return v;
            }
        } catch (_) {}
        return fallback || key;
    }

    function isRtl() {
        const lang = String(document.documentElement.lang || 'he').toLowerCase();
        return lang.startsWith('he') || lang.startsWith('ar') || document.documentElement.dir === 'rtl';
    }

    function imageUrlFor(slide) {
        if (!root || !slide) return '';
        const base = String(root.getAttribute('data-showcase-base') || '/static/images/showcase/');
        const normalized = base.endsWith('/') ? base : `${base}/`;
        return `${normalized}${slide.file}`;
    }

    function applySlideText() {
        if (!root) return;
        const slide = SLIDES[index];
        if (!slide) return;
        const titleEl = root.querySelector('.qs-feature-showcase-slide-title');
        const bodyEl = root.querySelector('.qs-feature-showcase-slide-body');
        const badgeEl = root.querySelector('.qs-feature-showcase-slide-badge');
        const imgEl = root.querySelector('.qs-feature-showcase-image');
        const mediaEl = root.querySelector('.qs-feature-showcase-media');
        if (titleEl) titleEl.textContent = T(slide.titleKey, '');
        if (bodyEl) bodyEl.textContent = T(slide.bodyKey, '');
        if (badgeEl) badgeEl.textContent = T(slide.badgeKey, '');
        if (mediaEl) mediaEl.classList.toggle('qs-feature-showcase-media--tall', !!slide.mediaTall);
        if (imgEl) {
            imgEl.src = imageUrlFor(slide);
            imgEl.alt = T(slide.titleKey, 'Feature preview');
        }
        root.querySelectorAll('.qs-feature-showcase-dot').forEach((dot, i) => {
            dot.classList.toggle('is-active', i === index);
            dot.setAttribute('aria-selected', i === index ? 'true' : 'false');
        });
        const kicker = root.querySelector('[data-i18n="showcase_kicker"]');
        const heading = root.querySelector('[data-i18n="showcase_title"]');
        const subtitle = root.querySelector('[data-i18n="showcase_subtitle"]');
        if (kicker) kicker.textContent = T('showcase_kicker', kicker.textContent);
        if (heading) heading.textContent = T('showcase_title', heading.textContent);
        if (subtitle) subtitle.textContent = T('showcase_subtitle', subtitle.textContent);
    }

    function goTo(nextIndex, userInitiated) {
        if (!SLIDES.length) return;
        index = ((nextIndex % SLIDES.length) + SLIDES.length) % SLIDES.length;
        applySlideText();
        if (userInitiated) restartTimer();
    }

    function step(delta) {
        goTo(index + delta, true);
    }

    function restartTimer() {
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
            const dir = isRtl() ? -1 : 1;
            goTo(index + dir, false);
        }, AUTO_MS);
    }

    function bindOnce() {
        if (bound || !root) return;
        bound = true;
        root.querySelector('.qs-feature-showcase-prev')?.addEventListener('click', () => {
            step(isRtl() ? 1 : -1);
        });
        root.querySelector('.qs-feature-showcase-next')?.addEventListener('click', () => {
            step(isRtl() ? -1 : 1);
        });
        dotsWrap?.addEventListener('click', (e) => {
            const dot = e.target.closest('.qs-feature-showcase-dot');
            if (!dot) return;
            const i = parseInt(dot.getAttribute('data-index'), 10);
            if (Number.isFinite(i)) goTo(i, true);
        });
        root.addEventListener('mouseenter', () => { if (timer) clearInterval(timer); });
        root.addEventListener('mouseleave', () => { if (root && !root.hidden) restartTimer(); });
        root.addEventListener('focusin', () => { if (timer) clearInterval(timer); });
        root.addEventListener('focusout', (e) => {
            if (!root.contains(e.relatedTarget)) restartTimer();
        });
    }

    function buildDots() {
        if (!dotsWrap) return;
        dotsWrap.innerHTML = SLIDES.map((s, i) =>
            `<button type="button" class="qs-feature-showcase-dot${i === 0 ? ' is-active' : ''}" data-index="${i}" aria-label="${T('showcase_dot_label', 'Slide')} ${i + 1}" aria-selected="${i === 0 ? 'true' : 'false'}"></button>`
        ).join('');
    }

    window.qsStartFeatureShowcase = function () {
        root = document.getElementById('qs-feature-showcase');
        if (!root) return;
        const alreadyRunning = running && !root.hidden;
        dotsWrap = root.querySelector('.qs-feature-showcase-dots');
        bindOnce();
        if (!alreadyRunning) {
            buildDots();
            index = 0;
        }
        root.hidden = false;
        root.setAttribute('aria-hidden', 'false');
        running = true;
        applySlideText();
        if (!alreadyRunning) restartTimer();
    };

    window.qsStopFeatureShowcase = function () {
        running = false;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        if (root) {
            root.hidden = true;
            root.setAttribute('aria-hidden', 'true');
        }
    };

    window.qsRefreshFeatureShowcaseI18n = function () {
        if (root && !root.hidden) applySlideText();
    };
})();
