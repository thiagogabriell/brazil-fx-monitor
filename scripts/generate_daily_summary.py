#!/usr/bin/env python3
"""Write the plain-language daily summary from deterministic rules only.

No language model and no paid service is involved. Every sentence is produced
by a rule over a published number, and a number that is not published produces
a sentence saying so rather than being left out silently.
"""

from __future__ import annotations

import datetime as _dt
import sys

from common import (
    DATA,
    log,
    read_json,
    record_source_state,
    sao_paulo_now,
    today_sp,
    utc_now_iso,
    write_json,
)
from intervention_model import CATEGORIES

MONTHS = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


def br_date(iso: str | None) -> str:
    if not iso:
        return "data não informada"
    year, month, day = iso.split("-")
    return f"{int(day)} de {MONTHS[int(month) - 1]} de {year}"


def usd(value: float | None, *, cents: bool = False) -> str:
    if value is None:
        return "valor não divulgado"
    amount = value / 100 if cents else value
    if abs(amount) >= 1_000_000_000:
        return f"US$ {amount / 1_000_000_000:,.2f} bilhões".replace(",", "@").replace(".", ",").replace("@", ".")
    if abs(amount) >= 1_000_000:
        return f"US$ {amount / 1_000_000:,.1f} milhões".replace(",", "@").replace(".", ",").replace("@", ".")
    return f"US$ {amount:,.0f}".replace(",", ".")


def pct(value: float | None) -> str:
    if value is None:
        return "variação não disponível"
    return f"{value:+.2f}%".replace(".", ",")


def brl(value: float | None) -> str:
    if value is None:
        return "cotação não disponível"
    return f"R$ {value:,.4f}".replace(",", "@").replace(".", ",").replace("@", ".")


