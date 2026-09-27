import React, { useEffect, useState } from 'react';
import {
  Plus, Play, BookOpen, Wand2, Wrench, Server, FolderKanban,
  Film, Clock, Sparkles, ChevronRight, LayoutGrid,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useProjectListStore, type ProjectMeta } from '../stores/useProjectListStore';
import { apiService } from '../services/api';
import { toast, promptAsync } from '../stores/useDialogStore';
import { ScriptImportView } from './ScriptImportView';

/**
 * 首页（Home）：跨项目的全局起点，对照竞品收敛公式
 * 「快速创建 CTA + 最近项目 + 模板入口 + 工具行」。
 * 与项目看板的职责区分：首页 = 开始创作；看板 = 管理（搜索/筛选/删除/复制/导入导出）。
 */

/** 风格模板卡：点击即按该风格一键建项目并进入画布（本地化 TapNow 模板范式） */
const STYLE_TEMPLATES = [
  { id: 'donghua_xianxia', label: '仙侠 3D', desc: '东方玄幻 · 大场面', grad: 'from-indigo-500/30 via-purple-600/20 to-transparent', icon: '⚔️' },
  { id: 'japanese_anime', label: '日漫热血', desc: 'ufotable 质感 · 高饱和', grad: 'from-sky-500/30 via-cyan-400/20 to-transparent', icon: '🔥' },
  { id: 'cyberpunk_3d', label: '赛博朋克', desc: '霓虹夜景 · 未来都市', grad: 'from-fuchsia-500/30 via-rose-500/20 to-transparent', icon: '🌆' },
  { id: 'korean_manhwa', label: '韩漫条漫', desc: '精致线稿 · 时尚质感', grad: 'from-amber-400/30 via-orange-500/20 to-transparent', icon: '💅' },
] as const;

const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
};

const fmtTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return d.toLocaleDateString();
};

