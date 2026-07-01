import WebSocket from 'ws';

/**
 * WebSocket client that connects to the Unity SimpleMCPBridge.
 * Translates JSON-RPC style requests into calls Unity can process.
 */
export class UnityBridge {
  private ws: WebSocket | null = null;
  private requestCounter = 0;
  private pending = new Map<
    string,
    { resolve: (result: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private _connected = false;

  // Callbacks
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;

  get connected(): boolean {
    return this._connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the Unity bridge WebSocket server.
   */
  connect(port: number, host = '127.0.0.1', timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${host}:${port}`;
      console.error(`[UnityBridge] Connecting to ${url}...`);

      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this._connected = true;
        console.error(`[UnityBridge] Connected to Unity at ${url}`);
        this.onConnected?.();
        resolve();
      });

      ws.on('message', (data) => {
        this._handleMessage(data.toString());
      });

      ws.on('close', () => {
        this._connected = false;
        console.error('[UnityBridge] Disconnected from Unity');

        // Reject all pending requests
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Unity disconnected'));
        }
        this.pending.clear();

        this.onDisconnected?.();
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        this._connected = false;
        this.onError?.(err);
        reject(err);
      });
    });
  }

  /**
   * Send a method call to Unity and wait for the response.
   * @param method  The RPC method name (e.g. "scene.create_object")
   * @param params  Parameters object
   * @param timeout Request timeout in ms (default 30s)
   */
  send(method: string, params: Record<string, unknown> = {}, timeout = 30_000): Promise<string> {
    if (!this.connected) {
      return Promise.reject(new Error('Not connected to Unity. Start SimpleMCPBridge in Unity first.'));
    }

    const id = `req_${++this.requestCounter}`;
    const message = JSON.stringify({ id, method, paramsJson: JSON.stringify(params) });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(message);
    });
  }

  /**
   * Call mcp.list_tools on Unity and return the parsed tool definitions.
   */
  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    const raw = await this.send('mcp.list_tools', {}, 10_000);
    // Unity returns a JSON array string as result
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('[UnityBridge] mcp.list_tools did not return an array:', raw.slice(0, 200));
      return [];
    }
    return parsed;
  }

  /**
   * Gracefully disconnect.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  // ── Private ──

  private _handleMessage(raw: string): void {
    let response: { id?: string; result?: string; error?: string };
    try {
      response = JSON.parse(raw);
    } catch {
      console.error('[UnityBridge] Failed to parse response as JSON:', raw.slice(0, 200));
      return;
    }

    if (!response.id || !this.pending.has(response.id)) return;

    const entry = this.pending.get(response.id)!;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);

    if (response.error) {
      entry.reject(new Error(response.error));
    } else {
      entry.resolve(response.result ?? 'null');
    }
  }
}
