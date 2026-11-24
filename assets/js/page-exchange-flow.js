/* Fluxo cambial: balance of payments flows. */
'use strict';

window.PAGE = (() => {
  let flow, raw;

  const million = (value) => (value === null || value === undefined
    ? `<span class="na">${BFX.naText()}</span>`
    : 'US$ ' + BFX.number(value, 0) + ' mi');

  function notice() {
    document.getElementById('concept-notice').innerHTML =
      `<div class="notice notice--warn">
        <strong>Conceito usado nesta página.</strong>
        ${BFX.escapeHtml(flow.concept)} ${BFX.escapeHtml(flow.not_the_same_as)}
      </div>
      <div class="notice notice--info">
        <strong>Datas distintas.</strong> A data de referência é o mês medido
        (${BFX.date(flow.reference_date)}); a data de publicação é posterior.
        ${BFX.escapeHtml(flow.official_update)}
      </div>`;
  }

  function cards() {
    const indicators = flow.indicators;
    const get = (key) => indicators[key] || {};
    const commercial = get('trade_balance');
    const financial = get('portfolio_investment_net');
    const current = get('current_account');
    const exports_ = get('goods_exports');
    const imports_ = get('goods_imports');
    const other = get('other_investment_net');
    const direct = get('direct_investment_net');

    const card = (label, value, meta, chip) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}${chip ? ' ' + chip : ''}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${meta}</p>` : ''}</div>`;

    const totalLatest = [commercial.latest, financial.latest, direct.latest, other.latest]
      .every((value) => value !== null && value !== undefined)
      ? commercial.latest + financial.latest + direct.latest + other.latest
      : null;

    document.getElementById('flow-cards').innerHTML = [
      card('Entrada de dólares (exportação de bens)', million(exports_.latest),
        `mês de referência ${BFX.date(exports_.reference_date)}`),
      card('Saída de dólares (importação de bens)', million(imports_.latest),
        `mês de referência ${BFX.date(imports_.reference_date)}`),
      card('Fluxo cambial comercial', million(commercial.latest),
        `acumulado de 12 meses ${BFX.number(commercial.accumulated_12m, 0)} mi`),
      card('Fluxo cambial financeiro', million(financial.latest),
        `acumulado de 12 meses ${BFX.number(financial.accumulated_12m, 0)} mi`),
      card('Fluxo total (comercial + financeiro)', million(totalLatest),
        'soma dos componentes publicados do mês'),
      card('Saldo líquido de transações correntes', million(current.latest),
        `acumulado no ano ${BFX.number(current.year_to_date, 0)} mi`),
      card('Saldo acumulado no mês', million(current.latest),
        'o balanço de pagamentos é mensal, portanto o mês é a menor unidade publicada'),
      card('Saldo acumulado no ano', million(current.year_to_date),
        `ano de ${(current.reference_date || '').slice(0, 4)}`),
      card('Média móvel de 3 meses (financeiro)', million(financial.moving_average_3m), null),
      card('Média móvel de 12 meses (financeiro)', million(financial.moving_average_12m), null),
      card('Meses negativos em sequência (financeiro)',
        BFX.number(financial.negative_month_streak),
        'sequência de meses com saldo negativo'),
      card('Tendência',
        financial.trend === 'saida_liquida'
          ? '<span class="neg trend trend--down">saída líquida de dólares</span>'
          : financial.trend === 'entrada_liquida'
            ? '<span class="pos trend trend--up">entrada líquida de dólares</span>'
            : `<span class="na">${BFX.naText()}</span>`,
        'baseada no acumulado de 3 meses; saída líquida não é, por si, fuga de capital')
    ].join('');
  }

  function table() {
    const group = document.getElementById('group-filter').value;
    const entries = Object.entries(flow.indicators)
      .filter(([, indicator]) => group === 'all' || indicator.group === group);

    document.getElementById('flow-body').innerHTML = entries.map(([key, indicator]) => {
      const t = BFX.trend(indicator.accumulated_3m);
      return `<tr>
        <td class="wrap">${BFX.escapeHtml(indicator.label)}</td>
        <td>${BFX.escapeHtml(indicator.group)}</td>
        <td class="num">${BFX.date(indicator.reference_date)}</td>
        <td class="right num">${million(indicator.latest)}</td>
        <td class="right num">${million(indicator.previous)}</td>
        <td class="right num">${million(indicator.accumulated_3m)}</td>
        <td class="right num">${million(indicator.accumulated_12m)}</td>
        <td class="right num">${million(indicator.year_to_date)}</td>
        <td class="right num">${million(indicator.moving_average_3m)}</td>
        <td class="right num">${million(indicator.moving_average_12m)}</td>
        <td class="right num">${BFX.number(indicator.negative_month_streak)}</td>
        <td class="${t.cls}">${indicator.trend ? BFX.escapeHtml(indicator.trend.replace(/_/g, ' ')) : BFX.naText()}</td>
        <td><a href="https://dadosabertos.bcb.gov.br/dataset?q=${indicator.sgs_code}" target="_blank" rel="noopener noreferrer">SGS ${indicator.sgs_code}</a></td>
      </tr>`;
    }).join('');
  }

  function seriesFor(key) {
    const spec = raw.series.find((item) => item.key === key);
    return spec
      ? spec.observations.map((row) => ({ date: row.date, value: row.value_usd_million }))
      : [];
  }

  function charts(range) {
    const colors = BFXCharts.palette();
    const tooltip = {
      formatter: (params) => `<strong>${String(params[0].axisValueLabel).slice(0, 7)}</strong><br>` +
        params.map((p) => `${p.marker} ${p.seriesName}: US$ ${BFX.number(p.value[1], 0)} mi`).join('<br>')
    };
    const axis = { axisLabel: { formatter: (value) => BFX.number(value / 1000, 0) + ' bi' } };

    const build = (elementId, definitions) => BFXCharts.create(elementId, {
      legend: { data: definitions.map((d) => d.name) },
      tooltip, yAxis: axis,
      series: definitions.map((definition) => ({
        name: definition.name,
        type: definition.type || 'line',
        showSymbol: false,
        stack: definition.stack,
        lineStyle: { width: 1.6, color: definition.color },
        itemStyle: { color: definition.color },
        areaStyle: definition.area ? { color: definition.color, opacity: 0.08 } : undefined,
        data: BFX.applyRange(seriesFor(definition.key), range, raw.reference_date)
          .map((row) => [row.date, row.value])
      }))
    });

    build('chart-commercial', [
      { key: 'goods_exports', name: 'Exportação de bens', color: colors.inflow },
      { key: 'goods_imports', name: 'Importação de bens', color: colors.outflow },
      { key: 'trade_balance', name: 'Saldo comercial', color: colors.info, area: true }
    ]);

    build('chart-financial', [
      { key: 'direct_investment_net', name: 'Investimento direto', color: colors.inflow },
      { key: 'portfolio_investment_net', name: 'Investimentos em carteira', color: colors.warn },
      { key: 'other_investment_net', name: 'Outros investimentos', color: colors.notional }
    ]);

    const current = BFX.applyRange(seriesFor('current_account'), range, raw.reference_date);
    BFXCharts.create('chart-total', {
      legend: { data: ['Transações correntes', 'Média móvel de 12 meses'] },
      tooltip, yAxis: axis,
      series: [
        {
          name: 'Transações correntes', type: 'bar',
          data: current.map((row) => [row.date, row.value]),
          itemStyle: {
            color: (params) => (params.value[1] >= 0 ? colors.inflow : colors.outflow)
          }
        },
        {
          name: 'Média móvel de 12 meses', type: 'line', showSymbol: false,
          lineStyle: { color: colors.info, width: 1.6 }, itemStyle: { color: colors.info },
          data: current.map((row, position) => {
            if (position < 11) return [row.date, null];
            const window_ = current.slice(position - 11, position + 1);
            const average = window_.reduce((sum, item) => sum + item.value, 0) / 12;
            return [row.date, average];
          })
        }
      ]
    });
  }

  function yearly() {
    const keys = ['current_account', 'trade_balance', 'direct_investment_net',
      'portfolio_investment_net', 'other_investment_net'];
    const totals = new Map();
    keys.forEach((key) => {
      seriesFor(key).forEach((row) => {
        const year = row.date.slice(0, 4);
        if (!totals.has(year)) totals.set(year, {});
        totals.get(year)[key] = (totals.get(year)[key] || 0) + row.value;
      });
    });
    const years = Array.from(totals.keys()).sort().reverse().slice(0, 16);
    document.getElementById('yearly-body').innerHTML = years.map((year) => {
      const row = totals.get(year);
      return `<tr><td class="num">${year}</td>` +
        keys.map((key) => {
          const t = BFX.trend(row[key]);
          return `<td class="right num ${t.cls}">${million(row[key])}</td>`;
        }).join('') + '</tr>';
    }).join('');
  }

  async function init() {
    [flow, raw] = await Promise.all([
      BFX.load('data/indicators/flow.json'),
      BFX.load('data/exchange-flow/balance-of-payments.json')
    ]);
    notice();
    cards();
    table();
    yearly();
    document.getElementById('group-filter').addEventListener('change', table);
    BFX.rangeSelector('flow-range', {
      initial: BFX.recall('defaultRange', '5y'),
      onChange: charts
    });
  }

  return { init };
})();
