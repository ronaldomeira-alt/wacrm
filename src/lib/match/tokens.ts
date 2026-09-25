import crypto from 'crypto';

/**
 * Gera um token opaco, criptograficamente seguro e sem qualquer PII.
 * 32 bytes de entropia aleatória -> 64 caracteres hexadecimais.
 */
export function generateTrackingToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Monta o link individual de visualização pública para o envio pelo WhatsApp.
 * Exemplo: https://ronaldomeira.com.br/imoveis/p/<token>
 */
export function buildSharePublicUrl(token: string, baseUrl?: string): string {
  const host = baseUrl || process.env.NEXT_PUBLIC_PUBLIC_APP_URL || 'https://ronaldomeira.com.br';
  const cleanHost = host.replace(/\/+$/, '');
  return `${cleanHost}/imoveis/p/${token}`;
}
