// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片涂抹编辑器状态（Toonflow nodeScaffold/components/imageEditor.vue 的 React 版）。
 *
 * 两种模式：
 * - mark（标记）：画笔 / 矩形 / 圆形 / 文本 / 橡皮擦，颜色 + 粗细（文本为字号），撤销 / 恢复 / 清空，保存后生成新图片节点；
 * - inpaint（局部重绘）：画笔 / 橡皮擦，固定红色、55% 不透明显示，配合提示词面板生成。
 * 涂抹层是与原图同像素尺寸的 <canvas>（不画原图，所以永远不会被跨域污染），导出即遮罩 PNG。
 * 与 Toonflow 的差异：标记的「保存」走后端 compose-mask（单一颜色），所以颜色对整层生效（改色即全部重绘成新色）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { INPAINT_COLOR } from './inpaint';

export type PaintMode = 'mark' | 'inpaint';
export type PaintTool = 'brush' | 'eraser' | 'rectangle' | 'circle' | 'text';

interface Point { x: number; y: number }
interface Stroke { tool: PaintTool | 'clear'; size: number; points: Point[]; text?: string }
export interface TextDraft { point: Point; size: number; text: string }

export const MARK_DEFAULT_COLOR = '#ff4545';

export interface PaintEditor {
  mode: PaintMode | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  tool: PaintTool;
  setTool: (tool: PaintTool) => void;
  color: string;
  setColor: (color: string) => void;
  /** 当前工具的粗细（文本工具为字号）。 */
  toolSize: number;
  setToolSize: (size: number) => void;
  strokeCount: number;
  historyLength: number;
  hasDrawing: boolean;
  textDraft: TextDraft | null;
  setTextDraftText: (text: string) => void;
  commitText: () => void;
  cancelText: () => void;
  /** 进入模式；图片未加载完成时返回 false。 */
  start: (mode: PaintMode) => boolean;
  cancel: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  /** 原图 <img>（取 naturalWidth/Height）。 */
  imageRef: (el: HTMLImageElement | null) => void;
  /** 涂抹层 <canvas>。 */
  canvasRef: (el: HTMLCanvasElement | null) => void;
  textInputRef: (el: HTMLTextAreaElement | null) => void;
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLCanvasElement>) => void;
    onLostPointerCapture: (e: ReactPointerEvent<HTMLCanvasElement>) => void;
  };
  /** 涂抹层是否有任何不透明像素（Toonflow generate 前的校验）。 */
  hasInk: () => boolean;
  /** 涂抹层 PNG dataURL（遮罩，原图像素尺寸）。 */
  layerDataUrl: () => string | null;
  /** 复制一份涂抹层（生成期间编辑器可能退出，合成时要用）。 */
  cloneLayer: () => HTMLCanvasElement | null;
  /** 文本输入框在涂抹层上的位置（像素，相对图片框）。 */
  textStyle: () => { left: number; top: number; width: number; fontSize: number; color: string } | null;
}

/** Toonflow：画笔粗细 2–60（默认 16）、字号 12–60（默认 24）。 */
export const BRUSH_RANGE = { min: 2, max: 60, initial: 16 };
export const FONT_RANGE = { min: 12, max: 60, initial: 24 };

