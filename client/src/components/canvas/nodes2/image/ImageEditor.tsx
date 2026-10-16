// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片预览 + 涂抹层 + 涂抹工具条（Toonflow imageEditor.vue 的模板部分）。
 * - <ImageStage>：卡片里的图片（按宽高比铺满 240 高）+ 进入编辑后的涂抹层 <canvas> + 文本输入框；
 * - <PaintToolbar>：编辑时替换卡片上方的浮动工具栏（NodeSkeleton topSlot）。
 */
import type { CSSProperties, KeyboardEvent, SyntheticEvent } from 'react';
import {
  IconArrowBackUp, IconArrowForwardUp, IconBrush, IconCheck, IconCircle, IconEraser, IconLoader2, IconSquare, IconTrash,
  IconTypography, IconX,
} from '@tabler/icons-react';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { BRUSH_RANGE, FONT_RANGE, type PaintEditor, type PaintTool } from './usePaintEditor';
import { CARD_EXTRA, MEDIA_HEIGHT, type NaturalSize } from './media';
import { INPAINT_OPACITY } from './inpaint';

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** 图片框的像素尺寸：按卡片内容宽与 240 高同时约束、保持宽高比。 */
export function stageBox(natural: NaturalSize | null | undefined, nodeWidth: number | undefined): { width: number; height: number } | null {
  if (!natural || !(natural.width > 0) || !(natural.height > 0) || !nodeWidth) return null;
  const ar = natural.width / natural.height;
  const contentWidth = Math.max(1, nodeWidth - CARD_EXTRA);
  const height = Math.min(MEDIA_HEIGHT, contentWidth / ar);
  return { width: Math.round(height * ar), height: Math.round(height) };
}

export interface ImageStageProps {
  src: string;
  alt: string;
  editor: PaintEditor;
  natural: NaturalSize | null;
  nodeWidth?: number;
  onLoad: (size: NaturalSize) => void;
  onError: () => void;
}

export function ImageStage({ src, alt, editor, natural, nodeWidth, onLoad, onError }: ImageStageProps) {
  const box = stageBox(natural, nodeWidth);
  const text = editor.textDraft ? editor.textStyle() : null;
  const frameStyle: CSSProperties | undefined = box ? { width: box.width, height: box.height } : undefined;
  return (
    <div className="cv-img-stage">
      <div className="cv-img-stage__frame" style={frameStyle}>
        <img
          ref={editor.imageRef}
          className={box ? 'is-sized' : undefined}
          src={resolveMediaUrl(src)}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) onLoad({ width: img.naturalWidth, height: img.naturalHeight });
          }}
          onError={onError}
        />
        {editor.mode && (
          <canvas
            ref={editor.canvasRef}
            className={['cv-img-stage__layer nodrag nopan nowheel', editor.mode === 'inpaint' ? 'is-inpaint' : 'is-mark'].join(' ')}
            style={{ opacity: editor.mode === 'inpaint' ? INPAINT_OPACITY : 0.9, cursor: editor.tool === 'text' ? 'text' : 'crosshair' }}
            aria-label={editor.mode === 'inpaint' ? '涂抹需要重绘的区域' : '图片标记画布'}
            {...editor.handlers}
            onMouseDown={stop}
            onDoubleClick={stop}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          />
        )}
        {editor.textDraft && (
          <textarea
            ref={editor.textInputRef}
            className="cv-img-stage__text nodrag nopan nowheel"
            style={text ? { left: text.left, top: text.top, width: text.width, fontSize: text.fontSize, color: text.color } : undefined}
            rows={Math.max(1, editor.textDraft.text.split('\n').length)}
            aria-label="标记文本"
            placeholder="输入文本"
            wrap="off"
            value={editor.textDraft.text}
            onChange={(e) => editor.setTextDraftText(e.target.value)}
            onPointerDown={stop}
            onMouseDown={stop}
            onDoubleClick={stop}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') { e.preventDefault(); editor.cancelText(); }
              else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editor.commitText(); }
            }}
            onBlur={editor.commitText}
          />
        )}
      </div>
    </div>
  );
}

const TOOL_LABEL: Record<PaintTool, string> = { brush: '画笔', eraser: '橡皮擦', rectangle: '矩形', circle: '圆形', text: '文本' };

export interface PaintToolbarProps {
  editor: PaintEditor;
  /** 标记模式的「保存」（生成标记图片节点）。 */
  onSave?: () => void;
  saving?: boolean;
}

/** Toonflow paintToolbar：[退出 标记/局部重绘] 画笔 (矩形 圆形 文本) 橡皮擦 (颜色) 粗细 撤销 恢复 清空 (保存)。 */
export function PaintToolbar({ editor, onSave, saving }: PaintToolbarProps) {
  const mark = editor.mode === 'mark';
  const busy = editor.busy || !!saving;
  const tools: PaintTool[] = mark ? ['brush', 'rectangle', 'circle', 'text', 'eraser'] : ['brush', 'eraser'];
  const icon = { brush: IconBrush, eraser: IconEraser, rectangle: IconSquare, circle: IconCircle, text: IconTypography } as const;
  const isText = editor.tool === 'text';
  const range = isText ? FONT_RANGE : BRUSH_RANGE;
  return (
    <div
      className="cv-card cv-toolbar cv-img-paintbar"
      role="toolbar"
      aria-label={mark ? '标记工具' : '局部重绘工具'}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); editor.cancel(); }
      }}
    >
      <ToolbarButton icon={IconX} title={mark ? '取消标记' : '取消局部重绘'} disabled={busy} onClick={() => editor.cancel()} className="cv-img-paintbar__exit">
        {mark ? '标记' : '局部重绘'}
      </ToolbarButton>
      {tools.map((t) => (
        <ToolbarButton
          key={t}
          icon={icon[t]}
          title={TOOL_LABEL[t]}
          iconOnly
          active={editor.tool === t}
          aria-pressed={editor.tool === t}
          disabled={busy}
          onClick={() => editor.setTool(t)}
        />
      ))}
      {mark && (
        <input
          type="color"
          className="cv-img-paintbar__color"
          value={editor.color}
          disabled={busy}
          title="标记颜色（作用于整层）"
          aria-label="标记颜色"
          onChange={(e) => editor.setColor(e.target.value)}
        />
      )}
      <label className="cv-img-paintbar__size">
        {isText ? '字号' : '粗细'}
        <input
          type="range"
          min={range.min}
          max={range.max}
          value={editor.toolSize}
          disabled={busy}
          aria-label={isText ? '文本字号' : '画笔粗细'}
          onChange={(e) => editor.setToolSize(Number(e.target.value))}
        />
        <span>{editor.toolSize}</span>
      </label>
      <ToolbarButton icon={IconArrowBackUp} title="撤销" iconOnly disabled={busy || !editor.strokeCount} onClick={editor.undo} />
      <ToolbarButton icon={IconArrowForwardUp} title="恢复" iconOnly disabled={busy || editor.strokeCount === editor.historyLength} onClick={editor.redo} />
      <ToolbarButton icon={IconTrash} title="清空标记" iconOnly disabled={busy || !editor.hasDrawing} onClick={editor.clear} />
      {mark && (
        <button
          type="button"
          className="cv-img-paintbar__save"
          disabled={busy || (!editor.hasDrawing && !editor.textDraft?.text.trim())}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); onSave?.(); }}
        >
          {saving ? <IconLoader2 size={16} className="cv-spin" aria-hidden /> : <IconCheck size={16} aria-hidden />}
          保存
        </button>
      )}
    </div>
  );
}
