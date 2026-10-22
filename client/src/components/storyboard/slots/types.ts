import type React from 'react';
import type { Project, StoryboardShot } from '../../../types';

/**
 * 分镜台 Slot 契约（P0：内部拆分，零行为变化）。
 *
 * 宿主（ShotInspector）拥有全部状态与 handler，只组装一个 ShotSlotContext
 * 往下传；各 Slot 为纯展示组件，经 registry 按 order/when 渲染。
 * P1 时 registry 的注册来源从 builtin.ts 换成插件 slots/*.json，
 * ShotSlotContext 即插件槽函数的入参原型。
 */

export type ProductionMode = 'comic' | 'motion_comic' | 'image_to_video';
export type InspectorTabId = string;
export type PreviewTabId = 'image' | 'video';
export type VideoMode = 'i2v' | 'r2v' | 't2v';

/** 素材选择弹窗配置（与宿主 useState 同构，供 updater 具名类型） */
export interface AssetPickerConfig {
  isOpen: boolean;
  title: string;
  category: any;
  onSelect: (asset: any) => void;
}

/** 制作模式能力位：所有按 productionMode 分支的条件收敛到这里 */
export interface ModeCaps {
  /** 可生图（visual 页生图表单、批量生图、R 键） */
  canImage: boolean;
  /** 可生成视频（运镜页、批量视频、V 键、模式动作栏视频按钮） */
  canVideo: boolean;
  /** 可配音（语音源表单、试听、批量配音、T 键） */
  canTts: boolean;
  /** 直出 r2v 流：角色立绘直驱视频，跳过首帧 */
  direct: boolean;
  /** 图生流：视频需要先有首帧 */
  needsFirstFrame: boolean;
  /** 预览锁定：漫画锁图、直出锁视频，null 表示可切 */
  lockPreview: PreviewTabId | null;
}

export interface ModeDef {
  id: ProductionMode;
  label: string;
  desc: string;
  order: number;
  caps: ModeCaps;
  /** 检查器标题（右栏头） */
  inspectorTitle: string;
}

export interface TabDef {
  id: string;
  order: number;
  /** 可见性，默认全可见 */
  when?: (ctx: ShotSlotContext) => boolean;
  label: (ctx: ShotSlotContext) => string;
  icon: string;
  color: string;
  render: (ctx: ShotSlotContext) => React.ReactNode;
}

export interface AnchorDef {
  id: string;
  order: number;
  when?: (ctx: ShotSlotContext) => boolean;
  render: (ctx: ShotSlotContext) => React.ReactNode;
}

export interface ActionDef {
  id: string;
  order: number;
  /** 批量操作栏按钮（左栏头） */
  when?: (ctx: ShotSlotContext) => boolean;
  render: (ctx: ShotSlotContext) => React.ReactNode;
}

/** 队列项（左栏底部渲染流水线） */
export interface ShotQueueItem {
  id: string;
  type: 'image' | 'video' | 'audio';
  status: 'queued' | 'running' | 'done' | 'error';
}

/**
 * Slot 上下文：宿主全部状态与 handler 的只读投影。
 * 约定：只增字段不改名；P1 插件槽按此接口拿数（只读）+ 调 action。
 */
