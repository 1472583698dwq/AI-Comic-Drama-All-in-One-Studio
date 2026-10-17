/**
 * 集看板：打开项目后的落点。点一集才进入分镜 / 片场 / 剪辑 / 成片 / 画布。
 */
import React, { useMemo } from 'react';
import { Clapperboard, Film, Plus, Pencil, Trash2, Users } from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { confirmAsync, promptAsync, toast } from '../stores/useDialogStore';
import { scenesInEpisode, shotsInEpisode, UNASSIGNED_EPISODE } from '../utils/episodeScope';

export const EpisodesBoard: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const addEpisode = useProjectStore((s) => s.addEpisode);
  const renameEpisode = useProjectStore((s) => s.renameEpisode);
  const deleteEpisode = useProjectStore((s) => s.deleteEpisode);
  const enterEpisode = useProjectStore((s) => s.enterEpisode);
  const setActiveTab = useProjectStore((s) => s.setActiveTab);

  const episodes = useMemo(
    () => [...((project as any)?.episodes || [])].sort((a: any, b: any) => (a.episode_index || 0) - (b.episode_index || 0)),
    [project],
  );
  const known = useMemo(() => new Set(episodes.map((e: any) => e.id)), [episodes]);
  const unassignedScenes = (project?.scenes || []).filter((s: any) => !s.episode_id || !known.has(s.episode_id));

  const cards = episodes.length === 0
    ? [{ id: UNASSIGNED_EPISODE, title: '未分集', summary: '这部还没有分集，现有场次都在这里。', virtual: true }]
    : [
        ...episodes.map((e: any) => ({ ...e, virtual: false })),
        ...(unassignedScenes.length > 0
          ? [{ id: UNASSIGNED_EPISODE, title: '未分集', summary: '还没归到任何一集的场。', virtual: true }]
          : []),
      ];

  const create = async () => {
    const title = await promptAsync({
      title: '新建一集',
      message: '给这一集起个名字',
      placeholder: `第${episodes.length + 1}集`,
      defaultValue: `第${episodes.length + 1}集`,
      confirmText: '创建',
    });
    if (!title?.trim()) return;
    // addEpisode 会连带建一个空场，进去就能写分镜
    const ep = addEpisode(title.trim());
    if (ep) toast.success(`已新建「${ep.title}」`);
  };

  const rename = async (ep: any) => {
    const title = await promptAsync({
      title: '重命名',
      message: '新的集名',
      defaultValue: ep.title || '',
      confirmText: '保存',
    });
    if (!title?.trim()) return;
    renameEpisode(ep.id, title.trim());
  };

  const remove = async (ep: any) => {
    const ok = await confirmAsync({
      title: '删除这一集',
      message: `删除「${ep.title}」后，里面的场会退回「未分集」，镜头不会被删掉。`,
      isDanger: true,
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    deleteEpisode(ep.id, null);
    toast.success('已删除，场次退回未分集');
  };

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
        请先在项目看板打开一个项目
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-background overflow-hidden">
      <div className="h-14 px-5 border-b border-white/70 dark:border-white/12 flex items-center gap-3 shrink-0">
        <Film className="w-4 h-4 text-brand" />
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-[color:var(--color-text-main)] truncate">{project.title || '未命名项目'}</div>
          <div className="text-[10.5px] text-gray-500">先选一集，再进入分镜、片场和剪辑</div>
        </div>
        <button
          type="button"
          onClick={() => setActiveTab('characters')}
          className="ml-auto px-3 py-1.5 rounded-xl border border-white/70 dark:border-white/12 text-[11.5px] text-gray-200 hover:border-brand flex items-center gap-1"
        >
          <Users className="w-3.5 h-3.5" />角色设定
        </button>
        <button
          type="button"
          onClick={create}
          className="px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" />新建一集
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-5xl">
          {cards.map((ep: any) => {
            const scenes = scenesInEpisode(project, ep.id);
            const shots = shotsInEpisode(project, ep.id);
            const done = shots.filter((s: any) => s.image_url || s.video_url).length;
            const cover = shots.find((s: any) => s.image_url)?.image_url;
            return (
              <div key={ep.id} className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 overflow-hidden flex flex-col">
                <button type="button" onClick={() => enterEpisode(ep.id)} className="text-left flex-1">
                  <div className="h-28 bg-surface-hover/80 flex items-center justify-center overflow-hidden">
                    {cover
                      ? <img src={cover} alt="" className="w-full h-full object-cover" />
                      : <Clapperboard className="w-8 h-8 text-gray-600" />}
                  </div>
                  <div className="px-3.5 py-3">
                    <div className="text-[13px] font-bold text-[color:var(--color-text-main)] truncate">
                      {ep.virtual ? ep.title : (ep.title || `第${ep.episode_index}集`)}
                    </div>
                    <div className="mt-1 text-[11px] text-gray-500">
                      {scenes.length} 场 · {shots.length} 镜 · 已有画面 {done}
                    </div>
                    {ep.summary && <div className="mt-1 text-[11px] text-gray-400 line-clamp-2">{ep.summary}</div>}
                  </div>
                </button>
                {!ep.virtual && (
                  <div className="px-3 pb-3 flex items-center gap-1.5">
                    <button type="button" onClick={() => rename(ep)} className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 text-[11px] text-gray-300 flex items-center gap-1">
                      <Pencil className="w-3 h-3" />改名
                    </button>
                    <button type="button" onClick={() => remove(ep)} className="px-2 py-1 rounded-lg border border-red-500/30 text-[11px] text-red-300 flex items-center gap-1">
                      <Trash2 className="w-3 h-3" />删除
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
