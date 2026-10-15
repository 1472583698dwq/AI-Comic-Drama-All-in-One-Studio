// REQ-toonflow-canvas 旧画布迁移单测（design §7：每条映射、具名口改连 in、幂等、未知类型保留、真实画布不丢数据）
import { describe, it, expect } from 'vitest';
import realCanvasesRaw from './fixtures/real-canvases.json?raw';
import {
  migrateCanvas,
  edgeKey,
  legacySlotFor,
  toInPort,
  detectAssetMediaKind,
  LEGACY_SLOT_MAP,
  NEW_IN_PORT,
  BATCH_SPLIT_SPACING,
  CANVAS_SCHEMA_VERSION,
  type RawCanvas,
  type CanvasNodeLike,
  type CanvasEdgeLike,
} from '../migrate';

const node = (id: string, type: string | undefined, data: Record<string, any> = {}, extra: Record<string, any> = {}): CanvasNodeLike => ({
  id,
  ...(type === undefined ? {} : { type }),
  position: { x: 100, y: 200 },
  data,
  ...extra,
});
const edge = (
  id: string,
  source: string,
  target: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): CanvasEdgeLike => ({
  id,
  source,
  target,
  ...(sourceHandle === undefined ? {} : { sourceHandle }),
  ...(targetHandle === undefined ? {} : { targetHandle }),
  type: 'default',
});
const byId = (nodes: any[], id: string) => nodes.find((n) => n.id === id);
const edgeById = (edges: any[], id: string) => edges.find((e) => e.id === id);
/** 深冻结：迁移函数一旦改动入参就会抛错 */
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.values(o as any).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

describe('helpers', () => {
  it('edgeKey = source|sourceHandle（空句柄记为空串）', () => {
    expect(edgeKey('a', 'image')).toBe('a|image');
    expect(edgeKey('a')).toBe('a|');
    expect(edgeKey('a', null)).toBe('a|');
    expect(edgeKey({ source: 'b', sourceHandle: 'prompt' })).toBe('b|prompt');
    expect(edgeKey({ source: 'b' })).toBe('b|');
  });

  it('LEGACY_SLOT_MAP / legacySlotFor 映射旧口名', () => {
    expect(NEW_IN_PORT).toBe('in');
    expect(LEGACY_SLOT_MAP.reference).toBe('reference_images');
    expect(LEGACY_SLOT_MAP.text).toBe('prompt');
    expect(LEGACY_SLOT_MAP.reference_audio).toBe('ref_audio');
    expect(legacySlotFor('prompt')).toBe('prompt');
    expect(legacySlotFor('first_frame', 'video')).toBe('first_frame');
    expect(legacySlotFor('image', 'video-legacy')).toBe('first_frame');
    expect(legacySlotFor('subject_reference', 'video')).toBe('subject_reference');
    expect(legacySlotFor('in')).toBeUndefined();
    expect(legacySlotFor('provider')).toBeUndefined();
    expect(legacySlotFor(null)).toBeUndefined();
  });

  it('toInPort：单输入口节点改连 in，其余原样', () => {
    expect(toInPort('video', 'first_frame')).toEqual({ targetHandle: 'in', role: 'first_frame' });
    expect(toInPort('audio', 'text')).toEqual({ targetHandle: 'in', role: 'prompt' });
    expect(toInPort('tts', 'reference_audio')).toEqual({ targetHandle: 'in', role: 'ref_audio' });
    expect(toInPort('image', null)).toEqual({ targetHandle: 'in' });
    expect(toInPort('image', 'in')).toBeNull();
    expect(toInPort('video', 'provider')).toBeNull();
    expect(toInPort('video', null, 'provider-video')).toBeNull();
    expect(toInPort('export', 'video')).toBeNull();
    expect(toInPort('shot-card', 'prompt')).toBeNull();
  });

  it('detectAssetMediaKind 按媒体字段 / 类型字段 / 扩展名判断', () => {
    expect(detectAssetMediaKind({ video_url: '/v.mp4' })).toBe('video');
    expect(detectAssetMediaKind({ audio_url: '/a.mp3' })).toBe('audio');
    expect(detectAssetMediaKind({ image_url: '/i.png' })).toBe('image');
    expect(detectAssetMediaKind({ media_type: 'video/mp4', file_url: '/x' })).toBe('video');
    expect(detectAssetMediaKind({ file_url: '/storage/a/b.WAV?x=1' })).toBe('audio');
    expect(detectAssetMediaKind({ file_url: '/storage/a/b.mov', thumb_url: '/t.png' })).toBe('video');
    expect(detectAssetMediaKind({ thumb_url: '/t.png' })).toBe('image');
    expect(detectAssetMediaKind({ category: 'character' })).toBe('image');
    expect(detectAssetMediaKind({ name: 'x' })).toBeUndefined();
  });
});

