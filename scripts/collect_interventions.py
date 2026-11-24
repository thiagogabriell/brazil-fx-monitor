#!/usr/bin/env python3
"""Collect and normalise every BCB foreign-exchange operation since 1999.

Source: "Historico de atuacoes no mercado de cambio" (Portal de Dados Abertos
do Banco Central, Departamento das Reservas Internacionais), published as a
single CSV covering 18/01/1999 onwards.

Documented source behaviour that shapes this collector:
  * the file is refreshed monthly, carrying the operations of the previous
    month, so the newest operation is typically 3 to 8 weeks old;
  * it "describes the operations up to the moment each result was published",
    therefore later cancellations and prepayments are NOT reflected and a
    ``cancelada`` status can never be derived from this source.
"""

from __future__ import annotations

import csv
import hashlib
import io
import sys
from collections import Counter, defaultdict
from decimal import Decimal

from common import (
    DATA,
    SourceUnavailable,
    fetch_bytes,
    fetch_json,
    log,
    parse_decimal_br,
    read_json,
    record_source_state,
    today_sp,
    usd_cents,
    utc_now_iso,
    write_json,
)
from intervention_model import (
    ASSET_CLASS_BY_MODALITY,
    ASSET_CLASS_UNDISCLOSED,
    CATEGORIES,
    classify,
)

CKAN_PACKAGE = (
    "https://dadosabertos.bcb.gov.br/api/3/action/package_show"
    "?id=historico-de-atuacoes-no-mercado-de-cambio"
)
CSV_URL = (
    "https://www.bcb.gov.br/conteudo/dadosabertos/BCBDepin/"
    "historico-atuacoes-mercado-cambio.csv"
)
DOC_URL = (
    "https://www.bcb.gov.br/conteudo/dadosabertos/BCBDepin/"
    "documentacao-atuacoes-mercado-cambio.pdf"
)
LANDING = (
    "https://dadosabertos.bcb.gov.br/dataset/"
    "historico-de-atuacoes-no-mercado-de-cambio"
)
COMMUNICATION_URL = (
    "https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo"
    "?tipo=Comunicado&numero={numero}"
)

COLUMNS = [
    "Comunicação",
    "Data Hora Comunicação",
    "Comunicado",
    "Data Hora Comunicado",
    "Data Hora Anúncio",
    "Procedimento Operacional",
    "Data",
    "Instrumento",
    "Modalidade",
    "Tipo Composto",
    "Data de Liquidação",
    "Data de Vencimento",
    "Volume USD Ofertado",
    "Volume USD Aceito",
    "Taxa de Corte",
]

STATUS_ANNOUNCED = "anunciada"
STATUS_EXECUTED = "realizada"
STATUS_SETTLED = "liquidada"
STATUS_PENDING = "pendente_de_confirmacao"


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _date(value: str | None) -> str | None:
    text = _clean(value)
    return text[:10] if len(text) >= 10 else None


def _timestamp(value: str | None) -> str | None:
    text = _clean(value)
    return text or None


def _fetch_package_metadata() -> dict:
    try:
        result = fetch_json(CKAN_PACKAGE).get("result", {})
    except SourceUnavailable as exc:
        log.warning("CKAN metadata unavailable: %s", exc)
        return {}
    return {
        "title": result.get("title"),
        "author": result.get("author"),
        "frequency_declared": result.get("frequencia"),
        "period_start_declared": result.get("inicio_periodo"),
        "license": result.get("license_title"),
        "license_url": result.get("license_url"),
        "metadata_modified": result.get("metadata_modified"),
        "notes": result.get("notes"),
        "documentation": result.get("documentacao") or DOC_URL,
    }


def _stable_id(row: dict[str, str], occurrence: int) -> str:
    """Deterministic id for one operation.

    Built from every published field so that a restated row produces a new id
    only when the Banco Central actually changed the operation's content; the
    occurrence suffix separates rows the source publishes identically.
    """
    raw = "|".join(_clean(row.get(column)) for column in COLUMNS)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return f"{digest}-{occurrence}"


def _status(accepted_cents: int | None, settlement: str | None, today: str) -> str:
    if accepted_cents is None:
        # The result was announced but no accepted volume was published.
        return STATUS_PENDING
    if accepted_cents == 0:
        # Auction held, nothing accepted. Still an announced operation only.
        return STATUS_ANNOUNCED
    if settlement and settlement <= today:
        return STATUS_SETTLED
    return STATUS_EXECUTED


