import React, { useEffect, useId } from 'react';
import { Minus, X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  testId?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  onMinimize,
  title,
  subtitle,
  children,
  maxWidth = 'lg',
  testId,
}) => {
  const titleId = useId();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const maxWidthClass = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
  }[maxWidth];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div
        className={`w-full ${maxWidthClass} bg-sz-bg-surface border border-sz-bg-border rounded-lg shadow-2xl overflow-hidden glass-panel-elevated`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-sz-bg-border">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-100">{title}</h2>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-1.5">
            {onMinimize && (
              <button
                onClick={onMinimize}
                aria-label="Minimize modal"
                className="p-1 rounded-md text-slate-400 hover:text-cyan-300 hover:bg-sz-bg-elevated transition-colors"
                title="Minimize window"
              >
                <Minus className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close modal"
              className="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-sz-bg-elevated transition-colors"
              title="Close window"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="p-6 max-h-[80vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};
