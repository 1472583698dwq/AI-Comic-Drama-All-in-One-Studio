// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点：Markdown → 安全 HTML（只读预览，对照 Toonflow textNode/markdownContent.ts 的 markdownDom）。
 * marked（GFM，单换行 = 换行：MiniMax 的剧本 / 提示词多为逐行文本）+ DOMPurify 净化；
 * 链接新窗口打开、任务列表复选框只读、相对产物图片在 dev 下回源后端（resolveMediaUrl）。
 */
import { Marked, Tokenizer, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { resolveMediaUrl } from '../../../../utils/devOrigin';

/** `<https://…>` / `<mailto:…>` 保留为链接；`<lora:name:0.8>` 这类提示词标签按原文显示（不当成 lora: 协议链接）。 */
const LINK_SCHEME_RE = /^(https?:|mailto:)/i;

/**
 * REQ-toonflow-canvas 删除线只认 `~~x~~`：GFM 的单 `~` 删除线会把「3~5 秒，然后 6~8 秒」这类中文范围写法渲染成删除线。
 * 单个 `~` 作为普通文字消费掉（预览与富文本解析共用）。
 */
export function doubleTildeOnly(this: Tokenizer, src: string, maskedSrc: string, prevChar?: string): Tokens.Del | false {
  const token = Tokenizer.prototype.del.call(this, src, maskedSrc, prevChar);
  if (!token) return false;
  if (token.raw.startsWith('~~')) return token;
  return { type: 'text', raw: '~', text: '~' } as unknown as Tokens.Del;
}

let previewMarked: Marked | null = null;

function getPreviewMarked(): Marked {
  if (previewMarked) return previewMarked;
  const m = new Marked({ gfm: true, breaks: true });
  m.use({
    tokenizer: {
      autolink(src) {
        const token = Tokenizer.prototype.autolink.call(this, src);
        if (!token || LINK_SCHEME_RE.test(token.href)) return token ?? false;
        return { type: 'text', raw: token.raw, text: token.raw } as unknown as Tokens.Link;
      },
      del: doubleTildeOnly,
    },
  });
  previewMarked = m;
  return m;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Markdown → 净化后的 HTML 字符串（空文本返回空串）。 */
export function renderMarkdownHtml(markdown: string): string {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';
  let html: string;
  try {
    html = getPreviewMarked().parse(markdown, { async: false }) as string;
  } catch {
    return `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`;
  }
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`;
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
  }) as DocumentFragment;
  // 只保留对齐样式（Toonflow 同款），其余内联样式去掉，避免外部内容改写画布配色
  for (const el of Array.from(fragment.querySelectorAll<HTMLElement>('[style]'))) {
    const align = el.style.textAlign;
    el.removeAttribute('style');
    if (['left', 'center', 'right', 'justify'].includes(align)) el.style.textAlign = align;
  }
  for (const a of Array.from(fragment.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    a.rel = 'noopener noreferrer';
    if (/^https?:/i.test(a.getAttribute('href') || '')) a.target = '_blank';
  }
  for (const img of Array.from(fragment.querySelectorAll<HTMLImageElement>('img'))) {
    const src = img.getAttribute('src');
    if (src) img.setAttribute('src', resolveMediaUrl(src));
    img.setAttribute('loading', 'lazy');
    img.setAttribute('draggable', 'false');
  }
  for (const box of Array.from(fragment.querySelectorAll<HTMLInputElement>('input'))) {
    if (box.type !== 'checkbox') box.remove();
    else box.setAttribute('disabled', '');
  }
  const host = document.createElement('div');
  host.appendChild(fragment);
  return host.innerHTML;
}
