#!/usr/bin/env python3
"""Generate the HTML shells so every page shares the same head and boot code."""
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BODIES = ROOT / ".build" / "bodies"

ECHARTS = (
    '<script defer src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js" '
    'integrity="sha384-Mx5lkUEQPM1pOJCwFtUICyX45KNojXbkWdYhkKUKsbv391mavbfoAmONbzkgYPzR" '
    'crossorigin="anonymous" referrerpolicy="no-referrer"></script>'
)

PAGES = [
    # (output path, page key, browser title, h1 title, needs charts, script)
    ("index.html", "overview", "Visão geral", "Visão geral", True, "page-overview.js"),
    ("pages/reserves.html", "reserves", "Extrato das reservas", "Extrato das reservas", True, "page-reserves.js"),
    ("pages/transactions.html", "transactions", "Movimentações diárias", "Movimentações diárias das reservas", False, "page-transactions.js"),
    ("pages/calendar.html", "calendar", "Calendário de intervenções", "Calendário de intervenções", True, "page-calendar.js"),
    ("pages/composition.html", "composition", "Composição das reservas", "Composição das reservas", True, "page-composition.js"),
    ("pages/interventions.html", "interventions", "Histórico de intervenções", "Histórico de intervenções", True, "page-interventions.js"),
    ("pages/exchange-flow.html", "exchange-flow", "Fluxo cambial", "Fluxo cambial", True, "page-exchange-flow.js"),
    ("pages/exchange-rate.html", "exchange-rate", "Mercado cambial", "Mercado cambial", True, "page-exchange-rate.js"),
    ("pages/effectiveness.html", "effectiveness", "Efetividade das intervenções", "Efetividade das intervenções", True, "page-effectiveness.js"),
    ("pages/pressure-index.html", "pressure", "Pressão cambial", "Indicador de pressão cambial", True, "page-pressure.js"),
    ("pages/alerts.html", "alerts", "Alertas", "Central de alertas", False, "page-alerts.js"),
    ("pages/simulator.html", "simulator", "Simulador de consumo das reservas", "Simulador de consumo das reservas", True, "page-simulator.js"),
    ("pages/sources.html", "sources", "Fontes e metodologia", "Fontes e metodologia", False, "page-sources.js"),
    ("pages/settings.html", "settings", "Configurações", "Configurações", False, "page-settings.js"),
]

TEMPLATE = """<!doctype html>
<html lang="pt-BR" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{browser_title} · Brazil FX Monitor</title>
<meta name="description" content="Monitoramento das reservas internacionais do Brasil, das intervenções cambiais do Banco Central, do fluxo de dólares e da pressão sobre o real, com dados oficiais.">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="{base}assets/icons/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{base}assets/css/app.css?v={version}">
</head>
<body>
<div id="app-shell"></div>
<template id="page-template">
{body}
</template>
{echarts}
<script defer src="{base}assets/js/core.js?v={version}"></script>
{charts_js}
<script defer src="{base}assets/js/{script}?v={version}"></script>
<script>
document.addEventListener('DOMContentLoaded', function () {{
  var start = function () {{
    if (!window.BFX) {{ setTimeout(start, 20); return; }}
    BFX.init('{key}', {title_js}).then(function () {{
      if (window.PAGE && typeof window.PAGE.init === 'function') {{
        window.PAGE.init().catch(function (error) {{
          var main = document.getElementById('main');
          if (main) {{
            var box = document.createElement('p');
            box.className = 'notice notice--error';
            box.textContent = 'Falha ao carregar os dados desta página: ' + error.message;
            main.prepend(box);
          }}
          console.error(error);
        }});
      }}
    }});
  }};
  start();
}});
</script>
</body>
</html>
"""


def asset_version() -> str:
    """Short digest of every asset, appended to css/js URLs for cache busting."""
    digest = hashlib.sha256()
    for path in sorted((ROOT / "assets").rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(ROOT).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


def main() -> None:
    version = asset_version()
    print("asset version", version)
    for output, key, browser_title, title, needs_charts, script in PAGES:
        path = ROOT / output
        base = "../" if "/" in output else "./"
        body_file = BODIES / (Path(output).stem + ".html")
        body = body_file.read_text(encoding="utf-8").rstrip() if body_file.exists() else ""
        html = TEMPLATE.format(
            version=version,
            browser_title=browser_title,
            base=base,
            body=body,
            echarts=ECHARTS if needs_charts else "",
            charts_js=(
                f'<script defer src="{base}assets/js/charts.js?v={version}"></script>'
                if needs_charts
                else ""
            ),
            script=script,
            key=key,
            title_js=repr(title).replace("'", '"'),
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        print("wrote", output)


if __name__ == "__main__":
    main()
