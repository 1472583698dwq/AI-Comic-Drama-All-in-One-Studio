import React, { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Sliders, Loader2, Image as ImageIcon, Video, Plus } from 'lucide-react';
import { apiService } from '../../services/api';
import { toast, confirmAsync } from '../../stores/useDialogStore';
import { WorkflowInspectorModal } from '../../components/workflow/WorkflowInspectorModal';

interface Props {
  defaultImage: string;
  defaultVideo: string;
  /** 设/取消默认只改草稿，跟着页面统一的保存按钮走 */
  onSetDefault: (key: string, value: string) => void;
}

/** ComfyUI 工作流清单：导入的每个工作流都会变成一个独立生成源，所以放在生图卡里就近管理。 */
export const ComfyWorkflowList: React.FC<Props> = ({ defaultImage, defaultVideo, onSetDefault }) => {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [inspectId, setInspectId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiService.listWorkflows('all');
      setList(r?.workflows || r || []);
    } catch { /* 空列表即可 */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (wf: any) => {
    if (wf.source !== 'internal') {
      toast.warning('外部直读的工作流是只读的，要删请到文件系统里删');
      return;
    }
    const ok = await confirmAsync({
      title: '删除工作流', isDanger: true, confirmText: '确认删除', cancelText: '取消',
      message: `删除「${wf.name || wf.id}」后，它对应的那个生成源也会一起消失。`,
    });
    if (!ok) return;
    try {
      await apiService.deleteWorkflow(wf.id);
      toast.success('已删除');
      await load();
      window.dispatchEvent(new Event('provider-list-refresh'));
    } catch (e: any) { toast.error(e?.message || '删除失败'); }
  };

  return (
    <div className="mt-3.5 rounded-xl border border-white/70 dark:border-white/12 bg-white/40 dark:bg-white/[.03] overflow-hidden">
      <div className="px-3.5 py-2 border-b border-white/60 dark:border-white/12 flex items-center gap-2">
        <span className="text-[11.5px] font-bold [color:var(--color-text-main)]">工作流</span>
        <span className="text-[10.5px] text-gray-500">{list.length} 个 · 每个都是一个生成源</span>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('open-workflow-import'))}
          className="ml-auto px-2 py-0.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[10.5px] text-emerald-300 hover:text-emerald-200 flex items-center gap-1"
        >
          <Plus className="w-3 h-3" />导入工作流
        </button>
        <button onClick={load} disabled={loading}
          className="text-[10.5px] text-gray-400 hover:text-white flex items-center gap-1 disabled:opacity-40">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}刷新
        </button>
      </div>

      {list.length === 0 ? (
        <div className="px-3.5 py-4 text-[11px] text-gray-500">
          还没有工作流。点右上「导入工作流」，支持上传/粘贴 .json 或从外部目录直接选 ComfyUI 模板。
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto custom-scrollbar divide-y divide-border/60">
          {list.map((wf) => {
            const isImg = defaultImage === wf.id;
            const isVid = defaultVideo === wf.id;
            return (
              <div key={wf.id} className="px-3.5 py-2 flex items-center gap-2 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11.5px] text-[color:var(--color-text-main)] truncate">{wf.name || wf.id}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                      wf.source === 'internal'
                        ? 'border-white/70 dark:border-white/12 bg-white/65 dark:bg-white/[.09] text-gray-400'
                        : 'border-sky-500/40 bg-sky-500/10 text-sky-300'}`}>
                      {wf.source === 'internal' ? '已导入' : '外部直读'}
                    </span>
                    {isImg && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">默认生图</span>}
                    {isVid && <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/40 text-violet-300">默认视频</span>}
                  </div>
                  <div className="text-[9.5px] font-mono text-gray-600 truncate">{wf.id}</div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => onSetDefault('COMFYUI_DEFAULT_IMAGE_WORKFLOW', isImg ? '' : wf.id)}
                    className={`px-2 py-0.5 rounded-lg border text-[10.5px] flex items-center gap-1 ${
                      isImg ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] text-gray-400 hover:text-white'}`}>
                    <ImageIcon className="w-2.5 h-2.5" />{isImg ? '取消默认' : '设默认生图'}
                  </button>
                  <button onClick={() => onSetDefault('COMFYUI_DEFAULT_VIDEO_WORKFLOW', isVid ? '' : wf.id)}
                    className={`px-2 py-0.5 rounded-lg border text-[10.5px] flex items-center gap-1 ${
                      isVid ? 'border-violet-500/40 bg-violet-500/10 text-violet-300' : 'border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] text-gray-400 hover:text-white'}`}>
                    <Video className="w-2.5 h-2.5" />{isVid ? '取消默认' : '设默认视频'}
                  </button>
                  <button onClick={() => setInspectId(wf.id)} title="查看/编辑槽位参数"
                    className="px-2 py-0.5 rounded-lg border border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] text-[10.5px] text-gray-300 hover:text-white flex items-center gap-1">
                    <Sliders className="w-2.5 h-2.5" />参数
                  </button>
                  {wf.source === 'internal' && (
                    <button onClick={() => remove(wf)} title="删除"
                      className="px-1.5 py-0.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:text-white">
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {inspectId && (
        <WorkflowInspectorModal
          workflowId={inspectId} isOpen={!!inspectId}
          onClose={() => setInspectId('')}
          onSaved={() => { load(); window.dispatchEvent(new Event('provider-list-refresh')); }}
        />
      )}
    </div>
  );
};
