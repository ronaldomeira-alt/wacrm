import { describe, expect, it } from 'vitest';
import { resolveAiHubUiMode } from './hub-mode';

describe('resolveAiHubUiMode (runtime rollback mechanism)', () => {
  it('uses defaultMode when env and query are unset', () => {
    expect(resolveAiHubUiMode()).toBe('legacy');
    expect(resolveAiHubUiMode({ defaultMode: 'unified' })).toBe('unified');
  });

  it('flips dynamically via server runtime env var without rebuild', () => {
    expect(resolveAiHubUiMode({ envValue: 'false', defaultMode: 'unified' })).toBe('legacy');
    expect(resolveAiHubUiMode({ envValue: '0', defaultMode: 'unified' })).toBe('legacy');
    expect(resolveAiHubUiMode({ envValue: 'legacy', defaultMode: 'unified' })).toBe('legacy');
    expect(resolveAiHubUiMode({ envValue: 'true', defaultMode: 'legacy' })).toBe('unified');
    expect(resolveAiHubUiMode({ envValue: '1', defaultMode: 'legacy' })).toBe('unified');
    expect(resolveAiHubUiMode({ envValue: 'unified', defaultMode: 'legacy' })).toBe('unified');
  });

  it('gives explicit queryOverride precedence for preview/rollback verification', () => {
    expect(
      resolveAiHubUiMode({ envValue: 'true', queryOverride: 'legacy', defaultMode: 'unified' }),
    ).toBe('legacy');
    expect(
      resolveAiHubUiMode({ envValue: 'false', queryOverride: 'unified', defaultMode: 'legacy' }),
    ).toBe('unified');
  });
});
