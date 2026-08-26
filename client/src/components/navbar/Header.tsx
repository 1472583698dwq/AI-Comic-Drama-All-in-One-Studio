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
  Library,
  Sun,
  Moon,
  FolderKanban
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useMcpStore } from '../../stores/useMcpStore';
import { useThemeStore } from '../../stores/useThemeStore';

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
    workspace,
    setWorkspace,
    isPlaying, 
    setIsPlaying, 
    totalDuration 
  } = useProjectStore();

  const { effectiveTheme, toggleTheme } = useThemeStore();
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

      {/* Center: Dual Workspace + Navigation Tabs */}
      <div className="hidden md:flex items-center gap-1.5">
        {/* Workspace Switcher */}
        <div className="flex items-center bg-surface-secondary p-1 rounded-xl border border-border">
          <button onClick={()=>{ setWorkspace('production'); setActiveTab('projects'); }} className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${workspace==='production' ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}>漫剧制作</button>
          <button onClick={()=>{ setWorkspace('creative'); setActiveTab('canvas'); }} className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${workspace==='creative' ? 'bg-gradient-to-r from-accent-pink to-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}>创意设计 <span className="text-[9px] bg-white/20 px-1 rounded ml-1">画布</span></button>
        </div>
        {platformMode === 'desktop' && workspace==='production' && (
        <div className="flex items-center bg-surface-secondary p-1 rounded-xl border border-border">
          <button
            onClick={() => setActiveTab('projects')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'projects'
                ? 'bg-surface-tertiary text-white shadow-sm border border-brand/40'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <FolderKanban className="w-3.5 h-3.5 text-brand" />
            <span>项目</span>
          </button>
          <button
            onClick={() => setActiveTab('studio')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'studio'
                ? 'bg-surface-tertiary text-white shadow-sm border border-border-active'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-brand-light" />
            <span>分镜</span>
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
            <span>3D</span>
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
            <span>剪辑</span>
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
            <span>素材</span>
          </button>
        </div>
        )}
        {workspace==='creative' && (
          <div className="flex items-center bg-surface-secondary p-1 rounded-xl border border-border">
            <button onClick={()=>setActiveTab('canvas')} className={`px-3 py-1 rounded-lg text-xs font-medium ${activeTab==='canvas' ? 'bg-surface-tertiary text-white shadow-sm border border-accent-pink/40' : 'text-gray-400'}`}>无限画布</button>
            <span className="text-[10px] text-gray-500 px-2">P1 即将上线</span>
          </div>
        )}
      </div>

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

        {/* Theme Mode Switcher (Dark / Light Mode) */}
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-lg bg-surface-secondary border border-border hover:border-brand/40 text-gray-300 hover:text-white transition-all flex items-center justify-center"
          title={effectiveTheme === 'dark' ? '当前：夜间模式，点击切换到明亮模式 (Light)' : '当前：明亮模式，点击切换到夜间模式 (Dark)'}
        >
          {effectiveTheme === 'dark' ? (
            <Sun className="w-4 h-4 text-amber-400 hover:rotate-90 transition-transform duration-300" />
          ) : (
            <Moon className="w-4 h-4 text-indigo-400 hover:-rotate-12 transition-transform duration-300" />
          )}
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
