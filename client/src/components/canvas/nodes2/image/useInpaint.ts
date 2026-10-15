// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 局部重绘执行（图片节点、图片生成节点共用，Toonflow imageEditor.generate 的 MiniMax 版）：
 *   涂抹层 → compose-mask 引导图 → useGeneration（kind:image，参考图 = 原图 + 引导图 + 用户参考）
 *   → 浏览器端按涂抹蒙版贴回原图并落盘 → 写回当前图片，新图进入历史版本（原图保留在历史里可切回）。
 */
import { useCallback, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { KitNodeActions } from '../../kit/hostContext';
import type { UseGeneration } from '../../kit/useGeneration';
import type { HistoryEntry, RefItem } from '../../kit/types';
import type { AssetSlotDef } from '../../providerSkills';
import type { ControlSpec } from '../../controls/DynamicControl';
import { composeMask } from '../../../../services/mediaOps';
import { toast } from '../../../../stores/useDialogStore';
import { assembleInpaint, compositeInpaint, inpaintBlockedReason, INPAINT_COLOR, INPAINT_OPACITY } from './inpaint';
import { closestRatioOption, effectiveParams } from './imageParams';
import { agentError, generationData, generationLanded } from './generation';
import { genImagePatch, loadImagePatch, type NaturalSize } from './media';
import { historyOf, withCurrent } from './HistoryStrip';
import { persistDataUrl } from './upload';
import { errorText } from './useImageMedia';
import type { PaintEditor } from './usePaintEditor';

export interface UseInpaintOptions {
  id: string;
  /** load-image 写三键；image 写 image_url + result_url。 */
  kind: 'load-image' | 'image';
  url: string;
  data: Record<string, unknown>;
  editor: PaintEditor;
  gen: UseGeneration;
  actions: KitNodeActions;
  providerId: string;
  params: Record<string, unknown>;
  model?: string;
  slots: AssetSlotDef[] | null;
  ratioSpec?: ControlSpec;
  natural: NaturalSize | null;
  refs?: readonly RefItem[];
  refRoles?: Record<string, string> | null;
  prompt: string;
}

export function useInpaint(o: UseInpaintOptions) {
  const rf = useReactFlow();
  const [inpainting, setInpainting] = useState(false);
  const cancelled = useRef(false);
  const optsRef = useRef(o);
  optsRef.current = o;

  const run = useCallback(async () => {
    const { id, kind, url, data, editor, gen, actions, providerId, params, model, slots, ratioSpec, natural, refs, refRoles, prompt } = optsRef.current;
    if (!url || inpainting || gen.running) return;
    if (!providerId) { toast.info('局部重绘需要先选择一个图片生成源'); return; }
    if (!prompt.trim()) { toast.info('请描述涂抹区域要改成什么'); return; }
    editor.commitText();
    if (!editor.hasInk()) { toast.info('请先涂抹需要重绘的区域'); return; }
    const mask = editor.layerDataUrl();
    const layer = editor.cloneLayer();
    if (!mask || !layer) { toast.error('无法导出涂抹区域', '局部重绘失败'); return; }

    cancelled.current = false;
    setInpainting(true);
    editor.setBusy(true);
    try {
      const guide = await composeMask(url, mask, { opacity: INPAINT_OPACITY, color: INPAINT_COLOR });
      if (cancelled.current) return;
      const assembled = assembleInpaint({ sourceUrl: url, guideUrl: guide.url, refs, prompt, refRoles, slots });
      const blocked = inpaintBlockedReason(assembled);
      if (blocked) throw new Error(blocked);
      // 输出比例跟随原图（贴回原图时按原图尺寸拉伸，比例不同会变形）
      const runParams = effectiveParams(params);
      const near = natural && ratioSpec ? closestRatioOption(ratioSpec, natural.width / natural.height) : undefined;
      if (near && ratioSpec) runParams[ratioSpec.param_name] = near;
      const seeded: HistoryEntry[] = withCurrent(historyOf(data), url);
      const res = await gen.run({
        nodeType: 'image',
        kind: 'image',
        data: generationData({ ...data, history: seeded }, slots, runParams, model ? { model } : {}),
        assembled,
        providerId,
        params: runParams,
        smartPlan: false,
      });
      if (!generationLanded(res)) {
        if (!cancelled.current) {
          // 失败态由执行器写进 agent_state（受控画布下一帧才落到 store），读一帧后再提示
          window.setTimeout(() => {
            const err = agentError((rf.getNode(id)?.data as Record<string, unknown> | undefined)?.agent_state) || '生成未返回结果';
            toast.error(err, '局部重绘失败');
          }, 0);
        }
        return;
      }
      let finalUrl = res.url;
      let dims: { width: number; height: number } | null = null;
      try {
        const c = await compositeInpaint(url, res.url, layer);
        finalUrl = await persistDataUrl(c.dataUrl);
        dims = { width: c.width, height: c.height };
      } catch (e) {
        toast.warning(`未能按涂抹区域贴回原图（${errorText(e, '合成失败')}），已直接使用生成结果`, '局部重绘');
      }
      // 生成结果已由 runGeneration 落进 image_url / history：此后不再理会「停止」，必须把三键与历史写成一致
      const history = (res.patch.history as HistoryEntry[]).map((h) => (h.url === res.url ? { ...h, url: finalUrl } : h));
      actions.update({
        ...(kind === 'load-image' ? { ...loadImagePatch(finalUrl), asset_id: undefined } : genImagePatch(finalUrl, data)),
        history,
        ...(dims ? dims : {}),
      });
      editor.cancel();
      toast.success('局部重绘完成，原图保留在历史版本里');
    } catch (e) {
      if (!cancelled.current) toast.error(errorText(e, '局部重绘失败'), '局部重绘失败');
    } finally {
      setInpainting(false);
      editor.setBusy(false);
    }
  }, [inpainting, rf]);

  const stop = useCallback(() => {
    cancelled.current = true;
    optsRef.current.gen.cancel();
    setInpainting(false);
    optsRef.current.editor.setBusy(false);
  }, []);

  return { inpainting, run, stop };
}
