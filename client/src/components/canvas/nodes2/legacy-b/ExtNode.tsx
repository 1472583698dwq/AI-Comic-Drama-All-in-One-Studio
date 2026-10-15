// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 换皮：声明式扩展节点 `ext-node`（canvas_nodes 插件前端扩展点，原 nodes/ExtNode.tsx）。
 * 插件只声明 inputs / outputs / params_schema / run，本组件通用渲染：
 * - 端口按声明生成（id = 声明的端口 id，design §6.2 ①：参与连线类型校验，上游值落到声明端口）；
 * - 参数走 params_schema + DynamicControl（保留 x-agent 徽标）；
 * - 运行经宿主 execute（CreativeCanvas → /canvas/node/execute → engine ext-node 分支按端口 id 取输入）。
 * 声明只有一份来源：全局注册表 canvasNodeSpecs（懒取回来的也登记进去，同旧组件第 26 条）。
 */
import { useMemo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconAdjustmentsHorizontal, IconPlayerPlay } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { useKitNodeActions } from '../../kit/hostContext';
import { paramsSchemaToSpecs } from '../../providerSkills';
import { extNodePorts, extSpecOf } from './ports';
import { extIconFor, resultOf } from './model';
import { useDynamicInputStates, useExtSpec, useRunWithInputs } from './hooks';
import { LbAlert, LbButton, LbTag, ParamsSection, PortInputList, ResultView, ShotWriteBack, TextPortInputs } from './ui';

type AnyData = Record<string, any>;
const EMPTY: AnyData = {};

export function ExtNode(props: NodeProps) {
  const d = (props.data || EMPTY) as AnyData;
  const actions = useKitNodeActions(props.id);
  const cid = typeof d.canvas_node_id === 'string' ? d.canvas_node_id : '';
  const { version, state } = useExtSpec(cid);
  // version：懒取的声明登记进注册表后 +1（重算端口）
  const spec = useMemo(() => (version >= 0 ? extSpecOf(d) : null), [d, version]);
  const ports = useMemo(() => (version >= 0 ? extNodePorts(d) : []), [d, version]);
  const states = useDynamicInputStates(props.id, version);
  const paramSpecs = useMemo(() => paramsSchemaToSpecs(spec?.params_schema), [spec]);
  const params = d.params && typeof d.params === 'object' ? (d.params as AnyData) : {};
  const { running, run } = useRunWithInputs(props.id);
  const busy = running || d.agent_state?.status === 'running';
  const result = resultOf(d);
  const textIsInput = ports.some((p) => p.type === 'target' && p.id === 'text');
  const label = (typeof d.label === 'string' && d.label) || spec?.name || '扩展节点';

  return (
    <NodeSkeleton
      node={props}
      label={label}
      icon={extIconFor(spec?.icon)}
      ports={ports}
      width={320}
      toolbar={<ToolbarButton icon={IconPlayerPlay} title="运行节点" loading={busy} disabled={!cid} onClick={() => void run()}>运行</ToolbarButton>}
      downloadUrl={result?.url}
      onFullscreen={result && result.kind !== 'audio' ? () => actions.openFullscreen(result.url, result.kind) : null}
    >
      <div className="cv-lb">
        <div className="cv-lb-row">
          {spec?.kind && <LbTag tone="primary" mono>{spec.kind}</LbTag>}
          <span className="cv-lb-hint cv-lb-mono cv-lb-push" title={props.id}>#{props.id.slice(-4)}</span>
        </div>
        {!spec && state === 'loading' && <div className="cv-lb-hint">正在读取节点声明…</div>}
        {!spec && state !== 'loading' && <LbAlert tone="muted">节点声明不存在（插件可能未启用或已卸载）</LbAlert>}
        {spec?.description && <div className="cv-lb-desc" title={spec.description}>{spec.description}</div>}
        {spec?.run?.extension && <div className="cv-lb-hint cv-lb-mono cv-lb-ellipsis" title={String(spec.run.extension)}>→ {String(spec.run.extension)}</div>}

        <PortInputList ports={ports} states={states} />
        <TextPortInputs ports={ports} states={states} data={d} onChange={(id, v) => actions.update({ [id]: v })} />

        <ParamsSection
          specs={paramSpecs}
          values={params}
          icon={IconAdjustmentsHorizontal}
          onChange={(name, v) => actions.update({ params: { ...params, [name]: v } })}
        />

        <ResultView data={d} textIsInput={textIsInput} />
        <ShotWriteBack nodeId={props.id} nodeType="ext-node" data={d} onUpdate={actions.update} />

        <LbButton variant="primary" block icon={IconPlayerPlay} loading={busy} disabled={!cid} onClick={() => void run()}>
          {busy ? '运行中' : '运行节点'}
        </LbButton>
      </div>
    </NodeSkeleton>
  );
}
