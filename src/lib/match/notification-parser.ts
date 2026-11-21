/**
 * Parser client-safe para notificações internas (Match + Inbox).
 * Não importa módulos de servidor (`web-push`, Supabase admin, etc.), podendo ser
 * usado livremente em Client Components do Next.js.
 */
export function parseNotificationTarget(notification: {
  type?: string | null;
  title?: string | null;
  body?: string | null;
  conversation_id?: string | null;
  contact_id?: string | null;
  metadata?: Record<string, unknown> | null;
}): { cleanBody: string; targetUrl: string; isMatchNotification: boolean } {
  const rawBody = notification.body || '';
  const urlMatch = rawBody.match(/\[url:([^\]]+)\]/);
  const cleanBody = rawBody.replace(/\s*\[url:[^\]]+\]\s*/g, '').trim();

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
