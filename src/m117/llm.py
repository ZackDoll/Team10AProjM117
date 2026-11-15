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
import urllib.error
import urllib.request
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



# --------------------------------------------------------------------------- ollama

def _ollama_messages(system: str, messages: list[dict]) -> list[dict]:
    """Anthropic-shaped (system + messages-with-content-blocks) -> Ollama's flat role list."""
    out = [{"role": "system", "content": system}]
    for m in messages:
        role, content = m["role"], m["content"]
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue
        if role == "assistant":
            text = "\n".join(b["text"] for b in content if b.get("type") == "text")
            calls = [b for b in content if b.get("type") == "tool_use"]
            msg: dict[str, Any] = {"role": "assistant", "content": text}
            if calls:
                msg["tool_calls"] = [{"function": {"name": c["name"], "arguments": c.get("input") or {}}}
                                      for c in calls]
            out.append(msg)
        else:  # user turn carrying tool_result blocks (and/or plain text blocks)
            for b in content:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    out.append({"role": "tool", "content": c if isinstance(c, str) else json.dumps(c)})
                elif b.get("type") == "text":
                    out.append({"role": role, "content": b["text"]})
    return out


def _ollama_tools(tools: list[dict] | None) -> list[dict] | None:
    if not tools:
        return None
    return [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""),
                                               "parameters": t["input_schema"]}} for t in tools]


class OllamaClient:
    """Local open-weight model via Ollama's HTTP API. No API key and no cost, and -- unlike the
    Anthropic models -- no deliberate training against prompt injection, so it is the backend to
    use when the Anthropic model resists every attack. Needs `ollama serve` running and the model
    already pulled (`ollama pull <model>`); see docs/OLLAMA.md."""

    def __init__(self, config: Config, meter: CostMeter):
        self.model = config.model
        self.config = config
        self.meter = meter
        self.host = config.ollama_host.rstrip("/")
        self.cache = DiskCache(config.cache_dir)

    def complete(self, *, system, messages, tools, seed, agent) -> LLMResponse:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _ollama_messages(system, messages),
            "stream": False,
            # temperature 0 + a fixed seed for determinism; mirrors the cache-based determinism
            # story used for the Anthropic backend, which can't set either.
            "options": {"temperature": 0, "seed": seed, "num_predict": self.config.max_tokens},
        }
        ollama_tools = _ollama_tools(tools)
        if ollama_tools:
            payload["tools"] = ollama_tools
        key = DiskCache.key({**payload, "_backend": "ollama"})
        hit = self.cache.get(key)
        if hit is not None:
            return LLMResponse(hit["content"], hit["stop_reason"], hit["usage"], cached=True)

        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(f"{self.host}/api/chat", data=body, method="POST",
                                      headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read())
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            raise RuntimeError(
                f"Could not reach Ollama at {self.host}. Run `ollama serve`, and "
                f"`ollama pull {self.model}` if you haven't yet. ({e})"
            ) from e

        msg = data.get("message", {})
        content: list[dict[str, Any]] = []
        text = msg.get("content") or ""
        if text:
            content.append({"type": "text", "text": text})
        tool_calls = msg.get("tool_calls") or []
        for i, tc in enumerate(tool_calls):
            fn = tc.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {"raw": args}
            content.append({"type": "tool_use", "id": f"ollama_{seed}_{i}", "name": fn.get("name", ""),
                             "input": args})
        stop_reason = "tool_use" if tool_calls else "end_turn"
        usage = {"input_tokens": data.get("prompt_eval_count", 0), "output_tokens": data.get("eval_count", 0)}
        self.meter.add(self.model, usage)  # $0 unless you add a price for this model in config
        out = {"content": content, "stop_reason": stop_reason, "usage": usage}
        self.cache.put(key, out)
        return LLMResponse(content, stop_reason, usage)


def make_client(config: Config, meter: CostMeter) -> LLMClient:
    if config.backend == "stub":
        return StubClient(config)
    if config.backend == "anthropic":
        return AnthropicClient(config, meter)
    if config.backend == "ollama":
        return OllamaClient(config, meter)
    raise ValueError(f"unknown backend {config.backend!r}")