describe('类型映射', () => {
  it('text-prompt → prompt：text/prompt 互补，输出口 text → prompt', () => {
    const raw = deepFreeze({
      nodes: [
        node('t1', 'text-prompt', { text: '只有 text' }),
        node('t2', 'text-prompt', { prompt: '只有 prompt' }),
        node('t3', 'text-prompt', { prompt: 'A', text: 'B' }),
        node('ex', 'export'),
      ],
      edges: [edge('e1', 't1', 'ex', 'text', 'video'), edge('e2', 't2', 'ex', 'prompt', 'video')],
    });
    const { canvas, changed, report } = migrateCanvas(raw);
    expect(changed).toBe(true);
    expect(byId(canvas.nodes, 't1')).toMatchObject({ type: 'prompt', data: { text: '只有 text', prompt: '只有 text', _migrated_from: 'text-prompt' } });
    expect(byId(canvas.nodes, 't2').data).toMatchObject({ prompt: '只有 prompt', text: '只有 prompt' });
    expect(byId(canvas.nodes, 't3').data).toMatchObject({ prompt: 'A', text: 'B' });
    expect(report.warnings.some((w) => w.includes('t3'))).toBe(true);
    expect(edgeById(canvas.edges, 'e1').sourceHandle).toBe('prompt');
    expect(edgeById(canvas.edges, 'e2').sourceHandle).toBe('prompt');
    // export 不是单输入口节点，目标口不动
    expect(edgeById(canvas.edges, 'e1').targetHandle).toBe('video');
    expect(report.converted['text-prompt->prompt']).toBe(3);
  });

  it('video-legacy → video：补 prompt/first_frame/provider_id，mode 原样保留；image 口=首帧、provider 口保留', () => {
    const raw = deepFreeze({
      nodes: [
        node('v', 'video-legacy', {
          video_prompt: '推镜',
          first_frame_url: '/f.png',
          provider_video: 'kling',
          mode: 'i2v',
          duration: 5,
          video_url: '/v.mp4',
        }),
        node('img', 'image', { image_url: '/f.png' }),
        node('pv', 'provider-video', { provider_id: 'kling' }),
        node('tl', 'timeline'),
      ],
      edges: [
        edge('e_img', 'img', 'v', 'image', 'image'),
        edge('e_prov', 'pv', 'v', 'provider', 'provider'),
        edge('e_out', 'v', 'tl', null, 'video'),
        edge('e_out2', 'v', 'tl', 'video', 'video'),
      ],
    });
    const { canvas, report } = migrateCanvas(raw);
    const v = byId(canvas.nodes, 'v');
    expect(v.type).toBe('video');
    expect(v.data).toMatchObject({
      prompt: '推镜',
      video_prompt: '推镜',
      first_frame: '/f.png',
      first_frame_url: '/f.png',
      provider_id: 'kling',
      provider: 'kling',
      provider_video: 'kling',
      mode: 'i2v',
      duration: 5,
      _migrated_from: 'video-legacy',
    });
    expect(edgeById(canvas.edges, 'e_img')).toMatchObject({ targetHandle: 'in', sourceHandle: 'image' });
    expect(v.data.refRoles).toEqual({ 'img|image': 'first_frame' });
    expect(v.data.refOrder).toEqual(['img|image']);
    expect(edgeById(canvas.edges, 'e_prov')).toMatchObject({ targetHandle: 'provider', sourceHandle: 'provider' });
    expect(report.providerEdges).toBe(1);
    expect(edgeById(canvas.edges, 'e_out').sourceHandle).toBe('video');
    expect(edgeById(canvas.edges, 'e_out2').sourceHandle).toBe('video');
    expect(report.converted['video-legacy->video']).toBe(1);
  });

  it('tts → audio：台词/语音源/参考音频对齐 audio 键，text/reference_audio 口改连 in', () => {
    const raw = deepFreeze({
      nodes: [
        node('tts1', 'tts', { dialogue: '你好', provider: 'minimax_tts', voice_id: 'female-1', emotion: 'happy', reference_audio: '/r.wav', audio_url: '/o.mp3' }),
        node('p', 'prompt', { prompt: '台词' }),
        node('la', 'load-audio', { audio_url: '/r.wav' }),
        node('pa', 'provider-audio', { provider_id: 'minimax_tts' }),
        node('ex', 'export'),
      ],
      edges: [
        edge('e_txt', 'p', 'tts1', 'prompt', 'text'),
        edge('e_ref', 'la', 'tts1', 'audio', 'reference_audio'),
        edge('e_prov', 'pa', 'tts1', 'provider', 'provider'),
        edge('e_out', 'tts1', 'ex', null, 'audio'),
      ],
    });
    const { canvas, report } = migrateCanvas(raw);
    const a = byId(canvas.nodes, 'tts1');
    expect(a.type).toBe('audio');
    expect(a.data).toMatchObject({
      text: '你好',
      prompt: '你好',
      dialogue: '你好',
      provider: 'minimax_tts',
      provider_id: 'minimax_tts',
      voice_id: 'female-1',
      emotion: 'happy',
      ref_audio: '/r.wav',
      reference_audio: '/r.wav',
      _migrated_from: 'tts',
    });
    expect(a.data.refRoles).toEqual({ 'p|prompt': 'prompt', 'la|audio': 'ref_audio' });
    expect(a.data.refOrder).toEqual(['p|prompt', 'la|audio']);
    expect(edgeById(canvas.edges, 'e_txt').targetHandle).toBe('in');
    expect(edgeById(canvas.edges, 'e_ref').targetHandle).toBe('in');
    expect(edgeById(canvas.edges, 'e_prov').targetHandle).toBe('provider');
    expect(edgeById(canvas.edges, 'e_out').sourceHandle).toBe('audio');
    expect(a.data.history).toEqual([{ url: '/o.mp3', provider_id: 'minimax_tts' }]);
    expect(report.converted['tts->audio']).toBe(1);
  });

  it('asset → load-image / load-video / load-audio，按媒体字段判断，输出口改成对应类型', () => {
    const raw = deepFreeze({
      nodes: [
        node('as_img', 'asset', { name: '角色', category: 'character', file_url: '/storage/assets/a.png', thumb_url: '/storage/assets/a_t.png', tags: ['x'] }),
        node('as_vid', 'asset', { name: '片段', video_url: '/storage/v.mp4' }),
        node('as_aud', 'asset', { name: '音色', file_url: '/storage/a.wav' }),
        node('as_unk', 'asset', { name: '无文件' }),
        node('vid', 'video'),
        node('aud', 'audio'),
      ],
      edges: [
        edge('e1', 'as_img', 'vid', null, 'reference_images'),
        edge('e2', 'as_aud', 'aud', 'image', 'ref_audio'),
      ],
    });
    const { canvas, report } = migrateCanvas(raw);
    expect(byId(canvas.nodes, 'as_img')).toMatchObject({
      type: 'load-image',
      data: { image: '/storage/assets/a.png', url: '/storage/assets/a.png', image_url: '/storage/assets/a.png', file_url: '/storage/assets/a.png', thumb_url: '/storage/assets/a_t.png', category: 'character', tags: ['x'] },
    });
    expect(byId(canvas.nodes, 'as_vid')).toMatchObject({ type: 'load-video', data: { video: '/storage/v.mp4', url: '/storage/v.mp4', video_url: '/storage/v.mp4' } });
    expect(byId(canvas.nodes, 'as_aud')).toMatchObject({ type: 'load-audio', data: { audio: '/storage/a.wav', audio_url: '/storage/a.wav' } });
    expect(byId(canvas.nodes, 'as_unk').type).toBe('load-image');
    expect(report.warnings.some((w) => w.includes('as_unk'))).toBe(true);
    expect(edgeById(canvas.edges, 'e1')).toMatchObject({ sourceHandle: 'image', targetHandle: 'in' });
    expect(edgeById(canvas.edges, 'e2')).toMatchObject({ sourceHandle: 'audio', targetHandle: 'in' });
    expect(byId(canvas.nodes, 'aud').data.refRoles).toEqual({ 'as_aud|audio': 'ref_audio' });
    expect(report.converted).toMatchObject({ 'asset->load-image': 2, 'asset->load-video': 1, 'asset->load-audio': 1 });
  });

  it('load-image-batch → N 个 load-image：横排、id 确定、出边逐个复制、原数组不丢', () => {
    const urls = ['/a.png', '/b.png', '/c.png'];
    const raw = deepFreeze({
      nodes: [
        node('batch', 'load-image-batch', { images: urls, image_list: urls, name: '角色组' }, { measured: { width: 300, height: 280 }, selected: true }),
        node('vid', 'video', { reference_images: urls }),
      ],
      edges: [edge('eb', 'batch', 'vid', 'images', 'reference_images')],
    });
    const { canvas, report } = migrateCanvas(raw);
    const ids = ['batch', 'batch__1', 'batch__2'];
    ids.forEach((id, i) => {
      const n = byId(canvas.nodes, id);
      expect(n.type).toBe('load-image');
      expect(n.position).toEqual({ x: 100 + i * BATCH_SPLIT_SPACING, y: 200 });
      expect(n.data).toMatchObject({ image: urls[i], url: urls[i], image_url: urls[i], name: '角色组', _migrated_from: 'load-image-batch' });
      expect(n.data._batch).toMatchObject({ from: 'batch', index: i, total: 3 });
      expect(n.measured).toBeUndefined();
      expect(n.data.images).toBeUndefined();
    });
    expect(BATCH_SPLIT_SPACING).toBe(260 + 40);
    // 原数组完整保留在首个节点
    expect(byId(canvas.nodes, 'batch').data._batch.legacy).toEqual({ images: urls, image_list: urls });
    expect(report.createdNodes).toEqual(['batch__1', 'batch__2']);
    // 出边复制到每张卡，并改连到 in，参考顺序 = 原批量顺序
    const outs = canvas.edges.filter((e) => e.target === 'vid');
    expect(outs.map((e) => [e.id, e.source, e.sourceHandle, e.targetHandle])).toEqual([
      ['eb', 'batch', 'image', 'in'],
      ['eb__1', 'batch__1', 'image', 'in'],
      ['eb__2', 'batch__2', 'image', 'in'],
    ]);
    const vd = byId(canvas.nodes, 'vid').data;
    expect(vd.refOrder).toEqual(['batch|image', 'batch__1|image', 'batch__2|image']);
    expect(Object.values(vd.refRoles)).toEqual(['reference_images', 'reference_images', 'reference_images']);
    expect(report.converted['load-image-batch->load-image']).toBe(1);
  });

  it('空的 load-image-batch 迁成一个保留原 id 的空 load-image', () => {
    const { canvas } = migrateCanvas({ nodes: [node('b0', 'load-image-batch', {})], edges: [] });
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0]).toMatchObject({ id: 'b0', type: 'load-image', data: { _batch: { from: 'b0', index: 0, total: 0, legacy: {} } } });
  });

  it('brief / timeline-export / 独有节点类型不变', () => {
    const types = ['brief', 'timeline-export', 'shot-card', 'comfy-workflow', 'script-split', 'custom', 'ext-node', 'provider', 'provider-image', 'timeline', 'export', 'group'];
    const raw = deepFreeze({ nodes: types.map((t, i) => node(`n${i}`, t, { k: i })), edges: [] });
    const { canvas, report, changed } = migrateCanvas(raw);
    expect(changed).toBe(false);
    expect(canvas.nodes).toEqual(raw.nodes);
    expect(report.unknownTypes).toEqual([]);
  });
});

