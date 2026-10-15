import { describe, expect, it, vi } from 'vitest';
import { autoRunShotSubgraph, type ShotAutoRunDeps } from '../shotAutoRun';

/** REQ-toonflow-canvas D4：分镜子图自动运行 → 回写分镜（url 取 execute 返回值，不读渲染前的旧 nodesRef）。 */

function deps(over: Partial<ShotAutoRunDeps> = {}) {
  const notes: Array<[string, string]> = [];
  const d: ShotAutoRunDeps & { notes: typeof notes } = {
    execute: vi.fn(async (id: string) => (id === 'v' ? { url: '/storage/videos/mock_1.mp4' } : {})),
    // 模拟宿主 nodesRef：await 之后仍是旧 data（没有 video_url）
    readNodeData: vi.fn(() => ({ prompt: 'x' })),
    writeBack: vi.fn(() => ({ ok: true })),
    notify: vi.fn((level, msg) => { notes.push([level, msg]); }),
    sleep: vi.fn(async () => {}),
    warn: vi.fn(),
    notes,
    ...over,
  };
  return d;
}

const input = { shotId: 'shot-1', shotIndex: 1, directorNodeId: 'd', videoNodeId: 'v' };

describe('autoRunShotSubgraph', () => {
  it('先跑 3D 导演再跑视频；用 execute 返回的 url 回写分镜，提示成功（不报「未自动产出」）', async () => {
    const d = deps();
    const out = await autoRunShotSubgraph(input, d);
    expect(vi.mocked(d.execute).mock.calls.map((c) => c[0])).toEqual(['d', 'v']);
    expect(d.writeBack).toHaveBeenCalledWith({ shotId: 'shot-1', field: 'video_url', value: '/storage/videos/mock_1.mp4' });
    expect(out).toEqual({ status: 'written', url: '/storage/videos/mock_1.mp4' });
    expect(d.notes).toEqual([['success', '分镜 #1 视频已生成并回写']]);
  });

  it('3D 导演规划失败不影响视频生成与回写', async () => {
    const d = deps({ execute: vi.fn(async (id: string) => { if (id === 'd') throw new Error('规划失败'); return { url: '/v.mp4' }; }) });
    await expect(autoRunShotSubgraph(input, d)).resolves.toMatchObject({ status: 'written', url: '/v.mp4' });
    expect(d.warn).toHaveBeenCalled();
  });

  it('execute 没带 url 时兜底读节点 data', async () => {
    const d = deps({ execute: vi.fn(async () => undefined), readNodeData: vi.fn(() => ({ video_url: '/late.mp4' })) });
    await expect(autoRunShotSubgraph(input, d)).resolves.toEqual({ status: 'written', url: '/late.mp4' });
  });

  it('只有真失败才报错：生成失败 → error 且不回写；回写失败 → warning', async () => {
    const failed = deps({ execute: vi.fn(async (id: string) => { if (id === 'v') throw new Error('图生视频模式需要首帧'); return {}; }) });
    await expect(autoRunShotSubgraph(input, failed)).resolves.toEqual({ status: 'generate-failed', error: '图生视频模式需要首帧' });
    expect(failed.writeBack).not.toHaveBeenCalled();
    expect(failed.notes[0][0]).toBe('error');

    const wbFail = deps({ writeBack: vi.fn(() => ({ ok: false, error: '目标分镜不存在' })) });
    await expect(autoRunShotSubgraph(input, wbFail)).resolves.toMatchObject({ status: 'writeback-failed' });
    expect(wbFail.notes[0][0]).toBe('warning');
  });
});
