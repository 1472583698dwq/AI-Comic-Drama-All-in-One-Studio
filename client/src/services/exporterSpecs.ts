// -*- coding: utf-8 -*-
/**
 * 插件导出器注册表（exporters 扩展点）：声明式导出目标 → 导出中心消费。
 */
import { apiService } from './api';

export interface ExporterInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  accepts?: string[];
  run?: Record<string, any>;
  enabled?: boolean;
}

const _items = new Map<string, ExporterInfo>();

export function listExporterSpecs(): ExporterInfo[] {
  return [..._items.values()];
}

export function getExporterSpec(id?: string): ExporterInfo | undefined {
  return id ? _items.get(id) : undefined;
}

export async function syncExporterSpecs(projectId?: string): Promise<number> {
  const res: any = await apiService.listExporters(projectId);
  const exporters: ExporterInfo[] = res?.exporters || [];
  _items.clear();
  let n = 0;
  for (const e of exporters) {
    if (e?.id && e.enabled !== false) {
      _items.set(e.id, e);
      n++;
    }
  }
  return n;
}
