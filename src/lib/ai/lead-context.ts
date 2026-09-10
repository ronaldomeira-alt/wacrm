import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadSummary } from './lead-analysis-types';

export interface FormattedLeadContext {
  contactName: string;
  aiScore: number | null;
  aiScoreReason: string | null;
  summary: LeadSummary | null;
  tags: string[];
  /** Concise text representation ready for system prompt injection. */
  promptExcerpts: string;
}

/**
 * Fetch already extracted intelligence for a contact (from contacts, lead_intelligence,
 * and contact_tags) without running a second LLM call.
 */
export async function getLeadContext(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<FormattedLeadContext | null> {
  if (!contactId) return null;

  try {
    const [contactRes, intelligenceRes, tagsRes] = await Promise.all([
      db
        .from('contacts')
        .select('name, ai_score, ai_score_reason')
        .eq('id', contactId)
        .eq('account_id', accountId)
        .maybeSingle(),
      db
        .from('lead_intelligence')
        .select('summary')
        .eq('contact_id', contactId)
        .eq('account_id', accountId)
        .maybeSingle(),
      db
        .from('contact_tags')
        .select('tags(name, category)')
        .eq('contact_id', contactId),
    ]);

    const contact = contactRes.data;
    if (!contact && !intelligenceRes.data) return null;

    const contactName = contact?.name || 'Cliente';
    const aiScore = typeof contact?.ai_score === 'number' ? contact.ai_score : null;
    const aiScoreReason = contact?.ai_score_reason || null;

    const summary = (intelligenceRes.data?.summary as LeadSummary) || null;

    const tagList: string[] = [];
    if (tagsRes.data && Array.isArray(tagsRes.data)) {
      for (const row of tagsRes.data as any[]) {
        const tag = row.tags;
        if (tag?.name) {
          tagList.push(tag.category ? `${tag.category}:${tag.name}` : tag.name);
        }
      }
    }

    // Build concise prompt summary to prevent redundant questioning
    const knownFacts: string[] = [];

    if (summary) {
      if (summary.purpose && summary.purpose.length > 0) {
        knownFacts.push(`Finalidade declarada: ${summary.purpose.join(', ')}`);
      }
      if (summary.location && summary.location.length > 0) {
        knownFacts.push(`Bairros/Localizações de interesse: ${summary.location.join(', ')}`);
      }
      if (summary.property_type && summary.property_type.length > 0) {
        knownFacts.push(`Tipologia desejada: ${summary.property_type.join(', ')}`);
      }
      if (summary.price_max || summary.price_min) {
        const minStr = summary.price_min ? `R$ ${summary.price_min.toLocaleString('pt-BR')}` : '';
        const maxStr = summary.price_max ? `R$ ${summary.price_max.toLocaleString('pt-BR')}` : '';
        const budget = [minStr && `a partir de ${minStr}`, maxStr && `até ${maxStr}`]
          .filter(Boolean)
          .join(' ');
        knownFacts.push(`Faixa de orçamento informada: ${budget}`);
      }
      if (summary.bedrooms && summary.bedrooms.length > 0) {
        knownFacts.push(`Quartos desejados: ${summary.bedrooms.join(' ou ')} dormitórios`);
      }
      if (summary.features && summary.features.length > 0) {
        knownFacts.push(`Preferências / Itens valorizados: ${summary.features.join(', ')}`);
      }
      if (summary.profile && summary.profile.length > 0) {
        knownFacts.push(`Perfil do comprador: ${summary.profile.join(', ')}`);
      }
      if (summary.intent) {
        knownFacts.push(`Momento / Grau de intenção: ${summary.intent}`);
      }
      if (summary.notes) {
        knownFacts.push(`Notas contextuais: ${summary.notes}`);
      }
    }

    if (tagList.length > 0) {
      knownFacts.push(`Tags ativas: ${tagList.join(', ')}`);
    }

    if (aiScore !== null) {
      knownFacts.push(`Score de engajamento do lead: ${aiScore}/10${aiScoreReason ? ` (${aiScoreReason})` : ''}`);
    }

    const promptExcerpts = knownFacts.length > 0
      ? `INFORMAÇÕES JÁ EXTRAÍDAS E CONFIRMADAS SOBRE ESTE CLIENTE (${contactName}):\n- ` +
        knownFacts.join('\n- ') +
        '\n\nIMPORTANTE: O cliente JÁ informou os pontos acima. NÃO pergunte novamente o que já consta nesta lista (como orçamento, finalidade ou localização) a menos que o cliente mude de ideia ou o contexto exija esclarecimento natural.'
      : '';

    return {
      contactName,
      aiScore,
      aiScoreReason,
      summary,
      tags: tagList,
      promptExcerpts,
    };
  } catch (err) {
    console.error('[lead context] error loading lead context:', err);
    return null;
  }
}
