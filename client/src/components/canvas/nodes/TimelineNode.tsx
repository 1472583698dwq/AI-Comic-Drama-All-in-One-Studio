// -*- coding: utf-8 -*-
/**
 * 画布「时间线」节点卡片 —— 合视频轻剪辑的摘要态。
 *
 * 形态对齐参考图：标题不占卡片内一栏，而是**悬浮胶囊**贴在卡片上沿左上（折叠按钮在右上）；
 * 大屏预览**只在节点选中时显示**；工具行（裁剪 / 删除 / 播放 / 时间码 /
 * 下载 / 全屏编辑）、时间标尺、片段条（首帧缩略图 + 时长标 + 虚线加号）、红色播放头、
 * 音频波形条、左侧 video/audio 连线口。
 *
 * 数据只有一个源：`node.data.clips`（随画布快照持久化）。卡片与全屏编辑器读写同一份，
 * 全屏编辑器经 portal 覆盖到 body —— 节点处在 ReactFlow 的 transform 视口里，
 * 直接 `fixed` 会被缩放的祖先当包含块，必须 portal。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, NodeProps } from '@xyflow/react';
import {
  Clapperboard,
  Download,
  FolderOpen,
  Maximize2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  Pause,
  Scissors,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import {
  appendClip,
  clipFromUrl,
  clipIndexAt,
  clipStartAt,
  formatTimecode,
  isClipPending,
  mediaKindFromUrl,
  removeClip,
  type TimelineClip,
} from '../../../types/timeline';
import { useProjectStore } from '../../../stores/useProjectStore';
import { CanvasResourcePickerModal } from '../CanvasResourcePickerModal';
import { TimelinePreview } from '../timeline/TimelinePreview';
import { TimelineStrip } from '../timeline/TimelineStrip';
import { TimelineStudioModal } from '../timeline/TimelineStudioModal';
import { useTimelinePlayer } from '../timeline/useTimelinePlayer';
import { defaultExportTitle, useTimelineExport } from '../timeline/useTimelineExport';

/** 卡片按参考图做成横向长条：窄卡上时间线挤成一团，读不出片段 */
const CARD_WIDTH = 560;
/** 每秒钟像素宽度：卡片与全屏共用一个口径，卡片略紧、全屏更舒展 */
const CARD_PPS = 26;

