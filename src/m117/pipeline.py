"""Single entry point: run one (topology, document, seed) and write its JSONL log.

The attacks pair calls run() with the poisoned text and passes template_id and position, so the
checker can group results. Clean runs leave both as None.
"""
from __future__ import annotations

import traceback
from pathlib import Path

from .canary import make_canary
from .config import Config
from .context import RunContext
from .llm import BudgetExceeded, CostMeter, LLMClient, make_client
from .runlog import RunLogger
from .topologies import TOPOLOGIES


def make_run_id(topology: str, doc_id: str, template_id: str | None, position: str | None,
                seed: int) -> str:
    return f"{topology}__{doc_id}__{template_id or 'clean'}__{position or 'na'}__s{seed}"


def run(config: Config, *, topology: str, doc_id: str, doc_text: str, seed: int,
        template_id: str | None = None, position: str | None = None,
        llm: LLMClient | None = None, meter: CostMeter | None = None) -> Path:
    if topology not in TOPOLOGIES:
        raise ValueError(f"topology must be one of {sorted(TOPOLOGIES)}")
    meter = meter or CostMeter(config.budget_usd, config.prices_per_mtok)
    llm = llm or make_client(config, meter)

    run_id = make_run_id(topology, doc_id, template_id, position, seed)
    canary = make_canary(run_id)
    log_path = Path(config.log_dir) / "runs" / f"{run_id}.jsonl"
    logger = RunLogger(log_path, base={
        "run_id": run_id, "topology": topology, "doc_id": doc_id, "template_id": template_id,
        "position": position, "seed": seed, "model": llm.model,
    })
    ctx = RunContext(run_id=run_id, topology=topology, seed=seed, canary=canary,
                     config=config, llm=llm, logger=logger)

    logger.log("run_start", canary=canary, doc_text=doc_text, config=config.to_dict())
    status, final = "ok", ""
    try:
        final = TOPOLOGIES[topology](ctx, doc_text)
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
                   spent_usd=round(meter.spent_usd, 6))
        logger.close()
    return log_path
