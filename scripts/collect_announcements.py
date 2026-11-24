#!/usr/bin/env python3
"""Build the register of official BCB communications behind each intervention.

The open dataset carries the communication number and its publication
timestamp, not the communication text. Each entry therefore links to the
official page on bcb.gov.br, where the reason for the operation is stated when
the Banco Central states one.
"""

from __future__ import annotations

import sys
from collections import defaultdict

from common import DATA, log, read_json, record_source_state, utc_now_iso, write_json

COMMUNICATION_URL = (
    "https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo"
    "?tipo=Comunicado&numero={numero}"
)


def main() -> int:
    source = read_json(DATA / "interventions" / "operations.json")
    if not source:
        log.error("interventions dataset not collected yet")
        record_source_state(
            "announcements", status="blocked", detail="interventions dataset missing"
        )
        return 1

    grouped: dict[str, list[dict]] = defaultdict(list)
    without_communication = 0
    for operation in source["operations"]:
        number = operation.get("communication_number")
        if not number:
            without_communication += 1
            continue
        grouped[number].append(operation)

    announcements = []
    for number, operations in grouped.items():
        dates = sorted({o["trade_date"] for o in operations if o["trade_date"]})
        published = sorted(
            {
                o["communication_published_at"]
                for o in operations
                if o["communication_published_at"]
            }
        )
        announced = sorted({o["announced_at"] for o in operations if o["announced_at"]})
        announcements.append(
            {
                "communication_number": number,
                "published_at_sao_paulo": published[0] if published else None,
                "announced_at_sao_paulo": announced[0] if announced else None,
                "trade_dates": dates,
                "first_trade_date": dates[0] if dates else None,
                "operation_count": len(operations),
                "categories": sorted({o["category"] for o in operations}),
                "offered_usd_cents": sum(
                    o["volume_offered_usd_cents"] or 0 for o in operations
                )
                or None,
                "accepted_usd_cents": sum(
                    o["volume_accepted_usd_cents"] or 0
                    for o in operations
                    if o["counts_as_executed"]
                )
                or None,
                "official_url": COMMUNICATION_URL.format(numero=number),
                "official_reason": None,
            }
        )

    announcements.sort(
        key=lambda a: (a["published_at_sao_paulo"] or "", a["communication_number"]),
        reverse=True,
    )

    write_json(
        DATA / "interventions" / "announcements.json",
        {
            "schema": "announcements/v1",
            "unit": "USD cents",
            "timezone": "America/Sao_Paulo",
            "concept": (
                "Comunicados do Banco Central associados as atuacoes no mercado "
                "de cambio, reconstruidos a partir do numero do comunicado "
                "publicado no conjunto de dados de atuacoes."
            ),
            "limitations": [
                "O texto do comunicado nao esta disponivel em formato aberto; o "
                "campo 'official_reason' permanece nulo e o link oficial leva "
                "ao comunicado completo.",
                f"{without_communication} operacoes historicas nao trazem numero "
                "de comunicado na fonte, em geral operacoes diretas anteriores "
                "a 2003.",
            ],
            "source": {
                "name": "Banco Central do Brasil - Comunicados",
                "landing_page": (
                    "https://www.bcb.gov.br/estabilidadefinanceira/buscanormas"
                ),
                "derived_from": "data/interventions/operations.json",
            },
            "reference_date": source["reference_date"],
            "collected_at": utc_now_iso(),
            "announcement_count": len(announcements),
            "operations_without_communication": without_communication,
            "announcements": announcements,
        },
        compact=True,
    )
    record_source_state(
        "announcements",
        status="ok",
        reference_date=source["reference_date"],
        record_count=len(announcements),
    )
    log.info(
        "announcements: %s communications, %s operations without one",
        len(announcements),
        without_communication,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
