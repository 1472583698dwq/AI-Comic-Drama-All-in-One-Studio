// -*- coding: utf-8 -*-
/**
 * 分镜参考装配 — 单镜 / 批量 / 画布三路共用的唯一口径。
 *
 * 解决过的断点：
 * 1. 多角色只取其一 → 全量绑定角色都进参考；
 * 2. 场景参考底图 (scene_ref_image) 绑了却从不发送；
 * 3. 导演台白模预演 (previz_url / previz_video_url) 无人消费；
 * 4. 首帧与参考语义混淆 → first_frame 只放真首帧，参考槽只放角色/场景/白模；
 * 5. 相机意图只进视频 prompt → withCameraIntent 给生图也补上。
 */
import type { StoryboardShot } from '../../types';
import { FRAMING_PRESETS, MOTION_PRESETS } from '../director3d/directorPresets';

export interface BoundCharRef {
  id: string;
  name: string;
  refUrl: string;
  weight: number;
}

export interface ShotRefInputs {
  /** 参考集合：角色三视图/立绘 + 场景底图 + 白模截图（按序，调用方按源 maxCount 截断） */
  reference_images: string[];
  /**  legacy 兼容：首个参考（单数键通道） */
  reference_image?: string;
  /** 仅视频且有真首帧时 */
  first_frame_url?: string;
  /** 主角色权重（旧单值通道兼容） */
  character_weight?: number;
  /** 全量角色权重表 */
  character_weights?: Record<string, number>;
  /** 仅视频：动态预演（白模视频参考，有声明的源才消费） */
  previz_video_url?: string;
}

export function boundCharRefs(shot: any, project: any): BoundCharRef[] {
  const ids: string[] = shot?.character_ids || [];
  if (!ids.length) return [];
  const chars: any[] = project?.characters || [];
  const out: BoundCharRef[] = [];
  for (const id of ids) {
    const c = chars.find((x: any) => x.id === id);
    if (!c) continue;
    const tv = (c.three_views || {}) as Record<string, string>;
    const refUrl = tv.front || c.avatar_url || tv.three_quarter || tv.side || '';
    if (!refUrl) continue;
    out.push({
      id,
      name: c.name || id,
      refUrl,
      weight: Number(shot?.character_weights?.[id] ?? 0.8),
    });
  }
  return out;
}

/** 全量绑定角色的文字标签（拼进生图 prompt 做身份锚定） */
export function characterTags(shot: any, project: any): string {
  const refs = boundCharRefs(shot, project);
  if (!refs.length) return '';
  const chars: any[] = project?.characters || [];
  return refs.map((r) => {
    const c = chars.find((x: any) => x.id === r.id);
    const desc = c?.visual_prompt || c?.description || '';
    return `[角色: ${r.name}${desc ? `, ${desc}` : ''}]`;
  }).join(' ');
}

export function promptWithCharacterTags(basePrompt: string, shot: any, project: any): string {
  const tags = characterTags(shot, project);
  if (!tags) return basePrompt;
  // 已含全部角色名则不动；否则前置缺失的角色标签
  const refs = boundCharRefs(shot, project);
  const missing = refs.filter((r) => !basePrompt.includes(r.name));
  if (!missing.length) return basePrompt;
  const chars: any[] = project?.characters || [];
  const add = missing.map((r) => {
    const c = chars.find((x: any) => x.id === r.id);
    const desc = c?.visual_prompt || c?.description || '';
    return `[角色: ${r.name}${desc ? `, ${desc}` : ''}]`;
  }).join(' ');
  return `${add} ${basePrompt}`;
}

/**
 * 组装某分镜的参考输入。
 * - image：参考 = 全量角色 + 场景底图 + 白模截图；不碰首帧（生图没有首帧语义）。
 * - video：first_frame 只放真首帧 (image_url)；参考 = 全量角色 + 场景底图 + 白模截图；
 *   动态预演另给 previz_video_url（有视频参考槽的源自行消费，无声明则被 keepDeclaredOnly 丢弃）。
 */
