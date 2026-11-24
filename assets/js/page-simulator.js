/* Simulador de consumo das reservas: pure arithmetic, clearly labelled. */
'use strict';

window.PAGE = (() => {
  let summary, officialBalance = null, comparisons = [];

  const PRESETS = [0.5, 1, 2, 5, 10];
  const HORIZONS = [7, 30, 90, 180, 365];

  function readParams() {
    const number = (id, fallback) => {
      const value = Number(document.getElementById(id).value);
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      initial: number('initial', 0) * 1e9,
      perIntervention: number('per-intervention', 0) * 1e9,
      perWeek: number('per-week', 0),
      perDay: number('per-day', 0) * 1e9,
      businessDays: Math.max(1, number('business-days', 21)),
      replenish: number('replenish', 0) * 1e9,
      floor: number('floor', 0) * 1e9
    };
  }

  /** Daily simulation over calendar days, business days carry the outflow. */
  function simulate(params, days) {
    const businessPerCalendar = params.businessDays / 30.4375;
    const interventionsPerBusinessDay = (params.perWeek * params.perIntervention) / 5;
    const dailyOutflow = (interventionsPerBusinessDay + params.perDay) * businessPerCalendar;
    const dailyReplenish = params.replenish / 30.4375;

    const points = [];
    let balance = params.initial;
    let consumed = 0;
    let floorDay = null;
    for (let day = 0; day <= days; day += 1) {
      points.push({ day, balance, consumed });
      if (floorDay === null && balance <= params.floor) floorDay = day;
      const outflow = dailyOutflow;
      consumed += outflow;
      balance = balance - outflow + dailyReplenish;
      if (balance < 0) balance = 0;
    }
    return { points, floorDay, dailyOutflow, dailyReplenish };
  }

  function cards(result, params) {
    const at = (day) => result.points[Math.min(day, result.points.length - 1)];
    const card = (label, value, meta) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${meta}</p>` : ''}</div>`;

    const final = at(365);
    const share = params.initial ? (final.consumed / params.initial) * 100 : null;

    document.getElementById('sim-cards').innerHTML = [
      card('Saldo inicial', BFX.usd(params.initial),
        officialBalance !== null && Math.abs(params.initial - officialBalance) < 1e6
          ? `saldo oficial de ${BFX.date(summary.reserves.cash.reference_date)}`
          : 'valor informado por você <span class="badge badge--hypothetical">hipotético</span>'),
      card('Saída média por dia útil',
        BFX.usd((params.perWeek * params.perIntervention) / 5 + params.perDay),
        `${params.perWeek} intervenção(ões) por semana de ${BFX.usd(params.perIntervention)}`),
      card('Saldo restante em 30 dias', BFX.usd(at(30).balance),
        `consumo de ${BFX.usd(at(30).consumed)}`),
      card('Saldo restante em 90 dias', BFX.usd(at(90).balance),
        `consumo de ${BFX.usd(at(90).consumed)}`),
      card('Saldo restante em 365 dias', BFX.usd(final.balance),
        `consumo de ${BFX.usd(final.consumed)}`),
      card('Percentual consumido em 365 dias', BFX.pct(share, { sign: false }),
        'sobre o saldo inicial informado'),
      card('Tempo até o saldo mínimo',
        result.floorDay === null
          ? 'acima do mínimo em 365 dias'
          : `${BFX.number(result.floorDay)} dia(s)`,
        `saldo mínimo de ${BFX.usd(params.floor)}`),
      card('Reposição considerada', BFX.usd(params.replenish),
        'por mês, somada ao saldo')
    ].join('');
  }

  function horizonTable(result, params) {
    document.getElementById('horizon-body').innerHTML = HORIZONS.map((days) => {
      const point = result.points[Math.min(days, result.points.length - 1)];
      const share = params.initial ? (point.consumed / params.initial) * 100 : null;
      const belowFloor = point.balance <= params.floor;
      return `<tr>
        <td>${days} dias</td>
        <td class="right num">${BFX.usd(point.consumed)}</td>
        <td class="right num ${belowFloor ? 'neg' : ''}">${BFX.usd(point.balance)}</td>
        <td class="right num">${BFX.pct(share, { sign: false })}</td>
        <td>${belowFloor
          ? '<span class="badge badge--alta">abaixo do mínimo desejado</span>'
          : '<span class="badge badge--official">acima do mínimo</span>'}</td>
      </tr>`;
    }).join('');
  }

  function presetTable(params) {
    document.getElementById('presets-body').innerHTML = PRESETS.map((billions) => {
      const scenario = { ...params, perIntervention: billions * 1e9 };
      const result = simulate(scenario, 365);
      const at = (day) => result.points[Math.min(day, result.points.length - 1)].balance;
      return `<tr>
        <td>US$ ${BFX.number(billions, billions < 1 ? 1 : 0)} bilhão(ões) por intervenção</td>
        <td class="right num">${BFX.usd(billions * 1e9)}</td>
        <td class="right num">${BFX.usd(at(30))}</td>
        <td class="right num">${BFX.usd(at(90))}</td>
        <td class="right num">${BFX.usd(at(180))}</td>
        <td class="right num">${BFX.usd(at(365))}</td>
        <td class="right num">${result.floorDay === null ? 'acima em 365 dias' : BFX.number(result.floorDay)}</td>
      </tr>`;
    }).join('');
  }

  function chart(result, params) {
    const colors = BFXCharts.palette();
    const baseDate = summary.reserves.cash
      ? Date.parse(summary.reserves.cash.reference_date + 'T00:00:00Z')
      : Date.now();
    const toSeries = (points) => points.map((point) => [
      new Date(baseDate + point.day * 86400000).toISOString().slice(0, 10),
      point.balance
    ]);

    const seriesList = [
      {
        name: 'Cenário atual', type: 'line', showSymbol: false,
        lineStyle: { width: 2, color: colors.info }, itemStyle: { color: colors.info },
        areaStyle: { color: colors.info, opacity: 0.08 },
        data: toSeries(result.points),
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: colors.warn, type: 'dashed' },
          label: { formatter: 'Saldo mínimo', color: colors.warn, fontSize: 10 },
          data: [{ yAxis: params.floor }]
        }
      },
      ...comparisons.map((comparison, position) => ({
        name: comparison.label, type: 'line', showSymbol: false,
        lineStyle: {
          width: 1.4, type: 'dashed',
          color: [colors.outflow, colors.inflow, colors.notional, colors.warn][position % 4]
        },
        itemStyle: {
          color: [colors.outflow, colors.inflow, colors.notional, colors.warn][position % 4]
        },
        data: toSeries(comparison.points)
      }))
    ];

    BFXCharts.create('chart-simulation', {
      legend: { data: seriesList.map((item) => item.name) },
      tooltip: {
        formatter: (paramsList) => `<strong>${BFX.date(String(paramsList[0].axisValueLabel).slice(0, 10))}</strong><br>` +
          paramsList.map((p) => `${p.marker} ${p.seriesName}: ${BFX.usd(p.value[1])}`).join('<br>')
      },
      yAxis: { axisLabel: { formatter: (value) => (value / 1e9).toFixed(0) + ' bi' } },
      series: seriesList
    });

    document.getElementById('comparison-note').textContent = comparisons.length
      ? `${comparisons.length} cenário(s) guardado(s) para comparação. Eixo do tempo em dias corridos a partir da data de referência das reservas.`
      : 'Ajuste os parâmetros e use "Guardar para comparar" para sobrepor cenários.';
  }

  function run() {
    const params = readParams();
    const result = simulate(params, 365);
    cards(result, params);
    horizonTable(result, params);
    presetTable(params);
    chart(result, params);
    BFX.store('simulator', {
      perIntervention: document.getElementById('per-intervention').value,
      perWeek: document.getElementById('per-week').value,
      perDay: document.getElementById('per-day').value,
      businessDays: document.getElementById('business-days').value,
      replenish: document.getElementById('replenish').value,
      floor: document.getElementById('floor').value
    });
    return { params, result };
  }

  async function init() {
    summary = await BFX.load('data/indicators/summary.json');
    officialBalance = summary.reserves.cash ? summary.reserves.cash.current_usd : null;

    const stored = BFX.recall('simulator', null);
    document.getElementById('initial').value = officialBalance
      ? (officialBalance / 1e9).toFixed(1) : '350';
    if (stored) {
      ['per-intervention', 'per-week', 'per-day', 'business-days', 'replenish', 'floor']
        .forEach((id) => {
          const key = id.replace(/-(.)/g, (match, letter) => letter.toUpperCase());
          if (stored[key] !== undefined && stored[key] !== '') {
            document.getElementById(id).value = stored[key];
          }
        });
    }

    document.getElementById('presets').innerHTML = PRESETS.map((billions) =>
      `<button class="btn" type="button" data-preset="${billions}">US$ ${BFX.number(billions, billions < 1 ? 1 : 0)} bi</button>`
    ).join(' ');
    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('per-intervention').value = button.dataset.preset;
        run();
      });
    });

    ['initial', 'per-intervention', 'per-week', 'per-day', 'business-days',
      'replenish', 'floor'].forEach((id) => {
      document.getElementById(id).addEventListener('input', run);
    });

    document.getElementById('reset-params').addEventListener('click', () => {
      document.getElementById('initial').value = officialBalance
        ? (officialBalance / 1e9).toFixed(1) : '350';
      run();
    });

    document.getElementById('add-comparison').addEventListener('click', () => {
      const { params, result } = run();
      comparisons.push({
        label: `US$ ${BFX.number(params.perIntervention / 1e9, 1)} bi x ${params.perWeek}/semana`,
        points: result.points
      });
      if (comparisons.length > 4) comparisons.shift();
      run();
    });
    document.getElementById('clear-comparison').addEventListener('click', () => {
      comparisons = [];
      run();
    });

    run();
  }

  return { init };
})();
