// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1 分镜台「在画布中运行」→ 新模型子图（纯函数，宿主 runShotOnCanvas 调用）。
 *
 * 旧宿主把分镜绑定（首帧 / 角色三视图 / 场景 / 道具 / 白模 / 参考音频）直接写进视频节点 data 的槽位键；
 * 新模型里生成节点只有 `in` 口、参考列表来自连线，所以每个绑定资源落成一个加载节点（load-image / load-audio /
 * load-video），连到生成节点的 `in`，槽位写进目标 `data.refRoles`（显式槽位，assembleInputs / 后端 inputs.py 优先采用）。
 *
 * 子图：文本（视频提示词）→ 视频；3D 导演（机位参数）→ 视频（camera_prompt）；
 *       无首帧但有画面提示词时加「图片生成」→ 视频（首帧）；绑定资源 → 视频 / 图片生成。
 * 资源分配沿用分镜台一键绑定同一纯函数（collectResources + planBinding，按生成源 input_schema 槽位），
 * 没有生成源定义时按资源来源落默认槽位（真首帧 → 首帧、图 → 参考图、音频 → 参考音频、白模视频 → 参考视频）。
 */
import type { Edge, Node } from '@xyflow/react';
import { collectResources, planBinding, type BindResource, type BindSlotLike } from '../../storyboard/referenceBinder';
import { NEW_IN_PORT, PRIMARY_OUTPUT_PORT, edgeKey } from '../migrate';
import type { Slot } from '../kit/types';
import { cameraPromptPatch, createDirector3DData } from '../nodes2/director3d/model';

type AnyData = Record<string, any>;
type MakeNode = (type: string, position: { x: number; y: number }, data?: Record<string, unknown>) => Node;

export interface BindingFill {
  url: string;
  name: string;
  type: 'image' | 'audio' | 'video';
  slot: Slot;
}

const FIRST_RE = /first.?frame|^first$|start.?frame/i;
const LAST_RE = /last.?frame|^last$|end.?frame/i;

/** 生成源插槽 → 新模型槽位。 */
export function canonicalSlotOf(s: Pick<BindSlotLike, 'key' | 'originalKey' | 'role' | 'type'>): Slot {
  const k = `${s.key} ${s.originalKey || ''}`;
  if (s.type === 'image') {
    if (s.role === 'first_frame' || FIRST_RE.test(k)) return 'first_frame';
    if (s.role === 'last_frame' || LAST_RE.test(k)) return 'last_frame';
    return 'reference_images';
  }
  if (s.type === 'audio') return 'ref_audio';
  return 'reference_video';
}

/** 没有生成源槽位声明时的默认落位。 */
function defaultSlotOf(r: BindResource, kind: 'image' | 'video'): Slot | null {
  if (r.type === 'audio') return kind === 'video' ? 'ref_audio' : null;
  if (r.type === 'video') return kind === 'video' ? 'reference_video' : null;
  if (r.source === 'frame') return kind === 'video' ? 'first_frame' : null;
  return 'reference_images';
}

/**
 * 分镜绑定 → 有序的 {url, slot}（同一槽位同一 url 去重；单值槽只取第一个）。
 * slots 为 null = 生成源未知（按默认落位）。
 */
