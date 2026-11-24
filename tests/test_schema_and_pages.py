"""Schema validation, error handling and the published HTML."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import common
import validate_data
from common import SourceUnavailable, write_json

ROOT = Path(__file__).resolve().parent.parent
PAGES = [ROOT / "index.html"] + sorted((ROOT / "pages").glob("*.html"))


def test_full_validation_passes():
    report = validate_data.Report()
    validate_data.validate_files(report)
    validate_data.validate_reserves(report)
    validate_data.validate_interventions(report)
    validate_data.validate_reconciliation(report)
    validate_data.validate_indicators(report)
    validate_data.validate_composition(report)
    validate_data.validate_frequency_mixing(report)
    validate_data.validate_html(report)
    assert report.errors == []
    assert report.checks > 500


def test_every_published_file_is_valid_json():
    for path in (ROOT / "data").rglob("*.json"):
        json.loads(path.read_text(encoding="utf-8"))


def test_every_dataset_declares_its_unit():
    required = {
        "reserves/cash.json": "USD",
        "reserves/liquidity.json": "USD",
        "interventions/operations.json": "USD cents",
        "exchange-rates/ptax.json": "BRL per USD",
        "exchange-flow/balance-of-payments.json": "USD million",
    }
    for relative, unit in required.items():
        document = json.loads((ROOT / "data" / relative).read_text(encoding="utf-8"))
        assert document["unit"] == unit, relative


def test_every_dataset_declares_a_source_and_reference_date():
    for relative in [
        "reserves/cash.json", "reserves/liquidity.json",
        "interventions/operations.json", "exchange-rates/ptax.json",
        "exchange-flow/balance-of-payments.json",
    ]:
        document = json.loads((ROOT / "data" / relative).read_text(encoding="utf-8"))
        assert document["reference_date"]
        assert document.get("source") or document.get("sources")
        assert document["collected_at"]


# --- error handling ---------------------------------------------------------

def test_write_json_skips_identical_content(tmp_path):
    target = tmp_path / "x.json"
    payload = {"a": 1, "collected_at": "2026-01-01T00:00:00+00:00"}
    assert write_json(target, payload) is True
    payload2 = {"a": 1, "collected_at": "2026-02-02T00:00:00+00:00"}
    assert write_json(target, payload2) is False
    payload3 = {"a": 2, "collected_at": "2026-02-02T00:00:00+00:00"}
    assert write_json(target, payload3) is True


def test_a_client_error_is_not_retried(monkeypatch):
    import urllib.error

    calls = {"n": 0}

    def fake_urlopen(request, timeout=0):
        calls["n"] += 1
        raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, None)

    monkeypatch.setattr(common.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(SourceUnavailable):
        common.fetch_bytes("https://example.invalid/x")
    assert calls["n"] == 1


def test_a_server_error_is_retried_then_reported(monkeypatch):
    import urllib.error

    calls = {"n": 0}

    def fake_urlopen(request, timeout=0):
        calls["n"] += 1
        raise urllib.error.HTTPError(request.full_url, 502, "bad gateway", {}, None)

    monkeypatch.setattr(common.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(common.time, "sleep", lambda seconds: None)
    with pytest.raises(SourceUnavailable):
        common.fetch_bytes("https://example.invalid/x")
    assert calls["n"] == common.MAX_ATTEMPTS


def test_html_body_is_retried_and_then_reported(monkeypatch):
    """The BCB gateway sometimes answers 200 with an HTML error page."""
    calls = {"n": 0}

    def fake_fetch(url, timeout=0):
        calls["n"] += 1
        return b"<html><body>erro</body></html>"

    monkeypatch.setattr(common, "fetch_bytes", fake_fetch)
    monkeypatch.setattr(common.time, "sleep", lambda seconds: None)
    with pytest.raises(SourceUnavailable):
        common.fetch_json("https://example.invalid/x")
    assert calls["n"] == common.MAX_ATTEMPTS


def test_layout_change_is_detected():
    import collect_interventions as ci

    with pytest.raises(SourceUnavailable):
        ci.build_operations("coluna1,coluna2\n1,2\n", "2026-11-24")


# --- pages ------------------------------------------------------------------

def test_every_menu_entry_has_a_page():
    core = (ROOT / "assets" / "js" / "core.js").read_text(encoding="utf-8")
    hrefs = set(re.findall(r"href: '([^']+)'", core))
    assert len(hrefs) == 14
    for href in hrefs:
        assert (ROOT / href).exists(), href


def test_pages_use_relative_paths_only():
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        assert 'href="/' not in text, page.name
        assert 'src="/' not in text, page.name


def test_pages_declare_language_and_title():
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        assert 'lang="pt-BR"' in text, page.name
        assert re.search(r"<title>.+</title>", text), page.name
        assert 'name="viewport"' in text, page.name


def test_asset_versions_are_in_sync():
    """Pages must reference the current digest of the assets."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "make_pages", ROOT / ".build" / "make_pages.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    version = module.asset_version()
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        assert f"core.js?v={version}" in text, (
            f"{page.name} references a stale asset version; "
            "run python3 .build/make_pages.py"
        )


def test_external_scripts_are_pinned_with_integrity():
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        for match in re.finditer(r"<script[^>]*src=\"https://[^\"]+\"[^>]*>", text):
            tag = match.group(0)
            assert "integrity=\"sha384-" in tag, page.name
            assert "crossorigin=" in tag, page.name
            assert re.search(r"@\d+\.\d+\.\d+/", tag), page.name


def test_no_inline_event_handlers():
    """Keeps the attack surface small and avoids executing source content."""
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        assert not re.search(r"\son(click|load|error|mouseover)=", text), page.name


def test_javascript_escapes_untrusted_values():
    """Values coming from the data files must pass through escapeHtml."""
    for script in (ROOT / "assets" / "js").glob("page-*.js"):
        text = script.read_text(encoding="utf-8")
        assert "escapeHtml" in text or "textContent" in text, script.name
        assert "innerHTML = payload" not in text


def test_no_credentials_or_tokens_in_the_repository():
    patterns = [
        re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
        re.compile(r"dt0[cs]01\.[A-Z0-9]{24}"),
        re.compile(r"AKIA[0-9A-Z]{16}"),
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ]
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in {".git", ".venv", "node_modules", "data"} for part in path.parts):
            continue
        if path.suffix in {".png", ".jpg", ".ico", ".woff", ".woff2"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for pattern in patterns:
            assert not pattern.search(text), f"possible secret in {path}"
