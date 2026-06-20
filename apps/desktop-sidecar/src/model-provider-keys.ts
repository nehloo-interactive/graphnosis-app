/**
 * Encrypt/decrypt model-provider API keys in settings (cortex data key).
 * In-memory `apiKey` is plaintext post-unlock; on-disk `apiKeyEnc` only.
 */

import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import { randomBytes } from 'node:crypto';
import type { AppSettings, ModelProviderState } from '@graphnosis-app/core/settings';

async function encryptApiKey(plaintext: string, dataKey: Uint8Array): Promise<string> {
  const salt = randomBytes(16);
  const blob = await crypto.encrypt(new TextEncoder().encode(plaintext), dataKey, salt);
  return Buffer.from(blob).toString('base64');
}

async function decryptApiKey(enc: string, dataKey: Uint8Array): Promise<string> {
  const blob = new Uint8Array(Buffer.from(enc, 'base64'));
  return new TextDecoder().decode(await crypto.decrypt(blob, dataKey));
}

function keyTail(apiKey: string): string {
  return apiKey.length >= 4 ? apiKey.slice(-4) : apiKey;
}

/** On-disk shape: blank apiKey, set apiKeyEnc + hasKey + keyTail. */
export async function encryptModelProviderKeysInSettings(
  settings: AppSettings,
  dataKey: Uint8Array,
): Promise<AppSettings> {
  const models = settings.models;
  if (!models?.providers) return settings;
  const nextProviders: Record<string, ModelProviderState> = {};
  let changed = false;
  for (const [pid, raw] of Object.entries(models.providers)) {
    const state = { ...raw };
    if (state.apiKey && state.apiKey.trim()) {
      const trimmed = state.apiKey.trim();
      state.apiKeyEnc = await encryptApiKey(trimmed, dataKey);
      state.hasKey = true;
      state.keyTail = keyTail(trimmed);
      delete state.apiKey;
      changed = true;
    } else if (state.apiKeyEnc) {
      delete state.apiKey;
    }
    nextProviders[pid] = state;
  }
  if (!changed) return settings;
  return { ...settings, models: { ...models, providers: nextProviders } };
}

/** In-memory shape: decrypt apiKeyEnc → apiKey, drop apiKeyEnc from memory. */
export async function decryptModelProviderKeysInSettings(
  settings: AppSettings,
  dataKey: Uint8Array,
): Promise<AppSettings> {
  const models = settings.models;
  if (!models?.providers) return settings;
  const nextProviders: Record<string, ModelProviderState> = {};
  for (const [pid, raw] of Object.entries(models.providers)) {
    const state = { ...raw };
    if (state.apiKeyEnc) {
      try {
        state.apiKey = await decryptApiKey(state.apiKeyEnc, dataKey);
        state.hasKey = true;
        if (!state.keyTail && state.apiKey) state.keyTail = keyTail(state.apiKey);
      } catch (e) {
        console.error(
          `[graphnosis-host] model provider '${pid}' API key decryption failed: ${(e as Error).message}`,
        );
        state.apiKey = '';
        state.hasKey = false;
      }
      delete state.apiKeyEnc;
    }
    nextProviders[pid] = state;
  }
  return { ...settings, models: { ...models, providers: nextProviders } };
}
