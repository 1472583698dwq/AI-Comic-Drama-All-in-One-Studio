// REQ-toonflow-canvas N5 · 3D 导演节点数据模型：运镜提示词推导、旧数据兼容、关键帧编辑、跳转载荷、导出落点、舞台预算
import { afterEach, describe, expect, it } from 'vitest';
import { buildMinimaxCameraPrompt, FRAMING_PRESETS } from '../../../../director3d/scene/presets';
import {
  DEFAULTS, appendKeyframe, buildNavigatePayload, describeParamChanges, cameraPromptPatch, createDirector3DData, deriveCameraPrompt, findFreeSlot,
  findShotId, focalOptions, framingPatch, isValidCamera, keyframesDuration, motionKeyframeSamples, moveKeyframe, nextKeyframeEasing,
  posePatch, presetToKeyframes, readKeyframes, readStageParams, removeKeyframe, replaceKeyframeCamera, retimeKeyframe, roundCamera,
  scaleKeyframesDuration, setKeyframeEasing, stageBoxAspect, withCurrent, type Director3DKeyframe, type StageCameraState,
} from '../model';
import { HARD_MAX_LIVE_STAGES, MAX_LIVE_STAGES, acquireStageSlot, liveStageCount, resetStageSlots, touchStageSlot } from '../stageBudget';
import { stagePixelRatio, MAX_STAGE_PIXELS } from '../useDirectorStage';

const cam = (z: number, fov = 45): StageCameraState => ({ position: [0, 1.3, z], target: [0, 1.25, 0], fov, roll: 0 });
const kf = (id: string, time: number, z = 2): Director3DKeyframe => ({ id, time, camera: cam(z), easing: 'smooth' });

