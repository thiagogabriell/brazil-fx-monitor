#!/usr/bin/env python3
"""Collect the Banco Central's FX auction results on the day they are published.

Why this exists
---------------
The open-data CSV of "atuacoes no mercado de cambio" is refreshed once a month,
so it lags by three to eight weeks. The Banco Central, however, publishes every
single auction the same day as a numbered Comunicado, and the site exposes them
through a public JSON endpoint:

    https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas
        ?p1=COMUNICADO&p2=<numero>

This collector walks the comunicados published after the CSV's coverage ends,
pairs each "Aviso de Abertura" with its "Resultado" by auction number, and
produces the operations that have not reached the monthly file yet. Everything
is parsed from the published wording; nothing is inferred. An auction whose
nature or amount cannot be read is kept with ``parsed: false`` and never
counted as spending.
"""

from __future__ import annotations

import html
import re
import sys
from decimal import Decimal

from common import (
    DATA,
    SourceUnavailable,
    fetch_json,
    log,
    read_json,
    record_source_state,
    utc_now_iso,
    write_json,
)

ENDPOINT = (
    "https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas"
    "?p1=COMUNICADO&p2={numero}"
)
PUBLIC_URL = (
    "https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo"
    "?tipo=Comunicado&numero={numero}"
)

# How far past the last known comunicado to probe before deciding we are done.
LOOKAHEAD = 12
# Safety stop so a bad cursor can never walk the whole normative archive.
MAX_FETCHES = 400

FX_PATTERN = re.compile(
    r"leil[aã]o de c[aâ]mbio|leil[aã]o de swap|swap cambial|moeda estrangeira",
    re.IGNORECASE,
)

# "Natureza:" wording -> category used across the application.
NATURE_MAP = [
    # "venda conjugada com compra" e "leiloes de venda conjugados com leiloes
    # de compra" sao a mesma operacao: o BCB vende agora e recompra depois.
    (re.compile(r"venda\s+conjugad[oa]s?", re.I), "sale_with_repurchase"),
    (re.compile(r"compra\s+conjugad[oa]s?", re.I), "sale_with_repurchase"),
    (re.compile(r"venda\s+com\s+compromisso", re.I), "sale_with_repurchase"),
    (re.compile(r"venda\s+[àa]\s*vista", re.I), "spot_sale"),
    (re.compile(r"compra\s+[àa]\s*vista", re.I), "spot_purchase"),
    (re.compile(r"swap\s+cambial\s+reverso", re.I), "swap_reverse"),
    (re.compile(r"swap\s+cambial\s+tradicional", re.I), "swap_traditional"),
]

AUCTION_FX = re.compile(r"Leil[aã]o de C[aâ]mbio\s+(\d+)\s*/\s*(\d{4})", re.I)
AUCTION_SWAP = re.compile(r"Leil[aã]o de Swap(?:\s+Cambial)?\s+(\d+)\s*/\s*(\d{4})", re.I)
RESULT_AMOUNT = re.compile(
    r"valor total de\s*USD\s*\$?\s*([\d.]+,\d{2})", re.I
)
RESULT_CUT = re.compile(r"taxa de corte do leil[aã]o\s+\d+\s*/\s*\d{4}\s+foi de\s*([\d.,]+)", re.I)
NATURE_FIELD = re.compile(r"Natureza:\s*([^:]+?)(?=\s+(?:Posi[cç][aã]o|Per[ií]odo|Quantidade|Lote|Montante|Volume|Taxa|Data)\b)", re.I)
SETTLEMENT = re.compile(
    r"Data de Liquida[cç][aã]o(?:\s+da Opera[cç][aã]o de Venda)?:\s*(\d{2}/\d{2}/\d{4})", re.I
)
REPURCHASE = re.compile(
    r"Data de Liquida[cç][aã]o da Opera[cç][aã]o de (?:Recompra|Compra):"
    r"\s*(\d{2}/\d{2}/\d{4})",
    re.I,
)
# Swap results publish the notional inside parentheses, in contracts plus USD.
SWAP_AMOUNT = re.compile(r"\(\s*USD\s*\$?\s*([\d.]+,\d{2})\s*\)", re.I)
SWAP_MATURITY = re.compile(r"com vencimento em\s*(\d{2}/\d{2}/\d{4})", re.I)


