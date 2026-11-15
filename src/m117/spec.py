"""Pipeline specs: a pipeline is a small graph described in JSON, not a hardcoded function.

    pipelines/chain.json, pipelines/orchestrator.json    built-in presets (read-only)
    pipelines/custom/<id>.json                           pipelines made in the viewer

Node types
    agent        one model call: input text in, output text out (the Reader, the Analyst)
    tool_agent   an agent that may call send_message in a short loop (the Reporter)
    hub          an LLM orchestrator. It relays, in order, to each of its `spokes`
                 (hub -> spoke -> hub), keeping one running conversation. Spokes are not
                 wired with edges; the hub reaches them itself.
`user` is implicit: edges may start at "user" (the document comes in) and the output node may
have one edge to "user" (the final report goes out).

Every delivery between nodes goes through ctx.message(), which stays the one hook point for the
defense. validate() is the single validator; the viewer's pipeline editor calls it through
scripts/validate_pipeline.py instead of reimplementing it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .agents import Agent, Orchestrator, ToolUser
from .context import RunContext

ROOT = Path(__file__).resolve().parents[2]
PIPELINES_DIR = ROOT / "pipelines"
CUSTOM_DIR = PIPELINES_DIR / "custom"

ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")  # also used in file names and run ids
NODE_TYPES = ("agent", "tool_agent", "hub")
PLACEHOLDERS = ("canary", "user_address", "questions")
_PH_RE = re.compile(r"\{(\w+)\}")


class SpecError(ValueError):
    """The pipeline spec is invalid. The message lists every problem found."""


# --------------------------------------------------------------------------- loading

def _path_for(pid: str) -> Path | None:
    if not ID_RE.fullmatch(pid):
        return None
    for d in (PIPELINES_DIR, CUSTOM_DIR):
        p = d / f"{pid}.json"
        if p.is_file():
            return p
    return None


def load_spec(pid: str) -> dict[str, Any]:
    p = _path_for(pid)
    if p is None:
        raise SpecError(f"unknown pipeline {pid!r}; available: {[s['id'] for s in list_specs()]}")
    spec = json.loads(p.read_text(encoding="utf-8"))
    validate(spec)
    return spec


def list_specs() -> list[dict[str, Any]]:
    """Every pipeline file, presets first. Files that fail to parse are skipped, not fatal."""
    out = []
    for d, builtin in ((PIPELINES_DIR, True), (CUSTOM_DIR, False)):
        for p in sorted(d.glob("*.json")) if d.is_dir() else []:
            try:
                spec = json.loads(p.read_text(encoding="utf-8"))
                spec["builtin"] = builtin
                out.append(spec)
            except (OSError, json.JSONDecodeError):
                continue
    out.sort(key=lambda s: (not s.get("builtin"), s["id"] != "chain", s["id"] != "orchestrator", s["id"]))
    return out


# --------------------------------------------------------------------------- validation

def _spokes(spec: dict) -> set[str]:
    return {s for n in spec.get("nodes", []) if isinstance(n, dict) and n.get("type") == "hub"
            for s in n.get("spokes") or [] if isinstance(s, str)}


def validate(spec: Any) -> list[str]:
    """Raise SpecError listing every problem; return a list of non-fatal warnings."""
    errs: list[str] = []
    warns: list[str] = []
    if not isinstance(spec, dict):
        raise SpecError("the pipeline must be a JSON object")

    pid = spec.get("id")
    if not isinstance(pid, str) or not ID_RE.fullmatch(pid) or "__" in pid:
        errs.append("id: letters, digits, _ . - only (max 64), and no double underscore")
    nodes = spec.get("nodes")
    edges = spec.get("edges")
    if not isinstance(nodes, list) or not nodes:
        raise SpecError("; ".join(errs + ["nodes: need at least one node"]))
    if not isinstance(edges, list):
        raise SpecError("; ".join(errs + ["edges: must be a list"]))

    ids: list[str] = []
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            errs.append(f"nodes[{i}]: must be an object")
            continue
        nid = n.get("id")
        if not isinstance(nid, str) or not ID_RE.fullmatch(nid) or "__" in nid:
            errs.append(f"nodes[{i}].id: letters, digits, _ . - only, no double underscore")
            continue
        if nid == "user":
            errs.append('a node cannot be called "user" (that is the implicit source and sink)')
        if nid in ids:
            errs.append(f"duplicate node id {nid!r}")
        ids.append(nid)
        if n.get("type") not in NODE_TYPES:
            errs.append(f"{nid}: type must be one of {list(NODE_TYPES)}")
        if not isinstance(n.get("system"), str) or not n["system"].strip():
            errs.append(f"{nid}: system prompt is empty")
        else:
            for ph in _PH_RE.findall(n["system"]):
                if ph not in PLACEHOLDERS:
                    errs.append(f"{nid}: unknown placeholder {{{ph}}} (allowed: "
                                + ", ".join("{%s}" % p for p in PLACEHOLDERS) + ")")
            has_ph = "{canary}" in n["system"]
            if n.get("holds_canary") and not has_ph:
                warns.append(f"{nid}: marked holds_canary but its prompt has no {{canary}}")
            if has_ph and not n.get("holds_canary"):
                warns.append(f"{nid}: prompt has {{canary}} but holds_canary is not set")

    idset = set(ids)
    spokes = _spokes(spec)
    hubs = [n for n in nodes if isinstance(n, dict) and n.get("type") == "hub"]
    seen_spokes: set[str] = set()
    for h in hubs:
        sp = h.get("spokes")
        if not isinstance(sp, list) or not sp:
            errs.append(f"{h.get('id')}: a hub needs a non-empty spokes list")
            continue
        for s in sp:
            if s not in idset:
                errs.append(f"{h['id']}: spoke {s!r} is not a node")
            elif s == h["id"]:
                errs.append(f"{h['id']}: a hub cannot be its own spoke")
            elif s in seen_spokes:
                errs.append(f"{s}: is a spoke of more than one hub")
            else:
                by_id = next(n for n in nodes if n.get("id") == s)
                if by_id.get("type") == "hub":
                    errs.append(f"{s}: a hub cannot be a spoke")
            seen_spokes.add(s)

    out = spec.get("output")
    if out not in idset:
        errs.append(f"output: {out!r} is not a node")
    elif out in spokes:
        errs.append(f"output: {out!r} is a spoke; make its hub the output instead")

    main = [i for i in ids if i not in spokes]
    adj: dict[str, list[str]] = {i: [] for i in main}
    has_user_in = False
    pairs: set[tuple[str, str]] = set()
    for i, e in enumerate(edges):
        if not isinstance(e, dict):
            errs.append(f"edges[{i}]: must be an object")
            continue
        a, b = e.get("from"), e.get("to")
        label = f"edge {a} -> {b}"
        ok = True
        for end, name in ((a, "from"), (b, "to")):
            if end != "user" and end not in idset:
                errs.append(f"{label}: {name} {end!r} is not a node")
                ok = False
            elif end in spokes:
                errs.append(f"{label}: {end!r} is a spoke, so its hub reaches it; do not wire it")
                ok = False
        if not ok:
            continue
        if a == b:
            errs.append(f"{label}: a node cannot connect to itself")
        elif a == "user" and b == "user":
            errs.append(f"{label}: nonsense")
        elif (a, b) in pairs:
            errs.append(f"{label}: listed twice")
        elif b == "user":
            if a != out:
                errs.append(f"{label}: only the output node ({out!r}) can send to user")
        elif a == "user":
            has_user_in = True
        pairs.add((a, b))
        if a != "user" and b != "user" and a != b:
            adj[a].append(b)
    if not has_user_in:
        errs.append('no edge from "user": nothing receives the document')

    # cycles (Kahn) over the non-spoke nodes
    indeg = {i: 0 for i in main}
    for a in adj:
        for b in adj[a]:
            indeg[b] += 1
    q = [i for i in main if indeg[i] == 0]
    done = 0
    while q:
        x = q.pop()
        done += 1
        for y in adj[x]:
            indeg[y] -= 1
            if indeg[y] == 0:
                q.append(y)
    if done != len(main):
        errs.append("the edges contain a cycle")

    # reachable from user
    reach: set[str] = set()
    stack = [b for (a, b) in pairs if a == "user" and b != "user"]
    while stack:
        x = stack.pop()
        if x in reach or x not in adj:
            continue
        reach.add(x)
        stack.extend(adj[x])
    for i in main:
        if i not in reach and has_user_in:
            errs.append(f"{i}: not reachable from user")

    # warnings: dead ends and a missing canary holder
    if out in idset and not errs:
        rev: dict[str, list[str]] = {i: [] for i in main}
        for a in adj:
            for b in adj[a]:
                rev[b].append(a)
        feeds, stack = set(), [out]
        while stack:
            x = stack.pop()
            if x in feeds:
                continue
            feeds.add(x)
            stack.extend(rev.get(x, []))
        for i in main:
            if i not in feeds:
                warns.append(f"{i}: its output never reaches the output node")
    if not any(isinstance(n, dict) and n.get("holds_canary") for n in nodes):
        warns.append("no node holds the canary, so attack success is undefined for this pipeline")

    if errs:
        raise SpecError("; ".join(errs))
    return warns


# --------------------------------------------------------------------------- running

def _topo_order(spec: dict) -> list[str]:
    spokes = _spokes(spec)
    main = [n["id"] for n in spec["nodes"] if n["id"] not in spokes]
    indeg = {i: 0 for i in main}
    nxt: dict[str, list[str]] = {i: [] for i in main}
    for e in spec["edges"]:
        if e["from"] != "user" and e["to"] != "user":
            nxt[e["from"]].append(e["to"])
            indeg[e["to"]] += 1
    order: list[str] = []
    ready = [i for i in main if indeg[i] == 0]
    while ready:
        ready.sort(key=main.index)  # declaration order breaks ties, so runs are reproducible
        x = ready.pop(0)
        order.append(x)
        for y in nxt[x]:
            indeg[y] -= 1
            if indeg[y] == 0:
                ready.append(y)
    return order


def render_system(node: dict, ctx: RunContext) -> str:
    """Fill {canary}, {user_address} and {questions}. Other braces (JSON examples) are left alone."""
    vals = {
        "canary": ctx.canary,
        "user_address": ctx.config.user_address,
        "questions": "\n".join(f"{i}. {q}" for i, q in enumerate(ctx.config.questions, 1)),
    }
    return _PH_RE.sub(lambda m: vals.get(m.group(1), m.group(0)), node["system"])


def describe(spec: dict, ctx: RunContext) -> dict:
    """The spec with each node's rendered system prompt added; logged in run_start."""
    d = json.loads(json.dumps(spec))
    d.pop("builtin", None)
    for n in d["nodes"]:
        n["system_rendered"] = render_system(n, ctx)
    return d


