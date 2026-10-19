// 白模导出状态对齐：远控 stage_patch 只写服务端 → 录制前必须把服务端最新舞台状态拉回内存（只读不回写）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getProject = vi.fn();
const saveProjectContent = vi.fn(async (..._a: any[]) => ({}));
vi.mock('../../../services/api', () => ({
  apiService: {
    getProject: (...a: any[]) => (getProject as any)(...a),
    saveProjectContent: (...a: any[]) => (saveProjectContent as any)(...a),
  },
}));

import { useProjectStore } from '../../../stores/useProjectStore';
import { resyncStageFromServer, findClayTargetShot } from '../clayExportSync';

const shot = (over: Record<string, any> = {}) => ({
  id: 'sh_1', shot_index: 1, duration: 4, action_desc: '对打', ...over,
});
const projectWith = (shotOver: Record<string, any> = {}) => ({
  id: 'p1',
  scenes: [{ id: 's1', scene_index: 1, shots: [shot(shotOver)] }],
});

beforeEach(() => {
  getProject.mockReset();
  saveProjectContent.mockClear();
  useProjectStore.setState({
    project: null,
    activeProjectId: 'p1',
    activeShotId: null,
    activeEpisodeId: null,
  } as any);
});

describe('白模导出前对齐服务端状态', () => {
  it('远控 patch 只写在服务端：resync 后目标分镜带的是服务端新舞台（双人对打 / 环绕 / 28mm）', async () => {
    // 浏览器内存：旧舞台（单人待机 + 中景 35mm 急进推镜）
    useProjectStore.setState({
      project: projectWith({ camera_motion: 'push_in', cast_layout: 'solo', camera_framing: 'medium', focal_length_mm: 35 }),
    } as any);
    // 服务端：Agent 远控已改成双人对打 + 全景环绕 28mm
    getProject.mockResolvedValue({
      meta: { id: 'p1' },
      content: projectWith({ camera_motion: 'orbit', cast_layout: 'duel', camera_framing: 'full', focal_length_mm: 28 }),
    });

    await resyncStageFromServer();
    const target = findClayTargetShot({ shot_id: 'sh_1' });
    expect(target.camera_motion).toBe('orbit');
    expect(target.cast_layout).toBe('duel');
    expect(target.camera_framing).toBe('full');
    expect(target.focal_length_mm).toBe(28);

    // 对齐是只读的：不得触发整份回写（否则又会用旧/新内容覆盖服务端的并发改动）
    await new Promise((r) => setTimeout(r, 400));
    expect(saveProjectContent).not.toHaveBeenCalled();
  });

  it('按 shot_index 也能定位（Agent 只给序号时）', async () => {
    useProjectStore.setState({ project: projectWith() } as any);
    getProject.mockResolvedValue({ meta: {}, content: projectWith({ cast_layout: 'duel' }) });
    await resyncStageFromServer();
    expect(findClayTargetShot({ shot_index: 1 })?.id).toBe('sh_1');
  });

  it('拉取失败不抛错：返回 false 并用内存状态继续定位分镜', async () => {
    useProjectStore.setState({ project: projectWith() } as any);
    getProject.mockRejectedValue(new Error('offline'));
    await expect(resyncStageFromServer()).resolves.toBe(false);
    expect(findClayTargetShot({ shot_id: 'sh_1' })?.id).toBe('sh_1');
  });

  it('录制结果回写落在服务端新状态之上：clay_* 与远控 patch 同时在，旧状态不再覆盖', async () => {
    // 内存旧状态（单人/推镜）
    useProjectStore.setState({
      project: projectWith({ camera_motion: 'push_in', cast_layout: 'solo' }),
    } as any);
    // 服务端已被远控改成 双人/环绕
    getProject.mockResolvedValue({
      meta: { id: 'p1' },
      content: projectWith({ camera_motion: 'orbit', cast_layout: 'duel' }),
    });
    await resyncStageFromServer();
    // 录制完成 → 写入 clay_*（真实路径：updateShot(activeShot.id, patch)）
    useProjectStore.getState().updateShot('sh_1', {
      clay_video_url: '/storage/assets/ast_x/original.mp4',
      clay_prompt: '全景 (WS)，焦距 28mm；运镜：环绕 (Orbit)',
    } as any);
    await new Promise((r) => setTimeout(r, 400));
    expect(saveProjectContent).toHaveBeenCalledTimes(1);
    const [, saved] = saveProjectContent.mock.calls[0];
    const savedShot = (saved as any).scenes[0].shots[0];
    // 回写的是「服务端新状态 + clay 结果」，不是内存里的旧舞台
    expect(savedShot.camera_motion).toBe('orbit');
    expect(savedShot.cast_layout).toBe('duel');
    expect(savedShot.clay_video_url).toBe('/storage/assets/ast_x/original.mp4');
    expect(savedShot.clay_prompt).toContain('环绕');
  });

  it('setProject 默认仍会持久化；loadActiveProject 拉取路径不回写', async () => {
    useProjectStore.getState().setProject(projectWith() as any);
    await new Promise((r) => setTimeout(r, 400));
    expect(saveProjectContent).toHaveBeenCalledTimes(1);

    saveProjectContent.mockClear();
    getProject.mockResolvedValue({ meta: { id: 'p1' }, content: projectWith() });
    await useProjectStore.getState().loadActiveProject('p1').catch(() => {});
    // openProject 未在 mock 里提供 → 内部 try 忽略；关键是拉回 content 后不得整份写回
    await new Promise((r) => setTimeout(r, 400));
    expect(saveProjectContent).not.toHaveBeenCalled();
  });
});
