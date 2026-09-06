import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Sparkles, 
  ShieldCheck, 
  Image as ImageIcon,
  Plus,
  Trash2,
  FolderOpen,
  Check,
  Wand2,
  Layers,
  Upload
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { Character } from '../../types';
import { apiService } from '../../services/api';
import { AiPolishButton } from '../ui/AiPolishButton';
import { AssetPickerModal } from '../asset/AssetPickerModal';

export const CharacterStudio: React.FC = () => {
  const { project, updateCharacter, addCharacter, deleteCharacter } = useProjectStore();

  const characters = project?.characters || [];
  const [selectedCharId, setSelectedCharId] = useState<string>(characters[0]?.id || '');
  const [isGeneratingSheet, setIsGeneratingSheet] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [assetPickerViewKey, setAssetPickerViewKey] = useState<'front' | 'side' | 'three_quarter' | 'avatar' | null>(null);
  // 音色列表 = 语音源接口（/tts/voices），不写死 minimax 预设
  const [voiceOptions, setVoiceOptions] = useState<Array<{id: string; name: string}>>([]);
  useEffect(() => {
    apiService.listTtsVoices().then((r: any) => {
      setVoiceOptions((r?.voices || []).map((v: any) => ({ id: v.id || v.voice_id, name: v.name || v.voice_name || v.id })));
    }).catch(() => {});
  }, []);

  // Auto select first char if active becomes invalid
  useEffect(() => {
    if (characters.length > 0 && !characters.some(c => c.id === selectedCharId)) {
      setSelectedCharId(characters[0].id);
    }
  }, [characters, selectedCharId]);

  const selectedChar = characters.find((c) => c.id === selectedCharId) || characters[0];

  const API_ORIGIN = 'http://127.0.0.1:8000';
  const resolveUrl = (u?: string) => {
    if (!u) return '';
    return u.startsWith('/') ? API_ORIGIN + u : u;
  };

  const handleCreateNewCharacter = () => {
    const newId = 'char_' + Date.now().toString(36);
    const newChar: Character = {
      id: newId,
      name: `新角色 ${characters.length + 1}`,
      role: 'supporting',
      gender: 'other',
      age_group: 'youth',
      emotion_preset: 'neutral',
      voice_id: '',
      voice_name: '',
      description: '角色性格与外貌特征描述...',
      visual_prompt: 'masterpiece, best quality, 1boy, handsome anime character...',
      three_views: {},
    };
    addCharacter(newChar);
    setSelectedCharId(newId);
  };

  const handleDeleteCurrentChar = () => {
    if (!selectedChar) return;
    if (characters.length <= 1) {
      alert('项目中至少保留一个角色');
      return;
    }
    if (confirm(`确认删除角色 "${selectedChar.name}" 吗？`)) {
      deleteCharacter(selectedChar.id);
    }
  };

  const handleSelectAssetForView = (asset: { url: string; visual_prompt?: string; name: string }) => {
    if (!selectedChar || !assetPickerViewKey) return;
    if (assetPickerViewKey === 'avatar') {
      updateCharacter(selectedChar.id, { avatar_url: asset.url });
    } else {
      updateCharacter(selectedChar.id, {
        three_views: {
          ...selectedChar.three_views,
          [assetPickerViewKey]: asset.url
        },
        avatar_url: selectedChar.avatar_url || asset.url,
        ...(asset.visual_prompt && !selectedChar.visual_prompt ? { visual_prompt: asset.visual_prompt } : {})
      });
    }
    setAssetPickerViewKey(null);
  };

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
        updateCharacter(selectedChar.id, { 
          three_views: { ...selectedChar.three_views, ...views },
          avatar_url: selectedChar.avatar_url || views.front || views.three_quarter
        });
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
      <div className="w-72 bg-surface border-r border-border flex flex-col shrink-0">
        <div className="p-3.5 border-b border-border flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Users className="w-4 h-4 text-accent-pink" />
            <span className="text-sm font-semibold text-white">角色资产库 ({characters.length})</span>
          </div>
          <button
            onClick={handleCreateNewCharacter}
            className="p-1.5 rounded-lg bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light text-xs flex items-center gap-1 font-bold transition-all"
            title="新建角色"
          >
            <Plus className="w-3.5 h-3.5" /> <span>新建</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
          {characters.map((char) => {
            const isSelected = char.id === selectedChar?.id;
            const avatar = char.three_views?.front || char.avatar_url || char.three_views?.three_quarter;
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
                  {avatar ? (
                    <img src={resolveUrl(avatar)} alt="" className="w-full h-full object-cover" />
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
                  <p className="text-[10px] text-gray-400 truncate mt-0.5">{char.voice_name || '默认音色'}</p>
                </div>
              </div>
            );
          })}

          {characters.length === 0 && (
            <div className="text-center py-8 text-xs text-gray-500 space-y-2">
              <p>暂无角色</p>
              <button onClick={handleCreateNewCharacter} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-bold">立即创建新角色</button>
            </div>
          )}
        </div>
      </div>

      {/* 2. Right Character Details & 3-Views Consistency Panel */}
      {selectedChar ? (
        <div className="flex-1 p-6 overflow-y-auto custom-scrollbar flex flex-col space-y-6">
          {/* Header Banner */}
          <div className="flex items-center justify-between bg-surface p-5 rounded-2xl border border-border shadow-sm">
            <div className="flex items-center space-x-4">
              <div 
                onClick={() => setAssetPickerViewKey('avatar')}
                className="relative w-16 h-16 rounded-2xl overflow-hidden border border-border shadow-md bg-black/40 group cursor-pointer"
                title="点击从素材库更换角色头像"
              >
                {selectedChar.avatar_url || selectedChar.three_views?.front ? (
                  <img src={resolveUrl(selectedChar.avatar_url || selectedChar.three_views?.front)} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xl font-bold text-white/60">{selectedChar.name[0]}</div>
                )}
                <div className="absolute inset-0 bg-black/60 text-white text-[10px] flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <FolderOpen className="w-3.5 h-3.5 mb-0.5 text-brand-light" />
                  <span>素材库选图</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={selectedChar.name}
                    onChange={e => updateCharacter(selectedChar.id, { name: e.target.value })}
                    className="text-lg font-bold text-white bg-transparent border-b border-transparent hover:border-border focus:border-brand px-1 py-0.5 rounded focus:outline-none"
                  />
                  <select
                    value={selectedChar.role || 'protagonist'}
                    onChange={e => updateCharacter(selectedChar.id, { role: e.target.value as any })}
                    className="text-xs bg-surface-secondary border border-border rounded-lg px-2 py-1 text-gray-300"
                  >
                    <option value="protagonist">主角</option>
                    <option value="supporting">配角</option>
                    <option value="antagonist">反派</option>
                    <option value="narrator">旁白</option>
                  </select>
                </div>
                <input
                  type="text"
                  value={selectedChar.description || ''}
                  onChange={e => updateCharacter(selectedChar.id, { description: e.target.value })}
                  placeholder="角色人设简述（如：天生废柴逆袭修仙的少年剑修）..."
                  className="text-xs text-gray-400 bg-transparent border-b border-transparent hover:border-border focus:border-brand w-full max-w-xl px-1 py-0.5 rounded focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleGenerate3Views}
                disabled={isGeneratingSheet}
                className="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-accent-pink to-brand text-white text-xs font-bold shadow-md hover:opacity-90 transition-all disabled:opacity-40"
              >
                <Sparkles className={`w-4 h-4 ${isGeneratingSheet ? 'animate-spin' : ''}`} />
                <span>{isGeneratingSheet ? 'ComfyUI 生成中...' : 'ComfyUI 智能生三视图'}</span>
              </button>
              <button
                onClick={handleDeleteCurrentChar}
                className="p-2.5 rounded-xl bg-surface-secondary border border-border text-gray-400 hover:text-red-400 hover:border-red-500/30 transition-all"
                title="删除角色"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {regenError && <div className="px-3.5 py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-300">⚠️ {regenError}</div>}

          {/* 3-Views Consistency Matrix (三视图素材库中心) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2">
                <ImageIcon className="w-4 h-4 text-brand-light" />
                <span>角色标准三视图与参考图绑定 (Three-View Consistency Matrix)</span>
              </h3>
              <span className="text-xs text-brand-light font-medium">✨ 从统一素材库一键选用 / 归档</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* 1. Front View (正面视图) */}
              <div className="bg-surface p-4 rounded-2xl border border-border flex flex-col group relative">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-brand" /> 正面视图 (Front 0°)
                  </span>
                  {selectedChar.three_views?.front && <span className="text-[10px] text-emerald-400 font-bold">已绑定</span>}
                </div>

                <div 
                  onClick={() => setAssetPickerViewKey('front')}
                  className="aspect-[3/4] rounded-xl overflow-hidden bg-black/60 mb-3 border border-border flex items-center justify-center relative cursor-pointer hover:border-brand transition-all group"
                  title="点击从素材库选择或上传正面参考图"
                >
                  {selectedChar.three_views?.front ? (
                    <img src={resolveUrl(selectedChar.three_views.front)} alt="Front View" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                  ) : (
                    <div className="flex flex-col items-center justify-center text-gray-500 text-xs space-y-2 p-4 text-center">
                      <FolderOpen className="w-8 h-8 text-brand-light/60" />
                      <span className="text-gray-300 font-medium">点击从素材库选择正面图</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-brand/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="px-3 py-1.5 rounded-full bg-brand text-white text-xs font-bold shadow-lg flex items-center gap-1">
                      <FolderOpen className="w-3.5 h-3.5" /> 从素材库更换
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-1 border-t border-border">
                  <button
                    onClick={() => setAssetPickerViewKey('front')}
                    className="flex-1 py-2 rounded-xl bg-brand/15 hover:bg-brand/25 border border-brand/30 text-brand-light text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-brand" />
                    <span>从素材库导入</span>
                  </button>
                  {selectedChar.three_views?.front && (
                    <button
                      onClick={() => updateCharacter(selectedChar.id, { three_views: { ...selectedChar.three_views, front: '' } })}
                      className="p-2 rounded-xl bg-surface-secondary hover:bg-red-500/20 text-gray-400 hover:text-red-400 border border-border"
                      title="清除此视角"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <span className="text-[10px] text-gray-400 mt-1.5">分镜生图时作为主面部特征与发型锁定输入</span>
              </div>

              {/* 2. Side Profile View (侧面轮廓) */}
              <div className="bg-surface p-4 rounded-2xl border border-border flex flex-col group relative">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-accent-orange" /> 侧面轮廓 (Side 90°)
                  </span>
                  {selectedChar.three_views?.side && <span className="text-[10px] text-emerald-400 font-bold">已绑定</span>}
                </div>

                <div 
                  onClick={() => setAssetPickerViewKey('side')}
                  className="aspect-[3/4] rounded-xl overflow-hidden bg-black/60 mb-3 border border-border flex items-center justify-center relative cursor-pointer hover:border-accent-orange transition-all group"
                  title="点击从素材库选择或上传侧面参考图"
                >
                  {selectedChar.three_views?.side ? (
                    <img src={resolveUrl(selectedChar.three_views.side)} alt="Side View" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                  ) : (
                    <div className="flex flex-col items-center justify-center text-gray-500 text-xs space-y-2 p-4 text-center">
                      <FolderOpen className="w-8 h-8 text-accent-orange/60" />
                      <span className="text-gray-300 font-medium">点击从素材库选择侧面图</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-accent-orange/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="px-3 py-1.5 rounded-full bg-accent-orange text-white text-xs font-bold shadow-lg flex items-center gap-1">
                      <FolderOpen className="w-3.5 h-3.5" /> 从素材库更换
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-1 border-t border-border">
                  <button
                    onClick={() => setAssetPickerViewKey('side')}
                    className="flex-1 py-2 rounded-xl bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-orange-400" />
                    <span>从素材库导入</span>
                  </button>
                  {selectedChar.three_views?.side && (
                    <button
                      onClick={() => updateCharacter(selectedChar.id, { three_views: { ...selectedChar.three_views, side: '' } })}
                      className="p-2 rounded-xl bg-surface-secondary hover:bg-red-500/20 text-gray-400 hover:text-red-400 border border-border"
                      title="清除此视角"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <span className="text-[10px] text-gray-400 mt-1.5">用于侧脸特写、转头动作与运镜视差过渡</span>
              </div>

              {/* 3. 3/4 Dynamic Angle View (3/4 动态视角) */}
              <div className="bg-surface p-4 rounded-2xl border border-border flex flex-col group relative">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-accent-pink" /> 3/4 视角 (Dynamic 45°)
                  </span>
                  {selectedChar.three_views?.three_quarter && <span className="text-[10px] text-emerald-400 font-bold">已绑定</span>}
                </div>

                <div 
                  onClick={() => setAssetPickerViewKey('three_quarter')}
                  className="aspect-[3/4] rounded-xl overflow-hidden bg-black/60 mb-3 border border-border flex items-center justify-center relative cursor-pointer hover:border-accent-pink transition-all group"
                  title="点击从素材库选择或上传 3/4 视角参考图"
                >
                  {selectedChar.three_views?.three_quarter ? (
                    <img src={resolveUrl(selectedChar.three_views.three_quarter)} alt="3/4 View" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                  ) : (
                    <div className="flex flex-col items-center justify-center text-gray-500 text-xs space-y-2 p-4 text-center">
                      <FolderOpen className="w-8 h-8 text-accent-pink/60" />
                      <span className="text-gray-300 font-medium">点击从素材库选择 3/4 图</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-accent-pink/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="px-3 py-1.5 rounded-full bg-accent-pink text-white text-xs font-bold shadow-lg flex items-center gap-1">
                      <FolderOpen className="w-3.5 h-3.5" /> 从素材库更换
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-1 border-t border-border">
                  <button
                    onClick={() => setAssetPickerViewKey('three_quarter')}
                    className="flex-1 py-2 rounded-xl bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 text-pink-300 text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-pink-400" />
                    <span>从素材库导入</span>
                  </button>
                  {selectedChar.three_views?.three_quarter && (
                    <button
                      onClick={() => updateCharacter(selectedChar.id, { three_views: { ...selectedChar.three_views, three_quarter: '' } })}
                      className="p-2 rounded-xl bg-surface-secondary hover:bg-red-500/20 text-gray-400 hover:text-red-400 border border-border"
                      title="清除此视角"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <span className="text-[10px] text-gray-400 mt-1.5">用于战斗对决、对话特写与戏剧化分镜生成</span>
              </div>
            </div>
          </div>

          {/* Character Prompts & Voice Configuration */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-surface p-4 rounded-2xl border border-border space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-brand" /> 视觉特征提示词 (Visual Prompt)
                </label>
                <AiPolishButton value={selectedChar.visual_prompt} onPolish={(v: any) => updateCharacter(selectedChar.id, { visual_prompt: v })} contextType="prompt" size="xs" />
              </div>
              <textarea
                value={selectedChar.visual_prompt}
                onChange={(e) => updateCharacter(selectedChar.id, { visual_prompt: e.target.value })}
                rows={3}
                placeholder="角色外貌特征描述词，如：银发蓝眸，冷峻少年，身着青云宗道袍..."
                className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-gray-200 focus:outline-none focus:border-brand leading-relaxed"
              />
            </div>

            <div className="bg-surface p-4 rounded-2xl border border-border space-y-2">
              <label className="text-xs font-bold text-white flex items-center justify-between">
                <span>🎙️ 专属角色音色</span>
                <span className="text-[10px] text-accent-pink font-mono">{voiceOptions.length} 个可选音色 · 来自语音源接口</span>
              </label>
              <select
                value={selectedChar.voice_id}
                onChange={(e) => {
                  const val = e.target.value;
                  const hit = voiceOptions.find(v => v.id === val);
                  updateCharacter(selectedChar.id, { voice_id: val, voice_name: hit?.name || val });
                }}
                className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-brand"
              >
                <option value="">源默认音色</option>
                {voiceOptions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                {selectedChar.voice_id && !voiceOptions.some(v => v.id === selectedChar.voice_id) && (
                  <option value={selectedChar.voice_id}>{selectedChar.voice_name || selectedChar.voice_id} (连线)</option>
                )}
              </select>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
          请选择或创建角色
        </div>
      )}

      {/* Universal Asset Picker Modal */}
      <AssetPickerModal
        isOpen={!!assetPickerViewKey}
        title={
          assetPickerViewKey === 'front' 
            ? `从素材库选择【${selectedChar?.name || '角色'}】正面视图` 
            : assetPickerViewKey === 'side' 
            ? `从素材库选择【${selectedChar?.name || '角色'}】侧面轮廓` 
            : assetPickerViewKey === 'three_quarter'
            ? `从素材库选择【${selectedChar?.name || '角色'}】3/4 动态视角`
            : `从素材库选择【${selectedChar?.name || '角色'}】头像`
        }
        defaultCategory="character"
        onSelect={handleSelectAssetForView}
        onClose={() => setAssetPickerViewKey(null)}
      />
    </div>
  );
};

