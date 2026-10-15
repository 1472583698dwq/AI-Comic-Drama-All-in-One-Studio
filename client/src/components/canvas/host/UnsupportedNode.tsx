// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1「不支持的节点」卡片（design §7 / testing D3）。
 * 迁移后仍不认识的类型（插件已卸载、旧版本独有类型、缺 type 的节点）原样保留在画布 JSON 里，用 kit 外壳渲染成占位卡：
 * 显示原类型与数据键，端口按「已有连线」临时生成（`*` 类型，不可新连），连线照常显示、保存，数据一字不丢。
 */
import { useCallback, useMemo } from 'react';
import { useStore, type NodeProps, type ReactFlowState } from '@xyflow/react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { NodeSkeleton } from '../kit/NodeSkeleton';
import type { PortDef } from '../kit/types';

/** 已有连线 → 占位端口（target 在左、source 在右；空 handle 记为 null 句柄口）。 */
export function portsFromEdges(nodeId: string, edges: ReadonlyArray<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>): PortDef[] {
  const ins = new Set<string>();
  const outs = new Set<string>();
  for (const e of edges) {
    if (e.target === nodeId) ins.add(e.targetHandle ?? '');
    if (e.source === nodeId) outs.add(e.sourceHandle ?? '');
  }
  return [
    ...[...ins].map((id) => ({ id, type: 'target' as const, dataType: '*' as const, label: id || '输入' })),
    ...[...outs].map((id) => ({ id, type: 'source' as const, dataType: '*' as const, label: id || '输出' })),
  ];
}

export function UnsupportedNode(props: NodeProps) {
  const { id, type } = props;
  const sel = useCallback((s: ReactFlowState) => {
    const list = portsFromEdges(id, s.edges);
    return list.map((p) => `${p.type}:${p.id}`).join('|');
  }, [id]);
  const sig = useStore(sel);
  const ports = useMemo<PortDef[]>(() => (sig ? sig.split('|').map((x) => {
    const [side, ...rest] = x.split(':');
    const pid = rest.join(':');
    return { id: pid, type: side as PortDef['type'], dataType: '*', label: pid || (side === 'target' ? '输入' : '输出') };
  }) : []), [sig]);
  const data = (props.data || {}) as Record<string, unknown>;
  const keys = Object.keys(data).filter((k) => typeof data[k] !== 'function');
  const rawType = typeof type === 'string' && type && type !== 'default' ? type : '（无类型）';
  return (
    <NodeSkeleton
      node={{ ...props, isConnectable: false }}
      label={typeof data.label === 'string' && data.label ? data.label : '不支持的节点'}
      icon={IconAlertTriangle}
      ports={ports}
      width={240}
      showToolbar={false}
    >
      <div className="cv-unsupported" role="note">
        <div className="cv-unsupported__title">不支持的节点类型：<code>{rawType}</code></div>
        <div className="cv-unsupported__desc">插件未启用或类型已下线。数据与连线已原样保留，保存时不会丢失。</div>
        {keys.length > 0 && (
          <div className="cv-unsupported__keys" title={keys.join(', ')}>数据：{keys.slice(0, 8).join('、')}{keys.length > 8 ? ` 等 ${keys.length} 项` : ''}</div>
        )}
      </div>
    </NodeSkeleton>
  );
}
