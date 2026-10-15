import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  assembleInputs, assemblePrompt, assembleAudioText, autoMode, availableModes, providerVideoMode, resolveSlotCaps, toEngineArgs, type SlotSpec,
} from '../assembleInputs';
import { buildRefs } from '../references';
import { normalizeVideoMode, ownPromptOf } from '../inputRules';
import { extractSlotsFromProvider, type DynamicProviderInfo } from '../../providerSkills';
import type { RefItem } from '../types';

/**
 * REQ-toonflow-canvas design §4：有序参考列表 → 生成源输入槽。
 * 「前后端同一夹具」一节逐条照搬 server/tests/test_canvas_in_port.py 的用例与期望值，
 * 保证 kit/assembleInputs 与后端 server/app/canvas/inputs.py 结果一致（改规则时两边一起改）。
 */

type N = { id: string; type: string; data: Record<string, unknown>; position?: { x: number; y: number } };

function srcNodes(): N[] {
  return [
    { id: 't1', type: 'prompt', data: { prompt: '一个女孩在雨中奔跑' } },
    { id: 'd1', type: 'director3d', data: { camera_prompt: '[推进,左摇]' } },
    { id: 'i1', type: 'load-image', data: { image_url: '/s/a.png' } },
    { id: 'i2', type: 'load-image', data: { image_url: '/s/b.png' } },
    { id: 'i3', type: 'load-image', data: { image_url: '/s/c.png' } },
    { id: 'a1', type: 'load-audio', data: { audio_url: '/s/x.mp3' } },
    { id: 'v1', type: 'load-video', data: { video_url: '/s/r.mp4' } },
  ];
}

/** 后端 _e：sourceHandle 为空时不写该键；targetHandle 为 null 时不写。 */
function e(id: string, source: string, sh: string, target: string, th: string | null): Edge {
  const edge: Edge = { id, source, target };
  if (sh) edge.sourceHandle = sh;
  if (th !== null) edge.targetHandle = th;
  return edge;
}

/** 前端版 collect_inputs：buildRefs（R1–R3）+ assembleInputs（R4–R6），生成源未知（不截断）。 */
function collect(nodes: N[], edges: Edge[], targetId: string) {
  const byId = new Map(nodes.map((n) => [n.id, { position: { x: 0, y: 0 }, ...n } as Node]));
  const target = byId.get(targetId)!;
  const refs = buildRefs(edges, (id) => byId.get(id), targetId);
  const r = assembleInputs({
    refs, targetType: target.type!, prompt: ownPromptOf(target.type, target.data), mode: target.data.mode as string,
  });
  return { slots: r.canonical, mode: r.mode, refs, r };
}

/** 后端 _to_new_model：旧具名口连线换成 in + refRoles + refOrder。 */
function toNewModel(nodes: N[], edges: Edge[], targetId: string, legacy: Record<string, string>) {
  const n2: N[] = JSON.parse(JSON.stringify(nodes));
  const e2: Edge[] = JSON.parse(JSON.stringify(edges));
  const tgt = n2.find((n) => n.id === targetId)!;
  const roles: Record<string, string> = {};
  const order: string[] = [];
  for (const edge of e2) {
    if (edge.target !== targetId) continue;
    const key = `${edge.source}|${edge.sourceHandle ?? ''}`;
    const slot = legacy[edge.targetHandle ?? ''];
    if (slot) roles[key] = slot;
    order.push(key);
    edge.targetHandle = 'in';
  }
  tgt.data = { ...tgt.data, refRoles: roles, refOrder: order };
  return { nodes: n2, edges: e2 };
}

const LEGACY = { prompt: 'prompt', text: 'prompt', camera_prompt: 'camera_prompt', first_frame: 'first_frame', last_frame: 'last_frame', reference_images: 'reference_images', reference: 'reference_images', ref_audio: 'ref_audio' };

