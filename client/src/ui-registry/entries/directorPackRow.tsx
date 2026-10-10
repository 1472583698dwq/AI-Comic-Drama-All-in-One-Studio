import React from 'react';
import { useDirectorPackBridge } from '../directorPackBridge';
import { markAttrs } from '../types';
import type { DirectorPackEnv, DirectorPackProp } from '../../components/director3d/directorPackSpecs';

/**
 * **导演包（`director_packs` 扩展点）的两类行**（设计 §12 规则 1 / 2 的第四个落地样本）：
 *   · `PackPropRow` —— `props`：GLB 道具开关（按下改舞台的 `propsConfig`，进而重建场景 / 装配 GLB）；
 *   · `PackEnvRow`  —— `environments`：背景底图环境（按下改 `packEnvId` + 场景描述）。
 *
 * 标签与子标题的取法与改造前逐字一致（`icon || '🧩'`、`glb_url` 取文件名兜底）。
 * **自标**：两个宿主都是 CSS grid 的子元素，槽位不加包裹层（`UISlot` 的
 * `NO_MARK_WRAPPER_HOSTS`），标记属性直接落在按钮根元素上。
 *
 * 选中态从桥接读（`isPropOn` / `activeEnvironmentId`）—— 行 UI 由条目渲染，状态必须一起注入。
 */

export const PackPropRow: React.FC<{ spec: DirectorPackProp }> = ({ spec }) => {
  const { toggleProp, isPropOn } = useDirectorPackBridge();
  const active = isPropOn(spec.id);
  return (
    <button
      onClick={() => toggleProp(spec.id)}
      className={`p-2.5 rounded-xl border text-left flex items-center space-x-2 transition-all ${active ? 'bg-brand/20 border-brand text-white shadow-md' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}
      {...markAttrs({ id: `director3d.props.${spec.id}`, kind: 'panel', source: 'plugin:director-pack' })}
    >
      <span className="text-base">{spec.icon || '🧩'}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold truncate">{spec.label}</div>
        <div className="text-[9px] text-gray-500 truncate">{spec.glb_url.split('/').pop() || '插件 GLB'}</div>
      </div>
    </button>
  );
};

export const PackEnvRow: React.FC<{ spec: DirectorPackEnv }> = ({ spec }) => {
  const { applyEnvironment, activeEnvironmentId } = useDirectorPackBridge();
  const active = activeEnvironmentId === spec.id;
  return (
    <button
      onClick={() => applyEnvironment(spec.id)}
      className={`p-2.5 rounded-xl border text-left transition-all ${active ? 'bg-accent-green/20 border-accent-green text-white shadow-md ring-1 ring-accent-green' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}
      {...markAttrs({ id: `director3d.env.${spec.id}`, kind: 'panel', source: 'plugin:director-pack' })}
    >
      <div className="text-xs font-bold flex items-center space-x-1"><span>{spec.icon || '🧩'}</span><span>{spec.label}</span></div>
      <div className="text-[9px] text-gray-500 mt-0.5">{spec.desc || spec.id}</div>
    </button>
  );
};

export default PackPropRow;
