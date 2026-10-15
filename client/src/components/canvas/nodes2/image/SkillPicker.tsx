// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片生成的 MiniMax 技能（旧 NodeAgentConsole「执行路径」）：
 * - <SkillPicker>：面板页脚的技能按钮 + 菜单（自动 / 文生图 / 参考生图 / 角色一致性），写 data.skill_id；
 *   智能规划开启时随 /canvas/agent/generate 下发 skill_id，Agent 按技能润色提示词并选路；
 * - <CharacterBinder>：选中「角色一致性」时出现在面板里，把项目角色卡的三视图绑定为参考
 *   （新建图片节点并连到本节点 in 口，进入参考列表，与分镜「在画布中运行」的绑法一致）。
 */
import { useState } from 'react';
import { IconCheck, IconPlus, IconUsers, IconWand } from '@tabler/icons-react';
import { MenuList, Popover } from '../../kit/ui/Popover';
import { IMAGE_AGENT_SKILLS } from '../../providerSkills';
import { characterMainImage } from '../../../storyboard/referenceBinder';
import { resolveMediaUrl } from '../../../../utils/devOrigin';

export const CHARACTER_SKILL_ID = 'character_consistency';

export interface SkillPickerProps {
  skillId: string;
  onChange: (skillId: string) => void;
  smartPlan: boolean;
  disabled?: boolean;
}

export function skillName(skillId: string): string {
  return IMAGE_AGENT_SKILLS.find((s) => s.id === skillId)?.name ?? '';
}

export function SkillPicker({ skillId, onChange, smartPlan, disabled }: SkillPickerProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const name = skillName(skillId);
  const items = [
    { key: '', label: '自动（由 Agent 判断）', icon: <IconWand size={16} aria-hidden />, extra: !skillId ? <IconCheck size={14} aria-hidden /> : undefined, onSelect: () => onChange('') },
    ...IMAGE_AGENT_SKILLS.map((s) => ({
      key: s.id,
      label: <span title={s.desc}>{s.name}<span className="cv-img-skill__desc">{s.desc}</span></span>,
      icon: s.id === CHARACTER_SKILL_ID ? <IconUsers size={16} aria-hidden /> : <IconWand size={16} aria-hidden />,
      extra: skillId === s.id ? <IconCheck size={14} aria-hidden /> : undefined,
      onSelect: () => onChange(s.id),
    })),
  ];
  return (
    <>
      <button
        type="button"
        className={['cv-btn cv-btn--sm cv-img-skill', skillId ? 'is-active' : ''].filter(Boolean).join(' ')}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label="技能"
        disabled={disabled}
        title={smartPlan ? `技能：${name || '自动'}（智能规划时随请求下发）` : `技能：${name || '自动'}（开启智能规划后生效；角色一致性的三视图绑定随时可用）`}
        onClick={(e) => { e.stopPropagation(); setAnchor(anchor ? null : e.currentTarget); }}
      >
        {skillId === CHARACTER_SKILL_ID ? <IconUsers size={16} aria-hidden /> : <IconWand size={16} aria-hidden />}
        <span>{name || '技能'}</span>
      </button>
      <Popover open={!!anchor} anchor={anchor} placement="top-start" onClose={() => setAnchor(null)} role="menu" aria-label="选择技能">
        <MenuList items={items} onClose={() => setAnchor(null)} />
      </Popover>
    </>
  );
}

export interface CharacterView {
  key: string;
  label: string;
  url: string;
}

const VIEW_LABEL: Record<string, string> = { front: '正面', side: '侧面', three_quarter: '3/4 侧', back: '背面' };
const VIEW_ORDER = ['front', 'three_quarter', 'side', 'back'];

/** 角色可绑定的视图：三视图各一张（主图在前）；只有立绘时退化为一张立绘。 */
export function characterViews(c: any): CharacterView[] {
  const tv = (c?.three_views || {}) as Record<string, unknown>;
  const keys = Object.keys(tv).filter((k) => typeof tv[k] === 'string' && tv[k]).sort((a, b) => {
    const ia = VIEW_ORDER.indexOf(a);
    const ib = VIEW_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const out: CharacterView[] = keys.map((k) => ({ key: k, label: VIEW_LABEL[k] || k, url: String(tv[k]) }));
  const main = characterMainImage(c);
  if (!out.length && main) out.push({ key: 'main', label: '立绘', url: main });
  return out;
}

export interface CharacterBinderProps {
  characters: any[];
  /** 已绑定的 `${characterId}|${viewKey}`。 */
  bound: ReadonlySet<string>;
  onBind: (character: any, views: CharacterView[]) => void;
  disabled?: boolean;
}

export function CharacterBinder({ characters, bound, onBind, disabled }: CharacterBinderProps) {
  const usable = characters.filter((c) => characterViews(c).length);
  return (
    <div className="cv-img-chars" role="group" aria-label="角色一致性：绑定角色三视图">
      <span className="cv-img-chars__label"><IconUsers size={14} aria-hidden />角色</span>
      {!usable.length && <span className="cv-img-chars__empty">当前项目没有带三视图 / 立绘的角色，先到「角色」页生成三视图</span>}
      {usable.map((c) => {
        const views = characterViews(c);
        const main = views[0];
        const boundViews = views.filter((v) => bound.has(`${c.id}|${v.key}`));
        const mainBound = bound.has(`${c.id}|${main.key}`);
        const rest = views.filter((v) => !bound.has(`${c.id}|${v.key}`));
        return (
          <span key={c.id} className={['cv-img-chars__chip', boundViews.length ? 'is-bound' : ''].filter(Boolean).join(' ')}>
            <button
              type="button"
              className="cv-img-chars__main"
              disabled={disabled || mainBound}
              title={mainBound ? `${c.name} 已绑定（在参考列表里删除即解绑）` : `绑定 ${c.name} 的${main.label}为参考`}
              onClick={(e) => { e.stopPropagation(); onBind(c, [main]); }}
            >
              <img src={resolveMediaUrl(main.url)} alt="" draggable={false} />
              <span>{c.name}</span>
              {mainBound ? <IconCheck size={12} aria-hidden /> : <IconPlus size={12} aria-hidden />}
            </button>
            {views.length > 1 && rest.length > 0 && (
              <button
                type="button"
                className="cv-img-chars__all"
                disabled={disabled}
                title={`绑定 ${c.name} 的全部视图：${views.map((v) => v.label).join(' / ')}`}
                onClick={(e) => { e.stopPropagation(); onBind(c, rest); }}
              >
                三视图
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