describe('前后端同一夹具：旧具名口 vs in + refRoles（TestResolverLegacyVsNew）', () => {
  function same(nodes: N[], edges: Edge[], targetId: string) {
    const old = collect(nodes, edges, targetId);
    const nm = toNewModel(nodes, edges, targetId, LEGACY);
    const neu = collect(nm.nodes, nm.edges, targetId);
    expect(neu.slots).toEqual(old.slots);
    expect(neu.mode).toEqual(old.mode);
    return old;
  }

  it('test_video_all_slots', () => {
    const nodes = [...srcNodes(), { id: 'vid', type: 'video', data: {} }];
    const edges = [
      e('e1', 't1', 'prompt', 'vid', 'prompt'), e('e2', 'd1', 'camera_prompt', 'vid', 'camera_prompt'),
      e('e3', 'i1', 'image', 'vid', 'first_frame'), e('e4', 'i2', 'image', 'vid', 'last_frame'),
      e('e5', 'i3', 'image', 'vid', 'reference_images'), e('e6', 'a1', 'audio', 'vid', 'ref_audio'),
    ];
    const r = same(nodes, edges, 'vid');
    expect(r.slots).toEqual({
      prompt: '一个女孩在雨中奔跑', camera_prompt: '[推进,左摇]', first_frame: '/s/a.png', last_frame: '/s/b.png',
      reference_images: ['/s/c.png'], ref_audio: ['/s/x.mp3'],
    });
    expect(r.mode).toBe('multiReference');
  });

  it('test_image_reference_handles', () => {
    const nodes = [...srcNodes(), { id: 'img', type: 'image', data: {} }];
    const edges = [
      e('e1', 't1', 'prompt', 'img', 'prompt'), e('e2', 'i1', 'image', 'img', 'reference'),
      e('e3', 'i2', 'image', 'img', 'reference_images'), e('e4', 'd1', 'camera_prompt', 'img', 'camera_prompt'),
    ];
    const r = same(nodes, edges, 'img');
    expect(r.slots.reference_images).toEqual(['/s/a.png', '/s/b.png']);
    expect(r.slots.camera_prompt).toBe('[推进,左摇]');
    expect(r.mode).toBe('');
  });

  it('test_audio_text_and_ref_audio', () => {
    const nodes = [...srcNodes(), { id: 'aud', type: 'audio', data: {} }];
    const r = same(nodes, [e('e1', 't1', 'prompt', 'aud', 'text'), e('e2', 'a1', 'audio', 'aud', 'ref_audio')], 'aud');
    expect(r.slots).toEqual({ prompt: '一个女孩在雨中奔跑', ref_audio: ['/s/x.mp3'] });
  });
});

