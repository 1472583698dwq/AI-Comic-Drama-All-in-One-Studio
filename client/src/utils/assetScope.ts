/**
 * 素材归属统一决策（P0 分级隔离）：
 * - 显式 global → 全局库
 * - 显式 project 且有项目上下文 → 项目私有
 * - 未指定但有项目上下文 → 项目私有（默认不进全局）
 * - 未指定且无项目 → 全局库（确定性落库，不再依赖后端"读时迁移"）
 */
export function resolveAssetOwnership(
  scope: 'project' | 'global' | null | undefined,
  projectId?: string | null,
): { scope: 'project' | 'global'; project_id: string | null } {
  const pid = projectId || null;
  if (scope === 'global') return { scope: 'global', project_id: null };
  if (pid) return { scope: 'project', project_id: pid };
  return { scope: 'global', project_id: null };
}

/** 把归属写入 FormData（createAsset / updateAsset 上传用）。 */
export function appendAssetOwnership(
  fd: FormData,
  scope: 'project' | 'global' | null | undefined,
  projectId?: string | null,
): { scope: 'project' | 'global'; project_id: string | null } {
  const own = resolveAssetOwnership(scope, projectId);
  fd.append('scope', own.scope);
  if (own.project_id) fd.append('project_id', own.project_id);
  return own;
}
