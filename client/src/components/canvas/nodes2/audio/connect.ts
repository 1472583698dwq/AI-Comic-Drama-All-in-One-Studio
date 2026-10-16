// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频生成节点的连线限制（Toonflow audioGenerationNode `canConnect`）：
 * 输入口 `in` 接 IMAGE / AUDIO / STRING；图片与音频参考**合计最多 1 个**，文本不限。
 *
 * 参考类型判断与参考列表一致（kit/references.inferEdgeDataType：sourceHandle → 来源类型 → 产物键 → 端口声明），
 * 未产出内容的上游按声明类型占位（同 Toonflow）。与 Toonflow 的差异：只拦「会让图片 + 音频超过 1 个」的新连线，
 * 已经超限的旧画布（迁移 / Agent 写入）仍允许再连文本参考，面板里提示并禁止生成。
 */
import type { Edge, Node } from '@xyflow/react';
import type { ConnectContext, ConnectSource, DataType, PortDef, RefItem } from '../../kit/types';
import { inferEdgeDataType } from '../../kit/references';
import { isRefEdge, edgeKey } from '../../kit/inputRules';

export const AUDIO_GEN_IN_PORT = 'in';
/** 图片 + 音频参考合计上限。 */
export const MEDIA_REF_LIMIT = 1;
const LIMITED: readonly DataType[] = ['IMAGE', 'AUDIO'];

function declaredType(port: PortDef | undefined): DataType | undefined {
  if (!port) return undefined;
  const list = (Array.isArray(port.dataType) ? port.dataType : [port.dataType])
    .flatMap((t) => String(t).split(','))
    .map((t) => t.trim())
    .filter((t) => t && t !== '*');
  return list.length === 1 ? (list[0] as DataType) : undefined;
}

/** 一条（将要成立的）参考是不是图片 / 音频。 */
export function isLimitedMediaRef(node: Pick<Node, 'type' | 'data'> | undefined, sourceHandle: string | null | undefined, port?: PortDef): boolean {
  const kind = (node ? inferEdgeDataType(node, sourceHandle) : undefined) ?? declaredType(port);
  return !!kind && LIMITED.includes(kind);
}

/** 参考列表里图片 + 音频的个数（面板校验用）。 */
export function countMediaRefs(refs: readonly Pick<RefItem, 'dataType'>[]): number {
  return refs.filter((r) => LIMITED.includes(r.dataType)).length;
}

/** NodeDef.canConnect：接收端附加规则（基础类型校验已通过）。 */
export function audioGenCanConnect(src: ConnectSource, dst: PortDef, ctx: ConnectContext): boolean {
  if (dst.id !== AUDIO_GEN_IN_PORT) return true;
  if (!isLimitedMediaRef(src.node, src.port.id, src.port)) return true;
  const newKey = edgeKey(src.node.id, src.port.id);
  const seen = new Set<string>();
  let media = 0;
  for (const inc of ctx.incoming) {
    const edge = inc.edge as Edge;
    const key = edgeKey(edge);
    // 同一来源输出口重复连（或重验已有连线）不重复计数
    if (key === newKey || seen.has(key)) continue;
    seen.add(key);
    if (!isRefEdge(edge.targetHandle, ctx.target.type, inc.node?.type)) continue;
    if (isLimitedMediaRef(inc.node, edge.sourceHandle, inc.port)) media++;
  }
  return media + 1 <= MEDIA_REF_LIMIT;
}