describe('前后端同一夹具：自动分配（TestAutoAssignment）', () => {
  function video(nImages: number, mode?: string, roles?: Record<string, string>) {
    const data: Record<string, unknown> = {};
    if (mode !== undefined) data.mode = mode;
    if (roles) data.refRoles = roles;
    const nodes = [...srcNodes(), { id: 'vid', type: 'video', data }];
    const edges = Array.from({ length: nImages }, (_, k) => e(`e${k + 1}`, `i${k + 1}`, 'image', 'vid', 'in'));
    return collect(nodes, edges, 'vid');
  }

  it('0 张 → text；1 张 → 首帧 singleImage；2 张默认 → 参考图 multiReference', () => {
    expect(video(0).slots).toEqual({});
    expect(video(0).mode).toBe('text');
    expect(video(1).slots).toEqual({ first_frame: '/s/a.png' });
    expect(video(1).mode).toBe('singleImage');
    expect(video(2).slots).toEqual({ reference_images: ['/s/a.png', '/s/b.png'] });
    expect(video(2).mode).toBe('multiReference');
  });

  it('startEnd / singleImage / text / multiReference 与旧值 i2v r2v t2v', () => {
    expect(video(2, 'startEnd').slots).toEqual({ first_frame: '/s/a.png', last_frame: '/s/b.png' });
    expect(video(3, 'startEnd').slots.reference_images).toEqual(['/s/c.png']);
    expect(video(2, 'singleImage').slots).toEqual({ first_frame: '/s/a.png', reference_images: ['/s/b.png'] });
    expect(video(2, 'text').slots).toEqual({});
    expect(video(1, 'multiReference').slots).toEqual({ reference_images: ['/s/a.png'] });
    expect(video(1, 'r2v').slots).toEqual({ reference_images: ['/s/a.png'] });
    expect(video(2, 'i2v').slots).toEqual({ first_frame: '/s/a.png', reference_images: ['/s/b.png'] });
    expect(video(1, 't2v').slots).toEqual({});
    expect(video(2, 'i2v', { 'i1|image': 'first_frame', 'i2|image': 'last_frame' }).mode).toBe('startEnd');
  });

  it('显式首帧后自动的进参考图；单值槽先到先得', () => {
    expect(video(2, undefined, { 'i2|image': 'first_frame' }).slots).toEqual({ first_frame: '/s/b.png', reference_images: ['/s/a.png'] });
    const r = video(2, undefined, { 'i1|image': 'first_frame', 'i2|image': 'first_frame' });
    expect(r.slots).toEqual({ first_frame: '/s/a.png' });
    expect(r.r.assignments['i2|image']).toBeNull();
  });

  it('非视频目标：单张图也进参考图', () => {
    const nodes = [...srcNodes(), { id: 'img', type: 'image', data: {} }];
    expect(collect(nodes, [e('e1', 'i1', 'image', 'img', 'in')], 'img').slots).toEqual({ reference_images: ['/s/a.png'] });
  });

  it('只有音频/视频参考 → multiReference', () => {
    const nodes = [...srcNodes(), { id: 'vid', type: 'video', data: {} }];
    const r = collect(nodes, [e('e1', 'a1', 'audio', 'vid', 'in'), e('e2', 'v1', 'video', 'vid', 'in')], 'vid');
    expect(r.slots).toEqual({ ref_audio: ['/s/x.mp3'], reference_video: ['/s/r.mp4'] });
    expect(r.mode).toBe('multiReference');
  });

  it('槽位与类型不符 → 视为未指定', () => {
    const nodes = [...srcNodes(), { id: 'vid', type: 'video', data: { refRoles: { 't1|prompt': 'first_frame' } } }];
    expect(collect(nodes, [e('e1', 't1', 'prompt', 'vid', 'in')], 'vid').slots).toEqual({ prompt: '一个女孩在雨中奔跑' });
  });

  it('3D 导演文本 → camera_prompt（任何目标）；refRoles 可改回 prompt', () => {
    for (const t of ['video', 'image', 'audio']) {
      const nodes = [...srcNodes(), { id: 'g', type: t, data: {} }];
      const r = collect(nodes, [e('e1', 'd1', '', 'g', 'in')], 'g');
      expect(r.refs[0].key).toBe('d1|');
      expect(r.r.assignments['d1|']).toBe('camera_prompt');
      expect(r.slots).toEqual({ camera_prompt: '[推进,左摇]' });
    }
    const nodes = [...srcNodes(), { id: 'g', type: 'video', data: { refRoles: { 'd1|camera_prompt': 'prompt' } } }];
    expect(collect(nodes, [e('e1', 'd1', 'camera_prompt', 'g', 'in')], 'g').slots).toEqual({ prompt: '[推进,左摇]' });
  });

  it('空 targetHandle 的旧边按自动处理', () => {
    const nodes = [...srcNodes(), { id: 'vid', type: 'video', data: {} }];
    expect(collect(nodes, [{ id: 'e1', source: 'i1', target: 'vid' }], 'vid').slots).toEqual({ first_frame: '/s/a.png' });
  });

  it('provider* / group 来源不是参考', () => {
    const nodes: N[] = [
      { id: 'p', type: 'provider-video', data: { provider_id: 'seedance' } },
      { id: 'grp', type: 'group', data: {} },
      { id: 'vid', type: 'video', data: {} },
    ];
    expect(collect(nodes, [e('e1', 'p', 'provider', 'vid', 'in'), e('e2', 'grp', '', 'vid', 'in')], 'vid').refs).toEqual([]);
  });
});

