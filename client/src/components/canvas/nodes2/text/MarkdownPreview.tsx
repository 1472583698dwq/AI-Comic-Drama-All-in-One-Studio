// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点：Markdown 只读预览（对照 Toonflow textNode/markdownPreview.vue）。
 * 内容经 markdownHtml.renderMarkdownHtml（marked + DOMPurify）净化后再插入。
 */
import { memo, useMemo, type CSSProperties } from 'react';
import { renderMarkdownHtml } from './markdownHtml';

export interface MarkdownPreviewProps {
  value: string;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}

export const MarkdownPreview = memo(function MarkdownPreview({ value, className, style, ...rest }: MarkdownPreviewProps) {
  const html = useMemo(() => renderMarkdownHtml(value), [value]);
  return (
    <div
      className={['cv-md', className].filter(Boolean).join(' ')}
      style={style}
      aria-label={rest['aria-label']}
      // 已净化（DOMPurify），见 markdownHtml.ts
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
