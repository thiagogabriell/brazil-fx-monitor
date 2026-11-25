#!/usr/bin/env python3
"""Derive every published indicator from the collected datasets.

Window conventions, surfaced in the output so the interface can state them:

  * reserve and exchange-rate windows end on the latest date each series
    actually published;
  * intervention windows end on ``interventions.reference_date``, which lags the
    reserves series by weeks because the source is refreshed monthly. Totals are
    therefore labelled with their own anchor date and never presented as
    "today".
"""

from __future__ import annotations

import datetime as _dt
import sys
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict

from common import DATA, log, read_json, record_source_state, utc_now_iso, write_json
from intervention_model import CATEGORIES
from pressure_index import compute as compute_pressure

WINDOWS = (7, 30, 90, 365)
DIRECT_OUT = {"spot_sale"}
DIRECT_IN = {"spot_purchase", "forward_purchase"}
TEMPORARY = {"sale_with_repurchase", "repurchase_agreement", "loan"}
NOTIONAL = {"swap_traditional", "swap_reverse"}


def _d(value: str) -> _dt.date:
    return _dt.date.fromisoformat(value)


# --------------------------------------------------------------------------- #
# series helpers
# --------------------------------------------------------------------------- #

class Series:
    """A date-indexed numeric series with as-of lookups."""

    def __init__(self, pairs: list[tuple[str, float | None]]):
        self.dates = [d for d, v in pairs if v is not None]
        self.values = [v for d, v in pairs if v is not None]
        self._by_date = dict(zip(self.dates, self.values))

    def __bool__(self) -> bool:
        return bool(self.dates)

    @property
    def last_date(self) -> str | None:
        return self.dates[-1] if self.dates else None

    @property
    def last(self) -> float | None:
        return self.values[-1] if self.values else None

    def at(self, date: str) -> float | None:
        return self._by_date.get(date)

    def as_of(self, date: str) -> tuple[str, float] | None:
        """Latest observation on or before ``date``."""
        position = bisect_right(self.dates, date) - 1
        if position < 0:
            return None
        return self.dates[position], self.values[position]

    def previous(self, date: str) -> tuple[str, float] | None:
        position = bisect_left(self.dates, date) - 1
        if position < 0:
            return None
        return self.dates[position], self.values[position]

    def window(self, start: str, end: str) -> list[tuple[str, float]]:
        lo = bisect_left(self.dates, start)
        hi = bisect_right(self.dates, end)
        return list(zip(self.dates[lo:hi], self.values[lo:hi]))

    def shift_business_days(self, date: str, offset: int) -> tuple[str, float] | None:
        """``offset`` steps along the observed dates of this series."""
        position = bisect_right(self.dates, date) - 1
        if position < 0:
            return None
        target = position + offset
        if target < 0 or target >= len(self.dates):
            return None
        return self.dates[target], self.values[target]


def _pct(new: float | None, old: float | None) -> float | None:
    if new is None or old in (None, 0):
        return None
    return round((new - old) / old * 100, 4)


def _change_block(series: Series, days: int, anchor: str) -> dict:
    reference = (_d(anchor) - _dt.timedelta(days=days)).isoformat()
    base = series.as_of(reference)
    current = series.last
    if base is None or current is None:
        return {
            "days": days,
            "available": False,
            "from_date": None,
            "from_value": None,
            "change": None,
            "change_pct": None,
        }
    return {
        "days": days,
        "available": True,
        "from_date": base[0],
        "from_value": base[1],
        "change": round(current - base[1], 6),
        "change_pct": _pct(current, base[1]),
    }


# --------------------------------------------------------------------------- #
# interventions
# --------------------------------------------------------------------------- #

def _daily_intervention_aggregates(operations: list[dict]) -> dict[str, dict]:
    """Aggregate executed operations per date, using the economically right date.

    Spot and temporary operations are keyed on their settlement date, because
    that is when reserves move. Swaps are keyed on their trade date, because
    they never move reserves.
    """
    daily: dict[str, dict] = defaultdict(
        lambda: {
            "sold_cents": 0,
            "bought_cents": 0,
            "temporary_out_cents": 0,
            "temporary_back_cents": 0,
            "swap_traditional_cents": 0,
            "swap_reverse_cents": 0,
            "operations": 0,
            "sale_operations": 0,
            "announced_only": 0,
        }
    )
    for operation in operations:
        category = operation["category"]
        accepted = operation["volume_accepted_usd_cents"] or 0
        if not operation["counts_as_executed"]:
            if operation["trade_date"]:
                daily[operation["trade_date"]]["announced_only"] += 1
            continue

        if category in NOTIONAL:
            date = operation["trade_date"]
            if not date:
                continue
            key = (
                "swap_traditional_cents"
                if category == "swap_traditional"
                else "swap_reverse_cents"
            )
            daily[date][key] += accepted
            daily[date]["operations"] += 1
            continue

        settlement = operation["settlement_date"] or operation["trade_date"]
        if settlement:
            bucket = daily[settlement]
            bucket["operations"] += 1
            if category in DIRECT_OUT:
                bucket["sold_cents"] += accepted
                bucket["sale_operations"] += 1
            elif category in DIRECT_IN:
                bucket["bought_cents"] += accepted
            elif category in TEMPORARY:
                bucket["temporary_out_cents"] += accepted
        if category in TEMPORARY and operation["maturity_date"]:
            daily[operation["maturity_date"]]["temporary_back_cents"] += accepted

    return dict(sorted(daily.items()))


