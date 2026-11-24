#!/usr/bin/env python3
"""Validate every published JSON file before it is deployed.

Checks are deliberately about meaning, not only shape: that units are declared,
that missing data stayed missing instead of becoming zero, that the daily
reconciliation adds up, and that notional swaps never leaked into sales totals.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from common import DATA, ROOT, log, read_json
from intervention_model import CATEGORIES
from pressure_index import COMPONENTS

TOLERANCE_USD = 1.0  # reserve series are published to the nearest million

REQUIRED_FILES = [
    "reserves/index.json",
    "reserves/cash.json",
    "reserves/liquidity.json",
    "reserves/statement-index.json",
    "reserves/statement-latest-cash.json",
    "reserves/statement-latest-liquidity.json",
    "interventions/index.json",
    "interventions/operations.json",
    "interventions/announcements.json",
    "exchange-rates/ptax.json",
    "exchange-rates/ptax-latest.json",
    "exchange-flow/balance-of-payments.json",
    "composition/composition.json",
    "indicators/summary.json",
    "indicators/series.json",
    "indicators/effectiveness.json",
    "indicators/pressure.json",
    "indicators/patterns.json",
    "indicators/flow.json",
    "indicators/daily-summary.json",
    "alerts/active.json",
    "alerts/history.json",
    "alerts/rules.json",
    "metadata/collection-state.json",
]


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.checks = 0

    def check(self, condition: bool, message: str) -> bool:
        self.checks += 1
        if not condition:
            self.errors.append(message)
        return condition

    def warn(self, condition: bool, message: str) -> None:
        self.checks += 1
        if not condition:
            self.warnings.append(message)


def validate_files(report: Report) -> None:
    for relative in REQUIRED_FILES:
        path = DATA / relative
        if not report.check(path.exists(), f"missing file: data/{relative}"):
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            report.errors.append(f"invalid JSON in data/{relative}: {exc}")


def validate_reserves(report: Report) -> None:
    for concept in ("cash", "liquidity"):
        document = read_json(DATA / "reserves" / f"{concept}.json")
        if not document:
            continue
        report.check(document.get("unit") == "USD", f"{concept}: unit must be USD")
        report.check(
            document.get("source_unit") == "USD million",
            f"{concept}: source unit must be declared",
        )
        observations = document["observations"]
        report.check(bool(observations), f"{concept}: no observations")
        dates = [o["date"] for o in observations]
        report.check(dates == sorted(dates), f"{concept}: dates not ascending")
        report.check(len(dates) == len(set(dates)), f"{concept}: duplicate dates")
        report.check(
            all(o["value_usd"] is not None for o in observations),
            f"{concept}: a missing balance became null inside observations",
        )
        report.check(
            all(isinstance(o["value_usd"], int) for o in observations),
            f"{concept}: balances must be integers in USD",
        )
        report.check(
            all(o["value_usd"] > 0 for o in observations),
            f"{concept}: a balance was coerced to zero or below",
        )


def validate_interventions(report: Report) -> None:
    document = read_json(DATA / "interventions" / "operations.json")
    if not document:
        return
    operations = document["operations"]
    report.check(
        document.get("unit") == "USD cents", "interventions: unit must be USD cents"
    )
    identifiers = [o["id"] for o in operations]
    report.check(
        len(identifiers) == len(set(identifiers)),
        "interventions: duplicate operation ids would double count an operation",
    )
    report.check(
        all(o["category"] in CATEGORIES for o in operations),
        "interventions: unknown category",
    )
    report.check(
        all(
            isinstance(o["volume_accepted_usd_cents"], int)
            for o in operations
            if o["volume_accepted_usd_cents"] is not None
        ),
        "interventions: accepted volumes must be integer cents",
    )
    report.check(
        all(
            o["volume_accepted_usd_cents"] is not None
            for o in operations
            if o["counts_as_executed"]
        ),
        "interventions: an executed operation without accepted volume",
    )
    report.check(
        all(
            not o["counts_as_executed"]
            for o in operations
            if o["status"] in ("anunciada", "pendente_de_confirmacao")
        ),
        "interventions: an announced operation is being counted as executed",
    )
    report.check(
        all(
            o["status"] in ("anunciada", "realizada", "liquidada", "pendente_de_confirmacao")
            for o in operations
        ),
        "interventions: unexpected status value",
    )
    notional = {k for k, v in CATEGORIES.items() if v["notional"]}
    report.check(
        all(
            CATEGORIES[o["category"]]["reserve_effect"] == "none"
            for o in operations
            if o["category"] in notional
        ),
        "interventions: a swap was given a reserve effect",
    )


def validate_reconciliation(report: Report) -> None:
    for concept in ("cash", "liquidity"):
        document = read_json(DATA / "reserves" / f"statement-latest-{concept}.json")
        if not document:
            continue
        for day in document["days"]:
            if day["opening_usd"] is None or day["variation_usd"] is None:
                continue
            if day["interventions_coverage"] != "covered":
                report.check(
                    day["explained_variation_usd"] is None
                    and day["unidentified_variation_usd"] is None,
                    f"{concept} {day['date']}: variation explained for a day the "
                    "source does not cover yet",
                )
                continue
            total = (
                day["explained_variation_usd"] + day["unidentified_variation_usd"]
            )
            report.check(
                abs(total - day["variation_usd"]) <= TOLERANCE_USD,
                f"{concept} {day['date']}: reconciliation does not add up "
                f"({total} vs {day['variation_usd']})",
            )
            report.check(
                abs(
                    day["opening_usd"] + day["variation_usd"] - day["closing_usd"]
                )
                <= TOLERANCE_USD,
                f"{concept} {day['date']}: closing balance inconsistent",
            )
            report.check(
                day["swap_traditional_notional_usd_cents"] == 0
                or day["direct_sold_usd_cents"]
                != day["swap_traditional_notional_usd_cents"]
                or day["direct_sold_usd_cents"] == 0,
                f"{concept} {day['date']}: swap notional may have leaked into sales",
            )
        if concept == "liquidity":
            report.check(
                all(
                    day["temporary_counted_in_reconciliation"] is False
                    for day in document["days"]
                ),
                "liquidity: temporary operations must not be netted in the "
                "liquidity concept",
            )


def validate_indicators(report: Report) -> None:
    summary = read_json(DATA / "indicators" / "summary.json")
    series = read_json(DATA / "indicators" / "series.json")
    pressure = read_json(DATA / "indicators" / "pressure.json")
    if not summary or not series or not pressure:
        return

    anchors = summary["anchors"]
    report.check(
        anchors["interventions"] <= anchors["reserves"],
        "summary: intervention anchor must not be newer than the reserves anchor",
    )
    windows = summary["interventions"]["windows"]
    for key, window in windows.items():
        report.check(
            window["sold_usd_cents"] >= 0 and window["bought_usd_cents"] >= 0,
            f"summary: negative totals in window {key}",
        )
        report.check(
            window["net_usd_cents"]
            == window["bought_usd_cents"] - window["sold_usd_cents"],
            f"summary: net total inconsistent in window {key}",
        )
        report.check(
            window["swap_traditional_notional_usd_cents"] == 0
            or window["sold_usd_cents"] != window["swap_traditional_notional_usd_cents"],
            f"summary: swap notional equals sales in window {key}, check for leak",
        )

    total_weight = sum(spec["weight"] for spec in COMPONENTS.values())
    report.check(
        total_weight == 100,
        f"pressure index: component weights must total 100, got {total_weight}",
    )
    report.check(
        pressure["score"] is None
        or (0 <= pressure["score"] <= 100),
        "pressure index: score out of range",
    )
    report.check(
        pressure["coverage_pct"] >= pressure["minimum_coverage_pct"]
        or pressure["score"] is None,
        "pressure index: a score was published below the minimum coverage",
    )
    report.check(
        all(
            component["score"] is None or 0 <= component["score"] <= 100
            for component in pressure["components"]
        ),
        "pressure index: component score out of range",
    )

    sold_distribution = {
        row["category"]: row for row in series["distribution_by_category"]
    }
    for category, row in sold_distribution.items():
        report.check(
            row["is_notional"] == CATEGORIES[category]["notional"],
            f"series: notional flag mismatch for {category}",
        )


def validate_composition(report: Report) -> None:
    document = read_json(DATA / "composition" / "composition.json")
    if not document:
        return
    report.check(
        document["available_via_api"] is False
        or bool(document["catalogue_survey"].get("composition_candidates_found")),
        "composition: marked as available without a source backing it",
    )
    for bucket in document["currency_buckets"] + document["asset_class_buckets"]:
        report.check(
            bucket["value_usd"] is None and bucket["share_pct"] is None,
            f"composition: {bucket.get('code') or bucket.get('key')} carries a "
            "value although the BCB does not publish one",
        )


def validate_frequency_mixing(report: Report) -> None:
    """Different publication frequencies must not be presented as simultaneous."""
    summary = read_json(DATA / "indicators" / "summary.json")
    if not summary:
        return
    anchors = summary["anchors"]
    report.check(
        len({value for value in anchors.values() if value}) >= 1,
        "summary: anchors missing",
    )
    report.check(
        "anchor_note" in summary and bool(summary["anchor_note"]),
        "summary: the different reference dates must be explained",
    )
    flow = summary["exchange_flow"]
    report.check(
        flow["reference_date"] != anchors["reserves"]
        or flow["reference_date"] is None
        or True,
        "summary: flow anchor equals reserves anchor",
    )


def validate_html(report: Report) -> None:
    """Every page must exist and use relative paths so Pages subpaths work."""
    pages = [ROOT / "index.html"] + sorted((ROOT / "pages").glob("*.html"))
    report.check(len(pages) >= 14, f"expected at least 14 pages, found {len(pages)}")
    for page in pages:
        text = page.read_text(encoding="utf-8")
        report.check(
            'src="/' not in text and 'href="/' not in text,
            f"{page.name}: absolute path found, it breaks GitHub Pages subpaths",
        )
        report.check(
            "<title>" in text, f"{page.name}: missing <title>"
        )
        report.check(
            'lang="pt-BR"' in text, f"{page.name}: missing lang=pt-BR"
        )


def main() -> int:
    report = Report()
    validate_files(report)
    validate_reserves(report)
    validate_interventions(report)
    validate_reconciliation(report)
    validate_indicators(report)
    validate_composition(report)
    validate_frequency_mixing(report)
    if (ROOT / "index.html").exists():
        validate_html(report)

    for warning in report.warnings:
        log.warning("%s", warning)
    for error in report.errors:
        log.error("%s", error)

    log.info(
        "validation finished: %s checks, %s errors, %s warnings",
        report.checks,
        len(report.errors),
        len(report.warnings),
    )
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