describe('前后端同一夹具：顺序与提示词（TestOrderAndPrompt）', () => {
  function nodes(own = '', order?: string[]): N[] {
    const data: Record<string, unknown> = { prompt: own };
    if (order) data.refOrder = order;
    return [
      { id: 'ta', type: 'prompt', data: { prompt: '角色：白衣少女' } },
      { id: 'tb', type: 'prompt', data: { prompt: '场景：竹林夜雨' } },
      { id: 'im', type: 'load-image', data: { image_url: '/s/a.png' } },
      { id: 'img', type: 'image', data },
    ];
  }
  const edges = () => [e('e1', 'ta', 'text', 'img', 'in'), e('e2', 'im', 'image', 'img', 'in'), e('e3', 'tb', 'text', 'img', 'in')];

  it('自身提示词 + 编号文本参考', () => {
    const r = collect(nodes('画 {{ref 1}} 站在 {{ref 3}}'), edges(), 'img');
    expect(r.slots.prompt).toBe('画 参考 1 站在 参考 3\n\n参考 1：\n角色：白衣少女\n\n参考 3：\n场景：竹林夜雨');
  });

  it('提到媒体参考时附编号对应关系', () => {
    const r = collect(nodes('让 {{ref 1}} 穿上 {{ref 2}} 的衣服'), edges(), 'img');
    expect(r.slots.prompt).toBe('让 参考 1 穿上 参考 2 的衣服\n\n参考 1：\n角色：白衣少女\n\n参考 3：\n场景：竹林夜雨\n\n（参考编号对应：参考 2=第 1 张参考图）');
    const vnodes = [...srcNodes(), { id: 'vid', type: 'video', data: { prompt: '{{ref 1}} 到 {{ref 2}}', mode: 'startEnd' } }];
    const rv = collect(vnodes, [e('a', 'i1', 'image', 'vid', 'in'), e('b', 'i2', 'image', 'vid', 'in')], 'vid');
    expect(rv.slots.prompt).toBe('参考 1 到 参考 2\n\n（参考编号对应：参考 1=首帧图，参考 2=尾帧图）');
  });

  it('refOrder 重排编号', () => {
    const r = collect(nodes('X', ['tb|text', 'im|image']), edges(), 'img');
    expect(r.refs.map((x) => x.key)).toEqual(['tb|text', 'im|image', 'ta|text']);
    expect(r.slots.prompt).toBe('X\n\n参考 1：\n场景：竹林夜雨\n\n参考 3：\n角色：白衣少女');
  });

  it('自身为空时第一条文本参考作主体（不加前缀）；与自身相同的文本参考去重', () => {
    expect(collect(nodes(''), edges(), 'img').slots.prompt).toBe('角色：白衣少女\n\n参考 3：\n场景：竹林夜雨');
    expect(collect(nodes('角色：白衣少女'), edges(), 'img').slots.prompt).toBe('角色：白衣少女\n\n参考 3：\n场景：竹林夜雨');
  });

  it('音频节点自身文本取 text 优先', () => {
    expect(ownPromptOf('audio', { prompt: 'p', text: ' 台词 ' })).toBe('台词');
    expect(ownPromptOf('image', { prompt: 'p', text: 't' })).toBe('p');
    expect(assemblePrompt('', [])).toBe('');
  });
});

