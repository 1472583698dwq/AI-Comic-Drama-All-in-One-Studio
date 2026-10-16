import { describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import '../../nodes2';
import { hostCreateNodes, newNodeData } from '../createNodes';
import { buildSaveSnapshot, createBackupGate, normalizeParents, prepareLoadedCanvas, resetRuntimeState, resolveOverlaps } from '../canvasLoad';
import { TEMPLATES, buildCreatorTemplate, buildTemplate } from '../templates';
import { bindingFills, buildShotSubgraph, canonicalSlotOf } from '../shotSubgraph';

/** REQ-toonflow-canvas H1：createNodes 摆放 / 连线 / 绝对坐标、加载迁移 + 备份一次、模板与分镜子图的新数据模型。 */

type AnyData = Record<string, any>;

function graph(initial: Node[], initialEdges: Edge[] = []) {
  let nodes = initial;
  let edges = initialEdges;
  return {
    get nodes() { return nodes; },
    get edges() { return edges; },
    access: {
      getNodes: () => nodes,
      getNode: (id: string) => nodes.find((n) => n.id === id),
      setNodes: (u: (n: Node[]) => Node[]) => { nodes = u(nodes); },
      setEdges: (u: (e: Edge[]) => Edge[]) => { edges = u(edges); },
    },
  };
}

describe('hostCreateNodes（Toonflow 摆放）', () => {
  const anchor: Node = { id: 'a', type: 'load-video', position: { x: 100, y: 100 }, measured: { width: 300, height: 200 }, data: {}, selected: true };

  it('缺省放锚点右侧 48px，竖排间隔 48，避让同层已有节点；合并注册表缺省数据', () => {
    const blocker: Node = { id: 'b', type: 'prompt', position: { x: 448, y: 100 }, measured: { width: 220, height: 150 }, data: {} };
    const g = graph([anchor, blocker]);
    const ids = hostCreateNodes(g.access, [{ type: 'load-image', data: { image_url: '/1.png' } }, { type: 'load-audio', data: { audio_url: '/2.wav' } }], { anchorId: 'a' });
    const [n1, n2] = ids.map((id) => g.nodes.find((n) => n.id === id)!);
    expect(n1.position).toEqual({ x: 448, y: 100 + 150 + 48 });
    expect(n2.position.x).toBe(448);
    expect(n2.position.y).toBeGreaterThanOrEqual(n1.position.y + 48);
    expect(n1.data).toMatchObject({ image_url: '/1.png', label: '图片' });
    // 缺省选中新节点、取消原选中
    expect(n1.selected).toBe(true);
    expect(g.nodes.find((n) => n.id === 'a')!.selected).toBe(false);
  });

  it('select:false 不改变当前选中；connectFrom 从锚点输出口连到新节点 in', () => {
    const g = graph([anchor]);
    const [id] = hostCreateNodes(g.access, [{ type: 'video', data: {} }], { anchorId: 'a', select: false, connectFrom: { nodeId: 'a', sourceHandle: 'video' } });
    expect(g.nodes.find((n) => n.id === id)!.selected).toBe(false);
    expect(g.nodes.find((n) => n.id === 'a')!.selected).toBe(true);
    expect(g.edges).toEqual([expect.objectContaining({ source: 'a', sourceHandle: 'video', target: id, targetHandle: 'in' })]);
  });

  it('connectTo：新节点主输出口 → 锚点 in（角色三视图绑定）', () => {
    const gen: Node = { id: 'g', type: 'image', position: { x: 0, y: 0 }, data: {} };
    const g = graph([gen]);
    const [id] = hostCreateNodes(g.access, [{ type: 'load-image', data: { image_url: '/c.png' } }], { anchorId: 'g', connectTo: {} });
    expect(g.edges).toEqual([expect.objectContaining({ source: id, sourceHandle: 'image', target: 'g', targetHandle: 'in' })]);
  });

  it('锚点在分组里：position 视为画布绝对坐标，换算成相对父分组并挂同一 parentId', () => {
    const group: Node = { id: 'grp', type: 'group', position: { x: 1000, y: 500 }, width: 600, height: 400, data: { label: '分组' } };
    const child: Node = { id: 'c', type: 'load-video', parentId: 'grp', position: { x: 24, y: 40 }, measured: { width: 300, height: 200 }, data: {} };
    const g = graph([group, child]);
    const [id] = hostCreateNodes(g.access, [{ type: 'load-image', data: {}, position: { x: 1400, y: 560 } }], { anchorId: 'c' });
    const n = g.nodes.find((x) => x.id === id)!;
    expect(n.parentId).toBe('grp');
    expect(n.position).toEqual({ x: 400, y: 60 });
  });

  it('custom / ext-node 标题现算：新建时不写死 label', () => {
    expect(newNodeData('ext-node', { canvas_node_id: 'x' })).not.toHaveProperty('label');
    expect(newNodeData('custom')).not.toHaveProperty('label');
    expect(newNodeData('image')).toMatchObject({ label: '图片生成', prompt: '' });
  });
});

describe('画布加载：迁移 + 运行态 + 父子顺序', () => {
  it('旧画布迁移：changed=true、旧类型转换、具名口改连 in、schema 未落盘需要保存', () => {
    const raw = {
      nodes: [
        { id: 'tp', type: 'text-prompt', position: { x: 0, y: 0 }, data: { prompt: 'hi' } },
        { id: 'v', type: 'video', position: { x: 300, y: 0 }, data: {} },
        { id: 'u', type: 'mystery', position: { x: 600, y: 0 }, data: { keep: 1 } },
      ],
      edges: [{ id: 'e', source: 'tp', sourceHandle: 'prompt', target: 'v', targetHandle: 'prompt' }],
    };
    const out = prepareLoadedCanvas(raw);
    expect(out.changed).toBe(true);
    expect(out.needsSave).toBe(true);
    expect(out.nodes.map((n) => n.type)).toEqual(['prompt', 'video', 'mystery']);
    expect(out.edges[0].targetHandle).toBe('in');
    expect((out.nodes[1].data as AnyData).refRoles).toEqual({ 'tp|prompt': 'prompt' });
    // 未知类型原样保留
    expect(out.nodes[2].data).toEqual({ keep: 1 });
    expect(out.report.unknownTypes).toEqual(['mystery']);
  });

  it('已是 v2 不再迁移、不需要备份', () => {
    const out = prepareLoadedCanvas({ schema_version: 2, nodes: [{ id: 'a', type: 'prompt', position: { x: 0, y: 0 }, data: {} }], edges: [] });
    expect(out.changed).toBe(false);
    expect(out.needsSave).toBe(false);
  });

  it('视频任务在跑（_polling + _taskId）保留；其他 running 复位为空闲', () => {
    const vid = resetRuntimeState({ agent_state: { status: 'running' }, _taskId: 't1', _polling: true }, 'video');
    expect(vid).toMatchObject({ agent_state: { status: 'running' }, _taskId: 't1', _polling: true });
    const img = resetRuntimeState({ agent_state: { status: 'running', tool: 'x' } }, 'image');
    expect(img.agent_state.status).toBe('idle');
    const vid2 = resetRuntimeState({ agent_state: { status: 'running' }, _taskId: 't1', _polling: false }, 'video');
    expect(vid2.agent_state.status).toBe('idle');
    expect(vid2._taskId).toBe('t1');
  });

  it('迁移后去重叠：同列相叠的节点依次下移（只往下、不改 x，吸附 16），不相交 / 未测量 / 子节点不动', () => {
    const mk = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Node> = {}): Node => ({ id, type: 'prompt', position: { x, y }, measured: { width: w, height: h }, data: {}, ...extra });
    const nodes = [
      mk('a', 0, 0, 220, 300),
      mk('b', 0, 400, 320, 620),     // 3D 导演变高
      mk('c', 0, 900, 220, 200),     // 原来在 b 下面，现在被 b 盖住
      mk('d', 600, 0, 220, 200),     // 另一列，不受影响
      mk('e', 0, 950, 0, 0),         // 未测量
      mk('f', 10, 10, 100, 100, { parentId: 'g' }), // 子节点
    ];
    const out = resolveOverlaps(nodes);
    const pos = (id: string) => out.find((n) => n.id === id)!.position;
    expect(pos('a')).toEqual({ x: 0, y: 0 });
    expect(pos('b')).toEqual({ x: 0, y: 400 });
    expect(pos('c')).toEqual({ x: 0, y: 1072 });
    expect(out.find((n) => n.id === 'd')).toBe(nodes[3]);
    expect(out.find((n) => n.id === 'e')).toBe(nodes[4]);
    expect(out.find((n) => n.id === 'f')).toBe(nodes[5]);
    expect(resolveOverlaps([mk('x', 0, 0, 100, 100), mk('y', 300, 0, 100, 100)])).toEqual([mk('x', 0, 0, 100, 100), mk('y', 300, 0, 100, 100)]);
  });

  it('父节点排在子节点前；悬空 parentId 去掉', () => {
    const out = normalizeParents([
      { id: 'c', parentId: 'g' },
      { id: 'g' },
      { id: 'o', parentId: 'missing' },
    ] as Node[]);
    expect(out.map((n) => n.id)).toEqual(['g', 'c', 'o']);
    expect(out[2].parentId).toBeUndefined();
  });

  it('保存快照：schema_version 2，去掉函数 / 选中 / 拖动态', () => {
    const snap = buildSaveSnapshot(
      [{ id: 'a', type: 'prompt', position: { x: 0, y: 0 }, selected: true, dragging: true, data: { prompt: 'x', onUpdate: () => {} } } as Node],
      [{ id: 'e', source: 'a', target: 'b', selected: true } as Edge],
      { x: 1, y: 2, zoom: 1 },
    );
    expect(snap.schema_version).toBe(2);
    expect(snap.nodes[0]).toMatchObject({ selected: false, data: { prompt: 'x' } });
    expect(snap.nodes[0].dragging).toBeUndefined();
    expect(snap.nodes[0].data.onUpdate).toBeUndefined();
    expect(snap.edges[0].selected).toBeUndefined();
    expect(snap.viewport).toEqual({ x: 1, y: 2, zoom: 1 });
  });

  it('备份闸门：同一画布只备份一次，保存前等备份；备份失败不抛', async () => {
    const resolvers = new Map<string, () => void>();
    const backup = vi.fn((_p: string, cid: string) => new Promise<void>((r) => { resolvers.set(cid, r); }));
    const gate = createBackupGate(backup, { info: () => {}, warn: () => {} });
    expect(gate.ensure('p', 'c', { nodes: [] })).toBe(true);
    expect(gate.ensure('p', 'c', { nodes: [] })).toBe(false);
    expect(gate.ensure('p', 'c2', {})).toBe(true);
    await Promise.resolve();
    expect(backup).toHaveBeenCalledTimes(2);
    let saved = false;
    const waiting = gate.wait('p', 'c').then(() => { saved = true; });
    await Promise.resolve();
    expect(saved).toBe(false);
    resolvers.get('c')!();
    await waiting;
    expect(saved).toBe(true);
    // 没有备份任务的画布直接放行
    await expect(gate.wait('p', 'other')).resolves.toBeUndefined();
    const failing = createBackupGate(() => Promise.reject(new Error('x')), { info: () => {}, warn: () => {} });
    failing.ensure('p', 'c', {});
    await expect(failing.wait('p', 'c')).resolves.toBeUndefined();
  });
});

