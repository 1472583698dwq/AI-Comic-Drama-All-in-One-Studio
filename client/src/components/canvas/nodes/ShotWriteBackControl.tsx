// -*- coding: utf-8 -*-
/**
 * 结果回写分镜控件（画布任意节点复用）
 * 结果字段映射与写入统一走 shotWriteBack；目标镜可来自节点归属（分镜跳转时写入）或手动选择。
 * 覆盖已有结果前会确认，旧值由 updateShot 自动进 history 可回退。
 */
import React, { useMemo, useState } from 'react';
import { CornerUpLeft } from 'lucide-react';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useCanvasStore } from '../../../stores/useCanvasStore';
import { confirmAsync, toast } from '../../../stores/useDialogStore';
import { collectNodeResults, findShot, listShotOptions, nodeShotId, shotDisplayName, writeBackToShot, type NodeResultOption } from '../shotWriteBack';

export const ShotWriteBackControls: React.FC<{ nodeId: string; nodeType: string; data: any }> = ({ nodeId, nodeType, data }) => {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const project = useProjectStore((s) => s.project);
  const linkedShotId = nodeShotId(data);
  const [targetShotId, setTargetShotId] = useState<string>(linkedShotId);
  // 节点切换/归属变化时重置目标镜（渲染期派生，避免 effect 级联渲染）
  const linkKey = `${nodeId}::${linkedShotId}`;
  const [lastLinkKey, setLastLinkKey] = useState<string>(linkKey);
  if (linkKey !== lastLinkKey) {
    setLastLinkKey(linkKey);
    setTargetShotId(linkedShotId);
  }
  const shotOptions = useMemo(() => listShotOptions(project), [project]);
  const results = useMemo(() => collectNodeResults(nodeType, data), [nodeType, data]);
  const targetShot = useMemo(() => findShot(project, targetShotId), [project, targetShotId]);

  if (!results.length) return null;

  const handleWriteBack = async (res: NodeResultOption) => {
    const sid = targetShotId || linkedShotId;
    if (!sid) { toast.warning('请先选择要回写的分镜'); return; }
    const shot = findShot(project, sid);
    if (!shot) { toast.error('目标分镜不存在（可能已删除）'); return; }
    const current = (shot as any)[res.field];
    if (current && current !== res.value) {
      const ok = await confirmAsync({
        title: '覆盖分镜结果',
        message: `${shotDisplayName(shot)} 已有${res.label}，确认用画布结果覆盖？（旧值自动进入历史，可在分镜里回退）`,
        confirmText: '覆盖回写',
        isDanger: true,
      });
      if (!ok) return;
    }
    const r = writeBackToShot({ shotId: sid, field: res.field, value: res.value });
    if (!r.ok) { toast.error(r.error || '回写失败'); return; }
    if (!linkedShotId) updateNodeData(nodeId, { shotId: sid });
    toast.success(`已回写 ${shotDisplayName(shot)} · ${res.label}`);
  };

  return (
    <div className="rounded-xl bg-surface-secondary border border-white/10 p-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-300">
        <CornerUpLeft className="w-3 h-3" /> 回写到分镜
        {linkedShotId && targetShot && <span className="text-[10px] font-normal text-white/40">· 已关联 {shotDisplayName(targetShot)}</span>}
      </div>
      <select value={targetShotId} onChange={(e) => setTargetShotId(e.target.value)} className="w-full bg-surface border border-white/15 rounded-lg px-2 py-1 text-[11px] text-white/90 focus:outline-none focus:border-emerald-500">
        <option value="">选择目标分镜…</option>
        {shotOptions.map((s) => (
          <option key={s.id} value={s.id}>{s.label}{s.hasVideo ? ' ·已有视频' : s.hasImage ? ' ·已有图' : ''}{s.hasAudio ? ' ·已有配音' : ''}</option>
        ))}
      </select>
      <div className="flex flex-wrap gap-1.5">
        {results.map((r, i) => (
          <button
            key={`${r.field}-${i}`}
            onClick={() => handleWriteBack(r)}
            disabled={!targetShot}
            className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-40 disabled:pointer-events-none border border-emerald-500/30 text-emerald-300 text-[10px] font-bold flex items-center gap-1"
            title={`把该结果写入 ${targetShot ? shotDisplayName(targetShot) : '所选分镜'}（覆盖前会确认，旧值进历史）`}
          >
            <CornerUpLeft className="w-2.5 h-2.5" /> 回写{r.label}
          </button>
        ))}
      </div>
      {!targetShot && <div className="text-[10px] text-amber-300/80">{linkedShotId ? '节点所属分镜不存在（可能已删除），请重新选择目标分镜' : '选择目标分镜后即可回写（节点无归属时不改动分镜）'}</div>}
    </div>
  );
};
