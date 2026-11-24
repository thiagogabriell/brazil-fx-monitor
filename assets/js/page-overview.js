/* Visão geral: executive dashboard. */
'use strict';

window.PAGE = (() => {
  let summary, series, dailySummary, alerts, patterns, pressure, reservesIndex, state;

  function metaRow(label, value) {
    return `<div class="card__meta-row"><dt>${BFX.escapeHtml(label)}</dt>` +
      `<dd>${value}</dd></div>`;
  }

  function cardMeta(rows) {
    return `<dl class="card__meta">${rows.join('')}</dl>`;
  }

  function sourceMeta({ source, reference, collected, unit, frequency, status }) {
    return cardMeta([
      metaRow('Fonte', BFX.escapeHtml(source)),
      metaRow('Data de referência', BFX.escapeHtml(BFX.date(reference))),
      metaRow('Última coleta', BFX.escapeHtml(BFX.utcToSaoPaulo(collected))),
      metaRow('Unidade', BFX.escapeHtml(unit)),
      metaRow('Frequência oficial', BFX.escapeHtml(frequency)),
      metaRow('Disponibilidade', status)
    ]);
  }

  function card(label, value, delta, meta, badge) {
    return `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}${badge ? ' ' + badge : ''}</p>
      <div class="card__value">${value}</div>
      ${delta ? `<div class="card__delta">${delta}</div>` : ''}
      ${meta || ''}
    </div>`;
  }

  /* ---------------------------------------------------------------- blocks */

  function renderAnchors() {
    const a = summary.anchors;
    document.getElementById('anchor-notice').innerHTML =
      `<div class="notice notice--info">
        <strong>Datas de referência diferentes por fonte.</strong>
        Reservas: ${BFX.date(a.reserves)} · Câmbio: ${BFX.date(a.exchange_rate)} ·
        Atuações do BCB: ${BFX.date(a.interventions)} ·
        Balanço de pagamentos: ${BFX.date(a.exchange_flow)}.
        ${BFX.escapeHtml(summary.anchor_note)}
      </div>`;
  }

  function renderReserves(conceptKey) {
    const block = summary.reserves[conceptKey];
    const container = document.getElementById('reserves-cards');
    if (!block) {
      container.innerHTML = '<p class="notice notice--warn">Conceito indisponível.</p>';
      return;
    }
    const fresh = BFX.freshness(block.reference_date, 6);
    document.getElementById('reserves-badge').innerHTML =
      BFX.qualityBadge(fresh.kind, `Publicado em ${BFX.date(block.reference_date)}`);

    const meta = sourceMeta({
      source: `BCB SGS ${conceptKey === 'cash' ? 13621 : 13982}`,
      reference: block.reference_date,
      collected: state && state.sources ? (state.sources['reserves_' + conceptKey] || {}).collected_at : null,
      unit: 'Dólares dos Estados Unidos',
      frequency: 'Diária, em dias úteis',
      status: fresh.kind === 'delayed'
        ? `<span class="neg">atrasada em ${fresh.ageDays} dias</span>`
        : `<span class="pos">em dia (${fresh.ageDays} dia(s) de defasagem)</span>`
    });

    const cards = [
      card('Total atual das reservas', BFX.usd(block.current_usd),
        BFX.deltaHtml(block.daily_change_usd, block.daily_change_pct), meta),
      card('Saldo anterior', BFX.usd(block.previous_usd),
        `<span class="neutral">em ${BFX.date(block.previous_date)}</span>`,
        cardMeta([metaRow('Dia útil anterior publicado', BFX.date(block.previous_date))])),
      card('Variação em 7 e 30 dias',
        `${BFX.pct(block.changes['7'].change_pct)} / ${BFX.pct(block.changes['30'].change_pct)}`,
        `${BFX.usd(block.changes['7'].change, { sign: true })} / ${BFX.usd(block.changes['30'].change, { sign: true })}`,
        cardMeta([
          metaRow('Base de 7 dias', BFX.date(block.changes['7'].from_date)),
          metaRow('Base de 30 dias', BFX.date(block.changes['30'].from_date))
        ])),
      card('Variação em 90 e 365 dias',
        `${BFX.pct(block.changes['90'].change_pct)} / ${BFX.pct(block.changes['365'].change_pct)}`,
        `${BFX.usd(block.changes['90'].change, { sign: true })} / ${BFX.usd(block.changes['365'].change, { sign: true })}`,
        cardMeta([
          metaRow('Base de 90 dias', BFX.date(block.changes['90'].from_date)),
          metaRow('Base de 365 dias', BFX.date(block.changes['365'].from_date))
        ])),
      card('Maior saldo histórico', BFX.usd(block.all_time_high_usd),
        `<span class="neutral">em ${BFX.date(block.all_time_high_date)}</span>`,
        cardMeta([metaRow('Série desde', BFX.date(block.first_date))])),
      card('Diferença para o maior saldo', BFX.usd(block.gap_to_all_time_high_usd, { sign: true }),
        BFX.deltaHtml(null, block.gap_to_all_time_high_pct), null),
      card('Menor saldo dos últimos 12 meses', BFX.usd(block.low_12m_usd),
        `<span class="neutral">em ${BFX.date(block.low_12m_date)}</span>`, null),
      card('Maior saldo dos últimos 12 meses', BFX.usd(block.high_12m_usd), null, null)
    ];
    container.innerHTML = cards.join('');

    const conceptSpec = reservesIndex.concepts.find((c) => c.key === conceptKey);
    document.getElementById('concept-explanation').innerHTML =
      `<strong>${BFX.escapeHtml(block.label)}:</strong> ` +
      BFX.escapeHtml(conceptSpec ? conceptSpec.description : '') +
      ' ' + BFX.escapeHtml(reservesIndex.warning);
  }

  function renderInterventions() {
    const block = summary.interventions;
    const windows = block.windows;
    const fresh = BFX.freshness(block.anchor_date, 75);
    document.getElementById('interventions-badge').innerHTML =
      BFX.qualityBadge(fresh.kind, `Última atuação publicada: ${BFX.date(block.anchor_date)}`);

    document.getElementById('interventions-notice').innerHTML =
      `<div class="notice notice--warn">
        A fonte oficial de atuações é atualizada <strong>uma vez por mês</strong> e
        cobre até <strong>${BFX.date(block.anchor_date)}</strong>, ou seja
        ${fresh.ageDays} dias atrás. Os totais abaixo terminam nessa data e não
        representam o dia de hoje. Não há, portanto, como afirmar que não houve
        intervenção depois dessa data.
      </div>`;

    const meta = (window_) => cardMeta([
      metaRow('Janela', `${BFX.date(window_.from_date)} a ${BFX.date(window_.to_date)}`),
      metaRow('Operações', BFX.number(window_.operation_count)),
      metaRow('Dias com venda direta', BFX.number(window_.days_with_direct_sale)),
      metaRow('Apenas anunciadas (não contadas)', BFX.number(window_.announced_without_result_count)),
      metaRow('Fonte', 'Histórico de atuações no mercado de câmbio (BCB)')
    ]);

    const anchorDay = block.anchor_day;
    const last = block.last_direct_sale;
    const cards = [
      card('Vendido no último dia coberto',
        anchorDay.available ? BFX.usdCents(anchorDay.sold_usd_cents) : BFX.naText(),
        `<span class="neutral">${BFX.escapeHtml(anchorDay.note)}</span>`,
        cardMeta([metaRow('Data', BFX.date(anchorDay.date))])),
      card('Última intervenção direta',
        last ? BFX.usdCents(last.accepted_usd_cents) : BFX.naText(),
        last ? `<span class="neutral">negociada em ${BFX.date(last.trade_date)}</span>` : '',
        last ? cardMeta([
          metaRow('Liquidação', BFX.date(last.settlement_date)),
          metaRow('Modalidade', last.modality),
          metaRow('Taxa de corte', BFX.number(last.cut_rate, 6)),
          metaRow('Comunicado', `<a href="https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Comunicado&numero=${encodeURIComponent(last.communication_number)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(last.communication_number)}</a>`)
        ]) : null),
      card('Vendido em 7 dias', BFX.usdCents(windows['7'].sold_usd_cents), null, meta(windows['7'])),
      card('Vendido em 30 dias', BFX.usdCents(windows['30'].sold_usd_cents), null, meta(windows['30'])),
      card('Vendido em 90 dias', BFX.usdCents(windows['90'].sold_usd_cents), null, meta(windows['90'])),
      card('Vendido em 365 dias', BFX.usdCents(windows['365'].sold_usd_cents), null, meta(windows['365'])),
      card('Comprado em 365 dias', BFX.usdCents(windows['365'].bought_usd_cents), null,
        cardMeta([
          metaRow('Comprado em 7 dias', BFX.usdCents(windows['7'].bought_usd_cents)),
          metaRow('Comprado em 30 dias', BFX.usdCents(windows['30'].bought_usd_cents)),
          metaRow('Comprado em 90 dias', BFX.usdCents(windows['90'].bought_usd_cents))
        ])),
      card('Saldo líquido em 365 dias',
        BFX.usdCents(windows['365'].net_usd_cents, { sign: true }),
        BFX.deltaHtml(windows['365'].net_usd_cents / 100, null),
        cardMeta([metaRow('Compras menos vendas diretas', 'liquidadas na janela')])),
      card('Operações com compromisso de recompra',
        BFX.usdCents(block.open_temporary.outstanding_usd_cents),
        `<span class="neutral">${BFX.number(block.open_temporary.count)} em aberto</span>`,
        cardMeta([
          metaRow('Posição em', BFX.date(block.open_temporary.as_of)),
          metaRow('Observação', BFX.escapeHtml(block.open_temporary.note))
        ]),
        '<span class="chip chip--temporary">temporária</span>'),
      card('Swaps cambiais em aberto (nocional)',
        BFX.usdCents(block.swap_outstanding.traditional_notional_usd_cents),
        `<span class="neutral">reverso: ${BFX.usdCents(block.swap_outstanding.reverse_notional_usd_cents)}</span>`,
        cardMeta([
          metaRow('Contratos tradicionais', BFX.number(block.swap_outstanding.traditional_contract_count)),
          metaRow('Contratos reversos', BFX.number(block.swap_outstanding.reverse_contract_count)),
          metaRow('Observação', BFX.escapeHtml(block.swap_outstanding.note))
        ]),
        '<span class="chip chip--notional">nocional</span>'),
      card('Quantidade de intervenções',
        BFX.number(block.executed_operations),
        `<span class="neutral">de ${BFX.number(block.total_operations)} registros publicados</span>`,
        cardMeta([
          metaRow('Liquidadas', BFX.number(block.by_status.liquidada || 0)),
          metaRow('Realizadas (a liquidar)', BFX.number(block.by_status.realizada || 0)),
          metaRow('Apenas anunciadas', BFX.number(block.by_status.anunciada || 0)),
          metaRow('Pendentes de confirmação', BFX.number(block.by_status.pendente_de_confirmacao || 0))
        ]))
    ];
    document.getElementById('interventions-cards').innerHTML = cards.join('');
  }

  function renderMarket() {
    const ptax = summary.market.ptax;
    const fresh = BFX.freshness(ptax.reference_date, 5);
    document.getElementById('market-badge').innerHTML =
      BFX.qualityBadge(fresh.kind, `PTAX de ${BFX.date(ptax.reference_date)}`);

    const meta = cardMeta([
      metaRow('Fonte', 'BCB SGS 1 e serviço PTAX (Olinda)'),
      metaRow('Data de referência', BFX.date(ptax.reference_date)),
      metaRow('Publicado em', BFX.stamp(ptax.published_at_sao_paulo)),
      metaRow('Unidade', 'Reais por dólar'),
      metaRow('Frequência oficial', 'Diária, em dias úteis')
    ]);

    const cards = [
      `<div class="card">
        <p class="card__label">Cotação do dólar comercial (ao vivo)
          <span class="badge badge--secondary">fonte secundária</span></p>
        <div class="card__value" id="ov-live">buscando…</div>
        <div class="card__delta" id="ov-live-delta"></div>
        ${cardMeta([
          metaRow('Fonte', BFX.escapeHtml(BFX.LIVE_SOURCE.name)),
          metaRow('Classificação', 'Cotação de mercado, não dado do Banco Central'),
          metaRow('Atualização', 'a cada 60 segundos enquanto o painel estiver aberto')
        ])}
      </div>`,
      card('Taxa PTAX de venda', BFX.brl(ptax.sell),
        BFX.deltaHtml(null, ptax.daily_change_pct, null, { invert: true }), meta,
        '<span class="badge badge--official">oficial</span>'),
      card('PTAX de compra', BFX.brl(ptax.buy), null,
        cardMeta([metaRow('Mesma data de referência', BFX.date(ptax.reference_date))])),
      card('Variação semanal e mensal',
        `${BFX.pct(ptax.changes['7'].change_pct)} / ${BFX.pct(ptax.changes['30'].change_pct)}`,
        null,
        cardMeta([
          metaRow('Base semanal', BFX.date(ptax.changes['7'].from_date)),
          metaRow('Base mensal', BFX.date(ptax.changes['30'].from_date))
        ])),
      card('Variação anual', BFX.pct(ptax.changes['365'].change_pct), null,
        cardMeta([metaRow('Base', BFX.date(ptax.changes['365'].from_date))])),
      card('Máxima de 12 meses', BFX.brl(ptax.high_12m),
        `<span class="neutral">em ${BFX.date(ptax.high_12m_date)}</span>`, null),
      card('Mínima de 12 meses', BFX.brl(ptax.low_12m),
        `<span class="neutral">em ${BFX.date(ptax.low_12m_date)}</span>`, null),
      card('Conceito da PTAX', '<span class="card__value--sm">referência oficial</span>', null,
        cardMeta([metaRow('Definição', BFX.escapeHtml(ptax.concept))]))
    ];
    document.getElementById('market-cards').innerHTML = cards.join('');

    const paint = (quote) => {
      const target = document.getElementById('ov-live');
      const delta = document.getElementById('ov-live-delta');
      if (!target) return;
      if (!quote || !quote.ok) {
        target.innerHTML = '<span class="na">indisponível</span>';
        delta.innerHTML = '<span class="na">a cotação ao vivo não respondeu; a PTAX ao lado continua válida</span>';
        return;
      }
      const t = BFX.trend(quote.changePct, { invert: true });
      target.textContent = BFX.brl(quote.bid);
      delta.innerHTML = `<span class="${t.cls}">${BFX.pct(quote.changePct)}</span>` +
        ` <span class="neutral">máx ${BFX.brl(quote.high)} · mín ${BFX.brl(quote.low)} · ` +
        `${BFX.escapeHtml(quote.at || '')}</span>`;
    };
    window.addEventListener('bfx:quote', (event) => paint(event.detail));
    // A quote may already have arrived before this block was rendered.
    if (BFX.lastQuote()) paint(BFX.lastQuote());
  }

  function renderFlow() {
    const flow = summary.exchange_flow;
    const fresh = BFX.freshness(flow.reference_date, 95);
    document.getElementById('flow-badge').innerHTML =
      BFX.qualityBadge(fresh.kind, `Balanço de pagamentos de ${BFX.date(flow.reference_date)}`);
    document.getElementById('flow-notice').innerHTML =
      `<div class="notice notice--info">${BFX.escapeHtml(flow.not_the_same_as)}</div>`;

    const million = (value) => (value === null || value === undefined
      ? BFX.naText()
      : 'US$ ' + BFX.number(value, 0) + ' mi');

    const indicators = flow.indicators;
    const pick = (key) => indicators[key] || {};
    const trade = pick('trade_balance');
    const portfolio = pick('portfolio_investment_net');
    const direct = pick('direct_investment_net');
    const current = pick('current_account');

    const metaFor = (indicator) => cardMeta([
      metaRow('Fonte', `BCB SGS ${indicator.sgs_code}`),
      metaRow('Série', BFX.escapeHtml(indicator.label)),
      metaRow('Data de referência', BFX.date(indicator.reference_date)),
      metaRow('Unidade', 'US$ milhões'),
      metaRow('Frequência oficial', 'Mensal'),
      metaRow('Convenção', BFX.escapeHtml(indicator.direction_note || ''))
    ]);

    const cards = [
      card('Fluxo comercial (balança comercial)', million(trade.latest),
        BFX.deltaHtml(trade.latest, null, million), metaFor(trade)),
      card('Fluxo financeiro (investimentos em carteira)', million(portfolio.latest),
        BFX.deltaHtml(portfolio.latest, null, million), metaFor(portfolio)),
      card('Conta financeira em 3 meses', million(flow.financial_account_3m_usd_million),
        BFX.deltaHtml(flow.financial_account_3m_usd_million, null, million),
        cardMeta([
          metaRow('Composição', 'investimento direto + carteira + outros investimentos'),
          metaRow('Data de referência', BFX.date(flow.reference_date)),
          metaRow('Unidade', 'US$ milhões')
        ])),
      card('Transações correntes no mês', million(current.latest),
        BFX.deltaHtml(current.latest, null, million), metaFor(current)),
      card('Acumulado no ano (carteira)', million(portfolio.year_to_date), null,
        cardMeta([metaRow('Ano', (portfolio.reference_date || '').slice(0, 4))])),
      card('Acumulado em 12 meses (carteira)', million(portfolio.accumulated_12m), null, null),
      card('Tendência do fluxo financeiro',
        portfolio.trend === 'saida_liquida'
          ? '<span class="neg trend trend--down">saída líquida</span>'
          : portfolio.trend === 'entrada_liquida'
            ? '<span class="pos trend trend--up">entrada líquida</span>'
            : `<span class="na">${BFX.naText()}</span>`,
        `<span class="neutral">${BFX.number(portfolio.negative_month_streak)} mês(es) negativo(s) em sequência</span>`,
        cardMeta([metaRow('Base', 'acumulado de 3 meses do balanço de pagamentos')])),
      card('Investimento direto no mês', million(direct.latest),
        BFX.deltaHtml(direct.latest, null, million), metaFor(direct))
    ];
    document.getElementById('flow-cards').innerHTML = cards.join('');
  }

  function renderDailySummary() {
    const container = document.getElementById('daily-summary');
    document.getElementById('summary-stamp').textContent =
      'gerado em ' + BFX.utcToSaoPaulo(dailySummary.generated_at);
    const blocks = dailySummary.blocks.map((block) =>
      `<div class="summary-block">
        <h3>${BFX.escapeHtml(block.title)}</h3>
        <p>${BFX.escapeHtml(block.text)}</p>
        <footer>${BFX.escapeHtml(block.source)}${block.reference_date ? ' · referência ' + BFX.date(block.reference_date) : ''}</footer>
      </div>`).join('');
    container.innerHTML =
      `<p class="card__meta-row" style="margin-bottom:10px"><strong>${BFX.escapeHtml(dailySummary.headline)}</strong></p>` +
      blocks +
      `<div class="notice notice--info" style="margin-top:12px">
        <strong>Informações ainda não publicadas:</strong>
        <ul class="plain" style="margin-top:6px">
          ${dailySummary.pending_information.map((item) => `<li>${BFX.escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
      <p class="card__meta-row">${BFX.escapeHtml(dailySummary.method)}</p>`;
  }

  function renderAlerts() {
    const container = document.getElementById('overview-alerts');
    const active = alerts.alerts || [];
    const detected = patterns.patterns.filter((p) => p.detected);
    const alertHtml = active.length
      ? active.slice(0, 8).map((alert) =>
        `<div class="summary-block">
          <h3><span class="badge badge--${BFX.escapeHtml(alert.severity)}">${BFX.escapeHtml(alert.severity)}</span>
            ${BFX.escapeHtml(alert.label)}</h3>
          <p>${BFX.escapeHtml(alert.description)}</p>
          <footer>Valor observado: ${BFX.escapeHtml(String(alert.observed_value))} ·
            limite: ${BFX.escapeHtml(String(alert.threshold === null ? '—' : alert.threshold))} ·
            ${BFX.escapeHtml(alert.source)}</footer>
        </div>`).join('')
      : '<p class="card__meta-row">Nenhum alerta ativo com os limites padrão.</p>';

    const patternHtml = detected.length
      ? detected.map((pattern) =>
        `<div class="summary-block">
          <h3>${BFX.escapeHtml(pattern.title)}
            <span class="badge badge--${pattern.kind === 'fato_confirmado' ? 'official' : 'preliminary'}">${pattern.kind === 'fato_confirmado' ? 'fato confirmado' : 'tendência observada'}</span></h3>
          <p>${BFX.escapeHtml(pattern.evidence.join(' · '))}</p>
          <footer>${BFX.escapeHtml(pattern.detail)}</footer>
        </div>`).join('')
      : '<p class="card__meta-row">Nenhum padrão monitorado foi identificado.</p>';

    container.innerHTML =
      `<h3 style="font-size:12px;text-transform:uppercase;color:var(--text-muted);margin:0 0 8px">Alertas ativos (limites padrão)</h3>${alertHtml}` +
      `<h3 style="font-size:12px;text-transform:uppercase;color:var(--text-muted);margin:16px 0 8px">Padrões identificados</h3>${patternHtml}`;
  }

  function renderPressure() {
    const container = document.getElementById('pressure-mini');
    const score = pressure.score;
    const colors = typeof BFXCharts !== 'undefined' ? BFXCharts.palette() : {};
    const colorFor = (value) => {
      if (value === null) return colors.unavailable || '#6b7689';
      if (value <= 20) return colors.inflow;
      if (value <= 40) return colors.info;
      if (value <= 60) return colors.warn;
      return colors.outflow;
    };
    const top = pressure.components
      .filter((c) => c.available && c.weight > 0)
      .sort((a, b) => b.score * b.weight - a.score * a.weight)
      .slice(0, 4);

    container.innerHTML = `
      <div class="grid grid--2">
        <div>
          <div class="card__value" style="font-size:40px;color:${colorFor(score)}">
            ${score === null ? BFX.naText() : BFX.number(score, 1)}
            <span style="font-size:14px;color:var(--text-muted)">/ 100</span>
          </div>
          <p class="card__delta"><strong>${BFX.escapeHtml(pressure.classification.label)}</strong>
            · cobertura de dados ${BFX.pct(pressure.coverage_pct, { sign: false })}</p>
          <div class="gauge-bar" style="margin-top:10px">
            <div class="gauge-bar__fill" style="width:${score === null ? 0 : score}%;background:${colorFor(score)}"></div>
          </div>
          <p class="card__meta-row" style="margin-top:10px">${BFX.escapeHtml(pressure.disclaimer)}</p>
        </div>
        <div>
          <h3 style="font-size:12px;text-transform:uppercase;color:var(--text-muted);margin:0 0 8px">Componentes que mais pesam agora</h3>
          ${top.map((component) => `
            <div class="component-row">
              <div>
                <div class="component-row__title">${BFX.escapeHtml(component.label)}</div>
                <div class="component-row__meta">${BFX.escapeHtml(component.justification)}</div>
              </div>
              <div class="component-row__score" style="color:${colorFor(component.score)}">
                ${BFX.number(component.score, 0)}
                <div class="component-row__meta">peso ${component.weight}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  function renderChart(range) {
    const reserves = BFX.applyRange(series.reserves_cash, range);
    const rates = BFX.applyRange(series.ptax, range);
    const sales = BFX.applyRange(series.interventions_daily, range)
      .filter((row) => row.sold_cents > 0);
    const colors = BFXCharts.palette();

    BFXCharts.create('chart-overview', {
      grid: { left: 70, right: 70, top: 34, bottom: 56 },
      legend: { data: ['Reservas (conceito caixa)', 'PTAX de venda', 'Venda direta liquidada'] },
      tooltip: {
        valueFormatter: null,
        formatter: (params) => {
          const header = params.length ? BFX.date(String(params[0].axisValueLabel).slice(0, 10)) : '';
          const lines = params.map((p) => {
            if (p.seriesName === 'Reservas (conceito caixa)') {
              return `${p.marker} ${p.seriesName}: ${BFX.usd(p.value[1])}`;
            }
            if (p.seriesName === 'PTAX de venda') {
              return `${p.marker} ${p.seriesName}: ${BFX.brl(p.value[1])}`;
            }
            return `${p.marker} ${p.seriesName}: ${BFX.usd(p.value[1])}`;
          });
          return `<strong>${header}</strong><br>${lines.join('<br>')}`;
        }
      },
      yAxis: [
        {
          type: 'value', name: 'Reservas (US$)', position: 'left',
          axisLabel: { formatter: (value) => (value / 1e9).toFixed(0) + ' bi' },
          splitLine: { lineStyle: { color: colors.border, type: 'dashed' } }
        },
        {
          type: 'value', name: 'PTAX (R$/US$)', position: 'right',
          axisLabel: { formatter: (value) => value.toFixed(2) },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: 'Reservas (conceito caixa)', type: 'line', showSymbol: false,
          yAxisIndex: 0, lineStyle: { width: 1.6, color: colors.info },
          itemStyle: { color: colors.info },
          areaStyle: { color: colors.info, opacity: 0.08 },
          data: reserves.map((row) => [row.date, row.value_usd])
        },
        {
          name: 'PTAX de venda', type: 'line', showSymbol: false, yAxisIndex: 1,
          lineStyle: { width: 1.6, color: colors.warn }, itemStyle: { color: colors.warn },
          data: rates.map((row) => [row.date, row.value])
        },
        {
          name: 'Venda direta liquidada', type: 'scatter', yAxisIndex: 0,
          symbolSize: 9, itemStyle: { color: colors.outflow },
          data: sales.map((row) => {
            const match = reserves.find((r) => r.date === row.date);
            return [row.date, match ? match.value_usd : null, row.sold_cents / 100];
          }).filter((point) => point[1] !== null)
        }
      ]
    });

    document.getElementById('chart-overview-note').innerHTML =
      'Pontos vermelhos marcam dias com venda direta de dólares liquidada, segundo ' +
      'o histórico de atuações do BCB (publicado até ' +
      BFX.escapeHtml(BFX.date(summary.anchors.interventions)) +
      '). Clique em um ponto para abrir o extrato daquele dia.';

    const chart = BFXCharts.registry.get('chart-overview');
    if (chart) {
      chart.off('click');
      chart.on('click', (params) => {
        if (params.seriesName !== 'Venda direta liquidada') return;
        const date = String(params.value[0]).slice(0, 10);
        window.location.href = BFX.base + 'pages/transactions.html?date=' + date;
      });
    }
  }

  async function init() {
    [summary, series, dailySummary, alerts, patterns, pressure, reservesIndex, state] =
      await Promise.all([
        BFX.load('data/indicators/summary.json'),
        BFX.load('data/indicators/series.json'),
        BFX.load('data/indicators/daily-summary.json'),
        BFX.load('data/alerts/active.json'),
        BFX.load('data/indicators/patterns.json'),
        BFX.load('data/indicators/pressure.json'),
        BFX.load('data/reserves/index.json'),
        BFX.load('data/metadata/collection-state.json', { optional: true })
      ]);

    renderAnchors();

    const select = document.getElementById('concept-select');
    select.innerHTML = reservesIndex.concepts
      .filter((concept) => concept.available)
      .map((concept) => `<option value="${concept.key}">${BFX.escapeHtml(concept.label)}</option>`)
      .join('');
    const stored = BFX.recall('defaultConcept', reservesIndex.default_concept);
    select.value = summary.reserves[stored] ? stored : reservesIndex.default_concept;
    select.addEventListener('change', () => {
      BFX.store('defaultConcept', select.value);
      renderReserves(select.value);
    });
    renderReserves(select.value);

    renderInterventions();
    renderMarket();
    renderFlow();
    renderDailySummary();
    renderAlerts();
    renderPressure();

    BFX.rangeSelector('overview-range', {
      initial: BFX.recall('defaultRange', '1y'),
      onChange: (range) => renderChart(range)
    });
  }

  return { init };
})();
