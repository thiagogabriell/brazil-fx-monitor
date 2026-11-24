#!/usr/bin/env python3
"""Build the daily reserves statement by reconciling balances with operations.

Method
------
For every date on which the Banco Central published a reserves balance:

  opening balance   = balance of the previous published date
  closing balance   = balance of this date
  variation         = closing - opening

Operations are attached to the date on which foreign currency actually moves:

  * the settlement date (``Data de Liquidacao``) for sales and purchases;
  * the maturity date (``Data de Vencimento``) for the return leg of temporary
    operations.

Only operations with a published accepted volume are counted. An announced
auction with no accepted volume is never counted as a sale. Exchange rate
swaps are reported as notional and never enter the reconciliation.

Whatever the published operations do not explain is reported as
"variacao nao identificada". No cause is invented for it: a drop in reserves is
not evidence that the Banco Central sold dollars, and a rise is not evidence
that it bought them. Interest income, cross-currency moves, gold and bond
revaluation all land in that residual because the BCB does not publish them per
day.

Cash and liquidity concepts are reconciled separately and never mixed. For the
liquidity concept the per-operation effect of temporary operations is not
published, so those operations are reported beside the statement instead of
being subtracted from it.
"""

from __future__ import annotations

import datetime as _dt
import sys
from collections import defaultdict
from pathlib import Path

from common import (
    DATA,
    log,
    read_json,
    record_source_state,
    utc_now_iso,
    write_json,
)
from intervention_model import CATEGORIES

DIRECT_OUT = {"spot_sale"}
DIRECT_IN = {"spot_purchase", "forward_purchase"}
TEMPORARY = {"sale_with_repurchase", "repurchase_agreement", "loan"}
NOTIONAL = {"swap_traditional", "swap_reverse"}

LATEST_WINDOW_DAYS = 540

METHODOLOGY = {
    "variation": "saldo final menos saldo do dia util anterior publicado",
    "operation_date_used": (
        "data de liquidacao para vendas e compras; data de vencimento para o "
        "retorno de operacoes temporarias"
    ),
    "excluded_from_reconciliation": (
        "operacoes sem volume aceito publicado e swaps cambiais (valor nocional)"
    ),
    "residual_label": "Variacao nao identificada",
    "residual_meaning": (
        "Diferenca entre a variacao observada do saldo e o efeito das operacoes "
        "confirmadas. Inclui rendimentos, variacao cambial entre moedas, "
        "marcacao de ouro e de titulos e qualquer outro movimento que o BCB nao "
        "divulga por dia. Nao e venda de dolares."
    ),
    "cash_concept": (
        "No conceito caixa, operacoes temporarias entram como saida na "
        "liquidacao e como entrada no vencimento."
    ),
    "liquidity_concept": (
        "No conceito liquidez o BCB nao divulga o efeito de cada operacao "
        "temporaria, portanto elas aparecem ao lado do extrato e nao sao "
        "subtraidas da variacao explicada."
    ),
}


def _cents(value: int | None) -> int:
    return value or 0


def _index_operations(interventions: dict) -> tuple[dict, dict, dict]:
    """Group executed operations by settlement date, maturity date, trade date."""
    by_settlement: dict[str, list[dict]] = defaultdict(list)
    by_maturity: dict[str, list[dict]] = defaultdict(list)
    by_trade: dict[str, list[dict]] = defaultdict(list)

    for operation in interventions["operations"]:
        if operation["trade_date"]:
            by_trade[operation["trade_date"]].append(operation)
        if not operation["counts_as_executed"]:
            continue
        category = operation["category"]
        if category in NOTIONAL:
            continue
        if operation["settlement_date"]:
            by_settlement[operation["settlement_date"]].append(operation)
        if category in TEMPORARY and operation["maturity_date"]:
            by_maturity[operation["maturity_date"]].append(operation)

    return by_settlement, by_maturity, by_trade


