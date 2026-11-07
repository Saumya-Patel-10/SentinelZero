"""Read-only incident, asset, dependency, task, and evidence tools."""

from __future__ import annotations

from collections import Counter
from typing import Any

from app.tools.registry import ToolContext


async def get_incident(ctx: ToolContext, _args: dict[str, Any]) -> tuple[Any, list[str], dict[str, Any]]:
    incident = await ctx.backend.get_incident(ctx.incident_id)
    # Double-check tenant + incident scope at the tool boundary.
    if incident.id != ctx.incident_id or incident.organization_id != ctx.organization_id:
        raise ValueError("Tool scope violation")
    data = incident.model_dump(mode="json")
    return data, [], {"incident_status": incident.status, "severity": incident.severity}


async def get_assets(ctx: ToolContext, _args: dict[str, Any]) -> tuple[Any, list[str], dict[str, Any]]:
    assets = await ctx.backend.get_assets(ctx.incident_id)
    for asset in assets:
        if asset.incident_id != ctx.incident_id or asset.organization_id != ctx.organization_id:
            raise ValueError("Tool scope violation")
    data = [asset.model_dump(mode="json") for asset in assets]
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
    view = await ctx.backend.get_dependencies(ctx.incident_id)
    data = {
        "dependencies": [item.model_dump(mode="json") for item in view.dependencies],
        "services": [item.model_dump(mode="json") for item in view.services],
        "operational_impacts": [item.model_dump(mode="json") for item in view.impacts],
        "data_scopes": [item.model_dump(mode="json") for item in view.data_scopes],
    }
    exfiltration = Counter(scope.exfiltration_status for scope in view.data_scopes)
    return data, [], {
        "dependency_count": len(view.dependencies),
        "service_count": len(view.services),
        "impact_count": len(view.impacts),
        "data_scope_count": len(view.data_scopes),
        "exfiltration_statuses": dict(sorted(exfiltration.items())),
    }


async def get_open_tasks(
    ctx: ToolContext, _args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    tasks = await ctx.backend.get_open_tasks(ctx.incident_id)
    for task in tasks:
        if task.incident_id != ctx.incident_id or task.organization_id != ctx.organization_id:
            raise ValueError("Tool scope violation")
    data = [task.model_dump(mode="json") for task in tasks]
    return data, [], {"count": len(tasks)}


async def get_evidence_summaries(
    ctx: ToolContext, _args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    evidence = await ctx.backend.get_evidence_summaries(ctx.incident_id)
    for item in evidence:
        if item.incident_id != ctx.incident_id or item.organization_id != ctx.organization_id:
            raise ValueError("Tool scope violation")
    data = [item.model_dump(mode="json") for item in evidence]
    ids = [item.id for item in evidence]
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