def _doc_block(doc: str) -> str:
    return f"<document>\n{doc}\n</document>"


def _build(node: dict, ctx: RunContext):
    system = render_system(node, ctx)
    if node["type"] == "agent":
        return Agent(node["id"], system)
    if node["type"] == "tool_agent":
        return ToolUser(node["id"], system)
    return Orchestrator(node["id"], system)


def _run_hub(ctx: RunContext, hub_node: dict, hub: Orchestrator, nodes: dict, agents: dict,
             received: str) -> str:
    """hub -> spoke -> hub for each spoke in order, then return the last spoke's reply."""
    sp_ids = hub_node["spokes"]
    to_spoke = hub.turn(ctx, received)
    reply = ""
    for k, sid in enumerate(sp_ids):
        ctx.message(hub_node["id"], sid, to_spoke)
        reply = agents[sid].step(ctx, to_spoke)
        if k < len(sp_ids) - 1:
            nxt = nodes[sp_ids[k + 1]].get("label", sp_ids[k + 1])
            back = f"The {nodes[sid].get('label', sid)} returned:\n{reply}\n\nWrite the message for the {nxt}."
            ctx.message(sid, hub_node["id"], back)
            to_spoke = hub.turn(ctx, back)
        else:
            ctx.message(sid, hub_node["id"], reply)
    return reply


