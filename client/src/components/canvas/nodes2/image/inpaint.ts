// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 局部重绘（照 Toonflow nodeScaffold/components/imageEditor.vue 的 generate）：
 *   1. 涂抹层 → mediaOps.composeMask → 区域引导图（原图 + 半透明红色涂抹 + 描边）；
 *   2. 参考图 = [原图, 引导图, ...用户参考]，提示词 = 重绘说明 + 用户要求，经 assembleInputs 按所选生成源组装；
 *   3. 生成结果按涂抹蒙版贴回原图（区域外像素严格保留）—— 浏览器端合成，失败时退回直接使用生成结果。
 */
import { assembleInputs, type AssembledInputs, type SlotSpec } from '../../kit/assembleInputs';
import { REF_TOKEN_RE, refToken } from '../../kit/references';
import type { RefItem } from '../../kit/types';
import { resolveMediaUrl } from '../../../../utils/devOrigin';

/** 合成前两张参考图的 key（不会和真实 edgeKey `源id|口` 冲突）。 */
export const INPAINT_SOURCE_KEY = '__inpaint__|source';
export const INPAINT_GUIDE_KEY = '__inpaint__|guide';
/** 涂抹色 / 引导图叠色（Toonflow #ff4545、55%）。 */
export const INPAINT_COLOR = '#ff4545';
export const INPAINT_OPACITY = 0.55;

/** Toonflow 的重绘说明（改为按参考图序号描述，和 assembleInputs 的「参考编号对应」口径一致）。 */
export const INPAINT_INSTRUCTION =
  '对第 1 张参考图（原图）进行局部重绘。第 2 张参考图是区域引导图，其中的红色涂抹标出需要修改的区域，红色只是区域指示，不要把标记画进结果。'
  + '保持原图构图、尺寸比例和区域外内容，只根据以下要求修改涂抹区域，返回完整图片：';

/** 用户提示词里的 `{{ref N}}` 整体后移 by 位（前面插入了原图与引导图）。 */
export function shiftRefTokens(text: string, by: number): string {
  if (!text || !by) return text;
  return text.replace(REF_TOKEN_RE, (_w, n: string) => refToken(Number(n) + by));
}

/** 原图 / 引导图两条合成参考（排在用户参考之前，按生成源 maxItems 截断时最后才会被截）。 */
export function inpaintRefs(sourceUrl: string, guideUrl: string): RefItem[] {
  return [
    { key: INPAINT_SOURCE_KEY, sourceId: '__inpaint__', sourceHandle: 'source', dataType: 'IMAGE', value: sourceUrl, label: '原图', thumb: sourceUrl },
    { key: INPAINT_GUIDE_KEY, sourceId: '__inpaint__', sourceHandle: 'guide', dataType: 'IMAGE', value: guideUrl, label: '区域引导图', thumb: guideUrl },
  ];
}

export interface InpaintAssembleParams {
  sourceUrl: string;
  guideUrl: string;
  /** 节点自己的参考（图片生成节点有；图片节点为空）。 */
  refs?: readonly RefItem[];
  /** 用户的重绘要求（可含 `{{ref N}}`，N 指 refs）。 */
  prompt: string;
  refRoles?: Record<string, string> | null;
  slots?: readonly SlotSpec[] | null;
}

/** 局部重绘的组装结果（与普通生成同一个 assembleInputs，目标类型 image → 全部进参考图）。 */
export function assembleInpaint(p: InpaintAssembleParams): AssembledInputs {
  const userPrompt = shiftRefTokens((p.prompt || '').trim(), 2);
  return assembleInputs({
    refs: [...inpaintRefs(p.sourceUrl, p.guideUrl), ...(p.refs || [])],
    targetType: 'image',
    prompt: `${INPAINT_INSTRUCTION}\n${userPrompt}`,
    refRoles: p.refRoles ?? null,
    slots: p.slots ?? null,
  });
}

/** 生成源的图片参考上限 < 2 时无法局部重绘（放不下原图 + 引导图）。 */
export function inpaintBlockedReason(assembled: AssembledInputs): string | null {
  const src = assembled.assignments[INPAINT_SOURCE_KEY];
  const guide = assembled.assignments[INPAINT_GUIDE_KEY];
  if (src && guide) return null;
  return src ? '当前生成源只能接收 1 张参考图，局部重绘需要原图 + 区域引导图两张' : '当前生成源不支持参考图，无法局部重绘';
}

/** 以匿名 CORS 加载图片（后端 /storage 带 Access-Control-Allow-Origin，画布不会被污染）。 */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = resolveMediaUrl(url);
  });
}

/**
 * 把生成结果按涂抹蒙版贴回原图（Toonflow：generated → destination-in 涂抹层 → destination-over 原图）。
 * layer 是与原图同尺寸的涂抹层（不透明度不影响，alpha>0 即重绘区）。返回 PNG dataURL；跨域污染等失败时抛错。
 */
export async function compositeInpaint(sourceUrl: string, generatedUrl: string, layer: HTMLCanvasElement): Promise<{ dataUrl: string; width: number; height: number }> {
  const [src, gen] = await Promise.all([loadImage(sourceUrl), loadImage(generatedUrl)]);
  const width = src.naturalWidth;
  const height = src.naturalHeight;
  if (!width || !height) throw new Error('原图尺寸无效');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建合成画布');
  try {
    ctx.drawImage(gen, 0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(layer, 0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(src, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL('image/png'), width, height };
  } finally {
    canvas.width = canvas.height = 0;
  }
}
