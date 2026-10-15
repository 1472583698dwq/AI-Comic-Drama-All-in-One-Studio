// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 节点内嵌 3D 舞台的生命周期与「节点 data ⇄ 舞台」同步。
 *
 * 生命周期（省 GPU）：
 * - 懒挂载：节点进入画布可视区（IntersectionObserver，root = .react-flow）或被选中时才创建舞台；
 * - 离开可视区且未选中：停止预览，RELEASE_DELAY_MS 后冻结最后一帧并销毁（释放 WebGL 上下文）；
 * - 名额：stageBudget 限制同时存活的舞台数，被挤掉的节点冻结成截图，选中 / 重新进入视口 / 点击占位再恢复；
 * - WebGL 上下文丢失：同样冻结并等待用户点击恢复；卸载时 dispose。
 *
 * 同步（data 是唯一真源）：站位 / 姿态 / 自定义关节 → setCast；景别 → 预设机位；焦距 / 荷兰角 → 改 FOV / roll；
 * 机位被外部改写（撤销等）→ setCameraState；环境、画幅同理。舞台里的拖关节 / 环绕结果写回 data（mannequin_pose / camera_state）。
 *
 * 画布缩放：React Flow 用 CSS transform 缩放画布。关节拾取由 stageCore 按「屏幕 rect / 布局尺寸」换算，任意缩放比都准
 * （REQ-toonflow-canvas C1 修复，去掉了原先「容器宽高 × zoom 再 scale(1/zoom)」的反向缩放绕法）；
 * 这里只按 zoom 调像素比，让画面放大时依然清晰、缩小时不浪费像素（绘制缓冲像素总量封顶 MAX_STAGE_PIXELS）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useStoreApi } from '@xyflow/react';
import { focalLengthToFov } from '../../../director3d/scene/presets';
import type { MannequinPose } from '../../../../types';
import { loadStageModule, type MiniStage, type StageModule } from './stageLoader';
import { acquireStageSlot, touchStageSlot } from './stageBudget';
import { isValidCamera, readStageParams, roundCamera, type Director3DData, type StageParams } from './model';

/** 离开可视区多久后销毁舞台 */
export const RELEASE_DELAY_MS = 4000;
/** 单个舞台绘制缓冲像素上限（放大画布时按此压低像素比） */
export const MAX_STAGE_PIXELS = 1_600_000;

export type StageStatus = 'idle' | 'loading' | 'ready' | 'suspended' | 'over-budget' | 'error';

/**
 * 舞台像素比：设备像素比（上限 2）× 画布缩放，再按 MAX_STAGE_PIXELS 封顶。
 * width / height 是舞台的布局尺寸（未缩放）；zoom 是 React Flow 画布缩放（屏幕上实际显示 = 布局 × zoom）。
 */
export function stagePixelRatio(width: number, height: number, dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, zoom = 1): number {
  const base = Math.min(dpr, 2) * (zoom > 0 ? zoom : 1);
  const cap = Math.sqrt(MAX_STAGE_PIXELS / Math.max(1, width * height));
  return Math.max(0.25, Math.min(base, cap));
}

export function poseEntitiesOf(data: Director3DData): MannequinPose['entities'] | undefined {
  const pose = data.mannequin_pose;
  if (!pose || typeof pose !== 'object') return undefined;
  const entities = (pose as MannequinPose).entities;
  return entities && typeof entities === 'object' ? entities : undefined;
}

function cameraJson(data: Director3DData): string {
  return isValidCamera(data.camera_state) ? JSON.stringify(roundCamera(data.camera_state)) : '';
}

interface Applied {
  castLayout: string;
  pose: string;
  poseJson: string;
  framing: string;
  focal: number;
  roll: number;
  camJson: string;
  env: string;
  aspect: number;
}

export interface UseDirectorStageOptions {
  nodeId: string;
  selected: boolean;
  data: Director3DData;
  params: StageParams;
  update: (patch: Record<string, unknown>) => void;
  /** 舞台外框（IntersectionObserver 观察对象） */
  boxRef: RefObject<HTMLElement | null>;
  /** 舞台画布挂载点（不放 React 子元素） */
  hostRef: RefObject<HTMLDivElement | null>;
  /** 导出 / 预览进行中：即使离开视口也不卸载、不被名额淘汰 */
  keepAlive?: boolean;
}

export interface DirectorStage {
  status: StageStatus;
  error: string;
  /** 舞台卸载前冻结的最后一帧（dataURL），占位时显示 */
  snapshot: string;
  /** 当前画布缩放（= React Flow zoom，防抖 150ms；只用来定像素比） */
  zoom: number;
  visible: boolean;
  selectedJoint: { entity: string; jointId: string } | null;
  stageRef: RefObject<MiniStage | null>;
  modRef: RefObject<StageModule | null>;
  /** 用户明确要舞台（点占位 / 重试） */
  activate: () => void;
  /** 有交互时刷新名额活跃时间 */
  touch: () => void;
}

