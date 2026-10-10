// @ts-nocheck
import React, { useEffect, useState, useRef } from 'react';
import { Sparkles, Loader2, Wand2 } from 'lucide-react';
import { apiService } from '../../services/api';

interface Position {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 全局 AI 润色悬浮按钮
 * - 监听所有 textarea / input[type=text] 的 focus
 * - 在聚焦元素右上角显示润色按钮
 * - 点击展开技能选择，调用 /skills/execute 润色
 */
export const GlobalAiPolish: React.FC<{ markProps?: Record<string, string> }> = ({ markProps }) => {
  const [activeEl, setActiveEl] = useState<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [open, setOpen] = useState(false);
  const [polishing, setPolishing] = useState<string | null>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiService.listSkills().then((list) => {
      const all = Array.isArray(list) ? list : (list as any)?.skills || [];
      const polish = all.filter((s: any) => s.category === 'prompt_optimization');
      if (polish.length) setSkills(polish);
      else setSkills([
        { name: 'prompt-master-optimizer', description: '万能优化' },
        { name: 'prompt-cinematic-boost', description: '电影感' },
        { name: 'prompt-detail-enhancer', description: '细节增强' },
        { name: 'prompt-anime-optimizer', description: '二次元' },
        { name: 'dialogue-emotion-polish', description: '台词情绪' },
      ]);
    }).catch(() => {
      setSkills([
        { name: 'prompt-master-optimizer', description: '万能优化' },
        { name: 'prompt-cinematic-boost', description: '电影感' },
        { name: 'prompt-detail-enhancer', description: '细节增强' },
        { name: 'prompt-anime-optimizer', description: '二次元' },
        { name: 'dialogue-emotion-polish', description: '台词情绪' },
      ]);
    });
  }, []);

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const isTextArea = target.tagName === 'TEXTAREA';
      const isInput = target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text';
      if (!isTextArea && !isInput) {
        // 检查是否在可编辑的文本框内
        return;
      }
      // 忽略搜索框等过短的
      const el = target as HTMLTextAreaElement | HTMLInputElement;
      // 仅对有 placeholder 或 已有值的 或 特定类的文本框显示
      // 过滤掉搜索框（placeholder 含 搜索）
      const placeholder = (el as HTMLTextAreaElement).placeholder || '';
      if (placeholder.includes('搜索') && el.value.length < 2) {
        // 仍然显示但降低优先级，暂时不显示
        // return;
      }
      setActiveEl(el);
      updatePosition(el);
      setOpen(false);
    };

    const handleFocusOut = (e: FocusEvent) => {
      // 延迟检查，若焦点移到润色面板则不隐藏
      setTimeout(() => {
        const ae = document.activeElement as HTMLElement;
        if (containerRef.current && containerRef.current.contains(ae)) return;
        if (ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && (ae as HTMLInputElement).type === 'text'))) {
          return;
        }
        // 若点击在面板内，不隐藏
        const related = e.relatedTarget as HTMLElement;
        if (related && containerRef.current?.contains(related)) return;
      }, 150);
    };

    const updatePosition = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      setPos({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
    };

    const handleScroll = () => {
      if (activeEl) updatePosition(activeEl);
    };

    const handleResize = () => {
      if (activeEl) updatePosition(activeEl);
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [activeEl]);

  // 点击外部关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node) && activeEl && !(activeEl.contains(e.target as Node))) {
        // 若点击的不是当前聚焦元素，也不是面板，则隐藏
        const target = e.target as HTMLElement;
        if (target.tagName !== 'TEXTAREA' && !(target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text')) {
          // 保持显示一段时间
        }
      }
    };
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, activeEl]);

  const getContextType = (el: HTMLElement | null): 'prompt' | 'dialogue' | 'general' => {
    if (!el) return 'general';
    const placeholder = (el as HTMLTextAreaElement).placeholder || '';
    const value = (el as HTMLTextAreaElement).value || '';
    const text = (placeholder + ' ' + value).toLowerCase();
    if (text.includes('台词') || text.includes('对白') || text.includes('dialogue') || placeholder.includes('台词')) return 'dialogue';
    if (text.includes('画面') || text.includes('提示词') || text.includes('prompt') || placeholder.includes('画面')) return 'prompt';
    return 'general';
  };

  const handlePolish = async (skillName: string) => {
    if (!activeEl) return;
    const original = activeEl.value;
    if (!original || !original.trim()) {
      alert('请先输入内容再润色');
      return;
    }
    setPolishing(skillName);
    setOpen(false);
    try {
      const ctxType = getContextType(activeEl);
      const context: any = {
        original_prompt: original,
        prompt: original,
        text: original,
        context_type: ctxType,
      };
      const res = await apiService.executeSkill(skillName, context, original);
      let polished = res?.modified_data?.polished_prompt || res?.modified_data?.polished_text || '';
      if (!polished || polished === res?.result_message) {
        polished = res?.modified_data?.polished_prompt || res?.modified_data?.polished_text || '';
      }
      if (!polished) {
        // 尝试从 result_message 提取
        polished = res?.result_message || '';
        // 若 result_message 包含中文解释，尝试提取英文部分
        if (polished && polished.length > original.length * 1.5) {
          const lines = polished.split('\n').map(s => s.trim()).filter(Boolean);
          const last = lines[lines.length - 1];
          if (last && last.length > 10) polished = last;
        }
      }
      if (polished && polished.trim() && polished.trim() !== original.trim()) {
        // 更新 React 受控组件的值
        const el = activeEl;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
          'value'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, polished.trim());
        } else {
          (el as any).value = polished.trim();
        }
        // 触发 React onChange
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // 聚焦并选中
        el.focus();
        // 对于中文，可能需要触发 composition
        try {
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
        } catch {}
      } else if (polished) {
        // 内容相同或空，不更新但提示
        console.log('Polish returned same content');
      } else {
        alert('润色未返回内容');
      }
    } catch (e: any) {
      alert('润色失败: ' + (e?.message || String(e)));
    } finally {
      setPolishing(null);
    }
  };

  if (!activeEl || !pos) return null;

  const contextType = getContextType(activeEl);
  const sortedSkills = [...skills].sort((a, b) => {
    const order: Record<string, number> = {};
    if (contextType === 'prompt') {
      order['prompt-master-optimizer'] = 0;
      order['prompt-cinematic-boost'] = 1;
      order['prompt-detail-enhancer'] = 2;
      order['prompt-anime-optimizer'] = 3;
    } else if (contextType === 'dialogue') {
      order['dialogue-emotion-polish'] = 0;
      order['prompt-master-optimizer'] = 1;
    }
    return (order[a.name] ?? 99) - (order[b.name] ?? 99);
  });

  // 计算按钮位置：元素右上角外侧
  const buttonTop = pos.top - 2;
  const buttonLeft = pos.left + pos.width - 2;

  return (
    <>
      {/* 悬浮按钮 */}
      <div
        ref={containerRef}
        style={{
          position: 'fixed',
          top: buttonTop,
          left: buttonLeft,
          transform: 'translateX(-100%) translateY(-100%)',
          zIndex: 9999,
          pointerEvents: 'auto',
        }}
        className="flex flex-col items-end gap-1"
        // 标注属性由条目注入，落在本组件自己的 fixed 根上（槽位不加包裹层，见审查 M3）
        {...markProps}
      >
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen(v => !v);
          }}
          disabled={!!polishing}
          className={`inline-flex items-center gap-1 rounded-full border shadow-lg backdrop-blur-md text-[11px] font-medium transition-all
            ${open ? 'bg-brand text-white border-brand shadow-brand/20' : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-300 hover:text-white hover:border-brand/40 hover:bg-brand/10'}
            px-2.5 py-1 disabled:opacity-40
          `}
          title="AI 润色：选择不同 Skill 优化提示词"
        >
          {polishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-brand" />}
          <span>{polishing ? '润色中...' : 'AI 润色'}</span>
        </button>

        {open && (
          <div className="w-64 bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl shadow-2xl overflow-hidden animate-fade-in">
            <div className="px-3 py-2 border-b border-white/70 dark:border-white/12 bg-surface/80">
              <div className="text-[11px] font-bold text-white flex items-center gap-1.5">
                <Wand2 className="w-3.5 h-3.5 text-brand" /> 选择润色技能
              </div>
              <div className="text-[10px] text-gray-500">
                {contextType === 'prompt' ? '画面提示词' : contextType === 'dialogue' ? '台词对白' : '通用'} · {sortedSkills.length} 个可用
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5 space-y-1">
              {sortedSkills.map(s => (
                <button
                  key={s.name}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handlePolish(s.name);
                  }}
                  disabled={!!polishing}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-transparent hover:border-brand/30 hover:bg-brand/10 flex items-start gap-2.5 group disabled:opacity-40"
                >
                  <div className="mt-0.5 p-1 rounded-lg bg-brand/10 border border-brand/20 group-hover:bg-brand group-hover:text-white transition-colors">
                    <Sparkles className="w-3 h-3 text-brand group-hover:text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-white group-hover:text-brand-light truncate">{s.name}</div>
                    <div className="text-[10px] text-gray-400 line-clamp-2 leading-relaxed">{s.description}</div>
                  </div>
                  {polishing === s.name && <Loader2 className="w-3 h-3 animate-spin text-brand mt-1" />}
                </button>
              ))}
            </div>
            <div className="px-3 py-2 border-t border-white/70 dark:border-white/12 bg-white/35 dark:bg-white/[.03] text-[10px] text-gray-500">
              💡 润色将保留原意，增强细节与风格
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default GlobalAiPolish;