def build_operations(csv_text: str, today: str) -> tuple[list[dict], dict]:
    reader = csv.DictReader(io.StringIO(csv_text))
    missing = [c for c in COLUMNS if c not in (reader.fieldnames or [])]
    if missing:
        raise SourceUnavailable(f"CSV layout changed, missing columns: {missing}")

    raw_rows = list(reader)
    signature_counts: Counter[str] = Counter()
    unmapped: list[dict] = []
    operations: list[dict] = []

    # Pre-count identical published rows so they can be flagged explicitly
    # instead of being silently deduplicated or silently double counted.
    full_signatures = Counter(
        "|".join(_clean(row.get(column)) for column in COLUMNS) for row in raw_rows
    )

    for row in raw_rows:
        signature = "|".join(_clean(row.get(column)) for column in COLUMNS)
        signature_counts[signature] += 1
        occurrence = signature_counts[signature]

        instrument = _clean(row.get("Instrumento"))
        modality = _clean(row.get("Modalidade"))
        category, problem = classify(instrument, modality)
        if category is None:
            unmapped.append(
                {"instrument": instrument, "modality": modality, "reason": problem}
            )
            log.error("unmapped operation: %s", problem)
            continue

        spec = CATEGORIES[category]
        offered = parse_decimal_br(row.get("Volume USD Ofertado"))
        accepted = parse_decimal_br(row.get("Volume USD Aceito"))
        cut_rate = parse_decimal_br(row.get("Taxa de Corte"))

        trade_date = _date(row.get("Data"))
        settlement_date = _date(row.get("Data de Liquidação"))
        maturity_date = _date(row.get("Data de Vencimento"))
        communication = _clean(row.get("Comunicado")) or None

        accepted_cents = usd_cents(accepted)
        status = _status(accepted_cents, settlement_date, today)
        counts_as_executed = status in (STATUS_EXECUTED, STATUS_SETTLED)

        operations.append(
            {
                "id": _stable_id(row, occurrence),
                "trade_date": trade_date,
                "announced_at": _timestamp(row.get("Data Hora Anúncio")),
                "communication_published_at": _timestamp(
                    row.get("Data Hora Comunicado")
                ),
                "settlement_date": settlement_date,
                "maturity_date": maturity_date,
                "category": category,
                "instrument": instrument,
                "modality": modality,
                "composite_type": _clean(row.get("Tipo Composto")) or None,
                "operational_procedure": _clean(row.get("Procedimento Operacional")),
                "asset_class_disclosed": bool(
                    modality in ASSET_CLASS_BY_MODALITY
                ),
                "volume_offered_usd_cents": usd_cents(offered),
                "volume_accepted_usd_cents": accepted_cents,
                "cut_rate": float(cut_rate) if cut_rate is not None else None,
                "status": status,
                "counts_as_executed": counts_as_executed,
                "communication_number": communication,
                "published_identically_times": full_signatures[signature],
                "ambiguous_duplicate": full_signatures[signature] > 1,
            }
        )

    operations.sort(
        key=lambda o: (o["trade_date"] or "", o["category"], o["id"])
    )

    stats = {
        "row_count": len(raw_rows),
        "operation_count": len(operations),
        "unmapped": unmapped,
        "ambiguous_duplicate_count": sum(
            1 for o in operations if o["ambiguous_duplicate"]
        ),
        "by_category": dict(Counter(o["category"] for o in operations)),
        "by_status": dict(Counter(o["status"] for o in operations)),
    }
    return operations, stats


def _settlement_index(operations: list[dict]) -> dict:
    """Group executed operations by the date on which reserves actually move."""
    by_date: dict[str, list[str]] = defaultdict(list)
    for operation in operations:
        if not operation["counts_as_executed"]:
            continue
        if CATEGORIES[operation["category"]]["notional"]:
            continue
        if operation["settlement_date"]:
            by_date[operation["settlement_date"]].append(operation["id"])
    return {date: sorted(ids) for date, ids in sorted(by_date.items())}


