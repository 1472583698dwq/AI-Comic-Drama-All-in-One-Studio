// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 合并后的 3D 导演节点 `director3d`（Toonflow 外壳 + MiniMax 3D 片场能力，两边功能都保留）。
 *
 * 卡片（宽 320，Toonflow director3dNode 同宽）：
 *   内嵌精简 3D 舞台（scene/createMiniStage：布偶、关节拖拽、轨道视角；懒挂载 / 离屏释放见 useDirectorStage）
 *   → 景别 / 运镜 / 焦距 / 速度 / 站位 / 姿态 预设（与 3D 片场同一份预设表）
 *   → 运镜提示词（camera_prompt 输出口，本地 buildMinimaxCameraPrompt 即时计算）
 *   → 运镜关键帧（Toonflow：记录当前机位、改时间 / 缓动、排序、删除、预览播放；或由运镜预设一键生成）。
 * 上方工具栏：导出 PNG（→ image 输出口 + 可选新图片节点）、导出 MP4（→ video 输出口 + 可选新视频节点）、在 3D 片场打开。
 * 下方提示词面板：导演指令（ai_directive，可 {{ref N}} 引用上游文本）→「AI 规划」走宿主 director_3d_stage_plan 分支改参数。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useReactFlow, type NodeProps } from '@xyflow/react';
import {
  IconCheck, IconCopy, IconCube3dSphere, IconExternalLink, IconFocusCentered, IconLayersIntersect, IconLoader2, IconMovie,
  IconPhotoDown, IconRestore, IconX,
} from '@tabler/icons-react';
import {
  NodeSkeleton, PromptPanel, ToolbarButton, assemblePrompt, refName, useKitNodeActions, useNodeReferences,
  type GenSourceOption, type MenuItemSpec,
} from '../../kit';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { motionShortLabel } from '../../../director3d/scene/presets';
import {
  ASPECT_OPTIONS, EASING_OPTIONS, ENTITY_LABELS, JOINT_LABELS, SPEED_OPTIONS,
  appendKeyframe, castOptions, cameraPromptPatch, deriveCameraPrompt, environmentLabel, environmentOptions, exportNames,
  findShotId, focalOptions, framingOptions, framingPatch, isValidCamera, keyframesDuration, labelOf,
  motionKeyframeSamples, motionOptions, moveKeyframe, nextKeyframeEasing, posePatch, poseOptions, presetToKeyframes,
  readKeyframes, readStageParams, removeKeyframe, replaceKeyframeCamera, retimeKeyframe, scaleKeyframesDuration,
  setKeyframeEasing, stageBadge, stageBoxAspect, withCurrent, buildNavigatePayload, describeParamChanges, PARSE_MODE_LABELS,
  type Director3DData, type Director3DKeyframe, type MinimalNode, type PickerOption,
} from './model';
import { useDirectorStage, type DirectorStage } from './useDirectorStage';
import { loadStageModule } from './stageLoader';
import { isTruncated, measureVideoDuration, uploadStageBlob, uploadStageVideo } from './exportMedia';
import { PresetPicker } from './PresetPicker';
import { KeyframeList } from './KeyframeList';
import './director3d.css';

/** 卡片宽（Toonflow director3dNode 同宽） */
export const DIRECTOR3D_WIDTH = 320;
/** 导出长边（16:9 → 1280×720）；成片明显短于运镜（设备极忙、采集管线卡住）时降到 RETRY_LONG_EDGE 重录一次 */
const EXPORT_LONG_EDGE = 1280;
const RETRY_LONG_EDGE = 960;

/** 「AI 规划」的生成源下拉只有一项：宿主的 director_3d_stage_plan 分支（MCP） */
export const PLAN_SOURCES: GenSourceOption[] = [
  { id: 'director_3d_stage_plan', label: 'AI 导演规划', group: 'MCP', description: 'MCP director_3d_stage_plan：按导演指令推荐景别、运镜、姿态、站位与焦距' },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e || '未知错误'));