MONTHS = {
    "janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "abril": 4,
    "maio": 5, "junho": 6, "julho": 7, "agosto": 8, "setembro": 9,
    "outubro": 10, "novembro": 11, "dezembro": 12,
}

# "Divulga as condicoes de oferta publica" / "Divulga a realizacao de leiloes":
# the Banco Central announces, usually at 18:30, the auctions of the next day.
# These are intentions with a ceiling, not results, and are published here as
# scheduled operations so the interface can show them without ever counting
# them as money spent.
SCHEDULED_DATE = re.compile(
    r"leil[oõ]es?\s+(?:ser[aã]o|ser[aá])\s+realizados?\s+no dia\s+"
    r"(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})",
    re.I,
)
SCHEDULED_CEILING = re.compile(
    r"aceitos?\s+no m[aá]ximo\s+(?:at[eé]\s+)?US\$\s*([\d.,]+)\s*(bilh|milh)", re.I
)
SCHEDULED_SETTLEMENT = re.compile(
    r"liquidad[ao]s?\s+no dia\s+(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})", re.I
)


def _long_date(day: str, month: str, year: str) -> str | None:
    number = MONTHS.get(month.lower())
    if not number:
        return None
    return f"{year}-{number:02d}-{int(day):02d}"


def _clean(value: str | None) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _iso(value: str | None) -> str | None:
    if not value:
        return None
    day, month, year = value.split("/")
    return f"{year}-{month}-{day}"


def _amount_cents(raw: str | None) -> int | None:
    if not raw:
        return None
    try:
        return int(Decimal(raw.replace(".", "").replace(",", ".")) * 100)
    except Exception:
        return None


def fetch_communication(number: int) -> dict | None:
    """Return the published comunicado, or ``None`` when it does not exist."""
    payload = fetch_json(ENDPOINT.format(numero=number))
    items = payload.get("conteudo") or []
    if not items:
        return None
    item = items[0]
    stamp = item.get("DataTexto") or ""
    return {
        "number": number,
        "published_at_sao_paulo": stamp,
        "date": _iso(stamp.split(" ")[0].zfill(10)) if "/" in stamp else None,
        "subject": _clean(item.get("Assunto")),
        "text": _clean(item.get("Texto")),
        "url": PUBLIC_URL.format(numero=number),
    }


def _nature_of(text: str) -> tuple[str | None, str | None]:
    field = NATURE_FIELD.search(text)
    raw = field.group(1).strip() if field else None
    probe = raw or text
    for pattern, category in NATURE_MAP:
        if pattern.search(probe):
            return category, raw
    return None, raw


