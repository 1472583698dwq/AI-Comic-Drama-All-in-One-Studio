// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 端口渲染与磁吸（对照 Toonflow nodeSkeleton.vue 的 handle 部分）。
 * - 左入右出，按数量均分：top = (i+1)/(n+1)；距卡片 −12px；18×18；
 * - 平时透明，节点悬停 / 已连接 / 正在拖线时显示；未连虚线圈、已连实心圈；
 * - 可连主色、不可连危险色（React Flow 的 connectingto / valid 类）；
 * - 悬停磁吸偏移 ≤6px（120ms ease-out），命中区外扩 13px。
 * handle id === port id。
 */
import { memo, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, useNodeId, useStore, type IsValidConnection, type ReactFlowState } from '@xyflow/react';
import { IconCircleDashed, IconCircleDot } from '@tabler/icons-react';
import type { PortDef } from './types';
import { describeDataType } from './connection';

export interface NodeHandlesProps {
  ports: readonly PortDef[];
  /** 缺省取所在节点（useNodeId）。 */
  nodeId?: string;
  connectable?: boolean;
  /** 单个 handle 级的连线校验（一般不需要：宿主在 <ReactFlow isValidConnection> 上统一校验）。 */
  isValidConnection?: IsValidConnection;
}

/** 计算已连接端口集合，返回稳定字符串（useStore 用 === 比较即可）。 */
export function connectedPortsKey(s: Pick<ReactFlowState, 'connectionLookup'>, nodeId: string, ports: readonly PortDef[]): string {
  const out: string[] = [];
  for (const side of ['target', 'source'] as const) {
    const sidePorts = ports.filter((p) => p.type === side);
    if (!sidePorts.length) continue;
    // 旧数据里没有 handle id 的连线落到该侧第一个端口
    let nullHandle = false;
    for (const c of s.connectionLookup.get(`${nodeId}-${side}`)?.values() ?? []) {
      if ((side === 'target' ? c.targetHandle : c.sourceHandle) == null) { nullHandle = true; break; }
    }
    sidePorts.forEach((p, i) => {
      if (s.connectionLookup.get(`${nodeId}-${side}-${p.id}`)?.size || (i === 0 && nullHandle)) out.push(`${side}:${p.id}`);
    });
  }
  return out.join('|');
}

function moveHandle(event: ReactPointerEvent<HTMLDivElement>) {
  if (event.pointerType === 'touch') return;
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // 以 handle 中心为原点、按 18px 归一（自动抵消画布缩放），总偏移半径限制在 6px 内（Toonflow 同款）
  const x = ((event.clientX - rect.left - rect.width / 2) / rect.width) * 18;
  const y = ((event.clientY - rect.top - rect.height / 2) / rect.height) * 18;
  const strength = Math.min(0.3, 6 / (Math.hypot(x, y) || 1));
  el.style.setProperty('--cv-hx', `${x * strength}px`);
  el.style.setProperty('--cv-hy', `${y * strength}px`);
}

function resetHandle(event: ReactPointerEvent<HTMLDivElement>) {
  event.currentTarget.style.removeProperty('--cv-hx');
  event.currentTarget.style.removeProperty('--cv-hy');
}

function NodeHandlesImpl({ ports, nodeId: nodeIdProp, connectable = true, isValidConnection }: NodeHandlesProps) {
  const ctxId = useNodeId();
  const nodeId = nodeIdProp ?? ctxId ?? '';
  const selector = useCallback((s: ReactFlowState) => connectedPortsKey(s, nodeId, ports), [nodeId, ports]);
  const connectedKey = useStore(selector);
  const connected = new Set(connectedKey ? connectedKey.split('|') : []);

  const groups = [
    { side: 'target' as const, position: Position.Left, items: ports.filter((p) => p.type === 'target') },
    { side: 'source' as const, position: Position.Right, items: ports.filter((p) => p.type === 'source') },
  ];

  return (
    <>
      {groups.map((g) => g.items.map((port, index) => {
        const isConnected = connected.has(`${g.side}:${port.id}`);
        const title = `${port.label ?? port.id} · ${describeDataType(port.dataType)}`;
        const Icon = isConnected ? IconCircleDot : IconCircleDashed;
        return (
          <Handle
            key={`${g.side}:${port.id}`}
            id={port.id}
            type={g.side}
            position={g.position}
            isConnectable={connectable}
            isValidConnection={isValidConnection}
            className={['cv-handle', isConnected ? 'is-connected' : ''].filter(Boolean).join(' ')}
            style={{ top: `${((index + 1) / (g.items.length + 1)) * 100}%` }}
            title={title}
            aria-label={title}
            data-port={port.id}
            data-datatype={describeDataType(port.dataType)}
            onPointerMove={moveHandle}
            onPointerLeave={resetHandle}
            onPointerCancel={resetHandle}
          >
            <Icon className="cv-handle__icon" size={18} aria-hidden />
          </Handle>
        );
      }))}
    </>
  );
}

export const NodeHandles = memo(NodeHandlesImpl);

/** 卡片最小高度：max(100, (单侧最多端口数 + 1) × 44)（Toonflow 同款）。 */
export function cardMinHeight(ports: readonly PortDef[]): number {
  const targets = ports.filter((p) => p.type === 'target').length;
  const sources = ports.filter((p) => p.type === 'source').length;
  return Math.max(100, (targets + 1) * 44, (sources + 1) * 44);
}
