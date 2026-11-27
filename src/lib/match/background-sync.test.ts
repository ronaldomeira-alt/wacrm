import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { reconcileMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn(async () => ({
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

import {
  resetBackgroundSyncState,
  resolveOperationalMatchAccountId,
  runMatchInventorySyncIfChanged,
} from './background-sync';

function createMockDb(state: {
  invLatest: string;
  projLatest: string;
  invCount: number;
  projCount: number;
  profileCalls?: { count: number };
}): SupabaseClient {
  return {
    from: (table: string) => {
      let isHeadCount = false;
      const chain: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (opts?.head) isHeadCount = true;
          return chain;
        },
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === 'profiles') {
            if (state.profileCalls) state.profileCalls.count += 1;
            return { data: { account_id: 'acct-real' }, error: null };
          }
          if (table === 'inventory_properties') {
            return { data: { updated_at: state.invLatest }, error: null };
          }
          if (table === 'property_match_projections') {
            return { data: { updated_at: state.projLatest }, error: null };
          }
          return { data: null, error: null };
        },
        then: (
          onFulfilled?: (v: unknown) => unknown,
          onRejected?: (r: unknown) => unknown
        ) => {
          if (isHeadCount && table === 'inventory_properties') {
            return Promise.resolve({ count: state.invCount, error: null }).then(
              onFulfilled,
              onRejected
            );
          }
          if (isHeadCount && table === 'property_match_projections') {
            return Promise.resolve({ count: state.projCount, error: null }).then(
              onFulfilled,
              onRejected
            );
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('runMatchInventorySyncIfChanged (P0 egress loop fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBackgroundSyncState();
    delete process.env.MATCH_CANONICAL_ACCOUNT_ID;
  });

  it('does NOT trigger full reconcile when projections have extra archived/orphan rows (660 inv vs 662 proj)', async () => {
    const db = createMockDb({
      invLatest: '2026-11-26T18:00:00.000Z',
      projLatest: '2026-11-26T18:05:00.000Z',
      invCount: 660,
      projCount: 662,
    });

    const first = await runMatchInventorySyncIfChanged(db, 'acct-1');
    const second = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(first.driftDetected).toBe(false);
    expect(first.reason).toBe('up_to_date');
    expect(second.driftDetected).toBe(false);
    expect(second.reason).toBe('up_to_date');
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('triggers reconcile when a property is deleted from inventory_properties (count decreases 660 -> 659)', async () => {
    const state = {
      invLatest: '2026-11-26T18:00:00.000Z',
      projLatest: '2026-11-26T18:05:00.000Z',
      invCount: 660,
      projCount: 662,
    };
    const db = createMockDb(state);

    const first = await runMatchInventorySyncIfChanged(db, 'acct-1');
    expect(first.driftDetected).toBe(false);
    expect(reconcileMock).toHaveBeenCalledTimes(0);

    // Simula exclusão de 1 imóvel no Meus Imóveis (sem alterar MAX(updated_at))
    state.invCount = 659;
    const afterDelete = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(afterDelete.driftDetected).toBe(true);
    expect(afterDelete.reason).toBe('inventory_watermark_changed');
    expect(reconcileMock).toHaveBeenCalledTimes(1);

    // Próximo tick sem novas mudanças volta a ser no-op
    const third = await runMatchInventorySyncIfChanged(db, 'acct-1');
    expect(third.driftDetected).toBe(false);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it('triggers reconcile when an inventory item is updated (latestInvAt advances)', async () => {
    const state = {
      invLatest: '2026-11-26T18:00:00.000Z',
      projLatest: '2026-11-26T18:05:00.000Z',
      invCount: 660,
      projCount: 662,
    };
    const db = createMockDb(state);

    await runMatchInventorySyncIfChanged(db, 'acct-1');
    expect(reconcileMock).toHaveBeenCalledTimes(0);

    state.invLatest = '2026-11-26T18:10:00.000Z';
    const afterUpdate = await runMatchInventorySyncIfChanged(db, 'acct-1');

    expect(afterUpdate.driftDetected).toBe(true);
    expect(afterUpdate.reason).toBe('inventory_newer_than_projection');
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it('triggers reconcile on cold start if inventory has MORE rows than projections (missing projections)', async () => {
    const db = createMockDb({
      invLatest: '2026-11-26T18:00:00.000Z',
      projLatest: '2026-11-26T18:05:00.000Z',
      invCount: 665,
      projCount: 662,
    });

    const result = await runMatchInventorySyncIfChanged(db, 'acct-1');
    expect(result.driftDetected).toBe(true);
    expect(result.reason).toBe('inventory_missing_projections');
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it('caches resolveOperationalMatchAccountId in memory to avoid repeated profiles queries', async () => {
    const profileCalls = { count: 0 };
    const db = createMockDb({
      invLatest: '2026-11-26T18:00:00.000Z',
      projLatest: '2026-11-26T18:05:00.000Z',
      invCount: 660,
      projCount: 662,
      profileCalls,
    });

    const a1 = await resolveOperationalMatchAccountId(db);
    const a2 = await resolveOperationalMatchAccountId(db);
    const a3 = await resolveOperationalMatchAccountId(db);

    expect(a1).toBe('acct-real');
    expect(a2).toBe('acct-real');
    expect(a3).toBe('acct-real');
    expect(profileCalls.count).toBe(1);
  });
});
