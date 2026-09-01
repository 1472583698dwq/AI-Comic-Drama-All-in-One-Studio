import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, addEdge, Connection, Edge, Node, ReactFlowProvider, useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, Sparkles, Image as ImageIcon, Film, Box, Library, Save, Download, Mic, Type, Plus, Wand2, Layers } from 'lucide-react';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { apiService } from '../../services/api';
import { useCanvasSync } from './hooks/useCanvasSync';
import { executeAgentNode } from './hooks/nodeAgentExecutor';
import { ShotCardNode } from './nodes/ShotCardNode';
import { ComfyWorkflowNode } from './nodes/ComfyWorkflowNode';
import { BriefNode, ScriptSplitNode } from './nodes/BriefNode';
import { AssetNode, Director3DNode } from './nodes/AssetNode';
import { VideoNode } from './nodes/VideoNode';
import { TTSNode } from './nodes/TTSNode';
import { TimelineExportNode } from './nodes/TimelineExportNode';
import { ProviderNode, ProviderImageNode, ProviderVideoNode, ProviderAudioNode } from './nodes/ProviderNode';
import { LoadImageNode, LoadImageBatchNode, LoadVideoNode, LoadAudioNode, TextPromptNode } from './nodes/LoaderNodes';
import { PromptNode, ImageNode, VideoGenNode, AudioNode, Director3DMinimalNode, ExportNode } from './nodes/MinimalNodes';
import { FloatingAgentPromptBar } from './FloatingAgentPromptBar';
import { WorkflowInspectorModal } from '../workflow/WorkflowInspectorModal';
import { getNodeSpec } from './nodeRegistry';

const nodeTypes: any = {
  // 6 核心 Agent 节点
  'prompt': PromptNode,
  'image': ImageNode,
  'video': VideoGenNode,
  'audio': AudioNode,
  'director3d': Director3DMinimalNode,
  'export': ExportNode,
  // 兼容旧节点
  'shot-card': ShotCardNode,
  'comfy-workflow': ComfyWorkflowNode,
  'brief': BriefNode,
  'script-split': ScriptSplitNode,
  'asset': AssetNode,
  'video-legacy': VideoNode,
  'tts': TTSNode,
  'timeline-export': TimelineExportNode,
  'provider-image': ProviderImageNode,
  'provider-video': ProviderVideoNode,
  'provider-audio': ProviderAudioNode,
  'provider': ProviderNode,
  'provider-llm': ProviderNode,
  'load-image': LoadImageNode,
  'load-image-batch': LoadImageBatchNode,
  'load-video': LoadVideoNode,
  'load-audio': LoadAudioNode,
  'text-prompt': TextPromptNode,
};

let idSeq = 0;
const genId = (p: string) => `${p}_${Date.now()}_${++idSeq}`;

const CORE_LIBRARY = [
  { type: 'prompt', label: '剧本 / Prompt', desc: '剧本拆解与分镜策划', icon: Type, color: 'text-sky-400' },
  { type: 'image', label: '生图 Agent', desc: '多引擎文生图与垫图参考', icon: ImageIcon, color: 'text-violet-400' },
  { type: 'video', label: '视频 Agent', desc: '动态视频 / 首尾帧 / 参考生视频', icon: Film, color: 'text-orange-400' },
  { type: 'audio', label: '配音 Agent', desc: '多角色情感 TTS 配音', icon: Mic, color: 'text-pink-400' },
  { type: 'director3d', label: '3D导演台', desc: '机位规划与运镜指令', icon: Box, color: 'text-amber-500' },
  { type: 'export', label: '导出草稿', desc: '一键生成剪映工程', icon: Download, color: 'text-emerald-500' },
];

const TEMPLATES = [
  { id: 't1', label: '剧本 → 生图 → 视频', desc: '漫剧创作标准链路', nodes: ['prompt', 'image', 'video'] },
  { id: 't2', label: '完整漫剧导演流', desc: '剧本 → 画面 → 视频 → 配音 → 导出', nodes: ['prompt', 'image', 'video', 'audio', 'export'] },
  { id: 't3', label: '连续镜头视频流', desc: '首帧 + 尾帧 → 连续动态视频', nodes: ['image', 'video'] },
];

