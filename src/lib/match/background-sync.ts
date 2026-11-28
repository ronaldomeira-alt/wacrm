import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../push/admin-client';
import {
  reconcileInventoryWithProjections,
  type ReconcileInventoryResult,
} from './inventory-reconciler';
import {
  claimMatchSync,
  commitMatchSync,
  isMatchSyncStateEnabled,
  probeMatchSync,
  releaseMatchSync,
  type MatchSyncClaim,
  type MatchSyncProbe,
} from './sync-state';

const DEFAULT_OPERATIONAL_ACCOUNT_ID = 'f8d2ae51-e393-4a74-a432-ddab0610837e';
const DEFAULT_WATCHER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const DEFAULT_FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas (rede de segurança; inserts/updates/deletes são detectados pelo watermark)

let watcherStarted = false;
let syncInFlight = false;
let cachedOperationalAccountId: string | null = null;
const lastObservedInventoryByAccount = new Map<
  string,
  { count: number; latestUpdatedAt: number; lastFullReconcileAt: number }
>();

// Freio de falha contínua: se a reconciliação falhar (ou voltar parcial), não
// repete a leitura integral a cada tick indefinidamente.
const failureBackoffUntilByAccount = new Map<string, number>();
const FAILURE_BACKOFF_MS = 15 * 60 * 1000;

export function resetBackgroundSyncState(accountId?: string): void {
  if (accountId) {
    lastObservedInventoryByAccount.delete(accountId);
    failureBackoffUntilByAccount.delete(accountId);
  } else {
    lastObservedInventoryByAccount.clear();
    failureBackoffUntilByAccount.clear();
    cachedOperationalAccountId = null;
  }
}

export async function resolveOperationalMatchAccountId(db: SupabaseClient): Promise<string | null> {
  if (process.env.MATCH_CANONICAL_ACCOUNT_ID) {
    return process.env.MATCH_CANONICAL_ACCOUNT_ID.trim();
  }

  if (cachedOperationalAccountId) {
    return cachedOperationalAccountId;
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
      cachedOperationalAccountId = String(realProfile.account_id);
      return cachedOperationalAccountId;
    }
  } catch {
    // Fallback para conta operacional padrão
  }

  cachedOperationalAccountId = DEFAULT_OPERATIONAL_ACCOUNT_ID;
  return cachedOperationalAccountId;
}

export interface BackgroundSyncCheckResult {
  checked: boolean;
  driftDetected: boolean;
  reason: string;
  reconcile?: ReconcileInventoryResult;
}

/**
 * Ciclo protegido pelo estado persistente (DEM-004).
 *
 * Regras:
 * - o fingerprint commitado é sempre o do probe ANTERIOR à leitura; um re-probe
 *   depois da leitura faria o próximo tick pular a mudança para sempre;
 * - a reconciliação completa periódica ignora o fingerprint, cobrindo escrita
 *   direta no inventário que não avança `updated_at`;
 * - ciclo parcial (erro silencioso do reconciliador) não avança o fingerprint:
 *   o tick seguinte repete o mesmo intervalo.
 */
