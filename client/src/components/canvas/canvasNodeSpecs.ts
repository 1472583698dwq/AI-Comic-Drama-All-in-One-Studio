// -*- coding: utf-8 -*-
/**
 * 声明式画布节点（canvas_nodes）前端注册表 — 插件前端扩展点。
 * 后端 spec（inputs/outputs/params_schema + run.extension）→ 本地缓存 →
 * 通用节点组件（ExtNode）按声明渲染，无需插件提供任何前端代码。
 */
import { apiService } from '../../services/api';

export type CanvasNodePortType = 'image' | 'video' | 'audio' | 'text' | 'any';

export interface CanvasNodePort {
  id: string;
  label?: string;
  type?: CanvasNodePortType;
  required?: boolean;
  description?: string;
  /** 输出端口专用：结果字段名（缺省与 id 同名） */
  from?: string;
}

export interface CanvasNodeSpec {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  kind?: 'image' | 'video' | 'audio' | 'utility' | 'text';
  enabled?: boolean;
  inputs?: CanvasNodePort[];
  outputs?: CanvasNodePort[];
  params_schema?: Record<string, any>;
  run?: Record<string, any>;
}

const _specs = new Map<string, CanvasNodeSpec>();

export function registerCanvasNodeSpec(spec: CanvasNodeSpec): void {
  if (!spec?.id) return;
  _specs.set(spec.id, spec);
}

export function unregisterCanvasNodeSpec(id: string): void {
  _specs.delete(id);
}

export function clearCanvasNodeSpecs(): void {
  _specs.clear();
}

export function listCanvasNodeSpecs(): CanvasNodeSpec[] {
  return [..._specs.values()];
}

export function getCanvasNodeSpec(id?: string): CanvasNodeSpec | undefined {
  return id ? _specs.get(id) : undefined;
}

/** 拉取后端有效声明并整体重载本地注册表（注册即 effect，重载先清空；按项目过滤停用项）。 */
export async function syncCanvasNodeSpecs(projectId?: string): Promise<number> {
  const res: any = await apiService.listCanvasNodes(projectId);
  const specs: CanvasNodeSpec[] = res?.nodes || [];
  clearCanvasNodeSpecs();
  let n = 0;
  for (const s of specs) {
    if (s?.id && s.enabled !== false) {
      registerCanvasNodeSpec(s);
      n++;
    }
  }
  return n;
}
