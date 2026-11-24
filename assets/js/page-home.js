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
  let summary, statement, spending, days = [], visible = 30;

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

  /** Every day with a definitive sale, over the whole series, not a window. */
  function spendingDays() {
    return spending.days.map((day) => ({
      date: day.date,
      direct_sold_usd_cents: day.sold_usd_cents,
      temporary_out_usd_cents: day.temporary_out_usd_cents,
      opening_date: day.opening_date,
      opening_usd: day.opening_usd,
      closing_usd: day.closing_usd,
      variation_usd: day.variation_usd,
      variation_pct: day.variation_pct,
      interventions_coverage: 'covered'
    }));
  }

  function totalSold(fromDate) {
    return spending.days
      .filter((day) => !fromDate || day.date >= fromDate)
      .reduce((total, day) => total + day.sold_usd_cents, 0);
  }

  function countSold(fromDate) {
    return spending.days.filter((day) => !fromDate || day.date >= fromDate).length;
  }

  function renderHeadline() {
    const reserves = summary.reserves.cash;
    const all = spending.days;
    const last = all[all.length - 1] || null;
    const anchor = summary.interventions.anchor_date;
    const yearStart = anchor.slice(0, 4) + '-01-01';
    const twelveMonths = new Date(Date.parse(anchor) - 365 * 86400000)
      .toISOString().slice(0, 10);

    document.getElementById('headline').innerHTML = `
      <div class="box box--wide">
        <p class="label">Quanto o governo gastou das reservas no último dia de gasto</p>
        <div class="big neg">${last ? cents(last.sold_usd_cents) : 'US$ 0'}</div>
        <p class="sub">
          ${last
            ? `Foi em <strong>${BFX.date(last.date, { withWeekday: true })}</strong>,
               há ${BFX.number(BFX.daysBetween(last.date, BFX.todaySaoPaulo()))} dias.
               Em todos os dias úteis desde então o gasto publicado foi zero.`
            : 'Nenhum dia de gasto no período carregado.'}
        </p>
      </div>

      <div class="box">
        <p class="label">Gasto em 12 meses</p>
        <div class="mid neg">${cents(totalSold(twelveMonths))}</div>
        <p class="sub">
          Em ${BFX.number(countSold(twelveMonths))} dia(s) de gasto.
          Nos demais dias úteis, zero.
        </p>
      </div>

      <div class="box">
        <p class="label">Gasto em ${anchor.slice(0, 4)}</p>
        <div class="mid neg">${cents(totalSold(yearStart))}</div>
        <p class="sub">
          Em ${BFX.number(countSold(yearStart))} dia(s) de gasto no ano.
          Desde ${BFX.date(spending.first_date)} o total gasto foi
          ${cents(spending.total_usd_cents)}, em
          ${BFX.number(spending.day_count)} dias.
        </p>
      </div>

      <div class="box">
        <p class="label">Quanto ainda tem</p>
        <div class="mid">${BFX.usd(reserves.current_usd)}</div>
        <p class="sub">
          Saldo de ${BFX.date(reserves.reference_date)}.
          Em 12 meses a reserva
          ${reserves.changes['365'].change_pct >= 0 ? 'subiu' : 'caiu'}
          ${BFX.usd(Math.abs(reserves.changes['365'].change))}
          (${BFX.pct(reserves.changes['365'].change_pct)}), porque rende juros.
        </p>
      </div>`;
  }

  function renderLag() {
    const anchor = summary.anchors.interventions;
    const lag = BFX.daysBetween(anchor, BFX.todaySaoPaulo());
    document.getElementById('lag').innerHTML = `
      <strong>Gasto é venda definitiva de dólares.</strong>
      O saldo das reservas sobe e desce todo dia por rendimento dos
      investimentos e por variação entre as moedas guardadas. Isso não é o
      governo gastando. Gasto é o Banco Central vender dólar de vez, e isso
      acontece em dias contados.
      O Banco Central publica essas vendas <strong>uma vez por mês</strong>:
      hoje a lista vai até ${BFX.date(anchor)}, ou seja ${lag} dias atrás.
      Depois dessa data ainda não dá para saber, e estimar seria inventar.`;
  }

  function renderTable() {
    const onlySpending = document.getElementById('only-spending').checked;
    const source = onlySpending ? spendingDays() : days.slice(-visible);
    const rows = source.slice().reverse();

    document.getElementById('rows').innerHTML = rows.length
      ? rows.map((day) => {
          const pending = day.interventions_coverage !== 'covered';
          const trend = BFX.trend(day.variation_usd);
          return `<tr>
            <td>${BFX.date(day.date, { withWeekday: true })}</td>
            <td class="${day.direct_sold_usd_cents ? 'neg' : 'neutral'}"
                style="font-size:15px">
              ${pending
                ? '<span class="pending">ainda não publicado</span>'
                : day.direct_sold_usd_cents
                  ? cents(day.direct_sold_usd_cents)
                  : 'US$ 0'}
            </td>
            <td>${BFX.usd(day.closing_usd)}</td>
            <td class="${trend.cls}">${BFX.usd(day.variation_usd, { sign: true })}</td>
            <td class="${pending ? 'pending' : day.temporary_out_usd_cents ? '' : 'neutral'}">
              ${pending ? '—' : day.temporary_out_usd_cents
                ? cents(day.temporary_out_usd_cents) : '—'}
            </td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="5" class="pending">Nenhum dia de gasto no período.</td></tr>';

    document.getElementById('row-count').textContent = onlySpending
      ? `${BFX.number(rows.length)} dia(s) de gasto desde ${BFX.date(spending.first_date)}, toda a série.`
      : `${BFX.number(rows.length)} dias, do mais recente para o mais antigo.`;

    document.getElementById('day-buttons').hidden = onlySpending;
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
    [summary, statement, spending] = await Promise.all([
      BFX.reload('data/indicators/summary.json'),
      BFX.reload('data/reserves/statement-latest-cash.json'),
      BFX.reload('data/indicators/spending-days.json')
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

    const onlySpending = document.getElementById('only-spending');
    onlySpending.checked = BFX.recall('onlySpending', true);
    onlySpending.addEventListener('change', () => {
      BFX.store('onlySpending', onlySpending.checked);
      renderTable();
    });
    renderTable();

    document.getElementById('export').addEventListener('click', () => {
      const onlySpending = document.getElementById('only-spending').checked;
      const data = (onlySpending ? spendingDays() : days).slice().reverse();
      BFX.exportCsv('gasto-das-reservas-por-dia.csv', data, [
        { label: 'data', value: 'date' },
        { label: 'gasto_venda_de_dolares_usd',
          value: (row) => (row.interventions_coverage === 'covered'
            ? row.direct_sold_usd_cents / 100 : '') },
        { label: 'saldo_usd', value: 'closing_usd' },
        { label: 'variacao_do_saldo_usd', value: 'variation_usd' },
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
