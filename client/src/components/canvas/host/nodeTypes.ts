// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas FX-2：画布的 nodeTypes（传给 `<ReactFlow nodeTypes>`）。
 *
 * 注册表组件 + 不认识的类型（含无类型 → default）一律「不支持的节点」卡片。
 * 引用只随注册表版本变化（kit nodeTypesMap 模块级缓存 + 这里按注册表版本 useMemo），
 * 与画布里有哪些节点无关：Agent 改画布 / 旧画布迁移让未知类型出现或消失时，不再换对象，
 * React Flow 不报「created a new nodeTypes object」（error002），节点组件也不会重挂载。
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { NodeTypes } from '@xyflow/react';
import { nodeTypesMap, registryVersion, subscribeRegistry } from '../kit/registry';
import { UnsupportedNode } from './UnsupportedNode';

/** 当前注册表下的画布 nodeTypes（同一注册表版本返回同一个对象）。 */
export function canvasNodeTypes(): NodeTypes {
  return nodeTypesMap(UnsupportedNode);
}

/** React 侧：订阅注册表版本，版本不变就是同一个对象。 */
export function useCanvasNodeTypes(): NodeTypes {
  const version = useSyncExternalStore(subscribeRegistry, registryVersion, registryVersion);
  return useMemo(() => canvasNodeTypes(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
}
