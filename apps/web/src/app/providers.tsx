import React from 'react';
import { ErrorBoundary } from './error-boundary';

interface ProvidersProps {
  children: React.ReactNode;
}

export const Providers: React.FC<ProvidersProps> = ({ children }) => {
  return <ErrorBoundary>{children}</ErrorBoundary>;
};
