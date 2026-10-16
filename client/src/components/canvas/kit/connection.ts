// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 连线类型校验（对照 Toonflow nodeScaffold/src/connection.ts）。
 * 规则：两端类型有交集或任一端含 `*` 即可连；基础校验通过后再执行「接收端」NodeDef.canConnect 附加规则。
 */
import type { Connection, Edge, IsValidConnection, Node } from '@xyflow/react';
import type { AnyNodeDef, ConnectContext, DataType, IncomingConnection, PortDef } from './types';

function typesOf(dataType: PortDef['dataType'] | undefined | null): string[] {
  if (dataType == null) return [];
  const list = Array.isArray(dataType) ? dataType : [dataType];
  // 兼容 "IMAGE,STRING" 这种逗号写法（Toonflow 同款）
  return list
    .filter((t): t is DataType => typeof t === 'string')
    .flatMap((t) => t.split(','))
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 两个端口的数据类型是否兼容：有交集或含 `*`。 */
export function isTypeCompatible(sourceType: PortDef['dataType'], targetType: PortDef['dataType']): boolean {
  const src = typesOf(sourceType);
  const dst = typesOf(targetType);
  return src.length > 0 && dst.length > 0 && (src.includes('*') || dst.includes('*') || src.some((t) => dst.includes(t)));
}

/** 端口级校验：方向正确（source→target）且类型兼容。 */
export function canConnect(srcPort: PortDef | undefined | null, dstPort: PortDef | undefined | null): boolean {
  if (!srcPort || !dstPort) return false;
  if (srcPort.type !== 'source' || dstPort.type !== 'target') return false;
  return isTypeCompatible(srcPort.dataType, dstPort.dataType);
}

/** 节点实际端口：有 getPorts 用动态端口，否则用静态声明。 */
export function resolvePorts(def: AnyNodeDef | undefined, node?: Pick<Node, 'data'> | null): PortDef[] {
  if (!def) return [];
  if (def.getPorts && node) {
    try {
      const ports = def.getPorts((node.data || {}) as never);
      if (Array.isArray(ports)) return ports;
    } catch (e) {
      console.error(`[kit] ${def.type}.getPorts 失败`, e);
    }
  }
  return def.ports;
}

/** 在节点上按 handle id 找端口（handle id === port id）。 */
export function findPort(def: AnyNodeDef | undefined, node: Pick<Node, 'data'> | undefined | null, handleId: string | null | undefined, side: PortDef['type']): PortDef | undefined {
  const ports = resolvePorts(def, node).filter((p) => p.type === side);
  if (!ports.length) return undefined;
  // 没有 handle id 的连线（旧数据）落到该侧第一个端口
  if (!handleId) return ports[0];
  return ports.find((p) => p.id === handleId);
}

export interface IsValidConnectionOptions {
  /** 拿得到时传入：canConnect 附加规则需要目标节点现有入边。 */
  getEdges?: () => Edge[];
  /** 节点类型未注册 / 端口找不到时是否放行（缺省 true，便于新旧节点混跑；全量接入后可设 false）。 */
  allowUnknown?: boolean;
}

/**
 * 生成 React Flow 的 `isValidConnection`。
 * - 自连拒绝；
 * - 两端都在注册表里：端口类型 + 接收端 NodeDef.canConnect；
 * - 任一端未注册：按 allowUnknown 处理。
 */
export function isValidConnectionFactory(
  getNode: (id: string) => Node | undefined,
  getDef: (type?: string | null) => AnyNodeDef | undefined,
  options: IsValidConnectionOptions = {},
): IsValidConnection {
  const allowUnknown = options.allowUnknown ?? true;
  return (conn: Edge | Connection) => {
    if (!conn.source || !conn.target) return false;
    if (conn.source === conn.target) return false;
    const sourceNode = getNode(conn.source);
    const targetNode = getNode(conn.target);
    if (!sourceNode || !targetNode) return allowUnknown;
    const sourceDef = getDef(sourceNode.type);
    const targetDef = getDef(targetNode.type);
    if (!sourceDef || !targetDef) return allowUnknown;
    const srcPort = findPort(sourceDef, sourceNode, conn.sourceHandle, 'source');
    const dstPort = findPort(targetDef, targetNode, conn.targetHandle, 'target');
    if (!srcPort || !dstPort) return false;
    if (!canConnect(srcPort, dstPort)) return false;
    if (!targetDef.canConnect) return true;
    const editingId = 'id' in conn ? (conn as Edge).id : undefined;
    const incoming: IncomingConnection[] = (options.getEdges?.() || [])
      .filter((e) => e.target === targetNode.id && e.id !== editingId)
      .map((edge) => {
        const node = getNode(edge.source);
        return { edge, node, port: node ? findPort(getDef(node.type), node, edge.sourceHandle, 'source') : undefined };
      });
    const ctx: ConnectContext = { target: targetNode, incoming, getNode };
    try {
      return targetDef.canConnect({ node: sourceNode, port: srcPort }, dstPort, ctx) === true;
    } catch (e) {
      console.error('[kit] 节点连接校验失败', e);
      return false;
    }
  };
}

/** 端口主数据类型（数组取第一个非 `*`），供菜单过滤 / 默认值读取使用。 */
export function primaryDataType(dataType: PortDef['dataType']): Exclude<DataType, '*'> | undefined {
  return typesOf(dataType).find((t) => t !== '*') as Exclude<DataType, '*'> | undefined;
}

/** 端口类型的可读描述（handle title / aria-label 用）。 */
export function describeDataType(dataType: PortDef['dataType']): string {
  return typesOf(dataType).join(' / ');
}
