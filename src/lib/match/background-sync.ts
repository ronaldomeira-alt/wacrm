import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../push/admin-client';
import {
  reconcileInventoryWithProjections,
  type ReconcileInventoryResult,
} from './inventory-reconciler';

const DEFAULT_OPERATIONAL_ACCOUNT_ID = 'f8d2ae51-e393-4a74-a432-ddab0610837e';
const DEFAULT_WATCHER_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos

let watcherStarted = false;
let syncInFlight = false;

export async function resolveOperationalMatchAccountId(db: SupabaseClient): Promise<string | null> {
  if (process.env.MATCH_CANONICAL_ACCOUNT_ID) {
    return process.env.MATCH_CANONICAL_ACCOUNT_ID.trim();
  }

  try {
    const { data: realProfile } = await db
      .from('profiles')
      .select('account_id')
      .eq('email', 'ronaldomeiracorretor@gmail.com')
      .not('account_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (realProfile?.account_id) {
      return String(realProfile.account_id);
    }
  } catch {
    // Fallback para conta operacional padrão
  }

  return DEFAULT_OPERATIONAL_ACCOUNT_ID;
}

export interface BackgroundSyncCheckResult {
  checked: boolean;
  driftDetected: boolean;
  reason: string;
  reconcile?: ReconcileInventoryResult;
}

/**
 * Verificação ultraleve (2 consultas `LIMIT 1` + contagem) para detectar se houve
 * qualquer cadastro, edição ou exclusão em `inventory_properties` (Meus Imóveis)
 * ainda não refletida em `property_match_projections` (WACRM).
 *
 * Só dispara `reconcileInventoryWithProjections` se houver drift real ou `force: true`,
 * garantindo custo mínimo de banco e latência baixíssima.
 */
export async function runMatchInventorySyncIfChanged(
  db: SupabaseClient,
  accountId?: string | null,
  options?: { force?: boolean; maxPropertiesToRecalculate?: number }
): Promise<BackgroundSyncCheckResult> {
  if (syncInFlight) {
    return { checked: false, driftDetected: false, reason: 'sync_already_in_flight' };
  }

  syncInFlight = true;
  try {
    const targetAccountId = accountId || (await resolveOperationalMatchAccountId(db));
    if (!targetAccountId) {
      return { checked: false, driftDetected: false, reason: 'account_not_resolved' };
    }

    if (options?.force) {
      const reconcile = await reconcileInventoryWithProjections(db, targetAccountId, {
        force: true,
        maxPropertiesToRecalculate: options.maxPropertiesToRecalculate ?? 40,
      });
      return { checked: true, driftDetected: true, reason: 'forced', reconcile };
    }

    const [latestInvRes, latestProjRes, invCountRes, projCountRes] = await Promise.all([
      db
        .from('inventory_properties')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from('property_match_projections')
        .select('updated_at')
        .eq('account_id', targetAccountId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from('inventory_properties')
        .select('property_id', { count: 'exact', head: true }),
      db
        .from('property_match_projections')
        .select('property_id', { count: 'exact', head: true })
        .eq('account_id', targetAccountId),
    ]);

    const latestInvAt = latestInvRes.data?.updated_at
      ? new Date(String(latestInvRes.data.updated_at)).getTime()
      : 0;
    const latestProjAt = latestProjRes.data?.updated_at
      ? new Date(String(latestProjRes.data.updated_at)).getTime()
      : 0;
    const invCount = typeof invCountRes.count === 'number' ? invCountRes.count : -1;
    const projCount = typeof projCountRes.count === 'number' ? projCountRes.count : -1;

    const hasNewerInventory = latestInvAt > latestProjAt;
    const hasCountMismatch = invCount >= 0 && projCount >= 0 && invCount !== projCount;

    if (!hasNewerInventory && !hasCountMismatch) {
      return { checked: true, driftDetected: false, reason: 'up_to_date' };
    }

    const reason = hasNewerInventory ? 'inventory_newer_than_projection' : 'inventory_count_mismatch';
    const reconcile = await reconcileInventoryWithProjections(db, targetAccountId, {
      force: true,
      maxPropertiesToRecalculate: options?.maxPropertiesToRecalculate ?? 25,
    });

    return { checked: true, driftDetected: true, reason, reconcile };
  } catch (err) {
    console.warn('[match-background-sync] Falha no check automático:', err);
    return { checked: false, driftDetected: false, reason: 'error' };
  } finally {
    syncInFlight = false;
  }
}

/**
 * Inicia o watcher periódico em background no processo Node.js persistente (Hostinger).
 * Executa a cada 2 minutos com `.unref()` (nunca trava encerramento do servidor).
 * Guardado para nunca rodar em testes, builds ou ambientes sem credenciais configuradas.
 */
export function startMatchBackgroundSyncWatcher(): void {
  if (watcherStarted) return;
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.ENABLE_MATCH_BACKGROUND_SYNC === 'false') return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  watcherStarted = true;
  const intervalMs = Math.max(
    60_000,
    Number(process.env.MATCH_BACKGROUND_SYNC_INTERVAL_MS || DEFAULT_WATCHER_INTERVAL_MS)
  );

  const tick = async () => {
    try {
      const db = supabaseAdmin();
      await runMatchInventorySyncIfChanged(db, null, {
        force: false,
        maxPropertiesToRecalculate: 20,
      });
    } catch (err) {
      console.warn('[match-background-sync] Tick ignorado:', err);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}
