"""Proposal-only task tool. It never creates, assigns, approves, or executes."""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import ValidationError

from app.schemas import ProposedTaskDraft
from app.tools.registry import ToolArgumentsInvalid, ToolContext


async def propose_task(
    ctx: ToolContext, args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    try:
        proposal = ProposedTaskDraft.model_validate(args)
    except ValidationError as exc:
        # Do not echo model/provider validation internals.
        raise ToolArgumentsInvalid("The task proposal did not match the required schema.") from exc

    if proposal.requires_human_approval is not True:
        raise ToolArgumentsInvalid("AI proposals must require human approval.")

    unknown = [eid for eid in proposal.evidence_ids if eid not in ctx.allowed_evidence_ids]
    if unknown:
        raise ToolArgumentsInvalid(
            "The task proposal cited evidence ids that were not returned by the evidence tool."
        )
    if proposal.evidence_basis == "EVIDENCE_BACKED" and not proposal.evidence_ids:
        raise ToolArgumentsInvalid("An evidence-backed proposal must cite evidence ids.")

    duplicate = next(
        (item for item in ctx.proposals if item.title.casefold() == proposal.title.casefold()),
        None,
    )
    if duplicate is not None:
        return (
            {
                "status": "PENDING_HUMAN_APPROVAL",
                "recorded": True,
                "executed": False,
                "duplicate": True,
                "message": "An identical pending proposal already exists for this run.",
            },
            [],
            {"proposal_title": duplicate.title[:80], "duplicate": True, "executed": False},
        )

    ctx.proposals.append(proposal)
    signature = hashlib.sha256(
        f"{ctx.run_id}:{proposal.title.casefold()}".encode("utf-8")
    ).hexdigest()[:16]
    return (
        {
            "proposal_id": f"prop_{signature}",
            "status": "PENDING_HUMAN_APPROVAL",
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
            "approval_status": "PENDING_HUMAN_APPROVAL",
            "executed": False,
        },
    )


HANDLERS = {"propose_task": propose_task}
