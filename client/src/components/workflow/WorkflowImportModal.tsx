// -*- coding: utf-8 -*-
/**
 * ComfyUI 工作流导入弹窗 —「工作流 → 派生生成源」链路的统一入口。
 * 三种导入方式：上传 .json / 粘贴 JSON 文本 / 外部目录直读。
 * 导入成功后打开 WorkflowInspectorModal 配置槽位映射，保存即派生生成源（后端 sync_workflow_provider）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, Upload, FileJson, FolderOpen, Loader2, AlertTriangle, RefreshCw, Check, ArrowRight } from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 导入完成（已生成内部工作流 id）；调用方通常接着打开槽位配置 */
  onImported?: (workflowId: string) => void;
}

const dropCls =
  'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/70 dark:border-white/12 bg-white/50 dark:bg-white/[.04] hover:border-brand/50 transition-colors cursor-pointer';

export const WorkflowImportModal: React.FC<Props> = ({ isOpen, onClose, onImported }) => {
  const [tab, setTab] = useState<'file' | 'json' | 'external'>('file');
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonName, setJsonName] = useState('');
  const [extList, setExtList] = useState<any[]>([]);
  const [extDir, setExtDir] = useState<any>(null);
  const [extLoading, setExtLoading] = useState(false);

  useEscapeClose(isOpen, onClose);

  const loadExternal = async () => {
    setExtLoading(true);
    try {
      const [dir, list] = await Promise.all([
        apiService.getExternalWorkflowsDir().catch(() => null),
        apiService.listWorkflows('external').catch(() => ({ workflows: [] })),
      ]);
      setExtDir(dir);
      setExtList(list?.workflows || []);
    } finally {
      setExtLoading(false);
    }
  };
  useEffect(() => { if (isOpen && tab === 'external') loadExternal(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isOpen, tab]);

  const finishImport = (res: any, label: string) => {
    const wf = res?.workflow || res?.meta || {};
    const id = wf.id || wf.workflow_id || '';
    toast.success(`✓ 已导入「${wf.name || label || id}」，接着配置槽位映射`);
    onImported?.(id);
  };

  const doUploadFile = async (f: File) => {
    if (!f.name.toLowerCase().endsWith('.json')) { toast.error('只支持 ComfyUI 工作流 .json 文件'); return; }
    setBusy('file');
    try {
      const res = await apiService.uploadWorkflow(f);
      finishImport(res, f.name);
    } catch (e: any) {
      toast.error(e?.message || '上传失败');
    } finally { setBusy(null); }
  };

  const doUploadJson = async () => {
    const text = jsonText.trim();
    if (text.length < 10) { toast.error('请粘贴 ComfyUI 工作流 JSON（API Format）'); return; }
    try { JSON.parse(text); } catch { toast.error('JSON 格式无效，请检查粘贴内容'); return; }
    setBusy('json');
    try {
      const res = await apiService.uploadWorkflowJson(text, jsonName || undefined);
      finishImport(res, jsonName || '粘贴的工作流');
      setJsonText(''); setJsonName('');
    } catch (e: any) {
      toast.error(e?.message || '导入失败');
    } finally { setBusy(null); }
  };

  const doImportExternal = async (wf: any) => {
    setBusy(wf.id);
    try {
      const res = await apiService.importExternalWorkflow(wf.id);
      finishImport(res, wf.name || wf.id);
    } catch (e: any) {
      toast.error(e?.message || '导入失败');
    } finally { setBusy(null); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in" onClick={onClose}>
      <div
        role="dialog"
        aria-label="导入 ComfyUI 工作流"
        className="w-full max-w-2xl max-h-[85vh] bg-white/60 dark:bg-white/[.05] rounded-2xl border border-white/70 dark:border-white/12 flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-12 px-5 border-b border-white/70 dark:border-white/12 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400"><FileJson className="w-4 h-4" /></div>
            <div>
              <div className="text-sm font-bold text-[color:var(--color-text-main)]">导入 ComfyUI 工作流</div>
              <div className="text-[10.5px] [color:var(--color-text-muted)]">导入后配置槽位映射，保存即自动生成一个独立生成源</div>
            </div>
          </div>
          <button onClick={onClose} aria-label="关闭" className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-white/55 dark:bg-white/[.06]">
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 flex items-center gap-1.5 shrink-0">
          {([['file', '上传 .json'], ['json', '粘贴 JSON'], ['external', '外部目录']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-full text-[11.5px] font-medium border transition-colors ${
                tab === k ? 'bg-brand/15 text-brand border-brand/40' : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)]'
              }`}
            >{label}</button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-3">
          {tab === 'file' && (
            <>
              <div
                className={`${dropCls} h-40 ${dragOver ? 'border-brand' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault(); setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) doUploadFile(f);
                }}
              >
                {busy === 'file'
                  ? <Loader2 className="w-6 h-6 animate-spin text-brand" />
                  : <Upload className="w-6 h-6 [color:var(--color-text-muted)]" strokeWidth={1.7} />}
                <div className="text-[12px] [color:var(--color-text-secondary)]">
                  {busy === 'file' ? '正在导入…' : '点击选择或拖入 ComfyUI 工作流 .json 文件'}
                </div>
                <div className="text-[10px] [color:var(--color-text-muted)]">支持 ComfyUI API Format JSON</div>
                <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) doUploadFile(f); e.target.value = ''; }} />
              </div>
            </>
          )}

          {tab === 'json' && (
            <div className="space-y-2">
              <input
                value={jsonName} onChange={(e) => setJsonName(e.target.value)}
                placeholder="名称（可选，如 我的换脸工作流）"
                className="w-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-lg px-3 py-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"
              />
              <textarea
                value={jsonText} onChange={(e) => setJsonText(e.target.value)}
                placeholder='粘贴 ComfyUI 工作流 JSON（API Format）… 例如 {"3": {"class_type": "KSampler", ...}}'
                rows={10}
                className="w-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl p-3 text-[11px] font-mono [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none"
              />
              <div className="flex justify-end">
                <button
                  onClick={doUploadJson} disabled={busy === 'json'}
                  className="px-4 py-2 rounded-lg bg-brand text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
                >
                  {busy === 'json' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileJson className="w-3.5 h-3.5" />}
                  {busy === 'json' ? '导入中…' : '导入并配置槽位'}
                </button>
              </div>
            </div>
          )}

          {tab === 'external' && (
            <div className="space-y-2">
              {extDir && (
                <div className={`p-2.5 rounded-lg border text-[11px] flex items-start gap-1.5 ${extDir.exists ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-amber-500/10 border-amber-500/25 text-amber-200'}`}>
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span className="min-w-0 break-all">
                    {extDir.exists
                      ? <>外部目录：<span className="font-mono">{extDir.resolved_dir}</span>（直接选用下面的工作流即可导入）</>
                      : extDir.is_configured
                        ? <>外部目录未找到：<span className="font-mono">{extDir.configured_dir}</span>（目录不存在，请检查 COMFYUI_WORKFLOWS_DIR）</>
                        : <>未配置外部目录（COMFYUI_WORKFLOWS_DIR）。可先用上面两个方式导入，或到系统设置配置目录。</>}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-[11px] [color:var(--color-text-muted)]">外部目录里的工作流（{extList.length}）</span>
                <button onClick={loadExternal} disabled={extLoading} className="ml-auto flex items-center gap-1 text-[10.5px] [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] disabled:opacity-50">
                  {extLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}刷新
                </button>
              </div>
              {extLoading && extList.length === 0 && (
                <div className="py-6 text-center text-[11px] [color:var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" />加载中…</div>
              )}
              {!extLoading && extList.length === 0 && (
                <div className="py-6 text-center text-[11px] [color:var(--color-text-muted)]">
                  外部目录暂无工作流。把 ComfyUI 模板 .json 放进目录后点刷新，或用「上传 / 粘贴」方式导入。
                </div>
              )}
              <div className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
                {extList.map((wf) => (
                  <div key={wf.id} className="flex items-center gap-2 p-2 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12">
                    <FolderOpen className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] [color:var(--color-text-main)] truncate">{wf.name || wf.id}</div>
                      <div className="text-[9.5px] font-mono [color:var(--color-text-muted)] truncate">{wf.id}{wf.source_file ? ` · ${wf.source_file}` : ''}</div>
                    </div>
                    <button
                      onClick={() => doImportExternal(wf)}
                      disabled={busy === wf.id}
                      className="px-2.5 py-1 rounded-lg bg-brand/10 border border-brand/30 text-brand text-[10.5px] font-semibold flex items-center gap-1 disabled:opacity-50 shrink-0"
                    >
                      {busy === wf.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}导入
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/70 dark:border-white/12 flex items-center gap-2 shrink-0">
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-[10.5px] [color:var(--color-text-muted)]">导入后会自动打开槽位映射配置；保存后该工作流即成为一个独立生成源，画布/素材库/分镜台都能选。</span>
          <button onClick={onClose} className="ml-auto px-3.5 py-1.5 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-xs [color:var(--color-text-main)]">关闭</button>
        </div>
      </div>
    </div>
  );
};
