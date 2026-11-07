import React from 'react';
import { useConnection } from '../../hooks/useConnection';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '../ui/Button';

export const ConnectionBanner: React.FC = () => {
  const { connectionStatus, toggleSimulatedConnection } = useConnection();

  if (connectionStatus === 'CONNECTED') return null;

  return (
    <div
      role="alert"
      className="bg-red-950/90 border-b border-red-700 text-red-200 px-4 py-2.5 flex items-center justify-between z-50 text-xs sm:text-sm animate-pulse"
    >
      <div className="flex items-center gap-2.5">
        <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
        <span>
          <strong>DISCONNECTED STATE:</strong> Real-time synchronization lost. Mutations are queued locally and will not silently replay privileged writes.
        </span>
      </div>
      <Button
        size="sm"
        variant="danger"
        onClick={toggleSimulatedConnection}
        className="h-7 text-xs px-2.5"
        icon={<RefreshCw className="w-3 h-3" />}
      >
        Reconnect Now
      </Button>
    </div>
  );
};
