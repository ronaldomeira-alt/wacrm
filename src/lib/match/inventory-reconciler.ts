import type { SupabaseClient } from '@supabase/supabase-js';
import { ensurePropertyUuid } from '../tunnel/auth';
import { isMatchRelevantProjectionChange } from './change-detection';
import { recalculateMatchesForProperty } from './service';
import type { DeliveryStatus, PropertyOperation } from './types';

// Watermark em memória por accountId para evitar reconciliações redundantes em rajadas de requests
const lastReconcileByAccount = new Map<string, number>();
const RECONCILE_COOLDOWN_MS = 20_000; // 20 segundos

export interface InventoryPropertyRawRow {
  account_id?: string;
  property_id: string;
  property_data: Record<string, unknown>;
  updated_at?: string;
}

export interface ProjectionDbRow {
  account_id: string;
  property_id: string;
  code: string | null;
  title: string;
  operation: PropertyOperation;
  property_type: string;
  neighborhood: string;
  city: string;
  price_min: number;
  price_max: number;
  area_min: number | null;
  area_max: number | null;
  bedrooms_min: number | null;
  bedrooms_max: number | null;
  delivery_status: DeliveryStatus;
  delivery_deadline: string | null;
  features: string[];
  cover_url: string | null;
  public_url: string | null;
  status: 'ativo' | 'inativo' | 'arquivado';
  updated_at: string;
}

