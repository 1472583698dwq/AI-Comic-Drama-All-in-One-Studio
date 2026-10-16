// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：导出草稿 `export`（原 nodes/MinimalNodes.tsx 的 ExportNode，进工具栏）。
 *
 * 逻辑不变：video / audio 两个输入口（后端 engine 聚合上游视频 / 音频 / 图片透传）；
 * 「配置导出选项」派发全局事件 `open-export-modal`（App 监听后写 modalIntents.exportOpen 打开 ExportModal，同旧组件）；
 * 节点被 Agent 会话关注时显示「会话」标签（useCanvasStore.agentFocusNodeIds，旧 AgentShell 同款）。
 * 旧 AgentShell 的「复制」浮条、「+ 衍生」按钮、#id 角标属于旧外壳：复制 / 创建副本改由 kit 右键菜单提供，
 * 衍生由拖线到空白处的菜单提供（本节点没有输出口，旧的「+ 衍生」连出的线本就无口可接）。
 * 换皮：NodeSkeleton / NodeHandles（见 ports.EXPORT_PORTS）/ --cv-* / Tabler。
 */
import type { NodeProps } from '@xyflow/react';
import { IconFileExport, IconSettings } from '@tabler/icons-react';
import { useCanvasStore } from '../../../../stores/useCanvasStore';
import { NodeSkeleton, ToolbarButton } from '../../kit';
import { LaButton, LaChip } from './ui';
import { openExportModal } from './helpers';

export const EXPORT_TYPE = 'export';
export const EXPORT_WIDTH = 220;

export function ExportNode(props: NodeProps) {
  const inSession = useCanvasStore((s) => s.agentFocusNodeIds.includes(props.id));
  return (
    <NodeSkeleton
      node={props}
      icon={IconFileExport}
      width={EXPORT_WIDTH}
      toolbar={<ToolbarButton icon={IconSettings} title="配置导出选项" onClick={openExportModal}>配置导出选项</ToolbarButton>}
    >
      <div className="cv-la">
        <div className="cv-la-row cv-la-row--between">
          <LaChip tone="accent" className="cv-la-mono"><span>剪映 Draft</span></LaChip>
          {inSession && <LaChip tone="accent" title="已加入会话：Agent 会把「这个节点」默认理解为它"><span>会话</span></LaChip>}
        </div>
        <div className="cv-la-hero">
          <IconFileExport size={32} stroke={1.5} aria-hidden />
          <span className="cv-la-strong">剪映草稿一键生成</span>
          <span className="cv-la-tiny cv-la-text-3">自动聚合上游所有镜头的视频轨、音频轨与台词字幕</span>
        </div>
        <LaButton variant="primary" size="sm" block onClick={openExportModal}>配置导出选项</LaButton>
      </div>
    </NodeSkeleton>
  );
}

export default ExportNode;
