// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N2：图片节点 `load-image`、图片生成节点 `image`（重合节点沿用旧类型 id，design §2/§6.1）。
 * import 本模块即完成注册（defineNode 幂等，同 type 覆盖）。端口 id 以 COORDINATION.md 第 1 条为准：
 * load-image → 输出 `image`（+ Toonflow 的来源口 `in`，标记产物从原图连进来）；image → 输入 `in`、输出 `image`。
 */
import { IconPhoto, IconPhotoAi } from '@tabler/icons-react';
import { defineNode } from '../../kit/registry';
import type { PortDef } from '../../kit/types';
import { LoadImageNode } from './LoadImageNode';
import { ImageGenNode } from './ImageGenNode';

export const LOAD_IMAGE_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: 'IMAGE', label: '来源图片' },
  { id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' },
];

export const IMAGE_GEN_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['IMAGE', 'STRING'], label: '图片、文本输入' },
  { id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' },
];

export const loadImageNodeDef = defineNode({
  type: 'load-image',
  label: '图片',
  icon: IconPhoto,
  category: 'image',
  ports: LOAD_IMAGE_PORTS,
  component: LoadImageNode,
  width: 220,
  defaultData: () => ({}),
  description: '上传或从素材库拖入图片；支持标记、局部重绘、宫格切分',
});

export const imageGenNodeDef = defineNode({
  type: 'image',
  label: '图片生成',
  icon: IconPhotoAi,
  category: 'image',
  ports: IMAGE_GEN_PORTS,
  component: ImageGenNode,
  width: 220,
  defaultData: () => ({ prompt: '', refOrder: [], refRoles: {}, smart_plan: false }),
  description: '按提示词与参考图生成图片：MiniMax 生成源、参数、智能规划、历史版本、局部重绘、宫格切分',
});

export { LoadImageNode } from './LoadImageNode';
export { ImageGenNode, promptPatch, IMAGE_PROMPT_KEYS } from './ImageGenNode';
export { setImageUploader, assetLibraryUploader, uploadImageFile, persistDataUrl, type ImageUploader, type UploadResult } from './upload';
export { gridSplitPositions, stackLeftOf, tileNodeWidth, siblingRects, type Rect } from './layout';
export { mediaNodeWidth, imageUrlOf, loadImagePatch, genImagePatch, normalizeMediaUrl, MEDIA_HEIGHT, CARD_EXTRA } from './media';
