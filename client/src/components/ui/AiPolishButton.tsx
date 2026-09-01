// @ts-nocheck
import React, { useEffect, useState, useRef } from 'react';
import {
  Sparkles,
  Wand2,
  Loader2,
  ChevronDown,
  Check,
  X,
  Copy,
  RotateCcw,
  Sliders,
  Layers,
  ArrowRight,
  MessageSquareQuote,
  Flame,
  Palette,
  Film,
  Camera,
  Search,
} from 'lucide-react';
import { apiService } from '../../services/api';

export interface AiPolishButtonProps {
  value: string;
  onPolish: (polished: string, meta?: any) => void;
  contextType?: 'prompt' | 'dialogue' | 'general';
  className?: string;
  size?: 'sm' | 'xs';
  label?: string;
}

interface SkillItem {
  name: string;
  description: string;
  category?: string;
  author?: string;
  version?: string;
  tools?: string[];
  instructions?: string;
}

const QUICK_REQUIREMENTS = {
  prompt: [
    '🌧️ 暴雨雷电夜景',
    '🌅 逆光丁达尔体积光',
    '🔥 燃烧战损破碎',
    '👁️ 眼神特写杀气',
    '⚡ 爆发雷电粒子',
    '🏯 仙侠云海仙阁',
    '🌃 赛博霓虹雨夜街区',
    '🗡️ 极速拔剑动态残影',
    '💥 冲击波碎石飞溅',
    '🌌 浩瀚星空银河',
    '🌫️ 幽暗密林晨雾',
  ],
  dialogue: [
    '🔥 语气更霸气强势、不容置疑',
    '😢 压抑悲痛带微微哭腔',
    '🤫 贴耳冷酷低语、极度阴冷',
    '⚡ 语速急促激动、命悬一线',
    '😏 玩味嘲讽、游刃有余',
    '💔 决绝冷漠、彻底死心',
    '⚔️ 怒吼咆哮、爆发决战意志',
  ],
  general: [
    '✨ 增强画面构图与光影质感',
    '🎨 更加生动细腻与细节丰富',
    '🔥 强化戏剧冲突与氛围感',
  ],
};

/**
 * 全新 AI 定向润色交互组件 (纯动态对接系统真实 SKILL 规范)
 * 支持：用户提具体定制要求 + 选择真实系统 Skill + 快捷要求标签 + 实时生成对比预览 + 一键应用替换
 */