const InnerCanvas: React.FC = () => {
  const { project } = useProjectStore();
  const { activeProjectId } = useProjectListStore();
  const { effectiveTheme } = useThemeStore();
  const { selectedNodeId, setSelectedNodeId } = useCanvasStore();
  const pid = activeProjectId || project?.id || null;
  const isLight = effectiveTheme === 'light';
  const { loadCanvas, debouncedSave } = useCanvasSync(pid);
  const { screenToFlowPosition, getViewport } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [assets, setAssets] = useState<any[]>([]);
  const [assetQuery, setAssetQuery] = useState('');
  const [inspectWfId, setInspectWfId] = useState('');
  const [saving, setSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const pidRef = useRef<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const h = (e: any) => setInspectWfId(e.detail?.workflowId || '');
    window.addEventListener('open-workflow-inspector', h as any);
    return () => window.removeEventListener('open-workflow-inspector', h as any);
  }, []);

  // 加载画布
  useEffect(() => {
    if (!pid) { setIsLoading(false); return; }
    if (pidRef.current !== pid) {
      pidRef.current = pid;
      loadedRef.current = false;
      setIsLoading(true);
    }
    if (loadedRef.current) { setIsLoading(false); return; }
    loadedRef.current = true;
    setIsLoading(true);
    const timer = setTimeout(() => setIsLoading(false), 3000);
    loadCanvas().then(snap => {
      if (snap && Array.isArray(snap.nodes)) {
        const withHandlers = snap.nodes.map((n: any) => ({
          ...n,
          data: { ...n.data, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute }
        }));
        setNodes(withHandlers);
        if (Array.isArray(snap.edges)) setEdges(snap.edges);
        if (withHandlers.length > 0 && !selectedNodeId) {
          setSelectedNodeId(withHandlers[0].id);
        }
      }
      clearTimeout(timer);
      setIsLoading(false);
    }).catch((e) => {
      console.warn('[Canvas] load failed', e);
      clearTimeout(timer);
      setIsLoading(false);
    });

    apiService.listAssets({ project_id: pid || undefined, limit: 24 }).then(r => setAssets(r.assets || [])).catch(() => {});
    const onAssetRefresh = () => apiService.listAssets({ project_id: pid || undefined, limit: 24 }).then(r => setAssets(r.assets || [])).catch(() => {});
    window.addEventListener('asset-refresh', onAssetRefresh as any);
    return () => { clearTimeout(timer); window.removeEventListener('asset-refresh', onAssetRefresh as any); };
  }, [pid]);

  // 历史回退 (Ctrl+Z)
  const histRef = useRef<{ nodes: any[]; edges: any[] }[]>([]);
  useEffect(() => {
    if (!pid || !loadedRef.current) return;
    histRef.current.push({ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) });
    if (histRef.current.length > 50) histRef.current.shift();
  }, [nodes, edges]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const prev = histRef.current.pop();
        if (prev) {
          const cur = histRef.current[histRef.current.length - 1];
          if (cur) { setNodes(cur.nodes); setEdges(cur.edges as any); }
          else if (prev) { setNodes(prev.nodes); setEdges(prev.edges as any); }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 800ms 防抖同步
  useEffect(() => {
    if (!pid || !loadedRef.current) return;
    let vp: any = {};
    try { vp = getViewport(); } catch {}
    const snap = { nodes, edges, viewport: vp, updated_at: new Date().toISOString(), version: 2 };
    debouncedSave(snap);
    try { useCanvasStore.getState().setFromFlow(nodes as any, edges as any); } catch {}
  }, [nodes, edges]);

  // 节点更新与下游级联传播（全量 Provider 句柄复用）
  const edgesRef = useRef(edges);
  const nodesRef = useRef(nodes);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  const handleNodeUpdate = useCallback((nodeId: string, patch: any) => {
    setNodes(nds => {
      let next = nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } } : n);
      const propagatable = patch.image_url || patch.result_url || patch.video_url || patch.audio_url || patch.prompt || patch.text || patch.reference || patch.first_frame || patch.last_frame || patch.reference_images || patch.first_frame_url || patch.last_frame_url || patch.ref_audio || patch.ref_audio_path;
      if (propagatable) {
        const downstreamEdges = (edgesRef.current || edges).filter((e: any) => e.source === nodeId);
        for (const e of downstreamEdges) {
          const tgtIdx = next.findIndex(n => n.id === e.target);
          if (tgtIdx === -1) continue;
          const tgt = next[tgtIdx];
          const srcData = next.find(n => n.id === nodeId)?.data as any;
          const patchDown: any = { _upstream: { ...((tgt.data as any)._upstream || {}) } };
          const th = (e as any).targetHandle || '';
          const urlImg = patch.image_url || patch.result_url || srcData?.image_url || srcData?.result_url;
          // first_frame 精准映射
          if ((patch.image_url || patch.result_url || patch.first_frame || patch.first_frame_url) && (th === 'first_frame' || th === 'first_frame_url' || (th === 'image' && tgt.type === 'video'))) {
            const url = patch.first_frame || patch.first_frame_url || urlImg;
            if (url) { patchDown.first_frame = url; patchDown.first_frame_url = url; patchDown.image_url = url; patchDown._upstream.first_frame = url; patchDown._upstream.first_frame_url = url; }
          } else if (th === 'last_frame' || th === 'last_frame_url' || patch.last_frame || patch.last_frame_url) {
            const url = patch.last_frame || patch.last_frame_url || srcData?.last_frame;
            if (url) { patchDown.last_frame = url; patchDown.last_frame_url = url; patchDown._upstream.last_frame = url; patchDown._upstream.last_frame_url = url; }
          } else if (patch.reference_images || patch.reference || th === 'reference_images' || th === 'reference' || th === 'images') {
            const arr = patch.reference_images || (patch.reference ? [patch.reference] : null) || (patch.image_url ? [patch.image_url] : null);
            if (arr) {
              const tgtExisting = (tgt.data as any).reference_images || [];
              const merged = Array.isArray(arr) ? arr : [arr];
              const dedup = [...tgtExisting];
              for (const u of merged) if (u && !dedup.includes(u)) dedup.push(u);
              patchDown.reference_images = dedup.length ? dedup : merged;
              patchDown.reference = merged[0];
              patchDown._upstream.reference_images = patchDown.reference_images;
              patchDown._upstream.reference = merged[0];
            }
            if (urlImg && !patchDown.reference_images) {
              patchDown.reference_images = [urlImg];
              patchDown._upstream.reference_images = [urlImg];
            }
          } else if (urlImg) {
            // 兜底：无句柄时按目标类型推断
            if (tgt.type === 'video' && !(tgt.data as any).first_frame) {
              patchDown.first_frame = urlImg; patchDown.first_frame_url = urlImg;
              patchDown._upstream.first_frame = urlImg;
            } else {
              patchDown.reference_images = [urlImg];
              patchDown.reference = urlImg;
              patchDown._upstream.reference_images = [urlImg];
            }
            patchDown.image_url = urlImg;
            patchDown._upstream.image_url = urlImg;
            patchDown._upstream.reference = urlImg;
          }
          // 参考音频透传
          const audioUrl = patch.audio_url || patch.ref_audio || patch.ref_audio_path || srcData?.audio_url;
          if (patch.audio_url || patch.ref_audio || patch.ref_audio_path) {
            if (th === 'ref_audio' || th === 'reference_audios' || th === 'audio' || tgt.type === 'audio') {
              patchDown.ref_audio = audioUrl; patchDown.ref_audio_path = audioUrl;
              patchDown.audio_url = audioUrl;
              patchDown._upstream.ref_audio = audioUrl;
            }
            patchDown.audio_url = audioUrl;
            patchDown._upstream.audio_url = audioUrl;
          }
          if (patch.video_url) {
            patchDown.video_url = patch.video_url;
            patchDown._upstream.video_url = patch.video_url;
          }
          if (patch.prompt || patch.text) {
            const txt = patch.prompt || patch.text || srcData?.prompt || srcData?.text;
            if (th === 'prompt' || th === 'text' || !th || tgt.type === 'image' || tgt.type === 'video' || tgt.type === 'audio' || tgt.type === 'prompt') {
              patchDown.prompt = txt; patchDown.text = txt; patchDown.image_prompt = txt; patchDown.video_prompt = txt;
            }
            patchDown._upstream.prompt = txt; patchDown._upstream.text = txt;
          }
          // 透传 params 变更（如 aspect_ratio/duration 等）
          for (const pk of ['aspect_ratio','resolution','steps','cfg','duration','fps','seed','model','provider','provider_id','workflow_id','voice_id','emotion','speed','pitch']) {
            if (patch[pk] !== undefined) { patchDown[pk] = patch[pk]; patchDown._upstream[pk] = patch[pk]; }
          }
          next[tgtIdx] = { ...tgt, data: { ...tgt.data, ...patchDown, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute, _upstream: patchDown._upstream } } as any;
        }
      }
      return next;
    });
  }, [edges]);

  // 执行节点生成 — 统一口径：image/video/audio 走 nodeAgentExecutor（MCP provider_* + 轮询 + agent_state），
  // prompt/director3d/旧节点 走各自通道，彻底消除双轨分叉
  const handleNodeExecute = useCallback(async (nodeId: string, customData?: any) => {
    const curNodes = nodesRef.current || nodes;
    const node = curNodes.find(n => n.id === nodeId);
    if (!node) return;
    setIsGenerating(true);
    try {
      if (node.type === 'prompt') {
        const d: any = { ...node.data, ...(customData || {}) };
        const textToProcess = (d.prompt || d.text || '').trim();
        if (!textToProcess) { handleNodeUpdate(nodeId, { text: '', prompt: '' }); return; }
        const skillId = d.skill_id || '';
        if (skillId === 'script_generation') {
          const res = await apiService.parseScript(textToProcess, d.style_preset || 'donghua_xianxia', d.aspect_ratio || '9:16');
          const scriptText = res?.scenes?.map((s: any) => `【场景 ${s.scene_index}】\n` + s.shots?.map((sh: any) => `镜头 ${sh.shot_index}: [${sh.camera_framing}] ${sh.action_desc}\n台词: ${sh.dialogue || '（无对白）'}`).join('\n\n')).join('\n\n') || textToProcess;
          handleNodeUpdate(nodeId, { text: scriptText, prompt: scriptText, script_data: res, agent_state: { status: 'completed', tool: 'split_novel_script', updated_at: new Date().toISOString() } });
        } else if (skillId === 'proposal_generation') {
          const r: any = await apiService.callMcpTool('split_novel_script', { novel_text: textToProcess, style_preset: d.style_preset || 'donghua_xianxia', aspect_ratio: d.aspect_ratio || '9:16' }).catch(async () => {
            // 降级：直接调 LLM 透传
            const res2 = await fetch(`${(window as any).location?.port === '5173' ? 'http://127.0.0.1:8000' : ''}/api/v1/agent/chat`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prompt: textToProcess, context: { skill: 'proposal' } })}).then(r=>r.json()).catch(()=>null);
            return { result: res2 };
          });
          const content = r?.result?.content || r?.result?.project || textToProcess;
          handleNodeUpdate(nodeId, { text: typeof content==='string'?content:JSON.stringify(content).slice(0,2000), prompt: typeof content==='string'?content:textToProcess });
        } else if (skillId === 'prompt_expansion') {
          handleNodeUpdate(nodeId, { agent_state: { status: 'running', tool: 'llm/expand', updated_at: new Date().toISOString() } });
          try {
            const expanded = await apiService.expandPrompt(textToProcess, 'image');
            if (!expanded) throw new Error('扩写返回为空');
            handleNodeUpdate(nodeId, { text: expanded, prompt: expanded, agent_state: { status: 'completed', tool: 'llm/expand', updated_at: new Date().toISOString() } });
          } catch (e: any) {
            handleNodeUpdate(nodeId, { agent_state: { status: 'failed', tool: 'llm/expand', error: String(e?.message || e).slice(0, 200), updated_at: new Date().toISOString() } });
            throw e;
          }
        } else {
          handleNodeUpdate(nodeId, { text: textToProcess, prompt: textToProcess });
        }
      } else if (['image', 'video', 'audio'].includes(node.type || '')) {
        await executeAgentNode({ node, override: customData, updateNodeData: handleNodeUpdate });
      } else if (node.type === 'director3d') {
        const d: any = { ...node.data, ...(customData || {}) };
        const res = await apiService.callMcpTool('director_3d_stage_plan', { framing: d.framing || 'medium', motion: d.motion || 'push_in', pose: d.pose || 'stand', focal_length_mm: d.focal_length_mm || 35, camera_roll_deg: d.camera_roll_deg || 0 });
        const r = (res as any)?.result || res;
        handleNodeUpdate(nodeId, { minimax_camera_prompt: r.minimax_camera_prompt || JSON.stringify(r).slice(0, 200), ...r });
      } else {
        // 兼容旧节点：经由 Canvas DAG 引擎执行（复用 Provider 系统）
        const d: any = { ...node.data, ...(customData || {}) };
        const API_ORIGIN = (window as any).location?.port === '5173' ? 'http://127.0.0.1:8000' : '';
        const resp = await fetch(`${API_ORIGIN}/api/v1/canvas/node/execute`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ node: { id: nodeId, type: node.type, data: d }, project_id: (window as any).__activePid || undefined }) }).then(r=>r.json());
        if (resp?.result?.status === 'success') {
          const rr = resp.result;
          const patch: any = {};
          if (rr.image_url) { patch.image_url = rr.image_url; patch.result_url = rr.image_url; }
          if (rr.video_url) patch.video_url = rr.video_url;
          if (rr.audio_url) patch.audio_url = rr.audio_url;
          if (rr.prompt) patch.prompt = rr.prompt;
          handleNodeUpdate(nodeId, patch);
        } else if (resp?.result?.error || resp?.detail) {
          throw new Error(resp.result?.error || resp.detail);
        }
      }
    } catch (e: any) {
      alert(`生成失败: ${e.message || e}`);
    } finally {
      setIsGenerating(false);
    }
  }, [nodes]);

  const isValidConnection: any = useCallback((connection: any) => {
    const c: Connection = connection;
    const src = nodes.find(n => n.id === c.source);
    const tgt = nodes.find(n => n.id === c.target);
    if (!src || !tgt) return true;
    const srcSpec = getNodeSpec(src.type || '');
    const tgtSpec = getNodeSpec(tgt.type || '');
    if (!srcSpec || !tgtSpec) return true;
    const srcOut = srcSpec.outputs.find(h => h.id === c.sourceHandle) || srcSpec.outputs[0];
    const tgtIn = tgtSpec.inputs.find(h => h.id === c.targetHandle) || tgtSpec.inputs[0];
    if (!srcOut || !tgtIn) return true;
    if (srcOut.type === tgtIn.type) return true;
    if (tgtIn.type === 'text' && srcOut.type === 'text') return true;
    return srcOut.type === tgtIn.type;
  }, [nodes]);

  const onConnect = useCallback((params: Connection) => {
    if (!isValidConnection(params)) {
      alert('连线类型不匹配');
      return;
    }
    setEdges(es => addEdge({ ...params, type: 'smoothstep', animated: true } as any, es as any));
    setTimeout(() => {
      const sourceId = params.source;
      const targetId = params.target;
      if (!sourceId || !targetId) return;
      setNodes(nds => {
        const srcNode = nds.find(n => n.id === sourceId);
        const tgtNode = nds.find(n => n.id === targetId);
        if (!srcNode || !tgtNode) return nds;
        const srcData: any = srcNode.data;
        const tgtHandle = (params.targetHandle || '') as string;
        const patch: any = {};
        const srcType = srcNode.type || '';
        if (['prompt', 'text-prompt', 'brief'].includes(srcType)) {
          const txt = srcData.prompt || srcData.text || srcData.brief || '';
          if (txt) { patch.prompt = txt; patch.text = txt; patch.image_prompt = txt; patch.video_prompt = txt; }
        }
        if (['image', 'shot-card', 'comfy-workflow', 'load-image', 'load-image-batch'].includes(srcType)) {
          const url = srcData.image_url || srcData.result_url || srcData.image || srcData.url || srcData.file_url;
          const urlArr = srcData.reference_images || srcData.images;
          if (tgtHandle === 'first_frame' || tgtHandle === 'first_frame_url') {
            if (url) patch.first_frame = url, patch.first_frame_url = url;
          } else if (tgtHandle === 'last_frame' || tgtHandle === 'last_frame_url') {
            if (url) patch.last_frame = url, patch.last_frame_url = url;
          } else if (tgtHandle === 'reference_images' || tgtHandle === 'images') {
            const arr = Array.isArray(urlArr) && urlArr.length ? urlArr : url ? [url] : [];
            if (arr.length) {
              const existing = (tgtNode.data as any).reference_images || [];
              patch.reference_images = [...existing, ...arr.filter((u: string) => !existing.includes(u))];
              patch.reference = arr[0];
            }
          } else {
            // 兜底：按 target 类型推断
            if (url) {
              if (tgtNode.type === 'video' && !(tgtNode.data as any).first_frame && tgtHandle !== 'reference_images') {
                patch.first_frame = url; patch.first_frame_url = url;
              } else {
                const existing = (tgtNode.data as any).reference_images || [];
                patch.reference_images = [...existing, url].filter((v,i,a)=>a.indexOf(v)===i);
                patch.reference = url;
              }
              patch.image_url = url;
            }
          }
        }
        if (srcType === 'video' && srcData.video_url) {
          if (tgtHandle === 'video' || tgtNode.type === 'export') patch.video_url = srcData.video_url;
          else patch.video_url = srcData.video_url;
        }
        if (['audio', 'tts'].includes(srcType) && srcData.audio_url) {
          if (tgtHandle === 'ref_audio' || tgtHandle === 'reference_audios' || tgtNode.type === 'audio') {
            patch.ref_audio = srcData.audio_url; patch.ref_audio_path = srcData.audio_url;
          }
          patch.audio_url = srcData.audio_url;
        }
        // Provider 节点透传
        if (['provider-image','provider-video','provider-audio','provider','provider-llm'].includes(srcType)) {
          const pid = srcData.provider_id || srcData.providerId || srcData.id;
          if (pid) { patch.provider_id = pid; patch.provider = pid; }
          if (srcData.model) patch.model = srcData.model;
        }
        if (Object.keys(patch).length) {
          return nds.map(n => n.id === targetId ? { ...n, data: { ...n.data, ...patch, _upstream: { ...(n.data as any)._upstream, ...patch } } } : n);
        }
        return nds;
      });
    }, 0);
  }, [isValidConnection]);

  const createNode = (type: string, position: { x: number; y: number }) => {
    const node: Node = {
      id: genId(type),
      type: type as any,
      position,
      data: { onUpdate: handleNodeUpdate, onExecute: handleNodeExecute },
    };
    if (type === 'prompt') node.data = { ...node.data, prompt: '' };
    if (type === 'image') node.data = { ...node.data, prompt: '' };
    if (type === 'video') node.data = { ...node.data, prompt: '', duration: 5 };
    if (type === 'audio') node.data = { ...node.data, text: '' };
    if (type === 'director3d') node.data = { ...node.data, framing: 'medium', motion: 'push_in' };
    return node;
  };

  const addTemplate = (tpl: any) => {
    const baseX = 120;
    const baseY = 80;
    const newNodes: Node[] = tpl.nodes.map((t: string, i: number) => createNode(t, { x: baseX + i * 400, y: baseY }));
    const newEdges: Edge[] = [];
    // 智能模板连线：区分线性链与分支（video/audio 并行汇入 export）
    for (let i = 1; i < newNodes.length; i++) {
      const prev = newNodes[i - 1];
      const cur = newNodes[i];
      // 跳过非法 video(prompt) -> audio(text) 直连，audio 应从 prompt 分支
      if (prev.type === 'video' && cur.type === 'audio') {
        // 改为 prompt 节点分叉到 audio
        const promptNode = newNodes.find(n => n.type === 'prompt');
        if (promptNode) {
          newEdges.push({ id: `e_${promptNode.id}_${cur.id}`, source: promptNode.id, target: cur.id, sourceHandle: 'prompt', targetHandle: 'text', type: 'smoothstep', animated: true } as any);
        }
        continue;
      }
      let sh = 'prompt', th = 'prompt';
      if (prev.type === 'prompt' && cur.type === 'image') { sh = 'prompt'; th = 'prompt'; }
      else if (prev.type === 'image' && cur.type === 'video') { sh = 'image'; th = 'first_frame'; }
      else if (prev.type === 'audio' && cur.type === 'export') { sh = 'audio'; th = 'audio'; }
      else if (prev.type === 'video' && cur.type === 'export') { sh = 'video'; th = 'video'; }
      else if (prev.type === 'prompt' && cur.type === 'video') { sh = 'prompt'; th = 'prompt'; }
      else if (prev.type === 'prompt' && cur.type === 'audio') { sh = 'prompt'; th = 'text'; }
      else {
        // 兜底：按 Registry 类型匹配，否则跳过
        const ps = getNodeSpec(prev.type || '');
        const ts = getNodeSpec(cur.type || '');
        if (ps && ts && ps.outputs[0] && ts.inputs[0] && ps.outputs[0].type !== ts.inputs[0].type) continue;
      }
      newEdges.push({ id: `e_${prev.id}_${cur.id}`, source: prev.id, target: cur.id, sourceHandle: sh, targetHandle: th, type: 'smoothstep', animated: true } as any);
    }
    // 完整链路模板收尾：若同时存在 video 与 audio，共同汇入 export
    if (tpl.id === 't2') {
      const videoNode = newNodes.find(n => n.type === 'video');
      const exportNode = newNodes.find(n => n.type === 'export');
      const audioNode = newNodes.find(n => n.type === 'audio');
      if (videoNode && exportNode && !newEdges.some(e => e.source === videoNode.id && e.target === exportNode.id)) {
        newEdges.push({ id: `e_${videoNode.id}_${exportNode.id}`, source: videoNode.id, target: exportNode.id, sourceHandle: 'video', targetHandle: 'video', type: 'smoothstep', animated: true } as any);
      }
      if (audioNode && exportNode && !newEdges.some(e => e.source === audioNode.id && e.target === exportNode.id)) {
        newEdges.push({ id: `e_${audioNode.id}_${exportNode.id}`, source: audioNode.id, target: exportNode.id, sourceHandle: 'audio', targetHandle: 'audio', type: 'smoothstep', animated: true } as any);
      }
    }
    setNodes(nds => [...nds, ...newNodes]);
    setEdges(es => [...es, ...newEdges]);
    if (newNodes.length > 0) setSelectedNodeId(newNodes[0].id);
  };

  // 监听衍生 + 菜单（使用 ref 避免闭包陈旧）
  useEffect(() => {
    const onAdd = (e: any) => {
      const { sourceId, nextType } = e.detail;
      const curNodes = nodesRef.current || [];
      const src = curNodes.find((n: any) => n.id === sourceId);
      const pos = src ? { x: src.position.x + 400, y: src.position.y } : { x: 120, y: 120 + curNodes.length * 40 };
      const node = createNode(nextType, pos);
      setNodes(nds => [...nds, node]);
      setSelectedNodeId(node.id);
      if (src) {
        const edge: Edge = { id: `e_${sourceId}_${node.id}`, source: sourceId, target: node.id, type: 'smoothstep', animated: true } as any;
        if (src.type === 'prompt' && nextType === 'image') { (edge as any).sourceHandle = 'prompt'; (edge as any).targetHandle = 'prompt'; }
        if (src.type === 'prompt' && nextType === 'video') { (edge as any).sourceHandle = 'prompt'; (edge as any).targetHandle = 'prompt'; }
        if (src.type === 'prompt' && nextType === 'audio') { (edge as any).sourceHandle = 'prompt'; (edge as any).targetHandle = 'text'; }
        if (src.type === 'image' && nextType === 'video') { (edge as any).sourceHandle = 'image'; (edge as any).targetHandle = 'first_frame'; }
        if (src.type === 'image' && nextType === 'image') { (edge as any).sourceHandle = 'image'; (edge as any).targetHandle = 'reference'; }
        if (src.type === 'video' && nextType === 'export') { (edge as any).sourceHandle = 'video'; (edge as any).targetHandle = 'video'; }
        if (src.type === 'audio' && nextType === 'export') { (edge as any).sourceHandle = 'audio'; (edge as any).targetHandle = 'audio'; }
        setEdges(es => [...es, edge]);
      }
    };
    const onDuplicate = (e: any) => {
      const { nodeId } = e.detail;
      const curNodes = nodesRef.current || [];
      const src = curNodes.find((n: any) => n.id === nodeId);
      if (!src) return;
      const newNode = createNode(src.type || 'prompt', { x: src.position.x + 40, y: src.position.y + 40 });
      newNode.data = { ...(src.data as any), onUpdate: handleNodeUpdate, onExecute: handleNodeExecute };
      setNodes(nds => [...nds, newNode]);
      setSelectedNodeId(newNode.id);
    };
    window.addEventListener('canvas-add-node', onAdd as any);
    window.addEventListener('canvas-duplicate-node', onDuplicate as any);
    return () => {
      window.removeEventListener('canvas-add-node', onAdd as any);
      window.removeEventListener('canvas-duplicate-node', onDuplicate as any);
    };
  }, []);

  // Agent 自主编排后刷新（方案 6.2：画布产出后重载）
  useEffect(() => {
    const onAgent = async () => {
      if (!pid) return;
      try {
        const snap: any = await apiService.getProjectCanvas(pid);
        const canvas = snap?.canvas || snap;
        if (canvas && Array.isArray(canvas.nodes)) {
          const withHandlers = canvas.nodes.map((n: any) => ({
            ...n,
            data: { ...n.data, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute },
          }));
          setNodes(withHandlers);
          if (Array.isArray(canvas.edges)) setEdges(canvas.edges);
        }
      } catch {}
    };
    window.addEventListener('agent-canvas-updated', onAgent as any);
    return () => window.removeEventListener('agent-canvas-updated', onAgent as any);
  }, [pid]);

  // 导出分镜
  useEffect(() => {
    const h = async () => {
      if (!pid) { alert('请先打开项目'); return; }
      const gens = nodes.filter(n => ['image', 'video', 'prompt'].includes(n.type as string));
      if (gens.length === 0) { alert('画布为空，无法导出'); return; }
      const sorted = [...gens].sort((a, b) => a.position.x - b.position.x);
      const shots = sorted.filter(n => n.type === 'image' || n.type === 'video').map((n, i) => {
        const d: any = n.data;
        return {
          id: `shot-${Date.now()}-${i}`, shot_index: i + 1, scene_index: 1,
          camera_framing: 'medium', camera_motion: 'push_in',
          action_desc: d.prompt || d.image_prompt || '', dialogue: d.text || '',
          image_prompt: d.prompt || '', image_url: d.image_url || d.result_url, video_url: d.video_url,
          duration: d.duration || 5, subtitle_text: d.prompt || '', status: 'ready',
        };
      });
      if (shots.length === 0) shots.push({ id: `shot-${Date.now()}`, shot_index: 1, scene_index: 1, camera_framing: 'medium', camera_motion: 'push_in', action_desc: '空', dialogue: '', image_prompt: '', duration: 5, subtitle_text: '', status: 'ready' } as any);
      const projContent: any = { id: pid, title: project?.title || '画布项目', original_novel: '', style_preset: project?.style_preset || 'donghua_xianxia', aspect_ratio: '9:16', characters: project?.characters || [], scenes: [{ id: 'scene-1', scene_index: 1, title: '场景1', location: '', time_of_day: 'day', atmosphere: 'epic', shots }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      try {
        await apiService.saveProjectContent(pid, projContent);
        useProjectStore.getState().setProject(projContent);
        alert(`已导出 ${shots.length} 镜到项目时间线`);
      } catch (e: any) { alert(e.message); }
    };
    window.addEventListener('canvas-export-shots', h as any);
    return () => window.removeEventListener('canvas-export-shots', h as any);
  }, [nodes, pid, project]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/canvas-nodetype');
    const assetId = e.dataTransfer.getData('application/canvas-assetid');
    const assetUrl = e.dataTransfer.getData('text/plain');
    if (!type && !assetId && !assetUrl) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (assetId) {
      const asset = assets.find(a => a.id === assetId);
      if (!asset) return;
      const node = createNode('image', position);
      const url = asset.thumb_url || asset.file_url;
      const abs = url?.startsWith('/') ? `http://127.0.0.1:8000${url}` : url;
      node.data = { ...node.data, reference: abs || url, image_url: abs || url };
      setNodes(nds => [...nds, node]);
      setSelectedNodeId(node.id);
      return;
    }
    if (type) {
      const node = createNode(type, position);
      setNodes(nds => [...nds, node]);
      setSelectedNodeId(node.id);
    }
  }, [screenToFlowPosition, assets]);

  const handleManualSave = async () => {
    if (!pid) { alert('请先在 项目看板 创建/打开项目'); return; }
    setSaving(true);
    try { await apiService.saveProjectCanvas(pid, { nodes, edges, version: 2 }); alert('画布已保存'); } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  };

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };

  useEffect(() => {
    const onDown = () => setIsDragging(true);
    const onUp = () => setIsDragging(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp); };
  }, []);

  if (!pid) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3" style={{ background: isLight ? '#E8ECF1' : '#08080B' }}>
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-xl shadow-lg shadow-brand/20">📁</div>
        <p className="text-sm [color:var(--color-text-main)] font-semibold">请先在「漫剧制作 → 项目看板」创建或打开项目</p>
        <p className="text-xs text-gray-400">画布按项目隔离持久化</p>
        <button onClick={() => useProjectStore.getState().setActiveTab('projects')} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold hover:bg-brand-light shadow-md">前往项目看板</button>
      </div>
    );
  }

  const isEmpty = nodes.length === 0;

  return (
    <div className="flex-1 flex overflow-hidden" style={{ background: isLight ? '#E8ECF1' : '#08080B', cursor: 'default' }}>
      {/* 左侧：极简工具栏 */}
      <div className="w-[280px] bg-surface border-r border-border flex flex-col shrink-0">
        <div className="h-12 px-4 border-b border-border flex items-center gap-2 shrink-0 bg-surface">
          <div className="w-7 h-7 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Layers className="w-3.5 h-3.5 text-brand" /></div>
          <span className="text-sm font-bold [color:var(--color-text-main)]">漫剧工作流</span>
          <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-surface-secondary border border-border [color:var(--color-text-muted)] font-mono">MiniMax Agent</span>
        </div>

        <div className="p-3 space-y-4 flex-1 overflow-y-auto">
          {/* 一键模板 */}
          <div>
            <div className="text-xs font-bold mb-2 [color:var(--color-text-main)]">一键模板</div>
            <div className="space-y-2">
              {TEMPLATES.map(t => (
                <button key={t.id} onClick={() => addTemplate(t)} className="w-full text-left p-3 rounded-2xl border border-border bg-surface-secondary hover:border-brand/40 hover:bg-surface-tertiary hover:shadow-md transition-all">
                  <div className="text-sm font-semibold [color:var(--color-text-main)]">{t.label}</div>
                  <div className="text-xs [color:var(--color-text-muted)] mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 6 核心 Agent 节点 */}
          <div>
            <div className="text-xs font-bold mb-2 [color:var(--color-text-main)]">核心 Agent 节点</div>
            <div className="grid grid-cols-2 gap-2">
              {CORE_LIBRARY.map(n => (
                <div
                  key={n.type}
                  draggable
                  onDragStart={e => e.dataTransfer.setData('application/canvas-nodetype', n.type)}
                  onClick={() => {
                    const pos = { x: 120 + nodes.length * 40, y: 120 + nodes.length * 40 };
                    const node = createNode(n.type, pos);
                    setNodes(nds => [...nds, node]);
                    setSelectedNodeId(node.id);
                  }}
                  className="flex flex-col gap-1.5 p-3 rounded-2xl bg-surface-secondary border border-border hover:border-brand/40 hover:bg-surface-tertiary hover:shadow-md cursor-grab active:cursor-grabbing transition-all"
                >
                  <n.icon className={`w-5 h-5 ${n.color}`} />
                  <div>
                    <div className="text-xs font-bold [color:var(--color-text-main)] leading-none">{n.label}</div>
                    <div className="text-[10px] [color:var(--color-text-muted)] mt-1">{n.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 素材库 */}
          <div className="rounded-2xl border border-border bg-surface p-3">
            <div className="text-xs font-bold [color:var(--color-text-main)] mb-2 flex items-center gap-1.5"><Library className="w-3.5 h-3.5 text-brand" /> 素材库 <span className="ml-auto text-[10px] [color:var(--color-text-muted)]">{assets.length} 个</span></div>
            <div className="grid grid-cols-2 gap-2 max-h-[160px] overflow-y-auto pr-1">
              {assets.map((a: any) => {
                const url = a.thumb_url || a.file_url;
                const abs = url?.startsWith('/') ? `http://127.0.0.1:8000${url}` : url;
                return (
                  <div key={a.id} draggable onDragStart={e => { e.dataTransfer.setData('application/canvas-assetid', a.id); e.dataTransfer.setData('text/plain', abs || url); }} className="group bg-surface-secondary border border-border rounded-xl overflow-hidden cursor-grab hover:border-brand/30 hover:shadow-md transition-all">
                    <div className="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">{abs ? <img src={abs} alt="" className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform" /> : <ImageIcon className="w-5 h-5 text-gray-500" />}</div>
                    <div className="p-1.5"><div className="text-[11px] font-medium truncate [color:var(--color-text-main)]">{a.name}</div></div>
                  </div>
                );
              })}
              {assets.length === 0 && <div className="col-span-2 text-xs [color:var(--color-text-muted)] text-center py-4">暂无素材</div>}
            </div>
          </div>
        </div>

        <div className="p-3 border-t border-border space-y-2 bg-surface-secondary/30">
          <button onClick={handleManualSave} disabled={saving} className="w-full py-2.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 hover:bg-brand-light shadow-md shadow-brand/20 transition-colors"><Save className="w-3.5 h-3.5" />{saving ? '保存中' : '保存画布'}</button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('canvas-export-shots'))} className="w-full py-2 rounded-xl bg-surface-secondary border border-border text-xs font-bold [color:var(--color-text-main)] flex items-center justify-center gap-1.5 hover:bg-surface-tertiary transition-colors"><Download className="w-3.5 h-3.5" /> 导出为分镜工程</button>
        </div>
      </div>

      {/* 中间无限画布 */}
      <div ref={wrapperRef} className="flex-1 relative flex flex-col min-w-0" style={{ background: isLight ? '#E8ECF1' : '#08080B' }} onDrop={onDrop} onDragOver={onDragOver}>
        <div className="h-11 px-4 border-b border-border bg-surface flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow shadow-emerald-500/30" />
            <span className="[color:var(--color-text-secondary)]">项目</span>
            <span className="font-mono [color:var(--color-text-main)] font-bold">{pid.slice(0, 8)}</span>
            <span className="[color:var(--color-text-muted)] hidden sm:inline">· 点卡片右侧 + 快速衍生 · 点击卡片在底部控制台操作</span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <button onClick={() => setNodes(nds => nds.map((n, i) => ({ ...n, position: { x: 120 + i * 400, y: 120 } })))} className="px-3 py-1 rounded-full bg-surface-secondary border border-border text-xs font-medium [color:var(--color-text-main)] hover:bg-surface-tertiary transition-colors">横向排布</button>
            <button onClick={() => { if (confirm('清空画布？')) { setNodes([]); setEdges([]); setSelectedNodeId(null); } }} className="w-7 h-7 rounded-full bg-surface-secondary border border-border text-[color:var(--color-text-muted)] hover:text-red-400 flex items-center justify-center transition-colors" title="清空">×</button>
          </div>
        </div>

        <div className="flex-1 relative">
          {isLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 gap-4" style={{ background: isLight ? '#E8ECF1' : '#08080B' }}>
              <div className="w-8 h-8 border-2 border-zinc-600 border-t-brand rounded-full animate-spin" />
              <div className="text-xs [color:var(--color-text-secondary)]">智能体画布加载中…</div>
            </div>
          ) : isEmpty ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 gap-6 overflow-y-auto" style={{ background: isLight ? '#E8ECF1' : '#08080B' }}>
              <div className="w-full max-w-[700px] bg-surface border border-border rounded-3xl shadow-2xl p-6 text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-brand/10 border border-brand/20 text-brand flex items-center justify-center mx-auto shadow-lg">
                  <Wand2 className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold [color:var(--color-text-main)]">从一个想法开始漫剧创作</h3>
                  <p className="text-xs [color:var(--color-text-muted)] mt-1">选择模板一键生成连贯的 Agent 节点链，或从左侧直接拖入节点</p>
                </div>
                <div className="grid grid-cols-3 gap-3 pt-2">
                  {TEMPLATES.map(t => (
                    <button key={t.id} onClick={() => addTemplate(t)} className="p-4 rounded-2xl border border-border bg-surface-secondary hover:border-brand/40 hover:bg-surface-tertiary text-left transition-all group">
                      <div className="text-xs font-bold [color:var(--color-text-main)] group-hover:text-brand">{t.label}</div>
                      <div className="text-[11px] [color:var(--color-text-muted)] mt-1">{t.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes.map(n => ({ ...n, selected: n.id === selectedNodeId }))}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
              deleteKeyCode="Delete"
              fitView
              colorMode={isLight ? 'light' : 'dark'}
              className={isLight ? 'light' : 'dark'}
              style={{ background: isLight ? '#E8ECF1' : '#08080B', cursor: isDragging ? 'grabbing' : 'crosshair' }}
            >
              <Background color={isLight ? '#CBD5E1' : '#1E1E2A'} gap={24} size={1.2} />
              <Controls className="!bg-surface !border-border !rounded-2xl shadow-xl ![color:var(--color-text-main)] [&_button]:!bg-surface [&_button]:!border-border [&_button]:![color:var(--color-text-main)]" />
              <MiniMap className="!bg-surface !border-border !rounded-xl" maskColor="rgba(10,10,12,0.8)" nodeColor={(n: any) => n.type === 'image' ? '#7C3AED' : n.type === 'video' ? '#F97316' : n.type === 'audio' ? '#EC4899' : n.type === 'prompt' ? '#06B6D4' : '#3F3F50'} />
            </ReactFlow>
          )}
        </div>

        {/* 底部全局编排控制台（节点级配置已下沉到卡内 NodeAgentBar） */}
        {!isEmpty && (
          <FloatingAgentPromptBar
            onAddNode={(t) => {
              const pos = { x: 120 + nodes.length * 40, y: 120 + nodes.length * 40 };
              const n = createNode(t, pos);
              setNodes(nds => [...nds, n]);
              setSelectedNodeId(n.id);
            }}
            onOpenAssetLibrary={() => {
              window.dispatchEvent(new CustomEvent('open-asset-library'));
            }}
            onExport={() => {
              window.dispatchEvent(new CustomEvent('open-export-modal'));
            }}
          />
        )}
      </div>

      {inspectWfId && <WorkflowInspectorModal workflowId={inspectWfId} isOpen={!!inspectWfId} onClose={() => setInspectWfId('')} onSaved={() => {}} />}
    </div>
  );
};

export const CreativeCanvas: React.FC = () => (
  <ReactFlowProvider><InnerCanvas /></ReactFlowProvider>
);
