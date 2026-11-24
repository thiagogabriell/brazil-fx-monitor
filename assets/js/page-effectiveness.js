/* Efetividade das intervenções. */
'use strict';

window.PAGE = (() => {
  let data, filtered = [];

  const LABELS = () => data.classification_labels;

  function notice() {
    document.getElementById('limitations-notice').innerHTML =
      `<div class="notice notice--warn">
        <strong>Método.</strong> ${BFX.escapeHtml(data.method)}
        <ul class="plain" style="margin-top:6px">
          ${data.limitations.map((item) => `<li>${BFX.escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>`;
  }

  function cards() {
    const since2015 = data.summary_since_2015.five_days;
    const all = data.summary_all.five_days;
    const card = (label, value, meta) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${BFX.escapeHtml(meta)}</p>` : ''}</div>`;

    const share = (tally, key) => (tally.share_pct[key] === undefined
      ? `<span class="na">${BFX.naText()}</span>`
      : BFX.pct(tally.share_pct[key], { sign: false }));

    document.getElementById('effectiveness-cards').innerHTML = [
      card('Vendas diretas analisadas', BFX.number(data.case_count),
        'operações com resultado publicado e PTAX disponível'),
      card('Real continuou se desvalorizando (5 dias úteis, desde 2015)',
        share(since2015, 'real_desvalorizou'),
        `${since2015.counts.real_desvalorizou || 0} de ${since2015.total} casos`),
      card('Real se valorizou (5 dias úteis, desde 2015)',
        share(since2015, 'real_valorizou'),
        `${since2015.counts.real_valorizou || 0} de ${since2015.total} casos`),
      card('Real permaneceu estável (5 dias úteis, desde 2015)',
        share(since2015, 'real_estavel'),
        `banda de estabilidade de mais ou menos ${data.stable_band_pct}%`),
      card('Real continuou se desvalorizando (toda a série)',
        share(all, 'real_desvalorizou'),
        `${all.counts.real_desvalorizou || 0} de ${all.total} casos desde 1999`),
      card('Dados insuficientes', BFX.number(all.counts.dados_insuficientes || 0),
        'casos sem PTAX suficiente para a comparação completa')
    ].join('');
  }

  function outcomeChart() {
    const population = document.getElementById('population').value;
    const colors = BFXCharts.palette();
    const tally = data[population];
    const keys = ['real_valorizou', 'real_estavel', 'real_desvalorizou', 'dados_insuficientes'];
    const horizons = [
      { key: 'same_day', label: 'No dia da operação' },
      { key: 'next_day', label: 'Próximo dia útil' },
      { key: 'five_days', label: 'Cinco dias úteis' }
    ];
    const colorFor = {
      real_valorizou: colors.inflow,
      real_estavel: colors.info,
      real_desvalorizou: colors.outflow,
      dados_insuficientes: colors.unavailable
    };

    BFXCharts.create('chart-outcomes', {
      dataZoom: [],
      toolbox: { feature: { dataZoom: { show: false }, restore: {}, saveAsImage: {} } },
      legend: { data: keys.map((key) => LABELS()[key]) },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => `<strong>${BFX.escapeHtml(params[0].axisValueLabel)}</strong><br>` +
          params.map((p) => `${p.marker} ${p.seriesName}: ${BFX.number(p.value)} caso(s)`).join('<br>')
      },
      xAxis: { type: 'category', data: horizons.map((h) => h.label),
        axisLabel: { color: colors.dim, interval: 0 } },
      yAxis: { type: 'value', name: 'casos' },
      series: keys.map((key) => ({
        name: LABELS()[key], type: 'bar', stack: 'outcome',
        itemStyle: { color: colorFor[key] },
        label: { show: true, color: colors.text, fontSize: 10, formatter: (p) => (p.value ? p.value : '') },
        data: horizons.map((horizon) => tally[horizon.key].counts[key] || 0)
      }))
    });
  }

  function scatter() {
    const colors = BFXCharts.palette();
    const points = filtered
      .filter((item) => item.change_five_days_pct !== null && item.sold_usd_cents)
      .map((item) => [item.sold_usd_cents / 100 / 1e9, item.change_five_days_pct, item.trade_date]);

    BFXCharts.create('chart-scatter', {
      dataZoom: [{ type: 'inside' }, { type: 'inside', yAxisIndex: 0 }],
      legend: { show: false },
      tooltip: {
        trigger: 'item',
        formatter: (params) => `<strong>${BFX.date(params.value[2])}</strong><br>` +
          `Vendido: US$ ${BFX.number(params.value[0], 2)} bi<br>` +
          `Variação da PTAX em 5 dias úteis: ${BFX.pct(params.value[1])}`
      },
      xAxis: { type: 'value', name: 'Valor vendido (US$ bilhões)',
        axisLabel: { formatter: (v) => BFX.number(v, 1) } },
      yAxis: { type: 'value', name: 'Variação da PTAX em 5 dias úteis (%)',
        axisLabel: { formatter: (v) => BFX.number(v, 1) } },
      series: [{
        type: 'scatter', symbolSize: 9,
        data: points,
        itemStyle: {
          color: (params) => (params.value[1] > 0 ? colors.outflow : colors.inflow),
          opacity: 0.75
        },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: colors.border, type: 'dashed' },
          data: [{ yAxis: 0 }]
        }
      }]
    });
  }

  function outcomeBadge(outcome) {
    const map = {
      real_valorizou: 'badge--official',
      real_estavel: 'badge--info',
      real_desvalorizou: 'badge--alta',
      dados_insuficientes: 'badge--unavailable'
    };
    return `<span class="badge ${map[outcome]}">${BFX.escapeHtml(LABELS()[outcome])}</span>`;
  }

  function table() {
    const fromYear = document.getElementById('from-year').value;
    filtered = data.cases.filter((item) => item.trade_date >= fromYear + '-01-01');
    const view = filtered.slice().reverse();
    document.getElementById('row-count').textContent =
      `${BFX.number(filtered.length)} intervenção(ões) desde ${fromYear}.`;

    document.getElementById('cases-body').innerHTML = view.map((item) => `<tr>
      <td class="num">${BFX.date(item.trade_date)}</td>
      <td class="right num">${BFX.usdCents(item.sold_usd_cents)}</td>
      <td class="right num">${BFX.brl(item.ptax_previous)}</td>
      <td class="right num">${BFX.brl(item.ptax_close)}</td>
      <td class="right num ${BFX.trend(item.change_same_day_pct, { invert: true }).cls}">${BFX.pct(item.change_same_day_pct)}</td>
      <td class="right num">${BFX.brl(item.ptax_next_business_day)}</td>
      <td class="right num ${BFX.trend(item.change_next_day_pct, { invert: true }).cls}">${BFX.pct(item.change_next_day_pct)}</td>
      <td class="right num">${BFX.brl(item.ptax_five_business_days)}</td>
      <td class="right num ${BFX.trend(item.change_five_days_pct, { invert: true }).cls}">${BFX.pct(item.change_five_days_pct)}</td>
      <td>${outcomeBadge(item.outcome_five_days)}</td>
      <td>${item.communication_number
        ? `<a href="https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Comunicado&numero=${encodeURIComponent(item.communication_number)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(item.communication_number)}</a>`
        : '<span class="na">—</span>'}</td>
    </tr>`).join('');
    scatter();
  }

  async function init() {
    data = await BFX.load('data/indicators/effectiveness.json');
    notice();
    cards();

    const years = Array.from(new Set(data.cases.map((item) => item.trade_date.slice(0, 4)))).sort();
    const select = document.getElementById('from-year');
    select.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('');
    select.value = years.includes('2015') ? '2015' : years[0];
    select.addEventListener('change', table);

    document.getElementById('population').addEventListener('change', outcomeChart);
    outcomeChart();
    table();

    document.getElementById('export-csv').addEventListener('click', () => {
      BFX.exportCsv('efetividade-intervencoes.csv', filtered, [
        { label: 'data_operacao', value: 'trade_date' },
        { label: 'data_liquidacao', value: 'settlement_date' },
        { label: 'vendido_usd', value: (row) => row.sold_usd_cents / 100 },
        { label: 'ptax_dia_anterior', value: 'ptax_previous' },
        { label: 'ptax_fechamento', value: 'ptax_close' },
        { label: 'variacao_dia_pct', value: 'change_same_day_pct' },
        { label: 'ptax_proximo_dia_util', value: 'ptax_next_business_day' },
        { label: 'variacao_proximo_dia_pct', value: 'change_next_day_pct' },
        { label: 'ptax_cinco_dias_uteis', value: 'ptax_five_business_days' },
        { label: 'variacao_cinco_dias_pct', value: 'change_five_days_pct' },
        { label: 'comportamento_cinco_dias', value: (row) => LABELS()[row.outcome_five_days] },
        { label: 'comunicado', value: 'communication_number' }
      ]);
    });
    document.getElementById('export-json').addEventListener('click', () => {
      BFX.exportJson('efetividade-intervencoes.json', {
        method: data.method, limitations: data.limitations,
        stable_band_pct: data.stable_band_pct, cases: filtered
      });
    });
  }

  return { init };
})();
