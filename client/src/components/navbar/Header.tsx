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
  Bot
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
  onOpenProvider?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenImport, onOpenExport, onOpenMcp, onOpenSkills, onOpenConfig, onOpenProvider }) => {
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
    <header className="h-[56px] bg-surface/95 backdrop-blur-xl border-b border-border px-3 lg:px-4 flex items-center gap-3 select-none z-30 relative shrink-0">
      {/* ① 品牌区 — 固定宽度，信息分层 */}
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand via-brand-light to-brand-blue flex items-center justify-center shadow-lg shadow-brand/20 shrink-0">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <div className="hidden sm:block min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-[13px] tracking-tight text-white whitespace-nowrap">MiniMax Studio</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-brand text-white font-mono font-bold tracking-wider">PRO v2</span>
          </div>
          <p className="text-[11px] leading-none text-gray-400 truncate max-w-[180px] lg:max-w-[220px] mt-0.5">
            {project?.title || '未选择项目'} · {(project?.scenes || []).reduce((n: number, s: any) => n + (s?.shots?.length || 0), 0)}镜 · {totalDuration.toFixed(0)}s
          </p>
        </div>
      </div>

      {/* ② 中心导航 — 工作台 + 频道，视觉分组 */}
      <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
        {/* 工作台切换 — 强分组 */}
        <div className="flex items-center p-1 rounded-full bg-surface-secondary border border-border shadow-inner shrink-0">
          <button onClick={()=>{ setWorkspace('production'); setActiveTab('projects'); }} className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all ${workspace==='production' ? 'bg-white text-surface shadow-sm dark:bg-brand dark:text-white' : 'text-gray-400 hover:text-white'}`}>漫剧制作</button>
          <button onClick={()=>{ setWorkspace('creative'); setActiveTab('canvas'); }} className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1 ${workspace==='creative' ? 'bg-gradient-to-r from-accent-pink to-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}>创意设计 <span className="hidden xl:inline text-[9px] bg-white/20 px-1 py-0.5 rounded">CANVAS</span></button>
        </div>

        {/* 频道 tabs — 仅桌面且对应工作台 */}
        <div className="hidden lg:flex items-center gap-1 ml-1">
          {workspace==='production' && (
            <div className="flex items-center rounded-full bg-surface-secondary border border-border p-1 gap-1">
              {[
                { id:'projects', label:'项目', icon: FolderKanban, color:'text-brand' },
                { id:'characters', label:'角色', icon: Users, color:'text-accent-pink' },
                { id:'studio', label:'分镜', icon: Layers, color:'text-brand-light' },
                { id:'director3d', label:'3D', icon: Compass, color:'text-accent-orange' },
                { id:'timeline', label:'剪辑', icon: Video, color:'text-brand-blue' },
                { id:'assets', label:'素材', icon: Library, color:'text-brand-blue' },
                { id:'agent', label:'Agent', icon: Bot, color:'text-accent-green' },
              ].map(t=>{
                const active = activeTab===t.id;
                return (
                  <button key={t.id} onClick={() => { if (t.id === 'agent') setWorkspace('production'); setActiveTab(t.id as any); }} className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${active ? 'bg-surface text-white shadow-sm border border-border-active' : 'text-gray-500 hover:text-gray-200'}`}>
                    <t.icon className={`w-3.5 h-3.5 ${t.color}`} /><span>{t.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          {workspace==='creative' && (
            <div className="flex items-center gap-1 rounded-full bg-surface-secondary border border-border p-1">
              <button onClick={()=>setActiveTab('canvas')} className={`px-3 py-1 rounded-full text-xs font-medium ${activeTab==='canvas' ? 'bg-white dark:bg-surface text-surface dark:text-white shadow-sm' : 'text-gray-500'}`}>无限画布</button>
              <span className="text-[10px] text-gray-500 pr-2 hidden xl:inline">9 节点 · 动态端口 · DAG</span>
            </div>
          )}
        </div>
      </div>

      {/* ③ 右侧操作 — 三级视觉：主操作 / 次操作 / 工具 */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* 次操作组 — 播放 + 平台 */}
        <div className="hidden md:flex items-center gap-1.5 pr-1.5 border-r border-border">
          <button onClick={() => setIsPlaying(!isPlaying)} className={`w-8 h-8 rounded-full flex items-center justify-center border transition-all ${isPlaying ? 'bg-accent-orange border-accent-orange text-white' : 'bg-surface-secondary border-border text-gray-400 hover:text-white hover:border-border-active'}`} title={isPlaying ? '暂停' : '预览'}>
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
          </button>
          <div className="hidden xl:flex items-center rounded-full bg-surface-secondary border border-border p-0.5">
            <button onClick={() => setPlatformMode('desktop')} className={`p-1.5 rounded-full transition-all ${platformMode==='desktop' ? 'bg-white dark:bg-brand text-surface dark:text-white shadow-sm' : 'text-gray-500 hover:text-white'}`} title="桌面端"><Monitor className="w-3.5 h-3.5" /></button>
            <button onClick={() => setPlatformMode('mobile')} className={`p-1.5 rounded-full transition-all ${platformMode==='mobile' ? 'bg-white dark:bg-brand text-surface dark:text-white shadow-sm' : 'text-gray-500 hover:text-white'}`} title="App 端"><Smartphone className="w-3.5 h-3.5" /></button>
          </div>
        </div>

        {/* 工具组 — 图标化 */}
        <div className="hidden md:flex items-center gap-1">
          <button onClick={onOpenProvider} className="w-8 h-8 rounded-full bg-surface-secondary border border-border hover:border-brand/40 text-gray-400 hover:text-white flex items-center justify-center" title="自定义生成源 (增删改查)"><Plug className="w-3.5 h-3.5 text-brand" /></button>
          <button onClick={onOpenSkills} className="w-8 h-8 rounded-full bg-surface-secondary border border-border hover:border-accent-orange/40 text-gray-400 hover:text-white flex items-center justify-center" title="技能工坊"><Sparkles className="w-3.5 h-3.5 text-accent-orange" /></button>
          <button onClick={onOpenMcp} className="w-8 h-8 rounded-full bg-surface-secondary border border-border hover:border-brand/40 text-gray-400 hover:text-white flex items-center justify-center relative" title="MCP 工具"><Cpu className="w-3.5 h-3.5 text-accent-green" /><span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-green animate-pulse border-2 border-surface" /></button>
          <button onClick={toggleTheme} className="w-8 h-8 rounded-full bg-surface-secondary border border-border hover:border-border-active text-gray-400 hover:text-white flex items-center justify-center" title="切换主题">{effectiveTheme==='dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-400" />}</button>
          <button onClick={() => { if(activeTab==='config') setActiveTab('studio'); else onOpenConfig(); }} className={`w-8 h-8 rounded-full border flex items-center justify-center transition-all ${activeTab==='config' ? 'bg-brand border-brand text-white shadow-md' : 'bg-surface-secondary border-border text-gray-400 hover:text-white'}`} title="设置"><Settings className={`w-3.5 h-3.5 ${activeTab==='config' ? 'animate-spin-slow' : ''}`} /></button>
        </div>

        {/* 主操作 — 视觉最重 */}
        <div className="flex items-center gap-1.5 pl-1.5 border-l border-border ml-1">
          <button onClick={onOpenImport} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white dark:bg-surface-secondary border border-border hover:border-brand text-surface dark:text-white text-xs font-semibold shadow-sm">
            <PlusCircle className="w-3.5 h-3.5 text-brand" /><span>导入</span>
          </button>
          <button onClick={onOpenExport} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-bold shadow-md shadow-brand/20 hover:shadow-brand/30 hover:scale-[1.02] transition-all">
            <Share2 className="w-3.5 h-3.5" /><span className="hidden sm:inline">导出</span><span className="sm:hidden">出</span>
          </button>
        </div>
      </div>
    </header>
  );
};
