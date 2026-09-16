import React from 'react';
import { Keyboard, Layers, Plus } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { WorkflowInspectorModal } from '../../workflow/WorkflowInspectorModal';
import { CanvasResourcePickerModal } from '../../canvas/CanvasResourcePickerModal';
import { AssetPickerModal } from '../../asset/AssetPickerModal';
import { useEscapeClose } from '../../../hooks/useEscapeClose';

/**
 * 浮层 Slot（shot.overlays）：快捷键指南 + 工作流检查窗 + 插槽素材选择窗
 * + 素材选择窗 + 分镜右键菜单。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const ShotOverlays: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    showHotkeysHint, setShowHotkeysHint,
    inspectingWorkflowId, setInspectingWorkflowId,
    loadProjectAssets, refreshSourceDefs,
    slotPicker, setSlotPicker, handleSlotPicked,
    assetPickerConfig, setAssetPickerConfig,
    ctxMenu, setCtxMenu, shots, ctxCanvases, ctxLoadingCanvas, sendShotToCanvas,
  } = ctx;
  useEscapeClose(!!ctxMenu, () => setCtxMenu(null));
  return (
    <>
      {/* ⌨️ 底部悬浮专业快捷键指南 */}
      {showHotkeysHint && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-surface/90 backdrop-blur-md border border-border px-3.5 py-1.5 rounded-full shadow-2xl z-30 flex items-center gap-3 text-[11px] [color:var(--color-text-main)] animate-fade-in pointer-events-auto">
          <div className="flex items-center gap-1 text-brand font-bold">
            <Keyboard className="w-3.5 h-3.5" /> 快捷键:
          </div>
          <div className="flex items-center gap-2">
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">Space</kbd> 播放</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">A</kbd>/<kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">D</kbd> 切镜头</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">R</kbd> 抽卡</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">V</kbd> 视频</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">T</kbd> 配音</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">1-4</kbd> 选候选</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">Ctrl+D</kbd> 复制</span>
          </div>
          <button onClick={() => setShowHotkeysHint(false)} className="ml-1 [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] text-xs">×</button>
        </div>
      )}

      {/* Workflow Inspector Modal */}
      {inspectingWorkflowId && (
        <WorkflowInspectorModal
          workflowId={inspectingWorkflowId}
          isOpen={!!inspectingWorkflowId}
          onClose={() => setInspectingWorkflowId('')}
          onSaved={() => {
            loadProjectAssets();
            // 暴露清单变了 → 该工作流对应生成源的 schema 已在后端重建，必须重新拉 definition 才能反映到表单
            refreshSourceDefs();
            window.dispatchEvent(new Event('provider-list-refresh'));
          }}
          onDeleted={() => {
            loadProjectAssets();
            refreshSourceDefs();
            window.dispatchEvent(new Event('provider-list-refresh'));
          }}
        />
      )}

      {/* 生成源插槽素材选择：画布产出 / 角色库 / 素材库 / 本地上传 */}
      {slotPicker && (
        <CanvasResourcePickerModal
          isOpen={!!slotPicker}
          onClose={() => setSlotPicker(null)}
          onSelect={handleSlotPicked}
          slotKey={slotPicker.writeKeys[0]}
          slotLabel={slotPicker.slot?.label}
          multiSelect={slotPicker.multi}
          acceptType={slotPicker.slot?.type || 'image'}
        />
      )}

      {/* Universal Asset Picker Modal for Storyboard Reference & Dynamic Inputs */}
      <AssetPickerModal
        isOpen={assetPickerConfig.isOpen}
        title={assetPickerConfig.title}
        defaultCategory={assetPickerConfig.category}
        onSelect={(asset) => {
          assetPickerConfig.onSelect(asset);
          setAssetPickerConfig(p => ({ ...p, isOpen: false }));
        }}
        onClose={() => setAssetPickerConfig(p => ({ ...p, isOpen: false }))}
      />

      {/* 分镜右键菜单：使用新画布 / 隶属到现有画布（视频在该画布生成后回写分镜） */}
      {ctxMenu && (() => {
        const shot: any = shots.find((s: any) => s.id === ctxMenu.shotId);
        if (!shot) return null;
        const affil = ctxCanvases.find(c => c.id === shot.canvas_id);
        return (
          <div className="fixed inset-0 z-[70]" onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }}>
            <div className="absolute w-60 rounded-xl bg-surface border border-border shadow-2xl p-1.5 space-y-0.5" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
              <div className="px-2.5 py-1.5 text-[11px] font-bold text-gray-400">分镜 #{shot.shot_index}{affil ? ` · 隶属「${affil.name}」` : ''}</div>
              <button onClick={() => sendShotToCanvas(shot, { mode: 'new' })} className="w-full text-left px-2.5 py-2 rounded-lg text-xs text-white hover:bg-brand/20 flex items-center gap-2"><Plus className="w-3.5 h-3.5 text-brand-light" /><span>使用新画布生成视频</span></button>
              <div className="px-2.5 pt-1.5 text-[10px] text-gray-500 font-bold">隶属到现有画布</div>
              {ctxLoadingCanvas && <div className="px-2.5 py-1.5 text-[11px] text-gray-500">加载画布列表…</div>}
              {!ctxLoadingCanvas && ctxCanvases.length === 0 && <div className="px-2.5 py-1.5 text-[11px] text-gray-500">暂无画布（先用新画布）</div>}
              {ctxCanvases.map(c => (
                <button key={c.id} onClick={() => sendShotToCanvas(shot, { mode: 'existing', canvas_id: c.id })} className="w-full text-left px-2.5 py-2 rounded-lg text-xs text-gray-200 hover:bg-brand/20 flex items-center gap-2 truncate">
                  <Layers className="w-3.5 h-3.5 text-gray-500" />
                  <span className="truncate">{shot.canvas_id === c.id ? '✓ ' : ''}{c.name}（{c.node_count}节点）</span>
                </button>
              ))}
              <div className="px-2.5 py-1.5 text-[10px] text-gray-600 leading-4">视频在所选画布自动生成后回写本分镜</div>
            </div>
          </div>
        );
      })()}
    </>
  );
};
