/**
 * 「选参考 / 添加到输入」→ 画布输入卡片。
 *
 * 节点控制台（NodeAgentConsole / NodeAgentBar）只持有 canvas store，拿不到 React Flow 的 setNodes/setEdges，
 * 所以统一派发事件，由 CreativeCanvas 放卡片 + 连线（放置规则见 autoLayout.ts）。
 * 插槽值本身仍由控制台照常写入目标节点，事件只负责「让画布上看得见输入了什么」。
 */

export interface InputItem {
  url: string;
  /** 来自画布上某卡片的产出：直接连那张卡，不再新建 */
  sourceNodeId?: string;
  /** 该资源在来源卡片上的键（image/video/audio 为产出；first_frame 等为那张卡自己的输入） */
  sourceSlotKey?: string;
}

export interface AttachInputsDetail {
  targetId: string;
  /** 插槽键（归一 key），优先作为目标句柄 id */
  slotKey: string;
  mediaType: 'image' | 'video' | 'audio';
  /** 多值插槽（参考集）：追加；单值插槽：替换原有输入 */
  multi: boolean;
  items: InputItem[];
  /** 该插槽写入后的完整取值：不在其中的旧输入卡/连线（如超出 maxCount 被挤掉的）一并清理 */
  keep?: string[];
}

export interface DetachInputDetail {
  targetId: string;
  slotKey: string;
  mediaType: 'image' | 'video' | 'audio';
}

export const ATTACH_EVENT = 'canvas-attach-inputs';
export const DETACH_EVENT = 'canvas-detach-input';

/** 由选择器回传的 URL 列表 + 每项来源元数据组装输入项 */
export function toInputItems(urls: string[], metas?: Record<string, any>): InputItem[] {
  return urls.filter(Boolean).map((url) => {
    const m = metas?.[url];
    return m?.sourceNodeId ? { url, sourceNodeId: m.sourceNodeId, sourceSlotKey: m.slotKey } : { url };
  });
}

export function emitAttachInputs(detail: AttachInputsDetail) {
  if (!detail.items.length) return;
  window.dispatchEvent(new CustomEvent(ATTACH_EVENT, { detail }));
}

export function emitDetachInput(detail: DetachInputDetail) {
  window.dispatchEvent(new CustomEvent(DETACH_EVENT, { detail }));
}
