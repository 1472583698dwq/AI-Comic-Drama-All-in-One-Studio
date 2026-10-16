// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：ComfyUI 工作流 `comfy-workflow`（原 nodes/ComfyWorkflowNode.tsx）。
 *
 * 逻辑不变：
 * - 工作流列表 = apiService.listWorkflows('all')（内部 + 外部目录直读）；选中写 data.workflow_id；
 * - 选中后 apiService.inspectWorkflow(id) 取 exposed_inputs，按其声明生成「动态端口区」表单
 *   （image 垫图上传→dataURL、number、select/combo、其余文本），默认值 default_value 合入 data.dynamic_inputs；
 * - 「参数与诊断」派发全局事件 `open-workflow-inspector`（App 接管，写 modalIntents.wfInspectId，同旧组件）；
 * - 「使用此工作流生成」= apiService.generateShotImage({prompt, workflow_id, dynamic_inputs, aspect_ratio:'9:16'})
 *   → 写 result_url + dynamic_inputs；主提示词 data.prompt → data.image_prompt → 'masterpiece, high quality'。
 * 换皮：NodeSkeleton / NodeHandles（端口见 ports.COMFY_WORKFLOW_PORTS）/ --cv-* / Tabler；标题栏「刷新」= 重新拉取工作流与暴露输入。
 * 宿主不再把上游文本写进 data.prompt 时，主提示词为空则回落到 `prompt` 口上游文本（旧宿主连线时已写入 data.prompt，结果一致）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconAdjustmentsHorizontal, IconCheck, IconCpu, IconPhoto, IconTypography, IconUpload } from '@tabler/icons-react';
import { apiService } from '../../../../services/api';
import { toast } from '../../../../stores/useDialogStore';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { AutoRatioMedia } from '../../../ui/AutoRatioMedia';
import { NodeSkeleton, ToolbarButton, useKitNodeActions, useNodeReferences } from '../../kit';
import { LaButton, LaChip, LaSelect } from './ui';
import {
  EMPTY_DATA, NO_CANVAS, errorMessage, exposedDefaults, exposedKey, interactiveGuards, isUrlLike, openWorkflowInspector, type ExposedInput,
} from './helpers';

export const COMFY_WORKFLOW_TYPE = 'comfy-workflow';
export const COMFY_WORKFLOW_WIDTH = 340;
/** 旧组件写死的兜底主提示词。 */
export const COMFY_DEFAULT_PROMPT = 'masterpiece, high quality';

export interface ComfyWorkflowData extends Record<string, unknown> {
  label?: string;
  workflow_id?: string;
  dynamic_inputs?: Record<string, unknown>;
  prompt?: string;
  image_prompt?: string;
  result_url?: string;
}

interface WorkflowItem {
  id: string;
  name?: string;
  source?: string;
  node_count?: number;
}

const EMPTY_EXPOSED: ExposedInput[] = [];
const EMPTY_INPUTS: Record<string, unknown> = {};

const workflowLabel = (w: WorkflowItem) => `${w.name || w.id} ${w.source === 'external' ? '(外部)' : '(内部)'} · ${w.node_count ?? 0}节点`;

