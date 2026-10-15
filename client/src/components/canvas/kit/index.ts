// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 节点框架 kit 公共出口（design §3）。
 * 节点作者：defineNode + NodeSkeleton + NodeHandles + PromptPanel/PromptInput/RefList + useNodeReferences + assembleInputs；
 * 宿主（H1）：nodeTypesMap / isValidConnectionFactory / CanvasHostProvider / SelectionToolbar / graphOps / theme.css（.cv-canvas）。
 */
export * from './types';
export {
  defineNode, undefineNode, getNodeDef, allNodeDefs, paletteDefs, nodeTypesMap, resolvePorts,
  findCompatiblePort, defsAcceptingFrom, defsProvidingTo, createNodeData, registryVersion, subscribeRegistry,
} from './registry';
export {
  isTypeCompatible, canConnect, findPort, isValidConnectionFactory, primaryDataType, describeDataType,
  type IsValidConnectionOptions,
} from './connection';
export {
  readOutputValue, OUTPUT_VALUE_KEYS, inferEdgeDataType, effectiveSourceHandle, buildRefs, orderRefs, refsEqual,
  remapRefTokens, moveKeys, refToken, refName, REF_TOKEN_RE, type BuildRefsOptions,
} from './references';
export {
  LEGACY_HANDLE_SLOTS, SLOT_KIND, SOURCE_HANDLE_KIND, SOURCE_TYPE_KIND, PROVIDER_MODE_BY_VIDEO_MODE,
  normalizeSlot, normalizeVideoMode, ownPromptOf, refOrderOf, refRolesOf, isRefEdge, isCameraSource, edgeKey,
  NEW_IN_PORT, PRIMARY_OUTPUT_PORT, IN_PORT_NODE_TYPES, type Kind,
} from './inputRules';
export { useNodeReferences, type NodeReferences, type UseNodeReferencesOptions } from './useNodeReferences';
export {
  assembleInputs, assemblePrompt, autoMode, availableModes, providerVideoMode, resolveSlotCaps, toEngineArgs,
  type AssembleParams, type AssembledInputs, type CanonicalSlots, type SlotSpec,
} from './assembleInputs';
export {
  CanvasHostContext, CanvasHostProvider, useCanvasHost, useKitNodeActions,
  type CanvasHost, type KitNodeActions, type MediaKind,
} from './hostContext';
export { NodeSkeleton, type NodeSkeletonProps, type SkeletonNodeProps } from './NodeSkeleton';
export { NodeHandles, cardMinHeight, connectedPortsKey, type NodeHandlesProps } from './NodeHandles';
export { FloatingToolbar, ToolbarButton, ToolbarDivider, type FloatingToolbarProps, type ToolbarButtonProps } from './FloatingToolbar';
export { PromptInput, RefAtom, type PromptInputProps } from './PromptInput';
export { stringToDoc, docToString, docJSONToString, fragmentToString, refAtomAttrs, REF_ATOM } from './promptDoc';
export { RefList, SLOT_LABELS, refTitle, type RefListProps } from './RefList';
export { PromptPanel, SmartPlanSwitch, ratioShapeStyle, type PromptPanelProps, type GenSourceOption } from './PromptPanel';
export { GroupNode, groupNodeDef } from './GroupNode';
export { SelectionToolbar, type SelectionToolbarProps, type SelectionAction } from './SelectionToolbar';
export {
  GROUP_TYPE, GROUP_PADDING, GROUP_MIN_SIZE, defaultIdFactory, sizeOf, absolutePosition, ancestorsOf, boundsOf,
  selectionRoots, selectionTree, duplicateNodes, groupNodes, ungroupNodes, fitGroupBounds, arrangeNodes, reparentOnDrop,
  type ArrangeMode, type DuplicateOptions, type DuplicateResult, type GroupOptions, type Rect,
} from './graphOps';
export { Popover, MenuList, computePosition, type PopoverProps, type PopoverPlacement, type PopoverAnchor, type MenuItemSpec } from './ui/Popover';
