// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 参考列表（对照 Toonflow components/referenceItem.vue + referenceCard.vue）：
 * 横向 48×48 卡片（最小高 48、间距 8），左上角序号、右上角删除、视频底部时长条；
 * 拖拽重排（原生 HTML5 DnD）或 Alt+←/→ 键盘移动 → moveRef，提示词里的 {{ref N}} 编号随之改变。
 */
import { useState, type DragEvent, type KeyboardEvent, type SyntheticEvent } from 'react';
import { IconFileText, IconMusic, IconPhoto, IconPlayerPlay, IconVideo, IconX } from '@tabler/icons-react';
import type { RefItem, Slot } from './types';

export const SLOT_LABELS: Record<Slot, string> = {
  first_frame: '首帧',
  last_frame: '尾帧',
  reference_images: '参考图',
  camera_prompt: '机位',
  ref_audio: '参考音频',
  reference_video: '参考视频',
  prompt: '提示词',
};

export interface RefListProps {
  refs: readonly RefItem[];
  onMove: (from: number, to: number) => void;
  onRemove?: (item: RefItem) => void;
  /** 点击卡片（预览）。 */
  onPreview?: (item: RefItem, index: number) => void;
  /** 卡片底部显示槽位（显式 role 或 assembleInputs 的分配结果）。 */
  slotOf?: (item: RefItem) => Slot | null | undefined;
  className?: string;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 卡片悬停提示（Toonflow：引用 N：内容）。 */
export function refTitle(item: RefItem, index: number): string {
  const content = !item.value ? '暂无内容'
    : item.dataType === 'STRING' ? item.value
      : item.dataType === 'VIDEO' ? '视频' : item.dataType === 'AUDIO' ? '音频' : '图片';
  return `引用 ${index}：${item.label ? `${item.label} · ` : ''}${content.length > 120 ? `${content.slice(0, 120)}…` : content}`;
}

function RefCard({ item, index, slot, onRemove, onPreview }: { item: RefItem; index: number; slot?: Slot | null; onRemove?: () => void; onPreview?: () => void }) {
  const [error, setError] = useState(false);
  const [duration, setDuration] = useState('');
  const Icon = item.dataType === 'IMAGE' ? IconPhoto : item.dataType === 'VIDEO' ? IconVideo : item.dataType === 'AUDIO' ? IconMusic : IconFileText;
  const showImage = item.dataType === 'IMAGE' && !!item.value && !error;
  const showVideoThumb = item.dataType === 'VIDEO' && !!item.thumb && !error;
  const showVideo = item.dataType === 'VIDEO' && !!item.value && !item.thumb && !error;
  return (
    <>
      {showImage ? (
        <img className="cv-ref__preview" src={item.thumb || item.value} alt={`预览引用 ${index}`} draggable={false} onError={() => setError(true)} />
      ) : showVideoThumb ? (
        <img className="cv-ref__preview" src={item.thumb} alt={`预览引用 ${index}`} draggable={false} onError={() => setError(true)} />
      ) : showVideo ? (
        <video
          className="cv-ref__preview"
          src={item.value}
          preload="metadata"
          muted
          playsInline
          aria-hidden
          onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d >= 0) setDuration(formatDuration(d)); }}
          onError={() => setError(true)}
        />
      ) : (
        <Icon size={21} aria-hidden />
      )}
      {onPreview && <span style={{ position: 'absolute', inset: 0, cursor: 'zoom-in' }} onClick={(e) => { e.stopPropagation(); onPreview(); }} aria-hidden />}
      {onRemove && (
        <button
          type="button"
          className="cv-ref__remove nodrag nopan"
          title="删除引用"
          aria-label={`删除引用 ${index}`}
          draggable={false}
          onPointerDown={stop}
          onMouseDown={stop}
          onDoubleClick={stop}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          <IconX size={12} aria-hidden />
        </button>
      )}
      <span className="cv-ref__index" aria-hidden>{index}</span>
      {slot ? (
        <span className="cv-ref__role" aria-hidden>{SLOT_LABELS[slot]}</span>
      ) : item.dataType === 'VIDEO' && (showVideo || showVideoThumb) ? (
        <span className="cv-ref__info" aria-hidden><IconPlayerPlay size={12} />{duration && <span>{duration}</span>}</span>
      ) : null}
    </>
  );
}

export function RefList({ refs, onMove, onRemove, onPreview, slotOf, className }: RefListProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const onDragStart = (i: number) => (e: DragEvent<HTMLDivElement>) => {
    e.stopPropagation();
    setDragFrom(i);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/x-cv-ref', String(i)); } catch { /* 部分环境不支持自定义类型 */ }
  };
  const onDragOver = (i: number) => (e: DragEvent<HTMLDivElement>) => {
    if (dragFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt !== i) setDropAt(i);
  };
  const onDrop = (i: number) => (e: DragEvent<HTMLDivElement>) => {
    if (dragFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragFrom !== i) onMove(dragFrom, i);
    setDragFrom(null);
    setDropAt(null);
  };
  const onDragEnd = () => { setDragFrom(null); setDropAt(null); };
  const onKey = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    e.stopPropagation();
    const to = e.key === 'ArrowLeft' ? i - 1 : i + 1;
    if (to >= 0 && to < refs.length) onMove(i, to);
  };

  return (
    <div className={['cv-reflist nodrag nopan nowheel', className].filter(Boolean).join(' ')} role="list" aria-label="输入引用" onPointerDown={stop} onMouseDown={stop}>
      {refs.map((item, i) => (
        <div
          key={item.key}
          role="listitem"
          tabIndex={0}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
          aria-label={refTitle(item, i + 1)}
          title={`${refTitle(item, i + 1)}\n拖拽或 Alt+←/→ 调整顺序`}
          className={['cv-ref', dragFrom === i ? 'is-dragging' : '', dropAt === i && dragFrom !== i ? 'is-drop-target' : ''].filter(Boolean).join(' ')}
          draggable
          onDragStart={onDragStart(i)}
          onDragOver={onDragOver(i)}
          onDrop={onDrop(i)}
          onDragEnd={onDragEnd}
          onKeyDown={onKey(i)}
        >
          <RefCard
            item={item}
            index={i + 1}
            slot={slotOf ? slotOf(item) : item.role}
            onRemove={onRemove ? () => onRemove(item) : undefined}
            onPreview={onPreview ? () => onPreview(item, i) : undefined}
          />
        </div>
      ))}
    </div>
  );
}
