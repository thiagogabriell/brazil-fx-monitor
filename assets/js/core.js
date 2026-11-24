/* Brazil FX Monitor - shared runtime.
 *
 * Everything here is static: the pages fetch JSON files published next to them
 * on GitHub Pages, so every path is relative and the app works unchanged when
 * served from a repository subdirectory.
 */
'use strict';

const BFX = (() => {
  /* ------------------------------------------------------------ base path */
  const base = (() => {
    const path = window.location.pathname;
    return path.includes('/pages/') ? '../' : './';
  })();

  const NAV = [
    { group: 'Panorama', items: [
      { href: 'index.html', label: 'Painel simples', icon: '●', key: 'home' },
      { href: 'pages/overview.html', label: 'Visão geral', icon: '◧', key: 'overview' },
      { href: 'pages/reserves.html', label: 'Extrato das reservas', icon: '▤', key: 'reserves' },
      { href: 'pages/calendar.html', label: 'Calendário de intervenções', icon: '▦', key: 'calendar' },
      { href: 'pages/composition.html', label: 'Composição das reservas', icon: '◴', key: 'composition' }
    ]},
    { group: 'Operações', items: [
      { href: 'pages/interventions.html', label: 'Histórico de intervenções', icon: '⇄', key: 'interventions' },
      { href: 'pages/transactions.html', label: 'Movimentações diárias', icon: '≡', key: 'transactions' },
      { href: 'pages/effectiveness.html', label: 'Efetividade das intervenções', icon: '◎', key: 'effectiveness' }
    ]},
    { group: 'Mercado', items: [
      { href: 'pages/exchange-rate.html', label: 'Mercado cambial', icon: '$', key: 'exchange-rate' },
      { href: 'pages/exchange-flow.html', label: 'Fluxo cambial', icon: '↹', key: 'exchange-flow' },
      { href: 'pages/pressure-index.html', label: 'Pressão cambial', icon: '◔', key: 'pressure' }
    ]},
    { group: 'Ferramentas', items: [
      { href: 'pages/alerts.html', label: 'Alertas', icon: '!', key: 'alerts' },
      { href: 'pages/simulator.html', label: 'Simulador', icon: '∿', key: 'simulator' },
      { href: 'pages/sources.html', label: 'Fontes e metodologia', icon: '§', key: 'sources' },
      { href: 'pages/settings.html', label: 'Configurações', icon: '⚙', key: 'settings' }
    ]}
  ];

  /* ------------------------------------------------------------- storage */
  const STORAGE_PREFIX = 'bfx:';

  function store(key, value) {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (error) {
      /* private mode or blocked storage: preferences simply do not persist */
    }
  }

  function recall(key, fallback) {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function forget(key) {
    try { window.localStorage.removeItem(STORAGE_PREFIX + key); } catch (error) { /* ignore */ }
  }

  /* --------------------------------------------------------------- theme */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    store('theme', theme);
    const button = document.getElementById('theme-toggle');
    if (button) {
      button.textContent = theme === 'dark' ? '☀' : '☾';
      button.setAttribute(
        'aria-label',
        theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'
      );
    }
    window.dispatchEvent(new CustomEvent('bfx:theme', { detail: { theme } }));
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  /* ---------------------------------------------------------------- data */
  const cache = new Map();

  async function load(relativePath, { optional = false } = {}) {
    if (cache.has(relativePath)) return cache.get(relativePath);
    const promise = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetch(base + relativePath, { cache: 'no-cache' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return await response.json();
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 350 * attempt * attempt));
          }
        }
      }
      if (optional) return null;
      throw new Error('Não foi possível carregar ' + relativePath + ': ' + lastError.message);
    })();
    cache.set(relativePath, promise);
    return promise;
  }

  /** Same as load, but ignores the cache so a page can refresh itself. */
  function reload(relativePath, options) {
    cache.delete(relativePath);
    return load(relativePath, options);
  }

  /* ----------------------------------------------------------- formatting */
  const nf = (digits) => new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });

  /** Format a USD amount given in whole dollars. */
  function usd(value, { digits = 2, compact = true, sign = false } = {}) {
    if (value === null || value === undefined || Number.isNaN(value)) return naText();
    const absolute = Math.abs(value);
    const prefix = sign && value > 0 ? '+' : '';
    if (!compact) return prefix + 'US$ ' + nf(digits).format(value);
    if (absolute >= 1e9) return prefix + 'US$ ' + nf(digits).format(value / 1e9) + ' bi';
    if (absolute >= 1e6) return prefix + 'US$ ' + nf(digits).format(value / 1e6) + ' mi';
    if (absolute >= 1e3) return prefix + 'US$ ' + nf(0).format(value) ;
    return prefix + 'US$ ' + nf(0).format(value);
  }

  /** Format a USD amount given in integer cents. */
  function usdCents(cents, options) {
    if (cents === null || cents === undefined) return naText();
    return usd(cents / 100, options);
  }

  function brl(value, digits = 4) {
    if (value === null || value === undefined) return naText();
    return 'R$ ' + nf(digits).format(value);
  }

  function pct(value, { digits = 2, sign = true } = {}) {
    if (value === null || value === undefined || Number.isNaN(value)) return naText();
    const prefix = sign && value > 0 ? '+' : '';
    return prefix + nf(digits).format(value) + '%';
  }

  function number(value, digits = 0) {
    if (value === null || value === undefined) return naText();
    return nf(digits).format(value);
  }

  function naText() { return 'não disponível'; }

  function date(iso, { withWeekday = false } = {}) {
    if (!iso) return naText();
    const [year, month, day] = iso.slice(0, 10).split('-');
    const text = `${day}/${month}/${year}`;
    if (!withWeekday) return text;
    const weekday = new Date(Date.UTC(+year, +month - 1, +day)).toLocaleDateString('pt-BR', {
      weekday: 'short', timeZone: 'UTC'
    });
    return `${text} (${weekday})`;
  }

  /** Render a Sao Paulo wall-clock timestamp exactly as published. */
  function stamp(value) {
    if (!value) return naText();
    const normalised = value.replace('T', ' ').slice(0, 19);
    const [datePart, timePart] = normalised.split(' ');
    return `${date(datePart)}${timePart ? ' ' + timePart : ''}`;
  }

  /** Convert an instant in UTC to the Sao Paulo wall clock for display. */
  function utcToSaoPaulo(iso) {
    if (!iso) return naText();
    try {
      return new Date(iso).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch (error) {
      return iso;
    }
  }

  function daysBetween(fromIso, toIso) {
    const a = Date.UTC(...fromIso.slice(0, 10).split('-').map((v, i) => (i === 1 ? +v - 1 : +v)));
    const b = Date.UTC(...toIso.slice(0, 10).split('-').map((v, i) => (i === 1 ? +v - 1 : +v)));
    return Math.round((b - a) / 86400000);
  }

  function todaySaoPaulo() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    return parts;
  }

  /* ------------------------------------------------------------ semantics */

  /** Direction class plus a glyph, so colour is never the only signal. */
  function trend(value, { invert = false } = {}) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return { cls: 'na trend trend--none', text: naText() };
    }
    const positiveIsGood = !invert;
    if (value > 0) {
      return { cls: (positiveIsGood ? 'pos' : 'neg') + ' trend trend--up', text: '' };
    }
    if (value < 0) {
      return { cls: (positiveIsGood ? 'neg' : 'pos') + ' trend trend--down', text: '' };
    }
    return { cls: 'neutral trend trend--flat', text: '' };
  }

  function deltaHtml(absolute, percent, formatter, options) {
    const basis = absolute === null || absolute === undefined ? percent : absolute;
    const t = trend(basis, options);
    const hasAbsolute = absolute !== null && absolute !== undefined;
    const left = hasAbsolute
      ? (formatter ? formatter(absolute) : usd(absolute, { sign: true }))
      : '';
    const right = percent === null || percent === undefined
      ? ''
      : (hasAbsolute ? ` (${pct(percent)})` : pct(percent));
    const text = (left + right).trim();
    if (!text) return `<span class="na">${naText()}</span>`;
    return `<span class="${t.cls} num">${escapeHtml(text)}</span>`;
  }

  const QUALITY = {
    official: { label: 'Dado oficial', cls: 'badge--official' },
    secondary: { label: 'Fonte secundária', cls: 'badge--secondary' },
    preliminary: { label: 'Preliminar', cls: 'badge--preliminary' },
    estimated: { label: 'Estimado', cls: 'badge--estimated' },
    delayed: { label: 'Atrasado', cls: 'badge--delayed' },
    unavailable: { label: 'Indisponível', cls: 'badge--unavailable' },
    hypothetical: { label: 'Hipotético', cls: 'badge--hypothetical' }
  };

  function qualityBadge(kind, extra) {
    const spec = QUALITY[kind] || QUALITY.unavailable;
    return `<span class="badge ${spec.cls}" title="${escapeHtml(extra || spec.label)}">${spec.label}</span>`;
  }

  /** Classify the age of a reference date against the source tolerance. */
  function freshness(referenceDate, toleranceDays) {
    if (!referenceDate) return { kind: 'unavailable', ageDays: null };
    const age = daysBetween(referenceDate, todaySaoPaulo());
    if (toleranceDays !== undefined && age > toleranceDays) {
      return { kind: 'delayed', ageDays: age };
    }
    return { kind: 'official', ageDays: age };
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* --------------------------------------------------------------- shell */

  function renderShell(pageKey, title) {
    const nav = NAV.map((group) => {
      const links = group.items.map((item) => {
        const current = item.key === pageKey ? ' aria-current="page"' : '';
        return `<a href="${base}${item.href}"${current}>` +
          `<span class="nav__icon" aria-hidden="true">${item.icon}</span>` +
          `<span>${escapeHtml(item.label)}</span></a>`;
      }).join('');
      return `<div class="nav__group-label">${escapeHtml(group.group)}</div>${links}`;
    }).join('');

    const shell = document.getElementById('app-shell');
    if (!shell) return;
    shell.outerHTML = `
      <a class="skip-link" href="#main">Ir para o conteúdo</a>
      <div class="app">
        <aside class="sidebar" aria-label="Navegação principal">
          <div class="sidebar__brand">
            <p class="sidebar__title">Brazil FX Monitor</p>
            <p class="sidebar__subtitle">Reservas, intervenções e pressão cambial</p>
          </div>
          <nav class="nav">${nav}</nav>
          <div class="sidebar__footer" id="shell-footer">Carregando estado…</div>
        </aside>
        <div class="content">
          <header class="topbar">
            <button class="btn btn--icon menu-toggle" id="menu-toggle"
                    aria-label="Abrir menu" aria-expanded="false">☰</button>
            <h1>${escapeHtml(title)}</h1>
            <div class="topbar__spacer"></div>
            <span id="live-quote" class="num" style="font-size:12px;color:var(--text-muted)"></span>
            <button class="btn btn--icon" id="theme-toggle" aria-label="Alternar tema">☀</button>
          </header>
          <main id="main">${document.getElementById('page-body') ? '' : ''}</main>
        </div>
      </div>`;

    const body = document.getElementById('page-template');
    if (body) {
      document.getElementById('main').innerHTML = body.innerHTML;
      body.remove();
    }

    document.getElementById('theme-toggle').addEventListener('click', () => {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });

    const toggle = document.getElementById('menu-toggle');
    toggle.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.querySelectorAll('.nav a').forEach((link) => {
      link.addEventListener('click', () => document.body.classList.remove('nav-open'));
    });
  }

  async function renderFooterState() {
    const footer = document.getElementById('shell-footer');
    if (!footer) return;
    try {
      const state = await load('data/metadata/collection-state.json', { optional: true });
      const alerts = await load('data/alerts/active.json', { optional: true });
      if (!state) { footer.textContent = 'Estado da coleta indisponível.'; return; }
      const sources = Object.values(state.sources || {});
      const failing = sources.filter((s) => s.status !== 'ok' && s.status !== 'unavailable_by_design');
      const count = alerts ? alerts.count : 0;
      footer.innerHTML =
        `<div>Última coleta com dado novo:<br><span class="num">${escapeHtml(utcToSaoPaulo(state.updated_at))}</span></div>` +
        `<div style="margin-top:5px">${sources.length} fontes · ` +
        (failing.length
          ? `<span class="neg">${failing.length} com falha</span>`
          : '<span class="pos">todas ok</span>') +
        `</div>` +
        `<div style="margin-top:3px">${count} alerta(s) ativo(s)</div>`;
    } catch (error) {
      footer.textContent = 'Estado da coleta indisponível.';
    }
  }

  /* ------------------------------------------------------------ live quote */

  const LIVE_SOURCE = {
    name: 'AwesomeAPI USD/BRL',
    endpoint: 'https://economia.awesomeapi.com.br/json/last/USD-BRL',
    classification: 'secondary'
  };

  let liveTimer = null;
  let lastQuote = null;

  async function fetchLiveQuote() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(LIVE_SOURCE.endpoint, { signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      const row = payload && payload.USDBRL;
      if (!row) throw new Error('resposta inesperada');
      const bid = Number(row.bid);
      const change = Number(row.pctChange);
      if (!Number.isFinite(bid)) throw new Error('cotação inválida');
      return {
        bid,
        ask: Number(row.ask),
        high: Number(row.high),
        low: Number(row.low),
        changePct: Number.isFinite(change) ? change : null,
        at: row.create_date || null,
        ok: true
      };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  function startLiveQuote() {
    // The element only exists on the pages that render the sidebar shell; the
    // standalone panel listens to the bfx:quote event and paints it itself.
    const element = document.getElementById('live-quote');
    const enabled = recall('liveQuote', true);
    const intervalSeconds = Number(recall('liveQuoteInterval', 60)) || 60;
    if (!enabled) {
      lastQuote = { ok: false, error: 'cotação ao vivo desligada', disabled: true };
      if (element) {
        element.innerHTML = '<span class="na">cotação ao vivo desligada</span>';
      }
      window.dispatchEvent(new CustomEvent('bfx:quote', { detail: lastQuote }));
      return;
    }
    const tick = async () => {
      const quote = await fetchLiveQuote();
      lastQuote = quote;
      if (!quote.ok) {
        if (element) {
          element.innerHTML = '<span class="na" title="' + escapeHtml(quote.error) +
            '">cotação ao vivo indisponível</span>';
        }
        window.dispatchEvent(new CustomEvent('bfx:quote', { detail: quote }));
        return;
      }
      if (!element) {
        window.dispatchEvent(new CustomEvent('bfx:quote', { detail: quote }));
        return;
      }
      const t = trend(quote.changePct, { invert: true });
      element.innerHTML = `USD/BRL <strong class="num">${escapeHtml(brl(quote.bid))}</strong> ` +
        `<span class="${t.cls}">${escapeHtml(pct(quote.changePct))}</span> ` +
        `<span class="badge badge--secondary" title="Fonte secundária, não é dado do Banco Central">mercado</span>`;
      window.dispatchEvent(new CustomEvent('bfx:quote', { detail: quote }));
    };
    tick();
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(tick, Math.max(15, intervalSeconds) * 1000);
  }

  /* ---------------------------------------------------------------- export */

  function downloadBlob(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function toCsv(rows, columns) {
    const header = columns.map((c) => c.label);
    const body = rows.map((row) => columns.map((c) => {
      const value = typeof c.value === 'function' ? c.value(row) : row[c.value];
      if (value === null || value === undefined) return '';
      const text = String(value);
      return /[",;\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }));
    return [header, ...body].map((line) => line.join(';')).join('\r\n');
  }

  function exportCsv(filename, rows, columns) {
    downloadBlob(filename, '﻿' + toCsv(rows, columns), 'text/csv;charset=utf-8');
  }

  function exportJson(filename, payload) {
    downloadBlob(filename, JSON.stringify(payload, null, 1), 'application/json');
  }

  /* --------------------------------------------------------------- ranges */

  const RANGES = [
    { key: 'today', label: 'Hoje', days: 1 },
    { key: '7d', label: '7 dias', days: 7 },
    { key: '30d', label: '30 dias', days: 30 },
    { key: '90d', label: '90 dias', days: 90 },
    { key: '6m', label: '6 meses', days: 182 },
    { key: '1y', label: '1 ano', days: 365 },
    { key: '2y', label: '2 anos', days: 730 },
    { key: '5y', label: '5 anos', days: 1826 },
    { key: '10y', label: '10 anos', days: 3653 },
    { key: 'max', label: 'Máximo', days: null },
    { key: 'custom', label: 'Personalizado', days: null }
  ];

  function rangeSelector(containerId, { initial = '1y', onChange }) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const stored = recall('range:' + containerId, initial);
    let active = RANGES.some((r) => r.key === stored) ? stored : initial;

    const buttons = RANGES.map((range) =>
      `<button class="btn" data-range="${range.key}" type="button">${range.label}</button>`
    ).join('');
    container.innerHTML =
      `<div class="range-group" role="group" aria-label="Período">${buttons}</div>` +
      `<div class="filters" id="${containerId}-custom" hidden style="margin-top:8px">
         <div class="field"><label for="${containerId}-from">De</label>
           <input type="date" id="${containerId}-from"></div>
         <div class="field"><label for="${containerId}-to">Até</label>
           <input type="date" id="${containerId}-to"></div>
       </div>`;

    const customBox = document.getElementById(containerId + '-custom');
    const fromInput = document.getElementById(containerId + '-from');
    const toInput = document.getElementById(containerId + '-to');
    const savedCustom = recall('range:' + containerId + ':custom', null);
    if (savedCustom) {
      fromInput.value = savedCustom.from || '';
      toInput.value = savedCustom.to || '';
    }

    function emit() {
      container.querySelectorAll('[data-range]').forEach((button) => {
        button.classList.toggle('btn--active', button.dataset.range === active);
        button.setAttribute('aria-pressed', String(button.dataset.range === active));
      });
      customBox.hidden = active !== 'custom';
      store('range:' + containerId, active);
      if (active === 'custom') {
        store('range:' + containerId + ':custom', { from: fromInput.value, to: toInput.value });
        onChange({ key: 'custom', from: fromInput.value || null, to: toInput.value || null, days: null });
      } else {
        const spec = RANGES.find((r) => r.key === active);
        onChange({ key: active, days: spec.days, from: null, to: null });
      }
    }

    container.addEventListener('click', (event) => {
      const button = event.target.closest('[data-range]');
      if (!button) return;
      active = button.dataset.range;
      emit();
    });
    [fromInput, toInput].forEach((input) => input.addEventListener('change', emit));
    emit();
  }

  /** Filter a list of `{date}` records by a range spec. */
  function applyRange(rows, range, anchorDate) {
    if (!rows.length) return rows;
    if (range.key === 'max') return rows;
    if (range.key === 'custom') {
      return rows.filter((row) => (!range.from || row.date >= range.from) &&
        (!range.to || row.date <= range.to));
    }
    const anchor = anchorDate || rows[rows.length - 1].date;
    const [year, month, day] = anchor.slice(0, 10).split('-').map(Number);
    const limit = new Date(Date.UTC(year, month - 1, day - (range.days - 1)))
      .toISOString().slice(0, 10);
    return rows.filter((row) => row.date >= limit);
  }

  /* ----------------------------------------------------------------- boot */

  async function init(pageKey, title) {
    applyTheme(recall('theme', 'dark'));
    renderShell(pageKey, title);
    applyTheme(recall('theme', 'dark'));
    renderFooterState();
    startLiveQuote();
  }

  /** Boot for a page that draws its own layout instead of the sidebar shell. */
  async function initStandalone() {
    applyTheme(recall('theme', 'dark'));
    const body = document.getElementById('page-template');
    const target = document.getElementById('main');
    if (body && target) {
      target.innerHTML = body.innerHTML;
      body.remove();
    }
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      });
      applyTheme(recall('theme', 'dark'));
    }
    startLiveQuote();
  }

  return {
    base, NAV, RANGES, LIVE_SOURCE,
    init, initStandalone, load, reload, store, recall, forget,
    usd, usdCents, brl, pct, number, naText, date, stamp, utcToSaoPaulo,
    daysBetween, todaySaoPaulo, trend, deltaHtml, qualityBadge, freshness,
    escapeHtml, exportCsv, exportJson, downloadBlob, toCsv,
    rangeSelector, applyRange, fetchLiveQuote, applyTheme, currentTheme,
    lastQuote: () => lastQuote
  };
})();

window.BFX = BFX;