def parse_auctions(communications: list[dict]) -> dict[str, dict]:
    """Pair "Aviso de Abertura" with "Resultado" by auction number."""
    auctions: dict[str, dict] = {}

    for item in communications:
        text = item["text"]
        is_swap = bool(AUCTION_SWAP.search(text)) and not AUCTION_FX.search(text)
        matches = (AUCTION_SWAP if is_swap else AUCTION_FX).findall(text)
        if not matches:
            continue

        opening = "Aviso de Abertura" in text
        for number, year in matches:
            key = f"{'swap' if is_swap else 'cambio'}-{year}-{int(number)}"
            entry = auctions.setdefault(
                key,
                {
                    "auction": f"{int(number)}/{year}",
                    "kind": "swap" if is_swap else "cambio",
                    "category": None,
                    "nature_published": None,
                    "trade_date": None,
                    "settlement_date": None,
                    "maturity_date": None,
                    "accepted_usd_cents": None,
                    "cut_rate": None,
                    "announcement": None,
                    "result": None,
                    "parsed": False,
                },
            )
            if opening:
                category, raw = _nature_of(text)
                entry["category"] = entry["category"] or category
                entry["nature_published"] = entry["nature_published"] or raw
                entry["trade_date"] = entry["trade_date"] or item["date"]
                settlement = SETTLEMENT.search(text)
                entry["settlement_date"] = entry["settlement_date"] or _iso(
                    settlement.group(1) if settlement else None
                )
                repurchase = REPURCHASE.search(text)
                if repurchase:
                    entry["maturity_date"] = _iso(repurchase.group(1))
                entry["announcement"] = {
                    "communication_number": item["number"],
                    "published_at_sao_paulo": item["published_at_sao_paulo"],
                    "url": item["url"],
                }
            elif "Resultado" in text:
                # A single comunicado can carry the result of several auctions;
                # pick the amount that belongs to this auction number.
                segment = text
                parts = re.split(r"Resultado do Leil[aã]o", text)
                for part in parts:
                    if re.search(rf"\b{int(number)}\s*/\s*{year}\b", part):
                        segment = part
                        break
                amount = RESULT_AMOUNT.search(segment) or SWAP_AMOUNT.search(segment)
                cut = RESULT_CUT.search(segment)
                entry["accepted_usd_cents"] = entry["accepted_usd_cents"] or _amount_cents(
                    amount.group(1) if amount else None
                )
                maturity = SWAP_MATURITY.search(segment)
                if maturity and not entry["maturity_date"]:
                    entry["maturity_date"] = _iso(maturity.group(1))
                entry["cut_rate"] = entry["cut_rate"] or (
                    cut.group(1).replace(".", "").replace(",", ".") if cut else None
                )
                entry["result"] = {
                    "communication_number": item["number"],
                    "published_at_sao_paulo": item["published_at_sao_paulo"],
                    "url": item["url"],
                }
                entry["trade_date"] = entry["trade_date"] or item["date"]

    for entry in auctions.values():
        entry["parsed"] = bool(
            entry["category"]
            and entry["accepted_usd_cents"] is not None
            and entry["trade_date"]
        )
        if entry["cut_rate"] is not None:
            try:
                entry["cut_rate"] = float(entry["cut_rate"])
            except ValueError:
                entry["cut_rate"] = None
    return auctions


def parse_scheduled(communications: list[dict], covered_until: str) -> list[dict]:
    """Auctions the Banco Central has announced but not yet carried out."""
    scheduled = []
    for item in communications:
        text = item["text"]
        if "Aviso de Abertura" in text or "Resultado do Leil" in text:
            continue
        when = SCHEDULED_DATE.search(text)
        if not when:
            continue
        date = _long_date(*when.groups())
        if not date or date <= covered_until:
            continue

        category, nature = _nature_of(item["subject"] + " " + text)
        ceiling = SCHEDULED_CEILING.search(text)
        ceiling_cents = None
        if ceiling:
            try:
                amount = Decimal(ceiling.group(1).replace(".", "").replace(",", "."))
                factor = 1_000_000_000 if ceiling.group(2).lower() == "bilh" else 1_000_000
                ceiling_cents = int(amount * factor * 100)
            except Exception:
                ceiling_cents = None
        settlement = SCHEDULED_SETTLEMENT.search(text)

        scheduled.append(
            {
                "auction_date": date,
                "category": category,
                "nature_published": nature,
                "subject": item["subject"],
                "ceiling_usd_cents": ceiling_cents,
                "ceiling_is_maximum": True,
                "settlement_date": _long_date(*settlement.groups()) if settlement else None,
                "communication_number": item["number"],
                "published_at_sao_paulo": item["published_at_sao_paulo"],
                "url": item["url"],
                "status": "anunciada",
                "counts_as_spending": False,
            }
        )
    scheduled.sort(key=lambda s: (s["auction_date"], s["communication_number"]))
    return scheduled


