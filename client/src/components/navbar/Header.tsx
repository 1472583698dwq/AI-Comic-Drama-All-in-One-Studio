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
  FolderKanban,
  Plug,
  Bot,
  Film,
  ChevronDown,
  Lock,
  LogOut
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useMcpStore } from '../../stores/useMcpStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { toast } from '../../stores/useDialogStore';

interface HeaderProps {
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenMcp: () => void;
  onOpenSkills: () => void;
  onOpenConfig: () => void;
  onOpenProvider?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ 
  onOpenImport, 
  onOpenExport, 
  onOpenMcp, 
  onOpenSkills, 
  onOpenConfig, 
  onOpenProvider 
}) => {
  const { 
    project, 
    closeProject,
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

  const shotsCount = (project?.scenes || []).reduce((n: number, s: any) => n + (s?.shots?.length || 0), 0);
  const charactersCount = project?.characters?.length || 0;

  // 8 大核心工作台频道 (永不折叠、永不隐藏，100% 直出可见)
  const navChannels = [
    { 
      id: 'projects', 
      label: '项目', 
      icon: FolderKanban, 
      tooltip: '项目看板 (管理与切换项目)' 
    },
    { 
      id: 'studio', 
      label: '分镜', 
      icon: Layers, 
      count: shotsCount, 
      tooltip: '导演分镜工作台' 
    },
    { 
      id: 'characters', 
      label: '角色', 
      icon: Users, 
      count: charactersCount, 
      tooltip: '角色设定与人设立绘' 
    },
    { 
      id: 'director3d', 
      label: '3D', 
      icon: Compass, 
      tooltip: '3D虚拟片场与运镜机位' 
    },
    { 
      id: 'timeline', 
      label: '剪辑', 
      icon: Video, 
      tooltip: '多轨音画字幕精剪' 
    },
    { 
      id: 'assets', 
      label: '素材库', 
      icon: Library, 
      isAssets: true, 
      tooltip: '媒体素材库 (人物 / 场景 / 道具 / 背景 / 音效)' 
    },
    { 
      id: 'agent', 
      label: 'AI导演', 
      icon: Bot, 
      isAgent: true, 
      tooltip: 'AI导演智能体工坊' 
    },
    { 
      id: 'canvas', 
      label: '画布', 
      icon: Sparkles, 
      isCanvas: true, 
      tooltip: '智能体无限画布 DAG 流转' 
    },
  ];

  return (
    <header className="h-[54px] bg-surface/95 backdrop-blur-xl border-b border-border px-3 lg:px-4 flex items-center justify-between gap-2 select-none z-30 relative shrink-0">
      {/* ── ① 左侧区：品牌 + 项目卡片 + 工作区双模切换 ── */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Logo 标识 */}
        <div 
          onClick={() => setActiveTab('projects')}
          className="flex items-center gap-2 cursor-pointer group"
          title="点击返回项目看板"
        >
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand via-brand-light to-brand-blue flex items-center justify-center shadow-md shadow-brand/20 group-hover:scale-105 transition-transform shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="hidden sm:block">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-[13px] tracking-tight text-white whitespace-nowrap">AI 漫剧 Studio</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand/20 border border-brand/40 text-brand font-mono font-bold">PRO</span>
            </div>
          </div>
        </div>

        {/* 当前项目信息胶囊 (点击直达项目看板或关闭项目) */}
        {project ? (
          <div className="flex items-center gap-1 bg-surface-secondary/70 border border-border rounded-xl p-0.5 shrink-0">
            <button
              onClick={() => setActiveTab('projects')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all text-left ${
                activeTab === 'projects'
                  ? 'bg-brand/20 text-brand border border-brand/40 font-semibold'
                  : 'hover:bg-surface-secondary text-gray-200 hover:text-white'
              }`}
              title="当前项目：点击打开项目看板"
            >
              <FolderKanban className="w-3.5 h-3.5 text-brand shrink-0" />
              <div className="max-w-[90px] sm:max-w-[130px] md:max-w-[160px] truncate">
                <span className="text-xs font-semibold truncate block">
                  {project.title || '未命名项目'}
                </span>
              </div>
              <span className="text-[10px] text-gray-400 font-mono hidden md:inline shrink-0">
                {shotsCount}镜 · {totalDuration.toFixed(0)}s
              </span>
              <ChevronDown className="w-3 h-3 text-gray-400 shrink-0 ml-0.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeProject();
                toast.info('已退出当前项目，返回项目看板');
              }}
              className="p-1 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="退出/关闭当前项目"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setActiveTab('projects')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 text-left shrink-0 transition-all"
            title="请先在项目看板创建或选择一个项目"
          >
            <FolderKanban className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-xs font-bold">请选择或新建项目</span>
          </button>
        )}

        {/* 工作区双模切换 Pill */}
        <div className={`hidden lg:flex items-center p-0.5 rounded-xl bg-surface-secondary/80 border border-border shrink-0 ${!project ? 'opacity-35 cursor-not-allowed' : ''}`}>
          <button 
            onClick={() => {
              if (!project) {
                toast.info('请先创建或打开项目以进入漫剧工坊');
                return;
              }
              setWorkspace('production');
            }} 
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              workspace === 'production' && activeTab !== 'canvas'
                ? 'bg-brand text-white shadow-sm shadow-brand/25' 
                : 'text-gray-400 hover:text-white'
            }`}
            title={project ? "漫剧制作流水线：分镜、角色、3D、剪辑、素材库" : "请先创建或打开项目"}
          >
            <Film className="w-3.5 h-3.5" />
            <span>漫剧工坊</span>
          </button>
          <button 
            onClick={() => { 
              if (!project) {
                toast.info('请先创建或打开项目以进入创意画布');
                return;
              }
              setWorkspace('creative'); 
              setActiveTab('canvas'); 
            }} 
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              workspace === 'creative' || activeTab === 'canvas'
                ? 'bg-gradient-to-r from-accent-pink to-brand text-white shadow-sm shadow-brand/25' 
                : 'text-gray-400 hover:text-white'
            }`}
            title={project ? "智能体无限画布：DAG多模态节点流转" : "请先创建或打开项目"}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>创意画布</span>
          </button>
        </div>
      </div>

      {/* ── ② 中间区：全量核心频道导航 (未选择项目时内部功能全部锁定禁用) ── */}
      <nav className="flex items-center gap-1 p-1 rounded-2xl bg-surface-secondary/80 border border-border shrink-0 max-w-full overflow-x-auto no-scrollbar">
        {navChannels.map((channel) => {
          const isInternal = channel.id !== 'projects';
          const isLocked = isInternal && !project;
          const isActive = activeTab === channel.id;
          const Icon = channel.icon;

          const handleClick = () => {
            if (isLocked) {
              toast.info(`【${channel.label}】为项目内部功能，请先在看板创建或打开项目`);
              return;
            }
            if (channel.id === 'canvas') {
              setWorkspace('creative');
              setActiveTab('canvas');
            } else if (channel.id === 'assets') {
              setWorkspace('production');
              setActiveTab('assets');
            } else {
              setWorkspace('production');
              setActiveTab(channel.id as any);
            }
          };

          // 素材库特殊样式：醒目高亮粉紫色
          if (channel.isAssets) {
            return (
              <button
                key={channel.id}
                onClick={handleClick}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold transition-all shrink-0 ${
                  isLocked
                    ? 'opacity-35 cursor-not-allowed text-gray-500 border border-transparent'
                    : isActive
                    ? 'bg-gradient-to-r from-accent-pink/25 to-brand/25 text-white border border-accent-pink/60 shadow-sm shadow-accent-pink/25 ring-1 ring-accent-pink/30'
                    : 'text-accent-pink/90 hover:text-white hover:bg-accent-pink/15 border border-accent-pink/30'
                }`}
                title={isLocked ? '请先创建或打开项目以进入素材库' : channel.tooltip}
              >
                {isLocked ? <Lock className="w-3.5 h-3.5 text-gray-500" /> : <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-accent-pink' : 'text-accent-pink/90'}`} />}
                <span className="tracking-wide">素材库</span>
                {!isLocked && <span className="w-1.5 h-1.5 rounded-full bg-accent-pink animate-pulse" />}
              </button>
            );
          }

          // 画布特殊高亮
          if (channel.isCanvas) {
            return (
              <button
                key={channel.id}
                onClick={handleClick}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold transition-all shrink-0 ${
                  isLocked
                    ? 'opacity-35 cursor-not-allowed text-gray-500 border border-transparent'
                    : isActive
                    ? 'bg-gradient-to-r from-accent-pink to-brand text-white shadow-sm border border-brand/50'
                    : 'text-purple-300/80 hover:text-white hover:bg-purple-500/10'
                }`}
                title={isLocked ? '请先创建或打开项目以进入创意画布' : channel.tooltip}
              >
                {isLocked ? <Lock className="w-3.5 h-3.5 text-gray-500" /> : <Icon className="w-3.5 h-3.5 text-purple-400" />}
                <span>{channel.label}</span>
              </button>
            );
          }

          return (
            <button
              key={channel.id}
              onClick={handleClick}
              className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-xl text-xs font-medium transition-all shrink-0 ${
                isLocked
                  ? 'opacity-35 cursor-not-allowed text-gray-500 hover:text-gray-500'
                  : isActive
                  ? 'bg-surface text-white shadow-sm border border-brand/50 text-brand-light font-bold'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-tertiary/60'
              }`}
              title={isLocked ? `请先创建或打开项目以使用【${channel.label}】` : channel.tooltip}
            >
              {isLocked ? (
                <Lock className="w-3.5 h-3.5 text-gray-500" />
              ) : (
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-brand' : 'text-gray-400'}`} />
              )}
              <span>{channel.label}</span>
              {typeof channel.count === 'number' && channel.count > 0 && !isLocked && (
                <span className={`text-[9px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                  isActive ? 'bg-brand text-white' : 'bg-surface-tertiary text-gray-400'
                }`}>
                  {channel.count}
                </span>
              )}
              {channel.isAgent && !isLocked && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
          );
        })}
      </nav>

      {/* ── ③ 右侧区：播放预览 + 设备视口 + 核心工具直出 + 导入/导出主操作 ── */}
      <div className="flex items-center gap-1.5 lg:gap-2 shrink-0">
        {/* 全剧预览播放 */}
        <button 
          onClick={() => {
            if (!project) {
              toast.info('请先创建或打开项目以预览播放');
              return;
            }
            setIsPlaying(!isPlaying);
          }} 
          className={`w-8 h-8 rounded-xl flex items-center justify-center border transition-all shrink-0 ${
            !project
              ? 'opacity-35 cursor-not-allowed bg-surface-secondary border-border text-gray-500'
              : isPlaying 
              ? 'bg-accent-orange border-accent-orange text-white shadow-sm shadow-accent-orange/30' 
              : 'bg-surface-secondary border-border text-gray-300 hover:text-white hover:border-brand/40'
          }`} 
          title={!project ? '请先创建或打开项目' : isPlaying ? '暂停全剧播放 (快捷键: 空格)' : '全剧预览播放 (快捷键: 空格)'}
        >
          {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
        </button>

        {/* 桌面端 / 移动端视口切换 */}
        <div className={`hidden xl:flex items-center rounded-xl bg-surface-secondary border border-border p-0.5 shrink-0 ${!project ? 'opacity-35 pointer-events-none' : ''}`}>
          <button 
            disabled={!project}
            onClick={() => setPlatformMode('desktop')} 
            className={`p-1.5 rounded-lg transition-all ${
              platformMode === 'desktop' 
                ? 'bg-surface text-brand shadow-sm font-bold' 
                : 'text-gray-400 hover:text-white'
            }`} 
            title="切换为专业桌面工作台"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button 
            disabled={!project}
            onClick={() => setPlatformMode('mobile')} 
            className={`p-1.5 rounded-lg transition-all ${
              platformMode === 'mobile' 
                ? 'bg-surface text-brand shadow-sm font-bold' 
                : 'text-gray-400 hover:text-white'
            }`} 
            title="切换为 9:16 移动端卡片流模式"
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 分隔线 */}
        <div className="h-4 w-px bg-border hidden sm:block shrink-0" />

        {/* ── 核心扩展工具组 ── */}
        {/* 自定义生成源 (Providers) */}
        {onOpenProvider && (
          <button
            onClick={onOpenProvider}
            className="flex items-center gap-1 px-2 py-1.5 rounded-xl bg-surface-secondary border border-border hover:border-indigo-500/50 hover:bg-surface text-gray-300 hover:text-indigo-300 transition-all text-xs font-medium shrink-0"
            title="自定义生成源 (Providers) - ComfyUI / 硅基流动 / MiniMax 等生图/视频/音频模型管理与测试"
          >
            <Plug className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span className="hidden 2xl:inline">生成源</span>
          </button>
        )}

        {/* 技能工坊 (Skill Studio) */}
        <button
          onClick={onOpenSkills}
          className="flex items-center gap-1 px-2 py-1.5 rounded-xl bg-surface-secondary border border-border hover:border-amber-500/50 hover:bg-surface text-gray-300 hover:text-amber-300 transition-all text-xs font-medium shrink-0"
          title="技能工坊 (Skill Studio) - 导演提示词工坊与Agent技能库"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="hidden 2xl:inline">技能</span>
        </button>

        {/* MCP 工具协议 */}
        <button
          onClick={onOpenMcp}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-xl bg-surface-secondary border border-border hover:border-emerald-500/50 hover:bg-surface text-gray-300 hover:text-emerald-300 transition-all text-xs font-medium shrink-0 relative"
          title={`MCP 工具协议中枢 - 标准生态连接器 (${activeToolsCount} 个工具在线)`}
        >
          <Cpu className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="hidden 2xl:inline">MCP</span>
          <span className="flex items-center">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {activeToolsCount > 0 && (
              <span className="text-[10px] font-mono text-emerald-400 font-bold ml-1 hidden md:inline">
                {activeToolsCount}
              </span>
            )}
          </span>
        </button>

        {/* 外观主题切换 */}
        <button 
          onClick={toggleTheme} 
          className="w-8 h-8 rounded-xl bg-surface-secondary border border-border hover:border-brand/40 text-gray-300 hover:text-white flex items-center justify-center transition-all shrink-0" 
          title={`外观主题：当前为${effectiveTheme === 'dark' ? '深色暗黑' : '浅色明亮'}模式，点击切换`}
        >
          {effectiveTheme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-400" />}
        </button>

        {/* 系统偏好设置 */}
        <button
          onClick={() => {
            if (activeTab === 'config') {
              if (project) setActiveTab('studio');
              else setActiveTab('projects');
            } else {
              onOpenConfig();
            }
          }}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all shrink-0 ${
            activeTab === 'config'
              ? 'bg-brand border-brand text-white shadow-sm font-semibold'
              : 'bg-surface-secondary border-border text-gray-300 hover:text-white hover:border-brand/40'
          }`}
          title={activeTab === 'config' ? '关闭设置并返回' : '系统偏好设置 (API Keys / 模型配置 / 服务状态)'}
        >
          <Settings className={`w-3.5 h-3.5 ${activeTab === 'config' ? 'animate-spin-slow text-white' : 'text-gray-400'}`} />
          <span className="hidden lg:inline">设置</span>
        </button>

        {/* 分隔线 */}
        <div className="h-4 w-px bg-border shrink-0" />

        {/* ── 主行动按钮组 ── */}
        {/* 导入小说 (始终可用，用于拆解创建新项目) */}
        <button
          onClick={onOpenImport}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-secondary hover:bg-surface-tertiary border border-border hover:border-brand text-white text-xs font-semibold shadow-sm transition-all shrink-0"
          title="从小说/剧本文本智能拆解创建新项目"
        >
          <PlusCircle className="w-3.5 h-3.5 text-brand" />
          <span className="hidden sm:inline">导入小说</span>
          <span className="sm:hidden">导入</span>
        </button>

        {/* 导出剪映 (必须有项目) */}
        <button 
          disabled={!project}
          onClick={() => {
            if (!project) {
              toast.info('请先创建或打开项目以导出工程');
              return;
            }
            onOpenExport();
          }} 
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold shadow-md transition-all shrink-0 ${
            !project
              ? 'opacity-35 cursor-not-allowed bg-surface-secondary border border-border text-gray-500 shadow-none'
              : 'bg-gradient-to-r from-brand via-brand-light to-brand-blue text-white shadow-brand/25 hover:shadow-brand/40 hover:scale-[1.02] active:scale-[0.98]'
          }`}
          title={!project ? "请先创建或打开项目以导出剪映工程" : "导出剪映/CapCut 官方草稿工程或音画分轨包"}
        >
          {!project ? <Lock className="w-3.5 h-3.5 text-gray-500" /> : <Share2 className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">导出剪映</span>
          <span className="sm:hidden">导出</span>
        </button>
      </div>
    </header>
  );
};

export default Header;
