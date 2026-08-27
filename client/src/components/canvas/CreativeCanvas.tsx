import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, addEdge, Connection, Edge, Node, ReactFlowProvider, useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, Sparkles, Upload, Image as ImageIcon, Film, Users, Box, Library, Cpu, BookOpen, X, Save, Download, Wand2, Plug, Globe, Mic, Video as VideoIcon, Type } from 'lucide-react';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { apiService } from '../../services/api';
import { useCanvasSync } from './hooks/useCanvasSync';
import { ShotCardNode } from './nodes/ShotCardNode';
import { ComfyWorkflowNode } from './nodes/ComfyWorkflowNode';
import { BriefNode, ScriptSplitNode } from './nodes/BriefNode';
import { AssetNode, Director3DNode } from './nodes/AssetNode';
import { VideoNode } from './nodes/VideoNode';
import { TTSNode } from './nodes/TTSNode';
import { TimelineExportNode } from './nodes/TimelineExportNode';
import { ProviderNode, ProviderImageNode, ProviderVideoNode, ProviderAudioNode } from './nodes/ProviderNode';
import { LoadImageNode, LoadImageBatchNode, LoadVideoNode, LoadAudioNode, TextPromptNode } from './nodes/LoaderNodes';
import { WorkflowInspectorModal } from '../workflow/WorkflowInspectorModal';
import { NODE_SPECS, getNodeSpec } from './nodeRegistry';
import { handleColor } from './utils/dynamicHandles';

