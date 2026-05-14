import type { Socket } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP `Transport` over a Node TCP / Unix socket.
 *
 * Wire format mirrors the stdio transport's: newline-delimited JSON-RPC
 * messages, one per line. We accumulate bytes into a buffer until we see a
 * `\n`, then dispatch each complete line as a single JSONRPCMessage.
 *
 * One transport instance per connection. The MCP SDK's `Server.connect()`
 * will call `start()` to begin reading, then call `send()` to write outbound
 * messages and invoke `onmessage` for inbound ones.
 */
export class SocketServerTransport implements Transport {
  private buffer = '';
  private closed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('SocketServerTransport: cannot start a closed transport');
    this.socket.on('data', (chunk: Buffer | string) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JSONRPCMessage;
          this.onmessage?.(msg);
        } catch (e) {
          this.onerror?.(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    this.socket.on('error', (err) => {
      this.onerror?.(err);
    });
    this.socket.on('close', () => {
      this.closed = true;
      this.onclose?.();
    });
    this.socket.on('end', () => {
      // Peer half-closed. Treat as full close on our end too.
      this.closed = true;
      this.onclose?.();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('SocketServerTransport: send on closed transport');
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.write(JSON.stringify(message) + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.socket.end(() => resolve());
    });
  }
}
