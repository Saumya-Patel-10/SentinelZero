import React, { useState, useRef, useEffect } from 'react';
import { useConnection } from '../../hooks/useConnection';
import { useAuth } from '../../hooks/useAuth';
import { RoleBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Message } from '../../services/contracts';
import { AlertCircle, Megaphone, Send, ShieldAlert } from 'lucide-react';

export const IncidentChat: React.FC = () => {
  const { messages, sendMessage } = useConnection();
  const { currentUser, isObserver } = useAuth();
  const [content, setContent] = useState('');
  const [msgType, setMsgType] = useState<Message['message_type']>('STANDARD');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || isObserver) return;
    setSending(true);
    try {
      await sendMessage(content.trim(), msgType);
      setContent('');
      setMsgType('STANDARD');
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  };

  const getMsgStyle = (type: Message['message_type']) => {
    switch (type) {
      case 'COMMAND_DIRECTIVE':
        return 'border-l-4 border-l-cyan-400 bg-cyan-950/30';
      case 'SITREP':
        return 'border-l-4 border-l-purple-400 bg-purple-950/20';
      case 'SYSTEM_ALERT':
        return 'border-l-4 border-l-red-400 bg-red-950/30';
      default:
        return 'border-sz-bg-border bg-sz-bg-surface';
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)] bg-sz-bg-base border border-sz-bg-border rounded-lg overflow-hidden">
      {/* Comms Channel Header */}
      <div className="px-4 py-3 border-b border-sz-bg-border bg-sz-bg-surface flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-slate-100">Out-of-Band Incident Comms Channel</h3>
        </div>
        <div className="text-[11px] font-mono text-emerald-400 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          SECURE ISOLATED TLS
        </div>
      </div>

      {/* Messages Feed */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" role="log" aria-label="Incident message feed">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`p-3.5 rounded-r-lg border border-l-4 ${getMsgStyle(m.message_type)} transition-all`}
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-200">{m.sender_name}</span>
                <RoleBadge role={m.sender_role} />
                {m.message_type !== 'STANDARD' && (
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-sz-bg-base text-cyan-300 border border-sz-bg-border">
                    {m.message_type.replace('_', ' ')}
                  </span>
                )}
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{m.content}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input / Form */}
      <div className="p-3 border-t border-sz-bg-border bg-sz-bg-surface">
        {isObserver ? (
          <div className="p-2.5 rounded bg-slate-900 border border-slate-700 text-xs text-slate-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-slate-400 shrink-0" />
            <span>Observer accounts have read-only privileges and cannot post messages to out-of-band comms.</span>
          </div>
        ) : (
          <form onSubmit={handleSend} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-400">Type:</span>
              <select
                value={msgType}
                onChange={(e) => setMsgType(e.target.value as Message['message_type'])}
                className="bg-sz-bg-base border border-sz-bg-border rounded px-2 py-1 text-xs text-cyan-300 font-mono focus:outline-none"
              >
                <option value="STANDARD">STANDARD UPDATE</option>
                <option value="SITREP">SITREP (Situation Report)</option>
                <option value="COMMAND_DIRECTIVE">COMMAND DIRECTIVE</option>
                <option value="SYSTEM_ALERT">SYSTEM ALERT</option>
              </select>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Broadcast message to active responders..."
                className="flex-1 bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-sans"
              />
              <Button type="submit" variant="primary" loading={sending} disabled={!content.trim()} icon={<Send className="w-4 h-4" />}>
                Send
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
