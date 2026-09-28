/** 新手引导标记：上下文提示卡的「已读」状态（localStorage，键前缀 tip_seen_） */

export const TIP_SEEN_PREFIX = 'tip_seen_';

export function isTipSeen(key: string): boolean {
  try { return localStorage.getItem(TIP_SEEN_PREFIX + key) === '1'; } catch { return false; }
}

export function markTipSeen(key: string): void {
  try { localStorage.setItem(TIP_SEEN_PREFIX + key, '1'); } catch { /* ignore */ }
}

/** 设置 → 系统「重置新手提示」：清掉所有已读标记，下次进入对应页面重新出现 */
export function resetContextTips(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(TIP_SEEN_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
