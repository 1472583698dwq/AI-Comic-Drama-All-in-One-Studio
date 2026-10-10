import React from 'react';
import { AgentChatDrawer } from '../../components/agent/AgentChatDrawer';
import { ContextTipCard } from '../../components/onboarding/ContextTipCard';
import { GlobalAiPolish } from '../../components/ui/GlobalAiPolish';
import { useProjectStore } from '../../stores/useProjectStore';
import { register } from '../registry';
import { useResolvedTab } from '../useResolvedTab';
import { APP_HOST, MAIN_TIPS_HOST, markAttrs } from '../types';

/**
 * 三个**呈现型**可插拔面（Phase 3，全部 `scope: 'prefs'` —— 只管本机界面，不碰后端能力）：
 *
 *   · `main.tips` 槽：两张上下文引导卡（画布首进 / 分镜台首进），挂载点在 `main` 内，
 *     这样卡片原有的 `absolute top-16 right-3` 依然相对内容区定位（挂到 app 槽会改定位基准）；
 *   · `app` 槽：悬浮 AI 导演抽屉（设计 Q4：prefs 层 + **保留**「画布 / 导演页不显示」闸门）；
 *   · `app` 槽：全局 AI 润色（老实现，靠 document 级 focusin 触发；关掉 = 整条不挂载，
 *     监听器随之卸载，不做「暗中还在监听」的半关状态）。
 *
 * 为什么不把它们的「条件」写进注册表开关：这些条件是**运行时状态**（有没有项目、当前在哪一页、
 * 桌面还是移动），注册表开关只表达「用户要不要这块界面」（设计 §2.4-1：开关只管存在性）。
 */

/**
 * 引导卡（画布）：无项目或不在画布页 → 不渲染（与改造前 App.tsx 的条件逐条一致）。
 * `markProps`：`main.tips` 宿主不给包裹层（卡片是 `absolute`，套静态层高度为 0，描边会退化，审查 M3），
 * 所以标注属性注入到卡片自己的根元素上。
 */
export const CanvasTipEntry: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const platformMode = useProjectStore((s) => s.platformMode);
  const resolvedTab = useResolvedTab();
  if (!project || resolvedTab !== 'canvas') return null;
  void platformMode;
  return (
    <ContextTipCard
      storageKey="canvas_first"
      title="画布这样玩"
      desc="按住节点右侧圆点拖到下一个节点即连线；选中生图 / 视频 / 配音节点，底部会弹出它的 Agent 控制台，用一句大白话描述你要什么即可。"
      markProps={markAttrs({ id: 'tip.canvas-first', kind: 'panel', scope: 'prefs', source: 'builtin' })}
    />
  );
};

/** 引导卡（分镜台 / 多轨剪辑，仅桌面模式） */
export const StudioTipEntry: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const platformMode = useProjectStore((s) => s.platformMode);
  const resolvedTab = useResolvedTab();
  if (!project || platformMode !== 'desktop') return null;
  if (resolvedTab !== 'studio' && resolvedTab !== 'timeline') return null;
  return (
    <ContextTipCard
      storageKey="studio_first"
      title="分镜台这样用"
      desc="先用顶栏「导入」粘贴小说章节，AI 会自动拆分镜；选中镜头后可在检查器里生成首帧 / 视频 / 配音，底部时间线控制整体节奏。"
      markProps={markAttrs({ id: 'tip.studio-first', kind: 'panel', scope: 'prefs', source: 'builtin' })}
    />
  );
};

/**
 * 悬浮 AI 导演抽屉。
 * 改造前的闸门（**保留**，Q4）：有项目 ∧ 当前页既不是画布（画布有专属右侧 Agent 侧栏）
 * 也不是 AI 导演页（那一页本身就是全屏 Agent）。
 * `key={project.id}` 也保留：切项目即重建会话侧栏，避免串到上一个项目的会话。
 */
export const AgentDrawerEntry: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const resolvedTab = useResolvedTab();
  if (!project || !resolvedTab) return null;
  if (resolvedTab === 'canvas' || resolvedTab === 'agent') return null;
  // markProps 落在组件自己的 fixed 触发胶囊上（app 宿主不给包裹层，审查 M3）
  return <AgentChatDrawer key={project.id} markProps={markAttrs({ id: 'panel.agent-drawer', kind: 'panel', scope: 'prefs', source: 'builtin' })} />;
};

/** 全局 AI 润色（无条件常驻，直到用户在 UI 偏好里关掉） */
export const AiPolishEntry: React.FC = () => (
  <GlobalAiPolish markProps={markAttrs({ id: 'panel.ai-polish', kind: 'panel', scope: 'prefs', source: 'builtin' })} />
);

function registerPanelEntries(): Array<() => void> {
  return [
    register({
      id: 'tip.canvas-first',
      kind: 'panel',
      host: MAIN_TIPS_HOST,
      order: 10,
      scope: 'prefs',
      switchId: 'tip_context',
      source: 'builtin',
      render: CanvasTipEntry,
    }),
    register({
      id: 'tip.studio-first',
      kind: 'panel',
      host: MAIN_TIPS_HOST,
      order: 20,
      scope: 'prefs',
      switchId: 'tip_context',
      source: 'builtin',
      render: StudioTipEntry,
    }),
    register({
      id: 'panel.agent-drawer',
      kind: 'panel',
      host: APP_HOST,
      order: 110,
      scope: 'prefs',
      switchId: 'panel_agent_drawer',
      source: 'builtin',
      render: AgentDrawerEntry,
    }),
    register({
      id: 'panel.ai-polish',
      kind: 'panel',
      host: APP_HOST,
      order: 120,
      scope: 'prefs',
      switchId: 'panel_ai_polish',
      source: 'builtin',
      render: AiPolishEntry,
    }),
  ];
}

registerPanelEntries();
