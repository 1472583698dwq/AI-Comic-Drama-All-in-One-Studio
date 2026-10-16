// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 紧凑预设下拉（景别 / 运镜 / 焦距 / 速度 / 站位 / 姿态）。
 * 外观对齐 kit 的生成源下拉：按钮在卡片里，选项弹层用 kit Popover（portal 到 body，不随画布缩放）。
 */
import { useMemo, useState } from 'react';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { Popover } from '../../kit';
import type { PickerOption } from './model';

export interface PresetPickerProps {
  /** 左侧小标签，如「景别」 */
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  /** 选项弹层最小宽度 */
  menuWidth?: number;
  className?: string;
}

export function PresetPicker({ label, value, options, onChange, disabled, menuWidth = 220, className }: PresetPickerProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = !!anchor;
  const current = options.find((o) => o.id === value);
  const groups = useMemo(() => {
    const map = new Map<string, PickerOption[]>();
    for (const o of options) map.set(o.group ?? '', [...(map.get(o.group ?? '') || []), o]);
    return [...map.entries()];
  }, [options]);
  return (
    <>
      <button
        type="button"
        className={['cv-d3-pick nodrag', className].filter(Boolean).join(' ')}
        aria-label={`${label}：${current?.label ?? value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={current?.desc ? `${current.label} · ${current.desc}` : current?.label ?? value}
        onClick={(e) => { e.stopPropagation(); setAnchor(anchor ? null : e.currentTarget); }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span className="cv-d3-pick__k">{label}</span>
        <span className="cv-d3-pick__v">{current?.label ?? value}</span>
        <IconChevronDown size={12} aria-hidden />
      </button>
      <Popover
        open={open}
        anchor={anchor}
        onClose={() => setAnchor(null)}
        className="cv-menu cv-d3-pop"
        role="listbox"
        aria-label={label}
        style={{ minWidth: menuWidth, maxHeight: 320, overflow: 'auto' }}
      >
        {groups.map(([group, items]) => (
          <div key={group || '_'} role="group" aria-label={group || undefined}>
            {group && <div className="cv-menu__group">{group}</div>}
            {items.map((o) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={o.id === value}
                className={['cv-menu__item cv-d3-pop__item', o.id === value ? 'is-active' : ''].filter(Boolean).join(' ')}
                onClick={() => { setAnchor(null); if (o.id !== value) onChange(o.id); }}
              >
                <span className="cv-d3-pop__text">
                  <span>{o.label}</span>
                  {o.desc && <small>{o.desc}</small>}
                </span>
                {o.id === value && <IconCheck size={14} aria-hidden />}
              </button>
            ))}
          </div>
        ))}
      </Popover>
    </>
  );
}
