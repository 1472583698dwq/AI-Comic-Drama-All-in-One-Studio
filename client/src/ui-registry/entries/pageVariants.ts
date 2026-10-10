import { useMemo } from 'react';
import { allEntries, useRegistryVersion } from '../registry';
import { pageHost, variantOf } from '../types';
import { VARIANT_META } from './variants';

/**
 * 页面版本查询（设置面板的「前端版本」分区消费）。
 *
 * 单独一个模块的原因：`entries/pages.tsx` 是「组件 + 注册副作用」文件，
 * 再往它导出 hook 会破坏 fast refresh 的约束（react/only-export-components）；
 * 而查询逻辑本身与条目实现无关，放这里两边都干净。
 *
 * 读的是**注册表**而不是 `VARIANT_META` 常量表 —— 面板列出的永远是「真的有条目的版本」，
 * 不会出现「点了却没反应」的选项。
 */

export interface PageVariantOption {
  id: string;
  label: string;
  description: string;
}

export function usePageVariants(pageId: string): PageVariantOption[] {
  const version = useRegistryVersion();
  const registry = useMemo(() => ({ version, list: allEntries() }), [version]);
  return useMemo(() => {
    const host = pageHost(pageId);
    const present = new Set(registry.list.filter((e) => e.host === host).map(variantOf));
    return VARIANT_META
      .filter((m) => present.has(m.id))
      .map((m) => ({ id: m.id, label: m.label, description: m.description }));
  }, [registry, pageId]);
}
