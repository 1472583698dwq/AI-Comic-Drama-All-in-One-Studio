// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 卡片内小控件（Toonflow el-input / el-select / el-button / el-tag 外观），
 * 颜色只用 --cv-* 变量（样式见 legacyB.css）。另含：参数区（DynamicControl，保留 x-agent 徽标）、
 * 声明端口清单、产出预览、结果回写分镜。
 */
import {
  forwardRef, useMemo, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type SyntheticEvent, type TextareaHTMLAttributes,
} from 'react';
import {
  IconAsterisk, IconChevronDown, IconChevronRight, IconCircleDashed, IconCircleDot, IconCornerUpLeft, IconLetterT, IconLoader2,
  IconMovie, IconMusic, IconPhoto,
} from '@tabler/icons-react';
import { DynamicControl, groupSpecs, type ControlSpec } from '../../controls/DynamicControl';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { Popover } from '../../kit/ui/Popover';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { useProjectStore } from '../../../../stores/useProjectStore';
import { confirmAsync, toast } from '../../../../stores/useDialogStore';
import { collectNodeResults, findShot, listShotOptions, nodeShotId, shotDisplayName, writeBackToShot, type NodeResultOption } from '../../shotWriteBack';
import type { KitIcon, DataType } from '../../kit/types';
import type { PortInputState } from './inputs';
import type { LegacyPortDef } from './ports';
import { resultOf } from './model';

const stop = (e: SyntheticEvent) => e.stopPropagation();
const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

// ───────────────────────────── 基础控件 ─────────────────────────────

/** 输入类控件统一：不拖节点、不平移画布、按键不触发画布快捷键。 */
const FIELD_GUARDS = { onKeyDown: stop, onPointerDown: stop, onMouseDown: stop };

export const LbInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function LbInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cx('cv-lb-input nodrag nopan', className)} {...FIELD_GUARDS} {...rest} />;
});

export const LbTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function LbTextarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('cv-lb-textarea nodrag nopan nowheel', className)} {...FIELD_GUARDS} {...rest} />;
});

export function LbSelect({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx('cv-lb-select-wrap', className)}>
      <select className="cv-lb-select nodrag nopan" {...FIELD_GUARDS} {...rest}>{children}</select>
      <IconChevronDown className="cv-lb-select-caret" size={14} aria-hidden />
    </span>
  );
}

export interface LbButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'text';
  block?: boolean;
  icon?: KitIcon;
  loading?: boolean;
}

