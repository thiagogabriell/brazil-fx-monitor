"""Deterministic foreign-exchange pressure index for Brazil (0-100).

This is a methodology of this application. It is NOT a Banco Central
classification, not a crisis forecast and not financial advice.

Each component maps one observable quantity to a 0-100 sub-score with a
piecewise-linear function whose breakpoints are declared in ``COMPONENTS`` and
exercised by the test suite. The total score is the weighted mean of the
components that have data, renormalised by the weight actually available.
``coverage_pct`` reports how much of the intended weight was available; below
``MIN_COVERAGE_PCT`` the score is withheld instead of being reported with false
precision.
"""

from __future__ import annotations

MIN_COVERAGE_PCT = 60.0

BANDS = [
    (0, 20, "Normal", "normal"),
    (21, 40, "Atencao", "attention"),
    (41, 60, "Pressao elevada", "elevated"),
    (61, 80, "Pressao severa", "severe"),
    (81, 100, "Pressao critica", "critical"),
]


def classify(score: float | None) -> dict:
    if score is None:
        return {
            "band": None,
            "label": "Dados insuficientes",
            "key": "insufficient",
        }
    for low, high, label, key in BANDS:
        if low <= score <= high:
            return {"band": [low, high], "label": label, "key": key}
    return {"band": [81, 100], "label": "Pressao critica", "key": "critical"}


def piecewise(value: float, points: list[tuple[float, float]]) -> float:
    """Linear interpolation, clamped at both ends.

    ``points`` may be declared in increasing or decreasing order of the
    observed quantity; they are sorted here so a component can be written in
    whichever direction reads naturally (for example reserves variation is
    declared from best to worst).
    """
    ordered = sorted(((float(x), float(y)) for x, y in points), key=lambda p: p[0])
    if value <= ordered[0][0]:
        return ordered[0][1]
    if value >= ordered[-1][0]:
        return ordered[-1][1]
    for (x0, y0), (x1, y1) in zip(ordered, ordered[1:]):
        if x0 <= value <= x1:
            if x1 == x0:
                return y1
            return y0 + (value - x0) / (x1 - x0) * (y1 - y0)
    return ordered[-1][1]


# Each entry: the quantity measured, its unit, the weight, the mapping
# breakpoints as (observed value -> sub-score) and the sentence template used
# to justify the sub-score in the interface.
COMPONENTS: dict[str, dict] = {
    "reserves_change_30d_pct": {
        "label": "Velocidade de reducao das reservas (30 dias)",
        "unit": "% das reservas",
        "weight": 12,
        "direction": "queda aumenta a pontuacao",
        "points": [(1.0, 0), (0.0, 10), (-0.5, 30), (-1.0, 50), (-2.5, 75), (-5.0, 100)],
        "template": (
            "As reservas variaram {value:+.2f}% em 30 dias. A escala atribui "
            "{score:.0f} pontos a essa variacao."
        ),
    },
    "reserves_change_90d_pct": {
        "label": "Velocidade de reducao das reservas (90 dias)",
        "unit": "% das reservas",
        "weight": 7,
        "direction": "queda aumenta a pontuacao",
        "points": [(2.0, 0), (0.0, 10), (-1.0, 30), (-2.5, 55), (-5.0, 80), (-10.0, 100)],
        "template": (
            "As reservas variaram {value:+.2f}% em 90 dias, equivalente a "
            "{score:.0f} pontos."
        ),
    },
    "direct_sale_days_30d": {
        "label": "Frequencia de vendas diretas de dolares (30 dias)",
        "unit": "dias com venda direta liquidada",
        "weight": 12,
        "direction": "mais dias aumentam a pontuacao",
        "points": [(0, 0), (1, 20), (3, 45), (6, 70), (10, 90), (15, 100)],
        "template": (
            "Houve venda direta de dolares em {value:.0f} dia(s) nos ultimos 30 "
            "dias cobertos pela fonte, o que vale {score:.0f} pontos."
        ),
    },
    "sold_vs_reserves_90d_pct": {
        "label": "Volume vendido em relacao as reservas (90 dias)",
        "unit": "% das reservas",
        "weight": 12,
        "direction": "mais volume aumenta a pontuacao",
        "points": [(0, 0), (0.25, 20), (1.0, 45), (2.5, 70), (5.0, 90), (10.0, 100)],
        "template": (
            "As vendas diretas de 90 dias somam {value:.2f}% das reservas "
            "atuais, o que vale {score:.0f} pontos."
        ),
    },
    "intervention_acceleration_ratio": {
        "label": "Aceleracao das intervencoes",
        "unit": "razao entre venda de 30 dias e media mensal dos 90 dias anteriores",
        "weight": 9,
        "direction": "razao maior que 1 indica aceleracao",
        "points": [(0.0, 0), (0.5, 15), (1.0, 35), (2.0, 60), (4.0, 85), (8.0, 100)],
        "template": (
            "A venda direta dos ultimos 30 dias equivale a {value:.2f} vez(es) a "
            "media mensal dos 90 dias anteriores, o que vale {score:.0f} pontos."
        ),
    },
    "brl_change_30d_pct": {
        "label": "Velocidade de desvalorizacao do real (30 dias)",
        "unit": "% de variacao da PTAX",
        "weight": 12,
        "direction": "alta do dolar aumenta a pontuacao",
        "points": [(-5.0, 0), (0.0, 10), (2.0, 30), (5.0, 55), (10.0, 80), (20.0, 100)],
        "template": (
            "A PTAX variou {value:+.2f}% em 30 dias, o que vale {score:.0f} pontos."
        ),
    },
    "brl_change_90d_pct": {
        "label": "Velocidade de desvalorizacao do real (90 dias)",
        "unit": "% de variacao da PTAX",
        "weight": 5,
        "direction": "alta do dolar aumenta a pontuacao",
        "points": [(-10.0, 0), (0.0, 10), (5.0, 35), (12.0, 60), (25.0, 85), (40.0, 100)],
        "template": (
            "A PTAX variou {value:+.2f}% em 90 dias, o que vale {score:.0f} pontos."
        ),
    },
    "financial_account_3m_usd_million": {
        "label": "Saida liquida de dolares (conta financeira, 3 meses)",
        "unit": "US$ milhoes acumulados em 3 meses",
        "weight": 9,
        "direction": "saida liquida aumenta a pontuacao",
        "points": [
            (30000, 0),
            (10000, 15),
            (0, 35),
            (-10000, 60),
            (-25000, 85),
            (-50000, 100),
        ],
        "template": (
            "A conta financeira somou US$ {value:,.0f} milhoes em 3 meses, o que "
            "vale {score:.0f} pontos."
        ),
    },
    "persistence_after_intervention_pct": {
        "label": "Persistencia da alta do dolar apos intervencoes",
        "unit": "% das intervencoes seguidas de nova alta em 5 dias uteis",
        "weight": 9,
        "direction": "mais persistencia aumenta a pontuacao",
        "points": [(0, 0), (25, 25), (50, 50), (75, 78), (100, 100)],
        "template": (
            "Em {value:.0f}% das ultimas vendas diretas o dolar seguiu subindo "
            "cinco dias uteis depois, o que vale {score:.0f} pontos."
        ),
    },
    "open_temporary_vs_reserves_pct": {
        "label": "Operacoes temporarias em aberto",
        "unit": "% das reservas",
        "weight": 6,
        "direction": "mais operacoes em aberto aumentam a pontuacao",
        "points": [(0, 0), (0.5, 20), (2.0, 45), (5.0, 70), (10.0, 90), (20.0, 100)],
        "template": (
            "As operacoes temporarias em aberto somam {value:.2f}% das reservas, "
            "o que vale {score:.0f} pontos."
        ),
    },
    "reserves_to_short_term_debt": {
        "label": "Reservas sobre divida externa de curto prazo",
        "unit": "razao",
        "weight": 0,
        "direction": "razao menor aumenta a pontuacao",
        "points": [(5.0, 0), (3.0, 20), (2.0, 40), (1.0, 70), (0.5, 100)],
        "template": "Razao de {value:.2f}, o que vale {score:.0f} pontos.",
        "unavailable_reason": (
            "O BCB nao publica a divida externa de curto prazo em dolares no "
            "portal de dados abertos; a serie 28192 disponivel esta em milhoes "
            "de reais e mede a divida total, nao o curto prazo."
        ),
    },
    "import_coverage_months": {
        "label": "Cobertura das importacoes pelas reservas",
        "unit": "meses de importacao",
        "weight": 7,
        "direction": "menos meses aumenta a pontuacao",
        "points": [(30, 0), (24, 10), (18, 25), (12, 45), (6, 80), (3, 100)],
        "template": (
            "As reservas cobrem {value:.1f} meses de importacoes, o que vale "
            "{score:.0f} pontos."
        ),
    },
}


