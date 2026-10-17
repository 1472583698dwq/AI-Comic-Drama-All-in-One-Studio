// REQ 素材节点（asset-source）：注册 / 素材类型识别 / 数据键写入 / 参考链路取值 / 渲染与素材库选择
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';

const listAssets = vi.fn(async () => ({ assets: [] as any[] }));
vi.mock('../../../../../services/api', () => ({
  apiService: {
    listAssets: (...args: any[]) => (listAssets as any)(...args),
    createAsset: vi.fn(),
  },
}));

import { buildRefs, readOutputValue } from '../../../kit/references';
import { getNodeDef, createNodeData, paletteDefs } from '../../../kit/registry';
import { Canvas, installFlowEnv } from '../../video/__tests__/flowEnv';
import '../index';
import {
  ASSET_SOURCE_TYPE, assetSourceKindOf, assetSourcePatch, assetSourcePreviewOf, assetSourceOutputValue,
} from '../pick';
import { AssetPickerModal } from '../../../../asset/AssetPickerModal';

beforeAll(installFlowEnv);
beforeEach(() => { listAssets.mockClear(); });
afterEach(() => cleanup());

function nodeOf(id: string, data: Record<string, unknown>): Node {
  return { id, type: ASSET_SOURCE_TYPE, position: { x: 0, y: 0 }, data };
}
function edgeOf(source: string, target: string): Edge {
  return { id: `e_${source}_${target}`, source, sourceHandle: 'out', target, targetHandle: 'in' };
}

describe('asset-source 注册', () => {
  it('注册到节点注册表、在工具盘中、带 out 输出口', () => {
    const def = getNodeDef(ASSET_SOURCE_TYPE);
    expect(def).toBeTruthy();
    expect(def!.ports).toEqual([{ id: 'out', type: 'source', dataType: '*', label: '素材输出' }]);
    expect(paletteDefs().some((d) => d.type === ASSET_SOURCE_TYPE)).toBe(true);
    expect(createNodeData(ASSET_SOURCE_TYPE)).toEqual({ label: '素材' });
  });
});

describe('assetSourceKindOf 素材类型识别', () => {
  it('按 category / 扩展名 / 正文兜底', () => {
    expect(assetSourceKindOf({ category: 'text', content: '台词' })).toBe('text');
    expect(assetSourceKindOf({ category: 'audio', file_url: '/a/x' })).toBe('audio');
    expect(assetSourceKindOf({ category: 'video', file_url: '/a/x' })).toBe('video');
    expect(assetSourceKindOf({ category: 'character', file_url: '/storage/a/original.png' })).toBe('image');
    expect(assetSourceKindOf({ category: 'other', file_url: '/storage/a/clip.MP4' })).toBe('video');
    expect(assetSourceKindOf({ category: 'other', file_url: '/storage/a/voice.m4a' })).toBe('audio');
    expect(assetSourceKindOf({ category: 'text', visual_prompt: '只读描述' })).toBe('text');
  });
});

describe('assetSourcePatch 数据键写入', () => {
  it('图片：写 image_url / image / url，清旧类型键，记录 asset 元信息并同步标题', () => {
    const patch = assetSourcePatch('image', { url: '/storage/a/x.png', assetId: 'ast_1', name: '封面' });
    expect(patch.asset_kind).toBe('image');
    expect(patch.asset_id).toBe('ast_1');
    expect(patch.asset_name).toBe('封面');
    expect(patch.label).toBe('封面');
    expect(patch.image_url).toBe('/storage/a/x.png');
    expect(patch.image).toBe('/storage/a/x.png');
    expect(patch.url).toBe('/storage/a/x.png');
    expect(patch.video_url).toBeUndefined();
    expect(patch.audio_url).toBeUndefined();
    expect(patch.prompt).toBeUndefined();
  });

  it('文本：写 prompt / text，不写 url', () => {
    const patch = assetSourcePatch('text', { content: '第一幕：雨夜', assetId: 'ast_2', name: '剧本' });
    expect(patch.prompt).toBe('第一幕：雨夜');
    expect(patch.text).toBe('第一幕：雨夜');
    expect(patch.url).toBeUndefined();
    expect(patch.image_url).toBeUndefined();
  });
});

describe('assetSourcePreviewOf / assetSourceOutputValue', () => {
  it('预览按声明类型与键回推', () => {
    expect(assetSourcePreviewOf({ asset_kind: 'video', video_url: '/v.mp4' })).toMatchObject({ kind: 'video', url: '/v.mp4' });
    expect(assetSourcePreviewOf({ image_url: '/i.png' })).toMatchObject({ kind: 'image', url: '/i.png' });
    expect(assetSourcePreviewOf({ prompt: '台词' })).toMatchObject({ kind: 'text', content: '台词' });
    expect(assetSourcePreviewOf({})).toMatchObject({ kind: '', url: '', content: '' });
  });

  it('输出值按目标类型取对应键', () => {
    const data = { image_url: '/i.png', video_url: '/v.mp4', audio_url: '/a.mp3', prompt: '文' };
    expect(assetSourceOutputValue(data, 'out', 'IMAGE')).toBe('/i.png');
    expect(assetSourceOutputValue(data, 'out', 'VIDEO')).toBe('/v.mp4');
    expect(assetSourceOutputValue(data, 'out', 'AUDIO')).toBe('/a.mp3');
    expect(assetSourceOutputValue(data, 'out', 'STRING')).toBe('文');
    expect(assetSourceOutputValue({}, 'out', 'IMAGE')).toBeUndefined();
  });
});

