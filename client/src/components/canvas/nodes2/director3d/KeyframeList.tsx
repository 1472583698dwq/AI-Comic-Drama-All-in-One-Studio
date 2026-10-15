// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 运镜关键帧列表（对照 Toonflow sceneEditor 的「关键帧」条 + 播放条）。
 * 列表顺序 = 播放顺序；每帧：缩略图 / 序号（点击回看）、时间、缓动（点击循环 平滑→线性→硬切）、用当前机位覆盖、上移、下移、删除。
 * 头部：总时长（按比例缩放）、添加关键帧、由运镜生成、清空、预览播放；预览进度条由父组件经 ref 直接写（播放中不重渲染）。
 */
import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  IconArrowDown, IconArrowUp, IconCamera, IconCameraPlus, IconPlayerPause, IconPlayerPlay, IconRefresh, IconTrash, IconWand, IconX,
} from '@tabler/icons-react';
import { ToolbarButton } from '../../kit';
import { KEYFRAME_EASING_LABELS, KEYFRAME_LIMIT, keyframesDuration, type Director3DKeyframe } from './model';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function NumberField({ value, onCommit, ariaLabel, className, disabled, digits = 2 }: {
  value: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  digits?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const commit = () => {
    const raw = draft;
    setDraft(null);
    if (cancelRef.current) { cancelRef.current = false; return; }
    if (raw === null) return;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n !== value) onCommit(n);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelRef.current = true; e.currentTarget.blur(); }
  };
  return (
    <input
      className={['cv-d3-num nodrag', className].filter(Boolean).join(' ')}
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      disabled={disabled}
      value={draft ?? value.toFixed(digits)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={onKey}
      onPointerDown={stop}
      onDoubleClick={stop}
    />
  );
}

export interface KeyframeListProps {
  keyframes: readonly Director3DKeyframe[];
  /** 舞台已就绪（添加 / 覆盖 / 回看 / 预览需要舞台） */
  stageReady: boolean;
  playing: boolean;
  /** 当前运镜预设名（「由运镜生成」按钮提示） */
  motionLabel: string;
  thumbs?: Readonly<Record<string, string>>;
  activeId?: string | null;
  scrubRef: RefObject<HTMLInputElement | null>;
  timeRef: RefObject<HTMLSpanElement | null>;
  onAdd: () => void;
  onGenerate: () => void;
  onClear: () => void;
  onPlayToggle: () => void;
  onSeek: (time: number) => void;
  onView: (kf: Director3DKeyframe) => void;
  onOverwrite: (kf: Director3DKeyframe) => void;
  onRemove: (kf: Director3DKeyframe) => void;
  onMove: (from: number, to: number) => void;
  onRetime: (kf: Director3DKeyframe, time: number) => void;
  onEasing: (kf: Director3DKeyframe) => void;
  onDuration: (duration: number) => void;
}

