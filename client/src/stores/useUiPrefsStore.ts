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
import { DEFAULT_VARIANT } from '../ui-registry/types';

const STORAGE_KEY = 'ai_manju_ui_switches';

/**
 * 页面版本单选偏好（设计 §2.4.1）：`page_variant.<pageId>` 独立键，值为变体标识。
 *
 * 与上面的布尔开关**分开存**：布尔键是「显示 / 隐藏」，这里是「用哪个版本」，混在一个
 * 对象里以后加版本切换会互相覆盖。key 前缀也保证互不干扰。
 * 本模块只负责**读写字符串**，不认识有哪些版本 —— 「值是否合法」由 ui-registry 解析层判定
 * （未知 / 缺失版本一律回落 default），因此这里不 import 注册表，避免循环依赖。
 */
const VARIANT_PREFIX = 'page_variant.';

/** id / 变体标识的合法形状：小写字母数字与中划线（和后端 page id 同形状） */
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const VARIANT_MAX_LEN = 32;

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
  {
    id: 'tip_context',
    label: '上下文引导卡',
    description: '首进画布 / 分镜台时角落那张「这样玩」提示卡不再出现（设置 → 系统里可重置已读记录）',
    default: true,
  },
  {
    id: 'panel_agent_drawer',
    label: '悬浮 AI 导演抽屉',
    description: '右下角悬浮的导演对话抽屉整体隐藏（画布页的专属 Agent 侧栏与「AI 导演」页不受影响）',
    default: true,
  },
  {
    id: 'panel_ai_polish',
    label: '全局 AI 润色',
    description: '输入框聚焦时弹出的 AI 润色小面板不再挂载（关闭即彻底停用，不留后台监听）',
    default: true,
  },
  {
    id: 'wizard_reopen',
    label: '安装向导重开入口',
    description: '「设置 → 系统」里的「重新运行安装向导」按钮隐藏；首次启动的强制向导不受此开关影响',
    default: true,
  },
  {
    id: 'settings_registry_view',
    label: '注册表视图',
    description: '设置台里追加「注册表」面板（列出全部条目与锁定壳清单），只影响本机显示',
    default: false,
  },
  {
    id: 'settings_diagnostics',
    label: '诊断与演练',
    description: '设置台里追加「诊断」面板（只读诊断 + 恢复保底版本 + 外部停用当前页演练），只影响本机显示',
    default: false,
  },
  {
    id: 'annotate_locked',
    label: '最小形态标注',
    description: '给锁定壳 / 可插拔区域 / 插件贡献叠三色描边与图例，用来核对最小形态边界',
    default: false,
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

/**
 * 读页面版本偏好：扫描 `page_variant.*` 前缀的键。
 * 只认合法 page id 与合法变体标识，脏值（超长 / 非法字符 / 空串）一律忽略 —— 不修不删，
 * 交由解析层回落 default，避免这里悄悄改用户的本地数据。
 */
function loadVariants(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (typeof localStorage === 'undefined') return out;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(VARIANT_PREFIX)) continue;
      const pageId = key.slice(VARIANT_PREFIX.length);
      if (!ID_RE.test(pageId)) continue;
      const value = normalizeVariant(localStorage.getItem(key));
      if (value) out[pageId] = value;
    }
  } catch { /* 读不到就当没有版本偏好 */ }
  return out;
}

/** 变体标识归一：非空、限长、形状合法；不合法返回 null */
function normalizeVariant(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > VARIANT_MAX_LEN || !ID_RE.test(v)) return null;
  return v;
}

/* ─────────────────── 界面语言（单选偏好，非布尔） ─────────────────── */

export type UiLang = 'zh' | 'en';
const LANG_KEY = 'ui_lang';

/** 读界面语言：只认 zh / en，其它一律回落中文 */
function loadLang(): UiLang {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_KEY) : null;
    return raw === 'en' ? 'en' : 'zh';
  } catch { return 'zh'; }
}

interface UiPrefsState {
  values: Record<string, boolean>;
  /** 页面版本单选偏好：pageId → variant（缺项 = 用 DEFAULT_VARIANT，由解析层回落） */
  variants: Record<string, string>;
  /** 界面语言（设置台 / 新增面板 / 标注 / 空态页的中英文案） */
  lang: UiLang;
  /** 切换某个 UI 开关（未知 id 不接收，避免写出无人读取的脏键） */
  setUiSwitch: (id: string, enabled: boolean) => void;
  /** 设置页面版本；传 'default'（或空）时删除该键 = 回到保底版本 */
  setPageVariant: (pageId: string, variant: string) => void;
  /** 一键恢复保底版本：清空全部 `page_variant.*` 键（诊断面板用） */
  resetAllPageVariants: () => void;
  /** 切换界面语言 */
  setLang: (lang: UiLang) => void;
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  values: loadValues(),
  variants: loadVariants(),
  lang: loadLang(),

  setUiSwitch: (id, enabled) => {
    if (!DEF_BY_ID.has(id)) return;
    const next = { ...get().values, [id]: enabled };
    set({ values: next });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  },

  setPageVariant: (pageId, variant) => {
    if (!ID_RE.test(String(pageId || ''))) return;
    const value = normalizeVariant(variant);
    if (!value) return;
    const next = { ...get().variants };
    try {
      if (value === DEFAULT_VARIANT) {
        delete next[pageId];
        localStorage.removeItem(VARIANT_PREFIX + pageId);
      } else {
        next[pageId] = value;
        localStorage.setItem(VARIANT_PREFIX + pageId, value);
      }
    } catch { /* 落盘失败仍更新内存态：本次会话内切换依然生效 */ }
    set({ variants: next });
  },

  resetAllPageVariants: () => {
    try {
      // 先收集再删：边遍历边删 localStorage 会漏键
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(VARIANT_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch { /* 落盘失败也照样清内存态 */ }
    set({ variants: {} });
  },

  setLang: (lang) => {
    const value: UiLang = lang === 'en' ? 'en' : 'zh';
    set({ lang: value });
    try { localStorage.setItem(LANG_KEY, value); } catch { /* ignore */ }
  },
}));

/** 页面版本偏好的落盘前缀（设置面板脚注用） */
export const PAGE_VARIANT_PREFIX = VARIANT_PREFIX;
