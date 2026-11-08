"""Read-only incident, asset, dependency, task, and evidence tools.

All reads go through the SpacetimeDB ``agent_get_*`` procedures, which take a
run_id and enforce authorization server-side.  Incident scope is verified at the
tool boundary as defense in depth.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict
from typing import Any

import httpx

from app.tools.registry import ToolArgumentsInvalid, ToolContext

KEV_FEED_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
_KEV_FIELDS = (
    "cveID",
    "vendorProject",
    "product",
    "vulnerabilityName",
    "dateAdded",
    "shortDescription",
    "requiredAction",
)


async def get_incident(ctx: ToolContext, _args: dict[str, Any]) -> tuple[Any, list[str], dict[str, Any]]:
    incident = await ctx.backend.agent_get_incident(ctx.run_id)
    # Defense in depth: the procedure is run-scoped (and therefore tenant-scoped)
    # server-side; the returned record must still match the authorized run.
    if incident.incident_id != ctx.incident_id or incident.run_id != ctx.run_id:
        raise ValueError("Tool scope violation")
    data = asdict(incident)
    return data, [], {"incident_status": incident.status, "severity": incident.severity}


async def get_assets(ctx: ToolContext, _args: dict[str, Any]) -> tuple[Any, list[str], dict[str, Any]]:
    assets = await ctx.backend.agent_get_assets(ctx.run_id)
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


def _clip(value: object, limit: int = 300) -> str:
    return str(value or "")[:limit]


def _kev_match(query: str, row: dict[str, Any]) -> bool:
    haystack = " ".join(_clip(row.get(field), 500) for field in _KEV_FIELDS).lower()
    return query in haystack


async def fetch_kev_matches(query: str, *, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """Read the public CISA KEV catalog. Never substitutes a local record."""

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=4.0), follow_redirects=True)
    try:
        response = await http.get(KEV_FEED_URL, headers={"Accept": "application/json", "User-Agent": "SentinelZero-exercise"})
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError, TypeError):
        return {
            "matches": [],
            "source": KEV_FEED_URL,
            "api_status": "UNAVAILABLE",
            "catalog_version": "",
            "note": "The public CISA KEV feed could not be read. No local catalog was substituted.",
        }
    finally:
        if owns_client:
            await http.aclose()

    rows = payload.get("vulnerabilities") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return {
            "matches": [],
            "source": KEV_FEED_URL,
            "api_status": "UNAVAILABLE",
            "catalog_version": "",
            "note": "The CISA KEV feed did not contain a vulnerabilities list.",
        }
    needle = query.lower()
    matches = []
    for row in rows:
        if not isinstance(row, dict) or not _kev_match(needle, row):
            continue
        matches.append({field: _clip(row.get(field)) for field in _KEV_FIELDS})
        if len(matches) == 5:
            break
    return {
        "matches": matches,
        "source": KEV_FEED_URL,
        "api_status": "PUBLIC_FEED",
        "catalog_version": _clip(payload.get("catalogVersion"), 40),
        "note": "Public CISA KEV JSON. Not an authenticated API and not MITRE ATT&CK.",
    }


async def query_threat_intelligence(
    ctx: ToolContext, args: dict[str, Any]
) -> tuple[Any, list[str], dict[str, Any]]:
    """Read the public CISA KEV feed for a caller-supplied query."""

    del ctx
    query = str(args.get("query") or "").strip()
    if len(query) < 2 or len(query) > 100:
        raise ToolArgumentsInvalid("query must be between 2 and 100 characters.")
    ioc_type = str(args.get("ioc_type") or "GENERAL")
    if ioc_type not in {"MALWARE_FAMILY", "CVE_VULNERABILITY", "ATTACK_TECHNIQUE", "GENERAL"}:
        ioc_type = "GENERAL"
    result = await fetch_kev_matches(query)
    result["query"] = query
    result["ioc_type"] = ioc_type
    return result, [], {
        "query": query[:100],
        "match_count": len(result["matches"]),
        "api_status": result["api_status"],
        "source": "CISA_KEV_PUBLIC_FEED",
    }


HANDLERS = {
    "get_incident": get_incident,
    "get_assets": get_assets,
    "get_dependencies": get_dependencies,
    "get_open_tasks": get_open_tasks,
    "get_evidence_summaries": get_evidence_summaries,
    "query_threat_intelligence": query_threat_intelligence,
}
