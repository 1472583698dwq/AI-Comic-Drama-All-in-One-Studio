import React from 'react';
import { Boxes, Wand2 } from 'lucide-react';
import { WorkbenchRow } from '../../components/canvas/WorkbenchRow';
import { useCanvasPalette } from '../canvasPaletteBridge';

/**
 * 画布调色板里**插件贡献的两类节点行**（设计 §12 规则 1 / 2）：
 *   · `CustomNodeRow` —— `custom_nodes`（自定义代码节点，沙箱执行；受 feature `canvas_custom_nodes` 闸，
 *     关闸时宿主根本不会注册这些条目，调色板只留一行「已在设置 → 功能开关里关闭」的提示）；
 *   · `ExtNodeRow`    —— `canvas_nodes`（声明式扩展节点）。
 *
 * 两个组件都由适配器在注册时用闭包绑定原始声明（`spec`），「加节点」则交给宿主注入的
 * `createNode` —— 位置（`freePosition`）、节点 state、选中逻辑都只有宿主知道。
 * 拖拽载荷的两个键是画布落地契约（宿主读 `application/canvas-nodetype` / `canvas-nodeid`）。
 */

export const CustomNodeRow: React.FC<{ spec: any }> = ({ spec }) => {
  const { createNode } = useCanvasPalette();
  return (
    <WorkbenchRow
      icon={Boxes}
      iconCls="text-teal-400"
      label={spec.name}
      desc={`${spec.kind}/${spec.language}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/canvas-nodetype', 'custom')}
      title="自定义节点：拖入画布，或点击直接创建"
      onClick={() => createNode('custom', { custom_node_id: spec.id })}
    />
  );
};

export const ExtNodeRow: React.FC<{ spec: any }> = ({ spec }) => {
  const { createNode } = useCanvasPalette();
  return (
    <WorkbenchRow
      icon={Wand2}
      iconCls="text-cyan-400"
      label={spec.name}
      desc={`${(spec.inputs || []).length}入/${(spec.outputs || []).length}出`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/canvas-nodetype', 'ext-node');
        e.dataTransfer.setData('application/canvas-nodeid', spec.id);
      }}
      title={`扩展节点（canvas_nodes）· ${spec.kind || 'utility'}：拖入画布，或点击直接创建`}
      onClick={() => createNode('ext-node', { canvas_node_id: spec.id, definition: spec })}
    />
  );
};

export default CustomNodeRow;
