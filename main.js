// Адрес веб-приложения Google Apps Script (functions/lead/Code.gs), вида https://script.google.com/macros/s/…/exec.
// При новом развёртывании (не новой версии) URL меняется — тогда обновить здесь.
const FORM_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxIkgxxrK3Me3zrRh5XbbGHRoVTzVPSK2h9q6r7yIj9INRLE36B1UwytSyF94-uCg/exec';
const FORM_TIMEOUT_MS = 20000; // STANDARD §6: 20 с → состояние ошибки

// C1: меню-бургер на телефоне и планшете (до 1080 px). Без библиотек (STANDARD §8).
(() => {
  const burger = document.querySelector('.burger');
  const nav = document.getElementById('site-nav');
  if (!burger || !nav) return;

  // Подписи кнопки — в data-* разметки (STANDARD §6 v1.5: тексты интерфейса только в HTML).
  const setOpen = (open) => {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? burger.dataset.labelClose : burger.dataset.labelOpen);
    nav.classList.toggle('is-open', open);
  };

  burger.addEventListener('click', () => setOpen(burger.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      burger.focus();
    }
  });
})();

// C7: форма заявки на пилот (STANDARD §6).
(() => {
  const form = document.getElementById('pilot-form');
  if (!form) return;
  const success = document.getElementById('form-success');
  const failure = document.getElementById('form-error');
  const submit = form.querySelector('[type="submit"]');
  const submitText = submit.innerHTML;

  // Тексты ошибок и состояний — из <template id="form-texts"> (STANDARD §6 v1.5).
  const texts = document.getElementById('form-texts');
  const t = (key) => {
    const el = texts && texts.content.querySelector(`[data-text="${key}"]`);
    if (!el) console.error(`form-texts: missing "${key}"`);
    return el ? el.textContent.trim() : key;
  };

  // Контакт: телефон (10–11 цифр, маска +7), e-mail или Telegram @username (5–32 символа).
  function parseContact(raw) {
    const v = raw.trim();
    if (/^@[A-Za-z0-9_]{5,32}$/.test(v)) return { type: 'telegram', value: v };
    // Те же правила, что в functions/lead: значение уходит в заголовок Reply-To письма.
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v)) return { type: 'email', value: v };
    if (/^[+\d\s()-]+$/.test(v)) {
      let d = v.replace(/\D/g, '');
      if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
      if (d.length === 10) {
        return { type: 'phone', value: `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}` };
      }
    }
    return null;
  }

  const RULES = {
    name: (el) => (el.value.trim() ? '' : t('name-required')),
    org: (el) => (el.value.trim() ? '' : t('org-required')),
    contact: (el) => {
      if (!el.value.trim()) return t('contact-required');
      return parseContact(el.value) ? '' : t('contact-invalid');
    },
    consent: (el) => (el.checked ? '' : t('consent-required')),
  };

  function setError(el, message) {
    const box = document.getElementById(`${el.id}-error`);
    if (message) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
    box.textContent = message;
    box.hidden = !message;
  }

  function validate() {
    let first = null;
    for (const [name, rule] of Object.entries(RULES)) {
      const el = form.elements[name];
      const message = rule(el);
      setError(el, message);
      if (message && !first) first = el;
    }
    return first;
  }

  // После первой отправки ошибки обновляются по ходу ввода.
  let tried = false;
  form.addEventListener('input', (e) => {
    const rule = RULES[e.target.name];
    if (tried && rule) setError(e.target, rule(e.target));
  });
  form.elements.contact.addEventListener('blur', (e) => {
    const c = parseContact(e.target.value);
    if (c && c.type === 'phone') e.target.value = c.value;
  });

  function payload() {
    const q = new URLSearchParams(location.search);
    const contact = parseContact(form.elements.contact.value);
    const data = {
      name: form.elements.name.value.trim(),
      org: form.elements.org.value.trim(),
      role: form.elements.role.value,
      contact: contact.value,
      contact_type: contact.type,
      comment: form.elements.comment.value.trim(),
      website: form.elements.website.value, // honeypot: функция отбрасывает заявку, если поле заполнено
      consent: true,
      page: location.pathname,
      referrer: document.referrer,
    };
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) data[k] = q.get(k) || '';
    return data;
  }

  function setSending(on) {
    submit.disabled = on;
    if (on) submit.textContent = t('sending');
    else submit.innerHTML = submitText;
    form.setAttribute('aria-busy', String(on));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    tried = true;
    failure.hidden = true;
    const firstInvalid = validate();
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    setSending(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORM_TIMEOUT_MS);
    let ok = false;
    try {
      // «Простой» CORS-запрос (text/plain, без своих заголовков): Apps Script не отвечает на preflight.
      const res = await fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload()),
        signal: controller.signal,
      });
      // Успех — только ответ 200 с {ok:true}; любой другой ответ — ошибка.
      if (res.status === 200) {
        const body = await res.json().catch(() => null);
        ok = Boolean(body && body.ok === true);
      }
    } catch {
      ok = false; // офлайн, таймаут, CORS, недоступный адрес
    } finally {
      clearTimeout(timer);
    }

    setSending(false);
    if (ok) {
      form.hidden = true;
      success.hidden = false;
      success.focus();
    } else {
      failure.hidden = false; // введённые данные остаются в полях
    }
  });
})();

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// C2: дорожки ЭЭГ/взгляд/стимул; стимул → вспышка, саккада, отклик ЭЭГ. Reduced motion — статичный кадр.
(() => {
  const canvas = document.querySelector('.monitor__canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  // Цвета — вычисленные токены темы (light-dark() в custom property не разрешается).
  const probe = document.createElement('i');
  probe.hidden = true;
  document.body.append(probe);
  const color = (name) => {
    probe.style.color = `var(${name})`;
    return getComputedStyle(probe).color;
  };
  let COLORS;
  const readColors = () => (COLORS = { eeg: color('--trace-eeg'), eye: color('--trace-eye'), stim: color('--trace-stim'), grid: color('--line') });
  readColors();

  const SPEED = 110; // пикселей в секунду
  const PERIOD = 1.6; // секунд между стимулами
  const GAP = 18; // стёртый участок перед курсором
  const STIM_LEN = 0.14;

  // Детерминированный шум.
  const hash = (n) => {
    const x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const fixation = (k) => (hash(k + 3.7) - 0.5) * 1.4;
  const onset = (s) => Math.floor(s / PERIOD) * PERIOD + 0.3;

  function sample(s) {
    const t0 = onset(s);
    const k = Math.floor(s / PERIOD);
    // ЭЭГ: фоновая активность + вызванный ответ после стимула
    let eeg = 0.32 * Math.sin(s * 2 * Math.PI * 9.5) + 0.18 * Math.sin(s * 2 * Math.PI * 4.1 + 1.3) + 0.14 * (hash(Math.floor(s * 60)) - 0.5);
    const dt = s - t0 - 0.25;
    if (dt > 0 && dt < 0.9) eeg += 0.95 * Math.exp(-dt * 5) * Math.sin(dt * 2 * Math.PI * 3.2);
    // Взгляд: фиксации и резкая саккада через 0,2 с после стимула
    const ds = s - t0 - 0.2;
    const from = fixation(k - 1);
    const to = fixation(k);
    let eye = s < t0 + 0.2 ? from : ds < 0.05 ? from + (to - from) * (ds / 0.05) : to;
    eye += 0.04 * Math.sin(s * 23) + 0.03 * (hash(Math.floor(s * 40) + 9) - 0.5);
    // Стимул: прямоугольная метка
    const stim = s >= t0 && s < t0 + STIM_LEN ? 1 : 0;
    return { eeg, eye: eye * 0.8, stim };
  }

  let W = 0;
  let H = 0;
  let dpr = 1;
  let buf = null; // по пикселю: [eeg, eye, stim]
  let n = 0; // номер сэмпла = пиксель развёртки во времени
  const flashes = [];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buf = new Float32Array(W * 3);
    flashes.length = 0;
    for (n = 0; n < W; n++) write(n, false);
  }

  function write(i, live) {
    const s = i / SPEED;
    const v = sample(s);
    const x = i % W;
    buf[x * 3] = v.eeg;
    buf[x * 3 + 1] = v.eye;
    buf[x * 3 + 2] = v.stim;
    if (live && v.stim && !sample((i - 1) / SPEED).stim) flashes.push({ x, born: performance.now() });
  }

  function trace(idx, laneY, amp, color, cursor) {
    const draw = (width, alpha) => {
      ctx.beginPath();
      let pen = false;
      for (let x = 0; x < W; x++) {
        const ahead = (x - cursor + W) % W;
        if (cursor >= 0 && ahead < GAP) {
          pen = false;
          continue;
        }
        const y = laneY - buf[x * 3 + idx] * amp;
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    draw(6, 0.16); // свечение
    draw(1.75, 1);
  }

  function frame(now, cursor) {
    ctx.clearRect(0, 0, W, H);
    const lane = H / 3;
    // сетка
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    for (let x = 0; x < W; x += 48) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
    }
    ctx.moveTo(0, lane + 0.5);
    ctx.lineTo(W, lane + 0.5);
    ctx.moveTo(0, lane * 2 + 0.5);
    ctx.lineTo(W, lane * 2 + 0.5);
    ctx.stroke();
    // вспышки на метках стимула — по всем трём дорожкам
    for (let i = flashes.length - 1; i >= 0; i--) {
      const age = (now - flashes[i].born) / 900;
      if (age >= 1) {
        flashes.splice(i, 1);
        continue;
      }
      const a = 1 - age;
      ctx.globalAlpha = 0.35 * a;
      ctx.fillStyle = COLORS.stim;
      ctx.fillRect(flashes[i].x - 10, 0, 20 + age * 30, H);
      ctx.globalAlpha = 0.9 * a;
      ctx.fillRect(flashes[i].x, 0, 2, H);
    }
    trace(0, lane * 0.5, lane * 0.32, COLORS.eeg, cursor);
    trace(1, lane * 1.5, lane * 0.32, COLORS.eye, cursor);
    trace(2, lane * 2.75, lane * 0.5, COLORS.stim, cursor);
    // голова развёртки
    if (cursor >= 0) {
      const x = (cursor - 1 + W) % W;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = COLORS.eeg;
      ctx.fillRect(x, 0, 1, H);
    }
    ctx.globalAlpha = 1;
  }

  resize();

  // Смена темы: новые цвета (статичный кадр — перерисовать).
  const recolor = () => {
    readColors();
    if (reduceMotion.matches) frame(performance.now(), -1);
  };
  document.addEventListener('themechange', recolor);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', recolor);

  if (reduceMotion.matches) {
    frame(performance.now(), -1);
    return;
  }

  let visible = false;
  let raf = 0;
  let last = 0;
  function tick(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const target = n + dt * SPEED;
    while (n < target) write(n++, true);
    frame(now, n % W);
    raf = requestAnimationFrame(tick);
  }
  function run() {
    const should = visible && !document.hidden && !reduceMotion.matches;
    if (should && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (!should && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    run();
  }).observe(canvas);
  document.addEventListener('visibilitychange', run);
  reduceMotion.addEventListener('change', () => {
    run();
    if (reduceMotion.matches) frame(performance.now(), -1);
  });
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      frame(performance.now(), raf ? n % W : -1);
    }, 100);
  }).observe(canvas);
})();