def _operation_ref(operation: dict) -> dict:
    spec = CATEGORIES[operation["category"]]
    return {
        "id": operation["id"],
        "category": operation["category"],
        "category_label": spec["label"],
        "instrument": operation["instrument"],
        "modality": operation["modality"],
        "trade_date": operation["trade_date"],
        "settlement_date": operation["settlement_date"],
        "maturity_date": operation["maturity_date"],
        "accepted_usd_cents": operation["volume_accepted_usd_cents"],
        "offered_usd_cents": operation["volume_offered_usd_cents"],
        "cut_rate": operation["cut_rate"],
        "status": operation["status"],
        "communication_number": operation["communication_number"],
    }


def build_statement(
    concept: str,
    observations: list[dict],
    by_settlement: dict,
    by_maturity: dict,
    by_trade: dict,
    interventions_from: str,
    interventions_to: str,
) -> list[dict]:
    rows: list[dict] = []
    treat_temporary_as_cash_flow = concept == "cash"

    for position, observation in enumerate(observations):
        date = observation["date"]
        closing = observation["value_usd"]
        previous = observations[position - 1] if position else None
        opening = previous["value_usd"] if previous else None

        variation = None if opening is None else closing - opening
        variation_pct = (
            None if not opening else round(variation / opening * 100, 6)
        )
        gap_days = (
            None
            if previous is None
            else (_dt.date.fromisoformat(date) - _dt.date.fromisoformat(previous["date"])).days
        )

        settled = by_settlement.get(date, [])
        matured = by_maturity.get(date, [])
        traded = by_trade.get(date, [])

        sold = sum(
            _cents(o["volume_accepted_usd_cents"])
            for o in settled
            if o["category"] in DIRECT_OUT
        )
        bought = sum(
            _cents(o["volume_accepted_usd_cents"])
            for o in settled
            if o["category"] in DIRECT_IN
        )
        temporary_out = sum(
            _cents(o["volume_accepted_usd_cents"])
            for o in settled
            if o["category"] in TEMPORARY
        )
        temporary_back = sum(
            _cents(o["volume_accepted_usd_cents"]) for o in matured
        )

        swap_traditional = sum(
            _cents(o["volume_accepted_usd_cents"])
            for o in traded
            if o["category"] == "swap_traditional" and o["counts_as_executed"]
        )
        swap_reverse = sum(
            _cents(o["volume_accepted_usd_cents"])
            for o in traded
            if o["category"] == "swap_reverse" and o["counts_as_executed"]
        )
        announced_only = [
            o for o in traded if not o["counts_as_executed"]
        ]

        if treat_temporary_as_cash_flow:
            explained_cents = bought + temporary_back - sold - temporary_out
        else:
            explained_cents = bought - sold

        # The operations dataset lags behind the reserves series by weeks. For a
        # date beyond its coverage we must not claim "no intervention".
        coverage = (
            "covered"
            if interventions_from <= date <= interventions_to
            else "not_yet_published"
            if date > interventions_to
            else "before_source_start"
        )

        explained_usd = explained_cents / 100 if coverage == "covered" else None
        unidentified = (
            None
            if variation is None or explained_usd is None
            else round(variation - explained_usd, 2)
        )

        rows.append(
            {
                "date": date,
                "concept": concept,
                "opening_date": previous["date"] if previous else None,
                "opening_usd": opening,
                "closing_usd": closing,
                "variation_usd": variation,
                "variation_pct": variation_pct,
                "calendar_gap_days": gap_days,
                "interventions_coverage": coverage,
                "direct_sold_usd_cents": sold,
                "direct_bought_usd_cents": bought,
                "temporary_out_usd_cents": temporary_out,
                "temporary_returned_usd_cents": temporary_back,
                "temporary_counted_in_reconciliation": treat_temporary_as_cash_flow,
                "confirmed_outflow_usd_cents": (
                    sold + temporary_out if treat_temporary_as_cash_flow else sold
                ),
                "confirmed_inflow_usd_cents": (
                    bought + temporary_back if treat_temporary_as_cash_flow else bought
                ),
                "explained_variation_usd": explained_usd,
                "unidentified_variation_usd": unidentified,
                "swap_traditional_notional_usd_cents": swap_traditional,
                "swap_reverse_notional_usd_cents": swap_reverse,
                "notional_note": (
                    "Valor nocional de swap cambial. Nao e saida de dolares das "
                    "reservas."
                )
                if (swap_traditional or swap_reverse)
                else None,
                "operation_count": len(settled) + len(matured),
                "announced_without_result_count": len(announced_only),
                "operations": [_operation_ref(o) for o in settled],
                "maturing_operations": [_operation_ref(o) for o in matured],
                "notional_operations": [
                    _operation_ref(o)
                    for o in traded
                    if o["category"] in NOTIONAL and o["counts_as_executed"]
                ],
                "announced_operations": [_operation_ref(o) for o in announced_only],
            }
        )
    return rows


