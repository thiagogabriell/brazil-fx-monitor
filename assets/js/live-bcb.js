/* Consulta ao vivo ao Banco Central, direto do navegador.
 *
 * Os três endpoints usados aqui liberam CORS para a origem deste site, o que
 * permite checar o Banco Central no momento em que a pessoa clica, sem esperar
 * a próxima rodada da automação.
 *
 * A automação em Python continua sendo a fonte dos arquivos do repositório.
 * O que esta consulta traz é sempre marcado como "ao vivo" e segue as mesmas
 * regras: anúncio não é operação realizada, swap é nocional, venda conjugada
 * com compra é temporária, e nada que não dê para ler vira número.
 */
'use strict';

const BFXLive = (() => {
  const COMMUNICATION =
    'https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas' +
    '?p1=COMUNICADO&p2=';
  const SGS = (code, count) =>
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados/ultimos/${count}?formato=json`;

  const LOOKAHEAD = 10;   // quantos números vagos antes de desistir
  const MAX_PROBES = 30;  // teto de requisições por clique

  const MONTHS = {
    janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4, maio: 5,
    junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10,
    novembro: 11, dezembro: 12
  };

  const NATURE = [
    [/venda\s+conjugad[oa]s?/i, 'sale_with_repurchase'],
    [/compra\s+conjugad[oa]s?/i, 'sale_with_repurchase'],
    [/venda\s+com\s+compromisso/i, 'sale_with_repurchase'],
    [/venda\s+[àa]\s*vista/i, 'spot_sale'],
    [/compra\s+[àa]\s*vista/i, 'spot_purchase'],
    [/swap\s+cambial\s+reverso/i, 'swap_reverse'],
    [/swap\s+cambial\s+tradicional/i, 'swap_traditional']
  ];

  const RE = {
    fx: /Leil[aã]o de C[aâ]mbio\s+(\d+)\s*\/\s*(\d{4})/gi,
    swap: /Leil[aã]o de Swap(?:\s+Cambial)?\s+(\d+)\s*\/\s*(\d{4})/gi,
    natureField: /Natureza:\s*([^:]+?)(?=\s+(?:Posi[cç][aã]o|Per[ií]odo|Quantidade|Lote|Montante|Volume|Taxa|Data)\b)/i,
    // Aceita "USD $2.000.000.000,00" e "USD $0", que e como o BCB escreve
    // um leilao em que nenhuma proposta foi aceita.
    amount: /valor total de\s*USD\s*\$?\s*([\d.]+(?:,\d{2})?)/i,
    swapAmount: /\(\s*USD\s*\$?\s*([\d.]+(?:,\d{2})?)\s*\)/i,
    cut: /taxa de corte do leil[aã]o\s+\d+\s*\/\s*\d{4}\s+foi de\s*([\d.,]+)/i,
    settlement: /Data de Liquida[cç][aã]o(?:\s+da Opera[cç][aã]o de Venda)?:\s*(\d{2}\/\d{2}\/\d{4})/i,
    repurchase: /Data de Liquida[cç][aã]o da Opera[cç][aã]o de (?:Recompra|Compra):\s*(\d{2}\/\d{2}\/\d{4})/i,
    swapMaturity: /com vencimento em\s*(\d{2}\/\d{2}\/\d{4})/i,
    scheduledDate: /leil[oõ]es?\s+(?:ser[aã]o|ser[aá])\s+realizados?\s+no dia\s+(\d{1,2})\s+de\s+(\S+)\s+de\s+(\d{4})/i,
    ceiling: /aceitos?\s+no m[aá]ximo\s+(?:at[eé]\s+)?US\$\s*([\d.,]+)\s*(bilh|milh)/i,
    scheduledSettlement: /liquidad[ao]s?\s+no dia\s+(\d{1,2})\s+de\s+(\S+)\s+de\s+(\d{4})/i
  };

  const strip = (value) => {
    const element = document.createElement('div');
    element.innerHTML = String(value || '').replace(/<[^>]+>/g, ' ');
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const isoFromBr = (value) => {
    if (!value) return null;
    const [day, month, year] = value.split('/');
    return `${year}-${month}-${day}`;
  };

  const isoFromLong = (day, month, year) => {
    const number = MONTHS[String(month).toLowerCase()];
    if (!number) return null;
    return `${year}-${String(number).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const cents = (raw) => {
    if (!raw) return null;
    const value = Number(raw.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  };

  const natureOf = (text) => {
    const field = RE.natureField.exec(text);
    const probe = field ? field[1] : text;
    for (const [pattern, category] of NATURE) {
      if (pattern.test(probe)) return { category, nature: field ? field[1].trim() : null };
    }
    return { category: null, nature: field ? field[1].trim() : null };
  };

  async function fetchJson(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function communication(number) {
    // A primeira requisicao de uma rajada ao site do BCB falha de vez em
    // quando, aparentemente por conexao fria. Uma segunda tentativa curta
    // resolve e evita reportar um problema que nao existe.
    let payload;
    try {
      payload = await fetchJson(COMMUNICATION + number);
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      payload = await fetchJson(COMMUNICATION + number);
    }

    const items = (payload && payload.conteudo) || [];
    if (!items.length) return null;
    const item = items[0];
    const stamp = item.DataTexto || '';
    const datePart = stamp.split(' ')[0] || '';
    const parts = datePart.split('/');
    return {
      number,
      publishedAt: stamp,
      date: parts.length === 3
        ? `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`
        : null,
      subject: strip(item.Assunto),
      text: strip(item.Texto),
      url: 'https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo'
        + `?tipo=Comunicado&numero=${number}`
    };
  }

  /** Walks forward from the newest comunicado the repository already knows.
   *
   * A number that does not exist answers HTTP 200 with an empty list, which is
   * a real answer. A request that never reaches the Banco Central is a
   * different thing and is counted apart, so the interface can say "não
   * consegui falar com o BC" instead of "não há nada novo". */
  async function probe(fromNumber, onProgress) {
    const found = [];
    let misses = 0;
    let probes = 0;
    let networkErrors = 0;
    let firstError = null;
    let number = fromNumber;
    while (misses < LOOKAHEAD && probes < MAX_PROBES) {
      number += 1;
      probes += 1;
      if (onProgress) onProgress(probes);
      let item = null;
      try {
        item = await communication(number);
      } catch (error) {
        networkErrors += 1;
        firstError = firstError || error;
        misses += 1;
        continue;
      }
      if (!item) { misses += 1; continue; }
      misses = 0;
      if (/c[âa]mbio|d[óo]lar|swap|moeda estrangeira/i.test(item.subject + ' ' + item.text)) {
        found.push(item);
      }
    }
    if (networkErrors === probes && probes > 0) {
      // O CDN do Banco Central guarda a resposta por 90 segundos sem declarar
      // `Vary: Origin`, então ele às vezes devolve ao navegador o cabeçalho
      // CORS de outra origem e o pedido é recusado. Não é erro desta página
      // nem do Banco Central estar fora do ar, e costuma passar sozinho.
      throw new Error(
        'o navegador não conseguiu ler a resposta do Banco Central agora '
        + '(cache do site do BC devolveu a permissão de outra origem). '
        + 'Os números na tela continuam válidos e a coleta automática não '
        + 'depende disso; tente de novo em um minuto'
      );
    }
    return {
      communications: found,
      lastProbed: number - misses,
      probes,
      networkErrors
    };
  }

  function parseAuctions(items) {
    const auctions = new Map();
    for (const item of items) {
      const text = item.text;
      RE.fx.lastIndex = 0; RE.swap.lastIndex = 0;
      const fxMatches = [...text.matchAll(RE.fx)];
      const swapMatches = [...text.matchAll(RE.swap)];
      const isSwap = swapMatches.length > 0 && fxMatches.length === 0;
      const matches = isSwap ? swapMatches : fxMatches;
      if (!matches.length) continue;

      const opening = text.includes('Aviso de Abertura');
      for (const match of matches) {
        const key = `${isSwap ? 'swap' : 'cambio'}-${match[2]}-${Number(match[1])}`;
        if (!auctions.has(key)) {
          auctions.set(key, {
            auction: `${Number(match[1])}/${match[2]}`,
            kind: isSwap ? 'swap' : 'cambio',
            category: null, nature: null, tradeDate: null,
            settlementDate: null, maturityDate: null,
            acceptedCents: null, cutRate: null,
            announcement: null, result: null, live: true
          });
        }
        const entry = auctions.get(key);
        if (opening) {
          const { category, nature } = natureOf(text);
          entry.category = entry.category || category;
          entry.nature = entry.nature || nature;
          entry.tradeDate = entry.tradeDate || item.date;
          const settlement = RE.settlement.exec(text);
          entry.settlementDate = entry.settlementDate || isoFromBr(settlement && settlement[1]);
          const repurchase = RE.repurchase.exec(text);
          if (repurchase) entry.maturityDate = isoFromBr(repurchase[1]);
          entry.announcement = { number: item.number, url: item.url, publishedAt: item.publishedAt };
        } else if (text.includes('Resultado')) {
          let segment = text;
          for (const part of text.split(/Resultado do Leil[aã]o/)) {
            if (new RegExp(`\\b${Number(match[1])}\\s*/\\s*${match[2]}\\b`).test(part)) {
              segment = part; break;
            }
          }
          const amount = RE.amount.exec(segment) || RE.swapAmount.exec(segment);
          const cut = RE.cut.exec(segment);
          entry.acceptedCents = entry.acceptedCents ?? cents(amount && amount[1]);
          if (cut && entry.cutRate === null) {
            entry.cutRate = Number(cut[1].replace(/\./g, '').replace(',', '.'));
          }
          const maturity = RE.swapMaturity.exec(segment);
          if (maturity && !entry.maturityDate) entry.maturityDate = isoFromBr(maturity[1]);
          entry.result = { number: item.number, url: item.url, publishedAt: item.publishedAt };
          entry.tradeDate = entry.tradeDate || item.date;
        }
      }
    }
    return [...auctions.values()].filter(
      (entry) => entry.category && entry.acceptedCents !== null && entry.tradeDate
    );
  }

  function parseScheduled(items) {
    const scheduled = [];
    for (const item of items) {
      const text = item.text;
      if (text.includes('Aviso de Abertura') || /Resultado do Leil[aã]o/.test(text)) continue;
      const when = RE.scheduledDate.exec(text);
      if (!when) continue;
      const date = isoFromLong(when[1], when[2], when[3]);
      if (!date) continue;
      const { category, nature } = natureOf(item.subject + ' ' + text);
      const ceiling = RE.ceiling.exec(text);
      let ceilingCents = null;
      if (ceiling) {
        const value = Number(ceiling[1].replace(/\./g, '').replace(',', '.'));
        const factor = ceiling[2].toLowerCase() === 'bilh' ? 1e9 : 1e6;
        if (Number.isFinite(value)) ceilingCents = Math.round(value * factor * 100);
      }
      const settlement = RE.scheduledSettlement.exec(text);
      scheduled.push({
        auctionDate: date,
        category,
        nature,
        subject: item.subject,
        ceilingCents,
        settlementDate: settlement ? isoFromLong(settlement[1], settlement[2], settlement[3]) : null,
        number: item.number,
        publishedAt: item.publishedAt,
        url: item.url,
        live: true
      });
    }
    return scheduled;
  }

  async function reserves() {
    const rows = await fetchJson(SGS(13621, 3));
    return rows.map((row) => {
      const [day, month, year] = row.data.split('/');
      return {
        date: `${year}-${month}-${day}`,
        valueUsd: Math.round(Number(row.valor.replace(',', '.')) * 1e6)
      };
    });
  }

  async function ptax() {
    const rows = await fetchJson(SGS(1, 2));
    return rows.map((row) => {
      const [day, month, year] = row.data.split('/');
      return { date: `${year}-${month}-${day}`, value: Number(row.valor.replace(',', '.')) };
    });
  }

  /** One round trip to the Banco Central. Returns what is newer than `since`. */
  async function refresh({ lastCommunication, onProgress }) {
    const result = {
      ok: true, errors: [], auctions: [], scheduled: [],
      reserves: [], ptax: [], probes: 0, lastProbed: lastCommunication
    };

    const [walk, balances, rates] = await Promise.allSettled([
      lastCommunication ? probe(lastCommunication, onProgress) : Promise.resolve(null),
      reserves(),
      ptax()
    ]);

    if (walk.status === 'fulfilled' && walk.value) {
      result.auctions = parseAuctions(walk.value.communications);
      result.scheduled = parseScheduled(walk.value.communications);
      result.probes = walk.value.probes;
      result.lastProbed = walk.value.lastProbed;
      if (walk.value.networkErrors) {
        result.errors.push(
          `${walk.value.networkErrors} de ${walk.value.probes} consultas de `
          + 'comunicado não chegaram ao Banco Central'
        );
      }
    } else if (walk.status === 'rejected') {
      result.errors.push('comunicados: ' + walk.reason.message);
    }
    if (balances.status === 'fulfilled') result.reserves = balances.value;
    else result.errors.push('reservas: ' + balances.reason.message);
    if (rates.status === 'fulfilled') result.ptax = rates.value;
    else result.errors.push('ptax: ' + rates.reason.message);

    result.ok = result.errors.length === 0;
    return result;
  }

  return { refresh, probe, parseAuctions, parseScheduled, reserves, ptax };
})();

window.BFXLive = BFXLive;
