import { useEffect, useRef } from 'react';

/**
 * 弹窗统一 ESC 关闭。
 *
 * - 只在 open=true 时进栈，卸载/关闭自动出栈；
 * - 多层弹窗叠加时只关最上面那个（后进先出），不会一次关穿；
 * - 中文输入法组合输入中（isComposing / keyCode 229）不响应，
 *   避免打拼音按 ESC 取消候选词时把整个弹窗关掉；
 * - 捕获阶段监听，早于组件内部的按键处理。
 */
const stack: Array<() => void> = [];
let bound = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (e.isComposing || e.keyCode === 229) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top();
}

export function useEscapeClose(open: boolean, onClose?: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;

  useEffect(() => {
    if (!open || typeof ref.current !== 'function') return;
    const entry = () => ref.current?.();
    stack.push(entry);
    if (!bound) {
      window.addEventListener('keydown', onKeyDown, true);
      bound = true;
    }
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i !== -1) stack.splice(i, 1);
    };
  }, [open]);
}

export default useEscapeClose;
