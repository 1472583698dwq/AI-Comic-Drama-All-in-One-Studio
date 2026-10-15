// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 「视频」节点 `load-video`（照 Toonflow packages/nodes/videoNode）。
 *
 * 端口：source `video`[VIDEO]（Toonflow 没有按连线替换，故无输入口）。
 * 数据：video_url（+ 旧键 video / url 同步写）、asset_id（经素材库上传 / 拖入时）、duration/width/height（元数据）。
 * 功能：上传 / 替换（≤100MB）、从素材库拖入、播放（自定义控制条）、全屏、下载、保存到素材库（宿主）、
 *      截帧（当前 / 首 / 尾 → 新图片节点）、提取音轨（→ 音频节点）、分离音视频（→ 静音视频 + 音频节点）、截取片段（→ 新视频节点）。
 * 尺寸：有视频时宽 = max(180, 240 × 宽高比) + 18（Toonflow resizeVideo），否则缺省 220。
 */
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconLayersSubtract, IconMusic, IconScissors, IconTransfer, IconUpload } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { useKitNodeActions } from '../../kit/hostContext';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { toast } from '../../../../stores/useDialogStore';
import { FrameCaptureButton, VideoPlayer, type VideoMeta, type VideoPlayerHandle } from './VideoPlayer';
import { VideoActionsDialog } from './VideoActionsDialog';
import { useVideoOps } from './useVideoOps';
import { fileNameOf, isVideoDrop, parseMediaDrop, uploadVideoFile, validateVideoFile, videoPatch, videoUrlOf } from './media';
import './video.css';

export const LOAD_VIDEO_LABEL = '视频';

/** Toonflow resizeVideo：高 240 按比例算宽，最小 180，再加卡片内边距 18。 */
export function mediaNodeWidth(meta: Pick<VideoMeta, 'width' | 'height'> | null | undefined): number | undefined {
  if (!meta?.width || !meta?.height) return undefined;
  return Math.max(180, (240 * meta.width) / meta.height) + 18;
}

