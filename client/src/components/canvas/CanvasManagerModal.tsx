// -*- coding: utf-8 -*-
/**
 * 画布管理面板 — 查看项目全部画布：新建 / 打开 / 重命名 / 删除，
 * 每个画布显示节点数与隶属分镜（shot.canvas_id），删除当前画布自动切到 active。
 */
import React, { useEffect, useState } from 'react';
import { X, Plus, Trash2, Pencil, FolderOpen, Film } from 'lucide-react';
import { apiService } from '../../services/api';
import { useProjectStore } from '../../stores/useProjectStore';

interface CanvasInfo { id: string; name: string; updated_at: string; node_count: number }
interface Props {
  isOpen: boolean;
  onClose: () => void;
  projectId: string | null;
  currentId: string;
  onSwitch: (cid: string, opts?: { skipSave?: boolean }) => void;
  onChanged: () => void;
}

export const CanvasManagerModal: React.FC<Props> = ({ isOpen, onClose, projectId, currentId, onSwitch, onChanged }) => {
  const [list, setList] = useState<CanvasInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const project = useProjectStore((s: any) => s.project);

  const refresh = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const r = await apiService.listProjectCanvases(projectId);
      setList(r.canvases || []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { if (isOpen) { refresh(); setNewName(''); setRenaming(null); } }, [isOpen]);

  if (!isOpen) return null;

  const shotsOf = (cid: string): Array<{ id: string; shot_index: number }> => {
    try {
      const shots = project?.scenes?.flatMap((s: any) => s.shots) || [];
      return shots.filter((s: any) => s.canvas_id === cid).map((s: any) => ({ id: s.id, shot_index: s.shot_index }));
    } catch { return []; }
  };

  const handleCreate = async () => {
    if (!projectId) return;
    const name = newName.trim() || `画布${list.length + 1}`;
    const cid = `cv_${Date.now().toString(36)}`;
    try {
      await apiService.saveProjectCanvas(projectId, { nodes: [], edges: [], version: 2 }, cid, name);
      setNewName('');
      await refresh();
      onChanged();
      onSwitch(cid);
      onClose();
    } catch (e: any) { alert(e.message); }
  };

  const handleRename = async (cid: string) => {
    if (!projectId || !renameValue.trim()) { setRenaming(null); return; }
    try {
      await apiService.renameProjectCanvas(projectId, cid, renameValue.trim());
      setRenaming(null);
      await refresh();
      onChanged();
    } catch (e: any) { alert(e.message); }
  };

  const handleDelete = async (cid: string, name: string) => {
    if (!projectId) return;
    if (list.length <= 1) { alert('至少保留一个画布'); return; }
    if (!confirm(`删除画布「${name}」？节点将丢失，隶属分镜不受影响`)) return;
    try {
      const r: any = await apiService.deleteProjectCanvas(projectId, cid);
      await refresh();
      onChanged();
      if (cid === currentId) onSwitch(r?.active_canvas_id || 'default', { skipSave: true });
      onClose();
    } catch (e: any) { alert(e.message); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-xl max-h-[82vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between bg-surface-secondary/50 shrink-0">
          <span className="text-sm font-bold text-white">画布管理 <span className="text-[10px] text-gray-500 font-normal ml-1">{list.length} 个 · 分镜隶属见各行</span></span>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-3 border-b border-border flex items-center gap-2 shrink-0">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder={`新建画布名称（默认 画布${list.length + 1}）`} className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
          <button onClick={handleCreate} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> 新建</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
          {loading && <div className="text-center text-xs text-gray-500 py-8">加载中…</div>}
          {!loading && list.length === 0 && <div className="text-center text-xs text-gray-500 py-8">暂无画布</div>}
          {list.map(c => {
            const affil = shotsOf(c.id);
            const isCur = c.id === currentId;
            return (
              <div key={c.id} className={`p-3 rounded-xl border transition-all ${isCur ? 'bg-brand/10 border-brand/40' : 'bg-surface-secondary/60 border-border'}`}>
                <div className="flex items-center gap-2">
                  {renaming === c.id ? (
                    <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleRename(c.id); if (e.key === 'Escape') setRenaming(null); }} onBlur={() => handleRename(c.id)} className="flex-1 bg-black/40 border border-brand rounded-lg px-2 py-1 text-xs text-white focus:outline-none" />
                  ) : (
                    <span className="flex-1 text-xs font-bold text-white truncate">{isCur ? '● ' : ''}{c.name}</span>
                  )}
                  <span className="text-[10px] text-gray-500 font-mono">{c.node_count}节点</span>
                  <span className="text-[10px] text-gray-600 font-mono">{c.updated_at || ''}</span>
                </div>
                {affil.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1 flex-wrap text-[10px] text-gray-400">
                    <Film className="w-3 h-3 text-brand-light" />
                    {affil.map(s => <span key={s.id} className="px-1.5 py-0.5 rounded bg-black/40 border border-border font-mono">#{s.shot_index}</span>)}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-1.5">
                  {!isCur && <button onClick={() => { onSwitch(c.id); onClose(); }} className="flex-1 py-1.5 rounded-lg bg-brand/15 border border-brand/30 text-[11px] text-brand-light hover:text-white flex items-center justify-center gap-1"><FolderOpen className="w-3 h-3" /> 打开</button>}
                  {isCur && <span className="flex-1 py-1.5 text-center text-[11px] text-emerald-400 font-bold">当前画布</span>}
                  <button onClick={() => { setRenaming(c.id); setRenameValue(c.name); }} className="px-2.5 py-1.5 rounded-lg bg-surface border border-border text-[11px] text-gray-300 hover:text-white flex items-center gap-1"><Pencil className="w-3 h-3" /> 改名</button>
                  <button onClick={() => handleDelete(c.id, c.name)} disabled={list.length <= 1} className="px-2.5 py-1.5 rounded-lg bg-surface border border-border text-[11px] text-gray-300 hover:text-red-400 disabled:opacity-40 flex items-center gap-1"><Trash2 className="w-3 h-3" /> 删除</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
