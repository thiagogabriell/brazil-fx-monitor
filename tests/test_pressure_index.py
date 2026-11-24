"""The pressure index must be deterministic, bounded and honest about gaps."""

from __future__ import annotations

import pytest

from pressure_index import COMPONENTS, MIN_COVERAGE_PCT, classify, compute, piecewise


def test_weights_total_one_hundred():
    assert sum(spec["weight"] for spec in COMPONENTS.values()) == 100


def test_piecewise_hits_every_declared_breakpoint():
    for key, spec in COMPONENTS.items():
        for x, y in spec["points"]:
            assert piecewise(x, spec["points"]) == pytest.approx(y), key


def test_piecewise_is_clamped_and_monotonic():
    points = COMPONENTS["reserves_change_30d_pct"]["points"]
    assert piecewise(999, points) == 0
    assert piecewise(-999, points) == 100
    # Falling reserves can only raise the sub-score.
    previous = -1
    for value in (5, 1, 0, -0.5, -1, -2.5, -5, -8):
        score = piecewise(value, points)
        assert score >= previous
        previous = score


def test_piecewise_interpolates_between_breakpoints():
    points = COMPONENTS["reserves_change_30d_pct"]["points"]
    assert piecewise(-0.75, points) == pytest.approx(40.0)


def test_descending_and_ascending_breakpoints_both_work():
    ascending = COMPONENTS["direct_sale_days_30d"]["points"]
    descending = COMPONENTS["financial_account_3m_usd_million"]["points"]
    assert piecewise(3, ascending) == pytest.approx(45)
    assert piecewise(0, descending) == pytest.approx(35)


def _full_values(**overrides):
    values = {
        "reserves_change_30d_pct": 0.0,
        "reserves_change_90d_pct": 0.0,
        "direct_sale_days_30d": 0.0,
        "sold_vs_reserves_90d_pct": 0.0,
        "intervention_acceleration_ratio": 0.0,
        "brl_change_30d_pct": 0.0,
        "brl_change_90d_pct": 0.0,
        "financial_account_3m_usd_million": 30000,
        "persistence_after_intervention_pct": 0.0,
        "open_temporary_vs_reserves_pct": 0.0,
        "import_coverage_months": 30,
        "reserves_to_short_term_debt": None,
    }
    values.update(overrides)
    return values


def test_score_is_bounded_and_deterministic():
    values = _full_values()
    first = compute(values)
    second = compute(values)
    assert first["score"] == second["score"]
    assert 0 <= first["score"] <= 100


def test_worst_case_reaches_the_critical_band():
    values = _full_values(
        reserves_change_30d_pct=-9,
        reserves_change_90d_pct=-20,
        direct_sale_days_30d=20,
        sold_vs_reserves_90d_pct=15,
        intervention_acceleration_ratio=10,
        brl_change_30d_pct=30,
        brl_change_90d_pct=60,
        financial_account_3m_usd_million=-80000,
        persistence_after_intervention_pct=100,
        open_temporary_vs_reserves_pct=30,
        import_coverage_months=2,
    )
    result = compute(values)
    assert result["score"] == 100
    assert result["classification"]["key"] == "critical"


def test_score_is_withheld_when_coverage_is_low():
    values = {key: None for key in COMPONENTS}
    values["brl_change_30d_pct"] = 5.0
    result = compute(values)
    assert result["score"] is None
    assert result["coverage_pct"] < MIN_COVERAGE_PCT
    assert result["classification"]["key"] == "insufficient"


def test_components_without_data_are_reported_with_a_reason():
    result = compute(_full_values())
    missing = {item["key"] for item in result["missing_components"]}
    assert "reserves_to_short_term_debt" in missing
    reason = next(
        item["reason"] for item in result["missing_components"]
        if item["key"] == "reserves_to_short_term_debt"
    )
    assert "dados abertos" in reason or "nao publica" in reason


def test_coverage_renormalises_the_weights():
    values = _full_values(import_coverage_months=None)
    result = compute(values)
    assert result["available_weight"] == 100 - COMPONENTS["import_coverage_months"]["weight"]
    assert result["coverage_pct"] == pytest.approx(result["available_weight"])
    assert result["score"] is not None


def test_bands_cover_zero_to_one_hundred():
    assert classify(0)["key"] == "normal"
    assert classify(20)["key"] == "normal"
    assert classify(21)["key"] == "attention"
    assert classify(41)["key"] == "elevated"
    assert classify(61)["key"] == "severe"
    assert classify(81)["key"] == "critical"
    assert classify(100)["key"] == "critical"
    assert classify(None)["key"] == "insufficient"


def test_published_index_matches_a_recomputation(pressure):
    recomputed = compute(pressure["observed_values"])
    assert recomputed["score"] == pressure["score"]
    assert recomputed["coverage_pct"] == pressure["coverage_pct"]


def test_published_index_declares_it_is_not_official(pressure):
    text = pressure["disclaimer"].lower()
    assert "nao e classificacao oficial" in text or "não é classificação oficial" in text
    assert "recomendacao financeira" in text or "recomendação financeira" in text
