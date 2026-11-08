import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import React from 'react';
import { AIRunPanel } from '../components/ai/AIRunPanel';
import { aiClient } from '../services/aiClient';
import { spacetimeClient } from '../services/spacetimeClient';
import { useUIStore } from '../stores/uiStore';
import { MOCK_USERS } from '../fixtures/mockData';
import {
  INCIDENT_ID,
  RUN_ID,
  accepted,
  completedRun,
  configureFastClient,
  envelope,
  json,
  mockFetch,
  recommendation,
  runRecord,
  subagents,
} from './aiTestUtils';

const ANALYZE = `POST /v1/incidents/${INCIDENT_ID}/analyze`;
const GET_RUN = `GET /v1/agent-runs/${RUN_ID}`;
const CANCEL = `POST /v1/agent-runs/${RUN_ID}/cancel`;

const [COMMANDER, ANALYST, RESPONDER, OBSERVER] = MOCK_USERS;

function renderPanel() {
  act(() => useUIStore.getState().setAIPanelOpen(true));
  return render(<AIRunPanel />);
}

function startRun() {
  fireEvent.click(screen.getByTestId('ai-run-start'));
}

/** Matches raw HTML / code-eval sinks. Pieces are joined so this file is not itself a sink. */
function rawHtmlSinkPattern(): RegExp {
  const piece = (...parts: string[]) => parts.join('');
  return new RegExp(
    [
      piece('dangerously', 'Set', 'Inner', 'HTML'),
      piece('\\.', 'inner', 'HTML\\s*='),
      piece('outer', 'HTML\\s*='),
      piece('insert', 'Adjacent', 'HTML'),
      piece('document\\.', 'write\\('),
      piece('\\beval\\('),
      piece('new ', 'Function\\('),
    ].join('|'),
  );
}