export const AiPolishButton: React.FC<AiPolishButtonProps> = ({
  value,
  onPolish,
  contextType = 'general',
  className = '',
  size = 'xs',
  label = 'AI 润色',
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedSkill, setSelectedSkill] = useState<string>('');
  const [originalText, setOriginalText] = useState<string>('');
  const [userInstruction, setUserInstruction] = useState<string>('');
  const [isPolishing, setIsPolishing] = useState<boolean>(false);
  const [polishedResult, setPolishedResult] = useState<string>('');
  const [suggestedEmotion, setSuggestedEmotion] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // 从后端系统接口拉取全部真实的 Skill 列表
  const loadSystemSkills = async () => {
    setLoadingSkills(true);
    try {
      const list = await apiService.listSkills();
      const all: SkillItem[] = Array.isArray(list) ? list : (list as any)?.skills || [];
      if (all && all.length > 0) {
        setSkills(all);
        if (!selectedSkill) {
          // 根据 contextType 挑选合适的初始技能
          const defaultMatch = contextType === 'dialogue'
            ? all.find(s => s.name.includes('dialogue') || s.name.includes('emotion'))
            : all.find(s => s.name.includes('prompt') || s.category === 'prompt_optimization');
          setSelectedSkill(defaultMatch ? defaultMatch.name : all[0].name);
        }
      }
    } catch (err) {
      console.error('Failed to load system skills:', err);
    } finally {
      setLoadingSkills(false);
    }
  };

  useEffect(() => {
    loadSystemSkills();
  }, []);

  // 当打开弹窗时，重置并同步当前值
  const handleOpenModal = () => {
    setOriginalText(value || '');
    setPolishedResult('');
    setSuggestedEmotion('');
    setErrorMsg(null);
    setCopied(false);
    loadSystemSkills();
    setModalOpen(true);
  };

  // 添加快捷要求标签
  const handleAddQuickTag = (tag: string) => {
    const cleanTag = tag.replace(/^[^\s]+\s*/, '');
    if (!userInstruction.trim()) {
      setUserInstruction(cleanTag);
    } else if (!userInstruction.includes(cleanTag)) {
      setUserInstruction(prev => `${prev}，${cleanTag}`);
    }
  };

  // 触发 AI 定向润色
  const handleExecutePolish = async () => {
    const textToPolish = originalText.trim() || value.trim();
    if (!textToPolish) {
      setErrorMsg('请先输入需要润色的内容');
      return;
    }

    setIsPolishing(true);
    setErrorMsg(null);

    try {
      const contextPayload: any = {
        original_prompt: textToPolish,
        prompt: textToPolish,
        text: textToPolish,
        user_instruction: userInstruction.trim(),
        user_requirement: userInstruction.trim(),
        context_type: contextType,
      };

      const res = await apiService.executeSkill(selectedSkill, contextPayload, userInstruction.trim() || textToPolish);

      let finalResult = res?.modified_data?.polished_prompt || res?.modified_data?.polished_text || res?.result_message || '';

      if (res?.modified_data?.suggested_emotion) {
        setSuggestedEmotion(res.modified_data.suggested_emotion);
      } else {
        setSuggestedEmotion('');
      }

      // 如果返回为空尝试解析
      if (!finalResult || finalResult === res?.result_message) {
        if (res?.modified_data?.polished_prompt) finalResult = res.modified_data.polished_prompt;
        else if (res?.modified_data?.polished_text) finalResult = res.modified_data.polished_text;
      }

      if (finalResult) {
        finalResult = finalResult.trim();
        // 清理 JSON 包裹
        if (finalResult.startsWith('{') && finalResult.includes('polished_text')) {
          try {
            const j = JSON.parse(finalResult);
            finalResult = j.polished_text || j.polished_prompt || finalResult;
            if (j.suggested_emotion) setSuggestedEmotion(j.suggested_emotion);
          } catch {}
        }
      }

      if (!finalResult) {
        throw new Error('未能生成润色结果，请重试');
      }

      setPolishedResult(finalResult);
    } catch (e: any) {
      setErrorMsg(e?.message || '润色请求失败，请检查网络或后端 LLM 配置');
    } finally {
      setIsPolishing(false);
    }
  };

  // 应用并替换
  const handleApply = () => {
    if (!polishedResult) return;
    const meta: any = {};
    if (suggestedEmotion) {
      meta.suggested_emotion = suggestedEmotion;
    }
    onPolish(polishedResult, meta);
    setModalOpen(false);
  };

  // 复制结果
  const handleCopy = () => {
    if (!polishedResult) return;
    navigator.clipboard.writeText(polishedResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const quickList = contextType === 'dialogue'
    ? QUICK_REQUIREMENTS.dialogue
    : QUICK_REQUIREMENTS.prompt;

  return (
    <>
      {/* 外部触发按钮 */}
      <button
        type="button"
        onClick={handleOpenModal}
        className={`inline-flex items-center gap-1.5 rounded-full border text-[11px] font-semibold transition-all shadow-sm
          ${size === 'xs' ? 'px-2.5 py-1' : 'px-3 py-1.5'}
          bg-surface-secondary border-border [color:var(--color-text-main)] hover:border-brand hover:text-brand-light hover:bg-brand/10 ${className}
        `}
        title="AI 定向润色：根据你的具体要求与技能风格智能重写"
      >
        <Sparkles className="w-3.5 h-3.5 text-brand" />
        <span>{label}</span>
      </button>

      {/* AI 定向润色全功能弹窗 */}
      {modalOpen && (
        <div className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
          <div className="w-full max-w-2xl bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-scale-up">
            
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-border bg-surface-secondary/60 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-xl bg-brand/20 border border-brand/40 text-brand-light">
                  <Wand2 className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-sm font-bold text-white flex items-center gap-2">
                    <span>✨ AI 智能定向润色</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/30 font-mono">
                      {contextType === 'dialogue' ? '戏剧台词模式' : '视觉提示词模式'}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-400">提出您的定制修改要求，AI 将结合所选技能生成高质量结果</div>
                </div>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="p-1.5 rounded-xl hover:bg-surface-tertiary text-gray-400 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
              
              {/* 1. 当前原文 */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-gray-300 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-violet-400" />
                    <span>原始{contextType === 'dialogue' ? '台词 / 旁白' : '描述 / 提示词'}</span>
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono">{originalText.length} 字</span>
                </label>
                <textarea
                  value={originalText}
                  onChange={(e) => setOriginalText(e.target.value)}
                  rows={2}
                  placeholder="输入或粘贴需要优化的原始内容..."
                  className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand font-mono resize-none leading-relaxed"
                />
              </div>

              {/* 2. 选择系统技能 Skill */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-gray-300 flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5 text-amber-400" />
                    <span>选择系统技能 (System Skill)</span>
                  </label>
                  <span className="text-[10px] text-gray-400">已加载 {skills.length} 个系统技能</span>
                </div>

                {/* 分类过滤器 */}
                <div className="flex items-center gap-1 overflow-x-auto pb-1">
                  {[
                    { id: 'all', label: '全部技能' },
                    { id: 'prompt_optimization', label: '提示词优化' },
                    { id: 'script_enhancement', label: '剧本台词' },
                    { id: 'character_design', label: '角色设定' },
                    { id: 'video_assembly', label: '剪映工程' },
                  ].map((tab) => {
                    const count = tab.id === 'all'
                      ? skills.length
                      : skills.filter(s => s.category === tab.id).length;
                    if (tab.id !== 'all' && count === 0) return null;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setSelectedCategory(tab.id)}
                        className={`px-2 py-0.5 rounded-lg text-[10px] font-medium whitespace-nowrap transition ${
                          selectedCategory === tab.id
                            ? 'bg-brand text-white font-bold'
                            : 'bg-surface-secondary text-gray-400 hover:text-gray-200 hover:bg-surface-tertiary'
                        }`}
                      >
                        {tab.label} ({count})
                      </button>
                    );
                  })}
                </div>
                
                {/* 技能列表 */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-36 overflow-y-auto p-0.5">
                  {skills
                    .filter(s => selectedCategory === 'all' || s.category === selectedCategory)
                    .map((s) => {
                      const isSelected = selectedSkill === s.name;
                      return (
                        <button
                          key={s.name}
                          type="button"
                          onClick={() => setSelectedSkill(s.name)}
                          className={`p-2 rounded-xl text-left border transition-all flex flex-col justify-between gap-1 ${
                            isSelected
                              ? 'bg-brand/20 border-brand text-white shadow-sm ring-1 ring-brand/40'
                              : 'bg-surface-secondary border-border/70 text-gray-300 hover:border-brand/40 hover:bg-surface-tertiary'
                          }`}
                        >
                          <div className="flex items-center justify-between w-full gap-1">
                            <span className={`text-[11px] font-bold truncate ${isSelected ? 'text-brand-light' : 'text-gray-200'}`}>
                              {s.name}
                            </span>
                            {isSelected && <Check className="w-3 h-3 text-brand-light shrink-0" />}
                          </div>
                          <span className="text-[9.5px] text-gray-400 line-clamp-1 leading-tight">
                            {s.description || s.name}
                          </span>
                        </button>
                      );
                    })}
                </div>

                {/* 选中技能的真实规范概要 */}
                {selectedSkill && (() => {
                  const curr = skills.find(s => s.name === selectedSkill);
                  if (!curr) return null;
                  return (
                    <div className="p-2 rounded-xl bg-surface-secondary/70 border border-border text-[10px] text-gray-300 flex items-start gap-2">
                      <div className="p-1 rounded-lg bg-brand/10 text-brand-light shrink-0 mt-0.5">
                        <FileCode className="w-3 h-3" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{curr.name}</span>
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-surface-tertiary text-gray-400 font-mono">
                            {curr.category}
                          </span>
                          {curr.tools && curr.tools.length > 0 && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-violet-500/20 text-violet-300 font-mono">
                              Tools: {curr.tools.join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="text-gray-400 mt-0.5 leading-relaxed line-clamp-2">
                          {curr.description}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* 3. 用户的具体定制要求 (核心交互) */}
              <div className="p-3.5 rounded-2xl bg-brand/5 border border-brand/20 space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-brand-light flex items-center gap-1.5">
                    <MessageSquareQuote className="w-4 h-4 text-brand" />
                    <span>你的具体定制要求 (支持自然语言提出任何修改)</span>
                  </label>
                  <span className="text-[10px] text-gray-400">AI 将严格按此要求重构</span>
                </div>

                <textarea
                  value={userInstruction}
                  onChange={(e) => setUserInstruction(e.target.value)}
                  rows={2}
                  placeholder="💡 例如：改成暴雨夜景、人物眼神更有杀气、手持燃烧的青色长剑、镜头极速推向面部特写、增加电影逆光宽画幅..."
                  className="w-full bg-surface border border-brand/30 rounded-xl p-2.5 text-xs text-white placeholder-gray-400 focus:outline-none focus:border-brand leading-relaxed resize-none"
                />

                {/* 快捷标签 */}
                <div className="space-y-1">
                  <div className="text-[10px] text-gray-400 font-medium">⚡ 快捷要求灵感词（点击即追加）：</div>
                  <div className="flex flex-wrap gap-1.5">
                    {quickList.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleAddQuickTag(tag)}
                        className="px-2 py-0.5 rounded-lg bg-surface border border-border hover:border-brand/50 hover:bg-brand/10 text-[10px] text-gray-300 hover:text-brand-light transition"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 4. 润色结果呈现区 */}
              {polishedResult && (
                <div className="p-3.5 rounded-2xl bg-emerald-500/5 border border-emerald-500/20 space-y-2 animate-fade-in">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-emerald-300 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                      <span>✨ AI 定向润色产物</span>
                    </span>
                    <div className="flex items-center gap-2">
                      {suggestedEmotion && (
                        <span className="px-2 py-0.5 rounded-md bg-pink-500/20 text-pink-300 border border-pink-500/30 text-[10px] font-semibold">
                          🎭 建议情绪: {suggestedEmotion}
                        </span>
                      )}
                      <span className="text-[10px] text-emerald-400 font-mono font-bold">
                        {polishedResult.length} 字
                      </span>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-xl bg-surface border border-emerald-500/20 font-mono text-xs text-white leading-relaxed select-text whitespace-pre-wrap max-h-36 overflow-y-auto">
                    {polishedResult}
                  </div>
                </div>
              )}

              {/* 错误提示 */}
              {errorMsg && (
                <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-center gap-2">
                  <X className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{errorMsg}</span>
                </div>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="px-5 py-3 border-t border-border bg-surface-secondary/40 flex items-center justify-between shrink-0">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-3.5 py-1.5 rounded-xl border border-border text-xs text-gray-300 hover:bg-surface-tertiary hover:text-white transition"
              >
                取消
              </button>

              <div className="flex items-center gap-2">
                {polishedResult ? (
                  <>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="px-3 py-1.5 rounded-xl border border-border bg-surface hover:bg-surface-tertiary text-xs font-semibold text-gray-200 flex items-center gap-1 transition"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? '已复制' : '复制结果'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExecutePolish}
                      disabled={isPolishing}
                      className="px-3 py-1.5 rounded-xl border border-border bg-surface hover:bg-surface-tertiary text-xs font-semibold text-gray-200 flex items-center gap-1 transition disabled:opacity-40"
                    >
                      <RotateCcw className={`w-3.5 h-3.5 ${isPolishing ? 'animate-spin' : ''}`} />
                      <span>重新润色</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleApply}
                      className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-brand to-emerald-600 hover:opacity-90 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-brand/20 transition"
                    >
                      <Check className="w-4 h-4" />
                      <span>✅ 应用并替换当前内容</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleExecutePolish}
                    disabled={isPolishing || (!originalText.trim() && !value.trim())}
                    className="px-5 py-2 rounded-xl bg-gradient-to-r from-brand to-violet-600 hover:opacity-95 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-brand/20 transition disabled:opacity-40"
                  >
                    {isPolishing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>AI 定向思考与润色中...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>🚀 开始按照我的要求润色</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AiPolishButton;

