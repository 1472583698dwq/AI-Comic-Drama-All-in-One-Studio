/**
 * 导演 Agent WebSocket 单例连接 — 自动重连（指数退避）+ 事件广播
 * 旧实现两个组件各建各的 WS 且断线不重连；此模块全局唯一，页面与抽屉共用。
 */
import type { WsStatus } from './agentTypes';

const isDev = typeof window !== 'undefined' && window.location.port === '5173';
export const AGENT_WS_URL = isDev
  ? 'ws://127.0.0.1:8000/api/v1/ws/agent'
  : (typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/v1/ws/agent`
      : 'ws://127.0.0.1:8000/api/v1/ws/agent');

type EventHandler = (ev: any) => void;
type StatusHandler = (s: WsStatus) => void;

let ws: WebSocket | null = null;
let status: WsStatus = 'closed';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let disposed = false;
const eventHandlers = new Set<EventHandler>();
const statusHandlers = new Set<StatusHandler>();

function setStatus(s: WsStatus) {
  status = s;
  statusHandlers.forEach((h) => {
    try { h(s); } catch {}
  });
}

function scheduleReconnect() {
  if (disposed || reconnectTimer) return;
  const delay = Math.min(15000, 1000 * Math.pow(2, Math.min(attempts, 4)));
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (disposed) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setStatus('connecting');
  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch {
    setStatus('closed');
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    attempts = 0;
    setStatus('open');
  };
  ws.onmessage = (ev) => {
    let data: any;
    try { data = JSON.parse(ev.data); } catch { return; }
    eventHandlers.forEach((h) => {
      try { h(data); } catch (e) { console.warn('[agentSocket] handler error', e); }
    });
  };
  ws.onclose = () => {
    ws = null;
    setStatus('closed');
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws?.close(); } catch {}
  };
}

export const agentSocket = {
  /** 幂等建连（应用启动/首次发送时调用） */
  ensure() {
    if (!ws) connect();
  },
  /** 发送 JSON；WS 不可用时返回 false（调用方走 SSE 降级） */
  send(payload: Record<string, any>): boolean {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(payload)); return true; } catch {}
    }
    return false;
  },
  onEvent(h: EventHandler): () => void {
    eventHandlers.add(h);
    return () => eventHandlers.delete(h);
  },
  onStatus(h: StatusHandler): () => void {
    statusHandlers.add(h);
    try { h(status); } catch {}
    return () => statusHandlers.delete(h);
  },
  get status(): WsStatus {
    return status;
  },
  /** 页面卸载时才调用（SPA 内不要调用，重连是特性） */
  dispose() {
    disposed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { ws?.close(); } catch {}
    ws = null;
  },
};
