// -*- coding: utf-8 -*-
/**
 * REQ 素材节点（asset-source）：从素材库挑素材并作为画布来源节点。
 * import 本模块即完成注册；宿主（CreativeCanvas 经 nodes2/index.ts）无需额外改动即出现在「节点」工具栏。
 */
import { IconFolderOpen } from '@tabler/icons-react';
import { defineNode } from '../../kit/registry';
import type { PortDef } from '../../kit/types';
import { AssetSourceNode } from './AssetSourceNode';
import { ASSET_SOURCE_TYPE, assetSourceOutputValue } from './pick';

/** 唯一输出口 `out`（`*`：可连图片 / 视频 / 文本节点的输入口），类型由所选素材决定。 */
export const ASSET_SOURCE_PORTS: PortDef[] = [
  { id: 'out', type: 'source', dataType: '*', label: '素材输出' },
];

export const assetSourceNodeDef = defineNode({
  type: ASSET_SOURCE_TYPE,
  label: '素材',
  icon: IconFolderOpen,
  category: 'tool',
  ports: ASSET_SOURCE_PORTS,
  component: AssetSourceNode,
  width: 240,
  defaultData: () => ({}),
  outputValue: assetSourceOutputValue,
  description: '从素材库选择图片 / 视频 / 音频 / 文本，连线到生成节点即加入其参考 / 参数',
});

export { AssetSourceNode } from './AssetSourceNode';
export {
  ASSET_SOURCE_TYPE, ASSET_SOURCE_KIND_LABELS, assetSourceKindOf, assetSourcePatch, assetSourcePreviewOf, assetSourceOutputValue,
  type AssetSourceKind, type AssetSourcePick,
} from './pick';