def build(summary: dict, alerts: dict, patterns: dict, pressure: dict) -> dict:
    now = sao_paulo_now()
    reserves = summary["reserves"].get("cash") or {}
    interventions = summary["interventions"]
    ptax = summary["market"]["ptax"]
    flow = summary["exchange_flow"]
    statement = summary.get("latest_statement_day") or {}

    blocks: list[dict] = []

    blocks.append(
        {
            "key": "reserves_balance",
            "title": "Saldo das reservas internacionais",
            "text": (
                f"Em {br_date(reserves.get('reference_date'))} as reservas "
                f"internacionais do Brasil no conceito caixa somavam "
                f"{usd(reserves.get('current_usd'))}. "
                f"A variação em relação a {br_date(reserves.get('previous_date'))}, "
                f"o dia útil anterior publicado, foi de "
                f"{usd(reserves.get('daily_change_usd'))} "
                f"({pct(reserves.get('daily_change_pct'))})."
            ),
            "source": "SGS 13621 (BCB)",
            "reference_date": reserves.get("reference_date"),
        }
    )

    changes = reserves.get("changes") or {}
    blocks.append(
        {
            "key": "reserves_windows",
            "title": "Variação em janelas mais longas",
            "text": (
                "Nos últimos 7 dias a variação foi de "
                f"{pct(changes.get('7', {}).get('change_pct'))}; em 30 dias, "
                f"{pct(changes.get('30', {}).get('change_pct'))}; em 90 dias, "
                f"{pct(changes.get('90', {}).get('change_pct'))}; e em 365 dias, "
                f"{pct(changes.get('365', {}).get('change_pct'))}. "
                f"O maior saldo da série foi {usd(reserves.get('all_time_high_usd'))} "
                f"em {br_date(reserves.get('all_time_high_date'))}, ou seja "
                f"{pct(reserves.get('gap_to_all_time_high_pct'))} em relação ao "
                "saldo atual."
            ),
            "source": "SGS 13621 (BCB)",
            "reference_date": reserves.get("reference_date"),
        }
    )

    windows = interventions["windows"]
    anchor = interventions["anchor_date"]
    blocks.append(
        {
            "key": "interventions",
            "title": "Intervenções confirmadas",
            "text": (
                "A fonte oficial de atuações no mercado de câmbio está "
                f"publicada até {br_date(anchor)}. Nessa base, as vendas diretas "
                f"de dólares somam {usd(windows['7']['sold_usd_cents'], cents=True)} "
                f"em 7 dias, {usd(windows['30']['sold_usd_cents'], cents=True)} em "
                f"30 dias, {usd(windows['90']['sold_usd_cents'], cents=True)} em 90 "
                f"dias e {usd(windows['365']['sold_usd_cents'], cents=True)} em 365 "
                "dias. As compras diretas no mesmo período de 365 dias somam "
                f"{usd(windows['365']['bought_usd_cents'], cents=True)}, o que deixa "
                "um saldo líquido de "
                f"{usd(windows['365']['net_usd_cents'], cents=True)}."
            ),
            "source": "Histórico de atuações no mercado de câmbio (BCB)",
            "reference_date": anchor,
        }
    )

    last_sale = interventions.get("last_direct_sale")
    if last_sale:
        blocks.append(
            {
                "key": "last_sale",
                "title": "Última venda direta",
                "text": (
                    f"A última venda direta de dólares com resultado publicado "
                    f"ocorreu em {br_date(last_sale['trade_date'])}, no valor de "
                    f"{usd(last_sale['accepted_usd_cents'], cents=True)}, com "
                    f"liquidação em {br_date(last_sale['settlement_date'])} e "
                    f"modalidade {last_sale['modality']}. "
                    f"Comunicado {last_sale['communication_number']}."
                ),
                "source": "Histórico de atuações no mercado de câmbio (BCB)",
                "reference_date": last_sale["trade_date"],
            }
        )

    temporary = interventions["open_temporary"]
    swaps = interventions["swap_outstanding"]
    blocks.append(
        {
            "key": "temporary_and_swaps",
            "title": "Operações temporárias e swaps",
            "text": (
                f"Há {temporary['count']} operação(ões) temporária(s) em aberto, "
                f"somando {usd(temporary['outstanding_usd_cents'], cents=True)}. "
                "Essas operações têm recompra contratada e não são consumo "
                "permanente das reservas. O estoque nocional de swaps cambiais "
                "tradicionais é de "
                f"{usd(swaps['traditional_notional_usd_cents'], cents=True)} e o de "
                f"swaps reversos é de "
                f"{usd(swaps['reverse_notional_usd_cents'], cents=True)}. "
                "Valor nocional de swap não é dólar retirado das reservas."
            ),
            "source": "Histórico de atuações no mercado de câmbio (BCB)",
            "reference_date": anchor,
        }
    )

    blocks.append(
        {
            "key": "exchange_rate",
            "title": "Comportamento do dólar",
            "text": (
                f"A PTAX de venda de {br_date(ptax['reference_date'])} ficou em "
                f"{brl(ptax['sell'])}, variação de "
                f"{pct(ptax['daily_change_pct'])} em relação ao dia útil anterior. "
                f"Em 30 dias a variação é de "
                f"{pct(ptax['changes']['30']['change_pct'])} e em 365 dias, "
                f"{pct(ptax['changes']['365']['change_pct'])}. "
                f"Na janela de 12 meses a máxima foi {brl(ptax['high_12m'])} e a "
                f"mínima {brl(ptax['low_12m'])}."
            ),
            "source": "SGS 1 (BCB)",
            "reference_date": ptax["reference_date"],
        }
    )

    portfolio = (flow["indicators"] or {}).get("portfolio_investment_net") or {}
    blocks.append(
        {
            "key": "flow",
            "title": "Fluxo mais recente",
            "text": (
                "O balanço de pagamentos mais recente é de "
                f"{br_date(flow['reference_date'])}. A conta financeira dos três "
                "últimos meses publicados soma "
                f"US$ {flow['financial_account_3m_usd_million']:,.0f} milhões. "
                f"Os investimentos em carteira acumulam "
                f"US$ {portfolio.get('accumulated_3m', 0):,.0f} milhões em três "
                f"meses, com {portfolio.get('negative_month_streak', 0)} mês(es) "
                "negativo(s) em sequência. Esse indicador não é o fluxo cambial "
                "contratado semanal, que não tem API pública."
            ).replace(",", "."),
            "source": "SGS 22864/22905/22969 (BCB)",
            "reference_date": flow["reference_date"],
        }
    )

    if statement:
        unidentified = statement.get("unidentified_variation_usd")
        blocks.append(
            {
                "key": "reconciliation",
                "title": "Conciliação do último dia",
                "text": (
                    f"No dia {br_date(statement.get('date'))} o saldo saiu de "
                    f"{usd(statement.get('opening_usd'))} para "
                    f"{usd(statement.get('closing_usd'))}. "
                    + (
                        "As atuações desse dia ainda não foram publicadas pelo "
                        "Banco Central, portanto a parte explicada da variação "
                        "não pode ser calculada."
                        if statement.get("interventions_coverage") != "covered"
                        else (
                            "Operações confirmadas explicam "
                            f"{usd(statement.get('explained_variation_usd'))} e "
                            f"{usd(unidentified)} ficam como variação não "
                            "identificada, que inclui rendimentos, variação "
                            "cambial entre moedas e marcação de ativos."
                        )
                    )
                ),
                "source": "Conciliação desta aplicação",
                "reference_date": statement.get("date"),
            }
        )

    detected = [p for p in patterns["patterns"] if p["detected"]]
    blocks.append(
        {
            "key": "patterns",
            "title": "Padrões identificados",
            "text": (
                "Nenhum dos padrões monitorados foi identificado com os dados "
                "atuais."
                if not detected
                else "Padrões identificados: " + "; ".join(p["title"] for p in detected) + "."
            ),
            "source": "Análise desta aplicação",
            "reference_date": patterns["anchor_reserves"],
        }
    )

    active = alerts.get("alerts", [])
    blocks.append(
        {
            "key": "alerts",
            "title": "Alertas",
            "text": (
                "Nenhum alerta ativo com os limites padrão."
                if not active
                else f"{len(active)} alerta(s) ativo(s) com os limites padrão: "
                + "; ".join(a["label"] for a in active[:6])
                + "."
            ),
            "source": "Central de alertas desta aplicação",
            "reference_date": None,
        }
    )

    score = pressure.get("score")
    blocks.append(
        {
            "key": "pressure",
            "title": "Indicador de pressão cambial",
            "text": (
                "O indicador experimental de pressão cambial não pôde ser "
                "calculado com precisão porque a cobertura de dados ficou em "
                f"{pressure.get('coverage_pct')}%."
                if score is None
                else (
                    f"O indicador experimental de pressão cambial está em "
                    f"{score} pontos, faixa "
                    f"\"{pressure['classification']['label']}\", com "
                    f"{pressure.get('coverage_pct')}% de cobertura dos "
                    "componentes. É uma metodologia desta aplicação, não uma "
                    "classificação oficial do Banco Central."
                )
            ),
            "source": "Metodologia desta aplicação",
            "reference_date": None,
        }
    )

    pending = []
    today = today_sp()
    if reserves.get("reference_date") and reserves["reference_date"] < today.isoformat():
        pending.append(
            f"O saldo das reservas de {br_date(today.isoformat())} ainda não foi "
            "publicado; o último disponível é de "
            f"{br_date(reserves['reference_date'])}."
        )
    pending.append(
        "As atuações no mercado de câmbio posteriores a "
        f"{br_date(anchor)} ainda não foram publicadas, porque a fonte é "
        "atualizada mensalmente."
    )
    pending.append(
        "A composição das reservas por moeda e por classe de ativo não é "
        "publicada em API pelo Banco Central."
    )

    return {
        "schema": "daily-summary/v1",
        "generated_at": utc_now_iso(),
        "generated_at_sao_paulo": now.replace(microsecond=0).isoformat(),
        "timezone": "America/Sao_Paulo",
        "date_sao_paulo": now.date().isoformat(),
        "method": (
            "Texto gerado por regras determinísticas sobre os dados coletados. "
            "Nenhum modelo de linguagem e nenhum serviço pago é utilizado."
        ),
        "anchors": summary["anchors"],
        "blocks": blocks,
        "pending_information": pending,
        "headline": (
            f"Reservas em {usd(reserves.get('current_usd'))} "
            f"({pct(reserves.get('daily_change_pct'))} no dia) e PTAX em "
            f"{brl(ptax['sell'])} ({pct(ptax['daily_change_pct'])})."
        ),
    }


def main() -> int:
    summary = read_json(DATA / "indicators" / "summary.json")
    alerts = read_json(DATA / "alerts" / "active.json") or {}
    patterns = read_json(DATA / "indicators" / "patterns.json")
    pressure = read_json(DATA / "indicators" / "pressure.json") or {}
    if not summary or not patterns:
        log.error("indicators missing")
        record_source_state("daily_summary", status="blocked")
        return 1

    payload = build(summary, alerts, patterns, pressure)
    write_json(DATA / "indicators" / "daily-summary.json", payload)
    record_source_state(
        "daily_summary",
        status="ok",
        reference_date=summary["anchors"]["reserves"],
        record_count=len(payload["blocks"]),
    )
    log.info("daily summary: %s blocks", len(payload["blocks"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
