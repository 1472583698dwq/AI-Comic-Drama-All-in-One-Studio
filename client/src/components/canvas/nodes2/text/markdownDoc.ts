// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点：Markdown ⇄ tiptap 文档（富文本编辑用，对照 Toonflow textNode/markdownExtensions.ts）。
 *
 * 用官方 @tiptap/markdown 的 MarkdownManager（marked 词法 + 各扩展自带的 parse/renderMarkdown），独立 marked 实例
 * （不改全局 marked）。与 Toonflow 的差异——MiniMax 的文本节点正文会原样流向下游当提示词，所以：
 *  1. 文字原样写回：不做 Markdown 转义 / HTML 实体编码（否则 `[中景]`、`1girl_solo`、`a & b` 会被写成 `\[中景\]`、
 *     `1girl\_solo`、`a &amp; b` 污染提示词）；
 *  2. 编辑解析时不把 URL / `<lora:x:0.8>` 识别成链接（否则会被改写成 `[x](x)`），输入时也不自动转链接；
 *  3. isRichSafe：解析再序列化与原文一致（忽略行尾空白 / 多余空行）才默认用富文本编辑，否则默认原文编辑，防止静默改写。
 * 本模块只被编辑器（懒加载）和测试引用，预览走 markdownHtml.ts。
 */
import { Marked, Tokenizer, marked as markedSingleton, type Tokens } from 'marked';
import { MarkdownManager } from '@tiptap/markdown';
import { mergeAttributes, type AnyExtension, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { doubleTildeOnly } from './markdownHtml';

/** 图片：存原始 src（序列化回 Markdown 用），显示时相对产物 URL 在 dev 下回源后端。 */
const MediaImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes, src: resolveMediaUrl(HTMLAttributes.src as string) || HTMLAttributes.src };
    return ['img', mergeAttributes(this.options.HTMLAttributes, attrs)];
  },
});

/** 富文本编辑器与 Markdown 转换共用的 schema 扩展（编辑器另加 Placeholder）。 */
export function markdownSchemaExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: false, linkOnPaste: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    MediaImage.configure({ inline: true }),
  ];
}

/**
 * 编辑解析用 marked：裸 URL / 尖括号自动链接一律按原文文本处理（显式 `[文字](链接)` 不受影响）；
 * 删除线只认 `~~x~~`（单个 `~` 常见于「3~5 秒」这类范围写法，见 markdownHtml.doubleTildeOnly）。
 */
function createEditorMarked(): Marked {
  const asText = (token: Tokens.Link | undefined): Tokens.Link | false =>
    token ? ({ type: 'text', raw: token.raw, text: token.raw } as unknown as Tokens.Link) : false;
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    tokenizer: {
      url(src) {
        return asText(Tokenizer.prototype.url.call(this, src));
      },
      autolink(src) {
        return asText(Tokenizer.prototype.autolink.call(this, src));
      },
      del: doubleTildeOnly,
    },
  });
  return m;
}

/** 需要块级子节点的容器（doc / 引用 / 列表项 / 表格单元格）。 */
const BLOCK_CONTAINERS = new Set(['doc', 'blockquote', 'listItem', 'taskItem', 'tableCell', 'tableHeader']);
const INLINE_TYPES = new Set(['text', 'image', 'hardBreak']);

/**
 * 段落解析会把「只含一张图」的段落拆成独立 image 节点（@tiptap/markdown 假设图片是块级），
 * 而这里图片是行内节点：把容器里散落的行内节点重新包进段落，保证文档符合 schema。
 */
function wrapInlineBlocks(node: JSONContent): JSONContent {
  if (!node.content?.length) return node;
  const children = node.content.map(wrapInlineBlocks);
  if (!BLOCK_CONTAINERS.has(node.type || '')) return { ...node, content: children };
  const out: JSONContent[] = [];
  let run: JSONContent[] = [];
  const flush = () => {
    if (run.length) out.push({ type: 'paragraph', content: run });
    run = [];
  };
  for (const child of children) {
    if (INLINE_TYPES.has(child.type || '')) run.push(child);
    else {
      flush();
      out.push(child);
    }
  }
  flush();
  return { ...node, content: out };
}

let manager: MarkdownManager | null = null;

export function getMarkdownManager(): MarkdownManager {
  if (manager) return manager;
  const m = new MarkdownManager({
    marked: createEditorMarked() as unknown as typeof markedSingleton,
    markedOptions: { gfm: true, breaks: false },
    extensions: markdownSchemaExtensions(),
  });
  // REQ-toonflow-canvas 正文原样写回：关掉 Markdown 转义与 HTML 实体编码（见文件头第 1 条）
  (m as unknown as { encodeTextForMarkdown: (text: string) => string }).encodeTextForMarkdown = (text) => text;
  manager = m;
  return m;
}

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Markdown → tiptap 文档 JSON。 */
export function markdownToDoc(markdown: string): JSONContent {
  const src = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n') : '';
  if (!src.trim()) return EMPTY_DOC;
  const doc = getMarkdownManager().parse(src);
  return doc?.content?.length ? wrapInlineBlocks(doc) : EMPTY_DOC;
}

/** tiptap 文档 JSON → Markdown。 */
export function docToMarkdown(doc: JSONContent): string {
  const out = getMarkdownManager().serialize(doc);
  // 空文档（只有空段落）不产出 &nbsp; 之类占位
  return out.replace(/^(?:&nbsp;| |\s)+$/, '');
}

/** 比较用的规范化：统一换行、去行尾空白、多个空行并一个、去首尾空白。 */
export function normalizeMarkdown(markdown: string): string {
  return (markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** isRichSafe 的比较口径：再忽略空行（块之间补 / 删空行如「标题\n正文」→「标题\n\n正文」不改变内容）。 */
function comparable(markdown: string): string {
  return normalizeMarkdown(markdown).split('\n').filter((line) => line.trim()).join('\n');
}

/** 富文本编辑是否不会改写这段 Markdown（解析再序列化 ≈ 原文，只差空白）。 */
export function isRichSafe(markdown: string): boolean {
  if (!markdown || !markdown.trim()) return true;
  try {
    return comparable(docToMarkdown(markdownToDoc(markdown))) === comparable(markdown);
  } catch {
    return false;
  }
}
