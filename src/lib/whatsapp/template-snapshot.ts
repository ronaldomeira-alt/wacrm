import type {
  MessageTemplate,
  TemplateButton,
  TemplateSnapshot,
  TemplateSnapshotButton,
  TemplateSnapshotProperty,
} from '@/types';
import type { SendTimeParams } from './template-send-builder';
import { renderApprovedTemplatePreview } from './session-window';

/**
 * Normalizes `templateMessageParams` + legacy `templateParams` into a typed
 * `SendTimeParams` object.
 */
export function normalizeTemplateSendParams(
  templateMessageParams?: unknown,
  legacyBodyParams?: string[],
): SendTimeParams {
  const raw =
    templateMessageParams && typeof templateMessageParams === 'object'
      ? (templateMessageParams as Record<string, unknown>)
      : {};

  const body = Array.isArray(raw.body)
    ? raw.body.map((v) => String(v ?? ''))
    : Array.isArray(legacyBodyParams)
      ? legacyBodyParams.map((v) => String(v ?? ''))
      : [];

  const headerText =
    typeof raw.headerText === 'string' ? raw.headerText : undefined;
  const headerMediaUrl =
    typeof raw.headerMediaUrl === 'string' ? raw.headerMediaUrl : undefined;
  const headerMediaId =
    typeof raw.headerMediaId === 'string' ? raw.headerMediaId : undefined;

  let buttonParams: Record<number, string> | undefined;
  if (raw.buttonParams && typeof raw.buttonParams === 'object') {
    buttonParams = {};
    for (const [k, v] of Object.entries(
      raw.buttonParams as Record<string, unknown>,
    )) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 0 && typeof v === 'string') {
        buttonParams[idx] = v;
      }
    }
  }

  return {
    body,
    headerText,
    headerMediaUrl,
    headerMediaId,
    buttonParams,
  };
}

/**
 * Substitutes `{{1}}..{{N}}` in a template button URL with the send-time
 * suffix (or falls back to the button's `example` when no override is given).
 */
export function resolveTemplateButtonUrl(
  buttonUrl: string,
  override?: string,
  example?: string,
): string {
  const value = (override ?? example ?? '').trim();
  if (!buttonUrl.includes('{{')) return buttonUrl;
  if (!value) return buttonUrl;
  return buttonUrl.replace(/\{\{\d+\}\}/g, value);
}

function buildSnapshotButtons(
  buttons: TemplateButton[] | undefined,
  params: SendTimeParams,
): TemplateSnapshotButton[] {
  if (!Array.isArray(buttons) || buttons.length === 0) return [];

  return buttons.map((btn, index) => {
    const override = params.buttonParams?.[index];
    if (btn.type === 'URL') {
      return {
        type: 'URL',
        text: btn.text,
        url: resolveTemplateButtonUrl(btn.url, override, btn.example),
      };
    }
    if (btn.type === 'PHONE_NUMBER') {
      return {
        type: 'PHONE_NUMBER',
        text: btn.text,
        phone_number: btn.phone_number,
      };
    }
    if (btn.type === 'COPY_CODE') {
      return {
        type: 'COPY_CODE',
        text: btn.text,
        code: (override ?? btn.example ?? '').trim() || undefined,
      };
    }
    return {
      type: 'QUICK_REPLY',
      text: btn.text,
    };
  });
}

/**
 * Builds an immutable historical snapshot of a sent WhatsApp template message
 * so future edits to `message_templates` or `properties` never mutate past
 * inbox history.
 */
export function buildTemplateSnapshot(args: {
  template: MessageTemplate;
  params?: SendTimeParams;
  renderedBodyOverride?: string | null;
  property?: TemplateSnapshotProperty | null;
  renderedAt?: string;
}): TemplateSnapshot {
  const { template, params = {}, renderedBodyOverride, property, renderedAt } = args;
  const bodyVars = params.body ?? [];
  const renderedBody =
    (renderedBodyOverride && renderedBodyOverride.trim()) ||
    renderApprovedTemplatePreview(template.body_text || '', bodyVars);

  let headerText: string | null = null;
  if (template.header_type === 'text' && template.header_content) {
    headerText = params.headerText?.trim()
      ? renderApprovedTemplatePreview(template.header_content, [params.headerText])
      : template.header_content;
  }

  const headerMediaUrl =
    template.header_type && template.header_type !== 'text'
      ? params.headerMediaUrl || template.header_media_url || null
      : null;

  return {
    template_id: template.id || null,
    meta_template_id: template.meta_template_id || null,
    template_name: template.name,
    language: template.language || 'pt_BR',
    category: template.category || null,
    header_type: template.header_type || null,
    header_text: headerText,
    header_media_url: headerMediaUrl,
    body_text: renderedBody,
    footer_text: template.footer_text || null,
    buttons: buildSnapshotButtons(template.buttons, params),
    ...(property ? { property } : {}),
    rendered_at: renderedAt || new Date().toISOString(),
  };
}