def run_spec(ctx: RunContext, spec: dict, doc: str) -> str:
    validate(spec)
    nodes = {n["id"]: n for n in spec["nodes"]}
    agents = {nid: _build(n, ctx) for nid, n in nodes.items()}
    label = lambda x: "User" if x == "user" else nodes[x].get("label", x)  # noqa: E731
    outputs: dict[str, str] = {}

    for nid in _topo_order(spec):
        node = nodes[nid]
        ins = [e for e in spec["edges"] if e["to"] == nid]
        payloads = [(e["from"], _doc_block(doc) if e["from"] == "user" else outputs[e["from"]]) for e in ins]
        joined = payloads[0][1] if len(payloads) == 1 else "\n\n".join(
            f"From {label(src)}:\n{text}" for src, text in payloads)

        if node["type"] == "hub":
            first = nodes[node["spokes"][0]].get("label", node["spokes"][0])
            task = node.get("task") or "Handle the input below."
            received = f"New task from the user: {task}\n\n{joined}\n\nWrite the message for the {first}."
        else:
            received = joined

        # one logged message per incoming edge. With a single input it is exactly what the
        # node receives; with several, each is logged raw and the node gets them joined.
        for src, text in payloads:
            ctx.message(src, nid, received if len(payloads) == 1 else text)

        if node["type"] == "hub":
            outputs[nid] = _run_hub(ctx, node, agents[nid], nodes, agents, received)
        else:
            outputs[nid] = agents[nid].step(ctx, received)

        if any(e["from"] == nid and e["to"] == "user" for e in spec["edges"]):
            ctx.message(nid, "user", outputs[nid])

    return outputs[spec["output"]]
