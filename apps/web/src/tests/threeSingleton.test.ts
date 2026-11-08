import { describe, it, expect, vi } from 'vitest';

describe('3D scene module graph', () => {
  it('loads exactly one Three.js instance with the react-three stack', async () => {
    const warn = vi.spyOn(console, 'warn');
    const mod = await import('../components/three/ImpactGraph3D');
    expect(typeof mod.ImpactGraph3D).toBe('function');
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/Multiple instances of Three\.js/);
    warn.mockRestore();
  }, 60_000);
});