describe('前后端同一夹具：音频配音文本 R6a（TestAudioText，K1 / T6）', () => {
  function nodes(data: Record<string, unknown>, type = 'audio'): N[] {
    return [
      { id: 'ta', type: 'prompt', data: { prompt: '角色：白衣少女' } },
      { id: 'im', type: 'load-image', data: { image_url: '/s/a.png' } },
      { id: 'tb', type: 'prompt', data: { prompt: '场景：竹林夜雨' } },
      { id: 'aud', type, data },
    ];
  }
  const edges = () => [e('e1', 'ta', 'text', 'aud', 'in'), e('e2', 'im', 'image', 'aud', 'in'), e('e3', 'tb', 'text', 'aud', 'in')];
  const prompt = (data: Record<string, unknown>) => collect(nodes(data), edges(), 'aud').slots.prompt;

  it('test_own_text_tokens_replaced_by_ref_text', () => {
    expect(prompt({ text: '{{ref 1}}，{{ref 3}}' })).toBe('角色：白衣少女，场景：竹林夜雨');
  });

  it('test_own_text_only_no_prefix_no_mapping', () => {
    // 没提到的文本参考不念；媒体参考 {{ref 2}} / 越界 {{ref 9}} 换成空串，也不加「参考编号对应」附注
    expect(prompt({ text: '大家好' })).toBe('大家好');
    expect(prompt({ text: '看{{ref 2}}这里{{ref 9}}' })).toBe('看这里');
  });

  it('test_text_key_before_prompt', () => {
    expect(prompt({ text: '念这句', prompt: '不念这句' })).toBe('念这句');
    expect(prompt({ prompt: '旧节点只有 prompt {{ref 3}}' })).toBe('旧节点只有 prompt 场景：竹林夜雨');
  });

  it('test_empty_own_joins_text_refs_with_newline', () => {
    expect(prompt({})).toBe('角色：白衣少女\n场景：竹林夜雨');
    const r = collect(nodes({ refOrder: ['tb|text', 'ta|text'] }), edges(), 'aud');
    expect(r.slots.prompt).toBe('场景：竹林夜雨\n角色：白衣少女');
  });

  it('test_other_targets_keep_numbered_refs', () => {
    const r = collect(nodes({ prompt: '{{ref 1}}' }, 'image'), edges(), 'aud');
    expect(r.slots.prompt).toBe('参考 1\n\n参考 1：\n角色：白衣少女\n\n参考 3：\n场景：竹林夜雨');
  });

  it('空值文本参考 / 机位文本也换成空串；assembleAudioText 纯函数', () => {
    expect(assembleAudioText(' {{ref 1}}{{ref 2}} ', [[1, '  甲 '], [2, '  ']])).toBe('甲');
    expect(assembleAudioText('', [[3, '丙'], [1, '甲'], [2, '']])).toBe('甲\n丙');
    expect(assembleAudioText('', [])).toBe('');
    const ns: N[] = [...srcNodes(), { id: 'aud', type: 'audio', data: { text: '{{ref 1}}开拍' } }];
    expect(collect(ns, [e('a', 'd1', 'camera_prompt', 'aud', 'in')], 'aud').slots).toEqual({ prompt: '开拍', camera_prompt: '[推进,左摇]' });
  });

  it('前端独有：自身台词没引用的文本参考标为未使用并提示；引用了非文本参考提示会被忽略', () => {
    const { r, refs } = collect(nodes({ text: '{{ref 1}}，{{ref 2}}' }), edges(), 'aud');
    expect(r.prompt).toBe('角色：白衣少女，');
    expect(r.assignments[refs[0].key]).toBe('prompt');
    expect(r.assignments[refs[2].key]).toBeNull();
    expect(r.warnings).toEqual(['台词里没有引用 参考 3，不会念出', '参考 2 不是文本，台词里的引用会被忽略']);
    expect(r.hasTextRefs).toBe(true); // 同后端 has_text_refs = 有文本参考
    // 自身为空：全部文本参考都念，没有这两条提示
    expect(collect(nodes({}), edges(), 'aud').r.warnings).toEqual([]);
  });
});

