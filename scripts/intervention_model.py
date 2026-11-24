"""Classification of BCB foreign-exchange operations.

The mapping below is derived strictly from the two columns the Banco Central
publishes in the "Historico de atuacoes no mercado de cambio" dataset
(``Instrumento`` and ``Modalidade``). Nothing is inferred beyond them.

``reserve_effect`` answers one question only: does this operation, by itself,
move the international reserves balance, and in which direction?

  ``decrease``            definitive outflow of foreign currency
  ``increase``            definitive inflow of foreign currency
  ``temporary_decrease``  foreign currency leaves now and is contractually due
                          back on ``maturity_date``
  ``none``                no foreign currency changes hands (notional only)
"""

from __future__ import annotations

CATEGORIES: dict[str, dict] = {
    "spot_sale_with_return": {
        "label": "Venda a vista com retorno contratado",
        "short_label": "Venda com retorno",
        "reserve_effect": "temporary_decrease",
        "notional": False,
        "temporary": True,
        "color_role": "temporary",
        "explanation": (
            "Venda a vista que o proprio Banco Central publica com data de "
            "vencimento, ou seja, com retorno contratado. Sai agora e volta na "
            "data informada, portanto nao e consumo permanente das reservas."
        ),
    },
    "spot_sale": {
        "label": "Venda direta de dolares a vista",
        "short_label": "Venda a vista",
        "reserve_effect": "decrease",
        "notional": False,
        "temporary": False,
        "color_role": "outflow",
        "explanation": (
            "Venda definitiva de moeda estrangeira ao mercado. Reduz as "
            "reservas internacionais na data de liquidacao."
        ),
    },
    "spot_purchase": {
        "label": "Compra direta de dolares a vista",
        "short_label": "Compra a vista",
        "reserve_effect": "increase",
        "notional": False,
        "temporary": False,
        "color_role": "inflow",
        "explanation": (
            "Compra definitiva de moeda estrangeira no mercado. Aumenta as "
            "reservas internacionais na data de liquidacao."
        ),
    },
    "forward_purchase": {
        "label": "Compra a termo",
        "short_label": "Compra a termo",
        "reserve_effect": "increase",
        "notional": False,
        "temporary": False,
        "color_role": "inflow",
        "explanation": (
            "Compra de moeda estrangeira com liquidacao futura. O efeito sobre "
            "as reservas ocorre na data de liquidacao informada."
        ),
    },
    "sale_with_repurchase": {
        "label": "Venda com compromisso de recompra",
        "short_label": "Venda com recompra",
        "reserve_effect": "temporary_decrease",
        "notional": False,
        "temporary": True,
        "color_role": "temporary",
        "explanation": (
            "Fornecimento temporario de dolares ao mercado. O BCB vende agora e "
            "recompra na data de vencimento, portanto nao e consumo permanente "
            "das reservas. No conceito liquidez o efeito e diferente do "
            "conceito caixa."
        ),
    },
    "repurchase_agreement": {
        "label": "Operacao compromissada",
        "short_label": "Compromissada",
        "reserve_effect": "temporary_decrease",
        "notional": False,
        "temporary": True,
        "color_role": "temporary",
        "explanation": (
            "Operacao compromissada com titulos soberanos. Troca temporaria de "
            "ativos por liquidez em moeda estrangeira, com retorno contratado."
        ),
    },
    "loan": {
        "label": "Emprestimo em moeda estrangeira",
        "short_label": "Emprestimo",
        "reserve_effect": "temporary_decrease",
        "notional": False,
        "temporary": True,
        "color_role": "temporary",
        "explanation": (
            "Linha de emprestimo em moeda estrangeira concedida pelo BCB, com "
            "devolucao contratada na data de vencimento."
        ),
    },
    "swap_traditional": {
        "label": "Swap cambial tradicional",
        "short_label": "Swap tradicional",
        "reserve_effect": "none",
        "notional": True,
        "temporary": False,
        "color_role": "notional",
        "explanation": (
            "Contrato de derivativo liquidado em reais. O valor e nocional: um "
            "swap cambial tradicional NAO representa venda de dolares das "
            "reservas internacionais."
        ),
    },
    "swap_reverse": {
        "label": "Swap cambial reverso",
        "short_label": "Swap reverso",
        "reserve_effect": "none",
        "notional": True,
        "temporary": False,
        "color_role": "notional",
        "explanation": (
            "Swap cambial na ponta inversa, tambem liquidado em reais. Valor "
            "nocional, sem saida de dolares das reservas."
        ),
    },
}

# (Instrumento, Modalidade) -> category. ``None`` modality means "any".
_INSTRUMENT_MAP: dict[str, str] = {
    "Venda a Vista": "spot_sale",
    "Compra a Vista": "spot_purchase",
    "Compra a Termo": "forward_purchase",
    "Venda com Recompra": "sale_with_repurchase",
    "Operação Compromissada": "repurchase_agreement",
    "Empréstimo": "loan",
}

_SWAP_MODALITY_MAP: dict[str, str] = {
    "Reverso": "swap_reverse",
    "Tradicional": "swap_traditional",
}

# Only these modality values disclose the asset class used. Everything else is
# genuinely not published and must be reported as such.
ASSET_CLASS_BY_MODALITY: dict[str, str] = {
    "Títulos Soberanos (Global Bonds)": "Titulos soberanos (Global Bonds)",
}

ASSET_CLASS_UNDISCLOSED = "Ativo de origem nao divulgado pelo Banco Central."


def classify(
    instrument: str, modality: str, *, has_maturity: bool = False
) -> tuple[str | None, str | None]:
    """Return ``(category_key, reason_when_unknown)``.

    ``has_maturity`` comes from the ``Data de Vencimento`` column. A spot sale
    that the Banco Central publishes with a maturity date is a sale with a
    contracted return, not a permanent use of the reserves, so it is classified
    as temporary. This is read from the data, never assumed from the modality.
    """
    instrument = (instrument or "").strip()
    modality = (modality or "").strip()

    if instrument == "Venda a Vista" and has_maturity:
        return "spot_sale_with_return", None

    if instrument == "Swap Cambial":
        key = _SWAP_MODALITY_MAP.get(modality)
        if key:
            return key, None
        # An unseen swap modality is reported, not guessed into a bucket.
        return None, f"modalidade de swap nao mapeada: {modality!r}"

    key = _INSTRUMENT_MAP.get(instrument)
    if key:
        return key, None
    return None, f"instrumento nao mapeado: {instrument!r}"


def asset_class_for(modality: str) -> str:
    return ASSET_CLASS_BY_MODALITY.get((modality or "").strip(), ASSET_CLASS_UNDISCLOSED)
