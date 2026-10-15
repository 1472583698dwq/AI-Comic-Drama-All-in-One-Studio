// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频节点共用的素材处理状态机（截帧 / 提取音轨 / 分离音视频 / 截取片段）。
 * 结果经 useKitNodeActions(id).createNodes 落成新节点（Toonflow：放右侧、不连线、不改变当前选中）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useKitNodeActions } from '../../kit/hostContext';
import { toast } from '../../../../stores/useDialogStore';
import {
  ACTION_LABELS, captureFrameSpec, runVideoAction, withPlacement, type FrameAtCommand, type VideoAction,
} from './videoOps';

function errMsg(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return m || fallback;
}

export interface UseVideoOpsOptions {
  /** 节点当前视频（存储地址，传给后端）。 */
  videoUrl: string;
  /** 节点标题（新节点标题前缀）。 */
  label: string;
  /** 播放头（截取当前帧）。 */
  getCurrentTime: () => number;
  /** 源视频宽高比（新节点摆放宽度估算）。 */
  aspect?: number;
}

export interface VideoOps {
  capturing: boolean;
  processing: boolean;
  /** 打开中的处理弹窗。 */
  action: VideoAction | null;
  capture: (at: FrameAtCommand) => Promise<void>;
  /** 提取音轨 / 分离音视频：打开即处理；截取片段：打开范围选择弹窗。 */
  open: (action: VideoAction) => void;
  runTrim: (range: { start: number; end: number }) => Promise<void>;
  retry: () => void;
  /** 处理中取消：停止等待、丢弃结果。 */
  cancel: () => void;
  close: () => void;
}

export function useVideoOps(nodeId: string, opts: UseVideoOpsOptions): VideoOps {
  const actions = useKitNodeActions(nodeId);
  const rf = useReactFlow();
  const [capturing, setCapturing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [action, setAction] = useState<VideoAction | null>(null);
  const tokenRef = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // 视频换了：关闭弹窗、丢弃进行中的处理（Toonflow watch(file.url) → reset）
  useEffect(() => {
    tokenRef.current++;
    setProcessing(false);
    setAction(null);
  }, [opts.videoUrl]);
  useEffect(() => () => { tokenRef.current++; }, []);

  const capture = useCallback(async (at: FrameAtCommand) => {
    const { videoUrl, label, getCurrentTime } = optsRef.current;
    if (!videoUrl || capturing) return;
    setCapturing(true);
    try {
      const spec = await captureFrameSpec(videoUrl, at, getCurrentTime(), label);
      const w = Number(spec.data.width);
      const h = Number(spec.data.height);
      actions.createNodes(withPlacement(rf.getNodes(), nodeId, [spec], 'frame', w && h ? w / h : undefined), { select: false });
      toast.success('已截取为图片节点');
    } catch (e) {
      toast.error(errMsg(e, '截帧失败'));
    } finally {
      setCapturing(false);
    }
  }, [actions, rf, nodeId, capturing]);

  const run = useCallback(async (act: VideoAction, range?: { start: number; end: number }) => {
    const { videoUrl, label, aspect } = optsRef.current;
    if (!videoUrl) return;
    const token = ++tokenRef.current;
    setProcessing(true);
    try {
      const specs = await runVideoAction(act, videoUrl, label, range);
      if (token !== tokenRef.current) return; // 已取消 / 视频已换
      actions.createNodes(withPlacement(rf.getNodes(), nodeId, specs, 'action', aspect), { select: false });
      setAction(null);
      toast.success(`${ACTION_LABELS[act]}完成，已生成 ${specs.length} 个节点`);
    } catch (e) {
      if (token === tokenRef.current) toast.error(errMsg(e, `${ACTION_LABELS[act]}失败`));
    } finally {
      if (token === tokenRef.current) setProcessing(false);
    }
  }, [actions, rf, nodeId]);

  const open = useCallback((act: VideoAction) => {
    if (processing || !optsRef.current.videoUrl) return;
    setAction(act);
    if (act !== 'trim') void run(act);
  }, [processing, run]);

  const runTrim = useCallback((range: { start: number; end: number }) => run('trim', range), [run]);
  const retry = useCallback(() => { if (action && action !== 'trim') void run(action); }, [action, run]);
  const cancel = useCallback(() => {
    tokenRef.current++;
    setProcessing(false);
    setAction(null);
  }, []);
  const close = useCallback(() => { if (!processing) setAction(null); }, [processing]);

  return { capturing, processing, action, capture, open, runTrim, retry, cancel, close };
}