def merge_recent_auctions(
    daily: dict[str, dict], operations: list[dict], recent: dict | None
) -> tuple[dict[str, dict], list[dict], str]:
    """Fold the same-day comunicados into the aggregates used by every page.

    Without this the home page knows about an auction from yesterday while the
    other pages still answer with the monthly file and contradict it. The
    monthly dataset stops at its own reference date and the collector only
    emits auctions after it, so nothing is counted twice.
    """
    if not recent or not recent.get("auctions"):
        return daily, operations, recent.get("scanned_until_date", "") if recent else ""

    merged = {date: dict(values) for date, values in daily.items()}
    extra_operations = []

    def bucket(date: str) -> dict:
        if date not in merged:
            merged[date] = {
                "sold_cents": 0, "bought_cents": 0, "temporary_out_cents": 0,
                "temporary_back_cents": 0, "swap_traditional_cents": 0,
                "swap_reverse_cents": 0, "operations": 0, "sale_operations": 0,
                "announced_only": 0,
            }
        return merged[date]

    for auction in recent["auctions"]:
        if not auction.get("parsed"):
            continue
        category = auction["category"]
        amount = auction.get("accepted_usd_cents") or 0
        trade = auction.get("trade_date")
        settlement = auction.get("settlement_date") or trade
        if not trade:
            continue

        if category in NOTIONAL:
            target = bucket(trade)
            key = (
                "swap_traditional_cents"
                if category == "swap_traditional"
                else "swap_reverse_cents"
            )
            target[key] += amount
            target["operations"] += 1
        else:
            target = bucket(settlement)
            target["operations"] += 1
            if category in DIRECT_OUT:
                target["sold_cents"] += amount
                target["sale_operations"] += 1
            elif category in DIRECT_IN:
                target["bought_cents"] += amount
            elif category in TEMPORARY:
                target["temporary_out_cents"] += amount
                if auction.get("maturity_date"):
                    bucket(auction["maturity_date"])["temporary_back_cents"] += amount

        reference = auction.get("result") or auction.get("announcement") or {}
        extra_operations.append(
            {
                "id": f"comunicado-{auction['auction'].replace('/', '-')}",
                "trade_date": trade,
                "announced_at": None,
                "communication_published_at": reference.get("published_at_sao_paulo"),
                "settlement_date": auction.get("settlement_date"),
                "maturity_date": auction.get("maturity_date"),
                "category": category,
                "instrument": None,
                "modality": auction.get("nature_published"),
                "composite_type": None,
                "operational_procedure": "Leilao Eletronico",
                "asset_class_disclosed": False,
                "volume_offered_usd_cents": None,
                "volume_accepted_usd_cents": amount,
                "cut_rate": auction.get("cut_rate"),
                "status": "liquidada" if amount else "anunciada",
                "counts_as_executed": amount > 0,
                "communication_number": str(reference.get("communication_number") or ""),
                "published_identically_times": 1,
                "ambiguous_duplicate": False,
                "provisional": True,
            }
        )

    covered = recent.get("scanned_until_date") or ""
    return dict(sorted(merged.items())), operations + extra_operations, covered


def _window_totals(daily: dict[str, dict], anchor: str, days: int) -> dict:
    start = (_d(anchor) - _dt.timedelta(days=days - 1)).isoformat()
    rows = [v for d, v in daily.items() if start <= d <= anchor]
    sold = sum(r["sold_cents"] for r in rows)
    bought = sum(r["bought_cents"] for r in rows)
    return {
        "days": days,
        "from_date": start,
        "to_date": anchor,
        "sold_usd_cents": sold,
        "bought_usd_cents": bought,
        "net_usd_cents": bought - sold,
        "temporary_out_usd_cents": sum(r["temporary_out_cents"] for r in rows),
        "temporary_returned_usd_cents": sum(r["temporary_back_cents"] for r in rows),
        "swap_traditional_notional_usd_cents": sum(
            r["swap_traditional_cents"] for r in rows
        ),
        "swap_reverse_notional_usd_cents": sum(r["swap_reverse_cents"] for r in rows),
        "operation_count": sum(r["operations"] for r in rows),
        "sale_operation_count": sum(r["sale_operations"] for r in rows),
        "days_with_direct_sale": sum(1 for r in rows if r["sold_cents"] > 0),
        "announced_without_result_count": sum(r["announced_only"] for r in rows),
    }


def _open_temporary(operations: list[dict], anchor: str) -> dict:
    """Temporary operations settled on or before ``anchor`` and not yet matured."""
    open_items = []
    for operation in operations:
        if operation["category"] not in TEMPORARY:
            continue
        if not operation["counts_as_executed"]:
            continue
        settlement = operation["settlement_date"]
        maturity = operation["maturity_date"]
        if not settlement or settlement > anchor:
            continue
        if maturity and maturity <= anchor:
            continue
        open_items.append(operation)
    return {
        "as_of": anchor,
        "count": len(open_items),
        "outstanding_usd_cents": sum(
            o["volume_accepted_usd_cents"] or 0 for o in open_items
        ),
        "operations": [
            {
                "id": o["id"],
                "category": o["category"],
                "settlement_date": o["settlement_date"],
                "maturity_date": o["maturity_date"],
                "accepted_usd_cents": o["volume_accepted_usd_cents"],
            }
            for o in sorted(open_items, key=lambda o: o["maturity_date"] or "")
        ],
        "note": (
            "Saldo em aberto calculado pelas datas de liquidacao e de "
            "vencimento publicadas. A fonte nao reflete pre-pagamentos, "
            "portanto este saldo e um limite superior."
        ),
    }


def _swap_outstanding(operations: list[dict], anchor: str) -> dict:
    open_items = [
        o
        for o in operations
        if o["category"] in NOTIONAL
        and o["counts_as_executed"]
        and o["settlement_date"]
        and o["settlement_date"] <= anchor
        and (not o["maturity_date"] or o["maturity_date"] > anchor)
    ]
    traditional = [o for o in open_items if o["category"] == "swap_traditional"]
    reverse = [o for o in open_items if o["category"] == "swap_reverse"]
    return {
        "as_of": anchor,
        "traditional_notional_usd_cents": sum(
            o["volume_accepted_usd_cents"] or 0 for o in traditional
        ),
        "reverse_notional_usd_cents": sum(
            o["volume_accepted_usd_cents"] or 0 for o in reverse
        ),
        "traditional_contract_count": len(traditional),
        "reverse_contract_count": len(reverse),
        "note": (
            "Estoque nocional estimado pelas datas de liquidacao e vencimento "
            "das atuacoes publicadas. Valor nocional nao representa dolares "
            "retirados das reservas."
        ),
    }


# --------------------------------------------------------------------------- #
# effectiveness
# --------------------------------------------------------------------------- #

STABLE_BAND_PCT = 0.25


def _classify_move(change_pct: float | None) -> str:
    if change_pct is None:
        return "dados_insuficientes"
    if change_pct <= -STABLE_BAND_PCT:
        return "real_valorizou"
    if change_pct >= STABLE_BAND_PCT:
        return "real_desvalorizou"
    return "real_estavel"


