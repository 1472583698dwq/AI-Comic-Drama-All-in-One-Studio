import { create } from 'zustand';

export interface CanvasAssetItem {
  id: string;
  name: string;
  url: string;
  type: 'image' | 'video' | 'audio';
  sourceNodeId: string;
  sourceNodeType: string;
  slotKey?: string;
  createdAt: string;
}

interface CanvasStore {
  nodes: any[];
  edges: any[];
  summary: string;
  selectedNodeId: string | null;
  activeSkillId: string | null;
  canvasAssets: CanvasAssetItem[];
  /**
   * 已「加入会话」的节点 id —— 用户右键节点显式加入，表示"接下来这轮我要让 Agent
   * 针对它做操作"。发送消息时会把这些节点的完整定义随上下文交给 LLM，
   * 让它知道「这个节点」到底指谁（否则模型只能靠画布摘要猜）。
   */
  agentFocusNodeIds: string[];
  setFromFlow: (nodes: any[], edges: any[]) => void;
  setSelectedNodeId: (id: string | null) => void;
  setActiveSkillId: (skillId: string | null) => void;
  updateNodeData: (id: string, patch: Record<string, any>) => void;
  getSummary: () => string;
  addAgentFocusNode: (id: string) => void;
  removeAgentFocusNode: (id: string) => void;
  toggleAgentFocusNode: (id: string) => void;
  clearAgentFocusNodes: () => void;
}

function extractAssetsFromNodes(nodes: any[]): CanvasAssetItem[] {
  const assets: CanvasAssetItem[] = [];
  const seenUrls = new Set<string>();

  for (const n of nodes) {
    const d = n.data || {};
    const candidateUrls: Array<{ url?: string; type: 'image' | 'video' | 'audio'; name: string; slotKey?: string }> = [
      { url: d.image_url || d.result_url || d.image, type: 'image', name: `${d.prompt?.slice(0, 10) || '图像'}.png`, slotKey: 'image' },
      { url: d.first_frame || d.first_frame_url, type: 'image', name: '首帧.png', slotKey: 'first_frame' },
      { url: d.last_frame || d.last_frame_url, type: 'image', name: '尾帧.png', slotKey: 'last_frame' },
      { url: d.reference || d.reference_image, type: 'image', name: '参考图.png', slotKey: 'reference' },
      { url: d.video_url, type: 'video', name: `${d.prompt?.slice(0, 10) || '视频'}.mp4`, slotKey: 'video' },
      { url: d.audio_url, type: 'audio', name: `${d.text?.slice(0, 10) || '音频'}.mp3`, slotKey: 'audio' },
    ];

    // Reference images array
    if (Array.isArray(d.reference_images)) {
      d.reference_images.forEach((u: string, idx: number) => {
        candidateUrls.push({ url: u, type: 'image', name: `参考图(${idx + 1}).png`, slotKey: 'reference_images' });
      });
    }

    for (const c of candidateUrls) {
      if (c.url && typeof c.url === 'string' && c.url.trim() && !seenUrls.has(c.url)) {
        seenUrls.add(c.url);
        assets.push({
          id: `asset_${n.id}_${assets.length}_${Date.now()}`,
          name: c.name,
          url: c.url,
          type: c.type,
          sourceNodeId: n.id,
          sourceNodeType: n.type || 'unknown',
          slotKey: c.slotKey,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  return assets;
}

function buildSummary(nodes: any[], edges: any[]): string {
  if (!nodes.length) return '画布为空';
  const lines: string[] = [];
  lines.push(`画布共 ${nodes.length} 节点 ${edges.length} 连线`);
  for (const n of nodes.slice(0, 12)) {
    const d: any = n.data || {};
    const label = n.type || 'unknown';
    const title = d.brief?.slice(0, 30) || d.image_prompt?.slice(0, 30) || d.name || d.prompt?.slice(0, 30) || d.text?.slice(0, 30) || '';
    lines.push(`- [${label}] ${n.id} @(${Math.round(n.position?.x || 0)},${Math.round(n.position?.y || 0)}) ${title ? '“' + title + '”' : ''}`);
  }
  if (nodes.length > 12) lines.push(`… 还有 ${nodes.length - 12} 节点`);
  for (const e of edges.slice(0, 8)) lines.push(`  连线 ${e.source} -> ${e.target}`);
  return lines.join('\n');
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  nodes: [],
  edges: [],
  summary: '画布为空',
  selectedNodeId: null,
  activeSkillId: null,
  canvasAssets: [],
  agentFocusNodeIds: [],
  setFromFlow: (nodes, edges) => {
    const summary = buildSummary(nodes, edges);
    const canvasAssets = extractAssetsFromNodes(nodes);
    // 节点集合被整体替换（切画布/重载）时，顺手剔除已不存在的关注 id，
    // 避免关注列表里留着指向幽灵节点的悬空项。
    const alive = new Set(nodes.map((n) => n.id));
    const keptFocus = get().agentFocusNodeIds.filter((id) => alive.has(id));
    set({ nodes, edges, summary, canvasAssets, agentFocusNodeIds: keptFocus });
  },
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  setActiveSkillId: (skillId) => set({ activeSkillId: skillId }),
  updateNodeData: (id, patch) => {
    const currentNodes = get().nodes;
    const nextNodes = currentNodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
    const canvasAssets = extractAssetsFromNodes(nextNodes);
    set({ nodes: nextNodes, canvasAssets });
    const target = currentNodes.find((n) => n.id === id);
    if (target?.data?.onUpdate) {
      target.data.onUpdate(id, patch);
    }
  },
  getSummary: () => get().summary,
  addAgentFocusNode: (id) => {
    if (!id) return;
    const cur = get().agentFocusNodeIds;
    if (cur.includes(id)) return;
    set({ agentFocusNodeIds: [...cur, id] });
  },
  removeAgentFocusNode: (id) => {
    set({ agentFocusNodeIds: get().agentFocusNodeIds.filter((x) => x !== id) });
  },
  toggleAgentFocusNode: (id) => {
    const cur = get().agentFocusNodeIds;
    set({ agentFocusNodeIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  clearAgentFocusNodes: () => set({ agentFocusNodeIds: [] }),
}));
