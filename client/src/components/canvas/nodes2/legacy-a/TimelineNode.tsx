// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：时间线 `timeline`（合视频轻剪辑，原 nodes/TimelineNode.tsx，卡片宽保持 560）。
 *
 * 逻辑不变：
 * - 唯一数据源 `data.clips`（随画布快照持久化），卡片与全屏编辑器读写同一份；
 * - 上游连线自动入列：`data._ingested` 记下入列过的 `video:URL` / `audio:URL`，用户删掉的片段不会被加回来；
 *   上游值来源 = 旧宿主写入的 `_upstream.video_url|video` / `data.video_url`（音频同理）+ 直接读入边上游节点的产出（kit buildRefs），
 *   新旧宿主都能用；
 * - 大屏预览只在节点选中时显示；工具行：裁剪模式 / 删除选中片段 · 播放 + 时间码 · 导出成片（/timeline/merge 轮询，
 *   成功后打开导出目录）/ 全屏编辑 / 折叠（`data.collapsed`）；片段条拖拽换序、两端裁剪、标尺定位、波形；
 * - 「添加素材」= CanvasResourcePickerModal（多选、视频 / 音频），非视频 / 音频素材给提示跳过；
 * - 全屏编辑 = 原 TimelineStudioModal（portal 到 body，含导出 MP4 / 剪映草稿 /timeline/draft）。
 * 换皮：NodeSkeleton（标题栏在卡片外，双击改名写 data.label = 成片名前缀）+ NodeHandles（video / audio 两个输入）、
 * 卡片内控件 / 片段条 / 预览全部改 --cv-* 变量与 Tabler 图标（TimelineCardStrip / TimelineCardPreview）。
 * 浮动工具栏：添加素材；合成成功后「下载」指向成片、「打开导出目录」；「全屏」= 打开全屏编辑器。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeProps } from '@xyflow/react';
import {
  IconAlertTriangle, IconArrowsMaximize, IconChevronDown, IconChevronUp, IconDownload, IconFolderOpen, IconLoader2,
  IconPlayerPauseFilled, IconPlayerPlayFilled, IconPlus, IconScissors, IconTimeline, IconTrash,
} from '@tabler/icons-react';
import {
  appendClip, clipFromUrl, clipIndexAt, clipStartAt, formatTimecode, isClipPending, mediaKindFromUrl, removeClip,
  type TimelineClip,
} from '../../../../types/timeline';
import { useProjectStore } from '../../../../stores/useProjectStore';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { CanvasResourcePickerModal } from '../../CanvasResourcePickerModal';
import { TimelineStudioModal } from '../../timeline/TimelineStudioModal';
import { useTimelinePlayer } from '../../timeline/useTimelinePlayer';
import { defaultExportTitle, useTimelineExport } from '../../timeline/useTimelineExport';
import { NodeSkeleton, ToolbarButton, useKitNodeActions, useNodeReferences } from '../../kit';
import { TimelineCardPreview } from './TimelineCardPreview';
import { TimelineCardStrip } from './TimelineCardStrip';
import { LaButton, LaNotice, LaProgress } from './ui';
import { EMPTY_DATA, NO_CANVAS, interactiveGuards, stopProp, upstreamMedia } from './helpers';

export const TIMELINE_TYPE = 'timeline';
/** 卡片按参考图做成横向长条：窄卡上时间线挤成一团，读不出片段 */
export const TIMELINE_WIDTH = 560;
/** 每秒钟像素宽度（卡片口径；全屏编辑器另有口径） */
const CARD_PPS = 26;

export interface TimelineData extends Record<string, unknown> {
  label?: string;
  clips?: TimelineClip[];
  collapsed?: boolean;
  _ingested?: string[];
  _upstream?: Record<string, unknown>;
  video_url?: string;
  audio_url?: string;
}