def build_effectiveness(operations: list[dict], ptax: Series) -> dict:
    """Compare the PTAX around each direct sale of dollars.

    There is no reliable intraday series for the moment of each auction, so
    daily closes are used and that limitation is published with the result.
    """
    cases = []
    for operation in operations:
        if operation["category"] != "spot_sale":
            continue
        if not operation["counts_as_executed"] or not operation["trade_date"]:
            continue

        trade_date = operation["trade_date"]
        on_day = ptax.as_of(trade_date)
        if on_day is None:
            continue
        before = ptax.previous(trade_date if ptax.at(trade_date) else on_day[0])
        next_day = ptax.shift_business_days(on_day[0], 1)
        five_days = ptax.shift_business_days(on_day[0], 5)

        before_value = before[1] if before else None
        close_value = on_day[1]

        cases.append(
            {
                "operation_id": operation["id"],
                "trade_date": trade_date,
                "settlement_date": operation["settlement_date"],
                "communication_number": operation["communication_number"],
                "sold_usd_cents": operation["volume_accepted_usd_cents"],
                "modality": operation["modality"],
                "ptax_previous_date": before[0] if before else None,
                "ptax_previous": before_value,
                "ptax_close_date": on_day[0],
                "ptax_close": close_value,
                "ptax_next_business_day_date": next_day[0] if next_day else None,
                "ptax_next_business_day": next_day[1] if next_day else None,
                "ptax_five_business_days_date": five_days[0] if five_days else None,
                "ptax_five_business_days": five_days[1] if five_days else None,
                "change_same_day_pct": _pct(close_value, before_value),
                "change_next_day_pct": _pct(
                    next_day[1] if next_day else None, close_value
                ),
                "change_five_days_pct": _pct(
                    five_days[1] if five_days else None, close_value
                ),
                "outcome_same_day": _classify_move(_pct(close_value, before_value)),
                "outcome_next_day": _classify_move(
                    _pct(next_day[1] if next_day else None, close_value)
                ),
                "outcome_five_days": _classify_move(
                    _pct(five_days[1] if five_days else None, close_value)
                ),
            }
        )

    cases.sort(key=lambda c: c["trade_date"])
    recent = [c for c in cases if c["trade_date"] >= "2015-01-01"]

    def tally(key: str, population: list[dict]) -> dict:
        counts = Counter(c[key] for c in population)
        total = sum(counts.values())
        return {
            "total": total,
            "counts": dict(counts),
            "share_pct": {
                outcome: round(count / total * 100, 2) for outcome, count in counts.items()
            }
            if total
            else {},
        }

    return {
        "schema": "effectiveness/v1",
        "generated_at": utc_now_iso(),
        "method": (
            "Para cada venda direta de dolares com resultado publicado, compara "
            "a PTAX do dia util anterior, do dia da operacao, do dia util "
            "seguinte e de cinco dias uteis depois."
        ),
        "limitations": [
            "Nao existe serie intradiaria confiavel e gratuita para o horario "
            "de cada leilao, portanto sao usados fechamentos diarios da PTAX.",
            "Correlacao nao e causalidade: outros fatores movem o cambio no "
            "mesmo periodo e a comparacao nao isola o efeito da intervencao.",
            "A classificacao usa uma banda de estabilidade de "
            f"+/-{STABLE_BAND_PCT}% definida por esta aplicacao.",
        ],
        "stable_band_pct": STABLE_BAND_PCT,
        "classification_labels": {
            "real_valorizou": "Real se valorizou",
            "real_estavel": "Real permaneceu relativamente estavel",
            "real_desvalorizou": "Real continuou se desvalorizando",
            "dados_insuficientes": "Dados insuficientes",
        },
        "case_count": len(cases),
        "summary_all": {
            "same_day": tally("outcome_same_day", cases),
            "next_day": tally("outcome_next_day", cases),
            "five_days": tally("outcome_five_days", cases),
        },
        "summary_since_2015": {
            "same_day": tally("outcome_same_day", recent),
            "next_day": tally("outcome_next_day", recent),
            "five_days": tally("outcome_five_days", recent),
        },
        "cases": cases,
    }


# --------------------------------------------------------------------------- #
# flows
# --------------------------------------------------------------------------- #

def build_flow_summary(flow: dict) -> dict:
    series = {s["key"]: Series([(o["date"], o["value_usd_million"]) for o in s["observations"]]) for s in flow["series"]}
    by_key = {s["key"]: s for s in flow["series"]}

    def accumulate(key: str, months: int) -> float | None:
        serie = series.get(key)
        if not serie or not serie.last_date:
            return None
        rows = serie.window(
            (_d(serie.last_date) - _dt.timedelta(days=31 * months - 1)).isoformat(),
            serie.last_date,
        )
        rows = rows[-months:]
        return round(sum(v for _, v in rows), 2) if rows else None

    def moving_average(key: str, months: int) -> float | None:
        serie = series.get(key)
        if not serie or len(serie.values) < months:
            return None
        return round(sum(serie.values[-months:]) / months, 2)

    def year_to_date(key: str) -> float | None:
        serie = series.get(key)
        if not serie or not serie.last_date:
            return None
        year = serie.last_date[:4]
        return round(sum(v for d, v in zip(serie.dates, serie.values) if d[:4] == year), 2)

    def negative_streak(key: str) -> int | None:
        serie = series.get(key)
        if not serie:
            return None
        streak = 0
        for value in reversed(serie.values):
            if value < 0:
                streak += 1
            else:
                break
        return streak

    financial_keys = [
        "direct_investment_net",
        "portfolio_investment_net",
        "other_investment_net",
    ]
    financial_total_3m = None
    if all(series.get(k) for k in financial_keys):
        parts = [accumulate(k, 3) for k in financial_keys]
        if all(p is not None for p in parts):
            financial_total_3m = round(sum(parts), 2)

    indicators = {}
    for key, spec in by_key.items():
        serie = series[key]
        indicators[key] = {
            "label": spec["label"],
            "group": spec["group"],
            "unit": "USD million",
            "sgs_code": spec["sgs_code"],
            "direction_note": spec["direction_note"],
            "reference_date": serie.last_date,
            "latest": serie.last,
            "previous": (serie.previous(serie.last_date) or (None, None))[1]
            if serie.last_date
            else None,
            "accumulated_3m": accumulate(key, 3),
            "accumulated_12m": accumulate(key, 12),
            "year_to_date": year_to_date(key),
            "moving_average_3m": moving_average(key, 3),
            "moving_average_12m": moving_average(key, 12),
            "negative_month_streak": negative_streak(key),
            "trend": (
                None
                if accumulate(key, 3) is None
                else "entrada_liquida"
                if accumulate(key, 3) > 0
                else "saida_liquida"
                if accumulate(key, 3) < 0
                else "neutro"
            ),
        }

    return {
        "schema": "flow-summary/v1",
        "generated_at": utc_now_iso(),
        "unit": "USD million",
        "reference_date": flow["reference_date"],
        "concept": flow["concept"],
        "not_the_same_as": flow["not_the_same_as"],
        "official_update": flow["official_update"],
        "financial_account_3m_usd_million": financial_total_3m,
        "financial_account_note": (
            "Soma de investimento direto, investimentos em carteira e outros "
            "investimentos nos tres meses mais recentes publicados. Sinal "
            "segue a convencao do BPM6 usada pelo BCB."
        ),
        "indicators": indicators,
    }


# --------------------------------------------------------------------------- #
# patterns
# --------------------------------------------------------------------------- #

