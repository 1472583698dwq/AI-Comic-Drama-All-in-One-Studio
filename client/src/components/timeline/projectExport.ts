import type { Project, StoryboardShot } from '../../types';

export interface ProjectExportPayload {
  project_id?: string;
  title?: string;
  aspect_ratio?: string;
  shots: Array<Record<string, any>>;
  bgm_url?: string | null;
  bgm_volume?: number;
  subtitles?: boolean;
  generate_missing_voice?: boolean;
  audio_provider?: string | null;
  allow_silent?: boolean;
}

export function buildProjectExportPayload(
  project: Project,
  shots: StoryboardShot[],
  opts: { title?: string; subtitles?: boolean; generateMissingVoice?: boolean } = {},
): ProjectExportPayload {
  return {
    project_id: project.id,
    title: opts.title || project.title,
    aspect_ratio: project.aspect_ratio,
    shots: shots.map((shot) => ({
      id: shot.id,
      shot_index: shot.shot_index,
      duration: Math.max(0, Number(shot.duration) || 0),
      video_url: shot.video_url || '',
      image_url: shot.image_url || '',
      audio_url: shot.audio_url || '',
      audio_duration: Math.max(0, Number(shot.audio_duration) || 0),
      subtitle_text: shot.subtitle_text || '',
      dialogue: shot.dialogue || '',
      voiceover: shot.voiceover || '',
    })),
    bgm_url: project.bgm_url || '',
    bgm_volume: Number.isFinite(Number(project.bgm_volume)) ? Number(project.bgm_volume) : 0.5,
    subtitles: opts.subtitles !== false,
    generate_missing_voice: opts.generateMissingVoice === true,
  };
}

export function projectExportPreflight(project: Project | null, shots: StoryboardShot[]): string | null {
  if (!project) return '请先打开项目';
  if (!shots.length) return '当前集没有分镜：请先在分镜台生成或导入分镜';
  const usable = shots.some(
    (shot) => shot.video_url || shot.image_url || shot.audio_url
      || shot.subtitle_text || shot.dialogue || shot.voiceover,
  );
  if (!usable) return '当前集没有可导出的画面、配音或字幕素材';
  const blobShots = shots.filter((shot) =>
    [shot.video_url, shot.image_url, shot.audio_url].some((url) => !!url && url.startsWith('blob:')),
  );
  if (blobShots.length) {
    const names = blobShots.slice(0, 3).map((shot) => `#${shot.shot_index}`).join('、');
    return `有 ${blobShots.length} 个镜头（${names}）的素材还是浏览器临时地址（blob:），请重新生成或重新选择素材后再导出`;
  }
  return null;
}
