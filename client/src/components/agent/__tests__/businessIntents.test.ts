import { describe, expect, it } from 'vitest';
import { extractArtifact } from '../businessIntents';

describe('agent/businessIntents · extractArtifact', () => {
  it('普通视频结果 → 视频产物（无 applyAs 覆盖）', () => {
    const a = extractArtifact('generate_video', { video_url: '/storage/videos/a.mp4' });
    expect(a).toEqual({ kind: 'video', url: '/storage/videos/a.mp4', tool: 'generate_video', label: '分镜视频' });
  });

  it('3D 导演台白模/预演视频 → 白模参考视频，应用目标写回 previz_video_url', () => {
    const a = extractArtifact('stage_get_state', {
      previz_video_url: '/storage/videos/clay.mp4',
      clay_video_url: '/storage/videos/clay.mp4',
      clay_first_frame_url: '/storage/generated/f1.jpg',
    });
    expect(a?.kind).toBe('video');
    expect(a?.url).toBe('/storage/videos/clay.mp4');
    expect(a?.label).toBe('白模参考视频');
    expect(a?.applyAs).toBe('previz_video');
  });

  it('只有白模首帧时 → 图片产物', () => {
    const a = extractArtifact('stage_get_state', { clay_first_frame_url: '/storage/generated/f1.jpg' });
    expect(a?.kind).toBe('image');
    expect(a?.url).toBe('/storage/generated/f1.jpg');
  });

  it('无媒体 / 非对象 → null', () => {
    expect(extractArtifact('stage_get_state', { shots_total: 1 })).toBeNull();
    expect(extractArtifact('stage_get_state', 'not-a-dict')).toBeNull();
  });
});