const nodeTypes: any = {
  'shot-card': ShotCardNode,
  'comfy-workflow': ComfyWorkflowNode,
  'brief': BriefNode,
  'script-split': ScriptSplitNode,
  'asset': AssetNode,
  'director3d': Director3DNode,
  'video': VideoNode,
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

const NODE_LIBRARY = [
  { type: 'brief', label: '灵感简报', desc: '粘贴小说/策划', icon: BookOpen, color: 'text-amber-400' },
  { type: 'script-split', label: '剧本拆解', desc: 'MiniMax LLM', icon: Sparkles, color: 'text-brand' },
  { type: 'text-prompt', label: '文本提示词', desc:'提示词源', icon: Type as any, color:'text-sky-400' },
  { type: 'load-image', label: '加载图像', desc:'单张参考', icon: ImageIcon, color:'text-violet-400' },
  { type: 'load-image-batch', label:'批量图像', desc:'多张参考', icon: ImageIcon, color:'text-violet-400' },
  { type: 'load-video', label:'加载视频', desc:'参考视频', icon: Film, color:'text-orange-400' },
  { type: 'load-audio', label:'加载音频', desc:'参考音频', icon: Library, color:'text-pink-400' },
  { type: 'shot-card', label: '分镜卡', desc: '首帧+视频', icon: Film, color: 'text-brand-light' },
  { type: 'comfy-workflow', label: 'ComfyUI工作流', desc: '本地强控', icon: Cpu, color: 'text-violet-400' },
  { type: 'provider-image', label: '生图源', desc: '多源解耦', icon: Cpu, color: 'text-violet-400' },
  { type: 'provider-video', label: '视频源', desc: '多源解耦', icon: Film, color: 'text-accent-orange' },
  { type: 'provider-audio', label: '语音源', desc: '多源解耦', icon: Library, color: 'text-accent-pink' },
  { type: 'video', label: '生视频', desc: 'I2V/R2V/T2V', icon: Film, color: 'text-accent-orange' },
  { type: 'tts', label: 'TTS配音', desc: '文本→语音', icon: Library, color: 'text-accent-pink' },
  { type: 'director3d', label: '3D导演台', desc: '机位计算', icon: Film, color: 'text-accent-orange' },
  { type: 'timeline-export', label: '剪映导出', desc: '多轨草稿', icon: Film, color: 'text-brand' },
  { type: 'asset', label: '素材节点', desc: '从资产库拖入', icon: Library, color: 'text-accent-pink' },
];

const InnerCanvas: React.FC = () => {
  const { project } = useProjectStore();
  const { activeProjectId } = useProjectListStore();
  const pid = activeProjectId || project?.id || null;
  const { loadCanvas, debouncedSave } = useCanvasSync(pid);
  const { screenToFlowPosition, getViewport } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [assets, setAssets] = useState<any[]>([]);
  const [assetQuery, setAssetQuery] = useState('');
  const [inspectWfId, setInspectWfId] = useState('');
  const [saving, setSaving] = useState(false);
  const [providerList, setProviderList] = useState<any[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  // 监听全局打开 WorkflowInspector 事件
  useEffect(() => {
    const h = (e: any) => setInspectWfId(e.detail?.workflowId || '');
    window.addEventListener('open-workflow-inspector', h as any);
    return () => window.removeEventListener('open-workflow-inspector', h as any);
  }, []);

  // 加载画布快照
  useEffect(() => {
    if (!pid || loadedRef.current) return;
    loadedRef.current = true;
    loadCanvas().then(snap => {
      if (snap && snap.nodes) {
        // 兼容 tldraw / reactflow 两种快照
        if (Array.isArray(snap.nodes)) {
          // 为老数据补 onUpdate 绑定（通过 nodeTypes 注入）
          const withHandlers = snap.nodes.map((n:any)=> ({...n, data:{...n.data, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute}}));
          setNodes(withHandlers);
        }
        if (Array.isArray(snap.edges)) setEdges(snap.edges);
        if (snap.viewport) { /* 可恢复视口 */ }
      } else if (snap && snap.store) {
        // tldraw 快照忽略
      }
    });
    apiService.listWorkflows('all').then(r=> setWorkflows(r.workflows||[])).catch(()=>{});
    apiService.listAssets({ project_id: pid || undefined, limit: 20 }).then(r=> setAssets(r.assets||[])).catch(()=>{});
    apiService.listProviders({}).then(r=> setProviderList(r.providers||[])).catch(()=>{});
    // 监听 provider 创建事件自动刷新
    const onProvCreated = ()=> apiService.listProviders({}).then(r=> setProviderList(r.providers||[])).catch(()=>{});
    window.addEventListener('provider-list-refresh', onProvCreated as any);
    // 暴露给 ProviderNode 拖拽后刷新
  }, [pid]);

  // 自动保存 + 同步到 canvasStore 供 Agent 感知 + 视口持久化（P5）
  const histRef = useRef<{nodes:any[],edges:any[]}[]>([]);
  // 历史栈（P5）：50 步
  useEffect(() => {
    if (!pid || !loadedRef.current) return;
    histRef.current.push({nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges))});
    if(histRef.current.length>50) histRef.current.shift();
  }, [nodes, edges]);
  useEffect(()=>{
    const onKey = (e:KeyboardEvent)=>{
      if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z'){
        e.preventDefault();
        const prev = histRef.current.pop();
        if(prev){
          const cur = histRef.current[histRef.current.length-1];
          if(cur){ setNodes(cur.nodes); setEdges(cur.edges as any); }
          else if(prev){ setNodes(prev.nodes); setEdges(prev.edges as any); }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return ()=> window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!pid || !loadedRef.current) return;
    let vp:any = {};
    try{ vp = getViewport(); } catch{}
    const snap = { nodes, edges, viewport: vp, updated_at: new Date().toISOString() };
    debouncedSave(snap);
    try { useCanvasStore.getState().setFromFlow(nodes as any, edges as any); } catch {}
  }, [nodes, edges]);

  const handleNodeUpdate = useCallback((nodeId: string, patch: any) => {
    setNodes(nds=> nds.map(n=> n.id===nodeId ? { ...n, data: { ...n.data, ...patch, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } } : n));
  }, []);

  const [executing, setExecuting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const handleBatchExecute = async (mode: 'selected'|'all') => {
    const targets = mode==='selected' ? selectedIds : undefined;
    if (mode==='selected' && !targets?.length) { alert('请先在画布中选中节点（Ctrl+点击）'); return; }
    setExecuting(true);
    try {
      const payload = { nodes: nodes.map(n=> ({ id:n.id, type:n.type, position:n.position, data:n.data })), edges, target_ids: targets, project_id: pid };
      const res = await fetch(`${window.location.port==='5173' ? 'http://127.0.0.1:8000' : ''}/api/v1/canvas/execute`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).then(r=>r.json());
      if (res.status==='success') {
        const results = res.results || {};
        setNodes(nds=> nds.map(n=> results[n.id] ? { ...n, data:{...n.data, ...results[n.id], _lastResult: results[n.id]}} : n));
        alert(`批量执行完成：${res.order?.length||0} 节点`);
      } else alert(res.detail || '执行失败');
    } catch(e:any){ alert(e.message); } finally { setExecuting(false); }
  };

  const handleNodeExecute = useCallback(async (nodeId: string) => {
    const node = nodes.find(n=> n.id===nodeId);
    if (!node) return;
    if (node.type === 'script-split') {
      // 找上游 brief
      const incoming = edges.filter(e=> e.target===nodeId);
      let briefText = '';
      let style_preset = 'donghua_xianxia';
      let aspect_ratio = '9:16';
      for (const e of incoming) {
        const src = nodes.find(n=> n.id===e.source);
        if (src && src.type==='brief') { briefText = (src.data as any).brief || ''; style_preset = (src.data as any).style_preset || style_preset; aspect_ratio = (src.data as any).aspect_ratio || aspect_ratio; }
      }
      if (!briefText.trim()) { handleNodeUpdate(nodeId,{error:'请先在上游 简报节点 填写小说内容并连线'}); return; }
      handleNodeUpdate(nodeId,{loading:true, error:undefined});
      try {
        const proj = await apiService.parseScript(briefText, style_preset, aspect_ratio);
        handleNodeUpdate(nodeId,{loading:false, result: proj});
        // 自动生成分镜卡节点阵列
        const shots = proj.scenes.flatMap(s=> s.shots).slice(0,8);
        const baseX = node.position.x + 360;
        let y = node.position.y - 100;
        const newNodes: Node[] = shots.map((s:any, i:number)=> ({
          id: genId('shot'),
          type: 'shot-card',
          position: { x: baseX + (i%3)*320, y: y + Math.floor(i/3)*360 },
          data: {
            shot_index: s.shot_index, action_desc: s.action_desc, image_prompt: s.image_prompt, subtitle_text: s.subtitle_text, dialogue: s.dialogue,
            camera_framing: s.camera_framing, camera_motion: s.camera_motion, emotion: s.emotion, duration: s.duration,
            onUpdate: handleNodeUpdate, onExecute: handleNodeExecute,
          }
        }));
        setNodes(nds=> [...nds, ...newNodes]);
        // 连线
        const newEdges: Edge[] = newNodes.map(n=> ({ id: `e_${nodeId}_${n.id}`, source: nodeId, target: n.id, type:'smoothstep', animated:true }));
        setEdges(es=> [...es, ...newEdges]);
        // 同步将拆解结果保存到项目内容
        if (pid) {
          try { await apiService.saveProjectContent(pid, proj); useProjectStore.getState().setProject(proj as any); } catch {}
        }
      } catch (e:any) { handleNodeUpdate(nodeId,{loading:false, error: e.message}); }
    } else if (node.type==='director3d') {
      const d:any = node.data;
      try {
        const res = await apiService.callMcpTool('director_3d_stage_plan', { framing: d.framing||'medium', motion: d.motion||'push_in', pose: 'stand' });
        const r = (res as any)?.result || res;
        handleNodeUpdate(nodeId,{ minimax_camera_prompt: r.minimax_camera_prompt || JSON.stringify(r).slice(0,120), ...r });
      } catch(e:any){ handleNodeUpdate(nodeId,{error:e.message}); }
    }
  }, [nodes, edges, pid]);

  // P2: 边校验 + 标签 + Provider 透传
  const isValidConnection: any = useCallback((connection:any)=>{
    const c: Connection = connection;
    // 基于 NodeSpec 校验类型兼容
    const src = nodes.find(n=> n.id===c.source);
    const tgt = nodes.find(n=> n.id===c.target);
    if(!src || !tgt) return true;
    const srcSpec = getNodeSpec(src.type || '');
    const tgtSpec = getNodeSpec(tgt.type || '');
    if(!srcSpec || !tgtSpec) return true;
    const srcOut = srcSpec.outputs.find(h=> h.id===c.sourceHandle) || srcSpec.outputs[0];
    const tgtIn = tgtSpec.inputs.find(h=> h.id===c.targetHandle) || tgtSpec.inputs[0];
    if(!srcOut || !tgtIn) return true;
    // 允许 text→text, image→image, video→video, audio→audio, 宽松：text 可连所有 prompt 类
    if(srcOut.type===tgtIn.type) return true;
    if(tgtIn.type==='text' && srcOut.type==='text') return true;
    // provider 型输出可连任意含 provider 的输入
    if(srcOut.id==='provider' && tgtIn.id==='provider') return true;
    return srcOut.type===tgtIn.type;
  }, [nodes]);

  const onConnect = useCallback((params: Connection)=> {
    // 校验
    if(!isValidConnection(params)){
      alert('连线类型不匹配：请检查输出/输入类型（image/audio/video/text/provider）');
      return;
    }
    const srcHandle = params.sourceHandle || 'provider';
    const tgtHandle = params.targetHandle || 'provider';
    const label = `${srcHandle} → ${tgtHandle}`;
    setEdges(es=> addEdge({...params, type:'smoothstep', animated:true, label, data:{mapping:`${srcHandle}->${tgtHandle}`}} as any, es as any));
    setTimeout(()=> {
      const sourceId = params.source;
      const targetId = params.target;
      if (!sourceId || !targetId) return;
      setNodes(nds=> {
        const srcNode = nds.find(n=> n.id===sourceId);
        const tgtNode = nds.find(n=> n.id===targetId);
        if (!srcNode || !tgtNode) return nds;
        const srcType = srcNode.type || '';
        const tgtType = tgtNode.type || '';
        const isProvider = srcType.startsWith('provider');
        const isLoad = srcType.startsWith('load-') || srcType==='text-prompt';
        // Provider 注入
        if (isProvider) {
          const provId = (srcNode.data as any)?.provider_id || (srcNode.data as any)?.provider || srcNode.id;
          const model = (srcNode.data as any)?.model || (srcNode.data as any)?.default_model;
          const def = (srcNode.data as any)?.definition;
          const params = (srcNode.data as any)?.default_params || (srcNode.data as any)?.params;
          return nds.map(n=> n.id===targetId ? { ...n, data: { ...n.data, provider: provId, provider_id: provId, model: model || n.data?.model, definition: def || n.data?.definition, provider_params: params || n.data?.provider_params, _providerName: def?.display_name || def?.name || provId } } : n);
        }
        // Load* / TextPrompt 注入对应字段
        if (isLoad) {
          const srcData:any = srcNode.data;
          const patch:any = {};
          if(srcType==='load-image') patch.first_frame = srcData.image || srcData.url;
          if(srcType==='load-image-batch') patch.reference_images = srcData.images || srcData.image_list;
          if(srcType==='load-video') patch.video = srcData.video || srcData.url;
          if(srcType==='load-audio') patch.audio = srcData.audio || srcData.url;
          if(srcType==='text-prompt') patch.prompt = srcData.prompt || srcData.text;
          // 兼容 r2v 的 reference_images 为 image[] 类型
          if(params.targetHandle==='reference_images' && srcType==='load-image') patch.reference_images = [srcData.image || srcData.url];
          if(params.targetHandle==='reference_images' && srcType==='load-image-batch') patch.reference_images = srcData.images;
          if(params.targetHandle==='first_frame' && srcType==='load-image') patch.first_frame = srcData.image;
          if(params.targetHandle==='prompt' && srcType==='text-prompt') patch.prompt = srcData.prompt;
          if(params.targetHandle==='text' && srcType==='text-prompt') patch.text = srcData.prompt;
          if(Object.keys(patch).length) {
            return nds.map(n=> n.id===targetId ? { ...n, data: {...n.data, ...patch, _upstream: {...(n.data as any)._upstream, ...patch} } } : n);
          }
        }
        // 通用：记录上游数据
        return nds.map(n=> n.id===targetId ? { ...n, data: {...n.data, _upstream: {...(n.data as any)._upstream, _connectedFrom: sourceId, _lastHandle: `${srcHandle}→${tgtHandle}`}}} : n);
      });
    }, 0);
  }, [isValidConnection]);

  const onDrop = useCallback((e: React.DragEvent)=>{
    e.preventDefault();
    const type = e.dataTransfer.getData('application/canvas-nodetype');
    const assetId = e.dataTransfer.getData('application/canvas-assetid');
    const providerId = e.dataTransfer.getData('application/provider-id');
    const providerKind = e.dataTransfer.getData('application/provider-kind') as any;
    if (!type && !assetId && !providerId) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (assetId) {
      const asset = assets.find(a=> a.id===assetId);
      if (!asset) return;
      const node: Node = { id: genId('asset'), type: 'asset', position, data: { ...asset, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } };
      setNodes(nds=> [...nds, node]);
      return;
    }
    if (providerId) {
      const def = providerList.find(p=> p.id===providerId);
      const kind = providerKind || def?.kind || 'image';
      const nodeType = kind==='image' ? 'provider-image' : kind==='video' ? 'provider-video' : kind==='audio' ? 'provider-audio' : 'provider-image';
      const node: Node = { id: genId(nodeType), type: nodeType as any, position, data: { provider_id: providerId, provider: providerId, kind, definition: def, model: def?.default_model || def?.models?.[0] || '', onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } };
      setNodes(nds=> [...nds, node]);
      return;
    }
    const lib = NODE_LIBRARY.find(n=> n.type===type);
    if (!lib) return;
    const node: Node = { id: genId(type), type: type as any, position, data: { onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } };
    // 默认值
    if (type==='brief') node.data = { ...node.data, brief:'', style_preset:'donghua_xianxia', aspect_ratio:'9:16' };
    if (type==='shot-card') node.data = { ...node.data, image_prompt:'masterpiece, cinematic lighting', action_desc:'', subtitle_text:'' };
    if (type==='text-prompt') node.data = { ...node.data, prompt:'' };
    if (type==='load-image') node.data = { ...node.data, image:'' };
    if (type==='load-image-batch') node.data = { ...node.data, images:[] };
    if (type==='load-video') node.data = { ...node.data, video:'' };
    if (type==='load-audio') node.data = { ...node.data, audio:'' };
    if (type && type.startsWith('provider')) {
      const kind = type==='provider-video' ? 'video' : type==='provider-audio' ? 'audio' : 'image';
      node.data = { ...node.data, kind, provider_id: '', model: '' };
    }
    setNodes(nds=> [...nds, node]);
  }, [screenToFlowPosition, assets, providerList]);

  const handleManualSave = async () => {
    if (!pid) { alert('请先在 项目看板 创建/打开项目'); return; }
    setSaving(true);
    try { await apiService.saveProjectCanvas(pid, { nodes, edges }); alert('画布已保存'); } catch(e:any){ alert(e.message);} finally{ setSaving(false); }
  };

  const handleExportToShots = async () => {
    if (!pid) { alert('请先打开项目'); return; }
    const shotNodes = nodes.filter(n=> n.type==='shot-card');
    if (shotNodes.length===0) { alert('画布中无分镜卡节点'); return; }
    // 按 x 排序转 shots
    const sorted = [...shotNodes].sort((a,b)=> a.position.x - b.position.x);
    const shots = sorted.map((n,i)=> {
      const d:any = n.data;
      return {
        id: `shot-${Date.now()}-${i}`,
        shot_index: i+1,
        scene_index: 1,
        camera_framing: d.camera_framing || 'medium',
        camera_motion: d.camera_motion || 'push_in',
        action_desc: d.action_desc || '',
        speaker_name: '',
        dialogue: d.dialogue || '',
        voiceover: '',
        emotion: d.emotion || 'neutral',
        image_prompt: d.image_prompt || '',
        image_url: d.image_url || undefined,
        video_url: d.video_url || undefined,
        duration: 3.5,
        subtitle_text: d.subtitle_text || d.action_desc || '',
        status: 'ready',
      };
    });
    const projContent: any = {
      id: pid,
      title: project?.title || '画布项目',
      original_novel: '',
      style_preset: project?.style_preset || 'donghua_xianxia',
      aspect_ratio: project?.aspect_ratio || '9:16',
      characters: project?.characters || [],
      scenes: [{ id:'scene-1', scene_index:1, title:'场景 1', location:'', time_of_day:'day', atmosphere:'epic', shots }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try { await apiService.saveProjectContent(pid, projContent); useProjectStore.getState().setProject(projContent); alert(`已导出 ${shots.length} 镜到项目，可前往 漫剧制作→分镜工作台 查看`); } catch(e:any){ alert(e.message); }
  };

  const onDragOver = (e: React.DragEvent)=> { e.preventDefault(); e.dataTransfer.dropEffect='move'; };

  if (!pid) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background p-8 text-center space-y-3">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-xl">📁</div>
        <p className="text-sm text-white font-semibold">请先在「漫剧制作 → 项目看板」创建或打开项目</p>
        <p className="text-xs text-gray-500">画布按项目隔离持久化，未选择项目时不会保存</p>
        <button onClick={()=> useProjectStore.getState().setActiveTab('projects')} className="px-4 py-2 rounded-xl bg-brand text-white text-xs">前往项目看板</button>
      </div>
    );
  }

  return (
    <div data-theme="dark" className="flex-1 flex overflow-hidden bg-[#0a0a0f]">
      {/* 左侧节点仓库 — 280px，卡片化、留白、层级 */}
      <div className="w-[300px] bg-surface border-r border-border flex flex-col shrink-0">
        <div className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Library className="w-3.5 h-3.5 text-brand" /></div>
            <span className="text-xs font-bold tracking-tight text-white">节点仓库</span>
          </div>
          <span className="text-[10px] px-2 py-1 rounded-full bg-surface-secondary border border-border text-gray-400">拖拽</span>
        </div>
        <div className="p-3 space-y-4 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2">
            {NODE_LIBRARY.map(n=> (
              <div key={n.type} draggable onDragStart={e=> e.dataTransfer.setData('application/canvas-nodetype', n.type)} className="flex flex-col gap-1.5 p-3 rounded-[14px] bg-surface-secondary border border-border hover:border-brand/30 hover:bg-surface-tertiary hover:shadow-md hover:shadow-brand/5 cursor-grab active:cursor-grabbing transition-all">
                <n.icon className={`w-4 h-4 ${n.color}`}/><div><div className="text-xs font-bold text-white leading-none">{n.label}</div><div className="text-[10px] text-gray-500 leading-none mt-1">{n.desc}</div></div>
              </div>
            ))}
          </div>
          <div className="rounded-[14px] bg-surface-secondary border border-border p-3">
            <div className="text-xs font-bold text-white mb-2 flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5 text-violet-400"/> ComfyUI 工作流 <span className="ml-auto text-[10px] text-gray-500">{workflows.length} 个</span></div>
            <div className="space-y-1 max-h-[160px] overflow-y-auto pr-1">
              {workflows.slice(0,10).map((w:any)=>(
                <div key={w.id} draggable onDragStart={e=>{
                  e.dataTransfer.setData('application/canvas-nodetype','comfy-workflow');
                  (window as any).__dragWorkflowId = w.id;
                }} className="flex items-center gap-2 p-2 rounded-xl bg-surface border border-transparent hover:border-violet-500/30 hover:bg-surface-tertiary cursor-grab">
                  <div className="w-7 h-7 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0"><Cpu className="w-3.5 h-3.5 text-violet-400"/></div>
                  <div className="min-w-0"><div className="text-xs font-medium text-white truncate">{w.name||w.id}</div><div className="text-[10px] text-gray-500">{w.source==='external'?'外部': '内部'} · {w.node_count}节点</div></div>
                </div>
              ))}
              {workflows.length===0 && <div className="text-[11px] text-gray-500 text-center py-4">暂无工作流，去设置里配置目录</div>}
            </div>
          </div>
          <div className="rounded-[14px] bg-surface-secondary border border-border p-3">
            <div className="text-xs font-bold text-white mb-2 flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5 text-brand"/> 生成源 <span className="ml-auto text-[10px] text-gray-500">{providerList.length} 个</span>
              <button onClick={()=> apiService.listProviders({}).then(r=>setProviderList(r.providers||[]))} className="ml-1 text-[10px] text-brand-light hover:underline">刷新</button>
            </div>
            <div className="text-[10px] text-gray-500 mb-2 leading-relaxed">每个生成源为独立节点，可多源并存。拖至画布后连线到分镜卡/视频/TTS。</div>
            <div className="space-y-1 max-h-[160px] overflow-y-auto pr-1">
              {providerList.slice(0,20).map((p:any)=> {
                const kindIcon = p.kind==='image' ? Globe : p.kind==='video' ? VideoIcon : p.kind==='audio' ? Mic : Plug;
                const KindIcon = kindIcon;
                return (
                  <div key={p.id} draggable onDragStart={e=>{
                    e.dataTransfer.setData('application/provider-id', p.id);
                    e.dataTransfer.setData('application/provider-kind', p.kind || 'image');
                  }} className="flex items-center gap-2 p-2 rounded-xl bg-surface border border-transparent hover:border-brand/30 hover:bg-surface-tertiary cursor-grab">
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${p.kind==='image' ? 'bg-violet-500/10 border border-violet-500/20' : p.kind==='video' ? 'bg-orange-500/10 border border-orange-500/20' : 'bg-pink-500/10 border border-pink-500/20'}`}><KindIcon className={`w-3.5 h-3.5 ${p.kind==='image' ? 'text-violet-400' : p.kind==='video' ? 'text-orange-400' : 'text-pink-400'}`}/></div>
                    <div className="min-w-0 flex-1"><div className="text-xs font-medium text-white truncate">{p.display_name || p.name || p.id}</div><div className="text-[10px] text-gray-500 flex items-center gap-1"><span className={`px-1 py-0 rounded text-[9px] ${p.builtin?'bg-brand/20 text-brand-light':'bg-emerald-500/15 text-emerald-400'}`}>{p.builtin?'内置':'自定义'}</span>{p.kind}</div></div>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${p.enabled===false?'bg-gray-500':'bg-emerald-500'}`}/>
                  </div>
                );
              })}
              {providerList.length===0 && <div className="text-[11px] text-gray-500 text-center py-4">暂无生成源，请先创建</div>}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button onClick={()=> window.dispatchEvent(new CustomEvent('open-provider-create', {detail:{kind:'image'}}))} className="flex-1 py-1.5 rounded-lg bg-brand text-white text-[11px]">新建</button>
              <button onClick={()=>{
                const doc = prompt('粘贴 API 文档/cURL，将调用导演自动接入。\n示例：POST https://api.xxx.com/v1/images/generations ...');
                if(doc){
                  const kind = prompt('类型？ image/video/audio', 'image') || 'image';
                  apiService.importProvider({ kind, doc_text: doc, name: `导入${kind}源` }).then(r=>{
                    alert(`✓ 已创建 ${r.provider?.id}`);
                    apiService.listProviders({}).then(x=>setProviderList(x.providers||[]));
                    window.dispatchEvent(new Event('provider-list-refresh'));
                  }).catch(e=> alert(e.message));
                }
              }} className="flex-1 py-1.5 rounded-lg bg-surface border border-border text-[11px] text-white">导演接入</button>
            </div>
          </div>
          <div className="rounded-[14px] bg-surface-secondary border border-border p-3">
            <div className="text-xs font-bold text-white mb-2 flex items-center gap-1.5"><Library className="w-3.5 h-3.5 text-accent-pink"/> 素材 <span className="ml-auto text-[10px] text-gray-500">{assets.length} 个</span></div>
            <div className="flex gap-1.5 mb-2">
              <div className="flex-1 flex items-center gap-1.5 rounded-full bg-surface border border-border px-2.5 py-1 focus-within:border-brand/40">
                <Search className="w-3 h-3 text-gray-500 shrink-0" />
                <input value={assetQuery} onChange={e=>setAssetQuery(e.target.value)} onKeyDown={e=>e.key==='Enter' && apiService.listAssets({project_id: pid, q: assetQuery}).then(r=>setAssets(r.assets||[]))} placeholder="搜索…" className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none min-w-0"/>
              </div>
              <button onClick={()=> apiService.listAssets({project_id: pid, q: assetQuery}).then(r=>setAssets(r.assets||[]))} className="w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center shrink-0"><Search className="w-3 h-3"/></button>
            </div>
            <div className="grid grid-cols-2 gap-2 max-h-[180px] overflow-y-auto pr-1">
              {assets.map((a:any)=>(
                <div key={a.id} draggable onDragStart={e=> e.dataTransfer.setData('application/canvas-assetid', a.id)} className="group bg-surface border border-border rounded-xl overflow-hidden cursor-grab hover:border-brand/30 hover:shadow-md transition-all">
                  <div className="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">{a.thumb_url||a.file_url ? <img src={(a.thumb_url||a.file_url).startsWith('/')? (window.location.port==='5173'?'http://127.0.0.1:8000':'')+(a.thumb_url||a.file_url) : (a.thumb_url||a.file_url)} alt="" className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"/> : <ImageIcon className="w-4 h-4 text-gray-500"/>}</div>
                  <div className="p-2"><div className="text-[11px] font-medium text-white truncate">{a.name}</div><div className="text-[10px] text-gray-500">{a.category}</div></div>
                </div>
              ))}
              {assets.length===0 && <div className="col-span-2 text-[11px] text-gray-500 text-center py-6">无素材，先导入或生成</div>}
            </div>
          </div>
        </div>
        <div className="p-3 border-t border-border space-y-2 bg-surface-secondary/50">
          <button onClick={handleManualSave} disabled={saving} className="w-full py-2.5 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 shadow-md shadow-brand/10"><Save className="w-3.5 h-3.5"/>{saving?'保存中': '保存画布'}</button>
          <button onClick={handleExportToShots} className="w-full py-2.5 rounded-full bg-white dark:bg-white text-surface dark:text-surface text-xs font-bold flex items-center justify-center gap-1.5 border border-border "><Download className="w-3.5 h-3.5"/> 导出为分镜</button>
          <p className="text-[10px] text-gray-500 text-center leading-relaxed">选中节点后「执行选中」批量生成<br/>自动保存已开启</p>
        </div>
      </div>

      {/* 画布 — 工具带 + 画布 */}
      <div ref={wrapperRef} className="flex-1 relative bg-[#08080B] flex flex-col min-w-0" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="h-10 px-3 border-b border-border bg-surface/80 backdrop-blur flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
            <span className="text-gray-300">项目</span><span className="font-mono text-white">{pid.slice(0,8)}</span><span className="text-gray-500 hidden sm:inline">· 自动保存 · 拖拽连线 · 框选</span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <button onClick={()=> setNodes(nds=> nds.map((n,i)=> ({...n, position:{ x: 80 + (i%4)*360, y: 80 + Math.floor(i/4)*320 }})))} className="hidden sm:inline px-3 py-1 rounded-full bg-surface-secondary border border-border text-xs text-white hover:border-border-active">自动排布</button>
            <button onClick={()=> handleBatchExecute('selected')} disabled={executing || selectedIds.length===0} className="px-3.5 py-1.5 rounded-full bg-violet-600 text-white text-xs font-bold disabled:opacity-40">{executing?'执行中':`执行选中${selectedIds.length?` · ${selectedIds.length}`:''}`}</button>
            <button onClick={()=> handleBatchExecute('all')} disabled={executing || nodes.length===0} className="px-3.5 py-1.5 rounded-full bg-brand text-white text-xs font-bold disabled:opacity-40">执行全画布</button>
            <button onClick={()=> { if(confirm('清空画布？')){ setNodes([]); setEdges([]); } }} className="w-8 h-8 rounded-full bg-surface-secondary border border-border text-gray-400 hover:text-red-400 flex items-center justify-center" title="清空">×</button>
          </div>
        </div>
        <div className="flex-1 relative">
          <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection} nodeTypes={nodeTypes} onSelectionChange={({nodes:sel})=> setSelectedIds(sel.map(n=>n.id))} deleteKeyCode="Delete" fitView className="bg-[#08080B]">
            <Background color="#1a1a2e" gap={20}/>
            <Controls className="!bg-surface !border-border" />
            <MiniMap className="!bg-surface !border-border" nodeColor={(n:any)=> n.type==='shot-card' ? '#7c3aed' : n.type==='comfy-workflow' ? '#8b5cf6' : String(n.type||'').startsWith('load-') ? '#10b981' : n.type==='text-prompt' ? '#0ea5e9' : '#333'} />
          </ReactFlow>
        </div>
      </div>

      {inspectWfId && <WorkflowInspectorModal workflowId={inspectWfId} isOpen={!!inspectWfId} onClose={()=>setInspectWfId('')} onSaved={()=>{ /* 刷新暴露输入 */ }} /> }
    </div>
  );
};

export const CreativeCanvas: React.FC = () => (
  <ReactFlowProvider><InnerCanvas /></ReactFlowProvider>
);
