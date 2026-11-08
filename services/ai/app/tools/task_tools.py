"""Proposal-only task tool. It never creates, assigns, approves, or executes."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.schemas import ProposedActionDraft
from app.tools.registry import ToolArgumentsInvalid, ToolContext


async def propose_task(
    ctx: ToolContext, args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    try:
        proposal = ProposedActionDraft.model_validate(args)
    except ValidationError as exc:
        # Do not echo model/provider validation internals.
        raise ToolArgumentsInvalid("The task proposal did not match the required schema.") from exc

    unknown = [eid for eid in proposal.evidence_ids if eid not in ctx.allowed_evidence_ids]
    if unknown:
        raise ToolArgumentsInvalid(
            "The task proposal cited evidence ids that were not returned by the evidence tool."
        )

    duplicate = next(
        (item for item in ctx.proposals if item.title.casefold() == proposal.title.casefold()),
        None,
    )
    if duplicate is not None:
        return (
            {
                "status": "PENDING",
                "recorded": True,
                "executed": False,
                "duplicate": True,
                "message": "An identical pending proposal already exists for this run.",
            },
            [],
            {"proposal_title": duplicate.title[:80], "duplicate": True, "executed": False},
        )

    ctx.proposals.append(proposal)
    return (
        {
            "proposal_id": f"prop_{ctx.run_id[-8:]}",
            "status": "PENDING",
            "recorded": True,
            "executed": False,
            "duplicate": False,
            "message": (
                "Proposal recorded for human review only. This tool cannot create, assign, "
                "approve, or execute a task."
            ),
            "proposal": proposal.model_dump(mode="json"),
        },
        [],
        {
            "proposal_title": proposal.title[:80],
            "approval_status": "PENDING",
            "executed": False,
        },
    )


HANDLERS = {"propose_task": propose_task}
