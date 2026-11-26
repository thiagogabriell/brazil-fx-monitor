"""The ten acceptance rules the application must never break.

Each test maps one to one onto a rule in the project brief.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import pytest

from intervention_model import CATEGORIES
import collect_interventions as ci

ROOT = Path(__file__).resolve().parent.parent

NOTIONAL = {key for key, spec in CATEGORIES.items() if spec["notional"]}
TEMPORARY = {key for key, spec in CATEGORIES.items() if spec["temporary"]}


# 1 --------------------------------------------------------------------------
def test_swap_is_never_counted_as_a_direct_sale(merged_operations, summary, series):
    operations = merged_operations
    swap_total = sum(
        o["volume_accepted_usd_cents"] or 0
        for o in operations
        if o["category"] in NOTIONAL and o["counts_as_executed"]
    )
    sold_total = sum(
        o["volume_accepted_usd_cents"] or 0
        for o in operations
        if o["category"] == "spot_sale" and o["counts_as_executed"]
    )
    assert swap_total > 0, "fixture should contain swaps"
    assert sold_total > 0, "fixture should contain direct sales"

    cumulative_sold = series["interventions_daily"][-1]["cumulative_sold_cents"]
    assert cumulative_sold == sold_total
    assert cumulative_sold != swap_total

    for window in summary["interventions"]["windows"].values():
        assert window["sold_usd_cents"] <= sold_total
        assert window["swap_traditional_notional_usd_cents"] >= 0
        # The swap bucket is reported on its own key, never folded into sales.
        assert "swap_traditional_notional_usd_cents" in window

    for category in NOTIONAL:
        assert CATEGORIES[category]["reserve_effect"] == "none"


def test_swap_daily_aggregate_is_separate_from_sales(series):
    swap_days = [
        row for row in series["interventions_daily"]
        if row["swap_traditional_cents"] > 0 and row["sold_cents"] == 0
    ]
    assert swap_days, "there must be days with swaps and no direct sale"
    for row in swap_days:
        # The swap volume stays in its own field and never reaches the direct
        # sale or purchase buckets, which drive the net balance.
        assert row["sold_cents"] == 0
        assert row["swap_traditional_cents"] != row["sold_cents"]
        assert row["net_cents"] == row["bought_cents"] - row["sold_cents"]


# 2 --------------------------------------------------------------------------
def test_announced_operation_is_not_counted_as_executed(operations):
    announced = [
        o for o in operations
        if o["status"] in ("anunciada", "pendente_de_confirmacao")
    ]
    assert announced, "fixture should contain announced-only operations"
    for operation in announced:
        assert operation["counts_as_executed"] is False


def test_announced_volume_is_excluded_from_totals(series, merged_operations):
    operations = merged_operations
    executed_sold = sum(
        o["volume_accepted_usd_cents"] or 0
        for o in operations
        if o["category"] == "spot_sale" and o["counts_as_executed"]
    )
    all_sold = sum(
        o["volume_accepted_usd_cents"] or 0
        for o in operations
        if o["category"] == "spot_sale"
    )
    assert executed_sold <= all_sold
    assert series["interventions_daily"][-1]["cumulative_sold_cents"] == executed_sold


# 3 --------------------------------------------------------------------------
def test_no_operation_is_counted_twice(merged_operations, series):
    operations = merged_operations
    identifiers = [o["id"] for o in operations]
    assert len(identifiers) == len(set(identifiers))

    by_category_count = {}
    for operation in operations:
        if operation["counts_as_executed"]:
            by_category_count[operation["category"]] = (
                by_category_count.get(operation["category"], 0) + 1
            )
    for row in series["distribution_by_category"]:
        assert row["operation_count"] == by_category_count.get(row["category"], 0)


def test_identical_published_rows_are_flagged_not_merged():
    """A row the BCB publishes twice keeps both records, each flagged."""
    header = ",".join(ci.COLUMNS)
    line = (
        ',,8845,2001-09-13 16:27:00,2001-09-13 16:27:00,Operação Direta,'
        '2001-09-13 00:00:00,Venda a Vista,Mercado,,2001-09-17 00:00:00,,,'
        '"50000000,00",'
    )
    csv_text = "\n".join([header, line, line])
    operations, stats = ci.build_operations(csv_text, "2026-11-24")
    assert len(operations) == 2
    assert operations[0]["id"] != operations[1]["id"]
    assert all(o["ambiguous_duplicate"] for o in operations)
    assert stats["ambiguous_duplicate_count"] == 2


# 4 --------------------------------------------------------------------------
def test_unexplained_reserve_drop_is_not_called_a_sale(statement_cash):
    unexplained = [
        day for day in statement_cash["days"]
        if day["interventions_coverage"] == "covered"
        and (day["variation_usd"] or 0) < 0
        and day["operation_count"] == 0
    ]
    assert unexplained, "fixture should contain drops with no operation behind them"
    for day in unexplained:
        assert day["direct_sold_usd_cents"] == 0
        assert day["confirmed_outflow_usd_cents"] == 0
        # The whole fall is reported as unidentified, never as a sale.
        assert day["unidentified_variation_usd"] is not None
        assert day["unidentified_variation_usd"] == pytest.approx(
            day["variation_usd"], abs=1.0
        )

    # A day with a sale must attribute only the published amount to the sale.
    with_sale = [
        day for day in statement_cash["days"]
        if day["interventions_coverage"] == "covered"
        and day["direct_sold_usd_cents"] > 0
    ]
    assert with_sale
    for day in with_sale:
        assert abs(day["variation_usd"]) != day["direct_sold_usd_cents"] / 100 or (
            day["unidentified_variation_usd"] == 0
        )


def test_reconciliation_adds_up(statement_cash):
    checked = 0
    for day in statement_cash["days"]:
        if day["interventions_coverage"] != "covered" or day["variation_usd"] is None:
            continue
        total = day["explained_variation_usd"] + day["unidentified_variation_usd"]
        assert total == pytest.approx(day["variation_usd"], abs=1.0)
        assert day["opening_usd"] + day["variation_usd"] == pytest.approx(
            day["closing_usd"], abs=1.0
        )
        checked += 1
    assert checked > 100


# 5 --------------------------------------------------------------------------
def test_temporary_operations_differ_from_permanent_sales(operations, statement_cash):
    for key in TEMPORARY:
        assert CATEGORIES[key]["reserve_effect"] == "temporary_decrease"
        assert CATEGORIES[key]["temporary"] is True
    assert CATEGORIES["spot_sale"]["reserve_effect"] == "decrease"
    assert CATEGORIES["spot_sale"]["temporary"] is False

    temporary_days = [
        day for day in statement_cash["days"] if day["temporary_out_usd_cents"] > 0
    ]
    assert temporary_days
    for day in temporary_days:
        # A temporary operation never lands in the direct sale bucket.
        assert day["direct_sold_usd_cents"] != day["temporary_out_usd_cents"] or (
            day["direct_sold_usd_cents"] == 0
        )


def test_temporary_operations_return_on_maturity(operations):
    returns = [
        o for o in operations
        if o["category"] in TEMPORARY and o["maturity_date"] and o["counts_as_executed"]
    ]
    assert returns, "fixture should contain temporary operations with maturity"
    for operation in returns:
        assert operation["maturity_date"] > operation["settlement_date"]


# 6 --------------------------------------------------------------------------
def test_missing_data_is_never_turned_into_zero(
    reserves_cash, operations, flow, composition
):
    for observation in reserves_cash["observations"]:
        assert observation["value_usd"] is not None
        assert observation["value_usd"] > 0

    pending = [o for o in operations if o["status"] == "pendente_de_confirmacao"]
    assert pending, "fixture should contain operations with no published result"
    for operation in pending:
        assert operation["volume_accepted_usd_cents"] is None

    for serie in flow["series"]:
        for observation in serie["observations"]:
            assert observation["value_usd_million"] is not None

    for bucket in composition["currency_buckets"] + composition["asset_class_buckets"]:
        assert bucket["value_usd"] is None
        assert bucket["share_pct"] is None


# 7 --------------------------------------------------------------------------
def test_different_frequencies_are_not_presented_as_simultaneous(summary):
    anchors = summary["anchors"]
    block = summary["interventions"]
    # As atuações saem no mesmo dia por comunicado; o saldo das reservas tem um
    # dia útil de atraso. A cobertura das atuações pode, portanto, ser mais
    # recente, desde que cada bloco declare a sua própria data.
    assert block["consolidated_until"] <= block["covered_until"]
    assert block["covered_until"] <= _dt.date.today().isoformat()
    assert block["coverage_note"]
    assert summary["anchor_note"]
    assert block["anchor_date"] == anchors["interventions"]
    assert summary["interventions"]["anchor_day"]["note"]
    for window in summary["interventions"]["windows"].values():
        assert window["to_date"] == anchors["interventions"]


def test_days_beyond_source_coverage_are_marked_not_empty(statement_cash):
    beyond = [
        day for day in statement_cash["days"]
        if day["interventions_coverage"] == "not_yet_published"
    ]
    assert beyond, "the reserves series runs ahead of the interventions source"
    for day in beyond:
        assert day["explained_variation_usd"] is None
        assert day["unidentified_variation_usd"] is None


# 8 --------------------------------------------------------------------------
def test_asset_class_is_never_inferred(operations, composition):
    disclosed = {"Títulos Soberanos (Global Bonds)"}
    for operation in operations:
        if operation["modality"] in disclosed:
            assert operation["asset_class_disclosed"] is True
        else:
            assert operation["asset_class_disclosed"] is False
    assert composition["available_via_api"] is False
    assert "não divulgado" in composition["unavailable_label"].lower().replace("nao", "não")


# 9 --------------------------------------------------------------------------
def test_cash_and_liquidity_are_handled_separately(
    statement_cash, statement_liquidity, summary
):
    assert statement_cash["concept"] == "cash"
    assert statement_liquidity["concept"] == "liquidity"
    assert all(
        day["temporary_counted_in_reconciliation"] is True
        for day in statement_cash["days"]
    )
    assert all(
        day["temporary_counted_in_reconciliation"] is False
        for day in statement_liquidity["days"]
    )
    assert set(summary["reserves"]) >= {"cash", "liquidity"}
    assert (
        summary["reserves"]["cash"]["current_usd"]
        != summary["reserves"]["liquidity"]["current_usd"]
    )


# 10 -------------------------------------------------------------------------
def test_revisions_are_tracked_and_recalculated(reserves_cash):
    assert "revisions" in reserves_cash
    assert isinstance(reserves_cash["revisions"], list)


def test_revision_detection_records_the_change():
    import collect_reserves as cr

    previous = {
        "revisions": [],
        "observations": [
            {"date": "2026-11-20", "value_usd": 1_000_000_000},
            {"date": "2026-11-21", "value_usd": 1_100_000_000},
        ],
    }
    current = [
        {"date": "2026-11-20", "value_usd": 1_000_000_000},
        {"date": "2026-11-21", "value_usd": 1_050_000_000},
        {"date": "2026-11-24", "value_usd": 1_060_000_000},
    ]
    revisions = cr._detect_revisions(previous, current)
    assert len(revisions) == 1
    assert revisions[0]["date"] == "2026-11-21"
    assert revisions[0]["previous_value_usd"] == 1_100_000_000
    assert revisions[0]["new_value_usd"] == 1_050_000_000


def test_reconciliation_follows_a_revised_balance():
    """A restated balance changes the residual, not the confirmed operations."""
    import reconcile_reserves as rr

    observations = [
        {"date": "2026-01-02", "value_usd": 300_000_000_000},
        {"date": "2026-01-05", "value_usd": 298_500_000_000},
    ]
    operation = {
        "id": "x-1",
        "category": "spot_sale",
        "instrument": "Venda a Vista",
        "modality": "PTAX",
        "trade_date": "2026-01-02",
        "settlement_date": "2026-01-05",
        "maturity_date": None,
        "volume_accepted_usd_cents": 100_000_000_000,
        "volume_offered_usd_cents": 100_000_000_000,
        "cut_rate": None,
        "status": "liquidada",
        "counts_as_executed": True,
        "communication_number": "1",
    }
    rows = rr.build_statement(
        "cash", observations, {"2026-01-05": [operation]}, {}, {}, "2026-01-01", "2026-12-31"
    )
    assert rows[1]["direct_sold_usd_cents"] == 100_000_000_000
    assert rows[1]["explained_variation_usd"] == -1_000_000_000
    assert rows[1]["unidentified_variation_usd"] == -500_000_000

    revised = [observations[0], {"date": "2026-01-05", "value_usd": 299_000_000_000}]
    rows = rr.build_statement(
        "cash", revised, {"2026-01-05": [operation]}, {}, {}, "2026-01-01", "2026-12-31"
    )
    assert rows[1]["direct_sold_usd_cents"] == 100_000_000_000
    assert rows[1]["explained_variation_usd"] == -1_000_000_000
    assert rows[1]["unidentified_variation_usd"] == 0


# --- conferência ------------------------------------------------------------

def test_a_spot_sale_with_a_maturity_date_is_not_permanent_spending(operations):
    """The BCB publishes some spot sales with a maturity date: they come back."""
    from intervention_model import CATEGORIES as SPEC, classify

    category, _ = classify("Venda a Vista", "ACC/ACE", has_maturity=True)
    assert category == "spot_sale_with_return"
    assert SPEC[category]["temporary"] is True
    assert SPEC[category]["reserve_effect"] == "temporary_decrease"

    category, _ = classify("Venda a Vista", "PTAX", has_maturity=False)
    assert category == "spot_sale"
    assert SPEC[category]["reserve_effect"] == "decrease"

    # Nothing classified as permanent spending may carry a maturity date.
    for operation in operations:
        if operation["category"] == "spot_sale":
            assert operation["maturity_date"] is None, operation["id"]


def test_spending_days_file_is_complete_and_consistent(operations):
    """The headline number must come from the whole series, not from a window."""
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "data" / "indicators" / "spending-days.json"
    document = json.loads(path.read_text(encoding="utf-8"))

    expected = {}
    for operation in operations:
        if operation["category"] != "spot_sale" or not operation["counts_as_executed"]:
            continue
        date = operation["settlement_date"] or operation["trade_date"]
        expected[date] = expected.get(date, 0) + (operation["volume_accepted_usd_cents"] or 0)
    expected = {date: value for date, value in expected.items() if value > 0}

    consolidated = {
        day["date"]: day["sold_usd_cents"]
        for day in document["days"]
        if not day["provisional"]
    }
    assert consolidated == expected
    assert document["day_count"] == len(document["days"])
    assert document["total_usd_cents"] == sum(
        day["sold_usd_cents"] for day in document["days"]
    )
    assert document["days"] == sorted(document["days"], key=lambda d: d["date"])
    assert document["first_date"] == min(expected)

    # Yearly totals must add back up to the overall total.
    assert sum(year["sold_usd_cents"] for year in document["by_year"]) == document["total_usd_cents"]
    assert sum(year["days"] for year in document["by_year"]) == document["day_count"]


def test_spending_day_balances_match_the_reserve_series(reserves_cash):
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "data" / "indicators" / "spending-days.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    balances = {o["date"]: o["value_usd"] for o in reserves_cash["observations"]}

    checked = 0
    for day in document["days"]:
        if day["closing_usd"] is None:
            continue
        assert day["closing_usd"] == balances[day["date"]], day["date"]
        if day["opening_usd"] is not None:
            assert day["opening_usd"] == balances[day["opening_date"]]
            assert day["variation_usd"] == day["closing_usd"] - day["opening_usd"]
        checked += 1
    assert checked > 300


def test_provisional_spending_comes_only_from_a_same_day_communication():
    """Days past the monthly file must cite the comunicado they came from."""
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    document = json.loads(
        (root / "data" / "indicators" / "spending-days.json").read_text(encoding="utf-8")
    )
    cutoff = document["consolidated_until"]

    for day in document["days"]:
        if day["provisional"]:
            assert day["date"] > cutoff, day["date"]
            assert day["source"] == "comunicado"
            links = day.get("communications") or []
            assert links, day["date"]
            assert any("bcb.gov.br" in (link.get("url") or "") for link in links)
        else:
            assert day["date"] <= cutoff
            assert day["source"] == "dados_abertos"

    assert document["provisional_count"] == sum(
        1 for day in document["days"] if day["provisional"]
    )


def test_recent_auctions_never_overlap_the_monthly_file(operations_document):
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    path = root / "data" / "interventions" / "recent-auctions.json"
    if not path.exists():
        pytest.skip("recent auctions not collected")
    recent = json.loads(path.read_text(encoding="utf-8"))

    assert recent["covers_after"] == operations_document["reference_date"]
    for auction in recent["auctions"]:
        assert auction["trade_date"] > recent["covers_after"], auction["auction"]
        assert auction["parsed"] is True
        assert auction["accepted_usd_cents"] is not None
        assert auction["category"] in CATEGORIES

    # An auction that could not be read is kept aside, never counted.
    for auction in recent["unparsed"]:
        assert auction["parsed"] is False


def test_an_auction_with_no_bids_accepted_is_read_and_counts_zero():
    """The BCB writes "USD $0" without decimals when nobody takes the offer."""
    import collect_recent_auctions as cra

    opening = {
        "number": 1, "date": "2026-11-25", "published_at_sao_paulo": "25/11/2026 10:30",
        "url": "u1", "subject": "venda conjugada",
        "text": (
            "Aviso de Abertura do Leilão de Câmbio 361/2026 Moeda: USD - DOLAR DOS EUA "
            "Natureza: Venda Conjugada com Compra Pós-Fixado Selic Período de "
            "Acolhimento de Propostas: 10:30 Data de Liquidação da Operação de Venda: "
            "30/11/2026"
        ),
    }
    result = {
        "number": 2, "date": "2026-11-25", "published_at_sao_paulo": "25/11/2026 10:40",
        "url": "u2", "subject": "resultado",
        "text": (
            "Resultado do Leilão de Câmbio 361/2026 comunica que não foi aceita "
            "nenhuma proposta no leilão 361/2026 . Foram aceitas 0 propostas no "
            "valor total de USD $0 ."
        ),
    }
    auctions = cra.parse_auctions([opening, result])
    entry = next(iter(auctions.values()))
    assert entry["parsed"] is True
    assert entry["accepted_usd_cents"] == 0
    assert entry["no_bids_accepted"] is True
    assert entry["category"] == "sale_with_repurchase"


def test_spending_days_never_holds_a_zero_or_future_day():
    """A temporary operation must not create a phantom day of spending."""
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    document = json.loads(
        (root / "data" / "indicators" / "spending-days.json").read_text(encoding="utf-8")
    )
    today = _dt.date.today().isoformat()
    for day in document["days"]:
        assert day["sold_usd_cents"] > 0, day["date"]
        assert day["date"] <= today, f"{day['date']} está no futuro"


def test_a_temporary_operation_never_becomes_a_spending_day():
    import calculate_indicators as ci
    from calculate_indicators import Series

    recent = {
        "auctions": [
            {
                "parsed": True, "category": "sale_with_repurchase",
                "trade_date": "2026-11-25", "settlement_date": "2026-11-30",
                "accepted_usd_cents": 200_000_000_000,
                "result": {"url": "u", "communication_number": 1},
                "announcement": None,
            }
        ]
    }
    document = ci.build_spending_days({}, Series([]), "2026-10-27", recent)
    assert document["days"] == []
    assert document["total_usd_cents"] == 0


def test_the_two_intervention_sources_never_overlap(operations_document, recent_auctions):
    """O arquivo mensal e os comunicados não podem cobrir a mesma data."""
    if not recent_auctions:
        pytest.skip("comunicados não coletados")
    consolidated = operations_document["reference_date"]
    for auction in recent_auctions["auctions"]:
        assert auction["trade_date"] > consolidated, auction["auction"]


def test_merged_totals_equal_the_sum_of_both_sources(
    operations_document, recent_auctions, summary
):
    from_file = sum(
        o["volume_accepted_usd_cents"] or 0
        for o in operations_document["operations"]
        if o["category"] == "spot_sale" and o["counts_as_executed"]
    )
    from_communications = sum(
        a["accepted_usd_cents"] or 0
        for a in (recent_auctions or {}).get("auctions", [])
        if a["parsed"] and a["category"] == "spot_sale"
    )
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    spending = json.loads(
        (root / "data" / "indicators" / "spending-days.json").read_text(encoding="utf-8")
    )
    assert spending["total_usd_cents"] == from_file + from_communications


def test_the_gap_between_the_two_reserve_concepts_equals_the_open_lines(summary):
    """Checagem contra a própria fonte, que também valida os comunicados.

    Uma operação de linha reduz o conceito caixa e não altera o conceito
    liquidez. Logo a diferença entre os dois é o saldo das linhas em aberto. Se
    a leitura dos comunicados estiver errada, esta conta deixa de fechar.
    """
    gap = summary["concept_gap"]
    assert gap["date"]
    assert gap["liquidity_minus_cash_usd"] is not None
    assert gap["matches"] is True, (
        f"liquidez - caixa = {gap['liquidity_minus_cash_usd']}, "
        f"linhas em aberto = {gap['open_line_operations_usd']}"
    )


def test_a_line_operation_moves_cash_but_not_liquidity(
    statement_cash, statement_liquidity
):
    """Verificado contra as duas séries reais do Banco Central.

    Numa operação de linha o dinheiro sai do caixa e volta depois, então ela
    reduz o conceito caixa e não altera o conceito liquidez. Rendimento e
    variação cambial afetam os dois igualmente, logo a diferença entre as duas
    variações no mesmo dia é exatamente o valor da linha.
    """
    cash = {d["date"]: d for d in statement_cash["days"]}
    liquidity = {d["date"]: d for d in statement_liquidity["days"]}

    checked = 0
    for date, day in cash.items():
        if day["interventions_coverage"] != "covered":
            continue
        if day["temporary_out_usd_cents"] <= 0:
            continue
        if day["direct_sold_usd_cents"] or day["direct_bought_usd_cents"]:
            continue
        if day["temporary_returned_usd_cents"]:
            continue
        other = liquidity.get(date)
        if not other or other["variation_usd"] is None or day["variation_usd"] is None:
            continue
        line = day["temporary_out_usd_cents"] / 100
        observed = other["variation_usd"] - day["variation_usd"]
        # Tolerância de um milhão: as séries são publicadas em milhões.
        assert abs(observed - line) <= 2_000_000, (
            f"{date}: liquidez - caixa = {observed}, linha = {line}"
        )
        checked += 1
    assert checked >= 5, "poucos dias de linha pura na janela para verificar"


def test_the_communication_parser_reproduces_the_official_monthly_file(
    operations_document,
):
    """Nas datas cobertas pelas duas fontes, elas têm de dizer a mesma coisa.

    O arquivo mensal consolidado é a verdade oficial. Se a leitura dos
    comunicados divergir dele numa data em que ambos existem, a leitura está
    errada. Esta checagem fica mais forte a cada mês, conforme o arquivo mensal
    avança sobre a janela já lida por comunicado.
    """
    import json
    from pathlib import Path

    import collect_recent_auctions as cra

    root = Path(__file__).resolve().parent.parent
    cache_path = root / "data" / "interventions" / "communications.json"
    if not cache_path.exists():
        pytest.skip("cache de comunicados ausente")
    cache = json.loads(cache_path.read_text(encoding="utf-8"))["communications"]

    monthly = {}
    for operation in operations_document["operations"]:
        if not operation["counts_as_executed"]:
            continue
        monthly.setdefault(operation["trade_date"], []).append(
            (
                operation["category"],
                operation["volume_accepted_usd_cents"],
                operation["maturity_date"],
            )
        )

    by_date = {}
    for item in cache:
        stamp = item.get("published_at_sao_paulo") or ""
        if "/" not in stamp:
            continue
        day, month, year = stamp.split(" ")[0].split("/")
        by_date.setdefault(f"{year}-{month}-{day}", []).append(item)

    compared = 0
    for date, items in sorted(by_date.items()):
        if date not in monthly:
            continue
        parsed = [
            (entry["category"], entry["accepted_usd_cents"], entry["maturity_date"])
            for entry in cra.parse_auctions(items).values()
            if entry["parsed"]
        ]
        if not parsed:
            continue
        assert sorted(parsed) == sorted(monthly[date]), (
            f"{date}: comunicados {sorted(parsed)} != arquivo mensal "
            f"{sorted(monthly[date])}"
        )
        compared += 1

    assert compared >= 1, "nenhuma data em comum entre as duas fontes para comparar"
