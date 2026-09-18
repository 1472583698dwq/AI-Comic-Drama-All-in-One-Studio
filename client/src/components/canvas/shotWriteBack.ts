// -*- coding: utf-8 -*-
/**
 * 画布结果 → 分镜 回写（唯一口径）
 * 节点数据里的结果字段 → 分镜媒体字段的映射与写入只在这里做，runShotOnCanvas 与节点控制台共用。
 * 分镜归属：节点 data.shotId（分镜跳转画布建子图时写入；手动回写选镜后也会记住）。
 */
import { useProjectStore } from '../../stores/useProjectStore';

export type WriteBackField = 'image_url' | 'video_url' | 'audio_url';

export interface NodeResultOption {
  field: WriteBackField;
  label: string;
  value: string;
}

const FIELD_LABEL: Record<WriteBackField, string> = {
  image_url: '图片/首帧',
  video_url: '视频',
  audio_url: '配音',
};

const IMAGE_TYPES = new Set(['image', 'shot-card', 'custom', 'load-image']);
const VIDEO_TYPES = new Set(['video', 'shot-card', 'custom', 'load-video', 'comfy-workflow']);
const AUDIO_TYPES = new Set(['audio', 'custom', 'load-audio', 'tts']);

/** 节点数据里可回写到分镜的结果（按节点类型声明的输出端口取，候选图/多版本一并列出） */
export function collectNodeResults(nodeType: string, data: any): NodeResultOption[] {
  const d: any = data || {};
  const out: NodeResultOption[] = [];
  const seen = new Set<string>();
  const push = (field: WriteBackField, value: any, label?: string) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const key = `${field}::${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ field, label: label || FIELD_LABEL[field], value });
  };

  const known = IMAGE_TYPES.has(nodeType) || VIDEO_TYPES.has(nodeType) || AUDIO_TYPES.has(nodeType);
  if (!known) {
    // 未知/扩展节点：按数据里实际存在的媒体结果收集，不做类型假设
    push('image_url', d.image_url || d.result_url);
    push('video_url', d.video_url);
    push('audio_url', d.audio_url);
    return out;
  }

  if (IMAGE_TYPES.has(nodeType)) {
    push('image_url', d.image_url || d.result_url);
    if (Array.isArray(d.candidates)) d.candidates.forEach((u: any, i: number) => push('image_url', u, `候选图 ${i + 1}`));
    if (Array.isArray(d.images)) d.images.forEach((u: any, i: number) => push('image_url', u, `图片 ${i + 1}`));
    if (d.previz_url) push('image_url', d.previz_url, '白模参考图');
  }
  if (VIDEO_TYPES.has(nodeType)) {
    push('video_url', d.video_url);
    if (Array.isArray(d.videos)) d.videos.forEach((u: any, i: number) => push('video_url', u, `视频 ${i + 1}`));
    if (d.previz_video_url) push('video_url', d.previz_video_url, '白模动态预演');
  }
  if (AUDIO_TYPES.has(nodeType)) {
    push('audio_url', d.audio_url);
    if (Array.isArray(d.audios)) d.audios.forEach((u: any, i: number) => push('audio_url', u, `音频 ${i + 1}`));
  }
  return out;
}

/** 节点上持久化的分镜归属（分镜→画布建子图时写入；手动选镜回写后记住） */
export function nodeShotId(data: any): string {
  return String(data?.shotId || data?.shot_id || '');
}

export function findShot(project: any, shotId: string): any | null {
  if (!project?.scenes || !shotId) return null;
  for (const sc of project.scenes) {
    const sh = (sc.shots || []).find((s: any) => s?.id === shotId);
    if (sh) return sh;
  }
  return null;
}

export interface ShotOption {
  id: string;
  label: string;
  shotIndex: number | string;
  hasImage: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** 项目全部分镜（下拉选镜用） */
export function listShotOptions(project: any): ShotOption[] {
  const out: ShotOption[] = [];
  (project?.scenes || []).forEach((sc: any, si: number) => {
    (sc.shots || []).forEach((sh: any) => {
      const sceneNo = (sc.scene_index ?? si + 1);
      out.push({
        id: sh.id,
        label: `场${sceneNo} · 镜${sh.shot_index ?? ''}${sh.action_desc ? ` ${String(sh.action_desc).slice(0, 12)}` : ''}`,
        shotIndex: sh.shot_index ?? '',
        hasImage: !!sh.image_url,
        hasVideo: !!sh.video_url,
        hasAudio: !!sh.audio_url,
      });
    });
  });
  return out;
}

export function shotDisplayName(shot: any): string {
  if (!shot) return '分镜';
  return shot.shot_index ? `分镜 #${shot.shot_index}` : '分镜';
}

/** 回写（含图片候选合并；历史已由 updateShot 自动留存） */
export function writeBackToShot(opts: { shotId: string; field: WriteBackField; value: string }): { ok: boolean; error?: string; shot?: any } {
  const store: any = useProjectStore.getState();
  const project = store.project;
  if (!project) return { ok: false, error: '未打开项目' };
  const shot = findShot(project, opts.shotId);
  if (!shot) return { ok: false, error: '目标分镜不存在（可能已删除）' };

  const patch: Record<string, any> = { [opts.field]: opts.value };
  if (opts.field === 'image_url') {
    const candidates = [opts.value, ...((shot.candidates || []) as string[]).filter((u) => u && u !== opts.value)].slice(0, 4);
    patch.candidates = candidates;
    patch.status = 'completed';
    patch.render_status = 'done';
  } else if (opts.field === 'video_url') {
    patch.status = 'completed';
    patch.render_status = 'done';
  }
  store.updateShot(opts.shotId, patch);
  return { ok: true, shot };
}
