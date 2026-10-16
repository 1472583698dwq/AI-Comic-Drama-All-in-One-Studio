// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片 / 图片生成节点共用的素材动作：
 * 预览尺寸、上传 / 替换（≤100MB）、素材库拖入、宫格切分（→ rows×cols 个图片节点）、标记保存（→ 新图片节点并连线）。
 * 产物节点一律经 useKitNodeActions(id).createNodes 落到画布（宿主可接管撤销 / 选中），摆放照 Toonflow。
 * 坐标约定（K1 h）：spec.position 是画布绝对坐标；宫格切分按 siblingRects 的绝对矩形排版，
 * 标记产物（单个节点）不传 position，由宿主摆放（锚点在分组里也正确）。
 */
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';
import type { KitNodeActions, NewNodeSpec } from '../../kit/hostContext';
import { composeMask, gridSplit, MediaOpsError } from '../../../../services/mediaOps';
import { toast } from '../../../../stores/useDialogStore';
import {
  dragMayCarryImage, imageUrlFromDrop, loadImagePatch, mediaNodeWidth, validateImageFile, type NaturalSize,
} from './media';
import { gridSplitPositions, siblingRects, tileNodeWidth } from './layout';
import { uploadImageFile, type UploadResult } from './upload';
import type { PaintEditor } from './usePaintEditor';
import { MARK_DEFAULT_COLOR } from './usePaintEditor';

export const LOAD_IMAGE_TYPE = 'load-image';
export const IMAGE_GEN_TYPE = 'image';

export function errorText(e: unknown, fallback: string): string {
  if (e instanceof MediaOpsError) return e.message || fallback;
  const msg = (e as { message?: string } | null)?.message;
  return msg ? String(msg) : fallback;
}

export interface UseImageMediaOptions {
  id: string;
  label: string;
  url: string;
  actions: KitNodeActions;
  /** 写入新图片（上传 / 拖入 / 替换）。 */
  onImage: (url: string, meta: { source: 'upload' | 'drop'; assetId?: string }) => void;
  /** 节点忙（生成中等）时禁用上传 / 切分。 */
  busy?: boolean;
}