describe('具名口改连 in + refRoles/refOrder', () => {
  const build = () =>
    deepFreeze({
      nodes: [
        node('p', 'prompt', { prompt: 'x' }),
        node('cam', 'director3d', {}),
        node('i1', 'image', { image_url: '/1.png' }),
        node('i2', 'image', { image_url: '/2.png' }),
        node('r1', 'load-image', { image_url: '/r1.png' }),
        node('r2', 'load-image', { image_url: '/r2.png' }),
        node('au', 'load-audio', { audio_url: '/a.wav' }),
        // 参考集旧数组顺序：r2 在前
        node('v', 'video', { reference_images: ['/r2.png', '/r1.png'], first_frame: '/1.png' }),
      ],
      // 连线顺序故意打乱
      edges: [
        edge('e_r1', 'r1', 'v', undefined, 'reference_images'),
        edge('e_au', 'au', 'v', 'audio', 'ref_audio'),
        edge('e_last', 'i2', 'v', 'image', 'last_frame'),
        edge('e_r2', 'r2', 'v', 'image', 'reference_images'),
        edge('e_p', 'p', 'v', 'prompt', 'prompt'),
        edge('e_first', 'i1', 'v', 'image', 'first_frame'),
        edge('e_cam', 'cam', 'v', 'camera_prompt', 'camera_prompt'),
      ],
    });

  it('全部改连 in，槽位写进 refRoles，refOrder 按槽位优先级、参考集按旧数组顺序', () => {
    const { canvas, report } = migrateCanvas(build());
    expect(canvas.edges.every((e) => e.targetHandle === 'in')).toBe(true);
    expect(report.rewiredEdges).toBe(7);
    const d = byId(canvas.nodes, 'v').data;
    expect(d.refRoles).toEqual({
      'p|prompt': 'prompt',
      'cam|camera_prompt': 'camera_prompt',
      'i1|image': 'first_frame',
      'i2|image': 'last_frame',
      'r1|image': 'reference_images',
      'r2|image': 'reference_images',
      'au|audio': 'ref_audio',
    });
    expect(d.refOrder).toEqual(['p|prompt', 'cam|camera_prompt', 'i1|image', 'i2|image', 'r2|image', 'r1|image', 'au|audio']);
    // 缺失的源口补成源节点的输出口，edgeKey 与新连线一致
    expect(edgeById(canvas.edges, 'e_r1').sourceHandle).toBe('image');
    // 旧的槽位数据仍在
    expect(d.reference_images).toEqual(['/r2.png', '/r1.png']);
    expect(d.first_frame).toBe('/1.png');
    // 连线数组顺序不变
    expect(canvas.edges.map((e) => e.id)).toEqual(build().edges.map((e) => e.id));
  });

  it('image 的 reference 口、audio 的 text 口、prompt/director3d 的 prompt 口、空句柄都改连 in', () => {
    const raw = deepFreeze({
      nodes: [
        node('p', 'prompt', { prompt: 'x' }),
        node('p2', 'prompt'),
        node('d3', 'director3d'),
        node('src', 'image', { image_url: '/s.png' }),
        node('img', 'image'),
        node('aud', 'audio'),
        node('vid', 'video'),
      ],
      edges: [
        edge('a', 'src', 'img', 'image', 'reference'),
        edge('b', 'p', 'aud', 'prompt', 'text'),
        edge('c', 'p', 'p2', 'prompt', 'prompt'),
        edge('d', 'p', 'd3', 'prompt', 'prompt'),
        edge('e', 'src', 'vid', 'image', null),
      ],
    });
    const { canvas } = migrateCanvas(raw);
    expect(canvas.edges.map((e) => e.targetHandle)).toEqual(['in', 'in', 'in', 'in', 'in']);
    expect(byId(canvas.nodes, 'img').data.refRoles).toEqual({ 'src|image': 'reference_images' });
    expect(byId(canvas.nodes, 'aud').data.refRoles).toEqual({ 'p|prompt': 'prompt' });
    expect(byId(canvas.nodes, 'p2').data.refRoles).toEqual({ 'p|prompt': 'prompt' });
    expect(byId(canvas.nodes, 'd3').data.refRoles).toEqual({ 'p|prompt': 'prompt' });
    // 空句柄：不指定槽位（按模式自动分配），但进 refOrder
    expect(byId(canvas.nodes, 'vid').data.refRoles).toBeUndefined();
    expect(byId(canvas.nodes, 'vid').data.refOrder).toEqual(['src|image']);
  });

  it('同一输出口连了两个旧槽位：改连后合并为一条，保留优先级高的槽位', () => {
    const raw = deepFreeze({
      nodes: [node('i', 'image', { image_url: '/i.png' }), node('v', 'video')],
      edges: [edge('e_ref', 'i', 'v', 'image', 'reference_images'), edge('e_first', 'i', 'v', 'image', 'first_frame')],
    });
    const { canvas, report } = migrateCanvas(raw);
    expect(canvas.edges.map((e) => e.id)).toEqual(['e_first']);
    expect(report.droppedEdges).toEqual(['e_ref']);
    expect(report.rewiredEdges).toBe(1);
    expect(byId(canvas.nodes, 'v').data.refRoles).toEqual({ 'i|image': 'first_frame' });
    expect(report.warnings.some((w) => w.includes('e_ref'))).toBe(true);
  });

  it('表外旧口名原样记为槽位并告警', () => {
    const raw = { nodes: [node('i', 'load-image', { image_url: '/x.png' }), node('v', 'video')], edges: [edge('e', 'i', 'v', 'image', 'subject_reference')] };
    const { canvas, report } = migrateCanvas(raw);
    expect(edgeById(canvas.edges, 'e').targetHandle).toBe('in');
    expect(byId(canvas.nodes, 'v').data.refRoles).toEqual({ 'i|image': 'subject_reference' });
    expect(report.warnings.some((w) => w.includes('subject_reference'))).toBe(true);
  });

  it('已有 in 连线 / refOrder / refRoles 时只追加不覆盖', () => {
    const raw = {
      nodes: [
        node('a', 'load-image', { image_url: '/a.png' }),
        node('b', 'load-image', { image_url: '/b.png' }),
        node('c', 'load-image', { image_url: '/c.png' }),
        node('v', 'video', { refOrder: ['b|image'], refRoles: { 'b|image': 'last_frame' } }),
      ],
      edges: [edge('ea', 'a', 'v', 'image', 'in'), edge('eb', 'b', 'v', 'image', 'in'), edge('ec', 'c', 'v', 'image', 'first_frame')],
    };
    const { canvas } = migrateCanvas(raw);
    const d = byId(canvas.nodes, 'v').data;
    expect(d.refOrder).toEqual(['b|image', 'a|image', 'c|image']);
    expect(d.refRoles).toEqual({ 'b|image': 'last_frame', 'c|image': 'first_frame' });
  });

  it('不改非单输入口节点的连线（export/timeline/shot-card/custom 的具名口保持原样）', () => {
    const raw = deepFreeze({
      nodes: [
        node('v', 'video', { video_url: '/v.mp4' }),
        node('i', 'image', { image_url: '/i.png' }),
        node('ex', 'export'),
        node('sc', 'shot-card'),
        node('cu', 'custom'),
        node('pi', 'provider-image'),
      ],
      edges: [
        edge('e1', 'v', 'ex', 'video', 'video'),
        edge('e2', 'i', 'sc', 'image', 'reference'),
        edge('e3', 'i', 'cu', 'image', 'first_frame'),
        edge('e4', 'pi', 'sc', 'provider', 'provider'),
      ],
    });
    const { canvas, report } = migrateCanvas(raw);
    expect(canvas.edges).toEqual(raw.edges);
    expect(report.rewiredEdges).toBe(0);
  });

  it('老 3D 导演输出口 camera → camera_prompt', () => {
    const raw = { nodes: [node('d', 'director3d'), node('v', 'video')], edges: [edge('e', 'd', 'v', 'camera', 'camera_prompt')] };
    const { canvas } = migrateCanvas(raw);
    expect(edgeById(canvas.edges, 'e')).toMatchObject({ sourceHandle: 'camera_prompt', targetHandle: 'in' });
    expect(byId(canvas.nodes, 'v').data.refRoles).toEqual({ 'd|camera_prompt': 'camera_prompt' });
  });
});

