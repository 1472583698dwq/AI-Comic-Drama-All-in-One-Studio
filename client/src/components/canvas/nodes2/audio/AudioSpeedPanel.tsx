// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 变速面板（Toonflow audioActions speedPanel：节点下方浮层，宽 440）：
 *   [✕ 变速] 0.5× ──滑块── 2× [倍数输入] [↑ 生成]
 * 倍数范围按后端 /media/ops/speed（atempo，保持音高）0.5–2.0。
 */
import { useState, type SyntheticEvent } from 'react';
import { IconArrowUp, IconLoader2, IconX } from '@tabler/icons-react';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, isValidSpeed } from './useAudioProcessing';
import './audio.css';

const stop = (e: SyntheticEvent) => e.stopPropagation();

export interface AudioSpeedPanelProps {
  processing: boolean;
  error?: string | null;
  disabled?: boolean;
  onClose: () => void;
  onRun: (rate: number) => void;
}

function clampSpeed(v: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v * 100) / 100));
}

export function AudioSpeedPanel({ processing, error, disabled, onClose, onRun }: AudioSpeedPanelProps) {
  const [speed, setSpeed] = useState(1);
  const [draft, setDraft] = useState('1.00');
  const valid = isValidSpeed(speed) && Math.abs(speed - 1) > 1e-9;
  const apply = (v: number) => {
    const next = clampSpeed(v);
    setSpeed(next);
    setDraft(next.toFixed(2));
  };
  const run = () => {
    if (!processing && !disabled && valid) onRun(speed);
  };
  return (
    <div className="cv-card cv-audio-speed" role="group" aria-label="音频变速">
      <div className="cv-audio-speed__row nodrag nopan nowheel" onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop} onKeyDown={stop}>
        <ToolbarButton icon={IconX} title={processing ? '取消处理' : '关闭变速'} onClick={onClose}>变速</ToolbarButton>
        <span className="cv-audio-speed__limit">{SPEED_MIN}×</span>
        <input
          className="cv-audio-speed__slider"
          type="range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={speed}
          disabled={processing}
          aria-label="音频变速滑块"
          aria-valuetext={`${speed.toFixed(2)}×`}
          onChange={(e) => apply(e.currentTarget.valueAsNumber)}
        />
        <span className="cv-audio-speed__limit">{SPEED_MAX}×</span>
        <input
          className="cv-audio-num"
          type="number"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={draft}
          disabled={processing}
          aria-label="音频变速倍数"
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            const n = Number.parseFloat(e.currentTarget.value);
            if (isValidSpeed(n)) setSpeed(Math.round(n * 100) / 100);
          }}
          onBlur={() => apply(Number.isFinite(Number.parseFloat(draft)) ? Number.parseFloat(draft) : speed)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply(Number.isFinite(Number.parseFloat(draft)) ? Number.parseFloat(draft) : speed);
              run();
            }
          }}
        />
        <button
          type="button"
          className="cv-send"
          title={valid ? '生成变速音频' : '倍数为 1× 时无需变速'}
          aria-label="生成变速音频"
          disabled={disabled || processing || !valid}
          onClick={(e) => { e.stopPropagation(); run(); }}
        >
          {processing ? <IconLoader2 size={16} className="cv-spin" aria-hidden /> : <IconArrowUp size={16} aria-hidden />}
        </button>
      </div>
      {(processing || error) && (
        <div className={['cv-audio-speed__status', !processing && error ? 'is-error' : ''].filter(Boolean).join(' ')} role="status">
          {processing ? '正在生成变速音频…' : error}
        </div>
      )}
    </div>
  );
}
