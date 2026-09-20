// -*- coding: utf-8 -*-
/**
 * 选区级 AI 润色浮标（全局单例）—— **在多行文本域里选中一段文字才出现**，
 * 点选技能后**只替换选中的那一段**，其余原样保留。
 *
 * 为什么不是"聚焦就出现"：
 * 旧实现 `GlobalAiPolish` 靠 `focusin` 触发，且 `handleFocusOut` 是空实现 ——
 * 按钮一旦出现就**再也不消失**，位置又只在 scroll/resize 时重算，于是折叠面板、
 * 切页签之后会留下一具"坐标尸体"飘在无关 UI 上（用户实测）。
 * 另外它无差别命中所有输入框（含搜索框/API Key 框），而且直接**整段覆盖**原值 ——
 * 用户"选一句改一句"的直觉会被吃掉整篇内容。故改为：
 *
 *   出现：textarea 内有非空选区（`selectionStart !== selectionEnd`）
 *   消失：选区塌陷 / 失焦 / 元素脱离 DOM —— 每次事件都重新求值，没有"存活期"
 *   写回：只替换 `[selectionStart, selectionEnd)`
 *   位置：镜像 div 量出选区末尾的真实坐标，并夹进视口
 *
 * 与字段级入口 `AiPolishButton` 的分工：
 *   · 本浮标：长文本里"只改这一句 / 这个词"，轻量、就地
 *   · `AiPolishButton`：字段级显式按钮，带定制要求 / 结果对比 / 应用替换（整段）
 * 两者共用 `polishUtils` 的技能清单、结果提取与写回逻辑。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, Wand2, X, AlertTriangle } from 'lucide-react';
import {
  loadPolishSkills, sortPolishSkills, guessContextType, runPolish, replaceRange,
  type PolishSkill, type PolishContextType,
} from './polishUtils';

interface SelState {
  el: HTMLTextAreaElement;
  start: number;
  end: number;
  text: string;
  contextType: PolishContextType;
}

const MENU_W = 236;
const PILL_W = 112;
const PILL_H = 28;
const MENU_H = 236;
const EDGE = 8;

/** 仅多行文本域参与（单行 input 多为搜索框/名称/密钥，选中不等于"想润色"）。 */
function eligible(el: Element | null): el is HTMLTextAreaElement {
  if (!el || el.tagName !== 'TEXTAREA') return false;
  // 显式退订：语义上不该润色的字段（如"跟 Agent 说话"的输入框）
  if (el.closest('[data-no-polish]')) return false;
  const ta = el as HTMLTextAreaElement;
  return !ta.disabled && !ta.readOnly;
}

/** 用镜像 div 量出 `index` 处光标的视口坐标（textarea 选区没有原生坐标 API）。 */
function measureCaret(el: HTMLTextAreaElement, index: number): { top: number; left: number; lineHeight: number } | null {
  try {
    const cs = window.getComputedStyle(el);
    const div = document.createElement('div');
    const s = div.style;
    const kebab = (p: string) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    const copy = [
      'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
      'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
      'letterSpacing', 'wordSpacing', 'tabSize',
    ];
    s.position = 'absolute';
    s.visibility = 'hidden';
    s.whiteSpace = 'pre-wrap';
    s.wordWrap = 'break-word';
    s.top = '0';
    s.left = '-9999px';
    s.width = cs.width;
    for (const p of copy) s.setProperty(kebab(p), cs.getPropertyValue(kebab(p)));
    div.textContent = el.value.slice(0, index);
    const span = document.createElement('span');
    span.textContent = el.value.slice(index) || '.';
    div.appendChild(span);
    document.body.appendChild(div);
    const rect = el.getBoundingClientRect();
    const top = rect.top + span.offsetTop - el.scrollTop + (parseFloat(cs.borderTopWidth) || 0);
    const left = rect.left + span.offsetLeft - el.scrollLeft + (parseFloat(cs.borderLeftWidth) || 0);
    const lineHeight = parseFloat(cs.lineHeight) || 16;
    document.body.removeChild(div);
    return { top, left, lineHeight };
  } catch {
    return null;
  }
}