describe('history', () => {
  it('生成节点用现有产出起第一条历史；已有 history 或无产出则不动', () => {
    const raw = deepFreeze({
      nodes: [
        node('img', 'image', { image_url: '/i.png', provider_id: 'p1', agent_state: { status: 'completed', updated_at: '2026-09-30T09:46:27Z' } }),
        node('img2', 'image', { result_url: '/r.png' }),
        node('vid', 'video', { video_url: '/v.mp4', provider: 'kling' }),
        node('aud', 'audio', { result_url: '/a.mp3' }),
        node('has', 'image', { image_url: '/new.png', history: [{ url: '/old.png' }] }),
        node('none', 'video', { prompt: 'x' }),
        node('li', 'load-image', { image_url: '/l.png' }),
      ],
      edges: [],
    });
    const { canvas } = migrateCanvas(raw);
    expect(byId(canvas.nodes, 'img').data.history).toEqual([{ url: '/i.png', created_at: '2026-09-30T09:46:27Z', provider_id: 'p1' }]);
    expect(byId(canvas.nodes, 'img2').data.history).toEqual([{ url: '/r.png' }]);
    expect(byId(canvas.nodes, 'vid').data.history).toEqual([{ url: '/v.mp4', provider_id: 'kling' }]);
    expect(byId(canvas.nodes, 'aud').data.history).toEqual([{ url: '/a.mp3' }]);
    expect(byId(canvas.nodes, 'has').data.history).toEqual([{ url: '/old.png' }]);
    expect(byId(canvas.nodes, 'none').data.history).toBeUndefined();
    expect(byId(canvas.nodes, 'li').data.history).toBeUndefined();
  });
});

