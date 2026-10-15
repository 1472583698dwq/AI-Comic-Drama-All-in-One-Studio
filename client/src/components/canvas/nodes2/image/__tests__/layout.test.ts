// REQ-toonflow-canvas N2：摆放 / 尺寸 / 参数快捷项 / 局部重绘组装 / 生成入参整理 —— 纯函数
import { describe, expect, it } from 'vitest';
import { freeY, gridSplitPositions, placeRightOf, siblingRects, stackLeftOf, tileNodeWidth, GRID_ROW_PITCH } from '../layout';
import { imageUrlFromDrop, loadImagePatch, genImagePatch, mediaNodeWidth, normalizeMediaUrl, validateImageFile } from '../media';
import { aspectLabel, closestRatioOption, detectQuickParams, paramsPatch, paramsSummary, providerDefaultParams, ratioText } from '../imageParams';
import { assembleInpaint, inpaintBlockedReason, shiftRefTokens, INPAINT_GUIDE_KEY, INPAINT_SOURCE_KEY } from '../inpaint';
import { generationData, generationLanded, isAgentRunning } from '../generation';
import { characterViews } from '../SkillPicker';
import { withCurrent } from '../HistoryStrip';
import type { Node } from '@xyflow/react';
import type { RefItem } from '../../../kit/types';

describe('宫格切分版式（Toonflow imageGridSplit）', () => {
  it('2×2：锚点右侧 80px，列距 tileWidth+40，行距 320，行优先', () => {
    const anchor = { x: 100, y: 50, width: 300, height: 290 };
    const tileWidth = tileNodeWidth(512, 512); // 1:1 → 240 + 18
    expect(tileWidth).toBe(258);
    const pos = gridSplitPositions({ anchor, rows: 2, cols: 2, tileWidth, others: [] });
    expect(pos).toEqual([
      { x: 480, y: 50 },
      { x: 480 + 298, y: 50 },
      { x: 480, y: 50 + GRID_ROW_PITCH },
      { x: 480 + 298, y: 50 + GRID_ROW_PITCH },
    ]);
  });

  it('网格矩形压到已有节点时整体下移到其下方 40px（按 y 升序逐个避让）', () => {
    const anchor = { x: 0, y: 0, width: 258, height: 290 };
    const others = [
      { x: 400, y: 100, width: 200, height: 200 }, // 压在网格区域内
      { x: 400, y: 330, width: 200, height: 100 }, // 第一次下移后又压到它
      { x: 2000, y: 0, width: 100, height: 100 }, // 不相交
    ];
    const pos = gridSplitPositions({ anchor, rows: 1, cols: 2, tileWidth: 258, others });
    expect(pos[0]).toEqual({ x: 338, y: 470 });
    expect(pos[1]).toEqual({ x: 338 + 298, y: 470 });
  });

  it('切块宽按块宽高比 ×240 + 18，并夹在 [100,720]+18', () => {
    expect(tileNodeWidth(1344, 768)).toBe(Math.round(240 * 1344 / 768) + 18);
    expect(tileNodeWidth(100, 1000)).toBe(100 + 18);
    expect(tileNodeWidth(10000, 100)).toBe(720 + 18);
  });

  it('标记产物放右侧并避让；角色参考放左侧竖排', () => {
    const anchor = { x: 0, y: 0, width: 300, height: 300 };
    expect(placeRightOf(anchor, { width: 258, height: 290 }, [])).toEqual({ x: 380, y: 0 });
    expect(placeRightOf(anchor, { width: 258, height: 290 }, [{ x: 380, y: 0, width: 100, height: 100 }])).toEqual({ x: 380, y: 140 });
    const left = stackLeftOf(anchor, 2, []);
    expect(left[0].x).toBe(-80 - 220);
    expect(left[1].y).toBeGreaterThan(left[0].y);
    expect(freeY({ x: 0, y: 0, width: 10, height: 10 }, [])).toBe(0);
  });

  it('siblingRects 只取同一父级节点、优先测量尺寸', () => {
    const nodes = [
      { id: 'a', position: { x: 1, y: 2 }, measured: { width: 10, height: 20 }, data: {} },
      { id: 'b', position: { x: 5, y: 5 }, width: 30, height: 40, data: {} },
      { id: 'c', position: { x: 9, y: 9 }, parentId: 'g', data: {} },
    ] as unknown as Node[];
    const r = siblingRects(nodes, 'a');
    expect(r.anchor).toEqual({ x: 1, y: 2, width: 10, height: 20 });
    expect(r.others).toEqual([{ x: 5, y: 5, width: 30, height: 40 }]);
  });
});

