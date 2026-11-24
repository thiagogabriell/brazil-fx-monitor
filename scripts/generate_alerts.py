#!/usr/bin/env python3
"""Evaluate the default alert rules against the published data.

Only the default thresholds are evaluated here, because this runs in GitHub
Actions and has no access to a user's preferences. The interface re-evaluates
the same rules in the browser using the thresholds stored in LocalStorage, from
the same rule definitions exported to ``data/alerts/rules.json``.
"""

from __future__ import annotations

import datetime as _dt
import sys

from alert_rules import RULES, RULES_BY_KEY, STALENESS_TOLERANCE_DAYS
from common import (
    DATA,
    log,
    read_json,
    record_source_state,
    sao_paulo_now,
    today_sp,
    utc_now_iso,
    write_json,
)

HISTORY_LIMIT = 2000


def _alert(
    key: str,
    *,
    reference_date: str | None,
    observed_value,
    threshold,
    description: str,
    severity: str | None = None,
    extra: dict | None = None,
) -> dict:
    rule = RULES_BY_KEY[key]
    now = sao_paulo_now()
    return {
        "id": f"{key}:{reference_date or now.date().isoformat()}",
        "rule_key": key,
        "label": rule["label"],
        "indicator": rule["indicator"],
        "severity": severity or rule["severity"],
        "unit": rule["unit"],
        "observed_value": observed_value,
        "threshold": threshold,
        "comparison": rule["comparison"],
        "description": description,
        "source": rule["source"],
        "page": rule["page"],
        "reference_date": reference_date,
        "detected_date_sao_paulo": now.date().isoformat(),
        "detected_time_sao_paulo": now.strftime("%H:%M:%S"),
        "detected_at_utc": utc_now_iso(),
        "thresholds_used": "padrao",
        **(extra or {}),
    }


def _bi(cents: int | None) -> str:
    if not cents:
        return "US$ 0"
    return f"US$ {cents / 100 / 1_000_000_000:,.3f} bilhoes"


