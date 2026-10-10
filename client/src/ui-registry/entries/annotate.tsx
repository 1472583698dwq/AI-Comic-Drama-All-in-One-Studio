import React, { useEffect } from 'react';
import { register } from '../registry';
import { useT } from '../i18n';
import { APP_HOST, markAttrs } from '../types';

/**
 * 最小形态**标注模式**（原型 v3 的「标注」能力）：
 * 叠三色描边区分「锁定壳 / 可插拔区域 / 插件贡献」，并在左下角给出图例。
 *
 * 实现要点：
 *   1. 描边由 `body[data-ui-annot="1"] [data-ui-mark]` 这套 CSS 规则画（见 index.css），
 *      条目侧只负责把 `markAttrs` 展开到根元素 —— 不参与布局，也不用给每个组件改结构；
 *   2. 本条目自己挂在 `scope: 'prefs'` + `switchId: 'annotate_locked'` 上：
 *      开关一关，条目从槽位移除、effect 清理掉 body 属性、描边与图例同时消失（无残留）；
 *   3. 挂载点用 `host='app'`（全局覆盖层），任何页面都能看到图例。
 */
export const AnnotLegendEntry: React.FC = () => {
  const t = useT();

  useEffect(() => {
    document.body.dataset.uiAnnot = '1';
    return () => { delete document.body.dataset.uiAnnot; };
  }, []);

  const legend: Array<[string, string]> = [
    ['rgba(251,191,36,.95)', t('annot.locked')],
    ['rgba(56,189,248,.85)', t('annot.pluggable')],
    ['rgba(249,115,22,.95)', t('annot.plugin')],
  ];

  // 自标：图例自身也挂在 `app` 宿主，而槽位不给 app 宿主加包裹层（审查 M3）
  return (
    <div
      className="fixed left-4 bottom-4 z-[95] max-w-[320px] rounded-2xl border border-white/70 dark:border-white/12 bg-surface/85 backdrop-blur-xl px-3.5 py-3 shadow-lg pointer-events-none"
      {...markAttrs({ id: 'overlay.annot-legend', kind: 'panel', scope: 'prefs', source: 'builtin' })}
    >
      <div className="font-mono text-[9.5px] tracking-[.16em] uppercase text-gray-500">{t('annot.legend')}</div>
      <div className="mt-2 flex flex-col gap-1.5">
        {legend.map(([color, label]) => (
          <div key={label} className="flex items-center gap-2 text-[11px] text-gray-400">
            <span className="w-4 h-3 shrink-0 rounded-[3px] border" style={{ borderColor: color, borderStyle: 'dashed' }} />
            <span className="truncate">{label}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[10px] text-gray-500">{t('annot.hint')}</div>
    </div>
  );
};

/** 标注图例条目：prefs 层（本机偏好），默认关 */
function registerAnnotEntries(): () => void {
  return register({
    id: 'overlay.annot-legend',
    kind: 'panel',
    host: APP_HOST,
    order: 200,
    scope: 'prefs',
    switchId: 'annotate_locked',
    source: 'builtin',
    render: AnnotLegendEntry,
  });
}

registerAnnotEntries();
