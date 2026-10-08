// -*- coding: utf-8 -*-
/**
 * 全屏时间线编辑器 —— 合视频轻剪辑的工作态。
 *
 * 形态对齐参考图：顶部标题 +「导出」下拉（**只保留 MP4 与剪映工程两项**，XML/达芬奇/
 * Premiere/FCP 本轮不做）、左侧素材面板、中央大预览 + 独立控制栏、
 * 底部多轨时间线（轨道头固定、内容横向滚动）。片段属性不在侧栏：
 * **右键片段 →「属性」→ 弹窗**（画布节点的右键菜单在全屏内被禁用）。
 *
 * 单一数据源：片段来自节点 `data.clips`，本组件只经 `onChange` 回写，
 * 不持有第二份片段状态 —— 卡片态与全屏态因此永远一致。
 */
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, Film, FolderOpen, Loader2, Scissors, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { appendClip, clipFromUrl, clipIndexAt, clipStartAt, formatTimecode, mediaKindFromUrl, timelineTotal, type TimelineClip } from '../../../types/timeline';
import { useEscapeClose } from '../../../hooks/useEscapeClose';
import { CanvasResourcePickerModal } from '../CanvasResourcePickerModal';
import { TimelineClipInspector } from './TimelineClipInspector';
import { TimelinePreview } from './TimelinePreview';
import { TimelineStrip } from './TimelineStrip';
import { TimelineStudioAssets } from './TimelineStudioAssets';
import { useTimelinePlayer } from './useTimelinePlayer';
import { useTimelineExport } from './useTimelineExport';

interface Props {
  open: boolean;
  onClose: () => void;
  clips: TimelineClip[];
  onChange: (clips: TimelineClip[]) => void;
  title: string;
  aspectRatio?: string;
  projectId?: string;
}

const STUDIO_PPS = 46;

