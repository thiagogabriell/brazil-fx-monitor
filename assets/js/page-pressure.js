/* Indicador de pressão cambial. */
'use strict';

window.PAGE = (() => {
  let pressure, patterns;

  function colorFor(value) {
    const colors = BFXCharts.palette();
    if (value === null || value === undefined) return colors.unavailable;
    if (value <= 20) return colors.inflow;
    if (value <= 40) return colors.info;
    if (value <= 60) return colors.warn;
    if (value <= 80) return colors.outflow;
    return colors.outflow;
  }

  function cards() {
    const score = pressure.score;
    const card = (label, value, meta) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${meta}</p>` : ''}</div>`;

    const dates = pressure.reference_dates || {};
    document.getElementById('pressure-cards').innerHTML = [
      `<div class="card">
        <p class="card__label">Pontuação total</p>
        <div class="card__value" style="color:${colorFor(score)}">
          ${score === null ? BFX.naText() : BFX.number(score, 1)}
          <span style="font-size:13px;color:var(--text-muted)">/ 100</span></div>
        <div class="gauge-bar" style="margin-top:8px">
          <div class="gauge-bar__fill" style="width:${score === null ? 0 : score}%;background:${colorFor(score)}"></div>
        </div>
        <p class="card__meta-row" style="margin-top:6px">
          <strong>${BFX.escapeHtml(pressure.classification.label)}</strong></p>
      </div>`,
      card('Grau de cobertura dos indicadores',
        BFX.pct(pressure.coverage_pct, { sign: false }),
        `peso disponível ${pressure.available_weight} de ${pressure.intended_weight};
         mínimo exigido ${pressure.minimum_coverage_pct}%`),
      card('Componentes com dado', BFX.number(pressure.components.filter((c) => c.available).length),
        `${pressure.missing_components.length} sem dado`),
      card('Datas de referência usadas',
        '<span class="card__value--sm">múltiplas</span>',
        `reservas ${BFX.date(dates.reserves)} · câmbio ${BFX.date(dates.exchange_rate)} ·
         atuações ${BFX.date(dates.interventions)} · fluxo ${BFX.date(dates.exchange_flow)}`)
    ].join('');

    document.getElementById('coverage-note').textContent =
      score === null
        ? 'A pontuação total não é exibida porque a cobertura ficou abaixo do mínimo.'
        : `Média ponderada apenas sobre os componentes com dado, renormalizada pelo peso disponível.`;
  }

  function components() {
    document.getElementById('components').innerHTML = pressure.components.map((component) => {
      const width = component.score === null ? 0 : component.score;
      return `<div class="component-row">
        <div>
          <div class="component-row__title">${BFX.escapeHtml(component.label)}
            ${component.weight === 0 ? '<span class="badge badge--unavailable">peso zero</span>' : ''}
            ${component.available ? '' : '<span class="badge badge--unavailable">sem dado</span>'}</div>
          <div class="component-row__meta">${BFX.escapeHtml(component.justification)}</div>
          <div class="component-row__meta">Unidade: ${BFX.escapeHtml(component.unit)} ·
            ${BFX.escapeHtml(component.direction)} ·
            valor observado: ${component.observed_value === null
              ? BFX.naText() : BFX.number(component.observed_value, 2)}</div>
          <div class="component-row__meta">Pontos de quebra:
            ${component.breakpoints.map((point) => `${BFX.number(point[0], 2)} → ${BFX.number(point[1], 0)}`).join(' · ')}</div>
          <div class="gauge-bar" style="margin-top:6px;max-width:320px">
            <div class="gauge-bar__fill" style="width:${width}%;background:${colorFor(component.score)}"></div>
          </div>
        </div>
        <div class="component-row__score" style="color:${colorFor(component.score)}">
          ${component.score === null ? '—' : BFX.number(component.score, 1)}
          <div class="component-row__meta">peso ${component.weight}</div>
        </div>
      </div>`;
    }).join('');

    document.getElementById('missing').innerHTML = pressure.missing_components.length
      ? pressure.missing_components.map((item) =>
        `<li><strong>${BFX.escapeHtml(item.label)}:</strong> ${BFX.escapeHtml(item.reason)}</li>`).join('')
      : '<li>Todos os componentes previstos têm dado nesta coleta.</li>';
  }

  function bands() {
    document.getElementById('bands-body').innerHTML = pressure.bands.map((band) => {
      const middle = (band.from + band.to) / 2;
      return `<tr>
        <td class="num">${band.from} a ${band.to}</td>
        <td><span class="badge" style="border-color:${colorFor(middle)};color:${colorFor(middle)}">${BFX.escapeHtml(band.label)}</span></td>
      </tr>`;
    }).join('');

    document.getElementById('formula').innerHTML = `
      <dt>Fórmula</dt><dd>${BFX.escapeHtml(pressure.formula)}</dd>
      <dt>Cobertura mínima</dt><dd>${pressure.minimum_coverage_pct}% do peso previsto</dd>
      <dt>Soma dos pesos previstos</dt><dd>${pressure.intended_weight}</dd>
      <dt>Natureza</dt><dd>${BFX.escapeHtml(pressure.disclaimer)}</dd>
      <dt>Gerado em</dt><dd>${BFX.escapeHtml(BFX.utcToSaoPaulo(pressure.generated_at))}</dd>`;
  }

  function history(range) {
    const colors = BFXCharts.palette();
    const rows = BFX.applyRange(pressure.history || [], range);
    BFXCharts.create('chart-history', {
      legend: { data: ['Pontuação', 'Cobertura de dados'] },
      tooltip: {
        formatter: (params) => `<strong>${BFX.date(String(params[0].axisValueLabel).slice(0, 10))}</strong><br>` +
          params.map((p) => `${p.marker} ${p.seriesName}: ${p.value[1] === null ? BFX.naText() : BFX.number(p.value[1], 1)}`).join('<br>')
      },
      yAxis: [
        { type: 'value', min: 0, max: 100, name: 'pontos' },
        { type: 'value', min: 0, max: 100, position: 'right', name: '% cobertura',
          splitLine: { show: false } }
      ],
      visualMap: [{
        show: false, seriesIndex: 0, dimension: 1, min: 0, max: 100,
        inRange: { color: [colors.inflow, colors.info, colors.warn, colors.outflow] }
      }],
      series: [
        {
          name: 'Pontuação', type: 'line', showSymbol: true, symbolSize: 5,
          yAxisIndex: 0, lineStyle: { width: 2 },
          data: rows.map((row) => [row.date, row.score])
        },
        {
          name: 'Cobertura de dados', type: 'line', showSymbol: false, yAxisIndex: 1,
          lineStyle: { width: 1, color: colors.dim, type: 'dashed' },
          itemStyle: { color: colors.dim },
          data: rows.map((row) => [row.date, row.coverage_pct])
        }
      ]
    });
  }

  function renderPatterns() {
    document.getElementById('patterns').innerHTML =
      `<p class="card__meta-row" style="margin-bottom:10px">${BFX.escapeHtml(patterns.evidence_policy)}</p>` +
      patterns.patterns.map((pattern) => `
        <div class="component-row">
          <div>
            <div class="component-row__title">
              ${pattern.detected ? '<span class="badge badge--alta">identificado</span>' : '<span class="badge badge--unavailable">não identificado</span>'}
              ${BFX.escapeHtml(pattern.title)}
              <span class="badge ${pattern.kind === 'fato_confirmado' ? 'badge--official' : 'badge--preliminary'}">
                ${pattern.kind === 'fato_confirmado' ? 'fato confirmado' : 'tendência observada'}</span>
            </div>
            <div class="component-row__meta">${BFX.escapeHtml(pattern.evidence.join(' · '))}</div>
            <div class="component-row__meta">${BFX.escapeHtml(pattern.detail)}</div>
          </div>
          <div class="component-row__score">${pattern.detected ? '●' : '○'}</div>
        </div>`).join('');
  }

  async function init() {
    [pressure, patterns] = await Promise.all([
      BFX.load('data/indicators/pressure.json'),
      BFX.load('data/indicators/patterns.json')
    ]);
    cards();
    components();
    bands();
    renderPatterns();
    BFX.rangeSelector('pressure-range', { initial: '5y', onChange: history });
  }

  return { init };
})();
