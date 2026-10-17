import React from 'react';
import { Film, Link2, Sparkles, Volume2 } from 'lucide-react';
import { registerMode } from './registry';
import { registerSlotEntry } from '../../../ui-registry/adapters/storyboardSlots';
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

  // ---- 检查器 Tab（注册进 UIRegistry：host=studio.slot.tabs，source=builtin） ----
  registerSlotEntry('tabs', {
    id: 'visual',
    order: 10,
    icon: '🎬',
    color: 'text-violet-400',
    label: () => '画面',
    render: (ctx) => <VisualTab ctx={ctx} />,
  }, 'builtin');
  registerSlotEntry('tabs', {
    id: 'dialogue',
    order: 20,
    icon: '🗣️',
    color: 'text-pink-400',
    label: () => '台词',
    render: (ctx) => <DialogueTab ctx={ctx} />,
  }, 'builtin');
  registerSlotEntry('tabs', {
    id: 'motion',
    order: 30,
    icon: '🎥',
    color: 'text-orange-400',
    label: () => '视频',
    render: (ctx) => <MotionTab ctx={ctx} />,
  }, 'builtin');

  // ---- visual 页锚点 ----
  registerSlotEntry('anchors', {
    id: 'character', order: 10, render: (ctx) => <CharacterAnchor ctx={ctx} />,
  }, 'builtin');
  registerSlotEntry('anchors', {
    id: 'scene', order: 20, render: (ctx) => <SceneAnchor ctx={ctx} />,
  }, 'builtin');
  registerSlotEntry('anchors', {
    id: 'prop', order: 30, render: (ctx) => <PropAnchor ctx={ctx} />,
  }, 'builtin');

  // ---- 左栏批量操作 ----
  registerSlotEntry('actions', {
    id: 'batch-image',
    order: 10,
    render: (ctx) => (
      <button onClick={ctx.handleBatchAllImages} className="flex-1 py-1 rounded-lg bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light font-bold flex items-center justify-center gap-1 transition-all" title="对所有选中/全部镜头批量并发生成画面">
        <Sparkles className="w-3 h-3 text-brand" /> 批量生图
      </button>
    ),
  }, 'builtin');
  registerSlotEntry('actions', {
    id: 'batch-bind',
    order: 15,
    render: (ctx) => (
      <button onClick={ctx.handleBatchBind} className="flex-1 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 font-bold flex items-center justify-center gap-1 transition-all" title="把人物 / 场景 / 道具 / 参考音频批量填入各镜头（按所选生成源声明，仅补空缺）">
        <Link2 className="w-3 h-3 text-emerald-400" /> 批量绑定参考
      </button>
    ),
  }, 'builtin');
  registerSlotEntry('actions', {
    id: 'batch-tts',
    order: 20,
    render: (ctx) => (
      <button onClick={ctx.handleBatchAllTTS} className="flex-1 py-1 rounded-lg bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 text-pink-300 font-bold flex items-center justify-center gap-1 transition-all" title="批量合成全剧台词配音">
        <Volume2 className="w-3 h-3 text-pink-400" /> 批量配音
      </button>
    ),
  }, 'builtin');
  registerSlotEntry('actions', {
    id: 'batch-video',
    order: 30,
    render: (ctx) => (
      <button onClick={ctx.handleBatchAllVideos} className="flex-1 py-1 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 font-bold flex items-center justify-center gap-1 transition-all" title="为选中 / 全部镜头批量生成动态视频（按各镜保存的视频输入）">
        <Film className="w-3 h-3 text-orange-400" /> 批量生视频
      </button>
    ),
  }, 'builtin');
}