export function LoadVideoNode(props: NodeProps) {
  const { id } = props;
  const data = useMemo(() => (props.data || {}) as Record<string, unknown>, [props.data]);
  const actions = useKitNodeActions(id);
  const url = videoUrlOf(data);
  const src = resolveMediaUrl(url);
  const label = typeof data.label === 'string' && data.label ? data.label : LOAD_VIDEO_LABEL;
  const playerRef = useRef<VideoPlayerHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const ops = useVideoOps(id, {
    videoUrl: url,
    label,
    getCurrentTime: () => playerRef.current?.currentTime() ?? 0,
    aspect: meta?.width && meta?.height ? meta.width / meta.height : Number(data.width) > 0 && Number(data.height) > 0 ? Number(data.width) / Number(data.height) : undefined,
  });
  const busy = uploading || ops.processing;

  const setVideo = useCallback((next: string, extra: Record<string, unknown> = {}) => {
    setMeta(null);
    actions.update({ ...videoPatch(next), duration: undefined, width: undefined, height: undefined, asset_id: undefined, ...extra });
  }, [actions]);

  const onMetadata = useCallback((m: VideoMeta) => {
    setMeta(m);
    const patch: Record<string, unknown> = {};
    if (m.duration && Math.abs(Number(data.duration || 0) - m.duration) > 0.01) patch.duration = Number(m.duration.toFixed(3));
    if (m.width && data.width !== m.width) patch.width = m.width;
    if (m.height && data.height !== m.height) patch.height = m.height;
    if (Object.keys(patch).length) actions.update(patch);
  }, [actions, data.duration, data.width, data.height]);

  const pickFile = () => { if (!busy) fileRef.current?.click(); };
  const onFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const err = validateVideoFile(file);
    if (err) { toast.error(err); return; }
    setUploading(true);
    try {
      const up = await uploadVideoFile(file, actions.projectId);
      // 替换输出不删除旧文件（Toonflow：复制节点可能仍引用旧视频）
      setVideo(up.url, up.assetId ? { asset_id: up.assetId } : {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '视频上传失败');
    } finally {
      setUploading(false);
    }
  };

  // —— 从素材库 / 系统拖入（拦截冒泡，避免宿主画布 onDrop 再新建节点）——
  const accepts = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || []);
    // 文本素材 / 节点面板拖拽交给宿主（宿主会新建文本节点 / 新节点）
    if (['application/canvas-text', 'application/canvas-assetkind', 'application/canvas-nodetype'].some((t) => types.includes(t))) return false;
    return types.includes('Files') || types.includes('application/canvas-assetid') || types.includes('text/uri-list');
  };
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropActive(false);
  };
  const onDrop = (e: DragEvent) => {
    setDropActive(false);
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) { void onFile(file); return; }
    const dropped = parseMediaDrop(e.dataTransfer);
    if (!dropped) return;
    if (!isVideoDrop(dropped)) { toast.error('请拖入视频素材'); return; }
    setVideo(dropped.url, dropped.assetId ? { asset_id: dropped.assetId } : {});
  };

  // 元数据未到时先用落盘的宽高（避免刷新后宽度跳动）
  const dims = meta ?? (Number(data.width) > 0 && Number(data.height) > 0 ? { width: Number(data.width), height: Number(data.height) } : null);
  const width = useMemo(() => (src ? mediaNodeWidth(dims) : undefined), [src, dims?.width, dims?.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const noVideo = !url;

  return (
    <NodeSkeleton
      node={props}
      width={width}
      downloadUrl={src || undefined}
      downloadName={url ? fileNameOf(url) : undefined}
      onFullscreen={() => void playerRef.current?.enterFullscreen()}
      fullscreenDisabled={!src}
      toolbar={(
        <>
          <ToolbarButton icon={IconMusic} title="提取音轨" disabled={noVideo || busy} onClick={() => ops.open('extractAudio')}>提取音轨</ToolbarButton>
          <ToolbarButton icon={IconLayersSubtract} title="分离音视频" disabled={noVideo || busy} onClick={() => ops.open('separate')}>分离音视频</ToolbarButton>
          <ToolbarButton icon={IconScissors} title="截取片段" disabled={noVideo || busy} onClick={() => ops.open('trim')}>截取片段</ToolbarButton>
          <ToolbarButton icon={IconTransfer} title="替换视频" loading={uploading} disabled={ops.processing} onClick={pickFile}>替换视频</ToolbarButton>
        </>
      )}
      toolbarRight={<FrameCaptureButton onSelect={(at) => void ops.capture(at)} loading={ops.capturing} disabled={noVideo || busy || ops.capturing} />}
    >
      <div
        className={['cv-video-content nopan', dropActive ? 'is-drop-target' : ''].filter(Boolean).join(' ')}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {src ? (
          <VideoPlayer
            key={src}
            ref={playerRef}
            src={src}
            label={label}
            onMetadata={onMetadata}
            onCapture={(at) => void ops.capture(at)}
            capturing={ops.capturing}
            captureDisabled={busy}
            onFullscreenFallback={() => actions.openFullscreen(src, 'video')}
          />
        ) : (
          <button
            type="button"
            className="cv-video-upload"
            title="上传视频（或从素材库拖入）"
            aria-label="上传视频"
            disabled={uploading}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={pickFile}
          >
            <span>
              <IconUpload size={48} stroke={1.5} aria-hidden />
              <span className="cv-video-upload__tip" style={{ display: 'block' }}>{uploading ? '上传中…' : '上传视频 / 拖入素材'}</span>
            </span>
          </button>
        )}
        {src && uploading && (
          <div className="cv-video-loading" role="status"><span>上传中…</span></div>
        )}
        <input
          ref={fileRef}
          className="cv-video-file"
          type="file"
          accept="video/*"
          aria-label="选择视频"
          disabled={busy}
          onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void onFile(f); }}
        />
      </div>
      <VideoActionsDialog
        action={ops.action}
        src={src}
        processing={ops.processing}
        onRunTrim={(r) => void ops.runTrim(r)}
        onRetry={ops.retry}
        onClose={ops.close}
        onCancel={ops.cancel}
        disabled={uploading}
      />
    </NodeSkeleton>
  );
}
