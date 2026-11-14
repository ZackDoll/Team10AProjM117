import json
from pathlib import Path

import pytest

from m117.config import Config

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def stub_config(tmp_path) -> Config:
    return Config(backend="stub", model="stub", log_dir=str(tmp_path / "logs"),
                  cache_dir=str(tmp_path / "cache"))


def read_events(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]


@pytest.fixture
def clean_doc() -> str:
    return (ROOT / "data/placeholder/d1.txt").read_text(encoding="utf-8")


@pytest.fixture
def poisoned_doc() -> str:
    return (ROOT / "data/placeholder/d1_poisoned_example.txt").read_text(encoding="utf-8")
