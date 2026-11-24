/* Central de alertas: server-evaluated defaults plus browser-side custom thresholds. */
'use strict';

window.PAGE = (() => {
  let rules, active, history, summary, series;

  function thresholds() {
    return BFX.recall('thresholds', {});
  }

  function enabled() {
    return BFX.recall('ruleEnabled', {});
  }

  function thresholdFor(rule) {
    const custom = thresholds()[rule.key];
    return custom === undefined || custom === null || custom === ''
      ? rule.default_threshold
      : Number(custom);
  }

  function isEnabled(rule) {
    const map = enabled();
    return map[rule.key] === undefined ? true : Boolean(map[rule.key]);
  }

  /* Re-evaluate the numeric rules with the user thresholds. The rules that
     depend on collection state stay as the automatic routines computed them. */
  function evaluateCustom() {
    const results = [];
    const reserves = summary.reserves.cash;
    const ptax = summary.market.ptax;
    const windows = summary.interventions.windows;
    const anchor = summary.interventions.anchor_date;
    const daily = series.interventions_daily;

    const push = (ruleKey, observed, description, referenceDate) => {
      const rule = rules.rules.find((item) => item.key === ruleKey);
      if (!rule || !isEnabled(rule)) return;
      const limit = thresholdFor(rule);
      if (limit === null || limit === undefined) return;
      const triggered = rule.comparison === '<='
        ? observed <= limit
        : rule.comparison === '>'
          ? observed > limit
          : observed >= limit;
      if (!triggered) return;
      results.push({
        rule_key: rule.key, label: rule.label, indicator: rule.indicator,
        severity: rule.severity, unit: rule.unit, observed_value: observed,
        threshold: limit, comparison: rule.comparison, description,
        source: rule.source, page: rule.page, reference_date: referenceDate,
        detected_date_sao_paulo: BFX.todaySaoPaulo(),
        detected_time_sao_paulo: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        thresholds_used: 'personalizado'
      });
    };

    const recent = daily.filter((row) =>
      row.date >= new Date(Date.parse(anchor) - 30 * 86400000).toISOString().slice(0, 10));
    const peak = recent.reduce((top, row) => (row.sold_cents > (top ? top.sold_cents : -1) ? row : top), null);
    if (peak && peak.sold_cents) {
      push('direct_sale_day_above_1bn', peak.sold_cents / 100,
        `Em ${BFX.date(peak.date)} foram liquidados ${BFX.usdCents(peak.sold_cents)} em vendas diretas.`,
        peak.date);
    }
    push('direct_sale_7d_above_5bn', windows['7'].sold_usd_cents / 100,
      `Vendas diretas de ${BFX.usdCents(windows['7'].sold_usd_cents)} em 7 dias até ${BFX.date(anchor)}.`, anchor);
    push('direct_sale_30d_above_10bn', windows['30'].sold_usd_cents / 100,
      `Vendas diretas de ${BFX.usdCents(windows['30'].sold_usd_cents)} em 30 dias até ${BFX.date(anchor)}.`, anchor);

    if (reserves) {
      [['reserves_drop_7d_above_1pct', '7'], ['reserves_drop_30d_above_2pct', '30'],
        ['reserves_drop_90d_above_5pct', '90']].forEach(([key, window_]) => {
        const change = reserves.changes[window_].change_pct;
        if (change === null) return;
        push(key, change,
          `As reservas variaram ${BFX.pct(change)} em ${window_} dias até ${BFX.date(reserves.reference_date)}.`,
          reserves.reference_date);
      });
    }

    ['usd_above_6', 'usd_above_6_5', 'usd_above_7'].forEach((key) => {
      if (ptax.sell === null) return;
      push(key, ptax.sell,
        `A PTAX de venda fechou em ${BFX.brl(ptax.sell)} em ${BFX.date(ptax.reference_date)}.`,
        ptax.reference_date);
    });
    if (ptax.changes['7'].change_pct !== null) {
      push('usd_up_7d_above_5pct', ptax.changes['7'].change_pct,
        `A PTAX variou ${BFX.pct(ptax.changes['7'].change_pct)} em 7 dias até ${BFX.date(ptax.reference_date)}.`,
        ptax.reference_date);
    }

    const portfolio = summary.exchange_flow.indicators.portfolio_investment_net;
    if (portfolio && portfolio.negative_month_streak !== null) {
      push('financial_account_negative_streak', portfolio.negative_month_streak,
        `${portfolio.negative_month_streak} mês(es) consecutivos com investimentos em carteira negativos.`,
        portfolio.reference_date);
    }

    const order = { critica: 0, alta: 1, atencao: 2, info: 3 };
    results.sort((a, b) => (order[a.severity] - order[b.severity]));
    return results;
  }

  function currentList() {
    return document.getElementById('use-custom').checked ? evaluateCustom() : (active.alerts || []);
  }

  function cards() {
    const list = currentList();
    const counts = { critica: 0, alta: 0, atencao: 0, info: 0 };
    list.forEach((alert) => { counts[alert.severity] = (counts[alert.severity] || 0) + 1; });
    const card = (label, value, meta) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${BFX.escapeHtml(meta)}</p>` : ''}</div>`;
    document.getElementById('alert-cards').innerHTML = [
      card('Alertas ativos', BFX.number(list.length),
        document.getElementById('use-custom').checked ? 'com os seus limites' : 'com os limites padrão'),
      card('Críticos', BFX.number(counts.critica), 'severidade mais alta'),
      card('Altos', BFX.number(counts.alta), ''),
      card('Atenção', BFX.number(counts.atencao), ''),
      card('Informativos', BFX.number(counts.info), ''),
      card('Histórico acumulado', BFX.number(history.count || 0),
        'gerado pelas rotinas automáticas com os limites padrão')
    ].join('');
  }

  function activeTable() {
    const list = currentList();
    const body = document.getElementById('active-body');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="9" class="card__meta-row">Nenhum alerta ativo.</td></tr>';
      return;
    }
    body.innerHTML = list.map((alert) => `<tr>
      <td><span class="badge badge--${BFX.escapeHtml(alert.severity)}">${BFX.escapeHtml(alert.severity)}</span></td>
      <td class="wrap">${BFX.escapeHtml(alert.indicator)}</td>
      <td class="right num">${BFX.escapeHtml(String(alert.observed_value))}${alert.unit === '%' ? '%' : ''}</td>
      <td class="right num">${alert.threshold === null || alert.threshold === undefined ? '—' : BFX.escapeHtml(String(alert.threshold))}</td>
      <td class="num">${BFX.date(alert.reference_date)}</td>
      <td class="num">${BFX.escapeHtml(alert.detected_date_sao_paulo)} ${BFX.escapeHtml(alert.detected_time_sao_paulo || '')}</td>
      <td class="wrap">${BFX.escapeHtml(alert.description)}</td>
      <td class="wrap">${BFX.escapeHtml(alert.source)}</td>
      <td><a href="${BFX.base}${BFX.escapeHtml(alert.page)}">abrir dados</a>${alert.official_url ? ` · <a href="${BFX.escapeHtml(alert.official_url)}" target="_blank" rel="noopener noreferrer">fonte oficial</a>` : ''}</td>
    </tr>`).join('');
  }

  function rulesTable() {
    const custom = thresholds();
    const on = enabled();
    document.getElementById('rules-body').innerHTML = rules.rules.map((rule) => `<tr>
      <td class="wrap">${BFX.escapeHtml(rule.label)}</td>
      <td class="wrap">${BFX.escapeHtml(rule.indicator)}</td>
      <td>${BFX.escapeHtml(rule.unit)}</td>
      <td class="num">${BFX.escapeHtml(rule.comparison)}</td>
      <td class="right num">${rule.default_threshold === null ? '—' : BFX.number(rule.default_threshold, rule.unit === 'BRL' ? 2 : 0)}</td>
      <td>${rule.default_threshold === null
        ? '<span class="na">não configurável</span>'
        : `<input type="number" step="any" data-threshold="${rule.key}"
              value="${custom[rule.key] === undefined ? '' : BFX.escapeHtml(String(custom[rule.key]))}"
              placeholder="${rule.default_threshold}" style="width:140px">`}</td>
      <td><input type="checkbox" data-enabled="${rule.key}"
            ${on[rule.key] === false ? '' : 'checked'}></td>
    </tr>`).join('');

    document.querySelectorAll('[data-threshold]').forEach((input) => {
      input.addEventListener('change', () => {
        const map = thresholds();
        if (input.value === '') delete map[input.dataset.threshold];
        else map[input.dataset.threshold] = Number(input.value);
        BFX.store('thresholds', map);
        refresh();
      });
    });
    document.querySelectorAll('[data-enabled]').forEach((input) => {
      input.addEventListener('change', () => {
        const map = enabled();
        map[input.dataset.enabled] = input.checked;
        BFX.store('ruleEnabled', map);
        refresh();
      });
    });
  }

  function historyTable() {
    const severity = document.getElementById('history-severity').value;
    const rows = (history.alerts || [])
      .filter((alert) => severity === 'all' || alert.severity === severity)
      .slice().reverse();
    const body = document.getElementById('history-body');
    body.innerHTML = rows.length
      ? rows.map((alert) => `<tr>
          <td class="num">${BFX.escapeHtml(alert.detected_date_sao_paulo)} ${BFX.escapeHtml(alert.detected_time_sao_paulo || '')}</td>
          <td><span class="badge badge--${BFX.escapeHtml(alert.severity)}">${BFX.escapeHtml(alert.severity)}</span></td>
          <td class="wrap">${BFX.escapeHtml(alert.label)}</td>
          <td class="right num">${BFX.escapeHtml(String(alert.observed_value))}</td>
          <td class="right num">${alert.threshold === null ? '—' : BFX.escapeHtml(String(alert.threshold))}</td>
          <td class="num">${BFX.date(alert.reference_date)}</td>
          <td class="wrap">${BFX.escapeHtml(alert.description)}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="card__meta-row">Nenhum alerta no histórico com este filtro.</td></tr>';
  }

  function notifyNew(list) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const seen = BFX.recall('notifiedAlerts', []);
    const fresh = list.filter((alert) =>
      !seen.includes(alert.rule_key + ':' + (alert.reference_date || '')) &&
      ['critica', 'alta'].includes(alert.severity));
    fresh.slice(0, 3).forEach((alert) => {
      try {
        new Notification('Brazil FX Monitor: ' + alert.label, {
          body: alert.description, tag: alert.rule_key
        });
      } catch (error) { /* some browsers block constructor notifications */ }
    });
    BFX.store('notifiedAlerts',
      list.map((alert) => alert.rule_key + ':' + (alert.reference_date || '')).slice(-200));
  }

  function refresh() {
    cards();
    activeTable();
    notifyNew(currentList());
  }

  async function init() {
    [rules, active, history, summary, series] = await Promise.all([
      BFX.load('data/alerts/rules.json'),
      BFX.load('data/alerts/active.json'),
      BFX.load('data/alerts/history.json'),
      BFX.load('data/indicators/summary.json'),
      BFX.load('data/indicators/series.json')
    ]);

    const useCustom = document.getElementById('use-custom');
    useCustom.checked = BFX.recall('useCustomThresholds', false);
    useCustom.addEventListener('change', () => {
      BFX.store('useCustomThresholds', useCustom.checked);
      refresh();
    });

    document.getElementById('reset-thresholds').addEventListener('click', () => {
      BFX.forget('thresholds');
      BFX.forget('ruleEnabled');
      rulesTable();
      refresh();
    });

    document.getElementById('history-severity').addEventListener('change', historyTable);
    document.getElementById('export-history').addEventListener('click', () => {
      BFX.exportCsv('historico-alertas.csv', history.alerts || [], [
        { label: 'detectado_em', value: (row) => row.detected_date_sao_paulo + ' ' + (row.detected_time_sao_paulo || '') },
        { label: 'severidade', value: 'severity' },
        { label: 'regra', value: 'label' },
        { label: 'indicador', value: 'indicator' },
        { label: 'valor_observado', value: 'observed_value' },
        { label: 'limite', value: 'threshold' },
        { label: 'data_referencia', value: 'reference_date' },
        { label: 'descricao', value: 'description' },
        { label: 'fonte', value: 'source' }
      ]);
    });

    const notify = document.getElementById('notify-btn');
    const syncNotifyButton = () => {
      if (!('Notification' in window)) {
        notify.textContent = 'Notificações não suportadas neste navegador';
        notify.disabled = true;
        return;
      }
      notify.textContent = Notification.permission === 'granted'
        ? 'Notificações ativadas'
        : Notification.permission === 'denied'
          ? 'Notificações bloqueadas no navegador'
          : 'Ativar notificações do navegador';
      notify.disabled = Notification.permission !== 'default';
    };
    notify.addEventListener('click', async () => {
      try {
        await Notification.requestPermission();
      } catch (error) { /* ignore */ }
      syncNotifyButton();
      refresh();
    });
    syncNotifyButton();

    rulesTable();
    historyTable();
    refresh();
  }

  return { init };
})();
