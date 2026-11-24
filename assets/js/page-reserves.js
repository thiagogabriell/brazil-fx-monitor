/* Extrato das reservas: daily statement with reconciliation. */
'use strict';

window.PAGE = (() => {
  let statementIndex, reservesIndex, concept, yearData = null, rows = [], filtered = [];
  let seriesCache = {};

  const CENTS = (value) => BFX.usdCents(value);

  function conceptMeta() {
    return statementIndex.concepts.find((c) => c.concept === concept) || {};
  }

  async function loadYear(year) {
    const meta = conceptMeta();
    if (year === 'latest') {
      const document_ = await BFX.load(meta.latest_file);
      return document_.days;
    }
    const spec = (meta.years || []).find((y) => String(y.year) === String(year));
    if (!spec) return [];
    const document_ = await BFX.load(spec.file);
    return document_.days;
  }

  function coverageNotice() {
    const coverage = statementIndex.interventions_coverage;
    document.getElementById('coverage-notice').innerHTML =
      `<div class="notice notice--warn">
        <strong>Cobertura das atuações:</strong>
        ${BFX.date(coverage.from)} a ${BFX.date(coverage.to)}.
        ${BFX.escapeHtml(coverage.note)}
      </div>`;
  }

  function statusCell(day) {
    if (day.interventions_coverage === 'not_yet_published') {
      return '<span class="badge badge--unavailable">sem dados de atuação</span>';
    }
    if (day.interventions_coverage === 'before_source_start') {
      return '<span class="badge badge--unavailable">antes do início da fonte</span>';
    }
    if (day.operation_count === 0 && day.announced_without_result_count === 0) {
      return '<span class="badge badge--official">sem operação confirmada</span>';
    }
    const chips = [];
    if (day.direct_sold_usd_cents) chips.push('<span class="chip chip--outflow">venda direta</span>');
    if (day.direct_bought_usd_cents) chips.push('<span class="chip chip--inflow">compra direta</span>');
    if (day.temporary_out_usd_cents) chips.push('<span class="chip chip--temporary">temporária</span>');
    if (day.temporary_returned_usd_cents) chips.push('<span class="chip chip--inflow">retorno temporária</span>');
    if (day.swap_traditional_notional_usd_cents || day.swap_reverse_notional_usd_cents) {
      chips.push('<span class="chip chip--notional">swap (nocional)</span>');
    }
    if (day.announced_without_result_count) {
      chips.push('<span class="chip">só anunciada</span>');
    }
    return chips.join(' ') || '<span class="badge badge--official">sem operação confirmada</span>';
  }

  function detailHtml(day) {
    const operationRow = (operation, label) => `
      <tr>
        <td>${BFX.escapeHtml(label)}</td>
        <td>${BFX.escapeHtml(operation.category_label)}</td>
        <td>${BFX.escapeHtml(operation.instrument)} / ${BFX.escapeHtml(operation.modality)}</td>
        <td>${BFX.date(operation.trade_date)}</td>
        <td>${BFX.date(operation.settlement_date)}</td>
        <td>${operation.maturity_date ? BFX.date(operation.maturity_date) : '<span class="na">não aplicável</span>'}</td>
        <td class="right num">${CENTS(operation.offered_usd_cents)}</td>
        <td class="right num">${CENTS(operation.accepted_usd_cents)}</td>
        <td class="right num">${operation.cut_rate === null ? '<span class="na">não divulgada</span>' : BFX.number(operation.cut_rate, 6)}</td>
        <td>USD</td>
        <td>${BFX.escapeHtml(operation.status)}</td>
        <td>${operation.communication_number
          ? `<a href="https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Comunicado&numero=${encodeURIComponent(operation.communication_number)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(operation.communication_number)}</a>`
          : '<span class="na">sem comunicado</span>'}</td>
      </tr>`;

    const groups = [
      ...day.operations.map((operation) => operationRow(operation, 'Liquidada no dia')),
      ...day.maturing_operations.map((operation) => operationRow(operation, 'Vencimento no dia')),
      ...day.notional_operations.map((operation) => operationRow(operation, 'Swap negociado (nocional)')),
      ...day.announced_operations.map((operation) => operationRow(operation, 'Apenas anunciada'))
    ];

    return `
      <dl class="detail-grid">
        <div><dt>Saldo inicial</dt><dd>${BFX.usd(day.opening_usd)}</dd></div>
        <div><dt>Saldo final</dt><dd>${BFX.usd(day.closing_usd)}</dd></div>
        <div><dt>Variação absoluta</dt><dd>${BFX.usd(day.variation_usd, { sign: true })}</dd></div>
        <div><dt>Variação percentual</dt><dd>${BFX.pct(day.variation_pct)}</dd></div>
        <div><dt>Dias de calendário desde o saldo anterior</dt><dd>${BFX.number(day.calendar_gap_days)}</dd></div>
        <div><dt>Valor retirado por intervenções confirmadas</dt><dd>${CENTS(day.confirmed_outflow_usd_cents)}</dd></div>
        <div><dt>Valor adicionado por operações confirmadas</dt><dd>${CENTS(day.confirmed_inflow_usd_cents)}</dd></div>
        <div><dt>Total vendido diretamente</dt><dd>${CENTS(day.direct_sold_usd_cents)}</dd></div>
        <div><dt>Total comprado diretamente</dt><dd>${CENTS(day.direct_bought_usd_cents)}</dd></div>
        <div><dt>Volume de operações temporárias</dt><dd>${CENTS(day.temporary_out_usd_cents)}</dd></div>
        <div><dt>Retorno de operações anteriores</dt><dd>${CENTS(day.temporary_returned_usd_cents)}</dd></div>
        <div><dt>Swap cambial tradicional (nocional)</dt><dd>${CENTS(day.swap_traditional_notional_usd_cents)}</dd></div>
        <div><dt>Swap cambial reverso (nocional)</dt><dd>${CENTS(day.swap_reverse_notional_usd_cents)}</dd></div>
        <div><dt>Variação explicada pelas operações</dt><dd>${day.explained_variation_usd === null ? '<span class="na">não calculável</span>' : BFX.usd(day.explained_variation_usd, { sign: true })}</dd></div>
        <div><dt>Variação não identificada</dt><dd>${day.unidentified_variation_usd === null ? '<span class="na">não calculável</span>' : BFX.usd(day.unidentified_variation_usd, { sign: true })}</dd></div>
        <div><dt>Outras variações identificadas</dt><dd><span class="na">não divulgadas por dia pelo BCB</span></dd></div>
      </dl>
      ${day.notional_note ? `<p class="notice notice--info">${BFX.escapeHtml(day.notional_note)}</p>` : ''}
      ${day.interventions_coverage !== 'covered'
        ? '<p class="notice notice--warn">As atuações desta data ainda não foram publicadas. A ausência de operações aqui <strong>não significa</strong> que não houve intervenção.</p>'
        : ''}
      ${groups.length
        ? `<div class="table-wrap"><table class="data">
            <caption>Operações associadas a este dia</caption>
            <thead><tr><th>Papel no dia</th><th>Tipo</th><th>Instrumento / modalidade</th>
              <th>Data da operação</th><th>Liquidação</th><th>Vencimento</th>
              <th class="right">Ofertado</th><th class="right">Negociado</th>
              <th class="right">Taxa de câmbio</th><th>Moeda</th><th>Status</th><th>Fonte oficial</th></tr></thead>
            <tbody>${groups.join('')}</tbody></table></div>`
        : '<p class="card__meta-row">Nenhuma operação associada a este dia na fonte oficial.</p>'}
      <p class="card__meta-row" style="margin-top:8px">
        Classe de ativo de origem: <strong>não divulgada pelo Banco Central</strong>,
        exceto quando a modalidade publicada identifica o ativo.
      </p>`;
  }

  function applyFilters() {
    const from = document.getElementById('from-date').value;
    const to = document.getElementById('to-date').value;
    const kind = document.getElementById('filter-kind').value;
    const minimum = Number(document.getElementById('min-variation').value || 0) * 1e6;

    filtered = rows.filter((day) => {
      if (from && day.date < from) return false;
      if (to && day.date > to) return false;
      if (minimum > 0 && Math.abs(day.variation_usd || 0) < minimum) return false;
      switch (kind) {
        case 'with-operation': return day.operation_count > 0;
        case 'with-sale': return day.direct_sold_usd_cents > 0;
        case 'with-purchase': return day.direct_bought_usd_cents > 0;
        case 'with-temporary':
          return day.temporary_out_usd_cents > 0 || day.temporary_returned_usd_cents > 0;
        case 'with-swap':
          return day.swap_traditional_notional_usd_cents > 0 ||
            day.swap_reverse_notional_usd_cents > 0;
        case 'uses-reserves':
          return day.confirmed_outflow_usd_cents > 0 || day.confirmed_inflow_usd_cents > 0;
        case 'unexplained':
          return day.unidentified_variation_usd !== null &&
            Math.abs(day.unidentified_variation_usd) >= 100e6;
        case 'no-data': return day.interventions_coverage !== 'covered';
        default: return true;
      }
    });
    renderTable();
    renderCards();
  }

  function renderCards() {
    const sold = filtered.reduce((total, day) => total + day.direct_sold_usd_cents, 0);
    const bought = filtered.reduce((total, day) => total + day.direct_bought_usd_cents, 0);
    const temporary = filtered.reduce((total, day) => total + day.temporary_out_usd_cents, 0);
    const unexplained = filtered.reduce(
      (total, day) => total + (day.unidentified_variation_usd || 0), 0);
    const variation = filtered.reduce((total, day) => total + (day.variation_usd || 0), 0);
    const covered = filtered.filter((day) => day.interventions_coverage === 'covered').length;

    const card = (label, value, meta) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${meta}</p>` : ''}</div>`;

    document.getElementById('statement-cards').innerHTML = [
      card('Dias no filtro', BFX.number(filtered.length),
        `${BFX.number(covered)} com atuações publicadas`),
      card('Variação somada no período', BFX.usd(variation, { sign: true }),
        'soma das variações diárias do saldo'),
      card('Total vendido diretamente', CENTS(sold), 'operações liquidadas no período'),
      card('Total comprado diretamente', CENTS(bought), 'operações liquidadas no período'),
      card('Operações temporárias', CENTS(temporary), 'saída com recompra contratada'),
      card('Variação não identificada', BFX.usd(unexplained, { sign: true }),
        'rendimentos, variação cambial, marcação de ativos e outros movimentos não divulgados por dia')
    ].join('');
  }

  function renderTable() {
    const body = document.getElementById('statement-body');
    const limit = Number(BFX.recall('pageSize', 250));
    const view = filtered.slice().reverse().slice(0, limit);
    document.getElementById('row-count').textContent =
      `${BFX.number(filtered.length)} dia(s) no filtro, mostrando ${BFX.number(view.length)}.`;

    if (!view.length) {
      body.innerHTML = '<tr><td colspan="13" class="loading">Nenhum dia atende aos filtros.</td></tr>';
      return;
    }

    body.innerHTML = view.map((day) => {
      const variationTrend = BFX.trend(day.variation_usd);
      return `<tr class="expandable" data-date="${day.date}" tabindex="0">
        <td class="num">${BFX.date(day.date, { withWeekday: true })}</td>
        <td class="right num">${BFX.usd(day.opening_usd)}</td>
        <td class="right num">${BFX.usd(day.closing_usd)}</td>
        <td class="right num ${variationTrend.cls}">${BFX.usd(day.variation_usd, { sign: true })}</td>
        <td class="right num ${variationTrend.cls}">${BFX.pct(day.variation_pct)}</td>
        <td class="right num">${day.confirmed_outflow_usd_cents ? '<span class="neg">' + CENTS(day.confirmed_outflow_usd_cents) + '</span>' : '—'}</td>
        <td class="right num">${day.confirmed_inflow_usd_cents ? '<span class="pos">' + CENTS(day.confirmed_inflow_usd_cents) + '</span>' : '—'}</td>
        <td class="right num">${day.direct_sold_usd_cents ? CENTS(day.direct_sold_usd_cents) : '—'}</td>
        <td class="right num">${day.direct_bought_usd_cents ? CENTS(day.direct_bought_usd_cents) : '—'}</td>
        <td class="right num">${day.temporary_out_usd_cents ? CENTS(day.temporary_out_usd_cents) : '—'}</td>
        <td class="right num">${day.temporary_returned_usd_cents ? CENTS(day.temporary_returned_usd_cents) : '—'}</td>
        <td class="right num">${day.unidentified_variation_usd === null
          ? '<span class="na">—</span>'
          : BFX.usd(day.unidentified_variation_usd, { sign: true })}</td>
        <td>${statusCell(day)}</td>
      </tr>`;
    }).join('');

    body.querySelectorAll('tr.expandable').forEach((row) => {
      const toggle = () => {
        const next = row.nextElementSibling;
        if (next && next.classList.contains('detail-row')) { next.remove(); return; }
        const day = filtered.find((d) => d.date === row.dataset.date);
        const detail = document.createElement('tr');
        detail.className = 'detail-row';
        detail.innerHTML = `<td colspan="13">${detailHtml(day)}</td>`;
        row.after(detail);
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
      });
    });
  }

  async function renderCharts(range) {
    if (!seriesCache.series) seriesCache.series = await BFX.load('data/indicators/series.json');
    const all = concept === 'liquidity'
      ? seriesCache.series.reserves_liquidity
      : seriesCache.series.reserves_cash;
    const balance = BFX.applyRange(all, range);
    const colors = BFXCharts.palette();

    BFXCharts.create('chart-balance', {
      legend: { show: false },
      tooltip: { formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>${BFX.usd(params[0].value[1])}` },
      yAxis: { axisLabel: { formatter: (value) => (value / 1e9).toFixed(0) + ' bi' } },
      series: [{
        name: 'Saldo das reservas', type: 'line', showSymbol: false,
        lineStyle: { width: 1.6, color: colors.info }, itemStyle: { color: colors.info },
        areaStyle: { color: colors.info, opacity: 0.08 },
        data: balance.map((row) => [row.date, row.value_usd])
      }]
    });

    const changes = BFX.applyRange(seriesCache.series.reserves_daily_change, range);
    BFXCharts.create('chart-daily-change', {
      legend: { show: false },
      dataZoom: [{ type: 'inside' }],
      grid: { left: 70, right: 26, top: 24, bottom: 28 },
      tooltip: { formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>${BFX.usd(params[0].value[1], { sign: true })}` },
      yAxis: { axisLabel: { formatter: (value) => (value / 1e6).toFixed(0) + ' mi' } },
      series: [{
        name: 'Variação diária', type: 'bar',
        data: changes.map((row) => [row.date, row.change_usd]),
        itemStyle: {
          color: (params) => (params.value[1] >= 0 ? colors.inflow : colors.outflow)
        }
      }]
    });
  }

  function exportColumns() {
    return [
      { label: 'data', value: 'date' },
      { label: 'conceito', value: 'concept' },
      { label: 'saldo_inicial_usd', value: 'opening_usd' },
      { label: 'saldo_final_usd', value: 'closing_usd' },
      { label: 'variacao_usd', value: 'variation_usd' },
      { label: 'variacao_pct', value: 'variation_pct' },
      { label: 'vendido_direto_usd', value: (row) => row.direct_sold_usd_cents / 100 },
      { label: 'comprado_direto_usd', value: (row) => row.direct_bought_usd_cents / 100 },
      { label: 'temporarias_usd', value: (row) => row.temporary_out_usd_cents / 100 },
      { label: 'retorno_temporarias_usd', value: (row) => row.temporary_returned_usd_cents / 100 },
      { label: 'swap_tradicional_nocional_usd', value: (row) => row.swap_traditional_notional_usd_cents / 100 },
      { label: 'swap_reverso_nocional_usd', value: (row) => row.swap_reverse_notional_usd_cents / 100 },
      { label: 'variacao_explicada_usd', value: 'explained_variation_usd' },
      { label: 'variacao_nao_identificada_usd', value: 'unidentified_variation_usd' },
      { label: 'cobertura_atuacoes', value: 'interventions_coverage' }
    ];
  }

  async function switchConcept() {
    concept = document.getElementById('concept-select').value;
    const meta = conceptMeta();
    const years = ['latest', ...(meta.years || []).map((y) => y.year).reverse()];
    const yearSelect = document.getElementById('year-select');
    yearSelect.innerHTML = years.map((year) =>
      `<option value="${year}">${year === 'latest' ? 'Mais recentes (540 dias)' : year}</option>`
    ).join('');
    rows = await loadYear('latest');
    const spec = reservesIndex.concepts.find((c) => c.key === concept);
    document.getElementById('concept-explanation').innerHTML =
      `<strong>${BFX.escapeHtml(meta.label || '')}:</strong> ` +
      BFX.escapeHtml(spec ? spec.description : '') + ' ' +
      BFX.escapeHtml(reservesIndex.warning) + ' ' +
      BFX.escapeHtml(statementIndex.methodology[concept === 'cash' ? 'cash_concept' : 'liquidity_concept']);
    applyFilters();
  }

  async function init() {
    [statementIndex, reservesIndex] = await Promise.all([
      BFX.load('data/reserves/statement-index.json'),
      BFX.load('data/reserves/index.json')
    ]);
    coverageNotice();

    const conceptSelect = document.getElementById('concept-select');
    conceptSelect.innerHTML = statementIndex.concepts.map((c) =>
      `<option value="${c.concept}">${BFX.escapeHtml(c.label)}</option>`).join('');
    const stored = BFX.recall('defaultConcept', statementIndex.default_concept);
    conceptSelect.value = statementIndex.concepts.some((c) => c.concept === stored)
      ? stored : statementIndex.default_concept;
    concept = conceptSelect.value;

    conceptSelect.addEventListener('change', async () => {
      BFX.store('defaultConcept', conceptSelect.value);
      await switchConcept();
      BFXCharts.registry.forEach((chart, id) => { if (id.startsWith('chart-')) chart.clear(); });
      renderCharts(currentRange);
    });

    document.getElementById('year-select').addEventListener('change', async (event) => {
      rows = await loadYear(event.target.value);
      applyFilters();
    });

    ['from-date', 'to-date', 'filter-kind', 'min-variation'].forEach((id) => {
      document.getElementById(id).addEventListener('change', applyFilters);
    });

    document.getElementById('export-csv').addEventListener('click', () => {
      BFX.exportCsv(`extrato-reservas-${concept}.csv`, filtered, exportColumns());
    });
    document.getElementById('export-json').addEventListener('click', () => {
      BFX.exportJson(`extrato-reservas-${concept}.json`, {
        concept,
        methodology: statementIndex.methodology,
        interventions_coverage: statementIndex.interventions_coverage,
        unit: 'USD',
        days: filtered
      });
    });

    document.getElementById('methodology').innerHTML =
      Object.entries(statementIndex.methodology).map(([key, value]) =>
        `<dt>${BFX.escapeHtml(key)}</dt><dd>${BFX.escapeHtml(value)}</dd>`).join('');

    await switchConcept();

    const query = new URLSearchParams(window.location.search);
    if (query.get('date')) {
      document.getElementById('from-date').value = query.get('date');
      document.getElementById('to-date').value = query.get('date');
      applyFilters();
    }

    BFX.rangeSelector('reserves-range', {
      initial: BFX.recall('defaultRange', '1y'),
      onChange: (range) => { currentRange = range; renderCharts(range); }
    });
  }

  let currentRange = { key: '1y', days: 365 };

  return { init };
})();
