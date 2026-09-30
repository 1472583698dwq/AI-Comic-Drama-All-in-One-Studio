import { create } from 'zustand';
import { apiService } from '../services/api';

/**
 * 非页面级「功能开关」（L2 能力级开关）。
 *
 * 与页面开关（usePageStore）的分工：
 *   页面开关 —— 管「看不看得见这一页」（入口可见性 + 接口准入）；
 *   功能开关 —— 管「这一页里的进阶能力开不开」（同一页内的可选能力，默认全关）。
 *
 * 数据源唯一：后端 `GET /api/v1/features`（契约冻结），写入走
 * `PUT /api/v1/features`，body `{ values: { id: bool } }`，返回与 GET 同形状的最新全量状态。
 * 后端拦截（关闭即生效，前端只负责如实展示）：
 *   - agent_teams 关闭 → /api/v1/agent-teams* 与 /api/v1/agent-profiles* 直接 404；
 *   - agent_multimodal 关闭 → Agent 附件退化为纯文本；
 *   - agent_subagent 关闭 → 子代理委派直接失败。
 *
 * 不缓存到 localStorage：功能开关的真相只有后端一份（后端默认全关），避免本地与后端漂移。
 */
export interface FeatureItem {
  id: string;
  label: string;
  /** 能力说明（同时是「关闭后」影响范围的唯一文案来源，前端不自行编造） */
  description: string;
  /** 出厂默认值（后端标记，当前契约全部为 false） */
  default?: boolean;
  enabled: boolean;
}

interface FeatureState {
  items: FeatureItem[];
  values: Record<string, boolean>;
  /** 开关落盘位置（后端返回，设置面板脚注用） */
  file: string;
  loaded: boolean;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  setFeature: (id: string, enabled: boolean) => Promise<void>;
}

const asBool = (v: any): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 0 || v === 1 ? v === 1 : undefined;

/**
 * 归一化契约返回：enabled 以 values 为准（values 缺失才回落到 item.enabled，再回落到 default）。
 * 只认后端下发的开关项 —— 后端没有的项一律不补，绝不「编造」开关。
 */
function normalizeFeatures(raw: any): FeatureItem[] {
  const list: any[] = Array.isArray(raw?.features) ? raw.features : Array.isArray(raw) ? raw : [];
  const values: Record<string, any> = raw?.values && typeof raw.values === 'object' ? raw.values : {};
  return list
    .filter((f) => f && typeof f.id === 'string' && f.id)
    .map((f) => {
      const fromValues = asBool(values[f.id]);
      const fromItem = asBool(f.enabled);
      const fromDefault = asBool(f.default);
      return {
        id: f.id,
        label: typeof f.label === 'string' && f.label ? f.label : f.id,
        description: typeof f.description === 'string' ? f.description : '',
        default: fromDefault ?? false,
        enabled: fromValues ?? fromItem ?? fromDefault ?? false,
      };
    });
}

const valuesOf = (items: FeatureItem[]): Record<string, boolean> =>
  items.reduce<Record<string, boolean>>((acc, it) => { acc[it.id] = it.enabled; return acc; }, {});

export const useFeatureStore = create<FeatureState>((set, get) => ({
  items: [],
  values: {},
  file: '',
  loaded: false,
  loading: false,
  error: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const res = await apiService.getFeatures();
      const items = normalizeFeatures(res);
      set({
        items,
        values: valuesOf(items),
        file: String(res?.file || ''),
        loaded: true,
        loading: false,
      });
    } catch (e: any) {
      // 兜底：仅请求失败时用「全部关闭」空态 —— 与后端默认全关一致，不编造任何开关项
      set({
        items: [],
        values: {},
        file: '',
        loaded: true,
        loading: false,
        error: e?.message || '读取功能开关失败',
      });
    }
  },

  /** 写后端成功后以返回值为准刷新本地（后端可能纠正值或拒绝某项） */
  setFeature: async (id, enabled) => {
    const res: any = await apiService.saveFeatures({ [id]: enabled });
    const items = normalizeFeatures(res);
    if (items.length > 0) {
      set({
        items,
        values: valuesOf(items),
        file: String(res?.file || get().file || ''),
        error: null,
      });
      return;
    }
    // 后端只回 values（或空体）时，按本地补丁更新，保持两侧一致
    const serverValues: Record<string, any> = res?.values && typeof res.values === 'object' ? res.values : {};
    const nextValues = { ...get().values, [id]: enabled, ...serverValues };
    set({
      values: nextValues,
      items: get().items.map((it) => (it.id === id ? { ...it, enabled: nextValues[it.id] === true } : it)),
      file: String(res?.file || get().file || ''),
      error: null,
    });
  },
}));

/** 某功能是否开启（读 getState 快照，不订阅；未加载一律 false —— 与后端默认全关一致） */
export const isFeatureEnabled = (id: string): boolean => useFeatureStore.getState().values[id] === true;
