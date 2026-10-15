// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 换皮：灵感简报 `brief` + 剧本拆解 `script-split`（原 nodes/BriefNode.tsx）。
 * 类型 id、数据键（brief / style_preset / aspect_ratio / result / error / loading）与端口 id 不变；
 * 外壳换 NodeSkeleton，执行改走 useKitNodeActions(id).execute（宿主原有分支 → /canvas/node/execute → engine script-split）。
 */
import { useMemo, useState } from 'react';
import { useReactFlow, type NodeProps } from '@xyflow/react';
import { IconPlayerPlay, IconSparkles } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { useKitNodeActions } from '../../kit/hostContext';
import { useNodeReferences } from '../../kit/useNodeReferences';
import { toast } from '../../../../stores/useDialogStore';
import { BRIEF_PORTS, SCRIPT_SPLIT_PORTS } from './ports';
import { BRIEF_RATIOS, DEFAULT_RATIO, DEFAULT_STYLE, STYLE_PRESETS, scriptResultSummary, styleLabel, textDownloadUrl } from './model';
import { usePolish } from './hooks';
import { LbAlert, LbButton, LbSelect, LbTag, LbTextarea } from './ui';

type AnyData = Record<string, any>;

// ───────────────────────────── 灵感简报 ─────────────────────────────

const EMPTY: AnyData = {};

export function BriefNode(props: NodeProps) {
  const d = (props.data || EMPTY) as AnyData;
  const actions = useKitNodeActions(props.id);
  const brief = typeof d.brief === 'string' ? d.brief : '';
  const style = typeof d.style_preset === 'string' && d.style_preset ? d.style_preset : DEFAULT_STYLE;
  const ratio = typeof d.aspect_ratio === 'string' && d.aspect_ratio ? d.aspect_ratio : DEFAULT_RATIO;
  const polish = usePolish(brief, (v) => actions.update({ brief: v }), { contextType: 'general', label: 'AI 润色简报' });
  const label = typeof d.label === 'string' && d.label ? d.label : '灵感简报';

  return (
    <NodeSkeleton
      node={props}
      ports={BRIEF_PORTS}
      toolbar={<ToolbarButton icon={IconSparkles} title="AI 润色简报" onClick={polish.open}>AI 润色</ToolbarButton>}
      downloadUrl={textDownloadUrl(brief)}
      downloadName={`${label}.md`}
      onFullscreen={null}
    >
      <div className="cv-lb">
        <div className="cv-lb-row cv-lb-row--between">
          <LbTag title="画风预设">{styleLabel(style)}</LbTag>
          <LbButton variant="text" icon={IconSparkles} onClick={polish.open} title="AI 定向润色：根据你的具体要求与技能风格智能重写">AI 润色简报</LbButton>
        </div>
        <LbTextarea
          aria-label="简报内容"
          rows={6}
          value={brief}
          placeholder="粘贴小说/策划简报… 将连到 剧本拆解节点"
          onChange={(e) => actions.update({ brief: e.target.value })}
        />
        <div className="cv-lb-row">
          <LbSelect className="cv-lb-grow" aria-label="画风" value={style} onChange={(e) => actions.update({ style_preset: e.target.value })}>
            {STYLE_PRESETS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            {!STYLE_PRESETS.some((s) => s.id === style) && <option value={style}>{style}</option>}
          </LbSelect>
          <LbSelect aria-label="画幅" value={ratio} onChange={(e) => actions.update({ aspect_ratio: e.target.value })}>
            {BRIEF_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
            {!BRIEF_RATIOS.includes(ratio) && <option value={ratio}>{ratio}</option>}
          </LbSelect>
        </div>
        <div className="cv-lb-hint cv-lb-row"><IconSparkles size={12} aria-hidden />拖出连线到「剧本拆解」节点</div>
      </div>
      {polish.portal}
    </NodeSkeleton>
  );
}

// ───────────────────────────── 剧本拆解 ─────────────────────────────

export function ScriptSplitNode(props: NodeProps) {
  const d = (props.data || EMPTY) as AnyData;
  const actions = useKitNodeActions(props.id);
  const rf = useReactFlow();
  // 所有入边的文本参考（简报 / 文本节点），只读不改 refOrder
  const { refs } = useNodeReferences(props.id, { handleId: null, promptKeys: [] });
  const upstreamBrief = useMemo(
    () => refs.filter((r) => r.dataType === 'STRING' && r.value.trim()).map((r) => r.value.trim()).join('\n\n'),
    [refs],
  );
  const [running, setRunning] = useState(false);
  const [localError, setLocalError] = useState('');
  const busy = running || !!d.loading;
  const result = d.result ?? d.project;
  const summary = scriptResultSummary(result);
  const error = (typeof d.error === 'string' && d.error) || localError;
  const ownBrief = typeof d.brief === 'string' ? d.brief.trim() : '';

  const run = async () => {
    if (busy) return;
    // 简报：连线优先（同旧宿主「找上游 brief」），其次节点自身的 brief；画风 / 画幅取上游简报节点的设置
    const brief = upstreamBrief || ownBrief;
    if (!brief) {
      const msg = '请先在上游 简报节点 填写小说内容并连线';
      setLocalError(msg);
      toast.warning(msg);
      return;
    }
    const overrides: AnyData = { brief };
    const briefNode = refs.map((r) => rf.getNode(r.sourceId)).find((n) => n?.type === 'brief');
    const bd = (briefNode?.data || {}) as AnyData;
    if (typeof bd.style_preset === 'string' && bd.style_preset) overrides.style_preset = bd.style_preset;
    if (typeof bd.aspect_ratio === 'string' && bd.aspect_ratio) overrides.aspect_ratio = bd.aspect_ratio;
    setLocalError('');
    if (d.error) actions.update({ error: undefined });
    setRunning(true);
    try {
      await actions.execute(overrides);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e || '执行失败');
      setLocalError(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  const resultJson = result ? JSON.stringify(result, null, 2) : '';
  const label = typeof d.label === 'string' && d.label ? d.label : '剧本拆解';

  return (
    <NodeSkeleton
      node={props}
      ports={SCRIPT_SPLIT_PORTS}
      toolbar={<ToolbarButton icon={IconPlayerPlay} title="一键拆解并生成分镜卡" loading={busy} onClick={() => void run()}>拆解</ToolbarButton>}
      downloadUrl={textDownloadUrl(resultJson, 'application/json')}
      downloadName={`${label}.json`}
      onFullscreen={null}
    >
      <div className="cv-lb">
        <div className="cv-lb-hint">
          输入简报 → 输出角色/分镜，真实调用 <code className="cv-lb-code">split_novel_script</code>
        </div>
        <div className={upstreamBrief || ownBrief ? 'cv-lb-quote' : 'cv-lb-quote is-empty'} title={upstreamBrief || ownBrief || undefined}>
          {upstreamBrief || ownBrief || '未连接简报：从「灵感简报」拖线到左侧输入口'}
        </div>
        <LbButton variant="primary" block icon={IconPlayerPlay} loading={busy} onClick={() => void run()}>
          {busy ? '拆解中…' : '一键拆解并生成分镜卡'}
        </LbButton>
        {error && <LbAlert>{error}</LbAlert>}
        {summary && <LbAlert tone="primary">✓ {summary.characters} 角色 · {summary.shots} 镜 已生成，连到分镜卡</LbAlert>}
      </div>
    </NodeSkeleton>
  );
}