describe('camera_prompt 推导（与 3D 片场 LIVE PROMPT 同一函数）', () => {
  it('缺省参数 = 旧节点缺省（中景 / 推镜 / 35mm）', () => {
    expect(deriveCameraPrompt({})).toBe('[Camera: Motion: Dolly In, Framing: 中景 (MS), Lens: 35mm]');
    expect(deriveCameraPrompt(createDirector3DData())).toBe(deriveCameraPrompt({}));
  });

  it('景别 / 运镜 / 焦距 / 荷兰角 / 速度 / 站位全部进提示词，且与 buildMinimaxCameraPrompt 逐字一致', () => {
    const data = { framing: 'close_up', motion: 'orbit', focal_length_mm: 50, camera_roll_deg: -12, speed: '1.5x', cast_layout: 'duel' };
    const want = buildMinimaxCameraPrompt({ framing: 'close_up', motion: 'orbit', focalLength: 50, cameraRoll: -12, motionSpeed: '1.5x', castLayout: 'duel' });
    expect(deriveCameraPrompt(data)).toBe(want);
    expect(want).toBe('[Camera: Motion: Orbit Clockwise, Framing: 特写 (CU), Lens: 50mm, Dutch Roll: -12.0°, Speed: 1.5x, Cast Staging: DUEL]');
  });

  it('旧数据容错：字符串数字、越界值、未知速度回落缺省', () => {
    const p = readStageParams({ focal_length_mm: '85', camera_roll_deg: 500, speed: '3x', motion_easing: 'bogus', environment: 'mars', aspect_ratio: 'abc' });
    expect(p.focalLength).toBe(85);
    expect(p.roll).toBe(0);
    expect(p.speed).toBe('1.0x');
    expect(p.easing).toBe(DEFAULTS.easing);
    expect(p.environment).toBe('plain');
    expect(p.aspectRatio).toBe('16:9');
    expect(p.aspect).toBeCloseTo(16 / 9, 9);
    expect(readStageParams({ aspect_ratio: '9:16' }).aspect).toBeCloseTo(9 / 16, 9);
  });

  it('插件导演包的自定义景别 / 运镜 id 原样保留（同源数组可被追加）', () => {
    const p = readStageParams({ framing: 'pack_wide_dutch', motion: 'pack_whip' });
    expect(p.framing).toBe('pack_wide_dutch');
    expect(deriveCameraPrompt(p)).toBe('[Camera: Motion: pack_whip, Framing: pack_wide_dutch, Lens: 35mm]');
  });

  it('cameraPromptPatch：两个键与参数一致时不写；任一不一致（含 MCP 英文版 minimax_camera_prompt）则两键都写成本地版', () => {
    const d = createDirector3DData();
    expect(cameraPromptPatch(d)).toBeNull();
    const legacy = { framing: 'close_up', motion: 'orbit', focal_length_mm: 50, minimax_camera_prompt: '[Camera: Motion: Orbit Clockwise 180°, Cinematic arc shot, Framing: Close Up, Lens: 50mm]' };
    const patch = cameraPromptPatch(legacy);
    expect(patch).toEqual({ camera_prompt: deriveCameraPrompt(legacy), minimax_camera_prompt: deriveCameraPrompt(legacy) });
    expect(Object.keys(patch!)).toEqual(['camera_prompt', 'minimax_camera_prompt']);
  });

  it('选景别同时带推荐焦距（3D 片场同款）；选姿态清掉自定义关节', () => {
    const cu = FRAMING_PRESETS.find((f) => f.id === 'close_up')!;
    expect(framingPatch('close_up')).toEqual({ framing: 'close_up', focal_length_mm: cu.fl });
    expect(framingPatch('unknown_pack')).toEqual({ framing: 'unknown_pack' });
    const pp = posePatch('fight');
    expect(pp).toEqual({ pose: 'fight', mannequin_pose: undefined });
    expect('mannequin_pose' in pp).toBe(true);
  });

  it('焦距下拉含当前值；选项缺当前值时补一项', () => {
    expect(focalOptions(28)).toEqual([16, 24, 28, 35, 50, 85, 135]);
    expect(focalOptions(35)).toEqual([16, 24, 35, 50, 85, 135]);
    expect(withCurrent([{ id: 'a', label: 'A' }], 'zz').map((o) => o.id)).toEqual(['a', 'zz']);
  });

  it('AI 规划前后参数差异摘要', () => {
    const a = readStageParams({ framing: 'close_up', focal_length_mm: 50, cast_layout: 'solo' });
    const b = readStageParams({ framing: 'low_angle', focal_length_mm: 28, cast_layout: 'duel' });
    expect(describeParamChanges(a, b)).toBe('景别 特写 (CU) → 贴地仰角，站位 单人焦点 → 双人对峙，焦距 50 → 28mm');
    expect(describeParamChanges(a, a)).toBe('');
  });

  it('舞台外框：横画幅照原比例，竖 / 方画幅限高', () => {
    expect(stageBoxAspect(16 / 9)).toBeCloseTo(16 / 9, 9);
    expect(stageBoxAspect(9 / 16)).toBe(1.25);
    expect(stageBoxAspect(1)).toBe(1.25);
  });
});

