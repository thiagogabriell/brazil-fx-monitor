#!/usr/bin/env python3
"""Collect Brazil's external-sector flows from the BCB balance of payments.

Important scope note, kept visible in the published data and in the UI:

The weekly "fluxo cambial contratado" table (commercial and financial flows
from contracted FX operations) that the Banco Central releases in its external
sector press note is NOT available through any open API or SGS series. A search
of the full Portal de Dados Abertos catalogue (4,261 datasets, checked
2026-11-24) returns no dataset for contracted FX flows.

What IS officially available, machine readable and monthly, is the balance of
payments. These series are collected here with their official names. They are a
different concept from contracted FX flow and are labelled as such.
"""

from __future__ import annotations

import datetime as _dt
import sys
from decimal import Decimal

from common import (
    DATA,
    SourceUnavailable,
    log,
    read_json,
    record_source_state,
    utc_now_iso,
    write_json,
)
from sgs import fetch_series

HISTORY_START = _dt.date(1995, 1, 1)

SERIES = [
    {
        "key": "current_account",
        "sgs_code": 22701,
        "label": "Transacoes correntes - saldo",
        "group": "corrente",
        "direction_note": "Positivo = entrada liquida de recursos no conceito BP.",
    },
    {
        "key": "trade_balance",
        "sgs_code": 22707,
        "label": "Balanca comercial - saldo",
        "group": "comercial",
        "direction_note": "Exportacao de bens menos importacao de bens.",
    },
    {
        "key": "goods_exports",
        "sgs_code": 22708,
        "label": "Exportacao de bens",
        "group": "comercial",
        "direction_note": "Entrada de recursos pela venda de bens ao exterior.",
    },
    {
        "key": "goods_imports",
        "sgs_code": 22709,
        "label": "Importacao de bens",
        "group": "comercial",
        "direction_note": "Saida de recursos pela compra de bens do exterior.",
    },
    {
        "key": "direct_investment_net",
        "sgs_code": 22864,
        "label": "Investimento direto - liquido",
        "group": "financeiro",
        "direction_note": "Conta financeira. Sinal segue a convencao do BPM6.",
    },
    {
        "key": "inward_direct_investment",
        "sgs_code": 22885,
        "label": "Investimentos diretos no pais (IDP) - liquido",
        "group": "financeiro",
        "direction_note": "Investimento direto recebido pelo Brasil.",
    },
    {
        "key": "portfolio_investment_net",
        "sgs_code": 22905,
        "label": "Investimentos em carteira - liquido",
        "group": "financeiro",
        "direction_note": "Conta financeira. Sinal segue a convencao do BPM6.",
    },
    {
        "key": "portfolio_liabilities_net",
        "sgs_code": 22924,
        "label": "Investimentos em carteira - passivos - liquido",
        "group": "financeiro",
        "direction_note": (
            "Fluxo de investidores nao residentes em ativos brasileiros."
        ),
    },
    {
        "key": "other_investment_net",
        "sgs_code": 22969,
        "label": "Outros investimentos - liquido",
        "group": "financeiro",
        "direction_note": "Emprestimos, moeda e depositos e creditos comerciais.",
    },
]


def _num(raw: str) -> float | None:
    try:
        return float(Decimal(raw))
    except Exception:
        return None


def main() -> int:
    path = DATA / "exchange-flow" / "balance-of-payments.json"
    previous = read_json(path)

    series_payload = []
    failures = []
    for spec in SERIES:
        try:
            rows = fetch_series(spec["sgs_code"], start=HISTORY_START, daily=False)
        except SourceUnavailable as exc:
            log.error("flow %s unavailable: %s", spec["key"], exc)
            failures.append({"key": spec["key"], "detail": str(exc)})
            continue
        observations = [
            {"date": row["date"], "value_usd_million": _num(row["raw"])}
            for row in rows
        ]
        if not observations:
            failures.append({"key": spec["key"], "detail": "no observations"})
            continue
        series_payload.append(
            {
                **{k: v for k, v in spec.items()},
                "unit": "USD million",
                "frequency": "monthly",
                "endpoint": (
                    "https://api.bcb.gov.br/dados/serie/bcdata.sgs."
                    f"{spec['sgs_code']}/dados?formato=json"
                ),
                "reference_date": observations[-1]["date"],
                "first_date": observations[0]["date"],
                "observation_count": len(observations),
                "observations": observations,
            }
        )

    if not series_payload:
        record_source_state(
            "exchange_flow",
            status="unavailable",
            detail="; ".join(f["detail"] for f in failures)[:300],
            reference_date=(previous or {}).get("reference_date"),
        )
        return 1

    reference = max(s["reference_date"] for s in series_payload)
    write_json(
        path,
        {
            "schema": "exchange-flow-bp/v1",
            "concept": (
                "Balanco de pagamentos mensal do Brasil (BPM6), divulgado pelo "
                "Banco Central. Mede fluxos economicos entre residentes e nao "
                "residentes."
            ),
            "not_the_same_as": (
                "Nao e o 'fluxo cambial contratado' semanal (comercial e "
                "financeiro) divulgado na nota do setor externo. Esse fluxo nao "
                "possui API publica nem serie no SGS; a verificacao do "
                "catalogo completo do Portal de Dados Abertos em 2026-11-24 "
                "nao retornou nenhum conjunto de dados de cambio contratado."
            ),
            "unit": "USD million",
            "frequency": "monthly",
            "official_update": (
                "Divulgacao mensal, cerca de 25 dias apos o fim do mes de "
                "referencia. A data de referencia e o primeiro dia do mes "
                "medido, nao a data de publicacao."
            ),
            "source": {
                "name": "Banco Central do Brasil - SGS / Estatisticas do setor externo",
                "landing_page": "https://dadosabertos.bcb.gov.br",
                "license": "Open Data Commons Open Database License (ODbL)",
            },
            "reference_date": reference,
            "collected_at": utc_now_iso(),
            "failures": failures,
            "series": series_payload,
        },
        compact=True,
    )
    record_source_state(
        "exchange_flow",
        status="ok" if not failures else "partial",
        reference_date=reference,
        record_count=sum(s["observation_count"] for s in series_payload),
        detail=f"{len(failures)} series indisponiveis" if failures else None,
    )
    log.info("exchange flow collected up to %s (%s series)", reference, len(series_payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
