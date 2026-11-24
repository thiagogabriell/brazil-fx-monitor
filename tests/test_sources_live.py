"""Live checks against the official endpoints.

These are skipped unless ``BFX_LIVE_TESTS=1`` so the normal suite stays offline
and deterministic. The scheduled workflow runs them once a day.
"""

from __future__ import annotations

import datetime as _dt
import os

import pytest

from common import fetch_bytes, fetch_json

live = pytest.mark.skipif(
    os.environ.get("BFX_LIVE_TESTS") != "1",
    reason="set BFX_LIVE_TESTS=1 to run the live source checks",
)


@live
@pytest.mark.parametrize(
    "code,expected_unit",
    [(13621, "million"), (13982, "million"), (1, "rate"), (10813, "rate")],
)
def test_sgs_series_respond(code, expected_unit):
    payload = fetch_json(
        f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}"
        "/dados/ultimos/3?formato=json"
    )
    assert isinstance(payload, list) and payload
    for row in payload:
        assert "data" in row and "valor" in row
        day, month, year = row["data"].split("/")
        _dt.date(int(year), int(month), int(day))
        float(row["valor"])


@live
def test_sgs_rejects_a_window_longer_than_ten_years():
    """Documents the constraint the collector works around."""
    from common import SourceUnavailable

    url = (
        "https://api.bcb.gov.br/dados/serie/bcdata.sgs.13621/dados"
        "?formato=json&dataInicial=01/01/1990&dataFinal=01/01/2026"
    )
    with pytest.raises(SourceUnavailable):
        fetch_json(url)


@live
def test_interventions_dataset_metadata_is_available():
    payload = fetch_json(
        "https://dadosabertos.bcb.gov.br/api/3/action/package_show"
        "?id=historico-de-atuacoes-no-mercado-de-cambio"
    )
    assert payload["success"] is True
    result = payload["result"]
    assert result["frequencia"] == "Mensal"
    assert result["inicio_periodo"] == "18/01/1999"
    urls = [resource["url"] for resource in result["resources"]]
    assert any(url.endswith("historico-atuacoes-mercado-cambio.csv") for url in urls)


@live
def test_interventions_csv_keeps_its_layout():
    import collect_interventions as ci

    payload = fetch_bytes(ci.CSV_URL, timeout=120)
    header = payload.decode("utf-8-sig", errors="replace").splitlines()[0]
    columns = [column.strip() for column in header.split(",")]
    assert columns == ci.COLUMNS


@live
def test_olinda_ptax_service_responds():
    today = _dt.date.today()
    start = today - _dt.timedelta(days=10)
    url = (
        "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
        "CotacaoDolarPeriodo(dataInicial=@dataInicial,"
        "dataFinalCotacao=@dataFinalCotacao)"
        f"?@dataInicial='{start.strftime('%m-%d-%Y')}'"
        f"&@dataFinalCotacao='{today.strftime('%m-%d-%Y')}'&$format=json"
    )
    payload = fetch_json(url)
    assert "value" in payload


@live
def test_composition_is_still_absent_from_the_open_catalogue():
    """If the BCB starts publishing it, this test fails and we add the page."""
    payload = fetch_json("https://dadosabertos.bcb.gov.br/api/3/action/package_list")
    names = payload["result"]
    candidates = [
        name for name in names
        if any(token in name for token in ("composicao", "direitos-especiais", "des-fmi"))
    ]
    assert candidates == [], f"new composition dataset found: {candidates}"


@live
def test_balance_of_payments_series_respond():
    for code in (22701, 22707, 22864, 22905, 22969):
        payload = fetch_json(
            f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}"
            "/dados/ultimos/1?formato=json"
        )
        assert payload and "valor" in payload[0]
