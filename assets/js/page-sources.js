/* Fontes e metodologia. */
'use strict';

window.PAGE = (() => {
  let state, reserves, interventions, ptax, flow, composition, pressure, statement, rules;

  const QUALITY = [
    ['official', 'Dado oficial confirmado', 'Publicado pelo Banco Central e lido diretamente da fonte.'],
    ['secondary', 'Dado de fonte secundária', 'Não vem do Banco Central; usado apenas para a cotação ao vivo.'],
    ['preliminary', 'Dado preliminar', 'Sujeito a revisão pela própria fonte.'],
    ['estimated', 'Dado estimado', 'Calculado por esta aplicação a partir de dados oficiais.'],
    ['delayed', 'Dado atrasado', 'A data de referência está além da periodicidade normal da fonte.'],
    ['unavailable', 'Dado indisponível', 'A fonte oficial não publica essa informação.'],
    ['hypothetical', 'Informação hipotética', 'Cenário de simulação, não é previsão nem dado observado.']
  ];

  function legend() {
    document.getElementById('quality-legend').innerHTML = QUALITY.map(([key, label, description]) =>
      `<div class="card">
        <p class="card__label">${BFX.qualityBadge(key, label)}</p>
        <div class="card__value card__value--sm" style="font-size:13px">${BFX.escapeHtml(label)}</div>
        <p class="card__meta-row" style="margin-top:6px">${BFX.escapeHtml(description)}</p>
      </div>`).join('');
  }

  function stateTable() {
    document.getElementById('state-updated').textContent =
      'atualizado em ' + BFX.utcToSaoPaulo(state.updated_at);
    const tolerance = rules.staleness_tolerance_days || {};
    document.getElementById('state-body').innerHTML =
      Object.entries(state.sources).map(([key, entry]) => {
        const fresh = entry.reference_date
          ? BFX.freshness(entry.reference_date, tolerance[key])
          : { kind: 'unavailable', ageDays: null };
        const statusBadge = entry.status === 'ok'
          ? BFX.qualityBadge(fresh.kind)
          : entry.status === 'unavailable_by_design'
            ? BFX.qualityBadge('unavailable', 'A fonte oficial não publica este dado')
            : `<span class="badge badge--alta">${BFX.escapeHtml(entry.status)}</span>`;
        return `<tr>
          <td>${BFX.escapeHtml(key)}</td>
          <td>${statusBadge}</td>
          <td class="num">${entry.reference_date ? BFX.date(entry.reference_date) : '<span class="na">—</span>'}</td>
          <td class="right num">${fresh.ageDays === null ? '—' : fresh.ageDays + ' dia(s)'}</td>
          <td class="right num">${entry.record_count === null || entry.record_count === undefined ? '—' : BFX.number(entry.record_count)}</td>
          <td class="num">${BFX.utcToSaoPaulo(entry.last_successful_at || entry.collected_at)}</td>
          <td class="wrap">${entry.detail ? BFX.escapeHtml(entry.detail) : ''}</td>
        </tr>`;
      }).join('');
  }

  function sourceCard(spec) {
    return `<div class="card" style="margin-bottom:12px">
      <p class="card__label">${BFX.escapeHtml(spec.name)}</p>
      <dl class="kv">
        <dt>URL</dt><dd><a href="${BFX.escapeHtml(spec.url)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(spec.url)}</a></dd>
        <dt>Endpoint</dt><dd>${spec.endpoint ? `<a href="${BFX.escapeHtml(spec.endpoint)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(spec.endpoint)}</a>` : '<span class="na">não aplicável</span>'}</dd>
        <dt>Metodologia</dt><dd>${BFX.escapeHtml(spec.methodology)}</dd>
        <dt>Unidade monetária</dt><dd>${BFX.escapeHtml(spec.unit)}</dd>
        <dt>Frequência de publicação</dt><dd>${BFX.escapeHtml(spec.frequency)}</dd>
        <dt>Disponibilidade histórica</dt><dd>${BFX.escapeHtml(spec.history)}</dd>
        <dt>Limitações</dt><dd>${BFX.escapeHtml(spec.limitations)}</dd>
        <dt>Restrições de acesso</dt><dd>${BFX.escapeHtml(spec.access)}</dd>
        <dt>Última atualização</dt><dd>${BFX.escapeHtml(spec.updated)}</dd>
        <dt>Licença</dt><dd>${BFX.escapeHtml(spec.license)}</dd>
      </dl>
    </div>`;
  }

  function catalogue() {
    const specs = [
      {
        name: 'Reservas internacionais, conceito caixa (SGS 13621)',
        url: reserves.cash.source.landing_page,
        endpoint: reserves.cash.source.endpoint,
        methodology: reserves.cash.concept_description,
        unit: 'Dólares dos Estados Unidos, publicados em milhões',
        frequency: reserves.cash.official_update,
        history: `${BFX.date(reserves.cash.first_date)} a ${BFX.date(reserves.cash.reference_date)}, ${BFX.number(reserves.cash.observation_count)} observações`,
        limitations: 'Somente o total, sem abertura por moeda ou por classe de ativo. Janela máxima de consulta de dez anos por requisição.',
        access: 'Aberto, sem autenticação. O gateway pode responder 502 ou devolver HTML em instabilidade; a coleta repete a requisição.',
        updated: BFX.utcToSaoPaulo(reserves.cash.collected_at),
        license: reserves.cash.source.license
      },
      {
        name: 'Reservas internacionais, conceito liquidez (SGS 13982)',
        url: reserves.liquidity.source.landing_page,
        endpoint: reserves.liquidity.source.endpoint,
        methodology: reserves.liquidity.concept_description,
        unit: 'Dólares dos Estados Unidos, publicados em milhões',
        frequency: reserves.liquidity.official_update,
        history: `${BFX.date(reserves.liquidity.first_date)} a ${BFX.date(reserves.liquidity.reference_date)}, ${BFX.number(reserves.liquidity.observation_count)} observações`,
        limitations: 'Série começa depois da série de conceito caixa. Não deve ser somada nem comparada diretamente com ela.',
        access: 'Aberto, sem autenticação.',
        updated: BFX.utcToSaoPaulo(reserves.liquidity.collected_at),
        license: reserves.liquidity.source.license
      },
      {
        name: interventions.source.name,
        url: interventions.source.landing_page,
        endpoint: interventions.source.endpoint,
        methodology: `${interventions.source.publisher_notes || ''} Documentação: ${interventions.source.documentation}`,
        unit: interventions.currency_note,
        frequency: interventions.official_update,
        history: `${BFX.date(interventions.first_date)} a ${BFX.date(interventions.reference_date)}, ${BFX.number(interventions.operation_count)} operações`,
        limitations: interventions.known_limitations.join(' '),
        access: 'Aberto, arquivo CSV único de cerca de 2 MB.',
        updated: `metadados alterados em ${interventions.source.metadata_modified || '—'}; coletado em ${BFX.utcToSaoPaulo(interventions.collected_at)}`,
        license: interventions.source.license
      },
      {
        name: 'Taxa de câmbio PTAX (SGS 1 e SGS 10813)',
        url: 'https://dadosabertos.bcb.gov.br/dataset/1-taxa-de-cambio---livre---dolar-americano-venda---diario',
        endpoint: ptax.sources[0].endpoint,
        methodology: ptax.concept,
        unit: 'Reais por dólar',
        frequency: ptax.official_update,
        history: `${BFX.date(ptax.first_date)} a ${BFX.date(ptax.reference_date)}, ${BFX.number(ptax.observation_count)} observações`,
        limitations: 'Taxa de referência, não cotação em tempo real. Não há série intradiária gratuita para o horário dos leilões.',
        access: 'Aberto, sem autenticação.',
        updated: BFX.utcToSaoPaulo(ptax.collected_at),
        license: ptax.license
      },
      {
        name: 'Serviço PTAX (Olinda OData v1)',
        url: 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/aplicacao',
        endpoint: 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo',
        methodology: 'Boletins de fechamento da PTAX com o horário exato de publicação.',
        unit: 'Reais por dólar',
        frequency: 'Diária, em dias úteis',
        history: 'Consulta por período; esta aplicação coleta os últimos 21 dias',
        limitations: 'O parâmetro de data usa o formato mm-dd-aaaa entre apóstrofos.',
        access: 'Aberto, sem autenticação.',
        updated: 'ver estado da coleta',
        license: 'Open Data Commons Open Database License (ODbL)'
      },
      {
        name: 'Balanço de pagamentos mensal (SGS 22701, 22707 a 22709, 22864, 22885, 22905, 22924, 22969)',
        url: 'https://www.bcb.gov.br/estatisticas/estatisticassetorexterno',
        endpoint: 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.22701/dados?formato=json',
        methodology: flow.concept,
        unit: 'US$ milhões',
        frequency: flow.official_update,
        history: `a partir de 1995, até ${BFX.date(flow.reference_date)}`,
        limitations: flow.not_the_same_as,
        access: 'Aberto, sem autenticação.',
        updated: BFX.utcToSaoPaulo(flow.collected_at),
        license: 'Open Data Commons Open Database License (ODbL)'
      },
      {
        name: 'Composição das reservas por moeda e por classe de ativo',
        url: 'https://www.bcb.gov.br/publicacoes/relatoriogestaoreservas',
        endpoint: null,
        methodology: composition.explanation,
        unit: 'não aplicável',
        frequency: 'Anual, apenas em PDF',
        history: 'não disponível em formato aberto',
        limitations: composition.perspective_warning,
        access: 'Documento em PDF, sem API.',
        updated: BFX.utcToSaoPaulo(composition.collected_at),
        license: 'Conteúdo do Banco Central do Brasil'
      },
      {
        name: 'Cotação de mercado USD/BRL ao vivo (fonte secundária)',
        url: 'https://docs.awesomeapi.com.br/api-de-moedas',
        endpoint: BFX.LIVE_SOURCE.endpoint,
        methodology: 'Cotação de mercado agregada, consultada diretamente pelo navegador. Não é dado do Banco Central.',
        unit: 'Reais por dólar',
        frequency: 'Intradiária, com atraso de alguns minutos',
        history: 'apenas o momento atual',
        limitations: 'Fonte secundária, usada somente para a cotação ao vivo. Nenhum valor dela é gravado no repositório.',
        access: 'Aberto, com CORS liberado, sem chave.',
        updated: 'a cada atualização do painel',
        license: 'Termos do provedor'
      }
    ];
    document.getElementById('catalogue').innerHTML = specs.map(sourceCard).join('');
  }

  function formulas() {
    const method = statement.methodology;
    const components = pressure.components.map((component) =>
      `<li><strong>${BFX.escapeHtml(component.label)}</strong> (peso ${component.weight}):
        ${BFX.escapeHtml(component.unit)}, ${BFX.escapeHtml(component.direction)}.
        Pontos de quebra: ${component.breakpoints.map((point) => `${point[0]} → ${point[1]}`).join('; ')}.</li>`).join('');

    document.getElementById('formulas').innerHTML = `
      <h3 style="font-size:13px;margin:0 0 6px">Conciliação diária das reservas</h3>
      <dl class="kv">
        ${Object.entries(method).map(([key, value]) =>
          `<dt>${BFX.escapeHtml(key)}</dt><dd>${BFX.escapeHtml(value)}</dd>`).join('')}
      </dl>
      <h3 style="font-size:13px;margin:18px 0 6px">Indicador de pressão cambial</h3>
      <dl class="kv">
        <dt>Fórmula</dt><dd>${BFX.escapeHtml(pressure.formula)}</dd>
        <dt>Natureza</dt><dd>${BFX.escapeHtml(pressure.disclaimer)}</dd>
        <dt>Cobertura mínima</dt><dd>${pressure.minimum_coverage_pct}%</dd>
      </dl>
      <ul class="plain" style="margin-top:8px">${components}</ul>
      <h3 style="font-size:13px;margin:18px 0 6px">Agregações de intervenções</h3>
      <ul class="plain">
        <li>Vendas e compras à vista são atribuídas à <strong>data de liquidação</strong>, porque é quando a moeda estrangeira se move.</li>
        <li>O retorno de operações temporárias é atribuído à <strong>data de vencimento</strong> publicada.</li>
        <li>Swaps cambiais são atribuídos à <strong>data da operação</strong> e contabilizados apenas como valor nocional.</li>
        <li>Operações sem volume aceito publicado não entram em nenhum total de venda ou compra.</li>
      </ul>
      <h3 style="font-size:13px;margin:18px 0 6px">Limites de alerta</h3>
      <ul class="plain">
        ${rules.rules.map((rule) => `<li><strong>${BFX.escapeHtml(rule.label)}:</strong>
          ${BFX.escapeHtml(rule.indicator)} ${BFX.escapeHtml(rule.comparison)}
          ${rule.default_threshold === null ? 'critério qualitativo' : BFX.number(rule.default_threshold, 2)}
          ${BFX.escapeHtml(rule.unit)} · severidade ${BFX.escapeHtml(rule.severity)}</li>`).join('')}
      </ul>`;
  }

  function limitations() {
    const items = [
      'A fonte de atuações no mercado de câmbio é atualizada mensalmente. Entre a última atuação publicada e hoje não é possível afirmar que houve ou não intervenção.',
      'A fonte de atuações não reflete cancelamentos nem pré-pagamentos posteriores à publicação do resultado, portanto o status "cancelada" não pode ser derivado dela.',
      'O motivo oficial de cada intervenção não consta no conjunto de dados; esta aplicação sempre leva ao comunicado correspondente.',
      'Não existe horário de execução por operação, apenas o horário de divulgação do comunicado e do anúncio.',
      'A composição das reservas por moeda e por classe de ativo não é publicada em API; a aplicação não exibe percentuais estimados.',
      'O fluxo cambial contratado semanal, divulgado na nota do setor externo, não possui API pública nem série no SGS. A página de fluxo usa o balanço de pagamentos mensal e diz isso explicitamente.',
      'A dívida externa de curto prazo em dólares não está disponível no portal aberto; o componente correspondente do indicador de pressão fica sem dado e com peso zero.',
      'A efetividade das intervenções usa fechamentos diários da PTAX, porque não há série intradiária gratuita e confiável para o horário dos leilões.',
      'O estoque de operações temporárias e de swaps é calculado pelas datas de liquidação e vencimento publicadas; é um limite superior, já que pré-pagamentos não aparecem na fonte.',
      'Agendamentos do GitHub Actions podem atrasar em períodos de fila alta e são desativados automaticamente após sessenta dias sem atividade no repositório público.'
    ];
    document.getElementById('limitations').innerHTML =
      items.map((item) => `<li>${BFX.escapeHtml(item)}</li>`).join('');
  }

  async function init() {
    const [cashDocument, liquidityDocument] = await Promise.all([
      BFX.load('data/reserves/cash.json'),
      BFX.load('data/reserves/liquidity.json')
    ]);
    reserves = { cash: cashDocument, liquidity: liquidityDocument };
    [state, interventions, ptax, flow, composition, pressure, statement, rules] =
      await Promise.all([
        BFX.load('data/metadata/collection-state.json'),
        BFX.load('data/interventions/index.json'),
        BFX.load('data/exchange-rates/ptax.json'),
        BFX.load('data/exchange-flow/balance-of-payments.json'),
        BFX.load('data/composition/composition.json'),
        BFX.load('data/indicators/pressure.json'),
        BFX.load('data/reserves/statement-index.json'),
        BFX.load('data/alerts/rules.json')
      ]);
    legend();
    stateTable();
    catalogue();
    formulas();
    limitations();
  }

  return { init };
})();