export function TimelineNode(props: NodeProps) {
  const { id, selected } = props;
  const d = (props.data || EMPTY_DATA) as TimelineData;
  const actions = useKitNodeActions(id);
  const updateRef = useRef(actions.update);
  updateRef.current = actions.update;

  const clips: TimelineClip[] = useMemo(() => (Array.isArray(d.clips) ? d.clips : []), [d.clips]);
  const collapsed = !!d.collapsed;
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [trimMode, setTrimMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 整体静音：默认静音，避免在画布上突然出声；卡片上只有一个总开关（全屏编辑器里才分视频 / 音频两轨）
  const [muted, setMuted] = useState(true);
  const toggleMuted = () => setMuted((v) => !v);

  const project = useProjectStore((s) => s.project);
  const player = useTimelinePlayer(clips);
  const baseName = d.label || project?.title || '时间线';
  const title = defaultExportTitle(baseName, clips);
  const exporter = useTimelineExport({ clips, title, aspectRatio: project?.aspect_ratio, projectId: project?.id });

  // —— 上游连线自动入列 ——
  const { refs } = useNodeReferences(id, { handleId: null });
  const ingested: string[] = useMemo(() => (Array.isArray(d._ingested) ? d._ingested : []), [d._ingested]);
  const pendingUpstream = useMemo(
    () => upstreamMedia(d, refs).filter((m) => !ingested.includes(`${m.kind}:${m.url}`)),
    [d, refs, ingested],
  );
  const pendingKey = pendingUpstream.map((m) => `${m.kind}:${m.url}`).join('|');
  useEffect(() => {
    if (!pendingUpstream.length) return;
    const additions = pendingUpstream.map((m) => clipFromUrl(m.url, { kind: m.kind }));
    const next = additions.reduce((acc, c) => appendClip(acc, c), clips);
    updateRef.current({ clips: next, _ingested: [...ingested, ...pendingUpstream.map((m) => `${m.kind}:${m.url}`)] });
    // pendingKey 覆盖了 pendingUpstream 的内容；clips / ingested 变化时 pendingKey 会随之变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

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
      handleClipsChange(accepted.reduce((acc, c) => appendClip(acc, c), clips));
      setNotice(null);
    }
    if (rejected.length) setNotice(`已跳过 ${rejected.length} 个非视频/音频素材：${rejected.slice(0, 2).join('、')}`);
  };

  // 预览大屏跟播放头走：停在末尾时定格最后一帧（与全屏编辑器一致）
  const rawIndex = clipIndexAt(clips, player.playhead);
  const activeIndex = rawIndex >= 0 ? rawIndex : clips.length - 1;
  const activeClip = activeIndex >= 0 ? clips[activeIndex] : null;
  const localTime = activeClip
    ? Math.min(activeClip.out, activeClip.in + Math.max(0, player.playhead - clipStartAt(clips, activeIndex)))
    : 0;

  const deleteSelected = () => {
    if (!selectedClipId) return;
    handleClipsChange(removeClip(clips, selectedClipId));
  };
  const openStudio = () => {
    // 卡片预览会继续在背后跑：进全屏前先停掉，避免两套播放头同时推进
    player.pause();
    setStudioOpen(true);
  };

  const busy = exporter.mp4.status === 'running';
  const statusError = exporter.mp4.error;
  const statusSuccess = exporter.mp4.status === 'success';
  const pendingCount = clips.filter(isClipPending).length;
  const outputUrl = statusSuccess && exporter.mp4.task?.output_url ? resolveMediaUrl(exporter.mp4.task.output_url) : '';
  const exportTitle = exporter.engine && !exporter.engine.available ? 'ffmpeg 未就绪' : `合成 MP4「${title}」并在导出文件夹中打开`;

  // portal 出去的弹层在 React 树上仍挂在节点里：拦住右键 / 双击，免得冒泡触发节点菜单与「双击聚焦」
  const portalGuards = { onContextMenu: stopProp, onDoubleClick: stopProp };

  return (
    <NodeSkeleton
      node={props}
      label={baseName}
      icon={IconTimeline}
      width={TIMELINE_WIDTH}
      onRefresh={exporter.refreshEngine}
      toolbar={<ToolbarButton icon={IconPlus} title="添加素材（画布产出 / 素材库 / 本地文件）" onClick={() => setPickerOpen(true)}>添加素材</ToolbarButton>}
      toolbarRight={statusSuccess ? <ToolbarButton icon={IconFolderOpen} title="打开导出目录" iconOnly onClick={exporter.openResultFolder} /> : null}
      downloadUrl={outputUrl || undefined}
      downloadName={exporter.mp4.task?.output_url ? exporter.mp4.task.output_url.split('/').pop() : undefined}
      onFullscreen={openStudio}
      fullscreenDisabled={false}
    >
      {collapsed ? (
        <div className="cv-la">
          <div className="cv-la-row cv-la-small cv-la-text-3">
            <span className="cv-la-mono">{clips.length} 段</span>
            <span>·</span>
            <span className="cv-la-mono">{formatTimecode(player.total)}</span>
            <span className="cv-la-grow cv-la-truncate">时间线已折叠</span>
            <LaButton variant="text" size="xs" icon={IconChevronDown} onClick={() => updateRef.current({ collapsed: false })} aria-label="展开时间线" title="展开">
              展开
            </LaButton>
          </div>
        </div>
      ) : (
        <div className="cv-la">
          {/* 大屏预览：只在节点选中时显示；未播放时定格在播放头所在帧，点画面即在该屏上播放 */}
          {selected && (
            <div className={NO_CANVAS} onPointerDown={stopProp} {...interactiveGuards}>
              <TimelineCardPreview
                clip={activeClip}
                localTime={localTime}
                playing={player.playing}
                onToggle={player.toggle}
                videoMuted={muted}
                audioMuted={muted}
              />
            </div>
          )}

          {/* 工具行：左（裁剪 / 删除）· 中（播放 + 时间码）· 右（导出成片 / 全屏编辑 / 折叠） */}
          <div className={`cv-la-tl-tools ${NO_CANVAS}`} {...interactiveGuards}>
            <LaButton
              variant="text"
              size="sm"
              iconOnly
              icon={IconScissors}
              active={trimMode}
              aria-pressed={trimMode}
              onClick={() => setTrimMode((v) => !v)}
              title="裁剪：打开后选中片段的左右把手常显，拖两端改入出点"
            />
            <LaButton
              variant="text"
              size="sm"
              iconOnly
              icon={IconTrash}
              disabled={!selectedClipId}
              onClick={deleteSelected}
              title={selectedClipId ? '删除选中片段' : '先在片段条里选中一段'}
            />
            <div className="cv-la-tl-tools__center">
              <button
                type="button"
                className="cv-la-play"
                onClick={player.toggle}
                disabled={!clips.length}
                aria-label={player.playing ? '暂停预览' : '播放预览'}
                title={player.playing ? '暂停预览' : '播放预览'}
              >
                {player.playing ? <IconPlayerPauseFilled size={14} aria-hidden /> : <IconPlayerPlayFilled size={14} aria-hidden />}
              </button>
              <span className="cv-la-timecode cv-la-mono" aria-label="播放头 / 总时长">
                <span className="cv-la-timecode__now">{formatTimecode(player.playhead)}</span>
                <span className="cv-la-timecode__sep">/</span>
                <span className="cv-la-timecode__total">{formatTimecode(player.total)}</span>
              </span>
              {pendingCount > 0 && <IconLoader2 size={14} className="cv-la-spin cv-la-accent" aria-label="正在读取片段时长" />}
            </div>
            {statusSuccess && (
              <LaButton variant="text" size="sm" iconOnly icon={IconFolderOpen} onClick={exporter.openResultFolder} title="打开导出目录" />
            )}
            <LaButton
              variant="text"
              size="sm"
              iconOnly
              icon={IconDownload}
              loading={busy}
              disabled={!clips.length}
              onClick={() => void exporter.exportMp4()}
              title={exportTitle}
              aria-label="导出成片"
            />
            <LaButton variant="text" size="sm" icon={IconArrowsMaximize} iconSize={14} className="cv-la-accent" onClick={openStudio} title="全屏编辑：大预览 + 多轨时间线">
              全屏编辑
            </LaButton>
            <LaButton
              variant="text"
              size="sm"
              iconOnly
              icon={IconChevronUp}
              onClick={() => updateRef.current({ collapsed: true })}
              title="折叠"
              aria-label="折叠时间线"
            />
          </div>

          {/* 时间线段 */}
          <div className={NO_CANVAS} onPointerDown={stopProp} {...interactiveGuards}>
            <TimelineCardStrip
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
            <div className="cv-la-field-row">
              <LaProgress value={Math.max(6, exporter.mp4.progress)} label="成片合成进度" />
              <span className="cv-la-tiny cv-la-text-3">{exporter.mp4.stage || '合成'}中… {Math.round(exporter.mp4.progress)}%</span>
            </div>
          )}
          {!busy && statusError && (
            <LaNotice tone="danger" icon={IconAlertTriangle} role="alert">
              <span className="cv-la-break">{statusError}</span>
            </LaNotice>
          )}
          {!busy && !statusError && statusSuccess && (
            <LaNotice tone="accent" icon={IconFolderOpen} role="status">
              <div className="cv-la-row">
                <span className="cv-la-grow cv-la-truncate">
                  已成片{exporter.mp4.task?.duration ? ` · ${exporter.mp4.task.duration}s` : ''}，已为你打开导出文件夹
                </span>
                <LaButton size="xs" onClick={exporter.downloadResult}>下载</LaButton>
              </div>
            </LaNotice>
          )}
          {notice && <LaNotice>{notice}</LaNotice>}
        </div>
      )}

      {/* 卡片态「选择素材」：portal 到 body 的独立全屏层（z 95：压过全屏编辑器 85 与画布弹窗 80，低于全局层 100+） */}
      {pickerOpen &&
        createPortal(
          <div style={{ position: 'fixed', inset: 0, zIndex: 95 }} {...portalGuards}>
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
          <div style={{ display: 'contents' }} {...portalGuards}>
            <TimelineStudioModal
              open={studioOpen}
              onClose={() => setStudioOpen(false)}
              clips={clips}
              onChange={handleClipsChange}
              title={title}
              aspectRatio={project?.aspect_ratio}
              projectId={project?.id}
            />
          </div>,
          document.body,
        )}
    </NodeSkeleton>
  );
}

export default TimelineNode;
