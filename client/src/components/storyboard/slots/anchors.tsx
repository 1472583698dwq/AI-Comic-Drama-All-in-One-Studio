import React from 'react';
import { Box, FolderOpen, Mountain, Plus, UserCheck, Users } from 'lucide-react';
import type { ShotSlotContext } from './types';

/**
 * 锚点 Slot（shot.anchors）：出场角色 / 场景空间 / 道具法宝。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */

export const CharacterAnchor: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    project, activeShot, updateShot,
    bindCharacterToShot, unbindCharacterFromShot, setCharacterWeight,
    setAudioProviderParams, setAssetPickerConfig,
    shotDynamicInputs, setShotDynamicInputs, getMediaUrl,
  } = ctx;
  return (
    <div className="p-3 rounded-2xl bg-brand/5 border border-brand/20 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-brand-light flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-brand" /> 出场角色锚定 (Character Anchor)
        </span>
        <span className="text-[10px] text-gray-400">自动同步立绘、三视图与专属音色</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(project?.characters || []).map((char) => {
          const isBound = (activeShot.character_ids || []).includes(char.id);
          const weight = activeShot.character_weights?.[char.id] ?? 0.8;
          const charAvatar = char.three_views?.front || char.avatar_url || char.three_views?.three_quarter;

          return (
            <div
              key={char.id}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-all text-xs ${
                isBound
                  ? 'bg-brand text-white border-brand shadow-md'
                  : 'bg-surface-secondary border-border text-gray-300 hover:border-brand/40 hover:text-white'
              }`}
            >
              <button
                onClick={() => {
                  if (isBound) {
                    unbindCharacterFromShot(activeShot.id, char.id);
                  } else {
                    bindCharacterToShot(activeShot.id, char.id);
                    // 自动关联讲述人与 TTS 专属音色
                    updateShot(activeShot.id, {
                      speaker_id: char.id,
                      speaker_name: char.name,
                    });
                    if (char.voice_id) {
                      setAudioProviderParams(p => ({ ...p, voice_id: char.voice_id }));
                    }
                  }
                }}
                className="flex items-center gap-1.5 font-semibold"
              >
                {charAvatar ? (
                  <img src={getMediaUrl(charAvatar)} alt="" className="w-4 h-4 rounded-full object-cover border border-white/20" />
                ) : (
                  <UserCheck className="w-3 h-3 text-brand-light" />
                )}
                <span>{char.name}</span>
              </button>

              {isBound && (
                <div className="flex items-center gap-1 pl-1 border-l border-white/20 text-[10px] font-mono">
                  <span title="参考图强度">{(weight * 100).toFixed(0)}%</span>
                  <button
                    onClick={() => unbindCharacterFromShot(activeShot.id, char.id)}
                    className="w-3.5 h-3.5 rounded-full hover:bg-black/30 flex items-center justify-center text-white/80"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {(!project?.characters || project.characters.length === 0) && (
          <div className="text-[11px] text-gray-500 py-1">当前项目无角色，可在顶部「角色」频道创建主角与三视图</div>
        )}
      </div>

      {(activeShot.character_ids || []).length > 0 && (() => {
        const boundChar = (project?.characters || []).find(c => (activeShot.character_ids || []).includes(c.id));
        if (!boundChar) return null;
        const currentRef = (activeShot as any).reference_image || boundChar.three_views?.front || boundChar.avatar_url || boundChar.three_views?.three_quarter;

        return (
          <div className="pt-2 border-t border-brand/15 space-y-2 text-[11px]">
            {/* 参考图片预览与视角切换 */}
            <div className="flex items-center justify-between bg-black/40 p-2 rounded-xl border border-brand/20">
              <div
                onClick={() => {
                  setAssetPickerConfig({
                    isOpen: true,
                    title: `为分镜选择参考图 / 垫图（角色: ${boundChar.name}）`,
                    category: 'character',
                    onSelect: (asset) => {
                      setShotDynamicInputs(p => ({ ...p, reference_image: asset.url }));
                      updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: asset.url } } as any);
                    }
                  });
                }}
                className="flex items-center gap-2 cursor-pointer group"
                title="点击从素材库更换参考垫图"
              >
                <div className="w-10 h-10 rounded-lg overflow-hidden bg-black/60 border border-border shrink-0 relative group-hover:border-brand transition-all">
                  {currentRef ? (
                    <img src={getMediaUrl(currentRef)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">无图</div>
                  )}
                  <div className="absolute inset-0 bg-brand/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <FolderOpen className="w-3.5 h-3.5 text-white" />
                  </div>
                </div>
                <div>
                  <div className="font-bold text-white flex items-center gap-1 group-hover:text-brand-light transition-colors">
                    <span>已绑定参考图:</span>
                    <span className="text-brand-light font-mono">{boundChar.name}</span>
                  </div>
                  <div className="text-[10px] text-emerald-400">
                    {currentRef ? '✓ IP-Adapter 垫图已就绪' : '⚠️ 点击从素材库选择'}
                  </div>
                </div>
              </div>

              {/* 视角切换与素材库选取按钮 */}
              <div className="flex items-center gap-1">
                {boundChar.three_views?.front && (
                  <button
                    onClick={() => updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: boundChar.three_views?.front } } as any)}
                    className="px-1.5 py-0.5 rounded bg-surface-secondary hover:bg-brand/30 border border-border text-[9px] text-gray-300"
                    title="使用正面图"
                  >
                    正面
                  </button>
                )}
                {boundChar.three_views?.side && (
                  <button
                    onClick={() => updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: boundChar.three_views?.side } } as any)}
                    className="px-1.5 py-0.5 rounded bg-surface-secondary hover:bg-brand/30 border border-border text-[9px] text-gray-300"
                    title="使用侧面图"
                  >
                    侧面
                  </button>
                )}
                {boundChar.three_views?.three_quarter && (
                  <button
                    onClick={() => updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: boundChar.three_views?.three_quarter } } as any)}
                    className="px-1.5 py-0.5 rounded bg-surface-secondary hover:bg-brand/30 border border-border text-[9px] text-gray-300"
                    title="使用 3/4 动态图"
                  >
                    3/4
                  </button>
                )}
                <button
                  onClick={() => {
                    setAssetPickerConfig({
                      isOpen: true,
                      title: `从素材库选择垫图 / 参考图`,
                      category: 'character',
                      onSelect: (asset) => {
                        setShotDynamicInputs(p => ({ ...p, reference_image: asset.url }));
                        updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: asset.url } } as any);
                      }
                    });
                  }}
                  className="px-2 py-0.5 rounded bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light text-[10px] font-bold flex items-center gap-1 transition-all"
                  title="从素材库选择任意图片作为垫图"
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>素材库</span>
                </button>
              </div>
            </div>

            {/* 权重滑块 */}
            <div className="flex items-center justify-between pt-1">
              <span className="text-gray-300">垫图权重:</span>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0.2"
                  max="1.0"
                  step="0.05"
                  value={activeShot.character_weights?.[boundChar.id] || 0.8}
                  onChange={(e) => setCharacterWeight(activeShot.id, boundChar.id, parseFloat(e.target.value))}
                  className="w-24 accent-brand"
                />
                <span className="font-mono text-brand-light text-[10px] w-7">
                  {((activeShot.character_weights?.[boundChar.id] || 0.8) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export const SceneAnchor: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { activeShot, bindSceneToShot, unbindSceneFromShot, setAssetPickerConfig, getMediaUrl } = ctx;
  return (
    <div className="p-3 rounded-2xl bg-emerald-500/5 border border-emerald-500/20 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
          <Mountain className="w-3.5 h-3.5 text-emerald-400" /> 场景环境空间 (Scene Space)
        </span>
        {activeShot.scene_name && (
          <button
            onClick={() => unbindSceneFromShot(activeShot.id)}
            className="text-[10px] text-gray-400 hover:text-red-400"
          >
            解除挂载
          </button>
        )}
      </div>

      {activeShot.scene_name ? (
        <div className="flex items-center justify-between bg-black/40 p-2 rounded-xl border border-emerald-500/30">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-10 h-10 rounded-lg overflow-hidden bg-black/60 border border-border shrink-0">
              {activeShot.scene_ref_image ? (
                <img src={getMediaUrl(activeShot.scene_ref_image)} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">场景</div>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold text-white truncate">{activeShot.scene_name}</div>
              <div className="text-[10px] text-gray-400 truncate">{activeShot.scene_prompt || '已注入环境光影'}</div>
            </div>
          </div>
          <button
            onClick={() => {
              setAssetPickerConfig({
                isOpen: true,
                title: '从素材库更换场景空间',
                category: 'scene',
                onSelect: (asset) => bindSceneToShot(activeShot.id, asset),
              });
            }}
            className="px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-[10px] font-bold shrink-0"
          >
            更换
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setAssetPickerConfig({
              isOpen: true,
              title: '从素材库选择场景空间素材',
              category: 'scene',
              onSelect: (asset) => bindSceneToShot(activeShot.id, asset),
            });
          }}
          className="w-full py-2 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 text-emerald-300 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>+ 从素材库挂载场景空间 (青云大殿 / 荒漠战场...)</span>
        </button>
      )}
    </div>
  );
};

export const PropAnchor: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { activeShot, updateShot, bindPropToShot, setAssetPickerConfig } = ctx;
  return (
    <div className="p-3 rounded-2xl bg-amber-500/5 border border-amber-500/20 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
          <Box className="w-3.5 h-3.5 text-amber-400" /> 道具与法宝特效 (Props & FX)
        </span>
        <button
          onClick={() => {
            setAssetPickerConfig({
              isOpen: true,
              title: '从素材库添加道具/法宝素材',
              category: 'prop',
              onSelect: (asset) => bindPropToShot(activeShot.id, asset),
            });
          }}
          className="text-[10px] text-amber-300 hover:underline flex items-center gap-0.5 font-bold"
        >
          <Plus className="w-3 h-3" /> 挂载道具
        </button>
      </div>

      {activeShot.prop_prompts ? (
        <div className="p-2 rounded-xl bg-black/40 border border-amber-500/30 flex items-center justify-between text-xs">
          <span className="text-gray-300 truncate">{activeShot.prop_prompts}</span>
          <button
            onClick={() => updateShot(activeShot.id, { prop_asset_ids: [], prop_prompts: '' })}
            className="text-[10px] text-gray-400 hover:text-red-400 ml-2 shrink-0"
          >
            清空
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-gray-500 py-0.5">暂无挂载道具，可从素材库挂载法宝剑气或关键物件</div>
      )}
    </div>
  );
};
