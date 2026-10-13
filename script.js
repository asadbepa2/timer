(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const TICK_MS = 30;

  // Shared UI state (declared early: used by the theme, alerts and the mini-player)
  const mini = { win: null, kind: null, els: null };
  let flashOn = false;
  let alertActive = false;

  /* ======================================================================
     Native web components (light DOM, styled by style.css)
     ====================================================================== */

  /** <ct-progress>  – accessible progress bar. Set `.value` between 0 and 1. */
  class CtProgress extends HTMLElement {
    connectedCallback() {
      if (this.bar) return;
      this.setAttribute('role', 'progressbar');
      this.setAttribute('aria-valuemin', '0');
      this.setAttribute('aria-valuemax', '100');
      this.bar = document.createElement('span');
      this.bar.className = 'bar';
      this.append(this.bar);
      this.value = this._v || 0;
    }
    set value(v) {
      this._v = clamp(Number(v) || 0, 0, 1);
      if (!this.bar) return;
      this.bar.style.transform = `scaleX(${this._v})`;
      this.setAttribute('aria-valuenow', String(Math.round(this._v * 100)));
    }
    get value() { return this._v || 0; }
  }

  /** <ct-toast>  – short, non-blocking message. */
  class CtToast extends HTMLElement {
    connectedCallback() {
      this.setAttribute('role', 'status');
      this.setAttribute('aria-live', 'polite');
    }
    show(message, ms = 2200) {
      this.textContent = message;
      this.classList.add('show');
      clearTimeout(this._t);
      this._t = setTimeout(() => this.classList.remove('show'), ms);
    }
  }

  /** <ct-modal>  – in-app dialog replacing alert(). */
  class CtModal extends HTMLElement {
    connectedCallback() {
      if (this.card) return;
      this.innerHTML =
        '<div class="modal__backdrop"></div>' +
        '<div class="modal__card" role="alertdialog" aria-modal="true" ' +
        'aria-labelledby="modal-title" aria-describedby="modal-text">' +
        '<h2 class="modal__title" id="modal-title"></h2>' +
        '<p class="modal__text" id="modal-text"></p>' +
        '<div class="modal__actions"></div></div>';
      this.card = this.querySelector('.modal__card');
      this.titleEl = this.querySelector('.modal__title');
      this.textEl = this.querySelector('.modal__text');
      this.actionsEl = this.querySelector('.modal__actions');
      this.querySelector('.modal__backdrop').addEventListener('click', () => this.close());
      this._onKey = (e) => this._handleKey(e);
    }

    open({ title, text, actions }) {
      if (!this.hasAttribute('open')) this._returnFocus = document.activeElement;
      this.titleEl.textContent = title;
      this.textEl.textContent = text;
      this.actionsEl.replaceChildren();
      const list = actions && actions.length ? actions : [{ label: 'Dismiss', variant: 'reset' }];
      this.actionsEl.style.gridTemplateColumns = `repeat(${list.length}, 1fr)`;
      list.forEach((a) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn--${a.variant || 'reset'}`;
        btn.textContent = a.label;
        btn.addEventListener('click', () => {
          this.close();
          if (a.onClick) a.onClick();
        });
        this.actionsEl.append(btn);
      });
      this.setAttribute('open', '');
      document.addEventListener('keydown', this._onKey);
      this.actionsEl.querySelector('button').focus();
    }

    close() {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      document.removeEventListener('keydown', this._onKey);
      if (this._returnFocus && this._returnFocus.focus) this._returnFocus.focus();
      this.dispatchEvent(new CustomEvent('ct-close'));
    }

    _handleKey(e) {
      if (e.key === 'Escape') { this.close(); return; }
      if (e.key !== 'Tab') return;
      const btns = [...this.actionsEl.querySelectorAll('button')];
      const first = btns[0];
      const last = btns[btns.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  customElements.define('ct-progress', CtProgress);
  customElements.define('ct-toast', CtToast);
  customElements.define('ct-modal', CtModal);

  const modal = $('modal');
  const toast = $('toast');

  /* ======================================================================
     Formatting helpers
     ====================================================================== */
  const parts = (ms) => {
    const s = Math.floor(ms / 1000);
    return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60, cs: Math.floor((ms % 1000) / 10) };
  };
  const fmtSplit = (ms) => {
    const p = parts(ms);
    return `${p.h ? pad(p.h) + ':' : ''}${pad(p.m)}:${pad(p.s)}.${pad(p.cs)}`;
  };
  const fmtFull = (ms) => {
    const p = parts(ms);
    return `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}.${pad(p.cs)}`;
  };
  const fmtMMSS = (ms) => {
    const t = Math.ceil(ms / 1000);                 // show 00:01 until the very end
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  };
  const fmtDur = (ms) => {
    const t = Math.round(ms / 1000);
    const m = Math.floor(t / 60);
    const s = t % 60;
    if (!s) return `${m} min`;
    if (!m) return `${s} sec`;
    return `${m}m ${s}s`;
  };
  const fmtDate = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  /** Tiny safe DOM builder: strings become text nodes, never HTML. */
  function h(tag, cls, ...kids) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    kids.forEach((k) => { if (k != null) el.append(k); });
    return el;
  }
  const span = (cls, text) => { const e = h('span', cls); e.textContent = text; return e; };

  function itemRow({ tag, title, meta, value, sub }) {
    return h('li', 'row row--item',
      tag ? span(`tag tag--${tag.key}`, tag.label) : null,
      h('div', 'row__main', span('row__title', title), span('row__meta', meta)),
      h('div', 'row__end', span('row__value', value), sub ? span('row__meta', sub) : null));
  }
  const emptyRow = (text) => h('li', 'row row--empty', text);

  /* ======================================================================
     Persistent storage (Local Storage)
     ====================================================================== */
  const KEY = 'core-tracker:v1';
  const THEME_KEY = 'core-tracker:theme';
  const MAX_HISTORY = 500;

  const defaults = () => ({
    history: [],
    totals: { lap: 0, timer: 0, sprint: 0, focusMs: 0 },
    sw: { elapsed: 0, startedAt: null, lastTotal: 0, laps: [] },
    prefs: { tmTitle: '', tmMin: 5, tmSec: 0, spWork: 25, spRest: 5, spRounds: 4, sound: 'classic', flash: true },
  });

  function loadDb() {
    const d = defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return d;
      const p = JSON.parse(raw);
      return {
        history: Array.isArray(p.history) ? p.history.slice(0, MAX_HISTORY) : d.history,
        totals: { ...d.totals, ...(p.totals || {}) },
        sw: { ...d.sw, ...(p.sw || {}), laps: Array.isArray(p.sw && p.sw.laps) ? p.sw.laps : [] },
        prefs: { ...d.prefs, ...(p.prefs || {}) },
      };
    } catch (_) {
      return d;
    }
  }

  const db = loadDb();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (_) { /* storage full or blocked */ }
  }

  // Ask the browser not to evict our data under storage pressure.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* ignore */ }

  function addHistory(entry) {
    db.history.unshift({ at: Date.now(), ...entry });
    if (db.history.length > MAX_HISTORY) db.history.length = MAX_HISTORY;
    db.totals[entry.type] = (db.totals[entry.type] || 0) + 1;
    if (entry.type === 'sprint') db.totals.focusMs += entry.durationMs || 0;
    save();
    renderLog();
  }

  /* ======================================================================
     Theme
     ====================================================================== */
  const root = document.documentElement;
  const themeBtn = $('theme-toggle');

  function applyTheme(theme) {
    root.dataset.theme = theme;
    themeBtn.setAttribute('aria-checked', String(theme === 'dark'));
    $('meta-theme').content = theme === 'light' ? '#f8f9fa' : '#121212';
    if (mini.win) mini.win.document.documentElement.dataset.theme = theme;
  }

  themeBtn.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* ignore */ }
  });
  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark');

  /* ======================================================================
     Audio alerts (Web Audio oscillators, no files) + screen flash
     ====================================================================== */
  let audioCtx = null;

  function unlockAudio() {          // call from a user gesture (Start / Preview click)
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) { /* audio unavailable */ }
  }

  /** One synthesized note with an exponential attack/decay envelope. */
  function tone({ freq, at, dur, type = 'sine', peak = 0.2, attack = 0.02 }) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  const SOUNDS = {
    // Classic Beep: high and urgent, three bursts of four short square-wave beeps.
    classic(t0) {
      for (let g = 0; g < 3; g++) {
        for (let i = 0; i < 4; i++) {
          tone({ freq: 1760, at: t0 + g * 1.1 + i * 0.16, dur: 0.1, type: 'square', peak: 0.1, attack: 0.005 });
        }
      }
    },
    // Digital Chime: a rising C-major arpeggio, each note with soft upper harmonics, played twice.
    chime(t0) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let r = 0; r < 2; r++) {
        notes.forEach((f, i) => {
          const at = t0 + r * 1.7 + i * 0.2;
          tone({ freq: f, at, dur: 1.2, peak: 0.2 });
          tone({ freq: f * 2, at, dur: 0.8, peak: 0.07 });
          tone({ freq: f * 3, at, dur: 0.45, peak: 0.025 });
        });
      }
    },
    // Gentle Alert: low, slow-swelling sine pulses.
    gentle(t0) {
      for (let r = 0; r < 3; r++) {
        const at = t0 + r * 1.5;
        tone({ freq: 293.66, at, dur: 1.4, peak: 0.18, attack: 0.25 });
        tone({ freq: 440, at: at + 0.05, dur: 1.2, peak: 0.05, attack: 0.3 });
      }
    },
  };

  function playAlert(preset = db.prefs.sound) {
    unlockAudio();
    if (!audioCtx) return;
    (SOUNDS[preset] || SOUNDS.classic)(audioCtx.currentTime + 0.05);
  }

  /* Screen flash: a soft pulsing overlay that runs until the alert modal closes. */
  const flashEl = $('flash');

  function startFlash() {
    flashOn = true;
    flashEl.classList.add('on');
    renderMini();
  }

  function stopFlash() {
    flashOn = false;
    flashEl.classList.remove('on');
    renderMini();
  }

  /** Sound + flash + in-app modal, used whenever a countdown or sprint block ends. */
  function alertFinish({ title, text, actions }) {
    alertActive = true;
    playAlert();
    if (db.prefs.flash) startFlash();
    modal.open({ title, text, actions });
    renderMini();
  }

  modal.addEventListener('ct-close', () => {
    alertActive = false;
    stopFlash();
  });

  /* ======================================================================
     Countdown engine (end-timestamp based: no drift, exact pause/resume)
     ====================================================================== */
  /* Shared 30 ms ticker. It runs in a Web Worker so countdowns stay on time even when
     the window is covered or hidden (browsers throttle main-thread timers in the
     background). Falls back to setInterval if workers are unavailable. */
  const Ticker = (() => {
    const subs = new Set();
    let worker = null;
    let fallbackId = null;
    const fire = () => subs.forEach((fn) => fn());

    function begin() {
      if (worker || fallbackId) return;
      try {
        const blob = new Blob([`setInterval(() => postMessage(0), ${TICK_MS});`], { type: 'text/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = fire;
        worker.onerror = () => {
          if (worker) worker.terminate();
          worker = null;
          fallbackId = setInterval(fire, TICK_MS);
        };
      } catch (_) {
        fallbackId = setInterval(fire, TICK_MS);
      }
    }

    function end() {
      if (subs.size) return;
      if (worker) { worker.terminate(); worker = null; }
      if (fallbackId) { clearInterval(fallbackId); fallbackId = null; }
    }

    return {
      add(fn) { subs.add(fn); begin(); },
      remove(fn) { subs.delete(fn); end(); },
    };
  })();

  class Countdown {
    constructor({ onTick, onDone }) {
      this.onTick = onTick;
      this.onDone = onDone;
      this.running = false;
      this.endAt = 0;
      this.remaining = 0;
      this.total = 0;
      this._fn = () => this._tick();
    }
    reset(ms) {                       // set a new duration and stop
      Ticker.remove(this._fn);
      this.running = false;
      this.total = this.remaining = ms;
      this.onTick(ms);
    }
    start() {
      if (this.running || this.remaining <= 0) return;
      this.running = true;
      this.endAt = Date.now() + this.remaining;
      Ticker.add(this._fn);
      this._tick();
    }
    pause() {
      if (!this.running) return;
      this.remaining = Math.max(0, this.endAt - Date.now());
      this.running = false;
      Ticker.remove(this._fn);
      this.onTick(this.remaining);
    }
    _tick() {
      if (!this.running) return;
      const left = this.endAt - Date.now();
      if (left <= 0) {
        Ticker.remove(this._fn);
        this.running = false;
        this.remaining = 0;
        this.onTick(0);
        this.onDone();
      } else {
        this.onTick(left);
      }
    }
  }

  /* ======================================================================
     Tabs
     ====================================================================== */
  const TAB_NAMES = ['stopwatch', 'timer', 'sprints', 'log'];
  const tabsEl = $('tabs');
  const tabBtns = TAB_NAMES.map((n) => $(`tab-${n}`));
  let activeTab = 'stopwatch';

  function selectTab(name, focus = false) {
    activeTab = name;
    const idx = TAB_NAMES.indexOf(name);
    tabsEl.style.setProperty('--i', idx);
    tabBtns.forEach((btn, i) => {
      btn.setAttribute('aria-selected', String(i === idx));
      btn.tabIndex = i === idx ? 0 : -1;
      $(`panel-${TAB_NAMES[i]}`).hidden = i !== idx;
    });
    if (focus) tabBtns[idx].focus();
  }

  tabBtns.forEach((btn, i) => {
    btn.addEventListener('click', () => selectTab(TAB_NAMES[i]));
    btn.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % TAB_NAMES.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + TAB_NAMES.length) % TAB_NAMES.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TAB_NAMES.length - 1;
      if (next !== null) { e.preventDefault(); selectTab(TAB_NAMES[next], true); }
    });
  });

  /* ======================================================================
     Stopwatch + lap splits
     ====================================================================== */
  const swEls = {
    card: $('sw-card'), main: $('sw-main'), cs: $('sw-cs'), status: $('sw-status'),
    start: $('sw-start'), stop: $('sw-stop'), lap: $('sw-lap'), reset: $('sw-reset'),
    list: $('lap-list'), count: $('lap-count'),
  };

  const sw = {
    running: false,
    startedAt: 0,
    elapsed: db.sw.elapsed || 0,
    lastTotal: db.sw.lastTotal || 0,
    timer: null,
  };

  const swTotal = () => sw.elapsed + (sw.running ? Date.now() - sw.startedAt : 0);

  function renderStopwatch() {
    const ms = swTotal();
    const p = parts(ms);
    swEls.main.textContent = `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
    swEls.cs.textContent = `.${pad(p.cs)}`;
  }

  function setSwState(state) {
    swEls.card.dataset.state = state;
    swEls.status.textContent = { ready: 'Ready', running: 'Running', paused: 'Paused' }[state];
    swEls.start.disabled = state === 'running';
    swEls.stop.disabled = state !== 'running';
    swEls.lap.disabled = state !== 'running';
    swEls.start.textContent = state === 'paused' ? 'Resume' : 'Start';
  }

  function persistStopwatch() {
    db.sw.elapsed = sw.elapsed;
    db.sw.startedAt = sw.running ? sw.startedAt : null;
    db.sw.lastTotal = sw.lastTotal;
    save();
  }

  function swStart() {
    if (sw.running) return;
    sw.running = true;
    sw.startedAt = Date.now();
    sw.timer = setInterval(renderStopwatch, TICK_MS);
    setSwState('running');
    persistStopwatch();
  }

  function swStop() {
    if (!sw.running) return;
    sw.elapsed += Date.now() - sw.startedAt;
    sw.running = false;
    clearInterval(sw.timer);
    renderStopwatch();
    setSwState('paused');
    persistStopwatch();
  }

  function swLap() {
    if (!sw.running) return;
    const total = swTotal();                       // capture instantly
    const lap = { n: db.sw.laps.length + 1, split: total - sw.lastTotal, total, at: Date.now() };
    sw.lastTotal = total;
    db.sw.laps.push(lap);
    persistStopwatch();
    addHistory({ type: 'lap', title: `Lap ${lap.n}`, durationMs: lap.split, totalMs: total });
    renderLaps();
  }

  function swReset() {
    clearInterval(sw.timer);
    sw.running = false;
    sw.elapsed = 0;
    sw.lastTotal = 0;
    db.sw.laps = [];
    persistStopwatch();
    renderStopwatch();
    renderLaps();
    setSwState('ready');
  }

  function renderLaps() {
    const laps = db.sw.laps;
    swEls.list.replaceChildren();
    swEls.count.textContent = laps.length ? String(laps.length) : '';
    if (!laps.length) {
      swEls.list.append(emptyRow('No laps yet. Press Lap while the stopwatch runs.'));
      return;
    }
    for (let i = laps.length - 1; i >= 0; i--) {
      const l = laps[i];
      swEls.list.append(itemRow({
        title: `Lap ${l.n}`,
        meta: fmtClock(l.at),
        value: fmtSplit(l.split),
        sub: `Total ${fmtFull(l.total)}`,
      }));
    }
  }

  swEls.start.addEventListener('click', swStart);
  swEls.stop.addEventListener('click', swStop);
  swEls.lap.addEventListener('click', swLap);
  swEls.reset.addEventListener('click', swReset);

  /* ======================================================================
     Countdown timer with title
     ====================================================================== */
  const tmEls = {
    card: $('tm-card'), display: $('tm-display'), status: $('tm-status'), label: $('tm-label'),
    progress: $('tm-progress'), title: $('tm-title'), min: $('tm-min'), sec: $('tm-sec'),
    start: $('tm-start'), stop: $('tm-stop'), reset: $('tm-reset'), presets: $('tm-presets'),
  };

  const tm = { armed: false, title: '' };

  const tmInputMs = () => {
    const m = clamp(parseInt(tmEls.min.value, 10) || 0, 0, 999);
    const s = clamp(parseInt(tmEls.sec.value, 10) || 0, 0, 59);
    return (m * 60 + s) * 1000;
  };

  function tmNormalise() {
    tmEls.min.value = clamp(parseInt(tmEls.min.value, 10) || 0, 0, 999);
    tmEls.sec.value = clamp(parseInt(tmEls.sec.value, 10) || 0, 0, 59);
    tmEls.min.classList.remove('is-invalid');
    tmEls.sec.classList.remove('is-invalid');
  }

  function tmSavePrefs() {
    db.prefs.tmTitle = tmEls.title.value;
    db.prefs.tmMin = parseInt(tmEls.min.value, 10) || 0;
    db.prefs.tmSec = parseInt(tmEls.sec.value, 10) || 0;
    save();
  }

  const tmTitleText = () => (tm.armed ? tm.title : tmEls.title.value.trim()) || 'Countdown';

  function renderTimer(ms) {
    tmEls.display.textContent = fmtMMSS(ms);
    tmEls.progress.value = tmCd.total > 0 ? 1 - ms / tmCd.total : 0;
    renderMini();
  }

  function setTmState(state) {
    tmEls.card.dataset.state = state;
    tmEls.status.textContent = { ready: 'Ready', running: 'Running', paused: 'Paused', finished: 'Finished' }[state];
    tmEls.start.disabled = state === 'running';
    tmEls.stop.disabled = state !== 'running';
    tmEls.start.textContent = state === 'paused' ? 'Resume' : 'Start';
    const lock = state === 'running' || state === 'paused';
    [tmEls.title, tmEls.min, tmEls.sec].forEach((el) => { el.disabled = lock; });
    tmEls.presets.querySelectorAll('.chip').forEach((c) => { c.disabled = lock; });
    tmEls.label.textContent = tmTitleText();
    renderMini();
  }

  const tmCd = new Countdown({ onTick: renderTimer, onDone: timerDone });

  function tmPreview() {                         // idle: mirror inputs on the display
    if (tm.armed) return;
    tmCd.reset(tmInputMs());
    tmEls.label.textContent = tmTitleText();
    if (tmEls.card.dataset.state === 'finished') setTmState('ready');
  }

  function tmStart() {
    if (tmCd.running) return;
    unlockAudio();
    if (!tm.armed) {
      tmNormalise();
      const ms = tmInputMs();
      if (ms <= 0) {
        tmEls.min.classList.add('is-invalid');
        tmEls.sec.classList.add('is-invalid');
        tmEls.min.focus();
        toast.show('Set a time greater than zero');
        return;
      }
      tm.title = tmEls.title.value.trim() || 'Countdown';
      tm.armed = true;
      tmCd.reset(ms);
      tmSavePrefs();
    }
    tmCd.start();
    setTmState('running');
  }

  function tmStop() {
    if (!tmCd.running) return;
    tmCd.pause();
    setTmState('paused');
  }

  function tmReset() {
    tm.armed = false;
    tmNormalise();
    tmCd.reset(tmInputMs());
    setTmState('ready');
  }

  function timerDone() {
    const title = tm.title;
    const total = tmCd.total;
    tm.armed = false;
    setTmState('finished');
    tmEls.label.textContent = title;
    addHistory({ type: 'timer', title, durationMs: total });
    alertFinish({
      title: 'Time’s up',
      text: `“${title}” finished after ${fmtDur(total)}.`,
      actions: [
        { label: 'Restart', variant: 'start', onClick: () => { tmReset(); tmStart(); } },
        { label: 'Dismiss', variant: 'reset' },
      ],
    });
  }

  tmEls.start.addEventListener('click', tmStart);
  tmEls.stop.addEventListener('click', tmStop);
  tmEls.reset.addEventListener('click', tmReset);

  [tmEls.title, tmEls.min, tmEls.sec].forEach((el) => {
    el.addEventListener('input', () => {
      el.classList.remove('is-invalid');
      if (el !== tmEls.title) tmEls.sec.classList.remove('is-invalid');
      tmPreview();
    });
    el.addEventListener('change', () => { if (!tm.armed) { tmNormalise(); tmPreview(); tmSavePrefs(); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') tmStart(); });
  });

  tmEls.presets.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.disabled) return;
    tmEls.title.value = chip.dataset.title;
    tmEls.min.value = chip.dataset.m;
    tmEls.sec.value = chip.dataset.s;
    tmNormalise();
    tmPreview();
    tmSavePrefs();
  });

  /* ======================================================================
     Pomodoro sprints (work / rest alternation)
     ====================================================================== */
  const spEls = {
    card: $('sp-card'), display: $('sp-display'), status: $('sp-status'),
    phaseBar: $('sp-phase-bar'), sessionBar: $('sp-session-bar'), done: $('sp-done'),
    work: $('sp-work'), rest: $('sp-rest'), rounds: $('sp-rounds'),
    start: $('sp-start'), stop: $('sp-stop'), skip: $('sp-skip'), reset: $('sp-reset'),
  };

  const sp = { armed: false, phase: 'idle', round: 1, done: 0, workMs: 0, restMs: 0, rounds: 4 };

  function spSettings() {
    return {
      work: clamp(parseInt(spEls.work.value, 10) || 25, 1, 180),
      rest: clamp(parseInt(spEls.rest.value, 10) || 5, 1, 60),
      rounds: clamp(parseInt(spEls.rounds.value, 10) || 4, 1, 12),
    };
  }

  function spNormalise() {
    const s = spSettings();
    spEls.work.value = s.work;
    spEls.rest.value = s.rest;
    spEls.rounds.value = s.rounds;
    db.prefs.spWork = s.work;
    db.prefs.spRest = s.rest;
    db.prefs.spRounds = s.rounds;
    save();
  }

  function renderSprint(ms) {
    spEls.display.textContent = fmtMMSS(ms);
    const frac = spCd.total > 0 ? clamp(1 - ms / spCd.total, 0, 1) : 0;
    spEls.phaseBar.value = frac;
    const progressed = sp.done + (sp.armed && sp.phase === 'work' ? frac : 0);
    spEls.sessionBar.value = sp.rounds ? progressed / sp.rounds : 0;
    spEls.done.textContent = `${sp.done} of ${sp.rounds}`;
    renderMini();
  }

  function setSpState(state) {
    spEls.card.dataset.state = state;
    spEls.card.dataset.phase = sp.phase === 'rest' ? 'rest' : 'work';
    let text = 'Ready';
    if (state === 'running' || state === 'paused') {
      const base = sp.phase === 'work' ? `Work, sprint ${sp.round} of ${sp.rounds}` : `Rest after sprint ${sp.round}`;
      text = state === 'paused' ? `${base} (paused)` : base;
    } else if (state === 'finished') {
      text = 'Session complete';
    }
    spEls.status.textContent = text;
    spEls.start.disabled = state === 'running';
    spEls.stop.disabled = state !== 'running';
    spEls.skip.disabled = !(state === 'running' || state === 'paused');
    spEls.start.textContent = state === 'paused' ? 'Resume' : 'Start';
    const lock = state === 'running' || state === 'paused';
    [spEls.work, spEls.rest, spEls.rounds].forEach((el) => { el.disabled = lock; });
    renderMini();
  }

  const spCd = new Countdown({ onTick: renderSprint, onDone: () => spAdvance(true) });

  function spPreview() {                          // idle: show the work length
    if (sp.armed) return;
    const s = spSettings();
    sp.rounds = s.rounds;
    sp.done = 0;
    sp.phase = 'idle';
    spCd.reset(s.work * 60000);
    setSpState('ready');
  }

  function spStart() {
    if (spCd.running) return;
    unlockAudio();
    if (!sp.armed) {
      spNormalise();
      const s = spSettings();
      Object.assign(sp, {
        armed: true, phase: 'work', round: 1, done: 0,
        workMs: s.work * 60000, restMs: s.rest * 60000, rounds: s.rounds,
      });
      spCd.reset(sp.workMs);
    }
    spCd.start();
    setSpState('running');
  }

  function spStop() {
    if (!spCd.running) return;
    spCd.pause();
    setSpState('paused');
  }

  function spReset() {
    sp.armed = false;
    spPreview();
  }

  function spComplete(natural) {
    sp.armed = false;
    sp.phase = 'idle';
    spCd.reset(0);
    setSpState('finished');
    if (natural) {
      alertFinish({
        title: 'Sprint session complete',
        text: `${sp.done} sprint${sp.done === 1 ? '' : 's'} finished, ${fmtDur(sp.done * sp.workMs)} of focus.`,
        actions: [{ label: 'Nice', variant: 'start' }],
      });
    } else {
      toast.show('Session ended');
    }
  }

  function spAdvance(natural) {
    if (sp.phase === 'work') {
      if (natural) {
        sp.done++;
        addHistory({
          type: 'sprint',
          title: `Sprint ${sp.round} of ${sp.rounds}`,
          durationMs: sp.workMs,
          detail: `${fmtDur(sp.workMs)} work, ${fmtDur(sp.restMs)} rest`,
        });
      }
      if (sp.round >= sp.rounds) { spComplete(natural); return; }
      sp.phase = 'rest';
      spCd.reset(sp.restMs);
      spCd.start();
      setSpState('running');
      if (natural) {
        alertFinish({
          title: 'Sprint done',
          text: `Rest for ${fmtDur(sp.restMs)}. The next sprint starts on its own.`,
          actions: [{ label: 'Got it', variant: 'accent' }],
        });
      } else {
        toast.show('Skipped to rest');
      }
    } else if (sp.phase === 'rest') {
      sp.round++;
      sp.phase = 'work';
      spCd.reset(sp.workMs);
      spCd.start();
      setSpState('running');
      if (natural) {
        alertFinish({
          title: 'Rest is over',
          text: `Sprint ${sp.round} of ${sp.rounds} starts now: ${fmtDur(sp.workMs)} of focus.`,
          actions: [{ label: 'Got it', variant: 'start' }],
        });
      } else {
        toast.show(`Sprint ${sp.round} started`);
      }
    }
  }

  spEls.start.addEventListener('click', spStart);
  spEls.stop.addEventListener('click', spStop);
  spEls.skip.addEventListener('click', () => { if (sp.armed) spAdvance(false); });
  spEls.reset.addEventListener('click', spReset);

  [spEls.work, spEls.rest, spEls.rounds].forEach((el) => {
    el.addEventListener('input', spPreview);
    el.addEventListener('change', () => { if (!sp.armed) { spNormalise(); spPreview(); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') spStart(); });
  });

  /* ======================================================================
     Log
     ====================================================================== */
  const logEls = {
    list: $('log-list'), clear: $('log-clear'),
    lap: $('stat-lap'), timer: $('stat-timer'), sprint: $('stat-sprint'), focus: $('stat-focus'),
  };
  const TAGS = { lap: 'Lap', timer: 'Timer', sprint: 'Sprint' };
  let clearArmed = false;
  let clearTimer = null;

  function renderLog() {
    logEls.lap.textContent = db.totals.lap;
    logEls.timer.textContent = db.totals.timer;
    logEls.sprint.textContent = db.totals.sprint;
    logEls.focus.textContent = db.totals.focusMs ? fmtDur(db.totals.focusMs) : '0 min';

    logEls.list.replaceChildren();
    if (!db.history.length) {
      logEls.list.append(emptyRow('Nothing logged yet. Laps, finished timers and sprints appear here.'));
      return;
    }
    db.history.forEach((e) => {
      const sub = e.type === 'lap' && e.totalMs != null ? `Total ${fmtFull(e.totalMs)}` : null;
      logEls.list.append(itemRow({
        tag: { key: e.type, label: TAGS[e.type] || e.type },
        title: e.title,
        meta: fmtDate(e.at),
        value: e.type === 'lap' ? fmtSplit(e.durationMs) : fmtDur(e.durationMs),
        sub,
      }));
    });
  }

  function disarmClear() {
    clearArmed = false;
    clearTimeout(clearTimer);
    logEls.clear.textContent = 'Clear history';
  }

  logEls.clear.addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      logEls.clear.textContent = 'Tap again to confirm';
      clearTimer = setTimeout(disarmClear, 4000);
      return;
    }
    disarmClear();
    db.history = [];
    db.totals = defaults().totals;
    save();
    renderLog();
    toast.show('History cleared');
  });

  /* ======================================================================
     Alert options (sound preset + screen flash)
     ====================================================================== */
  const optEls = { sound: $('opt-sound'), preview: $('opt-preview'), flash: $('opt-flash') };

  optEls.sound.addEventListener('change', () => {
    db.prefs.sound = optEls.sound.value;
    save();
  });

  optEls.flash.addEventListener('change', () => {
    db.prefs.flash = optEls.flash.checked;
    save();
    if (!optEls.flash.checked && !alertActive) stopFlash();
  });

  optEls.preview.addEventListener('click', () => {
    unlockAudio();
    playAlert(optEls.sound.value);
    if (db.prefs.flash && !alertActive) {          // brief demo of the flash too
      startFlash();
      setTimeout(() => { if (!alertActive) stopFlash(); }, 1800);
    }
  });

  /* ======================================================================
     Mini-player (Document Picture-in-Picture)
     ====================================================================== */
  const miniSupported = 'documentPictureInPicture' in window;
  const miniBtns = { timer: $('tm-mini'), sprint: $('sp-mini') };

  /** Reads what the mini window should show straight from the main UI. */
  function miniModel(kind) {
    if (kind === 'sprint') {
      return {
        label: spEls.status.textContent,
        time: spEls.display.textContent,
        frac: spEls.phaseBar.value,
        state: spEls.card.dataset.state,
        phase: sp.phase === 'rest' ? 'rest' : 'work',
      };
    }
    return {
      label: tmEls.label.textContent,
      time: tmEls.display.textContent,
      frac: tmEls.progress.value,
      state: tmEls.card.dataset.state,
      phase: 'work',
    };
  }

  function updateMiniButtons() {
    Object.entries(miniBtns).forEach(([kind, btn]) => {
      const on = !!mini.win && mini.kind === kind;
      btn.textContent = on ? 'Close mini-player' : 'Mini-player';
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  function renderMini() {
    if (!mini.win || !mini.els) return;
    const m = miniModel(mini.kind);
    const e = mini.els;
    const running = m.state === 'running';
    e.wrap.dataset.state = m.state;
    e.wrap.dataset.phase = m.phase;
    e.label.textContent = m.label;
    e.clock.textContent = m.time;
    e.bar.style.transform = `scaleX(${clamp(m.frac, 0, 1)})`;
    e.toggle.textContent = running ? 'Stop' : (m.state === 'paused' ? 'Resume' : 'Start');
    e.toggle.className = `btn btn--sm ${running ? 'btn--stop' : 'btn--start'}`;
    e.dismiss.hidden = !alertActive;
    e.flash.classList.toggle('on', flashOn);
  }

  function buildMini(win) {
    const doc = win.document;
    doc.title = 'Core Tracker mini-player';
    doc.documentElement.lang = 'en';
    doc.documentElement.dataset.theme = root.dataset.theme;

    // Copy the app's styles into the floating window.
    [...document.styleSheets].forEach((sheet) => {
      try {
        const style = doc.createElement('style');
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        doc.head.append(style);
      } catch (_) {
        if (sheet.href) {
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          doc.head.append(link);
        }
      }
    });

    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      if (tag === 'button') el.type = 'button';
      return el;
    };

    const els = {
      wrap: mk('div', 'mini'),
      label: mk('p', 'mini__label'),
      clock: mk('div', 'clock mini__clock'),
      bar: mk('span'),
      toggle: mk('button', 'btn btn--sm btn--start', 'Start'),
      reset: mk('button', 'btn btn--sm btn--reset', 'Reset'),
      dismiss: mk('button', 'btn btn--sm btn--accent', 'Dismiss'),
      close: mk('button', 'btn btn--reset mini__close', 'Close mini mode'),
      flash: mk('div', 'flash'),
    };
    els.clock.setAttribute('role', 'timer');
    els.flash.setAttribute('aria-hidden', 'true');
    els.dismiss.hidden = true;

    const track = mk('div', 'mini__progress');
    track.append(els.bar);
    const controls = mk('div', 'mini__controls');
    controls.append(els.toggle, els.reset, els.dismiss);
    els.wrap.append(els.label, els.clock, track, controls, els.close);
    doc.body.append(els.wrap, els.flash);

    els.toggle.addEventListener('click', () => {
      const running = miniModel(mini.kind).state === 'running';
      if (mini.kind === 'sprint') (running ? spStop : spStart)();
      else (running ? tmStop : tmStart)();
    });
    els.reset.addEventListener('click', () => (mini.kind === 'sprint' ? spReset() : tmReset()));
    els.dismiss.addEventListener('click', () => modal.close());
    els.close.addEventListener('click', () => win.close());

    // Fires for our Close button and for the window's own close control.
    win.addEventListener('pagehide', () => {
      if (mini.win !== win) return;
      mini.win = null;
      mini.kind = null;
      mini.els = null;
      updateMiniButtons();
    });

    mini.els = els;
  }

  async function toggleMini(kind) {
    if (!miniSupported) {
      toast.show('Mini-player needs Chrome or Edge 116+ on a desktop.');
      return;
    }
    if (mini.win) {
      if (mini.kind === kind) { mini.win.close(); return; }
      mini.kind = kind;                       // already open: switch what it shows
      updateMiniButtons();
      renderMini();
      return;
    }
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 320, height: 260 });
      mini.win = win;
      mini.kind = kind;
      buildMini(win);
      updateMiniButtons();
      renderMini();
    } catch (_) {
      mini.win = null;
      mini.kind = null;
      toast.show('Could not open the mini-player.');
    }
  }

  miniBtns.timer.addEventListener('click', () => toggleMini('timer'));
  miniBtns.sprint.addEventListener('click', () => toggleMini('sprint'));

  /* ======================================================================
     Install ("Download App") button
     ====================================================================== */
  const installBtn = $('install-btn');
  let installEvent = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                       // keep the prompt for our own button
    installEvent = e;
    if (!isStandalone()) installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    installEvent = null;                      // a prompt event can only be used once
    installBtn.hidden = true;
    toast.show(outcome === 'accepted' ? 'Installing…' : 'Install cancelled');
  });

  window.addEventListener('appinstalled', () => {
    installEvent = null;
    installBtn.hidden = true;
    toast.show('Installed. It now works offline.');
  });

  /* ======================================================================
     Profile actions
     ====================================================================== */
  $('quick-start').addEventListener('click', () => {
    if (activeTab === 'timer') tmStart();
    else if (activeTab === 'sprints') spStart();
    else { if (activeTab === 'log') selectTab('stopwatch'); swStart(); }
  });

  $('reset-all').addEventListener('click', () => {
    modal.close();
    stopFlash();
    swReset();
    tmReset();
    spReset();
    toast.show('All timers reset. History is kept.');
  });

  /* ======================================================================
     Init
     ====================================================================== */
  tmEls.title.value = db.prefs.tmTitle || '';
  tmEls.min.value = db.prefs.tmMin;
  tmEls.sec.value = db.prefs.tmSec;
  spEls.work.value = db.prefs.spWork;
  spEls.rest.value = db.prefs.spRest;
  spEls.rounds.value = db.prefs.spRounds;

  optEls.sound.value = SOUNDS[db.prefs.sound] ? db.prefs.sound : 'classic';
  optEls.flash.checked = !!db.prefs.flash;
  updateMiniButtons();

  // Restore a stopwatch that was left running (or paused) last session.
  if (db.sw.startedAt) {
    sw.running = true;
    sw.startedAt = db.sw.startedAt;
    sw.timer = setInterval(renderStopwatch, TICK_MS);
    setSwState('running');
  } else {
    setSwState(sw.elapsed > 0 ? 'paused' : 'ready');
  }
  renderStopwatch();
  renderLaps();

  tmNormalise();
  tmReset();

  spNormalise();
  spPreview();

  renderLog();
  selectTab('stopwatch');
})();