export function LbButton({ variant = 'default', block, icon: Icon, loading, className, children, disabled, onClick, ...rest }: LbButtonProps) {
  return (
    <button
      type="button"
      className={cx('cv-lb-btn nodrag nopan', `cv-lb-btn--${variant}`, block && 'cv-lb-btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      {...rest}
    >
      {loading ? <IconLoader2 className="cv-spin" size={14} aria-hidden /> : Icon ? <Icon size={14} aria-hidden /> : null}
      {children}
    </button>
  );
}

export function LbTag({ children, tone = 'default', mono, title }: { children: ReactNode; tone?: 'default' | 'primary' | 'danger'; mono?: boolean; title?: string }) {
  return <span className={cx('cv-lb-tag', `cv-lb-tag--${tone}`, mono && 'cv-lb-mono')} title={title}>{children}</span>;
}

export function LbDot({ tone, title }: { tone: 'ok' | 'error' | 'idle' | 'primary'; title?: string }) {
  return <span className={cx('cv-lb-dot', `cv-lb-dot--${tone}`)} title={title} role="img" aria-label={title} />;
}

export function LbAlert({ tone = 'danger', children, role }: { tone?: 'danger' | 'primary' | 'muted'; children: ReactNode; role?: string }) {
  return <div className={cx('cv-lb-alert', `cv-lb-alert--${tone}`)} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>{children}</div>;
}

export function LbField({ label, extra, children, hint }: { label: ReactNode; extra?: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="cv-lb-field">
      <div className="cv-lb-row cv-lb-row--between">
        <span className="cv-lb-label">{label}</span>
        {extra}
      </div>
      {children}
      {hint && <div className="cv-lb-hint">{hint}</div>}
    </div>
  );
}

/** 产出预览：图片 / 视频在固定高度的产出框里等比完整显示（不裁切），音频用原生播放器；相对 URL 在开发环境回源后端。 */
export function MediaPreview({ url, kind }: { url: string; kind: 'image' | 'video' | 'audio' }) {
  const src = resolveMediaUrl(url) || url;
  if (kind === 'audio') return <audio className="cv-lb-audio nodrag nopan" src={src} controls preload="metadata" onPointerDown={stop} />;
  if (kind === 'video') return <video className="cv-lb-output__media" src={src} controls preload="metadata" aria-label="产出视频" />;
  return <img className="cv-lb-output__media" src={src} alt="产出图片" draggable={false} />;
}

/**
 * 产出区（custom / ext-node）：媒体预览；没有媒体时显示结果文本 data.text（`text` 是输入口时它是输入，不当结果显示）；
 * 失败的 agent_state 显示错误。
 *
 * REQ-toonflow-canvas FX-2：产出放在固定高度的产出框里（Toonflow 媒体节点空态同高 144px）：媒体等比缩进框内、
 * 长文本在框内滚动、错误贴在框底（有产出时）或占满框（没产出时）。`reserve`（已绑定代码节点 / 扩展声明）时运行前就占好位置，
 * 出结果前后卡片高度不变，不会长高压住下方节点。
 */
export function ResultView({ data, textIsInput, reserve }: { data: Record<string, any>; textIsInput?: boolean; reserve?: boolean }) {
  const res = resultOf(data);
  const st = (data.agent_state || {}) as Record<string, unknown>;
  const text = !res && !textIsInput && typeof data.text === 'string' ? data.text.trim() : '';
  const error = st.status === 'failed' && st.error ? String(st.error) : '';
  if (!reserve && !res && !text && !error) return null;
  const empty = !res && !text;
  return (
    <div
      className={cx('cv-lb-output nodrag nopan nowheel', res && `cv-lb-output--${res.kind}`)}
      role="group"
      aria-label="产出"
      data-testid="cv-lb-output"
      onPointerDown={stop}
    >
      {res && <MediaPreview url={res.url} kind={res.kind} />}
      {text && <div className="cv-lb-output__text">{text}</div>}
      {empty && !error && (
        <div className="cv-lb-output__empty">
          <IconPhoto size={28} stroke={1.25} aria-hidden />
          <span>运行后在这里预览产出</span>
        </div>
      )}
      {error && <div className={cx('cv-lb-output__error', empty && 'is-full')} role="alert">{error}</div>}
    </div>
  );
}

// ───────────────────────────── 声明端口清单 ─────────────────────────────

const DATATYPE_ICON: Record<string, KitIcon> = { STRING: IconLetterT, IMAGE: IconPhoto, VIDEO: IconMovie, AUDIO: IconMusic, '*': IconAsterisk };
const DATATYPE_LABEL: Record<string, string> = { STRING: '文本', IMAGE: '图片', VIDEO: '视频', AUDIO: '音频', '*': '任意' };

function firstType(dt: DataType | DataType[]): string {
  return Array.isArray(dt) ? String(dt[0] ?? '*') : String(dt);
}

function preview(v: string | string[] | undefined): string {
  if (!v) return '';
  if (Array.isArray(v)) return v.length > 1 ? `${v.length} 项` : preview(v[0]);
  const s = v.replace(/\s+/g, ' ').trim();
  if (/^(https?:|data:|blob:|\/)/.test(s)) return s.split(/[?#]/)[0].split('/').pop() || s;
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/** 输入口清单：类型图标 · 名称（必填 *）· 连线状态 / 上游值摘要。 */
export function PortInputList({ ports, states }: { ports: readonly LegacyPortDef[]; states: Record<string, PortInputState> }) {
  const inputs = ports.filter((p) => p.type === 'target');
  if (!inputs.length) return null;
  return (
    <ul className="cv-lb-ports" aria-label="输入端口">
      {inputs.map((p) => {
        const t = firstType(p.dataType);
        const Icon = DATATYPE_ICON[t] ?? IconAsterisk;
        const st = states[p.id];
        const connected = !!st?.connected;
        const ConnIcon = connected ? IconCircleDot : IconCircleDashed;
        return (
          <li key={p.id} className={cx('cv-lb-port', connected && 'is-connected')} title={`${p.label ?? p.id}（${p.id} · ${DATATYPE_LABEL[t] ?? t}）${p.description ? `\n${p.description}` : ''}`}>
            <Icon className="cv-lb-port__type" size={14} aria-hidden />
            <span className="cv-lb-port__label">
              {p.label ?? p.id}
              {p.required && <span className="cv-lb-required" aria-label="必填">*</span>}
            </span>
            <span className="cv-lb-port__state">
              {connected ? (preview(st?.value) || (st!.connected > 1 ? `已连 ${st!.connected} 条` : '已连接')) : '未连接'}
            </span>
            <ConnIcon className="cv-lb-port__conn" size={14} aria-hidden />
          </li>
        );
      })}
    </ul>
  );
}

/** 未连线的文本输入口：直接在卡片里填（写到端口 id 键，执行时按端口 id 取值；连线后以连线为准）。 */
export function TextPortInputs({ ports, states, data, onChange }: {
  ports: readonly LegacyPortDef[];
  states: Record<string, PortInputState>;
  data: Record<string, unknown>;
  onChange: (portId: string, value: string) => void;
}) {
  const textPorts = ports.filter((p) => p.type === 'target' && firstType(p.dataType) === 'STRING' && !states[p.id]?.connected);
  if (!textPorts.length) return null;
  return (
    <>
      {textPorts.map((p) => (
        <LbTextarea
          key={p.id}
          aria-label={p.label ?? p.id}
          rows={2}
          value={typeof data[p.id] === 'string' ? (data[p.id] as string) : ''}
          placeholder={`${p.label ?? p.id}（连线优先）…`}
          onChange={(e) => onChange(p.id, e.target.value)}
        />
      ))}
    </>
  );
}

// ───────────────────────────── 参数区（DynamicControl） ─────────────────────────────

export function ParamsSection({ specs, values, onChange, title = '参数', collapsible, defaultOpen = true, footer, icon: Icon }: {
  specs: ControlSpec[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  title?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  footer?: ReactNode;
  icon?: KitIcon;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const visible = useMemo(() => groupSpecs(specs).sorted.filter((s) => s.visibility !== 'hidden'), [specs]);
  if (!visible.length) return null;
  const shown = !collapsible || open;
  return (
    <section className="cv-lb-section" aria-label={typeof title === 'string' ? title : '参数'}>
      <div className="cv-lb-section__head">
        <span className="cv-lb-label">{Icon && <Icon size={14} aria-hidden />}{title}</span>
        {collapsible && (
          <LbButton variant="text" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? '收起' : '展开'}
            {open ? <IconChevronDown size={12} aria-hidden /> : <IconChevronRight size={12} aria-hidden />}
          </LbButton>
        )}
      </div>
      {shown && (
        <div className="cv-lb-dyn nodrag nopan nowheel" onPointerDown={stop} onMouseDown={stop} onKeyDown={stop}>
          {visible.map((s) => (
            <DynamicControl
              key={s.id}
              spec={s}
              compact
              value={values[s.param_name] ?? s.default_value}
              onChange={(v) => onChange(s.param_name, v)}
            />
          ))}
          {footer}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────── 结果回写分镜（原 nodes/ShotWriteBackControl，换皮） ─────────────────────────────

export function ShotWriteBack({ nodeId, nodeType, data, onUpdate }: {
  nodeId: string;
  nodeType: string;
  data: Record<string, unknown>;
  onUpdate: (patch: Record<string, unknown>) => void;
}) {
  const project = useProjectStore((s) => s.project);
  const linkedShotId = nodeShotId(data);
  const [targetShotId, setTargetShotId] = useState<string>(linkedShotId);
  // 节点 / 归属变化时重置目标镜（渲染期派生，同旧控件）
  const linkKey = `${nodeId}::${linkedShotId}`;
  const [lastLinkKey, setLastLinkKey] = useState(linkKey);
  if (linkKey !== lastLinkKey) {
    setLastLinkKey(linkKey);
    setTargetShotId(linkedShotId);
  }
  const shotOptions = useMemo(() => listShotOptions(project), [project]);
  const results = useMemo(() => collectNodeResults(nodeType, data), [nodeType, data]);
  const targetShot = useMemo(() => findShot(project, targetShotId), [project, targetShotId]);
  if (!results.length) return null;

  const writeBack = async (res: NodeResultOption) => {
    const sid = targetShotId || linkedShotId;
    if (!sid) { toast.warning('请先选择要回写的分镜'); return; }
    const shot = findShot(project, sid);
    if (!shot) { toast.error('目标分镜不存在（可能已删除）'); return; }
    const current = (shot as Record<string, unknown>)[res.field];
    if (current && current !== res.value) {
      const ok = await confirmAsync({
        title: '覆盖分镜结果',
        message: `${shotDisplayName(shot)} 已有${res.label}，确认用画布结果覆盖？（旧值自动进入历史，可在分镜里回退）`,
        confirmText: '覆盖回写',
        isDanger: true,
      });
      if (!ok) return;
    }
    const r = writeBackToShot({ shotId: sid, field: res.field, value: res.value });
    if (!r.ok) { toast.error(r.error || '回写失败'); return; }
    if (!linkedShotId) onUpdate({ shotId: sid });
    toast.success(`已回写 ${shotDisplayName(shot)} · ${res.label}`);
  };

  return (
    <section className="cv-lb-section" aria-label="回写到分镜">
      <div className="cv-lb-section__head">
        <span className="cv-lb-label"><IconCornerUpLeft size={14} aria-hidden />回写到分镜</span>
        {linkedShotId && targetShot && <span className="cv-lb-hint">已关联 {shotDisplayName(targetShot)}</span>}
      </div>
      <LbSelect value={targetShotId} aria-label="目标分镜" onChange={(e) => setTargetShotId(e.target.value)}>
        <option value="">选择目标分镜…</option>
        {shotOptions.map((s) => (
          <option key={s.id} value={s.id}>{s.label}{s.hasVideo ? ' ·已有视频' : s.hasImage ? ' ·已有图' : ''}{s.hasAudio ? ' ·已有配音' : ''}</option>
        ))}
      </LbSelect>
      <div className="cv-lb-row cv-lb-wrap">
        {results.map((r, i) => (
          <LbButton
            key={`${r.field}-${i}`}
            icon={IconCornerUpLeft}
            disabled={!targetShot}
            title={`把该结果写入 ${targetShot ? shotDisplayName(targetShot) : '所选分镜'}（覆盖前会确认，旧值进历史）`}
            onClick={() => void writeBack(r)}
          >
            回写{r.label}
          </LbButton>
        ))}
      </div>
      {!targetShot && (
        <div className="cv-lb-hint">{linkedShotId ? '节点所属分镜不存在（可能已删除），请重新选择目标分镜' : '选择目标分镜后即可回写（节点无归属时不改动分镜）'}</div>
      )}
    </section>
  );
}

/**
 * REQ-toonflow-canvas FX-2：「回写到分镜」放进浮动工具栏的弹层（custom / ext-node）。
 * 原来是出结果后才出现在卡片里的一整段（目标分镜下拉 + 回写按钮 + 提示），会把卡片撑高、压住下方节点；
 * 工具栏浮在卡片上方，不占卡片高度。没有可回写的产出时不显示按钮。
 */
export function ShotWriteBackButton(props: {
  nodeId: string;
  nodeType: string;
  data: Record<string, unknown>;
  onUpdate: (patch: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const { nodeType, data, disabled } = props;
  const results = useMemo(() => collectNodeResults(nodeType, data), [nodeType, data]);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!results.length) return null;
  return (
    <>
      <ToolbarButton
        icon={IconCornerUpLeft}
        title="回写到分镜"
        active={!!anchor}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        回写分镜
      </ToolbarButton>
      <Popover open={!!anchor} anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-start" className="cv-lb-pop" role="dialog" aria-label="回写到分镜">
        <div className="cv-lb">
          <ShotWriteBack nodeId={props.nodeId} nodeType={nodeType} data={data} onUpdate={props.onUpdate} />
        </div>
      </Popover>
    </>
  );
}
