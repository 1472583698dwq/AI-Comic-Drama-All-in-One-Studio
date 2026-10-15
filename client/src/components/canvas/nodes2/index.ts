// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1：新节点注册汇总。宿主（CreativeCanvas）import 本文件即把全部 kit 节点注册进注册表
 * （nodeTypesMap / paletteDefs / 拖线菜单都从注册表生成）。import 顺序 = 工具栏顺序。
 * kit 自带的分组节点 `group` 在 kit/GroupNode 里注册（任何 kit 导入都会带上）。
 */
import '../kit';
import './text';
import './image';
import './video';
import './audio';
import './director3d';
import './legacy-a';
import './legacy-b';

/** 本目录注册的节点类型（不含 kit 的 group），供宿主 / 测试核对。 */
export const NODES2_TYPES = [
  'prompt', 'load-image', 'image', 'load-video', 'video', 'load-audio', 'audio', 'director3d',
  'shot-card', 'comfy-workflow', 'timeline', 'timeline-export', 'export',
  'brief', 'script-split', 'custom', 'ext-node', 'provider', 'provider-image', 'provider-video', 'provider-audio', 'provider-llm',
] as const;
