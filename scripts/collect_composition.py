#!/usr/bin/env python3
"""Record what the Banco Central actually publishes about reserve composition.

Findings of the source survey (2026-11-24), re-checked on every run:

  * The Portal de Dados Abertos catalogue (4,261 datasets) contains exactly two
    reserve datasets, SGS 13621 and SGS 13982, both totals only. There is no
    dataset, SGS series or OData service exposing the breakdown of the
    international reserves by currency or by asset class.
  * The breakdown is published only inside human-readable documents: the annual
    "Relatorio de Gestao das Reservas Internacionais" (PDF) and the
    "Demonstrativo de reservas internacionais e liquidez em moeda estrangeira"
    (IMF SDDS template).

This collector therefore publishes availability metadata and official links,
never parsed or estimated figures. The composition page uses it to state the
absence explicitly instead of showing an invented pie chart.
"""

from __future__ import annotations

import sys

from common import (
    DATA,
    SourceUnavailable,
    fetch_json,
    log,
    record_source_state,
    utc_now_iso,
    write_json,
)

CKAN_SEARCH = (
    "https://dadosabertos.bcb.gov.br/api/3/action/package_list"
)

CURRENCY_BUCKETS = [
    ("USD", "Dolar americano"),
    ("EUR", "Euro"),
    ("CNY", "Yuan chines"),
    ("GBP", "Libra esterlina"),
    ("JPY", "Iene japones"),
    ("CAD", "Dolar canadense"),
    ("AUD", "Dolar australiano"),
    ("OTHER", "Outras moedas"),
]

ASSET_BUCKETS = [
    ("gold", "Ouro"),
    ("foreign_government_bonds", "Titulos publicos estrangeiros"),
    ("other_debt", "Outros titulos de divida"),
    ("bank_deposits", "Depositos bancarios"),
    ("sdr", "Direitos Especiais de Saque (DES)"),
    ("imf_reserve_position", "Posicao de reserva no FMI"),
    ("other_assets", "Outros ativos"),
]

OFFICIAL_SOURCES = [
    {
        "name": "Reservas internacionais (pagina institucional do BCB)",
        "url": "https://www.bcb.gov.br/estabilidadefinanceira/reservasinternacionais",
        "machine_readable": False,
        "content": "Conceitos, metodologia e links para os relatorios.",
    },
    {
        "name": "Relatorio de Gestao das Reservas Internacionais",
        "url": "https://www.bcb.gov.br/publicacoes/relatoriogestaoreservas",
        "machine_readable": False,
        "content": (
            "Publicacao anual em PDF com a composicao por moeda e por classe "
            "de ativo, retornos e politica de investimento."
        ),
    },
    {
        "name": (
            "Demonstrativo de reservas internacionais e liquidez em moeda "
            "estrangeira"
        ),
        "url": (
            "https://www.bcb.gov.br/estatisticas/"
            "reservasinternacionaisliquidezmoedaestrangeira"
        ),
        "machine_readable": False,
        "content": (
            "Template de divulgacao do FMI (SDDS) com ativos de reserva, "
            "compromissos e posicoes em derivativos."
        ),
    },
    {
        "name": "International Monetary Fund - Brazil data",
        "url": "https://www.imf.org/en/Countries/BRA",
        "machine_readable": False,
        "content": (
            "Dados agregados de reservas e DES do Brasil nas publicacoes do FMI."
        ),
    },
]


def _verify_absence() -> dict:
    """Re-run the catalogue check so a future BCB release is not missed."""
    try:
        names = fetch_json(CKAN_SEARCH).get("result", [])
    except SourceUnavailable as exc:
        log.warning("could not re-check the open data catalogue: %s", exc)
        return {"checked": False, "detail": str(exc)}

    reserve_datasets = sorted(n for n in names if "reservas" in n)
    candidates = sorted(
        n
        for n in names
        if any(
            token in n
            for token in ("composicao", "ouro-reserva", "direitos-especiais", "des-fmi")
        )
    )
    return {
        "checked": True,
        "catalogue_size": len(names),
        "reserve_datasets_found": reserve_datasets,
        "composition_candidates_found": candidates,
        "conclusion": (
            "Nenhum conjunto de dados de composicao das reservas foi "
            "encontrado no catalogo aberto do BCB."
            if not candidates
            else "Possivel novo conjunto de dados encontrado; revisar."
        ),
    }


def main() -> int:
    survey = _verify_absence()
    available = bool(survey.get("composition_candidates_found"))

    payload = {
        "schema": "composition/v1",
        "available_via_api": available,
        "status": "unavailable_via_official_api",
        "unavailable_label": "Ativo de origem nao divulgado pelo Banco Central.",
        "explanation": (
            "O Banco Central nao publica a composicao das reservas "
            "internacionais em API, serie temporal ou dado aberto. A abertura "
            "por moeda e por classe de ativo existe apenas em publicacoes em "
            "PDF, com periodicidade anual para o relatorio de gestao. Por isso "
            "esta aplicacao nao exibe percentuais de composicao: qualquer "
            "numero diario aqui seria estimativa, nao dado oficial."
        ),
        "perspective_warning": (
            "A distribuicao por moeda e a distribuicao por classe de ativo sao "
            "duas oticas das mesmas reservas. Nao devem ser somadas."
        ),
        "currency_buckets": [
            {
                "code": code,
                "label": label,
                "value_usd": None,
                "share_pct": None,
                "reference_date": None,
                "status": "nao_divulgado_em_api",
            }
            for code, label in CURRENCY_BUCKETS
        ],
        "asset_class_buckets": [
            {
                "key": key,
                "label": label,
                "value_usd": None,
                "share_pct": None,
                "original_quantity": None,
                "reference_date": None,
                "status": "nao_divulgado_em_api",
            }
            for key, label in ASSET_BUCKETS
        ],
        "official_sources": OFFICIAL_SOURCES,
        "catalogue_survey": survey,
        "collected_at": utc_now_iso(),
    }

    write_json(DATA / "composition" / "composition.json", payload)
    record_source_state(
        "composition",
        status="unavailable_by_design",
        detail=survey.get("conclusion"),
        record_count=0,
    )
    log.info("composition availability recorded (available_via_api=%s)", available)
    return 0


if __name__ == "__main__":
    sys.exit(main())
