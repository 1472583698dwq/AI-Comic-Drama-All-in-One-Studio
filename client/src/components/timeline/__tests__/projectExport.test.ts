import { describe, expect, it } from 'vitest';
import { buildProjectExportPayload, projectExportPreflight } from '../projectExport';
import type { Project, StoryboardShot } from '../../../types';

const shot = (patch: Partial<StoryboardShot> = {}): StoryboardShot => ({
  id: 'shot_1',
  shot_index: 1,
  scene_index: 1,
  camera_framing: 'medium',
  camera_motion: 'static',
  action_desc: '',
  emotion: 'neutral',
  image_prompt: '',
  duration: 2.5,
  subtitle_text: '',
  status: 'ready',
  ...patch,
});

const project = {
  id: 'proj_1',
  title: '测试项目',
  original_novel: '',
  style_preset: 'donghua_xianxia',
  aspect_ratio: '9:16',
  characters: [],
  scenes: [],
  bgm_url: '/storage/audio/bgm.mp3',
  bgm_volume: 0.35,
  created_at: '',
  updated_at: '',
} as Project;

describe('buildProjectExportPayload', () => {
  it('携带多轨导出所需的镜头字段与项目 BGM 配置', () => {
    const payload = buildProjectExportPayload(project, [
      shot({
        video_url: '/storage/videos/a.mp4',
        image_url: '/storage/images/a.png',
        audio_url: '/storage/audio/a.mp3',
        audio_duration: 2.1,
        subtitle_text: '字幕',
        dialogue: '台词',
        voiceover: '旁白',
      }),
    ]);

    expect(payload.project_id).toBe('proj_1');
    expect(payload.title).toBe('测试项目');
    expect(payload.aspect_ratio).toBe('9:16');
    expect(payload.bgm_url).toBe('/storage/audio/bgm.mp3');
    expect(payload.bgm_volume).toBe(0.35);
    expect(payload.subtitles).toBe(true);
    expect(payload.shots[0]).toMatchObject({
      shot_index: 1,
      duration: 2.5,
      video_url: '/storage/videos/a.mp4',
      image_url: '/storage/images/a.png',
      audio_url: '/storage/audio/a.mp3',
      audio_duration: 2.1,
      subtitle_text: '字幕',
      dialogue: '台词',
      voiceover: '旁白',
    });
  });

  it('允许调用方覆盖标题与字幕开关', () => {
    const payload = buildProjectExportPayload(project, [shot()], {
      title: '第 1 集_成片',
      subtitles: false,
    });
    expect(payload.title).toBe('第 1 集_成片');
    expect(payload.subtitles).toBe(false);
  });
});

describe('projectExportPreflight', () => {
  it('空分镜与空素材会被拦截', () => {
    expect(projectExportPreflight(null, [])).toContain('先打开项目');
    expect(projectExportPreflight(project, [])).toContain('没有分镜');
    expect(projectExportPreflight(project, [shot()])).toContain('没有可导出');
  });

  it('blob 临时地址会被拦截并指出镜头', () => {
    const blocked = projectExportPreflight(project, [
      shot({ video_url: 'blob:http://localhost/1' }),
    ]);
    expect(blocked).toContain('blob:');
    expect(blocked).toContain('#1');
  });

  it('有画面素材时放行', () => {
    expect(projectExportPreflight(project, [shot({ image_url: '/storage/images/a.png' })])).toBeNull();
  });
});
