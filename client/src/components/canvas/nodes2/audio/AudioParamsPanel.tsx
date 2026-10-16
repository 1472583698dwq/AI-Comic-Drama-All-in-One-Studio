// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频生成参数弹层（PromptPanel 参数按钮里渲染）：
 *   ① 音色 / 情绪（沿用 TTSNode：音色列表按语音源取，可自定义音色 ID；情绪用生成源声明的枚举）
 *   ② 音频设置（Toonflow generationSettings：语种 / 采样率 / 输出格式；只显示生成源 params_schema 声明了的，其余仅存节点数据）
 *   ③ 其余参数（MiniMax DynamicControl，保留 x-agent「Agent可填 / 建议 / 手填」徽标）
 *   ④ 参考音频来源说明（连线参考 / 旧画布遗留在节点数据里的参考音频，可清除）
 * 改动即时写回节点（与 Toonflow 一致，无「应用」步骤）。
 */
import { useMemo, useState, type SyntheticEvent } from 'react';
import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { DynamicControl, groupSpecs, CATEGORY_LABEL, type ControlSpec } from '../../controls/DynamicControl';
import { paramsSchemaToSpecs } from '../../providerSkills';
import {
  audioSettingsOf, currentSettingValue, emotionParamKey, paramPatch, paramsOf, resolveAudioParams, schemaDefaults, settingControls, settingLabel,
  specialParamKeys, toDataValue, voiceParamKey, SETTING_LABELS, TEXT_PARAM_KEYS, type ProviderDefLike, type SettingControl, type SettingValue,
} from './audioSettings';
import type { VoiceCatalog } from './voices';
import { fileNameOf } from './media';
import './audio.css';

const stop = (e: SyntheticEvent) => e.stopPropagation();
const CUSTOM = '__custom__';

const AGENT_BADGE: Record<string, { label: string; title: string }> = {
  auto: { label: 'Agent可填', title: 'Agent 可自动代填（项目/上游推断），你改后不再覆盖' },
  suggest: { label: '建议', title: 'Agent 仅在你未填时建议值，可手调' },
  manual: { label: '手填', title: '仅手填，Agent 不代填（seed/锁定项）' },
};

function AgentBadge({ agent }: { agent?: string }) {
  const b = agent ? AGENT_BADGE[agent] : undefined;
  return b ? <span className="cv-audio-badge" title={b.title}>{b.label}</span> : null;
}

