// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 分组节点（对照 Toonflow canvas/components/groupNode.vue，design §5）：
 * 1px 边框、背景 color-mix(--cv-fill 25%, transparent)、标题在框外上方（12px 字）、双击改名、四角 9×9 缩放把手。
 * 缩放用 React Flow NodeResizeControl（自带从左/上缩放时子节点位置补偿）。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { NodeResizeControl, type NodeProps } from '@xyflow/react';
import { IconBoxMultiple } from '@tabler/icons-react';
import { defineNode } from './registry';
import { useKitNodeActions } from './hostContext';
import { GROUP_MIN_SIZE, GROUP_TYPE } from './graphOps';

const CORNERS = [
  { position: 'top-left', label: '左上角' },
  { position: 'top-right', label: '右上角' },
  { position: 'bottom-left', label: '左下角' },
  { position: 'bottom-right', label: '右下角' },
] as const;

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function GroupNode({ id, data, selected }: NodeProps) {
  const label = typeof data?.label === 'string' && data.label ? data.label : '分组';
  const actions = useKitNodeActions(id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const save = () => {
    if (!editing) return;
    setEditing(false);
    const v = draft.trim();
    if (v && v !== label) actions.rename(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
  };

  return (
    <div className={['cv-group', selected ? 'is-selected' : ''].filter(Boolean).join(' ')} data-node-type={GROUP_TYPE}>
      {editing ? (
        <input
          ref={inputRef}
          className="cv-group__label-input nodrag nopan"
          aria-label="分组名称"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={save}
          onPointerDown={stop}
          onMouseDown={stop}
          onClick={stop}
          onDoubleClick={stop}
        />
      ) : (
        <span
          className="cv-group__label"
          tabIndex={0}
          title={`${label}（双击编辑名称）`}
          onDoubleClick={(e) => { e.stopPropagation(); setDraft(label); setEditing(true); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setDraft(label); setEditing(true); } }}
        >
          {label}
        </span>
      )}
      {CORNERS.map((c) => (
        <NodeResizeControl
          key={c.position}
          position={c.position}
          minWidth={GROUP_MIN_SIZE.width}
          minHeight={GROUP_MIN_SIZE.height}
          autoScale={false}
          className="cv-group__resize"
        />
      ))}
    </div>
  );
}

/** REQ-toonflow-canvas 分组节点定义：不在工具栏出现，由选区工具栏「成组」创建。 */
export const groupNodeDef = defineNode({
  type: GROUP_TYPE,
  label: '分组',
  icon: IconBoxMultiple,
  category: 'tool',
  ports: [],
  component: GroupNode,
  inPalette: false,
  defaultData: () => ({ label: '分组' }),
});
