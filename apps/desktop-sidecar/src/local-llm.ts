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

// ── Backend verification descriptor ─────────────────────────────────────────
// Generic shape that lets MemoryStudio's "is this LLM really local?" checks
// work across runtimes. v1 ships with Ollama populated only; v2 adds entries
// for LM Studio, llama.cpp's llama-server, MLX-LM server, Jan, GPT4All, etc.
//
// Each backend tells the verification layer:
//   - what URL pattern it uses (so the "loopback ✓" badge can parse the host)
//   - what process names to look for when running lsof / ps
//   - what external hostnames it's KNOWN to legitimately reach (so the DNS
//     sinkhole self-test can target only those — e.g. `registry.ollama.ai`
//     for Ollama; the empty list for llama-server, which has no phone-home)
//   - which API flavor (Ollama-native vs. OpenAI-compatible) so the
//     honeypot canary can shape its request correctly

export type LocalLlmRuntimeId = 'ollama' | 'llama.cpp' | 'mlx' | 'lmstudio' | 'gpt4all' | 'jan' | 'custom';

export type LocalLlmApiFlavor = 'ollama' | 'openai-compatible';

export interface LocalLlmBackend {
  id: LocalLlmRuntimeId;
  /** Human-readable name shown in Settings / verification badges. */
  displayName: string;
  /** Base URL where the daemon serves requests. */
  baseUrl: string;
  /** API request shape — drives honeypot canary's request body. */
  api: LocalLlmApiFlavor;
  /** Process names to find when running `lsof -p` / `ps aux`. The first
   *  match wins; multiple names cover variants (e.g. ['ollama', 'ollama-runner']). */
  processNames: string[];
  /** External hostnames this backend is KNOWN to reach as part of normal
   *  operation, NOT including inference. Used by the DNS-sinkhole self-test
   *  to verify that inference still works when these are blocked. Empty
   *  array = backend has no documented phone-home behavior. */
  knownExternalHosts: string[];
  /** Default TCP port the daemon listens on (used as a fallback when PID
   *  lookup by name fails — `lsof -i :<port>` finds whoever's listening). */
  defaultPort: number;
}

/** v1 registry: only Ollama populated. v2 adds the others.
 *  Order matters for auto-detection: first reachable wins. */
export const LOCAL_LLM_BACKENDS: Record<LocalLlmRuntimeId, LocalLlmBackend | null> = {
  ollama: {
    id: 'ollama',
    displayName: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    api: 'ollama',
    processNames: ['ollama', 'ollama-runner'],
    // Ollama reaches `registry.ollama.ai` for `ollama pull` and version
    // checks. Inference does NOT use this — only model installation.
    knownExternalHosts: ['registry.ollama.ai', 'ollama.ai'],
    defaultPort: 11434,
  },
  // v2 placeholders. The verification UI shows "Backend: <id> — descriptor
  // missing, contact maintainer" if a user manages to select a null backend.
  'llama.cpp': null,
  mlx: {
    id: 'mlx',
    displayName: 'MLX-LM Server',
    baseUrl: 'http://127.0.0.1:8080/v1',
    api: 'openai-compatible',
    processNames: ['python', 'mlx_lm'],
    knownExternalHosts: [],
    defaultPort: 8080,
  },
  lmstudio: null,
  gpt4all: null,
  jan: null,
  custom: null,
};

/** Convenience: return the descriptor for the currently-active backend, or
 *  fall back to Ollama (which is the only thing wired up in v1). */
export function activeBackend(runtime?: LocalLlmRuntimeId | null): LocalLlmBackend {
  const id = runtime ?? 'ollama';
  const entry = LOCAL_LLM_BACKENDS[id];
  return entry ?? LOCAL_LLM_BACKENDS.ollama!;
}

// Minimal Ollama client. The bundled runtime is invisible to the user — installer drops it
// in the app's private prefix and starts it as a child process.
export class OllamaLlm implements LocalLlm {
  constructor(
    readonly name: string,
    private readonly model: string,
    private readonly baseUrl = 'http://127.0.0.1:11434',
    /** Default temperature when the call does not pass an explicit override. */
    private readonly getDefaultTemperature: () => number = () => 0.2,
  ) {}

  private ollamaTemperature(input: {
    jsonSchema?: unknown;
    temperature?: number;
  }): number {
    if (process.env.GRAPHNOSIS_EVAL_MODE === '1') return 0;
    if (input.jsonSchema) return 0;
    if (typeof input.temperature === 'number') return input.temperature;
    return this.getDefaultTemperature();
  }

