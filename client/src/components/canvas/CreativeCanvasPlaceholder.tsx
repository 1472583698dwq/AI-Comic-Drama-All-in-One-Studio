import React from 'react';
import { Sparkles } from 'lucide-react';

export const CreativeCanvasPlaceholder: React.FC = () => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-background p-8 text-center space-y-4">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-pink to-brand flex items-center justify-center text-3xl shadow-xl">🎨</div>
      <h2 className="text-lg font-bold text-white flex items-center gap-2"><Sparkles className="w-5 h-5 text-accent-pink"/> 创意设计 · 无限画布</h2>
      <p className="text-xs text-gray-400 max-w-lg">P1 将上线基于 tldraw 的自由画布，支持 13类节点（分镜卡/ComfyUI工作流/生图/生视频/TTS/3D导演/Agent/Skill等）+ 动态端口 + DAG 执行 + 画布感知 Agent。当前可先在「漫剧制作」完成项目管理与素材隔离。</p>
      <div className="text-[11px] text-gray-500 bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-4 py-3 max-w-lg text-left leading-relaxed">
        <div className="font-semibold text-gray-300 mb-1">即将上线（P1 2周）：</div>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>自由排布 + 贝塞尔连线 + 小地图 + 演示</li>
          <li>ComfyUI 工作流节点（暴露输入自动成端口，复用 WorkflowInspectorModal）</li>
          <li>分镜/角色/生图/视频/TTS/3D/资产/Agent/Skill 节点</li>
          <li>一键「生成分镜序列」打通到漫剧制作</li>
        </ul>
      </div>
    </div>
  );
};
