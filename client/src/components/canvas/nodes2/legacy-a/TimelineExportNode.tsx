// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：剪映导出 `timeline-export`（原 nodes/TimelineExportNode.tsx，兼容旧画布，不进工具栏）。
 *
 * 逻辑不变：分镜数据优先取上游写入的 `_upstream.project | _upstream.content`（带 scenes 的整份项目），否则当前项目；
 * 没有分镜给出提示；有则 apiService.exportJianYingDraft(project) → 结果写 data.lastResult 并展示
 * （镜数、时长、草稿目录、已同步剪映本地路径、前两条告警）。
 * 换皮：NodeSkeleton / NodeHandles（分镜 / 视频 / 音频三个输入，见 ports.TIMELINE_EXPORT_PORTS）/ --cv-* / Tabler。
 */
import { useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconAlertCircle, IconAlertTriangle, IconClock, IconDownload, IconMovie } from '@tabler/icons-react';
import { apiService } from '../../../../services/api';
import { useProjectStore } from '../../../../stores/useProjectStore';
import { NodeSkeleton, ToolbarButton, useKitNodeActions } from '../../kit';
import { LaButton, LaChip, LaNotice } from './ui';
import { EMPTY_DATA, errorMessage } from './helpers';

export const TIMELINE_EXPORT_TYPE = 'timeline-export';
export const TIMELINE_EXPORT_WIDTH = 360;
export const NO_SHOTS_MESSAGE = '无项目分镜数据：请先通过 简报→拆解→分镜卡 流程生成，或在画布中导出为分镜后重试';

export interface JianyingExportResult {
  total_shots?: number;
  duration_seconds?: number;
  export_dir?: string;
  jianyin_native_path?: string;
  warnings?: string[];
  [k: string]: unknown;
}

export interface TimelineExportData extends Record<string, unknown> {
  label?: string;
  lastResult?: JianyingExportResult | null;
  _upstream?: { project?: unknown; content?: unknown; [k: string]: unknown };
}

type ProjectLike = { scenes?: unknown[] };

export function TimelineExportNode(props: NodeProps) {
  const { id } = props;
  const d = (props.data || EMPTY_DATA) as TimelineExportData;
  const actions = useKitNodeActions(id);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = d.lastResult || null;

  const handleExport = async () => {
    const { project } = useProjectStore.getState();
    // 优先用画布上游聚合的分镜（script-split 全量），其次用当前项目
    let proj = project as ProjectLike | null;
    const upProj = (d._upstream?.project || d._upstream?.content) as ProjectLike | undefined;
    if (upProj && upProj.scenes) proj = upProj;
    if (!proj || !proj.scenes?.length) {
      setError(NO_SHOTS_MESSAGE);
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const res = await apiService.exportJianYingDraft(proj as Parameters<typeof apiService.exportJianYingDraft>[0]);
      actions.update({ lastResult: res });
    } catch (e) {
      setError(errorMessage(e, '导出失败'));
    } finally {
      setExporting(false);
    }
  };

  const warnings = Array.isArray(result?.warnings) ? result!.warnings : [];

  return (
    <NodeSkeleton
      node={props}
      icon={IconMovie}
      width={TIMELINE_EXPORT_WIDTH}
      toolbar={<ToolbarButton icon={IconDownload} title="一键导出剪映草稿" loading={exporting} onClick={() => void handleExport()}>导出剪映草稿</ToolbarButton>}
    >
      <div className="cv-la">
        <div className="cv-la-row cv-la-row--between">
          <span className="cv-la-small cv-la-strong">时间线 / 剪映导出</span>
          <LaChip className="cv-la-mono"><span>Jianying Draft</span></LaChip>
        </div>
        <p className="cv-la-p cv-la-small cv-la-text-2">
          聚合上游分镜的 <b>画面/视频</b>、<b>配音</b>、<b>字幕</b> 一键生成剪映官方草稿（pyJianYingDraft 多轨）。
        </p>
        {error && <LaNotice tone="danger" icon={IconAlertCircle} role="alert">{error}</LaNotice>}
        {result && (
          <LaNotice tone="accent" role="status">
            <div className="cv-la-row cv-la-strong">
              <IconClock size={12} aria-hidden />
              <span>导出成功 · {result.total_shots} 镜 · {result.duration_seconds}s</span>
            </div>
            <div className="cv-la-text-2">
              草稿目录：<span className="cv-la-mono cv-la-break">{result.export_dir}</span>
            </div>
            {result.jianyin_native_path && <div>已同步至剪映本地：{result.jianyin_native_path}</div>}
            {warnings.length > 0 && (
              <div className="cv-la-row cv-la-danger" style={{ alignItems: 'flex-start' }}>
                <IconAlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden />
                <span>{warnings.slice(0, 2).join('； ')}</span>
              </div>
            )}
          </LaNotice>
        )}
        <LaButton variant="primary" block icon={IconDownload} loading={exporting} onClick={() => void handleExport()}>
          {exporting ? '导出中…' : '一键导出剪映草稿'}
        </LaButton>
        <p className="cv-la-p cv-la-tiny cv-la-text-3 cv-la-center">需已配置剪映草稿目录（设置→JIANYIN_DRAFT_PATH）才可在剪映客户端直接打开</p>
      </div>
    </NodeSkeleton>
  );
}

export default TimelineExportNode;
