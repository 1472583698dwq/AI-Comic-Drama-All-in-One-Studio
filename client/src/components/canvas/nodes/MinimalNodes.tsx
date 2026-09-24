// -*- coding: utf-8 -*-
/**
 * 智能体节点定义 (Minimal Content-First Agent Nodes)
 * 深度绑定动态生成源 (ProviderDefinition)、无表单纯净视觉与一键衍生拉线
 */
import React, { useState, useRef, useEffect } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import {
  Type,
  Image as ImageIcon,
  Video as VideoIcon,
  Mic,
  Box,
  Download,
  Plus,
  Play,
  Pause,
  Copy,
  Sparkles,
  Volume2,
  Film,
  Clapperboard,
  FileText,
  ArrowUp,
  Edit3
} from 'lucide-react';
import { useCanvasStore } from '../../../stores/useCanvasStore';
import { AiPolishButton } from '../../ui/AiPolishButton';
import { AutoRatioMedia } from '../../ui/AutoRatioMedia';
import { HIGH_LEVEL_AGENT_SKILLS } from '../providerSkills';
// 导演预设与 3D 舞台同源（景别/运镜全量一致，避免节点选不出来的断层）
import { FRAMING_PRESETS, MOTION_PRESETS, framingShortLabel, motionShortLabel } from '../../director3d/directorPresets';

// 相对 /storage 产物 URL 在 dev 下必须回源到后端（统一走 devOrigin）
import { API_ORIGIN, resolveMediaUrl } from '../../../utils/devOrigin';

// 统一的 Agent 卡片外壳
const AgentShell: React.FC<{
  id: string;
  selected?: boolean;
  icon: any;
  label: string;
  providerBadge?: string;
  topActions?: React.ReactNode;
  children: React.ReactNode;
  handles?: React.ReactNode;
}> = ({ id, selected, icon: Icon, label, providerBadge, topActions, children, handles }) => {
  const { setSelectedNodeId, agentFocusNodeIds } = useCanvasStore();
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: any) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowAddMenu(false);
    };
    if (showAddMenu) document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showAddMenu]);

  return (
    <div
      onClick={() => setSelectedNodeId(id)}
      className={`w-[360px] bg-surface rounded-3xl border-2 transition-all duration-200 relative group select-none shadow-xl ${
        selected
          ? 'border-violet-500 ring-4 ring-violet-500/20 shadow-2xl shadow-violet-500/20'
          : 'border-white/10 hover:border-violet-500/40 shadow-black/40'
      }`}
    >
      {/* 顶部悬浮动作条 */}
      {selected && (
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-surface-secondary border border-white/15 rounded-full px-3 py-1 flex items-center gap-2 shadow-lg z-30 animate-in fade-in zoom-in-95 duration-150 backdrop-blur-md">
          {topActions || (
            <>
              <span className="text-[11px] font-semibold text-violet-400 flex items-center gap-1">
                <Icon className="w-3 h-3" /> {label}
              </span>
              <div className="w-px h-3 bg-white/15" />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent('canvas-duplicate-node', { detail: { nodeId: id } }));
                }}
                className="text-[11px] text-white/60 hover:text-white flex items-center gap-1 transition-colors"
                title="复制节点"
              >
                <Copy className="w-3 h-3" /> 复制
              </button>
            </>
          )}
        </div>
      )}

      {/* 卡片头部 */}
      <div className="px-4 py-3 flex items-center gap-2.5 border-b border-white/10">
        <div className="w-6 h-6 rounded-lg bg-white/5 flex items-center justify-center text-violet-400">
          <Icon className="w-3.5 h-3.5" />
        </div>
        <span className="text-xs font-bold text-white/95">{label}</span>
        {providerBadge && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-300 font-mono truncate max-w-[120px]">
            {providerBadge}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {agentFocusNodeIds.includes(id) && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-bold"
              title="已加入会话：Agent 会把「这个节点」默认理解为它"
            >
              会话
            </span>
          )}
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/5 text-white/40 border border-white/10">
            #{id.slice(-4)}
          </span>
        </span>
      </div>

      {/* 句柄 */}
      {handles}

      {/* 内容主体 */}
      <div className="p-4 flex flex-col items-center justify-center min-h-[200px]">
        {children}
      </div>

      {/* 右侧 + 快速拉线衍生手柄 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShowAddMenu((v) => !v);
        }}
        className="absolute -right-3.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-surface-secondary border border-white/20 shadow-lg flex items-center justify-center text-white/60 hover:text-white hover:border-violet-500 hover:scale-110 transition-all z-20"
        title="向右衍生新节点"
      >
        <Plus className="w-4 h-4" />
      </button>

      {/* 衍生菜单 */}
      {showAddMenu && (
        <div
          ref={menuRef}
          className="absolute left-[370px] top-1/2 -translate-y-1/2 w-48 bg-surface-secondary border border-white/15 rounded-2xl p-1.5 shadow-2xl z-40 flex flex-col gap-1 animate-in fade-in slide-in-from-left-2 duration-150"
        >
          <div className="px-2.5 py-1 text-[10px] font-bold text-white/40 uppercase tracking-wider">衍生连接下游</div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent('canvas-add-node', { detail: { sourceId: id, nextType: 'prompt' } }));
              setShowAddMenu(false);
            }}
            className="w-full px-2.5 py-1.5 rounded-xl text-left text-xs text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors"
          >
            <Type className="w-3.5 h-3.5 text-cyan-400" />
            <span>剧本 / Prompt 节点</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent('canvas-add-node', { detail: { sourceId: id, nextType: 'image' } }));
              setShowAddMenu(false);
            }}
            className="w-full px-2.5 py-1.5 rounded-xl text-left text-xs text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors"
          >
            <ImageIcon className="w-3.5 h-3.5 text-violet-400" />
            <span>生图 Agent 节点</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent('canvas-add-node', { detail: { sourceId: id, nextType: 'video' } }));
              setShowAddMenu(false);
            }}
            className="w-full px-2.5 py-1.5 rounded-xl text-left text-xs text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors"
          >
            <VideoIcon className="w-3.5 h-3.5 text-orange-400" />
            <span>视频 Agent 节点</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent('canvas-add-node', { detail: { sourceId: id, nextType: 'audio' } }));
              setShowAddMenu(false);
            }}
            className="w-full px-2.5 py-1.5 rounded-xl text-left text-xs text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors"
          >
            <Mic className="w-3.5 h-3.5 text-pink-400" />
            <span>配音 Agent 节点</span>
          </button>
        </div>
      )}
    </div>
  );
};

