import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * 零依赖轻量 Markdown 渲染（防 XSS：全程 React 节点拼接，不用 innerHTML）。
 * 支持：围栏代码块（含复制按钮）、行内代码、加粗/斜体/删除线、标题、引用、
 * 有序/无序列表、链接、分割线、简单表格、段落换行。
 */

let keySeq = 0;
const nk = (p: string) => `${p}-${keySeq++}`;

// ---------- 行内解析 ----------
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(~~[^~]+?~~)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(\[([^\]]+?)\]\((https?:[^)\s]+?)\))/g;

function parseInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  // 必须每次新建实例：函数会递归调用自身，加粗/斜体内层会重置共享正则的lastIndex，
  // 若共用模块级 /g 正则，外层循环会从头重新匹配同一token导致页面卡死（2026-09-08实测）。
  const re = new RegExp(INLINE_RE);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [full, code, bold1, bold2, strike, ital1, ital2, _link, linkText, href] = m;
    if (code) {
      out.push(
        <code key={nk('c')} className="px-1 py-px rounded bg-black/[.05] dark:bg-white/[.06] border border-black/5 dark:border-white/10 font-mono text-[12px] [color:var(--color-text-main)] break-all">
          {code.slice(1, -1)}
        </code>
      );
    } else if (bold1 || bold2) {
      const inner = bold1 ? bold1.slice(2, -2) : (bold2 as string).slice(2, -2);
      out.push(<strong key={nk('b')} className="font-bold">{parseInline(inner)}</strong>);
    } else if (strike) {
      out.push(<s key={nk('s')} className="line-through opacity-80">{parseInline((strike as string).slice(2, -2))}</s>);
    } else if (ital1 || ital2) {
      const inner = ital1 ? ital1.slice(1, -1) : (ital2 as string).slice(1, -1);
      out.push(<em key={nk('e')}>{parseInline(inner)}</em>);
    } else if (_link) {
      out.push(
        <a key={nk('a')} href={href} target="_blank" rel="noreferrer noopener" className="text-brand hover:underline break-all">
          {linkText}
        </a>
      );
    } else {
      out.push(full);
    }
    last = m.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- 代码块（含复制） ----------
const CodeBlock: React.FC<{ lang: string; code: string }> = ({ lang, code }) => {
  const [copied, setCopied] = useState(false);
  const doCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {}
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="my-2 rounded-lg border border-black/5 dark:border-white/10 bg-black/[.04] dark:bg-white/[.06] overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1 bg-black/[.03] dark:bg-white/5 border-b border-black/5 dark:border-white/10">
        <span className="text-[11px] font-mono [color:var(--color-text-muted)]">{lang || 'code'}</span>
        <button
          onClick={doCopy}
          className="flex items-center gap-1 text-[11px] [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] transition-colors px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10"
          title="复制代码"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="p-2.5 text-[12px] leading-relaxed font-mono [color:var(--color-text-main)] overflow-x-auto whitespace-pre custom-scrollbar select-text">
        {code}
      </pre>
    </div>
  );
};

