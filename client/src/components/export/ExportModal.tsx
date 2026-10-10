import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { 
  X, 
  Share2, 
  Download, 
  Film, 
  CheckCircle2, 
  Sparkles, 
  FolderDown,
  Layers,
  Music,
  AlertTriangle
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { API_ORIGIN } from '../../utils/devOrigin';
import { apiService } from '../../services/api';
import { syncExporterSpecs, listExporterSpecs, type ExporterInfo } from '../../services/exporterSpecs';
import { syncExporterEntries, clearExporterEntries } from '../../ui-registry/adapters/exporterEntries';
import { ExportBridgeContext } from '../../ui-registry/exportBridge';
import { UISlot } from '../../ui-registry/UISlot';
import { useUIEntries } from '../../ui-registry/resolveEnabled';
import { EXPORTER_ROWS_HOST } from '../../ui-registry/types';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';
import { AssetPickerModal } from '../asset/AssetPickerModal';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose }) => {
  const { project, totalDuration, setProject } = useProjectStore();
  const [isExporting, setIsExporting] = useState(false);
  const [exportedDraft, setExportedDraft] = useState<any>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [engine, setEngine] = useState<{ installed: boolean; error?: string | null } | null>(null);
  const [pickingBgm, setPickingBgm] = useState(false);
  /**
   * 导出器列表已进注册表（设计 §12 桥接）：宿主负责「拉数据 → 声明进注册表」+ 注入运行回调，
   * 列表本身从槽里读 —— 插件增删重跑一次 `syncExporterEntries()` 即可，不必重挂弹窗。
   */
  const exporterEntries = useUIEntries(EXPORTER_ROWS_HOST);
  /** 当前导出器声明：`runExport(id)` 需要完整 spec（注册表只保证「在不在」） */
  const exporterSpecsRef = useRef<ExporterInfo[]>([]);
  const [exporterBusyId, setExporterBusyId] = useState('');
  const [exporterResults, setExporterResults] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const resync = () => {
      syncExporterSpecs(project?.id)
        .then(() => {
          if (cancelled) return;
          const specs = listExporterSpecs();
          exporterSpecsRef.current = specs;
          // 宿主是唯一知道 `/exporters` 返回的地方 → 由它把声明送进注册表（设计 §12 规则 1）
          syncExporterEntries(specs);
        })
        .catch(() => {});
    };
    resync();
    // 插件启停经 SSE 重播该事件：弹窗打开期间也能实时增删导出器行
    // （未完成清单第 11 条当年记的「`exporter-list-refresh` 无监听方」由此关闭）
    window.addEventListener('exporter-list-refresh', resync);
    apiService.jianyinEngine()
      .then((s) => { if (!cancelled) setEngine(s); })
      .catch(() => { if (!cancelled) setEngine({ installed: false, error: '引擎自检请求失败' }); });
    return () => {
      cancelled = true;
      window.removeEventListener('exporter-list-refresh', resync);
      // 关闭 / 切项目：撤掉导出器条目，别在注册表里留下「上次打开时」的陈旧列表
      clearExporterEntries();
      exporterSpecsRef.current = [];
    };
  }, [isOpen, project?.id]);

  /**
   * 运行某个导出器（宿主侧）：装配 project → 调 `/exporters/{id}/run` → 记录结果。
   * 定义在早退之前，好让下面的桥接 `useMemo` 能把它作为依赖（hooks 必须在早退之前调用）。
   */
  const handleRunExporter = useCallback(async (spec: ExporterInfo) => {
    if (!project) return; // 无项目时弹窗本就不渲染，这里只是收紧类型
    setExporterBusyId(spec.id);
    setExporterResults((prev) => ({ ...prev, [spec.id]: undefined }));
    try {
      const shots = project.scenes.flatMap((s) => s.shots);
      const res = await apiService.runExporter({
        exporter_id: spec.id,
        project_id: project.id,
        payload: {
          project,
          shots,
          characters: project.characters || [],
          meta: { title: project.title, aspect_ratio: project.aspect_ratio, style_preset: project.style_preset },
        },
      });
      setExporterResults((prev) => ({ ...prev, [spec.id]: res }));
    } catch (e: any) {
      setExporterResults((prev) => ({ ...prev, [spec.id]: { error: e?.message || String(e) } }));
    } finally {
      setExporterBusyId('');
    }
  }, [project]);

  /** 注入给导出器条目的桥接：条目只报 id，spec 由宿主查（注册表不认识回调，见设计 §12 规则 2） */
  const exportBridge = useMemo(() => ({
    runExport: (id: string) => {
      const spec = exporterSpecsRef.current.find((s) => s.id === id);
      if (spec) void handleRunExporter(spec);
    },
    busyId: exporterBusyId,
    results: exporterResults,
  }), [handleRunExporter, exporterBusyId, exporterResults]);

  useEscapeClose(isOpen, onClose);
  if (!isOpen || !project) return null;

  const engineReady = engine === null || engine.installed;

  const handleExportJianYing = async () => {
    setIsExporting(true);
    setExportError(null);
    setExportedDraft(null);
    try {
      const res = await apiService.exportJianYingDraft(project);
      setExportedDraft(res);
    } catch (e: any) {
      setExportError(e?.message || '导出失败');
    } finally {
      setIsExporting(false);
    }
  };

  const downloadJsonFile = () => {
    if (!exportedDraft) return;
    const blob = new Blob([JSON.stringify(exportedDraft, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportedDraft.filename || `draft_${project.title}.json`;
    a.click();
  };

  const bindBgm = (asset: { name: string; url: string }) => {
    setProject({ ...project, bgm_url: asset.url, bgm_name: asset.name } as any);
    setExportedDraft(null);
  };

  const clearBgm = () => {
    setProject({ ...project, bgm_url: null, bgm_name: '' } as any);
    setExportedDraft(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-2xl bg-surface/80 rounded-2xl border border-white/70 dark:border-white/12 flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-white/70 dark:border-white/12 flex items-center justify-between bg-surface/80">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white shadow-sm">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">工程导出与成片分发中心</h2>
              <p className="text-[11px] text-gray-400">
                导出剪映/CapCut 官方草稿工程（画面/配音/字幕/可选 BGM 轨）
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-hover/80"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5">
          {/* Project Summary Card */}
          <div className="bg-surface/80 p-4 rounded-xl border border-white/70 dark:border-white/12 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {project.scenes[0]?.shots[0]?.image_url ? (
                <AutoRatioMedia
                  src={project.scenes[0].shots[0].image_url?.startsWith('/') ? API_ORIGIN + project.scenes[0].shots[0].image_url : project.scenes[0].shots[0].image_url}
                  fallbackAspect="1/1"
                  maxHeight={48}
                  className="rounded-lg border border-white/70 dark:border-white/12 shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-lg overflow-hidden bg-surface/80 border border-white/70 dark:border-white/12 flex-shrink-0 flex items-center justify-center text-[9px] text-gray-500">无图</div>
              )}
              <div>
                <h3 className="text-xs font-bold text-white">{project.title}</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {project.scenes.flatMap((s) => s.shots).length} 个分镜 · 总时长 {totalDuration.toFixed(1)}s · {project.aspect_ratio} 竖屏
                </p>
              </div>
            </div>
            <span className="text-xs px-2.5 py-1 rounded-full bg-brand/20 text-brand-light border border-brand/30 font-medium">
              {project.style_preset}
            </span>
          </div>

          {/* 全片 BGM 绑定：决定草稿里是否生成 bgm 轨 */}
          <div className="flex items-center gap-2 text-[11px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2">
            <Music className="w-3.5 h-3.5 text-accent-orange shrink-0" />
            <span className="text-gray-400 shrink-0">全片 BGM</span>
            {project.bgm_url ? (
              <>
                <span className="text-gray-200 truncate flex-1" title={project.bgm_url}>{project.bgm_name || project.bgm_url.split('/').pop()}</span>
                <button onClick={() => setPickingBgm(true)} className="px-2 py-0.5 rounded-lg bg-surface-hover/80 hover:bg-surface/80 border border-white/70 dark:border-white/12 text-gray-300 shrink-0">更换</button>
                <button onClick={clearBgm} className="px-2 py-0.5 rounded-lg hover:bg-surface-hover/80 border border-white/70 dark:border-white/12 text-gray-500 hover:text-red-300 shrink-0">清除</button>
              </>
            ) : (
              <>
                <span className="text-gray-500 flex-1">未绑定音频素材，导出的草稿不会包含 BGM 轨</span>
                <button onClick={() => setPickingBgm(true)} className="px-2 py-0.5 rounded-lg bg-accent-orange/15 hover:bg-accent-orange/25 border border-accent-orange/40 text-accent-orange shrink-0">绑定 BGM</button>
              </>
            )}
          </div>

          {/* Export Options Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Option 1: 剪映官方草稿导出 (Highlight!) */}
            <div className="bg-surface/80 p-5 rounded-2xl border-2 border-brand/60 relative overflow-hidden flex flex-col justify-between shadow-lg">
              <span className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-brand text-[9px] font-bold text-white">
                推荐首选
              </span>

              <div>
                <div className="flex items-center space-x-2 mb-2">
                  <FolderDown className="w-5 h-5 text-brand-light" />
                  <h4 className="text-xs font-bold text-white">剪映 / CapCut 官方草稿工程</h4>
                </div>
                <p className="text-[11px] text-gray-400 leading-relaxed mb-4">
                  直接导出为 <code className="text-brand-light font-mono">draft_content.json</code>：主画面轨按<em className="not-italic text-gray-200">素材真实时长</em>排布（静帧可延长、视频不冻帧），配音与字幕对齐到同一槽位；缺素材的镜头会被明确列出而不是静默错轨。
                </p>
              </div>

              {exportedDraft ? (
                <div className="space-y-2">
                  <div className="flex items-start space-x-1.5 text-xs text-accent-green font-semibold">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      草稿已生成：{exportedDraft.video_segments} 画面 / {exportedDraft.audio_segments} 配音 / {exportedDraft.caption_segments} 字幕，
                      全片实长 {Number(exportedDraft.duration_seconds || 0).toFixed(1)}s
                      （设计 {Number(exportedDraft.design_duration_seconds || 0).toFixed(1)}s）
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 text-[10px]">
                    {(exportedDraft.tracks || []).map((t: string) => (
                      <span key={t} className="px-1.5 py-0.5 rounded bg-surface-hover/80 border border-white/70 dark:border-white/12 text-gray-300 font-mono">{t}</span>
                    ))}
                    <span className={`px-1.5 py-0.5 rounded border font-mono ${exportedDraft.bgm?.bound ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-surface-hover/80 border-white/70 dark:border-white/12 text-gray-500'}`}>
                      {exportedDraft.bgm?.bound ? `bgm ×${exportedDraft.bgm.segments}` : 'bgm 未绑定'}
                    </span>
                  </div>
                  {exportedDraft.skipped_shots?.length > 0 && (
                    <div className="text-[10px] text-red-300 bg-red-500/10 p-2 rounded border border-red-500/25 max-h-24 overflow-y-auto">
                      <div className="font-bold mb-0.5">{exportedDraft.skipped_shots.length} 个镜头因无可用素材未进入草稿：</div>
                      {exportedDraft.skipped_shots.map((s: any, i: number) => (<div key={i}>#{s.shot_index} {s.reason}</div>))}
                    </div>
                  )}
                  {exportedDraft.warnings?.length > 0 && (
                    <div className="text-[10px] text-amber-300 bg-amber-500/10 p-2 rounded border border-amber-500/20 max-h-20 overflow-y-auto">
                      {exportedDraft.warnings.map((w: string, i: number) => (<div key={i}>⚠️ {w}</div>))}
                    </div>
                  )}
                  <details className="text-[10px]">
                    <summary className="cursor-pointer text-gray-400 hover:text-gray-200">逐镜时间线回执（{exportedDraft.report?.length || 0} 条）</summary>
                    <div className="mt-1 max-h-32 overflow-y-auto font-mono text-gray-400 space-y-0.5">
                      {(exportedDraft.report || []).map((r: any, i: number) => (
                        <div key={i} className="flex gap-2">
                          <span className="text-gray-500 w-8 shrink-0">#{r.shot_index}</span>
                          <span className="w-24 shrink-0">{(r.start_us / 1e6).toFixed(2)}s → {((r.start_us + r.slot_us) / 1e6).toFixed(2)}s</span>
                          <span className="truncate flex-1" title={r.picture || ''}>{r.picture || '无画面'}</span>
                          {r.audio && <span className="text-accent-pink">配音</span>}
                          {(r.notes || []).map((n: string, j: number) => <span key={j} className="text-amber-300">{n}</span>)}
                        </div>
                      ))}
                    </div>
                  </details>
                  <div className="text-[10px] text-gray-500 font-mono break-all">📁 {exportedDraft.export_dir}</div>
                  <div className="flex items-center space-x-2">
                    {exportedDraft.export_dir && (
                      <button
                        onClick={() => apiService.openFolder(exportedDraft.export_dir)}
                        className="flex-1 py-2 rounded-xl bg-surface-hover/80 hover:bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-brand-light hover:text-white font-medium flex items-center justify-center space-x-1.5 transition-all"
                      >
                        <FolderDown className="w-3.5 h-3.5" />
                        <span>在资源管理器中打开草稿箱</span>
                      </button>
                    )}
                    {exportedDraft.file_url && (
                      <a
                        href={API_ORIGIN + exportedDraft.file_url}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-2 rounded-xl bg-surface-hover/80 hover:bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-gray-300 hover:text-white text-center"
                      >
                        预览 JSON
                      </a>
                    )}
                  </div>
                  <button
                    onClick={downloadJsonFile}
                    className="w-full py-2.5 rounded-xl bg-accent-green hover:bg-accent-green/90 text-black font-bold text-xs flex items-center justify-center space-x-2 shadow-lg"
                  >
                    <Download className="w-4 h-4" />
                    <span>下载 draft_content.json</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {exportError && <div className="text-xs text-red-300 bg-red-500/15 p-2 rounded border border-red-500/30">⚠️ {exportError}</div>}
                  {!engineReady && (
                    <div className="text-[10px] text-amber-200 bg-amber-500/10 p-2 rounded border border-amber-500/25 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>剪映导出引擎未就绪：{engine?.error || ''}<br />开发环境执行 <code className="font-mono">pip install pyJianYingDraft pymediainfo</code> 后重启服务（打包版已内置）</span>
                    </div>
                  )}
                  <button
                    onClick={handleExportJianYing}
                    disabled={isExporting || !engineReady}
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white font-bold text-xs flex items-center justify-center space-x-2 shadow-lg shadow-brand/20 hover:opacity-90 transition-all disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <Sparkles className={`w-4 h-4 ${isExporting ? 'animate-spin' : ''}`} />
                    <span>{isExporting ? '生成多轨草稿中...' : '一键导出剪映草稿 (真实 pyJianYingDraft)'}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Option 2: MP4 / SRT 视频合成与字幕 — 尚未接入真实渲染 */}
            <div className="bg-surface/80 p-5 rounded-2xl border border-white/70 dark:border-white/12 flex flex-col justify-between opacity-80">
              <div>
                <div className="flex items-center space-x-2 mb-2">
                  <Film className="w-5 h-5 text-accent-orange" />
                  <h4 className="text-xs font-bold text-white">MP4 成片视频与字幕 (1080P/4K)</h4>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">开发中</span>
                </div>
                <p className="text-[11px] text-gray-400 leading-relaxed mb-4">
                  FFmpeg 硬件合成运镜动效 + 配音 + 特效字幕为 MP4/SRT（待接入真实渲染管线，当前可用剪映草稿方式出片）。
                </p>
              </div>

              <div className="space-y-2">
                <div className="text-[10px] text-amber-300 bg-amber-500/10 p-2 rounded border border-amber-500/20">暂未开放，将通过 FFmpeg + ComfyUI 视频模型合成</div>
              </div>
            </div>
          </div>

          {/* 插件导出器（exporters 扩展点）：行 = 注册表条目（设计 §12 桥接）
              —— 宿主保留这一节的标题/说明与网格容器，条目自己渲染卡片并自标；
              运行导出的能力由 `ExportBridgeContext` 注入（条目只报 id）。 */}
          {exporterEntries.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-bold text-white flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-accent-green" />插件导出器
                <span className="text-[10px] font-normal text-gray-500">来自插件包 exporters：SRT/第三方草稿/FFmpeg 命令等可扩展目标</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <ExportBridgeContext.Provider value={exportBridge}>
                  <UISlot host={EXPORTER_ROWS_HOST} />
                </ExportBridgeContext.Provider>
              </div>
            </div>
          )}
        </div>
      </div>

      <AssetPickerModal
        isOpen={pickingBgm}
        title="从素材库选择 BGM"
        mediaType="audio"
        defaultCategory="background"
        onSelect={(asset) => { bindBgm(asset); setPickingBgm(false); }}
        onClose={() => setPickingBgm(false)}
      />
    </div>
  );
};
