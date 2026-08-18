// ── Growth limits ──

import { WebSocket } from 'ws';
import { encryptPayload } from './crypto.js';
import { log } from './logger.js';
export const MAX_BRIDGES = 50;
export const MAX_PENDING = 10000;

/**
 * Route a tool call directly to a specific bridge by bridgeId.
 * Unlike callBridge() which looks up by tool name, this bypasses
 * tool-to-bridge routing and calls the named tool on the target bridge directly.
 */
export function callBridgeById(bridgeId: string, method: string, params: Record<string, unknown>): Promise<string> {
  const info = bridges.get(bridgeId);
  if (!info) {
    return Promise.reject(new Error(`Bridge '${bridgeId}' not found — use bridge.list to see connected bridges`));
  }
  if (info.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Bridge '${bridgeId}' WebSocket is not open (state=${info.ws.readyState})`));
  }

  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const message = JSON.stringify({ id, method, paramsJson: JSON.stringify(params) });
  log(`[Server] Direct call '${method}' → bridge [${bridgeId.slice(0, 8)}] (id=${id.slice(0, 28)})`);

  return new Promise((resolve, reject) => {
    if (pending.size >= MAX_PENDING) {
      return reject(new Error(`Server busy: too many pending tool calls (${MAX_PENDING})`));
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Direct tool call '${method}' on bridge '${bridgeId.slice(0, 8)}' timed out (30s)`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer, method, params, bridgeId });
    info.ws.send(encryptPayload(message), (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`WebSocket send to bridge '${bridgeId.slice(0, 8)}' failed: ${err.message}`));
      }
    });
  });
}



// ── Multi-Bridge State ──

/** Information about a connected bridge client. */
export interface BridgeInfo {
  ws: WebSocket;
  id: string;
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
  connectedAt: number;
  clientIp: string;
  clientPort: number;
}

/**
 * All connected bridges, keyed by bridgeId.
 * Multiple bridges can coexist — each has a unique ID (set by the Unity client via GUID).
 * During domain reload, the old bridge disconnects while the new one is already connected,
 * so they overlap briefly without conflict.
 */
export const bridges = new Map<string, BridgeInfo>();
/** Maps tool name → bridgeId for routing tool calls to the correct bridge. */
export const toolToBridge = new Map<string, string>();

/** Pending tool-call responses awaiting bridge reply, keyed by request ID. */
export const pending = new Map<string, {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  params: Record<string, unknown>;
  bridgeId: string;
}>();

/**
 * Retry queue for tool calls that were in-flight when ALL bridges disconnected.
 * On reconnect (register_tools from any bridge), these are re-sent.
 */
const retryQueue: Array<{
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  method: string;
  params: Record<string, unknown>;
  bridgeId: string;
}> = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Pending AI request responses awaiting LLM reply, keyed by requestId. */
export const pendingAI = new Map<string, {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
/** Whether Unity is currently compiling scripts. Bridge reports via {"type":"compilation","status":"started|finished"}. */
export let isUnityCompiling = false;
/** Current Unity play mode state. Bridge reports via {"type":"playmode","status":"entered|exiting|entered_edit|exiting_edit"}. */
export let playModeState: string | null = null;
export function setUnityCompiling(v: boolean): void { isUnityCompiling = v; }
export function setPlayModeState(v: string | null): void { playModeState = v; }

/**
 * Reject all pending tool calls that were sent to a specific bridge.
 * Used when a bridge disconnects — prevents 30s timeout hang.
 * Returns the number of rejected calls.
 */
export function rejectPendingForBridge(bridgeId: string, reason: string): number {
  let count = 0;
  for (const [reqId, entry] of pending) {
    if (entry.bridgeId === bridgeId) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Bridge disconnected: ${reason}`));
      pending.delete(reqId);
      count++;
    }
  }
  return count;
}

/**
 * Route a tool call to the bridge that registered the tool.
 * This allows multiple bridges to coexist: each registers its own tool set,
 * and calls are dispatched to the correct bridge by tool name.
 */
export function callBridge(method: string, params: Record<string, unknown>): Promise<string> {
  if (isUnityCompiling) {
    return Promise.reject(new Error('Unity is compiling — tools unavailable until compilation finishes'));
  }

  // Find which bridge registered this tool
  const bridgeId = toolToBridge.get(method);
  if (!bridgeId) {
    if (bridges.size === 0) {
      return Promise.reject(new Error('No bridge connected'));
    }
    return Promise.reject(new Error(`No bridge registered for tool '${method}' (${bridges.size} bridge(s) connected but none has this tool)`));
  }
  const info = bridges.get(bridgeId);
  if (!info || info.ws.readyState !== WebSocket.OPEN) {
    // Bridge disconnected — clean up mapping
    toolToBridge.delete(method);
    bridges.delete(bridgeId);
    return Promise.reject(new Error(`Bridge '${bridgeId}' disconnected while handling tool '${method}'`));
  }

  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const message = JSON.stringify({ id, method, paramsJson: JSON.stringify(params) });
  log(`[Server] Calling tool '${method}' → bridge [${bridgeId.slice(0,8)}] (id=${id.slice(0,28)})`);

  return new Promise((resolve, reject) => {
    if (pending.size >= MAX_PENDING) {
      return reject(new Error(`Server busy: too many pending tool calls (${MAX_PENDING})`));
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tool call '${method}' timed out`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer, method, params, bridgeId });
    info.ws.send(encryptPayload(message), (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`WebSocket send failed: ${err.message}`));
      }
    });
  });
}