// ---------- 块级解析 ----------
function renderBlocks(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // 先按围栏代码块切分（允许流式未闭合）
  const fenceRe = /```(\w*)\n?([\s\S]*?)(```|$)/g;
  const chunks: Array<{ type: 'code'; lang: string; code: string } | { type: 'text'; text: string }> = [];
  let last = 0;
  let fm: RegExpExecArray | null;
  fenceRe.lastIndex = 0;
  while ((fm = fenceRe.exec(text)) !== null) {
    if (fm.index > last) chunks.push({ type: 'text', text: text.slice(last, fm.index) });
    chunks.push({ type: 'code', lang: (fm[1] || '').trim(), code: (fm[2] || '').replace(/\n$/, '') });
    last = fm.index + fm[0].length;
    if (fm[3] === '') break; // 未闭合：余下全是代码
  }
  if (last < text.length) chunks.push({ type: 'text', text: text.slice(last) });
  if (chunks.length === 0) chunks.push({ type: 'text', text });

  for (const ch of chunks) {
    if (ch.type === 'code') {
      out.push(<CodeBlock key={nk('cb')} lang={ch.lang} code={ch.code} />);
      continue;
    }
    const lines = ch.text.split('\n');
    let i = 0;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length === 0) return;
      const nodes: React.ReactNode[] = [];
      para.forEach((ln, idx) => {
        if (idx > 0) nodes.push(<br key={nk('br')} />);
        nodes.push(...parseInline(ln));
      });
      out.push(<p key={nk('p')} className="my-1 leading-relaxed break-words">{nodes}</p>);
      para = [];
    };
    while (i < lines.length) {
      const ln = lines[i];
      const t = ln.trim();
      // 空行：分段
      if (!t) { flushPara(); i++; continue; }
      // 分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); out.push(<hr key={nk('hr')} className="my-2 border-black/10 dark:border-white/10" />); i++; continue; }
      // 标题
      const h = /^(#{1,4})\s+(.*)$/.exec(t);
      if (h) {
        flushPara();
        const level = h[1].length;
        const cls = level === 1 ? 'text-base font-bold mt-2.5 mb-1' : level === 2 ? 'text-sm font-bold mt-2.5 mb-1' : 'text-[13px] font-bold mt-2 mb-1';
        out.push(<div key={nk('h')} className={cls}>{parseInline(h[2])}</div>);
        i++; continue;
      }
      // 引用（连续归组）
      if (/^>/.test(t)) {
        flushPara();
        const qs: string[] = [];
        while (i < lines.length && /^>/.test(lines[i].trim())) { qs.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
        out.push(
          <blockquote key={nk('q')} className="my-1 pl-2.5 border-l-2 border-brand/60 [color:var(--color-text-secondary)]">
            {qs.map((q, idx) => (<div key={idx}>{parseInline(q)}</div>))}
          </blockquote>
        );
        continue;
      }
      // 表格：表头 + 分隔行 + 数据行
      if (t.startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?[\s:|-]*$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) {
        flushPara();
        const splitRow = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = splitRow(t);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
        out.push(
          <div key={nk('tw')} className="my-2 overflow-x-auto custom-scrollbar rounded-lg border border-black/5 dark:border-white/10">
            <table className="w-full text-[12px] border-collapse">
              <thead><tr className="bg-black/[.03] dark:bg-white/5">{head.map((c, ci) => (<th key={ci} className="px-2 py-1 text-left font-bold border-b border-black/5 dark:border-white/10 whitespace-nowrap">{parseInline(c)}</th>))}</tr></thead>
              <tbody>{rows.map((r, ri) => (<tr key={ri} className="border-b border-black/5 dark:border-white/5 last:border-0">{r.map((c, ci) => (<td key={ci} className="px-2 py-1 align-top break-words">{parseInline(c)}</td>))}</tr>))}</tbody>
            </table>
          </div>
        );
        continue;
      }
      // 无序列表（连续归组）
      if (/^([-*•])\s+/.test(t)) {
        flushPara();
        const items: string[] = [];
        while (i < lines.length && /^([-*•])\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^([-*•])\s+/, '')); i++; }
        out.push(
          <ul key={nk('ul')} className="my-1 space-y-0.5">
            {items.map((it, ii) => (
              <li key={ii} className="flex gap-1.5 leading-relaxed"><span className="text-brand shrink-0">•</span><span className="break-words">{parseInline(it)}</span></li>
            ))}
          </ul>
        );
        continue;
      }
      // 有序列表（连续归组）
      if (/^\d+[.)]\s+/.test(t)) {
        flushPara();
        const items: string[] = [];
        let n = 1;
        const nums: number[] = [];
        while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
          const mm = /^(\d+)[.)]\s+/.exec(lines[i].trim());
          nums.push(mm ? parseInt(mm[1], 10) : n);
          items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
          i++; n++;
        }
        out.push(
          <ol key={nk('ol')} className="my-1 space-y-0.5">
            {items.map((it, ii) => (
              <li key={ii} className="flex gap-1.5 leading-relaxed"><span className="text-brand shrink-0 font-mono">{nums[ii]}.</span><span className="break-words">{parseInline(it)}</span></li>
            ))}
          </ol>
        );
        continue;
      }
      para.push(ln);
      i++;
    }
    flushPara();
  }
  return out;
}

export const MarkdownText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  if (!text) return null;
  return <div className={className}>{renderBlocks(text)}</div>;
};

export default MarkdownText;
