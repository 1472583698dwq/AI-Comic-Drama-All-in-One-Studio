// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 宫格切分弹层（Toonflow nodeScaffold/components/imageGridSplit.vue）：
 * 常用 2×2 / 3×3 / 4×4 / 5×5 + 自定义行列（后端 /media/ops/grid-split 每轴 1–6）+ 带编号的切分预览，
 * 「切分为图片节点」后由节点按 Toonflow 版式落成 rows×cols 个图片节点（保留原图）。
 */
import { useState } from 'react';
import { IconLoader2 } from '@tabler/icons-react';
import { Popover, type PopoverAnchor } from '../../kit/ui/Popover';
import { resolveMediaUrl } from '../../../../utils/devOrigin';

/** 后端 grid-split 每轴上限。 */
export const GRID_MAX = 6;
const PRESETS = [2, 3, 4, 5];

export function isValidGrid(rows: number, cols: number): boolean {
  return [rows, cols].every((v) => Number.isInteger(v) && v >= 1 && v <= GRID_MAX);
}

export interface GridSplitPopoverProps {
  open: boolean;
  anchor: PopoverAnchor;
  onClose: () => void;
  src: string;
  splitting?: boolean;
  /** 已完成 / 总数（切分进行中显示）。 */
  progress?: string;
  disabled?: boolean;
  onSplit: (rows: number, cols: number) => void;
}

export function GridSplitPopover({ open, anchor, onClose, src, splitting, progress, disabled, onSplit }: GridSplitPopoverProps) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const valid = isValidGrid(rows, cols);
  const tooSmall = !!size && (size.width < cols || size.height < rows);
  const canSplit = valid && rows * cols > 1 && !tooSmall && !disabled;
  const clampInt = (v: string) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(1, Math.min(GRID_MAX, n)) : 1;
  };

  return (
    <Popover open={open} anchor={anchor} onClose={onClose} placement="bottom-start" className="cv-img-grid" role="dialog" aria-label="宫格切分">
      <div
        className="cv-img-grid__panel"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      >
        <div className="cv-img-grid__header">
          <strong>宫格切分</strong>
          <span>保留原图</span>
        </div>
        <div className="cv-img-grid__presets" role="group" aria-label="常用宫格">
          {PRESETS.map((n) => {
            const active = rows === n && cols === n;
            return (
              <button
                key={n}
                type="button"
                className={['cv-img-grid__preset', active ? 'is-active' : ''].filter(Boolean).join(' ')}
                aria-pressed={active}
                disabled={splitting}
                onClick={() => { setRows(n); setCols(n); }}
              >
                <span className="cv-img-grid__preset-icon" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }} aria-hidden>
                  {Array.from({ length: n * n }, (_, i) => <i key={i} />)}
                </span>
                <span>{n * n} 宫格</span>
                <small>{n} × {n}</small>
              </button>
            );
          })}
        </div>
        <div className="cv-img-grid__custom">
          <label>
            <span>行数</span>
            <input type="number" min={1} max={GRID_MAX} step={1} value={rows} disabled={splitting} aria-label="切分行数" onChange={(e) => setRows(clampInt(e.target.value))} />
          </label>
          <span className="cv-img-grid__times" aria-hidden>×</span>
          <label>
            <span>列数</span>
            <input type="number" min={1} max={GRID_MAX} step={1} value={cols} disabled={splitting} aria-label="切分列数" onChange={(e) => setCols(clampInt(e.target.value))} />
          </label>
        </div>
        <div className="cv-img-grid__preview">
          <div className="cv-img-grid__preview-image">
            <img
              src={resolveMediaUrl(src)}
              alt="宫格切分预览"
              draggable={false}
              onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              onError={() => setSize({ width: 0, height: 0 })}
            />
            {valid && (
              <div className="cv-img-grid__overlay" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }} aria-hidden>
                {Array.from({ length: rows * cols }, (_, i) => <span key={i}><small>{i + 1}</small></span>)}
              </div>
            )}
          </div>
        </div>
        <div className="cv-img-grid__summary" aria-live="polite">
          <span>{!valid ? '请设置有效行列数' : tooSmall ? '图片尺寸小于切分行列数' : `共 ${rows * cols} 张图片`}</span>
          <span>从左到右，逐行切分</span>
        </div>
        <button type="button" className="cv-img-grid__submit" disabled={!canSplit || splitting} onClick={() => onSplit(rows, cols)}>
          {splitting && <IconLoader2 size={16} className="cv-spin" aria-hidden />}
          {splitting ? `正在切分${progress ? ` ${progress}` : '…'}` : '切分为图片节点'}
        </button>
      </div>
    </Popover>
  );
}