describe('媒体尺寸与读写', () => {
  it('节点宽 = 240×宽高比 + 18', () => {
    expect(mediaNodeWidth({ width: 832, height: 1216 })).toBe(Math.round(240 * 832 / 1216) + 18);
    expect(mediaNodeWidth(null)).toBeUndefined();
  });
  it('load-image 三键同写；图片生成写 image_url + result_url，旧 image/url 键跟着改', () => {
    expect(loadImagePatch('/storage/a.png')).toEqual({ image_url: '/storage/a.png', image: '/storage/a.png', url: '/storage/a.png' });
    expect(genImagePatch('/s/b.png')).toEqual({ image_url: '/s/b.png', result_url: '/s/b.png' });
    expect(genImagePatch('/s/b.png', { image: 'old', url: 'old' })).toEqual({ image_url: '/s/b.png', result_url: '/s/b.png', image: '/s/b.png', url: '/s/b.png' });
  });
  it('拖入：素材库条目取 text/plain 并还原为存储相对路径；文本素材 / 非图片文本不接', () => {
    const dt = (m: Record<string, string>) => ({ getData: (k: string) => m[k] ?? '' });
    expect(imageUrlFromDrop(dt({ 'application/canvas-assetid': 'ast_1', 'text/plain': 'http://127.0.0.1:8001/storage/assets/ast_1/original.png' }))).toBe('/storage/assets/ast_1/original.png');
    expect(imageUrlFromDrop(dt({ 'application/canvas-assetid': 'ast_2', 'application/canvas-assetkind': 'text', 'text/plain': '一段文字' }))).toBe('');
    expect(imageUrlFromDrop(dt({ 'text/plain': '随便一段文字' }))).toBe('');
    expect(imageUrlFromDrop(dt({ 'text/uri-list': 'https://x.com/a.webp' }))).toBe('https://x.com/a.webp');
    expect(normalizeMediaUrl('http://localhost:8000/exports/x.png')).toBe('/exports/x.png');
  });
  it('上传校验：非图片 / 空文件 / 超 100MB', () => {
    expect(validateImageFile(new File(['x'], 'a.txt', { type: 'text/plain' }))).toBe('请选择图片文件');
    expect(validateImageFile(new File([], 'a.png', { type: 'image/png' }))).toContain('100 MB');
    expect(validateImageFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBeNull();
  });
});

const COMFY_SCHEMA = {
  properties: {
    combo_49_aspect_ratio: { type: 'string', title: '画面比例 (Resolution Selector)', enum: ['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)'], default: '1:1 (Square)', 'x-std-key': 'aspect_ratio', 'x-visibility': 'basic', 'x-agent': 'auto' },
    num_49_megapixels: { type: 'number', title: '百万像素', default: 1, 'x-visibility': 'hidden' },
    seed: { type: 'integer', title: '种子', 'x-agent': 'manual' },
  },
};
const BUILTIN_SCHEMA = {
  properties: {
    aspect_ratio: { type: 'string', title: '画面比例', enum: ['9:16', '16:9', '1:1'], default: '9:16', 'x-visibility': 'basic', 'x-agent': 'auto' },
    resolution: { type: 'string', title: '分辨率', enum: ['480p', '720p', '1080p'], default: '720p', 'x-visibility': 'basic' },
    steps: { type: 'integer', title: '采样步数', default: 20 },
  },
};

describe('参数快捷项（Toonflow generationSettings）', () => {
  it('比例按 x-std-key / 键名识别，枚举原样、展示取 W:H；分辨率按键名识别', () => {
    const c = detectQuickParams(COMFY_SCHEMA);
    expect(c.ratio?.param_name).toBe('combo_49_aspect_ratio');
    expect(c.size).toBeUndefined();
    expect(c.specs.find((s) => s.param_name === 'seed')?.agent).toBe('manual');
    const b = detectQuickParams(BUILTIN_SCHEMA);
    expect(b.ratio?.param_name).toBe('aspect_ratio');
    expect(b.size?.param_name).toBe('resolution');
    expect(ratioText('9:16 (Portrait Widescreen)')).toBe('9:16');
    expect(ratioText('1024x1024')).toBeNull();
    expect(aspectLabel(1024, 768)).toBe('4:3');
    expect(aspectLabel(1365, 768)).toBe('1.78:1');
  });
  it('摘要 `16:9 · 720p`、默认参数、最接近比例', () => {
    const b = detectQuickParams(BUILTIN_SCHEMA);
    expect(paramsSummary({ aspect_ratio: '16:9' }, b)).toEqual({ text: '16:9 · 720p', ratio: '16:9' });
    expect(paramsSummary({}, detectQuickParams(undefined))).toEqual({ text: '参数' });
    expect(providerDefaultParams({ params_schema: BUILTIN_SCHEMA, default_params: { steps: 30 } })).toEqual({ aspect_ratio: '9:16', resolution: '720p', steps: 30 });
    expect(closestRatioOption(detectQuickParams(COMFY_SCHEMA).ratio, 832 / 1216)).toBe('9:16 (Portrait Widescreen)');
  });
  it('写参数：params + provider_params 同写；只把后端执行器先读的标准键镜像到顶层，换源后旧标准键清掉', () => {
    const p = paramsPatch({ aspect_ratio: '1:1', prompt: 'x', combo_49_aspect_ratio: '1:1 (Square)' }, { steps: 20, aspect_ratio: '9:16' });
    expect(p.params).toEqual({ aspect_ratio: '1:1', prompt: 'x', combo_49_aspect_ratio: '1:1 (Square)' });
    expect(p.provider_params).toBe(p.params);
    expect(p.aspect_ratio).toBe('1:1');
    expect('steps' in p && p.steps === undefined).toBe(true);
    expect('prompt' in p).toBe(false);
    expect('combo_49_aspect_ratio' in p).toBe(false);
  });
});

describe('局部重绘组装', () => {
  const img = (key: string, value: string): RefItem => ({ key, sourceId: key.split('|')[0], sourceHandle: 'image', dataType: 'IMAGE', value });
  const txt = (key: string, value: string): RefItem => ({ key, sourceId: key.split('|')[0], sourceHandle: 'prompt', dataType: 'STRING', value });

  it('参考图 = 原图 + 引导图 + 用户参考；用户 {{ref N}} 后移 2 位并附编号对应', () => {
    expect(shiftRefTokens('把 {{ref 1}} 换成 {{ref 2}}', 2)).toBe('把 {{ref 3}} 换成 {{ref 4}}');
    const a = assembleInpaint({
      sourceUrl: '/s/src.png',
      guideUrl: '/s/guide.png',
      refs: [img('r1|image', '/s/ref.png'), txt('t|prompt', '雨夜')],
      prompt: '把伞换成 {{ref 1}} 的红伞',
      slots: [{ key: 'reference_images', type: 'image', maxCount: 4, multi: true, originalKey: 'reference_images' }],
    });
    expect(a.args.reference_images).toEqual(['/s/src.png', '/s/guide.png', '/s/ref.png']);
    expect(a.assignments[INPAINT_SOURCE_KEY]).toBe('reference_images');
    expect(a.assignments[INPAINT_GUIDE_KEY]).toBe('reference_images');
    expect(a.prompt.startsWith('对第 1 张参考图（原图）进行局部重绘')).toBe(true);
    expect(a.prompt).toContain('把伞换成 参考 3 的红伞');
    expect(a.prompt).toContain('参考 4：\n雨夜');
    expect(a.prompt).toContain('参考 3=第 3 张参考图');
    expect(inpaintBlockedReason(a)).toBeNull();
  });
  it('生成源只收 1 张参考图时阻止局部重绘', () => {
    const a = assembleInpaint({ sourceUrl: '/a', guideUrl: '/b', prompt: 'x', slots: [{ key: 'image', type: 'image', maxCount: 1, originalKey: 'image' }] });
    expect(inpaintBlockedReason(a)).toContain('只能接收 1 张');
  });
});

describe('生成入参整理', () => {
  it('剔除旧槽位键 / text / idea / img_*，本次参数写进 params 与 provider_params', () => {
    const d = generationData(
      { prompt: 'p', text: 'old', idea: 'old', reference_images: ['/old.png'], reference: '/old.png', img_12_image: '/x.png', image_ref: '/y.png', params: { aspect_ratio: '1:1' }, history: [] },
      [{ key: 'reference_images', originalKey: 'image_ref' }],
      { aspect_ratio: '9:16' },
      { model: 'm1' },
    );
    expect(d).toEqual({ prompt: 'p', params: { aspect_ratio: '9:16' }, provider_params: { aspect_ratio: '9:16' }, history: [], model: 'm1' });
  });
  it('结果是否落地 / 运行态是否陈旧', () => {
    expect(generationLanded(null)).toBe(false);
    expect(generationLanded({ url: '/a', patch: {} })).toBe(false);
    expect(generationLanded({ url: '/a', patch: { history: [] } })).toBe(true);
    const now = Date.parse('2026-10-15T10:00:00Z');
    expect(isAgentRunning({ status: 'running', updated_at: '2026-10-15T09:55:00Z' }, now)).toBe(true);
    expect(isAgentRunning({ status: 'running', updated_at: '2026-10-15T08:00:00Z' }, now)).toBe(false);
    expect(isAgentRunning({ status: 'completed' }, now)).toBe(false);
  });
  it('历史补当前图；角色视图主图在前', () => {
    expect(withCurrent([{ url: '/b', created_at: '1' }], '/a').map((h) => h.url)).toEqual(['/a', '/b']);
    expect(withCurrent([{ url: '/a', created_at: '1' }], '/a')).toHaveLength(1);
    expect(characterViews({ three_views: { side: '/s', front: '/f' } }).map((v) => v.key)).toEqual(['front', 'side']);
    expect(characterViews({ avatar_url: '/av' })).toEqual([{ key: 'main', label: '立绘', url: '/av' }]);
  });
});
