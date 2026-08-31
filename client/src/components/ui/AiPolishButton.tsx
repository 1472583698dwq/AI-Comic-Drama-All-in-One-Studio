// @ts-nocheck
import React, { useEffect, useState, useRef } from 'react';
import { Sparkles, Wand2, Loader2, ChevronDown, Check } from 'lucide-react';
import { apiService } from '../../services/api';
import { useSkillStore } from '../../stores/useSkillStore';

interface AiPolishButtonProps {
  value: string;
  onPolish: (polished: string, meta?: any) => void;
  contextType?: 'prompt' | 'dialogue' | 'general';
  className?: string;
  size?: 'sm' | 'xs';
  label?: string;
}

/**
 * AI 润色按钮：可选择不同 Skill 优化提示词
 * - 自动拉取 prompt_optimization 类别 skills + 内置 5 个润色技能
 * - 点击展开下拉，选择技能后调用 /skills/execute 润色
 */
export const AiPolishButton: React.FC<AiPolishButtonProps> = ({
  value,
  onPolish,
  contextType = 'general',
  className = '',
  size = 'xs',
  label = 'AI 润色',
}) => {
  const [open, setOpen] = useState(false);
  const [polishing, setPolishing] = useState<string | null>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 拉取技能列表，过滤 prompt_optimization
    apiService.listSkills().then((list) => {
      const all = Array.isArray(list) ? list : (list as any)?.skills || [];
      const polishSkills = all.filter((s: any) => s.category === 'prompt_optimization');
      // 若为空则用本地兜底
      if (polishSkills.length === 0) {
        setSkills([
          { name: 'prompt-master-optimizer', description: '万能优化', category: 'prompt_optimization' },
          { name: 'prompt-cinematic-boost', description: '电影感', category: 'prompt_optimization' },
          { name: 'prompt-detail-enhancer', description: '细节增强', category: 'prompt_optimization' },
          { name: 'prompt-anime-optimizer', description: '二次元', category: 'prompt_optimization' },
          { name: 'dialogue-emotion-polish', description: '台词情绪', category: 'prompt_optimization' },
        ]);
      } else {
        setSkills(polishSkills);
      }
    }).catch(() => {
      setSkills([
        { name: 'prompt-master-optimizer', description: '万能优化', category: 'prompt_optimization' },
        { name: 'prompt-cinematic-boost', description: '电影感', category: 'prompt_optimization' },
        { name: 'prompt-detail-enhancer', description: '细节增强', category: 'prompt_optimization' },
        { name: 'prompt-anime-optimizer', description: '二次元', category: 'prompt_optimization' },
        { name: 'dialogue-emotion-polish', description: '台词情绪', category: 'prompt_optimization' },
      ]);
    });
  }, []);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const handlePolish = async (skillName: string) => {
    if (!value || !value.trim()) {
      alert('请先输入内容再润色');
      return;
    }
    setPolishing(skillName);
    setOpen(false);
    try {
      const context: any = {
        original_prompt: value,
        prompt: value,
        text: value,
        context_type: contextType,
      };
      const res = await apiService.executeSkill(skillName, context, value);
      const polished = res?.modified_data?.polished_prompt || res?.modified_data?.polished_text || res?.result_message || '';
      // 尝试从 result_message 提取
      let finalText = polished;
      if (!finalText || finalText === res?.result_message) {
        // 如果 polished 为空，尝试解析
        if (res?.modified_data?.polished_prompt) finalText = res.modified_data.polished_prompt;
        else if (res?.modified_data?.polished_text) finalText = res.modified_data.polished_text;
      }
      // 清理：去除可能的引号和多余解释
      if (finalText) {
        finalText = finalText.trim();
        // 若返回的是 JSON 字符串，尝试解析
        if (finalText.startsWith('{') && finalText.includes('polished_text')) {
          try {
            const j = JSON.parse(finalText);
            finalText = j.polished_text || j.polished_prompt || finalText;
          } catch {}
        }
        // 若包含中文解释，取最后一段英文
        if (finalText.length > value.length * 1.5 && finalText.includes('\n')) {
          const lines = finalText.split('\n').map(s => s.trim()).filter(Boolean);
          const last = lines[lines.length - 1];
          if (last && last.length > 10) finalText = last;
        }
      }
      if (finalText && finalText !== value) {
        onPolish(finalText.trim(), res?.modified_data);
      } else if (finalText) {
        onPolish(finalText.trim(), res?.modified_data);
      } else {
        alert('润色未返回内容：' + (res?.result_message || '空'));
      }
    } catch (e: any) {
      alert('润色失败: ' + (e?.message || String(e)));
    } finally {
      setPolishing(null);
    }
  };

  const isPolishing = polishing !== null;

  // 根据 contextType 排序推荐
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

  return (
    <div ref={ref} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={isPolishing || !value.trim()}
        className={`inline-flex items-center gap-1 rounded-full border text-[11px] font-medium transition-all disabled:opacity-40
          ${size === 'xs' ? 'px-2 py-1' : 'px-2.5 py-1.5'}
          ${open ? 'bg-brand text-white border-brand shadow-md' : 'bg-surface-secondary border-border text-gray-300 hover:text-white hover:border-brand/40 hover:bg-brand/10'}
        `}
        title="AI 润色：选择不同 Skill 优化提示词"
      >
        {isPolishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-brand" />}
        <span>{isPolishing ? '润色中...' : label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-64 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden z-50 animate-fade-in">
          <div className="px-3 py-2 border-b border-border bg-surface-secondary/50">
            <div className="text-[11px] font-bold text-white flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5 text-brand" /> 选择润色技能
            </div>
            <div className="text-[10px] text-gray-500">针对当前内容智能优化</div>
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5 space-y-1">
            {sortedSkills.map(s => (
              <button
                key={s.name}
                onClick={() => handlePolish(s.name)}
                disabled={!!polishing}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-transparent hover:border-brand/30 hover:bg-brand/10 flex items-start gap-2.5 group"
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
          <div className="px-3 py-2 border-t border-border bg-surface-secondary/30 text-[10px] text-gray-500">
            💡 提示：润色将保留原意，增强细节与风格
          </div>
        </div>
      )}
    </div>
  );
};

export default AiPolishButton;
