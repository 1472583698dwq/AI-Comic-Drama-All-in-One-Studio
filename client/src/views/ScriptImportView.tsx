import React, { useState } from 'react';
import { 
  Sparkles, 
  BookOpen, 
  Layers, 
  X, 
  Zap, 
  Palette, 
  Smartphone, 
  Monitor, 
  Check, 
  FileText
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { StylePreset, AspectRatio } from '../types';
import { useEscapeClose } from '../hooks/useEscapeClose';

interface ScriptImportViewProps {
  isOpen: boolean;
  onClose: () => void;
}

const TEMPLATES = [
  {
    title: '东方玄幻 · 遮天九龙拉棺',
    text: `九龙拉棺，划破星空，降临在泰山之巅。
叶凡仰望苍穹，只觉得一股苍茫古老的气息扑面而来。
“天啊！那是什么？！”人群中爆发出一阵阵惊恐的尖叫。
“大家快往山下退！”叶凡大声呼喊。
突然，青铜古棺发出轰然巨响，一道神秘的八卦符文在虚空中缓缓展开……
叶凡凝视着古棺内部，沉声道：“这一世，我命由我不由天！”`,
  },
  {
    title: '现代异能 · 觉醒之日',
    text: `黑夜笼罩了整座都市，暴雨如注。
少年站在天台边缘，双瞳中突然亮起刺目的湛蓝色雷光。
“三年了，你们夺走的一切，今夜我都要亲手拿回来！”
虚空中空间扭曲，黑衣杀手冷笑着现身：“区区F级觉醒者，也敢口出狂言？”
轰——！雷霆撕裂黑夜，少年的身影如鬼魅般瞬间欺近！`,
  },
  {
    title: '古风修真 · 剑破苍穹',
    text: `万剑宗后山，白衣少年手握断剑，静静立于悬崖前。
风吹过他的衣袂，眼中满是孤绝。
“师傅，弟子今日便以此残剑，问鼎天下第一剑道！”
一道凌厉的剑气冲天而起，直接将天边的重重乌云斩为两半！`,
  },
];

const STYLE_OPTIONS: { id: StylePreset; label: string; desc: string }[] = [
  { id: 'donghua_xianxia', label: '🐉 国漫玄幻修仙', desc: '唯美国风，仙气缭绕与光影粒子' },
  { id: 'japanese_anime', label: '🌸 日系新海诚风', desc: '高饱和度、唯美镜头光晕与清新色调' },
  { id: 'modern_webtoon', label: '🏙️ 韩漫 Webtoon', desc: '强对比度、现代条漫质感与锐利线条' },
  { id: 'cinematic_3d', label: '🎮 3D 虚幻引擎5', desc: '次世代 CGI 电影质感与高精建模' },
  { id: 'dark_comic', label: '🦇 暗黑美漫画风', desc: '高反差黑白阴影、硬核图画小说' },
  { id: 'pure_white_aesthetic', label: '🤍 极简纯白美学', desc: '高调纯白光影、极简精致治愈系柔光线条' },
];

export const ScriptImportView: React.FC<ScriptImportViewProps> = ({ isOpen, onClose }) => {
  const { importNovelScript, isLoading, loadingMessage, apiError, activeProjectId } = useProjectStore();
  const [saveToProject, setSaveToProject] = useState(true);

  const [novelText, setNovelText] = useState(TEMPLATES[0].text);
  const [stylePreset, setStylePreset] = useState<StylePreset>('donghua_xianxia');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [localError, setLocalError] = useState<string | null>(null);

  useEscapeClose(isOpen, onClose);
  if (!isOpen) return null;

  const handleStartBreakdown = async () => {
    if (!novelText.trim()) {
      setLocalError('请输入小说文本内容');
      return;
    }
    setLocalError(null);
    try {
      await importNovelScript(novelText, stylePreset, aspectRatio);
      // P0: 自动保存到当前项目
      if (saveToProject && activeProjectId) {
        const proj = useProjectStore.getState().project;
        // 拆解结果自带一个新 UUID 作 id：改回当前项目 id 再 setProject（其内自动保存到该项目），
        // 否则 activeProjectId 会被切到那个不存在的 UUID 上
        if (proj) useProjectStore.getState().setProject({ ...proj, id: activeProjectId });
      }
      onClose();
    } catch (e: any) {
      setLocalError(e?.message || '拆解失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-3xl bg-white/60 dark:bg-white/[.05] rounded-2xl border border-white/70 dark:border-white/12 flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-white/70 dark:border-white/12 flex items-center justify-between bg-white/55 dark:bg-white/[.05]">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-r from-brand to-accent-orange text-white shadow-sm">
              <BookOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">长篇小说一键转漫剧 (小云雀 Agent 驱动)</h2>
              <p className="text-[11px] text-gray-400">
                支持上传/粘贴整章网文小说，AI 自动提炼世界观、人物性格与分镜序列
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/65 dark:bg-white/[.09]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[75vh] custom-scrollbar">
          {/* Quick Template Selector */}
          <div>
            <label className="text-xs font-semibold text-gray-300 mb-2 block flex items-center justify-between">
              <span>📚 快速载入网文范例文本</span>
              <span className="text-[10px] text-gray-500">点击即用</span>
            </label>
            <div className="flex space-x-2 overflow-x-auto pb-1 custom-scrollbar">
              {TEMPLATES.map((t) => (
                <button
                  key={t.title}
                  onClick={() => setNovelText(t.text)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium border whitespace-nowrap transition-all ${
                    novelText === t.text
                      ? 'bg-brand/20 border-brand text-brand-light shadow-sm'
                      : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 text-gray-400 hover:border-white/80 dark:border-white/20'
                  }`}
                >
                  {t.title}
                </button>
              ))}
            </div>
          </div>

          {/* Text Area */}
          <div>
            <label className="text-xs font-semibold text-gray-300 mb-1.5 block">
              📖 小说/剧本原文内容 (支持长文本直接粘贴)
            </label>
            <textarea
              value={novelText}
              onChange={(e) => setNovelText(e.target.value)}
              rows={6}
              placeholder="在此粘贴您的小说章节或剧本文本..."
              className="w-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl p-3.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand custom-scrollbar leading-relaxed"
            />
          </div>

          {/* Visual Style Preset */}
          <div>
            <label className="text-xs font-semibold text-gray-300 mb-2 block flex items-center space-x-1.5">
              <Palette className="w-3.5 h-3.5 text-brand-light" />
              <span>🎨 漫剧视觉画风设定</span>
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
              {STYLE_OPTIONS.map((st) => (
                <div
                  key={st.id}
                  onClick={() => setStylePreset(st.id)}
                  className={`p-3 rounded-xl border cursor-pointer transition-all ${
                    stylePreset === st.id
                      ? 'bg-brand/20 border-brand shadow-sm glow-border'
                      : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 hover:border-white/80 dark:border-white/20'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-white">{st.label}</span>
                    {stylePreset === st.id && <Check className="w-3.5 h-3.5 text-brand-light" />}
                  </div>
                  <p className="text-[10px] text-gray-400 line-clamp-1">{st.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Aspect Ratio Switcher */}
          <div>
            <label className="text-xs font-semibold text-gray-300 mb-2 block">
              📐 画面比例与画幅
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setAspectRatio('9:16')}
                className={`p-3 rounded-xl border flex items-center space-x-3 transition-all ${
                  aspectRatio === '9:16'
                    ? 'bg-brand/20 border-brand text-white'
                    : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 text-gray-400 hover:border-white/80 dark:border-white/20'
                }`}
              >
                <Smartphone className="w-5 h-5 text-brand-light" />
                <div className="text-left">
                  <div className="text-xs font-bold">9:16 竖屏短剧 (App/短视频首选)</div>
                  <div className="text-[10px] text-gray-400">适合抖音、快手、小红书、TikTok</div>
                </div>
              </button>

              <button
                onClick={() => setAspectRatio('16:9')}
                className={`p-3 rounded-xl border flex items-center space-x-3 transition-all ${
                  aspectRatio === '16:9'
                    ? 'bg-brand/20 border-brand text-white'
                    : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 text-gray-400 hover:border-white/80 dark:border-white/20'
                }`}
              >
                <Monitor className="w-5 h-5 text-accent-orange" />
                <div className="text-left">
                  <div className="text-xs font-bold">16:9 横屏影视 (B站/YouTube 首选)</div>
                  <div className="text-[10px] text-gray-400">适合大屏播放与连载动画</div>
                </div>
              </button>
            </div>
          </div>
        </div>

        {/* Footer Action */}
        <div className="h-16 px-6 border-t border-white/70 dark:border-white/12 bg-white/50 dark:bg-white/[.04] flex items-center justify-between">
          <div className="flex flex-col space-y-1">
            <span className="text-[11px] text-gray-400 flex items-center gap-2">
              {isLoading ? loadingMessage : '⚡ 调用 AI 大模型拆解角色/分镜/配音'}
              {activeProjectId && <label className="flex items-center gap-1 text-[10px] text-gray-300 cursor-pointer"><input type="checkbox" checked={saveToProject} onChange={e=>setSaveToProject(e.target.checked)} /> 保存到当前项目</label>}
              {!activeProjectId && <span className="text-[10px] text-amber-300">未选择项目，将仅本地预览（请先在项目看板创建/打开项目）</span>}
            </span>
            {(localError || apiError) && (
              <span className="text-[11px] text-red-400">⚠️ {localError || apiError}</span>
            )}
          </div>

          <button
            onClick={handleStartBreakdown}
            disabled={isLoading}
            className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue hover:opacity-90 text-white font-bold text-xs shadow-lg shadow-brand/25 flex items-center space-x-2 transition-all disabled:opacity-40"
          >
            <Zap className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            <span>{isLoading ? 'Agent 深度解析中...' : '一键开始剧本拆解'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