describe('未知类型与异常输入', () => {
  it('未知类型原样保留、列进 unknownTypes，连到它的线不动', () => {
    const weird = node('w', 'my-plugin-node', { foo: { deep: [1, 2] }, prompt: 'keep' });
    const raw = deepFreeze({
      nodes: [weird, node('p', 'prompt', { prompt: 'x' }), node('untyped', undefined, { a: 1 })],
      edges: [edge('e', 'p', 'w', 'prompt', 'prompt')],
    });
    const { canvas, report } = migrateCanvas(raw);
    expect(byId(canvas.nodes, 'w')).toBe(raw.nodes[0]);
    expect(byId(canvas.nodes, 'untyped')).toBe(raw.nodes[2]);
    expect(report.unknownTypes).toEqual(['my-plugin-node', 'default']);
    expect(edgeById(canvas.edges, 'e')).toEqual(raw.edges[0]);
  });

  it('空输入 / 缺 nodes edges / 悬空连线都不抛错', () => {
    expect(migrateCanvas(null).canvas).toMatchObject({ nodes: [], edges: [], schema_version: 2 });
    expect(migrateCanvas({} as RawCanvas).changed).toBe(false);
    const { canvas, report } = migrateCanvas({ nodes: [node('v', 'video')], edges: [edge('e', 'ghost', 'v', 'image', 'first_frame')] });
    expect(edgeById(canvas.edges, 'e').targetHandle).toBe('first_frame');
    expect(report.warnings.some((w) => w.includes('e'))).toBe(true);
  });

  it('保留画布其余字段（viewport/name 等），不修改入参', () => {
    const raw = deepFreeze({
      name: '默认画布',
      viewport: { x: 1, y: 2, zoom: 0.5 },
      updated_at: '2026-10-10',
      nodes: [node('t', 'tts', { text: 'hi' }), node('i', 'image', { image_url: '/i.png' })],
      edges: [edge('e', 'i', 't', 'image', 'reference_audio')],
    });
    const before = JSON.stringify(raw);
    const { canvas } = migrateCanvas(raw); // 冻结的入参被改会直接抛错
    expect(JSON.stringify(raw)).toBe(before);
    expect(canvas).toMatchObject({ name: '默认画布', viewport: { x: 1, y: 2, zoom: 0.5 }, updated_at: '2026-10-10', schema_version: CANVAS_SCHEMA_VERSION });
  });
});

