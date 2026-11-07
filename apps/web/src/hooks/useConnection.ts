import { useState, useEffect, useCallback } from 'react';
import { spacetimeClient, ConnectionStatus } from '../services/spacetimeClient';
import { Message, AuditEvent, EvidenceReference } from '../services/contracts';

export function useConnection() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(spacetimeClient.getState().connectionStatus);
  const [isLiveConnection, setIsLiveConnection] = useState<boolean>(spacetimeClient.getState().isLiveConnection);
  const [lastSyncTime, setLastSyncTime] = useState<string>(spacetimeClient.getState().lastSyncTime);
  const [latencyMs, setLatencyMs] = useState<number>(spacetimeClient.getState().latencyMs);
  const [messages, setMessages] = useState<Message[]>(spacetimeClient.getState().messages);
  const [auditLogs, setAuditLogs] = useState<AuditEvent[]>(spacetimeClient.getState().auditLogs);
  const [evidence, setEvidence] = useState<EvidenceReference[]>(spacetimeClient.getState().evidence);

  useEffect(() => {
    return spacetimeClient.subscribe((state) => {
      setConnectionStatus(state.connectionStatus);
      setIsLiveConnection(state.isLiveConnection);
      setLastSyncTime(state.lastSyncTime);
      setLatencyMs(state.latencyMs);
      setMessages(state.messages);
      setAuditLogs(state.auditLogs);
      setEvidence(state.evidence);
    });
  }, []);

  const sendMessage = useCallback(async (content: string, type: Message['message_type'] = 'STANDARD') => {
    return await spacetimeClient.sendMessage(content, type);
  }, []);

  const toggleSimulatedConnection = useCallback(() => {
    if (connectionStatus === 'CONNECTED') {
      spacetimeClient.setConnectionStatus('DISCONNECTED');
    } else {
      spacetimeClient.setConnectionStatus('RECONNECTING');
      setTimeout(() => {
        spacetimeClient.setConnectionStatus('CONNECTED');
      }, 1200);
    }
  }, [connectionStatus]);

  return {
    connectionStatus,
    isLiveConnection,
    lastSyncTime,
    latencyMs,
    messages,
    auditLogs,
    evidence,
    sendMessage,
    toggleSimulatedConnection,
  };
}