export function buildShotReferenceInputs(
  shot: any,
  project: any,
  kind: 'image' | 'video',
): ShotRefInputs {
  const refs = boundCharRefs(shot, project);
  const list: string[] = refs.map((r) => r.refUrl);
  const sceneRef: string = shot?.scene_ref_image || '';
  if (sceneRef && !list.includes(sceneRef)) list.push(sceneRef);
  const previz: string = shot?.previz_url || '';
  if (previz && !list.includes(previz)) list.push(previz);

  const out: ShotRefInputs = { reference_images: list };
  if (list.length) out.reference_image = list[0];
  if (refs.length) {
    out.character_weight = refs[0].weight;
    out.character_weights = Object.fromEntries(refs.map((r) => [r.id, r.weight]));
  }
  if (kind === 'video') {
    if (shot?.image_url) out.first_frame_url = shot.image_url;
    if (shot?.previz_video_url) out.previz_video_url = shot.previz_video_url;
  }
  return out;
}

/** 相机意图后缀（P1）：分镜自身的景别/运镜/焦距转提示词片段，无参数时返回空 */
export function cameraIntentSuffix(shot: any): string {
  const f = FRAMING_PRESETS.find((x) => x.id === shot?.camera_framing)?.label || shot?.camera_framing || '';
  const m = MOTION_PRESETS.find((x) => x.id === shot?.camera_motion)?.label || shot?.camera_motion || '';
  if (!f && !m) return '';
  const lens = shot?.focal_length_mm ? ` · ${shot.focal_length_mm}mm` : '';
  return ` [运镜: ${[f, m].filter(Boolean).join(' · ')}${lens}]`;
}

/**
 * 参考图点名。顺序与 buildShotReferenceInputs 的 reference_images 一致：
 * 角色，然后场景，然后构图白模。提示词里已经写了 @图片 时不再追加。
 */
export function referenceMentionSuffix(shot: any, project: any): string {
  const lines: string[] = [];
  let n = 1;
  for (const r of boundCharRefs(shot, project)) {
    lines.push(`@图片${n} 作为角色「${r.name}」的参考`);
    n += 1;
  }
  if (shot?.scene_ref_image) {
    lines.push(`@图片${n} 作为场景参考`);
    n += 1;
  }
  if (shot?.previz_url) {
    lines.push(`@图片${n} 作为构图参考`);
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
}

export function withReferenceMentions(prompt: string, shot: any, project: any): string {
  if (!prompt || /@图片\d+/.test(prompt)) return prompt;
  const suffix = referenceMentionSuffix(shot, project);
  return suffix ? `${prompt}${suffix}` : prompt;
}

/** 把相机意图补进 prompt；已含 [Camera: / [运镜: 的不动（导演台保存的优先） */
export function withCameraIntent(prompt: string, shot: any): string {
  if (!prompt) return prompt;
  if (/\[Camera:|\[运镜:/.test(prompt)) return prompt;
  return `${prompt}${cameraIntentSuffix(shot)}`;
}

/**
 * 导入自动绑定：小说拆解 / 一键成片落盘前，按说话人精确匹配 + 正文提及匹配自动填充 character_ids。
 * 已有手动绑定的分镜不动；无角色或无匹配的分镜保持空白待手绑（避免主角污染全剧参考）。
 */
export function autoBindShotCharacters(proj: any): { boundShots: number; totalShots: number } {
  const chars: any[] = proj?.characters || [];
  if (!chars.length) return { boundShots: 0, totalShots: 0 };
  let bound = 0, total = 0;
  for (const sc of proj?.scenes || []) {
    for (const sh of sc?.shots || []) {
      total++;
      if (Array.isArray(sh.character_ids) && sh.character_ids.length) continue;
      const ids: string[] = [];
      if (sh.speaker_name) {
        const sp = chars.find((c: any) => c.name === sh.speaker_name);
        if (sp) {
          ids.push(sp.id);
          sh.speaker_id = sp.id;
        }
      }
      const hay = `${sh.action_desc || ''} ${sh.dialogue || ''} ${sh.voiceover || ''} ${sh.image_prompt || ''}`;
      for (const c of chars) {
        if (c?.name && hay.includes(c.name) && !ids.includes(c.id)) ids.push(c.id);
      }
      if (ids.length) {
        sh.character_ids = ids;
        const w: Record<string, number> = { ...((sh as any).character_weights || {}) };
        for (const id of ids) if (w[id] == null) w[id] = 0.8;
        (sh as any).character_weights = w;
        bound++;
      }
    }
  }
  return { boundShots: bound, totalShots: total };
}

export type { StoryboardShot };