describe('幂等', () => {
  const legacy = (): RawCanvas => ({
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      node('t', 'text-prompt', { text: 'hello' }),
      node('b', 'load-image-batch', { images: ['/a.png', '/b.png'] }),
      node('as', 'asset', { file_url: '/x.mp4' }),
      node('tts', 'tts', { text: 'line', audio_url: '/o.mp3' }),
      node('vl', 'video-legacy', { video_prompt: 'go', video_url: '/v.mp4' }),
      node('v', 'video', { video_url: '/v2.mp4' }),
      node('d', 'director3d'),
      node('u', 'mystery'),
    ],
    edges: [
      edge('e1', 't', 'v', 'text', 'prompt'),
      edge('e2', 'b', 'v', 'images', 'reference_images'),
      edge('e3', 'd', 'v', 'camera', 'camera_prompt'),
      edge('e4', 't', 'tts', 'prompt', 'text'),
      edge('e5', 'b', 'vl', 'images', 'image'),
      edge('e6', 'as', 'u', null, 'in'),
    ],
  });

  it('schema_version >= 2 原样返回，changed=false', () => {
    const migrated = { ...legacy(), schema_version: 2 };
    const r = migrateCanvas(migrated);
    expect(r.changed).toBe(false);
    expect(r.canvas).toBe(migrated);
    expect(r.report.rewiredEdges).toBe(0);
  });

  it('跑两次 = 跑一次', () => {
    const once = migrateCanvas(legacy());
    expect(once.changed).toBe(true);
    expect(once.canvas.schema_version).toBe(2);
    const twice = migrateCanvas(once.canvas);
    expect(twice.changed).toBe(false);
    expect(twice.canvas).toEqual(once.canvas);
  });

  it('schema_version 丢失（后端存盘未保留）时再跑一次也不再改动', () => {
    const once = migrateCanvas(legacy()).canvas;
    const { schema_version: _drop, ...stripped } = once;
    const again = migrateCanvas(JSON.parse(JSON.stringify(stripped)));
    expect(again.changed).toBe(false);
    expect(again.canvas).toEqual(JSON.parse(JSON.stringify(once)));
  });

  it('没有需要迁移内容的画布 changed=false，但补上 schema_version', () => {
    const r = migrateCanvas({ nodes: [node('li', 'load-image', { image_url: '/a.png' }), node('ex', 'export')], edges: [edge('e', 'li', 'ex', 'image', 'video')] });
    expect(r.changed).toBe(false);
    expect(r.canvas.schema_version).toBe(2);
  });
});

