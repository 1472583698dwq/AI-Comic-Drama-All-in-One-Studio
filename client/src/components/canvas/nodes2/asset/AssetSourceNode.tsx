// -*- coding: utf-8 -*-
/**
 * REQ 素材节点（asset-source，Toonflow assetNode 的素材库版）：
 * - 空白态：「从素材库选择」按钮 → AssetPickerModal（图 / 视频 / 音频 / 文本，支持分类筛选、搜索、上传入库）；
 * - 选中后：按类型预览（图/视频/音频/文本），工具栏可「更换素材」；
 * - 输出口 `out`（`*` 类型）：连线到生成节点（或文本节点）后进入其参考列表，
 *   组装生成请求时按源 schema 落成首帧 / 参考图 / 参考音频等参数（kit/assembleInputs）。
 * 数据键：asset_id / asset_name / asset_kind + image_url / video_url / audio_url / prompt（+镜像键），
 * 读取口径见 pick.ts（与 kit/references、后端 canvas/inputs.py 一致）。
 */
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeProps } from '@xyflow/react';
import { IconArrowsExchange, IconFolderOpen, IconMusic } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { useKitNodeActions } from '../../kit/hostContext';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { AssetPickerModal } from '../../../asset/AssetPickerModal';
import { fileNameOf } from '../image/media';
import {
  assetSourceKindOf, assetSourcePatch, assetSourcePreviewOf,
} from './pick';
import './asset.css';

type Data = Record<string, unknown>;

export function AssetSourceNode(props: NodeProps) {
  const { id } = props;
  const data = (props.data || {}) as Data;
  const actions = useKitNodeActions(id);
  const [pickerOpen, setPickerOpen] = useState(false);

  const preview = useMemo(() => assetSourcePreviewOf(data), [data]);
  const display = preview.url ? resolveMediaUrl(preview.url) : '';
  const hasAsset = !!(preview.url || preview.content);
  const isMedia = preview.kind === 'image' || preview.kind === 'video' || preview.kind === 'audio';

  const onPick = useCallback((asset: { id: string; name: string; url: string; category: string; visual_prompt?: string; content?: string }) => {
    const kind = assetSourceKindOf(asset);
    actions.update(assetSourcePatch(kind, {
      url: asset.url || undefined,
      content: asset.content || asset.visual_prompt || undefined,
      assetId: asset.id,
      name: asset.name,
    }));
  }, [actions]);

  const toolbar = (
    <ToolbarButton
      icon={hasAsset ? IconArrowsExchange : IconFolderOpen}
      title={hasAsset ? '更换素材' : '从素材库选择素材'}
      onClick={() => setPickerOpen(true)}
    >
      {hasAsset ? '更换素材' : '选择素材'}
    </ToolbarButton>
  );

  const body = !hasAsset ? (
    <button
      type="button"
      className="cv-asset__empty nodrag"
      title="打开素材库选择图片 / 视频 / 音频 / 文本"
      onClick={() => setPickerOpen(true)}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <IconFolderOpen size={48} stroke={1.5} aria-hidden />
      <span>从素材库选择</span>
      <span className="cv-asset__hint">选好后连线到生成节点，即可加入其参考 / 参数</span>
    </button>
  ) : preview.kind === 'image' ? (
    <img className="cv-asset__media" src={display} alt={preview.name || '素材图片'} draggable={false} />
  ) : preview.kind === 'video' ? (
    <video className="cv-asset__media" src={display} controls muted preload="metadata" playsInline />
  ) : preview.kind === 'audio' ? (
    <div className="cv-asset__audio">
      <IconMusic size={36} stroke={1.5} aria-hidden />
      <audio src={display} controls preload="none" />
      <span className="cv-asset__filename">{preview.name || fileNameOf(preview.url)}</span>
    </div>
  ) : (
    <div className="cv-asset__text" title={preview.content.length > 200 ? `${preview.content.slice(0, 200)}…` : preview.content}>
      {preview.content || '（空文本素材）'}
    </div>
  );

  return (
    <NodeSkeleton
      node={props}
      width={240}
      toolbar={toolbar}
      downloadUrl={isMedia && display ? display : undefined}
      downloadName={preview.name || (preview.url ? fileNameOf(preview.url) : undefined)}
      fullscreenDisabled={!isMedia || !display}
    >
      {body}
      {pickerOpen && createPortal(
        <div className="relative z-[70]">
          <AssetPickerModal
            isOpen={pickerOpen}
            mediaType="all"
            title="从素材库选择素材"
            onSelect={onPick}
            onClose={() => setPickerOpen(false)}
          />
        </div>,
        document.body,
      )}
    </NodeSkeleton>
  );
}