async function runGateCycle(
  db: SupabaseClient,
  accountId: string,
  claim: MatchSyncClaim,
  probe: MatchSyncProbe,
  options: {
    maxPropertiesToRecalculate: number;
    suppressNotifications?: boolean;
    fullReconcileIntervalMs: number;
    nowMs: number;
  }
): Promise<BackgroundSyncCheckResult> {
  const lockToken = claim.lockToken as string;
  const lastFullMs = claim.lastFullSyncAt ? Date.parse(claim.lastFullSyncAt) : 0;
  const periodicFullDue = !lastFullMs || options.nowMs - lastFullMs >= options.fullReconcileIntervalMs;

  if (!periodicFullDue && claim.lastFingerprint === probe.fingerprint) {
    await commitMatchSync(db, accountId, lockToken, probe, 'skipped');
    return { checked: true, driftDetected: false, reason: 'up_to_date' };
  }

  try {
    const reconcile = await reconcileInventoryWithProjections(db, accountId, {
      force: true,
      maxPropertiesToRecalculate: options.maxPropertiesToRecalculate,
      suppressNotifications: options.suppressNotifications,
    });

    const partial = Boolean(reconcile.partial);
    if (partial) {
      failureBackoffUntilByAccount.set(accountId, Date.now() + FAILURE_BACKOFF_MS);
    } else {
      failureBackoffUntilByAccount.delete(accountId);
    }
    if (!partial) {
      await commitMatchSync(db, accountId, lockToken, probe, 'full');
    } else if (claim.lastFingerprint) {
      await commitMatchSync(
        db,
        accountId,
        lockToken,
        { ...probe, fingerprint: claim.lastFingerprint },
        'incremental'
      );
    } else {
      await releaseMatchSync(db, accountId, lockToken);
    }

    const driftDetected =
      reconcile.upsertedProjections > 0 ||
      reconcile.deactivatedOrphans > 0 ||
      reconcile.recalculatedProperties > 0;

    return {
      checked: true,
      driftDetected,
      reason: periodicFullDue ? 'periodic_full_verification' : 'inventory_watermark_changed',
      reconcile,
    };
  } catch (err) {
    await releaseMatchSync(db, accountId, lockToken);
    throw err;
  }
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
  options?: {
    force?: boolean;
    maxPropertiesToRecalculate?: number;
    suppressNotifications?: boolean;
    fullReconcileIntervalMs?: number;
  }
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

    const nowMs = Date.now();
    // O kill switch tem precedência: com o gate desligado, o caminho legado roda
    // como antes e o backoff não se aplica.
    if (
      isMatchSyncStateEnabled() &&
      !options?.force &&
      (failureBackoffUntilByAccount.get(targetAccountId) ?? 0) > nowMs
    ) {
      return { checked: false, driftDetected: false, reason: 'reconcile_failed_backoff' };
    }

    const fullReconcileIntervalMs = Math.max(
      60_000,
      options?.fullReconcileIntervalMs ??
        Number(process.env.MATCH_FULL_RECONCILE_INTERVAL_MS || DEFAULT_FULL_RECONCILE_INTERVAL_MS)
    );

    if (options?.force) {
      const reconcile = await reconcileInventoryWithProjections(db, targetAccountId, {
        force: true,
        maxPropertiesToRecalculate: options.maxPropertiesToRecalculate ?? 40,
        suppressNotifications: options.suppressNotifications,
      });
      const prev = lastObservedInventoryByAccount.get(targetAccountId);
      lastObservedInventoryByAccount.set(targetAccountId, {
        count: prev?.count ?? -1,
        latestUpdatedAt: prev?.latestUpdatedAt ?? nowMs,
        lastFullReconcileAt: nowMs,
      });
      return { checked: true, driftDetected: true, reason: 'forced', reconcile };
    }

    // DEM-004 (N1): gate persistente em banco. Só evita a leitura integral;
    // não aplica nenhum dado. Se as funções não existirem, cai no caminho legado.
    if (isMatchSyncStateEnabled()) {
      const claim = await claimMatchSync(db, targetAccountId);
      if (claim && !claim.acquired) {
        return { checked: false, driftDetected: false, reason: 'sync_already_in_flight' };
      }
      if (claim?.acquired && claim.lockToken) {
        const probe = await probeMatchSync(db, targetAccountId);
        if (!probe) {
          await releaseMatchSync(db, targetAccountId, claim.lockToken);
        } else {
          return await runGateCycle(db, targetAccountId, claim, probe, {
            maxPropertiesToRecalculate: options?.maxPropertiesToRecalculate ?? 25,
            suppressNotifications: options?.suppressNotifications,
            fullReconcileIntervalMs,
            nowMs,
          });
        }
      }
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

    const prevObserved = lastObservedInventoryByAccount.get(targetAccountId);
    // A projeção herda `updated_at` do imóvel. Comparar o máximo de duas tabelas
    // diferentes mantinha `hasNewerInventory` verdadeiro para sempre quando a última
    // edição não gerava upsert (caso real: 26/11 20:36 vs 20:35), forçando leitura
    // integral em todo tick. A comparação agora só serve de bootstrap no cold-start.
    const hasNewerInventory = !prevObserved && latestInvAt > latestProjAt;
    // `property_match_projections` retém projeções inativas/arquivadas de imóveis
    // removidos de `inventory_properties` (nunca executa DELETE de órfãos). Portanto,
    // `projCount > invCount` é um estado estável e legítimo — comparar `invCount !== projCount`
    // causava falso-positivo permanente em 100% dos ticks (loop de leitura integral da tabela).
    // Só tratamos divergência de contagem como drift no cold-start quando há MAIS imóveis
    // no inventário do que projeções conhecidas (`invCount > projCount`). Qualquer inserção,
    // edição ou exclusão subsequente é detectada com exatidão por `hasInventoryWatermarkChanged`.
    const hasMissingProjections = !prevObserved && invCount >= 0 && projCount >= 0 && invCount > projCount;
    const hasInventoryWatermarkChanged = Boolean(
      prevObserved &&
        ((invCount >= 0 && prevObserved.count >= 0 && invCount !== prevObserved.count) ||
          (latestInvAt > 0 && latestInvAt !== prevObserved.latestUpdatedAt))
    );
    const isPeriodicFullCheckDue = Boolean(
      prevObserved && nowMs - prevObserved.lastFullReconcileAt >= fullReconcileIntervalMs
    );

    if (
      !hasNewerInventory &&
      !hasMissingProjections &&
      !hasInventoryWatermarkChanged &&
      !isPeriodicFullCheckDue
    ) {
      lastObservedInventoryByAccount.set(targetAccountId, {
        count: invCount,
        latestUpdatedAt: latestInvAt,
        lastFullReconcileAt: prevObserved?.lastFullReconcileAt ?? nowMs,
      });
      return { checked: true, driftDetected: false, reason: 'up_to_date' };
    }

    const reason = hasNewerInventory
      ? 'inventory_newer_than_projection'
      : hasMissingProjections
        ? 'inventory_missing_projections'
        : hasInventoryWatermarkChanged
          ? 'inventory_watermark_changed'
          : 'periodic_full_verification';

    const reconcile = await reconcileInventoryWithProjections(db, targetAccountId, {
      force: true,
      maxPropertiesToRecalculate: options?.maxPropertiesToRecalculate ?? 25,
      suppressNotifications: options?.suppressNotifications,
    });

    lastObservedInventoryByAccount.set(targetAccountId, {
      count: invCount,
      latestUpdatedAt: latestInvAt,
      lastFullReconcileAt: nowMs,
    });

    const actualDrift =
      reconcile.upsertedProjections > 0 ||
      reconcile.deactivatedOrphans > 0 ||
      reconcile.recalculatedProperties > 0;

    return {
      checked: true,
      driftDetected: actualDrift || hasNewerInventory || hasMissingProjections || hasInventoryWatermarkChanged,
      reason,
      reconcile,
    };
  } catch (err) {
    console.warn('[match-background-sync] Falha no check automático:', err);
    failureBackoffUntilByAccount.set(
      accountId || cachedOperationalAccountId || 'default',
      Date.now() + FAILURE_BACKOFF_MS
    );
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
