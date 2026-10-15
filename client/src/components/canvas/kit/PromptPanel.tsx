// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 卡片下方提示词面板（照 Toonflow imageGenerationNode 的 promptCard，design §1「生成交互」）：
 *   [参考列表] [提示词输入] [生成源下拉 190px · 参数按钮「16:9 · 2K」 · 智能规划开关 · … · 发送 32×32]
 * 「模型」下拉换成 MiniMax 生成源；参数弹层内容由宿主提供（DynamicControl）；智能规划开启时走 /canvas/agent/generate。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { IconArrowUp, IconCheck, IconChevronDown, IconChevronUp, IconPlayerStop, IconSparkles } from '@tabler/icons-react';
import type { RefItem, Slot } from './types';
import { PromptInput } from './PromptInput';
import { RefList } from './RefList';
import { Popover } from './ui/Popover';

export interface GenSourceOption {
  id: string;
  label: string;
  /** 分组名（如「海螺」「可灵」或 provider 类型）。 */
  group?: string;
  description?: string;
  disabled?: boolean;
}

export interface PromptPanelProps {
  refs: readonly RefItem[];
  prompt: string;
  onPromptChange: (value: string) => void;
  onMoveRef?: (from: number, to: number) => void;
  onRemoveRef?: (item: RefItem) => void;
  onPreviewRef?: (item: RefItem, index: number) => void;
  /** 参考卡片底部显示的槽位（如 assembleInputs().assignments）。 */
  slotOf?: (item: RefItem) => Slot | null | undefined;

  sources: readonly GenSourceOption[];
  sourceId?: string;
  onSourceChange: (id: string) => void;
  sourcesLoading?: boolean;
  sourcePlaceholder?: string;
  /** 下拉展开时触发（懒加载生成源列表）。 */
  onSourcesOpen?: () => void;

  /** 参数按钮上的摘要，如 `16:9 · 2K`。 */
  paramsSummary?: ReactNode;
  /** 有值时在摘要前画比例小框（Toonflow generationSettings）。 */
  paramsRatio?: string;
  /** 参数弹层内容（宿主放 DynamicControl）；不传则不显示参数按钮。 */
  renderParams?: () => ReactNode;

  /** 「智能规划」开关；不传 onSmartPlanChange 则不显示。 */
  smartPlan?: boolean;
  onSmartPlanChange?: (value: boolean) => void;

  running?: boolean;
  onSend: () => void;
  onStop?: () => void;
  sendDisabled?: boolean;
  sendTitle?: string;

  /** 插在参考列表与输入框之间（如 Toonflow 首尾帧提示 referenceHint）。 */
  header?: ReactNode;
  /** 插在参数按钮之后。 */
  extraFooter?: ReactNode;
  /** 组装告警（截断 / 不支持的槽位…）。 */
  warnings?: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function ratioShapeStyle(ratio: string): { width: number; height: number } {
  const [w = 1, h = 1] = ratio.split(':').map(Number);
  if (!w || !h) return { width: 16, height: 16 };
  return { width: 16 * Math.min(w / h, 1), height: 16 * Math.min(h / w, 1) };
}

function SourceSelect({ sources, sourceId, onChange, loading, placeholder, disabled, onOpen }: {
  sources: readonly GenSourceOption[]; sourceId?: string; onChange: (id: string) => void; loading?: boolean; placeholder: string; disabled?: boolean; onOpen?: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = !!anchor;
  const setOpen = (v: boolean) => { if (!v) setAnchor(null); };
  const [query, setQuery] = useState('');
  const current = sources.find((s) => s.id === sourceId);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, GenSourceOption[]>();
    for (const s of sources) {
      if (q && !`${s.label} ${s.id} ${s.group ?? ''}`.toLowerCase().includes(q)) continue;
      const g = s.group ?? '';
      map.set(g, [...(map.get(g) || []), s]);
    }
    return [...map.entries()];
  }, [sources, query]);

