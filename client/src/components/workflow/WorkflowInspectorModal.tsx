import React, { useState, useEffect } from 'react';
import { apiService } from '../../services/api';
import { confirmAsync, toast } from '../../stores/useDialogStore';

interface ParameterItem {
  name: string;
  type: string;
  value: any;
  is_linked: boolean;
  link_source?: any;
  choices?: string[];
  min?: number;
  max?: number;
  step?: number;
}

interface NodeItem {
  node_id: string;
  title: string;
  class_type: string;
  category: 'model_loader' | 'sampler' | 'prompt' | 'latent' | 'output' | 'utility';
  is_subgraph_node?: boolean;
  subgraph_id?: string;
  subgraph_name?: string;
  parameters: ParameterItem[];
}

export interface ExposedInput {
  id: string;
  node_id: string;
  param_name: string;
  label: string;
  alias?: string;
  type: 'image' | 'text' | 'number' | 'select' | 'combo' | 'boolean' | 'audio' | 'video';
  required?: boolean;
  default_value?: any;
  description?: string;
  choices?: string[];
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export interface SubgraphItem {
  id: string;
  title: string;
  node_count: number;
  inner_node_ids: string[];
  exposed_params: {
    node_id: string;
    node_title: string;
    param_name: string;
    type: string;
    value: any;
    choices?: string[];
  }[];
}

interface WorkflowInspectData {
  workflow_id: string;
  name: string;
  description: string;
  source: 'internal' | 'external';
  mapping: Record<string, string>;
  node_overrides: Record<string, Record<string, any>>;
  exposed_inputs: ExposedInput[];
  /** ComfyUI 官方 App Mode 契约（工作流 extra.linearData 抽取而来），未声明时为空 */
  app_contract?: { linear_mode?: boolean; inputs?: any[]; outputs?: any[] } | null;
  source_file?: string | null;
  subgraphs?: SubgraphItem[];
  nodes: NodeItem[];
  available_models: {
    checkpoints: string[];
    unets: string[];
    loras: string[];
    vaes: string[];
    clips: string[];
    samplers: string[];
    schedulers: string[];
  };
}

interface Props {
  workflowId: string;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (newId?: string) => void;
  onDeleted?: (deletedId: string) => void;
}

export const WorkflowInspectorModal: React.FC<Props> = ({ workflowId, isOpen, onClose, onSaved, onDeleted }) => {
  const [data, setData] = useState<WorkflowInspectData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [refreshingContract, setRefreshingContract] = useState(false);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'nodes' | 'exposed' | 'mapping' | 'json'>('nodes');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [currentSubgraphId, setCurrentSubgraphId] = useState<string | null>(null);

  // Local state for edits
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, Record<string, any>>>({});
  const [exposedInputs, setExposedInputs] = useState<ExposedInput[]>([]);

  const loadData = async () => {
    if (!workflowId) return;
    setLoading(true);
    setValidationResult(null);
    try {
      const res = await apiService.inspectWorkflow(workflowId);
      if (res.status === 'success' && res.data) {
        setData(res.data);
        setMapping(res.data.mapping || {});
        setNodeOverrides(res.data.node_overrides || {});
        // 旧数据归一化：历史保存的 select 统一转为 combo（保留下拉语义），保存后即固化
        setExposedInputs((res.data.exposed_inputs || []).map((e: any) => (e.type === 'select' ? { ...e, type: 'combo' } : e)));
      }
    } catch (e: any) {
      alert(`解析工作流失败: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && workflowId) {
      loadData();
    }
  }, [isOpen, workflowId]);

  // 在 ComfyUI App Builder 里改完勾选并保存工作流后，回读 extra.linearData 重建生成源表单
  const handleRefreshContract = async () => {
    setRefreshingContract(true);
    try {
      const res = await apiService.refreshWorkflowAppContract(workflowId);
      const n = (res?.data?.app_contract?.inputs || []).length;
      await loadData();
      onSaved?.();
      alert(n ? `已读取 App 契约：${n} 个声明输入` : '来源文件里没有 extra.linearData，请先在 ComfyUI 的 App Builder 中勾选输入并保存');
    } catch (e: any) {
      alert(`读取 App 契约失败: ${e?.message || e}`);
    } finally {
      setRefreshingContract(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await apiService.validateWorkflow(workflowId);
      setValidationResult(res.data);
    } catch (e: any) {
      setValidationResult({ valid: false, errors: [{ message: e.message || String(e) }] });
    } finally {
      setValidating(false);
    }
  };

  const handleParamChange = (nodeId: string, paramName: string, value: any) => {
    setNodeOverrides(prev => {
      const current = { ...(prev[nodeId] || {}) };
      current[paramName] = value;
      return { ...prev, [nodeId]: current };
    });
  };

  const isExposed = (nodeId: string, paramName: string) => {
    return exposedInputs.some(exp => exp.node_id === String(nodeId) && exp.param_name === paramName);
  };

  const toggleExposeParam = (node: NodeItem, param: ParameterItem) => {
    const existingIndex = exposedInputs.findIndex(
      exp => exp.node_id === String(node.node_id) && exp.param_name === param.name
    );

    if (existingIndex >= 0) {
      // Remove
      setExposedInputs(prev => prev.filter((_, idx) => idx !== existingIndex));
    } else {
      // Add
      let type: ExposedInput['type'] = 'text';
      let defaultLabel = `${param.name} (${node.title})`;

      if (param.name === 'image' || node.class_type.includes('Image') || node.class_type.includes('LoadImage')) {
        type = 'image';
        defaultLabel = `参考垫图 (${node.title})`;
      } else if (param.type === 'INT' || param.type === 'FLOAT') {
        type = 'number';
      } else if (param.type === 'BOOLEAN') {
        type = 'boolean';
      } else if (param.type === 'COMBO' || (param.choices && param.choices.length > 0)) {
        // 原工作流中的下拉选择参数：暴露后保持下拉（combo），不再退化为手填文本
        type = 'combo';
      } else if (param.name === 'text' || param.name === 'prompt') {
        type = 'text';
        defaultLabel = `提示词/触发词 (${node.title})`;
      }

      const newExposed: ExposedInput = {
        id: `exp_${node.node_id}_${param.name}`,
        node_id: String(node.node_id),
        param_name: param.name,
        label: defaultLabel,
        type,
        required: false,
        default_value: param.value || '',
        description: `对应节点 #${node.node_id} (${node.class_type}) 的 ${param.name} 参数`,
        choices: param.choices,
        options: param.choices,
        min: param.min,
        max: param.max,
        step: param.step,
      };

      setExposedInputs(prev => [...prev, newExposed]);
    }
  };

  const handleAutoDetectExposed = () => {
    if (!data?.nodes) return;
    const detected: ExposedInput[] = [];
    const promptNode = mapping.prompt_node;
    const negNode = mapping.negative_node;

    for (const node of data.nodes) {
      if (node.class_type.includes('LoadImage') || node.class_type.includes('ImageLoad')) {
        const p = node.parameters.find(x => x.name === 'image');
        if (p && !p.is_linked) {
          detected.push({
            id: `img_${node.node_id}`,
            node_id: String(node.node_id),
            param_name: 'image',
            label: `参考垫图 (${node.title})`,
            type: 'image',
            required: false,
            description: '支持上传角色立绘、构图草图或姿态参考图，弹出文件系统',
          });
        }
      } else if (node.class_type.includes('LoadAudio') || node.class_type.includes('AudioLoad')) {
        const p = node.parameters.find(x => x.name === 'audio' || x.name === 'reference_audio');
        if (p && !p.is_linked) {
          detected.push({
            id: `aud_${node.node_id}`,
            node_id: String(node.node_id),
            param_name: p.name,
            label: `参考音频 (${node.title})`,
            type: 'audio',
            required: false,
            description: '支持上传参考音频，弹出文件系统',
          });
        }
      } else if (node.class_type.includes('LoadVideo') || node.class_type.includes('VideoLoad') || node.class_type.includes('VHS_LoadVideo')) {
        const p = node.parameters.find(x => x.name === 'video' || x.name === 'image');
        if (p && !p.is_linked) {
          detected.push({
            id: `vid_${node.node_id}`,
            node_id: String(node.node_id),
            param_name: p.name,
            label: `参考视频 (${node.title})`,
            type: 'video',
            required: false,
            description: '支持上传参考视频，弹出文件系统',
          });
        }
      } else if (node.class_type.includes('VAELoader') || node.class_type.includes('LoraLoader') || node.class_type.includes('CheckpointLoader') || node.class_type.includes('UNETLoader')) {
        for (const cand of ['vae_name','lora_name','ckpt_name','unet_name']) {
          const p = node.parameters.find(x => x.name === cand);
          if (p && !p.is_linked) {
            detected.push({
              id: `combo_${node.node_id}_${cand}`,
              node_id: String(node.node_id),
              param_name: cand,
              label: `${cand} (${node.title})`,
              type: 'combo',
              required: false,
              default_value: p.value||'',
              description: `${cand} 下拉选择，原白名单选择项恢复`,
              options: p.choices,
              choices: p.choices,
            });
          }
        }
      } else if (
        (node.class_type.includes('CLIPTextEncode') || node.class_type.includes('TextString')) &&
        String(node.node_id) !== String(promptNode) &&
        String(node.node_id) !== String(negNode)
      ) {
        const p = node.parameters.find(x => x.name === 'text' || x.name === 'string');
        if (p && !p.is_linked) {
          detected.push({
            id: `txt_${node.node_id}`,
            node_id: String(node.node_id),
            param_name: p.name,
            label: `风格/触发词 (${node.title})`,
            type: 'text',
            required: false,
            default_value: p.value || '',
            description: '可在此输入额外的角色 LoRA 触发词或局部描述',
          });
        }
      }
    }

    if (detected.length === 0) {
      alert('未检测到可自动暴露的图片上传或独立文本节点');
      return;
    }

    // Merge without duplicates
    setExposedInputs(prev => {
      const existingKeys = new Set(prev.map(x => `${x.node_id}_${x.param_name}`));
      const filteredNew = detected.filter(x => !existingKeys.has(`${x.node_id}_${x.param_name}`));
      return [...prev, ...filteredNew];
    });

    setActiveTab('exposed');
    alert(`⚡ 成功自动识别并添加了 ${detected.length} 个外部表单输入插槽！`);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res:any = await apiService.saveWorkflowOverrides(workflowId, {
        mapping,
        node_overrides: nodeOverrides,
        exposed_inputs: exposedInputs,
        auto_import_if_ext: true,
      });
      const newId = res?.meta?.id || res?.id || workflowId;
      if (newId !== workflowId) {
        alert(`🎉 已自动导入为内部工作流 ${newId} 并保存！原外部工作流配置已覆盖。`);
      } else {
        alert('🎉 工作流参数、槽位映射与外部表单暴露项已成功保存并覆盖！');
      }
      onSaved?.(newId as any);
      onClose();
    } catch (e: any) {
      alert(`保存失败: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (data?.source !== 'internal') {
      toast.warning('外部直读工作流为只读，请直接在文件系统中删除对应的 JSON 文件');
      return;
    }
    const confirmed = await confirmAsync({
      title: '删除工作流',
      message: `确定要永久删除内部工作流 "${data?.name || workflowId}" 吗？\n此操作将删除 storage/workflows/${workflowId}.json 与 .meta.json，且不可恢复。`,
      isDanger: true,
      confirmText: '确认删除',
      cancelText: '取消'
    });
    if (!confirmed) return;
    try {
      await apiService.deleteWorkflow(workflowId);
      toast.success('内部工作流已删除');
      if (onDeleted) onDeleted(workflowId);
      else onSaved?.();
      onClose();
    } catch (e: any) {
      toast.error(`删除失败: ${e.message || e}`);
    }
  };

  if (!isOpen) return null;

  const categoryNames: Record<string, string> = {
    all: '全部节点',
    subgraph: '📦 子图复合模块 (Subgraphs)',
    model_loader: '🧠 模型加载器 (UNet/LoRA/VAE)',
    sampler: '⚡ 采样器 (KSampler)',
    prompt: '📝 提示词 (CLIP/Prompt)',
    latent: '📐 画布尺寸与 Latent',
    output: '💾 输出图像 (SaveImage)',
    utility: '🔧 辅助与工具节点',
  };

  const currentSubgraph = data?.subgraphs?.find(sg => sg.id === currentSubgraphId);

  const filteredNodes = (data?.nodes || []).filter(node => {
    // If inside a subgraph, only show inner nodes of this subgraph
    if (currentSubgraphId) {
      if (node.subgraph_id !== currentSubgraphId) return false;
    } else {
      // At root level, hide inner subgraph nodes (they are represented by composite subgraph cards)
      if (node.is_subgraph_node && filterCategory !== 'subgraph') return false;
    }

    if (filterCategory === 'subgraph') {
      if (!node.is_subgraph_node) return false;
    } else if (filterCategory !== 'all' && node.category !== filterCategory) {
      return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        node.title.toLowerCase().includes(q) ||
        node.class_type.toLowerCase().includes(q) ||
        node.node_id.includes(q) ||
        (node.subgraph_name && node.subgraph_name.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-surface border border-white/10 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-blue/10 border border-accent-blue/30 flex items-center justify-center text-accent-blue font-bold text-base">
              ⚙️
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">ComfyUI 工作流参数深度配置与节点诊断</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium border ${
                  data?.source === 'internal'
                    ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
                    : 'bg-accent-purple/10 text-accent-purple border-accent-purple/30'
                }`}>
                  {data?.source === 'internal' ? '内部工作流' : '外部直读工作流'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                工作流: <span className="text-gray-200 font-mono">{data?.name || workflowId}</span> (共 {data?.nodes.length || 0} 个可执行节点 · {exposedInputs.length} 个表单暴露项)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleValidate}
              disabled={validating || loading}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200 hover:text-white transition flex items-center gap-1.5"
            >
              {validating ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  正在校验...
                </>
              ) : (
                <>
                  <span>🧪</span>
                  <span>一键连通性校验</span>
                </>
              )}
            </button>

            {data?.source === 'internal' && (
              <button
                onClick={handleDelete}
                disabled={saving || loading}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 hover:text-rose-200 transition flex items-center gap-1.5"
                title="永久删除此内部工作流"
              >
                <span>🗑️</span>
                <span>删除</span>
              </button>
            )}

            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold transition shadow-md flex items-center gap-1.5"
            >
              {saving ? '保存中...' : '💾 保存并应用配置'}
            </button>

            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white flex items-center justify-center transition"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Validation Result Banner */}
        {validationResult && (
          <div className={`px-6 py-3 text-xs border-b transition-all flex items-start gap-2.5 ${
            validationResult.valid
              ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-950/40 border-rose-500/30 text-rose-300'
          }`}>
            <span className="text-base">{validationResult.valid ? '✅' : '⚠️'}</span>
            <div className="flex-1">
              <div className="font-semibold">
                {validationResult.valid
                  ? `ComfyUI 校验通过！该工作流已准备就绪，包含 ${validationResult.node_count} 个有效节点。`
                  : `ComfyUI 校验未通过：发现以下参数或模型缺失问题`}
              </div>
              {validationResult.errors && validationResult.errors.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {validationResult.errors.map((err: any, idx: number) => (
                    <div key={idx} className="bg-black/30 p-2 rounded border border-rose-500/20">
                      <div className="font-medium text-rose-200">
                        {err.node_id ? `节点 #${err.node_id} (${err.class_type}): ` : ''}{err.message}
                      </div>
                      {err.suggested_fix && (
                        <div className="text-gray-400 text-[11px] mt-0.5">💡 {err.suggested_fix}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tabs Bar */}
        <div className="px-6 py-2.5 border-b border-white/5 flex items-center justify-between bg-white/[0.01]">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setActiveTab('nodes')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                activeTab === 'nodes'
                  ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/40'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              🌲 节点参数与模型选择 ({data?.nodes.length || 0})
            </button>
            <button
              onClick={() => setActiveTab('exposed')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                activeTab === 'exposed'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <span>⭐️ 外部表单暴露输入项</span>
              <span className="px-1.5 py-0.2 rounded-full bg-white/10 text-[10px] font-mono font-bold">
                {exposedInputs.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('mapping')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                activeTab === 'mapping'
                  ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/40'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              🎯 标准槽位映射 (Prompt / Seed / Dims)
            </button>
            <button
              onClick={() => setActiveTab('json')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                activeTab === 'json'
                  ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/40'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              📋 转换后 API JSON
            </button>
          </div>

          {activeTab === 'nodes' && (
            <div className="flex items-center gap-2">
              <select
                value={filterCategory}
                onChange={e => setFilterCategory(e.target.value)}
                className="bg-surface-secondary border border-white/10 rounded-lg px-2.5 py-1 text-xs text-gray-300 focus:outline-none focus:border-accent-blue"
              >
                {Object.entries(categoryNames).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>

              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索节点或参数..."
                className="bg-surface-secondary border border-white/10 rounded-lg px-2.5 py-1 text-xs text-gray-300 placeholder-gray-500 focus:outline-none focus:border-accent-blue w-44"
              />
            </div>
          )}

          {activeTab === 'exposed' && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleAutoDetectExposed}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 transition flex items-center gap-1"
              >
                <span>⚡ 自动探测图片与文本节点</span>
              </button>
              <button
                type="button"
                onClick={handleRefreshContract}
                disabled={refreshingContract}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-brand/20 hover:bg-brand/30 text-brand-light border border-brand/30 transition disabled:opacity-50 flex items-center gap-1"
                title="重新读取工作流的 extra.linearData（ComfyUI App Builder 勾选结果）"
              >
                <span>{refreshingContract ? '读取中…' : '🔄 重新读取 App 契约'}</span>
              </button>
              {(() => {
                const declared = (data?.app_contract?.inputs || []).length;
                return declared ? (
                  <span className="text-[11px] text-emerald-300">已按 App 契约的 {declared} 个输入渲染表单</span>
                ) : (
                  <span className="text-[11px] text-gray-400">
                    该工作流未声明 App 契约，表单只显示能语义命名的参数；在 ComfyUI 的 App Builder 勾选后点上方按钮回读
                  </span>
                );
              })()}
            </div>
          )}
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="py-20 text-center text-gray-400 flex flex-col items-center gap-3">
              <div className="w-6 h-6 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">正在深入解析 ComfyUI 工作流节点拓扑与可用模型...</span>
            </div>
          ) : activeTab === 'nodes' ? (
            <div className="space-y-4">
              {/* Subgraph Breadcrumb Navigation */}
              <div className="flex items-center justify-between pb-3 border-b border-white/10 text-xs">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentSubgraphId(null)}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-xl transition ${
                      currentSubgraphId === null
                        ? 'bg-brand/20 text-brand-light font-bold border border-brand/40 shadow-sm'
                        : 'text-gray-400 hover:text-white bg-surface-secondary border border-border'
                    }`}
                  >
                    <span>🏠 主图节点列表 (Root Graph)</span>
                  </button>

                  {currentSubgraph && (
                    <>
                      <span className="text-gray-500 font-mono">/</span>
                      <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-500/20 text-purple-300 border border-purple-500/40 font-bold">
                        <span>📦 {currentSubgraph.title}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/30 text-purple-200 font-normal">
                          {currentSubgraph.node_count} 个内部节点
                        </span>
                      </span>
                    </>
                  )}
                </div>

                {currentSubgraphId && (
                  <button
                    type="button"
                    onClick={() => setCurrentSubgraphId(null)}
                    className="text-xs font-semibold text-gray-200 hover:text-white flex items-center gap-1.5 bg-surface-tertiary hover:bg-surface-hover px-3 py-1.5 rounded-xl border border-border transition shadow-sm"
                  >
                    <span>⬅️ 返回主图层级</span>
                  </button>
                )}
              </div>

              {/* Top-Level Composite Subgraph Cards (When at Root level) */}
              {currentSubgraphId === null && (data?.subgraphs || []).map(sg => {
                return (
                  <div
                    key={sg.id}
                    onDoubleClick={() => setCurrentSubgraphId(sg.id)}
                    className="bg-purple-950/20 border-2 border-purple-500/40 hover:border-purple-500/70 rounded-2xl p-4 transition-all shadow-lg space-y-3 cursor-pointer group"
                    title="双击进入子图内部编辑详细节点"
                  >
                    <div className="flex items-center justify-between border-b border-purple-500/20 pb-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xl">📦</span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-white group-hover:text-purple-200 transition">
                              {sg.title}
                            </span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                              {sg.id}
                            </span>
                          </div>
                          <p className="text-[11px] text-purple-300/80 mt-0.5">
                            包含 {sg.node_count} 个内部节点 · 双击卡片或点击右侧按钮进入子图内部
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCurrentSubgraphId(sg.id);
                        }}
                        className="px-3.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-md shadow-purple-600/30"
                      >
                        <span>🔍 进入子图内部节点</span>
                      </button>
                    </div>

                    {/* Subgraph Exposed Parameters Overview */}
                    {sg.exposed_params.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold text-purple-200 flex items-center gap-1">
                          <span>⭐️ 该子图暴露的可配置参数 ({sg.exposed_params.length})：</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                          {sg.exposed_params.map(p => {
                            const nodeOverride = nodeOverrides[p.node_id] || {};
                            const currentVal = nodeOverride[p.param_name] !== undefined ? nodeOverride[p.param_name] : p.value;
                            const exposed = isExposed(p.node_id, p.param_name);
                            const matchingNode = data?.nodes.find(n => n.node_id === p.node_id);
                            return (
                              <div
                                key={`${p.node_id}_${p.param_name}`}
                                onClick={(e) => e.stopPropagation()}
                                className="p-2.5 rounded-xl bg-black/40 border border-purple-500/30 text-xs space-y-1.5"
                              >
                                <div className="flex items-center justify-between">
                                  <span className="font-semibold text-gray-200">{p.param_name}</span>
                                  <span className="text-[10px] text-purple-300/70 font-mono">#{p.node_id} ({p.node_title})</span>
                                </div>

                                <div className="flex items-center gap-2">
                                  {p.choices && (p.choices as string[]).length > 0 ? (
                                    <select
                                      value={String(currentVal ?? '')}
                                      onChange={(e) => handleParamChange(p.node_id, p.param_name, e.target.value)}
                                      className="flex-1 bg-surface border border-white/15 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-accent-blue"
                                    >
                                      <option value="">-- 请选择 --</option>
                                      {(p.choices as string[]).map((c: string) => (
                                        <option key={c} value={c}>{c}</option>
                                      ))}
                                      {String(currentVal ?? '') && !(p.choices as string[]).includes(String(currentVal)) && (
                                        <option value={String(currentVal)}>{String(currentVal)}</option>
                                      )}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      value={currentVal ?? ''}
                                      onChange={(e) => handleParamChange(p.node_id, p.param_name, e.target.value)}
                                      placeholder="参数值..."
                                      className="flex-1 bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs text-white"
                                    />
                                  )}
                                  {matchingNode && (
                                    <button
                                      type="button"
                                      onClick={() => toggleExposeParam(matchingNode, { name: p.param_name, type: p.type, value: p.value, choices: p.choices } as any)}
                                      className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition ${
                                        exposed
                                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                          : 'bg-white/5 text-gray-400 border-white/10 hover:text-white'
                                      }`}
                                    >
                                      {exposed ? '⭐️ 已暴露' : '暴露'}
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredNodes.length === 0 && (data?.subgraphs?.length || 0) === 0 ? (
                <div className="py-12 text-center text-gray-500 text-xs">
                  未找到匹配的节点
                </div>
              ) : (
                filteredNodes.map(node => {
                  const overrides = nodeOverrides[node.node_id] || {};
                  return (
                    <div
                      key={node.node_id}
                      className="bg-surface-secondary border border-white/10 rounded-xl p-4 transition hover:border-white/20"
                    >
                      {/* Node Header */}
                      <div className="flex items-center justify-between border-b border-white/5 pb-2.5 mb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-gray-400 border border-white/10">
                            #{node.node_id}
                          </span>
                          <span className="text-sm font-semibold text-gray-100">
                            {node.title}
                          </span>
                          <span className="text-[11px] font-mono text-gray-400">
                            ({node.class_type})
                          </span>
                          {node.is_subgraph_node && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 font-medium">
                              📦 {node.subgraph_name || '子图模块'}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
                          {node.category}
                        </span>
                      </div>

                      {/* Parameters Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                        {node.parameters.map(param => {
                          const currentValue =
                            overrides[param.name] !== undefined
                              ? overrides[param.name]
                              : param.value;
                          const exposed = isExposed(node.node_id, param.name);

                          return (
                            <div
                              key={param.name}
                              className={`p-2.5 rounded-lg border text-xs transition ${
                                param.is_linked
                                  ? 'bg-black/20 border-white/5 opacity-75'
                                  : exposed
                                  ? 'bg-amber-950/20 border-amber-500/30'
                                  : 'bg-black/40 border-white/10 hover:border-white/20'
                              }`}
                            >
                              <div className="flex items-center justify-between mb-1.5">
                                <span className="font-medium text-gray-300 flex items-center gap-1.5">
                                  <span>{param.name}</span>
                                  {param.is_linked && (
                                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-mono">
                                      🔗 连线自 #{param.link_source?.[0]}
                                    </span>
                                  )}
                                </span>

                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => toggleExposeParam(node, param)}
                                    title={exposed ? '点击取消暴露' : '点击暴露为外部生图/生视频表单输入项'}
                                    className={`text-[10px] px-2 py-0.5 rounded transition font-medium flex items-center gap-1 border ${
                                      exposed
                                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                                        : 'bg-white/5 text-gray-400 border-white/10 hover:text-white hover:bg-white/10'
                                    }`}
                                  >
                                    <span>{exposed ? '⭐️ 已暴露为表单项' : '➕ 暴露为表单项'}</span>
                                  </button>
                                  <span className="text-[10px] font-mono text-gray-500">
                                    {param.type}
                                  </span>
                                </div>
                              </div>

                              {param.is_linked ? (
                                <div className="text-[11px] text-gray-400 font-mono italic">
                                  该参数由上游节点插槽实时输出提供
                                </div>
                              ) : param.type === 'IMAGE' || param.type === 'AUDIO' || param.type === 'VIDEO' || param.name.toLowerCase().includes('image') || param.name.toLowerCase().includes('audio') || param.name.toLowerCase().includes('video') || param.name.toLowerCase().includes('frame') ? (
                                <label className="flex items-center gap-2 p-2 rounded-lg border border-dashed border-white/20 bg-black/20 hover:bg-black/30 cursor-pointer">
                                  <span className="text-xs">{param.type==='AUDIO' ? '🎵' : param.type==='VIDEO' ? '🎬' : '🖼️'}</span>
                                  <span className="text-xs text-gray-300 truncate flex-1">{currentValue ? `已选择${param.type==='AUDIO'?'音频':param.type==='VIDEO'?'视频':'图片'} · 点击更换` : `点击上传${param.type==='AUDIO'?'音频':param.type==='VIDEO'?'视频':'图片'} · 弹出文件系统`}</span>
                                  <input type="file" accept={param.type==='AUDIO' ? 'audio/*' : param.type==='VIDEO' ? 'video/*' : 'image/*'} className="hidden" onChange={e=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=> handleParamChange(node.node_id, param.name, r.result as string); r.readAsDataURL(f); }} />
                                </label>
                              ) : param.choices && param.choices.length > 0 ? (
                                <select
                                  value={currentValue || ''}
                                  onChange={e =>
                                    handleParamChange(node.node_id, param.name, e.target.value)
                                  }
                                  className="w-full bg-surface border border-white/15 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-accent-blue"
                                >
                                  <option value="">-- 请选择模型 / 预设 --</option>
                                  {param.choices.map((c: string) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </select>
                              ) : param.type === 'BOOLEAN' ? (
                                <label className="flex items-center gap-2 cursor-pointer mt-1">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(currentValue)}
                                    onChange={e =>
                                      handleParamChange(node.node_id, param.name, e.target.checked)
                                    }
                                    className="w-4 h-4 rounded text-accent-blue bg-surface border-white/20 focus:ring-0"
                                  />
                                  <span className="text-gray-300">
                                    {currentValue ? '已启用 (True)' : '已禁用 (False)'}
                                  </span>
                                </label>
                              ) : param.type === 'INT' || param.type === 'FLOAT' ? (
                                <input
                                  type="number"
                                  step={param.type === 'FLOAT' ? 0.05 : 1}
                                  value={currentValue ?? ''}
                                  onChange={e =>
                                    handleParamChange(
                                      node.node_id,
                                      param.name,
                                      param.type === 'FLOAT'
                                        ? parseFloat(e.target.value)
                                        : parseInt(e.target.value, 10)
                                    )
                                  }
                                  className="w-full bg-surface border border-white/15 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-accent-blue font-mono"
                                />
                              ) : typeof currentValue === 'string' && currentValue.length > 60 ? (
                                <textarea
                                  rows={2}
                                  value={currentValue || ''}
                                  onChange={e =>
                                    handleParamChange(node.node_id, param.name, e.target.value)
                                  }
                                  className="w-full bg-surface border border-white/15 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-accent-blue font-sans resize-none"
                                />
                              ) : (
                                <input
                                  type="text"
                                  value={currentValue ?? ''}
                                  onChange={e =>
                                    handleParamChange(node.node_id, param.name, e.target.value)
                                  }
                                  className="w-full bg-surface border border-white/15 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-accent-blue font-mono"
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : activeTab === 'exposed' ? (
            <div className="space-y-4 max-w-4xl mx-auto">
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 leading-relaxed flex items-start gap-2.5">
                <span className="text-lg">⭐️</span>
                <div>
                  <div className="font-bold text-amber-300 mb-0.5">外部生成表单动态输入配置说明</div>
                  在生图或生成视频时，不同工作流需要的输入差异很大（例如需要上传特定垫图、角色参考图、局部触发词等）。<br/>
                  在此暴露的节点参数，会在您生成画面或素材时，<b>自适应渲染为图片上传卡片或提示词输入框</b>，并将上传内容实时注入到工作流的对应节点中。
                </div>
              </div>

              {exposedInputs.length === 0 ? (
                <div className="py-16 text-center text-gray-500 space-y-3 bg-surface-secondary border border-white/10 rounded-xl p-6">
                  <div className="text-2xl">🧩</div>
                  <div className="text-sm font-semibold text-gray-300">当前尚未暴露任何自定义表单输入项</div>
                  <p className="text-xs text-gray-500 max-w-md mx-auto">
                    您可以点击下方按钮一键自动识别工作流中的垫图（LoadImage）与文本节点，或在「节点参数与模型选择」中按需勾选。
                  </p>
                  <button
                    type="button"
                    onClick={handleAutoDetectExposed}
                    className="px-4 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold transition"
                  >
                    ⚡ 一键自动识别可暴露项
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {exposedInputs.map((exp, idx) => (
                    <div
                      key={exp.id || idx}
                      className="bg-surface-secondary border border-white/10 rounded-xl p-4 transition hover:border-amber-500/30 space-y-3"
                    >
                      <div className="flex items-center justify-between border-b border-white/5 pb-2.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold">
                            #{exp.node_id} · {exp.param_name}
                          </span>
                          {(exp.alias && exp.alias !== exp.label) && (
                            <span className="text-[10px] px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 font-semibold">
                              ✏️ 别名: {exp.alias}
                            </span>
                          )}
                          <span className="text-xs font-medium text-gray-400">
                            类型: <span className="text-gray-200 font-semibold">{exp.type === 'image' ? '🖼️ 图片上传 (LoadImage)' : exp.type === 'audio' ? '🎵 音频上传' : exp.type === 'video' ? '🎬 视频上传' : exp.type === 'text' ? '📝 文本输入 (Text)' : exp.type === 'number' ? '🔢 数值 (Number)' : exp.type === 'boolean' ? '🔘 布尔开关' : '📋 下拉选择 (Combo)'}</span>
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setExposedInputs(prev => prev.filter((_, i) => i !== idx))}
                          className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10 transition"
                        >
                          ✕ 移除暴露
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                        <div>
                          <label className="text-[11px] text-gray-400 font-medium">✏️ 别名 / 注释 (Alias)</label>
                          <input
                            type="text"
                            value={exp.alias || ''}
                            onChange={e => {
                              const val = e.target.value;
                              setExposedInputs(prev =>
                                prev.map((item, i) => (i === idx ? { ...item, alias: val } : item))
                              );
                            }}
                            placeholder="如：主角脸型LoRA（仅改显示名，不影响注入）"
                            className="mt-1 w-full bg-surface border border-violet-500/30 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-violet-400"
                          />
                        </div>

                        <div>
                          <label className="text-[11px] text-gray-400 font-medium">外部表单显示名称 (Label) *</label>
                          <input
                            type="text"
                            value={exp.label}
                            onChange={e => {
                              const val = e.target.value;
                              setExposedInputs(prev =>
                                prev.map((item, i) => (i === idx ? { ...item, label: val } : item))
                              );
                            }}
                            placeholder="如：主角参考垫图 / 风格触发词"
                            className="mt-1 w-full bg-surface border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500"
                          />
                        </div>

                        <div>
                          <label className="text-[11px] text-gray-400 font-medium">输入组件形式 (Type)</label>
                          <select
                            value={exp.type}
                            onChange={e => {
                              const val = e.target.value as any;
                              setExposedInputs(prev =>
                                prev.map((item, i) => (i === idx ? { ...item, type: val } : item))
                              );
                            }}
                            className="mt-1 w-full bg-surface border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500"
                          >
                            <option value="image">🖼️ 图片上传器 (Image Uploader)</option>
                            <option value="audio">🎵 音频上传器 (Audio Uploader)</option>
                            <option value="video">🎬 视频上传器 (Video Uploader)</option>
                            <option value="text">📝 多行/单行文本输入 (Text Prompt)</option>
                            <option value="number">🔢 数值调节滑块 (Number)</option>
                            <option value="combo">📋 下拉单选 · 保留原生选项 (Combo)</option>
                            <option value="boolean">🔘 布尔开关 (Boolean)</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="text-[11px] text-gray-400 font-medium">用户引导提示 (Description)</label>
                        <input
                          type="text"
                          value={exp.description || ''}
                          onChange={e => {
                            const val = e.target.value;
                            setExposedInputs(prev =>
                              prev.map((item, i) => (i === idx ? { ...item, description: val } : item))
                            );
                          }}
                          placeholder="如：请上传人物正脸立绘"
                          className="mt-1 w-full bg-surface border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500"
                        />
                      </div>

                      {(exp.type === 'select' || exp.type === 'combo') && (
                        <div>
                          <label className="text-[11px] text-gray-400 font-medium">
                            📋 下拉选项（每行一个；留空则自动使用工作流原生选项 / ComfyUI 实时枚举）
                          </label>
                          <textarea
                            rows={3}
                            value={(exp.options || exp.choices || []).join('\n')}
                            onChange={e => {
                              const opts = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
                              setExposedInputs(prev =>
                                prev.map((item, i) => (i === idx ? { ...item, options: opts, choices: opts } : item))
                              );
                            }}
                            placeholder={'如：\n1:1 (Square)\n9:16 (Portrait)\n16:9 (Landscape)'}
                            className="mt-1 w-full bg-surface border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-amber-500 resize-none"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'mapping' ? (
            <div className="space-y-4 max-w-2xl mx-auto">
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300 leading-relaxed">
                💡 <b>槽位映射说明</b>：系统在生成分镜或素材时，会自动将小说拆解出的正向提示词、随机种子、长宽分辨率等动态参数注入到所映射的节点中。
              </div>

              <div className="space-y-3 bg-surface-secondary border border-white/10 rounded-xl p-5">
                {[
                  { key: 'prompt_node', label: '正向提示词节点 (Prompt Node)', hint: '通常为 CLIPTextEncode / TextString' },
                  { key: 'negative_node', label: '负向提示词节点 (Negative Node)', hint: '通常为负向 CLIPTextEncode' },
                  { key: 'ckpt_node', label: '主模型加载节点 (Checkpoint / UNet Node)', hint: 'CheckpointLoaderSimple 或 UNETLoader' },
                  { key: 'seed_node', label: '随机种子节点 (Seed Node)', hint: '通常为 KSampler / KSamplerAdvanced' },
                  { key: 'dim_node', label: '宽高分辨率节点 (Dimension Node)', hint: '通常为 EmptyLatentImage 或 ResolutionSelector' },
                  { key: 'save_node', label: '终端图像输出节点 (Save Image Node)', hint: 'SaveImage / PreviewImage' },
                ].map(slot => (
                  <div key={slot.key} className="flex flex-col gap-1 text-xs pb-3 border-b border-white/5 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-gray-200">{slot.label}</span>
                      <span className="text-[10px] text-gray-500">{slot.hint}</span>
                    </div>
                    <select
                      value={mapping[slot.key] || ''}
                      onChange={e => setMapping(prev => ({ ...prev, [slot.key]: e.target.value }))}
                      className="bg-surface border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-accent-blue"
                    >
                      <option value="">-- 未指定 / 自动推导 --</option>
                      {(data?.nodes || []).map(n => (
                        <option key={n.node_id} value={n.node_id}>
                          #{n.node_id} - {n.title} ({n.class_type})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-surface-secondary border border-white/10 rounded-xl p-4">
              <pre className="text-[11px] font-mono text-gray-300 overflow-x-auto p-2 bg-black/40 rounded-lg max-h-[60vh]">
                {JSON.stringify(data, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-white/10 flex items-center justify-between bg-white/[0.02] text-xs text-gray-400">
          <div>
            已配置覆写节点数: <span className="text-white font-mono">{Object.keys(nodeOverrides).length}</span> · 外部暴露输入: <span className="text-amber-300 font-mono font-bold">{exposedInputs.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white transition font-medium"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-1.5 rounded-lg bg-accent-blue hover:bg-blue-500 text-white font-semibold transition shadow-md"
            >
              {saving ? '保存中...' : '保存配置'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
