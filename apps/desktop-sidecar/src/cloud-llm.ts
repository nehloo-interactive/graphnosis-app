/**
 * LLM adapters for Ghampus skill walks — OpenAI-compatible chat
 * completions, local OpenAI-compatible runtimes (MLX, vLLM), and Anthropic.
 */

import type { GraphnosisHost } from './host.js';
import type { ModelProviderId } from './model-registry.js';

const DEFAULT_SYSTEM =
  'You are Ghampus, an AI agent executing one step of a structured skill. Answer concisely and concretely.';

/** OpenAI-compatible API base URLs for BYOK cloud providers. */
export const OPENAI_COMPAT_BASE_URLS: Partial<Record<ModelProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  together: 'https://api.together.xyz/v1',
};

/** Default loopback endpoints for OpenAI-compatible local runtimes. */
export const LOCAL_OPENAI_COMPAT_BASE_URLS: Partial<Record<ModelProviderId, string>> = {
  mlx: 'http://127.0.0.1:8080/v1',
  vllm: 'http://127.0.0.1:8000/v1',
};

export type LocalOpenAiProviderId = 'mlx' | 'vllm';

export function resolveLocalOpenAiBaseUrl(host: GraphnosisHost, providerId: LocalOpenAiProviderId): string {
  const custom = host.getSettings().models?.providers?.[providerId]?.baseUrl?.trim();
  if (custom) return custom.replace(/\/$/, '');
  return LOCAL_OPENAI_COMPAT_BASE_URLS[providerId] ?? '';
}

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

/** GET /models — lightweight reachability probe for OpenAI-compatible servers. */
export async function pingOpenAiCompatible(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** OpenAI-compatible POST /chat/completions */
export async function completeOpenAiCompatible(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  prompt: string,
  system = DEFAULT_SYSTEM,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
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

/**
 * Dispatch a skill-walk step to a local OpenAI-compatible runtime (MLX-LM,
 * vLLM). Fails with a clear message when the server is unreachable — the
 * walker catches this and records it on the step without crashing the walk.
 */
export async function dispatchLocalOpenAiModelCall(
  provider: LocalOpenAiProviderId,
  modelTag: string,
  prompt: string,
  host: GraphnosisHost,
): Promise<string> {
  const baseUrl = resolveLocalOpenAiBaseUrl(host, provider);
  if (!baseUrl) {
    throw new Error(
      `Provider '${provider}' has no base URL configured. Set models.providers.${provider}.baseUrl in Settings → Models.`,
    );
  }
  const reachable = await pingOpenAiCompatible(baseUrl);
  if (!reachable) {
    const label = provider === 'mlx' ? 'MLX-LM' : 'vLLM';
    throw new Error(
      `${label} server unreachable at ${baseUrl}. Start your local server or update the base URL in Settings → Models.`,
    );
  }
  const configuredKey = getProviderApiKey(host, provider);
  const apiKey = configuredKey ?? 'not-needed';
  return completeOpenAiCompatible(baseUrl, apiKey, modelTag, prompt);
}
