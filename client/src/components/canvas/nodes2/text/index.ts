// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点 `prompt`：注册到 kit 节点注册表并导出。
 * 宿主（H1）在 nodes2/index.ts 引入本模块即可；执行约定见 skills.ts 与 progress/N1.md。
 */
import { IconFileText } from '@tabler/icons-react';
import { defineNode, type NodeDef } from '../../kit';
import { TEXT_NODE_PORTS, TEXT_NODE_TYPE, TEXT_NODE_WIDTH, TextNode } from './TextNode';
import type { TextNodeData } from './skills';

export const textNodeDef = defineNode<NodeDef<TextNodeData>>({
  type: TEXT_NODE_TYPE,
  label: '文本',
  icon: IconFileText,
  category: 'text',
  ports: TEXT_NODE_PORTS,
  // 正文 text / prompt 两键同步；生成指令 gen_prompt；技能缺省自由生成（不落盘，按需写 skill_id）
  defaultData: () => ({ text: '', prompt: '', gen_prompt: '' }),
  component: TextNode,
  width: TEXT_NODE_WIDTH,
  description: 'Markdown 文本：编辑 / 预览；技能生成（自由生成、扩写、剧本拆解、策划案）',
});

export { TextNode, TEXT_NODE_PORTS, TEXT_NODE_TYPE, TEXT_NODE_WIDTH } from './TextNode';
export { TextDocumentDialog, type TextDocumentDialogProps, type TextDialogMode } from './TextDocumentDialog';
export { MarkdownPreview, type MarkdownPreviewProps } from './MarkdownPreview';
export { renderMarkdownHtml } from './markdownHtml';
export {
  TEXT_SKILLS, DEFAULT_TEXT_SKILL, GEN_PROMPT_KEY, RUNNING_STALE_MS, buildSkillRequest, documentOf, documentPatch,
  isRunningState, markdownFileName, normalizeSkillId, skillOf,
  type SkillRequest, type SkillRequestInput, type TextExecuteOverrides, type TextNodeData, type TextRefSnapshot,
  type TextSkill, type TextSkillId,
} from './skills';