  async complete(input: { system: string; user: string; jsonSchema?: unknown; temperature?: number; signal?: AbortSignal }): Promise<string> {
    if (input.signal?.aborted) {
      throw new DOMException('LLM request aborted', 'AbortError');
    }
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(input.signal ? { signal: input.signal } : {}),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: input.jsonSchema ? 'json' : undefined,
        options: { temperature: this.ollamaTemperature(input) },
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

  /** Streaming chat completion. Ollama's /api/chat with stream:true returns
   *  newline-delimited JSON; each line is `{ message: { content: "...token..." }, done: false }`.
   *  We pipe each delta to `onChunk`, accumulate, and resolve with the full text.
   *  Format=json is incompatible with streaming, so callers that want a
   *  structured response should use complete() instead. */
  async completeStream(
    input: { system: string; user: string; jsonSchema?: unknown; temperature?: number; signal?: AbortSignal },
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    if (input.signal?.aborted) {
      throw new DOMException('LLM stream aborted', 'AbortError');
    }
    // Streaming + json format together are not supported by Ollama —
    // requests that need structured output silently lose the format
    // constraint when streaming. Caller's responsibility to use
    // complete() for those. (Skill training is free-form text, so this
    // restriction doesn't bite the trainer.)
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(input.signal ? { signal: input.signal } : {}),
      body: JSON.stringify({
        model: this.model,
        stream: true,
        options: { temperature: this.ollamaTemperature(input) },
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Local LLM (${this.model}) stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const abortStream = (): void => {
      void reader.cancel().catch(() => {});
    };
    input.signal?.addEventListener('abort', abortStream, { once: true });
    try {
    // Ollama emits one JSON object per line. Boundaries don't always align
    // with fetch chunks, so we buffer until we see a newline before parsing.
    while (true) {
      if (input.signal?.aborted) {
        throw new DOMException('LLM stream aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // last fragment may be incomplete
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
          const piece = parsed.message?.content ?? '';
          if (piece) {
            full += piece;
            onChunk(piece);
          }
        } catch {
          // Malformed line — ignore and keep reading; Ollama occasionally
          // emits an error envelope or partial JSON during shutdown.
        }
      }
    }
    // Drain any final buffered line that didn't end with a newline.
    const tail = buffer.trim();
    if (tail) {
      try {
        const parsed = JSON.parse(tail) as { message?: { content?: string } };
        const piece = parsed.message?.content ?? '';
        if (piece) { full += piece; onChunk(piece); }
      } catch { /* ignore */ }
    }
    return full;
    } finally {
      input.signal?.removeEventListener('abort', abortStream);
    }
  }

  /** Returns true if Ollama is reachable. Used by BrainEngine before LLM-dependent loops. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function makeLlm(choice: LlmChoice): LocalLlm {
  if (choice.runtime === 'ollama') return new OllamaLlm(choice.label, choice.model);
  throw new Error(`Runtime not yet implemented: ${choice.runtime}`);
}

/**
 * A dynamic Ollama proxy that resolves the model tag at call time via
 * `getModelTag()`. Pass a getter that reads `settings.ai.llmModel` so
 * that changing the active model in Settings → Local LLM takes effect
 * immediately without a sidecar restart.
 *
 * This is the correct production instance for the sidecar — the static
 * `OllamaLlm` / `makeLlm` path is only used in tests and one-shot scripts.
 */
export class DynamicOllamaLlm implements LocalLlm {
  constructor(
    private readonly getModelTag: () => string,
    private readonly baseUrl = 'http://127.0.0.1:11434',
    private readonly getDefaultTemperature: () => number = () => 0.2,
  ) {}

  get name(): string {
    return `Ollama/${this.getModelTag()}`;
  }

  private client(): OllamaLlm {
    const tag = this.getModelTag();
    return new OllamaLlm(`Ollama/${tag}`, tag, this.baseUrl, this.getDefaultTemperature);
  }

  complete(input: { system: string; user: string; jsonSchema?: unknown; temperature?: number; signal?: AbortSignal }): Promise<string> {
    return this.client().complete(input);
  }

  completeStream(
    input: { system: string; user: string; jsonSchema?: unknown; temperature?: number; signal?: AbortSignal },
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    return this.client().completeStream(input, onChunk);
  }

  async ping(): Promise<boolean> {
    return this.client().ping();
  }
}
