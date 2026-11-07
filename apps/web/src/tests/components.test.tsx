import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { StatusBadge, ExerciseBadge } from '../components/ui/Badge';
import { TopBar } from '../components/layout/TopBar';
import { ConnectionBanner } from '../components/layout/ConnectionBanner';
import { spacetimeClient } from '../services/spacetimeClient';
import { KPIOverview } from '../components/dashboard/KPIOverview';

describe('UI Components & Accessibility Guardrails', () => {
  it('renders badges with explicit text labels and not color-alone', () => {
    const { rerender } = render(<StatusBadge status="CONFIRMED" />);
    expect(screen.getByText('CONFIRMED')).toBeInTheDocument();

    rerender(<StatusBadge status="SUSPECTED" />);
    expect(screen.getByText('SUSPECTED')).toBeInTheDocument();

    rerender(<StatusBadge status="RULED_OUT" />);
    expect(screen.getByText('RULED OUT')).toBeInTheDocument();

    rerender(<StatusBadge status="UNKNOWN" />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('renders Exercise scenario badge truthfully', () => {
    render(<ExerciseBadge />);
    expect(screen.getByText('EXERCISE SCENARIO')).toBeInTheDocument();
  });

  it('renders TopBar with brand, connection, and role selector', () => {
    render(<TopBar />);
    expect(screen.getByText('SENTINEL')).toBeInTheDocument();
    expect(screen.getByText('ZERO')).toBeInTheDocument();
    expect(screen.getByText('AI Incident Copilot')).toBeInTheDocument();
  });

  it('renders ConnectionBanner when state transitions to DISCONNECTED', () => {
    render(<ConnectionBanner />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => {
      spacetimeClient.setConnectionStatus('DISCONNECTED');
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/DISCONNECTED STATE/i)).toBeInTheDocument();

    act(() => {
      spacetimeClient.setConnectionStatus('CONNECTED');
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders KPIOverview with verified summary metrics', () => {
    render(<KPIOverview />);
    expect(screen.getByText('CONFIRMED COMPROMISED')).toBeInTheDocument();
    expect(screen.getByText('SUSPECTED COMPROMISED')).toBeInTheDocument();
    expect(screen.getByText('SERVICES DISRUPTED')).toBeInTheDocument();
    expect(screen.getByText('AFFECTED HUMAN GROUPS')).toBeInTheDocument();
    expect(screen.getByText('PENDING APPROVALS')).toBeInTheDocument();
  });
});