describe('参考链路：素材节点 → 生成节点', () => {
  it('连线进 in 口后参考列表按素材类型取值', () => {
    const nodes: Record<string, Pick<Node, 'id' | 'type' | 'data'>> = {
      a1: { id: 'a1', type: ASSET_SOURCE_TYPE, data: { asset_kind: 'image', image_url: '/storage/a/x.png' } },
      a2: { id: 'a2', type: ASSET_SOURCE_TYPE, data: { asset_kind: 'text', prompt: '一段台词' } },
      g1: { id: 'g1', type: 'image', data: {} },
    };
    const get = (id: string) => nodes[id];
    const refs = buildRefs([edgeOf('a1', 'g1'), edgeOf('a2', 'g1')], get, 'g1');
    expect(refs.map((r) => [r.dataType, r.value])).toEqual([['IMAGE', '/storage/a/x.png'], ['STRING', '一段台词']]);
    expect(refs[0].label).toBe('素材');
  });

  it('readOutputValue 走节点 outputValue（空素材返回空）', () => {
    const def = getNodeDef(ASSET_SOURCE_TYPE)!;
    expect(def.outputValue!({ video_url: '/v.mp4' }, 'out', 'VIDEO')).toBe('/v.mp4');
    expect(readOutputValue({ type: ASSET_SOURCE_TYPE, data: { audio_url: '/a.mp3' } }, 'out', 'AUDIO')).toBe('/a.mp3');
    expect(readOutputValue({ type: ASSET_SOURCE_TYPE, data: {} }, 'out', 'IMAGE')).toBe('');
  });
});

describe('素材节点渲染与素材库选择', () => {
  it('空白态显示「从素材库选择」，选择图片后渲染预览并写入数据键', async () => {
    listAssets.mockResolvedValueOnce({ assets: [
      { id: 'ast_1', name: '封面图', category: 'character', file_url: '/storage/assets/ast_1/original.png' },
    ] } as any);
    const { container } = render(<Canvas nodes={[nodeOf('a1', {})]} />);
    expect(screen.getByText('从素材库选择')).toBeTruthy();

    fireEvent.click(screen.getByText('从素材库选择'));
    const cardName = await screen.findByText('封面图');
    fireEvent.click(cardName);

    await waitFor(() => {
      const img = container.querySelector('img.cv-asset__media') as HTMLImageElement | null;
      expect(img).toBeTruthy();
      expect(img!.getAttribute('src')).toContain('/storage/assets/ast_1/original.png');
    });
  });

  it('文本素材选择后渲染正文块', async () => {
    listAssets.mockResolvedValueOnce({ assets: [
      { id: 'ast_2', name: '剧本片段', category: 'text', content: '第一幕：雨夜重逢。' },
    ] } as any);
    const { container } = render(<Canvas nodes={[nodeOf('a1', {})]} />);
    fireEvent.click(screen.getByText('从素材库选择'));
    fireEvent.click(await screen.findByText('剧本片段'));

    await waitFor(() => {
      const text = container.querySelector('.cv-asset__text');
      expect(text?.textContent).toContain('第一幕：雨夜重逢。');
    });
  });

  it('已有素材数据（音频）时直接渲染播放器', () => {
    const { container } = render(<Canvas nodes={[nodeOf('a1', { asset_kind: 'audio', audio_url: '/storage/a/v.mp3', asset_name: '配音' })]} />);
    expect(container.querySelector('.cv-asset__audio audio')).toBeTruthy();
    expect(screen.queryByText('从素材库选择')).toBeNull();
  });
});

describe('AssetPickerModal（mediaType=all）', () => {
  it('文本素材有独立卡片，选中回传 content', async () => {
    listAssets.mockResolvedValueOnce({ assets: [
      { id: 'ast_9', name: '旁白', category: 'text', content: '夜色渐深。' },
      { id: 'ast_8', name: '场景图', category: 'scene', file_url: '/storage/a/s.png' },
    ] } as any);
    const onSelect = vi.fn();
    render(<AssetPickerModal isOpen mediaType="all" onSelect={onSelect} onClose={() => {}} />);
    const tile = await screen.findByText('旁白');
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ast_9', content: '夜色渐深。', category: 'text' }));
  });

  it('mediaType=image 时文本素材不显示（保持既有行为）', async () => {
    listAssets.mockResolvedValueOnce({ assets: [
      { id: 'ast_9', name: '旁白', category: 'text', content: '夜色渐深。' },
    ] } as any);
    render(<AssetPickerModal isOpen mediaType="image" onSelect={vi.fn()} onClose={() => {}} />);
    await waitFor(() => expect(listAssets).toHaveBeenCalled());
    expect(screen.queryByText('旁白')).toBeNull();
  });
});
