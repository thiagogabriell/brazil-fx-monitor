"""Frontend checks.

The structural checks run everywhere with no dependency. The browser checks run
only when Playwright is installed, which keeps the default suite light.
"""

from __future__ import annotations

import http.server
import os
import re
import socketserver
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PAGES = [ROOT / "index.html"] + sorted((ROOT / "pages").glob("*.html"))


# --- structural -------------------------------------------------------------

def test_each_page_boots_its_own_module():
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        assert "window.PAGE" in text or "page-" in text, page.name
        # index.html is the standalone panel; the rest use the sidebar shell.
        assert "BFX.init(" in text or "BFX.initStandalone(" in text, page.name


def test_each_page_script_exists():
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        for match in re.finditer(r'src="(?:\.\./|\./)(assets/js/[a-z-]+\.js)', text):
            assert (ROOT / match.group(1)).exists(), match.group(1)


def test_colour_is_never_the_only_signal():
    css = (ROOT / "assets" / "css" / "app.css").read_text(encoding="utf-8")
    assert ".trend--up::before" in css
    assert ".trend--down::before" in css
    assert ".calendar__mark" in css
    core = (ROOT / "assets" / "js" / "core.js").read_text(encoding="utf-8")
    assert "trend trend--up" in core and "trend trend--down" in core


def test_light_theme_overrides_every_colour_token():
    css = (ROOT / "assets" / "css" / "app.css").read_text(encoding="utf-8")
    root_block = css.split(":root {")[1].split("}")[0]
    light_block = css.split('html[data-theme="light"] {')[1].split("}")[0]
    colour_tokens = {
        line.split(":")[0].strip()
        for line in root_block.splitlines()
        if line.strip().startswith("--") and "#" in line
    }
    light_tokens = {
        line.split(":")[0].strip()
        for line in light_block.splitlines()
        if line.strip().startswith("--")
    }
    assert colour_tokens - light_tokens == set()


def test_pages_have_a_skip_link_and_landmarks():
    core = (ROOT / "assets" / "js" / "core.js").read_text(encoding="utf-8")
    assert 'class="skip-link"' in core
    assert '<main id="main">' in core
    assert 'aria-label="Navegação principal"' in core
    assert 'aria-current="page"' in core


def test_responsive_grids_never_force_overflow():
    css = (ROOT / "assets" / "css" / "app.css").read_text(encoding="utf-8")
    for match in re.finditer(r"minmax\(([^,]+),", css):
        value = match.group(1).strip()
        assert value.startswith("min(") or value in {"0", "auto"}, value


# --- browser ----------------------------------------------------------------

playwright = pytest.importorskip.__self__ if False else None


def _serve(directory: Path):
    handler = lambda *args, **kwargs: http.server.SimpleHTTPRequestHandler(
        *args, directory=str(directory), **kwargs
    )
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


@pytest.fixture(scope="module")
def site_url():
    server = _serve(ROOT.parent)
    port = server.server_address[1]
    # Served from a subdirectory on purpose: that is how GitHub Pages hosts it.
    yield f"http://127.0.0.1:{port}/{ROOT.name}"
    server.shutdown()


LIVE_QUOTE_PATTERN = "**economia.awesomeapi.com.br/**"

LIVE_QUOTE_STUB = (
    '{"USDBRL":{"code":"USD","codein":"BRL","bid":"5.8900","ask":"5.8910",'
    '"high":"5.9500","low":"5.8000","pctChange":"-0.50",'
    '"create_date":"2026-11-24 16:00:00"}}'
)


