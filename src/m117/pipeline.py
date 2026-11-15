"""Single entry point: run one (topology, document, seed) and write its JSONL log.

The attacks pair calls run() with the poisoned text and passes template_id and position, so the
checker can group results. Clean runs leave both as None.
"""
from __future__ import annotations

import re
import sys
import traceback
from pathlib import Path

from .canary import make_canary
from .config import Config
from .context import RunContext
from .llm import BudgetExceeded, CostMeter, LLMClient, make_client
from .runlog import RunLogger
from .spec import describe, load_spec, run_spec, validate
from .transcript import write_transcript


def model_slug(model: str) -> str:
    """A model name made safe for a file name: 'qwen2.5:3b-instruct' -> 'qwen2.5-3b-instruct'.
    viz/src/api.ts has the same function; the batch tab uses it to predict run ids."""
    return re.sub(r"[^A-Za-z0-9.]+", "-", model).strip("-") or "unknown"


def effective_model(config: Config) -> str:
    """The model a run will actually use: the stub backend ignores config.model."""
    return "stub" if config.backend == "stub" else config.model


def make_run_id(topology: str, doc_id: str, template_id: str | None, position: str | None,
                seed: int, model: str) -> str:
    """{pipeline}__{doc}__{template|clean}__{position|na}__s{seed}__{model}.

    The model is part of the id so that running the same combination on two models gives two logs
    instead of the second replacing the first. The first five fields are unchanged."""
    return (f"{topology}__{doc_id}__{template_id or 'clean'}__{position or 'na'}__s{seed}"
            f"__{model_slug(model)}")


def run(config: Config, *, topology: str | None = None, doc_id: str, doc_text: str, seed: int,
        template_id: str | None = None, position: str | None = None,
        llm: LLMClient | None = None, meter: CostMeter | None = None,
        spec: dict | None = None) -> Path:
    """`topology` is a pipeline id (pipelines/<id>.json). Pass `spec` to run an unsaved pipeline
    instead; its id becomes the topology label in the log and the run id."""
    if spec is None:
        if not topology:
            raise ValueError("give a pipeline id (topology) or a spec")
        spec = load_spec(topology)  # SpecError (a ValueError) if unknown or invalid
    else:
        validate(spec)
        topology = spec["id"]
    meter = meter or CostMeter(config.budget_usd, config.prices_per_mtok)
    llm = llm or make_client(config, meter)

    run_id = make_run_id(topology, doc_id, template_id, position, seed, llm.model)
    canary = make_canary(run_id)
    log_path = Path(config.log_dir) / "runs" / f"{run_id}.jsonl"
    logger = RunLogger(log_path, base={
        "run_id": run_id, "topology": topology, "doc_id": doc_id, "template_id": template_id,
        "position": position, "seed": seed, "model": llm.model,
    })
    ctx = RunContext(run_id=run_id, topology=topology, seed=seed, canary=canary,
                     config=config, llm=llm, logger=logger)

    spent_before = meter.spent_usd  # the meter may be shared by a whole batch
    logger.log("run_start", canary=canary, doc_text=doc_text, config=config.to_dict(),
               pipeline=describe(spec, ctx))
    status, final = "ok", ""
    try:
        final = run_spec(ctx, spec, doc_text)
    except BudgetExceeded:
        status = "budget_exceeded"
        logger.log("error", kind="budget_exceeded", detail=traceback.format_exc())
        raise
    except Exception:
        status = "error"
        logger.log("error", kind="exception", detail=traceback.format_exc())
        raise
    finally:
        logger.log("run_end", status=status, final_output=final,
                   cost_usd=round(meter.spent_usd - spent_before, 6),
                   spent_usd=round(meter.spent_usd, 6))
        logger.close()
        try:
            write_transcript(log_path, Path(config.log_dir) / "transcripts")
        except Exception as e:  # a transcript problem must never lose or fail the run
            print(f"warning: could not write transcript: {type(e).__name__}: {e}", file=sys.stderr)
    return log_path