let seq = 0;
const makeNode = (type: string, position: { x: number; y: number }, data?: Record<string, unknown>): Node => ({ id: `${type}_${++seq}`, type, position, data: newNodeData(type, data) });

describe('模板（新数据模型）', () => {
  it('剧本 → 生图 → 视频：连到 in，图片 → 视频带首帧槽位', () => {
    const { nodes, edges } = buildTemplate(TEMPLATES[0], makeNode, () => 220);
    expect(nodes.map((n) => n.type)).toEqual(['prompt', 'image', 'video']);
    expect(edges.map((e) => `${e.sourceHandle}->${e.targetHandle}`)).toEqual(['prompt->in', 'image->in']);
    const vid = nodes[2].data as AnyData;
    expect(vid.refRoles).toEqual({ [`${nodes[1].id}|image`]: 'first_frame' });
    expect(vid.refOrder).toEqual([`${nodes[1].id}|image`]);
  });
  it('完整导演流：视频 / 配音汇入导出（媒体口），文本分叉到配音 in', () => {
    const { nodes, edges } = buildTemplate(TEMPLATES[1], makeNode, () => 220);
    const types = Object.fromEntries(nodes.map((n) => [n.id, n.type]));
    const pairs = edges.map((e) => `${types[e.source]}.${e.sourceHandle}->${types[e.target]}.${e.targetHandle}`);
    expect(pairs).toEqual(expect.arrayContaining(['prompt.prompt->image.in', 'image.image->video.in', 'prompt.prompt->audio.in', 'audio.audio->export.audio', 'video.video->export.video']));
  });
  it('首尾帧模板：两张图分别落首帧 / 尾帧', () => {
    const { nodes } = buildTemplate(TEMPLATES[2], makeNode, () => 220);
    expect(Object.values((nodes[2].data as AnyData).refRoles)).toEqual(['first_frame', 'last_frame']);
    expect((nodes[2].data as AnyData).mode).toBe('startEnd');
  });
  it('Creator 模板：未知键跳过，图片 → 视频落首帧', () => {
    const { nodes, edges } = buildCreatorTemplate({ nodes: [{ key: 'image' }, { key: 'video', x: 300 }, { key: 'weird' }], edges: [{ from: 'image', to: 'video' }] }, makeNode);
    expect(nodes.map((n) => n.type)).toEqual(['image', 'video']);
    expect(edges[0].targetHandle).toBe('in');
    expect(Object.values((nodes[1].data as AnyData).refRoles)).toEqual(['first_frame']);
  });
});

