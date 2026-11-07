# AI Service E2E (Playwright)

API smoke tests start the FastAPI service in **scripted** mode with synthetic
simulator data. Browser tests are optional and only run when `APP_BASE_URL` is set.

## Setup

```powershell
cd services/ai/tests/e2e
npm install
npx playwright install chromium   # only needed for the optional web project
```

## Run API smoke tests

```powershell
# Uses the Python on PATH by default. Point at the service venv if preferred.
$env:AI_E2E_PYTHON = "C:\path\to\services\ai\.venv\Scripts\python.exe"
npm run test:api
```

The config starts `start_service.py` on `127.0.0.1:8100`, seeds the simulator, and
mints HS256 test tokens with a local-only secret. Every run is labeled
`SIMULATED_MODEL_OUTPUT`.

## Run browser smoke tests

Start the web app first, then:

```powershell
$env:APP_BASE_URL = "http://127.0.0.1:5173"
$env:AI_PANEL_SELECTOR = "[data-testid='ai-run-panel']"   # optional
npm run test:web
```

`web.spec.ts` is skipped when `APP_BASE_URL` is unset. It checks that the page
renders, has body content, and raises no uncaught page errors.

## Notes

- These tests do not call NVIDIA. Live inference verification is a pytest marker:
  `python -m pytest -m live` from `services/ai` with `NVIDIA_API_KEY` and
  `AI_LIVE_TESTS=1`.
- `node_modules/` and `test-results/` are gitignored.
