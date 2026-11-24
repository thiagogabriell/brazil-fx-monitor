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
        assert "BFX.init(" in text, page.name


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


@pytest.mark.skipif(
    os.environ.get("BFX_BROWSER_TESTS") != "1",
    reason="set BFX_BROWSER_TESTS=1 and install playwright to run browser tests",
)
def test_every_page_renders_without_console_errors(site_url):
    playwright_api = pytest.importorskip("playwright.sync_api")
    targets = ["index.html"] + [f"pages/{p.name}" for p in sorted((ROOT / "pages").glob("*.html"))]
    with playwright_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for target in targets:
                page = browser.new_page()
                errors = []
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on("console", lambda msg: errors.append(msg.text)
                        if msg.type == "error" else None)
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
