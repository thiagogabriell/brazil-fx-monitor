/* Mercado cambial: PTAX, live quote and cross charts. */
'use strict';

window.PAGE = (() => {
  let summary, series, latest, index;

  function cards() {
    const ptax = summary.market.ptax;
    const card = (label, value, meta, badge) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}${badge ? ' ' + badge : ''}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${meta}</p>` : ''}</div>`;

    const official = '<span class="badge badge--official">oficial</span>';
    document.getElementById('rate-cards').innerHTML = [
      card('PTAX de venda', BFX.brl(ptax.sell),
        `referência ${BFX.date(ptax.reference_date)} · publicada em ${BFX.stamp(ptax.published_at_sao_paulo)}`, official),
      card('PTAX de compra', BFX.brl(ptax.buy),
        `mesma data de referência`, official),
      card('Variação diária', BFX.pct(ptax.daily_change_pct),
        `contra ${BFX.brl(ptax.previous_sell)} em ${BFX.date(ptax.previous_date)}`),
      card('Variação semanal', BFX.pct(ptax.changes['7'].change_pct),
        `base ${BFX.date(ptax.changes['7'].from_date)}`),
      card('Variação mensal', BFX.pct(ptax.changes['30'].change_pct),
        `base ${BFX.date(ptax.changes['30'].from_date)}`),
      card('Variação anual', BFX.pct(ptax.changes['365'].change_pct),
        `base ${BFX.date(ptax.changes['365'].from_date)}`),
      card('Máxima de 12 meses', BFX.brl(ptax.high_12m), `em ${BFX.date(ptax.high_12m_date)}`),
      card('Mínima de 12 meses', BFX.brl(ptax.low_12m), `em ${BFX.date(ptax.low_12m_date)}`)
    ].join('');

    document.getElementById('live-note').innerHTML =
      `<strong>${BFX.escapeHtml(summary.market.spot_quote.note)}</strong>
       Fonte: <a href="${BFX.escapeHtml(BFX.LIVE_SOURCE.endpoint)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(BFX.LIVE_SOURCE.name)}</a>.
       A PTAX acima é a taxa de referência oficial do Banco Central e é
       apresentada separadamente da cotação de mercado.`;
  }

  function paintLive(quote) {
    const container = document.getElementById('live-cards');
    const updated = document.getElementById('live-updated');
    if (!quote || !quote.ok) {
      container.innerHTML =
        `<div class="card"><p class="card__label">Cotação ao vivo</p>
          <div class="card__value card__value--sm na">indisponível</div>
          <p class="card__meta-row" style="margin-top:6px">A fonte secundária não
            respondeu. O último dado válido continua sendo a PTAX oficial acima.</p></div>`;
      updated.textContent = '';
      return;
    }
    const t = BFX.trend(quote.changePct, { invert: true });
    const card = (label, value, meta) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${BFX.escapeHtml(meta)}</p>` : ''}</div>`;
    container.innerHTML = [
      card('Compra (bid)', BFX.brl(quote.bid), 'cotação de mercado, atrasada em alguns minutos'),
      card('Venda (ask)', BFX.brl(quote.ask), 'cotação de mercado'),
      card('Variação no dia', `<span class="${t.cls}">${BFX.pct(quote.changePct)}</span>`, 'segundo a fonte secundária'),
      card('Máxima e mínima do dia', `${BFX.brl(quote.high)} / ${BFX.brl(quote.low)}`, 'intradiário da fonte secundária')
    ].join('');
    updated.textContent = 'atualizado em ' + (quote.at || '');
  }

  function charts(range) {
    const colors = BFXCharts.palette();
    const ptaxDocument = series.ptax;
    const rows = BFX.applyRange(ptaxDocument, range);
    const buyByDate = new Map(latest ? latest.bulletins.map((b) => [b.date, b.buy]) : []);
    const sales = BFX.applyRange(series.interventions_daily, range)
      .filter((row) => row.sold_cents > 0)
      .map((row) => row.date);

    BFXCharts.create('chart-ptax', {
      legend: { data: ['PTAX de venda'] },
      tooltip: {
        formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>` +
          params.map((p) => `${p.marker} ${p.seriesName}: ${BFX.brl(p.value[1])}`).join('<br>')
      },
      yAxis: { axisLabel: { formatter: (value) => value.toFixed(2) } },
      series: [{
        name: 'PTAX de venda', type: 'line', showSymbol: false,
        lineStyle: { width: 1.6, color: colors.warn }, itemStyle: { color: colors.warn },
        data: rows.map((row) => [row.date, row.value]),
        markLine: sales.length ? BFXCharts.markLines(sales, colors.outflow, 'Venda direta') : undefined
      }]
    });

    document.getElementById('marker-note').innerHTML =
      `As linhas verticais marcam dias com venda direta de dólares liquidada,
       segundo o histórico de atuações do BCB, publicado até
       ${BFX.escapeHtml(BFX.date(index.reference_date))}.`;

    const reserves = BFX.applyRange(series.reserves_cash, range);
    BFXCharts.create('chart-reserves-vs-usd', {
      legend: { data: ['Reservas (conceito caixa)', 'PTAX de venda'] },
      grid: { left: 70, right: 70, top: 34, bottom: 56 },
      tooltip: {
        formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>` +
          params.map((p) => `${p.marker} ${p.seriesName}: ` +
            (p.seriesName.includes('PTAX') ? BFX.brl(p.value[1]) : BFX.usd(p.value[1]))).join('<br>')
      },
      yAxis: [
        { type: 'value', name: 'US$', axisLabel: { formatter: (v) => (v / 1e9).toFixed(0) + ' bi' } },
        { type: 'value', name: 'R$/US$', position: 'right', splitLine: { show: false },
          axisLabel: { formatter: (v) => v.toFixed(2) } }
      ],
      series: [
        {
          name: 'Reservas (conceito caixa)', type: 'line', showSymbol: false, yAxisIndex: 0,
          lineStyle: { width: 1.6, color: colors.info }, itemStyle: { color: colors.info },
          data: reserves.map((row) => [row.date, row.value_usd])
        },
        {
          name: 'PTAX de venda', type: 'line', showSymbol: false, yAxisIndex: 1,
          lineStyle: { width: 1.4, color: colors.warn }, itemStyle: { color: colors.warn },
          data: rows.map((row) => [row.date, row.value])
        }
      ]
    });

    const daily = BFX.applyRange(series.interventions_daily, range);
    BFXCharts.create('chart-interventions-vs-usd', {
      legend: { data: ['Venda direta', 'Compra direta', 'PTAX de venda'] },
      grid: { left: 70, right: 70, top: 34, bottom: 56 },
      tooltip: {
        formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>` +
          params.map((p) => `${p.marker} ${p.seriesName}: ` +
            (p.seriesName.includes('PTAX') ? BFX.brl(p.value[1]) : BFX.usd(Math.abs(p.value[1])))).join('<br>')
      },
      yAxis: [
        { type: 'value', name: 'US$', axisLabel: { formatter: (v) => (v / 1e9).toFixed(1) + ' bi' } },
        { type: 'value', name: 'R$/US$', position: 'right', splitLine: { show: false },
          axisLabel: { formatter: (v) => v.toFixed(2) } }
      ],
      series: [
        {
          name: 'Venda direta', type: 'bar', yAxisIndex: 0, stack: 'ops',
          itemStyle: { color: colors.outflow },
          data: daily.map((row) => [row.date, -row.sold_cents / 100])
        },
        {
          name: 'Compra direta', type: 'bar', yAxisIndex: 0, stack: 'ops',
          itemStyle: { color: colors.inflow },
          data: daily.map((row) => [row.date, row.bought_cents / 100])
        },
        {
          name: 'PTAX de venda', type: 'line', showSymbol: false, yAxisIndex: 1,
          lineStyle: { width: 1.4, color: colors.warn }, itemStyle: { color: colors.warn },
          data: rows.map((row) => [row.date, row.value])
        }
      ]
    });
  }

  function bulletins() {
    if (!latest) {
      document.getElementById('bulletins-body').innerHTML =
        '<tr><td colspan="4" class="na">Boletins PTAX indisponíveis nesta coleta.</td></tr>';
      return;
    }
    document.getElementById('bulletins-body').innerHTML =
      latest.bulletins.slice().reverse().map((bulletin) => `<tr>
        <td class="num">${BFX.date(bulletin.date)}</td>
        <td class="num">${BFX.escapeHtml(bulletin.published_at_sao_paulo)}</td>
        <td class="right num">${BFX.brl(bulletin.buy)}</td>
        <td class="right num">${BFX.brl(bulletin.sell)}</td>
      </tr>`).join('');
  }

  async function init() {
    [summary, series, latest, index] = await Promise.all([
      BFX.load('data/indicators/summary.json'),
      BFX.load('data/indicators/series.json'),
      BFX.load('data/exchange-rates/ptax-latest.json', { optional: true }),
      BFX.load('data/interventions/index.json')
    ]);
    cards();
    bulletins();
    window.addEventListener('bfx:quote', (event) => paintLive(event.detail));
    paintLive(await BFX.fetchLiveQuote());
    BFX.rangeSelector('rate-range', {
      initial: BFX.recall('defaultRange', '1y'),
      onChange: charts
    });
  }

  return { init };
})();
