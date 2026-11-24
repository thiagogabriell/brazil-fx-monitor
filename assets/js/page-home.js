/* Painel simples: quanto tem, quanto saiu em cada dia, dólar ao vivo.
 *
 * Três relógios diferentes, porque o Banco Central publica em ritmos
 * diferentes, e a página não finge que são um só:
 *   dólar            -> tempo real, fonte secundária, atualiza sozinho
 *   saldo e variação -> diário, um dia útil de atraso
 *   venda do BC      -> mensal, portanto algumas semanas de atraso
 */
'use strict';

window.PAGE = (() => {
  let summary, statement, days = [], visible = 30;

  const cents = (value) => BFX.usdCents(value);

  function conceptNote() {
    return summary.reserves.cash ? 'conceito caixa' : '';
  }

  /** The day the money actually left, as far as the official source goes. */
  function lastConfirmedSale() {
    for (let index = days.length - 1; index >= 0; index -= 1) {
      if (days[index].direct_sold_usd_cents > 0) return days[index];
    }
    return null;
  }

  function renderHeadline() {
    const reserves = summary.reserves.cash;
    const interventions = summary.interventions;
    const latest = days[days.length - 1];
    const sale = lastConfirmedSale();
    const window30 = interventions.windows['30'];
    const trend = BFX.trend(latest ? latest.variation_usd : null);

    document.getElementById('headline').innerHTML = `
      <div class="box box--wide">
        <p class="label">O que o Brasil tem de reservas</p>
        <div class="big">${BFX.usd(reserves.current_usd)}</div>
        <p class="sub">
          Saldo de <strong>${BFX.date(reserves.reference_date, { withWeekday: true })}</strong>,
          o mais recente publicado pelo Banco Central (${conceptNote()}).
          Equivale a ${BFX.number(reserves.current_usd / 1e9, 1)} bilhões de dólares.
        </p>
      </div>

      <div class="box">
        <p class="label">Quanto mudou no último dia</p>
        <div class="mid ${trend.cls}">
          ${latest ? BFX.usd(latest.variation_usd, { sign: true }) : BFX.naText()}
        </div>
        <p class="sub">
          ${latest ? BFX.pct(latest.variation_pct) : ''} entre
          ${latest ? BFX.date(latest.opening_date) : '—'} e
          ${latest ? BFX.date(latest.date) : '—'}.
          Variação do saldo, que inclui rendimento e variação cambial, não só venda.
        </p>
      </div>

      <div class="box">
        <p class="label">Última venda de dólares confirmada</p>
        <div class="mid neg">${sale ? cents(sale.direct_sold_usd_cents) : BFX.naText()}</div>
        <p class="sub">
          ${sale
            ? `Liquidada em <strong>${BFX.date(sale.date)}</strong>, há
               ${BFX.number(BFX.daysBetween(sale.date, BFX.todaySaoPaulo()))} dias.`
            : 'Nenhuma venda direta no período carregado.'}
        </p>
      </div>

      <div class="box">
        <p class="label">Vendido nos 30 dias cobertos pela fonte</p>
        <div class="mid">${cents(window30.sold_usd_cents)}</div>
        <p class="sub">
          Janela de ${BFX.date(window30.from_date)} a ${BFX.date(window30.to_date)},
          com ${BFX.number(window30.days_with_direct_sale)} dia(s) de venda.
        </p>
      </div>`;
  }

  function renderLag() {
    const anchors = summary.anchors;
    const lag = BFX.daysBetween(anchors.interventions, BFX.todaySaoPaulo());
    document.getElementById('lag').innerHTML = `
      <strong>Por que a venda do dia de hoje não aparece.</strong>
      O Banco Central publica o saldo das reservas todo dia útil, mas publica as
      operações de câmbio <strong>uma vez por mês</strong>. Hoje a lista de
      operações vai até ${BFX.date(anchors.interventions)}, ou seja ${lag} dias
      atrás. Os dias mais recentes mostram a variação do saldo, que é dado
      diário, e a coluna de venda fica como <em>ainda não publicado</em> até o
      Banco Central divulgar. A cotação do dólar no topo é a única informação em
      tempo real desta página.`;
  }

  function renderTable() {
    const rows = days.slice(-visible).reverse();
    document.getElementById('rows').innerHTML = rows.map((day) => {
      const trend = BFX.trend(day.variation_usd);
      const pending = day.interventions_coverage !== 'covered';
      return `<tr>
        <td>${BFX.date(day.date, { withWeekday: true })}</td>
        <td>${BFX.usd(day.closing_usd)}</td>
        <td class="${trend.cls}">${BFX.usd(day.variation_usd, { sign: true })}</td>
        <td class="${trend.cls}">${BFX.pct(day.variation_pct)}</td>
        <td class="${pending ? 'pending' : day.direct_sold_usd_cents ? 'neg' : 'neutral'}">
          ${pending
            ? 'ainda não publicado'
            : day.direct_sold_usd_cents
              ? cents(day.direct_sold_usd_cents)
              : '—'}
        </td>
        <td class="${pending ? 'pending' : day.temporary_out_usd_cents ? '' : 'neutral'}">
          ${pending
            ? '—'
            : day.temporary_out_usd_cents
              ? cents(day.temporary_out_usd_cents)
              : '—'}
        </td>
      </tr>`;
    }).join('');

    document.getElementById('row-count').textContent =
      `${BFX.number(rows.length)} dias, do mais recente para o mais antigo.`;
    document.querySelectorAll('[data-days]').forEach((button) => {
      button.classList.toggle('btn--active', Number(button.dataset.days) === visible);
    });
  }

  function paintQuote(quote) {
    const element = document.getElementById('usd');
    if (!quote || !quote.ok) {
      element.innerHTML = '<span class="na">dólar ao vivo indisponível</span>';
      return;
    }
    const trend = BFX.trend(quote.changePct, { invert: true });
    element.innerHTML =
      `Dólar <strong>${BFX.escapeHtml(BFX.brl(quote.bid, 4))}</strong> ` +
      `<span class="${trend.cls}">${BFX.escapeHtml(BFX.pct(quote.changePct))}</span> ` +
      `<span style="color:var(--text-dim)">· ao vivo, fonte de mercado</span>`;
  }

  async function reload() {
    [summary, statement] = await Promise.all([
      BFX.reload('data/indicators/summary.json'),
      BFX.reload('data/reserves/statement-latest-cash.json')
    ]);
    days = statement.days;
    renderHeadline();
    renderLag();
    renderTable();
    document.getElementById('checked').textContent =
      'dados conferidos às ' + new Date().toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
      });
  }

  async function init() {
    await reload();

    document.getElementById('day-buttons').addEventListener('click', (event) => {
      const button = event.target.closest('[data-days]');
      if (!button) return;
      visible = Number(button.dataset.days);
      BFX.store('homeDays', visible);
      renderTable();
    });
    const stored = Number(BFX.recall('homeDays', 30));
    if ([7, 30, 90, 540].includes(stored)) visible = stored;
    renderTable();

    document.getElementById('export').addEventListener('click', () => {
      BFX.exportCsv('reservas-por-dia.csv', days.slice().reverse(), [
        { label: 'data', value: 'date' },
        { label: 'saldo_usd', value: 'closing_usd' },
        { label: 'variacao_usd', value: 'variation_usd' },
        { label: 'variacao_pct', value: 'variation_pct' },
        { label: 'vendido_pelo_bc_usd',
          value: (row) => (row.interventions_coverage === 'covered'
            ? row.direct_sold_usd_cents / 100 : '') },
        { label: 'operacoes_temporarias_usd',
          value: (row) => (row.interventions_coverage === 'covered'
            ? row.temporary_out_usd_cents / 100 : '') },
        { label: 'venda_publicada', value: (row) =>
          (row.interventions_coverage === 'covered' ? 'sim' : 'ainda nao') }
      ]);
    });

    window.addEventListener('bfx:quote', (event) => paintQuote(event.detail));
    if (BFX.lastQuote()) paintQuote(BFX.lastQuote());

    // Os arquivos de dados mudam quando a rotina publica algo novo; reconsultar
    // de tempos em tempos deixa a página viva sem recarregar nada à toa.
    setInterval(() => { reload().catch(() => {}); }, 10 * 60 * 1000);
  }

  return { init };
})();
