import type { LocalLlm } from './correction.js';

// Curated list of supported local LLM runtimes. The desktop UI shows this as a picker
// with "Recommended (auto-install)" pre-selected. We never surface the runtime name to
// non-technical users — they see "Memory assistant: Llama 3.2 (recommended)".

export interface LlmChoice {
  id: string;
  label: string;
  /** User-facing one-liner shown in the picker. */
  description: string;
  /** Approximate on-disk footprint in MB. */
  sizeMb: number;
  recommended?: boolean;
  /** Underlying runtime. */
  runtime: 'ollama' | 'llama.cpp' | 'mlx';
  /** Model tag used by the runtime. */
  model: string;
}

export const LLM_CATALOG: LlmChoice[] = [
  {
    id: 'llama-3.2-3b',
    label: 'Llama 3.2 (recommended)',
    description: 'Small, fast, runs on most modern laptops.',
    sizeMb: 2_000,
    recommended: true,
    runtime: 'ollama',
    model: 'llama3.2:3b-instruct-q4_K_M',
  },
  {
    id: 'qwen-2.5-3b',
    label: 'Qwen 2.5 (alternative)',
    description: 'Slightly stronger reasoning, similar size.',
    sizeMb: 2_100,
    runtime: 'ollama',
    model: 'qwen2.5:3b-instruct-q4_K_M',
  },
  {
    id: 'llama-3.2-1b',
    label: 'Llama 3.2 mini',
    description: 'For older Macs / lower-RAM machines.',
    sizeMb: 800,
    runtime: 'ollama',
    model: 'llama3.2:1b-instruct-q4_K_M',
  },
];

// Minimal Ollama client. The bundled runtime is invisible to the user — installer drops it
// in the app's private prefix and starts it as a child process.
export class OllamaLlm implements LocalLlm {
  constructor(
    readonly name: string,
    private readonly model: string,
    private readonly baseUrl = 'http://127.0.0.1:11434',
  ) {}

  async complete(input: { system: string; user: string; jsonSchema?: unknown }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: input.jsonSchema ? 'json' : undefined,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Local LLM (${this.model}) failed: ${res.status}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return json.message?.content ?? '';
  }
}

export function makeLlm(choice: LlmChoice): LocalLlm {
  if (choice.runtime === 'ollama') return new OllamaLlm(choice.label, choice.model);
  throw new Error(`Runtime not yet implemented: ${choice.runtime}`);
}
