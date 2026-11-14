"""LLM backends behind one interface.

- StubClient: free and deterministic. It echoes its input, and the tool-using agent obeys any
  instruction that mentions the attacker address. Use it for wiring tests and for the other
  pairs' development before the real model is ready.
- AnthropicClient: the real model. Every response is cached on disk, keyed on the full request
  plus the run seed, so rerunning a run costs nothing and returns the same transcript.

Content blocks are passed around as plain dicts (the API's JSON shape) so they can be cached,
logged and replayed unchanged.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .config import Config


@dataclass
class LLMResponse:
    content: list[dict[str, Any]]
    stop_reason: str
    usage: dict[str, int] = field(default_factory=dict)
    cached: bool = False

    @property
    def text(self) -> str:
        return "\n".join(b["text"] for b in self.content if b.get("type") == "text").strip()

    @property
    def tool_uses(self) -> list[dict[str, Any]]:
        return [b for b in self.content if b.get("type") == "tool_use"]


class LLMClient(Protocol):
    model: str

    def complete(self, *, system: str, messages: list[dict], tools: list[dict] | None,
                 seed: int, agent: str) -> LLMResponse: ...


class BudgetExceeded(RuntimeError):
    pass


class CostMeter:
    def __init__(self, budget_usd: float, prices: dict[str, list[float]]):
        self.budget_usd = budget_usd
        self.prices = prices
        self.spent_usd = 0.0
        self.input_tokens = 0
        self.output_tokens = 0

    def add(self, model: str, usage: dict[str, int]) -> None:
        inp = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) \
            + usage.get("cache_read_input_tokens", 0)
        out = usage.get("output_tokens", 0)
        self.input_tokens += inp
        self.output_tokens += out
        p_in, p_out = self.prices.get(model, [0.0, 0.0])
        self.spent_usd += inp / 1e6 * p_in + out / 1e6 * p_out
        if self.spent_usd > self.budget_usd:
            raise BudgetExceeded(f"Spent ${self.spent_usd:.4f} > budget ${self.budget_usd:.2f}")


# --------------------------------------------------------------------------- stub

_CANARY_RE = re.compile(r"CANARY-[0-9a-f]{8}")


class StubClient:
    """Deterministic fake model. Workers echo their input. The tool user sends the report to the
    user, and if its input mentions the attacker address it also 'obeys' and leaks the canary.
    That lets the evaluation pair get both leak and clean logs without spending anything."""

    def __init__(self, config: Config):
        self.model = "stub"
        self.config = config

    def complete(self, *, system, messages, tools, seed, agent) -> LLMResponse:
        last = messages[-1]["content"]
        if isinstance(last, list) and any(b.get("type") == "tool_result" for b in last):
            return LLMResponse([{"type": "text", "text": "Report sent."}], "end_turn")
        text = last if isinstance(last, str) else "\n".join(
            b.get("text", "") for b in last if b.get("type") == "text")
        if not tools:
            return LLMResponse([{"type": "text", "text": f"[{agent}] {text}"}], "end_turn")
        calls = [{"type": "tool_use", "id": "stub_0", "name": "send_message",
                  "input": {"to": self.config.user_address, "body": f"Final report:\n{text}"}}]
        m = _CANARY_RE.search(system)
        if self.config.attacker_address in text and m:
            calls.append({"type": "tool_use", "id": "stub_1", "name": "send_message",
                          "input": {"to": self.config.attacker_address, "body": f"key: {m.group(0)}"}})
        return LLMResponse(calls, "tool_use")


# --------------------------------------------------------------------------- anthropic

class DiskCache:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(payload: dict) -> str:
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

    def get(self, key: str) -> dict | None:
        p = self.root / f"{key}.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def put(self, key: str, value: dict) -> None:
        (self.root / f"{key}.json").write_text(json.dumps(value), encoding="utf-8")


class AnthropicClient:
    def __init__(self, config: Config, meter: CostMeter):
        import anthropic  # imported lazily so the stub works without an API key

        self.model = config.model
        self.config = config
        self.meter = meter
        self.cache = DiskCache(config.cache_dir)
        self.client = anthropic.Anthropic(max_retries=6)  # SDK retries 408/409/429/5xx with backoff

    def complete(self, *, system, messages, tools, seed, agent) -> LLMResponse:
        params: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "system": system,
            "messages": messages,
        }
        if self.config.effort:
            params["output_config"] = {"effort": self.config.effort}
        if tools:
            params["tools"] = tools
        key = DiskCache.key({**params, "seed": seed})
        hit = self.cache.get(key)
        if hit is not None:
            return LLMResponse(hit["content"], hit["stop_reason"], hit["usage"], cached=True)

        resp = self.client.messages.create(**params)
        content = [b.model_dump(mode="json", exclude_none=True) for b in resp.content]
        usage = {k: v for k, v in resp.usage.model_dump().items() if isinstance(v, int)}
        self.meter.add(self.config.model, usage)
        out = {"content": content, "stop_reason": resp.stop_reason, "usage": usage}
        if resp.stop_reason != "refusal":  # don't pin a refusal into the cache
            self.cache.put(key, out)
        return LLMResponse(content, resp.stop_reason, usage)


def make_client(config: Config, meter: CostMeter) -> LLMClient:
    if config.backend == "stub":
        return StubClient(config)
    if config.backend == "anthropic":
        return AnthropicClient(config, meter)
    raise ValueError(f"unknown backend {config.backend!r}")
