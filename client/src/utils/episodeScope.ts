/** 工作空间按集过滤。'none' = 还没归到任何一集的场；'all' = 不分集视角。 */

export const UNASSIGNED_EPISODE = 'none';
export const ALL_EPISODES = 'all';

export const WORKSPACE_TABS = ['studio', 'director3d', 'timeline', 'onekey', 'canvas'] as const;

export function scenesInEpisode(project: any, episodeId: string | null | undefined): any[] {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  if (!episodeId || episodeId === ALL_EPISODES) return scenes;
  const known = new Set((project?.episodes || []).map((e: any) => e.id));
  if (episodeId === UNASSIGNED_EPISODE) {
    return scenes.filter((s: any) => !s.episode_id || !known.has(s.episode_id));
  }
  return scenes.filter((s: any) => s.episode_id === episodeId);
}

export function shotsInEpisode(project: any, episodeId: string | null | undefined): any[] {
  return scenesInEpisode(project, episodeId).flatMap((s: any) => s.shots || []);
}