export function ComfyWorkflowNode(props: NodeProps) {
  const { id } = props;
  const d = (props.data || EMPTY_DATA) as ComfyWorkflowData;
  const actions = useKitNodeActions(id);
  const selectedId = d.workflow_id || '';
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  // 按工作流 id 记住解析结果：切换工作流时旧表单立即消失，不会把上一个工作流的输入混进来
  const [inspected, setInspected] = useState<{ wfId: string; items: ExposedInput[] }>({ wfId: '', items: EMPTY_EXPOSED });
  const [generating, setGenerating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // 上游连到 prompt 口的文本（宿主不再把它写进 data.prompt 时作兜底）
  const { refs: promptRefs } = useNodeReferences(id, { handleId: 'prompt' });
  const upstreamPrompt = promptRefs.find((r) => r.dataType === 'STRING' && r.value)?.value || '';

  const loadWorkflows = useCallback(
    () => apiService.listWorkflows('all').then((r) => setWorkflows(Array.isArray(r?.workflows) ? r.workflows : [])).catch(() => {}),
    [],
  );
  useEffect(() => { void loadWorkflows(); }, [loadWorkflows]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    apiService.inspectWorkflow(selectedId)
      .then((r) => { if (alive) setInspected({ wfId: selectedId, items: r?.data?.exposed_inputs || r?.exposed_inputs || [] }); })
      .catch(() => { if (alive) setInspected({ wfId: selectedId, items: EMPTY_EXPOSED }); });
    return () => { alive = false; };
  }, [selectedId, reloadKey]);
  const exposed = selectedId && inspected.wfId === selectedId ? inspected.items : EMPTY_EXPOSED;

  const stored = d.dynamic_inputs && typeof d.dynamic_inputs === 'object' ? d.dynamic_inputs : EMPTY_INPUTS;
  // 暴露输入默认值 + 已填值（已填优先），即旧组件 inspect 后的本地 dynamicInputs
  const dynamicInputs = useMemo(() => ({ ...exposedDefaults(exposed, stored), ...stored }), [exposed, stored]);

  const handleSelect = (wfId: string) => actions.update({ workflow_id: wfId });
  const handleDynamicChange = (key: string, val: unknown) => actions.update({ dynamic_inputs: { ...dynamicInputs, [key]: val } });

  const handleGenerate = async () => {
    if (!selectedId) { toast.warning('请先选择工作流'); return; }
    const prompt = d.prompt || upstreamPrompt || d.image_prompt || COMFY_DEFAULT_PROMPT;
    setGenerating(true);
    try {
      const res = await apiService.generateShotImage({
        prompt,
        workflow_id: selectedId,
        dynamic_inputs: Object.keys(dynamicInputs).length ? dynamicInputs : undefined,
        aspect_ratio: '9:16',
      });
      actions.update({ result_url: res.image_url, dynamic_inputs: dynamicInputs });
    } catch (e) {
      toast.error(errorMessage(e, '工作流生成失败'));
    } finally {
      setGenerating(false);
    }
  };

  const openInspector = () => openWorkflowInspector(selectedId);
  const resultUrl = d.result_url ? resolveMediaUrl(d.result_url) : '';
  // 当前值不在列表里（工作流已删 / 列表还没回来）时仍显示为选中项，避免 select 静默跳回空值
  const options = workflows.map((w) => ({ value: w.id, label: workflowLabel(w) }));
  if (selectedId && !workflows.some((w) => w.id === selectedId)) options.push({ value: selectedId, label: selectedId });

  return (
    <NodeSkeleton
      node={props}
      icon={IconCpu}
      width={COMFY_WORKFLOW_WIDTH}
      downloadUrl={resultUrl || undefined}
      downloadName={d.result_url ? d.result_url.split('/').pop() : undefined}
      onFullscreen={resultUrl ? () => actions.openFullscreen(resultUrl, 'image') : null}
      onRefresh={() => { void loadWorkflows(); setReloadKey((k) => k + 1); }}
      toolbar={(
        <>
          {selectedId && <ToolbarButton icon={IconAdjustmentsHorizontal} title="参数与诊断" onClick={openInspector}>参数与诊断</ToolbarButton>}
          <ToolbarButton icon={IconCheck} title="使用此工作流生成" loading={generating} disabled={!selectedId} onClick={() => void handleGenerate()}>生成</ToolbarButton>
        </>
      )}
    >
      <div className="cv-la">
        <div className="cv-la-row cv-la-row--between">
          <span className="cv-la-text-2 cv-la-small">ComfyUI 工作流</span>
          <LaChip tone={selectedId ? 'accent' : 'neutral'}><span>{selectedId ? '已绑定' : '未选择'}</span></LaChip>
        </div>

        <LaSelect
          aria-label="选择工作流"
          value={selectedId}
          onChange={(e) => handleSelect(e.target.value)}
          placeholder="— 选择工作流 (内部/外部直读) —"
          options={options}
        />

        {selectedId && (
          <div className="cv-la-row cv-la-row--between cv-la-small">
            <span className="cv-la-text-3">{exposed.length} 个暴露输入</span>
            <LaButton variant="link" icon={IconAdjustmentsHorizontal} iconSize={12} onClick={openInspector}>参数与诊断</LaButton>
          </div>
        )}

        {/* 动态端口区：表单按 exposed_inputs 声明生成 */}
        {exposed.length > 0 && (
          <div className={`cv-la-panel cv-la-panel--scroll ${NO_CANVAS}`} {...interactiveGuards} role="group" aria-label="暴露输入">
            {exposed.map((exp, i) => {
              const key = exposedKey(exp);
              const val = dynamicInputs[key];
              const label = exp.label || exp.param_name || key;
              const opts = ((exp.options || exp.choices || []) as unknown[]).map((c) => String(c));
              return (
                <div key={key || i} className="cv-la-field-row" data-exposed={key}>
                  <div className="cv-la-row cv-la-row--between cv-la-small">
                    <span className="cv-la-row cv-la-strong">
                      {exp.type === 'image'
                        ? <IconPhoto size={12} className="cv-la-accent" aria-hidden />
                        : <IconTypography size={12} className="cv-la-text-3" aria-hidden />}
                      <span className="cv-la-truncate">{label}</span>
                    </span>
                    <span className="cv-la-text-3 cv-la-tiny cv-la-mono">#{String(exp.node_id ?? '')}</span>
                  </div>
                  {exp.type === 'image' ? (
                    <div className="cv-la-row">
                      {/* 能预览的才画缩略图；ComfyUI 输入目录里的文件名（工作流默认值）显示为文件名标签 */}
                      {isUrlLike(val) ? (
                        <AutoRatioMedia src={resolveMediaUrl(val)} fallbackAspect="1/1" maxHeight={48} className="cv-la-thumb" />
                      ) : typeof val === 'string' && val ? (
                        <LaChip title={val} className="cv-la-mono"><span>{val}</span></LaChip>
                      ) : null}
                      <label className="cv-la-upload">
                        <input
                          type="file"
                          accept="image/*"
                          className="cv-la-hidden-input"
                          aria-label={`${label}：上传垫图`}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (!f) return;
                            const reader = new FileReader();
                            reader.onload = () => handleDynamicChange(key, reader.result as string);
                            reader.readAsDataURL(f);
                          }}
                        />
                        <IconUpload size={12} aria-hidden />
                        <span>{val ? '更换' : '上传垫图'}</span>
                      </label>
                      {!!val && <LaButton variant="danger-text" size="xs" onClick={() => handleDynamicChange(key, '')}>移除</LaButton>}
                    </div>
                  ) : exp.type === 'number' ? (
                    <input
                      type="number"
                      className="cv-la-field cv-la-field--sm"
                      aria-label={label}
                      value={val == null ? '' : String(val)}
                      onChange={(e) => handleDynamicChange(key, parseFloat(e.target.value) || 0)}
                    />
                  ) : exp.type === 'select' || exp.type === 'combo' ? (
                    <LaSelect
                      aria-label={label}
                      value={String(val ?? exp.default_value ?? '')}
                      onChange={(e) => handleDynamicChange(key, e.target.value)}
                      placeholder="-- 请选择 --"
                      options={[
                        ...opts.map((c) => ({ value: c, label: c })),
                        ...(String(val ?? '') && !opts.includes(String(val)) ? [{ value: String(val), label: String(val) }] : []),
                      ]}
                    />
                  ) : (
                    <input
                      type="text"
                      className="cv-la-field cv-la-field--sm"
                      aria-label={label}
                      value={val == null ? '' : String(val)}
                      onChange={(e) => handleDynamicChange(key, e.target.value)}
                      placeholder={exp.description || ''}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <textarea
          className={`cv-la-field cv-la-field--mono ${NO_CANVAS}`}
          {...interactiveGuards}
          aria-label="主提示词"
          value={d.prompt || ''}
          onChange={(e) => actions.update({ prompt: e.target.value })}
          placeholder={upstreamPrompt ? `上游提示词：${upstreamPrompt.slice(0, 60)}` : '主提示词 (将注入 workflow 的 prompt_node)…'}
          rows={2}
        />

        {resultUrl && (
          <div className="cv-la-media">
            <img className="cv-la-result" src={resultUrl} alt="工作流生成结果" draggable={false} />
          </div>
        )}

        <LaButton variant="primary" block icon={IconCheck} loading={generating} disabled={!selectedId} onClick={() => void handleGenerate()}>
          {generating ? '生成中…' : '使用此工作流生成'}
        </LaButton>
      </div>
    </NodeSkeleton>
  );
}

export default ComfyWorkflowNode;
