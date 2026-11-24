// One provider call, strict-JSON-in-prompt — same pattern as
// lead-analysis.ts's extractLeadIntelligence. Calls the existing
// provider adapters directly (providers/openai.ts / providers/anthropic.ts)
// unmodified; no new provider/integration.

import { executeAiInference } from './provider-manager';
import type { AiConfig, AiProvider, AiUsage } from './types';
import {
  buildTemplateFillSystemPrompt,
  buildTemplateFillUserPrompt,
  type TemplateFillPromptArgs,
} from './template-fill-prompt';
import { parseTemplateFillResult, type TemplateFillResult } from './template-fill-types';

export interface GenerateTemplateFillArgs extends TemplateFillPromptArgs {
  provider: AiProvider;
  apiKey: string;
  model: string;
  config?: AiConfig;
  /** The exact variable numbers the response must (only) contain. */
  expectedIndices: number[];
}

export async function generateTemplateFill(
  args: GenerateTemplateFillArgs,
): Promise<{ result: TemplateFillResult | null; usage: AiUsage | null }> {
  const systemPrompt = buildTemplateFillSystemPrompt();
  const userPrompt = buildTemplateFillUserPrompt(args);

  const fallbackConfig: AiConfig = args.config ?? {
    provider: args.provider,
    model: args.model,
    apiKey: args.apiKey,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 0,
    handoffAgentId: null,
    embeddingsApiKey: null,
  };

  const { text, usage } = await executeAiInference({
    config: fallbackConfig,
    mode: 'template_fill',
    systemPrompt,
    messages: [{ role: 'user' as const, content: userPrompt }],
    logUsage: false,
  });

  return { result: parseTemplateFillResult(text, args.expectedIndices), usage };
}
