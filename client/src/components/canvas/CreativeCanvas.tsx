import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, addEdge, Connection, Edge, Node, ReactFlowProvider, useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, Sparkles, Image as ImageIcon, Film, Box, Library, Cpu, Save, Download, Plug, Globe, Mic, Video as VideoIcon, Type, Plus, Wand2, FileText, Layers, Play, Trash2 } from 'lucide-react';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { useThemeStore } from '../../stores/useThemeStore';
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
import { PromptNode, ImageNode, VideoGenNode, AudioNode, Director3DMinimalNode, ExportNode } from './nodes/MinimalNodes';
import { WorkflowInspectorModal } from '../workflow/WorkflowInspectorModal';
import { getNodeSpec } from './nodeRegistry';

const nodeTypes: any = {
  // 新 6 核心
  'prompt': PromptNode,
  'image': ImageNode,
  'video': VideoGenNode,
  'audio': AudioNode,
  'director3d': Director3DMinimalNode,
  'export': ExportNode,
  // 兼容旧
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

// 仅 6 核心展示
const CORE_LIBRARY = [
  { type: 'prompt', label: '提示词', desc: '文本描述', icon: Type, color: 'text-sky-600' },
  { type: 'image', label: '生成图片', desc: '文生图/垫图', icon: ImageIcon, color: 'text-violet-600' },
  { type: 'video', label: '生成视频', desc: 'I2V/R2V', icon: Film, color: 'text-orange-600' },
  { type: 'audio', label: '生成音频', desc: 'TTS 配音', icon: Mic, color: 'text-pink-600' },
  { type: 'director3d', label: '3D导演台', desc: '机位编排', icon: Box, color: 'text-amber-600' },
  { type: 'export', label: '导出', desc: '剪映草稿', icon: Download, color: 'text-emerald-600' },
];

const TEMPLATES = [
  { id:'t1', label:'文生图 → 图生视频', desc:'提示词 → 图片 → 视频', nodes:['prompt','image','video'] },
  { id:'t2', label:'完整漫剧', desc:'提示词 → 图片 → 视频 → 音频 → 导出', nodes:['prompt','image','video','audio','export'] },
  { id:'t3', label:'单图转视频', desc:'图片 → 视频', nodes:['image','video'] },
];

const InnerCanvas: React.FC = () => {
  const { project } = useProjectStore();
  const { activeProjectId } = useProjectListStore();
  const { effectiveTheme } = useThemeStore();
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
  const [isLoading, setIsLoading] = useState(true);
  const [bottomPrompt, setBottomPrompt] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const pidRef = useRef<string|null>(null);
  const [mousePos, setMousePos] = useState<{x:number,y:number}|null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const h = (e: any) => setInspectWfId(e.detail?.workflowId || '');
    window.addEventListener('open-workflow-inspector', h as any);
    return () => window.removeEventListener('open-workflow-inspector', h as any);
  }, []);

  // 加载 - 带超时与重置，防止一直加载
  useEffect(() => {
    if (!pid) { setIsLoading(false); return; }
    // pid 切换时重置
    if (pidRef.current !== pid) {
      pidRef.current = pid;
      loadedRef.current = false;
      setIsLoading(true);
    }
    if (loadedRef.current) { setIsLoading(false); return; }
    loadedRef.current = true;
    setIsLoading(true);
    const timer = setTimeout(()=> setIsLoading(false), 3000);
    loadCanvas().then(snap => {
      if (snap && Array.isArray(snap.nodes)) {
        const withHandlers = snap.nodes.map((n:any)=> ({...n, data:{...n.data, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute}}));
        setNodes(withHandlers);
        if (Array.isArray(snap.edges)) setEdges(snap.edges);
      }
      clearTimeout(timer);
      setIsLoading(false);
    }).catch((e)=>{ console.warn('[Canvas] load failed', e); clearTimeout(timer); setIsLoading(false); });
    apiService.listAssets({ project_id: pid || undefined, limit: 24 }).then(r=> setAssets(r.assets||[])).catch(()=>{});
    const onAssetRefresh = () => apiService.listAssets({ project_id: pid || undefined, limit: 24 }).then(r=> setAssets(r.assets||[])).catch(()=>{});
    window.addEventListener('asset-refresh', onAssetRefresh as any);
    return ()=> { clearTimeout(timer); window.removeEventListener('asset-refresh', onAssetRefresh as any); };
  }, [pid]);

  const histRef = useRef<{nodes:any[],edges:any[]}[]>([]);
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
    const snap = { nodes, edges, viewport: vp, updated_at: new Date().toISOString(), version: 2 };
    debouncedSave(snap);
    try { useCanvasStore.getState().setFromFlow(nodes as any, edges as any); } catch {}
  }, [nodes, edges]);

  // 单端点逐步执行：每个节点独立可点，执行后结果自动流向下游（覆盖传统全流程）
  const handleNodeUpdate = useCallback((nodeId: string, patch: any) => {
    setNodes(nds=> {
      // 先更新源节点
      let next = nds.map(n=> n.id===nodeId ? { ...n, data: { ...n.data, ...patch, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } } : n);
      // 若 patch 含可传播字段，则同步到下游节点的 _upstream 与直连字段
      const propagatable = patch.image_url || patch.result_url || patch.video_url || patch.audio_url || patch.prompt || patch.text || patch.reference || patch.first_frame;
      if (propagatable) {
        const downstreamEdges = edges.filter(e=> e.source===nodeId);
        for(const e of downstreamEdges){
          const tgtIdx = next.findIndex(n=> n.id===e.target);
          if(tgtIdx===-1) continue;
          const tgt = next[tgtIdx];
          const srcData = next.find(n=> n.id===nodeId)?.data as any;
          const patchDown:any = { _upstream: { ...((tgt.data as any)._upstream||{}) } };
          // 按句柄精确映射
          const th = (e as any).targetHandle || '';
          if(patch.image_url || patch.result_url){
            const url = patch.image_url || patch.result_url || srcData?.image_url;
            if(th==='first_frame' || th==='image' || th==='reference' || tgt.type==='video'){
              patchDown.first_frame = url; patchDown.image_url = url; patchDown.reference = url;
            }
            patchDown.image_url = url;
            patchDown._upstream.image_url = url;
            patchDown._upstream.reference = url;
          }
          if(patch.video_url){
            patchDown.video_url = patch.video_url;
            patchDown._upstream.video_url = patch.video_url;
          }
          if(patch.audio_url){
            patchDown.audio_url = patch.audio_url;
            patchDown._upstream.audio_url = patch.audio_url;
          }
          if(patch.prompt || patch.text){
            const txt = patch.prompt || patch.text || srcData?.prompt;
            if(th==='prompt' || th==='text' || tgt.type==='image' || tgt.type==='video' || tgt.type==='audio' || tgt.type==='prompt'){
              patchDown.prompt = txt; patchDown.text = txt;
            }
            patchDown._upstream.prompt = txt; patchDown._upstream.text = txt;
          }
          // 合并
          next[tgtIdx] = { ...tgt, data: { ...tgt.data, ...patchDown, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute, _upstream: patchDown._upstream } } as any;
        }
      }
      return next;
    });
  }, [edges]);

  const handleNodeExecute = useCallback(async (nodeId: string) => {
    const node = nodes.find(n=> n.id===nodeId);
    if (!node) return;
    if (node.type==='director3d') {
      const d:any = node.data;
      try {
        const res = await apiService.callMcpTool('director_3d_stage_plan', { framing: d.framing||'medium', motion: d.motion||'push_in', pose: 'stand' });
        const r = (res as any)?.result || res;
        handleNodeUpdate(nodeId,{ minimax_camera_prompt: r.minimax_camera_prompt || JSON.stringify(r).slice(0,120), ...r });
      } catch(e:any){ handleNodeUpdate(nodeId,{error:e.message}); }
    }
  }, [nodes]);

  const isValidConnection: any = useCallback((connection:any)=>{
    const c: Connection = connection;
    const src = nodes.find(n=> n.id===c.source);
    const tgt = nodes.find(n=> n.id===c.target);
    if(!src || !tgt) return true;
    const srcSpec = getNodeSpec(src.type || '');
    const tgtSpec = getNodeSpec(tgt.type || '');
    if(!srcSpec || !tgtSpec) return true;
    const srcOut = srcSpec.outputs.find(h=> h.id===c.sourceHandle) || srcSpec.outputs[0];
    const tgtIn = tgtSpec.inputs.find(h=> h.id===c.targetHandle) || tgtSpec.inputs[0];
    if(!srcOut || !tgtIn) return true;
    if(srcOut.type===tgtIn.type) return true;
    if(tgtIn.type==='text' && srcOut.type==='text') return true;
    return srcOut.type===tgtIn.type;
  }, [nodes]);

  const onConnect = useCallback((params: Connection)=> {
    if(!isValidConnection(params)){
      alert('连线类型不匹配');
      return;
    }
    setEdges(es=> addEdge({...params, type:'smoothstep', animated:true } as any, es as any));
    setTimeout(()=> {
      const sourceId = params.source;
      const targetId = params.target;
      if (!sourceId || !targetId) return;
      setNodes(nds=> {
        const srcNode = nds.find(n=> n.id===sourceId);
        const tgtNode = nds.find(n=> n.id===targetId);
        if (!srcNode || !tgtNode) return nds;
        // 注入 _upstream 便于节点即时预览
        const srcData:any = srcNode.data;
        const patch:any = {};
        // 推断类型
        const srcType = srcNode.type || '';
        if(['prompt','text-prompt','brief'].includes(srcType)){
          patch.prompt = srcData.prompt || srcData.text || srcData.brief || '';
          patch.text = patch.prompt;
        }
        if(['image','shot-card','comfy-workflow','load-image'].includes(srcType)){
          const url = srcData.image_url || srcData.result_url || srcData.image || srcData.url || srcData.file_url;
          if(url){
            if(params.targetHandle==='first_frame' || (tgtNode.type==='video' && !patch.first_frame)) patch.first_frame = url;
            patch.image_url = url;
            patch.reference = url;
          }
        }
        if(srcType==='video' && srcData.video_url) patch.video_url = srcData.video_url;
        if(['audio','tts'].includes(srcType) && srcData.audio_url) patch.audio_url = srcData.audio_url;
        if(Object.keys(patch).length){
          return nds.map(n=> n.id===targetId ? { ...n, data:{...n.data, ...patch, _upstream:{...(n.data as any)._upstream, ...patch}}} : n);
        }
        return nds;
      });
    }, 0);
  }, [isValidConnection]);

  const createNode = (type:string, position:{x:number,y:number}) => {
    const node: Node = { id: genId(type), type: type as any, position, data: { onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } };
    if(type==='prompt') node.data = {...node.data, prompt: bottomPrompt || '' };
    if(type==='image') node.data = {...node.data, prompt: '', engine_type:'auto' };
    if(type==='video') node.data = {...node.data, prompt:'', mode:'i2v', duration:5, engine_type:'auto' };
    if(type==='audio') node.data = {...node.data, text:'', engine_type:'auto' };
    if(type==='director3d') node.data = {...node.data, framing:'medium', motion:'push_in' };
    if(type==='export') node.data = {...node.data };
    return node;
  };

  const addTemplate = (tpl:any) => {
    const baseX = 120;
    const baseY = 80;
    const newNodes: Node[] = tpl.nodes.map((t:string, i:number)=> createNode(t, { x: baseX, y: baseY + i*360 }));
    const newEdges: Edge[] = [];
    for(let i=1;i<newNodes.length;i++){
      const prev = newNodes[i-1];
      const cur = newNodes[i];
      // 自动连线：根据类型推断 handle
      let sh='prompt', th='prompt';
      if(prev.type==='prompt' && cur.type==='image'){ sh='prompt'; th='prompt'; }
      else if(prev.type==='image' && cur.type==='video'){ sh='image'; th='first_frame'; }
      else if(prev.type==='video' && cur.type==='audio'){ sh='video'; th='video'; }
      else if(prev.type==='audio' && cur.type==='export'){ sh='audio'; th='audio'; }
      else if(prev.type==='prompt' && cur.type==='video'){ sh='prompt'; th='prompt'; }
      else if(prev.type==='video' && cur.type==='export'){ sh='video'; th='video'; }
      else { sh = (prev.type as any); th = 'prompt'; }
      newEdges.push({ id:`e_${prev.id}_${cur.id}`, source:prev.id, target:cur.id, sourceHandle:sh, targetHandle:th, type:'smoothstep', animated:true } as any);
    }
    setNodes(nds=> [...nds, ...newNodes]);
    setEdges(es=> [...es, ...newEdges]);
    if(tpl.nodes.includes('prompt') && bottomPrompt){
      // 将底部输入同步到首个 prompt
      setTimeout(()=> {
        const firstPrompt = newNodes.find(n=> n.type==='prompt');
        if(firstPrompt) handleNodeUpdate(firstPrompt.id, { prompt: bottomPrompt, text: bottomPrompt });
      }, 100);
    }
  };

  // 监听节点 + 菜单
  useEffect(()=>{
    const onAdd = (e:any)=>{
      const { sourceId, nextType } = e.detail;
      const src = nodes.find(n=> n.id===sourceId);
      const pos = src ? { x: src.position.x, y: src.position.y + 340 } : { x: 120, y: 120 + nodes.length*340 };
      const node = createNode(nextType, pos);
      setNodes(nds=> [...nds, node]);
      if(src){
        const edge: Edge = { id:`e_${sourceId}_${node.id}`, source:sourceId, target:node.id, type:'smoothstep', animated:true } as any;
        // 智能 handle
        if(src.type==='prompt' && nextType==='image') { (edge as any).sourceHandle='prompt'; (edge as any).targetHandle='prompt'; }
        if(src.type==='image' && nextType==='video') { (edge as any).sourceHandle='image'; (edge as any).targetHandle='first_frame'; }
        if(src.type==='video' && nextType==='export') { (edge as any).sourceHandle='video'; (edge as any).targetHandle='video'; }
        if(src.type==='audio' && nextType==='export') { (edge as any).sourceHandle='audio'; (edge as any).targetHandle='audio'; }
        setEdges(es=> [...es, edge]);
      }
    };
    window.addEventListener('canvas-add-node', onAdd as any);
    return ()=> window.removeEventListener('canvas-add-node', onAdd as any);
  }, [nodes]);

  // 导出为分镜
  useEffect(()=>{
    const h = async ()=>{
      if(!pid){ alert('请先打开项目'); return; }
      // 收集所有 image/video 节点按 y 排序
      const gens = nodes.filter(n=> ['image','video','prompt'].includes(n.type as string));
      if(gens.length===0){ alert('画布为空，无法导出'); return; }
      const sorted = [...gens].sort((a,b)=> a.position.y - b.position.y);
      const shots = sorted.filter(n=> n.type==='image' || n.type==='video').map((n,i)=>{
        const d:any=n.data;
        return {
          id:`shot-${Date.now()}-${i}`, shot_index:i+1, scene_index:1,
          camera_framing:'medium', camera_motion:'push_in',
          action_desc: d.prompt || d.image_prompt || '', dialogue: d.text || '',
          image_prompt: d.prompt || '', image_url: d.image_url || d.result_url, video_url: d.video_url,
          duration: d.duration || 5, subtitle_text: d.prompt || '', status:'ready'
        };
      });
      if(shots.length===0) shots.push({ id:`shot-${Date.now()}`, shot_index:1, scene_index:1, camera_framing:'medium', camera_motion:'push_in', action_desc: bottomPrompt || '空', dialogue:'', image_prompt: bottomPrompt||'', duration:5, subtitle_text: bottomPrompt||'', status:'ready'} as any);
      const projContent:any = { id: pid, title: project?.title||'画布项目', original_novel:'', style_preset: project?.style_preset||'donghua_xianxia', aspect_ratio:'9:16', characters: project?.characters||[], scenes:[{ id:'scene-1', scene_index:1, title:'场景1', location:'', time_of_day:'day', atmosphere:'epic', shots }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      try{ await apiService.saveProjectContent(pid, projContent); useProjectStore.getState().setProject(projContent); alert(`已导出 ${shots.length} 镜到项目`);}catch(e:any){ alert(e.message); }
    };
    window.addEventListener('canvas-export-shots', h as any);
    return ()=> window.removeEventListener('canvas-export-shots', h as any);
  }, [nodes, pid, project, bottomPrompt]);

  const onDrop = useCallback((e: React.DragEvent)=>{
    e.preventDefault();
    const type = e.dataTransfer.getData('application/canvas-nodetype');
    const assetId = e.dataTransfer.getData('application/canvas-assetid');
    const assetUrl = e.dataTransfer.getData('text/plain');
    if (!type && !assetId && !assetUrl) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (assetId) {
      const asset = assets.find(a=> a.id===assetId);
      if (!asset) return;
      // 拖素材到画布：创建一个 image 节点并带入 reference
      const node = createNode('image', position);
      const url = asset.thumb_url || asset.file_url;
      const abs = url?.startsWith('/')? `http://127.0.0.1:8000${url}`: url;
      node.data = { ...node.data, reference: abs || url, image_url: abs || url };
      setNodes(nds=> [...nds, node]);
      return;
    }
    if(type){
      const node = createNode(type, position);
      setNodes(nds=> [...nds, node]);
    }
  }, [screenToFlowPosition, assets]);

  const handleManualSave = async () => {
    if (!pid) { alert('请先在 项目看板 创建/打开项目'); return; }
    setSaving(true);
    try { await apiService.saveProjectCanvas(pid, { nodes, edges, version:2 }); alert('画布已保存'); } catch(e:any){ alert(e.message);} finally{ setSaving(false); }
  };

  const onDragOver = (e: React.DragEvent)=> { e.preventDefault(); e.dataTransfer.dropEffect='move'; };

  // 鼠标高可见性：跟随光晕 + 抓取态
  useEffect(()=>{
    const el = wrapperRef.current;
    if(!el) return;
    const onMove = (e: MouseEvent)=> {
      const rect = el.getBoundingClientRect();
      setMousePos({x: e.clientX - rect.left, y: e.clientY - rect.top});
    };
    const onDown = ()=> setIsDragging(true);
    const onUp = ()=> setIsDragging(false);
    el.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return ()=> { el.removeEventListener('mousemove', onMove); window.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Agent 画布联动：监听导演 Agent 的 canvas 工具结果，实时同步（全流程参与）
  useEffect(()=>{
    const onAgentCanvas = (e: any)=>{
      const { tool, status, result } = e.detail || {};
      if (status !== 'success' || !result) return;
      if (['canvas_create_node','canvas_update_node','canvas_connect','canvas_query'].includes(tool)) {
        if (!pid) return;
        apiService.getProjectCanvas(pid).then(snap=>{
          const canvas = (snap as any)?.canvas || snap;
          if (canvas && Array.isArray(canvas.nodes)) {
            const withHandlers = canvas.nodes.map((n:any)=> ({...n, data:{...n.data, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute}}));
            setNodes(withHandlers);
            if (Array.isArray(canvas.edges)) setEdges(canvas.edges);
          }
        }).catch(()=>{});
      }
      if (tool === 'canvas_execute' && result?.results) {
        const resMap: any = result.results || {};
        setNodes(nds=> nds.map(n=>{
          const r = resMap[n.id];
          if (!r || r.status !== 'success') return n;
          const patch: any = {};
          if (r.image_url) patch.image_url = r.image_url;
          if (r.result_url) patch.result_url = r.result_url;
          if (r.video_url) patch.video_url = r.video_url;
          if (r.audio_url) patch.audio_url = r.audio_url;
          if (r.prompt) patch.prompt = r.prompt;
          if (Object.keys(patch).length) return { ...n, data: {...n.data, ...patch, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute}};
          return n;
        }));
      }
    };
    const onAgentCanvasUpdated = ()=>{
      if (!pid) return;
      apiService.getProjectCanvas(pid).then(snap=>{
        const canvas = (snap as any)?.canvas || snap;
        if (canvas && Array.isArray(canvas.nodes)) {
          const withHandlers = canvas.nodes.map((n:any)=> ({...n, data:{...n.data, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute}}));
          setNodes(withHandlers);
          if (Array.isArray(canvas.edges)) setEdges(canvas.edges);
        }
      }).catch(()=>{});
    };
    window.addEventListener('agent-canvas-tool' as any, onAgentCanvas);
    window.addEventListener('agent-canvas-updated' as any, onAgentCanvasUpdated);
    return ()=> {
      window.removeEventListener('agent-canvas-tool' as any, onAgentCanvas);
      window.removeEventListener('agent-canvas-updated' as any, onAgentCanvasUpdated);
    };
  }, [pid, handleNodeUpdate, handleNodeExecute]);

  if (!pid) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3" style={{background: isLight ? "#E8ECF1" : "#08080B"}}>
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-xl shadow-lg shadow-brand/20">📁</div>
        <p className="text-sm [color:var(--color-text-main)] font-semibold">请先在「漫剧制作 → 项目看板」创建或打开项目</p>
        <p className="text-xs text-gray-400">画布按项目隔离持久化</p>
        <button onClick={()=> useProjectStore.getState().setActiveTab('projects')} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold hover:bg-brand-light shadow-md">前往项目看板</button>
      </div>
    );
  }

  const isEmpty = nodes.length===0;

  return (
    <div className="flex-1 flex overflow-hidden" style={{background: isLight ? "#E8ECF1" : "#08080B", cursor: 'default'}}>
      {/* 左侧：极简工具栏 — 暗色工业风 */}
      <div className="w-[280px] bg-surface border-r border-border flex flex-col shrink-0">
        <div className="h-12 px-4 border-b border-border flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Layers className="w-3.5 h-3.5 text-brand"/></div>
          <span className="text-sm font-bold" style={{color: "var(--color-text-main)"}}>工作流</span>
          <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-surface-secondary border border-border text-gray-400">6 节点</span>
        </div>
        <div className="p-3 space-y-4 flex-1 overflow-y-auto">
          {/* 模板 */}
          <div>
            <div className="text-xs font-bold mb-2" style={{color: "var(--color-text-main)"}}>一键模板</div>
            <div className="space-y-2">
              {TEMPLATES.map(t=>(
                <button key={t.id} onClick={()=> addTemplate(t)} className="w-full text-left p-3 rounded-2xl border border-border bg-surface-secondary hover:border-brand/40 hover:bg-surface-tertiary hover:shadow-md transition-all">
                  <div className="text-sm font-semibold" style={{color: "var(--color-text-main)"}}>{t.label}</div>
                  <div className="text-xs text-gray-400">{t.desc}</div>
                  <div className="mt-1.5 flex gap-1">{t.nodes.map((n,i)=> <span key={i} className="w-6 h-6 rounded-full bg-surface border border-border flex items-center justify-center text-[10px] text-gray-300">{n[0].toUpperCase()}</span>)}</div>
                </button>
              ))}
            </div>
          </div>
          {/* 6 节点 */}
          <div>
            <div className="text-xs font-bold mb-2" style={{color: "var(--color-text-main)"}}>基础节点</div>
            <div className="grid grid-cols-2 gap-2">
              {CORE_LIBRARY.map(n=> (
                <div key={n.type} draggable onDragStart={e=> e.dataTransfer.setData('application/canvas-nodetype', n.type)} className="flex flex-col gap-2 p-3 rounded-2xl bg-surface-secondary border border-border hover:border-brand/30 hover:bg-surface-tertiary hover:shadow-md cursor-grab active:cursor-grabbing transition-all">
                  <n.icon className={`w-5 h-5 ${n.color}`}/><div><div className="text-sm font-semibold [color:var(--color-text-main)] leading-none">{n.label}</div><div className="text-[11px] text-gray-400 mt-1">{n.desc}</div></div>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-gray-400 leading-relaxed bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5">💡 每个节点内部可切换 <b>API / ComfyUI</b> 引擎，参考图可从素材库拖入或在节点内上传。</div>
          </div>
          {/* 素材 */}
          <div className="rounded-2xl border border-border bg-surface p-3">
            <div className="text-xs font-bold [color:var(--color-text-main)] mb-2 flex items-center gap-1.5"><Library className="w-3.5 h-3.5 text-brand"/> 素材库 <span className="ml-auto text-[10px] text-gray-400">{assets.length} 个</span></div>
            <div className="flex gap-1.5 mb-2">
              <div className="flex-1 flex items-center gap-1.5 rounded-full bg-surface-secondary border border-border px-3 py-1.5 focus-within:border-brand/40 focus-within:bg-surface-tertiary">
                <Search className="w-3 h-3 text-gray-500 shrink-0" />
                <input value={assetQuery} onChange={e=>setAssetQuery(e.target.value)} onKeyDown={e=>e.key==='Enter' && apiService.listAssets({project_id: pid, q: assetQuery}).then(r=>setAssets(r.assets||[]))} placeholder="搜索…" className="flex-1 bg-transparent text-sm [color:var(--color-text-main)] placeholder-gray-500 focus:outline-none min-w-0"/>
              </div>
              <button onClick={()=> apiService.listAssets({project_id: pid, q: assetQuery}).then(r=>setAssets(r.assets||[]))} className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center shrink-0 hover:bg-brand-light"><Search className="w-3 h-3"/></button>
            </div>
            <div className="grid grid-cols-2 gap-2 max-h-[200px] overflow-y-auto pr-1">
              {assets.map((a:any)=>{
                const url = a.thumb_url || a.file_url;
                const abs = url?.startsWith('/')? `http://127.0.0.1:8000${url}`: url;
                return (
                  <div key={a.id} draggable onDragStart={e=> { e.dataTransfer.setData('application/canvas-assetid', a.id); e.dataTransfer.setData('text/plain', abs||url);}} className="group bg-surface-secondary border border-border rounded-xl overflow-hidden cursor-grab hover:border-brand/30 hover:shadow-md transition-all">
                    <div className="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">{abs ? <img src={abs} alt="" className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"/> : <ImageIcon className="w-5 h-5 text-gray-600"/>}</div>
                    <div className="p-2"><div className="text-xs font-medium truncate [color:var(--color-text-main)]">{a.name}</div><div className="text-[10px] text-gray-400">{a.category}</div></div>
                  </div>
                );
              })}
              {assets.length===0 && <div className="col-span-2 text-xs text-gray-500 text-center py-6">暂无素材，拖入或生成后自动出现</div>}
            </div>
          </div>
        </div>
        <div className="p-3 border-t border-border space-y-2 bg-surface-secondary/50">
          <button onClick={handleManualSave} disabled={saving} className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 hover:bg-brand-light shadow-md shadow-brand/20"><Save className="w-4 h-4"/>{saving?'保存中': '保存画布'}</button>
          <button onClick={()=> window.dispatchEvent(new CustomEvent('canvas-export-shots'))} className="w-full py-2.5 rounded-xl bg-surface-secondary border border-border text-sm font-bold [color:var(--color-text-main)] flex items-center justify-center gap-1.5 hover:bg-surface-tertiary hover:border-border-active"><Download className="w-4 h-4"/> 导出为分镜</button>
        </div>
      </div>

      {/* 中间画布 — 暗色画布区，鼠标高对比 */}
      <div ref={wrapperRef} className="flex-1 relative flex flex-col min-w-0" style={{background: isLight ? "#E8ECF1" : "#08080B"}} onDrop={onDrop} onDragOver={onDragOver}>
        <div className="h-11 px-3 border-b border-border bg-surface flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow shadow-emerald-500/30" />
            <span className="text-gray-400">项目</span><span className="font-mono [color:var(--color-text-main)] text-xs">{pid.slice(0,8)}</span><span className="text-gray-500 hidden sm:inline text-xs">· 点卡片右侧 + 串行 · 拖素材到节点</span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <span className="hidden sm:inline px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">● 单点执行 · 结果自动流向下游</span>
            <button onClick={()=> setNodes(nds=> nds.map((n,i)=> ({...n, position:{ x: 120, y: 80 + i*380 }})))} className="px-3 py-1.5 rounded-full bg-surface-secondary border border-border text-xs font-medium [color:var(--color-text-main)] hover:bg-surface-tertiary hover:border-border-active">竖向排布</button>
            <button onClick={()=> { if(confirm('清空画布？')){ setNodes([]); setEdges([]); } }} className="w-8 h-8 rounded-full bg-surface-secondary border border-border text-gray-400 hover:text-red-400 hover:border-red-500/30 flex items-center justify-center" title="清空">×</button>
          </div>
        </div>
        <div className="flex-1 relative">
          {isLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 gap-4" style={{background: isLight ? "#E8ECF1" : "#08080B"}}>
              <div className="w-8 h-8 border-2 border-zinc-700 border-t-brand rounded-full animate-spin"/>
              <div className="text-sm text-gray-400">画布加载中…</div>
              <button onClick={()=> setIsLoading(false)} className="text-xs text-brand hover:underline">跳过等待，直接显示</button>
            </div>
          ) : isEmpty ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 gap-6 overflow-y-auto" style={{background: isLight ? "#E8ECF1" : "#08080B"}}>
              <div className="w-full max-w-[720px] bg-surface border border-border rounded-[24px] shadow-xl p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl bg-brand flex items-center justify-center shadow-md shadow-brand/20"><Wand2 className="w-5 h-5 text-white"/></div>
                  <div><div className="text-[15px] font-bold [color:var(--color-text-main)]">从一个想法开始</div><div className="text-xs text-gray-400">选择模板或直接在下方输入提示词，一键生成线性工作流</div></div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {TEMPLATES.map(t=>(
                    <button key={t.id} onClick={()=> addTemplate(t)} className="p-4 rounded-2xl border-2 border-border bg-surface-secondary hover:border-brand/40 hover:bg-surface-tertiary text-left group">
                      <div className="w-8 h-8 rounded-xl bg-surface border border-border flex items-center justify-center mb-2 group-hover:border-brand/20"><Layers className="w-4 h-4 text-gray-300"/></div>
                      <div className="text-sm font-bold [color:var(--color-text-main)]">{t.label}</div>
                      <div className="text-xs text-gray-400 mt-1">{t.desc}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs text-gray-500"><div className="h-px flex-1 bg-border"/><span>或</span><div className="h-px flex-1 bg-border"/></div>
                <div className="mt-4 flex gap-2">
                  {CORE_LIBRARY.slice(0,4).map(n=> (
                    <button key={n.type} onClick={()=> setNodes([createNode(n.type, {x:200, y:120})])} className="flex-1 py-2.5 rounded-xl bg-surface-secondary border border-border text-sm font-medium [color:var(--color-text-main)] hover:border-brand/30 hover:bg-surface-tertiary flex flex-col items-center gap-1">
                      <n.icon className={`w-5 h-5 ${n.color}`}/><span style={{color: "var(--color-text-main)"}}>{n.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="text-xs text-gray-500">💡 每个节点内可切换 API / ComfyUI，参考图从素材库拖入即可</div>
            </div>
          ) : (
            <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection} nodeTypes={nodeTypes} deleteKeyCode="Delete" fitView className="" style={{background: isLight ? "#E8ECF1" : "#08080B", cursor: isDragging ? "grabbing" : "crosshair"}}>
              <Background color={isLight ? "#CBD5E1" : "#1E1E2A"} gap={20} size={1}/>
              <Controls className="!bg-surface !border-border !rounded-xl shadow-lg ![color:var(--color-text-main)] [&_button]:!bg-surface [&_button]:!border-border [&_button]:![color:var(--color-text-main)] hover:[&_button]:!bg-surface-secondary" />
              <MiniMap className="!bg-surface !border-border" maskColor="rgba(10,10,12,0.8)" nodeColor={(n:any)=> n.type==='image' ? '#7C3AED' : n.type==='video' ? '#F97316' : n.type==='audio' ? '#EC4899' : n.type==='prompt' ? '#06B6D4' : '#3F3F50'} />
            </ReactFlow>
          )}
          {/* 鼠标高可见光晕（暗底高对比） */}
          {mousePos && !isEmpty && !isLoading && (
            <div className="pointer-events-none absolute w-7 h-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand/70 bg-brand/15 shadow-lg shadow-brand/30 hidden lg:block" style={{left: mousePos.x, top: mousePos.y}} />
          )}
        </div>
        {/* 底部输入条 — 暗色 */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[min(720px,92%)] bg-surface border border-border rounded-[20px] shadow-2xl shadow-black/40 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button onClick={()=> {
              const rect = wrapperRef.current?.getBoundingClientRect();
              const pos = { x: 200, y: 80 + nodes.length*380 };
              const n = createNode('prompt', pos);
              setNodes(nds=> [...nds, n]);
            }} className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center hover:bg-brand-light shadow-md"><Plus className="w-4 h-4"/></button>
            <input value={bottomPrompt} onChange={e=>setBottomPrompt(e.target.value)} onKeyDown={e=>{
              if(e.key==='Enter' && !e.shiftKey){
                e.preventDefault();
                if(!bottomPrompt.trim()) return;
                if(isEmpty){
                  const tpl = TEMPLATES[1];
                  addTemplate(tpl);
                  setTimeout(()=> {
                    const first = nodes.find(n=> n.type==='prompt');
                    if(!first){
                      // 新模板已含 prompt，更新它
                      setNodes(nds=> nds.map(n=> n.type==='prompt' && !n.data.prompt ? {...n, data:{...n.data, prompt: bottomPrompt, text: bottomPrompt}} : n));
                    }
                  }, 200);
                } else {
                  const last = nodes[nodes.length-1];
                  const pos = last ? { x: last.position.x, y: last.position.y + 380 } : { x: 200, y: 120 };
                  const n = createNode('prompt', pos);
                  n.data = {...n.data, prompt: bottomPrompt, text: bottomPrompt};
                  setNodes(nds=> [...nds, n]);
                  if(last){
                    setEdges(es=> [...es, { id:`e_${last.id}_${n.id}`, source:last.id, target:n.id, type:'smoothstep', animated:true } as any]);
                  }
                }
                setBottomPrompt('');
              }
            }} placeholder="描述你想要生成的内容…（回车创建提示词节点，Shift+回车换行）" className="flex-1 bg-transparent text-sm [color:var(--color-text-main)] placeholder:text-gray-500 focus:outline-none"/>
            <span className="text-xs text-gray-500">{bottomPrompt.length} / 7500</span>
            <button onClick={()=>{
              if(!bottomPrompt.trim()) return;
              const pos = { x: 200, y: 80 + nodes.length*380 };
              const n = createNode('prompt', pos);
              n.data = {...n.data, prompt: bottomPrompt, text: bottomPrompt};
              setNodes(nds=> [...nds, n]);
              setBottomPrompt('');
            }} className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center hover:bg-brand-light shadow-md"><span className="text-sm">↗</span></button>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border text-gray-400">拖素材到节点</span>
            <span className="px-2 py-1 rounded-full bg-surface-secondary border border-border text-gray-400">点卡片右侧 + 串行</span>
            <span className="ml-auto flex items-center gap-1 text-gray-400"><Film className="w-3 h-3"/> 支持图片/视频/音频</span>
          </div>
        </div>
      </div>

      {inspectWfId && <WorkflowInspectorModal workflowId={inspectWfId} isOpen={!!inspectWfId} onClose={()=>setInspectWfId('')} onSaved={()=>{}} /> }
    </div>
  );
};

export const CreativeCanvas: React.FC = () => (
  <ReactFlowProvider><InnerCanvas /></ReactFlowProvider>
);
