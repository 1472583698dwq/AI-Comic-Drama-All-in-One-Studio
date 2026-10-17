import React, { useMemo, useState } from 'react';
import { Clapperboard, Layers, ListOrdered, Pencil, Plus, Settings2, Trash2, X } from 'lucide-react';
import { useProjectStore } from '../../../stores/useProjectStore';
import { confirmAsync, promptAsync, toast } from '../../../stores/useDialogStore';

/**
 * 分集条（分镜台顶部）：选集筛选 + 分集管理入口。
 * - 归属写在 Scene.episode_id；'all' = 不分集视角，'none' = 未分集。
 * - 管理弹窗内可：新建/重命名/删除分集，以及逐场设置归属。
 */
interface Props {
  activeEpisodeId: string; // 'all' | 'none' | episode_id
  onChange: (id: string) => void;
}

export const EpisodeBar: React.FC<Props> = ({ activeEpisodeId, onChange }) => {
  const { project, addEpisode, renameEpisode, deleteEpisode, assignScenesToEpisode, autoSplitEpisodes } = useProjectStore();
  const [manageOpen, setManageOpen] = useState(false);

  const episodes = useMemo(
    () => [...((project as any)?.episodes || [])].sort((a: any, b: any) => (a.episode_index || 0) - (b.episode_index || 0)),
    [project],
  );
  const scenes = useMemo(
    () => [...(project?.scenes || [])].sort((a: any, b: any) => (a.scene_index || 0) - (b.scene_index || 0)),
    [project],
  );
  const unassignedCount = scenes.filter((s: any) => !s.episode_id || !episodes.some((e: any) => e.id === s.episode_id)).length;
  const knownIds = new Set(episodes.map((e: any) => e.id));
  const countShots = (sceneList: any[]) => sceneList.reduce((n, s) => n + (s.shots?.length || 0), 0);
  const shotsOfEpisode = (epId: string) => countShots(scenes.filter((s: any) => s.episode_id === epId));
  const shotCountOfScene = (s: any) => s.shots?.length || 0;

  const handleAddEpisode = async () => {
    const ep = addEpisode();
    if (ep) {
      onChange(ep.id);
      toast.success(`已新建「${ep.title}」，并配了一个空场，直接「新建分镜」即可`);
    }
  };

  const handleAutoSplit = async () => {
    const raw = await promptAsync({ title: '均分分集', message: `把当前 ${scenes.length} 个场按顺序均分为几集？（会重建全部分集归属）`, placeholder: '如 4', defaultValue: '2', confirmText: '均分' });
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (!n || n < 1) { toast.warning('请输入有效的集数'); return; }
    if (n > scenes.length) { toast.warning(`集数不能超过场数（${scenes.length}）`); return; }
    autoSplitEpisodes(n);
    const first = (useProjectStore.getState().project as any)?.episodes?.[0];
    if (first?.id) onChange(first.id);
    toast.success(`已均分为 ${n} 集`);
  };

  if (!project) return null;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/70 dark:border-white/12 bg-surface/60 backdrop-blur shrink-0 overflow-x-auto">
        <span className="flex items-center gap-1 text-[11px] text-gray-500 shrink-0"><ListOrdered className="w-3.5 h-3.5" />分集</span>
        {episodes.length === 0 ? (
          <span className="text-[11px] text-gray-500">未分集（点击右侧「新建分集」或「均分」开始）</span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => useProjectStore.getState().leaveEpisode()}
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold shrink-0 bg-surface-secondary/80 text-gray-300 hover:text-white border border-border"
            >
              返回集看板
            </button>
            {episodes.map((ep: any) => (
              <button
                key={ep.id}
                onClick={() => onChange(ep.id)}
                title={`${ep.title} · ${scenes.filter((s: any) => s.episode_id === ep.id).length}场 ${shotsOfEpisode(ep.id)}镜`}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold shrink-0 transition-colors ${activeEpisodeId === ep.id ? 'bg-brand text-white' : 'bg-surface-secondary/80 text-gray-400 hover:text-white border border-border'}`}
              >
                {ep.title} {shotsOfEpisode(ep.id)}镜
              </button>
            ))}
            {unassignedCount > 0 && (
              <button
                onClick={() => onChange('none')}
                title={`未分集：${unassignedCount} 场`}
                className={`px-2.5 py-1 rounded-full text-[11px] shrink-0 transition-colors ${activeEpisodeId === 'none' ? 'bg-brand text-white' : 'bg-surface-secondary/80 text-gray-500 hover:text-white border border-dashed border-gray-500/40'}`}
              >
                未分集 {unassignedCount}场
              </button>
            )}
          </>
        )}
        <div className="flex-1" />
        <button onClick={handleAddEpisode} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] text-gray-300 hover:text-white bg-surface-secondary/80 border border-border shrink-0" title="新建分集">
          <Plus className="w-3 h-3" />新建分集
        </button>
        <button onClick={handleAutoSplit} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] text-gray-300 hover:text-white bg-surface-secondary/80 border border-border shrink-0" title="把所有场按顺序均分为 N 集" disabled={scenes.length === 0}>
          <Layers className="w-3 h-3" />均分
        </button>
        <button onClick={() => setManageOpen(true)} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] text-gray-300 hover:text-white bg-surface-secondary/80 border border-border shrink-0" title="分集管理">
          <Settings2 className="w-3 h-3" />管理
        </button>
      </div>

      {manageOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setManageOpen(false)}>
          <div className="bg-surface border border-border rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
              <h3 className="text-sm font-bold text-white flex items-center gap-2"><Clapperboard className="w-4 h-4 text-brand" />分集管理</h3>
              <button onClick={() => setManageOpen(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* 分集列表 */}
              <div>
                <div className="text-xs font-semibold text-white mb-2">分集（{episodes.length}）</div>
                {episodes.length === 0 && <div className="text-[11px] text-gray-500">还没有分集：先「新建分集」，再在下方把场归到对应分集。</div>}
                <div className="space-y-1">
                  {episodes.map((ep: any) => (
                    <div key={ep.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-surface-secondary/70 border border-border">
                      <span className="text-[11px] text-gray-500 font-mono w-8 shrink-0">#{ep.episode_index}</span>
                      <span className="flex-1 text-xs text-white truncate">{ep.title}</span>
                      <span className="text-[10px] text-gray-500 shrink-0">
                        {scenes.filter((s: any) => s.episode_id === ep.id).length}场 · {shotsOfEpisode(ep.id)}镜
                      </span>
                      <button
                        onClick={async () => {
                          const raw = await promptAsync({ title: '重命名分集', message: '新标题', defaultValue: ep.title, confirmText: '保存' });
                          if (raw && raw.trim()) renameEpisode(ep.id, raw.trim());
                        }}
                        className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white" title="重命名"
                      ><Pencil className="w-3 h-3" /></button>
                      <button
                        onClick={async () => {
                          const ok = await confirmAsync({ title: '删除分集', message: `删除「${ep.title}」？其下的场不会被删除，只会变为未分集。`, isDanger: true, confirmText: '删除', cancelText: '取消' });
                          if (ok) {
                            deleteEpisode(ep.id);
                            if (activeEpisodeId === ep.id) onChange('none');
                            toast.success('分集已删除（场已变为未分集）');
                          }
                        }}
                        className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-300" title="删除（场保留）"
                      ><Trash2 className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              </div>

              {/* 场归属 */}
              <div>
                <div className="text-xs font-semibold text-white mb-2">场归属（{scenes.length} 场，{unassignedCount} 未分集）</div>
                {scenes.length === 0 && <div className="text-[11px] text-gray-500">项目还没有场。</div>}
                <div className="space-y-1">
                  {scenes.map((s: any) => {
                    const valid = s.episode_id && knownIds.has(s.episode_id);
                    return (
                      <div key={s.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-surface-secondary/70 border border-border">
                        <span className="text-[11px] text-gray-500 font-mono w-12 shrink-0">场{s.scene_index}</span>
                        <span className="flex-1 text-xs text-gray-300 truncate">{s.title || '—'}</span>
                        <span className="text-[10px] text-gray-500 shrink-0">{shotCountOfScene(s)}镜</span>
                        <select
                          value={valid ? s.episode_id : ''}
                          onChange={(e) => assignScenesToEpisode([Number(s.scene_index)], e.target.value || null)}
                          className="bg-surface border border-border rounded-lg px-1.5 py-0.5 text-[11px] text-gray-200 focus:outline-none focus:border-brand shrink-0"
                        >
                          <option value="">未分集</option>
                          {episodes.map((ep: any) => <option key={ep.id} value={ep.id}>{ep.title}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="p-3 border-t border-border flex items-center justify-end gap-2 shrink-0">
              <button onClick={handleAddEpisode} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold"><Plus className="w-3.5 h-3.5" />新建分集</button>
              <button onClick={() => setManageOpen(false)} className="px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-white">完成</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
