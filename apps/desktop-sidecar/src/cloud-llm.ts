/**
 * Cloud LLM adapters for Ghampus skill walks — OpenAI-compatible chat
 * completions and Anthropic Messages API.
 */

import type { GraphnosisHost } from './host.js';
import type { ModelProviderId } from './model-registry.js';

const DEFAULT_SYSTEM =
  'You are Ghampus, an AI agent executing one step of a structured skill. Answer concisely and concretely.';

/** OpenAI-compatible API base URLs for BYOK providers. */
export const OPENAI_COMPAT_BASE_URLS: Partial<Record<ModelProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  together: 'https://api.together.xyz/v1',
};

export function getProviderApiKey(host: GraphnosisHost, providerId: string): string | null {
  const state = host.getSettings().models?.providers?.[providerId];
  const key = state?.apiKey?.trim();
  return key ? key : null;
}

export function requireProviderApiKey(host: GraphnosisHost, providerId: string): string {
  const key = getProviderApiKey(host, providerId);
  if (!key) {
    throw new Error(
      `Provider '${providerId}' requires a configured API key. Open Settings → Models to connect it, or switch routing strategy to Local-only.`,
    );
  }
  return key;
}

export function isProviderRoutingReady(host: GraphnosisHost, providerId: string): boolean {
  const provider = host.getSettings().models?.providers?.[providerId];
  if (!provider?.enabled) return false;
  // Ollama and other local providers need no key.
  if (providerId === 'ollama' || providerId === 'mlx' || providerId === 'vllm') {
    return provider.enabled === true;
  }
  return provider.hasKey === true && !!getProviderApiKey(host, providerId);
}

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    if (typeof body.error === 'string') return body.error;
    if (body.error && typeof body.error === 'object' && body.error.message) return body.error.message;
  } catch { /* ignore */ }
  return `${res.status} ${res.statusText}`;
}

/** OpenAI-compatible POST /chat/completions */
export async function completeOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  system = DEFAULT_SYSTEM,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible API error: ${await readApiError(res)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

/** Anthropic POST /v1/messages */
export async function completeAnthropic(
  apiKey: string,
  model: string,
  prompt: string,
  system = DEFAULT_SYSTEM,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${await readApiError(res)}`);
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = json.content?.find((b) => b.type === 'text')?.text;
  return text?.trim() ?? '';
}

export async function dispatchCloudModelCall(
  provider: ModelProviderId,
  modelTag: string,
  prompt: string,
  host: GraphnosisHost,
): Promise<string> {
  if (provider === 'anthropic') {
    const apiKey = requireProviderApiKey(host, provider);
    return completeAnthropic(apiKey, modelTag, prompt);
  }
  const baseUrl = OPENAI_COMPAT_BASE_URLS[provider];
  if (baseUrl) {
    const apiKey = requireProviderApiKey(host, provider);
    return completeOpenAiCompatible(baseUrl, apiKey, modelTag, prompt);
  }
  throw new Error(
    `Provider '${provider}' adapter is not available in this build. Configure Ollama as fallback or wait for the adapter to ship.`,
  );
}
