// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频生成参数弹层（照 Toonflow videoGenerationNode/components/generationSettings.vue）：
 * 生成模式 → 时长 / 分辨率 → 通用比例 → 生成音频，下面再列生成源 params_schema 的其余参数（MiniMax DynamicControl，保留 Agent 可填徽标）。
 */
import { DynamicControl, groupSpecs, type ControlSpec } from '../../controls/DynamicControl';
import { ratioShapeStyle } from '../../kit/PromptPanel';
import type { GenMode } from '../../kit/types';
import { formatDuration, isRatioShape, type ParamValue, type QuickParams } from './videoParams';

export const VIDEO_MODE_LABELS: Record<GenMode, string> = {
  text: '文生视频',
  singleImage: '单图参考',
  startEnd: '首尾帧',
  multiReference: '多参考',
};

export interface VideoGenSettingsProps {
  q: QuickParams;
  params: Record<string, unknown>;
  ratio: string;
  /** 模式下拉当前值：'' = 自动。 */
  modeValue: GenMode | '';
  /** 自动时实际生效的模式（显示在「自动（…）」里）。 */
  autoModeLabel: string;
  modes: { value: GenMode; supported: boolean }[];
  onMode: (mode: GenMode | '') => void;
  onParam: (key: string, value: unknown) => void;
  /** 其余参数（已去掉快捷参数）。 */
  specs: ControlSpec[];
  providerSelected: boolean;
  disabled?: boolean;
}

function optionValue(options: ParamValue[], raw: string): ParamValue | undefined {
  return options.find((o) => String(o) === raw);
}

export function VideoGenSettings(props: VideoGenSettingsProps) {
  const { q, params, ratio, modeValue, modes, onMode, onParam, specs, providerSelected, disabled } = props;
  const { basic, advanced } = groupSpecs(specs);
  const more = [...basic, ...advanced];
  const durationVal = q.durationKey ? params[q.durationKey] : undefined;
  const resolutionVal = q.resolutionKey ? params[q.resolutionKey] : undefined;
  return (
    <div className="cv-vgen-settings">
      <div className="cv-vgen-settings__block">
        <div className="cv-vgen-settings__label">生成模式</div>
        <select
          className="cv-select"
          aria-label="视频生成模式"
          value={modeValue}
          disabled={disabled}
          onChange={(e) => onMode(e.currentTarget.value as GenMode | '')}
        >
          <option value="">{`自动（${props.autoModeLabel}）`}</option>
          {modes.map((m) => (
            <option key={m.value} value={m.value} disabled={!m.supported}>
              {VIDEO_MODE_LABELS[m.value]}{m.supported ? '' : '（当前生成源不支持）'}
            </option>
          ))}
        </select>
      </div>

      {(q.durationKey || q.resolutionKey) && (
        <div className="cv-vgen-settings__row">
          {q.durationKey && (
            <div>
              <div className="cv-vgen-settings__label">时长</div>
              <select
                className="cv-select"
                aria-label="视频时长"
                value={durationVal === undefined || durationVal === null ? '' : String(durationVal)}
                disabled={disabled}
                onChange={(e) => onParam(q.durationKey!, optionValue(q.durationOptions, e.currentTarget.value))}
              >
                {(durationVal === undefined || durationVal === null || durationVal === '') && <option value="">默认</option>}
                {q.durationOptions.map((o) => <option key={String(o)} value={String(o)}>{formatDuration(o)}</option>)}
              </select>
            </div>
          )}
          {q.resolutionKey && (
            <div>
              <div className="cv-vgen-settings__label">分辨率</div>
              <select
                className="cv-select"
                aria-label="视频分辨率"
                value={resolutionVal === undefined || resolutionVal === null ? '' : String(resolutionVal)}
                disabled={disabled}
                onChange={(e) => onParam(q.resolutionKey!, optionValue(q.resolutionOptions, e.currentTarget.value))}
              >
                {(resolutionVal === undefined || resolutionVal === null || resolutionVal === '') && <option value="">默认</option>}
                {q.resolutionOptions.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      <div className="cv-vgen-settings__label">通用比例</div>
      <div className="cv-vgen-ratios" role="group" aria-label="视频比例">
        {q.ratioOptions.map((o) => (
          <button
            key={o.value}
            type="button"
            className="cv-vgen-ratio"
            aria-label={`比例 ${o.value}`}
            aria-pressed={ratio === o.value}
            disabled={disabled || !o.supported}
            title={o.supported ? `比例 ${o.value}` : '当前生成源不支持该比例'}
            onClick={() => onParam(q.ratioKey, o.value)}
          >
            {isRatioShape(o.value) ? <span className="cv-ratio-shape" style={ratioShapeStyle(o.value)} aria-hidden /> : <span className="cv-ratio-shape" style={{ width: 16, height: 16, borderStyle: 'dashed' }} aria-hidden />}
            <span className="cv-vgen-ratio__text">{o.value}</span>
          </button>
        ))}
      </div>

      {q.audioKey && (
        <div className="cv-vgen-settings__audio">
          <span className="cv-vgen-settings__label" style={{ margin: 0 }}>生成音频</span>
          <button
            type="button"
            role="switch"
            className="cv-switch"
            aria-label="生成音频"
            aria-checked={params[q.audioKey] === true}
            disabled={disabled}
            onClick={() => onParam(q.audioKey!, !(params[q.audioKey!] === true))}
          >
            <span className="cv-switch__track" aria-hidden><span className="cv-switch__thumb" /></span>
          </button>
        </div>
      )}

      {more.length > 0 && (
        <>
          <div className="cv-vgen-settings__divider" role="separator" />
          <div className="cv-vgen-settings__label">其他参数</div>
          <div className="cv-vgen-settings__more">
            {more.map((spec) => (
              <DynamicControl key={spec.param_name} spec={spec} value={params[spec.param_name]} onChange={(v) => onParam(spec.param_name, v)} compact />
            ))}
          </div>
        </>
      )}
      {!providerSelected && <div className="cv-vgen-settings__note">选择生成源后可设置时长、分辨率等该源支持的参数。</div>}
      {providerSelected && !q.ratioDeclared && <div className="cv-vgen-settings__note">该生成源未声明比例参数：默认不下发比例；手动选择后以 aspect_ratio 下发，是否生效由生成源决定。</div>}
    </div>
  );
}
