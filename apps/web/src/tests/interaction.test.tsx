import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AppRouter } from '../app/router';
import { spacetimeClient } from '../services/spacetimeClient';
import { MOCK_USERS } from '../fixtures/mockData';
import { useUIStore } from '../stores/uiStore';
import { useGraphStore } from '../stores/graphStore';
import { aiClient } from '../services/aiClient';

describe('End-to-End User Interaction Workflows', () => {
  beforeEach(() => {
    // Reset state before each test
    spacetimeClient.setCurrentUser(MOCK_USERS[0]); // Saumya (Commander)
    spacetimeClient.setConnectionStatus('CONNECTED');
    useUIStore.getState().setCurrentView('COMMAND_CENTER');
    useUIStore.getState().setSelectedNodeId(null);
    useUIStore.getState().setAIPanelOpen(false);
    useGraphStore.getState().setSelectedNode(null);
  });

  it('renders the Command Center dashboard with KPIs, lifecycle progression, and active tasks', () => {
    render(<AppRouter />);

    // Brand and KPIs
    expect(screen.getByText('SENTINEL')).toBeInTheDocument();
    expect(screen.getByText('ZERO')).toBeInTheDocument();
    expect(screen.getByText('EXERCISE SCENARIO')).toBeInTheDocument();
    expect(screen.getByText('CONFIRMED COMPROMISED')).toBeInTheDocument();
    expect(screen.getByText('SERVICES DISRUPTED')).toBeInTheDocument();

    // Incident title from mock
    expect(screen.getByText(/LockBit Ransomware Outbreak/i)).toBeInTheDocument();

    // Lifecycle progression bar
    expect(screen.getAllByText('CONTAINING').length).toBeGreaterThan(0);
  });

  it('allows Incident Commander to approve consequential tasks awaiting human sign-off', async () => {
    render(<AppRouter />);

    // Locate awaiting approval task card
    const authorizeButtons = screen.getAllByRole('button', { name: /Authorize Task/i });
    expect(authorizeButtons.length).toBeGreaterThan(0);

    // Commander clicks Authorize Task
    await act(async () => {
      fireEvent.click(authorizeButtons[0]);
    });

    // Verify task state updated in client
    const tasks = spacetimeClient.getState().tasks;
    const approvedTask = tasks.find((t) => t.id === 'tsk_06');
    expect(approvedTask?.approval_status).toBe('APPROVED');
    expect(approvedTask?.status).toBe('IN_PROGRESS');
  });

  it('switches between 2D and 3D graph views and filters by search', async () => {
    render(<AppRouter />);

    // Navigate to Impact Graph view
    act(() => {
      useUIStore.getState().setCurrentView('IMPACT_GRAPH');
    });

    expect(await screen.findByText('2D FLOW', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('3D SCENE')).toBeInTheDocument();

    // Type search filter
    const searchInput = screen.getByPlaceholderText(/Search assets, clinical services/i);
    act(() => {
      fireEvent.change(searchInput, { target: { value: 'EHR-PROD-SQL-01' } });
    });

    expect(useGraphStore.getState().searchQuery).toBe('EHR-PROD-SQL-01');

    // Toggle 3D mode
    const threeDButton = screen.getByText('3D SCENE');
    act(() => {
      fireEvent.click(threeDButton);
    });

    expect(useUIStore.getState().is3DMode).toBe(true);

    // Toggle back to 2D
    const twoDButton = screen.getByText('2D FLOW');
    act(() => {
      fireEvent.click(twoDButton);
    });

    expect(useUIStore.getState().is3DMode).toBe(false);
  });

  it('opens and closes the Nemotron AI Incident Copilot modal and executes analysis', async () => {
    render(<AppRouter />);

    // Click AI button in TopBar
    const aiButton = screen.getByRole('button', { name: /Launch Nemotron/i });
    act(() => {
      fireEvent.click(aiButton);
    });

    // Verify modal is open and has run controls
    expect(screen.getByText('NVIDIA Nemotron AI Command')).toBeInTheDocument();
    expect(screen.getByTestId('ai-run-panel')).toBeInTheDocument();
    expect(screen.getByLabelText('Analysis Type')).toBeInTheDocument();

    // No AI session is configured in this test, so the run is a labeled exercise scenario.
    aiClient.configure({ exerciseStepMs: 1 });
    const runButton = screen.getByRole('button', { name: /Execute Nemotron Run/i });
    await act(async () => {
      fireEvent.click(runButton);
    });

    await waitFor(() => {
      expect(screen.getByTestId('ai-subagent-communications')).toHaveAttribute('data-status', 'COMPLETED');
    });

    expect(screen.getByText(/ALLOWLISTED READ-ONLY TOOL SEQUENCE/i)).toBeInTheDocument();
    expect(screen.getByTestId('ai-inference-mode')).toHaveAttribute('data-mode', 'SIMULATED');
    expect(screen.getByTestId('ai-exercise-notice')).toHaveTextContent('EXERCISE SCENARIO');
    expect(screen.getByText('Requires Incident Commander approval')).toBeInTheDocument();
    aiClient.reset();

    // Close modal via Close button
    const closeButtons = screen.getAllByRole('button', { name: /Close modal/i });
    act(() => {
      fireEvent.click(closeButtons[0]);
    });

    expect(useUIStore.getState().isAIPanelOpen).toBe(false);
  });

  it('displays out-of-band communication channel and broadcasts new sitreps', async () => {
    render(<AppRouter />);

    // Switch to Communications tab
    act(() => {
      useUIStore.getState().setCurrentView('COMMUNICATIONS');
    });

    expect(await screen.findByText('Out-of-Band Incident Comms Channel', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/EXERCISE CHANNEL/i)).toBeInTheDocument();

    // Type and send a message
    const input = screen.getByPlaceholderText(/Broadcast message to active responders/i);
    const sendButton = screen.getByRole('button', { name: /Send/i });

    act(() => {
      fireEvent.change(input, { target: { value: 'Testing out-of-band broadcast message' } });
    });

    await act(async () => {
      fireEvent.click(sendButton);
    });

    // Verify message appears in feed
    expect(screen.getByText('Testing out-of-band broadcast message')).toBeInTheDocument();
  });

  it('enforces accessibility standards: Escape key dismisses open modals', () => {
    render(<AppRouter />);

    act(() => {
      useUIStore.getState().setAIPanelOpen(true);
    });

    expect(screen.getByText('NVIDIA Nemotron AI Command')).toBeInTheDocument();

    // Fire Escape key event
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    });

    expect(useUIStore.getState().isAIPanelOpen).toBe(false);
  });
});
