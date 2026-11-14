from __future__ import annotations

from dataclasses import dataclass

from .config import Config
from .llm import LLMClient
from .runlog import RunLogger


@dataclass
class RunContext:
    run_id: str
    topology: str
    seed: int
    canary: str
    config: Config
    llm: LLMClient
    logger: RunLogger
    hop: int = 0

    def message(self, sender: str, receiver: str, content: str) -> None:
        self.logger.log("message", sender=sender, receiver=receiver, content=content, hop=self.hop)
        self.hop += 1
