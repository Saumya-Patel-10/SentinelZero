"""Public CISA KEV lookup stays honest when the feed is missing or matched."""

from __future__ import annotations

import json

import httpx

from app.tools.incident_tools import KEV_FEED_URL, fetch_kev_matches


async def test_kev_lookup_reports_public_feed_matches():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == KEV_FEED_URL
        return httpx.Response(
            200,
            json={
                "catalogVersion": "2026.11.08",
                "vulnerabilities": [
                    {
                        "cveID": "CVE-2024-1709",
                        "vendorProject": "ConnectWise",
                        "product": "ScreenConnect",
                        "vulnerabilityName": "ConnectWise ScreenConnect Authentication Bypass",
                        "dateAdded": "2024-02-22",
                        "shortDescription": "Authentication bypass.",
                        "requiredAction": "Apply the vendor update.",
                    }
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await fetch_kev_matches("CVE-2024-1709", client=client)

    assert result["api_status"] == "PUBLIC_FEED"
    assert result["source"] == KEV_FEED_URL
    assert result["matches"][0]["cveID"] == "CVE-2024-1709"
    assert "AUTHENTICATED" not in json.dumps(result)


async def test_kev_lookup_does_not_invent_records_when_unreachable():
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(503, text="offline")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await fetch_kev_matches("LockBit", client=client)

    assert result["api_status"] == "UNAVAILABLE"
    assert result["matches"] == []
    assert "AUTHENTICATED" not in json.dumps(result)
