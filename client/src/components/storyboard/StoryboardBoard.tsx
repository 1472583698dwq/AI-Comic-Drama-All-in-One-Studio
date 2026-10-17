import React, { useMemo, useState } from 'react';
import { Film, Image as ImageIcon, Mic, Play, Plus, Sparkles, Users } from 'lucide-react';
import type { ShotSlotContext } from './slots/types';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';
import { lanesOf } from './shotLanes';

/**
 * 分镜板：分镜工作台的默认入口。
 *
 * 这里故意只展示「看故事 / 看状态 / 进入编辑」所需的信息；Provider、动态插槽、
 * 参考绑定和 3D 参数统一留在 ShotDetailDrawer 的高级编辑区，避免用户打开分镜台
 * 就同时面对整套生成引擎配置。
 */
export const StoryboardBoard: React.FC<{
  ctx: ShotSlotContext;
  onOpenShot: (shotId: string) => void;
}> = ({ ctx, onOpenShot }) => {
  const { shots, activeShot, project, setActiveShotId, addShot, getMediaUrl, queue, openShotCtxMenu } = ctx;

  const groups = useMemo(() => {
    const byScene = new Map<number, typeof shots>();
    shots.forEach((shot) => {
      const list = byScene.get(Number(shot.scene_index || 0)) || [];
      list.push(shot);
      byScene.set(Number(shot.scene_index || 0), list);
    });
    return [...byScene.entries()].sort((a, b) => a[0] - b[0]).map(([sceneIndex, sceneShots]) => ({
      sceneIndex,
      title: project?.scenes.find((s) => Number(s.scene_index) === sceneIndex)?.title || `场景 ${sceneIndex}`,
      shots: sceneShots,
    }));
  }, [shots, project]);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto custom-scrollbar bg-background px-4 pb-8">
      <div className="mx-auto max-w-[1500px]">
        <div className="flex items-center justify-between gap-3 py-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">镜头板</span>
              <span className="rounded-full border border-border bg-surface-secondary px-2 py-0.5 text-[10px] font-mono text-gray-400">
                {shots.length} 镜
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-gray-500">先浏览连续性，再打开单镜详情精修</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-[11px] text-gray-500 sm:inline">点击镜头卡片开始编辑</span>
            <button
              type="button"
              onClick={() => addShot()}
              className="flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white shadow-lg shadow-brand/15 hover:bg-brand-light"
            >
              <Plus className="h-3.5 w-3.5" /> 新建分镜
            </button>
          </div>
        </div>

        {shots.length === 0 ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface/60 text-center">
            <Film className="mb-3 h-10 w-10 text-brand/60" />
            <div className="text-sm font-semibold text-white">这一集还没有分镜</div>
            <div className="mt-1 text-xs text-gray-500">新建一个镜头，或回到项目看板重新拆解剧本</div>
            <button type="button" onClick={() => addShot()} className="mt-4 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white">
              新建第一个镜头
            </button>
          </div>
        ) : (
          <div className="space-y-7">
            {groups.map((group) => (
              <section key={group.sceneIndex}>
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="h-4 w-1 rounded-full bg-brand" />
                  <h2 className="text-xs font-bold text-white">场景 {group.sceneIndex} · {group.title}</h2>
                  <span className="text-[10px] text-gray-500">{group.shots.length} 镜</span>
                </div>
                <div className="space-y-3">
                  {group.shots.map((shot) => {
                    const lanes = lanesOf(shot);
                    const selected = shot.id === activeShot?.id;
                    const characters = (project?.characters || [])
                      .filter((c) => (shot.character_ids || []).includes(c.id))
                      .slice(0, 3);
                    const queueItem = queue.find((item) => item.id === shot.id);
                    const hasOutput = Boolean(shot.image_url || shot.video_url || shot.audio_url);

                    return (
                      <article
                        key={shot.id}
                        onContextMenu={(event) => openShotCtxMenu(event, shot)}
                        onClick={(event) => {
                          // 视频原生控制条属于卡片内的直接交互，点击播放/暂停时不要抢先打开详情抽屉。
                          if ((event.target as HTMLElement).closest('video')) return;
                          setActiveShotId(shot.id);
                          onOpenShot(shot.id);
                        }}
                        className={`group flex cursor-pointer flex-col overflow-hidden rounded-2xl border bg-surface transition-all hover:border-brand/60 hover:shadow-xl hover:shadow-brand/5 sm:flex-row ${selected ? 'border-brand ring-1 ring-brand/40' : 'border-border'}`}
                      >
                        <div className="relative flex min-h-[190px] w-full shrink-0 items-center justify-center bg-surface-secondary sm:min-h-0 sm:w-56">
                          {shot.video_url ? (
                            <ShotVideoPreview
                              videoUrl={getMediaUrl(shot.video_url)}
                              fallbackImageUrl={shot.image_url ? getMediaUrl(shot.image_url) : undefined}
                              fallbackAspect={ctx.previewAspect}
                            />
                          ) : shot.image_url ? (
                            <AutoRatioMedia src={getMediaUrl(shot.image_url)} fallbackAspect={ctx.previewAspect} maxHeight={260} className="w-full" />
                          ) : (
                            <div className="flex min-h-[190px] w-full items-center justify-center px-4 text-center text-[11px] text-gray-500 sm:min-h-[150px]">
                              {shot.status === 'generating_image' ? '画面生成中…' : shot.status === 'generating_video' ? '视频生成中…' : '尚未生成画面'}
                            </div>
                          )}
                          <div className="absolute left-2 top-2 flex items-center gap-1.5">
                            <span className="rounded-lg bg-black/70 px-1.5 py-1 text-[10px] font-mono font-bold text-white">#{shot.shot_index}</span>
                            {shot.candidates && shot.candidates.length > 1 && <span className="rounded-lg bg-brand/85 px-1.5 py-1 text-[9px] font-bold text-white">{shot.candidates.length} 抽</span>}
                          </div>
                          <div className="absolute right-2 top-2 flex gap-1">
                            {shot.video_url && <span className="rounded-md bg-orange-500/90 p-1 text-white"><Film className="h-3 w-3" /></span>}
                            {shot.audio_url && <span className="rounded-md bg-pink-500/90 p-1 text-white"><Mic className="h-3 w-3" /></span>}
                          </div>
                          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/75 to-transparent px-2 pb-2 pt-6">
                            <span className="text-[10px] font-semibold text-white">{shot.camera_framing || '中景'} · {shot.camera_motion || '固定'}</span>
                            <span className="text-[10px] font-mono text-gray-200">{shot.duration}s</span>
                          </div>
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col justify-between gap-3 p-4">
                          <div className="min-h-[34px] text-sm font-semibold leading-6 text-gray-100 line-clamp-2">
                            {shot.action_desc || shot.image_prompt || '未填写镜头描述'}
                          </div>
                          {shot.dialogue || shot.voiceover ? (
                            <div className="truncate text-[11px] text-pink-300">🗣️ {shot.dialogue || shot.voiceover}</div>
                          ) : (
                            <div className="text-[11px] text-gray-600">暂无台词</div>
                          )}
                          <div className="flex min-h-[22px] items-center gap-1.5 overflow-hidden">
                            {characters.map((character) => (
                              <span key={character.id} className="flex shrink-0 items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand-light">
                                <Users className="h-2.5 w-2.5" /> {character.name}
                              </span>
                            ))}
                            {shot.scene_name && <span className="max-w-[130px] truncate rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">{shot.scene_name}</span>}
                          </div>
                          <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
                            <div className="flex items-center gap-2 text-[10px] text-gray-500">
                              <span className={lanes.image && shot.image_url ? 'text-emerald-400' : lanes.image ? 'text-gray-500' : 'text-gray-700'}><ImageIcon className="mr-0.5 inline h-3 w-3" />画面</span>
                              <span className={lanes.video && shot.video_url ? 'text-emerald-400' : lanes.video ? 'text-gray-500' : 'text-gray-700'}><Film className="mr-0.5 inline h-3 w-3" />视频</span>
                              <span className={lanes.audio && shot.audio_url ? 'text-emerald-400' : lanes.audio ? 'text-gray-500' : 'text-gray-700'}><Mic className="mr-0.5 inline h-3 w-3" />配音</span>
                            </div>
                            <button
                              type="button"
                              onClick={(event) => { event.stopPropagation(); setActiveShotId(shot.id); onOpenShot(shot.id); }}
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold text-brand-light opacity-70 transition-opacity hover:bg-brand/15 hover:opacity-100"
                            >
                              {hasOutput ? <Play className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                              {hasOutput ? '编辑镜头' : '开始生成'}
                            </button>
                          </div>
                          {queueItem && <div className="flex items-center gap-1 text-[10px] text-brand-light"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />渲染队列：{queueItem.status === 'running' ? '进行中' : queueItem.status === 'queued' ? '排队中' : queueItem.status === 'done' ? '完成' : '失败'}</div>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/** 视频优先展示；加载失败时保留首帧并把失败原因显式显示出来。 */
const ShotVideoPreview: React.FC<{
  videoUrl: string;
  fallbackImageUrl?: string;
  fallbackAspect: string;
}> = ({ videoUrl, fallbackImageUrl, fallbackAspect }) => {
  const [failed, setFailed] = useState(false);
  if (failed && fallbackImageUrl) {
    return (
      <div className="relative">
        <AutoRatioMedia src={fallbackImageUrl} fallbackAspect={fallbackAspect} maxHeight={260} className="w-full" />
        <span className="absolute bottom-2 left-2 rounded-md bg-black/75 px-2 py-1 text-[10px] text-amber-200">视频加载失败，显示首帧</span>
      </div>
    );
  }
  if (failed) {
    return <div className="flex min-h-[190px] w-full items-center justify-center px-4 text-center text-[11px] text-red-300">视频加载失败，请打开详情重试</div>;
  }
  return (
    <AutoRatioMedia
      kind="video"
      src={videoUrl}
      fallbackAspect={fallbackAspect}
      maxHeight={260}
      className="w-full"
      videoProps={{ controls: true, muted: true, playsInline: true, preload: 'metadata', onError: () => setFailed(true) }}
    />
  );
};