def detect_patterns(
    daily: dict[str, dict],
    reserves: Series,
    ptax: Series,
    flow_summary: dict,
    open_temporary: dict,
    anchor_interventions: str,
    effectiveness: dict,
) -> dict:
    found: list[dict] = []

    def add(
        key: str,
        title: str,
        kind: str,
        detected: bool,
        evidence: list[str],
        detail: str,
    ) -> None:
        found.append(
            {
                "key": key,
                "title": title,
                "kind": kind,
                "detected": detected,
                "evidence": evidence,
                "detail": detail,
            }
        )

    w30 = _window_totals(daily, anchor_interventions, 30)
    w90 = _window_totals(daily, anchor_interventions, 90)
    previous_30 = _window_totals(
        daily, (_d(anchor_interventions) - _dt.timedelta(days=30)).isoformat(), 30
    )

    add(
        "sale_frequency_up",
        "Aumento na frequencia de vendas diretas de dolares",
        "tendencia_observada",
        w30["days_with_direct_sale"] > previous_30["days_with_direct_sale"],
        [
            f"{w30['days_with_direct_sale']} dia(s) com venda direta entre "
            f"{w30['from_date']} e {w30['to_date']}",
            f"{previous_30['days_with_direct_sale']} dia(s) nos 30 dias anteriores",
        ],
        "Compara dias com venda direta liquidada em duas janelas de 30 dias.",
    )

    average_now = (
        w30["sold_usd_cents"] / w30["sale_operation_count"]
        if w30["sale_operation_count"]
        else None
    )
    average_before = (
        previous_30["sold_usd_cents"] / previous_30["sale_operation_count"]
        if previous_30["sale_operation_count"]
        else None
    )
    add(
        "average_size_up",
        "Aumento no valor medio das intervencoes",
        "tendencia_observada",
        bool(average_now and average_before and average_now > average_before),
        [
            f"media atual {int(average_now)} centavos de USD" if average_now else "sem venda na janela atual",
            f"media anterior {int(average_before)} centavos de USD" if average_before else "sem venda na janela anterior",
        ],
        "Valor medio por operacao de venda direta em duas janelas de 30 dias.",
    )

    sale_dates = sorted(d for d, v in daily.items() if v["sold_cents"] > 0)
    consecutive = 0
    best_streak = 0
    streak_dates: list[str] = []
    business_days = ptax.dates
    position_of = {date: index for index, date in enumerate(business_days)}
    for date in sale_dates:
        if date not in position_of:
            continue
        if streak_dates and position_of[date] == position_of[streak_dates[-1]] + 1:
            streak_dates.append(date)
        else:
            streak_dates = [date]
        if len(streak_dates) > best_streak:
            best_streak = len(streak_dates)
            consecutive = best_streak
    recent_streak_dates = [d for d in sale_dates if d >= (_d(anchor_interventions) - _dt.timedelta(days=30)).isoformat()]
    add(
        "consecutive_interventions",
        "Intervencoes em dias uteis consecutivos",
        "fato_confirmado",
        len(recent_streak_dates) >= 3,
        [f"datas com venda direta nos ultimos 30 dias: {', '.join(recent_streak_dates) or 'nenhuma'}"],
        f"Maior sequencia historica de dias uteis consecutivos com venda direta: {consecutive}.",
    )

    change_30 = _change_block(reserves, 30, reserves.last_date) if reserves else None
    change_90 = _change_block(reserves, 90, reserves.last_date) if reserves else None
    add(
        "reserves_falling_fast",
        "Reducao acelerada das reservas",
        "tendencia_observada",
        bool(change_30 and change_30["change_pct"] is not None and change_30["change_pct"] <= -1.0),
        [
            f"variacao de 30 dias: {change_30['change_pct']}%" if change_30 else "sem dado",
            f"variacao de 90 dias: {change_90['change_pct']}%" if change_90 else "sem dado",
        ],
        "Criterio desta aplicacao: queda de 1% ou mais em 30 dias.",
    )

    ptax_30 = _change_block(ptax, 30, ptax.last_date) if ptax else None
    ptax_90 = _change_block(ptax, 90, ptax.last_date) if ptax else None
    add(
        "brl_depreciating",
        "Desvalorizacao persistente do real",
        "tendencia_observada",
        bool(
            ptax_30
            and ptax_90
            and ptax_30["change_pct"] is not None
            and ptax_90["change_pct"] is not None
            and ptax_30["change_pct"] > 0
            and ptax_90["change_pct"] > 0
        ),
        [
            f"PTAX em 30 dias: {ptax_30['change_pct']}%" if ptax_30 else "sem dado",
            f"PTAX em 90 dias: {ptax_90['change_pct']}%" if ptax_90 else "sem dado",
        ],
        "Alta do dolar nas duas janelas ao mesmo tempo.",
    )

    financial_3m = flow_summary.get("financial_account_3m_usd_million")
    add(
        "net_outflow",
        "Saida liquida persistente de dolares",
        "tendencia_observada",
        bool(financial_3m is not None and financial_3m < 0),
        [
            f"conta financeira de 3 meses: US$ {financial_3m} milhoes"
            if financial_3m is not None
            else "sem dado"
        ],
        (
            "Baseado no balanco de pagamentos mensal, nao no fluxo cambial "
            "contratado, que nao tem API publica. Saida liquida nao e, por si, "
            "fuga de capital."
        ),
    )

    five_day = effectiveness["summary_since_2015"]["five_days"]
    persisted = five_day["share_pct"].get("real_desvalorizou")
    add(
        "dollar_rises_after_intervention",
        "Alta do dolar mesmo apos intervencoes",
        "tendencia_observada",
        bool(persisted is not None and persisted >= 50),
        [
            f"{persisted}% das vendas diretas desde 2015 foram seguidas de alta "
            f"do dolar em cinco dias uteis"
            if persisted is not None
            else "sem dado"
        ],
        "Comparacao de fechamentos da PTAX, sem inferencia de causalidade.",
    )

    reserves_now = reserves.last if reserves else None
    outstanding_pct = (
        round(open_temporary["outstanding_usd_cents"] / 100 / reserves_now * 100, 4)
        if reserves_now and open_temporary["outstanding_usd_cents"]
        else 0.0
    )
    add(
        "temporary_operations_up",
        "Aumento de operacoes temporarias em aberto",
        "fato_confirmado",
        open_temporary["count"] > 0,
        [
            f"{open_temporary['count']} operacao(oes) em aberto em "
            f"{open_temporary['as_of']}",
            f"equivalente a {outstanding_pct}% das reservas",
        ],
        open_temporary["note"],
    )

    twelve_months_ago = (_d(reserves.last_date) - _dt.timedelta(days=365)).isoformat() if reserves else None
    window_12m = reserves.window(twelve_months_ago, reserves.last_date) if reserves else []
    min_12m = min((v for _, v in window_12m), default=None)
    add(
        "near_12m_low",
        "Aproximacao do menor saldo dos ultimos 12 meses",
        "tendencia_observada",
        bool(
            reserves_now
            and min_12m
            and (reserves_now - min_12m) / min_12m <= 0.005
        ),
        [
            f"saldo atual US$ {reserves_now}" if reserves_now else "sem dado",
            f"minimo de 12 meses US$ {min_12m}" if min_12m else "sem dado",
        ],
        "Criterio desta aplicacao: saldo a 0,5% ou menos do minimo de 12 meses.",
    )

    all_values = reserves.values if reserves else []
    historical_average = (
        round(sum(all_values[-1260:]) / len(all_values[-1260:]), 2)
        if all_values
        else None
    )
    add(
        "below_five_year_average",
        "Mudanca significativa em relacao a media historica",
        "tendencia_observada",
        bool(
            reserves_now
            and historical_average
            and abs(reserves_now - historical_average) / historical_average >= 0.05
        ),
        [
            f"saldo atual US$ {reserves_now}" if reserves_now else "sem dado",
            f"media dos ultimos cinco anos uteis US$ {historical_average}"
            if historical_average
            else "sem dado",
        ],
        "Criterio desta aplicacao: afastamento de 5% ou mais da media de cinco anos.",
    )

    return {
        "schema": "patterns/v1",
        "generated_at": utc_now_iso(),
        "anchor_interventions": anchor_interventions,
        "anchor_reserves": reserves.last_date if reserves else None,
        "anchor_exchange_rate": ptax.last_date if ptax else None,
        "evidence_policy": (
            "Cada padrao lista os dados que levaram a sua identificacao. "
            "'fato_confirmado' vem direto da fonte oficial; "
            "'tendencia_observada' e uma leitura de series, nao previsao."
        ),
        "detected_count": sum(1 for p in found if p["detected"]),
        "patterns": found,
    }