describe('持久化形状', () => {
  it('默认 data 带全部舞台键 + 已算好的输出，JSON 往返后读出的参数不变', () => {
    const d = createDirector3DData();
    expect(d).toMatchObject({
      framing: 'medium', motion: 'push_in', pose: 'stand', cast_layout: 'solo', focal_length_mm: 35, camera_roll_deg: 0,
      speed: '1.0x', environment: 'plain', aspect_ratio: '16:9', motion_easing: 'ease_in_out', keyframes: [], ai_directive: '',
    });
    expect(d.camera_prompt).toBe(d.minimax_camera_prompt);
    const full = {
      ...d,
      framing: 'low_angle', cast_layout: 'duel', pose: 'fight',
      mannequin_pose: { v: 1, entities: { entity_protagonist: { joints: { elbow_L: [-1.2, 0.1, 0] as [number, number, number] } } } },
      camera_state: roundCamera({ position: [0.123456789, 1, 2], target: [0, 1.25, 0], fov: 37.84931, roll: 0 }),
      keyframes: [kf('a', 0), kf('b', 1.5, 1.2)],
    };
    const back = JSON.parse(JSON.stringify(full));
    expect(readStageParams(back)).toEqual(readStageParams(full));
    expect(readKeyframes(back.keyframes)).toEqual(full.keyframes);
    expect(back.mannequin_pose).toEqual(full.mannequin_pose);
    expect(back.camera_state).toEqual({ position: [0.1235, 1, 2], target: [0, 1.25, 0], fov: 37.8493, roll: 0 });
    expect(isValidCamera(back.camera_state)).toBe(true);
  });

  it('readKeyframes：丢坏帧、排序、补 id / easing', () => {
    const raw = [
      { time: 2, camera: cam(1) },
      { id: 'x', time: 0, camera: cam(2), easing: 'cut' },
      { time: 1, camera: { position: [0, 1], target: [0, 0, 0], fov: 40 } },
      { time: -1, camera: cam(3) },
      null,
      { id: 'y', time: '1.5', camera: cam(1.5), easing: 'weird' },
    ];
    const out = readKeyframes(raw);
    expect(out.map((k) => [k.id, k.time, k.easing])).toEqual([['x', 0, 'cut'], ['y', 1.5, 'smooth'], ['kf_0', 2, 'smooth']]);
    expect(readKeyframes(raw)).toEqual(out); // 缺 id 时 id 稳定
    expect(readKeyframes('nope')).toEqual([]);
  });
});

