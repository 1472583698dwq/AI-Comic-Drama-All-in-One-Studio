import React from 'react';
import { Image as ImageIcon, Paintbrush, Sliders, Sparkles, Link2 } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { FRAMING_PRESETS } from '../../director3d/directorPresets';
import { referenceMentionSuffix } from '../shotReference';
import { imageLayoutOf, lanesOf } from '../shotLanes';
import { useAnchorDefs } from '../../../ui-registry/adapters/storyboardSlots';
import { ProviderSlotList } from './ProviderSlotList';
import { SlotOutlet } from './PluginRender';
import { ProviderPicker, ProviderParamForm } from '../../ui/ProviderPicker';
import { AiPolishButton } from '../../ui/AiPolishButton';

/**
 * visual Tab：锚点（经 anchorRegistry）+ 画面动作描述 + 生图源表单 + 机位预设。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const VisualTab: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    project, activeShot, updateShot,
    synthesizeShotPrompt,
    imageProvider, imageProviderDef, imageProviderParams,
    setImageProvider, setImageProviderParams,
    shotDynamicInputs, resolveRenderSlots,
    setSlotValue, handleSlotUploadFile, pickAssetForSlot, injectCharacterToSlot,
    uploadingInputKey, getMediaUrl,
    setInspectingWorkflowId, probeProvider,
    handleOneClickBind, hasBindUndo, undoLastBind,
    handleRegenerateImage, isRegenerating, regenError,
  } = ctx;
  // 锚点槽从注册表取（内置 + 插件同一条管线），when(ctx) 过滤仍在宿主侧
  const anchors = useAnchorDefs(ctx);
  const imageOn = lanesOf(activeShot).image;
  const layout = imageLayoutOf(activeShot);
  const imageState = !imageOn ? '已关闭' : !activeShot.image_url ? '未生成' : layout === 'grid' ? '四宫格' : ((activeShot.candidates?.length || 0) > 1 ? '选优' : '单张');
  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between text-[11px] text-gray-400">
        <span>出画面</span>
        <span className={imageOn ? 'text-gray-200' : 'text-gray-500'}>{imageState}</span>
      </div>
      {anchors.map((a) => (
        <SlotOutlet key={a.id} slotKey={a.id} render={a.render} ctx={ctx} />
      ))}

      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-gray-300 flex items-center gap-1"><Paintbrush className="w-3 h-3 text-violet-400"/> 画面动作描述</label>
          <AiPolishButton value={activeShot.action_desc} onPolish={(v: any) => updateShot(activeShot.id, { action_desc: v })} contextType="prompt" size="xs" />
        </div>
        <textarea value={activeShot.action_desc} onChange={(e) => updateShot(activeShot.id, { action_desc: e.target.value })} rows={2} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand leading-relaxed" placeholder="描述人物动作、情景与交互..."/>
        <label className="mt-2 block text-[11px] text-gray-400">景别</label>
        <select
          value={activeShot.camera_framing || 'medium'}
          onChange={(e) => {
            const id = e.target.value;
            const short = (FRAMING_PRESETS.find((f) => f.id === id)?.label || id).replace(/\s*\(.*$/, '');
            const prev = activeShot.action_desc || '';
            const next = /景别：[^，。\n]*/.test(prev)
              ? prev.replace(/景别：[^，。\n]*/, `景别：${short}`)
              : (prev ? `${prev} 景别：${short}` : `景别：${short}`);
            updateShot(activeShot.id, { camera_framing: id, action_desc: next } as any);
          }}
          className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white"
        >
          {FRAMING_PRESETS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      {(() => {
        return (
        <div className="p-3 rounded-2xl bg-surface-secondary/50 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5 text-violet-400" /> 生图生成源配置
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => synthesizeShotPrompt(activeShot.id)}
                className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-brand to-violet-600 hover:opacity-90 text-white text-[11px] font-bold flex items-center gap-1 shadow-sm transition-all"
                title="一键将角色特征、场景环境、道具法宝、3D机位词融合成完整提示词"
              >
                <Sparkles className="w-3 h-3" />
                <span>合成提示词</span>
              </button>
              <button
                onClick={() => handleOneClickBind('image')}
                className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold flex items-center gap-1 transition-all"
                title="按该生图源声明的参考插槽，自动填入绑定的人物 / 场景 / 道具 / 白模等参考图"
              >
                <Link2 className="w-3 h-3" />
                <span>一键绑定参考</span>
              </button>
              {hasBindUndo && (
                <button onClick={undoLastBind} className="px-2 py-1 rounded-lg border border-border text-gray-400 hover:text-white text-[11px] transition-all" title="撤销上一次一键绑定">
                  ↩ 撤销
                </button>
              )}
              <AiPolishButton value={activeShot.image_prompt} onPolish={(v: any) => updateShot(activeShot.id, { image_prompt: v })} contextType="prompt" size="xs" />
            </div>
          </div>

          {/* 生图源选择 */}
          <ProviderPicker
            kind="image"
            value={imageProvider}
            onChange={(pid, def) => {
              setImageProvider(pid, def);
              if (pid) localStorage.setItem('default_image_provider', pid);
              updateShot(activeShot.id, { image_provider: pid, provider_params: { ...(activeShot as any).provider_params, image: imageProviderParams } } as any);
              if (pid) probeProvider(pid);
            }}
            placeholder="— 选择生图源（空为系统默认） —"
          />

          {/* 生图源专有 Schema 参数动态表单 */}
          {imageProviderDef?.params_schema && (
            <div className="rounded-xl bg-surface-secondary border border-violet-500/20 p-2.5 space-y-2">
              <div className="text-[11px] font-bold text-violet-300 flex items-center justify-between">
                <span>⚙️ {imageProviderDef.display_name || imageProviderDef.name || imageProviderDef.id} 专属参数</span>
              </div>
              <ProviderParamForm
                definition={imageProviderDef}
                values={imageProviderParams}
                onChange={(next) => {
                  setImageProviderParams(next);
                  updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, image: next } } as any);
                }}
              />
            </div>
          )}

          {/* 源声明的输入区：提示词 + 媒体插槽，全部来自该源 input_schema，零写死模板 */}
          {(() => {
            const def: any = imageProviderDef;
            const inProps = def?.input_schema?.properties || {};
            const promptLabel = String(inProps?.prompt?.title || inProps?.prompt?.description || '正向生图提示词');
            const slots: any[] = resolveRenderSlots(def, 'image');
            return (
              <div className="space-y-2.5">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-gray-300 font-semibold">
                    <span className="truncate" title={promptLabel}>{promptLabel}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {def?.workflow_id && (
                        <button onClick={() => setInspectingWorkflowId(def.workflow_id)} className="text-[10px] font-normal text-brand-light hover:underline flex items-center gap-1" title="编辑该工作流的暴露清单">
                          <Sliders className="w-3 h-3" /> 参数与暴露
                        </button>
                      )}
                      <span className="text-[10px] text-gray-500 font-mono">{activeShot.image_prompt?.length || 0} 字</span>
                    </span>
                  </div>
                  <textarea
                    value={activeShot.image_prompt}
                    onChange={(e) => updateShot(activeShot.id, { image_prompt: e.target.value })}
                    rows={3}
                    className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                    placeholder={inProps?.prompt?.description ? `${inProps.prompt.description}...` : '输入画面提示词...'}
                  />
                  {referenceMentionSuffix(activeShot, project) && (
                    <p className="text-[10px] text-gray-500 whitespace-pre-wrap leading-relaxed">生成时附在提示词后：{referenceMentionSuffix(activeShot, project).trim()}</p>
                  )}
                </div>

                <ProviderSlotList
                  slots={slots}
                  values={shotDynamicInputs}
                  uploadingKey={uploadingInputKey}
                  onWrite={setSlotValue}
                  onUpload={handleSlotUploadFile}
                  onPickFromLibrary={pickAssetForSlot}
                  onInjectCharacter={injectCharacterToSlot}
                  resolveUrl={getMediaUrl}
                />
                <button
                  type="button"
                  onClick={() => handleRegenerateImage()}
                  disabled={!imageOn || isRegenerating}
                  className="w-full py-2.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
                  <span>{isRegenerating ? '生成中…' : layout === 'grid' ? '用此源生成四宫格' : '用此源生成画面'}</span>
                </button>
                {regenError && <div className="text-xs text-red-300">{regenError}</div>}
              </div>
            );
          })()}

        </div>
        );
      })()}

    </div>
  );
};
