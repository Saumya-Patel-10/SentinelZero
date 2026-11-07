import React from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline' | 'commander';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className,
  disabled,
  ...props
}) => {
  const baseClasses =
    'inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:pointer-events-none disabled:opacity-50 select-none';

  const sizeClasses = {
    sm: 'h-8 px-3 text-xs rounded',
    md: 'h-10 px-4 text-sm rounded-md',
    lg: 'h-11 px-6 text-base rounded-md',
  }[size];

  const variantClasses = {
    primary: 'bg-cyan-600 hover:bg-cyan-500 text-slate-900 font-semibold shadow-sm shadow-cyan-900/30',
    commander: 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold shadow-md shadow-cyan-900/40 border border-cyan-400/40',
    secondary: 'bg-sz-bg-elevated hover:bg-sz-bg-highlight text-slate-200 border border-sz-bg-border',
    danger: 'bg-red-700 hover:bg-red-600 text-white shadow-sm shadow-red-950/40',
    outline: 'border border-cyan-500/40 hover:bg-cyan-950/30 text-cyan-300',
    ghost: 'hover:bg-slate-800/60 text-slate-300 hover:text-white',
  }[variant];

  return (
    <button
      className={clsx(baseClasses, sizeClasses, variantClasses, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin text-current" />
      ) : icon ? (
        <span className="mr-2 inline-flex">{icon}</span>
      ) : null}
      {children}
    </button>
  );
};