describe('R7 生成源模式 / 模式归一', () => {
  it('新模式映射 t2v/i2v/r2v；空模式按槽位', () => {
    expect(providerVideoMode('text', {})).toBe('t2v');
    expect(providerVideoMode('singleImage', {})).toBe('i2v');
    expect(providerVideoMode('startEnd', {})).toBe('i2v');
    expect(providerVideoMode('multiReference', {})).toBe('r2v');
    expect(providerVideoMode('r2v', {})).toBe('r2v');
    expect(providerVideoMode('', { first_frame: 'f' })).toBe('i2v');
    expect(providerVideoMode(undefined, { reference_images: ['a'] })).toBe('r2v');
    expect(providerVideoMode(null, { reference_video: ['v'] })).toBe('r2v');
    expect(providerVideoMode('', {})).toBe('t2v');
    expect(normalizeVideoMode('StartEndRequired')).toBe('startEnd');
    expect(normalizeVideoMode('bogus')).toBe('');
  });

  it('autoMode：0→text（有音视频→multiReference）、1→singleImage、≥2→multiReference', () => {
    expect(autoMode([])).toBe('text');
    expect(autoMode([{ dataType: 'AUDIO' }])).toBe('multiReference');
    expect(autoMode([{ dataType: 'IMAGE' }])).toBe('singleImage');
    expect(autoMode([{ dataType: 'IMAGE' }, { dataType: 'IMAGE' }])).toBe('multiReference');
  });

  it('生成源未知时 args = 后端 to_engine_upstream 的键', () => {
    const nodes = [...srcNodes(), { id: 'vid', type: 'video', data: { prompt: 'go' } }];
    const { r } = collect(nodes, [e('e1', 'i1', 'image', 'vid', 'in'), e('e2', 'a1', 'audio', 'vid', 'in'), e('e3', 'v1', 'video', 'vid', 'in')], 'vid');
    expect(r.args).toEqual({
      prompt: 'go', text: 'go', first_frame: '/s/a.png', first_frame_url: '/s/a.png',
      ref_audio: '/s/x.mp3', reference_audios: ['/s/x.mp3'], reference_videos: ['/s/r.mp4'],
    });
    expect(r.providerMode).toBe('i2v');
    expect(toEngineArgs({})).toEqual({});
  });
});

// —— 前端独有：按生成源能力映射入参键 / 截断 / 提示 ——

let seq = 0;
function ref(dataType: RefItem['dataType'], value: string, extra: Partial<RefItem> = {}): RefItem {
  seq += 1;
  const sourceId = extra.sourceId ?? `n${seq}`;
  const sourceHandle = extra.sourceHandle ?? dataType.toLowerCase();
  return { key: `${sourceId}|${sourceHandle}`, sourceId, sourceHandle, targetHandle: 'in', dataType, value, ...extra };
}

const VIDEO_SLOTS: SlotSpec[] = [
  { key: 'first_frame', type: 'image', maxCount: 1, originalKey: 'first_frame_image', label: '首帧' },
  { key: 'last_frame', type: 'image', maxCount: 1, originalKey: 'last_frame_image', label: '尾帧' },
  { key: 'reference_images', type: 'image', maxCount: 3, multi: true, originalKey: 'subject_reference', label: '参考图' },
  { key: 'ref_audio', type: 'audio', maxCount: 1, label: '参考音频' },
  { key: 'reference_videos', type: 'video', maxCount: 1, multi: false, label: '参考视频' },
];

