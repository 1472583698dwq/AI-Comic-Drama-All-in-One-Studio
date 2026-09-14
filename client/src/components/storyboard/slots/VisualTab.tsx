import React from 'react';
import { Image as ImageIcon, Paintbrush, Sliders, Sparkles } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { getVisibleAnchors } from './registry';
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
    activeShot, updateShot, productionMode,
    synthesizeShotPrompt,
    imageProvider, imageProviderDef, imageProviderParams,
    setImageProvider, setImageProviderParams,
    shotDynamicInputs, resolveRenderSlots,
    setSlotValue, handleSlotUploadFile, pickAssetForSlot, injectCharacterToSlot,
    uploadingInputKey, getMediaUrl, handleRegenerateImage, isRegenerating,
    setInspectingWorkflowId, probeProvider, regenError,
  } = ctx;
  return (
    <div className="space-y-3.5">
      {getVisibleAnchors(ctx).map((a) => (
        <SlotOutlet key={a.id} slotKey={a.id} render={a.render} ctx={ctx} />
      ))}

      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-gray-300 flex items-center gap-1"><Paintbrush className="w-3 h-3 text-violet-400"/> 画面动作描述</label>
          <AiPolishButton value={activeShot.action_desc} onPolish={(v: any) => updateShot(activeShot.id, { action_desc: v })} contextType="prompt" size="xs" />
        </div>
        <textarea value={activeShot.action_desc} onChange={(e) => updateShot(activeShot.id, { action_desc: e.target.value })} rows={2} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand leading-relaxed" placeholder="描述人物动作、情景与交互..."/>
      </div>

      {/* 4. 生图源专属表单（直出模式隐藏：立绘直驱视频，无需单张生图） */}
      {(() => {
        // NOTE: 条件与原代码一致 —— motion_comic 隐藏生图表单
        const hide = productionMode === 'motion_comic';
        if (hide) {
          return <div className="text-[11px] text-gray-500 bg-surface-secondary/60 border border-border rounded-lg px-2.5 py-1.5">直出模式跳过生图：绑定上方角色 / 场景 / 道具后，直接去「运镜动态」页生成参考生视频</div>;
        }
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
                <span>⚡ 全要素合成</span>
              </button>
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
              </div>
            );
          })()}

          <div className="flex gap-2">
            <button
              onClick={() => handleRegenerateImage(1)}
              disabled={isRegenerating}
              className="flex-1 py-2.5 rounded-xl bg-surface-tertiary hover:bg-surface-hover border border-border text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 transition-all"
            >
              <span>单张生成</span>
            </button>
            <button
              onClick={() => handleRegenerateImage(4)}
              disabled={isRegenerating}
              className="flex-[2] py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-light text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-lg shadow-brand/20 hover:opacity-90 disabled:opacity-40 transition-all"
            >
              <Sparkles className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
              <span>{isRegenerating ? '4 抽并发中…' : '1 镜 4 抽 (推荐 ⚡)'}</span>
            </button>
          </div>
          {regenError && <div className="text-xs text-red-300">{regenError}</div>}
        </div>
        );
      })()}

      {/* 镜头机位与运动预设 */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-gray-400">景别构图</label>
          <select value={activeShot.camera_framing} onChange={(e) => updateShot(activeShot.id, { camera_framing: e.target.value as any })} className="w-full mt-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
            <option value="close_up">特写 (Close-Up)</option>
            <option value="medium">中景 (Medium)</option>
            <option value="full">全景 (Full)</option>
            <option value="long">远景 (Long)</option>
            <option value="bird_eye">俯视 (Bird Eye)</option>
            <option value="low_angle">仰视 (Low Angle)</option>
          </select>
        </div>
        <div>
          <label className="text-[11px] text-gray-400">镜头运动</label>
          <select value={activeShot.camera_motion} onChange={(e) => updateShot(activeShot.id, { camera_motion: e.target.value as any })} className="w-full mt-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
            <option value="static">静止 (Static)</option>
            <option value="push_in">推近 (Push In)</option>
            <option value="pull_out">拉远 (Pull Out)</option>
            <option value="orbit">环绕 (Orbit)</option>
            <option value="shake">震颤 (Shake)</option>
          </select>
        </div>
      </div>
    </div>
  );
};
