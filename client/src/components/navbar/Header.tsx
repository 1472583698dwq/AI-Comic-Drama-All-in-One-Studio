import React from 'react';
import {
  Sparkles, Monitor, Smartphone, PlusCircle, Play, Pause,
  FolderKanban, Film, ChevronDown, Lock, LogOut,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';

interface HeaderProps {
  onOpenImport: () => void;
  onOpenExport: () => void;
  // 兼容旧调用（工具入口已迁至左侧栏底部工具区）
  onOpenMcp?: () => void;
  onOpenSkills?: () => void;
  onOpenProvider?: () => void;
}

/**
 * 顶栏只承担「全局上下文」：品牌 / 当前项目 / 工作区切换 / 播放 / 视口 / 导入导出 / 设置。
 * 主频道导航与扩展工具已在左侧栏，避免顶栏拥挤（设置也更易被发现）。
 */
export const Header: React.FC<HeaderProps> = ({ onOpenImport, onOpenExport }) => {
  const {
    project, closeProject, platformMode, setPlatformMode,
    activeTab, setActiveTab, workspace, setWorkspace,
    isPlaying, setIsPlaying, totalDuration,
  } = useProjectStore();

  const shotsCount = (project?.scenes || []).reduce(
    (n: number, s: any) => n + (s?.shots?.length || 0), 0);

  // 播放靠底部多轨时间线（桌面端）或移动端卡片流驱动；其余页签不渲染任何播放消费方，
  // 此前在这些页签上点播放只会切图标，什么都不会发生。
  const canPlay = !!project && (
    platformMode === 'mobile' ||
    activeTab === 'studio' || activeTab === 'timeline' || activeTab === 'director3d'
  );

  return (
    <header className="h-[54px] bg-surface/95 backdrop-blur-xl border-b border-border px-3 lg:px-4 flex items-center justify-between gap-2 select-none z-30 relative shrink-0">
      {/* ── 左侧：品牌 + 当前项目 + 工作区切换 ── */}
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        <div
          onClick={() => setActiveTab('projects')}
          className="flex items-center gap-2 cursor-pointer group"
          title="点击返回项目看板"
        >
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand via-brand-light to-brand-blue flex items-center justify-center shadow-md shadow-brand/20 group-hover:scale-105 transition-transform shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="hidden xl:block">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-[13px] tracking-tight text-white whitespace-nowrap">AI 漫剧 Studio</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand/20 border border-brand/40 text-brand font-mono font-bold">PRO</span>
            </div>
          </div>
        </div>

        {/* 当前项目胶囊 */}
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
              <div className="max-w-[100px] sm:max-w-[150px] md:max-w-[190px] truncate">
                <span className="text-xs font-semibold truncate block">{project.title || '未命名项目'}</span>
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

        {/* 工作区双模切换 */}
        <div className={`hidden lg:flex items-center p-0.5 rounded-xl bg-surface-secondary/80 border border-border shrink-0 ${!project ? 'opacity-35 cursor-not-allowed' : ''}`}>
          <button
            onClick={() => {
              if (!project) { toast.info('请先创建或打开项目以进入漫剧工坊'); return; }
              setWorkspace('production');
              // 从画布 / AI 导演等非制作页签点进来时要真的切过去，否则按钮亮了人还停在原地
              if (!['studio', 'characters', 'director3d', 'timeline', 'assets'].includes(activeTab)) {
                setActiveTab('studio');
              }
            }}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              workspace === 'production' && ['studio', 'characters', 'director3d', 'timeline', 'assets'].includes(activeTab)
                ? 'bg-brand text-white shadow-sm shadow-brand/25'
                : 'text-gray-400 hover:text-white'
            }`}
            title={project ? '漫剧制作流水线：分镜、角色、3D、剪辑、素材库' : '请先创建或打开项目'}
          >
            <Film className="w-3.5 h-3.5" />
            <span>漫剧工坊</span>
          </button>
          <button
            onClick={() => {
              if (!project) { toast.info('请先创建或打开项目以进入创意画布'); return; }
              setWorkspace('creative');
              setActiveTab('canvas');
            }}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              workspace === 'creative' || activeTab === 'canvas'
                ? 'bg-gradient-to-r from-accent-pink to-brand text-white shadow-sm shadow-brand/25'
                : 'text-gray-400 hover:text-white'
            }`}
            title={project ? '智能体无限画布：DAG多模态节点流转' : '请先创建或打开项目'}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>创意画布</span>
          </button>
        </div>
      </div>

      {/* ── 右侧：播放 + 视口 + 导入导出 + 设置 ── */}
      <div className="flex items-center gap-1.5 lg:gap-2 shrink-0">
        <button
          onClick={() => {
            if (!project) { toast.info('请先创建或打开项目以预览播放'); return; }
            if (!canPlay) { toast.info('请切到分镜工作台 / 多轨剪辑 / 3D 片场再播放'); return; }
            setIsPlaying(!isPlaying);
          }}
          className={`w-8 h-8 rounded-xl flex items-center justify-center border transition-all shrink-0 ${
            !canPlay
              ? 'opacity-35 cursor-not-allowed bg-surface-secondary border-border text-gray-500'
              : isPlaying
              ? 'bg-accent-orange border-accent-orange text-white shadow-sm shadow-accent-orange/30'
              : 'bg-surface-secondary border-border text-gray-300 hover:text-white hover:border-brand/40'
          }`}
          title={!project ? '请先创建或打开项目' : !canPlay ? '该页签无播放视图，请切到分镜工作台 / 多轨剪辑 / 3D 片场' : isPlaying ? '暂停播放 (空格)' : '预览播放：按分镜时长推进播放头 (空格)'}
        >
          {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
        </button>

        <div className={`hidden xl:flex items-center rounded-xl bg-surface-secondary border border-border p-0.5 shrink-0 ${!project ? 'opacity-35 pointer-events-none' : ''}`}>
          <button
            disabled={!project}
            onClick={() => setPlatformMode('desktop')}
            className={`p-1.5 rounded-lg transition-all ${platformMode === 'desktop' ? 'bg-surface text-brand shadow-sm font-bold' : 'text-gray-400 hover:text-white'}`}
            title="专业桌面工作台"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button
            disabled={!project}
            onClick={() => setPlatformMode('mobile')}
            className={`p-1.5 rounded-lg transition-all ${platformMode === 'mobile' ? 'bg-surface text-brand shadow-sm font-bold' : 'text-gray-400 hover:text-white'}`}
            title="9:16 移动端卡片流"
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="h-4 w-px bg-border hidden sm:block shrink-0" />

        <button
          onClick={onOpenImport}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-secondary hover:bg-surface-tertiary border border-border hover:border-brand text-white text-xs font-semibold shadow-sm transition-all shrink-0"
          title="从小说/剧本文本智能拆解创建新项目"
        >
          <PlusCircle className="w-3.5 h-3.5 text-brand" />
          <span className="hidden sm:inline">导入小说</span>
          <span className="sm:hidden">导入</span>
        </button>

        <button
          disabled={!project}
          onClick={() => {
            if (!project) { toast.info('请先创建或打开项目以导出工程'); return; }
            onOpenExport();
          }}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold shadow-md transition-all shrink-0 ${
            !project
              ? 'opacity-35 cursor-not-allowed bg-surface-secondary border border-border text-gray-500 shadow-none'
              : 'bg-gradient-to-r from-brand via-brand-light to-brand-blue text-white shadow-brand/25 hover:shadow-brand/40 hover:scale-[1.02] active:scale-[0.98]'
          }`}
          title={!project ? '请先创建或打开项目以导出剪映工程' : '导出剪映 / CapCut 草稿工程'}
        >
          {!project ? <Lock className="w-3.5 h-3.5 text-gray-500" /> : <Film className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">导出剪映</span>
          <span className="sm:hidden">导出</span>
        </button>

      </div>
    </header>
  );
};

export default Header;
