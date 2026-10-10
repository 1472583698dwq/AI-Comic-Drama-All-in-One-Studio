import { createElement, type ComponentType } from 'react';
import { register, unregisterSource } from '../registry';
import { DIRECTOR_ENVS_HOST, DIRECTOR_PROPS_HOST } from '../types';
import { PackEnvRow, PackPropRow } from '../entries/directorPackRow';
import type { DirectorPackEnv, DirectorPackProp } from '../../components/director3d/directorPackSpecs';

/**
 * **导演包（`director_packs` 扩展点）→ UIRegistry 适配器**
 * （设计 §12 桥接的第四个落地样本，§12.4-4）。
 *
 * 收敛前：`Director3DStage` 自己把 `listDirectorPackProps()` 合并进道具面板的
 * `propOptions`、把 `listDirectorPackEnvironments()` 直接 map 成环境按钮 ——
 * 插件增删只能靠 `packRev` 重算 / 重挂舞台（而这台舞台挂着 three.js 场景，重挂很贵）。
 *
 * 收敛后：
 *   · 每个插件道具 / 环境是 `director3d.props` / `director3d.environments` 的一条条目
 *     （`meta` 留原始声明）；
 *   · 「按下后做什么」由宿主经 `DirectorPackBridgeContext` 注入（只有舞台持有场景 / 镜头：
 *     道具改 `propsConfig`、环境改 `packEnvId`），条目只报 id；
 *   · `syncDirectorPacks()` 完成后调一次 `syncDirectorPackEntries()` 即可，行的增删立即可见。
 *
 * **边界（有意不收敛）**：`director_packs.presets`（framing / motion / pose / cast）不是
 * 「一组行」，而是被 `applyDirectorPackPresets()` 合并进舞台与画布节点**共用**的同源数组
 * （`directorPresets`）的数据；它没有独立的 UI 挂载点，硬条目化反而会拆散那份同源契约
 * （见 `directorPackSpecs.ts` 顶部注释与设计 §12.2 的边界说明）。
 *
 * 本文件只导出函数（Fast-refresh 约定）：桥接在 `ui-registry/directorPackBridge.ts`、
 * 行组件在 `ui-registry/entries/directorPackRow.tsx`。
 */

/** 每个声明一个**稳定**的组件类型（同一个声明只创建一次，避免重注册时整棵重建） */
const makeRow = <P,>(Row: ComponentType<{ spec: P }>, spec: P, name: string): ComponentType => {
  const Bound: ComponentType = () => createElement(Row, { spec });
  const id = (spec as any)?.id ?? '?';
  Bound.displayName = `${name}(${id})`;
  return Bound;
};

/**
 * **来源命名空间**：导演包都来自插件包 → 统一的外部贡献命名空间。
 * 回滚走注册表的 `unregisterSource(source, hostPrefix)`（未完成清单第 9 条）。
 */
const DIRECTOR_PACK_SOURCE = 'plugin:director-pack' as const;

/** 回滚**作用域**（审查 L8）：只清本适配器登记的两个挂载点（道具 / 环境各一个 host） */
const DIRECTOR_PROPS_HOST_PREFIX = DIRECTOR_PROPS_HOST;
const DIRECTOR_ENVS_HOST_PREFIX = DIRECTOR_ENVS_HOST;

/**
 * 用最新的两份清单**替换**导演包条目。
 * 顺序与改造前一致：道具（order 200+）在前、环境（order 300+）在后；
 * 两类落在各自的挂载点，槽位不混。
 */
export function syncDirectorPackEntries(props: DirectorPackProp[], envs: DirectorPackEnv[]): void {
  clearDirectorPackEntries();
  const rows = [
    ...(props || []).map((spec, i) => ({
      id: `director3d.props.${spec.id}`,
      host: DIRECTOR_PROPS_HOST,
      order: 200 + i,
      meta: { packProp: spec },
      render: makeRow(PackPropRow, spec, 'PackPropRow'),
    })),
    ...(envs || []).map((spec, i) => ({
      id: `director3d.env.${spec.id}`,
      host: DIRECTOR_ENVS_HOST,
      order: 300 + i,
      meta: { packEnv: spec },
      render: makeRow(PackEnvRow, spec, 'PackEnvRow'),
    })),
  ];
  rows.forEach((r) => register({
    id: r.id,
    kind: 'panel',
    host: r.host,
    order: r.order,
    // 导演包装载失败不影响宿主
    source: DIRECTOR_PACK_SOURCE,
    meta: r.meta,
    render: r.render,
  }));
}

/** 清空导演包条目（舞台卸载时调用，别在注册表里留下陈旧行） */
export function clearDirectorPackEntries(): void {
  unregisterSource(DIRECTOR_PACK_SOURCE, DIRECTOR_PROPS_HOST_PREFIX);
  unregisterSource(DIRECTOR_PACK_SOURCE, DIRECTOR_ENVS_HOST_PREFIX);
}
