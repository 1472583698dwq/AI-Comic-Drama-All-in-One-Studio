import React, { useState, useEffect } from 'react';
import { 
  Users, 
  Sparkles, 
  Image as ImageIcon,
  Plus,
  Trash2,
  FolderOpen,
  Music,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { Character } from '../../types';
import { apiService } from '../../services/api';
import { API_ORIGIN } from '../../utils/devOrigin';
import { AssetPickerModal } from '../asset/AssetPickerModal';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';
import { confirmAsync, toast } from '../../stores/useDialogStore';

export const CharacterStudio: React.FC = () => {
  const { project, updateCharacter, addCharacter, deleteCharacter } = useProjectStore();

  const characters = project?.characters || [];
  const [selectedCharId, setSelectedCharId] = useState<string>(characters[0]?.id || '');
  const [isGeneratingSheet, setIsGeneratingSheet] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  // ref_audio 走音频素材选择器（mediaType=audio），三视图走图片选择器
  const [assetPickerViewKey, setAssetPickerViewKey] = useState<'front' | 'ref_audio' | null>(null);

  // Auto select first char if active becomes invalid
  useEffect(() => {
    if (characters.length > 0 && !characters.some(c => c.id === selectedCharId)) {
      setSelectedCharId(characters[0].id);
    }
  }, [characters, selectedCharId]);

  const selectedChar = characters.find((c) => c.id === selectedCharId) || characters[0];

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
      // 形象以三视图为准：不再预填通用视觉提示词，生图/生三视图统一用 人设描述 兜底
      visual_prompt: '',
      three_views: {},
    };
    addCharacter(newChar);
    setSelectedCharId(newId);
  };

  const handleDeleteCurrentChar = async () => {
    if (!selectedChar) return;
    if (characters.length <= 1) {
      toast.warning('项目中至少保留一个角色');
      return;
    }
    const confirmed = await confirmAsync({
      title: '删除角色',
      message: `确定要删除角色「${selectedChar.name}」吗？\n删除后该角色的立绘和分镜关联将失效。`,
      isDanger: true,
      confirmText: '确认删除',
      cancelText: '取消'
    });
    if (confirmed) {
      deleteCharacter(selectedChar.id);
      toast.success(`角色「${selectedChar.name}」已删除`);
    }
  };

  const handleSelectAssetForView = (asset: { url: string; visual_prompt?: string; name: string }) => {
    if (!selectedChar || !assetPickerViewKey) return;
    if (assetPickerViewKey === 'ref_audio') {
      updateCharacter(selectedChar.id, { ref_audio_url: asset.url, ref_audio_name: asset.name });
    } else {
      updateCharacter(selectedChar.id, {
        three_views: {
          ...selectedChar.three_views,
          [assetPickerViewKey]: asset.url
        },
        avatar_url: selectedChar.avatar_url || asset.url,
      });
    }
    setAssetPickerViewKey(null);
  };

  const handleGenerate3Views = async () => {
    // 视觉提示词已收敛：三视图是唯一形象来源；生成时用 人设描述/角色名 兜底
    const visualPrompt = selectedChar.visual_prompt?.trim() || selectedChar.description?.trim() || selectedChar.name;
    setRegenError(null);
    setIsGeneratingSheet(true);
    try {
      const res = await apiService.generateCharacter3Views({
        name: selectedChar.name,
        visual_prompt: visualPrompt,
        description: selectedChar.description,
        style_preset: project?.style_preset || 'donghua_xianxia',
      });
      const views = res.three_views || {};
      if (views.front) {
        updateCharacter(selectedChar.id, { 
          three_views: { ...selectedChar.three_views, front: views.front },
          avatar_url: selectedChar.avatar_url || views.front
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
            const avatar = char.three_views?.front || char.avatar_url;
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
                <div className="w-12 h-12 rounded-xl overflow-hidden bg-surface-secondary flex-shrink-0 border border-border">
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
                  <p className="text-[10px] text-gray-400 truncate mt-0.5">
                    {char.ref_audio_url ? '🎙 参考音频已绑定' : (char.voice_name || '默认音色')}
                  </p>
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
                className="relative w-16 h-16 rounded-2xl overflow-hidden border border-border shadow-md bg-surface-secondary"
                title="头像取自正面视图"
              >
                {selectedChar.three_views?.front || selectedChar.avatar_url ? (
                  <img src={resolveUrl(selectedChar.three_views?.front || selectedChar.avatar_url)} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xl font-bold text-white/60">{selectedChar.name[0]}</div>
                )}
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
                <span>{isGeneratingSheet ? '生成中...' : '智能生成三视图'}</span>
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
                <span>角色标准三视图 (Three-View Consistency Matrix)</span>
              </h3>
              <span className="text-xs text-brand-light font-medium">✨ 从统一素材库一键选用 / 归档</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* 1. Front View (正面视图) */}
              <div className="bg-surface p-4 rounded-2xl border border-border flex flex-col group relative">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-brand" /> 角色三视图 (Character Sheet)
                  </span>
                  {selectedChar.three_views?.front && <span className="text-[10px] text-emerald-400 font-bold">已绑定</span>}
                </div>

                {selectedChar.three_views?.front ? (
                  <AutoRatioMedia
                    src={resolveUrl(selectedChar.three_views.front)}
                    alt="Three Views"
                    fallbackAspect="3/4"
                    onClick={() => setAssetPickerViewKey('front')}
                    title="点击从素材库选择或上传三视图"
                    className="rounded-xl bg-surface-secondary mb-3 border border-border cursor-pointer hover:border-brand transition-all group"
                    mediaClassName="group-hover:scale-105 transition-transform"
                  >
                    <div className="absolute inset-0 bg-brand/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="px-3 py-1.5 rounded-full bg-brand text-white text-xs font-bold shadow-lg flex items-center gap-1">
                        <FolderOpen className="w-3.5 h-3.5" /> 从素材库更换
                      </span>
                    </div>
                  </AutoRatioMedia>
                ) : (
                  <div
                    onClick={() => setAssetPickerViewKey('front')}
                    className="aspect-[3/4] rounded-xl overflow-hidden bg-surface-secondary mb-3 border border-border flex items-center justify-center relative cursor-pointer hover:border-brand transition-all group"
                    title="点击从素材库选择或上传三视图"
                  >
                    <div className="flex flex-col items-center justify-center text-gray-500 text-xs space-y-2 p-4 text-center">
                      <FolderOpen className="w-8 h-8 text-brand-light/60" />
                      <span className="text-gray-300 font-medium">点击从素材库选择三视图</span>
                    </div>
                    <div className="absolute inset-0 bg-brand/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="px-3 py-1.5 rounded-full bg-brand text-white text-xs font-bold shadow-lg flex items-center gap-1">
                        <FolderOpen className="w-3.5 h-3.5" /> 从素材库更换
                      </span>
                    </div>
                  </div>
                )}

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

            </div>
          </div>

          {/* 参考音频绑定（音色克隆）：角色配音的唯一声音来源 */}
          <div className="bg-surface p-4 rounded-2xl border border-border space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-white flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-accent-pink" /> 参考音频绑定（音色克隆）
              </label>
              <span className={`text-[10px] font-bold ${selectedChar.ref_audio_url ? 'text-emerald-400' : 'text-gray-500'}`}>
                {selectedChar.ref_audio_url ? '已绑定' : '未绑定 · 可选'}
              </span>
            </div>

            {selectedChar.ref_audio_url ? (
              <div className="flex items-center gap-2">
                <audio
                  controls
                  src={resolveUrl(selectedChar.ref_audio_url)}
                  className="flex-1 min-w-0 h-9"
                />
                <button
                  onClick={() => setAssetPickerViewKey('ref_audio')}
                  className="shrink-0 px-3 py-2 rounded-xl bg-brand/15 hover:bg-brand/25 border border-brand/30 text-brand-light text-xs font-bold flex items-center gap-1.5 transition-all"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-brand" />
                  <span>更换</span>
                </button>
                <button
                  onClick={() => updateCharacter(selectedChar.id, { ref_audio_url: '', ref_audio_name: '' })}
                  className="shrink-0 p-2 rounded-xl bg-surface-secondary hover:bg-red-500/20 text-gray-400 hover:text-red-400 border border-border"
                  title="解绑参考音频"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAssetPickerViewKey('ref_audio')}
                className="w-full py-3.5 rounded-xl border border-dashed border-border hover:border-brand hover:bg-brand/5 text-gray-300 hover:text-white text-xs font-medium flex flex-col items-center justify-center gap-1.5 transition-all"
              >
                <FolderOpen className="w-5 h-5 text-brand-light/70" />
                <span>从素材库选择 / 上传参考音频</span>
              </button>
            )}

            {selectedChar.ref_audio_name && (
              <p className="text-[10px] text-gray-400 truncate">当前：{selectedChar.ref_audio_name}</p>
            )}
            <p className="text-[10px] text-gray-500 leading-relaxed">
              绑定后，该角色的单镜试听与批量配音会自动把此音频作为 ref_audio 传给所配语音源；
              支持音色克隆的源（GPT-SoVITS / CosyVoice / 自定义克隆源）将按该音色合成。
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
          请选择或创建角色
        </div>
      )}

      {/* Universal Asset Picker Modal：三视图=图片，参考音频=音频 */}
      <AssetPickerModal
        isOpen={!!assetPickerViewKey}
        mediaType={assetPickerViewKey === 'ref_audio' ? 'audio' : 'image'}
        title={
          assetPickerViewKey === 'ref_audio'
            ? `从素材库选择【${selectedChar?.name || '角色'}】参考音频`
            : `从素材库选择【${selectedChar?.name || '角色'}】角色三视图`
        }
        defaultCategory={assetPickerViewKey === 'ref_audio' ? 'other' : 'character'}
        onSelect={handleSelectAssetForView}
        onClose={() => setAssetPickerViewKey(null)}
      />
    </div>
  );
};