export const HomeView: React.FC = () => {
  const { project, setActiveTab } = useProjectStore();

  const [recents, setRecents] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [scriptOpen, setScriptOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiService.listProjects({ sort: 'updated_at' })
      .then((res: any) => {
        if (!cancelled) setRecents((res.projects || []).slice(0, 6));
      })
      .catch(() => { if (!cancelled) setRecents([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  /** 打开指定项目：双 store 同步 + 加载完整内容 + 直达画布 */
  const openProject = async (id: string, title: string) => {
    useProjectListStore.getState().setActiveProjectId(id);
    await useProjectStore.getState().loadActiveProject(id);
    if (!useProjectStore.getState().project) {
      toast.error(`项目「${title || '未命名项目'}」加载失败`);
      return;
    }
    setActiveTab('canvas');
  };

  const goCanvasIfProject = () => {
    if (project) { setActiveTab('canvas'); return true; }
    return false;
  };

  /** 继续创作：有活跃项目直接进画布；否则接管最近项目 */
  const handleContinue = async () => {
    if (goCanvasIfProject()) return;
    if (recents.length > 0) {
      await openProject(recents[0].id, recents[0].title);
      return;
    }
    handleNewProject();
  };

  /** 快捷新建：命名 → 空白项目 → 直达画布 */
  const createAndEnter = async (title: string, stylePreset: string) => {
    try {
      const meta = await useProjectListStore.getState().createBlank({
        title: title.trim() || '未命名项目', style_preset: stylePreset, aspect_ratio: '9:16',
      });
      await useProjectStore.getState().loadActiveProject(meta.id);
      setActiveTab('canvas');
      toast.info(`已创建「${meta.title}」，开始创作吧`);
    } catch (e: any) {
      toast.error(e?.message || '创建项目失败');
    }
  };

  const handleNewProject = () => {
    promptAsync({
      title: '新建项目',
      message: '给项目起个名字（之后可随时修改）',
      defaultValue: '未命名项目',
      confirmText: '创建并进入画布',
    }).then((val) => { if (val !== null) createAndEnter(val || '未命名项目', 'donghua_xianxia'); });
  };

  const handleTemplate = (t: typeof STYLE_TEMPLATES[number]) => {
    promptAsync({
      title: `从模板开始 · ${t.label}`,
      message: t.desc,
      defaultValue: `${t.label}项目`,
      confirmText: '创建并进入画布',
    }).then((val) => { if (val !== null) createAndEnter(val || `${t.label}项目`, t.id); });
  };

  /** 导入剧本：无活跃项目时先兜底建一个空白项目承接（ScriptImportView 依赖 activeProjectId 落盘） */
  const handleImportScript = async () => {
    if (!goCanvasIfProject()) {
      try {
        const meta = await useProjectListStore.getState().createBlank({
          title: '剧本导入', style_preset: 'donghua_xianxia', aspect_ratio: '9:16',
        });
        await useProjectStore.getState().loadActiveProject(meta.id);
      } catch (e: any) {
        toast.error(e?.message || '创建承接项目失败');
        return;
      }
    }
    setScriptOpen(true);
  };

  /** 工具弹窗由 App 持有，统一走全局意图事件 */
  const dispatchOpen = (evt: string) => window.dispatchEvent(new Event(evt));

  const lastProject = project || recents[0];

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="max-w-[1080px] mx-auto px-6 py-8 space-y-8">

        {/* ── ① 欢迎区：问候 + 状态 + 主 CTA ── */}
        <section>
          <h1 className="text-xl font-bold text-white tracking-tight">
            {greeting()}，{project ? `继续《${project.title || '未命名项目'}》` : '开始你的漫剧创作'}
          </h1>
          <p className="mt-1.5 text-xs text-gray-500">
            {lastProject
              ? `上次工作于《${lastProject.title || '未命名项目'}》 · ${fmtTime(lastProject.updated_at) || '刚刚'}`
              : '还没有项目 —— 从下方新建，或挑一个风格模板一键开始'}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button
              onClick={handleContinue}
              disabled={recents.length === 0 && !project}
              className="h-9 px-4 inline-flex items-center gap-2 rounded-xl bg-brand text-white text-xs font-semibold shadow-sm shadow-brand/25 hover:bg-brand-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-glow"
            >
              <Play className="w-4 h-4" strokeWidth={1.8} />
              {project ? '继续创作' : recents.length > 0 ? '继续上次项目' : '新建项目'}
            </button>
            <button
              onClick={handleNewProject}
              className="h-9 px-4 inline-flex items-center gap-2 rounded-xl border border-border text-xs font-semibold text-gray-200 hover:text-white hover:bg-surface-secondary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
            >
              <Plus className="w-4 h-4" strokeWidth={1.8} />新建项目
            </button>
            <button
              onClick={handleImportScript}
              className="h-9 px-4 inline-flex items-center gap-2 rounded-xl border border-border text-xs font-semibold text-gray-200 hover:text-white hover:bg-surface-secondary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
            >
              <BookOpen className="w-4 h-4" strokeWidth={1.8} />导入剧本
            </button>
          </div>
        </section>

        {/* ── ② 最近项目：横向卡片行，点击直达画布 ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-bold text-white flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-gray-500" strokeWidth={1.8} />最近项目
            </h2>
            <button
              onClick={() => setActiveTab('projects')}
              className="inline-flex items-center gap-0.5 text-[11px] text-gray-500 hover:text-white transition-colors"
            >
              全部项目<ChevronRight className="w-3 h-3" strokeWidth={1.8} />
            </button>
          </div>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[108px] rounded-2xl bg-surface-secondary/60 border border-border animate-pulse" />
              ))}
            </div>
          ) : recents.length === 0 ? (
            <div className="h-[108px] rounded-2xl border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-gray-500">
              <FolderKanban className="w-5 h-5" strokeWidth={1.5} />
              <span className="text-[11px]">还没有项目，从上方新建或选个模板开始</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {recents.map((p) => (
                <button
                  key={p.id}
                  onClick={() => openProject(p.id, p.title)}
                  className="group text-left rounded-2xl border border-border bg-surface overflow-hidden hover:border-border-active hover:bg-surface-secondary transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
                >
                  <div className="h-[62px] relative bg-gradient-to-br from-brand/25 via-surface-tertiary to-transparent flex items-center justify-center overflow-hidden">
                    <Film className="w-5 h-5 text-brand-light/70 group-hover:scale-110 transition-transform" strokeWidth={1.5} />
                    {p.id === project?.id && (
                      <span className="absolute top-2 right-2 text-[9px] px-1.5 py-0.5 rounded-full bg-brand text-white font-bold">当前</span>
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="text-xs font-semibold text-white truncate">{p.title || '未命名项目'}</div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
                      <span className="flex items-center gap-0.5"><Film className="w-2.5 h-2.5" strokeWidth={1.7} />{p.stats?.shots ?? 0} 镜</span>
                      <span className="tabular-nums">{fmtTime(p.updated_at)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── ③ 快速开始 · 风格模板：一键建项目 ── */}
        <section>
          <h2 className="text-[13px] font-bold text-white flex items-center gap-1.5 mb-3">
            <Sparkles className="w-3.5 h-3.5 text-brand-light" strokeWidth={1.8} />快速开始 · 风格模板
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {STYLE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => handleTemplate(t)}
                className={`group relative h-[92px] rounded-2xl border border-border bg-gradient-to-br ${t.grad} p-3.5 text-left overflow-hidden hover:border-border-active hover:scale-[1.02] transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand`}
              >
                <span className="text-lg" aria-hidden="true">{t.icon}</span>
                <div className="absolute bottom-3 left-3.5 right-3.5">
                  <div className="text-xs font-bold text-white">{t.label}</div>
                  <div className="text-[10px] text-gray-400 truncate">{t.desc}</div>
                </div>
                <Plus className="absolute top-3 right-3 w-3.5 h-3.5 text-white/50 opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={2} />
              </button>
            ))}
          </div>
        </section>

        {/* ── ④ 工具与状态行（轻量单行）── */}
        <section className="flex flex-wrap items-center gap-2 pt-1 pb-4 border-t border-border-subtle">
          <span className="text-[10.5px] font-semibold tracking-wider text-gray-600 mr-1">工具</span>
          <button
            onClick={() => dispatchOpen('open-skill-studio')}
            className="h-7 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-[11px] text-gray-400 hover:text-white hover:bg-surface-secondary transition-colors"
          >
            <Wand2 className="w-3.5 h-3.5" strokeWidth={1.7} />技能工坊
          </button>
          <button
            onClick={() => dispatchOpen('open-mcp-tools')}
            className="h-7 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-[11px] text-gray-400 hover:text-white hover:bg-surface-secondary transition-colors"
          >
            <Wrench className="w-3.5 h-3.5" strokeWidth={1.7} />MCP 工具
          </button>
          <button
            onClick={() => dispatchOpen('open-provider-manager')}
            className="h-7 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-[11px] text-gray-400 hover:text-white hover:bg-surface-secondary transition-colors"
          >
            <Server className="w-3.5 h-3.5" strokeWidth={1.7} />生成源管理
          </button>
          <button
            onClick={() => setActiveTab('projects')}
            className="h-7 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-[11px] text-gray-400 hover:text-white hover:bg-surface-secondary transition-colors"
          >
            <LayoutGrid className="w-3.5 h-3.5" strokeWidth={1.7} />项目看板
          </button>
        </section>
      </div>

      {/* 长篇小说一键转漫剧（复用现有自包含弹窗） */}
      <ScriptImportView isOpen={scriptOpen} onClose={() => setScriptOpen(false)} />
    </div>
  );
};

export default HomeView;