export function useDirectorStage(opts: UseDirectorStageOptions): DirectorStage {
  const { nodeId, selected, data, params: p, boxRef, hostRef } = opts;
  const dataRef = useRef(data);
  dataRef.current = data;
  const updateRef = useRef(opts.update);
  updateRef.current = opts.update;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const keepAlive = !!opts.keepAlive;
  const keepAliveRef = useRef(keepAlive);
  keepAliveRef.current = keepAlive;

  const stageRef = useRef<MiniStage | null>(null);
  const modRef = useRef<StageModule | null>(null);
  const appliedRef = useRef<Applied | null>(null);

  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [suspended, setSuspended] = useState(false);
  const [overBudget, setOverBudget] = useState(false);
  const [failed, setFailed] = useState('');
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState('');
  const [selectedJoint, setSelectedJoint] = useState<{ entity: string; jointId: string } | null>(null);

  // —— 画布缩放（订阅 store，不随每帧缩放重渲染；只用来定像素比）——
  const store = useStoreApi();
  const [zoom, setZoom] = useState(() => store.getState().transform[2] || 1);
  useEffect(() => {
    let timer = 0;
    let last = store.getState().transform[2] || 1;
    setZoom(last);
    const unsub = store.subscribe((s) => {
      const z = s.transform[2] || 1;
      if (z === last) return;
      last = z;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setZoom(z), 150);
    });
    return () => { unsub(); window.clearTimeout(timer); };
  }, [store]);

  // —— 可见性 ——
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return undefined; }
    const root = el.closest('.react-flow');
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setVisible(last.isIntersecting);
    }, { root, rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [boxRef]);

  // 重新进入视口 / 被选中：解除「被挤掉 / 名额不足」
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisibleRef.current) { setSuspended(false); setOverBudget(false); }
    prevVisibleRef.current = visible;
  }, [visible]);
  useEffect(() => {
    if (!selected) return;
    setSuspended(false);
    setOverBudget(false);
    touchStageSlot(nodeId);
  }, [selected, nodeId]);

  const want = (selected || visible || keepAlive) && !suspended && !overBudget && !failed;
  useEffect(() => {
    if (want) {
      if (!live) setLive(true);
      return undefined;
    }
    if (!live) return undefined;
    // 被挤掉 / 出错立即卸载；只是离开视口则延迟（来回滚动不反复重建）
    const delay = suspended || overBudget || failed ? 0 : RELEASE_DELAY_MS;
    const t = window.setTimeout(() => setLive(false), delay);
    return () => window.clearTimeout(t);
  }, [want, live, suspended, overBudget, failed]);

  // —— 创建 / 销毁 ——
  useEffect(() => {
    if (!live) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    const release = acquireStageSlot(nodeId, {
      isPinned: () => selectedRef.current || keepAliveRef.current,
      evict: () => { setSuspended(true); setLive(false); },
    });
    if (!release) {
      setOverBudget(true);
      setLive(false);
      return undefined;
    }
    let cancelled = false;
    let lost = false;
    let stage: MiniStage | null = null;
    let canvas: HTMLCanvasElement | null = null;
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      setSuspended(true);
      setLive(false);
    };
    loadStageModule().then((mod) => {
      if (cancelled) return;
      const d = dataRef.current;
      const params = readStageParams(d);
      const entities = poseEntitiesOf(d);
      const s = mod.createMiniStage(host, {
        environment: params.environment,
        castLayout: params.castLayout,
        pose: params.pose,
        camera: isValidCamera(d.camera_state) ? d.camera_state : undefined,
        framing: params.framing,
        focalLength: params.focalLength,
        cameraRoll: params.roll,
        aspect: params.aspect,
        pixelRatio: stagePixelRatio(host.clientWidth, host.clientHeight, undefined, store.getState().transform[2] || 1),
        onJointsChange: () => {
          const cur = stageRef.current;
          if (!cur) return;
          const pose = cur.getMannequinPose();
          if (appliedRef.current) appliedRef.current.poseJson = JSON.stringify(pose.entities ?? null);
          updateRef.current({ mannequin_pose: pose });
        },
        onCameraChange: (state) => {
          const r = roundCamera(state);
          if (appliedRef.current) appliedRef.current.camJson = JSON.stringify(r);
          updateRef.current({ camera_state: r });
        },
        onSelect: (entity, jointId) => {
          touchStageSlot(nodeId);
          setSelectedJoint(entity && jointId ? { entity, jointId } : null);
        },
      });
      stage = s;
      if (entities) s.setCast(params.castLayout, params.pose, entities);
      appliedRef.current = {
        castLayout: params.castLayout,
        pose: params.pose,
        poseJson: JSON.stringify(entities ?? null),
        framing: params.framing,
        focal: params.focalLength,
        roll: params.roll,
        camJson: cameraJson(d),
        env: params.environment,
        aspect: params.aspect,
      };
      canvas = s.renderer.domElement;
      canvas.addEventListener('webglcontextlost', onLost);
      // 开发态挂在 DOM 上，便于 E2E / 自测脚本定位关节（生产构建不挂）
      if (import.meta.env?.DEV) (host as HTMLDivElement & { __miniStage?: MiniStage }).__miniStage = s;
      stageRef.current = s;
      modRef.current = mod;
      setFailed('');
      setReady(true);
    }).catch((e) => {
      if (cancelled) return;
      console.error('[director3d] 3D 舞台创建失败', e);
      setFailed(e instanceof Error ? e.message : String(e));
      setLive(false);
    });
    return () => {
      cancelled = true;
      if (canvas) canvas.removeEventListener('webglcontextlost', onLost);
      if (stage) {
        if (!lost) {
          try {
            stage.render();
            const url = stage.renderer.domElement.toDataURL('image/png');
            if (url && url.length > 64) setSnapshot(url);
          } catch { /* 读不到画面就保留上一张 */ }
        }
        try { stage.dispose(); } catch (e) { console.error('[director3d] 舞台释放失败', e); }
        if (import.meta.env?.DEV) delete (host as HTMLDivElement & { __miniStage?: MiniStage }).__miniStage;
      }
      if (stageRef.current === stage) stageRef.current = null;
      appliedRef.current = null;
      setReady(false);
      setSelectedJoint(null);
      release();
    };
  }, [live, nodeId, hostRef, store]);

  // —— data → 舞台 ——
  const entities = poseEntitiesOf(data);
  const poseJson = JSON.stringify(entities ?? null);
  useEffect(() => {
    const stage = stageRef.current;
    const a = appliedRef.current;
    if (!ready || !stage || !a) return;
    const poseChanged = a.pose !== p.pose;
    const jointsChanged = a.poseJson !== poseJson;
    if (a.castLayout === p.castLayout && !poseChanged && !jointsChanged) return;
    a.castLayout = p.castLayout;
    a.pose = p.pose;
    if (poseChanged && !jointsChanged && entities) {
      // 姿态预设被外部改了（AI 规划 / MCP）而自定义关节还在：与 3D 片场一致，姿态预设优先、清掉自定义关节
      stage.setCast(p.castLayout, p.pose, undefined);
      a.poseJson = 'null';
      updateRef.current({ mannequin_pose: undefined });
      return;
    }
    a.poseJson = poseJson;
    stage.setCast(p.castLayout, p.pose, entities);
  }, [ready, p.castLayout, p.pose, poseJson]); // eslint-disable-line react-hooks/exhaustive-deps

  const camJson = cameraJson(data);
  useEffect(() => {
    const stage = stageRef.current;
    const mod = modRef.current;
    const a = appliedRef.current;
    if (!ready || !stage || !mod || !a) return;
    const framingChanged = a.framing !== p.framing;
    const lensChanged = a.focal !== p.focalLength || a.roll !== p.roll;
    const camChanged = !!camJson && camJson !== a.camJson;
    a.framing = p.framing;
    a.focal = p.focalLength;
    a.roll = p.roll;
    if (camChanged) {
      // 外部改写了机位（撤销 / 重做 / 复制粘贴）：照搬，不回写
      a.camJson = camJson;
      stage.setCameraState(dataRef.current.camera_state!, { silent: true });
    } else if (framingChanged) {
      // 换景别 = 跳到 3D 片场同一张表里的预设机位（会回写 camera_state）
      stage.setCameraState(mod.framingCameraState(p.framing, p.focalLength, p.roll));
    } else if (lensChanged) {
      // 换焦距 / 荷兰角：机位不动，只改 FOV / roll
      const cur = stage.getCameraState();
      stage.setCameraState({ ...cur, fov: focalLengthToFov(p.focalLength), roll: p.roll });
    }
  }, [ready, p.framing, p.focalLength, p.roll, camJson]);

  useEffect(() => {
    const stage = stageRef.current;
    const a = appliedRef.current;
    if (!ready || !stage || !a || a.env === p.environment) return;
    a.env = p.environment;
    stage.setEnvironment(p.environment);
  }, [ready, p.environment]);

  useEffect(() => {
    const stage = stageRef.current;
    const a = appliedRef.current;
    if (!ready || !stage || !a || a.aspect === p.aspect) return;
    a.aspect = p.aspect;
    stage.setAspect(p.aspect);
  }, [ready, p.aspect]);

  // 画布缩放 / 画幅变了：按「设备像素比 × 缩放」与像素上限重设像素比
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const host = hostRef.current;
    if (!ready || !stage || !host) return;
    stage.renderer.setPixelRatio(stagePixelRatio(host.clientWidth, host.clientHeight, undefined, zoom));
    stage.resize();
  }, [ready, zoom, p.aspect, hostRef]);

  const activate = useCallback(() => {
    setSuspended(false);
    setOverBudget(false);
    setFailed('');
    touchStageSlot(nodeId);
  }, [nodeId]);
  const touch = useCallback(() => touchStageSlot(nodeId), [nodeId]);

  const status: StageStatus = ready ? 'ready' : failed ? 'error' : overBudget ? 'over-budget' : suspended ? 'suspended' : live ? 'loading' : 'idle';
  return { status, error: failed, snapshot, zoom, visible, selectedJoint, stageRef, modRef, activate, touch };
}