/** 关键帧缩略图：从舞台画布裁出帧区域（舞台是 preserveDrawingBuffer，可直接读） */
function captureThumb(src: HTMLCanvasElement, aspect: number, height = 52): string {
  const cw = src.width;
  const ch = src.height;
  if (!cw || !ch) return '';
  let fw = cw;
  let fh = Math.round(cw / aspect);
  if (fh > ch) { fh = ch; fw = Math.round(ch * aspect); }
  const c = document.createElement('canvas');
  c.height = height;
  c.width = Math.max(1, Math.round(height * aspect));
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(src, Math.floor((cw - fw) / 2), Math.floor((ch - fh) / 2), fw, fh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

/** 参考图叠加层：贴在舞台帧区域（外框可能比画幅宽，帧在框内水平居中） */
function frameStyle(aspect: number, boxAspect: number): CSSProperties {
  if (aspect >= boxAspect) return { left: 0, top: 0, width: '100%', height: '100%' };
  const w = (aspect / boxAspect) * 100;
  return { top: 0, height: '100%', width: `${w}%`, left: `${(100 - w) / 2}%` };
}

function StagePlaceholder({ stage, onActivate }: { stage: DirectorStage; onActivate: () => void }) {
  const { status, snapshot, error } = stage;
  const tip = status === 'loading' ? '正在载入 3D 舞台…'
    : status === 'error' ? `3D 舞台创建失败：${error}（点击重试）`
      : status === 'over-budget' ? '同时打开的 3D 舞台过多，点击切换到这里'
        : status === 'suspended' ? '舞台已休眠以节省显存，点击恢复'
          : '选中或滚动到可见区域即载入 3D 舞台';
  return (
    <button
      type="button"
      className={['cv-d3__placeholder', snapshot ? 'has-snapshot' : '', status === 'error' ? 'is-error' : ''].filter(Boolean).join(' ')}
      aria-label={tip}
      title={tip}
      onClick={onActivate}
    >
      {snapshot && <img src={snapshot} alt="" draggable={false} />}
      {!snapshot && (status === 'loading' ? <IconLoader2 className="cv-spin" size={28} aria-hidden /> : <IconCube3dSphere size={38} stroke={1.2} aria-hidden />)}
      <span className="cv-d3__placeholder-tip">{tip}</span>
    </button>
  );
}

export function Director3DNode(props: NodeProps) {
  const { id } = props;
  const selected = !!props.selected;
  const data = (props.data || {}) as Director3DData;
  const dataRef = useRef(data);
  dataRef.current = data;
  const actions = useKitNodeActions(id);
  const update = actions.update;
  const rf = useReactFlow();

  const params = readStageParams(data);
  const keyframes = useMemo(() => readKeyframes(data.keyframes), [data.keyframes]);
  const framesRef = useRef(keyframes);
  framesRef.current = keyframes;
  const cameraPrompt = deriveCameraPrompt(params);

  // —— 输出口 camera_prompt（+ 兼容键 minimax_camera_prompt）始终等于本地运镜提示词 ——
  useEffect(() => {
    const patch = cameraPromptPatch(dataRef.current, cameraPrompt);
    if (patch) update(patch);
  }, [cameraPrompt, data.camera_prompt, data.minimax_camera_prompt, update]);

  // —— 提示条 ——
  const [notice, setNotice] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | null>(null);
  const noticeTimer = useRef(0);
  const say = useCallback((kind: 'info' | 'success' | 'error', text: string) => {
    setNotice({ kind, text });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === 'error' ? 9000 : 4500);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // —— 舞台 ——
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState<{ kind: 'image' | 'video'; phase: 'render' | 'upload' } | null>(null);
  // 导出 / 预览中保持舞台存活（离开视口也不卸载、不被名额淘汰）
  const stage = useDirectorStage({ nodeId: id, selected, data, params, update, boxRef, hostRef, keepAlive: playing || !!exporting });
  const stageReady = stage.status === 'ready';
  const [overlayOn, setOverlayOn] = useState(false);

  // —— 关键帧预览（播放中直接写进度条 DOM，不重渲染节点）——
  const scrubRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [activeKf, setActiveKf] = useState<string | null>(null);
  const rafRef = useRef(0);
  const headRef = useRef(0);
  const showHead = useCallback((t: number) => {
    headRef.current = t;
    if (scrubRef.current) scrubRef.current.value = String(t);
    if (timeRef.current) timeRef.current.textContent = `${t.toFixed(2)} / ${keyframesDuration(framesRef.current).toFixed(2)}s`;
  }, []);
  const applyAt = useCallback((t: number) => {
    const s = stage.stageRef.current;
    const mod = stage.modRef.current;
    if (!s || !mod || !framesRef.current.length) return;
    s.setCameraState(mod.sampleCameraKeyframes(framesRef.current, t), { silent: true });
  }, [stage.stageRef, stage.modRef]);
  const stopPlayback = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setPlaying(false);
  }, []);
  const startPlayback = useCallback(() => {
    const dur = keyframesDuration(framesRef.current);
    if (!stage.stageRef.current || framesRef.current.length < 2 || !(dur > 0)) return;
    const from = headRef.current >= dur ? 0 : headRef.current;
    const t0 = performance.now() - from * 1000;
    setActiveKf(null);
    setPlaying(true);
    const tick = (now: number) => {
      const t = Math.min(dur, Math.max(0, (now - t0) / 1000));
      applyAt(t);
      showHead(t);
      if (t >= dur) { rafRef.current = 0; setPlaying(false); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [applyAt, showHead, stage.stageRef]);
  const seek = useCallback((t: number) => {
    stopPlayback();
    setActiveKf(null);
    applyAt(t);
    showHead(t);
  }, [applyAt, showHead, stopPlayback]);
  // 离开视口 / 舞台卸载：停止预览（不在屏幕上就不渲染）
  useEffect(() => { if (!stageReady || !stage.visible) stopPlayback(); }, [stageReady, stage.visible, stopPlayback]);
  useEffect(() => { stopPlayback(); showHead(0); }, [keyframes, stopPlayback, showHead]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // —— 关键帧缩略图（舞台就绪后按关键帧机位各渲一帧；布景变了重渲）——
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const sceneSig = `${params.castLayout}|${params.pose}|${JSON.stringify(data.mannequin_pose ?? null)}|${params.environment}|${params.aspectRatio}`;
  const kfSig = keyframes.map((k) => `${k.id}:${k.camera.position.join(',')}:${k.camera.target.join(',')}:${k.camera.fov}:${k.camera.roll ?? 0}`).join('|');
  useEffect(() => {
    if (!stageReady || playing || !kfSig) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const s = stage.stageRef.current;
      if (!s || cancelled) return;
      const out: Record<string, string> = {};
      const prev = s.getCameraState();
      try {
        for (const kf of framesRef.current) {
          s.setCameraState(kf.camera, { silent: true });
          s.render();
          const url = captureThumb(s.renderer.domElement, readStageParams(dataRef.current).aspect);
          if (url) out[kf.id] = url;
        }
      } catch (e) {
        console.warn('[director3d] 关键帧缩略图生成失败', e);
      } finally {
        s.setCameraState(prev, { silent: true });
        s.render();
      }
      if (!cancelled) setThumbs(out);
    }, 320);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [stageReady, playing, kfSig, sceneSig, stage.stageRef]);

  // —— 上游参考（in 口：文本作为导演指令素材，图片可叠加到舞台对照构图）——
  const { refs, moveRef, removeRef } = useNodeReferences(id, { promptKeys: ['ai_directive'] });
  const directive = typeof data.ai_directive === 'string' ? data.ai_directive : '';
  const imageRefs = refs.filter((r) => r.dataType === 'IMAGE' && r.value);
  const textRefs = useMemo(() => refs.map((r, i) => [i + 1, r] as const).filter(([, r]) => r.dataType === 'STRING' && r.value.trim()), [refs]);
  const composedDirective = useMemo(
    () => assemblePrompt(directive, textRefs.map(([n, r]) => [n, r.value] as [number, string])),
    [directive, textRefs],
  );
  const refWarnings = refs.map((r, i) => (!r.value ? `${refName(i + 1)} 暂无内容，已跳过` : '')).filter(Boolean);

  // —— AI 规划（宿主 director_3d_stage_plan 分支：改参数，提示词随参数本地重算）——
  const [planning, setPlanning] = useState(false);
  const runPlan = async () => {
    const text = composedDirective.trim();
    if (!text || planning) return;
    const beforeData = (rf.getNode(id)?.data ?? dataRef.current) as Director3DData;
    const p = readStageParams(beforeData);
    setPlanning(true);
    try {
      await actions.execute({
        ai_directive: text,
        framing: p.framing,
        motion: p.motion,
        pose: p.pose,
        focal_length_mm: p.focalLength,
        camera_roll_deg: p.roll,
        cast_layout: p.castLayout,
        speed: p.speed,
      });
      // 宿主写回在下一轮渲染生效；旧宿主出错时只弹窗不抛错，这里用「data 有没有被写」判断成败
      await new Promise((r) => window.setTimeout(r, 0));
      const afterData = (rf.getNode(id)?.data ?? dataRef.current) as Director3DData;
      if (afterData === beforeData) {
        say('error', 'AI 规划没有返回结果（宿主可能已提示错误）');
        return;
      }
      const mode = typeof afterData.parse_mode === 'string' ? PARSE_MODE_LABELS[afterData.parse_mode] ?? afterData.parse_mode : '';
      const changes = describeParamChanges(p, readStageParams(afterData));
      say('success', `AI 规划${mode ? `（${mode}）` : ''}：${changes || '机位参数无变化'}${changes ? '；运镜提示词已重算' : ''}`);
    } catch (e) {
      say('error', `AI 规划失败：${errText(e)}`);
    } finally {
      setPlanning(false);
    }
  };

  // —— 预设 ——
  const fOptions = useMemo(() => withCurrent(framingOptions(), params.framing), [params.framing]);
  const mOptions = useMemo(() => withCurrent(motionOptions(), params.motion), [params.motion]);
  const pOptions = useMemo(() => withCurrent(poseOptions(), params.pose), [params.pose]);
  const cOptions = useMemo(() => withCurrent(castOptions(), params.castLayout), [params.castLayout]);
  const lensOptions: PickerOption[] = useMemo(() => focalOptions(params.focalLength).map((fl) => ({ id: String(fl), label: `${fl}mm` })), [params.focalLength]);
  const speedOptions: PickerOption[] = useMemo(() => SPEED_OPTIONS.map((s) => ({ id: s, label: s })), []);

  const resetCamera = async () => {
    const mod = stage.modRef.current ?? await loadStageModule().catch(() => null);
    const p = readStageParams(dataRef.current);
    if (!mod || !stage.stageRef.current) return;
    stopPlayback();
    stage.stageRef.current.setCameraState(mod.framingCameraState(p.framing, p.focalLength, p.roll));
  };
  const resetJoints = () => update({ mannequin_pose: undefined });

  // —— 关键帧编辑 ——
  const setKeyframes = (list: Director3DKeyframe[]) => update({ keyframes: list });
  const currentCamera = () => stage.stageRef.current?.getCameraState() ?? null;
  const onAddKeyframe = () => {
    const cam = currentCamera();
    if (!cam) return;
    stopPlayback();
    const next = appendKeyframe(framesRef.current, cam);
    setActiveKf(next[next.length - 1]?.id ?? null);
    setKeyframes(next);
  };
  const onGenerateKeyframes = async () => {
    stopPlayback();
    try {
      const mod = stage.modRef.current ?? await loadStageModule();
      const d = dataRef.current;
      const p = readStageParams(d);
      const base = currentCamera() ?? (isValidCamera(d.camera_state) ? d.camera_state : mod.framingCameraState(p.framing, p.focalLength, p.roll));
      const frames = mod.motionPresetKeyframes(p.motion, base, { speed: p.speed, easing: p.easing, samples: motionKeyframeSamples(p.motion, p.easing) });
      const list = presetToKeyframes(frames, p.easing);
      const replaced = framesRef.current.length;
      setActiveKf(null);
      setKeyframes(list);
      say('info', `已按「${motionShortLabel(p.motion)}」生成 ${list.length} 个关键帧（${keyframesDuration(list).toFixed(2)}s）${replaced ? `，替换了原有 ${replaced} 个` : ''}`);
    } catch (e) {
      say('error', `生成关键帧失败：${errText(e)}`);
    }
  };

  // —— 导出（PNG / MP4 → 素材库 → 输出口；可选在右侧新建图片 / 视频节点）——
  // 录制进度直接写 DOM（不重渲染节点）：录制期间主线程 / 合成越闲，MediaRecorder 越不容易掉帧
  const [lastExport, setLastExport] = useState<'image' | 'video' | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const progressRef = useRef(0);
  const recordLabelRef = useRef('正在录制运镜视频');
  const busyTextRef = useRef<HTMLSpanElement>(null);
  const busyBarRef = useRef<HTMLElement>(null);
  const videoBtnTextRef = useRef<HTMLSpanElement>(null);
  useEffect(() => () => abortRef.current?.abort(new Error('导演节点已关闭，导出已停止')), []);
  const paintProgress = useCallback((pct: number, text?: string) => {
    progressRef.current = pct;
    if (busyTextRef.current) busyTextRef.current.textContent = text ?? `${recordLabelRef.current} ${pct}%（保持窗口可见）`;
    if (busyBarRef.current) busyBarRef.current.style.width = `${pct}%`;
    if (videoBtnTextRef.current) videoBtnTextRef.current.textContent = `导出中 ${pct}%`;
  }, []);

  // REQ-toonflow-canvas F1：不传 position（K1 h 约定是画布绝对坐标），交给宿主摆放：
  // 锚点右侧、按实测尺寸避让同层节点，锚点在分组里时新节点挂同一分组并换算成相对坐标。
  const placeExportNode = (type: 'load-image' | 'load-video', nodeData: Record<string, unknown>) => {
    actions.createNodes([{ type, data: nodeData }], { placement: 'right', select: false });
  };

  const exportImage = async () => {
    const s = stage.stageRef.current;
    if (!s || exporting) return;
    stopPlayback();
    setExporting({ kind: 'image', phase: 'render' });
    try {
      const blob = await s.snapshotPNG({ longEdge: EXPORT_LONG_EDGE });
      const names = exportNames(dataRef.current.label, 'image');
      setExporting({ kind: 'image', phase: 'upload' });
      const url = await uploadStageBlob(blob, { fileName: `${names.fileBase}.png`, name: names.assetName, projectId: actions.projectId });
      update({ image_url: url });
      setLastExport('image');
      const newNode = dataRef.current.export_new_node !== false;
      if (newNode) placeExportNode('load-image', { label: names.nodeLabel, image_url: url, image: url, url });
      say('success', `已导出机位截图 PNG（「图片」输出口${newNode ? '，并在右侧新建图片节点' : ''}）`);
    } catch (e) {
      say('error', `导出 PNG 失败：${errText(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const exportVideo = async () => {
    if (exporting?.kind === 'video') { abortRef.current?.abort(new Error('已取消导出')); return; }
    const s = stage.stageRef.current;
    const mod = stage.modRef.current;
    if (!s || !mod || exporting) return;
    stopPlayback();
    const p = readStageParams(dataRef.current);
    const fromKeyframes = framesRef.current.length >= 2;
    const frames = mod.normalizeKeyframes(fromKeyframes
      ? framesRef.current
      : mod.motionPresetKeyframes(p.motion, s.getCameraState(), { speed: p.speed, easing: p.easing }));
    const duration = mod.cameraKeyframesDuration(frames);
    if (!(duration > 0)) { say('error', '运镜时长为 0：请至少记录两个不同时间的关键帧'); return; }
    // REQ-toonflow-canvas C1：stageCore.recordCameraPath 已修尾部丢帧（末帧后等采集 / 编码管线排空再停录，成片时长 = 运镜时长），
    // 不再需要「末尾多录 0.6s + 服务器裁剪」的绕法，按运镜时长原样录制、MP4 直接进素材库
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    progressRef.current = 0;
    recordLabelRef.current = '正在录制运镜视频';
    setExporting({ kind: 'video', phase: 'render' });
    try {
      const record = async (longEdge: number) => {
        let lastPct = -1;
        const blob = await s.recordCameraPath(frames, duration, 30, {
          longEdge,
          signal: ctrl.signal,
          onProgress: (v) => {
            const pct = Math.min(99, Math.floor(v * 100));
            if (pct !== lastPct) { lastPct = pct; paintProgress(pct); }
          },
        });
        ctrl.signal.throwIfAborted();
        return { blob, seconds: await measureVideoDuration(blob) };
      };
      // 兜底：成片仍明显短于运镜（采集管线卡住超过录制收尾的等待上限）→ 降分辨率重录一次，取较长的那份
      let take = await record(EXPORT_LONG_EDGE);
      if (isTruncated(take.seconds, duration)) {
        recordLabelRef.current = '录制掉帧，降低分辨率重录';
        paintProgress(0);
        const retry = await record(RETRY_LONG_EDGE);
        if (!(retry.seconds < take.seconds)) take = retry;
      }
      const names = exportNames(dataRef.current.label, 'video');
      setExporting({ kind: 'video', phase: 'upload' });
      const url = await uploadStageVideo(take.blob, Number.isFinite(take.seconds) ? take.seconds : duration, {
        fileBase: names.fileBase, name: names.assetName, projectId: actions.projectId,
      });
      ctrl.signal.throwIfAborted();
      update({ video_url: url });
      setLastExport('video');
      const newNode = dataRef.current.export_new_node !== false;
      if (newNode) placeExportNode('load-video', { label: names.nodeLabel, video_url: url, video: url, url });
      const source = fromKeyframes ? `${framesRef.current.length} 个关键帧` : `运镜「${motionShortLabel(p.motion)}」`;
      if (isTruncated(take.seconds, duration)) {
        say('error', `视频已导出，但录制时设备繁忙丢帧：成片 ${take.seconds.toFixed(1)}s，短于运镜 ${duration.toFixed(1)}s。可关闭其他页面后重试`);
      } else {
        say('success', `已导出运镜视频 MP4（${duration.toFixed(1)}s，${source}；「视频」输出口${newNode ? '，并在右侧新建视频节点' : ''}）`);
      }
    } catch (e) {
      if (ctrl.signal.aborted) say('info', '已取消导出视频');
      else say('error', `导出 MP4 失败：${errText(e)}`);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setExporting(null);
    }
  };

  // —— 在 3D 片场打开 ——
  const openInStage = () => {
    if (!actions.navigate) return;
    const shotId = findShotId(id, dataRef.current, rf.getEdges(), (nid) => rf.getNode(nid) as MinimalNode | undefined);
    actions.navigate('director3d', buildNavigatePayload(id, dataRef.current, shotId));
  };

  const [copied, setCopied] = useState(false);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(cameraPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      say('error', '复制失败：浏览器不允许访问剪贴板');
    }
  };

  // —— 外壳：工具栏 / 面板 / 右键菜单 ——
  const lastKind = lastExport ?? (data.video_url ? 'video' : data.image_url ? 'image' : null);
  const lastUrl = lastKind === 'video' ? data.video_url : lastKind === 'image' ? data.image_url : undefined;
  const videoBusy = exporting?.kind === 'video';
  const toolbar = (
    <>
      <ToolbarButton icon={IconPhotoDown} title="导出当前机位 PNG" loading={exporting?.kind === 'image'} disabled={!stageReady || !!exporting} onClick={() => void exportImage()}>导出 PNG</ToolbarButton>
      <ToolbarButton
        icon={videoBusy ? IconX : IconMovie}
        title={videoBusy ? '取消导出视频' : keyframes.length >= 2 ? `按 ${keyframes.length} 个关键帧导出 MP4` : `按运镜「${motionShortLabel(params.motion)}」导出 MP4`}
        active={videoBusy}
        disabled={!stageReady || exporting?.kind === 'image'}
        onClick={() => void exportVideo()}
      >
        {videoBusy ? <span ref={videoBtnTextRef}>{exporting?.phase === 'upload' ? '上传中…' : `导出中 ${progressRef.current}%`}</span> : '导出 MP4'}
      </ToolbarButton>
    </>
  );
  const toolbarRight = (
    <ToolbarButton icon={IconExternalLink} title={actions.navigate ? '在完整的 3D 片场里打开' : '当前宿主未接入页面跳转'} disabled={!actions.navigate} onClick={openInStage}>
      在 3D 片场打开
    </ToolbarButton>
  );
  const menuItems: MenuItemSpec[] = [
    { key: 'd3-reset-camera', label: '机位复位到景别预设', icon: <IconFocusCentered size={16} aria-hidden />, disabled: !stageReady, onSelect: () => void resetCamera() },
    { key: 'd3-reset-joints', label: '关节复位', icon: <IconRestore size={16} aria-hidden />, disabled: !data.mannequin_pose, onSelect: resetJoints },
    { key: 'd3-open-stage', label: '在 3D 片场打开', icon: <IconExternalLink size={16} aria-hidden />, disabled: !actions.navigate, onSelect: openInStage },
  ];

  const renderParams = () => (
    <div className="cv-d3-params">
      <div className="cv-d3-params__row">
        <span className="cv-d3-params__label">画幅（舞台与导出）</span>
        <div className="cv-d3-params__opts">
          {ASPECT_OPTIONS.map((r) => (
            <ToolbarButton key={r} title={r} active={params.aspectRatio === r} onClick={() => update({ aspect_ratio: r })}>{r}</ToolbarButton>
          ))}
        </div>
      </div>
      <div className="cv-d3-params__row">
        <span className="cv-d3-params__label">环境</span>
        <div className="cv-d3-params__opts">
          {environmentOptions().map((e) => (
            <ToolbarButton key={e.id} title={e.label} active={params.environment === e.id} onClick={() => update({ environment: e.id })}>{e.label}</ToolbarButton>
          ))}
        </div>
      </div>
      <div className="cv-d3-params__row">
        <span className="cv-d3-params__label">运镜缓动（生成关键帧 / 无关键帧导出视频）</span>
        <div className="cv-d3-params__opts">
          {EASING_OPTIONS.map((e) => (
            <ToolbarButton key={e.id} title={e.label} active={params.easing === e.id} onClick={() => update({ motion_easing: e.id })}>{e.label}</ToolbarButton>
          ))}
        </div>
      </div>
      <div className="cv-d3-params__row">
        <span className="cv-d3-params__label"><span>荷兰角</span><span>{params.roll > 0 ? '+' : ''}{params.roll}°</span></span>
        <input
          type="range"
          min={-45}
          max={45}
          step={1}
          value={params.roll}
          aria-label="荷兰角（度）"
          onChange={(e) => update({ camera_roll_deg: Number(e.target.value) })}
        />
      </div>
      <div className="cv-d3-params__row">
        <button
          type="button"
          role="switch"
          aria-checked={data.export_new_node !== false}
          className="cv-switch"
          onClick={() => update({ export_new_node: data.export_new_node === false })}
        >
          <span className="cv-switch__track" aria-hidden><span className="cv-switch__thumb" /></span>
          <span>导出时在右侧新建图片 / 视频节点</span>
        </button>
      </div>
    </div>
  );

  const panel = (
    <PromptPanel
      refs={refs}
      prompt={directive}
      onPromptChange={(v) => update({ ai_directive: v })}
      onMoveRef={moveRef}
      onRemoveRef={removeRef}
      onPreviewRef={(item) => { if (item.dataType === 'IMAGE' && item.value) actions.openFullscreen(resolveMediaUrl(item.value), 'image'); }}
      sources={PLAN_SOURCES}
      sourceId={PLAN_SOURCES[0].id}
      onSourceChange={() => {}}
      paramsSummary={`${params.aspectRatio} · ${environmentLabel(params.environment)}`}
      paramsRatio={params.aspectRatio}
      renderParams={renderParams}
      running={planning}
      onSend={() => void runPlan()}
      sendDisabled={!composedDirective.trim()}
      sendTitle="AI 规划机位"
      header={imageRefs.length ? <div className="cv-d3-panel-hint">图片参考可在舞台右上角「叠加参考图」对照构图；AI 规划只读取文字指令与文本参考。</div> : undefined}
      placeholder="描述镜头意图，如「贴地仰角双人对峙，缓慢推近」；AI 规划会推荐景别、运镜、姿态、站位与焦距"
      warnings={refWarnings}
    />
  );

  // —— 卡片 ——
  const boxAspect = stageBoxAspect(params.aspect);
  const joint = stage.selectedJoint;
  const busyText = !exporting ? ''
    : exporting.phase === 'upload' ? `正在上传${exporting.kind === 'image' ? '截图' : '视频'}到素材库…`
      : exporting.kind === 'image' ? '正在导出 PNG…' : `${recordLabelRef.current} ${progressRef.current}%（保持窗口可见）`;

  return (
    <NodeSkeleton
      node={props}
      width={DIRECTOR3D_WIDTH}
      toolbar={toolbar}
      toolbarRight={toolbarRight}
      downloadUrl={lastUrl ? resolveMediaUrl(lastUrl) : undefined}
      downloadName={lastKind === 'video' ? 'director3d.mp4' : 'director3d.png'}
      onFullscreen={lastUrl ? () => actions.openFullscreen(resolveMediaUrl(lastUrl), lastKind === 'video' ? 'video' : 'image') : undefined}
      fullscreenDisabled={!lastUrl}
      panel={panel}
      menuItems={menuItems}
    >
      <div className="cv-d3">
        <div
          ref={boxRef}
          className="cv-d3__stage nodrag nopan nowheel"
          style={{ aspectRatio: String(boxAspect) }}
          data-stage-status={stage.status}
          onPointerDown={stage.touch}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div ref={hostRef} className="cv-d3__host" />
          {stageReady && overlayOn && imageRefs[0] && (
            <img className="cv-d3__overlay-ref" src={resolveMediaUrl(imageRefs[0].value)} style={frameStyle(params.aspect, boxAspect)} alt="" draggable={false} />
          )}
          {!stageReady && <StagePlaceholder stage={stage} onActivate={stage.activate} />}
          {stageReady && (
            <>
              <div className="cv-d3__hud">
                <span className="cv-d3__chip">{stageBadge(params)}</span>
                {joint && (
                  <span className="cv-d3__chip cv-d3__chip--joint">{`${ENTITY_LABELS[joint.entity] ?? joint.entity} · ${JOINT_LABELS[joint.jointId] ?? joint.jointId}`}</span>
                )}
              </div>
              <div className="cv-d3__hud-actions">
                {imageRefs.length > 0 && (
                  <ToolbarButton icon={IconLayersIntersect} iconOnly title={overlayOn ? '隐藏参考图叠加' : '叠加参考图（对照构图）'} active={overlayOn} onClick={() => setOverlayOn((v) => !v)} />
                )}
                <ToolbarButton icon={IconFocusCentered} iconOnly title="机位复位到景别预设" onClick={() => void resetCamera()} />
                <ToolbarButton icon={IconRestore} iconOnly title="关节复位（回到姿态预设）" disabled={!data.mannequin_pose} onClick={resetJoints} />
              </div>
              <div className="cv-d3__hint">拖关节摆姿势（Shift 扭转）· 拖空白环绕 · 右键平移 · 滚轮推拉</div>
            </>
          )}
          {exporting && (
            <div className="cv-d3__busy" role="status" aria-live="polite">
              <span ref={busyTextRef}>{busyText}</span>
              {exporting.kind === 'video' && exporting.phase === 'render' && (
                <span className="cv-d3__busy-bar"><i ref={busyBarRef} style={{ width: `${progressRef.current}%` }} /></span>
              )}
            </div>
          )}
        </div>

        <div className="cv-d3__grid" onDoubleClick={(e) => e.stopPropagation()}>
          <PresetPicker label="景别" value={params.framing} options={fOptions} onChange={(v) => update(framingPatch(v))} />
          <PresetPicker label="运镜" value={params.motion} options={mOptions} onChange={(v) => update({ motion: v })} menuWidth={260} />
          <PresetPicker label="焦距" value={String(params.focalLength)} options={lensOptions} onChange={(v) => update({ focal_length_mm: Number(v) })} menuWidth={120} />
          <PresetPicker label="速度" value={params.speed} options={speedOptions} onChange={(v) => update({ speed: v })} menuWidth={120} />
          <PresetPicker label="站位" value={params.castLayout} options={cOptions} onChange={(v) => update({ cast_layout: v })} />
          <PresetPicker label="姿态" value={params.pose} options={pOptions} onChange={(v) => update(posePatch(v))} />
        </div>

        <div className="cv-d3__prompt" title={`运镜提示词（输出口 camera_prompt）：${labelOf(fOptions, params.framing)} · ${labelOf(mOptions, params.motion)}`}>
          <code className="nodrag" aria-label="运镜提示词">{cameraPrompt}</code>
          <ToolbarButton icon={copied ? IconCheck : IconCopy} iconOnly size="sm" title={copied ? '已复制' : '复制运镜提示词'} onClick={() => void copyPrompt()} />
        </div>

        <KeyframeList
          keyframes={keyframes}
          stageReady={stageReady}
          playing={playing}
          motionLabel={motionShortLabel(params.motion)}
          thumbs={thumbs}
          activeId={activeKf}
          scrubRef={scrubRef}
          timeRef={timeRef}
          onAdd={onAddKeyframe}
          onGenerate={() => void onGenerateKeyframes()}
          onClear={() => { stopPlayback(); setActiveKf(null); setKeyframes([]); }}
          onPlayToggle={() => (playing ? stopPlayback() : startPlayback())}
          onSeek={seek}
          onView={(kf) => { stopPlayback(); setActiveKf(kf.id); stage.stageRef.current?.setCameraState(kf.camera); }}
          onOverwrite={(kf) => { const cam = currentCamera(); if (cam) setKeyframes(replaceKeyframeCamera(framesRef.current, kf.id, cam)); }}
          onRemove={(kf) => { if (activeKf === kf.id) setActiveKf(null); setKeyframes(removeKeyframe(framesRef.current, kf.id)); }}
          onMove={(from, to) => setKeyframes(moveKeyframe(framesRef.current, from, to))}
          onRetime={(kf, t) => setKeyframes(retimeKeyframe(framesRef.current, kf.id, t))}
          onEasing={(kf) => setKeyframes(setKeyframeEasing(framesRef.current, kf.id, nextKeyframeEasing(kf.easing)))}
          onDuration={(d) => setKeyframes(scaleKeyframesDuration(framesRef.current, d))}
        />

        {notice && (
          <div className={`cv-d3__notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            <span>{notice.text}</span>
            <ToolbarButton icon={IconX} iconOnly title="关闭提示" onClick={() => setNotice(null)} />
          </div>
        )}
      </div>
    </NodeSkeleton>
  );
}
