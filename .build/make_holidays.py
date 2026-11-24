#!/usr/bin/env python3
"""Generate the Brazilian bank holiday list used to skip pointless collections.

Fixed national holidays plus the movable ones derived from Easter (anonymous
Gregorian algorithm). 24 and 31 December are included because there is no bank
clearing on those days, so the Banco Central publishes nothing new.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / ".github" / "holidays-br.txt"

FIXED = [
    (1, 1, "Confraternizacao Universal"),
    (4, 21, "Tiradentes"),
    (5, 1, "Dia do Trabalho"),
    (9, 7, "Independencia"),
    (10, 12, "Nossa Senhora Aparecida"),
    (11, 2, "Finados"),
    (11, 15, "Proclamacao da Republica"),
    (11, 20, "Consciencia Negra"),
    (12, 24, "Vespera de Natal - sem compensacao bancaria"),
    (12, 25, "Natal"),
    (12, 31, "Ultimo dia util do ano - sem compensacao bancaria"),
]


def easter(year: int) -> _dt.date:
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return _dt.date(year, month, day + 1)


def main() -> None:
    lines = [
        "# Feriados bancarios brasileiros usados para pular coletas sem publicacao.",
        "# Gerado por .build/make_holidays.py. Nao editar a mao.",
    ]
    for year in range(2025, 2032):
        sunday = easter(year)
        movable = [
            (sunday - _dt.timedelta(days=48), "Carnaval (segunda)"),
            (sunday - _dt.timedelta(days=47), "Carnaval (terca)"),
            (sunday - _dt.timedelta(days=2), "Sexta-feira Santa"),
            (sunday + _dt.timedelta(days=60), "Corpus Christi"),
        ]
        entries = [
            (_dt.date(year, month, day), name) for month, day, name in FIXED
        ] + movable
        lines.append(f"# {year}")
        for date, name in sorted(entries):
            lines.append(f"{date.isoformat()}")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{OUT} written with {sum(1 for l in lines if not l.startswith('#'))} dates")


if __name__ == "__main__":
    main()
