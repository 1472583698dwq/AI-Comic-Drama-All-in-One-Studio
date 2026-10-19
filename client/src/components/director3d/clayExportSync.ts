/**
 * 白模导出的状态对齐（REQ stage-remote-clay）。
 *
 * 背景：Agent 远控摆台（stage_control）只写服务端 content，而浏览器端的舞台状态是
 * 「挂载时从内存 store 播种一次」的副本——远控的 patch 不会进这个副本。于是
 * 「远控摆台 → 远控导出」会录到旧舞台，且导出完成后的整份回写还会把服务端的新状态覆盖回旧的。
 *
 * 修法：任何一次白模录制开始前，先以服务端 content 为准对齐内存（只读不回写），
 * 再定位目标分镜；录制完成后的 clay_* 回写落在「服务端新状态」之上，不再覆盖。
 */
import { useProjectStore } from '../../stores/useProjectStore';
import { shotsInEpisode } from '../../utils/episodeScope';

/** 拉服务端最新 content 覆盖内存（不回写）。失败时返回 false：宁可用内存旧状态继续，也别把导出卡死。 */
export async function resyncStageFromServer(): Promise<boolean> {
  const st = useProjectStore.getState();
  if (!(st.activeProjectId || st.project?.id)) return false;
  try {
    await st.reloadProjectContent();
    return true;
  } catch {
    return false;
  }
}

/** 在（对齐后的）内存项目里定位要录制的分镜：shot_id → shot_index → 当前镜 → 第一镜 */
export function findClayTargetShot(
  detail: { shot_id?: string; shot_index?: number | string } | null | undefined,
): any | null {
  const st = useProjectStore.getState();
  const all = shotsInEpisode(st.project, st.activeEpisodeId);
  return all.find((sh: any) => sh.id && sh.id === detail?.shot_id)
    || all.find((sh: any) => detail?.shot_index !== undefined && Number(sh.shot_index) === Number(detail.shot_index))
    || all.find((sh: any) => sh.id === st.activeShotId)
    || all[0]
    || null;
}
