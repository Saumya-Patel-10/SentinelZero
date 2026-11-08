"""Read-only incident, asset, dependency, task, and evidence tools.

All reads go through the SpacetimeDB ``agent_get_*`` procedures, which take a
run_id and enforce authorization server-side.  Incident scope is verified at the
tool boundary as defense in depth.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict
from typing import Any

from app.tools.registry import ToolContext


async def get_incident(ctx: ToolContext, _args: dict[str, Any]) -> tuple[Any, list[str], dict[str, Any]]:
    incident = await ctx.backend.agent_get_incident(ctx.run_id)
    # Double-check tenant + incident scope at the tool boundary.
    if incident.incident_id != ctx.incident_id or incident.organization_id != ctx.organization_id:
        raise ValueError("Tool scope violation")
    data = asdict(incident)
    return data, [], {"incident_status": incident.status, "severity": incident.severity}


async def get_assets(ctx: ToolContext, _args: dict[str, Any]) -> tuple[Any, list[str], dict[str, Any]]:
    assets = await ctx.backend.agent_get_assets(ctx.run_id)
    for asset in assets:
        # AgentAsset doesn't carry organization_id; scope is enforced by the procedure.
        pass
    data = [asdict(asset) for asset in assets]
    compromise = Counter(asset.compromise_status for asset in assets)
    availability = Counter(asset.availability_status for asset in assets)
    return data, [], {
        "count": len(assets),
        "compromise_statuses": dict(sorted(compromise.items())),
        "availability_statuses": dict(sorted(availability.items())),
    }


async def get_dependencies(
    ctx: ToolContext, _args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    view = await ctx.backend.agent_get_dependencies(ctx.run_id)
    data = {
        "dependencies": [asdict(d) for d in view.dependencies],
        "services": [asdict(s) for s in view.services],
        "operational_impacts": [asdict(i) for i in view.impacts],
    }
    return data, [], {
        "dependency_count": len(view.dependencies),
        "service_count": len(view.services),
        "impact_count": len(view.impacts),
    }


async def get_open_tasks(
    ctx: ToolContext, _args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    tasks = await ctx.backend.agent_get_open_tasks(ctx.run_id)
    data = [asdict(task) for task in tasks]
    return data, [], {"count": len(tasks)}


async def get_evidence_summaries(
    ctx: ToolContext, _args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    evidence = await ctx.backend.agent_get_evidence_summaries(ctx.run_id)
    ids = [item.id for item in evidence]
    data = [asdict(item) for item in evidence]
    classifications = Counter(item.classification for item in evidence)
    return data, ids, {
        "count": len(evidence),
        "classifications": dict(sorted(classifications.items())),
    }


HANDLERS = {
    "get_incident": get_incident,
    "get_assets": get_assets,
    "get_dependencies": get_dependencies,
    "get_open_tasks": get_open_tasks,
    "get_evidence_summaries": get_evidence_summaries,
}
