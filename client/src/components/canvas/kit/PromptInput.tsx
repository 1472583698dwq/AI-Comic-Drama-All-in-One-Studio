// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas tiptap 提示词输入（对照 Toonflow nodeScaffold/components/promptInput.vue）。
 * - 值是纯字符串，引用写成 `{{ref N}}`（与 Toonflow 存储格式一致）；编辑器里渲染成带缩略图的「参考 N」引用标签；
 * - 输入 `@` 或点「@」按钮弹出参考列表插入引用；
 * - 参考顺序变化 / 上游断开时，标签跟随原参考重新编号 / 移除，并回写字符串；
 * - 复制为纯文本时保留 `{{ref N}}`，粘贴含 `{{ref N}}` 的文本自动变成标签。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Node as TiptapNode } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { IconAt, IconFileText, IconMaximize, IconMusic, IconPhoto, IconVideo, IconX } from '@tabler/icons-react';
import type { RefItem } from './types';
import { refName } from './references';
import { ToolbarButton } from './FloatingToolbar';
import { Popover } from './ui/Popover';
import { REF_ATOM, docToString, fragmentToString, lineToInline, refAtomAttrs, stringToDoc } from './promptDoc';
import { resolveMediaUrl } from '../../../utils/devOrigin';

/** 行内原子节点：`{{ref N}}` 的编辑态表示。 */
export const RefAtom = TiptapNode.create({
  name: REF_ATOM,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      index: { default: 1 },
      refKey: { default: null },
      label: { default: '' },
      thumb: { default: null },
      missing: { default: false },
    };
  },
  parseHTML() {
    return [{
      tag: 'span[data-ref-index]',
      getAttrs: (el) => ({ index: Number((el as HTMLElement).getAttribute('data-ref-index')) || 1, refKey: (el as HTMLElement).getAttribute('data-ref-key') }),
    }];
  },
  renderHTML({ node }) {
    const { index, refKey, label, thumb, missing } = node.attrs as { index: number; refKey: string | null; label: string; thumb: string | null; missing: boolean };
    const attrs: Record<string, string> = {
      class: `cv-ref-chip${missing ? ' is-missing' : ''}`,
      'data-ref-index': String(index),
      contenteditable: 'false',
    };
    if (refKey) attrs['data-ref-key'] = refKey;
    if (label) attrs.title = label;
    return thumb
      ? ['span', attrs, ['img', { src: resolveMediaUrl(thumb), alt: '', draggable: 'false' }], refName(index)] // 属性存原值，展示时回源
      : ['span', attrs, refName(index)];
  },
  renderText({ node }) {
    return `{{ref ${(node.attrs as { index: number }).index}}}`;
  },
});

interface MentionState { from: number; to: number; query: string; active: number; anchor: { x: number; y: number } }

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  refs: readonly RefItem[];
  placeholder?: string;
  /** 右上角「展开编辑」按钮（Toonflow expandable）。 */
  expandable?: boolean;
  disabled?: boolean;
  /** ⌘/Ctrl + Enter 回调（发送）。 */
  onSubmit?: () => void;
  autoFocus?: boolean;
  className?: string;
  /** 展开态（内部用）。 */
  expanded?: boolean;
}

function refIcon(item: RefItem) {
  const Icon = item.dataType === 'IMAGE' ? IconPhoto : item.dataType === 'VIDEO' ? IconVideo : item.dataType === 'AUDIO' ? IconMusic : IconFileText;
  return <Icon size={16} aria-hidden />;
}

/** 编辑器里把引用标签与当前参考列表对齐：重新编号、补缩略图、移除已断开的参考。返回是否改动。 */
function syncAtoms(editor: Editor, refs: readonly RefItem[], prevKeys: ReadonlySet<string>): boolean {
  const { state } = editor;
  const tr = state.tr;
  const removals: { pos: number; size: number }[] = [];
  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== REF_ATOM) return;
    const a = node.attrs as { index: number; refKey: string | null; label: string; thumb: string | null; missing: boolean };
    let next;
    if (a.refKey && !refs.some((r) => r.key === a.refKey)) {
      // 这个参考刚被断开：移除标签（Toonflow 同款）；从未绑定过的保持原样标成未连接
      if (prevKeys.has(a.refKey)) { removals.push({ pos, size: node.nodeSize }); return; }
      next = { ...a, missing: true };
    } else {
      next = refAtomAttrs(a.index, refs, a.refKey);
    }
    if (next.index !== a.index || next.refKey !== a.refKey || next.label !== a.label || next.thumb !== a.thumb || next.missing !== a.missing) {
      tr.setNodeMarkup(pos, undefined, next);
    }
  });
  for (const r of removals.reverse()) tr.delete(tr.mapping.map(r.pos), tr.mapping.map(r.pos + r.size));
  if (!tr.docChanged) return false;
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
  return true;
}

