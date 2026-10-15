// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：分镜卡 `shot-card`（原 nodes/ShotCardNode.tsx）。
 *
 * 逻辑不变：
 * - 读 data：shotId（分镜归属）、shot_index、camera_framing / camera_motion、provider / provider_id / model（连线注入的生成源）、
 *   providerDef / definition（动态输入口）、action_desc、image_prompt、video_prompt、image_url、video_url、subtitle_text、
 *   workflow_id、dynamic_inputs；
 * - 「生成首帧」= apiService.generateShotImage（项目画幅 / 风格）→ 写 image_url；
 * - 「生视频」= apiService.generateShotVideo（i2v，首帧 = image_url，5s）→ 有 task_id 时 pollVideoTask → 写 video_url；
 * - 挂载的人物 / 场景 / 道具徽章读 useProjectStore 里同 id 的分镜（找不到用节点自身数据）。
 * 换皮：NodeSkeleton 外壳 + NodeHandles（端口见 ports.shotCardPorts）、颜色只用 --cv-*、Tabler 图标、错误改用全局 toast；
 * 数据只从 data 读、经 useKitNodeActions().update 写（旧组件的 localData 副本会在外部更新后过期，已去掉）。
 */
import { useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconCheck, IconMountain, IconPhoto, IconPlayerPlay, IconSparkles, IconSword } from '@tabler/icons-react';
import { apiService } from '../../../../services/api';
import { useProjectStore } from '../../../../stores/useProjectStore';
import { toast } from '../../../../stores/useDialogStore';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { pollVideoTask } from '../../../../utils/videoTask';
import { AutoRatioMedia } from '../../../ui/AutoRatioMedia';
import { NodeSkeleton, ToolbarButton, useKitNodeActions } from '../../kit';
import { shotCardPorts } from './ports';
import { LaButton, LaChip, LaNotice } from './ui';
import { EMPTY_DATA, NO_CANVAS, errorMessage, interactiveGuards } from './helpers';

export const SHOT_CARD_TYPE = 'shot-card';
export const SHOT_CARD_WIDTH = 300;

export interface ShotCardData extends Record<string, unknown> {
  label?: string;
  shotId?: string;
  id?: string;
  shot_index?: number | string;
  camera_framing?: string;
  camera_motion?: string;
  provider?: string;
  provider_id?: string;
  model?: string;
  providerDef?: unknown;
  definition?: unknown;
  action_desc?: string;
  image_prompt?: string;
  video_prompt?: string;
  image_url?: string;
  video_url?: string;
  subtitle_text?: string;
  workflow_id?: string;
  dynamic_inputs?: Record<string, unknown>;
  character_ids?: string[];
  scene_name?: string;
  prop_prompts?: unknown;
}

