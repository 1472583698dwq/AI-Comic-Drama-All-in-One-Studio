import { extractSlotsFromProvider } from '../canvas/providerSkills';

/** 这一镜的视频输入：用本镜画面当首帧，或用角色/场景参考直出。 */
export type VideoInputChoice = 'frame' | 'cast';

export interface VideoInputOffers {
  frame: boolean;
  cast: boolean;
}

function isFirstFrameSlot(s: { role?: string; key?: string; originalKey?: string }) {
  return s.role === 'first_frame' || /first.?frame|^first$|start.?frame/i.test(`${s.key || ''} ${s.originalKey || ''}`);
}

function isLastFrameSlot(s: { role?: string; key?: string; originalKey?: string }) {
  return s.role === 'last_frame' || /last.?frame|^last$|end.?frame/i.test(`${s.key || ''} ${s.originalKey || ''}`);
}

/** 当前视频源声明了哪些输入。没有插槽声明时两种都留，避免旧源无表可填。 */
export function providerVideoOffers(def: any): VideoInputOffers {
  const slots = extractSlotsFromProvider(def || null, 'video');
  if (!slots.length) return { frame: true, cast: true };
  const frame = slots.some(isFirstFrameSlot);
  const cast = slots.some((s) => !isFirstFrameSlot(s) && !isLastFrameSlot(s));
  if (!frame && !cast) return { frame: true, cast: true };
  return { frame, cast };
}

/** 镜头上保存的选择优先；没存过时，已有画面且源收首帧就用画面。 */
export function videoInputOf(shot: any, offers: VideoInputOffers): VideoInputChoice {
  const saved = shot?.video_input;
  if (saved === 'frame' && offers.frame) return 'frame';
  if (saved === 'cast' && offers.cast) return 'cast';
  if (offers.frame && shot?.image_url) return 'frame';
  if (offers.cast) return 'cast';
  return offers.frame ? 'frame' : 'cast';
}

/** 视频源声明了音频槽时，本镜配音才能送进这次视频请求。 */
export function providerAudioSlot(def: any): { key: string; originalKey?: string } | null {
  const slots = extractSlotsFromProvider(def || null, 'video');
  const hit = slots.find((s) => s.type === 'audio' || /audio|voice/i.test(`${s.key || ''} ${s.originalKey || ''} ${s.role || ''}`));
  if (!hit) return null;
  return { key: hit.key, originalKey: hit.originalKey };
}