function findMention(editor: Editor): Omit<MentionState, 'active' | 'anchor'> | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 24), $from.parentOffset, undefined, '￼');
  const m = /@([^\s@￼]{0,12})$/.exec(before);
  if (!m) return null;
  return { from: $from.pos - m[0].length, to: $from.pos, query: m[1] };
}

function matchRef(item: RefItem, index: number, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return String(index + 1).startsWith(q) || refName(index + 1).toLowerCase().includes(q) || (item.label || '').toLowerCase().includes(q);
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function PromptInput({ value, onChange, refs, placeholder = '描述一下生成风格提示词，输入 @ 引用参考', expandable, disabled, onSubmit, autoFocus, className, expanded }: PromptInputProps) {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const prevKeys = useRef<Set<string>>(new Set(refs.map((r) => r.key)));
  const [mention, setMention] = useState<MentionState | null>(null);
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const [showExpanded, setShowExpanded] = useState(false);
  const editorRef = useRef<Editor | null>(null);

  const mentionItems = useMemo(() => {
    if (!mention) return [];
    return refs.map((r, i) => ({ r, i })).filter(({ r, i }) => matchRef(r, i, mention.query));
  }, [mention, refs]);
  const mentionItemsRef = useRef(mentionItems);
  mentionItemsRef.current = mentionItems;

  const insertRef = useCallback((index: number, range?: { from: number; to: number }) => {
    const editor = editorRef.current;
    if (!editor) return;
    const attrs = refAtomAttrs(index, refsRef.current);
    const chain = editor.chain().focus();
    if (range) chain.insertContentAt(range, [{ type: REF_ATOM, attrs }]);
    else chain.insertContent([{ type: REF_ATOM, attrs }]);
    chain.run();
    setMention(null);
  }, []);

  const updateMention = useCallback((editor: Editor) => {
    const found = findMention(editor);
    if (!found) { if (mentionRef.current) setMention(null); return; }
    let anchor = { x: 0, y: 0 };
    try {
      const c = editor.view.coordsAtPos(found.from);
      anchor = { x: c.left, y: c.bottom };
    } catch { /* jsdom 等环境没有布局 */ }
    setMention((prev) => ({ ...found, anchor, active: prev && prev.query === found.query ? prev.active : 0 }));
  }, []);

  // 选项对象保持稳定引用：useEditor 每次渲染会比较选项，不同就 setOptions（但扩展不会因此重建）。
  // K1：占位文字经 ref 读取——prop 变化后（如文本节点切技能）下面的 effect 派发一个空事务让占位装饰重算。
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false,
      blockquote: false, codeBlock: false, horizontalRule: false, bold: false, italic: false,
      strike: false, code: false, link: false, underline: false, trailingNode: false,
      dropcursor: false, gapcursor: false, hardBreak: false,
    }),
    Placeholder.configure({ placeholder: () => placeholderRef.current }),
    RefAtom,
  ], []);
  const [initialContent] = useState(() => stringToDoc(value, refs));
  const editorProps = useMemo(() => ({
    attributes: { class: 'nokey', role: 'textbox', 'aria-multiline': 'true', 'aria-label': '生成提示词' },
    handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
      const m = mentionRef.current;
      if (m && !event.isComposing) {
        const items = mentionItemsRef.current;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const n = Math.max(items.length, 1);
          setMention({ ...m, active: (m.active + (event.key === 'ArrowDown' ? 1 : -1) + n) % n });
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const pick = items[m.active];
          if (pick) insertRef(pick.i + 1, { from: m.from, to: m.to });
          else setMention(null);
          return true;
        }
        if (event.key === 'Escape') { setMention(null); return true; }
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmitRef.current) {
        onSubmitRef.current();
        return true;
      }
      return false;
    },
    // 复制为纯文本时保留 {{ref N}}
    clipboardTextSerializer: (slice: Slice) => fragmentToString(slice.content),
    // 粘贴纯文本中的 {{ref N}} → 引用标签
    clipboardTextParser: (text: string, _ctx: unknown, _plain: boolean, view: { state: { schema: Schema } }) => {
      const schema = view.state.schema;
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const toInline = (line: string) => lineToInline(line, refsRef.current).map((j) => schema.nodeFromJSON(j));
      if (lines.length === 1) return new Slice(Fragment.from(toInline(lines[0])), 0, 0);
      const paras = lines.map((l) => schema.nodes.paragraph.create(null, toInline(l)));
      return new Slice(Fragment.from(paras), 1, 1);
    },
  }), [insertRef]);

  const editor = useEditor({
    extensions,
    content: initialContent,
    editable: !disabled,
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: false,
    editorProps,
    onUpdate: ({ editor: ed }) => {
      const s = docToString(ed.state.doc);
      if (s !== valueRef.current) {
        valueRef.current = s;
        onChangeRef.current(s);
      }
      updateMention(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => updateMention(ed),
    onBlur: () => { window.setTimeout(() => { if (!editorRef.current?.isFocused) setMention(null); }, 150); },
  });
  editorRef.current = editor;

  // 外部值变化（Agent 写入、撤销、参考重排改写编号）→ 重建内容
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (docToString(editor.state.doc) === value) return;
    editor.commands.setContent(stringToDoc(value, refsRef.current), { emitUpdate: false });
  }, [editor, value]);

  // 参考列表变化 → 标签重新编号 / 移除，并回写字符串
  const refsSig = refs.map((r) => `${r.key}\u0001${r.thumb ?? ''}\u0001${r.label ?? ''}`).join('\u0002');
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const changed = syncAtoms(editor, refsRef.current, prevKeys.current);
    prevKeys.current = new Set(refsRef.current.map((r) => r.key));
    if (!changed) return;
    const s = docToString(editor.state.doc);
    if (s !== valueRef.current) {
      valueRef.current = s;
      onChangeRef.current(s);
    }
  }, [editor, refsSig]);

  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);

  // K1：占位文字变化 → 空事务（不进撤销历史、不改文档）触发占位装饰重算
  const shownPlaceholder = useRef(placeholder);
  useEffect(() => {
    if (!editor || editor.isDestroyed || shownPlaceholder.current === placeholder) return;
    shownPlaceholder.current = placeholder;
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, placeholder]);

  const openMention = () => {
    if (!editor || disabled) return;
    editor.chain().focus().insertContent('@').run();
  };

  return (
    <div
      className={['cv-prompt-input nodrag nopan nowheel', expanded ? 'is-expanded' : '', className].filter(Boolean).join(' ')}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      onWheel={stop}
    >
      <EditorContent editor={editor} />
      {expandable && !expanded && (
        <ToolbarButton className="cv-prompt-input__expand" icon={IconMaximize} title="展开编辑提示词" iconOnly onMouseDown={(e) => e.preventDefault()} onClick={() => setShowExpanded(true)} />
      )}
      <ToolbarButton
        className="cv-prompt-input__expand"
        style={{ top: expandable && !expanded ? 28 : 2 }}
        icon={IconAt}
        title="插入引用"
        iconOnly
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openMention}
      />
      <Popover
        open={!!mention && !!editor?.isFocused}
        anchor={mention?.anchor ?? null}
        onClose={() => setMention(null)}
        className="cv-mention-pop"
        role="listbox"
        aria-label="选择参考"
      >
        {mentionItems.length ? mentionItems.map(({ r, i }, k) => (
          <button
            key={r.key}
            type="button"
            role="option"
            aria-selected={k === mention?.active}
            className={['cv-menu__item', k === mention?.active ? 'is-active' : ''].filter(Boolean).join(' ')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => mention && insertRef(i + 1, { from: mention.from, to: mention.to })}
          >
            {r.thumb ? <img className="cv-mention-pop__thumb" src={resolveMediaUrl(r.thumb)} alt="" /> : refIcon(r)}
            <span>{refName(i + 1)}</span>
            {r.label && <span className="cv-menu__item-extra">{r.label}</span>}
          </button>
        )) : <div className="cv-menu__empty">{refs.length ? '没有匹配的参考' : '暂无参考，先把上游节点连到输入口'}</div>}
      </Popover>
      {showExpanded && typeof document !== 'undefined' && createPortal(
        <div
          className="cv-scope"
          role="dialog"
          aria-label="生成提示词"
          style={{ position: 'fixed', inset: 0, zIndex: 1900, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--color-background) 60%, transparent)' }}
          onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setShowExpanded(false); }}
          onMouseDown={stop}
          onClick={stop}
          onDoubleClick={stop}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setShowExpanded(false); }}
          onContextMenu={stop}
          onWheel={stop}
        >
          <div className="cv-card" style={{ width: '80%', maxWidth: 960, padding: '14px 16px', boxShadow: 'var(--cv-shadow)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--cv-text-1)', fontSize: 14 }}>
              <span>生成提示词</span>
              <ToolbarButton icon={IconX} title="关闭" iconOnly onClick={() => setShowExpanded(false)} />
            </div>
            <PromptInput value={value} onChange={onChange} refs={refs} placeholder={placeholder} disabled={disabled} onSubmit={onSubmit} autoFocus expanded />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
