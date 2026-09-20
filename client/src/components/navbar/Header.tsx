import React from 'react';
import {
  Sparkles, FolderKanban, Film, ChevronDown, Lock, LogOut,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';

interface HeaderProps {
  onOpenExport: () => void;
  // 兼容旧调用（工具入口已迁至左侧栏底部工具区）
  onOpenMcp?: () => void;
  onOpenSkills?: () => void;
  onOpenProvider?: () => void;
}

/**
 * 顶栏只承担「全局上下文」：品牌 / 当前项目 / 导出。
 * 主频道导航与扩展工具已在左侧栏，避免顶栏拥挤（设置也更易被发现）。
 *
 * 精简链路：播放头与桌面/移动视口切换随「分镜工作台 / 多轨剪辑 / 3D 片场」三个页签
 * 一并下线（那两个控件只对这三个页签生效）；「导入小说」按钮随小说拆解链路下线。
 */
export const Header: React.FC<HeaderProps> = ({ onOpenExport }) => {
  const {
    project, closeProject, activeTab, setActiveTab, totalDuration,
  } = useProjectStore();

  const shotsCount = (project?.scenes || []).reduce(
    (n: number, s: any) => n + (s?.shots?.length || 0), 0);

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

      </div>

      {/* ── 右侧：导出 ── */}
      <div className="flex items-center gap-1.5 lg:gap-2 shrink-0">
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
