"""Shared helpers for Brazil FX Monitor collectors and processors.

Conventions enforced here:
  * All monetary values are stored in whole United States dollars (``USD``).
    Source units are recorded in metadata, never silently assumed.
  * Missing data is ``None``, never ``0``.
  * Every written file is validated as JSON and written atomically.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import random
import time
import urllib.error
import urllib.request
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

USER_AGENT = (
    "brazil-fx-monitor/1.0 (+https://github.com/thiagogabriell/brazil-fx-monitor) "
    "python-urllib"
)

TIMEOUT_SECONDS = 60
MAX_ATTEMPTS = 5
BACKOFF_BASE = 1.8

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z",
)
log = logging.getLogger("bfx")


class SourceUnavailable(RuntimeError):
    """Raised when a source could not be read after every retry."""


# --------------------------------------------------------------------------- #
# time
# --------------------------------------------------------------------------- #

def utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def sao_paulo_now() -> _dt.datetime:
    """Current time in America/Sao_Paulo (UTC-03:00, no DST since 2019)."""
    return _dt.datetime.now(_dt.timezone.utc).astimezone(
        _dt.timezone(_dt.timedelta(hours=-3))
    )


def today_sp() -> _dt.date:
    return sao_paulo_now().date()


def br_to_iso(value: str) -> str:
    """``24/11/2026`` -> ``2026-11-24``."""
    day, month, year = value.strip().split("/")
    return f"{year}-{month.zfill(2)}-{day.zfill(2)}"


def iso_to_br(value: str) -> str:
    year, month, day = value.split("-")
    return f"{day}/{month}/{year}"


# --------------------------------------------------------------------------- #
# numbers
# --------------------------------------------------------------------------- #

def parse_decimal_br(raw: str | None) -> Decimal | None:
    """Parse ``"675510000,00"`` / ``"5,834000"``. Empty or absent -> ``None``."""
    if raw is None:
        return None
    text = raw.strip().replace(" ", "")
    if not text:
        return None
    text = text.replace(".", "").replace(",", ".")
    try:
        return Decimal(text)
    except Exception:
        log.warning("could not parse decimal %r", raw)
        return None


def millions_to_usd(value: str | float | None) -> int | None:
    """SGS reserve series are published in millions of USD."""
    if value is None or value == "":
        return None
    return int((Decimal(str(value)) * Decimal(1_000_000)).to_integral_value())


def usd_cents(value: Decimal | None) -> int | None:
    """Store USD amounts as integer cents to keep arithmetic exact."""
    if value is None:
        return None
    return int((value * 100).to_integral_value())


# --------------------------------------------------------------------------- #
# http
# --------------------------------------------------------------------------- #

def fetch_bytes(url: str, *, timeout: int = TIMEOUT_SECONDS) -> bytes:
    """GET with exponential backoff plus jitter. Raises ``SourceUnavailable``."""
    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
            log.info("GET %s -> %s bytes (attempt %s)", url, len(payload), attempt)
            return payload
        except urllib.error.HTTPError as exc:
            last = exc
            # 4xx other than 429 will not be fixed by retrying.
            if exc.code != 429 and 400 <= exc.code < 500:
                raise SourceUnavailable(f"{url} -> HTTP {exc.code}") from exc
            log.warning("GET %s -> HTTP %s (attempt %s)", url, exc.code, attempt)
        except Exception as exc:  # noqa: BLE001 - network layer is broad
            last = exc
            log.warning("GET %s failed: %s (attempt %s)", url, exc, attempt)
        if attempt < MAX_ATTEMPTS:
            time.sleep(BACKOFF_BASE**attempt + random.uniform(0, 0.75))
    raise SourceUnavailable(f"{url} unavailable after {MAX_ATTEMPTS} attempts: {last}")


def fetch_json(url: str, *, timeout: int = TIMEOUT_SECONDS) -> Any:
    """GET and parse JSON.

    The BCB gateway intermittently answers HTTP 200 with an HTML error page, so
    a body that does not parse as JSON is treated as a transient failure and
    retried like a 5xx rather than reported as missing data.
    """
    last: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        payload = fetch_bytes(url, timeout=timeout)
        text = payload.decode("utf-8-sig", errors="replace").strip()
        if text:
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                last = exc
                log.warning(
                    "GET %s returned non-JSON body (attempt %s): %.120s",
                    url,
                    attempt,
                    text.replace("\n", " "),
                )
        else:
            last = SourceUnavailable("empty body")
            log.warning("GET %s returned an empty body (attempt %s)", url, attempt)
        if attempt < MAX_ATTEMPTS:
            time.sleep(BACKOFF_BASE**attempt + random.uniform(0, 0.75))
    raise SourceUnavailable(f"{url} did not return valid JSON: {last}")


# --------------------------------------------------------------------------- #
# io
# --------------------------------------------------------------------------- #

def read_json(path: Path) -> Any | None:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        log.warning("%s is not valid JSON; treating as absent", path)
        return None


def write_json(
    path: Path, payload: Any, *, sort_keys: bool = False, compact: bool = False
) -> bool:
    """Write ``payload`` only when the serialised content changed.

    Returns ``True`` when the file on disk was modified. ``collected_at``
    timestamps are ignored for the comparison so that a run that found no new
    data produces no commit.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        # Large datasets are minified; they are machine input, not review input.
        text = (
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=sort_keys,
            )
            + "\n"
        )
    else:
        text = (
            json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=sort_keys)
            + "\n"
        )

    previous = read_json(path)
    if previous is not None and _without_timestamps(previous) == _without_timestamps(
        payload
    ):
        log.info("%s unchanged", _display(path))
        return False

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))  # parse-back guard
    tmp.replace(path)
    log.info("%s written (%s bytes)", _display(path), len(text))
    return True


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


_VOLATILE_KEYS = {"collected_at", "generated_at", "last_collection_at"}


def _without_timestamps(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_timestamps(item)
            for key, item in value.items()
            if key not in _VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [_without_timestamps(item) for item in value]
    return value


def record_source_state(
    key: str,
    *,
    status: str,
    reference_date: str | None = None,
    detail: str | None = None,
    record_count: int | None = None,
) -> None:
    """Append/refresh one entry in ``data/metadata/collection-state.json``."""
    path = DATA / "metadata" / "collection-state.json"
    state = read_json(path) or {"sources": {}}
    state.setdefault("sources", {})
    previous = state["sources"].get(key, {})
    entry = {
        "status": status,
        "reference_date": reference_date,
        "record_count": record_count,
        "detail": detail,
        "collected_at": utc_now_iso(),
    }
    if status != "ok":
        # Keep the last good reference so the UI can show data age on failure.
        entry["last_successful_reference_date"] = previous.get(
            "last_successful_reference_date"
        ) or previous.get("reference_date")
        entry["last_successful_at"] = previous.get("last_successful_at") or previous.get(
            "collected_at"
        )
    else:
        entry["last_successful_reference_date"] = reference_date
        entry["last_successful_at"] = entry["collected_at"]
    state["sources"][key] = entry
    state["updated_at"] = utc_now_iso()
    # This file is intentionally timestamp-only sometimes; always persist it.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(state, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
