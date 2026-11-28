import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Estado persistente do ciclo de Match (DEM-004).
 *
 * O gate anterior usava `max(updated_at)` de `property_match_projections` como
 * referência de sincronização. Como a projeção herda o `updated_at` do imóvel,
 * uma alteração que não muda nada relevante deixa a projeção permanentemente
 * "atrás" do inventário e o gate nunca fecha — cada tick lê a base inteira.
 *
 * Aqui o estado vive no banco (`match_sync_state`), é calculado por uma única
 * chamada barata (`probe_match_sync`) e inclui os dois drenos de exclusão.
 * Se as funções ainda não existirem no banco, tudo retorna `null` e o chamador
 * segue pelo caminho antigo, sem quebrar o deploy.
 */

export const DEFAULT_SOURCE_INVENTORY_ACCOUNT_ID = '52716edc-399e-4d4c-9788-0d6b04c0031f';
const DEFAULT_LOCK_SECONDS = 900;

export interface MatchSyncProbe {
  inventoryWatermark: string | null;
  inventoryCount: number;
  tombstoneCount: number;
  tombstoneMaxAt: string | null;
  deletedMatchCount: number;
  deletedMatchMaxAt: string | null;
  fingerprint: string;
}

export interface MatchSyncClaim {
  acquired: boolean;
  lastFingerprint: string | null;
  lastRunAt: string | null;
  lastFullSyncAt: string | null;
  lockToken: string | null;
}

export type MatchSyncMode = 'skipped' | 'full' | 'incremental';

const warnedFunctions = new Set<string>();

function warnOnce(fn: string, detail: unknown): void {
  if (warnedFunctions.has(fn)) return;
  warnedFunctions.add(fn);
  console.warn(`[match-sync-state] falha em ${fn}; usando caminho legado:`, detail);
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function resolveSourceInventoryAccountId(): string {
  return (process.env.MATCH_SYNC_SOURCE_ACCOUNT_ID || '').trim() || DEFAULT_SOURCE_INVENTORY_ACCOUNT_ID;
}

export function isMatchSyncStateEnabled(): boolean {
  // Dois nomes aceitos: MATCH_SYNC_GATE (documentado) e MATCH_SYNC_STATE (legado).
  const value = process.env.MATCH_SYNC_GATE ?? process.env.MATCH_SYNC_STATE;
  return value !== 'off';
}

/** Uma única chamada ~300 B; retorna null se a função ainda não existir no banco. */
export async function probeMatchSync(
  db: SupabaseClient,
  operationalAccountId: string,
  sourceAccountId = resolveSourceInventoryAccountId()
): Promise<MatchSyncProbe | null> {
  if (typeof db?.rpc !== 'function') return null;
  try {
    const { data, error } = await db.rpc('probe_match_sync', {
      p_operational_account_id: operationalAccountId,
      p_source_account_id: sourceAccountId,
    });
    if (error || !data) {
      warnOnce('probe_match_sync', error || 'sem dados');
      return null;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row.fingerprint !== 'string') {
      warnOnce('probe_match_sync', 'fingerprint ausente');
      return null;
    }

    return {
      inventoryWatermark: asString(row.inventoryWatermark),
      inventoryCount: asNumber(row.inventoryCount),
      tombstoneCount: asNumber(row.tombstoneCount),
      tombstoneMaxAt: asString(row.tombstoneMaxAt),
      deletedMatchCount: asNumber(row.deletedMatchCount),
      deletedMatchMaxAt: asString(row.deletedMatchMaxAt),
      fingerprint: row.fingerprint,
    };
  } catch {
    return null;
  }
}

export async function claimMatchSync(
  db: SupabaseClient,
  operationalAccountId: string,
  lockSeconds = DEFAULT_LOCK_SECONDS
): Promise<MatchSyncClaim | null> {
  if (typeof db?.rpc !== 'function') return null;
  try {
    const { data, error } = await db.rpc('claim_match_sync', {
      p_operational_account_id: operationalAccountId,
      p_lock_seconds: lockSeconds,
    });
    if (error) {
      warnOnce('claim_match_sync', error);
      return null;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row) {
      warnOnce('claim_match_sync', 'sem linha de retorno');
      return null;
    }

    return {
      acquired: Boolean(row.acquired),
      lastFingerprint: asString(row.last_fingerprint),
      lastRunAt: asString(row.last_run_at),
      lastFullSyncAt: asString(row.last_full_sync_at),
      lockToken: asString(row.lock_token),
    };
  } catch {
    return null;
  }
}

export async function commitMatchSync(
  db: SupabaseClient,
  operationalAccountId: string,
  lockToken: string,
  probe: MatchSyncProbe,
  mode: MatchSyncMode
): Promise<boolean> {
  if (typeof db?.rpc !== 'function') return false;
  try {
    const { data, error } = await db.rpc('commit_match_sync', {
      p_operational_account_id: operationalAccountId,
      p_lock_token: lockToken,
      p_fingerprint: probe.fingerprint,
      p_mode: mode,
      p_inventory_watermark: probe.inventoryWatermark,
      p_tombstone_count: probe.tombstoneCount,
      p_deleted_match_count: probe.deletedMatchCount,
    });
    if (error) warnOnce('commit_match_sync', error);
    return !error && data === true;
  } catch (err) {
    warnOnce('commit_match_sync', err);
    return false;
  }
}

export async function releaseMatchSync(
  db: SupabaseClient,
  operationalAccountId: string,
  lockToken: string
): Promise<boolean> {
  if (typeof db?.rpc !== 'function') return false;
  try {
    const { data, error } = await db.rpc('release_match_sync', {
      p_operational_account_id: operationalAccountId,
      p_lock_token: lockToken,
    });
    if (error) warnOnce('release_match_sync', error);
    return !error && data === true;
  } catch (err) {
    warnOnce('release_match_sync', err);
    return false;
  }
}