describe('AIRunPanel', () => {
  beforeEach(() => {
    spacetimeClient.setCurrentUser(COMMANDER);
  });

  afterEach(() => {
    aiClient.reset();
    act(() => useUIStore.getState().setAIPanelOpen(false));
    delete (window as unknown as Record<string, unknown>).__pwned;
  });

  it('shows the live sub-agent pipeline, sitrep, LIVE badge, and a PENDING recommendation without self-approval', async () => {
    const { fetch } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: (_i, n) =>
        n === 1 ? json(runRecord({ subagents: subagents(['COMPLETED', 'RUNNING', 'PENDING', 'PENDING']) })) : json(completedRun()),
    });
    configureFastClient(fetch);
    renderPanel();
    startRun();

    await waitFor(() => expect(screen.getByTestId('ai-run-status')).toHaveAttribute('data-status', 'COMPLETED'));

    for (const [i, name] of ['triage', 'impact', 'containment', 'communications'].entries()) {
      const stage = screen.getByTestId(`ai-subagent-${name}`);
      expect(stage).toHaveAttribute('data-status', 'COMPLETED');
      expect(within(stage).getByText('Tool calls').nextSibling).toHaveTextContent(String(i + 1));
      expect(within(stage).getByText(`${(i + 1) * 100}ms`)).toBeInTheDocument();
      expect(within(stage).getByText(`${name} summary`)).toBeInTheDocument();
    }

    const badge = screen.getByTestId('ai-inference-mode');
    expect(badge).toHaveAttribute('data-mode', 'LIVE');
    expect(badge).toHaveTextContent('LIVE INFERENCE');
    expect(screen.queryByText('EXERCISE SCENARIO')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-sitrep')).toHaveTextContent('SITREP: ransomware contained to two hosts.');
    expect(screen.getByTestId('ai-recommendation-status')).toHaveTextContent('PENDING');
    expect(screen.getByTestId('ai-approval-required')).toHaveTextContent('Requires Incident Commander approval');
    expect(screen.getByTestId('ai-run-live-status')).toHaveTextContent(/completed/i);

    const panel = screen.getByTestId('ai-run-panel');
    expect(within(panel).queryByRole('button', { name: /authorize|approve/i })).not.toBeInTheDocument();

    // Queuing creates a task that still needs the Commander's decision in the approval UI.
    const before = spacetimeClient.getState().tasks.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-recommendation-queue'));
    });
    const tasks = spacetimeClient.getState().tasks;
    expect(tasks).toHaveLength(before + 1);
    expect(tasks[0]).toMatchObject({ approval_status: 'PENDING_APPROVAL', status: 'AWAITING_APPROVAL', is_ai_proposed: true });
    expect(screen.getByTestId('ai-recommendation-queued')).toBeInTheDocument();
  });

  it('shows a FAILED sub-agent and withholds the recommendation', async () => {
    const { fetch } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () =>
        json(
          completedRun({
            status: 'FAILED',
            error_category: 'AI_PROVIDER_TIMEOUT',
            error_message: 'The containment stage timed out.',
            subagents: subagents(['COMPLETED', 'COMPLETED', 'FAILED', 'SKIPPED']),
          })
        ),
    });
    configureFastClient(fetch);
    renderPanel();
    startRun();

    await waitFor(() => expect(screen.getByTestId('ai-run-failure')).toBeInTheDocument());
    expect(screen.getByTestId('ai-subagent-containment')).toHaveAttribute('data-status', 'FAILED');
    expect(screen.getByTestId('ai-subagent-communications')).toHaveAttribute('data-status', 'SKIPPED');
    expect(screen.getByTestId('ai-run-failure')).toHaveTextContent('containment');
    expect(screen.getByTestId('ai-run-failure')).toHaveTextContent('AI_PROVIDER_TIMEOUT');
    expect(screen.queryByTestId('ai-recommendation')).not.toBeInTheDocument();
  });

  it('rejects a malformed run response and shows no unvalidated data', async () => {
    const { fetch } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () => json({ ...completedRun(), subagents: [{ name: 'rogue', status: 'COMPLETED' }], sitrep: 'SHOULD NOT RENDER' }),
      [CANCEL]: () => json({ run_id: RUN_ID, status: 'CANCELLED' }, 202),
    });
    configureFastClient(fetch);
    renderPanel();
    startRun();

    await waitFor(() => expect(screen.getByTestId('ai-run-error')).toHaveAttribute('data-error-kind', 'MALFORMED_RESPONSE'));
    expect(screen.queryByText('SHOULD NOT RENDER')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-recommendation')).not.toBeInTheDocument();
  });

  it.each([
    [401, 'AUTH_REQUIRED', 'Authentication required (401)'],
    [403, 'ACCESS_DENIED', 'Access denied (403)'],
    [429, 'RATE_LIMITED', 'Rate limited (429)'],
    [503, 'SERVICE_UNAVAILABLE', 'AI service unavailable'],
  ] as const)('renders a %i error envelope safely as text', async (status, code, title) => {
    const hostile = `<img src=x onerror="window.__pwned=1"> ${code} <script>window.__pwned=1</script>`;
    const { fetch } = mockFetch({ [ANALYZE]: () => envelope(status, code, hostile, status === 429 ? { 'Retry-After': '30' } : {}) });
    configureFastClient(fetch);
    renderPanel();
    startRun();

    const alert = await screen.findByTestId('ai-run-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveAttribute('data-error-kind', code);
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent('<script>');
    expect(alert).toHaveTextContent('request req-123');
    if (status === 429) expect(alert).toHaveTextContent('retry after 30s');
    expect(alert.querySelector('img, script')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('renders script-injection strings in sub-agent summaries, sitrep, and recommendation as inert text', async () => {
    const payloads = [
      '<script>window.__pwned=1</script>',
      '<img src=x onerror="window.__pwned=1">',
      '<a href="javascript:window.__pwned=1">click</a>',
      '"><svg onload="window.__pwned=1">',
    ];
    const { fetch } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () =>
        json(
          completedRun({
            subagents: subagents(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED'], payloads),
            sitrep: `Draft ${payloads.join(' ')}`,
            recommendation: recommendation({
              title: payloads[0],
              description: `Description ${payloads[1]}`,
              rationale: payloads[3],
            }),
          })
        ),
    });
    configureFastClient(fetch);
    renderPanel();
    startRun();

    await waitFor(() => expect(screen.getByTestId('ai-run-status')).toHaveAttribute('data-status', 'COMPLETED'));
    const panel = screen.getByTestId('ai-run-panel');
    expect(panel.querySelector('script, img, svg[onload], a[href^="javascript"], [onerror], [onload]')).toBeNull();
    expect(screen.getByTestId('ai-subagent-triage-summary').textContent).toBe(payloads[0]);
    expect(screen.getByTestId('ai-sitrep').textContent).toContain(payloads[1]);
    expect(within(screen.getByTestId('ai-recommendation')).getByText(payloads[0])).toBeInTheDocument();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('cancel button aborts polling and calls the cancel endpoint', async () => {
    const { fetch, calls } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () => json(runRecord({ subagents: subagents(['RUNNING', 'PENDING', 'PENDING', 'PENDING']) })),
      [CANCEL]: () => json({ run_id: RUN_ID, status: 'CANCELLED' }, 202),
    });
    configureFastClient(fetch);
    renderPanel();
    startRun();

    await waitFor(() => expect(screen.getByTestId('ai-subagent-triage')).toHaveAttribute('data-status', 'RUNNING'));
    fireEvent.click(screen.getByTestId('ai-run-cancel'));

    await waitFor(() => expect(screen.getByTestId('ai-run-error')).toHaveAttribute('data-error-kind', 'CANCELLED'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === `/v1/agent-runs/${RUN_ID}/cancel`)).toBe(true));
    expect(screen.getByTestId('ai-run-start')).toBeEnabled();
  });

  it('falls back to a clearly labeled EXERCISE SCENARIO when the AI service is unreachable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    configureFastClient(fetch);
    renderPanel();
    startRun();

    await waitFor(() => expect(screen.getByTestId('ai-run-status')).toHaveAttribute('data-status', 'COMPLETED'));
    expect(screen.getByTestId('ai-inference-mode')).toHaveAttribute('data-mode', 'SIMULATED');
    expect(screen.getByTestId('ai-inference-mode')).toHaveTextContent('NOT LIVE INFERENCE');
    expect(screen.getByText('EXERCISE SCENARIO')).toBeInTheDocument();
    expect(screen.getByTestId('ai-exercise-notice')).toHaveTextContent(/unreachable/i);
    expect(screen.queryByText('LIVE INFERENCE')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-approval-required')).toBeInTheDocument();
  });

  it.each([
    ['OBSERVER', OBSERVER],
    ['RESPONDER', RESPONDER],
  ])('blocks %s from starting or viewing analysis', (_role, user) => {
    const { fetch, calls } = mockFetch({});
    configureFastClient(fetch);
    spacetimeClient.setCurrentUser(user);
    renderPanel();

    expect(screen.getByTestId('ai-run-forbidden')).toHaveTextContent(user.role);
    expect(screen.queryByTestId('ai-run-start')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-subagent-pipeline')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('allows ANALYST to request analysis but not to approve', async () => {
    const { fetch } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () => json(completedRun()),
    });
    configureFastClient(fetch);
    spacetimeClient.setCurrentUser(ANALYST);
    renderPanel();
    expect(screen.getByTestId('ai-run-start')).toBeEnabled();
    startRun();
    await waitFor(() => expect(screen.getByTestId('ai-recommendation')).toBeInTheDocument());
    expect(screen.getByTestId('ai-approval-required')).toBeInTheDocument();
    expect(within(screen.getByTestId('ai-run-panel')).queryByRole('button', { name: /authorize|approve/i })).not.toBeInTheDocument();
  });

  it('uses only text rendering across apps/web (no raw HTML sinks)', async () => {
    const sources = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.includes('/tests/'))
      .filter(([, src]) => rawHtmlSinkPattern().test(src))
      .map(([file]) => file);
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