// Появление при скролле (stagger) и подсветка шагов; без IO или с reduced motion — сразу.
(() => {
  document.querySelectorAll('[data-stagger]').forEach((list) => {
    [...list.children].forEach((el, i) => el.style.setProperty('--i', i));
  });
  const items = document.querySelectorAll('[data-reveal], [data-steps]');
  if (!items.length) return;
  if (!('IntersectionObserver' in window) || reduceMotion.matches) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-visible');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px' },
  );
  items.forEach((el) => io.observe(el));
})();

// C11: интерактивная схема «стимул → запись → очистка → графики» (tabs по WAI-ARIA).
(() => {
  const scheme = document.querySelector('[data-scheme]');
  if (!scheme) return;
  const tabs = [...scheme.querySelectorAll('[role="tab"]')];
  let current = Math.max(0, tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
  // Автопереключение — только в зоне видимости, без взаимодействия.
  let paused = false;
  let inView = false;
  let hover = false;

  function select(i, focus) {
    current = (i + tabs.length) % tabs.length;
    tabs.forEach((tab, j) => {
      const on = j === current;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
    });
    scheme.style.setProperty('--progress', String(current / (tabs.length - 1)));
    if (focus) tabs[current].focus();
  }

  tabs.forEach((tab, i) => tab.addEventListener('click', () => {
    paused = true;
    select(i, false);
  }));
  scheme.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
    const keys = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    paused = true;
    select(keys[e.key], true);
  });
  select(current, false);

  scheme.addEventListener('mouseenter', () => (hover = true));
  scheme.addEventListener('mouseleave', () => (hover = false));
  scheme.addEventListener('focusin', () => (paused = true));
  if (reduceMotion.matches || !('IntersectionObserver' in window)) return;
  new IntersectionObserver((entries) => (inView = entries[0].isIntersecting), { threshold: 0.4 }).observe(scheme);
  setInterval(() => {
    if (inView && !paused && !hover && !document.hidden && !reduceMotion.matches) select(current + 1, false);
  }, 3200);
})();