describe('关键帧编辑', () => {
  it('追加：首帧 0，之后每帧 +1s，机位取 4 位小数', () => {
    let list = appendKeyframe([], { ...cam(2.123456), fov: 45.123456 }, { id: 'a' });
    expect(list).toEqual([{ id: 'a', time: 0, camera: { position: [0, 1.3, 2.1235], target: [0, 1.25, 0], fov: 45.1235, roll: 0 }, easing: 'smooth' }]);
    list = appendKeyframe(list, cam(1), { id: 'b' });
    list = appendKeyframe(list, cam(0.5), { id: 'c', gap: 0.5 });
    expect(list.map((k) => k.time)).toEqual([0, 1, 1.5]);
    expect(keyframesDuration(list)).toBe(1.5);
  });

  it('删除：删首帧时整体前移，时间轴始终从 0 开始', () => {
    const list = [kf('a', 0), kf('b', 1), kf('c', 2.5)];
    expect(removeKeyframe(list, 'b').map((k) => [k.id, k.time])).toEqual([['a', 0], ['c', 2.5]]);
    expect(removeKeyframe(list, 'a').map((k) => [k.id, k.time])).toEqual([['b', 0], ['c', 1.5]]);
  });

  it('排序：机位跟着走，时间留在原位（保持递增）', () => {
    const list = [kf('a', 0, 3), kf('b', 1, 2), kf('c', 2, 1)];
    const moved = moveKeyframe(list, 2, 0);
    expect(moved.map((k) => [k.id, k.time, k.camera.position[2]])).toEqual([['c', 0, 1], ['a', 1, 3], ['b', 2, 2]]);
    expect(moveKeyframe(list, 0, 5)).toEqual(list);
  });

  it('改时间：夹在相邻帧之间', () => {
    const list = [kf('a', 0), kf('b', 1), kf('c', 2)];
    expect(retimeKeyframe(list, 'b', 5).map((k) => k.time)).toEqual([0, 1.95, 2]);
    expect(retimeKeyframe(list, 'b', -3).map((k) => k.time)).toEqual([0, 0.05, 2]);
    expect(retimeKeyframe(list, 'c', 9.5).map((k) => k.time)).toEqual([0, 1, 9.5]);
    expect(retimeKeyframe(list, 'a', 0.5).map((k) => k.time)).toEqual([0.5, 1, 2]);
  });

  it('总时长：按比例缩放，相邻帧至少隔 0.05s', () => {
    const list = [kf('a', 0), kf('b', 1), kf('c', 2)];
    expect(scaleKeyframesDuration(list, 4).map((k) => k.time)).toEqual([0, 2, 4]);
    expect(scaleKeyframesDuration(list, 0).map((k) => k.time)).toEqual([0, 0.05, 0.1]);
    expect(scaleKeyframesDuration([kf('a', 0)], 4).map((k) => k.time)).toEqual([0]);
  });

  it('缓动循环 平滑 → 线性 → 硬切 → 平滑；覆盖机位', () => {
    expect(nextKeyframeEasing('smooth')).toBe('linear');
    expect(nextKeyframeEasing('linear')).toBe('cut');
    expect(nextKeyframeEasing('cut')).toBe('smooth');
    expect(nextKeyframeEasing(undefined)).toBe('linear');
    const list = [kf('a', 0), kf('b', 1)];
    expect(setKeyframeEasing(list, 'b', 'cut')[1].easing).toBe('cut');
    expect(replaceKeyframeCamera(list, 'a', cam(9.87654321)).at(0)!.camera.position[2]).toBe(9.8765);
  });

  it('由运镜生成：采样段数按运镜类型；两帧时缓入缓出落成「平滑」', () => {
    expect(motionKeyframeSamples('push_in', 'ease_in_out')).toBe(1);
    expect(motionKeyframeSamples('push_in', 'explosive')).toBe(6);
    expect(motionKeyframeSamples('orbit', 'linear')).toBe(8);
    expect(motionKeyframeSamples('shake', 'ease_in_out')).toBe(16);
    const two = presetToKeyframes([{ time: 0, camera: cam(2), easing: 'linear' }, { time: 2.5, camera: cam(1), easing: 'linear' }], 'ease_in_out');
    expect(two.map((k) => [k.time, k.easing])).toEqual([[0, 'linear'], [2.5, 'smooth']]);
    expect(new Set(two.map((k) => k.id)).size).toBe(2);
    const lin = presetToKeyframes([{ time: 0, camera: cam(2) }, { time: 2.5, camera: cam(1) }], 'linear');
    expect(lin[1].easing).toBe('linear');
  });
});

describe('在 3D 片场打开 / 导出落点', () => {
  it('shotId：自身优先，否则取下游第一个带 shotId 的节点', () => {
    const nodes: Record<string, { id: string; data: Record<string, unknown> }> = {
      v1: { id: 'v1', data: {} },
      v2: { id: 'v2', data: { shotId: 'shot_9' } },
    };
    const edges = [{ source: 'd3', target: 'v1' }, { source: 'd3', target: 'v2' }, { source: 'x', target: 'd3' }];
    expect(findShotId('d3', {}, edges, (id) => nodes[id])).toBe('shot_9');
    expect(findShotId('d3', { shotId: 'own' }, edges, (id) => nodes[id])).toBe('own');
    expect(findShotId('d3', {}, [], (id) => nodes[id])).toBeUndefined();
  });

  it('跳转载荷：分镜同名字段 + 节点舞台状态', () => {
    const data = {
      ...createDirector3DData(), framing: 'close_up', motion: 'orbit', pose: 'fight', cast_layout: 'duel', focal_length_mm: 50, speed: '1.5x',
      mannequin_pose: { v: 1, entities: { entity_protagonist: { joints: { knee_R: [0.5, 0, 0] as [number, number, number] } } } },
      camera_state: cam(1.4), keyframes: [kf('a', 0), kf('b', 2)],
    };
    const p = buildNavigatePayload('d3', data, 'shot_1');
    expect(p).toMatchObject({
      source: 'canvas-director3d', nodeId: 'd3', shotId: 'shot_1',
      shotPatch: { camera_framing: 'close_up', camera_motion: 'orbit', pose_preset: 'fight', cast_layout: 'duel', focal_length_mm: 50, camera_roll_deg: 0, motion_speed: '1.5x', mannequin_pose: data.mannequin_pose },
      stage: { framing: 'close_up', camera_state: cam(1.4), camera_prompt: deriveCameraPrompt(data) },
    });
    expect(p.stage.keyframes).toHaveLength(2);
    expect('shotId' in buildNavigatePayload('d3', createDirector3DData())).toBe(false);
  });

  it('导出新节点落点：锚点右侧 80px，往下避开同层节点', () => {
    const anchor = { id: 'd3', position: { x: 0, y: 0 }, measured: { width: 320, height: 600 } };
    const size = { w: 280, h: 300 };
    expect(findFreeSlot([anchor], anchor, size)).toEqual({ x: 400, y: 0 });
    const blocker = { id: 'img1', position: { x: 400, y: 0 }, measured: { width: 260, height: 200 } };
    const other = { id: 'img2', position: { x: 400, y: 224 }, measured: { width: 260, height: 200 } };
    expect(findFreeSlot([anchor, other, blocker], anchor, size)).toEqual({ x: 400, y: 448 });
    const inGroup = { id: 'g1', parentId: 'grp', position: { x: 400, y: 0 }, measured: { width: 260, height: 200 } };
    expect(findFreeSlot([anchor, inGroup], anchor, size)).toEqual({ x: 400, y: 0 });
  });
});

