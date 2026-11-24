"""Thin client for the Banco Central SGS open-data API.

Endpoint shape (validated 2026-11-24):
    https://api.bcb.gov.br/dados/serie/bcdata.sgs.<code>/dados
        ?formato=json&dataInicial=dd/mm/aaaa&dataFinal=dd/mm/aaaa

Hard constraint returned by the service itself for daily series:
    "O sistema aceita uma janela de consulta de, no maximo, 10 anos
     em series de periodicidade diaria"
so daily series must be requested in <=10 year windows.
"""

from __future__ import annotations

import datetime as _dt

from common import SourceUnavailable, br_to_iso, fetch_json, log, today_sp

BASE = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados"
WINDOW_YEARS = 9  # stay inside the 10 year ceiling


def _url(code: int, start: _dt.date, end: _dt.date) -> str:
    return (
        BASE.format(code=code)
        + "?formato=json"
        + f"&dataInicial={start.strftime('%d/%m/%Y')}"
        + f"&dataFinal={end.strftime('%d/%m/%Y')}"
    )


def fetch_series(
    code: int,
    *,
    start: _dt.date,
    end: _dt.date | None = None,
    daily: bool = True,
) -> list[dict[str, str]]:
    """Return ``[{"date": "YYYY-MM-DD", "raw": "362953"}, ...]`` ascending.

    Windows that legitimately hold no observations are skipped; a window that
    cannot be read at all propagates ``SourceUnavailable`` so the caller can
    preserve the previous good file instead of publishing a truncated series.
    """
    end = end or today_sp()
    collected: dict[str, str] = {}
    cursor = start
    step = _dt.timedelta(days=365 * WINDOW_YEARS)

    while cursor <= end:
        window_end = min(cursor + step, end)
        try:
            payload = fetch_json(_url(code, cursor, window_end))
        except SourceUnavailable as exc:
            # SGS answers 404 for a window with no observations at all.
            if "HTTP 404" in str(exc):
                log.info("sgs.%s %s..%s has no observations", code, cursor, window_end)
                cursor = window_end + _dt.timedelta(days=1)
                continue
            raise
        if isinstance(payload, dict):  # error envelope
            raise SourceUnavailable(f"sgs.{code}: {payload}")
        for item in payload:
            value = (item.get("valor") or "").strip()
            if not value:
                continue  # never coerce a blank observation into zero
            collected[br_to_iso(item["data"])] = value
        cursor = window_end + _dt.timedelta(days=1)

    return [{"date": d, "raw": collected[d]} for d in sorted(collected)]


def fetch_last(code: int, count: int = 1) -> list[dict[str, str]]:
    url = (
        f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}"
        f"/dados/ultimos/{count}?formato=json"
    )
    payload = fetch_json(url)
    if isinstance(payload, dict):
        raise SourceUnavailable(f"sgs.{code}: {payload}")
    return [
        {"date": br_to_iso(i["data"]), "raw": (i.get("valor") or "").strip()}
        for i in payload
        if (i.get("valor") or "").strip()
    ]