export interface ShotSlotContext {
  // ---- 项目与分镜 ----
  project: Project | null;
  shots: StoryboardShot[];
  activeShot: StoryboardShot;
  // ---- store actions ----
  setActiveShotId: (id: string | null) => void;
  updateShot: (shotId: string, updates: any) => void;
  addShot: (sceneIndex?: number, afterShotId?: string) => void;
  duplicateShot: (shotId: string) => void;
  deleteShot: (shotId: string) => void;
  setActiveTab: (tab: any) => void;
  setWorkspace: (w: 'production' | 'creative') => void;
  generateShotVideo: (shotId: string, options?: any) => Promise<void>;
  bindCharacterToShot: (shotId: string, charId: string) => void;
  unbindCharacterFromShot: (shotId: string, charId: string) => void;
  setCharacterWeight: (shotId: string, charId: string, weight: number) => void;
  bindSceneToShot: (shotId: string, sceneAsset: any) => void;
  unbindSceneFromShot: (shotId: string) => void;
  bindPropToShot: (shotId: string, propAsset: any) => void;
  synthesizeShotPrompt: (shotId: string) => void;
  selectCandidate: (shotId: string, candidateIndex: number) => void;
  autoFitShotDuration: (shotId: string, padding?: number) => void;
  // ---- 宿主 UI 状态 ----
  previewTab: PreviewTabId;
  setPreviewTab: (t: PreviewTabId) => void;
  effectivePreviewTab: PreviewTabId;
  previewAspect: string;
  inspectorTab: string;
  setInspectorTab: (t: string) => void;
  productionMode: ProductionMode;
  setProductionMode: (m: ProductionMode) => void;
  isPlayingAudio: boolean;
  isRegenerating: boolean;
  isGeneratingVid: boolean;
  candidateCount: 1 | 4;
  setCandidateCount: (c: 1 | 4) => void;
  videoMode: VideoMode;
  setVideoMode: (m: VideoMode) => void;
  videoProvider: string;
  setVideoProvider: (pid: string, def?: any) => void;
  videoProviderDef: any;
  videoProviderParams: Record<string, any>;
  setVideoProviderParams: (next: Record<string, any>) => void;
  imageProvider: string;
  setImageProvider: (pid: string, def?: any) => void;
  imageProviderDef: any;
  imageProviderParams: Record<string, any>;
  setImageProviderParams: (next: Record<string, any>) => void;
  audioProvider: string;
  setAudioProvider: (pid: string, def?: any) => void;
  audioProviderDef: any;
  audioProviderParams: Record<string, any>;
  setAudioProviderParams: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  audioEmotionKey: string;
  healthMap: Record<string, any>;
  batchSelected: Set<string>;
  setBatchSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  queue: ShotQueueItem[];
  ttsError: string | null;
  regenError: string | null;
  videoError: string | null;
  videoSuccess: boolean;
  autoFitNotification: string | null;
  uploadingInputKey: string | null;
  savingAsset: boolean;
  shotDynamicInputs: Record<string, any>;
  setShotDynamicInputs: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  showHotkeysHint: boolean;
  setShowHotkeysHint: (v: boolean) => void;
  inspectingWorkflowId: string;
  setInspectingWorkflowId: (id: string) => void;
  slotPicker: { slot: any; writeKeys: string[]; multi: boolean; replaceIndex?: number } | null;
  setSlotPicker: (v: { slot: any; writeKeys: string[]; multi: boolean; replaceIndex?: number } | null) => void;
  assetPickerConfig: AssetPickerConfig;
  setAssetPickerConfig: React.Dispatch<React.SetStateAction<AssetPickerConfig>>;
  ctxMenu: { x: number; y: number; shotId: string } | null;
  setCtxMenu: (v: { x: number; y: number; shotId: string } | null) => void;
  ctxCanvases: Array<{ id: string; name: string; node_count: number }>;
  ctxLoadingCanvas: boolean;
  // ---- 宿主 handlers ----
  handlePlayTTS: () => void;
  handleRegenerateImage: (customCount?: number) => void;
  handleGenerateVideo: () => void;
  /** 把上一镜的视频尾帧（没有视频时用它的画面）写成本镜首帧 */
  carryPreviousFrame: () => Promise<void>;
  /** 进入下一镜且当前镜没有画面时，自动承接上一镜尾帧/画面 */
  autoCarryPreviousFrame: boolean;
  setAutoCarryPreviousFrame: (enabled: boolean) => void;
  handleBatchAllImages: () => void;
  handleBatchAllTTS: () => void;
  handleBatchAllVideos: () => void;
  /** 一键绑定：按所选源声明的插槽，把人物/场景/道具/参考音频填入参考列表 */
  handleOneClickBind: (kind: 'image' | 'video') => void;
  /** 批量一键绑定（选中镜头/全部；图片源 + 视频源各按自身声明） */
  handleBatchBind: () => void;
  hasBindUndo: boolean;
  undoLastBind: () => void;
  handleSaveShotToAsset: (kind: 'image' | 'video') => void;
  sendShotToCanvas: (shot: any, opts: { mode: 'new' | 'existing'; canvas_id?: string }) => void;
  openShotCtxMenu: (e: React.MouseEvent, shot: any) => void;
  setSlotValue: (writeKeys: string[], value: any) => void;
  handleSlotUploadFile: (writeKeys: string[], file: File | File[], multi: boolean, maxCount?: number) => void;
  injectCharacterToSlot: (writeKeys: string[], multi: boolean) => void;
  pickAssetForSlot: (slot: any, writeKeys: string[], multi: boolean, replaceIndex?: number) => void;
  handleSlotPicked: (urlOrUrls: string | string[], meta?: any) => void;
  resolveRenderSlots: (def: any, kind: 'image' | 'video' | 'audio') => any[];
  keepDeclaredOnly: (def: any, values: Record<string, any>) => Record<string, any>;
  shotBatchInputs: (sh: any, kind: 'image' | 'video') => Record<string, any> | undefined;
  probeProvider: (pid: string) => void;
  refreshSourceDefs: () => void;
  loadProjectAssets: () => void;
  getMediaUrl: (url?: string | null) => string;
  /** 打开槽管理弹窗（P1：启停/排序/造新槽） */
  openSlotManager: () => void;
}
