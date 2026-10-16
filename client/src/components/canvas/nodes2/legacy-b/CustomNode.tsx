// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 换皮：自定义代码节点 `custom`（原 nodes/CustomNode.tsx）。
 * 一段代码即一节点（视频超分 / 风格迁移…）：选节点 → 端口按其 input_schema 生成（design §6.2 ②：注册端口与渲染端口同源）→
 * 参数走 params_schema + DynamicControl（保留 x-agent 徽标）→ 运行经宿主 execute。
 * 数据键沿用：custom_node_id / definition / params / 端口同名输入键 / image_url·video_url·audio_url·text / agent_state / shotId。
 */
import { useEffect, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconAdjustmentsHorizontal, IconPlayerPlay } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { useKitNodeActions } from '../../kit/hostContext';
import { paramsSchemaToSpecs } from '../../providerSkills';
import { loadCustomNodeDef, loadCustomNodeList, type CustomNodeDefinition } from './customNodeDefs';
import { customDefOf, customNodePorts } from './ports';
import { resultOf } from './model';
import { useCustomNodeDefsVersion, useDynamicInputStates, useRunWithInputs } from './hooks';
import { LbAlert, LbButton, LbSelect, LbTag, ParamsSection, PortInputList, ResultView, ShotWriteBackButton, TextPortInputs } from './ui';

type AnyData = Record<string, any>;

const EMPTY: AnyData = {};

export function CustomNode(props: NodeProps) {
  const d = (props.data || EMPTY) as AnyData;
  const actions = useKitNodeActions(props.id);
  const cid = typeof d.custom_node_id === 'string' ? d.custom_node_id : '';
  const version = useCustomNodeDefsVersion();

  // 节点列表（下拉）：功能开关 canvas_custom_nodes 关闭时后端 404
  const [options, setOptions] = useState<CustomNodeDefinition[]>([]);
  const [listError, setListError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = (refresh?: boolean) => loadCustomNodeList({ refresh })
      .then((list) => { if (alive) { setOptions(list); setListError(''); } })
      .catch((e) => { if (alive) setListError(e instanceof Error ? e.message : String(e)); });
    void load();
    const onRefresh = () => void load(true);
    window.addEventListener('customnode-list-refresh', onRefresh);
    return () => {
      alive = false;
      window.removeEventListener('customnode-list-refresh', onRefresh);
    };
  }, []);
  useEffect(() => { if (cid) void loadCustomNodeDef(cid); }, [cid]);

  // version：定义缓存登记后 +1（定义晚到时重算）
  const def = useMemo(() => (version >= 0 ? customDefOf(d) : null), [d, version]);
  const ports = useMemo(() => (version >= 0 ? customNodePorts(d) : []), [d, version]);
  const states = useDynamicInputStates(props.id, version);
  const paramSpecs = useMemo(() => paramsSchemaToSpecs(def?.params_schema), [def]);
  const params = d.params && typeof d.params === 'object' ? (d.params as AnyData) : {};
  const { running, run } = useRunWithInputs(props.id);
  const busy = running || d.agent_state?.status === 'running';
  const result = resultOf(d);
  const textIsInput = ports.some((p) => p.type === 'target' && p.id === 'text');
  const label = (typeof d.label === 'string' && d.label) || def?.name || '自定义节点';

  return (
    <NodeSkeleton
      node={props}
      label={label}
      ports={ports}
      width={320}
      toolbar={(
        <>
          <ToolbarButton icon={IconPlayerPlay} title="运行节点" loading={busy} disabled={!cid} onClick={() => void run()}>运行</ToolbarButton>
          {/* FX-2：回写分镜放进工具栏弹层，不再在卡片里出结果后多出一段 */}
          <ShotWriteBackButton nodeId={props.id} nodeType="custom" data={d} onUpdate={actions.update} disabled={busy} />
        </>
      )}
      downloadUrl={result?.url}
      onFullscreen={result && result.kind !== 'audio' ? () => actions.openFullscreen(result.url, result.kind) : null}
    >
      <div className="cv-lb">
        <div className="cv-lb-row">
          {def?.kind && <LbTag tone="primary" mono>{def.kind}</LbTag>}
          {def?.language && <LbTag mono>{def.language}</LbTag>}
          <span className="cv-lb-hint cv-lb-mono cv-lb-push" title={props.id}>#{props.id.slice(-4)}</span>
        </div>
        <LbSelect
          aria-label="选择自定义节点"
          value={cid}
          onChange={(e) => actions.update({ custom_node_id: e.target.value, definition: undefined })}
        >
          <option value="">选择自定义节点…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}（{o.kind}/{o.language}）</option>)}
          {cid && !options.some((o) => o.id === cid) && <option value={cid}>{def?.name || cid}</option>}
        </LbSelect>
        {listError && <LbAlert tone="muted">自定义节点列表不可用：{listError}</LbAlert>}
        {def?.description && <div className="cv-lb-desc" title={def.description}>{def.description}</div>}

        <PortInputList ports={ports} states={states} />
        <TextPortInputs ports={ports} states={states} data={d} onChange={(id, v) => actions.update({ [id]: v })} />

        <ParamsSection
          specs={paramSpecs}
          values={params}
          icon={IconAdjustmentsHorizontal}
          onChange={(name, v) => actions.update({ params: { ...params, [name]: v } })}
        />

        {/* FX-2：固定高度的产出框，绑定后就占位，出结果前后卡片高度不变 */}
        <ResultView data={d} textIsInput={textIsInput} reserve={!!cid} />

        <LbButton variant="primary" block icon={IconPlayerPlay} loading={busy} disabled={!cid} onClick={() => void run()}>
          {busy ? '运行中' : '运行节点'}
        </LbButton>
      </div>
    </NodeSkeleton>
  );
}
