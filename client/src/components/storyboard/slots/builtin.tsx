import React from 'react';
import { Film, Link2, Sparkles, Volume2 } from 'lucide-react';
import { actionRegistry, anchorRegistry, registerMode, tabRegistry } from './registry';
import { BUILTIN_MODES } from './modes';
import { CharacterAnchor, PropAnchor, SceneAnchor } from './anchors';
import { DialogueTab } from './DialogueTab';
import { MotionTab } from './MotionTab';
import { VisualTab } from './VisualTab';

/**
 * 内置 Slot 注册（P0）。
 * P1 时本文件的 register* 调用被插件 slots/*.json 加载器取代，
 * 注册表 API 与宿主渲染逻辑不变。
 */
export function registerBuiltinSlots() {
  // ---- 制作模式 ----
  for (const m of BUILTIN_MODES) registerMode(m);

  // ---- 检查器 Tab ----
  tabRegistry.register({
    id: 'visual',
    order: 10,
    icon: '🎬',
    color: 'text-violet-400',
    label: (ctx) => {
      const pm = ctx.productionMode;
      return pm === 'comic' ? '漫画画面与角色' : pm === 'motion_comic' ? '角色与运镜' : '首帧画面与角色';
    },
    render: (ctx) => <VisualTab ctx={ctx} />,
  });
  tabRegistry.register({
    id: 'dialogue',
    order: 20,
    icon: '🗣️',
    color: 'text-pink-400',
    label: (ctx) => (ctx.productionMode === 'comic' ? '气泡与对白' : '台词与配音'),
    render: (ctx) => <DialogueTab ctx={ctx} />,
  });
  tabRegistry.register({
    id: 'motion',
    order: 30,
    icon: '🎥',
    color: 'text-orange-400',
    // 漫画模式无运镜页（与原 `productionMode !== 'comic'` 条件一致）
    when: (ctx) => ctx.productionMode !== 'comic',
    label: () => '运镜动态',
    render: (ctx) => <MotionTab ctx={ctx} />,
  });

  // ---- visual 页锚点 ----
  anchorRegistry.register({
    id: 'character', order: 10, render: (ctx) => <CharacterAnchor ctx={ctx} />,
  });
  anchorRegistry.register({
    id: 'scene', order: 20, render: (ctx) => <SceneAnchor ctx={ctx} />,
  });
  anchorRegistry.register({
    id: 'prop', order: 30, render: (ctx) => <PropAnchor ctx={ctx} />,
  });

  // ---- 左栏批量操作 ----
  actionRegistry.register({
    id: 'batch-image',
    order: 10,
    when: (ctx) => ctx.productionMode !== 'motion_comic',
    render: (ctx) => (
      <button onClick={ctx.handleBatchAllImages} className="flex-1 py-1 rounded-lg bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light font-bold flex items-center justify-center gap-1 transition-all" title="对所有选中/全部镜头批量并发生成画面">
        <Sparkles className="w-3 h-3 text-brand" /> 批量生图
      </button>
    ),
  });
  actionRegistry.register({
    id: 'batch-bind',
    order: 15,
    render: (ctx) => (
      <button onClick={ctx.handleBatchBind} className="flex-1 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 font-bold flex items-center justify-center gap-1 transition-all" title="按各镜所选生成源声明，批量把人物 / 场景 / 道具 / 参考音频填入参考列表（图片源 + 视频源，仅补空缺）">
        <Link2 className="w-3 h-3 text-emerald-400" /> 批量绑定
      </button>
    ),
  });
  actionRegistry.register({
    id: 'batch-tts',
    order: 20,
    when: (ctx) => ctx.productionMode !== 'comic',
    render: (ctx) => (
      <button onClick={ctx.handleBatchAllTTS} className="flex-1 py-1 rounded-lg bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 text-pink-300 font-bold flex items-center justify-center gap-1 transition-all" title="批量合成全剧台词配音">
        <Volume2 className="w-3 h-3 text-pink-400" /> 批量配音
      </button>
    ),
  });
  actionRegistry.register({
    id: 'batch-video',
    order: 30,
    when: (ctx) => ctx.productionMode !== 'comic',
    render: (ctx) => (
      <button onClick={ctx.handleBatchAllVideos} className="flex-1 py-1 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 font-bold flex items-center justify-center gap-1 transition-all" title="批量转为动态视频">
        <Film className="w-3 h-3 text-orange-400" /> 批量视频
      </button>
    ),
  });
}