# --------------------------------------------------------------------------- #
# chart series
# --------------------------------------------------------------------------- #

def build_series_file(
    daily: dict[str, dict],
    reserves_cash: Series,
    reserves_liq: Series,
    ptax: Series,
    operations: list[dict],
) -> dict:
    monthly: dict[str, dict] = defaultdict(
        lambda: {
            "sold_cents": 0,
            "bought_cents": 0,
            "temporary_out_cents": 0,
            "swap_traditional_cents": 0,
            "swap_reverse_cents": 0,
            "sale_operations": 0,
            "operations": 0,
            "days_with_sale": 0,
        }
    )
    for date, row in daily.items():
        bucket = monthly[date[:7]]
        bucket["sold_cents"] += row["sold_cents"]
        bucket["bought_cents"] += row["bought_cents"]
        bucket["temporary_out_cents"] += row["temporary_out_cents"]
        bucket["swap_traditional_cents"] += row["swap_traditional_cents"]
        bucket["swap_reverse_cents"] += row["swap_reverse_cents"]
        bucket["sale_operations"] += row["sale_operations"]
        bucket["operations"] += row["operations"]
        bucket["days_with_sale"] += 1 if row["sold_cents"] > 0 else 0

    cumulative = 0
    intervention_daily = []
    for date in sorted(daily):
        row = daily[date]
        cumulative += row["sold_cents"]
        intervention_daily.append(
            {
                "date": date,
                "sold_cents": row["sold_cents"],
                "bought_cents": row["bought_cents"],
                "net_cents": row["bought_cents"] - row["sold_cents"],
                "cumulative_sold_cents": cumulative,
                "temporary_out_cents": row["temporary_out_cents"],
                "temporary_back_cents": row["temporary_back_cents"],
                "swap_traditional_cents": row["swap_traditional_cents"],
                "swap_reverse_cents": row["swap_reverse_cents"],
                "operations": row["operations"],
            }
        )

    reserves_monthly = []
    seen_month: dict[str, tuple[str, float]] = {}
    for date, value in zip(reserves_cash.dates, reserves_cash.values):
        seen_month[date[:7]] = (date, value)
    previous_value = None
    for month in sorted(seen_month):
        date, value = seen_month[month]
        reserves_monthly.append(
            {
                "month": month,
                "date": date,
                "value_usd": value,
                "change_usd": None if previous_value is None else value - previous_value,
                "change_pct": _pct(value, previous_value),
            }
        )
        previous_value = value

    reserves_daily_change = []
    for index in range(1, len(reserves_cash.dates)):
        previous = reserves_cash.values[index - 1]
        current = reserves_cash.values[index]
        reserves_daily_change.append(
            {
                "date": reserves_cash.dates[index],
                "change_usd": current - previous,
                "change_pct": _pct(current, previous),
            }
        )

    distribution = Counter()
    distribution_value = Counter()
    for operation in operations:
        if not operation["counts_as_executed"]:
            continue
        distribution[operation["category"]] += 1
        distribution_value[operation["category"]] += (
            operation["volume_accepted_usd_cents"] or 0
        )

    # Outstanding temporary balance over time, from settlement and maturity legs.
    deltas: dict[str, int] = defaultdict(int)
    for operation in operations:
        if operation["category"] not in TEMPORARY or not operation["counts_as_executed"]:
            continue
        accepted = operation["volume_accepted_usd_cents"] or 0
        if operation["settlement_date"]:
            deltas[operation["settlement_date"]] += accepted
        if operation["maturity_date"]:
            deltas[operation["maturity_date"]] -= accepted
    running = 0
    temporary_outstanding = []
    for date in sorted(deltas):
        running += deltas[date]
        temporary_outstanding.append({"date": date, "outstanding_cents": running})

    swap_deltas: dict[str, int] = defaultdict(int)
    for operation in operations:
        if operation["category"] not in NOTIONAL or not operation["counts_as_executed"]:
            continue
        accepted = operation["volume_accepted_usd_cents"] or 0
        sign = 1 if operation["category"] == "swap_traditional" else -1
        if operation["settlement_date"]:
            swap_deltas[operation["settlement_date"]] += sign * accepted
        if operation["maturity_date"]:
            swap_deltas[operation["maturity_date"]] -= sign * accepted
    running = 0
    swap_outstanding_series = []
    for date in sorted(swap_deltas):
        running += swap_deltas[date]
        swap_outstanding_series.append({"date": date, "net_notional_cents": running})

    return {
        "schema": "indicator-series/v1",
        "generated_at": utc_now_iso(),
        "units": {
            "cents_fields": "USD cents",
            "value_usd": "USD",
            "ptax": "BRL per USD",
        },
        "reserves_cash": [
            {"date": d, "value_usd": v}
            for d, v in zip(reserves_cash.dates, reserves_cash.values)
        ],
        "reserves_liquidity": [
            {"date": d, "value_usd": v}
            for d, v in zip(reserves_liq.dates, reserves_liq.values)
        ],
        "reserves_daily_change": reserves_daily_change,
        "reserves_monthly": reserves_monthly,
        "ptax": [{"date": d, "value": v} for d, v in zip(ptax.dates, ptax.values)],
        "interventions_daily": intervention_daily,
        "interventions_monthly": [
            {"month": month, **values} for month, values in sorted(monthly.items())
        ],
        "distribution_by_category": [
            {
                "category": category,
                "label": CATEGORIES[category]["label"],
                "operation_count": count,
                "accepted_usd_cents": distribution_value[category],
                "is_notional": CATEGORIES[category]["notional"],
            }
            for category, count in distribution.most_common()
        ],
        "temporary_outstanding": temporary_outstanding,
        "swap_net_outstanding": swap_outstanding_series,
    }


# --------------------------------------------------------------------------- #
# pressure index values
# --------------------------------------------------------------------------- #