function normalizeDateString(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01`;
  if (/^\d{2}\/\d{4}$/.test(trimmed)) {
    const [mm, yyyy] = trimmed.split('/');
    return `${yyyy}-${mm}-01`;
  }
  return null;
}

/**
 * Converte uma linha da tabela `inventory_properties` (Meus Imóveis) para o formato
 * canônico de `property_match_projections` (WACRM).
 */
export function inventoryRowToProjectionRow(
  invRow: InventoryPropertyRawRow,
  targetAccountId: string
): ProjectionDbRow {
  const raw = (invRow.property_data || {}) as Record<string, unknown>;
  const rawId = String(invRow.property_id || raw.id || '');
  const propertyId = ensurePropertyUuid(rawId);

  const propType = String(raw.type || 'apartamento').toLowerCase().trim();
  const neighborhood = String(raw.neighborhood || 'João Pessoa').trim() || 'João Pessoa';
  const city = String(raw.city || 'João Pessoa').trim() || 'João Pessoa';
  const title =
    String(raw.title || raw.condominium_name || `${raw.type || 'Imóvel'} no ${neighborhood}`).trim() ||
    'Imóvel';

  const operation: PropertyOperation =
    String(raw.purpose || '').trim().toLowerCase() === 'locação' ||
    String(raw.purpose || '').trim().toLowerCase() === 'locacao'
      ? 'locacao'
      : 'venda';

  const priceRange = (raw.price_range as { min?: number; max?: number } | null) || null;
  const priceMin = Number(priceRange?.min ?? raw.price_from ?? raw.price ?? 0) || 0;
  const priceMax = Number(priceRange?.max ?? raw.price_to ?? raw.price ?? priceMin) || priceMin;

  const areaRange = (raw.area_range as { min?: number; max?: number } | null) || null;
  const areaMin =
    areaRange?.min != null
      ? Number(areaRange.min)
      : raw.area_m2 != null
      ? Number(raw.area_m2)
      : null;
  const areaMax =
    areaRange?.max != null
      ? Number(areaRange.max)
      : raw.area_m2 != null
      ? Number(raw.area_m2)
      : areaMin;

  let bedroomsMin: number | null = null;
  let bedroomsMax: number | null = null;
  const bedOptions = Array.isArray(raw.bedrooms_options)
    ? (raw.bedrooms_options as unknown[]).map(Number).filter((n) => !Number.isNaN(n))
    : [];
  if (bedOptions.length > 0) {
    bedroomsMin = Math.min(...bedOptions);
    bedroomsMax = Math.max(...bedOptions);
  } else if (raw.bedrooms != null && !Number.isNaN(Number(raw.bedrooms))) {
    bedroomsMin = Number(raw.bedrooms);
    bedroomsMax = Number(raw.bedrooms);
  }

  let deliveryStatus: DeliveryStatus = 'pronto';
  const bFeats = Array.isArray(raw.building_features) ? (raw.building_features as string[]) : [];
  const aFeats = Array.isArray(raw.apartment_features) ? (raw.apartment_features as string[]) : [];
  const notesText = [
    ...bFeats,
    ...aFeats,
    String(raw.notes || ''),
  ]
    .join(' ')
    .toLowerCase();

  const stage = String(raw.stage || '');
  if (raw.is_development || stage) {
    if (stage === 'Pré-lançamento' || stage === 'Lançamento') {
      deliveryStatus = 'planta';
    } else if (stage === 'Em construção') {
      deliveryStatus = 'em_construcao';
    } else if (stage === 'Pronto para morar') {
      deliveryStatus = 'pronto';
    } else {
      deliveryStatus = 'planta';
    }
  } else if (notesText.includes('na planta') || notesText.includes('lançamento')) {
    deliveryStatus = 'planta';
  } else if (notesText.includes('em construção') || notesText.includes('obra')) {
    deliveryStatus = 'em_construcao';
  }

  const activeUnitStatuses = new Set(['disponivel', 'disponível', 'available', 'ativo', 'active']);
  const units = Array.isArray(raw.units) ? (raw.units as Array<{ status?: string }>) : [];
  const hasUnitInventory = units.length > 0;
  const hasAvailableUnit =
    hasUnitInventory &&
    units.some((u) => activeUnitStatuses.has(String(u?.status || '').trim().toLowerCase()));

  const rawStatus = String(raw.status || '').trim().toLowerCase();
  const rawStatusEnum = String(raw.status_enum || '').trim().toLowerCase();
  const isVendido = rawStatus === 'vendido' || rawStatusEnum === 'vendido';
  const isArquivado = rawStatus === 'arquivado' || rawStatusEnum === 'arquivado';
  const isInativo = rawStatus === 'inativo' || rawStatusEnum === 'inativo';
  const isExplicitlyDeactivated =
    raw.ativo === false || Boolean(raw.desativado_em) || Boolean(raw.motivo_desativacao);
  const developmentWithoutUnits = Boolean(raw.is_development && (!hasUnitInventory || !hasAvailableUnit));
  const unitInventoryExhausted = Boolean(!raw.is_development && hasUnitInventory && !hasAvailableUnit);

  // Regra de negócio: o catálogo do Match é exclusivo de VENDA.
  const isAtivo =
    operation === 'venda' &&
    !isVendido &&
    !isArquivado &&
    !isInativo &&
    !isExplicitlyDeactivated &&
    !developmentWithoutUnits &&
    !unitInventoryExhausted;

  const status: 'ativo' | 'inativo' | 'arquivado' = isAtivo
    ? 'ativo'
    : isArquivado
    ? 'arquivado'
    : 'inativo';

  const features = Array.from(new Set([...bFeats, ...aFeats].map(String)));

  const photos = Array.isArray(raw.photos)
    ? (raw.photos as Array<{ is_cover?: boolean; storage_path?: string; url?: string }>)
    : [];
  const coverPhoto = photos.find((p) => p?.is_cover) || photos[0];
  let coverUrl: string | null = null;
  if (coverPhoto?.url) {
    coverUrl = String(coverPhoto.url);
  } else if (coverPhoto?.storage_path) {
    const sp = String(coverPhoto.storage_path);
    coverUrl = sp.startsWith('http')
      ? sp
      : `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/storage/v1/object/public/property-photos/${sp}`;
  }

  const publicUrl = raw.public_page_id ? `/imovel/${String(raw.public_page_id)}` : null;

  return {
    account_id: targetAccountId,
    property_id: propertyId,
    code: raw.unit ? `Unidade ${String(raw.unit)}` : (raw.code as string) || null,
    title,
    operation,
    property_type: propType,
    neighborhood,
    city,
    price_min: priceMin,
    price_max: priceMax,
    area_min: areaMin,
    area_max: areaMax,
    bedrooms_min: bedroomsMin,
    bedrooms_max: bedroomsMax,
    delivery_status: deliveryStatus,
    delivery_deadline: normalizeDateString(raw.delivery_deadline ?? raw.delivery_date),
    features,
    cover_url: coverUrl,
    public_url: publicUrl,
    status,
    updated_at: invRow.updated_at || (raw.updated_at as string) || new Date().toISOString(),
  };
}

export interface ReconcileInventoryResult {
  executed: boolean;
  /** true quando o ciclo não completou (erro de leitura ou exceção) e o gate deve repetir. */
  partial?: boolean;
  upsertedProjections: number;
  deactivatedOrphans: number;
  recalculatedProperties: number;
  archivedContactMatchesCleaned: number;
}

/**
 * Reconcilia incrementalmente `inventory_properties` (Meus Imóveis) com `property_match_projections` (WACRM)
 * e higieniza matches `'novo'` de contatos que já foram arquivados ou pausados.
 *
 * Recupera automaticamente eventos perdidos durante indisponibilidade de rede, falhas no túnel
 * ou edições realizadas via MCP / Cron OLX / Importação no Meus Imóveis.
 */
export async function reconcileInventoryWithProjections(
  db: SupabaseClient,
  accountId: string,
  options?: {
    force?: boolean;
    maxPropertiesToRecalculate?: number;
    suppressNotifications?: boolean;
  }
): Promise<ReconcileInventoryResult> {
  const now = Date.now();
  const lastRun = lastReconcileByAccount.get(accountId) || 0;
  if (!options?.force && now - lastRun < RECONCILE_COOLDOWN_MS) {
    return {
      executed: false,
      upsertedProjections: 0,
      deactivatedOrphans: 0,
      recalculatedProperties: 0,
      archivedContactMatchesCleaned: 0,
    };
  }
  lastReconcileByAccount.set(accountId, now);

  let upsertedProjections = 0;
  let deactivatedOrphans = 0;
  let recalculatedProperties = 0;
  let archivedContactMatchesCleaned = 0;

  try {
    // 1. Higieniza matches 'novo' pertencentes a leads que já estão arquivados ou pausados
    const contactsTable = db.from('contacts');
    if (typeof contactsTable?.select === 'function') {
      const { data: inactiveContacts } = await contactsTable
        .select('id, paused_at, archived_at')
        .eq('account_id', accountId);

      const archivedLeadIds = (inactiveContacts || [])
        .filter((c: { archived_at?: string | null }) => Boolean(c.archived_at))
        .map((c: { id: string }) => c.id);

      const pausedLeadIds = (inactiveContacts || [])
        .filter((c: { paused_at?: string | null; archived_at?: string | null }) => Boolean(c.paused_at) && !c.archived_at)
        .map((c: { id: string }) => c.id);

      const nowIso = new Date().toISOString();
      if (archivedLeadIds.length > 0) {
        for (let i = 0; i < archivedLeadIds.length; i += 100) {
          const slice = archivedLeadIds.slice(i, i + 100);
          const { data: cleaned } = await db
            .from('lead_property_matches')
            .update({ match_status: 'arquivado', archived_at: nowIso, updated_at: nowIso })
            .eq('account_id', accountId)
            .eq('match_status', 'novo')
            .eq('suppressed', false)
            .in('lead_id', slice)
            .select('id');
          archivedContactMatchesCleaned += cleaned?.length || 0;
        }
      }

      if (pausedLeadIds.length > 0) {
        for (let i = 0; i < pausedLeadIds.length; i += 100) {
          const slice = pausedLeadIds.slice(i, i + 100);
          await db
            .from('lead_property_matches')
            .update({ match_status: 'pausado', paused_at: nowIso, updated_at: nowIso })
            .eq('account_id', accountId)
            .eq('match_status', 'novo')
            .eq('suppressed', false)
            .in('lead_id', slice);
        }
      }
    }
  } catch (err) {
    console.warn('[reconcileInventory] Aviso na higienização de contatos inativos:', err);
  }

  try {
    // 2. Carrega inventário do Meus Imóveis e projeções atuais do WACRM
    const invTable = db.from('inventory_properties');
    if (typeof invTable?.select !== 'function') {
      return {
        executed: true,
        partial: true,
        upsertedProjections,
        deactivatedOrphans,
        recalculatedProperties,
        archivedContactMatchesCleaned,
      };
    }

    const [{ data: invRows, error: invErr }, { data: projRows, error: projErr }] = await Promise.all([
      invTable.select('property_id, account_id, property_data, updated_at'),
      db
        .from('property_match_projections')
        .select(
          'property_id, account_id, code, title, operation, property_type, neighborhood, city, price_min, price_max, area_min, area_max, bedrooms_min, bedrooms_max, delivery_status, delivery_deadline, features, cover_url, public_url, status, updated_at'
        )
        .eq('account_id', accountId),
    ]);

    if (invErr || projErr || !invRows || invRows.length === 0) {
      return {
        executed: true,
        partial: true,
        upsertedProjections,
        deactivatedOrphans,
        recalculatedProperties,
        archivedContactMatchesCleaned,
      };
    }

    // Carrega imóveis explicitamente deletados para não ressuscitar tombstones
    const deletedSet = new Set<string>();
    try {
      const delTable = db.from('deleted_match_properties');
      if (typeof delTable?.select === 'function') {
        const { data: delRows } = await delTable
          .select('property_id')
          .eq('account_id', accountId);
        for (const r of (delRows || []) as Array<{ property_id: string }>) {
          deletedSet.add(r.property_id);
        }
      }
    } catch {
      // Ignora se a tabela não estiver acessível
    }

    const existingMap = new Map<string, Record<string, unknown>>();
    for (const p of (projRows || []) as Array<Record<string, unknown>>) {
      existingMap.set(String(p.property_id), p);
    }

    const projectionsToUpsert: ProjectionDbRow[] = [];
    const propertiesToRecalculate: Array<{ propertyId: string; isRecentUpdate: boolean }> = [];
    const seenPropertyIds = new Set<string>();

    for (const inv of invRows as InventoryPropertyRawRow[]) {
      const candidate = inventoryRowToProjectionRow(inv, accountId);
      if (deletedSet.has(candidate.property_id)) continue;

      seenPropertyIds.add(candidate.property_id);
      const existing = existingMap.get(candidate.property_id);

      const isNew = !existing;
      const isRelevantChange =
        isNew ||
        isMatchRelevantProjectionChange(
          existing as Record<string, unknown>,
          candidate as unknown as Record<string, unknown>
        );
      const isCosmeticChange =
        !isNew &&
        !isRelevantChange &&
        (existing.title !== candidate.title ||
          (existing.cover_url || null) !== (candidate.cover_url || null) ||
          (existing.public_url || null) !== (candidate.public_url || null));

      if (isNew || isRelevantChange || isCosmeticChange) {
        projectionsToUpsert.push({
          ...candidate,
          cover_url: candidate.cover_url || (existing?.cover_url as string) || null,
          public_url: candidate.public_url || (existing?.public_url as string) || null,
        });
      }

      if (isNew || isRelevantChange) {
        const invUpdatedMs = inv.updated_at ? new Date(inv.updated_at).getTime() : 0;
        const isRecentUpdate =
          invUpdatedMs > 0 && Date.now() - invUpdatedMs <= 24 * 60 * 60 * 1000;
        propertiesToRecalculate.push({
          propertyId: candidate.property_id,
          isRecentUpdate,
        });
      }
    }

    // Identifica projeções órfãs (que não existem mais em inventory_properties e ainda constavam como 'ativo')
    const orphanActiveIds: string[] = [];
    for (const [propId, existing] of existingMap.entries()) {
      if (!seenPropertyIds.has(propId) && existing.status === 'ativo') {
        orphanActiveIds.push(propId);
      }
    }

    if (orphanActiveIds.length > 0) {
      const nowIso = new Date().toISOString();
      for (let i = 0; i < orphanActiveIds.length; i += 50) {
        const chunk = orphanActiveIds.slice(i, i + 50);
        await db
          .from('property_match_projections')
          .update({ status: 'inativo', updated_at: nowIso })
          .eq('account_id', accountId)
          .in('property_id', chunk);

        await db
          .from('lead_property_matches')
          .delete()
          .eq('account_id', accountId)
          .eq('match_status', 'novo')
          .in('property_id', chunk);
      }
      deactivatedOrphans = orphanActiveIds.length;
    }

    // Upsert das projeções alteradas/novas em lotes de 100
    if (projectionsToUpsert.length > 0) {
      for (let i = 0; i < projectionsToUpsert.length; i += 100) {
        const chunk = projectionsToUpsert.slice(i, i + 100);
        const { error: uErr } = await db
          .from('property_match_projections')
          .upsert(chunk, { onConflict: 'account_id,property_id' });
        if (!uErr) {
          upsertedProjections += chunk.length;
        }
      }
    }

    // Recalcula matches para os imóveis afetados
    if (propertiesToRecalculate.length > 0) {
      // Se for uma sincronização em massa de histórico (> 3 imóveis defasados),
      // suprime notificações retroativas para evitar avalanche
      const isBulkCatchup =
        Boolean(options?.suppressNotifications) || propertiesToRecalculate.length > 3;
      const maxToProcess = options?.maxPropertiesToRecalculate ?? 25;
      const slice = propertiesToRecalculate.slice(0, maxToProcess);

      for (const item of slice) {
        await recalculateMatchesForProperty(db, accountId, item.propertyId, {
          suppressNotifications: isBulkCatchup || !item.isRecentUpdate,
        });
        recalculatedProperties++;
      }

      // Se sobraram mais imóveis de um lote grande, permite próxima rodada sem cooldown longo
      if (propertiesToRecalculate.length > maxToProcess) {
        lastReconcileByAccount.set(accountId, 0);
      }
    }
  } catch (err) {
    console.warn('[reconcileInventory] Erro durante reconciliação:', err);
    return {
      executed: true,
      partial: true,
      upsertedProjections,
      deactivatedOrphans,
      recalculatedProperties,
      archivedContactMatchesCleaned,
    };
  }

  return {
    executed: true,
    upsertedProjections,
    deactivatedOrphans,
    recalculatedProperties,
    archivedContactMatchesCleaned,
  };
}

export function resetInventoryReconcileWatermark(accountId?: string): void {
  if (accountId) {
    lastReconcileByAccount.delete(accountId);
  } else {
    lastReconcileByAccount.clear();
  }
}
