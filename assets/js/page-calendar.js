/* Calendário de intervenções e mapa anual. */
'use strict';

window.PAGE = (() => {
  let series, index, statementIndex, summary, categories;
  let dailyMap = new Map(), statementMap = new Map();
  let cursor, selected = null;

  const CENTS = (value) => BFX.usdCents(value);
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  const LEGEND = [
    { key: 'sale', label: 'Venda direta de dólares', mark: 'V', cls: 'calendar__day--sale' },
    { key: 'purchase', label: 'Compra direta de dólares', mark: 'C', cls: 'calendar__day--purchase' },
    { key: 'temporary', label: 'Operação com compromisso de recompra', mark: 'R', cls: 'calendar__day--temporary' },
    { key: 'swap', label: 'Swap cambial (valor nocional)', mark: 'S', cls: 'calendar__day--swap' },
    { key: 'multiple', label: 'Múltiplas intervenções', mark: '+', cls: 'calendar__day--multiple' },
    { key: 'none', label: 'Dia sem intervenção confirmada', mark: '·', cls: 'calendar__day--none' },
    { key: 'nodata', label: 'Dia sem dados disponíveis', mark: '?', cls: 'calendar__day--nodata' }
  ];

  function classify(date) {
    // O limite é até onde há informação apurada, somando o arquivo mensal e os
    // comunicados do dia, e não até onde o arquivo mensal chegou.
    const coveredUntil = summary.interventions.covered_until || index.reference_date;
    if (date > coveredUntil || date < index.first_date) return { key: 'nodata' };
    const row = dailyMap.get(date);
    if (!row) return { key: 'none' };
    const kinds = [];
    if (row.sold_cents > 0) kinds.push('sale');
    if (row.bought_cents > 0) kinds.push('purchase');
    if (row.temporary_out_cents > 0 || row.temporary_back_cents > 0) kinds.push('temporary');
    if (row.swap_traditional_cents > 0 || row.swap_reverse_cents > 0) kinds.push('swap');
    if (!kinds.length) return { key: 'none' };
    if (kinds.length > 1) return { key: 'multiple', kinds };
    return { key: kinds[0], kinds };
  }

  function renderLegend() {
    document.getElementById('calendar-legend').innerHTML = LEGEND.map((item) => {
      const spec = LEGEND.find((l) => l.key === item.key);
      return `<span><i class="${spec.cls}" style="border-color:currentColor"></i>` +
        `<code style="font-family:var(--mono)">${spec.mark}</code> ${BFX.escapeHtml(item.label)}</span>`;
    }).join('');
  }

  function renderCalendar() {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    document.getElementById('month-title').textContent = `${MONTHS[month]} de ${year}`;
    document.getElementById('month-input').value =
      `${year}-${String(month + 1).padStart(2, '0')}`;

    const first = new Date(Date.UTC(year, month, 1));
    const offset = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    const cells = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
      .map((dow) => `<div class="calendar__dow" role="columnheader">${dow}</div>`);
    for (let i = 0; i < offset; i += 1) {
      cells.push('<div class="calendar__day calendar__day--empty" role="gridcell"></div>');
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const kind = classify(date);
      const spec = LEGEND.find((l) => l.key === kind.key);
      const row = dailyMap.get(date);
      const amount = row && row.sold_cents ? CENTS(row.sold_cents) : '';
      cells.push(
        `<button type="button" class="calendar__day ${spec.cls}" role="gridcell"
                 data-date="${date}" aria-pressed="${selected === date}"
                 aria-label="${BFX.escapeHtml(BFX.date(date))}: ${BFX.escapeHtml(spec.label)}${amount ? ', ' + amount : ''}">
          <strong>${day}</strong>
          <span class="calendar__mark" aria-hidden="true">${spec.mark}</span>
        </button>`);
    }
    const container = document.getElementById('calendar');
    container.innerHTML = cells.join('');
    container.querySelectorAll('[data-date]').forEach((button) => {
      button.addEventListener('click', () => selectDay(button.dataset.date));
    });
  }

  async function ensureStatement(year) {
    if (statementMap.has('year:' + year)) return;
    const meta = statementIndex.concepts.find((c) => c.concept === 'cash') || {};
    const spec = (meta.years || []).find((y) => String(y.year) === String(year));
    if (!spec) { statementMap.set('year:' + year, true); return; }
    const document_ = await BFX.load(spec.file, { optional: true });
    if (document_) {
      document_.days.forEach((day) => statementMap.set(day.date, day));
    }
    statementMap.set('year:' + year, true);
  }

  async function operationsFor(date) {
    const year = date.slice(0, 4);
    const spec = index.years.find((y) => String(y.year) === year);
    if (!spec) return [];
    const document_ = await BFX.load(spec.file, { optional: true });
    if (!document_) return [];
    return document_.operations.filter((operation) =>
      operation.trade_date === date || operation.settlement_date === date ||
      operation.maturity_date === date);
  }

  async function selectDay(date) {
    selected = date;
    renderCalendar();
    const title = document.getElementById('day-title');
    const detail = document.getElementById('day-detail');
    title.textContent = BFX.date(date, { withWeekday: true });
    detail.innerHTML = '<p class="loading">Carregando…</p>';

    await ensureStatement(date.slice(0, 4));
    const statementDay = statementMap.get(date);
    const row = dailyMap.get(date) || {
      sold_cents: 0, bought_cents: 0, temporary_out_cents: 0, temporary_back_cents: 0,
      swap_traditional_cents: 0, swap_reverse_cents: 0, operations: 0
    };
    const operations = await operationsFor(date);

    const noData = date > index.reference_date;
    const header = noData
      ? `<div class="notice notice--warn">As atuações desta data ainda não foram
           publicadas pelo Banco Central. Não é possível afirmar que não houve
           intervenção.</div>`
      : '';

    const ptaxPoint = series.ptax.find((point) => point.date === date);
    const ptaxPrevious = (() => {
      const indexOf = series.ptax.findIndex((point) => point.date === date);
      return indexOf > 0 ? series.ptax[indexOf - 1] : null;
    })();
    const variation = ptaxPoint && ptaxPrevious
      ? ((ptaxPoint.value - ptaxPrevious.value) / ptaxPrevious.value) * 100
      : null;

    detail.innerHTML = header + `
      <dl class="detail-grid">
        <div><dt>Total vendido diretamente</dt><dd>${CENTS(row.sold_cents)}</dd></div>
        <div><dt>Total comprado diretamente</dt><dd>${CENTS(row.bought_cents)}</dd></div>
        <div><dt>Operações temporárias (saída)</dt><dd>${CENTS(row.temporary_out_cents)}</dd></div>
        <div><dt>Retorno de operações temporárias</dt><dd>${CENTS(row.temporary_back_cents)}</dd></div>
        <div><dt>Swap tradicional (nocional)</dt><dd>${CENTS(row.swap_traditional_cents)}</dd></div>
        <div><dt>Swap reverso (nocional)</dt><dd>${CENTS(row.swap_reverse_cents)}</dd></div>
        <div><dt>Saldo inicial das reservas</dt><dd>${statementDay ? BFX.usd(statementDay.opening_usd) : '<span class="na">sem saldo publicado nesta data</span>'}</dd></div>
        <div><dt>Saldo final das reservas</dt><dd>${statementDay ? BFX.usd(statementDay.closing_usd) : '<span class="na">sem saldo publicado nesta data</span>'}</dd></div>
        <div><dt>Variação das reservas</dt><dd>${statementDay ? BFX.usd(statementDay.variation_usd, { sign: true }) : '<span class="na">—</span>'}</dd></div>
        <div><dt>Variação não identificada</dt><dd>${statementDay && statementDay.unidentified_variation_usd !== null ? BFX.usd(statementDay.unidentified_variation_usd, { sign: true }) : '<span class="na">—</span>'}</dd></div>
        <div><dt>PTAX de venda</dt><dd>${ptaxPoint ? BFX.brl(ptaxPoint.value) : '<span class="na">sem PTAX nesta data</span>'}</dd></div>
        <div><dt>Variação cambial no dia</dt><dd>${BFX.pct(variation)}</dd></div>
      </dl>
      ${operations.length ? `<div class="table-wrap"><table class="data">
        <caption>Operações registradas nesta data (negociação, liquidação ou vencimento)</caption>
        <thead><tr><th>Tipo</th><th>Instrumento / modalidade</th><th>Negociação</th>
          <th>Liquidação</th><th>Vencimento</th><th class="right">Ofertado</th>
          <th class="right">Negociado</th><th class="right">Taxa</th><th>Status</th>
          <th>Efeito</th><th>Fonte oficial</th></tr></thead>
        <tbody>${operations.map((operation) => {
          const spec = categories[operation.category];
          return `<tr>
            <td>${BFX.escapeHtml(spec.label)}</td>
            <td>${BFX.escapeHtml(operation.instrument)} / ${BFX.escapeHtml(operation.modality)}</td>
            <td class="num">${BFX.date(operation.trade_date)}</td>
            <td class="num">${BFX.date(operation.settlement_date)}</td>
            <td class="num">${operation.maturity_date ? BFX.date(operation.maturity_date) : '—'}</td>
            <td class="right num">${operation.volume_offered_usd_cents === null ? '—' : CENTS(operation.volume_offered_usd_cents)}</td>
            <td class="right num">${operation.counts_as_executed ? CENTS(operation.volume_accepted_usd_cents) : '<span class="na">não realizada</span>'}</td>
            <td class="right num">${operation.cut_rate === null ? '—' : BFX.number(operation.cut_rate, 4)}</td>
            <td>${BFX.escapeHtml(operation.status.replace(/_/g, ' '))}</td>
            <td>${spec.notional ? '<span class="chip chip--notional">nocional</span>' : spec.temporary ? '<span class="chip chip--temporary">temporária</span>' : spec.reserve_effect === 'decrease' ? '<span class="chip chip--outflow">reduz</span>' : '<span class="chip chip--inflow">aumenta</span>'}</td>
            <td>${operation.communication_number
              ? `<a href="https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Comunicado&numero=${encodeURIComponent(operation.communication_number)}" target="_blank" rel="noopener noreferrer">Comunicado ${BFX.escapeHtml(operation.communication_number)}</a>`
              : `<a href="${BFX.escapeHtml(index.source.landing_page)}" target="_blank" rel="noopener noreferrer">Conjunto de dados</a>`}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`
        : '<p class="card__meta-row">Nenhuma operação registrada nesta data na fonte oficial.</p>'}
      <p style="margin-top:10px"><a href="transactions.html?date=${date}">Ver esta data na página de movimentações</a></p>`;
  }

  function renderHeatmap() {
    const year = document.getElementById('heatmap-year').value;
    const metric = document.getElementById('heatmap-metric').value;
    const colors = BFXCharts.palette();

    const field = {
      sold: 'sold_cents', bought: 'bought_cents',
      operations: 'operations', swap: 'swap_traditional_cents'
    }[metric];

    const rows = series.interventions_daily
      .filter((row) => row.date.startsWith(year) && row[field] > 0)
      .map((row) => [row.date, metric === 'operations' ? row[field] : row[field] / 100]);

    const maximum = rows.reduce((top, row) => Math.max(top, row[1]), 0) || 1;
    const title = {
      sold: 'Volume vendido diretamente', bought: 'Volume comprado diretamente',
      operations: 'Número de operações', swap: 'Valor nocional de swaps tradicionais'
    }[metric];

    BFXCharts.create('chart-heatmap', {
      dataZoom: [],
      toolbox: { feature: { dataZoom: { show: false }, restore: {}, saveAsImage: {} } },
      legend: { show: false },
      grid: undefined,
      xAxis: undefined,
      yAxis: undefined,
      tooltip: {
        trigger: 'item',
        formatter: (params) => {
          const value = params.value[1];
          return `<strong>${BFX.date(params.value[0])}</strong><br>${BFX.escapeHtml(title)}: ` +
            (metric === 'operations' ? BFX.number(value) : BFX.usd(value));
        }
      },
      visualMap: {
        min: 0, max: maximum, calculable: true, orient: 'horizontal',
        left: 'center', bottom: 4,
        textStyle: { color: colors.dim, fontSize: 10 },
        inRange: {
          color: metric === 'bought'
            ? [colors.raised, colors.inflow]
            : metric === 'swap'
              ? [colors.raised, colors.notional]
              : [colors.raised, colors.warn, colors.outflow]
        },
        formatter: (value) => (metric === 'operations' ? BFX.number(value) : BFX.usd(value, { digits: 1 }))
      },
      calendar: {
        top: 56, left: 44, right: 16, cellSize: ['auto', 13], range: year,
        itemStyle: { color: colors.card, borderColor: colors.border, borderWidth: 1 },
        dayLabel: { color: colors.dim, nameMap: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] },
        monthLabel: {
          color: colors.muted,
          nameMap: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
        },
        yearLabel: { show: false },
        splitLine: { lineStyle: { color: colors.border } }
      },
      series: [{
        type: 'heatmap', coordinateSystem: 'calendar', data: rows
      }]
    });

    const chart = BFXCharts.registry.get('chart-heatmap');
    if (chart) {
      chart.off('click');
      chart.on('click', (params) => {
        if (!params.value) return;
        const date = String(params.value[0]).slice(0, 10);
        cursor = new Date(date + 'T00:00:00Z');
        renderCalendar();
        selectDay(date);
      });
    }
  }

  async function init() {
    [series, index, statementIndex, summary] = await Promise.all([
      BFX.load('data/indicators/series.json'),
      BFX.load('data/interventions/index.json'),
      BFX.load('data/reserves/statement-index.json'),
      BFX.load('data/indicators/summary.json')
    ]);
    categories = index.categories;
    series.interventions_daily.forEach((row) => dailyMap.set(row.date, row));

    document.getElementById('coverage-notice').innerHTML =
      `<div class="notice notice--info">
        <strong>Atuações apuradas de ${BFX.date(index.first_date)} a
        ${BFX.date(summary.interventions.covered_until)}.</strong>
        Até <strong>${BFX.date(summary.interventions.consolidated_until)}</strong> os
        números vêm do arquivo mensal consolidado. De lá até
        <strong>${BFX.date(summary.interventions.covered_until)}</strong> vêm dos
        comunicados publicados no mesmo dia do leilão. Dias depois dessa data
        aparecem como sem dados, não como dias sem intervenção.
      </div>`;

    renderLegend();

    const reference = summary.interventions.covered_until || index.reference_date;
    cursor = new Date(reference.slice(0, 7) + '-01T00:00:00Z');
    renderCalendar();
    selectDay(reference);

    document.getElementById('prev-month').addEventListener('click', () => {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
      renderCalendar();
    });
    document.getElementById('next-month').addEventListener('click', () => {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      renderCalendar();
    });
    document.getElementById('month-input').addEventListener('change', (event) => {
      if (!event.target.value) return;
      cursor = new Date(event.target.value + '-01T00:00:00Z');
      renderCalendar();
    });

    const yearSelect = document.getElementById('heatmap-year');
    yearSelect.innerHTML = index.years.slice().reverse()
      .map((year) => `<option value="${year.year}">${year.year}</option>`).join('');
    yearSelect.value = reference.slice(0, 4);
    yearSelect.addEventListener('change', renderHeatmap);
    document.getElementById('heatmap-metric').addEventListener('change', renderHeatmap);
    renderHeatmap();
  }

  return { init };
})();