  return (
    <>
      <button
        type="button"
        className="cv-source-select"
        aria-label="生成源"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={current?.description || current?.label || placeholder}
        onClick={(e) => {
          e.stopPropagation();
          if (anchor) setAnchor(null);
          else { onOpen?.(); setAnchor(e.currentTarget); }
        }}
      >
        <IconSparkles size={17} aria-hidden />
        <span className={['cv-source-select__text', current ? '' : 'cv-source-select__placeholder'].filter(Boolean).join(' ')}>
          {current?.label ?? (sourceId || placeholder)}
        </span>
        <IconChevronDown size={14} aria-hidden />
      </button>
      <Popover open={open} anchor={anchor} placement="top-start" onClose={() => setOpen(false)} className="cv-menu" role="listbox" aria-label="生成源" style={{ maxHeight: 320, overflow: 'auto', minWidth: 220 }}>
        <div style={{ padding: '2px 8px 6px' }}>
          <input
            className="cv-node__label-input"
            style={{ width: '100%', height: 28, borderColor: 'var(--cv-border-light)' }}
            placeholder="搜索生成源"
            aria-label="搜索生成源"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {loading && <div className="cv-menu__empty">加载中…</div>}
        {!loading && !groups.length && <div className="cv-menu__empty">{sources.length ? '没有匹配的生成源' : '暂无可用生成源，请先在设置中配置'}</div>}
        {groups.map(([group, items]) => (
          <div key={group || '_'} role="group" aria-label={group || undefined}>
            {group && <div className="cv-menu__group">{group}</div>}
            {items.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === sourceId}
                className={['cv-menu__item', s.id === sourceId ? 'is-active' : ''].filter(Boolean).join(' ')}
                disabled={s.disabled}
                title={s.description}
                onClick={() => { onChange(s.id); setOpen(false); setQuery(''); }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
                {s.id === sourceId && <IconCheck size={14} aria-hidden />}
              </button>
            ))}
          </div>
        ))}
      </Popover>
    </>
  );
}

function ParamsButton({ summary, ratio, render, disabled }: { summary?: ReactNode; ratio?: string; render: () => ReactNode; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = !!anchor;
  return (
    <>
      <button
        type="button"
        className="cv-btn cv-btn--sm cv-params-btn"
        aria-label="生成参数"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setAnchor(anchor ? null : e.currentTarget); }}
      >
        {ratio && <span className="cv-ratio-shape" style={ratioShapeStyle(ratio)} aria-hidden />}
        <span>{summary ?? '参数'}</span>
        <IconChevronUp size={14} aria-hidden />
      </button>
      <Popover open={open} anchor={anchor} placement="top-start" onClose={() => setAnchor(null)} className="cv-params-pop" role="dialog" aria-label="生成参数">
        {render()}
      </Popover>
    </>
  );
}

export function SmartPlanSwitch({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className="cv-switch"
      disabled={disabled}
      title={value ? '智能规划：先由 Agent 规划技能、生成源与参数再生成' : '智能规划已关闭：按当前生成源与参数直接生成'}
      onClick={(e) => { e.stopPropagation(); onChange(!value); }}
    >
      <span className="cv-switch__track" aria-hidden><span className="cv-switch__thumb" /></span>
      <span>智能规划</span>
    </button>
  );
}

export function PromptPanel(props: PromptPanelProps) {
  const {
    refs, prompt, onPromptChange, onMoveRef, onRemoveRef, onPreviewRef, slotOf,
    sources, sourceId, onSourceChange, sourcesLoading, onSourcesOpen,
    running, onSend, onStop, disabled,
  } = props;
  const sendDisabled = running ? !onStop : (disabled || props.sendDisabled);
  const sendTitle = running ? '停止生成' : (props.sendTitle ?? '生成');
  return (
    <div className={['cv-card cv-prompt-card', props.className].filter(Boolean).join(' ')}>
      {refs.length > 0 && (
        <RefList refs={refs} onMove={onMoveRef ?? (() => {})} onRemove={onRemoveRef} onPreview={onPreviewRef} slotOf={slotOf} />
      )}
      {props.header}
      <PromptInput
        value={prompt}
        onChange={onPromptChange}
        refs={refs}
        placeholder={props.placeholder}
        expandable
        disabled={disabled}
        onSubmit={running || sendDisabled ? undefined : onSend}
      />
      <div className="cv-prompt-footer">
        <SourceSelect
          sources={sources}
          sourceId={sourceId}
          onChange={onSourceChange}
          loading={sourcesLoading}
          placeholder={props.sourcePlaceholder ?? '选择生成源'}
          disabled={disabled || running}
          onOpen={onSourcesOpen}
        />
        {props.renderParams && (
          <ParamsButton summary={props.paramsSummary} ratio={props.paramsRatio} render={props.renderParams} disabled={disabled || running} />
        )}
        {props.extraFooter}
        {props.onSmartPlanChange && (
          <SmartPlanSwitch value={!!props.smartPlan} onChange={props.onSmartPlanChange} disabled={disabled || running} />
        )}
        <button
          type="button"
          className="cv-send"
          title={sendTitle}
          aria-label={sendTitle}
          disabled={sendDisabled}
          onClick={(e) => { e.stopPropagation(); if (running) onStop?.(); else onSend(); }}
        >
          {running ? <IconPlayerStop size={16} aria-hidden /> : <IconArrowUp size={16} aria-hidden />}
        </button>
      </div>
      {props.warnings && props.warnings.length > 0 && (
        <div className="cv-prompt-warnings" role="status">
          {props.warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}
    </div>
  );
}
