// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 节点共用 hooks：入边状态订阅、执行（带声明端口上的上游值）、定义缓存订阅、扩展声明懒取、AI 润色入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, useStore, type ReactFlowState } from '@xyflow/react';
import { AiPolishButton } from '../../../ui/AiPolishButton';
import { apiService } from '../../../../services/api';
import { toast } from '../../../../stores/useDialogStore';
import { useKitNodeActions } from '../../kit/hostContext';
import { getCanvasNodeSpec, registerCanvasNodeSpec, type CanvasNodeSpec } from '../../canvasNodeSpecs';
import { customNodeDefsVersion, subscribeCustomNodeDefs } from './customNodeDefs';
import { collectDynamicInputs, dynamicInputStates, type PortInputState } from './inputs';

/**
 * 订阅本节点入边，算出每个输入口的连线数与当前上游值（与执行 / 传播同一套 inputs.ts 规则）。
 * `version` 变化时强制重算（自定义节点定义 / 扩展声明晚到时端口会变，但 React Flow store 没变）。
 */
export function useDynamicInputStates(nodeId: string, version: number = 0): Record<string, PortInputState> {
  const selector = useCallback((s: ReactFlowState) => {
    const target = s.nodeLookup.get(nodeId);
    if (!target || version < 0) return '';
    const st = dynamicInputStates(target, s.edges, (id) => s.nodeLookup.get(id));
    return Object.keys(st).length ? JSON.stringify(st) : '';
  }, [nodeId, version]);
  const key = useStore(selector);
  return useMemo(() => (key ? (JSON.parse(key) as Record<string, PortInputState>) : {}), [key]);
}

/**
 * 执行：仍走宿主原有分支（useKitNodeActions(id).execute → CreativeCanvas 的 /canvas/node/execute 或 /custom-nodes/run），
 * 另把 collectDynamicInputs 算出的「声明端口 id → 上游值」作为本次 overrides 交给宿主——
 * 即使宿主还没按端口 id 传播（design §6.2 ① 的旧问题），后端按端口 id 也能取到值。
 */
export function useRunWithInputs(nodeId: string) {
  const rf = useReactFlow();
  const actions = useKitNodeActions(nodeId);
  const [running, setRunning] = useState(false);
  const run = useCallback(async (extra?: Record<string, unknown>) => {
    if (running) return;
    const node = rf.getNode(nodeId);
    const inputs = collectDynamicInputs(node, rf.getEdges(), (id) => rf.getNode(id));
    setRunning(true);
    try {
      await actions.execute({ ...inputs, ...(extra || {}) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e || '执行失败'));
    } finally {
      setRunning(false);
    }
  }, [running, rf, nodeId, actions]);
  return { running, run };
}

/** 订阅自定义节点定义缓存（定义晚到时端口 / 参数要跟着变）。 */
export function useCustomNodeDefsVersion(): number {
  const [v, setV] = useState(customNodeDefsVersion());
  useEffect(() => subscribeCustomNodeDefs(() => setV(customNodeDefsVersion())), []);
  return v;
}

/**
 * 扩展节点声明懒取：全局注册表没有时拉 /canvas-nodes/{id} 并登记（声明只有一份来源，同旧组件第 26 条）。
 * 返回 version（登记后 +1，触发端口重算）与状态：idle（已有 / 无 id）、loading、missing（插件未启用 / 已卸载）。
 */
export function useExtSpec(cid: string): { version: number; state: 'idle' | 'loading' | 'missing' } {
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState('');
  const known = !!cid && !!getCanvasNodeSpec(cid);
  useEffect(() => {
    if (!cid || getCanvasNodeSpec(cid)) return;
    let stop = false;
    apiService.getCanvasNode(cid)
      .then((res: any) => {
        const got: CanvasNodeSpec = res?.node || res;
        if (!got?.id) throw new Error('empty');
        registerCanvasNodeSpec(got);
        if (!stop) setVersion((v) => v + 1);
      })
      .catch(() => { if (!stop) setFailed(cid); });
    return () => { stop = true; };
  }, [cid]);
  const state = !cid || known ? 'idle' : failed === cid ? 'missing' : 'loading';
  return { version, state };
}

const stop = (e: SyntheticEvent) => e.stopPropagation();
const PORTAL_GUARDS = {
  onPointerDown: stop, onMouseDown: stop, onClick: stop, onDoubleClick: stop, onKeyDown: stop, onWheel: stop, onContextMenu: stop,
};

/**
 * AI 润色（复用 AiPolishButton 的完整弹窗：技能选择 / 定制要求 / 对比 / 应用）。
 * 组件挂到 body（不随画布缩放、不被节点 transform 影响），自带的触发按钮隐藏，由节点里的按钮调 `open()` 打开；
 * 门户里的合成事件不冒泡回节点（否则会触发节点选中 / 双击聚焦 / 右键菜单）。
 */
export function usePolish(value: string, onPolish: (v: string) => void, opts: { contextType?: 'prompt' | 'dialogue' | 'general'; label?: string } = {}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const open = useCallback(() => {
    hostRef.current?.querySelector<HTMLButtonElement>(':scope > button')?.click();
  }, []);
  const portal = typeof document === 'undefined' ? null : createPortal(
    <div ref={hostRef} className="cv-lb-polish-host" {...PORTAL_GUARDS}>
      <AiPolishButton value={value} onPolish={(v: string) => onPolish(v)} contextType={opts.contextType ?? 'general'} size="xs" label={opts.label ?? 'AI 润色'} />
    </div>,
    document.body,
  );
  return { open, portal };
}