def score_component(key: str, value: float | None) -> dict:
    spec = COMPONENTS[key]
    base = {
        "key": key,
        "label": spec["label"],
        "unit": spec["unit"],
        "weight": spec["weight"],
        "direction": spec["direction"],
        "breakpoints": [list(point) for point in spec["points"]],
        "observed_value": value,
    }
    if value is None:
        base.update(
            {
                "score": None,
                "available": False,
                "justification": spec.get(
                    "unavailable_reason", "Dado nao disponivel na fonte oficial."
                ),
            }
        )
        return base
    score = round(piecewise(float(value), spec["points"]), 2)
    base.update(
        {
            "score": score,
            "available": True,
            "justification": spec["template"].format(value=float(value), score=score),
        }
    )
    return base


def compute(values: dict[str, float | None]) -> dict:
    """Return the full index payload for the given observed values."""
    components = [score_component(key, values.get(key)) for key in COMPONENTS]

    usable = [
        component
        for component in components
        if component["available"] and component["weight"] > 0
    ]
    intended_weight = sum(
        spec["weight"] for spec in COMPONENTS.values() if spec["weight"] > 0
    )
    available_weight = sum(component["weight"] for component in usable)
    coverage_pct = (
        round(available_weight / intended_weight * 100, 2) if intended_weight else 0.0
    )

    if coverage_pct < MIN_COVERAGE_PCT or not usable:
        score: float | None = None
    else:
        score = round(
            sum(component["score"] * component["weight"] for component in usable)
            / available_weight,
            1,
        )

    missing = [
        {"key": component["key"], "label": component["label"], "reason": component["justification"]}
        for component in components
        if not component["available"]
    ]

    return {
        "score": score,
        "classification": classify(score),
        "coverage_pct": coverage_pct,
        "minimum_coverage_pct": MIN_COVERAGE_PCT,
        "intended_weight": intended_weight,
        "available_weight": available_weight,
        "components": components,
        "missing_components": missing,
        "bands": [
            {"from": low, "to": high, "label": label, "key": key}
            for low, high, label, key in BANDS
        ],
        "disclaimer": (
            "Indicador experimental desta aplicacao. Nao e classificacao "
            "oficial do Banco Central, nao e previsao de crise e nao e "
            "recomendacao financeira."
        ),
        "formula": (
            "score = soma(sub_score_i * peso_i) / soma(peso_i), apenas sobre os "
            "componentes com dado disponivel. Cada sub_score vem de uma funcao "
            "linear por partes com pontos de quebra declarados."
        ),
    }