export function bindingFills(opts: {
  shot: AnyData;
  project: AnyData | null | undefined;
  projectAssets?: AnyData[];
  kind: 'image' | 'video';
  slots?: BindSlotLike[] | null;
  includeFirstFrame?: boolean;
}): BindingFill[] {
  const { shot, project, kind } = opts;
  const resources = collectResources({ shot, project, projectAssets: opts.projectAssets || [], kind, includeFirstFrame: opts.includeFirstFrame });
  const out: BindingFill[] = [];
  const seen = new Set<string>();
  const single = new Set<Slot>();
  const push = (url: unknown, name: string, type: BindingFill['type'], slot: Slot | null) => {
    if (!slot || typeof url !== 'string' || !url.trim()) return;
    if (slot === 'first_frame' || slot === 'last_frame') {
      if (single.has(slot)) return;
      single.add(slot);
    }
    const key = `${slot}::${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, name, type, slot });
  };
  if (opts.slots && opts.slots.length) {
    const plan = planBinding(resources, opts.slots, { ...(shot.dynamic_inputs || {}) }, { overwrite: false });
    for (const f of plan.filled) {
      const def = opts.slots.find((s) => s.key === f.slotKey);
      if (!def) continue;
      push(f.url, f.name, def.type, canonicalSlotOf(def));
    }
    return out;
  }
  for (const r of resources) push(r.url, r.name, r.type, defaultSlotOf(r, kind));
  return out;
}

const LOADER_OF: Record<BindingFill['type'], string> = { image: 'load-image', audio: 'load-audio', video: 'load-video' };

function loaderData(type: BindingFill['type'], url: string, name: string): AnyData {
  const base = type === 'image' ? { image_url: url, image: url, url }
    : type === 'video' ? { video_url: url, video: url, url }
      : { audio_url: url, audio: url, url };
  return { ...base, label: name, _autoInput: true };
}

export interface ShotSubgraphInput {
  shot: AnyData;
  project: AnyData | null | undefined;
  projectAssets?: AnyData[];
  /** 视频 / 图片生成源的插槽（extractSlotsFromProvider）；null = 生成源未知 */
  videoSlots?: BindSlotLike[] | null;
  imageSlots?: BindSlotLike[] | null;
  makeNode: MakeNode;
}

export interface ShotSubgraph {
  nodes: Node[];
  edges: Edge[];
  promptNodeId: string;
  directorNodeId: string;
  videoNodeId: string;
  imageNodeId?: string;
}

/** 参数镜像（节点面板同款：params + provider_params） */
function paramsOf(p: unknown): AnyData {
  return p && typeof p === 'object' ? { params: p, provider_params: p } : {};
}

export function buildShotSubgraph(input: ShotSubgraphInput): ShotSubgraph {
  const { shot, makeNode } = input;
  const vprompt = String(shot.video_prompt || shot.action_desc || shot.image_prompt || '');
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const COL_IN = 0;
  const COL_MID = 440;
  const COL_OUT = 860;

  // 文本：视频提示词
  const promptNode = makeNode('prompt', { x: COL_MID, y: 0 }, { prompt: vprompt, text: vprompt, label: `分镜 #${shot.shot_index ?? ''} 提示词` });
  nodes.push(promptNode);

  // 3D 导演：分镜机位参数（camera_prompt 按参数算好，节点未挂载时下游 / 后端也读得到）
  const dirBase: AnyData = {
    ...createDirector3DData(),
    framing: shot.camera_framing || 'medium',
    motion: shot.camera_motion || 'push_in',
    pose: shot.pose_preset || 'stand',
    focal_length_mm: shot.focal_length_mm || 35,
    camera_roll_deg: shot.camera_roll_deg || 0,
    cast_layout: shot.cast_layout || 'solo',
    speed: shot.motion_speed || '1.0x',
    ai_directive: '',
    shotId: shot.id,
  };
  if (shot.mannequin_pose) dirBase.mannequin_pose = shot.mannequin_pose;
  const dirNode = makeNode('director3d', { x: COL_MID, y: 280 }, { ...dirBase, ...(cameraPromptPatch(dirBase) || {}) });
  nodes.push(dirNode);

  // 图片生成（无首帧但有画面提示词）
  const motionComic = shot.production_mode === 'motion_comic';
  let imgNode: Node | undefined;
  if (!shot.image_url && shot.image_prompt) {
    imgNode = makeNode('image', { x: COL_MID, y: 900 }, {
      prompt: shot.image_prompt,
      ...(shot.image_provider ? { provider_id: shot.image_provider, provider: shot.image_provider } : {}),
      shotId: shot.id,
      shotIndex: shot.shot_index,
      character_ids: shot.character_ids,
      character_weights: shot.character_weights,
      scene_ref_image: shot.scene_ref_image,
      scene_name: shot.scene_name,
      prop_asset_ids: shot.prop_asset_ids,
      ...paramsOf(shot.provider_params?.image),
    });
    nodes.push(imgNode);
  }

  // 视频自身提示词留空：文本节点（连到 in）作主体（assembleInputs R6：自身为空时第一条文本参考作主体、不加前缀），
  // 用户改文本节点即生效，不必再同步两份
  const videoNode = makeNode('video', { x: COL_OUT, y: 0 }, {
    prompt: '',
    duration: Math.round(Number(shot.duration)) || 5,
    ...(shot.video_provider ? { provider_id: shot.video_provider, provider: shot.video_provider } : {}),
    // 分镜归属：节点结果可回写该镜（右键「回写到分镜」/ 自动运行后回写）
    shotId: shot.id,
    shotIndex: shot.shot_index,
    character_ids: shot.character_ids,
    character_weights: shot.character_weights,
    scene_ref_image: shot.scene_ref_image,
    scene_name: shot.scene_name,
    prop_asset_ids: shot.prop_asset_ids,
    previz_url: shot.previz_url,
    previz_video_url: shot.previz_video_url,
    speaker_name: shot.speaker_name,
    ...paramsOf(shot.provider_params?.video),
  });
  nodes.push(videoNode);

  const order = new Map<string, string[]>();
  const roles = new Map<string, Record<string, string>>();
  const connect = (src: Node, target: Node, slot?: Slot) => {
    const sh = PRIMARY_OUTPUT_PORT[src.type || ''] || '';
    const key = edgeKey(src.id, sh);
    const list = order.get(target.id) || [];
    if (list.includes(key)) return;
    list.push(key);
    order.set(target.id, list);
    if (slot) roles.set(target.id, { ...(roles.get(target.id) || {}), [key]: slot });
    edges.push({ id: `e_${src.id}_${sh}_${target.id}_in`, source: src.id, sourceHandle: sh, target: target.id, targetHandle: NEW_IN_PORT } as Edge);
  };

  connect(promptNode, videoNode, 'prompt');
  connect(dirNode, videoNode, 'camera_prompt');
  if (imgNode) connect(imgNode, videoNode, 'first_frame');

  // 绑定资源 → 加载节点（同一 url 的加载节点在图片 / 视频之间复用）
  const loaders = new Map<string, Node>();
  let row = 0;
  const loaderFor = (f: BindingFill): Node => {
    const k = `${f.type}::${f.url}`;
    let n = loaders.get(k);
    if (!n) {
      n = makeNode(LOADER_OF[f.type], { x: COL_IN, y: row * 300 }, loaderData(f.type, f.url, f.name));
      row += 1;
      loaders.set(k, n);
      nodes.push(n);
    }
    return n;
  };
  const videoFills = bindingFills({
    shot, project: input.project, projectAssets: input.projectAssets, kind: 'video', slots: input.videoSlots,
    // 直出（多参考）不带旧首帧；有图片生成节点时首帧来自它
    includeFirstFrame: !motionComic && !imgNode,
  }).filter((f) => !(imgNode && f.slot === 'first_frame'));
  for (const f of videoFills) connect(loaderFor(f), videoNode, f.slot);
  if (imgNode) {
    const imageFills = bindingFills({ shot, project: input.project, projectAssets: input.projectAssets, kind: 'image', slots: input.imageSlots, includeFirstFrame: false });
    for (const f of imageFills) if (f.type === 'image') connect(loaderFor(f), imgNode, f.slot === 'first_frame' || f.slot === 'last_frame' ? f.slot : 'reference_images');
  }

  for (const n of nodes) {
    const o = order.get(n.id);
    if (!o) continue;
    n.data = { ...(n.data || {}), refOrder: o, refRoles: roles.get(n.id) || {} };
  }
  return { nodes, edges, promptNodeId: promptNode.id, directorNodeId: dirNode.id, videoNodeId: videoNode.id, imageNodeId: imgNode?.id };
}