def main() -> int:
    path = DATA / "interventions" / "operations.json"
    previous = read_json(path)
    package = _fetch_package_metadata()

    try:
        payload = fetch_bytes(CSV_URL, timeout=120)
    except SourceUnavailable as exc:
        log.error("interventions CSV unavailable: %s", exc)
        record_source_state(
            "interventions",
            status="unavailable",
            detail=str(exc),
            reference_date=(previous or {}).get("reference_date"),
        )
        return 1

    csv_text = payload.decode("utf-8-sig", errors="replace")
    today = today_sp().isoformat()
    try:
        operations, stats = build_operations(csv_text, today)
    except SourceUnavailable as exc:
        log.error("%s", exc)
        record_source_state("interventions", status="layout_changed", detail=str(exc))
        return 1

    if not operations:
        record_source_state("interventions", status="empty")
        return 1

    executed = [o for o in operations if o["counts_as_executed"]]
    latest_trade = max(o["trade_date"] for o in operations if o["trade_date"])

    executed = [o for o in operations if o["counts_as_executed"]]
    dates = [o["trade_date"] for o in operations if o["trade_date"]]
    latest_trade, first_trade = max(dates), min(dates)

    source = {
        "name": package.get("title") or "Historico de Atuacoes no Mercado de Cambio",
        "publisher": package.get("author")
        or "Banco Central do Brasil / Departamento das Reservas Internacionais",
        "endpoint": CSV_URL,
        "landing_page": LANDING,
        "documentation": package.get("documentation") or DOC_URL,
        "license": package.get("license")
        or "Open Data Commons Open Database License (ODbL)",
        "license_url": package.get("license_url"),
        "declared_frequency": package.get("frequency_declared") or "Mensal",
        "declared_period_start": package.get("period_start_declared") or "18/01/1999",
        "metadata_modified": package.get("metadata_modified"),
        "publisher_notes": package.get("notes"),
    }
    official_update = (
        "A serie e atualizada ate o ultimo dia util do mes e traz as atuacoes "
        "do mes anterior, quando houver. A ultima atuacao disponivel costuma "
        "ter de 3 a 8 semanas de defasagem."
    )
    limitations = [
        "A fonte descreve as atuacoes no momento da publicacao do resultado e "
        "nao reflete cancelamentos nem pre-pagamentos posteriores, portanto o "
        "status 'cancelada' nao pode ser derivado dela.",
        "A justificativa oficial de cada atuacao nao consta do conjunto de "
        "dados; ela aparece no comunicado correspondente.",
        "Nao ha horario de execucao por operacao, apenas o horario de "
        "divulgacao do comunicado e do anuncio.",
        "Quando o BCB publica linhas identicas em todos os campos nao e "
        "possivel distinguir duas operacoes iguais de uma repeticao do "
        "registro; essas linhas ficam marcadas com 'ambiguous_duplicate'.",
    ]
    common = {
        "unit": "USD cents",
        "unit_note": (
            "Volumes em centavos de dolar (inteiros) para evitar erro de "
            "precisao. Divida por 100 para obter USD."
        ),
        "currency_note": (
            "Todos os volumes sao publicados pelo BCB em dolares dos Estados "
            "Unidos (colunas 'Volume USD Ofertado' e 'Volume USD Aceito')."
        ),
        "source": source,
        "official_update": official_update,
        "known_limitations": limitations,
        "reference_date": latest_trade,
        "first_date": first_trade,
        "collected_at": utc_now_iso(),
    }

    changed = False

    # Full dataset: the authoritative file, also used for CSV/JSON export.
    changed |= write_json(
        path,
        {
            "schema": "interventions/v1",
            **common,
            "statistics": stats,
            "categories": CATEGORIES,
            "asset_class_undisclosed_label": ASSET_CLASS_UNDISCLOSED,
            "asset_class_by_modality": ASSET_CLASS_BY_MODALITY,
            "executed_count": len(executed),
            "operations": operations,
            "settlement_index": _settlement_index(operations),
        },
        compact=True,
    )

    # Year shards keep the browser payload small; pages load only what they need.
    by_year: dict[str, list[dict]] = defaultdict(list)
    for operation in operations:
        if operation["trade_date"]:
            by_year[operation["trade_date"][:4]].append(operation)

    shard_dir = DATA / "interventions" / "by-year"
    shard_dir.mkdir(parents=True, exist_ok=True)
    years_meta = []
    for year in sorted(by_year):
        items = by_year[year]
        changed |= write_json(
            shard_dir / f"{year}.json",
            {
                "schema": "interventions-year/v1",
                "year": int(year),
                "unit": "USD cents",
                "reference_date": latest_trade,
                "collected_at": utc_now_iso(),
                "operation_count": len(items),
                "operations": items,
            },
            compact=True,
        )
        years_meta.append(
            {
                "year": int(year),
                "file": f"data/interventions/by-year/{year}.json",
                "operation_count": len(items),
                "executed_count": sum(1 for o in items if o["counts_as_executed"]),
            }
        )

    for stale in shard_dir.glob("*.json"):
        if stale.stem not in by_year:
            log.warning("removing stale shard %s", stale.name)
            stale.unlink()
            changed = True

    changed |= write_json(
        DATA / "interventions" / "index.json",
        {
            "schema": "interventions-index/v1",
            **common,
            "statistics": stats,
            "categories": CATEGORIES,
            "asset_class_undisclosed_label": ASSET_CLASS_UNDISCLOSED,
            "asset_class_by_modality": ASSET_CLASS_BY_MODALITY,
            "executed_count": len(executed),
            "operation_count": len(operations),
            "years": years_meta,
            "full_dataset_file": "data/interventions/operations.json",
            "settlement_index": _settlement_index(operations),
        },
    )

    record_source_state(
        "interventions",
        status="ok",
        reference_date=latest_trade,
        record_count=len(operations),
        detail=f"{len(executed)} operacoes com resultado publicado",
    )
    log.info(
        "interventions: %s operations (%s executed), latest trade date %s, "
        "%s unmapped, changed=%s",
        len(operations),
        len(executed),
        latest_trade,
        len(stats["unmapped"]),
        changed,
    )
    return 0 if not stats["unmapped"] else 2


if __name__ == "__main__":
    sys.exit(main())
