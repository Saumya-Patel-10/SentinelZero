import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/Button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in SentinelZero Web Application:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-sz-bg-deep flex items-center justify-center p-4">
          <div className="max-w-md w-full p-6 rounded-lg bg-sz-bg-surface border border-red-700/60 shadow-2xl space-y-4 text-center">
            <div className="w-12 h-12 rounded-full bg-red-950/80 border border-red-600 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6 text-red-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100">Command Center Interface Exception</h2>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                An isolated client runtime exception occurred. Incident database connection and out-of-band operational state remain safe.
              </p>
            </div>
            {this.state.error && (
              <div className="p-2.5 rounded bg-sz-bg-base text-left font-mono text-[11px] text-red-300 max-h-32 overflow-y-auto">
                {this.state.error.message}
              </div>
            )}
            <Button
              variant="commander"
              onClick={() => window.location.reload()}
              icon={<RefreshCw className="w-4 h-4" />}
            >
              Reload Interface
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