export function useImageMedia({ id, label, url, actions, onImage, busy }: UseImageMediaOptions) {
  const rf = useReactFlow();
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const [naturalFor, setNaturalFor] = useState('');
  const [imgError, setImgError] = useState(false);
  const [errorFor, setErrorFor] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [gridAnchor, setGridAnchor] = useState<HTMLElement | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [markSaving, setMarkSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 换图后旧尺寸 / 旧错误作废（尺寸跟着 url 走，避免闪成上一张的宽度）
  const size = naturalFor === url ? natural : null;
  const failed = errorFor === url && imgError;
  const width = url && !failed ? mediaNodeWidth(size) : undefined;

  const onLoad = useCallback((s: NaturalSize) => {
    setNatural(s);
    setNaturalFor(url);
    setImgError(false);
  }, [url]);
  const onError = useCallback(() => {
    setImgError(true);
    setErrorFor(url);
  }, [url]);

  const upload = useCallback(async (file: File | null | undefined, source: 'upload' | 'drop' = 'upload') => {
    const err = validateImageFile(file);
    if (err) { toast.error(err, '图片上传失败'); return; }
    if (uploading) return;
    setUploading(true);
    try {
      const res: UploadResult = await uploadImageFile(file!, { nodeId: id, projectId: actions.projectId });
      onImage(res.url, { source, assetId: res.assetId });
    } catch (e) {
      toast.error(errorText(e, '图片上传失败'), '图片上传失败');
    } finally {
      setUploading(false);
    }
  }, [uploading, id, actions.projectId, onImage]);

  const openFilePicker = useCallback(() => {
    if (!uploading) fileInputRef.current?.click();
  }, [uploading]);

  const onDragOver = useCallback((e: DragEvent) => {
    if (busy || uploading || !dragMayCarryImage(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  }, [busy, uploading, dragOver]);
  const onDragLeave = useCallback(() => setDragOver(false), []);
  const onDrop = useCallback((e: DragEvent) => {
    setDragOver(false);
    if (busy || uploading) return;
    const file = Array.from(e.dataTransfer.files || []).find((f) => (f.type || '').startsWith('image/'));
    const dropped = file ? '' : imageUrlFromDrop(e.dataTransfer);
    if (!file && !dropped) return; // 不是图片：交给画布处理（文本投放等）
    e.preventDefault();
    e.stopPropagation();
    if (file) void upload(file, 'drop');
    else onImage(dropped, { source: 'drop', assetId: e.dataTransfer.getData('application/canvas-assetid') || undefined });
  }, [busy, uploading, upload, onImage]);

  // —— 宫格切分 ——
  const split = useCallback(async (rows: number, cols: number) => {
    if (!url || splitting) return;
    setSplitting(true);
    try {
      const res = await gridSplit(url, rows, cols);
      const tiles = res.images || [];
      if (!tiles.length) throw new Error('切分未返回图片');
      // 绝对坐标（K1 h）：锚点在分组里时宿主换算成相对坐标，保持宫格版式
      const { anchor, others } = siblingRects(rf.getNodes() as Node[], id);
      const tileWidth = tileNodeWidth(tiles[0].width, tiles[0].height);
      const positions = anchor ? gridSplitPositions({ anchor, rows: res.rows, cols: res.cols, tileWidth, others }) : [];
      const specs: NewNodeSpec[] = tiles.map((t, i) => ({
        type: LOAD_IMAGE_TYPE,
        ...(positions[i] ? { position: positions[i] } : {}),
        data: {
          label: `${label || '图片'} · ${t.row + 1}-${t.col + 1}`,
          ...loadImagePatch(t.url),
          _origin: { op: 'grid-split', from: id, row: t.row, col: t.col, rows: res.rows, cols: res.cols },
        },
      }));
      actions.createNodes(specs, { select: false });
      setGridAnchor(null);
      toast.success(`已切分为 ${specs.length} 个图片节点`);
    } catch (e) {
      toast.error(errorText(e, '宫格切分失败'), '宫格切分失败');
    } finally {
      setSplitting(false);
    }
  }, [url, splitting, rf, id, label, actions]);

  // —— 标记保存：涂抹层 → compose-mask（单色叠加 + 描边）→ 右侧新图片节点，并从本节点 image 连到它的 in ——
  const saveMark = useCallback(async (editor: PaintEditor) => {
    if (!url || markSaving || editor.busy) return;
    editor.commitText();
    if (!editor.hasInk()) { toast.info('请先在图片上画出标记'); return; }
    const mask = editor.layerDataUrl();
    if (!mask) { toast.error('无法导出标记图层', '标记保存失败'); return; }
    setMarkSaving(true);
    editor.setBusy(true);
    try {
      const res = await composeMask(url, mask, { opacity: 0.9, color: editor.color || MARK_DEFAULT_COLOR });
      // REQ-toonflow-canvas F1：单个产物不传 position，交给宿主摆放（锚点右侧、避让同层、分组内自动换算）
      actions.createNodes(
        [{
          type: LOAD_IMAGE_TYPE,
          data: { label: `${label || '图片'} - 标记`, ...loadImagePatch(res.url), _origin: { op: 'mark', from: id } },
        }],
        { connectFrom: { nodeId: id, sourceHandle: 'image', targetHandle: 'in' }, select: false },
      );
      editor.setBusy(false);
      editor.cancel();
      toast.success('已生成标记图片节点');
    } catch (e) {
      editor.setBusy(false);
      toast.error(errorText(e, '标记保存失败'), '标记保存失败');
    } finally {
      setMarkSaving(false);
    }
  }, [url, markSaving, id, label, actions]);

  return {
    natural: size, width, failed, onLoad, onError,
    uploading, upload, openFilePicker, fileInputRef,
    dragOver, onDragOver, onDragLeave, onDrop,
    gridAnchor, setGridAnchor, splitting, split,
    markSaving, saveMark,
  };
}