describe('真实画布（storage/projects 抽样）', () => {
  const fixture = JSON.parse(realCanvasesRaw) as { canvases: Record<string, RawCanvas> };
  const names = Object.keys(fixture.canvases);

  it('样本覆盖存量画布里出现过的所有连线形态', () => {
    const pairs = new Set<string>();
    for (const c of Object.values(fixture.canvases)) {
      const t = new Map(c.nodes!.map((n) => [n.id, n.type]));
      for (const e of c.edges!) pairs.add(`${t.get(e.source)}.${e.sourceHandle ?? ''}->${t.get(e.target)}.${e.targetHandle ?? ''}`);
    }
    expect([...pairs].sort()).toEqual([
      'director3d.camera_prompt->video.camera_prompt',
      'image.image->video.first_frame',
      'load-image.->video.reference_images',
      'load-image.image->image.reference_images',
      'prompt.prompt->image.prompt',
      'prompt.prompt->video.prompt',
    ]);
  });

  it.each(names)('%s：迁移后节点、原有 data 键与值、连线全部保留', (name) => {
    const raw = deepFreeze(JSON.parse(JSON.stringify(fixture.canvases[name])) as RawCanvas);
    const { canvas, changed, report } = migrateCanvas(raw);
    expect(changed).toBe(true);
    expect(report.unknownTypes).toEqual([]);
    expect(report.droppedEdges).toEqual([]);
    // 节点：id、类型、位置不变；原有 data 键全部还在且值不变（只追加）
    expect(canvas.nodes.map((n) => n.id)).toEqual(raw.nodes!.map((n) => n.id));
    for (const old of raw.nodes!) {
      const now = byId(canvas.nodes, old.id);
      expect(now.type).toBe(old.type);
      expect(now.position).toEqual(old.position);
      for (const [k, v] of Object.entries(old.data || {})) expect(now.data[k]).toEqual(v);
    }
    // 连线：条数与端点不变；生成节点的入边全部改连 in，旧口名能从 refRoles 还原
    expect(canvas.edges.map((e) => [e.id, e.source, e.target])).toEqual(raw.edges!.map((e) => [e.id, e.source, e.target]));
    for (const old of raw.edges!) {
      const now = edgeById(canvas.edges, old.id);
      expect(now.targetHandle).toBe('in');
      const tgt = byId(canvas.nodes, old.target);
      expect(tgt.data.refRoles[edgeKey(now)]).toBe(LEGACY_SLOT_MAP[old.targetHandle!]);
      expect(tgt.data.refOrder).toContain(edgeKey(now));
    }
    expect(report.rewiredEdges).toBe(raw.edges!.length);
    expect(migrateCanvas(canvas).changed).toBe(false);
  });

  it('proj_7e528eff/default：已生成的图片 / 视频起了历史，视频参考顺序 = 提示词、首帧', () => {
    const { canvas } = migrateCanvas(fixture.canvases['proj_7e528eff/default']);
    const img = byId(canvas.nodes, 'image_1790761554739_2').data;
    expect(img.history).toEqual([
      { url: '/storage/generated/gen_1790761587_b583dd70.png', created_at: '2026-09-30T09:46:27.809872Z', provider_id: 'comfyui_wf_b6dd2cda' },
    ]);
    const vid = byId(canvas.nodes, 'video_1790761554739_4').data;
    expect(vid.history).toEqual([{ url: '/storage/videos/vid_1790761824_be0b3b18.mp4', created_at: '2026-09-30T09:50:27.594002Z', provider_id: 'prov_ecf35ae4' }]);
    expect(vid.refOrder).toEqual(['prompt_1790761554739_3|prompt', 'image_1790761554739_2|image']);
    expect(vid.refRoles).toEqual({ 'prompt_1790761554739_3|prompt': 'prompt', 'image_1790761554739_2|image': 'first_frame' });
  });

  it('proj_48f29f6e/default：缺 sourceHandle 的参考图连线补成 image，三张参考按原顺序', () => {
    const { canvas } = migrateCanvas(fixture.canvases['proj_48f29f6e/default']);
    expect(canvas.edges.every((e) => e.sourceHandle === 'image' && e.targetHandle === 'in')).toBe(true);
    expect(byId(canvas.nodes, 'video_11605_417').data.refOrder).toEqual([
      'load-image_11599_978|image',
      'load-image_11602_587|image',
      'load-image_11603_933|image',
    ]);
  });
});
