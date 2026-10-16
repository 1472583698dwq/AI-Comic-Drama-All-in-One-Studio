import React from 'react';
import { Library, Users } from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { usePageStore } from '../../stores/usePageStore';
import { AssetLibrary } from './AssetLibrary';
import { CharacterStudio } from '../character/CharacterStudio';

/**
 * 素材库：「素材」与「角色」两个标签页。
 *
 * 角色设定原来是侧栏里一个独立页面，现在并进素材库 —— 角色本质上也是一类素材，
 * 拆成两个入口反而让人找不到。两个标签页各自对应一个页签 id（assets / characters），
 * 所以旧代码里 `setActiveTab('characters')` 的跳转照样有效，会直接落到「角色」这一页。
 * 功能开关里关掉了「角色设定」的话，这里就只剩「素材」。
 */
export const AssetsHub: React.FC = () => {
  const activeTab = useProjectStore((s) => s.activeTab);
  const setActiveTab = useProjectStore((s) => s.setActiveTab);
  const charactersCount = useProjectStore((s) => s.project?.characters?.length || 0);
  const charactersEnabled = usePageStore((s) => s.values.characters === true);

  const tab: 'assets' | 'characters' =
    activeTab === 'characters' && charactersEnabled ? 'characters' : 'assets';

  const tabs = [
    { id: 'assets' as const, label: '素材', icon: Library },
    ...(charactersEnabled ? [{ id: 'characters' as const, label: '角色', icon: Users, count: charactersCount }] : []),
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {tabs.length > 1 && (
        <div className="h-11 shrink-0 px-4 flex items-end gap-1 border-b border-black/[.07] dark:border-white/[.08] bg-surface/80">
          {tabs.map(({ id, label, icon: Icon, ...rest }) => {
            const on = tab === id;
            const count = (rest as { count?: number }).count;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id as any)}
                aria-current={on ? 'page' : undefined}
                className={`relative h-9 px-3 inline-flex items-center gap-2 text-[13px] font-medium rounded-t-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand ${
                  on
                    ? '[color:var(--color-text-main)]'
                    : '[color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-black/[.04] dark:hover:bg-white/[.05]'
                }`}
              >
                <Icon className="w-4 h-4" strokeWidth={1.8} />
                {label}
                {count != null && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-black/[.06] dark:bg-white/[.08] text-[11px] tabular-nums inline-flex items-center justify-center">
                    {count}
                  </span>
                )}
                {on && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-brand" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        {tab === 'characters' ? <CharacterStudio /> : <AssetLibrary />}
      </div>
    </div>
  );
};

export default AssetsHub;
