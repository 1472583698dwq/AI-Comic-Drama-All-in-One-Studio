import React, { useEffect, useState } from 'react';
import {
  Plus, Play, BookOpen, Wand2, Wrench, Server, FolderKanban,
  Film, Clock, Users, Sparkles, ChevronRight, LayoutGrid, ArrowUpRight,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { isPageEnabled } from '../stores/usePageStore';
import { useProjectListStore, type ProjectMeta } from '../stores/useProjectListStore';
import { apiService } from '../services/api';
import { toast, promptAsync } from '../stores/useDialogStore';
import { ScriptImportView } from './ScriptImportView';

/**
 * 首页（Home）：跨项目的全局起点，对照竞品收敛公式
 * 「快速创建 CTA + 最近项目 + 模板入口 + 工具行」。
 * 与项目看板的职责区分：首页 = 开始创作；看板 = 管理（搜索/筛选/删除/复制/导入导出）。
 *
 * 视觉基线（磨砂玻璃 + 大方块）：
 * - 底色语义类（bg-surface*）在本项目被 !important 固定为不透明，做不出玻璃；
 *   这里统一用 bg-white/xx 作浅色玻璃、dark:bg-white/[.0x] 作暗色玻璃，
 *   文字一律走 var(--color-text-main / -secondary / -muted) 变量色 —— 绕开
 *   index.css 里「浅色主题 text-white 映射」与「bg-gradient 容器白字白名单」
 *   两套 !important 规则，避免浅底白字/深底深字。
 * - 页面加了固定氛围层（品牌色光斑 + 极淡网格），玻璃才有可透的层次。
 *
 * 接线说明（新基线）：本页为旧线 backup/simpleuse 版本的落位，依赖全部按新基线适配 ——
 * 依赖面只有 useProjectStore / useProjectListStore / apiService / useDialogStore / ScriptImportView，
 * 签名与旧线一致，未改任何上游 API；工具行三个入口仍走 App 持有的全局意图事件。
 */

/** 风格模板卡：点击即按该风格一键建项目并进入画布（本地化 TapNow 模板范式） */
const STYLE_TEMPLATES = [
  { id: 'donghua_xianxia', label: '仙侠 3D', desc: '东方玄幻 · 大场面', grad: 'from-[#4C1D95]/90 via-[#6D28D9]/70 to-[#1E1B4B]/90', icon: '⚔️' },
  { id: 'japanese_anime', label: '日漫热血', desc: 'ufotable 质感 · 高饱和', grad: 'from-[#0C4A6E]/90 via-[#0284C7]/70 to-[#082F49]/90', icon: '🔥' },
  { id: 'cyberpunk_3d', label: '赛博朋克', desc: '霓虹夜景 · 未来都市', grad: 'from-[#701A75]/90 via-[#DB2777]/60 to-[#2E1065]/90', icon: '🌆' },
  { id: 'korean_manhwa', label: '韩漫条漫', desc: '精致线稿 · 时尚质感', grad: 'from-[#78350F]/90 via-[#EA580C]/60 to-[#431407]/90', icon: '💅' },
] as const;

/** 磨砂面板底色：浅色=半透明白 + 1px 深色外描边；暗色=6% 白 + 浅描边 */
const GLASS =
  'border border-white/70 bg-white/55 backdrop-blur-2xl '
  + 'shadow-[0_0_0_1px_rgba(15,23,42,.045),0_1px_0_0_rgba(255,255,255,.9)_inset,0_26px_54px_-32px_rgba(15,23,42,.38)] '
  + 'dark:border-white/12 dark:bg-white/[.06] '
  + 'dark:shadow-[0_0_0_1px_rgba(255,255,255,.05),0_1px_0_0_rgba(255,255,255,.06)_inset,0_26px_54px_-32px_rgba(0,0,0,.85)]';

const T_MAIN = '[color:var(--color-text-main)]';
const T_SEC = '[color:var(--color-text-secondary)]';
const T_MUTED = '[color:var(--color-text-muted)]';

/** 分区标题：左侧一根品牌色短竖线 + 标题 + 可选右侧动作 */
const SectionTitle: React.FC<{ icon: React.ReactNode; title: string; hint?: React.ReactNode }> = ({ icon, title, hint }) => (
  <div className="flex items-center justify-between mb-3.5">
    <h2 className={`text-[13.5px] font-bold ${T_MAIN} flex items-center gap-2`}>
      <span className="w-[3px] h-[13px] rounded-full bg-[color:var(--color-brand)] shrink-0" aria-hidden="true" />
      <span className={`${T_MUTED} flex items-center`}>{icon}</span>
      {title}
    </h2>
    {hint}
  </div>
);

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

/** 秒 → 紧凑时长（项目统计里 duration 就是秒） */
const fmtDur = (sec?: number) => {
  const n = Math.max(0, Math.round(sec || 0));
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m${String(n % 60).padStart(2, '0')}s`;
};

export const HomeView: React.FC = () => {
  const { project, setActiveTab } = useProjectStore();

  const [recents, setRecents] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [scriptOpen, setScriptOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
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

  /**
   * 项目看板入口（首页有两处）：看板可能已被功能开关关掉。
   * 关掉时按钮灰显 + tooltip 说明，点击只提示去哪儿开 —— 不做「点了没反应」也不静默跳走。
   */
  const boardOn = isPageEnabled('projects');
  const BOARD_OFF_HINT = '项目看板已关闭，可在 设置 → 功能开关 开启';
  const goBoard = () => {
    if (!boardOn) { toast.info(BOARD_OFF_HINT); return; }
    setActiveTab('projects');
  };
  const boardCls = boardOn ? '' : 'opacity-45 cursor-not-allowed';

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
    <div className="flex-1 min-h-0 relative">

      {/* ── 氛围层：固定不动，给磨砂面板提供可透的底层层次 ── */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-[28%] -left-[12%] w-[46vw] h-[46vw] min-w-[420px] min-h-[420px] rounded-full blur-[110px] opacity-[.22] bg-[radial-gradient(circle_at_center,#7C3AED,transparent_62%)]" />
        <div className="absolute -top-[18%] right-[-14%] w-[40vw] h-[40vw] min-w-[380px] min-h-[380px] rounded-full blur-[120px] opacity-[.18] bg-[radial-gradient(circle_at_center,#0EA5E9,transparent_62%)]" />
        <div className="absolute bottom-[-22%] left-[28%] w-[36vw] h-[36vw] min-w-[320px] min-h-[320px] rounded-full blur-[130px] opacity-[.14] bg-[radial-gradient(circle_at_center,#EC4899,transparent_65%)]" />
        <div className="absolute inset-0 opacity-[.55] [background-image:linear-gradient(to_right,rgba(15,23,42,.045)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,.045)_1px,transparent_1px)] [background-size:52px_52px] [mask-image:radial-gradient(ellipse_at_50%_0%,#000_10%,transparent_78%)] dark:opacity-[.4] dark:[background-image:linear-gradient(to_right,rgba(255,255,255,.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,.05)_1px,transparent_1px)]" />
      </div>

      <div className="absolute inset-0 overflow-y-auto custom-scrollbar">
        <div className="relative max-w-[1240px] mx-auto px-6 py-8 lg:px-10 lg:py-10 space-y-8">

          {/* ── ① Hero：大方块磨砂面板（问候 + 状态 + 主 CTA） ── */}
          <section className={`relative overflow-hidden rounded-[28px] ${GLASS} px-6 py-7 lg:px-9 lg:py-9`}>
            {/* 面板内部氛围：右上角品牌光晕 + 顶部高光细线 */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              <div className="absolute -top-24 -right-16 w-[380px] h-[380px] rounded-full blur-[90px] opacity-[.3] bg-[radial-gradient(circle_at_center,#A855F7,transparent_65%)]" />
              <div className="absolute inset-x-10 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(124,58,237,.55),transparent)]" />
            </div>

            <div className="relative flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
              <div className="min-w-0">
                <span className={`inline-flex items-center h-6 px-2.5 rounded-full border border-white/70 bg-white/60 gap-1.5 text-[10.5px] font-semibold tracking-wide ${T_SEC} dark:border-white/10 dark:bg-white/[.06]`}>
                  <Sparkles className="w-3 h-3 text-[color:var(--color-brand)]" strokeWidth={2} />
                  AI 漫剧 Studio
                </span>

                <h1 className={`mt-4 text-[26px] lg:text-[33px] font-bold tracking-tight leading-[1.18] ${T_MAIN}`}>
                  {greeting()}，{project ? `继续《${project.title || '未命名项目'}》` : '开始你的漫剧创作'}
                </h1>

                <p className={`mt-2.5 text-[12.5px] ${T_MUTED}`}>
                  {lastProject
                    ? `上次工作于《${lastProject.title || '未命名项目'}》 · ${fmtTime(lastProject.updated_at) || '刚刚'}`
                    : '还没有项目 —— 点击下方新建，或挑一个风格模板一键开始'}
                </p>
              </div>

              {/* CTA：主次分明的大按钮组 */}
              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  onClick={handleContinue}
                  disabled={recents.length === 0 && !project}
                  className="h-11 px-5 inline-flex items-center gap-2 rounded-2xl bg-gradient-to-br from-[color:var(--color-brand-light)] to-[color:var(--color-brand)] text-white text-[12.5px] font-semibold shadow-[0_14px_30px_-12px_rgba(124,58,237,.75)] hover:brightness-110 active:scale-[.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-glow)]"
                >
                  <Play className="w-4 h-4" strokeWidth={2} />
                  {project ? '继续创作' : recents.length > 0 ? '继续上次项目' : '新建项目'}
                </button>
                <button
                  onClick={handleNewProject}
                  className={`h-11 px-4 inline-flex items-center gap-2 rounded-2xl border border-white/70 bg-white/55 backdrop-blur-xl text-[12.5px] font-semibold ${T_SEC} hover:[color:var(--color-text-main)] hover:bg-white/80 active:scale-[.98] transition-all dark:border-white/10 dark:bg-white/[.05] dark:hover:bg-white/[.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-glow)]`}
                >
                  <Plus className="w-4 h-4" strokeWidth={2} />新建项目
                </button>
                <button
                  onClick={handleImportScript}
                  className={`h-11 px-4 inline-flex items-center gap-2 rounded-2xl border border-white/70 bg-white/55 backdrop-blur-xl text-[12.5px] font-semibold ${T_SEC} hover:bg-white/80 active:scale-[.98] transition-all dark:border-white/10 dark:bg-white/[.05] dark:hover:bg-white/[.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-glow)]`}
                >
                  <BookOpen className="w-4 h-4" strokeWidth={2} />导入剧本
                </button>
              </div>
            </div>
          </section>

          {/* ── ② 最近项目：大方块磨砂卡，点击直达画布 ── */}
          <section>
            <SectionTitle
              icon={<Clock className="w-3.5 h-3.5" strokeWidth={2} />}
              title="最近项目"
              hint={(
                <button
                  onClick={goBoard}
                  title={boardOn ? '进入项目看板' : BOARD_OFF_HINT}
                  className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] ${T_MUTED} hover:[color:var(--color-text-main)] hover:bg-white/60 dark:hover:bg-white/[.07] transition-colors ${boardCls}`}
                >
                  全部项目<ChevronRight className="w-3 h-3" strokeWidth={2} />
                </button>
              )}
            />

            {loading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className={`h-[212px] rounded-[24px] ${GLASS} animate-pulse`} />
                ))}
              </div>
            ) : recents.length === 0 ? (
              <div className={`h-[212px] rounded-[24px] border border-dashed border-white/70 dark:border-white/10 bg-white/35 dark:bg-white/[.02] backdrop-blur-xl flex flex-col items-center justify-center gap-2.5 ${T_MUTED}`}>
                <span className="w-11 h-11 rounded-2xl border border-white/70 dark:border-white/10 bg-white/60 dark:bg-white/[.05] flex items-center justify-center">
                  <FolderKanban className="w-5 h-5" strokeWidth={1.6} />
                </span>
                <span className="text-[11.5px]">还没有项目，从上方新建或选个风格模板开始</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {recents.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => openProject(p.id, p.title)}
                    className={`group relative text-left rounded-[24px] ${GLASS} p-2 transition-all duration-300 hover:-translate-y-1 hover:bg-white/75 hover:shadow-[0_0_0_1px_rgba(124,58,237,.35),0_1px_0_0_rgba(255,255,255,.95)_inset,0_30px_60px_-28px_rgba(76,29,149,.5)] dark:hover:bg-white/[.075] dark:hover:shadow-[0_0_0_1px_rgba(168,85,247,.35),0_1px_0_0_rgba(255,255,255,.08)_inset,0_30px_60px_-28px_rgba(0,0,0,.9)] active:scale-[.995] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-glow)]`}
                  >
                    {/* 缩略区：品牌渐变 + 斜向光带 + 点阵纹理，占满卡片上半（大方块） */}
                    <div className="relative h-[118px] rounded-[17px] overflow-hidden bg-gradient-to-br from-[#7C3AED]/30 via-[#38BDF8]/20 to-transparent dark:from-[#7C3AED]/45 dark:via-[#38BDF8]/25">
                      <div aria-hidden="true" className="absolute -inset-y-10 -left-1/3 w-2/3 rotate-[18deg] bg-white/25 blur-2xl" />
                      <div aria-hidden="true" className="absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(255,255,255,.55)_1px,transparent_1px)] [background-size:15px_15px]" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="w-12 h-12 rounded-2xl border border-white/60 bg-white/55 backdrop-blur-md flex items-center justify-center shadow-[0_8px_20px_-10px_rgba(15,23,42,.4)] dark:border-white/15 dark:bg-white/10">
                          <Film className="w-5 h-5 text-[color:var(--color-brand-glow)] group-hover:scale-110 transition-transform duration-300" strokeWidth={1.7} />
                        </span>
                      </div>
                      {/* 序号 + 当前标记 */}
                      <span className={`absolute top-2.5 left-2.5 h-5 min-w-[22px] px-1.5 rounded-md border border-white/60 bg-white/60 backdrop-blur-md flex items-center justify-center text-[10px] font-bold tabular-nums ${T_MAIN} dark:border-white/12 dark:bg-white/10`}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {p.id === project?.id && (
                        <span className="absolute top-2.5 right-2.5 h-5 px-2 rounded-md bg-[color:var(--color-brand)] flex items-center text-[9.5px] font-bold [color:#fff] shadow-[0_6px_16px_-6px_rgba(124,58,237,.9)]">
                          当前
                        </span>
                      )}
                    </div>

                    {/* 信息区 */}
                    <div className="px-2.5 pt-3 pb-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-[13.5px] font-semibold truncate flex-1 ${T_MAIN}`}>
                          {p.title || '未命名项目'}
                        </span>
                        <ArrowUpRight className={`w-3.5 h-3.5 shrink-0 ${T_MUTED} opacity-0 -translate-x-0.5 translate-y-0.5 group-hover:opacity-100 group-hover:translate-x-0 group-hover:translate-y-0 transition-all duration-300`} strokeWidth={2} />
                      </div>
                      <div className={`mt-2 flex items-center gap-3 text-[10.5px] ${T_MUTED}`}>
                        <span className="flex items-center gap-1">
                          <Film className="w-3 h-3" strokeWidth={1.8} />{p.stats?.shots ?? 0} 镜
                        </span>
                        <span className="flex items-center gap-1 tabular-nums">
                          <Clock className="w-3 h-3" strokeWidth={1.8} />{fmtDur(p.stats?.duration)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" strokeWidth={1.8} />{p.stats?.characters ?? 0}
                        </span>
                        <span className="ml-auto shrink-0">{fmtTime(p.updated_at)}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* ── ③ 快速开始 · 风格模板：深色渐变玻璃大方块，一键建项目 ── */}
          <section>
            <SectionTitle
              icon={<Sparkles className="w-3.5 h-3.5" strokeWidth={2} />}
              title="快速开始 · 风格模板"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {STYLE_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleTemplate(t)}
                  className={`group relative h-[152px] rounded-[24px] overflow-hidden border border-white/25 bg-gradient-to-br ${t.grad} p-4 text-left shadow-[0_20px_44px_-24px_rgba(15,23,42,.55)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_32px_60px_-24px_rgba(76,29,149,.6)] active:scale-[.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-glow)]`}
                >
                  {/* 玻璃反光 + 大号图标水印 */}
                  <span aria-hidden="true" className="absolute -inset-y-12 -left-1/4 w-3/4 rotate-[16deg] bg-white/15 blur-2xl" />
                  <span aria-hidden="true" className="absolute -right-8 -bottom-10 w-28 h-28 rounded-full border border-white/15" />
                  <span aria-hidden="true" className="absolute -right-4 -bottom-16 w-40 h-40 rounded-full border border-white/10" />
                  <span aria-hidden="true" className="absolute inset-x-6 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(255,255,255,.7),transparent)]" />

                  <div className="relative h-full flex flex-col justify-between">
                    <span className="text-[24px] leading-none" aria-hidden="true">{t.icon}</span>
                    <div>
                      <div className="text-[13.5px] font-bold text-white">{t.label}</div>
                      <div className="mt-0.5 text-[10.5px] text-white/70 truncate">{t.desc}</div>
                    </div>
                  </div>

                  <span className="absolute top-3.5 right-3.5 w-6 h-6 rounded-lg border border-white/40 bg-white/15 backdrop-blur-md flex items-center justify-center opacity-0 group-hover:opacity-100 translate-x-1 group-hover:translate-x-0 transition-all duration-300">
                    <Plus className="w-3.5 h-3.5 text-white" strokeWidth={2.4} />
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* ── ④ 工具与状态行：磨砂条 ── */}
          <section className={`flex flex-wrap items-center gap-2 rounded-[22px] ${GLASS} px-3.5 py-3`}>
            <span className={`text-[10.5px] font-semibold tracking-wider ${T_MUTED} mr-1`}>工具</span>
            {[
              { evt: 'open-skill-studio', icon: <Wand2 className="w-3.5 h-3.5" strokeWidth={1.9} />, label: '技能工坊' },
              { evt: 'open-mcp-tools', icon: <Wrench className="w-3.5 h-3.5" strokeWidth={1.9} />, label: 'MCP 工具' },
              { evt: 'open-provider-manager', icon: <Server className="w-3.5 h-3.5" strokeWidth={1.9} />, label: '生成源管理' },
            ].map((it) => (
              <button
                key={it.evt}
                onClick={() => dispatchOpen(it.evt)}
                className={`h-8 px-3.5 inline-flex items-center gap-1.5 rounded-xl border border-white/70 bg-white/50 text-[11.5px] font-medium ${T_SEC} hover:[color:var(--color-text-main)] hover:bg-white/80 transition-colors dark:border-white/10 dark:bg-white/[.05] dark:hover:bg-white/[.09]`}
              >
                {it.icon}{it.label}
              </button>
            ))}
            <button
              onClick={goBoard}
              title={boardOn ? '进入项目看板' : BOARD_OFF_HINT}
              className={`h-8 px-3.5 inline-flex items-center gap-1.5 rounded-xl border border-white/70 bg-white/50 text-[11.5px] font-medium ${T_SEC} hover:bg-white/80 transition-colors dark:border-white/10 dark:bg-white/[.05] dark:hover:bg-white/[.09] ${boardCls}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" strokeWidth={1.9} />项目看板
            </button>
          </section>
        </div>
      </div>

      {/* 长篇小说一键转漫剧（复用现有自包含弹窗） */}
      <ScriptImportView isOpen={scriptOpen} onClose={() => setScriptOpen(false)} />
    </div>
  );
};

export default HomeView;