def pressure_values(
    daily: dict[str, dict],
    reserves: Series,
    ptax: Series,
    flow_summary: dict,
    open_temporary: dict,
    effectiveness: dict,
    anchor_reserves: str,
    anchor_interventions: str,
) -> dict[str, float | None]:
    reserves_now = reserves.as_of(anchor_reserves)
    reserves_value = reserves_now[1] if reserves_now else None

    def reserve_change(days: int) -> float | None:
        if not reserves_value:
            return None
        base = reserves.as_of(
            (_d(anchor_reserves) - _dt.timedelta(days=days)).isoformat()
        )
        return _pct(reserves_value, base[1]) if base else None

    def ptax_change(days: int) -> float | None:
        current = ptax.as_of(ptax.last_date) if ptax else None
        if not current:
            return None
        base = ptax.as_of((_d(ptax.last_date) - _dt.timedelta(days=days)).isoformat())
        return _pct(current[1], base[1]) if base else None

    w30 = _window_totals(daily, anchor_interventions, 30)
    w90 = _window_totals(daily, anchor_interventions, 90)
    previous_90 = _window_totals(
        daily, (_d(anchor_interventions) - _dt.timedelta(days=30)).isoformat(), 90
    )

    sold_30 = w30["sold_usd_cents"] / 100
    sold_90 = w90["sold_usd_cents"] / 100
    monthly_average_before = previous_90["sold_usd_cents"] / 100 / 3

    acceleration = (
        round(sold_30 / monthly_average_before, 4)
        if monthly_average_before > 0
        else (8.0 if sold_30 > 0 else 0.0)
    )

    five_day_share = effectiveness["summary_since_2015"]["five_days"]["share_pct"].get(
        "real_desvalorizou"
    )

    return {
        "reserves_change_30d_pct": reserve_change(30),
        "reserves_change_90d_pct": reserve_change(90),
        "direct_sale_days_30d": float(w30["days_with_direct_sale"]),
        "sold_vs_reserves_90d_pct": (
            round(sold_90 / reserves_value * 100, 4) if reserves_value else None
        ),
        "intervention_acceleration_ratio": acceleration,
        "brl_change_30d_pct": ptax_change(30),
        "brl_change_90d_pct": ptax_change(90),
        "financial_account_3m_usd_million": flow_summary.get(
            "financial_account_3m_usd_million"
        ),
        "persistence_after_intervention_pct": five_day_share,
        "open_temporary_vs_reserves_pct": (
            round(open_temporary["outstanding_usd_cents"] / 100 / reserves_value * 100, 4)
            if reserves_value
            else None
        ),
        "reserves_to_short_term_debt": None,
        "import_coverage_months": None,
    }


def _import_coverage_months(flow: dict, reserves_value: float | None) -> float | None:
    """Reserves divided by the average monthly goods imports of the last year."""
    if not reserves_value:
        return None
    imports = next((s for s in flow["series"] if s["key"] == "goods_imports"), None)
    if not imports:
        return None
    recent = [o["value_usd_million"] for o in imports["observations"][-12:]]
    recent = [v for v in recent if v is not None and v > 0]
    if len(recent) < 6:
        return None
    monthly_average_usd = sum(recent) / len(recent) * 1_000_000
    return round(reserves_value / monthly_average_usd, 3)


def build_spending_days(
    daily: dict[str, dict],
    reserves: Series,
    consolidated_until: str,
    recent: dict | None = None,
) -> dict:
    """Every single day the Banco Central actually spent reserves, since 1999.

    "Spending" means a definitive sale of dollars settling on that date. Sales
    published with a maturity date are excluded, because they come back, and so
    are swaps, which never move the reserves.

    ``daily`` already carries the same-day comunicados merged in, so days after
    ``consolidated_until`` are marked provisional and carry the link to the
    comunicado they came from.
    """
    links: dict[str, list[dict]] = defaultdict(list)
    for auction in (recent or {}).get("auctions", []):
        if not auction.get("parsed") or auction["category"] != "spot_sale":
            continue
        date = auction.get("settlement_date") or auction.get("trade_date")
        if not date:
            continue
        for leg in ("result", "announcement"):
            reference = auction.get(leg)
            if reference and reference not in links[date]:
                links[date].append(reference)

    rows = []
    for date in sorted(daily):
        sold = daily[date]["sold_cents"]
        if sold <= 0:
            continue
        closing = reserves.at(date)
        previous = reserves.previous(date) if closing is not None else None
        provisional = date > consolidated_until
        row = {
            "date": date,
            "sold_usd_cents": sold,
            "temporary_out_usd_cents": daily[date]["temporary_out_cents"],
            "operation_count": daily[date]["sale_operations"],
            "opening_date": previous[0] if previous else None,
            "opening_usd": previous[1] if previous else None,
            "closing_usd": closing,
            "variation_usd": (
                closing - previous[1] if closing is not None and previous else None
            ),
            "variation_pct": _pct(closing, previous[1]) if previous else None,
            "source": "comunicado" if provisional else "dados_abertos",
            "provisional": provisional,
        }
        if provisional:
            row["communications"] = links.get(date, [])
        rows.append(row)

    total = sum(row["sold_usd_cents"] for row in rows)
    by_year: dict[str, dict] = defaultdict(lambda: {"sold_usd_cents": 0, "days": 0})
    for row in rows:
        bucket = by_year[row["date"][:4]]
        bucket["sold_usd_cents"] += row["sold_usd_cents"]
        bucket["days"] += 1

    return {
        "schema": "spending-days/v1",
        "generated_at": utc_now_iso(),
        "unit": "USD cents",
        "concept": (
            "Dias em que o Banco Central vendeu dolares de forma definitiva, "
            "pela data de liquidacao. Nao inclui swaps, que sao nocionais, nem "
            "vendas com retorno contratado, nem operacoes temporarias."
        ),
        "reference_date": rows[-1]["date"] if rows else consolidated_until,
        "consolidated_until": consolidated_until,
        "provisional_count": sum(1 for row in rows if row["provisional"]),
        "coverage_note": (
            f"Lista completa desde o inicio da serie. Ate {consolidated_until} vem "
            "do arquivo mensal consolidado; depois dessa data vem dos "
            "comunicados que o Banco Central publica no mesmo dia do leilao, "
            "marcados como provisorios."
        ),
        "first_date": rows[0]["date"] if rows else None,
        "day_count": len(rows),
        "total_usd_cents": total,
        "by_year": [
            {"year": int(year), **values} for year, values in sorted(by_year.items())
        ],
        "days": rows,
    }


# --------------------------------------------------------------------------- #
# summary
# --------------------------------------------------------------------------- #

