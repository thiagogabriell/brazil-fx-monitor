/* Histórico de intervenções: aggregates by type and long history charts. */
'use strict';

window.PAGE = (() => {
  let summary, series, index, announcements, categories;

  const CENTS = (value) => BFX.usdCents(value);

  function windowCards() {
    const windows = summary.interventions.windows;
    const card = (label, value, meta, chip) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}${chip ? ' ' + chip : ''}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${meta}</p>` : ''}</div>`;

    document.getElementById('window-cards').innerHTML = [
      card('Vendido em 7 dias', CENTS(windows['7'].sold_usd_cents),
        `${BFX.date(windows['7'].from_date)} a ${BFX.date(windows['7'].to_date)}`),
      card('Vendido em 30 dias', CENTS(windows['30'].sold_usd_cents),
        `${windows['30'].days_with_direct_sale} dia(s) com venda`),
      card('Vendido em 90 dias', CENTS(windows['90'].sold_usd_cents),
        `${windows['90'].sale_operation_count} operação(ões) de venda`),
      card('Vendido em 365 dias', CENTS(windows['365'].sold_usd_cents),
        `saldo líquido ${CENTS(windows['365'].net_usd_cents)}`),
      card('Swaps tradicionais em 365 dias',
        CENTS(windows['365'].swap_traditional_notional_usd_cents),
        'valor nocional, não é saída de dólares',
        '<span class="chip chip--notional">nocional</span>'),
      card('Operações temporárias em 365 dias',
        CENTS(windows['365'].temporary_out_usd_cents),
        `retorno de ${CENTS(windows['365'].temporary_returned_usd_cents)}`,
        '<span class="chip chip--temporary">temporária</span>')
    ].join('');
  }

  function windowsTable() {
    const windows = summary.interventions.windows;
    document.getElementById('windows-body').innerHTML =
      ['7', '30', '90', '365'].map((key) => {
        const w = windows[key];
        return `<tr>
          <td>${key} dias</td>
          <td class="num">${BFX.date(w.from_date)} a ${BFX.date(w.to_date)}</td>
          <td class="right num neg">${CENTS(w.sold_usd_cents)}</td>
          <td class="right num pos">${CENTS(w.bought_usd_cents)}</td>
          <td class="right num ${BFX.trend(w.net_usd_cents).cls}">${CENTS(w.net_usd_cents)}</td>
          <td class="right num">${CENTS(w.temporary_out_usd_cents)}</td>
          <td class="right num">${CENTS(w.temporary_returned_usd_cents)}</td>
          <td class="right num" style="color:var(--notional)">${CENTS(w.swap_traditional_notional_usd_cents)}</td>
          <td class="right num" style="color:var(--notional)">${CENTS(w.swap_reverse_notional_usd_cents)}</td>
          <td class="right num">${BFX.number(w.operation_count)}</td>
          <td class="right num">${BFX.number(w.days_with_direct_sale)}</td>
          <td class="right num">${BFX.number(w.announced_without_result_count)}</td>
        </tr>`;
      }).join('');
  }

  function categoryBlock(elementId, keys, extra) {
    const rows = series.distribution_by_category.filter((row) => keys.includes(row.category));
    const total = rows.reduce((sum, row) => sum + row.accepted_usd_cents, 0);
    const count = rows.reduce((sum, row) => sum + row.operation_count, 0);
    const reserves = summary.reserves.cash ? summary.reserves.cash.current_usd : null;
    const share = reserves ? (total / 100 / reserves) * 100 : null;
    const spec = categories[keys[0]];

    const content = rows.length
      ? `<dl class="detail-grid">
          <div><dt>Operações com resultado publicado</dt><dd>${BFX.number(count)}</dd></div>
          <div><dt>Volume acumulado desde 1999</dt><dd>${CENTS(total)}</dd></div>
          <div><dt>Percentual das reservas atuais</dt><dd>${BFX.pct(share, { sign: false })}</dd></div>
          ${extra || ''}
        </dl>
        <p class="card__meta-row">${BFX.escapeHtml(spec.explanation)}</p>`
      : '<p class="card__meta-row">Nenhuma operação desta natureza na fonte oficial.</p>';
    document.getElementById(elementId).innerHTML = content;
  }

  function typeBlocks() {
    const open = summary.interventions.open_temporary;
    const swaps = summary.interventions.swap_outstanding;
    const last = summary.interventions.last_direct_sale;

    categoryBlock('block-spot-sale', ['spot_sale'],
      last ? `<div><dt>Última venda direta</dt><dd>${BFX.date(last.trade_date)} · ${CENTS(last.accepted_usd_cents)}</dd></div>
              <div><dt>Data da liquidação</dt><dd>${BFX.date(last.settlement_date)}</dd></div>
              <div><dt>Impacto esperado sobre as reservas</dt><dd>redução na liquidação</dd></div>` : '');

    categoryBlock('block-spot-purchase', ['spot_purchase', 'forward_purchase'],
      '<div><dt>Impacto esperado</dt><dd>aumento das reservas na liquidação</dd></div>');

    categoryBlock('block-temporary', ['sale_with_repurchase', 'repurchase_agreement', 'loan'],
      `<div><dt>Operações em aberto</dt><dd>${BFX.number(open.count)}</dd></div>
       <div><dt>Saldo em aberto</dt><dd>${CENTS(open.outstanding_usd_cents)}</dd></div>
       <div><dt>Posição em</dt><dd>${BFX.date(open.as_of)}</dd></div>
       <div><dt>Efeito no conceito caixa</dt><dd>saída na liquidação, entrada no vencimento</dd></div>
       <div><dt>Efeito no conceito liquidez</dt><dd><span class="na">não divulgado por operação pelo BCB</span></dd></div>`);

    categoryBlock('block-swap-traditional', ['swap_traditional'],
      `<div><dt>Contratos em aberto</dt><dd>${BFX.number(swaps.traditional_contract_count)}</dd></div>
       <div><dt>Valor nocional em aberto</dt><dd>${CENTS(swaps.traditional_notional_usd_cents)}</dd></div>
       <div><dt>Posição em</dt><dd>${BFX.date(swaps.as_of)}</dd></div>`);

    categoryBlock('block-swap-reverse', ['swap_reverse'],
      `<div><dt>Contratos em aberto</dt><dd>${BFX.number(swaps.reverse_contract_count)}</dd></div>
       <div><dt>Valor nocional em aberto</dt><dd>${CENTS(swaps.reverse_notional_usd_cents)}</dd></div>`);

    const others = series.distribution_by_category
      .filter((row) => !['spot_sale', 'spot_purchase', 'forward_purchase',
        'sale_with_repurchase', 'repurchase_agreement', 'loan',
        'swap_traditional', 'swap_reverse'].includes(row.category));
    document.getElementById('block-other').innerHTML = others.length
      ? others.map((row) => `<p>${BFX.escapeHtml(row.label)}: ${BFX.number(row.operation_count)} operação(ões), ${CENTS(row.accepted_usd_cents)}</p>`).join('')
      : `<p class="card__meta-row">Todas as operações publicadas pelo Banco Central
          estão classificadas nos blocos acima: venda e compra à vista, compra a
          termo, venda com recompra, operação compromissada, empréstimo em moeda
          estrangeira e swap cambial tradicional e reverso.</p>`;
  }

  function charts(range) {
    const colors = BFXCharts.palette();
    const daily = BFX.applyRange(series.interventions_daily, range, index.reference_date);
    const monthly = series.interventions_monthly.map((row) => ({ date: row.month + '-01', ...row }));
    const monthlyRange = BFX.applyRange(monthly, range, index.reference_date + '');

    const moneyTooltip = (title) => ({
      formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>` +
        params.map((p) => `${p.marker} ${p.seriesName}: ${BFX.usd(p.value[1])}`).join('<br>')
    });

    BFXCharts.create('chart-daily-sales', {
      legend: { data: ['Venda direta', 'Compra direta'] },
      tooltip: moneyTooltip(),
      yAxis: { axisLabel: { formatter: (v) => (v / 1e9).toFixed(1) + ' bi' } },
      series: [
        {
          name: 'Venda direta', type: 'bar', stack: 'direct',
          itemStyle: { color: colors.outflow },
          data: daily.map((row) => [row.date, -row.sold_cents / 100])
        },
        {
          name: 'Compra direta', type: 'bar', stack: 'direct',
          itemStyle: { color: colors.inflow },
          data: daily.map((row) => [row.date, row.bought_cents / 100])
        }
      ]
    });

    BFXCharts.create('chart-cumulative', {
      legend: { data: ['Vendas acumuladas', 'Saldo líquido acumulado'] },
      tooltip: moneyTooltip(),
      yAxis: { axisLabel: { formatter: (v) => (v / 1e9).toFixed(0) + ' bi' } },
      series: [
        {
          name: 'Vendas acumuladas', type: 'line', showSymbol: false,
          lineStyle: { color: colors.outflow, width: 1.6 }, itemStyle: { color: colors.outflow },
          areaStyle: { color: colors.outflow, opacity: 0.08 },
          data: daily.map((row) => [row.date, row.cumulative_sold_cents / 100])
        },
        {
          name: 'Saldo líquido acumulado', type: 'line', showSymbol: false,
          lineStyle: { color: colors.info, width: 1.4 }, itemStyle: { color: colors.info },
          data: (() => {
            let running = 0;
            return daily.map((row) => {
              running += row.net_cents;
              return [row.date, running / 100];
            });
          })()
        }
      ]
    });

    BFXCharts.create('chart-frequency', {
      legend: { data: ['Dias com venda no mês', 'Operações no mês'] },
      tooltip: {
        formatter: (params) => `<strong>${String(params[0].axisValueLabel).slice(0, 7)}</strong><br>` +
          params.map((p) => `${p.marker} ${p.seriesName}: ${BFX.number(p.value[1])}`).join('<br>')
      },
      series: [
        {
          name: 'Dias com venda no mês', type: 'bar', itemStyle: { color: colors.warn },
          data: monthlyRange.map((row) => [row.date, row.days_with_sale])
        },
        {
          name: 'Operações no mês', type: 'line', showSymbol: false,
          lineStyle: { color: colors.info, width: 1.4 }, itemStyle: { color: colors.info },
          data: monthlyRange.map((row) => [row.date, row.operations])
        }
      ]
    });

    BFXCharts.create('chart-average', {
      legend: { show: false },
      dataZoom: [{ type: 'inside' }],
      grid: { left: 70, right: 26, top: 24, bottom: 28 },
      tooltip: {
        formatter: (params) => `<strong>${String(params[0].axisValueLabel).slice(0, 7)}</strong><br>` +
          `Volume médio por venda: ${BFX.usd(params[0].value[1])}`
      },
      yAxis: { axisLabel: { formatter: (v) => (v / 1e6).toFixed(0) + ' mi' } },
      series: [{
        name: 'Volume médio por venda', type: 'bar', itemStyle: { color: colors.outflow },
        data: monthlyRange
          .filter((row) => row.sale_operations > 0)
          .map((row) => [row.date, row.sold_cents / 100 / row.sale_operations])
      }]
    });

    BFXCharts.create('chart-distribution', {
      dataZoom: [], xAxis: undefined, yAxis: undefined, grid: undefined,
      toolbox: { feature: { dataZoom: { show: false }, restore: {}, saveAsImage: {} } },
      legend: { bottom: 0, type: 'scroll' },
      tooltip: {
        trigger: 'item',
        formatter: (params) => `${params.marker} <strong>${BFX.escapeHtml(params.name)}</strong><br>` +
          `${BFX.number(params.value)} operação(ões)<br>${params.percent}% do total`
      },
      series: [{
        name: 'Distribuição por tipo', type: 'pie', radius: ['38%', '66%'],
        center: ['50%', '45%'],
        itemStyle: { borderColor: colors.card, borderWidth: 2 },
        label: { color: colors.muted, fontSize: 11 },
        data: series.distribution_by_category.map((row) => ({
          name: row.label + (row.is_notional ? ' (nocional)' : ''),
          value: row.operation_count,
          itemStyle: {
            color: row.is_notional ? colors.notional
              : row.category === 'spot_sale' ? colors.outflow
                : row.category === 'spot_purchase' || row.category === 'forward_purchase' ? colors.inflow
                  : colors.warn
          }
        }))
      }]
    });

    BFXCharts.create('chart-outstanding', {
      legend: { show: false },
      tooltip: {
        formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>` +
          `Operações temporárias em aberto: ${BFX.usd(params[0].value[1])}`
      },
      yAxis: { axisLabel: { formatter: (v) => (v / 1e9).toFixed(1) + ' bi' } },
      series: [{
        name: 'Operações temporárias em aberto', type: 'line', step: 'end', showSymbol: false,
        lineStyle: { color: colors.warn, width: 1.6 }, itemStyle: { color: colors.warn },
        areaStyle: { color: colors.warn, opacity: 0.08 },
        data: BFX.applyRange(series.temporary_outstanding, range, index.reference_date)
          .map((row) => [row.date, row.outstanding_cents / 100])
      }]
    });

    BFXCharts.create('chart-swaps', {
      legend: { data: ['Swap tradicional negociado', 'Swap reverso negociado', 'Estoque nocional líquido'] },
      tooltip: moneyTooltip(),
      yAxis: { axisLabel: { formatter: (v) => (v / 1e9).toFixed(0) + ' bi' } },
      series: [
        {
          name: 'Swap tradicional negociado', type: 'bar', stack: 'swap',
          itemStyle: { color: colors.notional },
          data: daily.map((row) => [row.date, row.swap_traditional_cents / 100])
        },
        {
          name: 'Swap reverso negociado', type: 'bar', stack: 'swap',
          itemStyle: { color: colors.info },
          data: daily.map((row) => [row.date, -row.swap_reverse_cents / 100])
        },
        {
          name: 'Estoque nocional líquido', type: 'line', showSymbol: false,
          lineStyle: { color: colors.warn, width: 1.4 }, itemStyle: { color: colors.warn },
          data: BFX.applyRange(series.swap_net_outstanding, range, index.reference_date)
            .map((row) => [row.date, row.net_notional_cents / 100])
        }
      ]
    });
  }

  function renderAnnouncements() {
    const limit = Number(document.getElementById('announcement-limit').value);
    const rows = announcements.announcements.slice(0, limit);
    document.getElementById('announcements-body').innerHTML = rows.map((entry) => `<tr>
      <td class="num">${BFX.escapeHtml(entry.communication_number)}</td>
      <td class="num">${BFX.stamp(entry.published_at_sao_paulo)}</td>
      <td class="num">${entry.trade_dates.map(BFX.date).join(', ')}</td>
      <td>${entry.categories.map((key) => BFX.escapeHtml(categories[key].short_label)).join(', ')}</td>
      <td class="right num">${CENTS(entry.offered_usd_cents)}</td>
      <td class="right num">${CENTS(entry.accepted_usd_cents)}</td>
      <td class="na">não consta no conjunto de dados</td>
      <td><a href="${BFX.escapeHtml(entry.official_url)}" target="_blank" rel="noopener noreferrer">comunicado</a></td>
    </tr>`).join('');
  }

  async function init() {
    [summary, series, index, announcements] = await Promise.all([
      BFX.load('data/indicators/summary.json'),
      BFX.load('data/indicators/series.json'),
      BFX.load('data/interventions/index.json'),
      BFX.load('data/interventions/announcements.json')
    ]);
    categories = index.categories;

    document.getElementById('coverage-notice').innerHTML =
      `<div class="notice notice--warn">
        <strong>Série de ${BFX.date(index.first_date)} a ${BFX.date(index.reference_date)}.</strong>
        ${BFX.escapeHtml(index.official_update)}
        <ul class="plain" style="margin-top:6px">
          ${index.known_limitations.map((item) => `<li>${BFX.escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>`;

    windowCards();
    windowsTable();
    typeBlocks();
    renderAnnouncements();
    document.getElementById('announcement-limit').addEventListener('change', renderAnnouncements);

    BFX.rangeSelector('interventions-range', {
      initial: BFX.recall('defaultRange', '5y'),
      onChange: charts
    });
  }

  return { init };
})();