export const SelectionPolish: React.FC = () => {
  const [sel, setSel] = useState<SelState | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<PolishSkill[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selRef = useRef<SelState | null>(null);
  const openRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // 应用润色会把结果重新选中（方便对照/撤销），那会触发 selectionchange。
  // 若不加抑制，浮标会立刻在"刚润色完的文字"上又弹一次。规则：抑制期间只有
  // **真实用户手势**（mouseup / keyup）能重新唤起，程序化选区变化一律忽略。
  const suppressRef = useRef(false);

  useEffect(() => { selRef.current = sel; }, [sel]);
  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => { loadPolishSkills().then(setSkills); }, []);

  const clear = useCallback(() => {
    selRef.current = null;
    setSel(null);
    setPos(null);
    setOpen(false);
    setError(null);
  }, []);

  /** 重算浮标位置（选区不变时用于滚动/布局变化后跟随）。 */
  const reposition = useCallback(() => {
    const cur = selRef.current;
    if (!cur) return;
    if (!cur.el.isConnected) { clear(); return; }
    const caret = measureCaret(cur.el, cur.end);
    const w = openRef.current ? MENU_W : PILL_W;
    const h = openRef.current ? MENU_H : PILL_H;
    const fallback = cur.el.getBoundingClientRect();
    const anchor = caret || { top: fallback.top, left: fallback.left + fallback.width - 8, lineHeight: 0 };
    setPos({
      // 贴在选区末尾下方；夹进视口，避免菜单被右/下边缘切掉
      top: Math.max(EDGE, Math.min(anchor.top + anchor.lineHeight + 6, window.innerHeight - h - EDGE)),
      left: Math.max(EDGE, Math.min(anchor.left, window.innerWidth - w - EDGE)),
    });
  }, [clear]);

  /**
   * 单一求值入口：每次触发都从"当前真实的焦点元素 + 选区"重新判断该不该显示。
   * 这样一来"消失"不需要任何专门的隐藏分支 —— 选区塌陷、失焦、元素被卸载时，
   * 这里求值的结果自然就是不显示。
   */
  const sync = useCallback(() => {
    if (suppressRef.current) return;

    const active = document.activeElement;
    if (!eligible(active)) {
      // 焦点在浮标自身（点菜单时 mousedown 已 preventDefault，正常不会走到这）
      if (containerRef.current && containerRef.current.contains(active)) return;
      clear();
      return;
    }
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    if (end - start < 1) { clear(); return; }

    const next: SelState = {
      el: active,
      start,
      end,
      text: active.value.slice(start, end),
      contextType: guessContextType(active),
    };
    selRef.current = next;
    setSel(next);
    setError(null);
    reposition();
  }, [clear, reposition]);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    };
    // 真实用户手势：解除"应用后抑制"，允许重新唤起
    const onUserGesture = () => {
      suppressRef.current = false;
      schedule();
    };
    const onScroll = () => { if (selRef.current) schedule(); };
    const onResize = () => { if (selRef.current) schedule(); };

    document.addEventListener('select', schedule, true);
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mouseup', onUserGesture, true);
    document.addEventListener('keyup', onUserGesture, true);
    document.addEventListener('focusout', schedule, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('select', schedule, true);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('mouseup', onUserGesture, true);
      document.removeEventListener('keyup', onUserGesture, true);
      document.removeEventListener('focusout', schedule, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [sync]);

  // 布局变化（面板折叠/变宽、页签切换）同步跟随 —— 旧实现缺这一步，才会留"坐标尸体"
  useEffect(() => {
    if (!sel) return;
    const ro = new ResizeObserver(() => reposition());
    try { ro.observe(sel.el); } catch { /* ignore */ }
    return () => ro.disconnect();
  }, [sel, reposition]);

  useEffect(() => { if (sel) reposition(); }, [open, sel, reposition]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (openRef.current || selRef.current)) {
        e.stopPropagation();
        clear();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [clear]);

  const apply = useCallback(async (skill: PolishSkill) => {
    const cur = selRef.current;
    if (!cur) return;
    setBusy(skill.name);
    setError(null);
    try {
      const { text: polished } = await runPolish(skill.name, cur.text, cur.contextType);
      if (!polished || !polished.trim()) throw new Error('润色未返回内容');
      suppressRef.current = true;
      const { caret } = replaceRange(cur.el, cur.start, cur.end, polished.trim());
      // 让结果仍处于选中态，方便继续比较/撤销
      requestAnimationFrame(() => {
        try { cur.el.focus(); cur.el.selectionStart = cur.start; cur.el.selectionEnd = caret; } catch { /* ignore */ }
      });
      clear();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }, [clear]);

  if (!sel || !pos) return null;

  const sorted = sortPolishSkills(skills, sel.contextType);
  const contextLabel = sel.contextType === 'prompt' ? '画面提示词' : sel.contextType === 'dialogue' ? '台词对白' : '通用';

  return (
    <div
      ref={containerRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999, width: open ? MENU_W : undefined }}
      className="flex flex-col items-stretch gap-1"
    >
      {!open && (
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); setOpen(true); }}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-brand/50 bg-surface text-[11px] font-semibold shadow-lg shadow-black/30 backdrop-blur-md [color:var(--color-text-main)] hover:bg-brand/10 disabled:opacity-40"
          title={`只润色选中的 ${sel.end - sel.start} 个字，其余原样保留`}
        >
          <Sparkles className="w-3 h-3 text-brand" />
          <span>润色选中</span>
          <span className="text-[9px] font-mono [color:var(--color-text-muted)]">{sel.end - sel.start}字</span>
        </button>
      )}

      {open && (
        <div className="bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-fade-in">
          <div className="px-2.5 py-2 border-b border-border bg-surface-secondary/50 flex items-center gap-1.5">
            <Wand2 className="w-3.5 h-3.5 text-brand shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold [color:var(--color-text-main)]">润色选中 · {contextLabel}</div>
              <div className="text-[9px] [color:var(--color-text-muted)] truncate" title={sel.text}>「{sel.text}」</div>
            </div>
            <button
              onMouseDown={(e) => { e.preventDefault(); clear(); }}
              className="p-1 rounded-md [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary shrink-0"
              title="关闭"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="max-h-[180px] overflow-y-auto p-1 custom-scrollbar">
            {sorted.map((s) => (
              <button
                key={s.name}
                onMouseDown={(e) => { e.preventDefault(); void apply(s); }}
                disabled={!!busy}
                className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-brand/10 flex items-start gap-2 group disabled:opacity-40"
              >
                <div className="mt-0.5 p-1 rounded-md bg-brand/10 border border-brand/20 group-hover:bg-brand group-hover:text-white text-brand shrink-0">
                  {busy === s.name
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Sparkles className="w-3 h-3" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold [color:var(--color-text-main)] truncate group-hover:text-brand-light">{s.name}</div>
                  {s.description && (
                    <div className="text-[9px] [color:var(--color-text-muted)] line-clamp-1 leading-tight">{s.description}</div>
                  )}
                </div>
              </button>
            ))}
            {!sorted.length && (
              <div className="px-2 py-3 text-[10px] [color:var(--color-text-muted)] text-center">没有可用润色技能</div>
            )}
          </div>

          {error && (
            <div className="px-2.5 py-1.5 border-t border-red-500/30 bg-red-500/10 text-[10px] text-red-300 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}

          <div className="px-2.5 py-1.5 border-t border-border bg-surface-secondary/30 text-[9px] [color:var(--color-text-muted)]">
            只替换选中的 {sel.end - sel.start} 个字 · 需要提定制要求请用字段上的「AI 润色」
          </div>
        </div>
      )}
    </div>
  );
};
