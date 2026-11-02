/**
 * Verifica se uma alteração na projeção do imóvel afeta critérios comerciais
 * utilizados pelo mecanismo de Match (preço, bairro, quartos, tipologia, status, features).
 *
 * Se apenas campos cosméticos mudarem (fotos, links, título, código, descrições),
 * retorna false para evitar tempestade de recálculos no banco de dados.
 */
export function isMatchRelevantProjectionChange(
  oldProj: Record<string, unknown>,
  newProj: Record<string, unknown>
): boolean {
  if (oldProj.status !== newProj.status) return true;
  if (oldProj.operation !== newProj.operation) return true;
  if (oldProj.property_type !== newProj.property_type) return true;
  if (oldProj.neighborhood !== newProj.neighborhood) return true;
  if (oldProj.city !== newProj.city) return true;
  if (Number(oldProj.price_min ?? 0) !== Number(newProj.price_min ?? 0)) return true;
  if (Number(oldProj.price_max ?? 0) !== Number(newProj.price_max ?? 0)) return true;

  const oldAreaMin = oldProj.area_min != null ? Number(oldProj.area_min) : null;
  const newAreaMin = newProj.area_min != null ? Number(newProj.area_min) : null;
  if (oldAreaMin !== newAreaMin) return true;

  const oldAreaMax = oldProj.area_max != null ? Number(oldProj.area_max) : null;
  const newAreaMax = newProj.area_max != null ? Number(newProj.area_max) : null;
  if (oldAreaMax !== newAreaMax) return true;

  const oldBedMin = oldProj.bedrooms_min != null ? Number(oldProj.bedrooms_min) : null;
  const newBedMin = newProj.bedrooms_min != null ? Number(newProj.bedrooms_min) : null;
  if (oldBedMin !== newBedMin) return true;

  const oldBedMax = oldProj.bedrooms_max != null ? Number(oldProj.bedrooms_max) : null;
  const newBedMax = newProj.bedrooms_max != null ? Number(newProj.bedrooms_max) : null;
  if (oldBedMax !== newBedMax) return true;

  if ((oldProj.delivery_status || 'pronto') !== (newProj.delivery_status || 'pronto')) return true;
  if ((oldProj.delivery_deadline || null) !== (newProj.delivery_deadline || null)) return true;

  const oldFeatures = Array.isArray(oldProj.features) ? [...oldProj.features].map(String).sort() : [];
  const newFeatures = Array.isArray(newProj.features) ? [...newProj.features].map(String).sort() : [];
  if (oldFeatures.length !== newFeatures.length) return true;
  for (let i = 0; i < oldFeatures.length; i++) {
    if (oldFeatures[i] !== newFeatures[i]) return true;
  }

  return false;
}
