import { expect, test, type APIRequestContext } from "@playwright/test";

import { authHeaders } from "./jwt";

const INCIDENT = "inc_riverbend_ransomware_001";
const ANALYZE = `/v1/incidents/${INCIDENT}/analyze`;
const READ_TOOLS = [
  "get_incident",
  "get_assets",
  "get_dependencies",
  "get_open_tasks",
  "get_evidence_summaries",
];

async function waitForRun(
  request: APIRequestContext,
  runId: string,
  headers: Record<string, string>,
): Promise<Record<string, any>> {
  const deadline = Date.now() + 20_000;
  let last: Record<string, any> = {};
  while (Date.now() < deadline) {
    const response = await request.get(`/v1/agent-runs/${runId}`, { headers });
    expect(response.status()).toBe(200);
    last = await response.json();
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(last.status)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run did not finish: ${JSON.stringify(last)}`);
}

test("health is truthful about the simulated provider", async ({ request }) => {
  const response = await request.get("/health");

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.proposal_only).toBe(true);
  expect(body.secrets_exposed).toBe(false);
  expect(body.provider.mode).toBe("scripted");
  expect(body.provider.inference_label).toBe("SIMULATED_MODEL_OUTPUT");
  expect(body.provider.live_inference_available).toBe(false);
  expect(body.backend.contract_status).toBe("MOCK_AWAITING_AGENT1");
});

test("analysis requires a bearer token", async ({ request }) => {
  const response = await request.post(ANALYZE, { data: {} });

  expect(response.status()).toBe(401);
  const body = await response.json();
  expect(body.error.code).toBe("AUTH_REQUIRED");
});

test("scripted analysis completes with evidence-linked pending proposals", async ({
  request,
}) => {
  const headers = authHeaders();

  const accepted = await request.post(ANALYZE, {
    headers,
    data: { focus: "Preserve uncertainty about exfiltration." },
  });
  expect(accepted.status()).toBe(202);
  const acceptedBody = await accepted.json();
  expect(acceptedBody.provider_mode).toBe("scripted");
  expect(acceptedBody.inference_label).toBe("SIMULATED_MODEL_OUTPUT");
  expect(acceptedBody.live_inference).toBe(false);
  expect(acceptedBody.exercise_label).toBe("EXERCISE");

  const run = await waitForRun(request, acceptedBody.run_id, headers);

  expect(run.status).toBe("COMPLETED");
  expect(run.truthfulness.proposal_only).toBe(true);
  expect(run.truthfulness.live_inference).toBe(false);
  expect(run.provider_calls).toHaveLength(2);
  expect(run.tool_calls).toHaveLength(5);
  expect(new Set(run.tool_calls.map((call: any) => call.tool_name))).toEqual(
    new Set(READ_TOOLS),
  );
  expect(run.tool_calls.every((call: any) => call.status === "OK")).toBe(true);

  const recommendation = run.recommendation;
  expect(recommendation).toBeTruthy();
  expect(recommendation.approval_status).toBe("PENDING_HUMAN_APPROVAL");
  expect(recommendation.evidence_ids_used.length).toBeGreaterThan(0);
  expect(recommendation.uncertainties.length).toBeGreaterThan(0);
  for (const task of recommendation.proposed_tasks) {
    expect(task.requires_human_approval).toBe(true);
  }
  expect(JSON.stringify(run)).not.toContain("nvapi-");
  expect(JSON.stringify(run)).not.toContain("untrusted_incident_data");

  const submitUrl = `/v1/recommendations/${recommendation.recommendation_id}/submit`;
  const submitted = await request.post(submitUrl, {
    headers: { ...headers, "Idempotency-Key": "e2e-submit-001" },
  });
  expect(submitted.status()).toBe(202);
  const submittedBody = await submitted.json();
  expect(submittedBody.approval_status).toBe("PENDING_HUMAN_APPROVAL");
  expect(submittedBody.submitted).toBe(true);
  expect(submittedBody.duplicate).toBe(false);

  const duplicate = await request.post(submitUrl, {
    headers: { ...headers, "Idempotency-Key": "e2e-submit-002" },
  });
  expect(duplicate.status()).toBe(202);
  expect((await duplicate.json()).duplicate).toBe(true);
});

test("unknown runs use the safe error envelope", async ({ request }) => {
  const response = await request.get("/v1/agent-runs/run_does_not_exist", {
    headers: authHeaders(),
  });

  expect(response.status()).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.error.request_id).toBeTruthy();
});
