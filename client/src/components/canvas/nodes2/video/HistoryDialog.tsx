// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 生成历史（照 Toonflow nodeScaffold/components/mediaHistory.vue）：
 * 左侧历史列表、右侧预览，「设为当前结果」→ 写回 video_url（下游拿到的就是当前版本）。
 * 历史来自 data.history（kit/useGeneration 追加，新的在前）；当前结果不在历史里时补一条（Toonflow「只补当前结果」）。
 */
import { useMemo, useState } from 'react';
import { IconHistory } from '@tabler/icons-react';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import type { HistoryEntry } from '../../kit/types';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { Modal } from './Modal';
import { fileNameOf } from './media';

export type VideoHistoryItem = HistoryEntry & { source?: string };

/** 历史列表（含当前结果）：data.history 去重 + 当前 url 不在其中时补在最前。 */
export function historyItems(history: unknown, currentUrl: string): VideoHistoryItem[] {
  const list = Array.isArray(history)
    ? (history as VideoHistoryItem[]).filter((h) => h && typeof h.url === 'string' && h.url)
    : [];
  const seen = new Set<string>();
  const out: VideoHistoryItem[] = [];
  for (const h of list) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    out.push(h);
  }
  if (currentUrl && !seen.has(currentUrl)) out.unshift({ url: currentUrl, created_at: '' });
  return out;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface HistoryButtonProps {
  items: readonly VideoHistoryItem[];
  current: string;
  disabled?: boolean;
  onSelect: (item: VideoHistoryItem) => void;
  /** 生成源 id → 显示名。 */
  sourceName?: (id: string) => string;
}

export function HistoryButton({ items, current, disabled, onSelect, sourceName }: HistoryButtonProps) {
  const [opened, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>('');
  const [previewError, setPreviewError] = useState('');
  // 生成 / 上传中关闭（Toonflow watch(disabled) → visible = false）：按 React 推荐在渲染期随 prop 调整 state
  const [prevDisabled, setPrevDisabled] = useState(disabled);
  if (prevDisabled !== disabled) {
    setPrevDisabled(disabled);
    if (disabled) setOpen(false);
  }
  const open = opened && !disabled;
  const select = (u: string) => { setSelected(u); setPreviewError(''); };
  const sel = useMemo(() => items.find((i) => i.url === selected), [items, selected]);

  return (
    <>
      <ToolbarButton icon={IconHistory} title="历史记录" disabled={disabled} onClick={() => { select(current || items[0]?.url || ''); setOpen(true); }}>历史记录</ToolbarButton>
      <Modal
        open={open}
        title="视频历史记录"
        width="min(760px, calc(100vw - 32px))"
        onClose={() => setOpen(false)}
        footer={(
          <>
            <button type="button" className="cv-btn cv-btn--outline" onClick={() => setOpen(false)}>关闭</button>
            <button
              type="button"
              className="cv-btn cv-btn--primary"
              disabled={disabled || !sel || sel.url === current || !!previewError}
              onClick={() => { if (sel) { onSelect(sel); setOpen(false); } }}
            >
              设为当前结果
            </button>
          </>
        )}
      >
        <div className="cv-history">
          {!items.length ? (
            <div className="cv-history__empty">暂无历史记录</div>
          ) : (
            <div className="cv-history__content">
              <div className="cv-history__list" role="listbox" aria-label="历史文件">
                {items.map((item, i) => {
                  const meta = [formatTime(item.created_at), item.source === 'upload' ? '上传替换' : item.provider_id ? (sourceName?.(item.provider_id) ?? item.provider_id) : '']
                    .filter(Boolean).join(' · ');
                  return (
                    <button
                      key={item.url}
                      type="button"
                      role="option"
                      aria-selected={selected === item.url}
                      className={['cv-history__item', selected === item.url ? 'is-selected' : ''].filter(Boolean).join(' ')}
                      title={item.prompt ? `${item.url}\n${item.prompt}` : item.url}
                      onClick={() => select(item.url)}
                    >
                      <span className="cv-history__name">{`#${items.length - i} ${fileNameOf(item.url)}`}</span>
                      {meta && <span className="cv-history__meta">{meta}</span>}
                      {item.url === current && <span className="cv-history__current">当前结果</span>}
                    </button>
                  );
                })}
              </div>
              <div className="cv-history__preview">
                {previewError ? (
                  <span className="cv-history__empty">{previewError}</span>
                ) : sel ? (
                  <video
                    key={sel.url}
                    src={resolveMediaUrl(sel.url)}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label="历史视频预览"
                    onError={() => setPreviewError('无法预览该视频，文件可能已被移动或删除')}
                  />
                ) : null}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