function Segmented({ label, options, value, disabled, onChange }: {
  label: string; options: SettingControl['options']; value: SettingValue | undefined; disabled?: boolean; onChange: (v: SettingValue) => void;
}) {
  return (
    <div className="cv-audio-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value !== undefined && String(value) === String(o.value)}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function genderLabel(g?: string): string {
  if (!g) return '';
  return g === 'male' ? '男' : g === 'female' ? '女' : g;
}

function VoiceField({ value, defaultVoice, catalog, loading, disabled, onChange }: {
  value: string; defaultVoice?: string; catalog: VoiceCatalog | null; loading: boolean; disabled?: boolean; onChange: (v: string) => void;
}) {
  const voices = catalog?.voices ?? [];
  const known = voices.some((v) => v.id === value);
  const [customOpen, setCustomOpen] = useState(false);
  const custom = customOpen || (!!value && !known && !loading) || (!loading && !voices.length);
  return (
    <div className="cv-audio-field__control">
      <select
        className="cv-audio-select"
        aria-label="音色"
        disabled={disabled || loading}
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === CUSTOM) {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          onChange(v);
        }}
      >
        <option value="">{loading ? '加载音色…' : `默认音色${defaultVoice ? `（${defaultVoice}）` : '（源声明）'}`}</option>
        {voices.map((v) => (
          <option key={v.id} value={v.id}>{[v.name || v.id, genderLabel(v.gender)].filter(Boolean).join(' · ')}</option>
        ))}
        <option value={CUSTOM}>自定义音色 ID…</option>
      </select>
      {custom && (
        <input
          className="cv-audio-input"
          aria-label="自定义音色 ID"
          placeholder="输入音色 ID（留空用源默认）"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
      {catalog?.borrowedFrom && <span className="cv-audio-params__hint">该源未提供音色列表，已列出 {catalog.borrowedFrom} 预设音色</span>}
    </div>
  );
}

export interface AudioParamsPanelProps {
  data: Record<string, unknown>;
  def: ProviderDefLike;
  providerId: string;
  providerName: string;
  catalog: VoiceCatalog | null;
  voicesLoading: boolean;
  /** 实际下发的参考音频来自参考列表第 index 项 */
  refAudio: { index: number; label?: string } | null;
  /** 生成源是否声明了参考音频槽（未知生成源 = undefined） */
  refAudioSupported?: boolean;
  /** 旧画布遗留在节点数据里的参考音频（没有连线参考时仍会下发） */
  legacyRefAudio: string;
  disabled?: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}

export function AudioParamsPanel(props: AudioParamsPanelProps) {
  const { data, def, providerId, providerName, catalog, voicesLoading, refAudio, refAudioSupported, legacyRefAudio, disabled, onPatch } = props;
  // FX-2：显示补齐缺省后的参数（与直接生成下发的一致）；改动仍只写被改的那个键
  const params = resolveAudioParams(def, paramsOf(data), data);
  const schemaProps = (def?.params_schema?.properties ?? {}) as Record<string, any>;
  const specs = useMemo(() => paramsSchemaToSpecs(def?.params_schema as Record<string, any> | undefined), [def]);
  const voiceKey = voiceParamKey(def);
  const emotionKey = emotionParamKey(def);
  const emotionSpec = emotionKey ? specs.find((s) => s.param_name === emotionKey) : undefined;
  const controls = settingControls(def);
  const special = specialParamKeys(def);
  const rest = specs.filter((s) => !special.has(s.param_name) && s.param_name !== emotionKey && s.visibility !== 'hidden');
  const { basic, advanced } = groupSpecs(rest);
  const advancedCats = Array.from(new Set(advanced.map((s) => s.category || 'advanced')));
  const voiceValue = String((voiceKey ? params[voiceKey] ?? data[voiceKey] : undefined) ?? data.voice_id ?? '');

  const setParam = (key: string, value: unknown) => onPatch(paramPatch(data, key, value));
  const renderSpec = (spec: ControlSpec) => (
    <DynamicControl key={spec.param_name} spec={spec} compact value={params[spec.param_name] ?? spec.default_value} onChange={(v) => setParam(spec.param_name, v)} />
  );

  const status = !providerId
    ? { text: '未选择语音源', bad: false }
    : catalog?.configured === false
      ? { text: '未配置', bad: true }
      : catalog?.healthy === false
        ? { text: '服务未就绪', bad: true }
        : catalog?.healthy
          ? { text: '可用', bad: false }
          : { text: '', bad: false };
  const dataSettings = audioSettingsOf(data);
  const dataOnly = (['language', 'sampleRate', 'format'] as const).filter((k) => !controls.some((c) => c.key === k));

  return (
    <div className="cv-audio-params nodrag nopan nowheel" onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop} onKeyDown={stop} onWheel={stop}>
      <div className="cv-audio-params__header">
        <IconAdjustmentsHorizontal size={17} aria-hidden />
        <span>音频参数</span>
        <span className={['cv-audio-params__status', status.bad ? 'is-bad' : ''].filter(Boolean).join(' ')} title={providerName || undefined}>
          {[providerId ? providerName : '', status.text].filter(Boolean).join(' · ')}
        </span>
      </div>

      {!providerId && (
        <div className="cv-audio-params__hint">先在左侧下拉选择语音源；或打开「智能规划」，由 Agent 自动选源、音色与参数。</div>
      )}

      {(voiceKey || emotionSpec) && (
        <section className="cv-audio-params__section" aria-label="音色与情绪">
          <div className="cv-audio-params__title">音色与情绪</div>
          {voiceKey && (
            <div className="cv-audio-field">
              <span className="cv-audio-field__label">音色<AgentBadge agent={schemaProps[voiceKey]?.['x-agent']} /></span>
              <VoiceField
                value={voiceValue}
                defaultVoice={typeof schemaProps[voiceKey]?.default === 'string' ? schemaProps[voiceKey].default : undefined}
                catalog={catalog}
                loading={voicesLoading}
                disabled={disabled}
                onChange={(v) => onPatch({ ...paramPatch(data, voiceKey, v), ...(voiceKey !== 'voice_id' ? { voice_id: v || undefined } : {}) })}
              />
            </div>
          )}
          {emotionSpec && renderSpec(emotionSpec)}
        </section>
      )}

      <section className="cv-audio-params__section" aria-label="音频设置">
        <div className="cv-audio-params__title">音频设置</div>
        {controls.map((c) => (
          <div key={c.key} className="cv-audio-field">
            <span className="cv-audio-field__label">{SETTING_LABELS[c.key]}</span>
            <Segmented
              label={`音频${SETTING_LABELS[c.key]}`}
              options={c.options}
              value={currentSettingValue(c, params, data, def)}
              disabled={disabled}
              onChange={(v) => onPatch({ ...paramPatch(data, c.paramKey, v), [c.key]: toDataValue(c.key, v) })}
            />
          </div>
        ))}
        {dataOnly.length > 0 && (
          <div className="cv-audio-params__hint">
            {controls.length ? '其余' : '当前语音源未声明'}
            {dataOnly.map((k) => SETTING_LABELS[k]).join(' / ')}
            参数，按 {dataOnly.map((k) => settingLabel(k, dataSettings[k])).join(' · ')} 保存在节点里，不下发。
          </div>
        )}
      </section>

      {rest.length > 0 && (
        <section className="cv-audio-params__section" aria-label="生成参数">
          <div className="cv-audio-params__title">参数</div>
          {basic.map(renderSpec)}
          {advancedCats.map((cat) => (
            <div key={cat} className="cv-audio-params__section">
              <div className="cv-audio-params__hint">{CATEGORY_LABEL[cat] || cat}</div>
              {advanced.filter((s) => (s.category || 'advanced') === cat).map(renderSpec)}
            </div>
          ))}
        </section>
      )}

      <section className="cv-audio-params__section" aria-label="参考音频">
        <div className="cv-audio-params__title">参考音频</div>
        {refAudio ? (
          <div className="cv-audio-ref-row"><span>使用参考 {refAudio.index}{refAudio.label ? ` · ${refAudio.label}` : ''}（音色克隆 / 参考）</span></div>
        ) : legacyRefAudio ? (
          <div className="cv-audio-ref-row">
            <span title={legacyRefAudio}>沿用节点里的参考音频（未连线）：{fileNameOf(legacyRefAudio) || legacyRefAudio}</span>
            <button
              type="button"
              className="cv-audio-btn cv-audio-btn--sm"
              disabled={disabled}
              onClick={() => onPatch({ ref_audio: undefined, reference_audio: undefined, ref_audio_path: undefined, reference_audios: undefined })}
            >
              清除
            </button>
          </div>
        ) : (
          <div className="cv-audio-params__hint">
            {refAudioSupported === false ? '当前语音源不支持参考音频。' : '把「音频」节点连到输入口即可作为参考音色（图片和音频参考合计 1 个）。'}
          </div>
        )}
      </section>

      {providerId && (
        <div className="cv-audio-params__footer">
          <button
            type="button"
            className="cv-audio-btn cv-audio-btn--sm"
            disabled={disabled}
            title="把参数恢复到该语音源的默认值"
            onClick={() => {
              const defaults = schemaDefaults(def);
              const patch: Record<string, unknown> = { params: defaults, provider_params: defaults };
              // 顶层同名键一起复位（engine 执行器优先读顶层）；台词键不动
              for (const k of Object.keys(schemaProps)) if (!(TEXT_PARAM_KEYS as readonly string[]).includes(k)) patch[k] = defaults[k];
              if (voiceKey && voiceKey !== 'voice_id') patch.voice_id = defaults[voiceKey];
              onPatch(patch);
            }}
          >
            恢复默认
          </button>
        </div>
      )}
    </div>
  );
}