describe('分镜「在画布中运行」子图', () => {
  const project = {
    characters: [
      { id: 'c1', name: '林川', three_views: { front: '/c1.png' }, ref_audio_url: '/c1.wav' },
    ],
  };
  const shot = {
    id: 's1', shot_index: 3, video_prompt: '镜头推进 [Camera: Dolly In]', image_prompt: '少女回眸',
    camera_framing: 'close_up', camera_motion: 'orbit', character_ids: ['c1'], speaker_name: '林川',
    scene_ref_image: '/scene.png', previz_url: '/clay.png', video_provider: 'kling', duration: 6,
  };

  it('槽位归一：首帧 / 尾帧 / 参考图 / 参考音频 / 参考视频', () => {
    expect(canonicalSlotOf({ key: 'first_frame_url', type: 'image' })).toBe('first_frame');
    expect(canonicalSlotOf({ key: 'end_image', role: 'last_frame', type: 'image' })).toBe('last_frame');
    expect(canonicalSlotOf({ key: 'img_5', type: 'image' })).toBe('reference_images');
    expect(canonicalSlotOf({ key: 'voice', type: 'audio' })).toBe('ref_audio');
    expect(canonicalSlotOf({ key: 'v', type: 'video' })).toBe('reference_video');
  });

  it('无生成源定义：角色三视图 / 场景 / 白模 → 参考图，参考音频 → ref_audio', () => {
    const fills = bindingFills({ shot, project, kind: 'video', includeFirstFrame: true });
    expect(fills.map((f) => `${f.slot}:${f.url}`)).toEqual(expect.arrayContaining([
      'reference_images:/c1.png', 'reference_images:/scene.png', 'reference_images:/clay.png', 'ref_audio:/c1.wav',
    ]));
  });

  it('子图：文本 / 3D 导演 / 图片生成 / 绑定加载节点都连到视频 in，槽位写进 refRoles', () => {
    const sub = buildShotSubgraph({ shot, project, makeNode });
    const byId = new Map(sub.nodes.map((n) => [n.id, n]));
    const vid = byId.get(sub.videoNodeId)!;
    const vd = vid.data as AnyData;
    expect(vd).toMatchObject({ shotId: 's1', shotIndex: 3, provider_id: 'kling', duration: 6, prompt: '' });
    // 不带旧槽位键
    for (const k of ['first_frame', 'reference_images', 'ref_audio', 'camera_prompt']) expect(vd).not.toHaveProperty(k);
    const into = sub.edges.filter((e) => e.target === vid.id);
    expect(into.every((e) => e.targetHandle === 'in')).toBe(true);
    const roleOf = (srcType: string) => into.filter((e) => byId.get(e.source)!.type === srcType).map((e) => vd.refRoles[`${e.source}|${e.sourceHandle}`]);
    expect(roleOf('prompt')).toEqual(['prompt']);
    expect(roleOf('director3d')).toEqual(['camera_prompt']);
    expect(roleOf('image')).toEqual(['first_frame']);
    expect(roleOf('load-audio')).toEqual(['ref_audio']);
    expect(roleOf('load-image').sort()).toEqual(['reference_images', 'reference_images', 'reference_images']);
    expect(vd.refOrder.length).toBe(into.length);
    // 3D 导演：分镜机位参数 + 算好的运镜提示词
    const dir = byId.get(sub.directorNodeId)!.data as AnyData;
    expect(dir).toMatchObject({ framing: 'close_up', motion: 'orbit', shotId: 's1' });
    expect(dir.camera_prompt).toBeTruthy();
    // 图片生成：自身提示词 + 角色参考图（加载节点复用）
    const img = byId.get(sub.imageNodeId!)!;
    const intoImg = sub.edges.filter((e) => e.target === img.id);
    expect((img.data as AnyData).prompt).toBe('少女回眸');
    expect(intoImg.length).toBeGreaterThan(0);
    expect(Object.values((img.data as AnyData).refRoles).every((r) => r === 'reference_images')).toBe(true);
  });

  it('已有首帧图：真首帧加载节点落 first_frame，不建图片生成；动漫直出（motion_comic）不带首帧', () => {
    const withFrame = buildShotSubgraph({ shot: { ...shot, image_url: '/frame.png' }, project, makeNode });
    expect(withFrame.imageNodeId).toBeUndefined();
    const v = withFrame.nodes.find((n) => n.id === withFrame.videoNodeId)!.data as AnyData;
    const frameNode = withFrame.nodes.find((n) => (n.data as AnyData).image_url === '/frame.png')!;
    expect(v.refRoles[`${frameNode.id}|image`]).toBe('first_frame');
    const mc = buildShotSubgraph({ shot: { ...shot, image_url: '/frame.png', production_mode: 'motion_comic' }, project, makeNode });
    const mv = mc.nodes.find((n) => n.id === mc.videoNodeId)!.data as AnyData;
    expect(Object.values(mv.refRoles)).not.toContain('first_frame');
  });

  it('按生成源插槽绑定（planBinding）：只落生成源声明的槽位', () => {
    const fills = bindingFills({
      shot: { ...shot, image_url: '/frame.png' }, project, kind: 'video', includeFirstFrame: true,
      slots: [{ key: 'first_frame', label: '首帧', type: 'image' }, { key: 'reference_images', label: '参考图', type: 'image', multi: true, maxCount: 2 }],
    });
    expect(fills.filter((f) => f.slot === 'first_frame').map((f) => f.url)).toEqual(['/frame.png']);
    expect(fills.filter((f) => f.slot === 'reference_images').length).toBe(2);
    expect(fills.some((f) => f.slot === 'ref_audio')).toBe(false);
  });
});
