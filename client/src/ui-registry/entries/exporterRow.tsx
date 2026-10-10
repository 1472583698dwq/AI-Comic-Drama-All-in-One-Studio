import React from 'react';
import { FileText } from 'lucide-react';
import { API_ORIGIN } from '../../utils/devOrigin';
import { apiService } from '../../services/api';
import { useExportBridge } from '../exportBridge';
import { markAttrs } from '../types';
import type { ExporterInfo } from '../../services/exporterSpecs';

/**
 * **导出器行**（`exporters` 扩展点的条目渲染组件，设计 §12）。
 *
 * 与改造前 `ExportModal` 里的卡片逐字一致，只是数据与回调改从两处来：
 *   · `spec`（原始声明）由适配器在注册时用闭包传进来；
 *   · `runExport` / `busyId` / `results` 由宿主通过 `ExportBridgeContext` 注入。
 *
 * **自标**：`modal.export` 是 CSS grid 宿主，槽位不给包裹层（包裹层会成为 grid 子项、
 * 让行卡片不再撑满格子）—— 标记属性直接落在卡片自己的根元素上，见 `UISlot` 的
 * `NO_MARK_WRAPPER_HOSTS`。
 */
export const ExporterRow: React.FC<{ spec: ExporterInfo }> = ({ spec }) => {
  const { runExport, busyId, results } = useExportBridge();
  const r: any = results[spec.id];
  const busy = busyId === spec.id;

  return (
    <div
      className="bg-surface/80 p-4 rounded-2xl border border-white/70 dark:border-white/12 space-y-2"
      {...markAttrs({ id: `exporter.${spec.id}`, kind: 'panel', source: 'plugin:exporter' })}
    >
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-accent-green" />
        <div className="text-xs font-bold text-white truncate">{spec.name}</div>
        <span className="text-[9px] font-mono text-gray-500 ml-auto truncate max-w-[140px]" title={spec.run?.extension}>{spec.run?.extension}</span>
      </div>
      {spec.description && <div className="text-[11px] text-gray-400 leading-4">{spec.description}</div>}
      <button
        onClick={() => runExport(spec.id)}
        disabled={busy}
        className="w-full py-2 rounded-xl bg-accent-green/20 border border-accent-green/40 text-accent-green text-xs font-bold hover:bg-accent-green/30 disabled:opacity-40"
      >
        {busy ? '执行中…' : '运行导出'}
      </button>
      {r?.error && <div className="text-[11px] text-red-300">⚠️ {r.error}</div>}
      {r && !r.error && (
        <div className="text-[11px] text-gray-300 space-y-1">
          {r.file_url && (
            <a className="text-accent-green underline break-all block" href={API_ORIGIN + r.file_url} target="_blank" rel="noreferrer">下载 / 预览 {r.file_url}</a>
          )}
          {r.url && !r.file_url && (
            <a className="text-accent-green underline break-all block" href={r.url} target="_blank" rel="noreferrer">{r.url}</a>
          )}
          {r.export_dir && (
            <button className="text-accent-green underline block" onClick={() => apiService.openFolder(r.export_dir)}>打开目录 {r.export_dir}</button>
          )}
          {!r.file_url && !r.url && !r.export_dir && (
            <pre className="text-[10px] font-mono text-gray-400 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">{JSON.stringify(r).slice(0, 500)}</pre>
          )}
        </div>
      )}
    </div>
  );
};

export default ExporterRow;