def main() -> int:
    interventions = read_json(DATA / "interventions" / "index.json")
    if not interventions:
        log.error("interventions index missing; run collect_interventions.py first")
        record_source_state("recent_auctions", status="blocked")
        return 1

    covered_until = interventions["reference_date"]
    cache_path = DATA / "interventions" / "communications.json"
    cache = read_json(cache_path) or {"last_number": None, "communications": []}

    known = {item["number"]: item for item in cache["communications"]}
    # Start from the newest comunicado already seen, or from the last one the
    # monthly file refers to, so the first run has a sane anchor.
    start = cache.get("last_number")
    if not start:
        numbers = [
            int(a["communication_number"])
            for a in (read_json(DATA / "interventions" / "announcements.json") or {}).get(
                "announcements", []
            )[:5]
            if a.get("communication_number", "").isdigit()
        ]
        start = max(numbers) if numbers else None
    if not start:
        record_source_state("recent_auctions", status="blocked", detail="no cursor")
        return 1

    number = start
    misses = 0
    fetched = 0
    highest = start
    try:
        while misses < LOOKAHEAD and fetched < MAX_FETCHES:
            number += 1
            if number in known:
                highest = max(highest, number)
                misses = 0
                continue
            item = fetch_communication(number)
            fetched += 1
            if item is None:
                misses += 1
                continue
            misses = 0
            highest = max(highest, number)
            if FX_PATTERN.search(item["subject"] + " " + item["text"]):
                known[number] = item
    except SourceUnavailable as exc:
        log.error("comunicados unavailable: %s", exc)
        record_source_state(
            "recent_auctions", status="unavailable", detail=str(exc),
            reference_date=cache.get("reference_date"),
        )
        return 1

    communications = sorted(known.values(), key=lambda i: i["number"])
    write_json(
        cache_path,
        {
            "schema": "communications-cache/v1",
            "source": {
                "name": "Banco Central do Brasil - Comunicados",
                "endpoint": ENDPOINT.format(numero="<numero>"),
            },
            "last_number": highest,
            "collected_at": utc_now_iso(),
            "count": len(communications),
            "communications": communications,
        },
        compact=True,
    )

    auctions = parse_auctions(communications)
    pending = [
        entry
        for entry in auctions.values()
        if entry["parsed"] and (entry["trade_date"] or "") > covered_until
    ]
    pending.sort(key=lambda e: (e["trade_date"], e["auction"]))

    unparsed = [
        entry
        for entry in auctions.values()
        if not entry["parsed"] and (entry["trade_date"] or "") > covered_until
    ]

    scheduled = parse_scheduled(communications, covered_until)
    # An announcement whose result already arrived is no longer pending.
    done = {(e["trade_date"], e["category"]) for e in pending}
    scheduled = [
        item for item in scheduled
        if (item["auction_date"], item["category"]) not in done
    ]

    reference = max((e["trade_date"] for e in pending), default=covered_until)
    write_json(
        DATA / "interventions" / "recent-auctions.json",
        {
            "schema": "recent-auctions/v1",
            "unit": "USD cents",
            "concept": (
                "Leiloes de cambio divulgados pelo Banco Central por comunicado, "
                "no mesmo dia, que ainda nao entraram no arquivo mensal de "
                "atuacoes."
            ),
            "covers_after": covered_until,
            # O navegador usa este numero como ponto de partida para checar o
            # Banco Central ao vivo, sem baixar o cache inteiro de comunicados.
            "last_communication_number": highest,
            "reference_date": reference,
            "collected_at": utc_now_iso(),
            "source": {
                "name": "Banco Central do Brasil - Comunicados",
                "endpoint": ENDPOINT.format(numero="<numero>"),
                "landing_page": (
                    "https://www.bcb.gov.br/estabilidadefinanceira/buscanormas"
                ),
            },
            "limitations": [
                "Os valores vem do texto do comunicado de resultado. Quando o "
                "comunicado nao permite ler a natureza ou o valor, a operacao "
                "fica registrada como nao interpretada e nao entra em nenhum "
                "total.",
                "O arquivo mensal continua sendo a fonte oficial consolidada; "
                "estas operacoes saem daqui assim que ele as incorpora.",
            ],
            "scheduled_note": (
                "Leiloes ja anunciados e ainda nao realizados. O valor e o teto "
                "anunciado, nao o valor aceito. Nunca entra em nenhum total de "
                "gasto."
            ),
            "scheduled_count": len(scheduled),
            "scheduled": scheduled,
            "auction_count": len(pending),
            "unparsed_count": len(unparsed),
            "unparsed": unparsed,
            "auctions": pending,
        },
    )

    spending = [e for e in pending if e["category"] == "spot_sale"]
    record_source_state(
        "recent_auctions",
        status="ok",
        reference_date=reference,
        record_count=len(pending),
        detail=f"{len(spending)} venda(s) a vista apos {covered_until}",
    )
    log.info(
        "recent auctions: %s comunicados lidos, %s leiloes apos %s (%s vendas), "
        "%s nao interpretados",
        fetched,
        len(pending),
        covered_until,
        len(spending),
        len(unparsed),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