def build_summary(
    reserves_index: dict,
    reserves: dict[str, Series],
    ptax_doc: dict,
    ptax: Series,
    ptax_latest: dict | None,
    daily: dict[str, dict],
    interventions: dict,
    open_temporary: dict,
    swap_outstanding: dict,
    flow_summary: dict,
    statement_latest: dict,
    anchor_interventions: str,
    consolidated_until: str,
    operations: list[dict],
) -> dict:

    reserve_blocks = {}
    for concept, series in reserves.items():
        if not series:
            continue
        anchor = series.last_date
        previous = series.previous(anchor)
        twelve_months_ago = (_d(anchor) - _dt.timedelta(days=365)).isoformat()
        window_12m = series.window(twelve_months_ago, anchor)
        all_time_max = max(series.values)
        all_time_max_date = series.dates[series.values.index(all_time_max)]
        reserve_blocks[concept] = {
            "concept": concept,
            "label": next(
                c["label"] for c in reserves_index["concepts"] if c["key"] == concept
            ),
            "unit": "USD",
            "reference_date": anchor,
            "current_usd": series.last,
            "previous_date": previous[0] if previous else None,
            "previous_usd": previous[1] if previous else None,
            "daily_change_usd": (
                None if not previous else series.last - previous[1]
            ),
            "daily_change_pct": (
                None if not previous else _pct(series.last, previous[1])
            ),
            "changes": {str(days): _change_block(series, days, anchor) for days in WINDOWS},
            "all_time_high_usd": all_time_max,
            "all_time_high_date": all_time_max_date,
            "gap_to_all_time_high_usd": series.last - all_time_max,
            "gap_to_all_time_high_pct": _pct(series.last, all_time_max),
            "low_12m_usd": min((v for _, v in window_12m), default=None),
            "low_12m_date": min(window_12m, key=lambda p: p[1])[0] if window_12m else None,
            "high_12m_usd": max((v for _, v in window_12m), default=None),
            "observation_count": len(series.values),
            "first_date": series.dates[0] if series.dates else None,
        }

    windows = {str(days): _window_totals(daily, anchor_interventions, days) for days in WINDOWS}

    executed_sales = sorted(
        (
            o
            for o in operations
            if o["category"] == "spot_sale" and o["counts_as_executed"]
        ),
        key=lambda o: (o["settlement_date"] or o["trade_date"] or ""),
    )
    last_sale = executed_sales[-1] if executed_sales else None
    executed_any = [o for o in operations if o["counts_as_executed"]]
    last_operation = (
        sorted(executed_any, key=lambda o: o["trade_date"] or "")[-1]
        if executed_any
        else None
    )

    anchor_row = daily.get(anchor_interventions)

    ptax_anchor = ptax.last_date
    ptax_12m = ptax.window(
        (_d(ptax_anchor) - _dt.timedelta(days=365)).isoformat(), ptax_anchor
    )
    previous_ptax = ptax.previous(ptax_anchor)
    latest_bulletin = (ptax_latest or {}).get("bulletins", [])
    market = {
        "ptax": {
            "unit": "BRL per USD",
            "reference_date": ptax_anchor,
            "published_at_sao_paulo": (
                latest_bulletin[-1]["published_at_sao_paulo"] if latest_bulletin else None
            ),
            "sell": ptax.last,
            "buy": next(
                (
                    o["buy"]
                    for o in reversed(ptax_doc["observations"])
                    if o["date"] == ptax_anchor
                ),
                None,
            ),
            "previous_date": previous_ptax[0] if previous_ptax else None,
            "previous_sell": previous_ptax[1] if previous_ptax else None,
            "daily_change_pct": (
                _pct(ptax.last, previous_ptax[1]) if previous_ptax else None
            ),
            "changes": {
                "7": _change_block(ptax, 7, ptax_anchor),
                "30": _change_block(ptax, 30, ptax_anchor),
                "365": _change_block(ptax, 365, ptax_anchor),
            },
            "high_12m": max((v for _, v in ptax_12m), default=None),
            "high_12m_date": max(ptax_12m, key=lambda p: p[1])[0] if ptax_12m else None,
            "low_12m": min((v for _, v in ptax_12m), default=None),
            "low_12m_date": min(ptax_12m, key=lambda p: p[1])[0] if ptax_12m else None,
            "concept": ptax_doc["concept"],
            "official_update": ptax_doc["official_update"],
        },
        "spot_quote": {
            "available_server_side": False,
            "note": (
                "O BCB nao publica cotacao de mercado em tempo real. A cotacao "
                "ao vivo do painel e buscada no navegador em fonte secundaria e "
                "identificada como tal."
            ),
            "browser_source": {
                "name": "AwesomeAPI - cotacao USD/BRL",
                "endpoint": "https://economia.awesomeapi.com.br/json/last/USD-BRL",
                "classification": "fonte_secundaria",
                "cors_enabled": True,
            },
        },
    }

    return {
        "schema": "indicator-summary/v1",
        "generated_at": utc_now_iso(),
        "anchors": {
            "reserves": reserve_blocks.get("cash", {}).get("reference_date"),
            "interventions": anchor_interventions,
            "exchange_rate": ptax_anchor,
            "exchange_flow": flow_summary["reference_date"],
        },
        "anchor_note": (
            "Cada bloco usa a data de referencia da sua propria fonte. As "
            "atuacoes no mercado de cambio tem divulgacao mensal e por isso a "
            "ancora delas e anterior a das reservas e do cambio."
        ),
        "reserves": reserve_blocks,
        "reserves_default_concept": "cash",
        "interventions": {
            "unit": "USD cents",
            "anchor_date": anchor_interventions,
            "consolidated_until": consolidated_until,
            "covered_until": anchor_interventions,
            # Sem datas no texto: cada pagina compoe a frase com as datas
            # ja formatadas, para nao mostrar ISO ao leitor.
            "coverage_note": (
                "Os numeros vem do arquivo mensal consolidado do Banco Central "
                "ate a data de consolidacao e, dali em diante, dos comunicados "
                "que o Banco Central publica no mesmo dia do leilao, marcados "
                "como provisorios ate o arquivo mensal alcanca-los."
            ),
            "anchor_day": {
                "date": anchor_interventions,
                "available": anchor_row is not None,
                "sold_usd_cents": (anchor_row or {}).get("sold_cents"),
                "bought_usd_cents": (anchor_row or {}).get("bought_cents"),
                "note": (
                    "Ultimo dia coberto pela fonte oficial de atuacoes, nao o dia "
                    "de hoje."
                ),
            },
            "windows": windows,
            "total_operations": len(operations),
            "executed_operations": interventions["executed_count"],
            "by_category": interventions["statistics"]["by_category"],
            "by_status": interventions["statistics"]["by_status"],
            "last_direct_sale": (
                {
                    "id": last_sale["id"],
                    "trade_date": last_sale["trade_date"],
                    "settlement_date": last_sale["settlement_date"],
                    "accepted_usd_cents": last_sale["volume_accepted_usd_cents"],
                    "offered_usd_cents": last_sale["volume_offered_usd_cents"],
                    "modality": last_sale["modality"],
                    "cut_rate": last_sale["cut_rate"],
                    "communication_number": last_sale["communication_number"],
                    "provisional": bool(last_sale.get("provisional")),
                }
                if last_sale
                else None
            ),
            "last_operation": (
                {
                    "id": last_operation["id"],
                    "category": last_operation["category"],
                    "category_label": CATEGORIES[last_operation["category"]]["label"],
                    "trade_date": last_operation["trade_date"],
                    "accepted_usd_cents": last_operation["volume_accepted_usd_cents"],
                }
                if last_operation
                else None
            ),
            "open_temporary": open_temporary,
            "swap_outstanding": swap_outstanding,
            "official_update": interventions["official_update"],
            "known_limitations": interventions["known_limitations"],
        },
        "market": market,
        "exchange_flow": {
            "reference_date": flow_summary["reference_date"],
            "financial_account_3m_usd_million": flow_summary[
                "financial_account_3m_usd_million"
            ],
            "indicators": flow_summary["indicators"],
            "not_the_same_as": flow_summary["not_the_same_as"],
        },
        "latest_statement_day": (
            statement_latest["days"][-1] if statement_latest.get("days") else None
        ),
    }