export function usePaintEditor(src: string, opts: { disabled?: boolean } = {}): PaintEditor {
  const [mode, setMode] = useState<PaintMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [tool, setToolState] = useState<PaintTool>('brush');
  const [color, setColorState] = useState(MARK_DEFAULT_COLOR);
  const [brushSize, setBrushSize] = useState(BRUSH_RANGE.initial);
  const [fontSize, setFontSize] = useState(FONT_RANGE.initial);
  const [strokeCount, setStrokeCount] = useState(0);
  const [historyLength, setHistoryLength] = useState(0);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);

  const imgEl = useRef<HTMLImageElement | null>(null);
  const canvasEl = useRef<HTMLCanvasElement | null>(null);
  const textEl = useRef<HTMLTextAreaElement | null>(null);
  const strokes = useRef<Stroke[]>([]);
  const countRef = useRef(0);
  const draft = useRef<Stroke | null>(null);
  const pointerId = useRef<number | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const colorRef = useRef(color);
  colorRef.current = color;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;
  const disabledRef = useRef(!!opts.disabled);
  disabledRef.current = !!opts.disabled;
  const toolSize = tool === 'text' ? fontSize : brushSize;
  const toolSizeRef = useRef(toolSize);
  toolSizeRef.current = toolSize;

  const strokeColor = () => (modeRef.current === 'inpaint' ? INPAINT_COLOR : colorRef.current);

  const ctx2d = () => canvasEl.current?.getContext('2d') ?? null;

  const drawSegment = (stroke: Stroke, point: Point, previous: Point = point) => {
    const ctx = ctx2d();
    if (!ctx) return;
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = ctx.strokeStyle = strokeColor();
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (point === previous) {
      ctx.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  };

  const drawStroke = (stroke: Stroke) => {
    const canvas = canvasEl.current;
    const ctx = ctx2d();
    if (!canvas || !ctx) return;
    if (stroke.tool === 'clear') { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    if (stroke.tool === 'brush' || stroke.tool === 'eraser') {
      stroke.points.forEach((p, i) => drawSegment(stroke, p, i ? stroke.points[i - 1] : p));
      return;
    }
    const start = stroke.points[0];
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = ctx.strokeStyle = strokeColor();
    ctx.lineWidth = stroke.size;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    if (stroke.tool === 'text') {
      ctx.font = `${stroke.size}px sans-serif`;
      ctx.textBaseline = 'top';
      (stroke.text || '').split('\n').forEach((line, i) => ctx.fillText(line, start.x, start.y + i * stroke.size * 1.25));
      return;
    }
    const end = stroke.points[1];
    if (!end) return;
    ctx.beginPath();
    if (stroke.tool === 'rectangle') ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
    else {
      const r = Math.min(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) / 2;
      ctx.arc(start.x + Math.sign(end.x - start.x) * r, start.y + Math.sign(end.y - start.y) * r, r, 0, Math.PI * 2);
    }
    ctx.stroke();
  };

  /** 按当前历史游标重放全部操作（形状预览、撤销 / 恢复、改色都走这里）。 */
  const redraw = useCallback(() => {
    const canvas = canvasEl.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    let drawn = false;
    for (const s of strokes.current.slice(0, countRef.current)) {
      drawStroke(s);
      if (s.tool === 'clear') drawn = false;
      else if (s.tool !== 'eraser') drawn = true;
    }
    setHasDrawing(drawn);
    // drawStroke / drawSegment 只读 ref，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitStroke = (stroke: Stroke) => {
    strokes.current.splice(countRef.current, strokes.current.length - countRef.current, stroke);
    countRef.current = strokes.current.length;
    setStrokeCount(countRef.current);
    setHistoryLength(countRef.current);
    redraw();
  };

  const releasePointer = () => {
    const captured = pointerId.current;
    pointerId.current = null;
    draft.current = null;
    if (captured !== null && canvasEl.current?.hasPointerCapture?.(captured)) canvasEl.current.releasePointerCapture(captured);
  };

  const cancelStroke = () => {
    releasePointer();
    redraw();
  };

  const commitText = useCallback(() => {
    const d = textDraftRef.current;
    textDraftRef.current = null;
    setTextDraft(null);
    if (d && d.text.trim() && !busyRef.current && modeRef.current === 'mark') {
      commitStroke({ tool: 'text', size: d.size, points: [d.point], text: d.text });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = useCallback(() => {
    releasePointer();
    strokes.current = [];
    countRef.current = 0;
    setStrokeCount(0);
    setHistoryLength(0);
    setHasDrawing(false);
    textDraftRef.current = null;
    setTextDraft(null);
    setMode(null);
    const canvas = canvasEl.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换图（替换 / 切历史版本 / 重绘完成）即退出编辑（Toonflow watch(src, cancel)）
  useEffect(() => { cancel(); }, [src, cancel]);

  const sizeCanvas = () => {
    const img = imgEl.current;
    const canvas = canvasEl.current;
    if (!img || !canvas || !img.naturalWidth || !img.naturalHeight) return;
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      redraw();
    }
  };

  const start = useCallback((next: PaintMode) => {
    const img = imgEl.current;
    if (disabledRef.current || busyRef.current || !img || !img.complete || !img.naturalWidth) return false;
    cancel();
    setToolState('brush');
    setMode(next);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancel]);

  const getPoint = (e: { clientX: number; clientY: number }): Point => {
    const canvas = canvasEl.current!;
    const b = canvas.getBoundingClientRect();
    const w = b.width || canvas.width;
    const h = b.height || canvas.height;
    return {
      x: Math.max(0, Math.min(canvas.width, ((e.clientX - b.left) / w) * canvas.width)),
      y: Math.max(0, Math.min(canvas.height, ((e.clientY - b.top) / h) * canvas.height)),
    };
  };

  /** 屏幕粗细 → 原图像素粗细（clientWidth 不受画布缩放影响，同 Toonflow）。 */
  const scaledSize = () => {
    const canvas = canvasEl.current!;
    return (toolSizeRef.current * canvas.width) / (canvas.clientWidth || canvas.width || 1);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const canvas = canvasEl.current;
    if (!canvas || busyRef.current || disabledRef.current || e.button !== 0 || pointerId.current !== null || !modeRef.current) return;
    commitText();
    const point = getPoint(e);
    const size = scaledSize();
    if (toolRef.current === 'text') {
      if (modeRef.current !== 'mark') return;
      const d = { point, size, text: '' };
      textDraftRef.current = d;
      setTextDraft(d);
      window.setTimeout(() => textEl.current?.focus(), 0);
      return;
    }
    pointerId.current = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    const stroke: Stroke = { tool: toolRef.current, size, points: [point] };
    draft.current = stroke;
    if (stroke.tool === 'brush' || stroke.tool === 'eraser') drawSegment(stroke, point);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (e.pointerId !== pointerId.current || busyRef.current || !draft.current) return;
    e.preventDefault();
    const stroke = draft.current;
    const point = getPoint(e);
    if (stroke.tool === 'brush' || stroke.tool === 'eraser') {
      drawSegment(stroke, point, stroke.points[stroke.points.length - 1]);
      stroke.points.push(point);
    } else {
      stroke.points[1] = point;
      redraw();
      drawStroke(stroke);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (e.pointerId !== pointerId.current || !draft.current) return;
    e.preventDefault();
    onPointerMove(e);
    const stroke = draft.current;
    releasePointer();
    if (!stroke) return;
    if ((stroke.tool === 'rectangle' || stroke.tool === 'circle')
      && (!stroke.points[1] || stroke.points[0].x === stroke.points[1].x || stroke.points[0].y === stroke.points[1].y)) {
      redraw();
      return;
    }
    commitStroke(stroke);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (e.pointerId !== pointerId.current) return;
    cancelStroke();
  };

  const undo = () => {
    if (busyRef.current || !countRef.current) return;
    countRef.current -= 1;
    setStrokeCount(countRef.current);
    redraw();
  };
  const redo = () => {
    if (busyRef.current || countRef.current >= strokes.current.length) return;
    countRef.current += 1;
    setStrokeCount(countRef.current);
    redraw();
  };
  const clear = () => {
    if (!busyRef.current) commitStroke({ tool: 'clear', size: 0, points: [] });
  };

  // 标记颜色对整层生效（compose-mask 单色）：改色即重绘
  useEffect(() => { if (modeRef.current) redraw(); }, [color, redraw]);

  const hasInk = () => {
    const canvas = canvasEl.current;
    const ctx = ctx2d();
    if (!canvas || !ctx || !canvas.width || !canvas.height) return false;
    try {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
      return false;
    } catch {
      return hasDrawing;
    }
  };

  const layerDataUrl = () => {
    const canvas = canvasEl.current;
    if (!canvas || !canvas.width) return null;
    try { return canvas.toDataURL('image/png'); } catch { return null; }
  };

  const cloneLayer = () => {
    const canvas = canvasEl.current;
    if (!canvas || !canvas.width) return null;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d')?.drawImage(canvas, 0, 0);
    return copy;
  };

  const textStyle = () => {
    const canvas = canvasEl.current;
    const d = textDraftRef.current;
    if (!canvas || !d || !canvas.width) return null;
    const scale = (canvas.clientWidth || canvas.width) / canvas.width;
    return {
      left: canvas.offsetLeft + d.point.x * scale,
      top: canvas.offsetTop + d.point.y * scale,
      width: Math.max(40, (canvas.clientWidth || canvas.width) - d.point.x * scale),
      fontSize: d.size * scale,
      color: colorRef.current,
    };
  };

  const imageRef = useCallback((el: HTMLImageElement | null) => { imgEl.current = el; }, []);
  const canvasRef = useCallback((el: HTMLCanvasElement | null) => {
    canvasEl.current = el;
    if (el) sizeCanvas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const textInputRef = useCallback((el: HTMLTextAreaElement | null) => { textEl.current = el; }, []);

  const setTool = (t: PaintTool) => {
    commitText();
    setToolState(t);
  };
  const setToolSize = (v: number) => {
    if (toolRef.current === 'text') setFontSize(Math.max(FONT_RANGE.min, Math.min(FONT_RANGE.max, v)));
    else setBrushSize(Math.max(BRUSH_RANGE.min, Math.min(BRUSH_RANGE.max, v)));
  };

  return useMemo<PaintEditor>(() => ({
    mode, busy, setBusy, tool, setTool, color, setColor: setColorState, toolSize, setToolSize,
    strokeCount, historyLength, hasDrawing, textDraft,
    // ref 同步更新：输入后立刻回车提交时，commitText 读到的必须是最新文本
    setTextDraftText: (text: string) => {
      const d = textDraftRef.current;
      if (!d) return;
      const next = { ...d, text };
      textDraftRef.current = next;
      setTextDraft(next);
    },
    commitText,
    cancelText: () => { textDraftRef.current = null; setTextDraft(null); },
    start, cancel, undo, redo, clear,
    imageRef, canvasRef, textInputRef,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel },
    hasInk, layerDataUrl, cloneLayer, textStyle,
    // 处理函数只读 ref，按渲染期状态重建对象即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [mode, busy, tool, color, toolSize, strokeCount, historyLength, hasDrawing, textDraft, commitText, start, cancel]);
}
