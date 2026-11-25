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
  let summary, statement, spending, recent, days = [], visible = 30;
  // Operações que o navegador descobriu falando com o Banco Central agora,
  // além do que a automação já tinha gravado no repositório.
  let live = { days: [], scheduled: [], auctions: [], reserves: null, ptax: null, at: null };

  const cents = (value) => BFX.usdCents(value);

  const plural = (count, one, many) =>
    `${BFX.number(count)} ${count === 1 ? one : many}`;

  /** "hoje", "ontem" ou "há N dias", nunca um número negativo. */
  function whenPhrase(date) {
    const days = BFX.daysBetween(date, BFX.todaySaoPaulo());
    if (days <= 0) return 'hoje';
    if (days === 1) return 'ontem';
    return `há ${BFX.number(days)} dias`;
  }

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
    const known = new Set(spending.days.map((day) => day.date));
    const extra = live.days
      // Só dias com venda definitiva entram aqui. Uma operação temporária tem
      // sold = 0 e criava uma linha fantasma de "gasto US$ 0", na data de
      // liquidação dela, que às vezes é no futuro.
      .filter((day) => day.sold > 0 && !known.has(day.date))
      .map((day) => ({
        date: day.date,
        direct_sold_usd_cents: day.sold,
        temporary_out_usd_cents: day.temporary,
        opening_date: null, opening_usd: null,
        closing_usd: null, variation_usd: null, variation_pct: null,
        interventions_coverage: 'covered',
        source: 'ao_vivo',
        provisional: true,
        live: true,
        communications: day.communications
      }));
    return spending.days.map((day) => ({
      date: day.date,
      direct_sold_usd_cents: day.sold_usd_cents,
      temporary_out_usd_cents: day.temporary_out_usd_cents,
      opening_date: day.opening_date,
      opening_usd: day.opening_usd,
      closing_usd: day.closing_usd,
      variation_usd: day.variation_usd,
      variation_pct: day.variation_pct,
      interventions_coverage: 'covered',
      source: day.source,
      provisional: day.provisional,
      communications: day.communications || []
    })).concat(extra).sort((a, b) => a.date.localeCompare(b.date));
  }

  function totalSold(fromDate) {
    return spendingDays()
      .filter((day) => !fromDate || day.date >= fromDate)
      .reduce((total, day) => total + day.direct_sold_usd_cents, 0);
  }

  function countSold(fromDate) {
    return spendingDays().filter((day) => !fromDate || day.date >= fromDate).length;
  }

  function renderHeadline() {
    const reserves = summary.reserves.cash;
    const all = spendingDays();
    const last = all[all.length - 1] || null;
    const anchor = summary.interventions.anchor_date;
    const yearStart = anchor.slice(0, 4) + '-01-01';
    // A janela tem de terminar hoje. Ancorar na data da fonte mensal fazia
    // "12 meses" virar 13 meses e inflar o total.
    const twelveMonths = new Date(Date.parse(BFX.todaySaoPaulo()) - 365 * 86400000)
      .toISOString().slice(0, 10);

    document.getElementById('headline').innerHTML = `
      <div class="box box--wide">
        <p class="label">Quanto o governo gastou das reservas no último dia de gasto</p>
        <div class="big neg">${last ? cents(last.direct_sold_usd_cents) : 'US$ 0'}</div>
        <p class="sub">
          ${last
            ? `Foi em <strong>${BFX.date(last.date, { withWeekday: true })}</strong>, `
              + `${whenPhrase(last.date)}.`
              + (last.live
                ? ' Encontrado agora, consultando o Banco Central direto do seu navegador.'
                : last.provisional
                  ? ' Vem do comunicado que o Banco Central publicou no dia do leilão.'
                  : '')
              + ' Em todos os dias úteis desde então o gasto publicado foi zero.'
            : 'Nenhum dia de gasto no período carregado.'}
        </p>
      </div>

      <div class="box">
        <p class="label">Gasto em 12 meses</p>
        <div class="mid neg">${cents(totalSold(twelveMonths))}</div>
        <p class="sub">
          Em ${plural(countSold(twelveMonths), 'dia de gasto', 'dias de gasto')}.
          Nos demais dias úteis, zero.
        </p>
      </div>

      <div class="box">
        <p class="label">Gasto em ${anchor.slice(0, 4)}</p>
        <div class="mid neg">${cents(totalSold(yearStart))}</div>
        <p class="sub">
          Em ${plural(countSold(yearStart), 'dia de gasto', 'dias de gasto')} no ano.
          Desde ${BFX.date(spending.first_date)} o total gasto foi
          ${cents(totalSold(null))}, em ${BFX.number(countSold(null))} dias.
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
    const consolidated = spending.consolidated_until;
    document.getElementById('lag').innerHTML = `
      <strong>Gasto é venda definitiva de dólares.</strong>
      O saldo das reservas sobe e desce todo dia por rendimento dos
      investimentos e por variação entre as moedas guardadas. Isso não é o
      governo gastando. Gasto é o Banco Central vender dólar de vez, e isso
      acontece em dias contados.
      <br><br>
      <strong>De onde vem cada linha.</strong>
      Até ${BFX.date(consolidated)} os valores vêm do arquivo mensal
      consolidado do Banco Central. Depois dessa data vêm do
      <strong>comunicado que o próprio Banco Central publica no mesmo dia do
      leilão</strong>, marcado aqui como provisório, com link para o documento.
      Os dois batem quando o arquivo mensal alcança a data.`;
  }

  function renderTable() {
    const onlySpending = document.getElementById('only-spending').checked;
    const source = onlySpending ? spendingDays() : days.slice(-visible);
    const rows = source.slice().reverse();

    document.getElementById('rows').innerHTML = rows.length
      ? rows.map((day) => {
          const pending = day.interventions_coverage !== 'covered';
          const trend = BFX.trend(day.variation_usd);
          const link = (day.communications || []).find((c) => c && c.url);
          return `<tr>
            <td>${BFX.date(day.date, { withWeekday: true })}
              ${day.provisional
                ? `<a href="${BFX.escapeHtml(link ? link.url : '#')}" target="_blank"
                     rel="noopener noreferrer" class="badge badge--preliminary"
                     title="Vem do comunicado do dia, ainda não do arquivo mensal">provisório</a>`
                : ''}</td>
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
      ? `${plural(rows.length, 'dia de gasto', 'dias de gasto')} desde ${BFX.date(spending.first_date)}, toda a série`
        + (spending.provisional_count
          ? `, incluindo ${plural(spending.provisional_count, 'provisório', 'provisórios')}.`
          : '.')
      : `${BFX.number(rows.length)} dias, do mais recente para o mais antigo.`;

    document.getElementById('day-buttons').hidden = onlySpending;
    document.querySelectorAll('[data-days]').forEach((button) => {
      button.classList.toggle('btn--active', Number(button.dataset.days) === visible);
    });
  }

  const CATEGORY_LABEL = {
    spot_sale: 'venda definitiva de dólares',
    spot_purchase: 'compra de dólares',
    sale_with_repurchase: 'venda com recompra contratada',
    swap_traditional: 'swap cambial tradicional',
    swap_reverse: 'swap cambial reverso'
  };

  /** Operações recentes que NÃO são gasto, para quem viu a notícia e veio
   *  procurar o número aqui. Elas existem, são do Banco Central, e a página
   *  diz exatamente por que não entram na conta. */
  function renderNotSpending() {
    const container = document.getElementById('not-spending');
    const fromFile = ((recent && recent.auctions) || []).map((a) => ({
      date: a.trade_date, category: a.category,
      cents: a.accepted_usd_cents, url: (a.result || a.announcement || {}).url,
      number: (a.result || a.announcement || {}).communication_number
    }));
    const fromLive = live.auctions.map((a) => ({
      date: a.tradeDate, category: a.category, cents: a.acceptedCents,
      url: (a.result || a.announcement || {}).url,
      number: (a.result || a.announcement || {}).number
    }));
    const seen = new Set(fromFile.map((a) => `${a.date}|${a.category}|${a.cents}`));
    const rows = fromFile
      .concat(fromLive.filter((a) => !seen.has(`${a.date}|${a.category}|${a.cents}`)))
      .filter((a) => a.category !== 'spot_sale' && a.cents && a.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 8);

    if (!rows.length) { container.innerHTML = ''; return; }

    // Swap aparece quase todo dia e em duas pontas. Agrupar por dia evita que
    // oito linhas de swap escondam a operação que a pessoa veio procurar.
    const swaps = new Map();
    const others = [];
    for (const row of rows) {
      if (String(row.category).startsWith('swap')) {
        const bucket = swaps.get(row.date) || { date: row.date, cents: 0, urls: new Set() };
        bucket.cents += row.cents;
        if (row.url) bucket.urls.add(`${row.number}|${row.url}`);
        swaps.set(row.date, bucket);
      } else {
        others.push(row);
      }
    }

    const why = {
      sale_with_repurchase: 'venda com recompra: o Banco Central recebe o dinheiro de volta',
      spot_purchase: 'compra de dólares: entra dinheiro, não sai'
    };

    const lines = others.map((row) => `<li>
        <strong>${BFX.date(row.date)}</strong>: <strong>${cents(row.cents)}</strong> —
        ${BFX.escapeHtml(why[row.category] || 'não é venda definitiva')}
        ${row.url ? ` · <a href="${BFX.escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">comunicado ${BFX.escapeHtml(String(row.number))}</a>` : ''}
      </li>`).concat([...swaps.values()]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((bucket) => {
          const links = [...bucket.urls].slice(0, 2).map((item) => {
            const [number, url] = item.split('|');
            return `<a href="${BFX.escapeHtml(url)}" target="_blank" rel="noopener noreferrer">comunicado ${BFX.escapeHtml(number)}</a>`;
          }).join(' · ');
          return `<li>
            <strong>${BFX.date(bucket.date)}</strong>: <strong>${cents(bucket.cents)}</strong> em
            swap cambial — contrato liquidado em reais, não sai dólar da reserva
            ${links ? ' · ' + links : ''}
          </li>`;
        }))
      .sort((a, b) => b.localeCompare(a));

    container.innerHTML = `
      <div class="lag" style="border-left-color:var(--notional)">
        <strong>Operações recentes que não são gasto.</strong>
        Se você viu uma notícia com um valor que não aparece acima, provavelmente
        é uma destas. São reais e são do Banco Central, mas nenhuma retira
        dólares das reservas de forma definitiva.
        <ul class="plain" style="margin-top:8px">${lines.slice(0, 7).join('')}</ul>
      </div>`;
  }

  function renderScheduled() {
    const fromFile = (recent && recent.scheduled) || [];
    const known = new Set(fromFile.map((item) => item.communication_number));
    const rows = fromFile
      .map((item) => ({
        date: item.auction_date,
        category: item.category,
        ceiling: item.ceiling_usd_cents,
        settlement: item.settlement_date,
        number: item.communication_number,
        url: item.url,
        subject: item.subject,
        live: false
      }))
      .concat(live.scheduled
        .filter((item) => !known.has(item.number))
        .map((item) => ({
          date: item.auctionDate, category: item.category,
          ceiling: item.ceilingCents, settlement: item.settlementDate,
          number: item.number, url: item.url, subject: item.subject, live: true
        })))
      .filter((item) => item.date >= BFX.todaySaoPaulo())
      .sort((a, b) => a.date.localeCompare(b.date));

    const container = document.getElementById('scheduled');
    if (!rows.length) { container.innerHTML = ''; return; }

    container.innerHTML = `
      <div class="lag" style="border-left-color:var(--info)">
        <strong>Anunciado pelo Banco Central, ainda não realizado.</strong>
        O valor abaixo é o <strong>teto anunciado</strong>, não o que foi
        efetivamente negociado. O resultado sai no dia do leilão e só então
        entra nas contas desta página.
        <ul class="plain" style="margin-top:8px">
          ${rows.map((item) => `<li>
            <strong>${BFX.date(item.date, { withWeekday: true })}</strong>:
            ${BFX.escapeHtml(CATEGORY_LABEL[item.category] || 'operação de câmbio')},
            até <strong>${item.ceiling === null || item.ceiling === undefined
              ? 'valor não informado em dólares'
              : cents(item.ceiling)}</strong>
            ${item.settlement ? `, liquidação em ${BFX.date(item.settlement)}` : ''}
            ${item.category === 'sale_with_repurchase'
              ? ' <em>(o Banco Central vende e recompra depois, então não é gasto permanente)</em>'
              : ''}
            ${item.category && item.category.startsWith('swap')
              ? ' <em>(valor nocional, não sai dólar das reservas)</em>'
              : ''}
            · <a href="${BFX.escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">comunicado ${BFX.escapeHtml(String(item.number))}</a>
            ${item.live ? '<span class="badge badge--preliminary">ao vivo</span>' : ''}
          </li>`).join('')}
        </ul>
      </div>`;
  }

  async function runRefresh(button) {
    const status = document.getElementById('checked');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Consultando o BC…';
    status.textContent = '';
    try {
      const result = await BFXLive.refresh({
        lastCommunication: live.lastProbed
          || (recent && recent.last_communication_number)
          || null,
        onProgress: (n) => { button.textContent = `Consultando o BC… (${n})`; }
      });

      live.lastProbed = result.lastProbed;
      live.at = new Date();

      // Apenas vendas definitivas entram como gasto; o resto fica à vista mas
      // separado, exatamente como no resto da aplicação.
      const byDate = new Map();
      for (const auction of result.auctions) {
        const date = auction.settlementDate || auction.tradeDate;
        if (!date) continue;
        if (!byDate.has(date)) {
          byDate.set(date, { date, sold: 0, temporary: 0, communications: [] });
        }
        const bucket = byDate.get(date);
        if (auction.category === 'spot_sale') bucket.sold += auction.acceptedCents || 0;
        else if (auction.category === 'sale_with_repurchase') {
          bucket.temporary += auction.acceptedCents || 0;
        } else continue;
        for (const leg of [auction.result, auction.announcement]) {
          if (leg) bucket.communications.push({ url: leg.url, number: leg.number });
        }
      }
      live.days = [...byDate.values()].filter((day) => day.sold > 0 || day.temporary > 0);
      live.scheduled = result.scheduled;
      live.auctions = result.auctions;

      // Saldo das reservas mais recente, direto do SGS.
      const newest = result.reserves[result.reserves.length - 1];
      const block = summary.reserves.cash;
      if (newest && block && newest.date > block.reference_date) {
        block.current_usd = newest.valueUsd;
        block.reference_date = newest.date;
        // A variação de 12 meses precisa ser refeita com o saldo novo, senão
        // a tela mistura saldo de hoje com variação de ontem.
        const base = block.changes && block.changes['365'];
        if (base && base.from_value) {
          base.change = newest.valueUsd - base.from_value;
          base.change_pct = ((newest.valueUsd - base.from_value) / base.from_value) * 100;
        }
      }
      // Dias de gasto recentes podem ter ficado sem saldo quando o arquivo foi
      // gerado; o SGS já tem.
      const balances = new Map(result.reserves.map((row) => [row.date, row.valueUsd]));
      for (const day of spending.days) {
        if (day.closing_usd === null && balances.has(day.date)) {
          day.closing_usd = balances.get(day.date);
        }
      }

      renderHeadline();
      renderScheduled();
      renderNotSpending();
      renderTable();

      const found = live.days.reduce((total, day) => total + day.sold, 0);
      status.innerHTML = result.ok
        ? `Banco Central consultado às ${live.at.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
          + (found
            ? ` · <strong class="neg">${BFX.escapeHtml(cents(found))} de venda nova encontrada</strong>`
            : ' · nada de novo além do que já estava na tela')
        : `<span class="na">consulta parcial: ${BFX.escapeHtml(result.errors.join('; '))}</span>`;
    } catch (error) {
      status.innerHTML = `<span class="na">não foi possível consultar o Banco Central agora: ${BFX.escapeHtml(error.message)}</span>`;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
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
    [summary, statement, spending, recent] = await Promise.all([
      BFX.reload('data/indicators/summary.json'),
      BFX.reload('data/reserves/statement-latest-cash.json'),
      BFX.reload('data/indicators/spending-days.json'),
      BFX.reload('data/interventions/recent-auctions.json', { optional: true })
    ]);
    days = statement.days;
    renderHeadline();
    renderScheduled();
    renderNotSpending();
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

    const refresh = document.getElementById('refresh');
    refresh.addEventListener('click', () => runRefresh(refresh));
    // Uma consulta automática ao abrir, para a tela já nascer em dia.
    runRefresh(refresh);

    window.addEventListener('bfx:quote', (event) => paintQuote(event.detail));
    if (BFX.lastQuote()) paintQuote(BFX.lastQuote());

    // Os arquivos de dados mudam quando a rotina publica algo novo; reconsultar
    // de tempos em tempos deixa a página viva sem recarregar nada à toa.
    setInterval(() => { reload().catch(() => {}); }, 10 * 60 * 1000);
  }

  return { init };
})();
