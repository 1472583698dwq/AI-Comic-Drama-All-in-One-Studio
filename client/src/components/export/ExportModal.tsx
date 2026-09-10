import React, { useState } from 'react';
import { 
  X, 
  Share2, 
  Download, 
  Film, 
  FileText, 
  CheckCircle2, 
  Sparkles, 
  FolderDown,
  Layers
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { apiService } from '../../services/api';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose }) => {
  const { project, totalDuration } = useProjectStore();
  const [isExporting, setIsExporting] = useState(false);
  const [exportedDraft, setExportedDraft] = useState<any>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  if (!isOpen || !project) return null;

  const API_ORIGIN = 'http://127.0.0.1:8000';

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-2xl bg-surface rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-border flex items-center justify-between bg-surface-secondary/60">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white shadow-sm">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">工程导出与成片分发中心</h2>
              <p className="text-[11px] text-gray-400">
                支持剪映/CapCut 官方草稿工程无损导出，以及 4K/1080P 音画合成
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5">
          {/* Project Summary Card */}
          <div className="bg-surface-secondary p-4 rounded-xl border border-border flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-12 h-12 rounded-lg overflow-hidden bg-black/60 border border-border flex-shrink-0">
                {project.scenes[0]?.shots[0]?.image_url ? (
                  <img
                    src={project.scenes[0].shots[0].image_url?.startsWith('/') ? API_ORIGIN + project.scenes[0].shots[0].image_url : project.scenes[0].shots[0].image_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">无图</div>
                )}
              </div>
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

          {/* Export Options Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Option 1: 剪映官方草稿导出 (Highlight!) */}
            <div className="bg-surface-secondary/70 p-5 rounded-2xl border-2 border-brand/60 relative overflow-hidden flex flex-col justify-between shadow-lg">
              <span className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-brand text-[9px] font-bold text-white">
                推荐首选
              </span>

              <div>
                <div className="flex items-center space-x-2 mb-2">
                  <FolderDown className="w-5 h-5 text-brand-light" />
                  <h4 className="text-xs font-bold text-white">剪映 / CapCut 官方草稿工程</h4>
                </div>
                <p className="text-[11px] text-gray-400 leading-relaxed mb-4">
                  直接导出为 <code className="text-brand-light font-mono">draft_content.json</code>，分镜画面轨、角色对白轨、旁白轨、动态字幕与 BGM 100% 自动精确对齐，可在剪映中二次精修。
                </p>
              </div>

              {exportedDraft ? (
                <div className="space-y-2">
                  <div className="flex items-center space-x-1.5 text-xs text-accent-green font-semibold">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>草稿生成完毕！（{exportedDraft.video_segments} 个画面片段 / {exportedDraft.caption_segments} 条字幕）</span>
                  </div>
                  {exportedDraft.warnings?.length > 0 && (
                    <div className="text-[10px] text-amber-300 bg-amber-500/10 p-2 rounded border border-amber-500/20 max-h-20 overflow-y-auto">
                      {exportedDraft.warnings.map((w: string, i: number) => (<div key={i}>⚠️ {w}</div>))}
                    </div>
                  )}
                  <div className="text-[10px] text-gray-500 font-mono break-all">📁 {exportedDraft.export_dir}</div>
                  <div className="flex items-center space-x-2">
                    {exportedDraft.export_dir && (
                      <button
                        onClick={() => apiService.openFolder(exportedDraft.export_dir)}
                        className="flex-1 py-2 rounded-xl bg-surface-tertiary hover:bg-surface border border-border text-xs text-brand-light hover:text-white font-medium flex items-center justify-center space-x-1.5 transition-all"
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
                        className="px-3 py-2 rounded-xl bg-surface-tertiary hover:bg-surface border border-border text-xs text-gray-300 hover:text-white text-center"
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
                  <button
                    onClick={handleExportJianYing}
                    disabled={isExporting}
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white font-bold text-xs flex items-center justify-center space-x-2 shadow-lg shadow-brand/20 hover:opacity-90 transition-all"
                  >
                    <Sparkles className={`w-4 h-4 ${isExporting ? 'animate-spin' : ''}`} />
                    <span>{isExporting ? '生成多轨草稿中...' : '一键导出剪映草稿 (真实 pyJianYingDraft)'}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Option 2: MP4 / SRT 视频合成与字幕 — 尚未接入真实渲染 */}
            <div className="bg-surface-secondary/70 p-5 rounded-2xl border border-border flex flex-col justify-between opacity-80">
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
        </div>
      </div>
    </div>
  );
};
