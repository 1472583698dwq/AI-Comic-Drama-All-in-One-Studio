// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片生成参数弹层内容：
 * 上半部 = Toonflow generationSettings（分辨率单选 + 比例宫格，带比例小框），
 * 下半部 = 所选生成源 params_schema 的完整 DynamicControl 列表（基础 / 按分类的高级项，保留 x-agent「Agent可填 / 建议 / 手填」徽标）。
 * 改动即写回节点（Toonflow 同款即时生效）。
 */
import { DynamicControl, groupSpecs, CATEGORY_LABEL, type ControlSpec } from '../../controls/DynamicControl';
import { ratioShapeStyle } from '../../kit/PromptPanel';
import { paramValue, ratioText, type QuickParams } from './imageParams';

export interface GenParamsPanelProps {
  quick: QuickParams;
  params: Record<string, unknown>;
  onParamChange: (key: string, value: unknown) => void;
  modelSpec?: ControlSpec;
  model?: string;
  onModelChange?: (model: string) => void;
  /** 局部重绘：比例跟随原图，不让选（显示说明）。 */
  ratioLocked?: string;
  /** 未选生成源（Agent 自动选源）。 */
  noProvider?: boolean;
}

export function GenParamsPanel({ quick, params, onParamChange, modelSpec, model, onModelChange, ratioLocked, noProvider }: GenParamsPanelProps) {
  if (noProvider) {
    return <div className="cv-img-params__empty">未选择生成源：参数由 Agent 智能规划时自动决定。选定生成源后可在这里调整比例、分辨率等参数。</div>;
  }
  const { ratio, size } = quick;
  const rest = quick.specs.filter((s) => s !== ratio && s !== size);
  const { basic, advanced } = groupSpecs(rest);
  const cats = Array.from(new Set(advanced.map((s) => s.category || 'advanced')));
  const sizeValue = paramValue(params, size);
  const ratioValue = paramValue(params, ratio);
  const control = (spec: ControlSpec) => (
    <div key={spec.param_name} className="cv-img-params__control">
      <DynamicControl spec={spec} value={params[spec.param_name] ?? spec.default_value} onChange={(v) => onParamChange(spec.param_name, v)} compact />
    </div>
  );
  return (
    <div className="cv-img-params">
      {modelSpec && onModelChange && (
        <div className="cv-img-params__control">
          <DynamicControl spec={modelSpec} value={model || modelSpec.default_value} onChange={(v) => onModelChange(String(v ?? ''))} compact />
        </div>
      )}
      {size && (
        <>
          <div className="cv-img-params__label">{size.label || '分辨率'}</div>
          <div className="cv-img-params__sizes" role="radiogroup" aria-label={size.label || '分辨率'}>
            {(size.options || []).map((o) => (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={String(sizeValue ?? '') === o}
                className={['cv-img-params__size', String(sizeValue ?? '') === o ? 'is-active' : ''].filter(Boolean).join(' ')}
                onClick={() => onParamChange(size.param_name, o)}
              >
                {o}
              </button>
            ))}
          </div>
        </>
      )}
      {ratio && (
        <>
          <div className="cv-img-params__label">{ratio.label || '比例'}</div>
          {ratioLocked ? (
            <div className="cv-img-params__note">局部重绘：输出比例跟随原图（{ratioLocked}）</div>
          ) : (
            <div className="cv-img-params__ratios" role="radiogroup" aria-label={ratio.label || '比例'}>
              {(ratio.options || []).map((o) => {
                const r = ratioText(o);
                const active = String(ratioValue ?? '') === o;
                return (
                  <button
                    key={o}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`比例 ${r ?? o}`}
                    title={o}
                    className={['cv-img-params__ratio', active ? 'is-active' : ''].filter(Boolean).join(' ')}
                    onClick={() => onParamChange(ratio.param_name, o)}
                  >
                    {r && <span className="cv-ratio-shape" style={ratioShapeStyle(r)} aria-hidden />}
                    <span>{r ?? o}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      {basic.length > 0 && (
        <>
          <div className="cv-img-params__label">基础参数 · Agent 可自动代填</div>
          <div className="cv-img-params__group">{basic.map(control)}</div>
        </>
      )}
      {cats.map((cat) => (
        <div key={cat}>
          <div className="cv-img-params__label">{CATEGORY_LABEL[cat] || cat}</div>
          <div className="cv-img-params__group">{advanced.filter((s) => (s.category || 'advanced') === cat).map(control)}</div>
        </div>
      ))}
      {!size && !ratio && !basic.length && !advanced.length && !modelSpec && (
        <div className="cv-img-params__empty">该生成源没有可调参数</div>
      )}
    </div>
  );
}
