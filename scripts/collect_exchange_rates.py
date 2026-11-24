#!/usr/bin/env python3
"""Collect the official BRL/USD exchange rate published by the Banco Central.

The BCB publishes the PTAX reference rate, not an intraday "commercial dollar"
quote. Both are kept apart:

  * ``ptax`` - SGS 1 (venda) and SGS 10813 (compra), daily closing PTAX, plus
    the same day detail from the Olinda PTAX OData service.
  * the live spot quote shown on the dashboard is fetched in the browser from a
    clearly labelled secondary source; it is never written here as if it were a
    BCB figure.
"""

from __future__ import annotations

import datetime as _dt
import sys
from decimal import Decimal

from common import (
    DATA,
    SourceUnavailable,
    fetch_json,
    log,
    read_json,
    record_source_state,
    today_sp,
    utc_now_iso,
    write_json,
)
from sgs import fetch_series

HISTORY_START = _dt.date(1999, 1, 1)
SGS_SELL = 1
SGS_BUY = 10813

OLINDA_DAY = (
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
    "CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='{d}'&$format=json"
)
OLINDA_PERIOD = (
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
    "CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)"
    "?@dataInicial='{a}'&@dataFinalCotacao='{b}'&$format=json"
)


def _num(raw: str) -> float | None:
    try:
        return float(Decimal(raw))
    except Exception:
        return None


def collect_ptax() -> dict | None:
    path = DATA / "exchange-rates" / "ptax.json"
    previous = read_json(path)
    try:
        sell = fetch_series(SGS_SELL, start=HISTORY_START)
        buy = {r["date"]: r["raw"] for r in fetch_series(SGS_BUY, start=HISTORY_START)}
    except SourceUnavailable as exc:
        log.error("ptax unavailable: %s", exc)
        record_source_state(
            "exchange_rate_ptax",
            status="unavailable",
            detail=str(exc),
            reference_date=(previous or {}).get("reference_date"),
        )
        return None

    observations = [
        {
            "date": row["date"],
            "sell": _num(row["raw"]),
            "buy": _num(buy[row["date"]]) if row["date"] in buy else None,
        }
        for row in sell
    ]
    if not observations:
        record_source_state("exchange_rate_ptax", status="empty")
        return None

    payload = {
        "schema": "exchange-rate-ptax/v1",
        "unit": "BRL per USD",
        "frequency": "daily (business days)",
        "official_update": (
            "PTAX de fechamento divulgada pelo BCB por volta das 13h10 "
            "(America/Sao_Paulo) de cada dia util."
        ),
        "concept": (
            "Taxa PTAX: media das cotacoes do dolar nas quatro janelas de "
            "consulta do dia, calculada e divulgada pelo Banco Central. Nao e "
            "uma cotacao de mercado em tempo real."
        ),
        "sources": [
            {
                "name": "BCB SGS",
                "series_code": SGS_SELL,
                "series_name": "Taxa de cambio - Livre - Dolar americano (venda) - diario",
                "endpoint": f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{SGS_SELL}/dados?formato=json",
            },
            {
                "name": "BCB SGS",
                "series_code": SGS_BUY,
                "series_name": "Taxa de cambio - Livre - Dolar americano (compra) - diario",
                "endpoint": f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{SGS_BUY}/dados?formato=json",
            },
        ],
        "license": "Open Data Commons Open Database License (ODbL)",
        "reference_date": observations[-1]["date"],
        "first_date": observations[0]["date"],
        "observation_count": len(observations),
        "collected_at": utc_now_iso(),
        "observations": observations,
    }
    write_json(path, payload, compact=True)
    record_source_state(
        "exchange_rate_ptax",
        status="ok",
        reference_date=payload["reference_date"],
        record_count=len(observations),
    )
    return payload


def collect_olinda_latest() -> None:
    """Latest published PTAX bulletins, with their exact publication timestamp."""
    path = DATA / "exchange-rates" / "ptax-latest.json"
    end = today_sp()
    start = end - _dt.timedelta(days=21)
    url = OLINDA_PERIOD.format(a=start.strftime("%m-%d-%Y"), b=end.strftime("%m-%d-%Y"))
    try:
        payload = fetch_json(url)
    except SourceUnavailable as exc:
        log.warning("olinda ptax unavailable: %s", exc)
        record_source_state("exchange_rate_olinda", status="unavailable", detail=str(exc))
        return

    rows = []
    for item in payload.get("value", []):
        stamp = item.get("dataHoraCotacao")
        if not stamp:
            continue
        rows.append(
            {
                "date": stamp[:10],
                "published_at_sao_paulo": stamp,
                "buy": item.get("cotacaoCompra"),
                "sell": item.get("cotacaoVenda"),
            }
        )
    rows.sort(key=lambda r: r["date"])
    if not rows:
        record_source_state("exchange_rate_olinda", status="empty")
        return

    write_json(
        path,
        {
            "schema": "exchange-rate-ptax-latest/v1",
            "unit": "BRL per USD",
            "timezone": "America/Sao_Paulo",
            "source": {
                "name": "BCB Olinda - servico PTAX (OData v1)",
                "endpoint": url,
                "entity_set": "CotacaoDolarPeriodo",
            },
            "reference_date": rows[-1]["date"],
            "collected_at": utc_now_iso(),
            "bulletins": rows,
        },
    )
    record_source_state(
        "exchange_rate_olinda",
        status="ok",
        reference_date=rows[-1]["date"],
        record_count=len(rows),
    )


def main() -> int:
    ptax = collect_ptax()
    collect_olinda_latest()
    if not ptax:
        return 1
    log.info("exchange rates collected up to %s", ptax["reference_date"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
