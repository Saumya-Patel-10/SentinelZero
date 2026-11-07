import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock matchMedia for tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock Element.prototype.scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock HTMLCanvasElement.prototype.getContext for WebGL detection
HTMLCanvasElement.prototype.getContext = vi.fn((contextId: string) => {
  if (contextId === 'webgl' || contextId === 'experimental-webgl') {
    return {} as any;
  }
  return null;
}) as any;

// Mock window.alert and window.confirm
window.alert = vi.fn();
window.confirm = vi.fn(() => true);