describe('舞台名额 / 像素比', () => {
  afterEach(() => resetStageSlots());

  it('超过软上限淘汰最久没用且未选中的；选中的可突破软上限但不超过硬上限', () => {
    const evicted: string[] = [];
    const releases = new Map<string, () => void>();
    for (let i = 0; i < MAX_LIVE_STAGES; i++) {
      const id = `n${i}`;
      releases.set(id, acquireStageSlot(id, { isPinned: () => id === 'n0', evict: () => evicted.push(id) })!);
    }
    expect(liveStageCount()).toBe(MAX_LIVE_STAGES);
    touchStageSlot('n1'); // n1 最近用过 → n2 最旧（n0 选中不可淘汰）
    expect(acquireStageSlot('new', { isPinned: () => false, evict: () => evicted.push('new') })).toBeTypeOf('function');
    expect(evicted).toEqual(['n2']);
    expect(liveStageCount()).toBe(MAX_LIVE_STAGES);
    releases.get('n2')!(); // 被淘汰后旧的释放函数是空操作
    expect(liveStageCount()).toBe(MAX_LIVE_STAGES);
  });

  it('全部选中时：未选中的申请被拒，选中的申请到硬上限为止', () => {
    for (let i = 0; i < HARD_MAX_LIVE_STAGES; i++) expect(acquireStageSlot(`p${i}`, { isPinned: () => true, evict: () => {} })).not.toBeNull();
    expect(acquireStageSlot('late', { isPinned: () => true, evict: () => {} })).toBeNull();
    resetStageSlots();
    for (let i = 0; i < MAX_LIVE_STAGES; i++) acquireStageSlot(`p${i}`, { isPinned: () => true, evict: () => {} });
    expect(acquireStageSlot('free', { isPinned: () => false, evict: () => {} })).toBeNull();
    expect(acquireStageSlot('sel', { isPinned: () => true, evict: () => {} })).not.toBeNull();
  });

  it('像素比：不超过 2，放大画布时按像素总量封顶', () => {
    expect(stagePixelRatio(302, 170, 2)).toBe(2);
    expect(stagePixelRatio(302, 170, 1)).toBe(1);
    const r = stagePixelRatio(2416, 1360, 2);
    expect(2416 * 1360 * r * r).toBeLessThanOrEqual(MAX_STAGE_PIXELS + 1);
    expect(stagePixelRatio(100000, 100000, 2)).toBe(0.25);
  });
});