def _stub_live_quote(page, *, fulfil: bool):
    """The live quote is a third party; tests must not depend on the network."""
    if fulfil:
        page.route(
            LIVE_QUOTE_PATTERN,
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                headers={"access-control-allow-origin": "*"},
                body=LIVE_QUOTE_STUB,
            ),
        )
    else:
        page.route(LIVE_QUOTE_PATTERN, lambda route: route.abort())


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_every_page_renders_without_console_errors(site_url):
    playwright_api = pytest.importorskip("playwright.sync_api")
    targets = ["index.html"] + [
        f"pages/{p.name}" for p in sorted((ROOT / "pages").glob("*.html"))
    ]
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for target in targets:
                page = browser.new_page()
                _stub_live_quote(page, fulfil=True)
                errors = []
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on(
                    "console",
                    lambda msg: errors.append(msg.text) if msg.type == "error" else None,
                )
                page.goto(f"{site_url}/{target}", wait_until="networkidle")
                page.wait_for_timeout(1500)
                assert errors == [], f"{target}: {errors}"
                assert page.locator(".notice--error").count() == 0, target
                assert page.locator("#main").inner_text().strip() != ""
                page.close()
        finally:
            browser.close()


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_official_data_survives_a_failing_secondary_source(site_url):
    """When the live quote fails, the official PTAX must still be shown."""
    playwright_api = pytest.importorskip("playwright.sync_api")
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            _stub_live_quote(page, fulfil=False)
            page.goto(f"{site_url}/pages/exchange-rate.html", wait_until="networkidle")
            page.wait_for_timeout(2000)
            body = page.locator("#main").inner_text()
            assert "indisponível" in body
            assert "PTAX" in body
            # The official figure is still rendered, not replaced by zero.
            assert page.locator("#rate-cards .card").count() >= 6
            assert page.locator(".notice--error").count() == 0
            page.close()
        finally:
            browser.close()


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_statement_row_expands_with_the_day_detail(site_url):
    playwright_api = pytest.importorskip("playwright.sync_api")
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            _stub_live_quote(page, fulfil=True)
            page.goto(f"{site_url}/pages/reserves.html", wait_until="networkidle")
            page.wait_for_timeout(2000)
            page.locator("#statement-body tr.expandable").first.click()
            page.wait_for_timeout(300)
            assert page.locator("tr.detail-row").count() == 1
            detail = page.locator("tr.detail-row").inner_text()
            assert "Saldo inicial" in detail
            assert "Variação não identificada" in detail
            page.close()
        finally:
            browser.close()


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_exports_produce_a_csv_download(site_url, tmp_path):
    playwright_api = pytest.importorskip("playwright.sync_api")
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(accept_downloads=True)
            _stub_live_quote(page, fulfil=True)
            page.goto(f"{site_url}/pages/reserves.html", wait_until="networkidle")
            page.wait_for_timeout(2000)
            with page.expect_download() as download_info:
                page.click("#export-csv")
            target = tmp_path / "extrato.csv"
            download_info.value.save_as(target)
            # Read as bytes: universal newlines would hide the CRLF endings
            # that spreadsheet software expects.
            raw = target.read_bytes()
            text = raw.decode("utf-8")
            assert text.startswith("\ufeff"), "CSV must carry a BOM for Excel"
            assert "variacao_nao_identificada_usd" in text
            assert raw.count(b"\r\n") > 10
            assert ";" in text.splitlines()[0]
            page.close()
        finally:
            browser.close()


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_theme_preference_persists(site_url):
    playwright_api = pytest.importorskip("playwright.sync_api")
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            context = browser.new_context()
            page = context.new_page()
            _stub_live_quote(page, fulfil=True)
            page.goto(f"{site_url}/index.html", wait_until="networkidle")
            page.wait_for_timeout(1200)
            assert page.evaluate("document.documentElement.dataset.theme") == "dark"
            page.click("#theme-toggle")
            page.wait_for_timeout(200)
            assert page.evaluate("document.documentElement.dataset.theme") == "light"

            second = context.new_page()
            _stub_live_quote(second, fulfil=True)
            second.goto(f"{site_url}/pages/settings.html", wait_until="networkidle")
            second.wait_for_timeout(1200)
            assert second.evaluate("document.documentElement.dataset.theme") == "light"
            context.close()
        finally:
            browser.close()


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_navigation_between_pages_works(site_url):
    """Navigation is exercised from a shell page, not from the simple panel."""
    playwright_api = pytest.importorskip("playwright.sync_api")
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            _stub_live_quote(page, fulfil=True)
            page.goto(f"{site_url}/pages/overview.html", wait_until="networkidle")
            page.wait_for_timeout(1200)
            links = page.locator(".nav a")
            assert links.count() == 15
            page.click('.nav a[href$="calendar.html"]')
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1800)
            assert "Calendário" in page.title()
            assert page.locator(".calendar__day").count() > 20
            assert page.locator('.nav a[aria-current="page"]').count() == 1
            page.close()
        finally:
            browser.close()


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_mobile_layout_has_no_horizontal_overflow(site_url):
    playwright_api = pytest.importorskip("playwright.sync_api")
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 390, "height": 844})
            page.goto(f"{site_url}/index.html", wait_until="networkidle")
            page.wait_for_timeout(1500)
            overflow = page.evaluate(
                "document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            assert overflow <= 1
            page.close()
        finally:
            browser.close()
