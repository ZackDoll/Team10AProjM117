"""Agents. An agent turns one input message into one output string. The topology decides where
that input comes from and where the output goes, and logs both.

Every LLM call is logged as an `llm_call` event (usage, cache hit, stop reason). Messages
between agents are logged by the topology through RunContext.message().
"""
from __future__ import annotations

import json

from .context import RunContext
from .llm import LLMResponse
from .tools import SEND_MESSAGE_TOOL, TOOL_IMPLS


def _call(ctx: RunContext, agent: str, system: str, messages: list[dict],
          tools: list[dict] | None = None) -> LLMResponse:
    resp = ctx.llm.complete(system=system, messages=messages, tools=tools, seed=ctx.seed, agent=agent)
    ctx.logger.log("llm_call", agent=agent, stop_reason=resp.stop_reason, usage=resp.usage,
                   cached=resp.cached)
    if resp.stop_reason == "refusal":
        ctx.logger.log("error", agent=agent, kind="refusal")
    return resp


class Agent:
    """Single-turn worker with no tools (the reader and the analyst)."""

    def __init__(self, name: str, system: str):
        self.name = name
        self.system = system

    def step(self, ctx: RunContext, input_text: str) -> str:
        return _call(ctx, self.name, self.system, [{"role": "user", "content": input_text}]).text


class ToolUser(Agent):
    """Has send_message. Runs a short tool loop. Every call goes through tools.send_message,
    which only writes to the log."""

    def step(self, ctx: RunContext, input_text: str) -> str:
        messages: list[dict] = [{"role": "user", "content": input_text}]
        resp = None
        for _ in range(ctx.config.tool_user_max_turns):
            resp = _call(ctx, self.name, self.system, messages, tools=[SEND_MESSAGE_TOOL])
            if resp.stop_reason != "tool_use" or not resp.tool_uses:
                break
            messages.append({"role": "assistant", "content": resp.content})
            results = []
            for tu in resp.tool_uses:
                impl = TOOL_IMPLS.get(tu["name"])
                args = tu.get("input") or {}
                if isinstance(args, str):
                    args = json.loads(args)
                if impl is None:
                    out, is_err = f"unknown tool {tu['name']}", True
                else:
                    out, is_err = impl(ctx, self.name, str(args.get("to", "")), str(args.get("body", ""))), False
                results.append({"type": "tool_result", "tool_use_id": tu["id"], "content": out,
                                **({"is_error": True} if is_err else {})})
            messages.append({"role": "user", "content": results})
        return resp.text if resp else ""


class Orchestrator:
    """Hub agent. It keeps one running conversation across the whole task, and each turn it
    writes the message that the next worker receives."""

    def __init__(self, name: str, system: str):
        self.name = name
        self.system = system
        self.messages: list[dict] = []

    def turn(self, ctx: RunContext, content: str) -> str:
        self.messages.append({"role": "user", "content": content})
        resp = _call(ctx, self.name, self.system, self.messages)
        self.messages.append({"role": "assistant", "content": resp.content or [{"type": "text", "text": ""}]})
        return resp.text
