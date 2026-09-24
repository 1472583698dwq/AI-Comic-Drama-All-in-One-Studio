import React, { useState } from 'react';

type AspectLike = string | number;

const toRatioNumber = (v: AspectLike): number | null => {
  if (typeof v === 'number') return v > 0 ? v : null;
  const s = String(v).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[/:：]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const w = parseFloat(m[1]);
    const h = parseFloat(m[2]);
    return w > 0 && h > 0 ? w / h : null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export interface AutoRatioMediaProps {
  src: string;
  kind?: 'image' | 'video';
  alt?: string;
  /** 容器类：边框/圆角/背景/定位等（宽高由素材比例决定） */
  className?: string;
  /** 媒体元素附加类 */
  mediaClassName?: string;
  /** 元数据加载完成前的兜底比例（如 '3/4'、'9:16'、1.5） */
  fallbackAspect?: AspectLike;
  /** 最大高度（px）：超出时整体等比缩小并居中，不裁切 */
  maxHeight?: number;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  title?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  imgProps?: React.ImgHTMLAttributes<HTMLImageElement>;
  videoProps?: React.VideoHTMLAttributes<HTMLVideoElement>;
  imgRef?: React.Ref<HTMLImageElement>;
  videoRef?: React.Ref<HTMLVideoElement>;
}

/**
 * 自适应比例媒体框：容器宽高比始终等于素材真实比例，不裁切、不留边。
 * 加载出真实尺寸后自动更新比例；maxHeight 时按比例缩小并水平居中。
 */
export const AutoRatioMedia: React.FC<AutoRatioMediaProps> = ({
  src,
  kind = 'image',
  alt = '',
  className = '',
  mediaClassName = '',
  fallbackAspect = '1/1',
  maxHeight,
  onClick,
  title,
  style,
  children,
  imgProps,
  videoProps,
  imgRef,
  videoRef,
}) => {
  const [ratio, setRatio] = useState<AspectLike>(fallbackAspect);
  const num = toRatioNumber(ratio);

  const sizeStyle: React.CSSProperties = {
    aspectRatio: String(ratio),
    maxWidth: '100%',
    width: maxHeight && num ? `min(100%, ${Math.round(maxHeight * num)}px)` : '100%',
  };
  if (maxHeight && num) {
    sizeStyle.marginLeft = 'auto';
    sizeStyle.marginRight = 'auto';
  }

  const applyRatio = (w?: number, h?: number) => {
    if (w && h && w > 0 && h > 0) setRatio(`${w}/${h}`);
  };

  if (kind === 'video') {
    const { onLoadedMetadata, ...restVideo } = videoProps || {};
    return (
      <div className={`relative overflow-hidden ${className}`} style={{ ...sizeStyle, ...style }} onClick={onClick} title={title}>
        <video
          ref={videoRef}
          src={src}
          className={`block w-full h-full object-contain ${mediaClassName}`}
          onLoadedMetadata={(e) => {
            applyRatio(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
            onLoadedMetadata?.(e);
          }}
          {...restVideo}
        />
        {children}
      </div>
    );
  }

  const { onLoad, ...restImg } = imgProps || {};
  return (
    <div className={`relative overflow-hidden ${className}`} style={{ ...sizeStyle, ...style }} onClick={onClick} title={title}>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className={`block w-full h-full object-contain ${mediaClassName}`}
        onLoad={(e) => {
          applyRatio(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
          onLoad?.(e);
        }}
        {...restImg}
      />
      {children}
    </div>
  );
};
