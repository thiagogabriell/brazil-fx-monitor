import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

DATA = ROOT / "data"


def _load(relative):
    path = DATA / relative
    if not path.exists():
        pytest.skip(f"{relative} not collected yet")
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def operations_document():
    return _load("interventions/operations.json")


@pytest.fixture(scope="session")
def operations(operations_document):
    return operations_document["operations"]


@pytest.fixture(scope="session")
def summary():
    return _load("indicators/summary.json")


@pytest.fixture(scope="session")
def series():
    return _load("indicators/series.json")


@pytest.fixture(scope="session")
def statement_cash():
    return _load("reserves/statement-latest-cash.json")


@pytest.fixture(scope="session")
def statement_liquidity():
    return _load("reserves/statement-latest-liquidity.json")


@pytest.fixture(scope="session")
def reserves_cash():
    return _load("reserves/cash.json")


@pytest.fixture(scope="session")
def pressure():
    return _load("indicators/pressure.json")


@pytest.fixture(scope="session")
def composition():
    return _load("composition/composition.json")


@pytest.fixture(scope="session")
def flow():
    return _load("exchange-flow/balance-of-payments.json")
