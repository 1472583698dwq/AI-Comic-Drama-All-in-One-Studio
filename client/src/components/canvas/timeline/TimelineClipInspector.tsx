// -*- coding: utf-8 -*-
/**
 * 全屏编辑器右侧属性面板：选中片段的精确信息 + 入出点数字输入。
 *
 * 为什么保留数字输入：拖把手适合「看着调」，而修剪到某一帧需要「敲数字」。
 * 两个入口写的是同一份 in/out，改动经 `clampClip` 规整后立即回写。
 */
import React, { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { MIN_CLIP_SECONDS, clampClip, clipSpan, formatTimecode, type TimelineClip } from '../../../types/timeline';

interface Props {
  clip: TimelineClip | null;
  clips: TimelineClip[];
  total: number;
  onChange: (clips: TimelineClip[]) => void;
  /** 弹窗内使用：去掉侧栏外边距，宽度适配弹窗卡片 */
  embedded?: boolean;
  /** 弹窗形态下提供右上角关闭按钮（遮罩点击不关闭时唯一的关闭入口） */
  onClose?: () => void;
}

const FIELD = 'w-full bg-transparent border border-border rounded-md px-1.5 py-1 font-mono text-[11px] [color:var(--color-text-main)] focus:outline-none focus:border-brand';
const LABEL = 'text-[10px] [color:var(--color-text-muted)]';

/**
 * 数字输入用「本地文本 + 失焦/回车提交」：直接受控于 number 会让用户
 * 敲到 "1." 时被 Number() 吞掉小数点，根本没法输入小数秒。失焦即规整回写。
 */
const NumberField: React.FC<{
  value: number;
  min: number;
  max?: number;
  onCommit: (value: number) => void;
}> = ({ value, min, max, onCommit }) => {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const commit = () => {
    const parsed = Number(text);
    onCommit(Number.isFinite(parsed) ? parsed : value);
    setFocused(false);
  };

  return (
    <input
      className={FIELD}
      type="number"
      min={min}
      max={max}
      step={0.1}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
};

export const TimelineClipInspector: React.FC<Props> = ({ clip, clips, total, onChange, embedded = false, onClose }) => {
  const patchClip = (patch: Partial<TimelineClip>) => {
    onChange(clips.map((c) => (c.id === clip?.id ? clampClip({ ...c, ...patch }) : c)));
  };

  return (
    <div
      className={
        embedded
          ? 'w-[340px] rounded-2xl border border-border overflow-hidden flex flex-col'
          : 'w-[196px] shrink-0 my-3 mr-3 rounded-2xl border border-border overflow-hidden flex flex-col'
      }
      style={{ background: 'var(--color-surface)' }}
    >
      <div className="h-9 px-3 flex items-center border-b border-border text-[11px] font-semibold [color:var(--color-text-secondary)]">
        属性
        {onClose && (
          <button
            onClick={onClose}
            aria-label="关闭属性弹窗"
            title="关闭"
            className="ml-auto w-6 h-6 rounded-md flex items-center justify-center [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary transition-colors"
          >
            <X className="w-3.5 h-3.5" strokeWidth={1.8} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {!clip && (
          <div className="space-y-2 text-[10.5px] [color:var(--color-text-muted)] leading-relaxed">
            <div className="flex items-center justify-between">
              <span>片段数量</span>
              <span className="font-mono [color:var(--color-text-main)]">{clips.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>成片总时长</span>
              <span className="font-mono [color:var(--color-text-main)]">{formatTimecode(total)}</span>
            </div>
            <p className="pt-1">在时间线里点一个片段，这里可以精确改它的入点 / 出点。</p>
          </div>
        )}

        {clip && (
          <>
            <div className="space-y-1">
              <span className={LABEL}>片段</span>
              <div className="text-[11px] [color:var(--color-text-main)] break-all">{clip.name}</div>
              <div className="flex items-center gap-1.5 text-[10px] [color:var(--color-text-muted)]">
                <span className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border">{clip.kind === 'audio' ? '音频' : '视频'}</span>
                <span className="font-mono">源 {formatTimecode(clip.duration)}</span>
              </div>
            </div>

            <div className="space-y-1">
              <span className={LABEL}>入点（秒）</span>
              <NumberField
                value={clip.in}
                min={0}
                max={Math.max(0, clip.out - MIN_CLIP_SECONDS)}
                onCommit={(v) => patchClip({ in: v })}
              />
            </div>

            <div className="space-y-1">
              <span className={LABEL}>出点（秒）</span>
              <NumberField
                value={clip.out}
                min={clip.in + MIN_CLIP_SECONDS}
                max={clip.duration || undefined}
                onCommit={(v) => patchClip({ out: v })}
              />
            </div>

            <div className="flex items-center justify-between text-[10.5px]">
              <span className={LABEL}>裁后时长</span>
              <span className="font-mono text-brand">{formatTimecode(clipSpan(clip))}</span>
            </div>

            <button
              onClick={() => patchClip({ in: 0, out: clip.duration || clip.out })}
              className="w-full h-7 rounded-md border border-border text-[10.5px] [color:var(--color-text-secondary)] hover:text-brand hover:border-brand/50 flex items-center justify-center gap-1 transition-colors"
            >
              <RotateCcw className="w-3 h-3" strokeWidth={1.8} />
              重置为整段
            </button>
          </>
        )}
      </div>
    </div>
  );
};