def evaluate(summary: dict, series: dict, state: dict, announcements: dict) -> list[dict]:
    alerts: list[dict] = []
    interventions = summary["interventions"]
    windows = interventions["windows"]
    anchor = interventions["anchor_date"]

    # --- direct sales --------------------------------------------------- #
    daily_rows = series["interventions_daily"]
    peak_day = max(daily_rows, key=lambda r: r["sold_cents"], default=None)
    recent = [r for r in daily_rows if r["date"] >= (_dt.date.fromisoformat(anchor) - _dt.timedelta(days=30)).isoformat()]
    worst_recent = max(recent, key=lambda r: r["sold_cents"], default=None)
    rule = RULES_BY_KEY["direct_sale_day_above_1bn"]
    if worst_recent and worst_recent["sold_cents"] / 100 >= rule["default_threshold"]:
        alerts.append(
            _alert(
                "direct_sale_day_above_1bn",
                reference_date=worst_recent["date"],
                observed_value=worst_recent["sold_cents"] / 100,
                threshold=rule["default_threshold"],
                description=(
                    f"Em {worst_recent['date']} foram liquidados "
                    f"{_bi(worst_recent['sold_cents'])} em vendas diretas de "
                    "dolares."
                ),
            )
        )

    for key, window in (
        ("direct_sale_7d_above_5bn", "7"),
        ("direct_sale_30d_above_10bn", "30"),
    ):
        rule = RULES_BY_KEY[key]
        total = windows[window]["sold_usd_cents"] / 100
        if total >= rule["default_threshold"]:
            alerts.append(
                _alert(
                    key,
                    reference_date=anchor,
                    observed_value=total,
                    threshold=rule["default_threshold"],
                    description=(
                        f"Vendas diretas de {_bi(windows[window]['sold_usd_cents'])} "
                        f"entre {windows[window]['from_date']} e "
                        f"{windows[window]['to_date']}."
                    ),
                )
            )

    # --- reserves ------------------------------------------------------- #
    reserves = summary["reserves"].get("cash")
    if reserves:
        for key, window in (
            ("reserves_drop_7d_above_1pct", "7"),
            ("reserves_drop_30d_above_2pct", "30"),
            ("reserves_drop_90d_above_5pct", "90"),
        ):
            rule = RULES_BY_KEY[key]
            change = reserves["changes"][window]["change_pct"]
            if change is not None and change <= rule["default_threshold"]:
                alerts.append(
                    _alert(
                        key,
                        reference_date=reserves["reference_date"],
                        observed_value=change,
                        threshold=rule["default_threshold"],
                        description=(
                            f"As reservas caíram {change:.2f}% em {window} dias, "
                            f"de {reserves['changes'][window]['from_date']} a "
                            f"{reserves['reference_date']}."
                        ),
                    )
                )

    # --- exchange rate -------------------------------------------------- #
    ptax = summary["market"]["ptax"]
    for key in ("usd_above_6", "usd_above_6_5", "usd_above_7"):
        rule = RULES_BY_KEY[key]
        if ptax["sell"] is not None and ptax["sell"] >= rule["default_threshold"]:
            alerts.append(
                _alert(
                    key,
                    reference_date=ptax["reference_date"],
                    observed_value=ptax["sell"],
                    threshold=rule["default_threshold"],
                    description=(
                        f"A PTAX de venda fechou em R$ {ptax['sell']:.4f} em "
                        f"{ptax['reference_date']}."
                    ),
                )
            )

    rule = RULES_BY_KEY["usd_up_7d_above_5pct"]
    change_7d = ptax["changes"]["7"]["change_pct"]
    if change_7d is not None and change_7d >= rule["default_threshold"]:
        alerts.append(
            _alert(
                "usd_up_7d_above_5pct",
                reference_date=ptax["reference_date"],
                observed_value=change_7d,
                threshold=rule["default_threshold"],
                description=(
                    f"A PTAX subiu {change_7d:.2f}% em 7 dias, de "
                    f"{ptax['changes']['7']['from_date']} a {ptax['reference_date']}."
                ),
            )
        )

    # --- consecutive intervention days ---------------------------------- #
    ptax_dates = [point["date"] for point in series["ptax"]]
    position = {date: index for index, date in enumerate(ptax_dates)}
    sale_dates = [r["date"] for r in daily_rows if r["sold_cents"] > 0 and r["date"] in position]
    streak: list[str] = []
    longest_recent: list[str] = []
    for date in sale_dates:
        if streak and position[date] == position[streak[-1]] + 1:
            streak.append(date)
        else:
            streak = [date]
        if len(streak) >= 3 and streak[-1] >= (
            _dt.date.fromisoformat(anchor) - _dt.timedelta(days=365)
        ).isoformat():
            longest_recent = list(streak)
    if longest_recent:
        alerts.append(
            _alert(
                "three_consecutive_intervention_days",
                reference_date=longest_recent[-1],
                observed_value=len(longest_recent),
                threshold=3,
                description=(
                    "Vendas diretas liquidadas em dias uteis consecutivos: "
                    + ", ".join(longest_recent)
                ),
            )
        )

    # --- flows ----------------------------------------------------------- #
    flow_indicators = summary["exchange_flow"]["indicators"]
    portfolio = flow_indicators.get("portfolio_investment_net")
    rule = RULES_BY_KEY["financial_account_negative_streak"]
    if portfolio and (portfolio["negative_month_streak"] or 0) >= rule["default_threshold"]:
        alerts.append(
            _alert(
                "financial_account_negative_streak",
                reference_date=portfolio["reference_date"],
                observed_value=portfolio["negative_month_streak"],
                threshold=rule["default_threshold"],
                description=(
                    f"{portfolio['negative_month_streak']} meses consecutivos com "
                    "investimentos em carteira negativos, segundo o balanco de "
                    "pagamentos."
                ),
            )
        )

    # --- dollar still rising after interventions ------------------------- #
    effectiveness = read_json(DATA / "indicators" / "effectiveness.json") or {}
    cases = effectiveness.get("cases", [])
    if cases:
        last_case = cases[-1]
        window_cases = [
            case
            for case in cases
            if case["trade_date"]
            >= (_dt.date.fromisoformat(last_case["trade_date"]) - _dt.timedelta(days=30)).isoformat()
        ]
        change = last_case.get("change_five_days_pct")
        if len(window_cases) >= 2 and change is not None and change > 0:
            alerts.append(
                _alert(
                    "usd_rising_after_interventions",
                    reference_date=last_case["trade_date"],
                    observed_value=change,
                    threshold=0.0,
                    description=(
                        f"Apos a venda direta de {last_case['trade_date']} a PTAX "
                        f"subiu {change:.2f}% em cinco dias uteis, com "
                        f"{len(window_cases)} vendas diretas na janela de 30 dias."
                    ),
                )
            )

    # --- new communication ----------------------------------------------- #
    entries = announcements.get("announcements", [])
    if entries:
        newest = entries[0]
        alerts.append(
            _alert(
                "new_intervention_communication",
                reference_date=newest["first_trade_date"] or newest.get("trade_dates", [None])[0],
                observed_value=newest["communication_number"],
                threshold=None,
                description=(
                    f"Comunicado {newest['communication_number']} publicado em "
                    f"{newest['published_at_sao_paulo']}, com "
                    f"{newest['operation_count']} operacao(oes)."
                ),
                extra={"official_url": newest["official_url"]},
            )
        )

    # --- source health ---------------------------------------------------- #
    today = today_sp()
    for key, entry in (state.get("sources") or {}).items():
        status = entry.get("status")
        if status == "unavailable_by_design":
            # A documented absence in the official source is not a failure.
            continue
        if status != "ok":
            alerts.append(
                _alert(
                    "collection_failure",
                    reference_date=entry.get("last_successful_reference_date"),
                    observed_value=entry.get("status"),
                    threshold="ok",
                    description=(
                        f"A fonte '{key}' terminou com status "
                        f"'{entry.get('status')}'. {entry.get('detail') or ''}".strip()
                    ),
                    severity="alta",
                    extra={"source_key": key},
                )
            )
            continue
        reference = entry.get("reference_date")
        tolerance = STALENESS_TOLERANCE_DAYS.get(key)
        if reference and tolerance:
            age = (today - _dt.date.fromisoformat(reference)).days
            if age > tolerance:
                alerts.append(
                    _alert(
                        "stale_source",
                        reference_date=reference,
                        observed_value=age,
                        threshold=tolerance,
                        description=(
                            f"A fonte '{key}' tem data de referencia {reference}, "
                            f"ou seja {age} dias atras, acima da tolerancia de "
                            f"{tolerance} dias para a sua periodicidade."
                        ),
                        extra={"source_key": key},
                    )
                )

    order = {"critica": 0, "alta": 1, "atencao": 2, "info": 3}
    alerts.sort(key=lambda a: (order.get(a["severity"], 9), a["reference_date"] or ""))
    return alerts


