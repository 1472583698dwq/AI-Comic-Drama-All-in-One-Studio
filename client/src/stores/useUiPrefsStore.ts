/**
 * UI 开关（界面偏好）—— 设置 → 功能开关 里的第三类开关，管「界面元素显不显示」。
 *
 * 与另外两层的分工：
 *   页面开关（usePageStore）—— 后端真相，管「这一页能不能进」（入口可见性 + 接口准入）；
 *   功能开关（useFeatureStore）—— 后端真相，管「页内进阶能力开不开」；
 *   UI 开关（本模块）—— **纯前端呈现偏好**，只改本机界面长什么样，
 *   不碰任何后端能力、不改接口准入，也不影响其他机器。
 *
 * 所以它不走另外两层的契约（那两层明确不落 localStorage，避免与后端漂移）：
 * 这里只落 localStorage，改完即时生效、无需重启、无需保存。
 */
import { create } from 'zustand';

const STORAGE_KEY = 'ai_manju_ui_switches';

export interface UiSwitchItem {
  id: string;
  label: string;
  /** 前端按「关闭后：<description>」展示 */
  description: string;
  /** 出厂默认：true = 出厂就显示（关闭属于用户主动精简界面） */
  default: boolean;
}

/**
 * 全部 UI 开关。**第一个（sidebar_chat_history）是侧栏快捷区总闸**：
 * 有些用户只要功能导航，不需要「会话 / 项目」这一大块，关掉后侧栏回到极简。
 */
export const UI_SWITCH_DEFS: UiSwitchItem[] = [
  {
    id: 'sidebar_chat_history',
    label: '会话与项目快捷侧栏',
    description: '左侧栏里的「会话 / 项目」快捷区（含项目分组、排序筛选、归档）整体隐藏，侧栏只留功能导航与底部工具',
    default: true,
  },
];

const DEF_BY_ID = new Map(UI_SWITCH_DEFS.map((it) => [it.id, it]));

/** 读本地偏好：只认定义里存在的 id 且值为布尔；缺项/损坏一律回落出厂默认 */
function loadValues(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  UI_SWITCH_DEFS.forEach((it) => { out[it.id] = it.default; });
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return out;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      UI_SWITCH_DEFS.forEach((it) => {
        if (typeof (saved as any)[it.id] === 'boolean') out[it.id] = (saved as any)[it.id];
      });
    }
  } catch { /* 读不到就用出厂默认 */ }
  return out;
}

interface UiPrefsState {
  values: Record<string, boolean>;
  /** 切换某个 UI 开关（未知 id 不接收，避免写出无人读取的脏键） */
  setUiSwitch: (id: string, enabled: boolean) => void;
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  values: loadValues(),

  setUiSwitch: (id, enabled) => {
    if (!DEF_BY_ID.has(id)) return;
    const next = { ...get().values, [id]: enabled };
    set({ values: next });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  },
}));

/** 某个 UI 开关是否开启（读 getState 快照，不订阅；未知 id 一律 false） */
export const isUiSwitchEnabled = (id: string): boolean => {
  const v = useUiPrefsStore.getState().values[id];
  return typeof v === 'boolean' ? v : !!DEF_BY_ID.get(id)?.default;
};
