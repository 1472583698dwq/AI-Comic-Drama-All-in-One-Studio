import React from 'react';
import { ChevronRight, Film, X } from 'lucide-react';
import type { ShotSlotContext } from './slots/types';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';
import { InspectorPanel } from './slots/InspectorPanel';

/** 按需打开的单镜详情：把高级生成控制从默认镜头板中移出。 */
export const ShotDetailDrawer: React.FC<{
  ctx: ShotSlotContext;
  onClose: () => void;
}> = ({ ctx, onClose }) => {
  const { activeShot, project, getMediaUrl } = ctx;
  if (!activeShot) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-[430px] flex-col border-l border-border bg-surface shadow-2xl shadow-black/40">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface-secondary/80 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Film className="h-4 w-4 shrink-0 text-brand" />
          <span className="text-xs font-bold text-white">镜头 #{activeShot.shot_index}</span>
          <ChevronRight className="h-3 w-3 text-gray-600" />
          <span className="truncate text-[11px] text-gray-400">{project?.title || '当前项目'}</span>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-surface-tertiary hover:text-white" title="关闭镜头详情">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="shrink-0 border-b border-border bg-background/40 p-3">
        <div className="overflow-hidden rounded-xl border border-border bg-surface-secondary">
          {activeShot.video_url ? (
            <AutoRatioMedia kind="video" src={getMediaUrl(activeShot.video_url)} fallbackAspect={ctx.previewAspect} maxHeight={190} className="w-full" videoProps={{ controls: true, muted: true, playsInline: true }} />
          ) : activeShot.image_url ? (
            <AutoRatioMedia src={getMediaUrl(activeShot.image_url)} fallbackAspect={ctx.previewAspect} maxHeight={190} className="w-full" />
          ) : (
            <div className="flex aspect-video items-center justify-center text-xs text-gray-500">当前镜头还没有画面</div>
          )}
        </div>
        <div className="mt-2 line-clamp-2 text-xs font-semibold leading-5 text-gray-200">{activeShot.action_desc || activeShot.image_prompt || '未填写镜头描述'}</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <InspectorPanel ctx={ctx} embedded />
      </div>
    </div>
  );
};
