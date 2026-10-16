// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频生成历史（对照 Toonflow nodeScaffold/components/mediaHistory.vue）：
 * 左侧版本列表（时间 · 语音源 · 当前结果），右侧试听 + 台词，「设为当前结果」→ audio_url 指向该版本（下游拿到的就是它）。
 * 数据来自 data.history（useGeneration 每次生成追加，新的在前），当前结果不在历史里时也补进列表。
 */
import { useMemo, useState } from 'react';
import type { HistoryEntry } from '../../kit/types';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { AudioDialog } from './AudioDialog';
import { AudioPlayer } from './AudioPlayer';
import { fileNameOf } from './media';
import './audio.css';

export interface AudioHistoryDialogProps {
  history: readonly HistoryEntry[] | undefined;
  currentUrl: string;
  /** 语音源 id → 名称 */
  sourceName?: (providerId: string) => string | undefined;
  disabled?: boolean;
  onClose: () => void;
  onSelect: (entry: HistoryEntry) => void;
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 历史列表：去重（同 url 只留第一条），当前结果不在其中时补到最前。 */
export function historyItems(history: readonly HistoryEntry[] | undefined, currentUrl: string): HistoryEntry[] {
  const seen = new Set<string>();
  const items: HistoryEntry[] = [];
  for (const h of history || []) {
    if (!h || typeof h.url !== 'string' || !h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    items.push(h);
  }
  if (currentUrl && !seen.has(currentUrl)) items.unshift({ url: currentUrl, created_at: '' });
  return items;
}

export function AudioHistoryDialog({ history, currentUrl, sourceName, disabled, onClose, onSelect }: AudioHistoryDialogProps) {
  const items = useMemo(() => historyItems(history, currentUrl), [history, currentUrl]);
  const [selectedUrl, setSelectedUrl] = useState<string>(() => currentUrl || items[0]?.url || '');
  const selected = items.find((h) => h.url === selectedUrl) ?? items[0];
  const total = items.length;
  const metaOf = (h: HistoryEntry) => {
    const who = h.provider_id ? (sourceName?.(h.provider_id) || h.provider_id) : '上传 / 外部';
    return [formatWhen(h.created_at), who].filter(Boolean).join(' · ');
  };

  return (
    <AudioDialog
      open
      title="音频历史记录"
      width={760}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="cv-audio-btn" onClick={onClose}>关闭</button>
          <button
            type="button"
            className="cv-audio-btn cv-audio-btn--primary"
            disabled={disabled || !selected || selected.url === currentUrl}
            onClick={() => { if (selected) { onSelect(selected); onClose(); } }}
          >
            设为当前结果
          </button>
        </>
      )}
    >
      {!total ? (
        <div className="cv-audio-history__empty">暂无历史记录</div>
      ) : (
        <div className="cv-audio-history">
          <div className="cv-audio-history__list" role="listbox" aria-label="历史版本">
            {items.map((h, i) => (
              <button
                key={h.url}
                type="button"
                role="option"
                aria-selected={selected?.url === h.url}
                className={['cv-audio-history__item', selected?.url === h.url ? 'is-selected' : ''].filter(Boolean).join(' ')}
                title={h.url}
                onClick={() => setSelectedUrl(h.url)}
              >
                <span className="cv-audio-history__name">版本 {total - i} · {fileNameOf(h.url) || '音频'}</span>
                <span className="cv-audio-history__meta">{metaOf(h) || '—'}</span>
                {h.url === currentUrl && <span className="cv-audio-history__current">当前结果</span>}
              </button>
            ))}
          </div>
          <div className="cv-audio-history__preview">
            {selected && <AudioPlayer key={selected.url} src={resolveMediaUrl(selected.url)} label="历史音频预览" />}
            {selected?.prompt && <div className="cv-audio-history__prompt">{selected.prompt}</div>}
          </div>
        </div>
      )}
    </AudioDialog>
  );
}