def main() -> int:
    interventions = read_json(DATA / "interventions" / "operations.json")
    reserves_index = read_json(DATA / "reserves" / "index.json")
    ptax_doc = read_json(DATA / "exchange-rates" / "ptax.json")
    flow = read_json(DATA / "exchange-flow" / "balance-of-payments.json")
    statement_latest = read_json(DATA / "reserves" / "statement-latest-cash.json") or {}
    ptax_latest = read_json(DATA / "exchange-rates" / "ptax-latest.json")

    missing = [
        name
        for name, value in [
            ("interventions", interventions),
            ("reserves", reserves_index),
            ("ptax", ptax_doc),
            ("exchange flow", flow),
        ]
        if not value
    ]
    if missing:
        log.error("missing inputs: %s", ", ".join(missing))
        record_source_state(
            "indicators", status="blocked", detail=f"missing: {', '.join(missing)}"
        )
        return 1

    reserves: dict[str, Series] = {}
    for concept in ("cash", "liquidity"):
        document = read_json(DATA / "reserves" / f"{concept}.json")
        if document:
            reserves[concept] = Series(
                [(o["date"], o["value_usd"]) for o in document["observations"]]
            )
    ptax = Series([(o["date"], o["sell"]) for o in ptax_doc["observations"]])

    recent_auctions = read_json(DATA / "interventions" / "recent-auctions.json")
    operations = interventions["operations"]
    daily = _daily_intervention_aggregates(operations)
    consolidated_until = interventions["reference_date"]
    daily, operations, covered_until = merge_recent_auctions(
        daily, operations, recent_auctions
    )
    # A âncora passa a ser até onde há informação apurada, não até onde o
    # arquivo mensal chegou.
    anchor_interventions = max(
        [consolidated_until] + ([covered_until] if covered_until else [])
    )
    open_temporary = _open_temporary(operations, anchor_interventions)
    swap_outstanding = _swap_outstanding(operations, anchor_interventions)

    flow_summary = build_flow_summary(flow)
    effectiveness = build_effectiveness(operations, ptax)
    summary = build_summary(
        reserves_index,
        reserves,
        ptax_doc,
        ptax,
        ptax_latest,
        daily,
        interventions,
        open_temporary,
        swap_outstanding,
        flow_summary,
        statement_latest,
        anchor_interventions,
        consolidated_until,
        operations,
    )

    reserves_cash = reserves.get("cash") or Series([])
    values = pressure_values(
        daily,
        reserves_cash,
        ptax,
        flow_summary,
        open_temporary,
        effectiveness,
        reserves_cash.last_date or anchor_interventions,
        anchor_interventions,
    )
    values["import_coverage_months"] = _import_coverage_months(flow, reserves_cash.last)
    pressure = compute_pressure(values)
    pressure.update(
        {
            "schema": "pressure-index/v1",
            "generated_at": utc_now_iso(),
            "reference_dates": summary["anchors"],
            "observed_values": values,
        }
    )

    history = _pressure_history(
        daily,
        reserves_cash,
        ptax,
        flow,
        flow_summary,
        operations,
        effectiveness,
        anchor_interventions,
    )
    pressure["history"] = history

    patterns = detect_patterns(
        daily,
        reserves_cash,
        ptax,
        flow_summary,
        open_temporary,
        anchor_interventions,
        effectiveness,
    )

    series_file = build_series_file(
        daily,
        reserves_cash,
        reserves.get("liquidity") or Series([]),
        ptax,
        operations,
    )

    write_json(
        DATA / "indicators" / "spending-days.json",
        build_spending_days(daily, reserves_cash, consolidated_until, recent_auctions),
        compact=True,
    )
    write_json(DATA / "indicators" / "summary.json", summary)
    write_json(DATA / "indicators" / "flow.json", flow_summary, compact=True)
    write_json(DATA / "indicators" / "effectiveness.json", effectiveness, compact=True)
    write_json(DATA / "indicators" / "pressure.json", pressure)
    write_json(DATA / "indicators" / "patterns.json", patterns)
    write_json(DATA / "indicators" / "series.json", series_file, compact=True)

    record_source_state(
        "indicators",
        status="ok",
        reference_date=summary["anchors"]["reserves"],
        record_count=len(series_file["interventions_daily"]),
    )
    log.info(
        "indicators built: pressure=%s (coverage %s%%), patterns detected=%s",
        pressure["score"],
        pressure["coverage_pct"],
        patterns["detected_count"],
    )
    return 0


def _pressure_history(
    daily: dict[str, dict],
    reserves: Series,
    ptax: Series,
    flow: dict,
    flow_summary: dict,
    operations: list[dict],
    effectiveness: dict,
    anchor_interventions: str,
) -> list[dict]:
    """Recompute the index at month ends over the last five years."""
    if not reserves or not ptax:
        return []
    points = []
    end = _d(anchor_interventions)
    cursor = end.replace(day=1)
    for _ in range(60):
        anchor = (cursor - _dt.timedelta(days=1)).isoformat()
        if anchor < max(reserves.dates[0], ptax.dates[0]):
            break
        open_temporary = _open_temporary(operations, anchor)
        values = pressure_values(
            daily,
            reserves,
            Series(list(zip(ptax.dates, ptax.values))[: bisect_right(ptax.dates, anchor)]),
            flow_summary,
            open_temporary,
            effectiveness,
            (reserves.as_of(anchor) or (anchor, None))[0],
            anchor,
        )
        values["import_coverage_months"] = _import_coverage_months(
            flow, (reserves.as_of(anchor) or (None, None))[1]
        )
        result = compute_pressure(values)
        points.append(
            {
                "date": anchor,
                "score": result["score"],
                "coverage_pct": result["coverage_pct"],
                "classification": result["classification"]["key"],
            }
        )
        cursor = (cursor - _dt.timedelta(days=1)).replace(day=1)
    return list(reversed(points))


if __name__ == "__main__":
    sys.exit(main())