// 1. 文本 / 剧本策划 Agent 节点 - 节点内编辑 + 技能 + 生成（经全局 handleNodeExecute 的 prompt 分支）
export const PromptNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data;
  const content = d.text || d.prompt || '';
  const { updateNodeData } = useCanvasStore();
  const [generating, setGenerating] = useState(false);
  const st: any = d.agent_state;

  const run = async () => {
    if (!d.onExecute) return;
    setGenerating(true);
    try {
      await (d.onExecute as any)(id);
    } catch {
      /* handleNodeExecute 内部已 alert */
    } finally {
      setGenerating(false);
    }
  };

  return (
    <AgentShell
      id={id}
      selected={selected}
      icon={Type}
      label="剧本 / Prompt Agent"
      providerBadge={d.provider || 'LLM Agent'}
      handles={
        <>
          <Handle type="target" position={Position.Left} id="prompt_in" className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-[#141419]" />
          <Handle type="source" position={Position.Right} id="prompt" className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-[#141419]" />
        </>
      }
    >
      {/* 未选中时不拦截事件：让点击冒泡到 AgentShell 的 onClick，整张卡片任意位置都能激活。
          选中后才拦截，避免操作内部控件（技能/执行/润色）时把节点取消选中。
          —— 此前无条件 stopPropagation，导致只有卡头那条窄条能点中，正文死活激活不了。 */}
      <div
        className="w-full flex flex-col gap-2"
        onClick={selected ? (e) => e.stopPropagation() : undefined}
        onMouseDown={selected ? (e) => e.stopPropagation() : undefined}
      >
        {selected ? (
          <textarea
            value={content}
            onChange={(e) => updateNodeData(id, { text: e.target.value, prompt: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onPaste={(e) => { e.stopPropagation(); const text = (e.clipboardData as any)?.getData('text/plain') || (e.clipboardData as any)?.getData('text') || ''; if (text) { e.preventDefault(); const t = e.target as HTMLTextAreaElement; const s = t.selectionStart ?? content.length; const en = t.selectionEnd ?? content.length; const nv = content.slice(0, s) + text + content.slice(en); updateNodeData(id, { text: nv, prompt: nv }); requestAnimationFrame(() => { try { t.selectionStart = t.selectionEnd = s + text.length; } catch {} }); } }}
            onCopy={(e) => e.stopPropagation()}
            onCut={(e) => e.stopPropagation()}
            placeholder="输入故事创意 / 小说段落 / 分镜描述，点击下方技能触发拆解、扩写…"
            rows={content ? 6 : 3}
            className="w-full max-h-48 bg-surface-secondary border border-white/10 rounded-xl px-3 py-2 text-xs text-white/90 placeholder-white/40 focus:outline-none focus:border-cyan-500 resize-y leading-relaxed select-text nodrag"
            autoFocus
          />
        ) : content ? (
          <div className="w-full max-h-48 overflow-y-auto p-3.5 rounded-2xl bg-surface-secondary border border-white/10 text-xs text-white/90 whitespace-pre-wrap leading-relaxed select-text font-sans">
            {content}
          </div>
        ) : (
          <div className="w-full flex flex-col items-center justify-center py-4 px-2 text-center">
            <div className="w-10 h-10 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-3">
              <Clapperboard className="w-5 h-5" />
            </div>
            <span className="text-xs font-bold text-white/90 mb-1">剧本与分镜创作</span>
            <span className="text-[11px] text-white/40">点击卡片激活编辑，或选择技能</span>
          </div>
        )}
        <div className="text-[10px] text-white/40 text-right">{content.length} 字符</div>

        {selected && (
          <>
            {/* 字段级 AI 润色（整段按技能重写）；只改一句/一个词 → 选中文字后出现浮标 */}
            <div className="flex items-center justify-end">
              <AiPolishButton
                value={content}
                onPolish={(v: any) => updateNodeData(id, { text: v, prompt: v })}
                contextType="prompt"
                size="xs"
              />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {HIGH_LEVEL_AGENT_SKILLS.map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => updateNodeData(id, { skill_id: skill.id })}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-medium border transition-all flex items-center gap-1 ${d.skill_id === skill.id ? 'bg-cyan-600 text-white border-cyan-500' : 'bg-white/5 hover:bg-cyan-600/30 border-white/10 text-white/70'}`}
                >
                  <Sparkles className="w-2.5 h-2.5 text-cyan-400" />
                  {skill.name}
                </button>
              ))}
            </div>
            <button
              onClick={run}
              disabled={generating || !content.trim()}
              className="w-full py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:bg-white/10 text-white text-xs font-bold flex items-center justify-center gap-1.5"
            >
              {generating ? (<><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Agent 处理中…</>) : (<>技能执行 <ArrowUp className="w-3 h-3" /></>)}
            </button>
            {st?.status === 'failed' && <span className="text-[10px] text-red-400 line-clamp-2" title={st.error}>✗ {st.error}</span>}
          </>
        )}
      </div>
    </AgentShell>
  );
};

const getNodeAspectStyle = (d: any): React.CSSProperties => {
  const raw = d.aspect_ratio || d.params?.aspect_ratio || d.provider_params?.aspect_ratio || d._last_agent_plan?.params?.aspect_ratio || d._last_agent_plan?.final_args?.aspect_ratio || (d.width && d.height ? `${d.width}:${d.height}` : null);
  if (d.width && d.height) return { aspectRatio: `${d.width} / ${d.height}` };
  const m = String(raw || '9:16').match(/(\d+)\s*[:：]\s*(\d+)/);
  if (m) return { aspectRatio: `${m[1]} / ${m[2]}` };
  return { aspectRatio: '9 / 16' };
};

// 2. 概念分镜生图 Agent 节点 - Per-Node Agent：节点内选源/挂插槽/输Prompt/生成
export const ImageNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data;
  const imgUrl = d.image_url || d.result_url || d.url;
  const st: any = d.agent_state;
  const aspectStyle = getNodeAspectStyle(d);
  const refImages: string[] = Array.isArray(d.reference_images)
    ? d.reference_images
    : (d.reference || d.reference_image ? [d.reference || d.reference_image] : []);
  const dynamicImgKeys = Object.keys(d).filter(k => k.startsWith('img_') && typeof d[k] === 'string' && d[k]);
  const allRefs = Array.from(new Set([...refImages, ...dynamicImgKeys.map(k => d[k])]));

  return (
    <AgentShell
      id={id}
      selected={selected}
      icon={ImageIcon}
      label="分镜生图 Agent"
      providerBadge={d.provider ? `${d.provider}${d.model ? ':' + d.model : ''}` : '待绑定生成源'}
      handles={
        <>
          <Handle type="target" position={Position.Left} id="prompt" className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-[#141419]" style={{ top: '25%' }} />
          <Handle type="target" position={Position.Left} id="reference" className="!w-3 !h-3 !bg-violet-500 !border-2 !border-[#141419]" style={{ top: '42%' }} />
          <Handle type="target" position={Position.Left} id="reference_images" className="!w-3 !h-3 !bg-violet-400 !border-2 !border-[#141419]" style={{ top: '58%' }} />
          <Handle type="target" position={Position.Left} id="camera_prompt" className="!w-3 !h-3 !bg-amber-500 !border-2 !border-[#141419]" style={{ top: '75%' }} />
          <Handle type="source" position={Position.Right} id="image" className="!w-3 !h-3 !bg-violet-500 !border-2 !border-[#141419]" />
        </>
      }
    >
      {imgUrl ? (
        <AutoRatioMedia
          src={resolveMediaUrl(imgUrl)}
          alt="生成的画面"
          fallbackAspect={String(aspectStyle.aspectRatio)}
          maxHeight={420}
          className="rounded-2xl bg-surface-secondary border border-white/10 group"
          mediaClassName="group-hover:scale-105 transition-transform duration-300"
        >
          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-surface/85 text-[9px] font-mono text-violet-300 border border-violet-500/30 flex items-center gap-1">
            <span>{d.skill_id || 'text_to_image'} · {d.provider || 'auto'}</span>
            {allRefs.length > 0 && <span className="text-violet-400">({allRefs.length}垫图)</span>}
          </div>
          {st?.status === 'running' && (
            <div className="absolute inset-0 bg-surface/85 flex flex-col items-center justify-center gap-2">
              <div className="w-7 h-7 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-[11px] text-violet-200">Agent 生成中…</span>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
            <span className="text-[11px] text-white/90 line-clamp-2">{d.prompt || '已生成分镜图像'}</span>
          </div>
        </AutoRatioMedia>
      ) : (
        <div className="w-full max-h-[320px] rounded-2xl border-2 border-dashed border-white/15 bg-surface-secondary flex flex-col items-center justify-center p-4 text-center" style={aspectStyle}>
          <ImageIcon className="w-8 h-8 text-violet-400/50 mb-2" />
          <span className="text-xs font-bold text-white/80">待生成画面</span>
          <span className="text-[10px] text-white/30 mt-1 font-mono">{String(d.aspect_ratio || d.params?.aspect_ratio || '9:16').split(' ')[0]}</span>
          {allRefs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 items-center justify-center">
              <span className="px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/30 text-[10px] text-violet-300 font-mono flex items-center gap-1">
                ✓ {allRefs.length} 参考垫图
              </span>
              <div className="flex -space-x-1.5 overflow-hidden py-0.5">
                {allRefs.slice(0, 3).map((r, i) => (
                  <img key={i} src={resolveMediaUrl(r)} alt="" className="inline-block w-5 h-5 rounded-full ring-1 ring-violet-400/40 object-cover bg-surface-secondary" />
                ))}
              </div>
            </div>
          )}
          {st?.status === 'failed' && <span className="text-[10px] text-red-400 mt-1 line-clamp-2" title={st.error}>✗ {st.error}</span>}
        </div>
      )}
      {/* 比例跟随产物：aspectStyle 来自 aspect_ratio 参数或生成结果宽高 */}
    </AgentShell>
  );
};

// 3. 动态导演视频 Agent 节点 - Per-Node Agent：首尾帧/参考插槽 + 节点内选源生成（含异步轮询）
export const VideoGenNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data;
  const vidUrl = d.video_url || d.result_url;
  const st: any = d.agent_state;
  const aspectStyle = getNodeAspectStyle(d);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!videoRef.current) return;
    if (isPlaying) { videoRef.current.pause(); setIsPlaying(false); } else { videoRef.current.play(); setIsPlaying(true); }
  };
  return (
    <AgentShell
      id={id}
      selected={selected}
      icon={VideoIcon}
      label="动态导演视频 Agent"
      providerBadge={d.provider ? `${d.provider}${d.model ? ':' + d.model : ''}` : '待绑定视频源'}
      handles={
        <>
          <Handle type="target" position={Position.Left} id="camera_prompt" className="!w-3 !h-3 !bg-amber-500 !border-2 !border-[#141419]" style={{ top: '15%' }} />
          <Handle type="target" position={Position.Left} id="first_frame" className="!w-3 !h-3 !bg-orange-500 !border-2 !border-[#141419]" style={{ top: '32%' }} />
          <Handle type="target" position={Position.Left} id="last_frame" className="!w-3 !h-3 !bg-orange-400 !border-2 !border-[#141419]" style={{ top: '46%' }} />
          <Handle type="target" position={Position.Left} id="reference_images" className="!w-3 !h-3 !bg-amber-500 !border-2 !border-[#141419]" style={{ top: '60%' }} />
          <Handle type="target" position={Position.Left} id="prompt" className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-[#141419]" style={{ top: '78%' }} />
          <Handle type="source" position={Position.Right} id="video" className="!w-3 !h-3 !bg-orange-500 !border-2 !border-[#141419]" />
        </>
      }
    >
      {vidUrl ? (
        <AutoRatioMedia
          kind="video"
          src={resolveMediaUrl(vidUrl)}
          fallbackAspect={String(aspectStyle.aspectRatio)}
          maxHeight={420}
          videoRef={videoRef}
          className="rounded-2xl bg-surface-secondary border border-white/10 group"
          videoProps={{ loop: true, playsInline: true, preload: 'metadata', onEnded: () => setIsPlaying(false) }}
        >
          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-surface/85 text-[9px] font-mono text-orange-300 border border-orange-500/30">{d.skill_id || 'video'} · {d.provider || 'auto'}</div>
          {st?.status === 'running' && (
            <div className="absolute inset-0 bg-surface/85 flex flex-col items-center justify-center gap-2">
              <div className="w-7 h-7 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-[11px] text-orange-200">Agent 生成中（异步排队）…</span>
            </div>
          )}
          <button onClick={togglePlay} className="absolute w-12 h-12 rounded-full bg-surface/85 backdrop-blur-md border border-white/20 text-white flex items-center justify-center group-hover:scale-110 transition-transform shadow-xl">
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
          </button>
        </AutoRatioMedia>
      ) : (
        <div className="w-full max-h-[320px] rounded-2xl border-2 border-dashed border-white/15 bg-surface-secondary flex flex-col items-center justify-center p-4 text-center" style={aspectStyle}>
          <Film className="w-8 h-8 text-orange-400/50 mb-2" />
          <span className="text-xs font-bold text-white/80">待生成镜头视频</span>
          <span className="text-[10px] text-white/30 mt-1 font-mono">{String(d.aspect_ratio || d.params?.aspect_ratio || '9:16').split(' ')[0]}</span>
          <div className="mt-2 flex flex-wrap gap-1 justify-center">
            {(d.first_frame || d.first_frame_url) && <span className="px-2 py-0.5 rounded-full bg-orange-500/10 border border-orange-500/30 text-[10px] text-orange-300 font-mono">✓ 首帧</span>}
            {(d.last_frame || d.last_frame_url) && <span className="px-2 py-0.5 rounded-full bg-orange-500/10 border border-orange-500/30 text-[10px] text-orange-300 font-mono">✓ 尾帧</span>}
            {Array.isArray(d.reference_images) && d.reference_images.length > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-300 font-mono">✓ {d.reference_images.length} 参考</span>}
          </div>
          {st?.status === 'failed' && <span className="text-[10px] text-red-400 mt-2 line-clamp-2" title={st.error}>✗ {st.error}</span>}
        </div>
      )}
      {/* 比例跟随产物 */}
    </AgentShell>
  );
};

// 4. 声音总监配音 Agent 节点 - Per-Node Agent：节点内选语音源/台词/克隆参考
export const AudioNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data;
  const audioUrl = d.audio_url || d.result_url;
  const st: any = d.agent_state;
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioRef.current) return;
    if (isPlaying) { audioRef.current.pause(); setIsPlaying(false); } else { audioRef.current.play(); setIsPlaying(true); }
  };
  return (
    <AgentShell
      id={id}
      selected={selected}
      icon={Mic}
      label="配音 / 声音 Agent"
      providerBadge={d.provider ? `${d.provider}${d.model ? ':' + d.model : ''}` : '待绑定语音源'}
      handles={
        <>
          <Handle type="target" position={Position.Left} id="prompt" className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-[#141419]" style={{ top: '35%' }} />
          <Handle type="target" position={Position.Left} id="ref_audio" className="!w-3 !h-3 !bg-pink-500 !border-2 !border-[#141419]" style={{ top: '65%' }} />
          <Handle type="source" position={Position.Right} id="audio" className="!w-3 !h-3 !bg-pink-500 !border-2 !border-[#141419]" />
        </>
      }
    >
      <div className="w-full flex flex-col items-center justify-center p-3 gap-3">
        {d.text && (
          <div className="w-full p-2.5 rounded-xl bg-surface-secondary border border-white/10 text-xs text-white/90 line-clamp-3">
            “{d.text}”
          </div>
        )}
        {audioUrl ? (
          <div className="w-full flex items-center gap-3 p-3 rounded-2xl bg-pink-950/20 border border-pink-500/30">
            <button onClick={togglePlay} className="w-10 h-10 rounded-full bg-pink-600 text-white flex items-center justify-center shadow-lg hover:scale-105 transition-transform">
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-xs font-bold text-pink-200">角色配音音频</span>
              <span className="text-[10px] text-pink-300/60 font-mono truncate">{audioUrl.split('/').pop()}</span>
              <span className="text-[9px] text-pink-300/40">{d.skill_id || 'agent'}{d.voice_id ? ' · ' + d.voice_id : ''}</span>
            </div>
            <audio ref={audioRef} src={resolveMediaUrl(audioUrl)} onEnded={() => setIsPlaying(false)} className="hidden" />
          </div>
        ) : (
          <div className="flex flex-col items-center text-center py-3">
            <Volume2 className="w-8 h-8 text-pink-400/40 mb-1" />
            <span className="text-xs font-bold text-white/80">待合成角色对白</span>
            {st?.status === 'failed' && <span className="text-[10px] text-red-400 mt-1 line-clamp-2" title={st.error}>✗ {st.error}</span>}
          </div>
        )}
      </div>
      {/* 控制台已下沉至底部栏 */}
    </AgentShell>
  );
};

// 5. 3D 导演机位规划 Agent 节点 - Agent 容器：节点内景别/运镜选择 + MCP director_3d_stage_plan 执行
export const Director3DMinimalNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data;
  const { updateNodeData } = useCanvasStore();
  const [running, setRunning] = useState(false);
  const run = async () => {
    if (!d.onExecute) return;
    setRunning(true);
    try { await (d.onExecute as any)(id); } finally { setRunning(false); }
  };
  return (
    <AgentShell
      id={id}
      selected={selected}
      icon={Box}
      label="3D 导演机位 Agent"
      providerBadge={d.skill_id || 'MCP: director_3d_stage_plan'}
      handles={
        <>
          <Handle type="target" position={Position.Left} id="prompt" className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-[#141419]" style={{top:'50%'}} />
          <Handle type="source" position={Position.Right} id="camera_prompt" className="!w-3 !h-3 !bg-blue-500 !border-2 !border-[#141419]" />
        </>
      }
    >
      {/* 同 PromptNode：未选中时不拦截点击，让整卡可激活；选中后才拦住以免内部操作丢选中 */}
      <div
        className="w-full flex flex-col gap-2 p-1"
        onClick={selected ? (e) => e.stopPropagation() : undefined}
        onMouseDown={selected ? (e) => e.stopPropagation() : undefined}
        onKeyDown={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          {selected ? (
            <>
              <label className="flex flex-col gap-1 p-2 rounded-xl bg-surface-secondary border border-white/10">
                <span className="text-white/40 text-[9px]">景别</span>
                <select value={d.framing || 'medium'} onChange={(e) => updateNodeData(id, { framing: e.target.value })} className="bg-surface-secondary border border-white/10 rounded-lg px-1.5 py-1 text-[11px] text-cyan-300 focus:outline-none focus:border-cyan-500">
                  {FRAMING_PRESETS.map((f)=>(<option key={f.id} value={f.id}>{f.label}</option>))}
                </select>
              </label>
              <label className="flex flex-col gap-1 p-2 rounded-xl bg-surface-secondary border border-white/10">
                <span className="text-white/40 text-[9px]">运镜</span>
                <select value={d.motion || 'push_in'} onChange={(e) => updateNodeData(id, { motion: e.target.value })} className="bg-surface-secondary border border-white/10 rounded-lg px-1.5 py-1 text-[11px] text-orange-300 focus:outline-none focus:border-orange-500">
                  {MOTION_PRESETS.map((m)=>(<option key={m.id} value={m.id}>{m.label}{m.category === 'combo' ? ' ★' : ''}</option>))}
                </select>
              </label>
            </>
          ) : (
            <>
              <div className="p-2 rounded-xl bg-surface-secondary border border-white/10 flex flex-col">
                <span className="text-white/40 text-[9px]">景别</span>
                <span className="font-bold text-cyan-300">{framingShortLabel(d.framing)}</span>
              </div>
              <div className="p-2 rounded-xl bg-surface-secondary border border-white/10 flex flex-col">
                <span className="text-white/40 text-[9px]">运镜</span>
                <span className="font-bold text-orange-300">{motionShortLabel(d.motion)}</span>
              </div>
            </>
          )}
        </div>
        {selected && (
          <textarea
            value={d.ai_directive || ''}
            onChange={(e) => updateNodeData(id, { ai_directive: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onPaste={(e) => { e.stopPropagation(); const text = (e.clipboardData as any)?.getData('text/plain') || (e.clipboardData as any)?.getData('text') || ''; if (text) { e.preventDefault(); const t = e.target as HTMLTextAreaElement; const cur = d.ai_directive || ''; const s = t.selectionStart ?? cur.length; const en = t.selectionEnd ?? cur.length; const nv = cur.slice(0, s) + text + cur.slice(en); updateNodeData(id, { ai_directive: nv }); requestAnimationFrame(() => { try { t.selectionStart = t.selectionEnd = s + text.length; } catch {} }); } }}
            onCopy={(e) => e.stopPropagation()}
            onCut={(e) => e.stopPropagation()}
            placeholder="粘贴/输入自然语言机位指令，如“希区柯克变焦突显惊恐”或“贴地仰角双人对峙推镜”"
            rows={2}
            className="w-full bg-surface-secondary border border-white/10 rounded-xl px-2.5 py-2 text-[11px] text-white placeholder-white/40 focus:outline-none focus:border-blue-500 resize-none nodrag select-text"
            autoFocus
          />
        )}
        {selected && (
          <div className="flex items-center justify-end">
            <AiPolishButton
              value={d.ai_directive || ''}
              onPolish={(v: any) => updateNodeData(id, { ai_directive: v })}
              contextType="prompt"
              size="xs"
            />
          </div>
        )}
        {d.minimax_camera_prompt && (
          <div className="p-2.5 rounded-xl bg-blue-950/20 border border-blue-500/30 text-[10px] text-blue-200 font-mono line-clamp-3 select-text nodrag">
            运镜 Prompt: {d.minimax_camera_prompt}
          </div>
        )}
        {selected && (
          <button onClick={run} disabled={running} className="w-full py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-bold">
            {running ? '机位计算中…' : '生成机位 Prompt ↑'}
          </button>
        )}
        <div className="text-[9px] text-white/30 text-center">MCP 工具 · director_3d_stage_plan</div>
      </div>
    </AgentShell>
  );
};

// 6. 剪辑合成导出 Agent 节点
export const ExportNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data;
  return (
    <AgentShell
      id={id}
      selected={selected}
      icon={Download}
      label="剪辑合成导出 Agent"
      providerBadge="剪映 Draft"
      handles={
        <>
          <Handle type="target" position={Position.Left} id="video" className="!w-3 !h-3 !bg-orange-500 !border-2 !border-[#141419]" style={{ top: '35%' }} />
          <Handle type="target" position={Position.Left} id="audio" className="!w-3 !h-3 !bg-pink-500 !border-2 !border-[#141419]" style={{ top: '65%' }} />
        </>
      }
    >
      <div className="w-full flex flex-col items-center justify-center p-4 text-center gap-3">
        <Download className="w-8 h-8 text-violet-400" />
        <span className="text-xs font-bold text-white/90">剪映草稿一键生成</span>
        <span className="text-[10px] text-white/40 max-w-[200px]">
          自动聚合上游所有镜头的视频轨、音频轨与台词字幕
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('open-export-modal'));
          }}
          className="w-full py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold shadow-lg shadow-violet-600/30 transition-all"
        >
          配置导出选项
        </button>
      </div>
    </AgentShell>
  );
};