def _write_shards(concept: str, rows: list[dict], reference: str) -> list[dict]:
    by_year: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_year[row["date"][:4]].append(row)

    directory = DATA / "reserves" / "statement" / concept
    directory.mkdir(parents=True, exist_ok=True)
    meta = []
    for year in sorted(by_year):
        items = by_year[year]
        write_json(
            directory / f"{year}.json",
            {
                "schema": "reserves-statement-year/v1",
                "concept": concept,
                "year": int(year),
                "unit": "USD",
                "cents_fields_unit": "USD cents",
                "reference_date": reference,
                "collected_at": utc_now_iso(),
                "day_count": len(items),
                "days": items,
            },
            compact=True,
        )
        meta.append(
            {
                "year": int(year),
                "file": f"data/reserves/statement/{concept}/{year}.json",
                "day_count": len(items),
            }
        )
    for stale in directory.glob("*.json"):
        if stale.stem not in by_year:
            stale.unlink()
    return meta


def main() -> int:
    interventions = read_json(DATA / "interventions" / "operations.json")
    reserves_index = read_json(DATA / "reserves" / "index.json")
    if not interventions or not reserves_index:
        log.error("missing input datasets; run the collectors first")
        record_source_state("reconciliation", status="blocked", detail="inputs missing")
        return 1

    by_settlement, by_maturity, by_trade = _index_operations(interventions)
    interventions_from = interventions["first_date"]
    interventions_to = interventions["reference_date"]

    concepts_meta = []
    for concept in ("cash", "liquidity"):
        series = read_json(DATA / "reserves" / f"{concept}.json")
        if not series:
            log.warning("concept %s not available; skipping", concept)
            continue
        rows = build_statement(
            concept,
            series["observations"],
            by_settlement,
            by_maturity,
            by_trade,
            interventions_from,
            interventions_to,
        )
        years = _write_shards(concept, rows, series["reference_date"])
        write_json(
            DATA / "reserves" / f"statement-latest-{concept}.json",
            {
                "schema": "reserves-statement-latest/v1",
                "concept": concept,
                "unit": "USD",
                "cents_fields_unit": "USD cents",
                "reference_date": series["reference_date"],
                "collected_at": utc_now_iso(),
                "window_days": LATEST_WINDOW_DAYS,
                "days": rows[-LATEST_WINDOW_DAYS:],
            },
            compact=True,
        )
        concepts_meta.append(
            {
                "concept": concept,
                "label": next(
                    c["label"]
                    for c in reserves_index["concepts"]
                    if c["key"] == concept
                ),
                "reference_date": series["reference_date"],
                "day_count": len(rows),
                "latest_file": f"data/reserves/statement-latest-{concept}.json",
                "years": years,
            }
        )
        log.info("statement %s: %s days", concept, len(rows))

    if not concepts_meta:
        record_source_state("reconciliation", status="blocked", detail="no concept")
        return 1

    write_json(
        DATA / "reserves" / "statement-index.json",
        {
            "schema": "reserves-statement-index/v1",
            "generated_at": utc_now_iso(),
            "methodology": METHODOLOGY,
            "interventions_coverage": {
                "from": interventions_from,
                "to": interventions_to,
                "note": (
                    "Depois de "
                    f"{interventions_to} as atuacoes ainda nao foram publicadas. "
                    "Dias posteriores aparecem como 'sem dados disponiveis', nao "
                    "como 'sem intervencao'."
                ),
            },
            "concepts": concepts_meta,
            "default_concept": "cash",
        },
    )
    record_source_state(
        "reconciliation",
        status="ok",
        reference_date=max(c["reference_date"] for c in concepts_meta),
        record_count=sum(c["day_count"] for c in concepts_meta),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