export function KeyframeList(props: KeyframeListProps) {
  const { keyframes, stageReady, playing, thumbs, activeId } = props;
  const n = keyframes.length;
  const duration = keyframesDuration(keyframes);
  return (
    <section className="cv-d3-kf" aria-label="运镜关键帧" onDoubleClick={stop}>
      <div className="cv-d3-kf__head">
        <span className="cv-d3-kf__title">关键帧<b>{n}</b></span>
        {n >= 2 && (
          <label className="cv-d3-kf__dur" title="总时长：按比例缩放所有关键帧时间">
            <NumberField value={duration} onCommit={props.onDuration} ariaLabel="关键帧总时长（秒）" />
            <span>s</span>
          </label>
        )}
        <span className="cv-d3-kf__tools">
          <ToolbarButton className="cv-d3-ibtn nodrag" icon={IconCameraPlus} iconOnly size="sm" title={n >= KEYFRAME_LIMIT ? `最多 ${KEYFRAME_LIMIT} 个关键帧` : '添加关键帧（当前机位）'} disabled={!stageReady || n >= KEYFRAME_LIMIT} onClick={props.onAdd} />
          <ToolbarButton className="cv-d3-ibtn nodrag" icon={IconWand} iconOnly size="sm" title={`由运镜「${props.motionLabel}」生成关键帧${n ? '（替换现有）' : ''}`} onClick={props.onGenerate} />
          <ToolbarButton className="cv-d3-ibtn nodrag" icon={IconTrash} iconOnly size="sm" title="清空关键帧" disabled={!n} onClick={props.onClear} />
          <ToolbarButton
            className="cv-d3-ibtn nodrag"
            icon={playing ? IconPlayerPause : IconPlayerPlay}
            iconOnly
            size="sm"
            title={playing ? '暂停预览' : '预览运镜'}
            active={playing}
            disabled={!stageReady || n < 2}
            onClick={props.onPlayToggle}
          />
        </span>
      </div>
      {n >= 2 && (
        <div className="cv-d3-kf__scrub">
          <input
            ref={props.scrubRef}
            className="nodrag"
            type="range"
            min={0}
            max={duration}
            step={0.01}
            defaultValue={0}
            aria-label="运镜预览进度"
            disabled={!stageReady}
            onInput={(e) => props.onSeek(Number(e.currentTarget.value))}
            onPointerDown={stop}
          />
          <span ref={props.timeRef} className="cv-d3-kf__time-label">{`0.00 / ${duration.toFixed(2)}s`}</span>
        </div>
      )}
      {n === 0 ? (
        <div className="cv-d3-kf__empty">在舞台里调好机位后点 <IconCameraPlus size={13} aria-hidden /> 记录关键帧，或点 <IconWand size={13} aria-hidden /> 按当前运镜生成</div>
      ) : (
        <ol className="cv-d3-kf__list nowheel" onPointerDown={stop}>
          {keyframes.map((kf, i) => {
            const thumb = thumbs?.[kf.id];
            const easing = kf.easing ?? 'smooth';
            return (
              <li key={kf.id} className={['cv-d3-kf__row', activeId === kf.id ? 'is-active' : ''].filter(Boolean).join(' ')}>
                <button type="button" className="cv-d3-kf__idx nodrag" title={`回看关键帧 ${i + 1} 的机位`} aria-label={`回看关键帧 ${i + 1}`} disabled={!stageReady} onClick={(e) => { e.stopPropagation(); props.onView(kf); }}>
                  {thumb ? <img src={thumb} alt="" draggable={false} /> : <IconCamera size={14} aria-hidden />}
                  <span>{String(i + 1).padStart(2, '0')}</span>
                </button>
                <span className="cv-d3-kf__t">
                  <NumberField value={kf.time} onCommit={(t) => props.onRetime(kf, t)} ariaLabel={`关键帧 ${i + 1} 时间（秒）`} disabled={i === 0} />
                  <span>s</span>
                </span>
                <button
                  type="button"
                  className="cv-d3-kf__ease nodrag"
                  disabled={i === 0}
                  title={i === 0 ? '起点帧（缓动作用于「上一帧 → 本帧」）' : `缓动：${KEYFRAME_EASING_LABELS[easing]}（点击切换）`}
                  aria-label={`关键帧 ${i + 1} 缓动：${i === 0 ? '起点' : KEYFRAME_EASING_LABELS[easing]}`}
                  onClick={(e) => { e.stopPropagation(); props.onEasing(kf); }}
                >
                  {i === 0 ? '起点' : KEYFRAME_EASING_LABELS[easing]}
                </button>
                <span className="cv-d3-kf__acts">
                  <ToolbarButton className="cv-d3-ibtn nodrag" icon={IconRefresh} iconOnly size="sm" title="用当前机位覆盖此帧" disabled={!stageReady} onClick={() => props.onOverwrite(kf)} />
                  <ToolbarButton className="cv-d3-ibtn nodrag" icon={IconArrowUp} iconOnly size="sm" title="上移" disabled={i === 0} onClick={() => props.onMove(i, i - 1)} />
                  <ToolbarButton className="cv-d3-ibtn nodrag" icon={IconArrowDown} iconOnly size="sm" title="下移" disabled={i === n - 1} onClick={() => props.onMove(i, i + 1)} />
                  <ToolbarButton className="cv-d3-ibtn nodrag" icon={IconX} iconOnly size="sm" title={`删除关键帧 ${i + 1}`} onClick={() => props.onRemove(kf)} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
