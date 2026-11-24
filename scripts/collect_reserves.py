#!/usr/bin/env python3
"""Collect Brazil's international reserves daily balances from the BCB SGS API.

Two separate concepts are collected and never mixed:
  * SGS 13621 - Reservas internacionais - Conceito caixa - Total - diaria
  * SGS 13982 - Reservas internacionais - Conceito liquidez - Total - diaria

Both series are published in millions of USD and are normalised to whole USD.
"""

from __future__ import annotations

import datetime as _dt
import sys

from common import (
    DATA,
    SourceUnavailable,
    log,
    millions_to_usd,
    read_json,
    record_source_state,
    today_sp,
    utc_now_iso,
    write_json,
)
from sgs import fetch_series

HISTORY_START = _dt.date(1999, 1, 1)

CONCEPTS = {
    "cash": {
        "sgs_code": 13621,
        "label": "Conceito caixa",
        "description": (
            "Reservas internacionais no conceito caixa: ativos de reserva "
            "disponiveis, sem considerar compromissos de curto prazo em moeda "
            "estrangeira."
        ),
    },
    "liquidity": {
        "sgs_code": 13982,
        "label": "Conceito liquidez",
        "description": (
            "Reservas internacionais no conceito liquidez: inclui a posicao de "
            "liquidez em moeda estrangeira, portanto nao e comparavel nem "
            "somavel ao conceito caixa."
        ),
    },
}


def collect_concept(key: str, spec: dict) -> dict | None:
    code = spec["sgs_code"]
    path = DATA / "reserves" / f"{key}.json"
    previous = read_json(path)

    try:
        rows = fetch_series(code, start=HISTORY_START)
    except SourceUnavailable as exc:
        log.error("reserves/%s unavailable: %s", key, exc)
        record_source_state(
            f"reserves_{key}",
            status="unavailable",
            detail=str(exc),
            reference_date=(previous or {}).get("reference_date"),
        )
        return None

    if not rows:
        record_source_state(
            f"reserves_{key}", status="empty", detail="source returned no observations"
        )
        return None

    observations = [
        {
            "date": row["date"],
            "value_usd": millions_to_usd(row["raw"]),
            "source_value": row["raw"],
        }
        for row in rows
    ]

    revisions = _detect_revisions(previous, observations)

    payload = {
        "schema": "reserves/v1",
        "concept": key,
        "concept_label": spec["label"],
        "concept_description": spec["description"],
        "unit": "USD",
        "source_unit": "USD million",
        "frequency": "daily (business days)",
        "official_update": (
            "Divulgacao diaria pelo BCB, normalmente com um dia util de defasagem."
        ),
        "source": {
            "name": "Banco Central do Brasil - Sistema Gerenciador de Series Temporais (SGS)",
            "series_code": code,
            "series_name": f"Reservas internacionais - {spec['label']} - Total - diaria",
            "endpoint": (
                f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados?formato=json"
            ),
            "landing_page": (
                "https://dadosabertos.bcb.gov.br/dataset/"
                f"{code}-reservas-internacionais---conceito-"
                f"{'caixa' if key == 'cash' else 'liquidez'}---total---diaria"
            ),
            "license": "Open Data Commons Open Database License (ODbL)",
        },
        "reference_date": observations[-1]["date"],
        "first_date": observations[0]["date"],
        "observation_count": len(observations),
        "collected_at": utc_now_iso(),
        "revisions": revisions,
        "observations": observations,
    }

    write_json(path, payload, compact=True)
    record_source_state(
        f"reserves_{key}",
        status="ok",
        reference_date=payload["reference_date"],
        record_count=len(observations),
    )
    return payload


def _detect_revisions(previous: dict | None, observations: list[dict]) -> list[dict]:
    """Keep an audit trail when the BCB restates a previously published value."""
    history = list((previous or {}).get("revisions") or [])
    if not previous:
        return history
    old = {o["date"]: o["value_usd"] for o in previous.get("observations", [])}
    for observation in observations:
        before = old.get(observation["date"])
        if before is not None and before != observation["value_usd"]:
            history.append(
                {
                    "date": observation["date"],
                    "previous_value_usd": before,
                    "new_value_usd": observation["value_usd"],
                    "detected_at": utc_now_iso(),
                }
            )
            log.warning(
                "revision on %s: %s -> %s",
                observation["date"],
                before,
                observation["value_usd"],
            )
    return history[-500:]


def main() -> int:
    results = {key: collect_concept(key, spec) for key, spec in CONCEPTS.items()}
    ok = [k for k, v in results.items() if v]
    if not ok:
        log.error("no reserve concept could be collected")
        return 1

    index = {
        "schema": "reserves-index/v1",
        "generated_at": utc_now_iso(),
        "concepts": [
            {
                "key": key,
                "label": CONCEPTS[key]["label"],
                "description": CONCEPTS[key]["description"],
                "file": f"data/reserves/{key}.json",
                "available": bool(payload),
                "reference_date": (payload or {}).get("reference_date"),
                "observation_count": (payload or {}).get("observation_count"),
                "sgs_code": CONCEPTS[key]["sgs_code"],
            }
            for key, payload in results.items()
        ],
        "default_concept": "cash",
        "warning": (
            "Os conceitos caixa e liquidez medem a mesma reserva por oticas "
            "diferentes. Nao somar e nao comparar diretamente."
        ),
    }
    write_json(DATA / "reserves" / "index.json", index)
    log.info("reserves collected: %s (as of %s)", ", ".join(ok), today_sp())
    return 0


if __name__ == "__main__":
    sys.exit(main())
