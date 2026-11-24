import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  LeadSearchProfile,
  InfoProvenance,
  DeliveryStatus,
  LeadCommercialOperation,
} from './types';

export interface ContactRow {
  id: string;
  account_id: string;
  name: string | null;
  phone: string;
  ai_score: number | null;
  paused_at: string | null;
  archived_at: string | null;
}

export interface TagWithJoin {
  source: string;
  originally_from_ctwa: boolean;
  tags: {
    id: string;
    name: string;
    category: string | null;
  } | null;
}

/**
 * Constrói o LeadSearchProfile agregando dados de contacts, lead_intelligence,
 * tags com proveniência e ctwa_referral da conversa mais recente.
 */
export async function buildLeadSearchProfile(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<LeadSearchProfile | null> {
  const [
    { data: contact },
    { data: intelligence },
    { data: contactTags },
    { data: conversation },
  ] = await Promise.all([
    db
      .from('contacts')
      .select('id, account_id, name, phone, ai_score, paused_at, archived_at')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle<ContactRow>(),
    db
      .from('lead_intelligence')
      .select('summary')
      .eq('contact_id', contactId)
      .maybeSingle<{ summary: Record<string, unknown> }>(),
    db
      .from('contact_tags')
      .select('source, originally_from_ctwa, tags!inner(id, name, category)')
      .eq('contact_id', contactId)
      .returns<TagWithJoin[]>(),
    db
      .from('conversations')
      .select('id, ctwa_referral')
      .eq('contact_id', contactId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; ctwa_referral: Record<string, unknown> | null }>(),
  ]);

  if (!contact) return null;

  return buildProfileFromData(contact, intelligence, contactTags, conversation);
}

/**
 * Constrói o LeadSearchProfile a partir de registros já carregados em memória.
 * Permite processamento em lote de múltiplos contatos sem incorrer em N+1 queries.
 */
export function buildProfileFromData(
  contact: ContactRow,
  intelligence: { summary?: Record<string, unknown> } | null,
  contactTags: TagWithJoin[] | null,
  conversation: { ctwa_referral?: Record<string, unknown> | null } | null
): LeadSearchProfile {
  const accountId = contact.account_id;
  const rawSummary = (intelligence?.summary || {}) as Record<string, unknown>;
  const ctwaReferral = conversation?.ctwa_referral || null;

  // Processa tags por categoria e proveniência
  const tagCategories: Record<string, { names: string[]; source: InfoProvenance }[]> = {};
  for (const ct of contactTags || []) {
    const t = ct.tags;
    if (!t || !t.category) continue;
    const cat = t.category.trim();
    const src = (ct.source as InfoProvenance) || 'conversation';
    (tagCategories[cat] ??= []).push({ names: [t.name], source: src });
  }

  // Helper para resolver proveniência de uma categoria
  const resolveProvenance = (cat: string, fallbackFromCtwa = false): InfoProvenance => {
    const entries = tagCategories[cat] || [];
    // Conversa ou manual sempre tem prioridade sobre CTWA
    if (entries.some((e) => e.source === 'conversation' || e.source === 'manual')) {
      return 'conversation';
    }
    if (entries.some((e) => e.source === 'ctwa') || fallbackFromCtwa) {
      return 'ctwa';
    }
    return 'conversation';
  };

  // 1. Finalidade (agrega estado atual do summary + tags de Finalidade)
  const rawPurpose = Array.isArray(rawSummary.purpose)
    ? (rawSummary.purpose as unknown[]).map((p) => String(p))
    : [];
  const notesText = typeof rawSummary.notes === 'string' ? rawSummary.notes : '';
  const stageSignalText = typeof rawSummary.stage_signal === 'string' ? rawSummary.stage_signal : '';
  const intentText = typeof rawSummary.intent === 'string' ? rawSummary.intent : '';
  const profileArrText = Array.isArray(rawSummary.profile)
    ? (rawSummary.profile as unknown[]).map((p) => String(p)).join(' ')
    : '';

  const purposeList = [...rawPurpose];
  const finalidadeTags = tagCategories['Finalidade'] || [];
  for (const ft of finalidadeTags) {
    for (const name of ft.names) {
      if (!purposeList.includes(name)) purposeList.push(name);
    }
  }

  // 2. Tipologias
  const propertyTypes = Array.isArray(rawSummary.property_type)
    ? (rawSummary.property_type as unknown[]).map((t) => String(t))
    : [];
  const tipoTags = tagCategories['Tipo de imóvel'] || [];
  for (const tt of tipoTags) {
    for (const name of tt.names) {
      if (!propertyTypes.includes(name)) propertyTypes.push(name);
    }
  }

  // 3. Localizações / Bairros
  const locations = Array.isArray(rawSummary.location)
    ? (rawSummary.location as unknown[]).map((l) => String(l))
    : [];
  const bairroTags = tagCategories['Bairro'] || [];
  for (const bt of bairroTags) {
    for (const name of bt.names) {
      if (!locations.includes(name)) locations.push(name);
    }
  }

  // 4. Preço (suporta number, string numérica ou faixas como "Até 3000", "3.500-4.000", "300k-400k", "700k-1M")
  const parsePriceRangeTag = (rawText: string): { min: number | null; max: number | null } => {
    const norm = normalizeString(rawText);
    const parsedValues: number[] = [];
    const tokenRegex = /(\d+(?:\.\d{3})+|\d+(?:,\d+)?)\s*(m\b|milhao|milhoes|k\b|mil\b)?/gi;
    let m: RegExpExecArray | null;
    while ((m = tokenRegex.exec(norm)) !== null) {
      const rawNum = m[1].replace(/\./g, '').replace(',', '.');
      const unit = (m[2] || '').toLowerCase();
      let val = Number(rawNum);
      if (Number.isNaN(val) || val <= 0) continue;
      if (unit.startsWith('m') && unit !== 'mil') {
        val *= 1_000_000;
      } else if (unit === 'k' || unit === 'mil') {
        val *= 1_000;
      } else if (val < 1500) {
        val *= 1_000;
      }
      parsedValues.push(Math.round(val));
    }
    if (parsedValues.length === 0) return { min: null, max: null };
    if (norm.includes('acima de')) {
      return { min: parsedValues[0], max: null };
    }
    if (parsedValues.length === 1) {
      return { min: null, max: parsedValues[0] };
    }
    return { min: parsedValues[0], max: parsedValues[parsedValues.length - 1] };
  };

  const parsePriceValue = (val: unknown): number | null => {
    if (typeof val === 'number' && !Number.isNaN(val) && val > 0) {
      return val < 1500 ? val * 1000 : val;
    }
    if (typeof val === 'string' && val.trim() !== '') {
      const rangeParsed = parsePriceRangeTag(val);
      if (rangeParsed.max !== null) return rangeParsed.max;
      if (rangeParsed.min !== null) return rangeParsed.min;
      const cleaned = val.replace(/[R$\s.]/g, '').replace(',', '.');
      const num = Number(cleaned);
      if (!Number.isNaN(num) && num > 0) {
        return num < 1500 ? num * 1000 : num;
      }
    }
    return null;
  };

  let priceMin = parsePriceValue(rawSummary.price_min);
  let priceMax = parsePriceValue(rawSummary.price_max);
  const priceFlexMax = parsePriceValue(rawSummary.price_flex_max);

  // Extrai de tag 'Faixa de valor' se não estiver no summary
  const valorTags = tagCategories['Faixa de valor'] || [];
  let hasRentalValueTag = false;
  let hasPurchaseValueTag = false;
  for (const vt of valorTags) {
    for (const name of vt.names) {
      const parsed = parsePriceRangeTag(name);
      if (parsed.max !== null && parsed.max > 0 && parsed.max <= 15000) {
        hasRentalValueTag = true;
      }
      if ((parsed.max !== null && parsed.max >= 50000) || (parsed.min !== null && parsed.min >= 50000)) {
        hasPurchaseValueTag = true;
      }
      if (priceMax === null && parsed.max !== null) {
        priceMax = parsed.max;
      }
      if (priceMin === null && parsed.min !== null) {
        priceMin = parsed.min;
      }
    }
  }

  // 5. Quartos (suporta number ou string como "2" / "2 quartos")
  const bedrooms: number[] = [];
  if (Array.isArray(rawSummary.bedrooms)) {
    for (const item of rawSummary.bedrooms) {
      if (typeof item === 'number' && !Number.isNaN(item)) {
        if (!bedrooms.includes(item)) bedrooms.push(item);
      } else if (typeof item === 'string') {
        const m = item.match(/\d+/);
        if (m) {
          const v = parseInt(m[0], 10);
          if (!bedrooms.includes(v)) bedrooms.push(v);
        }
      }
    }
  }
  const quartosTags = tagCategories['Quartos'] || [];
  for (const qt of quartosTags) {
    for (const name of qt.names) {
      const matchNum = name.match(/\d+/);
      if (matchNum) {
        const val = parseInt(matchNum[0], 10);
        if (!bedrooms.includes(val)) bedrooms.push(val);
      }
    }
  }

  // 6. Pronto / Planta / Em construção
  const deliveryStatus: DeliveryStatus[] = [];
  const statusTags = tagCategories['Status'] || [];
  const allStatusTexts = [
    ...statusTags.flatMap((s) => s.names),
    notesText,
    ...(Array.isArray(rawSummary.features) ? (rawSummary.features as string[]) : []),
  ].map((t) => t.toLowerCase());

  if (allStatusTexts.some((t) => t.includes('pronto'))) deliveryStatus.push('pronto');
  if (allStatusTexts.some((t) => t.includes('planta') || t.includes('lancamento') || t.includes('lançamento'))) {
    deliveryStatus.push('planta');
  }
  if (allStatusTexts.some((t) => t.includes('constru') || t.includes('obra'))) {
    deliveryStatus.push('em_construcao');
  }

  // 7. Classificação estrita de Modalidade Comercial (compra/venda vs locação vs indefinido)
  // Regra de negócio WACRM: O catálogo do Match é exclusivo de VENDA.
  // - Clientes de locação são inelegíveis (critério eliminatório).
  // - Clientes sem intenção comercial definida ('indefinido') não são tratados automaticamente como compradores.
  // - 'Moradia' isolada define uso habitacional (pode ser compra ou aluguel) e é confrontada com todos os sinais de locação.
  // - Mudança recente para locação prevalece sobre intenção antiga de compra.
  const rawOperationField =
    typeof rawSummary.operation === 'string'
      ? normalizeString(rawSummary.operation)
      : typeof rawSummary.modalidade === 'string'
        ? normalizeString(rawSummary.modalidade)
        : '';

  const summaryPurposes = rawPurpose.map(normalizeString);
  const tagPurposes = finalidadeTags.flatMap((ft) => ft.names).map(normalizeString);
  const allPurposes = purposeList.map(normalizeString);

  const notesNorm = normalizeString(
    [notesText, stageSignalText, intentText, profileArrText].filter(Boolean).join(' ')
  );
  const ctwaNorm = normalizeString(
    [
      typeof ctwaReferral?.headline === 'string' ? ctwaReferral.headline : '',
      typeof ctwaReferral?.body === 'string' ? ctwaReferral.body : '',
    ]
      .filter(Boolean)
      .join(' ')
  );

  const hasRentalBudget =
    (priceMax !== null && priceMax > 0 && priceMax <= 15000) || hasRentalValueTag;
  const hasPurchaseBudget =
    (priceMax !== null && priceMax >= 50000) ||
    (priceMin !== null && priceMin >= 50000) ||
    hasPurchaseValueTag;

  const summaryHasInvestment = summaryPurposes.some((p) => p.includes('invest'));
  const summaryHasExplicitPurchase = summaryPurposes.some(
    (p) => p.includes('compra') || p.includes('venda') || p.includes('aquisicao')
  );
  const summaryHasRental = summaryPurposes.some(
    (p) =>
      (p.includes('locacao') || p.includes('aluguel') || p.includes('alugar') || p.includes('temporada')) &&
      !p.includes('invest')
  );

  const tagsHaveInvestment = tagPurposes.some((p) => p.includes('invest'));
  const tagsHaveExplicitPurchase = tagPurposes.some(
    (p) => p.includes('compra') || p.includes('venda') || p.includes('aquisicao')
  );
  const tagsHaveRental = tagPurposes.some(
    (p) =>
      (p.includes('locacao') || p.includes('aluguel') || p.includes('alugar') || p.includes('temporada')) &&
      !p.includes('invest')
  );

  const hasInvestmentPurpose = summaryHasInvestment || tagsHaveInvestment;
  // Se o summary consolidado atual tem apenas locação (e não tem compra/investimento),
  // uma tag legada de 'Compra' não prevalece sobre o estado atual da conversa.
  const latestSummaryOverridesStalePurchaseTag =
    summaryHasRental && !summaryHasInvestment && !summaryHasExplicitPurchase;
  const hasExplicitPurchasePurpose =
    summaryHasExplicitPurchase || (tagsHaveExplicitPurchase && !latestSummaryOverridesStalePurchaseTag);
  const hasRentalPurpose = summaryHasRental || tagsHaveRental;

  // Menções a locação em contexto de compra para investimento (rentabilidade Airbnb/Stay) ou "sair do aluguel"
  const isInvestmentOrExitRentMention =
    /\b(sair\s+do\s+aluguel|retorno\s+com\s+locacao|renda\s+por\s+locacao|renda\s+com\s+locacao|investir\s+com\s+locacao|investir\s+em\s+aluguel|investimento\/locacao|deixar\s+em\s+locacao|colocar\s+para\s+alugar|rentabilidade|gestao\s+via\s+stay|locacao\s+por\s+temporada\s+[^.;]*nao\s+foi\s+confirmad)\b/.test(
      notesNorm
    ) ||
    (hasInvestmentPurpose &&
      !hasRentalBudget &&
      /\b(locacao\s+por\s+temporada|aluguel\s+por\s+temporada|investidor)\b/.test(notesNorm));

  // Sinais explícitos de transição recente para locação ou busca exclusiva de aluguel nas notas da conversa
  const notesIndicateRentalPivot =
    !isInvestmentOrExitRentMention &&
    /\b(depois\s+perguntou\s+por\s+[^.;]*(aluguel|locacao)|passou\s+a\s+buscar\s+[^.;]*(aluguel|locacao)|agora\s+busca\s+[^.;]*(aluguel|locacao)|ultima\s+pergunta\s+foi\s+sobre\s+locacao|mudou\s+para\s+(aluguel|locacao)|so\s+tem\s+interesse\s+em\s+(aluguel|locacao)|apenas\s+para\s+(aluguel|locacao)|somente\s+(aluguel|locacao)|so\s+para\s+locacao|locacao\s+anual|contrato\s+anual|12\s+meses|processo\s+de\s+aluguel|forma\s+da\s+locacao|condicoes\s+para\s+locacao|ninguem\s+alugue\s+antes|orcamento\s+considerado:\s*aluguel|busca\s+locacao|procura\s+aluguel|quer\s+alugar|locatario\s+interessado)\b/.test(
      notesNorm
    );

  const notesMentionRental =
    !isInvestmentOrExitRentMention &&
    (notesIndicateRentalPivot ||
      /\b(locacao|aluguel|alugar|locatario)\b|\/\s*mes\b|\bpor\s+mes\b|\bmensal\b/.test(notesNorm));

  const notesConfirmPurchase =
    !notesIndicateRentalPivot &&
    (/\b(compra|comprar|comprador|aquisicao|investimento|investir|investidor|financiamento|financiar|fgts|condicoes\s+de\s+pagamento|entrada\s+e\s+parcelas|sair\s+do\s+aluguel|pre-lancamento|na\s+planta|em\s+construcao|repasse|avant\s+home|live\s+park|vela\s+e\s+mar|mahal|toscano\s+flat)\b/.test(
      notesNorm
    ) ||
      /\b[1-9]\d{2}\s*(mil|\.000)\b/.test(notesNorm) ||
      isInvestmentOrExitRentMention);

  const ctwaHasSaleMarkers =
    /\b(pre-lancamento|lancamento|em\s+construcao|na\s+planta|venda|compra|financiamento|investir\s+em\s+aluguel|investir\s+com\s+locacao)\b/.test(
      ctwaNorm
    ) || /\b[1-9]\d{2}\s*(mil|\.000)\b/.test(ctwaNorm);

  const ctwaIsRental =
    /\/\s*mes\b|\bpor\s+mes\b|\bmensal\b|\blocacao\s+anual\b|\bso\s+locacao\b|\bsomente\s+locacao\b/.test(
      ctwaNorm
    ) ||
    (!ctwaHasSaleMarkers && /\b(locacao|aluguel|alugar)\b/.test(ctwaNorm));

  const ctwaIsSale = !ctwaIsRental && ctwaHasSaleMarkers;

  const hasOffPlanDelivery =
    deliveryStatus.includes('planta') || deliveryStatus.includes('em_construcao');

  let isShortStayOnly = false;
  if (!hasInvestmentPurpose && !hasExplicitPurchasePurpose && !hasPurchaseBudget && !hasOffPlanDelivery) {
    const wantsShortStay =
      allPurposes.some((p) => p.includes('temporada')) ||
      (notesNorm.includes('temporada') && !isInvestmentOrExitRentMention);
    if (wantsShortStay) {
      isShortStayOnly = true;
    }
  }

  let operation: LeadCommercialOperation = 'indefinido';

  if (rawOperationField === 'locacao' || rawOperationField === 'aluguel') {
    operation = 'locacao';
  } else if (isShortStayOnly || hasRentalBudget || notesIndicateRentalPivot) {
    operation = 'locacao';
  } else if (hasRentalPurpose) {
    if (hasInvestmentPurpose) {
      // Investidor buscando imóvel para renda com locação por temporada
      operation = 'venda';
    } else if (hasExplicitPurchasePurpose) {
      // Interesse simultâneo em compra e locação: só é elegível quando há evidência confiável de interesse atual em compra
      if (
        hasPurchaseBudget ||
        hasOffPlanDelivery ||
        notesConfirmPurchase ||
        rawOperationField === 'venda' ||
        rawOperationField === 'compra'
      ) {
        operation = 'venda';
      } else if (notesMentionRental || ctwaIsRental) {
        operation = 'locacao';
      } else {
        operation = 'indefinido';
      }
    } else {
      operation = 'locacao';
    }
  } else if (
    (ctwaIsRental || notesMentionRental) &&
    !hasInvestmentPurpose &&
    !hasExplicitPurchasePurpose &&
    !hasPurchaseBudget &&
    !hasOffPlanDelivery &&
    !notesConfirmPurchase
  ) {
    operation = 'locacao';
  } else if (
    rawOperationField === 'venda' ||
    rawOperationField === 'compra' ||
    hasInvestmentPurpose ||
    hasExplicitPurchasePurpose ||
    hasPurchaseBudget ||
    hasOffPlanDelivery ||
    notesConfirmPurchase ||
    ctwaIsSale
  ) {
    operation = 'venda';
  } else if (
    allPurposes.some((p) => p.includes('moradia')) &&
    !ctwaIsRental &&
    !notesMentionRental &&
    !hasRentalPurpose &&
    !hasRentalBudget
  ) {
    operation = 'venda';
  } else {
    operation = 'indefinido';
  }

  // 8. Requisitos obrigatórios vs Preferências, Metragem, Plantas Maiores e Restrições Explícitas
  const reqObj = (rawSummary.requirements as Record<string, unknown>) || {};
  let propertyTypeStrict = reqObj.property_type_strict === true;
  let locationStrict = reqObj.location_strict === true;
  let priceStrictMax = reqObj.price_strict_max === true;
  let bedroomsStrict = reqObj.bedrooms_strict === true;
  const deliveryStrict = reqObj.delivery_strict === true;

  const requiredFeatures = Array.isArray(reqObj.required_features)
    ? (reqObj.required_features as string[])
    : [];

  const preferredFeatures = Array.isArray(rawSummary.features)
    ? (rawSummary.features as string[]).filter((f) => !requiredFeatures.includes(f))
    : [];

  const allContextNorm = normalizeString(
    [
      notesText,
      stageSignalText,
      intentText,
      profileArrText,
      ...requiredFeatures,
      ...preferredFeatures,
      JSON.stringify(reqObj),
    ]
      .filter(Boolean)
      .join(' ')
  );

  // 8.1 Detecção de proprietário vendedor (captação) ou busca redirecionada para outro estado (ES/RJ/etc.)
  const isPropertySeller =
    /\b(nao\s+e\s+comprador|proprietario\s+vendedor|venda\s+de\s+imovel\s+proprio|vender\s+o\s+(?:meu\s+|seu\s+)?(?:imovel|flat|apartamento|casa)|procura\s+a\s+imobiliaria\s+para\s+vender|captacao\/venda)\b/.test(
      allContextNorm
    ) ||
    allPurposes.some(
      (p) => p.includes('venda de imovel proprio') || p.includes('vender imovel')
    );

  const isRedirectedOutOfState =
    /\b(sem\s+aderencia\s+geografica|espirito\s+santo\s+e\s+rio\s+de\s+janeiro|redirecionou\s+a\s+busca\s+para\s+(?:es|rj|sp|mg)|precisa\s+ser\s+em\s+locais\s+mais\s+proximos\s+de\s+minas)\b/.test(
      allContextNorm
    );

  const isSellerOrOutOfArea = isPropertySeller || isRedirectedOutOfState;
  if (isSellerOrOutOfArea) {
    operation = 'indefinido';
  }

  // 8.2 Restrições explícitas de tipologia ("não quer flat nem estúdio", "sem studio", etc.)
  const excludedSet = new Set<string>();
  const negationRe =
    /(?:nao\s+(?:quer\w*|gost\w*|aceit\w*|tem\s+interesse\s+em|desej\w*|pode\s+ser)|sem|dispensa|rejeita|exceto|evita|menos|nem)\s+[^.;!\n]{0,60}/g;
  const typePatterns: Array<{ key: string; re: RegExp }> = [
    { key: 'flat', re: /\bflats?\b/ },
    { key: 'studio', re: /\b(?:studios?|estudios?)\b/ },
    { key: 'apartamento', re: /\b(?:apartamentos?|aptos?)\b/ },
    { key: 'casa', re: /\bcasas?\b/ },
    { key: 'cobertura', re: /\bcoberturas?\b/ },
    { key: 'terreno', re: /\b(?:terrenos?|lotes?)\b/ },
    { key: 'comercial', re: /\b(?:salas?\s+comerciais?|comercial)\b/ },
  ];
  let negMatch: RegExpExecArray | null;
  while ((negMatch = negationRe.exec(allContextNorm)) !== null) {
    const clause = negMatch[0];
    for (const tp of typePatterns) {
      if (tp.re.test(clause)) {
        excludedSet.add(tp.key);
      }
    }
  }
  const excludedPropertyTypes = Array.from(excludedSet);

  // Remove tipologias explicitamente rejeitadas da lista de tipologias aceitas
  if (excludedPropertyTypes.length > 0) {
    for (let i = propertyTypes.length - 1; i >= 0; i--) {
      const normT = normalizeString(propertyTypes[i]);
      if (
        excludedPropertyTypes.some(
          (ex) =>
            normT.includes(ex) ||
            (ex === 'studio' && (normT.includes('studio') || normT.includes('estudio')))
        )
      ) {
        propertyTypes.splice(i, 1);
      }
    }
  }

  // 8.3 Extração de metragem e preferência por plantas maiores ("plantas maiores", "50 ou 75 m²", "80m² +/-")
  let areaMin: number | null =
    typeof rawSummary.area_min === 'number' && rawSummary.area_min > 0
      ? rawSummary.area_min
      : typeof reqObj.area_min === 'number' && (reqObj.area_min as number) > 0
        ? (reqObj.area_min as number)
        : null;
  let areaMax: number | null =
    typeof rawSummary.area_max === 'number' && rawSummary.area_max > 0
      ? rawSummary.area_max
      : null;
  let areaStrict = reqObj.area_strict === true;

  const mentionsLargerPlans =
    /\b(plantas?\s+maiores|mais\s+espaco|maior\s+metragem|unir\s+unidades|uniao\s+de\s+(?:unidades|flats)|apartamento\s+maior|imovel\s+maior|acha\s+(?:pequeno|compacto)|muito\s+pequeno)\b/.test(
      allContextNorm
    );

  // Extrai metragens explícitas associadas a "a partir de X m²", "no mínimo X m²", "plantas de X e Y m²", "Xm² +/-"
  const strictAreaMatch = allContextNorm.match(
    /\b(?:a\s+partir\s+de|no\s+minimo|minimo\s+de|acima\s+de|pelo\s+menos)\s+(\d{2,3})\s*m(?:2|²|\b)/
  );
  if (strictAreaMatch) {
    const parsed = parseInt(strictAreaMatch[1], 10);
    if (parsed >= 30 && parsed <= 500) {
      areaMin = areaMin !== null ? Math.max(areaMin, parsed) : parsed;
      areaStrict = true;
    }
  }

  const rangeAreaMatch = allContextNorm.match(
    /\b(?:plantas?\s+(?:maiores\s*)?(?:de|\()?\s*|formar\s+plantas?\s+de\s+|entre\s+)(\d{2,3})\s*(?:ou|e|a)\s*(\d{2,3})\s*m(?:2|²|\b)/
  );
  if (rangeAreaMatch) {
    const a1 = parseInt(rangeAreaMatch[1], 10);
    const a2 = parseInt(rangeAreaMatch[2], 10);
    const low = Math.min(a1, a2);
    const high = Math.max(a1, a2);
    if (low >= 35 && low <= 500) {
      areaMin = areaMin ?? low;
      areaMax = areaMax ?? high;
    }
  }

  const approxAreaMatch = allContextNorm.match(/\b(\d{2,3})\s*m(?:2|²)\s*(?:\+\/-|aprox|em\s+media)?/);
  if (areaMin === null && approxAreaMatch) {
    const val = parseInt(approxAreaMatch[1], 10);
    // Só define areaMin se for uma metragem de busca de espaço (>= 45m²), não a descrição de um flat de 22/25m²
    if (val >= 45 && val <= 400) {
      areaMin = Math.round(val * 0.85);
    }
  }

  const prefersLargerPlans =
    mentionsLargerPlans || (areaMin !== null && areaMin >= 45);

  if (prefersLargerPlans && areaMin === null) {
    areaMin = 48; // Referência comercial para superar studios/flats compactos de 18–35 m²
  }

  // 8.4 Prevalência da conversa sobre o anúncio de origem (Seção 3):
  // Se o cliente entrou por um anúncio de studio/flat, mas na conversa declarou que procura 2+ quartos ou plantas maiores (>= 45 m²),
  // o perfil deve atualizar a quantidade de quartos e buscar 'Apartamento', sem ficar preso ao studio/flat do anúncio!
  const explicitMultiBedRe =
    /(?:busca|procura|quer|precisa\s+de|prefere|interesse\s+em|apartamento\s+de|apto\s+de|imovel\s+de)\s+(?:um\s+)?(?:apartamento\s+de\s+|apto\s+de\s+)?([2-5])\s*(?:ou\s*([2-5])\s*)?(?:quartos|qts|dormitorios)/g;
  const fromConversationBedrooms: number[] = [];
  let bedMatch: RegExpExecArray | null;
  while ((bedMatch = explicitMultiBedRe.exec(allContextNorm)) !== null) {
    const b1 = parseInt(bedMatch[1], 10);
    if (b1 >= 2 && !fromConversationBedrooms.includes(b1)) fromConversationBedrooms.push(b1);
    if (bedMatch[2]) {
      const b2 = parseInt(bedMatch[2], 10);
      if (b2 >= 2 && !fromConversationBedrooms.includes(b2)) fromConversationBedrooms.push(b2);
    }
  }
  if (fromConversationBedrooms.length > 0 && !bedrooms.some((b) => b >= 2)) {
    bedrooms.splice(0, bedrooms.length, ...fromConversationBedrooms);
  }

  const wantsMultiBedroom = bedrooms.some((b) => b >= 2);
  if (wantsMultiBedroom || prefersLargerPlans) {
    for (let i = propertyTypes.length - 1; i >= 0; i--) {
      const normT = normalizeString(propertyTypes[i]);
      if (normT.includes('studio') || normT.includes('estudio') || normT.includes('flat')) {
        propertyTypes.splice(i, 1);
      }
    }
    if (!propertyTypes.some((t) => normalizeString(t).includes('apartamento'))) {
      propertyTypes.unshift('Apartamento');
    }
    if (wantsMultiBedroom) {
      bedroomsStrict = true;
    }
  }

  if (excludedPropertyTypes.length > 0 && propertyTypes.length > 0) {
    propertyTypeStrict = true;
  }

  // Detecção textual de limite financeiro inegociável vs. orçamento flexível vindo de anúncio barato (Seção 5)
  const hasExplicitStrictBudgetText =
    /\b(?:limite\s+(?:maximo|absoluto|financeiro)|teto\s+(?:maximo|de)|nao\s+posso\s+passar\s+de|orcamento\s+maximo|no\s+maximo\s+r\$|abaixo\s+de\s+r\$\s*\d|ate\s+r\$\s*\d+\s*mil\s+no\s+maximo)\b/.test(
      allContextNorm
    );
  if (hasExplicitStrictBudgetText) {
    priceStrictMax = true;
  }

  let budgetIsFlexibleFromAd = false;
  let effectivePriceFlexMax = priceFlexMax;
  if (
    !priceStrictMax &&
    priceMax !== null &&
    priceMax > 0 &&
    priceMax <= 360000 &&
    (wantsMultiBedroom || prefersLargerPlans)
  ) {
    // O valor inicial (ex.: R$ 270k–350k) veio do anúncio de studio, mas o cliente busca apartamento maior (2+ quartos / 50+ m²)
    budgetIsFlexibleFromAd = true;
    effectivePriceFlexMax = Math.max(effectivePriceFlexMax ?? 0, priceMax * 1.9, 650000);
  }

  if (
    /\b(?:somente\s+no\s+bairro|apenas\s+no\s+|so\s+no\s+bessa|so\s+em\s+manaira|so\s+em\s+cabo\s+branco|nao\s+abre\s+mao\s+do\s+bairro)\b/.test(
      allContextNorm
    )
  ) {
    locationStrict = true;
  }

  // Especificidade de localização
  let locationSpecificity: 'city' | 'region' | 'neighborhood' = 'neighborhood';
  if (locations.length === 1 && normalizeString(locations[0]).includes('joao pessoa')) {
    locationSpecificity = 'city';
  } else if (locations.some((l) => l.toLowerCase().includes('praia') || l.toLowerCase().includes('sul'))) {
    locationSpecificity = 'region';
  }

  const hasCtwa = !!ctwaReferral;

  return {
    accountId,
    leadId: contact.id,
    name: contact.name || 'Lead',
    phone: contact.phone,
    aiScore: contact.ai_score ?? 0,
    isPaused: contact.paused_at !== null,
    isArchived: contact.archived_at !== null,
    operation,
    purpose: purposeList,
    propertyTypes,
    propertyTypeStrict,
    locations,
    locationStrict,
    locationSpecificity,
    priceMin,
    priceMax,
    priceStrictMax,
    priceFlexMax: effectivePriceFlexMax,
    bedrooms,
    bedroomsStrict,
    deliveryStatus,
    deliveryStrict,
    requiredFeatures,
    preferredFeatures,
    isShortStayOnly,
    areaMin,
    areaMax,
    areaStrict,
    prefersLargerPlans,
    excludedPropertyTypes,
    budgetIsFlexibleFromAd,
    isSellerOrOutOfArea,
    provenance: {
      operation: resolveProvenance('Finalidade', hasCtwa),
      purpose: resolveProvenance('Finalidade', hasCtwa),
      propertyTypes: wantsMultiBedroom || prefersLargerPlans ? 'conversation' : resolveProvenance('Tipo de imóvel', hasCtwa),
      locations: resolveProvenance('Bairro', hasCtwa),
      price: resolveProvenance('Faixa de valor', hasCtwa),
      bedrooms: resolveProvenance('Quartos', hasCtwa),
      delivery: resolveProvenance('Status', hasCtwa),
      features: resolveProvenance('Momento', hasCtwa),
    },
  };
}

function normalizeString(val: string): string {
  return val
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
