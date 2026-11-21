import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPushToAccount } from '../push/send';

export interface MatchNotificationCandidate {
  matchId?: string;
  leadId: string;
  leadName: string;
  propertyId: string;
  propertyTitle: string;
  propertyType: string;
  neighborhood: string;
  matchScore: number;
  profileMaturity: number;
  aiScore: number;
  isReopened?: boolean;
  reopenReason?: string | null;
}

/**
 * Critério de relevância comercial para disparo de notificação de Match.
 * Distingue claramente:
 * - matchScore (0–100%): compatibilidade determinística imóvel ↔ perfil
 * - profileMaturity (0–100%): completude das preferências extraídas
 * - aiScore (0–10): qualificação/temperatura comercial do lead
 */
export function isMatchNotificationRelevant(args: {
  matchScore: number;
  profileMaturity: number;
  aiScore: number;
  isCtwaOrigin?: boolean;
  existingScore?: number | null;
  isReopened?: boolean;
}): boolean {
  if (args.isCtwaOrigin) return false;

  // Se já existia com score relevante (>= 80%) e não é uma reabertura por mudança material,
  // um recálculo repetido NUNCA deve disparar nova notificação.
  if (
    !args.isReopened &&
    typeof args.existingScore === 'number' &&
    args.existingScore >= 80
  ) {
    return false;
  }

  const score = Math.round(args.matchScore);
  const maturity = Math.round(args.profileMaturity);
  const aiScore = Number(args.aiScore || 0);

  // Caso 1: Match Forte (>= 85%) com perfil maduro (>= 65%)
  if (score >= 85 && maturity >= 65) {
    return true;
  }

  // Caso 2: Compatibilidade alta (>= 80%) para lead com alta qualificação comercial (aiScore >= 7 e maturidade >= 55%)
  if (score >= 80 && aiScore >= 7 && maturity >= 55) {
    return true;
  }

  return false;
}

/**
 * Formata a mensagem canônica de notificação de Match:
 * Ex.: "Novo Match: apartamento no Bessa compatível com cliente Maria — 96% de compatibilidade."
 */
export function formatMatchNotificationText(
  candidate: MatchNotificationCandidate,
  extraCount = 0
): { title: string; body: string; url: string; tag: string } {
  const score = Math.round(candidate.matchScore);
  const propType = (candidate.propertyType || 'imóvel').toLowerCase().trim();
  const neighborhood = (candidate.neighborhood || 'João Pessoa').trim();
  const leadName = (candidate.leadName || 'Cliente').trim();

  const prefix = candidate.isReopened ? 'Match Reaberto' : 'Novo Match';
  let body = `${prefix}: ${propType} no ${neighborhood} compatível com cliente ${leadName} — ${score}% de compatibilidade.`;

  if (candidate.isReopened && candidate.reopenReason) {
    body = `${prefix}: ${propType} no ${neighborhood} compatível com cliente ${leadName} — ${score}% de compatibilidade (${candidate.reopenReason}).`;
  } else if (extraCount > 0) {
    body = `${prefix}: ${propType} no ${neighborhood} compatível com cliente ${leadName} — ${score}% de compatibilidade (+${extraCount} ${extraCount === 1 ? 'outra opção compatível' : 'outras opções compatíveis'}).`;
  }

  const params = new URLSearchParams();
  params.set('lead', candidate.leadId);
  params.set('property', candidate.propertyId);
  if (candidate.matchId) {
    params.set('match', candidate.matchId);
  }
  const url = `/match?${params.toString()}`;
  const tag = `match-opp-${candidate.leadId}-${candidate.propertyId}`;
  const title = candidate.isReopened
    ? `Match Reaberto: ${leadName} (${score}%)`
    : `Novo Match: ${leadName} (${score}%)`;

  return { title, body, url, tag };
}

/**
 * Extrai URL de destino e texto limpo de uma linha da tabela `notifications`.
 */
export function parseNotificationTarget(notification: {
  type?: string;
  title?: string | null;
  body?: string | null;
  conversation_id?: string | null;
  contact_id?: string | null;
  metadata?: Record<string, unknown> | null;
}): { cleanBody: string; targetUrl: string; isMatchNotification: boolean } {
  const rawBody = notification.body || '';
  const urlMatch = rawBody.match(/\s*\[url:(\/[^\]]+)\]\s*$/);
  const cleanBody = urlMatch ? rawBody.replace(urlMatch[0], '').trim() : rawBody;

  const metaUrl =
    notification.metadata && typeof notification.metadata.url === 'string'
      ? notification.metadata.url
      : null;

  const isMatchType =
    notification.type === 'match_created' ||
    notification.type === 'match_reopened' ||
    notification.type === 'match_interest' ||
    Boolean(urlMatch) ||
    Boolean(notification.title?.startsWith('Novo Match')) ||
    Boolean(notification.title?.startsWith('Match Reaberto')) ||
    Boolean(notification.title?.startsWith('Interesse em Imóvel'));

  if (metaUrl) {
    return { cleanBody, targetUrl: metaUrl, isMatchNotification: isMatchType };
  }
  if (urlMatch?.[1]) {
    return { cleanBody, targetUrl: urlMatch[1], isMatchNotification: true };
  }
  if (isMatchType && notification.contact_id) {
    return {
      cleanBody,
      targetUrl: `/match?lead=${notification.contact_id}`,
      isMatchNotification: true,
    };
  }
  if (notification.conversation_id) {
    return {
      cleanBody,
      targetUrl: `/inbox?c=${notification.conversation_id}`,
      isMatchNotification: false,
    };
  }
  return { cleanBody, targetUrl: '/match', isMatchNotification: isMatchType };
}

