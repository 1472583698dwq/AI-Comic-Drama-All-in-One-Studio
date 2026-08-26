import { create } from 'zustand';

interface CanvasStore {
  nodes: any[];
  edges: any[];
  summary: string; // 压缩摘要供 Agent 使用
  setFromFlow: (nodes: any[], edges: any[]) => void;
  getSummary: () => string;
}

function buildSummary(nodes: any[], edges: any[]): string {
  if (!nodes.length) return '画布为空';
  const lines: string[] = [];
  lines.push(`画布共 ${nodes.length} 节点 ${edges.length} 连线`);
  for (const n of nodes.slice(0, 12)) {
    const d: any = n.data || {};
    const label = n.type || 'unknown';
    const title = d.brief?.slice(0, 30) || d.image_prompt?.slice(0, 30) || d.name || d.prompt?.slice(0, 30) || '';
    lines.push(`- [${label}] ${n.id} @(${Math.round(n.position.x)},${Math.round(n.position.y)}) ${title ? '“'+title+'”' : ''}`);
  }
  if (nodes.length > 12) lines.push(`… 还有 ${nodes.length-12} 节点`);
  for (const e of edges.slice(0, 8)) lines.push(`  连线 ${e.source} -> ${e.target}`);
  return lines.join('\n');
}

export const useCanvasStore = create<CanvasStore>((set, get)=> ({
  nodes: [],
  edges: [],
  summary: '画布为空',
  setFromFlow: (nodes, edges) => {
    const summary = buildSummary(nodes, edges);
    set({ nodes, edges, summary });
  },
  getSummary: () => get().summary,
}));
