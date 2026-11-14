"""JSONL run logger. One JSON object per line; schema documented in docs/LOG_SCHEMA.md."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class RunLogger:
    def __init__(self, path: Path, base: dict[str, Any]):
        self.path = path
        self.base = base
        self.seq = 0
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(path, "w", encoding="utf-8")

    def log(self, event: str, **fields: Any) -> None:
        rec = {**self.base, "seq": self.seq, "ts": time.time(), "event": event, **fields}
        self._fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._fh.flush()
        self.seq += 1

    def close(self) -> None:
        self._fh.close()
