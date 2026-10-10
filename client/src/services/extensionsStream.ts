import { API_ORIGIN } from '../utils/devOrigin';

/**
 * 扩展 / 插件变更事件流（SSE）—— 热插拔的推送通道（设计 §4 Phase 4，Q1 定稿用 SSE）。
 *
 * 后端在 enable / disable / reload / install / uninstall 成功后推一条
 * `{kind, action, id, ts}`；这里**只做一件事**：把既有那批 `*-list-refresh` 事件重新广播一遍，
 * 各宿主（扩展页、主题、导出器、导演包、画布节点、分镜槽、生成源）本来就监听这些事件并重拉，
 * 于是「插件一改，界面立刻跟着变」，不再需要用户切页 / 手动刷新。
 *
 * 为什么复用老事件名而不是新造一套：宿主侧的重拉逻辑已经存在且各自知道该重拉什么，
 * 再造一层「事件 → 宿主」映射只会多一份真相。SSE 只负责「什么时候」，不负责「各拉什么」。
 *
 * 兜底：连接失败 / 后端没起时**不报错、不阻塞**，EventSource 自带重连 + 这里再加退避重开；
 * 各宿主的手动刷新入口（扩展页「重试」、设置台插件分区重试）保持可用。
 */

/** 收到任何变更后统一重播的刷新事件（宿主自己决定要不要重拉） */
const REFRESH_EVENTS = [
  'plugin-list-refresh',        // 插件列表（设置 → 扩展、设置台「插件」分区）
  'provider-list-refresh',      // 生成源（插件可贡献 providers / workflows）
  'theme-list-refresh',         // 主题（themes 扩展点）
  'canvasnode-list-refresh',    // 画布扩展节点（canvas_nodes）
  'exporter-list-refresh',      // 导出器（exporters）
  'directorpacks-list-refresh', // 导演包（director_packs）
  'storyboard-slots-refresh',   // 分镜槽（storyboard_slots）
  'customnode-list-refresh',    // 自定义代码节点（custom_nodes）
];

export interface ExtensionsStreamEvent {
  kind?: string;
  action?: string;
  id?: string;
  ts?: number;
}

/**
 * 页面开关的变更也走 `/extensions/page:<id>/enable|disable`，因此同样会被本项目发布到这里；
 * 但它有自己的加载路径（`usePageStore` 自己重拉），无差别重播下面那批刷新事件只会白拉一堆请求
 * （审查 L5）—— 按事件 id 前缀跳过即可。手动刷新（`kind: 'manual'`）与连接建立
 * （`kind: 'stream'`）没有 id，照常广播。
 */
const isPageSwitchEvent = (detail?: ExtensionsStreamEvent): boolean =>
  typeof detail?.id === 'string' && detail.id.startsWith('page:');

/** 广播一轮刷新（也导出给「手动刷新」兜底入口复用） */
export function broadcastExtensionsChanged(detail?: ExtensionsStreamEvent): void {
  if (isPageSwitchEvent(detail)) return;
  REFRESH_EVENTS.forEach((name) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* ignore */ }
  });
}

/**
 * 手动刷新兜底（设计 §4 Phase 4「兜底保留手动刷新入口」；未完成清单第 11 条）。
 *
 * 用途：SSE 抖动 / 后端刚重启（连接中断期间漏掉的变更）时，
 * 由用户手动让界面追上后端 —— 走的仍是**同一份事件表**（`REFRESH_EVENTS`），
 * 口径与按钮文案一致：`startExtensionsStream` 的退避最长 30 秒、**永不放弃重连**
 * （不存在「重连已放弃」这个状态，审查 L1 已把它从文案里去掉）。
 * 不新增第二套「事件 → 宿主」映射：SSE 只负责「什么时候」，这里只负责「再来一次」。
 *
 * 边界：只覆盖**扩展 / 插件态**（插件列表、主题、导出器、导演包、画布节点、分镜槽、
 * 生成源、自定义节点）。页面开关与功能开关是另外两套真相源，各有自己的加载路径，不在此处。
 */
export function refreshExtensionState(): void {
  broadcastExtensionsChanged({ kind: 'manual', action: 'refresh' });
}

/**
 * 订阅后端事件流；返回停止函数（在 App 卸载时调用）。
 * 重复调用会各开一条连接 —— 调用方保证只开一次（App 的启动 effect）。
 */
export function startExtensionsStream(): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => { /* 环境不支持（SSR / 老浏览器） */ };

  let es: EventSource | null = null;
  let stopped = false;
  let failures = 0;
  let timer: number | null = null;

  const open = () => {
    if (stopped) return;
    try {
      es = new EventSource(`${API_ORIGIN}/api/v1/extensions/events`);
    } catch {
      return; // 构造失败（URL 非法等）直接放弃，不影响应用
    }

    es.onopen = () => {
      failures = 0;
      // 连接（重）建立时补一次刷新：覆盖「后端重启 / 我们断线期间发生的变更」
      broadcastExtensionsChanged({ kind: 'stream', action: 'open' });
    };

    es.onmessage = (ev) => {
      let detail: ExtensionsStreamEvent | null = null;
      try { detail = JSON.parse(ev.data); } catch { return; } // 心跳 / 注释帧
      if (detail) broadcastExtensionsChanged(detail);
    };

    es.onerror = () => {
      if (stopped || !es) return;
      // EventSource 自己会重连；只有它把连接判死（CLOSED）时才由我们退避重开，
      // 这样后端未起时不会打出无意义的请求风暴（1s → 30s 封顶）
      if (es.readyState === EventSource.CLOSED) {
        try { es.close(); } catch { /* ignore */ }
        es = null;
        const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(failures, 5)));
        failures += 1;
        timer = window.setTimeout(open, delay);
      }
    };
  };

  open();

  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    try { es?.close(); } catch { /* ignore */ }
    es = null;
  };
}
