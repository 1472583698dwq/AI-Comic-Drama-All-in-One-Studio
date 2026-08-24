import React from 'react';
import { 
  Sparkles, 
  Monitor, 
  Smartphone, 
  Layers, 
  Video, 
  Users, 
  Cpu, 
  Share2, 
  PlusCircle, 
  Play, 
  Pause,
  Compass,
  Settings,
  Library
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useMcpStore } from '../../stores/useMcpStore';

interface HeaderProps {
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenMcp: () => void;
  onOpenSkills: () => void;
  onOpenConfig: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenImport, onOpenExport, onOpenMcp, onOpenSkills, onOpenConfig }) => {
  const { 
    project, 
    platformMode, 
    setPlatformMode, 
    activeTab, 
    setActiveTab, 
    isPlaying, 
    setIsPlaying, 
    totalDuration 
  } = useProjectStore();

  const { tools } = useMcpStore();
  const activeToolsCount = tools.filter((t) => t.is_enabled).length;

  return (
    <header className="h-14 bg-surface border-b border-border px-4 flex items-center justify-between select-none z-30 relative">
      {/* Left: Brand Logo & Project Title */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-2 bg-gradient-to-r from-brand to-brand-blue p-1.5 rounded-lg shadow-lg shadow-brand/20">
          <Sparkles className="w-4 h-4 text-white animate-pulse" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <span className="font-bold text-sm bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
              MiniMax AI 漫剧 Studio
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/20 text-brand-light border border-brand/40 font-mono font-medium">
              v2.0 PRO
            </span>
          </div>
          <p className="text-[11px] text-gray-400 truncate max-w-[200px]">
            {project?.title || '未导入剧本'} ({project?.scenes[0]?.shots.length || 0} 镜 · {totalDuration.toFixed(1)}s)
          </p>
        </div>
      </div>

      {/* Center: Desktop Navigation Tabs (When in Desktop Mode) */}
      {platformMode === 'desktop' && (
        <div className="hidden md:flex items-center bg-surface-secondary p-1 rounded-xl border border-border">
          <button
            onClick={() => setActiveTab('studio')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'studio'
                ? 'bg-surface-tertiary text-white shadow-sm border border-border-active'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-brand-light" />
            <span>分镜工作台</span>
          </button>

          <button
            onClick={() => setActiveTab('director3d')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'director3d'
                ? 'bg-surface-tertiary text-white shadow-sm border border-brand/50 text-brand-light'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Compass className="w-3.5 h-3.5 text-accent-orange" />
            <span>3D 导演台</span>
            <span className="text-[9px] bg-accent-orange/20 text-accent-orange px-1 rounded">MiniMax</span>
          </button>

          <button
            onClick={() => setActiveTab('timeline')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'timeline'
                ? 'bg-surface-tertiary text-white shadow-sm border border-border-active'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Video className="w-3.5 h-3.5 text-brand-blue" />
            <span>多轨剪辑</span>
          </button>

          <button
            onClick={() => setActiveTab('assets')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'assets' || activeTab === 'characters'
                ? 'bg-surface-tertiary text-white shadow-sm border border-border-active'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Library className="w-3.5 h-3.5 text-accent-pink" />
            <span>素材库</span>
            <span className="text-[9px] bg-accent-pink/20 text-accent-pink px-1 rounded">人物·场景·道具</span>
          </button>
        </div>
      )}

      {/* Right: Dual-Mode Switcher, MCP Tools & Export Actions */}
      <div className="flex items-center space-x-2.5">
        {/* Playback Toggle */}
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
            isPlaying
              ? 'bg-accent-orange/20 border-accent-orange text-accent-orange'
              : 'bg-surface-secondary border-border text-gray-300 hover:border-border-active'
          }`}
          title="播放/暂停全剧预览"
        >
          {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
          <span>{isPlaying ? '暂停' : '预览'}</span>
        </button>

        {/* Dual Platform Switcher */}
        <div className="flex items-center bg-surface-secondary p-0.5 rounded-lg border border-border">
          <button
            onClick={() => setPlatformMode('desktop')}
            className={`flex items-center space-x-1 px-2 py-1 rounded text-xs font-medium transition-all ${
              platformMode === 'desktop'
                ? 'bg-brand text-white shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}
            title="切换到桌面专业 Studio"
          >
            <Monitor className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">桌面端</span>
          </button>

          <button
            onClick={() => setPlatformMode('mobile')}
            className={`flex items-center space-x-1 px-2 py-1 rounded text-xs font-medium transition-all ${
              platformMode === 'mobile'
                ? 'bg-brand text-white shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}
            title="切换到移动端小云雀极速卡片流"
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">App 端</span>
          </button>
        </div>

        {/* Skills Studio Button */}
        <button
          onClick={onOpenSkills}
          className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-surface-secondary border border-border hover:border-accent-orange/40 text-gray-300 transition-all"
          title="漫剧专业技能工坊 (Skill Studio)"
        >
          <Sparkles className="w-3.5 h-3.5 text-accent-orange" />
          <span className="hidden lg:inline">技能工坊</span>
          <span className="text-[9px] px-1 rounded bg-accent-orange/20 text-accent-orange font-mono">Skill</span>
        </button>

        {/* Config / Settings */}
        <button
          onClick={() => {
            if (activeTab === 'config') {
              setActiveTab('studio');
            } else {
              onOpenConfig();
            }
          }}
          className={`p-1.5 rounded-lg border transition-all ${
            activeTab === 'config'
              ? 'bg-brand/20 border-brand text-brand-light ring-1 ring-brand/50 shadow-md shadow-brand/20'
              : 'bg-surface-secondary border-border hover:border-border-active text-gray-400 hover:text-white'
          }`}
          title={activeTab === 'config' ? '关闭配置并返回工作台' : '系统与模型配置（MiniMax / DeepSeek / ComfyUI / 剪映）'}
        >
          <Settings className={`w-4 h-4 ${activeTab === 'config' ? 'animate-spin-slow text-brand-light' : ''}`} />
        </button>

        {/* MCP Tools Badge Button */}
        <button
          onClick={onOpenMcp}
          className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-surface-secondary border border-border hover:border-brand/40 text-gray-300 transition-all"
          title="管理外部 MCP 工具 (ComfyUI / 剪映 / 配音)"
        >
          <Cpu className="w-3.5 h-3.5 text-accent-green" />
          <span className="hidden lg:inline">MCP 工具</span>
          <span className="w-2 h-2 rounded-full bg-accent-green animate-ping" />
        </button>

        {/* Import Novel Script */}
        <button
          onClick={onOpenImport}
          className="flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-surface-tertiary border border-border hover:border-brand text-white transition-all shadow-sm"
        >
          <PlusCircle className="w-3.5 h-3.5 text-brand-light" />
          <span>导入小说</span>
        </button>

        {/* Export Draft / Video */}
        <button
          onClick={onOpenExport}
          className="flex items-center space-x-1.5 px-3.5 py-1 rounded-lg text-xs font-semibold bg-gradient-to-r from-brand to-brand-blue hover:opacity-90 text-white shadow-md shadow-brand/25 transition-all"
        >
          <Share2 className="w-3.5 h-3.5" />
          <span>导出剪映</span>
        </button>
      </div>
    </header>
  );
};
