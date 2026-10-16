// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 历史版本条（Toonflow mediaHistory「设为当前结果」的就地版）：
 * data.history 每一项一个缩略图（新的在前），当前版本高亮；点击即切换当前版本（写回 image_url，下游随之更新）。
 */
import type { SyntheticEvent } from 'react';
import { IconHistory } from '@tabler/icons-react';
import type { HistoryEntry } from '../../kit/types';
import { resolveMediaUrl } from '../../../../utils/devOrigin';

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** 读 data.history（过滤掉无 url 的脏项）。 */
export function historyOf(data: Record<string, unknown> | null | undefined): HistoryEntry[] {
  const raw = data?.history;
  return Array.isArray(raw) ? (raw as HistoryEntry[]).filter((h) => h && typeof h.url === 'string' && h.url) : [];
}

/** 当前图片不在历史里时补到最前（上传 / 迁移来的旧结果），保证切走后还能切回。 */
export function withCurrent(history: HistoryEntry[], current: string, extra: Partial<HistoryEntry> = {}): HistoryEntry[] {
  if (!current || history.some((h) => h.url === current)) return history;
  return [{ url: current, created_at: new Date().toISOString(), ...extra }, ...history];
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function historyTitle(h: HistoryEntry, index: number, total: number, current: boolean): string {
  const parts = [`版本 ${total - index}${current ? '（当前）' : ''}`, formatTime(h.created_at)];
  parts.push(h.provider_id ? `生成源 ${h.provider_id}` : '上传 / 编辑');
  if (h.prompt) parts.push(h.prompt.length > 80 ? `${h.prompt.slice(0, 80)}…` : h.prompt);
  return parts.filter(Boolean).join('\n');
}

export interface HistoryStripProps {
  history: HistoryEntry[];
  current: string;
  disabled?: boolean;
  onSelect: (entry: HistoryEntry) => void;
}

export function HistoryStrip({ history, current, disabled, onSelect }: HistoryStripProps) {
  if (history.length < 2) return null;
  return (
    <div className="cv-img-history nodrag nopan nowheel" role="listbox" aria-label="历史版本" onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop}>
      <span className="cv-img-history__icon" title={`历史版本 ${history.length} 个`} aria-hidden><IconHistory size={14} /></span>
      {history.map((h, i) => {
        const isCurrent = h.url === current;
        return (
          <button
            key={`${h.url}|${i}`}
            type="button"
            role="option"
            aria-selected={isCurrent}
            className={['cv-img-history__item', isCurrent ? 'is-current' : ''].filter(Boolean).join(' ')}
            title={historyTitle(h, i, history.length, isCurrent)}
            aria-label={`版本 ${history.length - i}${isCurrent ? '（当前）' : ''}`}
            disabled={disabled}
            onClick={(e) => { e.stopPropagation(); if (!isCurrent) onSelect(h); }}
          >
            <img src={resolveMediaUrl(h.url)} alt="" draggable={false} loading="lazy" />
          </button>
        );
      })}
    </div>
  );
}