// C12: переключатель темы (тему до CSS ставит inline-скрипт в <head>).
(() => {
  const root = document.documentElement;
  const btn = document.querySelector('.theme-toggle');
  const stored = () => {
    try {
      return localStorage.getItem('theme');
    } catch {
      return null;
    }
  };
  const sync = () => btn && btn.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
  let timer;
  const apply = (theme, save) => {
    root.classList.add('theme-anim');
    root.dataset.theme = theme;
    sync();
    if (save) {
      try {
        localStorage.setItem('theme', theme);
      } catch {
        // хранилище недоступно: тема до перезагрузки
      }
    }
    document.dispatchEvent(new CustomEvent('themechange'));
    clearTimeout(timer);
    timer = setTimeout(() => root.classList.remove('theme-anim'), 400);
  };
  if (btn) btn.addEventListener('click', () => apply(root.dataset.theme === 'dark' ? 'light' : 'dark', true));
  // Пока человек сам не выбрал тему — следуем системе.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!stored()) apply(e.matches ? 'dark' : 'light', false);
  });
  sync();
})();

// Движение: прогресс, параллакс, подсветка, магнитные кнопки. Только transform; reduced motion — без них.
(() => {
  const bar = document.querySelector('.scroll-progress');
  const monitor = document.querySelector('[data-parallax]');
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (bar) bar.style.setProperty('--progress', String(max > 0 ? Math.min(1, window.scrollY / max) : 0));
      if (monitor && !reduceMotion.matches) {
        const y = Math.min(window.scrollY, window.innerHeight);
        monitor.style.transform = `translate3d(0, ${(y * 0.08).toFixed(1)}px, 0)`;
      }
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  if (reduceMotion.matches || !fine.matches) return;

  document.querySelectorAll('[data-spotlight]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
      el.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
    });
  });

  document.querySelectorAll('[data-magnetic]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) * 0.2;
      const dy = (e.clientY - (r.top + r.height / 2)) * 0.3;
      el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    });
    el.addEventListener('pointerleave', () => {
      el.style.transform = '';
    });
  });
})();
