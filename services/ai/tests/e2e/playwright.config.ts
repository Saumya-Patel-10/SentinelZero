import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.AI_E2E_PORT ?? "8100");
const AI_BASE_URL = process.env.AI_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.AI_E2E_PYTHON ?? "python";
const JWT_SECRET =
  process.env.AI_E2E_JWT_SECRET ?? "e2e-only-secret-" + "x".repeat(40);
const E2E_DIR = fileURLToPath(new URL(".", import.meta.url));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: AI_BASE_URL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "api", testMatch: /api\.spec\.ts/ },
    { name: "web", testMatch: /web\.spec\.ts/ },
  ],
  webServer: {
    command: `"${PYTHON}" start_service.py`,
    cwd: E2E_DIR,
    url: `${AI_BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    env: {
      ...inheritedEnv,
      AI_ENVIRONMENT: "test",
      AI_PROVIDER_MODE: "scripted",
      AI_BACKEND_MODE: "memory",
      AI_JWT_SECRET: JWT_SECRET,
      AI_E2E_JWT_SECRET: JWT_SECRET,
      AI_E2E_PORT: String(PORT),
      AI_LOG_LEVEL: "WARNING",
      AI_RATE_LIMIT_PER_MINUTE: "120",
      AI_RATE_LIMIT_BURST: "20",
    },
  },
});