export const TimelineStudioModal: React.FC<Props> = ({ open, onClose, clips, onChange, title, aspectRatio, projectId }) => {
  const player = useTimelinePlayer(clips);
  const exporter = useTimelineExport({ clips, title, aspectRatio, projectId });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [trimMode, setTrimMode] = useState(false);
  // 视频音轨 / 音频音轨：默认静音，轨道头喇叭可单独开关（参考图左下角双轨控制）
  const [videoMuted, setVideoMuted] = useState(true);
  const [audioMuted, setAudioMuted] = useState(true);
  // 片段右键菜单 →「属性」弹窗（替代原右侧属性栏）
  const [ctxMenu, setCtxMenu] = useState<{ clip: TimelineClip; x: number; y: number } | null>(null);
  const [propsClipId, setPropsClipId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEscapeClose(open, onClose);
  // 内层弹窗 / 右键菜单各自进 Esc 栈：不注册的话栈顶恒为 studio 的 onClose，
  // 按 Esc 会把整个全屏编辑器一起关掉，而不是只关最内层。
  // 注册条件必须与各自的渲染条件严格一致：片段可能已被删除（属性弹窗不再渲染），
  // 条件写宽会出现「弹窗看不见却占着栈顶」→ 第一次按 Esc 像失灵。
  useEscapeClose(!!propsClipId && clips.some((c) => c.id === propsClipId), () => setPropsClipId(null));
  useEscapeClose(ctxMenu !== null, () => setCtxMenu(null));

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  if (!open) return null;

  const total = timelineTotal(clips);
  // 播放头停在成片末尾时 clipIndexAt 返回 -1，此时定格最后一帧（而不是切回空状态画面）
  const rawIndex = clipIndexAt(clips, player.playhead);
  const activeIndex = rawIndex >= 0 ? rawIndex : clips.length - 1;
  const activeClip = activeIndex >= 0 ? clips[activeIndex] : null;
  const localTime = activeClip
    ? Math.min(activeClip.out, activeClip.in + Math.max(0, player.playhead - clipStartAt(clips, activeIndex)))
    : 0;
  const selectedClip = clips.find((c) => c.id === selectedId) || null;
  const ffmpegReady = !!exporter.engine?.available;
  const busy = exporter.busy;

  const handleClips = (next: TimelineClip[]) => {
    onChange(next);
    if (selectedId && !next.some((c) => c.id === selectedId)) setSelectedId(null);
  };

  const handleAddUrls = (urls: string[]) => {
    const usable = urls.filter((u) => u && mediaKindFromUrl(u));
    if (usable.length !== urls.length) setNotice('已跳过非视频/音频的素材（合片只接受视频与音频）');
    if (!usable.length) return;
    const next = usable.reduce(
      (acc, u) => appendClip(acc, clipFromUrl(u, { kind: mediaKindFromUrl(u) || 'video' })),
      clips,
    );
    if (next.length === clips.length) setNotice('这些素材已经在时间线里了，未重复添加');
    else onChange(next);
  };

  // ── 层级口径（本仓库没有全局统一的 z-index 规范，这里固定口径，数值维持现状）──
  // 根层 85：必须是画布内的最高层 —— 高于画布类弹窗 80（CanvasManagerModal /
  //   SlotManagerModal / BindPreviewModal）与节点参数弹窗 60（NodeAgentConsole）；
  //   必须低于全局层（AiPolishButton 全屏 100 / FirstRunWizard 120 /
  //   GlobalDialogContainer 99999），否则全局对话框会被全屏编辑器盖住。
  //   85 正落在 80 ≤ x < 100 窗口内，故不必调整数值。
  // 内部层 88（右键遮罩）/ 89（右键菜单）/ 90（属性弹窗）：根已有 z-index，已建立
  //   堆叠上下文，这三个数只在编辑器**内部**比大小，不会与外部任何 z 值竞争。
  return (
    <div
      className="fixed inset-0 z-[85] flex flex-col"
      style={{
        // 背景跟随主题：白天白色系 / 黑夜黑色系，不硬编码深色（否则白天下面板对比刺眼）
        background: 'color-mix(in srgb, var(--color-background) 92%, transparent)',
        backdropFilter: 'blur(6px)',
      }}
      onContextMenu={(e) => {
        // 禁止画布节点的右键菜单在全屏编辑器里复用弹出；片段右键菜单自带 stopPropagation 不受影响
        e.preventDefault();
      }}
    >
      {/* 顶部栏 */}
      <div className="h-12 px-4 flex items-center gap-3 border-b border-white/70 dark:border-white/12 shrink-0" style={{ background: 'var(--color-surface)' }}>
        <Film className="w-4 h-4 text-brand" strokeWidth={1.8} />
        <span className="text-[13.5px] font-semibold [color:var(--color-text-main)]">{title}</span>
        <span className="font-mono text-[10.5px] [color:var(--color-text-muted)]">
          {clips.length} 段 · {formatTimecode(total, { withHours: true })}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {!ffmpegReady && !exporter.engineLoading && (
            <span className="hidden lg:block max-w-[420px] truncate text-[10px] text-amber-300" title={exporter.engine?.ffmpeg_hint}>
              {exporter.engine?.ffmpeg_hint || 'ffmpeg 未就绪：可改用导出剪映草稿'}
            </span>
          )}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="h-8 px-3 rounded-lg bg-brand hover:bg-brand-light text-white text-[11.5px] font-semibold flex items-center gap-1.5 shadow-lg shadow-brand/25 transition-colors"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" strokeWidth={1.9} />}
              导出
              <ChevronDown className="w-3 h-3" strokeWidth={2} />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-[calc(100%+6px)] w-[220px] p-1 rounded-xl border border-white/70 dark:border-white/12 shadow-2xl z-10" style={{ background: 'var(--color-surface)' }}>
                <button
                  role="menuitem"
                  disabled={!ffmpegReady || busy}
                  onClick={() => {
                    setMenuOpen(false);
                    exporter.exportMp4();
                  }}
                  title={ffmpegReady ? '服务端 ffmpeg 合成为一条 MP4' : exporter.engine?.ffmpeg_hint || 'ffmpeg 未就绪'}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[11.5px] [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-surface/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Download className="w-3.5 h-3.5" strokeWidth={1.8} />
                  导出为 MP4
                  {!ffmpegReady && <span className="ml-auto text-[9.5px] text-amber-300">未就绪</span>}
                </button>
                <button
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    exporter.exportDraft();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[11.5px] [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-surface/80 disabled:opacity-40 transition-colors"
                >
                  <Film className="w-3.5 h-3.5" strokeWidth={1.8} />
                  导出到剪映草稿
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="关闭时间线编辑器"
            title="关闭（Esc）"
            className="w-7 h-7 rounded-lg border border-white/70 dark:border-white/12 flex items-center justify-center [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] transition-colors"
          >
            <X className="w-3.5 h-3.5" strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {/* 导出状态条：只在有进度/结果/错误时出现 */}
      {(busy || exporter.mp4.error || exporter.mp4.status === 'success' || exporter.draft.status !== 'idle') && (
        <div className="px-4 py-2 border-b border-white/70 dark:border-white/12 flex items-center gap-2 text-[11px] shrink-0" style={{ background: 'var(--color-surface-secondary)' }}>
          {busy && (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" />
              <span className="[color:var(--color-text-secondary)]">{exporter.mp4.status === 'running' ? exporter.mp4.stage || '合成' : '导出草稿'}中…</span>
              <span className="flex-1 max-w-[240px] h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-surface-tertiary)' }}>
                <span className="block h-full bg-brand transition-[width] duration-300" style={{ width: `${Math.max(6, exporter.mp4.progress)}%` }} />
              </span>
            </>
          )}
          {!busy && exporter.mp4.error && (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="text-amber-300 break-all">{exporter.mp4.error}</span>
              {!ffmpegReady && (
                <button onClick={exporter.exportDraft} className="ml-auto shrink-0 h-6 px-2 rounded-md border border-amber-500/40 text-amber-200 hover:bg-amber-500/15 transition-colors">
                  改用导出剪映草稿
                </button>
              )}
            </>
          )}
          {!busy && exporter.mp4.status === 'success' && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-300">
                已成片 {exporter.mp4.task?.duration ? `· ${exporter.mp4.task.duration}s` : ''} · {(exporter.mp4.task?.output_url || '').split('/').pop()}
              </span>
              <button onClick={exporter.downloadResult} className="ml-auto shrink-0 h-6 px-2 rounded-md border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/15 transition-colors">
                下载成片
              </button>
              <button onClick={exporter.openResultFolder} className="shrink-0 h-6 px-2 rounded-md border border-white/70 dark:border-white/12 [color:var(--color-text-secondary)] hover:text-brand hover:border-brand/50 transition-colors">
                打开目录
              </button>
            </>
          )}
          {!busy && exporter.draft.status === 'success' && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-300 break-all">剪映草稿已生成：{exporter.draft.result?.export_dir}</span>
            </>
          )}
          {!busy && exporter.draft.status === 'error' && (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-amber-300 break-all">{exporter.draft.error}</span>
            </>
          )}
        </div>
      )}

      {/* 素材提示（跳过非视频/音频、导入结果等一次性反馈） */}
      {notice && (
        <div className="px-4 py-1.5 border-b border-white/70 dark:border-white/12 flex items-center gap-2 text-[10.5px] text-amber-300 shrink-0" style={{ background: 'var(--color-surface-secondary)' }}>
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="break-all">{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭提示" className="ml-auto [color:var(--color-text-muted)] hover:[color:var(--color-text-main)]">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* 主体：素材面板 / 预览 / 属性 */}
      <div className="flex-1 flex min-h-0">
        <TimelineStudioAssets
          clips={clips}
          projectId={projectId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAddUrls={handleAddUrls}
          onBrowse={() => setPickerOpen(true)}
          onNotice={setNotice}
        />
        <div className="flex-1 min-w-0 flex flex-col px-3 py-3">
          {/* 预览大屏：独立圆角面板（对齐参考图，素材/属性面板同为浮动圆角卡片） */}
          <div className="flex-1 min-h-0 rounded-2xl overflow-hidden border border-white/70 dark:border-white/12">
            <TimelinePreview
              clip={activeClip}
              localTime={localTime}
              playing={player.playing}
              playhead={player.playhead}
              total={total}
              onToggle={player.toggle}
              variant="studio"
              videoMuted={videoMuted}
              audioMuted={audioMuted}
              onToggleVolume={() => {
                const next = !(videoMuted && audioMuted);
                setVideoMuted(next);
                setAudioMuted(next);
              }}
            />
          </div>
        </div>
      </div>

      {/* 底部区：工具条 + 多轨时间线（浮动圆角面板，轨道头与静音已内置在 TimelineStrip 左侧） */}
      <div
        className="mx-3 mb-3 h-[206px] shrink-0 rounded-2xl border border-white/70 dark:border-white/12 overflow-hidden flex flex-col"
        style={{ background: 'var(--color-surface)' }}
      >
        {/* 时间线工具条（参考图：左为片段操作，右为输出动作） */}
        <div className="h-9 px-3 flex items-center gap-1 border-b border-white/70 dark:border-white/12 shrink-0">
          <button
            onClick={() => setTrimMode((v) => !v)}
            aria-pressed={trimMode}
            aria-label="裁剪模式"
            title="裁剪：打开后片段的左右把手常显，拖两端改入出点"
            className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
              trimMode ? 'bg-brand/15 text-brand' : '[color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface/80'
            }`}
          >
            <Scissors className="w-3.5 h-3.5" strokeWidth={1.7} />
          </button>
          <button
            onClick={() => {
              if (!selectedId) return;
              handleClips(clips.filter((c) => c.id !== selectedId));
            }}
            disabled={!selectedId}
            aria-label="删除选中片段"
            title={selectedId ? '删除选中片段' : '先在时间线里选中一段'}
            className="w-6 h-6 rounded-md flex items-center justify-center [color:var(--color-text-muted)] hover:text-red-400 hover:bg-red-500/10 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.7} />
          </button>
          <span className="mx-1 h-4 w-px" style={{ background: 'var(--color-border)' }} />
          <span className="text-[10.5px] [color:var(--color-text-muted)]">
            {clips.length} 段 · {formatTimecode(total, { withHours: true })}
          </span>
          {selectedClip && <span className="text-[10.5px] text-brand truncate max-w-[220px]">已选：{selectedClip.name}</span>}
          <span className="flex-1" />
          {exporter.mp4.status === 'success' && (
            <button
              onClick={exporter.openResultFolder}
              className="h-6 px-2 rounded-md border border-emerald-500/40 text-[10.5px] text-emerald-300 hover:bg-emerald-500/15 flex items-center gap-1 transition-colors"
            >
              <FolderOpen className="w-3 h-3" strokeWidth={1.8} />
              打开导出文件夹
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 px-3 py-2">
          <TimelineStrip
            clips={clips}
            onChange={handleClips}
            selectedId={selectedId}
            onSelect={setSelectedId}
            playhead={player.playhead}
            onSeek={player.seek}
            playing={player.playing}
            pxPerSecond={STUDIO_PPS}
            variant="studio"
            onAdd={() => setPickerOpen(true)}
            showTrimHandles={trimMode}
            videoMuted={videoMuted}
            audioMuted={audioMuted}
            onToggleVideoMute={() => setVideoMuted((v) => !v)}
            onToggleAudioMute={() => setAudioMuted((v) => !v)}
            onClipContextMenu={(clip, pos) => {
              setSelectedId(clip.id);
              setCtxMenu({ clip, x: pos.x, y: pos.y });
            }}
          />
        </div>
      </div>

      {/* 片段右键菜单：仅「属性」一项（点击空白/再右键关闭） */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-[88]"
            onPointerDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            role="menu"
            className="fixed z-[89] min-w-[128px] p-1 rounded-xl border border-white/70 dark:border-white/12 shadow-2xl"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 148),
              top: Math.min(ctxMenu.y, window.innerHeight - 64),
              background: 'var(--color-surface)',
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                setPropsClipId(ctxMenu.clip.id);
                setCtxMenu(null);
              }}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[11.5px] [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-surface/80 transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" strokeWidth={1.8} />
              属性
            </button>
          </div>
        </>
      )}

      {/* 片段属性弹窗（原右侧属性栏的弹窗化） */}
      {(() => {
        const propsClip = clips.find((c) => c.id === propsClipId) || null;
        if (!propsClip) return null;
        return (
          <div className="fixed inset-0 z-[90] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.35)' }}>
            <TimelineClipInspector
              embedded
              clip={propsClip}
              clips={clips}
              total={total}
              onChange={handleClips}
              onClose={() => setPropsClipId(null)}
            />
          </div>
        );
      })()}

      {pickerOpen && (
        <CanvasResourcePickerModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(urls) => handleAddUrls(Array.isArray(urls) ? urls : [urls])}
          slotKey="timeline_clip"
          slotLabel="时间线素材"
          multiSelect
          acceptType="all"
        />
      )}
    </div>
  );
};


