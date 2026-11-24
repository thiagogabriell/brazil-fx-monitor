"""Parsing, units and date handling."""

from __future__ import annotations

import datetime as _dt
from decimal import Decimal

import pytest

import collect_interventions as ci
from common import br_to_iso, iso_to_br, millions_to_usd, parse_decimal_br, usd_cents
from intervention_model import ASSET_CLASS_UNDISCLOSED, classify


def test_brazilian_decimals_are_parsed_exactly():
    assert parse_decimal_br("675510000,00") == Decimal("675510000.00")
    assert parse_decimal_br("5,834000") == Decimal("5.834000")
    assert parse_decimal_br("1.234.567,89") == Decimal("1234567.89")
    assert parse_decimal_br("-0,000300") == Decimal("-0.000300")


def test_blank_values_are_none_not_zero():
    assert parse_decimal_br("") is None
    assert parse_decimal_br("   ") is None
    assert parse_decimal_br(None) is None
    assert millions_to_usd(None) is None
    assert millions_to_usd("") is None
    assert usd_cents(None) is None


def test_millions_are_converted_without_floating_point_drift():
    assert millions_to_usd("362953") == 362_953_000_000
    assert millions_to_usd("362953.7") == 362_953_700_000
    assert isinstance(millions_to_usd("1"), int)


def test_cents_keep_monetary_precision():
    assert usd_cents(Decimal("675510000.00")) == 67_551_000_000
    assert usd_cents(Decimal("0.01")) == 1
    total = sum(usd_cents(Decimal("0.10")) for _ in range(10))
    assert total == 100  # 0.1 * 10 would drift in binary floating point


def test_date_conversions_round_trip():
    assert br_to_iso("24/11/2026") == "2026-11-24"
    assert br_to_iso("4/1/1999") == "1999-01-04"
    assert iso_to_br("2026-11-24") == "24/11/2026"


def test_every_published_instrument_is_classified(operations):
    seen = {(o["instrument"], o["modality"]) for o in operations}
    for instrument, modality in seen:
        category, problem = classify(instrument, modality)
        assert category is not None, problem


def test_unknown_instrument_is_reported_not_guessed():
    category, problem = classify("Instrumento Novo", "Mercado")
    assert category is None
    assert "nao mapeado" in problem


def test_unknown_swap_modality_is_reported_not_guessed():
    category, problem = classify("Swap Cambial", "Modalidade Nova")
    assert category is None
    assert "swap" in problem


def test_status_follows_the_published_result():
    today = "2026-11-24"
    assert ci._status(None, "2026-01-05", today) == ci.STATUS_PENDING
    assert ci._status(0, "2026-01-05", today) == ci.STATUS_ANNOUNCED
    assert ci._status(100, "2026-01-05", today) == ci.STATUS_SETTLED
    assert ci._status(100, "2027-01-05", today) == ci.STATUS_EXECUTED


def test_cancelled_status_is_never_produced(operations):
    assert all(o["status"] != "cancelada" for o in operations)


def test_asset_class_defaults_to_not_disclosed():
    from intervention_model import asset_class_for

    assert asset_class_for("Mercado") == ASSET_CLASS_UNDISCLOSED
    assert asset_class_for("PTAX") == ASSET_CLASS_UNDISCLOSED
    assert asset_class_for("Títulos Soberanos (Global Bonds)") != ASSET_CLASS_UNDISCLOSED


def test_weekends_and_holidays_leave_calendar_gaps(statement_cash):
    gaps = [
        day["calendar_gap_days"] for day in statement_cash["days"]
        if day["calendar_gap_days"] is not None
    ]
    assert max(gaps) > 1, "the series must skip weekends and holidays"
    assert min(gaps) >= 1
    # Every gap is reported so a reader can tell a weekend from a missing day.
    for day in statement_cash["days"][1:]:
        assert day["opening_date"] is not None
        assert day["calendar_gap_days"] >= 1


def test_timezone_of_published_timestamps(operations):
    stamped = [o for o in operations if o["announced_at"]]
    assert stamped
    for operation in stamped[:50]:
        # BCB publishes local Sao Paulo wall-clock times with no offset.
        assert "T" not in operation["announced_at"]
        _dt.datetime.strptime(operation["announced_at"], "%Y-%m-%d %H:%M:%S")
