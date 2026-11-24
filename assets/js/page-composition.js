/* Composição das reservas: what the BCB publishes, and what it does not. */
'use strict';

window.PAGE = (() => {
  let composition, series, index, categories;

  function notice() {
    const survey = composition.catalogue_survey;
    document.getElementById('availability-notice').innerHTML =
      `<div class="notice notice--warn">
        <strong>A composição das reservas não é publicada em API pelo Banco Central.</strong>
        ${BFX.escapeHtml(composition.explanation)}
      </div>
      <div class="notice notice--info">
        <strong>Verificação automática do catálogo aberto.</strong>
        ${survey.checked
          ? `${BFX.number(survey.catalogue_size)} conjuntos de dados verificados em
             ${BFX.escapeHtml(BFX.utcToSaoPaulo(composition.collected_at))}.
             Conjuntos com "reservas" no nome:
             ${survey.reserve_datasets_found.map((n) => `<code>${BFX.escapeHtml(n)}</code>`).join(', ')}.
             ${BFX.escapeHtml(survey.conclusion)}`
          : `Não foi possível reverificar o catálogo nesta coleta: ${BFX.escapeHtml(survey.detail || '')}`}
      </div>
      <div class="notice notice--info">${BFX.escapeHtml(composition.perspective_warning)}</div>`;
  }

  function buckets() {
    document.getElementById('currency-body').innerHTML =
      composition.currency_buckets.map((bucket) => `<tr>
        <td><strong>${BFX.escapeHtml(bucket.code)}</strong> ${BFX.escapeHtml(bucket.label)}</td>
        <td class="right na">não divulgado</td>
        <td class="right na">não divulgado</td>
        <td class="na">não divulgada</td>
        <td><span class="badge badge--unavailable">indisponível</span></td>
      </tr>`).join('');

    document.getElementById('asset-body').innerHTML =
      composition.asset_class_buckets.map((bucket) => `<tr>
        <td>${BFX.escapeHtml(bucket.label)}</td>
        <td class="right na">não divulgado</td>
        <td class="right na">não divulgado</td>
        <td class="right na">não divulgada</td>
        <td><span class="badge badge--unavailable">indisponível</span></td>
      </tr>`).join('');
  }

  async function assetUsage() {
    document.getElementById('asset-usage-note').innerHTML =
      `<strong>${BFX.escapeHtml(composition.unavailable_label)}</strong>
       Quando o Banco Central informa apenas que vendeu dólares, esta aplicação
       não presume que ele vendeu títulos do Tesouro americano, ouro ou qualquer
       outro ativo específico para financiar a operação. A tabela abaixo lista
       somente as operações em que a própria modalidade publicada identifica a
       classe de ativo.`;

    const disclosedModalities = Object.keys(index.asset_class_by_modality);
    const found = [];
    for (const year of index.years) {
      if (!year.operation_count) continue;
      const document_ = await BFX.load(year.file, { optional: true });
      if (!document_) continue;
      document_.operations.forEach((operation) => {
        if (disclosedModalities.includes(operation.modality)) found.push(operation);
      });
    }

    const body = document.getElementById('asset-usage-body');
    if (!found.length) {
      body.innerHTML = '<tr><td colspan="7" class="card__meta-row">' +
        'Nenhuma operação com classe de ativo divulgada na fonte.</td></tr>';
      return;
    }
    body.innerHTML = found.sort((a, b) => b.trade_date.localeCompare(a.trade_date))
      .map((operation) => `<tr>
        <td class="num">${BFX.date(operation.trade_date)}</td>
        <td>${BFX.escapeHtml(categories[operation.category].label)}</td>
        <td>${BFX.escapeHtml(operation.modality)}</td>
        <td>USD</td>
        <td>${BFX.escapeHtml(index.asset_class_by_modality[operation.modality])}</td>
        <td class="right num">${operation.counts_as_executed ? BFX.usdCents(operation.volume_accepted_usd_cents) : '<span class="na">não realizada</span>'}</td>
        <td>${operation.communication_number
          ? `<a href="https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Comunicado&numero=${encodeURIComponent(operation.communication_number)}" target="_blank" rel="noopener noreferrer">Comunicado ${BFX.escapeHtml(operation.communication_number)}</a>`
          : `<a href="${BFX.escapeHtml(index.source.landing_page)}" target="_blank" rel="noopener noreferrer">Conjunto de dados</a>`}</td>
      </tr>`).join('');
  }

  function sources() {
    document.getElementById('official-sources').innerHTML =
      composition.official_sources.map((source) => `<li>
        <a href="${BFX.escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(source.name)}</a>
        — ${BFX.escapeHtml(source.content)}
        <span class="badge ${source.machine_readable ? 'badge--official' : 'badge--unavailable'}">
          ${source.machine_readable ? 'legível por máquina' : 'apenas documento'}</span>
      </li>`).join('');
  }

  function chart(range) {
    const colors = BFXCharts.palette();
    const cash = BFX.applyRange(series.reserves_cash, range);
    const liquidity = BFX.applyRange(series.reserves_liquidity, range);
    BFXCharts.create('chart-total', {
      legend: { data: ['Conceito caixa', 'Conceito liquidez'] },
      tooltip: {
        formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>` +
          params.map((p) => `${p.marker} ${p.seriesName}: ${BFX.usd(p.value[1])}`).join('<br>')
      },
      yAxis: { axisLabel: { formatter: (value) => (value / 1e9).toFixed(0) + ' bi' } },
      series: [
        {
          name: 'Conceito caixa', type: 'line', showSymbol: false,
          lineStyle: { width: 1.6, color: colors.info }, itemStyle: { color: colors.info },
          data: cash.map((row) => [row.date, row.value_usd])
        },
        {
          name: 'Conceito liquidez', type: 'line', showSymbol: false,
          lineStyle: { width: 1.4, color: colors.notional, type: 'dashed' },
          itemStyle: { color: colors.notional },
          data: liquidity.map((row) => [row.date, row.value_usd])
        }
      ]
    });
  }

  async function init() {
    [composition, series, index] = await Promise.all([
      BFX.load('data/composition/composition.json'),
      BFX.load('data/indicators/series.json'),
      BFX.load('data/interventions/index.json')
    ]);
    categories = index.categories;
    notice();
    buckets();
    sources();
    BFX.rangeSelector('composition-range', {
      initial: BFX.recall('defaultRange', '5y'),
      onChange: chart
    });
    await assetUsage();
  }

  return { init };
})();
