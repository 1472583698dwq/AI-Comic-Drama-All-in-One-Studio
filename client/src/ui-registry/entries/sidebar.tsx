import { ChatHistoryBlock } from '../../components/navbar/ChatHistoryBlock';
import { register } from '../registry';
import { SIDEBAR_HOST } from '../types';

/**
 * 侧栏扩展点条目（Phase 3 的第一个 `sidebar-block`）。
 *
 * 现状：侧栏里**唯一**由 UI 偏好控制的内容就是下半部「会话 / 项目快捷区」，
 * 之前硬编码在 `Sidebar.tsx` 里；现在登记成注册表条目：
 *   · `scope: 'prefs'` + `switchId: 'sidebar_chat_history'` —— 开关一关条目即移除，
 *     与改造前「关掉后侧栏只剩导航与底部工具」等价；
 *   · 壳（侧栏本身）仍然是 locked（`shell.sidebar`），锁定的是「导航 + 底部工具」，
 *     这块内容可关 —— 这两件事在设计 §5.2 的备注里已分得很清楚。
 *
 * 后续再往侧栏加块（预埋位）时，只需在 `SIDEBAR_HOST` 下加一条本文件这样的条目，
 * `Sidebar.tsx` 不用再改。
 */
function registerSidebarEntries(): () => void {
  return register({
    id: 'sidebar.chat-history',
    kind: 'sidebar-block',
    host: SIDEBAR_HOST,
    order: 10,
    scope: 'prefs',
    switchId: 'sidebar_chat_history',
    source: 'builtin',
    render: ChatHistoryBlock,
  });
}

registerSidebarEntries();
