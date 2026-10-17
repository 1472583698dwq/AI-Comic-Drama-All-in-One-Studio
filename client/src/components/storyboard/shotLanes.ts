/** 一镜三档：画面 / 视频 / 音频。缺省为开，旧镜头不用补字段。 */

export interface ShotLanes {
  image: boolean;
  video: boolean;
  audio: boolean;
}

export function lanesOf(shot: any): ShotLanes {
  const lanes = shot?.lanes || {};
  return {
    image: lanes.image !== false,
    video: lanes.video !== false,
    audio: lanes.audio !== false,
  };
}

/** pick = 单张或四张选优；grid = 一张 2×2 故事板，交给视频按格表演。 */
export function imageLayoutOf(shot: any): 'pick' | 'grid' {
  return shot?.image_layout === 'grid' ? 'grid' : 'pick';
}

export function videoUsesOf(shot: any): { grid: boolean; audio: boolean } {
  const uses = shot?.video_uses || {};
  return { grid: uses.grid === true, audio: uses.audio === true };
}

const GRID_LEAD = '生成一张 2×2 四宫格分镜，阅读顺序从左到右、从上到下。四格是同一主体的连续动作，格与格之间用细线分开，不要在格子里写大字编号。';

export function withGridPrompt(prompt: string, shot: any): string {
  if (imageLayoutOf(shot) !== 'grid' || !prompt || prompt.includes('四宫格')) return prompt;
  return `${GRID_LEAD}\n${prompt}`;
}

/** 视频提交时追加四宫格和配音的职责。refCount 是角色/场景参考已经占用的 @图片 个数。 */
export function appendVideoLinks(
  prompt: string,
  opts: { grid: boolean; frameStill: boolean; audio: boolean; refCount: number },
): string {
  const lines: string[] = [];
  let n = Math.max(0, opts.refCount) + 1;
  if (opts.grid) {
    lines.push(`@图片${n} 作为四宫格故事板，按从左到右、从上到下表演，格线不要出现在成片里`);
    n += 1;
  }
  if (opts.frameStill) lines.push(`@图片${n} 作为首帧`);
  if (opts.audio && !/@音频\d+/.test(prompt)) lines.push('@音频1 作为台词');
  return lines.length ? `${prompt}\n${lines.join('\n')}` : prompt;
}
