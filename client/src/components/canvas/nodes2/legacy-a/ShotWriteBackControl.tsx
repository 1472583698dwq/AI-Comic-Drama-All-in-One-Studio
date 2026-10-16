// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：结果回写分镜控件（原 nodes/ShotWriteBackControl.tsx，画布任意节点复用）。
 * 逻辑不变：结果字段映射与写入统一走 shotWriteBack；目标镜来自节点归属（分镜跳转时写入）或手动选择；
 * 覆盖已有结果前确认，旧值由 updateShot 自动进 history 可回退；无归属节点回写后记住 shotId。
 * 外观改 Toonflow + --cv-* 变量；写节点数据优先走宿主 updateNodeData（CanvasHostProvider），
 * 不依赖 React Flow 上下文（宿主的节点控制台等画布外位置也能用）。
 */
import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconCornerUpLeft } from '@tabler/icons-react';
import { useProjectStore } from '../../../../stores/useProjectStore';
import { useCanvasStore } from '../../../../stores/useCanvasStore';
import { confirmAsync, toast } from '../../../../stores/useDialogStore';
import {
  collectNodeResults, findShot, listShotOptions, nodeShotId, shotDisplayName, writeBackToShot, type NodeResultOption,
} from '../../shotWriteBack';
import { useCanvasHost } from '../../kit';
import { LaButton, LaSelect } from './ui';
import { NO_CANVAS, interactiveGuards } from './helpers';

export interface ShotWriteBackControlsProps {
  nodeId: string;
  nodeType: string;
  data: Record<string, unknown> | null | undefined;
  /** 写节点数据（记住 shotId）；缺省：宿主 updateNodeData → 旧 canvas store。 */
  onUpdate?: (patch: Record<string, unknown>) => void;
}

export function ShotWriteBackControls({ nodeId, nodeType, data, onUpdate }: ShotWriteBackControlsProps) {
  const host = useCanvasHost();
  const project = useProjectStore((s) => s.project);
  const linkedShotId = nodeShotId(data);
  const [targetShotId, setTargetShotId] = useState<string>(linkedShotId);
  // 节点切换 / 归属变化时重置目标镜（渲染期派生，避免 effect 级联渲染）
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

  const update = (patch: Record<string, unknown>) => {
    if (onUpdate) onUpdate(patch);
    else if (host.updateNodeData) host.updateNodeData(nodeId, patch);
    else useCanvasStore.getState().updateNodeData(nodeId, patch);
  };

  const handleWriteBack = async (res: NodeResultOption) => {
    const sid = targetShotId || linkedShotId;
    if (!sid) { toast.warning('请先选择要回写的分镜'); return; }
    const shot = findShot(project, sid);
    if (!shot) { toast.error('目标分镜不存在（可能已删除）'); return; }
    const current = (shot as Record<string, unknown>)[res.field];
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
    if (!linkedShotId) update({ shotId: sid });
    toast.success(`已回写 ${shotDisplayName(shot)} · ${res.label}`);
  };

  return (
    <div className={`cv-la cv-la-panel ${NO_CANVAS}`} {...interactiveGuards}>
      <div className="cv-la-row cv-la-small">
        <IconCornerUpLeft size={14} className="cv-la-accent" aria-hidden />
        <span className="cv-la-strong">回写到分镜</span>
        {linkedShotId && targetShot && <span className="cv-la-text-3 cv-la-tiny cv-la-truncate">· 已关联 {shotDisplayName(targetShot)}</span>}
      </div>
      <LaSelect
        aria-label="目标分镜"
        value={targetShotId}
        onChange={(e) => setTargetShotId(e.target.value)}
        placeholder="选择目标分镜…"
        options={shotOptions.map((s) => ({
          value: s.id,
          label: `${s.label}${s.hasVideo ? ' ·已有视频' : s.hasImage ? ' ·已有图' : ''}${s.hasAudio ? ' ·已有配音' : ''}`,
        }))}
      />
      <div className="cv-la-row cv-la-row--wrap">
        {results.map((r, i) => (
          <LaButton
            key={`${r.field}-${i}`}
            size="xs"
            icon={IconCornerUpLeft}
            disabled={!targetShot}
            onClick={() => void handleWriteBack(r)}
            title={`把该结果写入 ${targetShot ? shotDisplayName(targetShot) : '所选分镜'}（覆盖前会确认，旧值进历史）`}
          >
            回写{r.label}
          </LaButton>
        ))}
      </div>
      {!targetShot && (
        <div className="cv-la-row cv-la-tiny cv-la-text-2">
          <IconAlertTriangle size={12} aria-hidden />
          <span>{linkedShotId ? '节点所属分镜不存在（可能已删除），请重新选择目标分镜' : '选择目标分镜后即可回写（节点无归属时不改动分镜）'}</span>
        </div>
      )}
    </div>
  );
}

export default ShotWriteBackControls;
