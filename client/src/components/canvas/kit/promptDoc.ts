// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 提示词字符串 ⇄ tiptap 文档 的纯函数转换。
 * 存储格式与 Toonflow 一致：纯字符串，引用写成 `{{ref N}}` 字面量（N 从 1 起，指向参考列表第 N 项），换行 = 段落。
 */
import type { JSONContent } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import type { RefItem } from './types';
import { REF_TOKEN_RE, refName, refToken } from './references';

export const REF_ATOM = 'refAtom';

export interface RefAtomAttrs {
  index: number;
  refKey: string | null;
  label: string;
  thumb: string | null;
  missing: boolean;
}

/** 第 index 个参考（1 起）对应的 chip 属性。 */
export function refAtomAttrs(index: number, refs: readonly RefItem[], refKey?: string | null): RefAtomAttrs {
  const item = refKey ? refs.find((r) => r.key === refKey) : refs[index - 1];
  const idx = item ? refs.indexOf(item) + 1 : index;
  return {
    index: idx,
    refKey: item?.key ?? refKey ?? null,
    label: item ? `${refName(idx)}${item.label ? ` · ${item.label}` : ''}` : `${refName(idx)}（未连接）`,
    thumb: item?.thumb ?? null,
    missing: !item,
  };
}

/** 一行文本 → 行内节点（text + refAtom）。 */
export function lineToInline(line: string, refs: readonly RefItem[]): JSONContent[] {
  const out: JSONContent[] = [];
  let last = 0;
  for (const m of line.matchAll(REF_TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: line.slice(last, at) });
    out.push({ type: REF_ATOM, attrs: { ...refAtomAttrs(Number(m[1]), refs) } });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
  return out;
}

/** 字符串 → tiptap doc JSON（每行一个段落）。 */
export function stringToDoc(value: string, refs: readonly RefItem[]): JSONContent {
  const lines = (value ?? '').split('\n');
  return {
    type: 'doc',
    content: lines.map((line) => {
      const content = lineToInline(line, refs);
      return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}

function inlineToString(node: PMNode | JSONContent): string {
  const type = typeof node.type === 'string' ? node.type : (node as PMNode).type.name;
  if (type === 'text') return (node as { text?: string }).text ?? '';
  if (type === REF_ATOM) return refToken(Number((node as { attrs?: Record<string, unknown> }).attrs?.index ?? 1));
  if (type === 'hardBreak') return '\n';
  return '';
}

/** ProseMirror Fragment（段落列表或行内节点）→ 字符串。 */
export function fragmentToString(fragment: Fragment): string {
  const blocks: string[] = [];
  let inline = '';
  let sawBlock = false;
  fragment.forEach((child) => {
    if (child.isBlock) {
      sawBlock = true;
      let line = '';
      child.forEach((c) => { line += inlineToString(c); });
      blocks.push(line);
    } else inline += inlineToString(child);
  });
  if (!sawBlock) return inline;
  if (inline) blocks.unshift(inline);
  return blocks.join('\n');
}

/** doc → 存储字符串。 */
export function docToString(doc: PMNode): string {
  return fragmentToString(doc.content);
}

/** doc JSON → 存储字符串（测试 / 无编辑器时用）。 */
export function docJSONToString(doc: JSONContent): string {
  return (doc.content || []).map((p) => (p.content || []).map((c) => inlineToString(c)).join('')).join('\n');
}