describe('生成源能力（前端独有）', () => {
  it('availableModes 由槽位决定（供模式切换 UI）', () => {
    expect(availableModes([])).toEqual(['text']);
    expect(availableModes([{ key: 'first_frame', type: 'image', maxCount: 1 }])).toEqual(['text', 'singleImage']);
    expect(availableModes(VIDEO_SLOTS)).toEqual(['text', 'singleImage', 'startEnd', 'multiReference']);
    expect(availableModes(null)).toEqual(['text', 'singleImage', 'startEnd', 'multiReference']);
  });

  it('args 用 input_schema 属性名；超出 maxItems 截断并提示；canonical 不截断（同后端）', () => {
    const refs = [ref('IMAGE', 'u1'), ref('IMAGE', 'u2'), ref('IMAGE', 'u3'), ref('IMAGE', 'u4')];
    const r = assembleInputs({ refs, targetType: 'video', prompt: 'p', slots: VIDEO_SLOTS });
    expect(r.mode).toBe('multiReference');
    expect(r.canonical.reference_images).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(r.reference_images).toEqual(['u1', 'u2', 'u3']);
    expect(r.args).toEqual({ prompt: 'p', subject_reference: ['u1', 'u2', 'u3'] });
    expect(r.warnings).toEqual(['参考图超出生成源上限（最多 3 个），已忽略 参考 4']);
    expect(r.assignments[refs[3].key]).toBeNull();
    expect(r.providerMode).toBe('r2v');
  });

  it('生成源没有该槽：不下发并提示；必填槽缺失提示', () => {
    const only: SlotSpec[] = [{ key: 'first_frame', type: 'image', maxCount: 1, required: true, label: '首帧' }];
    const r = assembleInputs({ refs: [ref('VIDEO', 'v1')], targetType: 'video', prompt: 'p', slots: only });
    expect(r.canonical.reference_video).toEqual(['v1']);
    expect(r.reference_video).toEqual([]);
    expect(r.warnings).toEqual(['生成源不支持参考视频，参考 1 未使用', '生成源需要首帧']);
  });

  it('空参考跳过并提示（仍占编号）；文生模式提示图片未使用', () => {
    const r = assembleInputs({ refs: [ref('STRING', ''), ref('IMAGE', 'u1')], targetType: 'video', prompt: '{{ref 2}}', mode: 'text' });
    expect(r.warnings).toEqual(['参考 1 暂无内容，已跳过', '当前为文生模式，参考 2 未使用']);
    expect(r.prompt).toBe('参考 2');
  });

  it('与 providerSkills.extractSlotsFromProvider 对接（x-slot / maxItems / 非标准键）', () => {
    const provider: DynamicProviderInfo = {
      id: 'seedance', name: 'seedance', kind: 'video', models: [],
      input_schema: {
        properties: {
          image_urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 2, 'x-handle': 'image', 'x-slot': 'reference_images' },
          video_urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 1, 'x-handle': 'video', 'x-slot': 'reference_videos' },
          audio: { type: 'string', format: 'uri', 'x-handle': 'audio', 'x-slot': 'ref_audio' },
        },
        required: ['image_urls'],
      },
    };
    const slots = extractSlotsFromProvider(provider, 'video');
    expect(resolveSlotCaps(slots)?.reference_video?.argKey).toBe('video_urls');
    const r = assembleInputs({ refs: [ref('IMAGE', 'u1'), ref('IMAGE', 'u2'), ref('IMAGE', 'u3'), ref('AUDIO', 'a')], targetType: 'video', prompt: 'p', slots });
    expect(r.args).toEqual({ prompt: 'p', image_urls: ['u1', 'u2'], audio: 'a' });
    expect(r.warnings).toEqual([expect.stringContaining('最多 2 个')]);
    const single = assembleInputs({ refs: [ref('IMAGE', 'u9')], targetType: 'image', prompt: 'p', slots: [{ key: 'image', type: 'image', maxCount: 1, multi: false }] });
    expect(single.args).toEqual({ prompt: 'p', image: 'u9' });
    expect(resolveSlotCaps(null)).toBeNull();
  });

  it('截断后对应关系只写仍会下发的图', () => {
    const refs = [ref('IMAGE', 'u1'), ref('IMAGE', 'u2')];
    const r = assembleInputs({ refs, targetType: 'image', prompt: '{{ref 1}} 和 {{ref 2}}', slots: [{ key: 'reference_images', type: 'image', maxCount: 1, multi: true }] });
    expect(r.prompt).toBe('参考 1 和 参考 2\n\n（参考编号对应：参考 1=第 1 张参考图）');
  });
});
