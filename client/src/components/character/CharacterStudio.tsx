import React, { useState } from 'react';
import { 
  Users, 
  Sparkles, 
  ShieldCheck, 
  Image as ImageIcon,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { apiService } from '../../services/api';

export const CharacterStudio: React.FC = () => {
  const { project, updateCharacter } = useProjectStore();

  const characters = project?.characters || [];
  const [selectedCharId, setSelectedCharId] = useState<string>(characters[0]?.id || '');
  const [isGeneratingSheet, setIsGeneratingSheet] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const selectedChar = characters.find((c) => c.id === selectedCharId) || characters[0];

  if (!selectedChar) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        暂无角色资产，请先导入小说拆解
      </div>
    );
  }

  const API_ORIGIN = 'http://127.0.0.1:8000';
  const resolveUrl = (u?: string) => u && u.startsWith('/') ? API_ORIGIN + u : u;

  const handleGenerate3Views = async () => {
    if (!selectedChar.visual_prompt?.trim()) { setRegenError('视觉提示词为空'); return; }
    setRegenError(null);
    setIsGeneratingSheet(true);
    try {
      const res = await apiService.generateCharacter3Views({
        name: selectedChar.name,
        visual_prompt: selectedChar.visual_prompt,
        description: selectedChar.description,
        style_preset: project?.style_preset || 'donghua_xianxia',
      });
      const views = res.three_views || {};
      if (views.front || views.side || views.three_quarter) {
        updateCharacter(selectedChar.id, { three_views: { ...selectedChar.three_views, ...views } });
      }
      if (res.errors && Object.keys(res.errors).length) {
        const msg = Object.values(res.errors).join('; ');
        if (!views.front) setRegenError(msg);
      }
    } catch (e: any) {
      setRegenError(e?.message || '三视图生成失败');
    } finally {
      setIsGeneratingSheet(false);
    }
  };

  return (
    <div className="flex-1 flex h-[calc(100vh-3.5rem)] bg-background overflow-hidden">
      {/* 1. Left Character List */}
      <div className="w-72 bg-surface border-r border-border flex flex-col">
        <div className="p-3.5 border-b border-border flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Users className="w-4 h-4 text-accent-pink" />
            <span className="text-sm font-semibold text-white">角色资产库 ({characters.length})</span>
          </div>
          <span className="text-[10px] bg-accent-pink/20 text-accent-pink px-2 py-0.5 rounded border border-accent-pink/30">
            IP-Adapter 锁定
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
          {characters.map((char) => {
            const isSelected = char.id === selectedChar.id;
            return (
              <div
                key={char.id}
                onClick={() => setSelectedCharId(char.id)}
                className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center space-x-3 ${
                  isSelected
                    ? 'bg-surface-tertiary border-accent-pink shadow-md glow-border'
                    : 'bg-surface-secondary/70 border-border hover:border-border-active'
                }`}
              >
                <div className="w-12 h-12 rounded-xl overflow-hidden bg-black/60 flex-shrink-0 border border-border">
                  {char.avatar_url ? (
                    <img src={resolveUrl(char.avatar_url)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-500 font-bold">
                      {char.name[0]}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-1.5">
                    <span className="text-xs font-bold text-white truncate">{char.name}</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-brand/20 text-brand-light">
                      {char.role === 'protagonist' ? '主角' : char.role === 'supporting' ? '配角' : '旁白'}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-400 truncate mt-0.5">{char.voice_name}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Right Character Details & 3-Views Consistency Panel */}
      <div className="flex-1 p-6 overflow-y-auto custom-scrollbar flex flex-col space-y-6">
        {/* Header Banner */}
        <div className="flex items-center justify-between bg-surface p-5 rounded-2xl border border-border shadow-sm">
          <div className="flex items-center space-x-4">
            <div className="w-16 h-16 rounded-2xl overflow-hidden border border-border shadow-md bg-black/40">
              {selectedChar.avatar_url ? (
                <img src={resolveUrl(selectedChar.avatar_url)} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xl font-bold text-white/60">{selectedChar.name[0]}</div>
              )}
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-lg font-bold text-white">{selectedChar.name}</h2>
                <span className="flex items-center space-x-1 text-[10px] px-2 py-0.5 rounded-full bg-accent-green/20 text-accent-green border border-accent-green/40">
                  <ShieldCheck className="w-3 h-3" />
                  <span>面部特征与三视图已锚定</span>
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1 max-w-xl">{selectedChar.description}</p>
            </div>
          </div>

          <button
            onClick={handleGenerate3Views}
            disabled={isGeneratingSheet}
            className="flex items-center space-x-2 px-4 py-2 rounded-xl bg-gradient-to-r from-accent-pink to-brand text-white text-xs font-semibold shadow-md hover:opacity-90 transition-all disabled:opacity-40"
          >
            <Sparkles className={`w-4 h-4 ${isGeneratingSheet ? 'animate-spin' : ''}`} />
            <span>{isGeneratingSheet ? 'ComfyUI 生成中...' : '生成标准三视图 (ComfyUI 真实)'}</span>
          </button>
        </div>

        {regenError && <div className="px-3 py-1.5 rounded bg-red-500/15 border border-red-500/30 text-xs text-red-300">⚠️ {regenError}</div>}

        {/* 3-Views Consistency Matrix (三视图一致性展示) */}
        <div>
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center space-x-2">
            <ImageIcon className="w-4 h-4 text-brand-light" />
            <span>角色全生命周期三视图 (Three-View Consistency Sheet)</span>
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Front View */}
            <div className="bg-surface p-3.5 rounded-2xl border border-border flex flex-col">
              <div className="aspect-[3/4] rounded-xl overflow-hidden bg-black/60 mb-2 border border-border flex items-center justify-center">
                { (resolveUrl(selectedChar.three_views?.front) || resolveUrl(selectedChar.avatar_url)) ? (
                  <img src={resolveUrl(selectedChar.three_views?.front) || resolveUrl(selectedChar.avatar_url)} alt="Front View" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[10px] text-gray-500">待生成</span>
                )}
              </div>
              <span className="text-xs font-bold text-white">正面视图 (Front 0°)</span>
              <span className="text-[10px] text-gray-400 mt-0.5">用于面部对齐与主视觉特征锁定</span>
            </div>

            {/* Side Profile View */}
            <div className="bg-surface p-3.5 rounded-2xl border border-border flex flex-col">
              <div className="aspect-[3/4] rounded-xl overflow-hidden bg-black/60 mb-2 border border-border flex items-center justify-center">
                { (resolveUrl(selectedChar.three_views?.side) || resolveUrl(selectedChar.avatar_url)) ? (
                  <img src={resolveUrl(selectedChar.three_views?.side) || resolveUrl(selectedChar.avatar_url)} alt="Side View" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[10px] text-gray-500">待生成</span>
                )}
              </div>
              <span className="text-xs font-bold text-white">侧面轮廓 (Side 90°)</span>
              <span className="text-[10px] text-gray-400 mt-0.5">用于侧脸特写与运镜视差过渡</span>
            </div>

            {/* 3/4 Dynamic Angle View */}
            <div className="bg-surface p-3.5 rounded-2xl border border-border flex flex-col">
              <div className="aspect-[3/4] rounded-xl overflow-hidden bg-black/60 mb-2 border border-border flex items-center justify-center">
                { (resolveUrl(selectedChar.three_views?.three_quarter) || resolveUrl(selectedChar.avatar_url)) ? (
                  <img src={resolveUrl(selectedChar.three_views?.three_quarter) || resolveUrl(selectedChar.avatar_url)} alt="3/4 View" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[10px] text-gray-500">待生成</span>
                )}
              </div>
              <span className="text-xs font-bold text-white">3/4 动态视角 (Dynamic 45°)</span>
              <span className="text-[10px] text-gray-400 mt-0.5">用于战斗运镜与戏剧化分镜生成</span>
            </div>
          </div>
        </div>

        {/* Character Prompts & Voice Configuration */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-surface p-4 rounded-2xl border border-border space-y-2">
            <label className="text-xs font-semibold text-white block">
              ✨ 视觉一致性提示词 (Visual Prompt)
            </label>
            <textarea
              value={selectedChar.visual_prompt}
              onChange={(e) => updateCharacter(selectedChar.id, { visual_prompt: e.target.value })}
              rows={3}
              className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-gray-300 focus:outline-none focus:border-brand"
            />
          </div>

          <div className="bg-surface p-4 rounded-2xl border border-border space-y-2">
            <label className="text-xs font-semibold text-white block flex items-center justify-between">
              <span>🎙️ MiniMax 专属角色音色</span>
              <span className="text-[10px] text-accent-pink">Speech-01</span>
            </label>
            <select
              value={selectedChar.voice_id}
              onChange={(e) => updateCharacter(selectedChar.id, { voice_id: e.target.value })}
              className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white focus:outline-none"
            >
              <option value="male-qn-qingse">热血少年 (叶凡推荐) - 青涩坚毅</option>
              <option value="female-shaonv">灵动少女 (姬紫月推荐) - 清脆甜美</option>
              <option value="male-badao">霸道魔尊 (庞博/反派推荐) - 狂傲霸气</option>
              <option value="female-yujie">冷艳御姐 - 清冷高贵</option>
              <option value="male-pangbai">史诗宏大旁白 - 沧桑低沉</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
