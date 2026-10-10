/**
 * 必达页（锁定页）清单 —— **唯一来源**（审查 L4-2）。
 *
 * 两处消费，必须说同一件事：
 *   · `entries/pages.tsx` 注册时给该页标 `locked`（不绑 switchId，见 `registry.ts` 的注册期校验）；
 *   · `App.tsx` 页面槽标注时把 `data-ui-locked` 展开到 `main` 上，让标注模式与注册表视图口径一致。
 *
 * 锁定真相在后端（`server/app/core/pages.py` 的 `is_locked`）；前端这里只是同一个事实的镜像，
 * 不新增后端契约（设计 §5.4-1）。注意 `locked` 锁的是**存在性**、不是版本（设计 §2.4-4）。
 */
export const LOCKED_PAGE_IDS: readonly string[] = ['config'];

/** 某页是否锁定（必达入口：关掉它用户就回不到开关面板） */
export const isLockedPageId = (id: string): boolean => LOCKED_PAGE_IDS.includes(id);