def main() -> int:
    summary = read_json(DATA / "indicators" / "summary.json")
    series = read_json(DATA / "indicators" / "series.json")
    state = read_json(DATA / "metadata" / "collection-state.json") or {}
    announcements = read_json(DATA / "interventions" / "announcements.json") or {}
    if not summary or not series:
        log.error("indicators not built yet")
        record_source_state("alerts", status="blocked", detail="indicators missing")
        return 1

    active = evaluate(summary, series, state, announcements)

    write_json(
        DATA / "alerts" / "active.json",
        {
            "schema": "alerts-active/v1",
            "generated_at": utc_now_iso(),
            "timezone": "America/Sao_Paulo",
            "thresholds": "padrao",
            "disclaimer": (
                "Os limites sao criterios configuraveis de monitoramento desta "
                "aplicacao e nao indicadores oficiais de crise."
            ),
            "count": len(active),
            "by_severity": {
                severity: sum(1 for a in active if a["severity"] == severity)
                for severity in ("critica", "alta", "atencao", "info")
            },
            "alerts": active,
        },
    )

    history_path = DATA / "alerts" / "history.json"
    history = read_json(history_path) or {"schema": "alerts-history/v1", "alerts": []}
    known = {a["id"] for a in history["alerts"]}
    added = [a for a in active if a["id"] not in known]
    history["alerts"] = (history["alerts"] + added)[-HISTORY_LIMIT:]
    history["updated_at"] = utc_now_iso()
    history["count"] = len(history["alerts"])
    write_json(history_path, history, compact=True)

    write_json(
        DATA / "alerts" / "rules.json",
        {
            "schema": "alert-rules/v1",
            "generated_at": utc_now_iso(),
            "note": (
                "Definicoes usadas tanto pelas rotinas automaticas quanto pelo "
                "navegador. No navegador os limites podem ser alterados e ficam "
                "no LocalStorage."
            ),
            "severities": ["critica", "alta", "atencao", "info"],
            "staleness_tolerance_days": STALENESS_TOLERANCE_DAYS,
            "rules": RULES,
        },
    )

    record_source_state(
        "alerts", status="ok", reference_date=summary["anchors"]["reserves"], record_count=len(active)
    )
    log.info("alerts: %s active, %s new in history", len(active), len(added))
    return 0


if __name__ == "__main__":
    sys.exit(main())