export const TimelineNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data || {};
  const updateRef = useRef<(patch: Record<string, any>) => void>(() => undefined);
  updateRef.current = (patch) => d.onUpdate?.(id, patch);

  const clips: TimelineClip[] = useMemo(() => (Array.isArray(d.clips) ? d.clips : []), [d.clips]);
  const collapsed = !!d.collapsed;
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [trimMode, setTrimMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 整体静音：默认静音，避免在画布上突然出声；卡片上只有一个总开关（全屏编辑器里才分视频/音频两轨）
  const [muted, setMuted] = useState(true);
  const toggleMuted = () => setMuted((v) => !v);

  const project = useProjectStore((s) => s.project);
  const player = useTimelinePlayer(clips);
  const baseName = d.label || project?.title || '时间线';
  const title = defaultExportTitle(baseName, clips);
  const exporter = useTimelineExport({
    clips,
    title,
    aspectRatio: project?.aspect_ratio,
    projectId: project?.id,
  });

  // 上游连线自动入列：`_upstream` 由 CreativeCanvas 的连线/更新传播写入。
  // `_ingested` 记下「这条上游 URL 已经入列过」：否则用户从时间线里删掉上游带进来的片段后，
  // 下一次重渲染又会把它加回来 —— 表现为「上游的片段删不掉」。
  const up: any = d._upstream || {};
  const upstreamVideo: string = up.video_url || up.video || d.video_url || '';
  const upstreamAudio: string = up.audio_url || up.audio || d.audio_url || '';
  const ingested: string[] = Array.isArray(d._ingested) ? d._ingested : [];
  const ingestedKey = ingested.join('|');
  useEffect(() => {
    const additions: TimelineClip[] = [];
    if (upstreamVideo && !ingested.includes(`video:${upstreamVideo}`)) {
      additions.push(clipFromUrl(upstreamVideo, { kind: 'video' }));
    }
    if (upstreamAudio && !ingested.includes(`audio:${upstreamAudio}`)) {
      additions.push(clipFromUrl(upstreamAudio, { kind: 'audio' }));
    }
    if (!additions.length) return;
    const next = additions.reduce((acc, c) => appendClip(acc, c), clips);
    updateRef.current({
      clips: next,
      _ingested: [...ingested, ...additions.map((c) => `${c.kind}:${c.url}`)],
    });
  }, [upstreamVideo, upstreamAudio, clips, ingestedKey]);

  const handleClipsChange = (next: TimelineClip[]) => {
    updateRef.current({ clips: next });
    if (selectedClipId && !next.some((c) => c.id === selectedClipId)) setSelectedClipId(null);
  };

  const handleAddMedia = (urls: string | string[]) => {
    const list = Array.isArray(urls) ? urls : [urls];
    const accepted: TimelineClip[] = [];
    const rejected: string[] = [];
    list.forEach((url) => {
      const kind = mediaKindFromUrl(url);
      if (!kind) {
        rejected.push(url.split('/').pop() || url);
        return;
      }
      accepted.push(clipFromUrl(url, { kind }));
    });
    if (accepted.length) {
      const next = accepted.reduce((acc, c) => appendClip(acc, c), clips);
      handleClipsChange(next);
      setNotice(null);
    }
    if (rejected.length) {
      setNotice(`已跳过 ${rejected.length} 个非视频/音频素材：${rejected.slice(0, 2).join('、')}`);
    }
  };

  // 预览大屏跟播放头走：停在末尾时定格最后一帧（与全屏编辑器一致）
  const rawIndex = clipIndexAt(clips, player.playhead);
  const activeIndex = rawIndex >= 0 ? rawIndex : clips.length - 1;
  const activeClip = activeIndex >= 0 ? clips[activeIndex] : null;
  const localTime = activeClip
    ? Math.min(activeClip.out, activeClip.in + Math.max(0, player.playhead - clipStartAt(clips, activeIndex)))
    : 0;

  // 导出完成后由 useTimelineExport 直接打开导出文件夹（本页不播放、也不自动下载）
  const handleDownload = () => exporter.exportMp4();

  const deleteSelected = () => {
    if (!selectedClipId) return;
    handleClipsChange(removeClip(clips, selectedClipId));
  };

  const busy = exporter.mp4.status === 'running';
  const statusError = exporter.mp4.error;
  const statusSuccess = exporter.mp4.status === 'success';
  const pendingCount = clips.filter(isClipPending).length;

  return (
    <div
      className={`relative rounded-2xl border transition-all duration-200 ${
        selected ? 'border-brand/70 shadow-2xl shadow-brand/15' : 'border-border hover:border-brand/40 shadow-xl'
      }`}
      style={{ width: CARD_WIDTH, background: 'var(--color-surface)' }}
    >
      <Handle type="target" position={Position.Left} id="video" className="!w-3 !h-3 !bg-orange-500 !border-2 !border-[#141419]" style={{ top: '34%' }} />
      <Handle type="target" position={Position.Left} id="audio" className="!w-3 !h-3 !bg-pink-500 !border-2 !border-[#141419]" style={{ top: '66%' }} />

      {/* 悬浮标题：无底色块的轻量一行（选中态预览大屏出现时标题隐藏）；折叠按钮在右上。
          标题兼作画布拖动手柄（工具行/时间线内部都标了 nodrag，不会误拖卡片） */}
      <div className="absolute -top-7 left-0 right-0 z-10 flex items-center gap-1.5">
        {!selected && (
          <span
            title={title}
            className="nodrag cursor-grab active:cursor-grabbing flex items-center gap-1.5 min-w-0 max-w-[calc(100%-40px)] px-1"
          >
            <Clapperboard className="w-3 h-3 text-brand shrink-0" strokeWidth={1.8} />
            <span className="text-[11px] font-semibold truncate [color:var(--color-text-main)]">{title}</span>
            {pendingCount > 0 && <Loader2 className="w-3 h-3 animate-spin text-brand shrink-0" />}
          </span>
        )}
        <button
          onClick={() => updateRef.current({ collapsed: !collapsed })}
          aria-label={collapsed ? '展开时间线' : '折叠时间线'}
          title={collapsed ? '展开' : '折叠'}
          className="nodrag ml-auto w-6 h-6 rounded-lg flex items-center justify-center shrink-0 [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary transition-colors"
        >
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </div>

      {collapsed ? (
        <div className="px-3 py-2.5 rounded-2xl flex items-center gap-2 text-[10.5px] [color:var(--color-text-muted)]">
          <span className="font-mono">{clips.length} 段</span>
          <span>·</span>
          <span className="font-mono">{formatTimecode(player.total)}</span>
          <span className="truncate">时间线已折叠，点右上角按钮展开</span>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden">
          {/* 大屏预览：**只在节点选中时显示**；未播放时定格在播放头所在的那一帧，点画面即在该屏上播放 */}
          {selected && (
            <div className="nodrag border-b border-border" onPointerDown={(e) => e.stopPropagation()}>
              <TimelinePreview
                clip={activeClip}
                localTime={localTime}
                playing={player.playing}
                playhead={player.playhead}
                total={player.total}
                onToggle={player.toggle}
                variant="card"
                videoMuted={muted}
                audioMuted={muted}
              />
            </div>
          )}

          {/* 工具行：左（裁剪/删除）· 中（播放 + 时间码）· 右（下载/全屏编辑） */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-border nodrag">
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setTrimMode((v) => !v)}
                aria-pressed={trimMode}
                aria-label="裁剪模式"
                title="裁剪：打开后选中片段的左右把手常显，拖两端改入出点"
                className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
                  trimMode
                    ? 'bg-brand/15 text-brand'
                    : '[color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary'
                }`}
              >
                <Scissors className="w-3.5 h-3.5" strokeWidth={1.7} />
              </button>
              <button
                onClick={deleteSelected}
                disabled={!selectedClipId}
                aria-label="删除选中片段"
                title={selectedClipId ? '删除选中片段' : '先在片段条里选中一段'}
                className="w-6 h-6 rounded-md flex items-center justify-center [color:var(--color-text-muted)] hover:text-red-400 hover:bg-red-500/10 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.7} />
              </button>
            </div>

            <div className="flex-1 flex items-center justify-center gap-2">
              <button
                onClick={player.toggle}
                disabled={!clips.length}
                aria-label={player.playing ? '暂停预览' : '播放预览'}
                title={player.playing ? '暂停预览' : '播放预览'}
                className="w-7 h-7 rounded-full flex items-center justify-center text-white bg-brand hover:bg-brand-light disabled:opacity-35 shadow-sm shadow-brand/30 transition-colors"
              >
                {player.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <span className="font-mono text-[11px]">
                <span className="text-brand font-semibold">{formatTimecode(player.playhead)}</span>
                <span className="[color:var(--color-text-muted)] mx-1">/</span>
                <span className="[color:var(--color-text-secondary)]">{formatTimecode(player.total)}</span>
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {statusSuccess && (
                <button
                  onClick={exporter.openResultFolder}
                  aria-label="打开导出目录"
                  title="打开导出目录"
                  className="w-6 h-6 rounded-md flex items-center justify-center text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5" strokeWidth={1.7} />
                </button>
              )}
              <button
                onClick={handleDownload}
                disabled={busy || !clips.length}
                aria-label="导出成片"
                title={exporter.engine && !exporter.engine.available ? 'ffmpeg 未就绪' : '合成 MP4 并在导出文件夹中打开'}
                className="w-6 h-6 rounded-md flex items-center justify-center [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary disabled:opacity-35 transition-colors"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" strokeWidth={1.7} />}
              </button>
              <button
                onClick={() => {
                  // 卡片预览会继续在背后跑：进全屏前先停掉，避免两套播放头同时推进
                  player.pause();
                  setStudioOpen(true);
                }}
                className="h-6 px-1.5 rounded-md flex items-center gap-1 text-[10.5px] font-semibold text-brand hover:bg-brand/12 transition-colors"
                title="全屏编辑：大预览 + 多轨时间线"
              >
                <Maximize2 className="w-3 h-3" strokeWidth={1.9} />
                全屏编辑
              </button>
            </div>
          </div>

          {/* 时间线段 */}
          <div className="px-3 pt-2 pb-3 nodrag" onPointerDown={(e) => e.stopPropagation()}>
            <TimelineStrip
              clips={clips}
              onChange={handleClipsChange}
              selectedId={selectedClipId}
              onSelect={setSelectedClipId}
              playhead={player.playhead}
              onSeek={player.seek}
              playing={player.playing}
              pxPerSecond={CARD_PPS}
              variant="card"
              onAdd={() => setPickerOpen(true)}
              showTrimHandles={trimMode}
              videoMuted={muted}
              audioMuted={muted}
              onToggleVideoMute={toggleMuted}
            />
          </div>

          {/* 状态行：只在「有话说」的时候出现 */}
          {busy && (
            <div className="px-3 pb-2">
              <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-surface-tertiary)' }}>
                <div className="h-full bg-brand transition-[width] duration-300" style={{ width: `${Math.max(6, exporter.mp4.progress)}%` }} />
              </div>
              <div className="mt-1 text-[10px] [color:var(--color-text-muted)]">
                {exporter.mp4.stage || '合成'}中… {Math.round(exporter.mp4.progress)}%
              </div>
            </div>
          )}
          {!busy && statusError && (
            <div className="mx-2.5 mb-2 px-2 py-1.5 rounded-lg text-[10px] leading-relaxed flex gap-1.5 bg-amber-500/10 border border-amber-500/30 text-amber-300">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-[1px]" />
              <span className="break-all">{statusError}</span>
            </div>
          )}
          {!busy && !statusError && statusSuccess && (
            <div className="mx-2.5 mb-2 px-2 py-1.5 rounded-lg text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-1.5">
              <FolderOpen className="w-3 h-3 shrink-0" />
              <span className="flex-1 truncate">
                已成片{(exporter.mp4.task?.duration) ? ` · ${exporter.mp4.task.duration}s` : ''}，已为你打开导出文件夹
              </span>
              <button
                onClick={exporter.downloadResult}
                className="shrink-0 h-5 px-1.5 rounded border border-emerald-500/40 hover:bg-emerald-500/15 transition-colors"
              >
                下载
              </button>
            </div>
          )}
          {notice && (
            <div className="mx-2.5 mb-2 px-2 py-1.5 rounded-lg text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30">{notice}</div>
          )}
        </div>
      )}

      {/* 卡片态「选择素材」：portal 到 body 的独立全屏层。层级口径：
          必须压过全屏编辑器（TimelineStudioModal 的 85）与画布类弹窗（80），
          又必须低于全局层（AiPolishButton 100 / FirstRunWizard 120 / GlobalDialogContainer 99999）。
          95 正落在这个 80 ≤ x < 100 窗口内；与编辑器不同时出现（编辑器打开时卡片已被覆盖）。 */}
      {pickerOpen &&
        createPortal(
          <div className="fixed inset-0 z-[95]">
            <CanvasResourcePickerModal
              isOpen={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onSelect={handleAddMedia}
              slotKey="timeline_clip"
              slotLabel="时间线素材"
              multiSelect
              acceptType="all"
            />
          </div>,
          document.body,
        )}

      {studioOpen &&
        createPortal(
          <TimelineStudioModal
            open={studioOpen}
            onClose={() => setStudioOpen(false)}
            clips={clips}
            onChange={handleClipsChange}
            title={title}
            aspectRatio={project?.aspect_ratio}
            projectId={project?.id}
          />,
          document.body,
        )}
    </div>
  );
};