/**
 * Persiste notificações internas no WACRM (tabela `notifications`) para os membros
 * autorizados da conta (`owner`, `admin`, `agent`) e dispara Web Push para os dispositivos inscritos.
 *
 * Totalmente resiliente e idempotente:
 * - Nunca bloqueia o fluxo de cálculo em caso de erro.
 * - Deduplica notificações recentes para o mesmo par (lead, imóvel).
 * - Funciona com a migration 088 aplicada (`type = 'match_created'`) e possui fallback
 *   automático caso a constraint antiga de `notifications` ainda esteja ativa.
 */
export async function dispatchMatchNotifications(
  db: SupabaseClient,
  accountId: string,
  candidates: MatchNotificationCandidate[],
  options?: { suppressNotifications?: boolean }
): Promise<{ internalCreated: number; pushSent: number }> {
  if (options?.suppressNotifications || !candidates || candidates.length === 0) {
    return { internalCreated: 0, pushSent: 0 };
  }

  // Ordena candidatos pelo maior matchScore para destacar a melhor oportunidade
  const sorted = [...candidates].sort((a, b) => b.matchScore - a.matchScore);
  const primary = sorted[0];
  const extraCount = sorted.length - 1;
  const formatted = formatMatchNotificationText(primary, extraCount);

  let internalCreated = 0;

  try {
    // 1. Busca membros da conta com permissão operacional (owner, admin, agent)
    const profilesQuery = db.from('profiles');
    if (typeof profilesQuery?.select === 'function') {
      const { data: members } = await profilesQuery
        .select('id, user_id, account_role')
        .eq('account_id', accountId);

      const eligibleUserIds = Array.from(
        new Set(
          (members || [])
            .filter(
              (m: { account_role?: string | null; user_id?: string | null; id?: string | null }) =>
                !m.account_role || ['owner', 'admin', 'agent'].includes(m.account_role)
            )
            .map((m: { user_id?: string | null; id?: string | null }) => m.user_id || m.id)
            .filter(Boolean) as string[]
        )
      );

      if (eligibleUserIds.length > 0) {
        const notifTable = db.from('notifications');
        if (typeof notifTable?.insert === 'function') {
          // Verifica se já existe notificação não lida idêntica para evitar duplicação
          const alreadyNotifiedUsers = new Set<string>();
          if (typeof notifTable.select === 'function') {
            try {
              const { data: recentNotifs } = await notifTable
                .select('user_id, title, body')
                .eq('account_id', accountId)
                .eq('contact_id', primary.leadId)
                .is('read_at', null);

              for (const rn of (recentNotifs || []) as Array<{ user_id: string; body?: string | null }>) {
                if (rn.body && rn.body.includes(primary.propertyId)) {
                  alreadyNotifiedUsers.add(rn.user_id);
                }
              }
            } catch {
              // Ignora se mock de teste não implementar select completo em notifications
            }
          }

          const targetUserIds = eligibleUserIds.filter((uid) => !alreadyNotifiedUsers.has(uid));

          if (targetUserIds.length > 0) {
            const bodyWithEmbeddedUrl = `${formatted.body} [url:${formatted.url}]`;
            const notifType = primary.isReopened ? 'match_reopened' : 'match_created';

            const modernRows = targetUserIds.map((userId) => ({
              account_id: accountId,
              user_id: userId,
              type: notifType,
              contact_id: primary.leadId,
              title: formatted.title,
              body: bodyWithEmbeddedUrl,
            }));

            const { error: modernErr } = await notifTable.insert(modernRows);
            if (!modernErr) {
              internalCreated = modernRows.length;
            } else {
              // Fallback compatível com constraint legada `type = 'conversation_assigned'`
              const fallbackRows = targetUserIds.map((userId) => ({
                account_id: accountId,
                user_id: userId,
                type: 'conversation_assigned',
                contact_id: primary.leadId,
                title: formatted.title,
                body: bodyWithEmbeddedUrl,
              }));
              const { error: fbErr } = await notifTable.insert(fallbackRows);
              if (!fbErr) {
                internalCreated = fallbackRows.length;
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[match-notifications] Falha ao gravar notificação interna:', err);
  }

  // 2. Dispara Web Push para os aparelhos inscritos na conta
  let pushSent = 0;
  try {
    const pushRes = await sendPushToAccount(accountId, {
      title: formatted.title,
      body: formatted.body,
      url: formatted.url,
      tag: formatted.tag,
    });
    pushSent = pushRes?.sent || 0;
  } catch (err) {
    console.warn('[match-notifications] Falha ao enviar Web Push de Match:', err);
  }

  return { internalCreated, pushSent };
}
