/* Movimentações diárias: the full operation ledger. */
'use strict';

window.PAGE = (() => {
  let index, categories, operations = [], filtered = [], page = 0;

  const CENTS = (value) => BFX.usdCents(value);

  function effectLabel(category) {
    const spec = categories[category];
    const map = {
      decrease: '<span class="chip chip--outflow">reduz as reservas</span>',
      increase: '<span class="chip chip--inflow">aumenta as reservas</span>',
      temporary_decrease: '<span class="chip chip--temporary">saída temporária</span>',
      none: '<span class="chip chip--notional">nocional, sem saída de dólares</span>'
    };
    return map[spec.reserve_effect] || '';
  }

  function assetClass(operation) {
    return operation.asset_class_disclosed
      ? (index.asset_class_by_modality[operation.modality] || operation.modality)
      : index.asset_class_undisclosed_label;
  }

  function coverageNotice() {
    document.getElementById('coverage-notice').innerHTML =
      `<div class="notice notice--warn">
        <strong>Fonte publicada até ${BFX.date(index.reference_date)}.</strong>
        ${BFX.escapeHtml(index.official_update)}
        ${index.statistics.ambiguous_duplicate_count
          ? ` Há ${index.statistics.ambiguous_duplicate_count} linha(s) que o BCB publica com todos os campos idênticos; elas ficam marcadas como possível duplicidade e não são removidas, para não alterar o total oficial.`
          : ''}
      </div>`;
  }

  function fillSelectors() {
    const categorySelect = document.getElementById('filter-category');
    categorySelect.innerHTML = '<option value="all">Todos</option>' +
      Object.entries(categories).map(([key, spec]) =>
        `<option value="${key}">${BFX.escapeHtml(spec.label)}</option>`).join('');

    document.getElementById('filter-currency').innerHTML =
      '<option value="all">Todas</option><option value="USD">USD (dólar dos Estados Unidos)</option>';

    document.getElementById('filter-asset').innerHTML =
      '<option value="all">Todas</option>' +
      Object.values(index.asset_class_by_modality).map((label) =>
        `<option value="${BFX.escapeHtml(label)}">${BFX.escapeHtml(label)}</option>`).join('') +
      `<option value="undisclosed">${BFX.escapeHtml(index.asset_class_undisclosed_label)}</option>`;

    document.getElementById('filter-status').innerHTML =
      '<option value="all">Todos</option>' +
      ['liquidada', 'realizada', 'anunciada', 'pendente_de_confirmacao']
        .map((status) => `<option value="${status}">${status.replace(/_/g, ' ')}</option>`).join('') +
      '<option value="cancelada" disabled>cancelada (não derivável desta fonte)</option>';

    document.getElementById('filter-source').innerHTML =
      '<option value="all">Todas</option>' +
      '<option value="with-communication">Com comunicado oficial</option>' +
      '<option value="without-communication">Sem comunicado na fonte</option>';

    const yearSelect = document.getElementById('year-select');
    yearSelect.innerHTML = index.years.slice().reverse().map((year) =>
      `<option value="${year.year}">${year.year} (${year.operation_count} operações)</option>`).join('');
    yearSelect.value = index.years[index.years.length - 1].year;
  }

  async function loadYear(year) {
    const spec = index.years.find((y) => String(y.year) === String(year));
    if (!spec) return [];
    const document_ = await BFX.load(spec.file);
    return document_.operations;
  }

  function applyFilters() {
    const from = document.getElementById('from-date').value;
    const to = document.getElementById('to-date').value;
    const category = document.getElementById('filter-category').value;
    const currency = document.getElementById('filter-currency').value;
    const asset = document.getElementById('filter-asset').value;
    const status = document.getElementById('filter-status').value;
    const source = document.getElementById('filter-source').value;
    const reserves = document.getElementById('filter-reserves').value;
    const minimum = Number(document.getElementById('min-value').value || 0) * 1e6 * 100;

    filtered = operations.filter((operation) => {
      if (from && (operation.trade_date || '') < from) return false;
      if (to && (operation.trade_date || '') > to) return false;
      if (category !== 'all' && operation.category !== category) return false;
      if (currency !== 'all' && currency !== 'USD') return false;
      if (asset !== 'all') {
        const label = assetClass(operation);
        if (asset === 'undisclosed') {
          if (operation.asset_class_disclosed) return false;
        } else if (label !== asset) return false;
      }
      if (status !== 'all' && operation.status !== status) return false;
      if (source === 'with-communication' && !operation.communication_number) return false;
      if (source === 'without-communication' && operation.communication_number) return false;
      if (minimum > 0 && (operation.volume_accepted_usd_cents || 0) < minimum) return false;
      const spec = categories[operation.category];
      if (reserves === 'direct' && spec.reserve_effect === 'none') return false;
      if (reserves === 'notional' && !spec.notional) return false;
      if (reserves === 'temporary' && !spec.temporary) return false;
      return true;
    });
    page = 0;
    renderCards();
    renderTable();
  }

  function renderCards() {
    const sum = (predicate) => filtered
      .filter(predicate)
      .reduce((total, operation) => total + (operation.volume_accepted_usd_cents || 0), 0);

    const executed = (operation) => operation.counts_as_executed;
    const sold = sum((o) => executed(o) && o.category === 'spot_sale');
    const bought = sum((o) => executed(o) && ['spot_purchase', 'forward_purchase'].includes(o.category));
    const temporary = sum((o) => executed(o) && categories[o.category].temporary);
    const notional = sum((o) => executed(o) && categories[o.category].notional);
    const announced = filtered.filter((o) => !o.counts_as_executed).length;

    const card = (label, value, meta) => `<div class="card">
      <p class="card__label">${BFX.escapeHtml(label)}</p>
      <div class="card__value card__value--sm">${value}</div>
      ${meta ? `<p class="card__meta-row" style="margin-top:6px">${BFX.escapeHtml(meta)}</p>` : ''}</div>`;

    document.getElementById('ledger-cards').innerHTML = [
      card('Operações no filtro', BFX.number(filtered.length),
        `${announced} apenas anunciada(s), não contadas como venda`),
      card('Vendido diretamente', CENTS(sold), 'venda à vista com resultado publicado'),
      card('Comprado diretamente', CENTS(bought), 'compra à vista e a termo'),
      card('Operações temporárias', CENTS(temporary), 'venda com recompra, compromissada e empréstimo'),
      card('Valor nocional de swaps', CENTS(notional),
        'não é saída de dólares das reservas'),
      card('Saldo líquido direto', CENTS(bought - sold), 'compras menos vendas diretas')
    ].join('');
  }

  function detailHtml(operation) {
    const spec = categories[operation.category];
    const url = operation.communication_number
      ? `https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Comunicado&numero=${encodeURIComponent(operation.communication_number)}`
      : index.source.landing_page;
    return `
      <dl class="detail-grid">
        <div><dt>Identificador estável</dt><dd>${BFX.escapeHtml(operation.id)}</dd></div>
        <div><dt>Data da operação</dt><dd>${BFX.date(operation.trade_date)}</dd></div>
        <div><dt>Horário do anúncio (São Paulo)</dt><dd>${BFX.stamp(operation.announced_at)}</dd></div>
        <div><dt>Publicação do comunicado (São Paulo)</dt><dd>${BFX.stamp(operation.communication_published_at)}</dd></div>
        <div><dt>Data da liquidação</dt><dd>${BFX.date(operation.settlement_date)}</dd></div>
        <div><dt>Data de recompra / vencimento</dt><dd>${operation.maturity_date ? BFX.date(operation.maturity_date) : '<span class="na">não aplicável</span>'}</dd></div>
        <div><dt>Tipo da intervenção</dt><dd>${BFX.escapeHtml(spec.label)}</dd></div>
        <div><dt>Procedimento operacional</dt><dd>${BFX.escapeHtml(operation.operational_procedure)}</dd></div>
        <div><dt>Instrumento</dt><dd>${BFX.escapeHtml(operation.instrument)}</dd></div>
        <div><dt>Modalidade</dt><dd>${BFX.escapeHtml(operation.modality)}</dd></div>
        <div><dt>Tipo composto</dt><dd>${operation.composite_type ? BFX.escapeHtml(operation.composite_type) : '<span class="na">não aplicável</span>'}</dd></div>
        <div><dt>Valor anunciado</dt><dd>${operation.volume_offered_usd_cents === null ? '<span class="na">não divulgado</span>' : CENTS(operation.volume_offered_usd_cents)}</dd></div>
        <div><dt>Valor ofertado</dt><dd>${operation.volume_offered_usd_cents === null ? '<span class="na">não divulgado</span>' : CENTS(operation.volume_offered_usd_cents)}</dd></div>
        <div><dt>Valor efetivamente negociado</dt><dd>${operation.volume_accepted_usd_cents === null ? '<span class="na">não divulgado</span>' : CENTS(operation.volume_accepted_usd_cents)}</dd></div>
        <div><dt>Moeda utilizada</dt><dd>USD</dd></div>
        <div><dt>Classe de ativo</dt><dd>${BFX.escapeHtml(assetClass(operation))}</dd></div>
        <div><dt>Taxa de câmbio da operação (taxa de corte)</dt><dd>${operation.cut_rate === null ? '<span class="na">não divulgada</span>' : BFX.number(operation.cut_rate, 6)}</dd></div>
        <div><dt>Status</dt><dd>${BFX.escapeHtml(operation.status.replace(/_/g, ' '))}</dd></div>
        <div><dt>Conta como executada</dt><dd>${operation.counts_as_executed ? 'sim' : 'não'}</dd></div>
        <div><dt>Efeito sobre as reservas</dt><dd>${effectLabel(operation.category)}</dd></div>
        <div><dt>Motivo informado oficialmente</dt><dd><span class="na">não consta no conjunto de dados; ver o comunicado</span></dd></div>
        <div><dt>Número do comunicado</dt><dd>${operation.communication_number ? BFX.escapeHtml(operation.communication_number) : '<span class="na">sem comunicado</span>'}</dd></div>
        <div><dt>Linha publicada de forma idêntica</dt><dd>${operation.published_identically_times} vez(es)${operation.ambiguous_duplicate ? ' — possível duplicidade na fonte' : ''}</dd></div>
      </dl>
      <p class="card__meta-row">${BFX.escapeHtml(spec.explanation)}</p>
      <p style="margin-top:8px"><a href="${url}" target="_blank" rel="noopener noreferrer">Abrir a fonte oficial desta operação</a></p>`;
  }

  function renderTable() {
    const body = document.getElementById('ledger-body');
    const size = Number(BFX.recall('pageSize', 100));
    const start = page * size;
    const view = filtered.slice().reverse().slice(start, start + size);

    document.getElementById('row-count').textContent =
      `${BFX.number(filtered.length)} operação(ões) no filtro.`;

    if (!view.length) {
      body.innerHTML = '<tr><td colspan="12" class="loading">Nenhuma operação atende aos filtros.</td></tr>';
      document.getElementById('pager').textContent = '';
      return;
    }

    body.innerHTML = view.map((operation) => `
      <tr class="expandable" data-id="${BFX.escapeHtml(operation.id)}" tabindex="0">
        <td class="num">${BFX.date(operation.trade_date)}</td>
        <td class="num">${BFX.date(operation.settlement_date)}</td>
        <td>${BFX.escapeHtml(categories[operation.category].short_label)}</td>
        <td>${BFX.escapeHtml(operation.instrument)} / ${BFX.escapeHtml(operation.modality)}</td>
        <td class="right num">${operation.volume_offered_usd_cents === null ? '<span class="na">—</span>' : CENTS(operation.volume_offered_usd_cents)}</td>
        <td class="right num">${operation.volume_offered_usd_cents === null ? '<span class="na">—</span>' : CENTS(operation.volume_offered_usd_cents)}</td>
        <td class="right num">${operation.counts_as_executed ? CENTS(operation.volume_accepted_usd_cents) : '<span class="na">não realizada</span>'}</td>
        <td class="right num">${operation.cut_rate === null ? '<span class="na">—</span>' : BFX.number(operation.cut_rate, 4)}</td>
        <td>USD</td>
        <td>${BFX.escapeHtml(operation.status.replace(/_/g, ' '))}</td>
        <td>${effectLabel(operation.category)}</td>
        <td>${operation.communication_number
          ? `<a href="https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Comunicado&numero=${encodeURIComponent(operation.communication_number)}" target="_blank" rel="noopener noreferrer">${BFX.escapeHtml(operation.communication_number)}</a>`
          : '<span class="na">—</span>'}</td>
      </tr>`).join('');

    body.querySelectorAll('tr.expandable').forEach((row) => {
      const toggle = () => {
        const next = row.nextElementSibling;
        if (next && next.classList.contains('detail-row')) { next.remove(); return; }
        const operation = filtered.find((o) => o.id === row.dataset.id);
        const detail = document.createElement('tr');
        detail.className = 'detail-row';
        detail.innerHTML = `<td colspan="12">${detailHtml(operation)}</td>`;
        row.after(detail);
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
      });
    });

    const pages = Math.ceil(filtered.length / size);
    document.getElementById('pager').innerHTML = pages > 1
      ? `Página ${page + 1} de ${pages} ` +
        `<button class="btn" id="prev-page" ${page === 0 ? 'disabled' : ''}>anterior</button> ` +
        `<button class="btn" id="next-page" ${page + 1 >= pages ? 'disabled' : ''}>próxima</button>`
      : '';
    const prev = document.getElementById('prev-page');
    const next = document.getElementById('next-page');
    if (prev) prev.addEventListener('click', () => { page -= 1; renderTable(); });
    if (next) next.addEventListener('click', () => { page += 1; renderTable(); });
  }

  function exportColumns() {
    return [
      { label: 'id', value: 'id' },
      { label: 'data_operacao', value: 'trade_date' },
      { label: 'data_liquidacao', value: 'settlement_date' },
      { label: 'data_vencimento', value: 'maturity_date' },
      { label: 'tipo', value: (row) => categories[row.category].label },
      { label: 'instrumento', value: 'instrument' },
      { label: 'modalidade', value: 'modality' },
      { label: 'tipo_composto', value: 'composite_type' },
      { label: 'moeda', value: () => 'USD' },
      { label: 'classe_ativo', value: (row) => assetClass(row) },
      { label: 'ofertado_usd', value: (row) => (row.volume_offered_usd_cents === null ? '' : row.volume_offered_usd_cents / 100) },
      { label: 'negociado_usd', value: (row) => (row.volume_accepted_usd_cents === null ? '' : row.volume_accepted_usd_cents / 100) },
      { label: 'taxa_de_corte', value: 'cut_rate' },
      { label: 'status', value: 'status' },
      { label: 'conta_como_executada', value: (row) => (row.counts_as_executed ? 'sim' : 'nao') },
      { label: 'efeito_reservas', value: (row) => categories[row.category].reserve_effect },
      { label: 'valor_nocional', value: (row) => (categories[row.category].notional ? 'sim' : 'nao') },
      { label: 'comunicado', value: 'communication_number' },
      { label: 'possivel_duplicidade', value: (row) => (row.ambiguous_duplicate ? 'sim' : 'nao') }
    ];
  }

  async function init() {
    index = await BFX.load('data/interventions/index.json');
    categories = index.categories;
    coverageNotice();
    fillSelectors();

    const query = new URLSearchParams(window.location.search);
    const requested = query.get('date');
    if (requested) {
      document.getElementById('year-select').value = requested.slice(0, 4);
      document.getElementById('from-date').value = requested;
      document.getElementById('to-date').value = requested;
    }

    operations = await loadYear(document.getElementById('year-select').value);

    document.getElementById('year-select').addEventListener('change', async (event) => {
      operations = await loadYear(event.target.value);
      applyFilters();
    });
    ['from-date', 'to-date', 'filter-category', 'filter-currency', 'filter-asset',
      'filter-status', 'filter-source', 'min-value', 'filter-reserves'].forEach((id) => {
      document.getElementById(id).addEventListener('change', applyFilters);
    });

    document.getElementById('export-csv').addEventListener('click', () => {
      BFX.exportCsv('movimentacoes-bcb.csv', filtered, exportColumns());
    });
    document.getElementById('export-json').addEventListener('click', () => {
      BFX.exportJson('movimentacoes-bcb.json', {
        unit: 'USD cents',
        source: index.source,
        known_limitations: index.known_limitations,
        categories,
        operations: filtered
      });
    });

    applyFilters();
  }

  return { init };
})();
