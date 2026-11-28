import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { reconcileMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn(async (): Promise<{
    executed: boolean;
    partial?: boolean;
    upsertedProjections: number;
    deactivatedOrphans: number;
    recalculatedProperties: number;
    archivedContactMatchesCleaned: number;
  }> => ({
    executed: true,
    upsertedProjections: 0,
    deactivatedOrphans: 0,
    recalculatedProperties: 0,
    archivedContactMatchesCleaned: 0,
  })),
}));

vi.mock('./inventory-reconciler', () => ({
  reconcileInventoryWithProjections: reconcileMock,
}));

import { resetBackgroundSyncState, runMatchInventorySyncIfChanged } from './background-sync';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function createRpcDb(options: {
  fingerprint: string;
  lastFingerprint: string | null;
  lastFullSyncAt?: string | null;
  acquired?: boolean;
  reconcilePartial?: boolean;
}) {
  const calls: RpcCall[] = [];
  const db = {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: { account_id: 'acct-1' }, error: null }),
        then: (ok?: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
      };
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'probe_match_sync') {
        return {
          data: {
            inventoryWatermark: '2026-11-26T20:36:21Z',
            inventoryCount: 660,
            tombstoneCount: 56,
            tombstoneMaxAt: '2026-10-20T01:28:19Z',
            deletedMatchCount: 53,
            deletedMatchMaxAt: '2026-09-27T13:34:49Z',
            fingerprint: options.fingerprint,
          },
          error: null,
        };
      }
      if (fn === 'claim_match_sync') {
        return {
          data: {
            acquired: options.acquired ?? true,
            last_fingerprint: options.lastFingerprint,
            last_run_at: '2026-11-27T23:00:00Z',
            last_full_sync_at: options.lastFullSyncAt ?? new Date().toISOString(),
            lock_token: (options.acquired ?? true) ? 'lock-token' : null,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('gate persistente (DEM-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBackgroundSyncState();
    delete process.env.MATCH_SYNC_STATE;
    delete process.env.MATCH_SYNC_GATE;
    delete process.env.MATCH_CANONICAL_ACCOUNT_ID;
  });

  it('pula a leitura pesada quando o fingerprint nao mudou e nao ha full periodico vencido', async () => {
    const { db, calls } = createRpcDb({ fingerprint: 'fp-1', lastFingerprint: 'fp-1' });

    const result = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(result.reason).toBe('up_to_date');
    expect(result.driftDetected).toBe(false);
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual([
      'claim_match_sync',
      'probe_match_sync',
      'commit_match_sync',
    ]);
    expect(calls[2].args.p_mode).toBe('skipped');
  });

  it('roda a reconciliacao quando o fingerprint mudou e commita o fingerprint PRE-leitura', async () => {
    const { db, calls } = createRpcDb({ fingerprint: 'fp-2', lastFingerprint: 'fp-1' });

    const result = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('inventory_watermark_changed');
    const commit = calls.find((c) => c.fn === 'commit_match_sync');
    expect(commit?.args.p_mode).toBe('full');
    expect(commit?.args.p_fingerprint).toBe('fp-2');
  });

  it('nao adquire o ciclo quando outro worker esta com o lock', async () => {
    const { db } = createRpcDb({ fingerprint: 'fp-1', lastFingerprint: 'fp-1', acquired: false });

    const result = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(result.reason).toBe('sync_already_in_flight');
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('ciclo parcial nao avanca o fingerprint (o proximo tick repete)', async () => {
    reconcileMock.mockResolvedValueOnce({
      executed: true,
      partial: true,
      upsertedProjections: 0,
      deactivatedOrphans: 0,
      recalculatedProperties: 0,
      archivedContactMatchesCleaned: 0,
    });
    const { db, calls } = createRpcDb({ fingerprint: 'fp-3', lastFingerprint: 'fp-1' });

    await runMatchInventorySyncIfChanged(db, 'acct-1');

    const commit = calls.find((c) => c.fn === 'commit_match_sync');
    expect(commit?.args.p_mode).toBe('incremental');
    expect(commit?.args.p_fingerprint).toBe('fp-1');
  });

  it('falha continua entra em backoff e nao repete a leitura integral a cada tick', async () => {
    reconcileMock.mockResolvedValue({
      executed: true,
      partial: true,
      upsertedProjections: 0,
      deactivatedOrphans: 0,
      recalculatedProperties: 0,
      archivedContactMatchesCleaned: 0,
    });
    const { db } = createRpcDb({ fingerprint: 'fp-1', lastFingerprint: null });

    const first = await runMatchInventorySyncIfChanged(db, 'acct-1');
    const second = await runMatchInventorySyncIfChanged(db, 'acct-1');
    const third = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(first.checked).toBe(true);
    expect(second.reason).toBe('reconcile_failed_backoff');
    expect(third.reason).toBe('reconcile_failed_backoff');
    expect(reconcileMock).toHaveBeenCalledTimes(1);

    resetBackgroundSyncState('acct-1');
  });

  it('roda o full periodico mesmo sem mudanca de fingerprint', async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const { db } = createRpcDb({ fingerprint: 'fp-1', lastFingerprint: 'fp-1', lastFullSyncAt: old });

    const result = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('periodic_full_verification');
  });

  it('MATCH_SYNC_GATE=off volta ao caminho legado', async () => {
    process.env.MATCH_SYNC_GATE = 'off';
    const { db, calls } = createRpcDb({ fingerprint: 'fp-1', lastFingerprint: 'fp-1' });

    await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(calls).toHaveLength(0);
  });

  it('MATCH_SYNC_STATE=off (nome legado) tambem desliga', async () => {
    process.env.MATCH_SYNC_STATE = 'off';
    const { db, calls } = createRpcDb({ fingerprint: 'fp-1', lastFingerprint: 'fp-1' });

    await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(calls).toHaveLength(0);
  });
});