type AnyShot = { id?: string; character_ids?: string[]; scene_name?: string; prop_prompts?: unknown };
type AnyCharacter = { id: string; name?: string; avatar_url?: string; three_views?: Record<string, string> };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function ShotCardNode(props: NodeProps) {
  const { id } = props;
  const d = (props.data || EMPTY_DATA) as ShotCardData;
  const actions = useKitNodeActions(id);
  const project = useProjectStore((s) => s.project);
  const [generating, setGenerating] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);

  // 挂载的人物与场景：优先用项目里同 id 的分镜（分镜页改了这里实时跟），找不到时用节点自身数据（同旧组件）
  const shotKey = str(d.shotId) || str(d.id) || id;
  const liveShot = useMemo<AnyShot>(() => {
    const scenes = (project?.scenes || []) as Array<{ shots?: AnyShot[] }>;
    for (const sc of scenes) {
      const hit = (sc.shots || []).find((s) => s?.id === shotKey);
      if (hit) return hit;
    }
    return d;
  }, [project, shotKey, d]);
  const characters = (project?.characters || []) as AnyCharacter[];

  // 解耦：优先用连线注入的生成源（d.provider），否则回退 provider_id（同旧组件）
  const provider = str(d.provider) || str(d.provider_id);
  const model = str(d.model);
  const imgUrl = d.image_url ? resolveMediaUrl(d.image_url) : '';
  const inputLabels = useMemo(() => shotCardPorts(d).filter((p) => p.type === 'target').map((p) => p.label ?? p.id), [d]);
  const title = d.label || `分镜卡${d.shot_index ? ` #${d.shot_index}` : ''}`;

  const handleGenerate = async () => {
    if (!str(d.image_prompt).trim()) { toast.warning('请填写画面提示词'); return; }
    setGenerating(true);
    try {
      const res = await apiService.generateShotImage({
        prompt: str(d.image_prompt),
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
        workflow_id: d.workflow_id || undefined,
        dynamic_inputs: d.dynamic_inputs,
        provider: provider || undefined,
        model: model || undefined,
      });
      actions.update({ image_url: res.image_url });
    } catch (e) {
      toast.error(errorMessage(e, '生成首帧失败'));
    } finally {
      setGenerating(false);
    }
  };

  const handleVideo = async () => {
    const prompt = str(d.video_prompt) || str(d.action_desc) || str(d.image_prompt);
    if (!prompt) { toast.warning('请填写视频运动描述'); return; }
    setVideoBusy(true);
    try {
      const res = await apiService.generateShotVideo({ prompt, mode: 'i2v', first_frame_url: d.image_url, duration: 5, provider: provider || undefined });
      let url = res.video_url;
      // 排队任务统一轮询（pollVideoTask：网络抖动不误杀，终态失败即抛）
      if (!url && res.task_id) url = await pollVideoTask(res.task_id);
      actions.update({ video_url: url });
    } catch (e) {
      toast.error(errorMessage(e, '生成视频失败'));
    } finally {
      setVideoBusy(false);
    }
  };

  const subtitle = d.subtitle_text ? <div className="cv-la-subtitle">{d.subtitle_text}</div> : null;
  const hasBadges = !!(liveShot?.character_ids?.length || liveShot?.scene_name || liveShot?.prop_prompts);

  return (
    <NodeSkeleton
      node={props}
      label={title}
      width={SHOT_CARD_WIDTH}
      downloadUrl={imgUrl || undefined}
      downloadName={d.image_url ? d.image_url.split('/').pop() : undefined}
      onFullscreen={imgUrl ? () => actions.openFullscreen(imgUrl, 'image') : null}
      toolbar={(
        <>
          <ToolbarButton icon={IconSparkles} title="生成首帧" loading={generating} onClick={() => void handleGenerate()}>生成首帧</ToolbarButton>
          <ToolbarButton icon={IconPlayerPlay} title="生视频" loading={videoBusy} onClick={() => void handleVideo()}>生视频</ToolbarButton>
        </>
      )}
    >
      <div className="cv-la">
        <div className="cv-la-row cv-la-row--between">
          {provider ? (
            <LaChip tone="accent" title={provider} className="cv-la-mono"><span>{provider.slice(0, 12)}</span></LaChip>
          ) : <span />}
          <LaChip className="cv-la-mono"><span>{d.camera_framing || 'medium'} · {d.camera_motion || 'push_in'}</span></LaChip>
        </div>

        {/* 挂载的人物与场景徽章 */}
        {hasBadges && (
          <div className="cv-la-row cv-la-row--wrap">
            {(liveShot.character_ids || []).map((cid) => {
              const char = characters.find((c) => c.id === cid);
              if (!char) return null;
              const tv = char.three_views || {};
              const avatar = tv.front || char.avatar_url || tv.three_quarter || tv.side;
              return (
                <LaChip key={cid} tone="accent" title={char.name}>
                  {avatar && <img className="cv-la-chip__avatar" src={resolveMediaUrl(avatar)} alt="" />}
                  <span>{char.name}</span>
                </LaChip>
              );
            })}
            {liveShot.scene_name && <LaChip icon={IconMountain} title={liveShot.scene_name}><span>{liveShot.scene_name}</span></LaChip>}
            {!!liveShot.prop_prompts && <LaChip icon={IconSword}><span>道具</span></LaChip>}
          </div>
        )}

        {imgUrl ? (
          <AutoRatioMedia src={imgUrl} fallbackAspect="9/16" maxHeight={220} className="cv-la-media">
            {subtitle}
          </AutoRatioMedia>
        ) : (
          <div className="cv-la-media cv-la-media--empty">
            <IconPhoto size={28} stroke={1.5} aria-hidden />
            <span className="cv-la-small">{generating ? '生成中…' : '暂无画面'}</span>
            {subtitle}
          </div>
        )}

        <textarea
          className={`cv-la-field ${NO_CANVAS}`}
          {...interactiveGuards}
          aria-label="画面动作描述"
          value={d.action_desc || ''}
          onChange={(e) => actions.update({ action_desc: e.target.value })}
          placeholder="画面动作描述…（支持多行）"
          rows={2}
        />
        <textarea
          className={`cv-la-field cv-la-field--mono ${NO_CANVAS}`}
          {...interactiveGuards}
          aria-label="画面提示词"
          value={d.image_prompt || ''}
          onChange={(e) => actions.update({ image_prompt: e.target.value })}
          placeholder="英文画面提示词…（可粘贴长段）"
          rows={2}
        />
        {inputLabels.length > 0 && (
          <LaNotice tone="accent">已接入 {inputLabels.join('、')} · 多模态输入就绪</LaNotice>
        )}
        <div className="cv-la-row">
          <LaButton variant="primary" size="sm" className="cv-la-grow" icon={IconSparkles} loading={generating} onClick={() => void handleGenerate()}>
            {generating ? '生成中' : '生成首帧'}
          </LaButton>
          <LaButton size="sm" icon={IconPlayerPlay} loading={videoBusy} onClick={() => void handleVideo()}>生视频</LaButton>
        </div>
        {d.video_url && (
          <div className="cv-la-row cv-la-small cv-la-accent">
            <IconCheck size={12} aria-hidden />
            <span className="cv-la-truncate">视频已生成</span>
          </div>
        )}
      </div>
    </NodeSkeleton>
  );
}

export default ShotCardNode;
