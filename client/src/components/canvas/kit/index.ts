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
  assembleInputs, assemblePrompt, assembleAudioText, autoMode, availableModes, providerVideoMode, resolveSlotCaps, toEngineArgs,
  type AssembleParams, type AssembledInputs, type CanonicalSlots, type SlotSpec,
} from './assembleInputs';
export {
  CanvasHostContext, CanvasHostProvider, useCanvasHost, useKitNodeActions,
  type CanvasHost, type KitNodeActions, type MediaKind, type NewNodeSpec, type CreateNodesOptions, createNodesLocal } from './hostContext';
export { NodeSkeleton, type NodeSkeletonProps, type SkeletonNodeProps } from './NodeSkeleton';
export { NodeHandles, cardMinHeight, connectedPortsKey, type NodeHandlesProps } from './NodeHandles';
export { FloatingToolbar, ToolbarButton, ToolbarDivider, type FloatingToolbarProps, type ToolbarButtonProps } from './FloatingToolbar';
export { PromptInput, RefAtom, type PromptInputProps } from './PromptInput';
export { stringToDoc, docToString, docJSONToString, fragmentToString, refAtomAttrs, REF_ATOM } from './promptDoc';
export { RefList, SLOT_LABELS, refTitle, type RefListProps } from './RefList';
export {
  PromptPanel, SmartPlanSwitch, ratioShapeStyle, normalizeWarnings,
  type PromptPanelProps, type GenSourceOption, type PromptWarning, type PromptWarningInput, type PromptWarningTone,
} from './PromptPanel';
export { GroupNode, groupNodeDef } from './GroupNode';
export { SelectionToolbar, type SelectionToolbarProps, type SelectionAction } from './SelectionToolbar';
export {
  GROUP_TYPE, GROUP_PADDING, GROUP_MIN_SIZE, defaultIdFactory, sizeOf, absolutePosition, ancestorsOf, boundsOf,
  selectionRoots, selectionTree, duplicateNodes, groupNodes, ungroupNodes, fitGroupBounds, arrangeNodes, reparentOnDrop,
  type ArrangeMode, type DuplicateOptions, type DuplicateResult, type GroupOptions, type Rect,
} from './graphOps';
export { Popover, MenuList, computePosition, type PopoverProps, type PopoverPlacement, type PopoverAnchor, type MenuItemSpec } from './ui/Popover';
export {
  useGeneration, useNodeGeneration, runGeneration, appendHistory, HISTORY_LIMIT, stripStaleSlotKeys, STALE_SLOT_KEYS, LEGACY_REF_AUDIO_KEYS,
  type GenKind, type GenerationHistoryItem, type RunGenerationOptions, type RunGenerationResult, type UseGeneration, type StripStaleOptions,
} from './useGeneration';
export {
  useProviderSources, useProviderDefinition, loadProviderSources, loadProviderDefinition, invalidateProviderSources,
  providerSourcesGeneration, PROVIDER_REFRESH_EVENT, type ProviderSource, type SourceKind,
} from './useProviderSources';
// K1：卡片 / 弹层内通用表单控件（.cv-ctl-*，Element Plus 外观）
export {
  KitField, KitInput, KitTextarea, KitSelect, KitButton, KitTag, KitAlert,
  type KitFieldProps, type KitInputProps, type KitTextareaProps, type KitSelectProps, type KitSelectOption, type KitButtonProps, type KitControlSize,
} from './ui/controls';
