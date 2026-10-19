/**
 * 录制节拍器（REQ clay-record-frames）。
 *
 * 背景：窗口被其他窗口遮挡时，Chromium 会停掉 rAF、并把主线程 setTimeout 节流到 ~1s
 * （实测遮挡窗口 2s 内只跑 3 次 33ms 定时器）。旧的白模录制靠全局 rAF 画布合成出帧：
 * 遮挡时画布不再重绘 → captureStream 只采到 1 帧 → 成片 0.03s。
 *
 * 结论（同环境实测）：Worker 里的 setInterval 不受页面遮挡节流（2s/90 次，正常速率）。
 * 所以录制节拍与等待都放到 Worker 驱动，主线程只负责在收到 tick 时渲染一帧。
 */

/** Worker 版 sleep：页面被遮挡时主线程 setTimeout 会被节流，Worker 不会 */
export const workerSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  try {
    const src = `setTimeout(()=>{postMessage(1); close();}, ${Math.max(0, Math.floor(ms))});`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
    w.onmessage = () => { try { w.terminate(); } catch { /* ignore */ } resolve(); };
    w.onerror = () => { try { w.terminate(); } catch { /* ignore */ } resolve(); };
  } catch {
    setTimeout(resolve, ms);
  }
});

/**
 * 稳定节拍：Worker setInterval 按 intervalMs 触发 onTick（不受遮挡节流）；
 * Worker/Blob 不可用时退化为主线程 setTimeout。返回停止函数。
 */
export const createBeatTicker = (intervalMs: number, onTick: () => void): (() => void) => {
  let stopped = false;
  let worker: Worker | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  try {
    const src = `let t=null;onmessage=(e)=>{if(e.data==='start'){if(t)clearInterval(t);t=setInterval(()=>postMessage('tick'), ${Math.max(8, Math.floor(intervalMs))});}else{if(t){clearInterval(t);t=null;}close();}};`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
    worker.onmessage = () => { if (!stopped) onTick(); };
    worker.postMessage('start');
  } catch {
    const loop = () => { if (stopped) return; onTick(); fallback = setTimeout(loop, intervalMs); };
    fallback = setTimeout(loop, intervalMs);
  }
  return () => {
    stopped = true;
    if (fallback) { clearTimeout(fallback); fallback = null; }
    if (worker) {
      try { worker.postMessage('stop'); } catch { /* ignore */ }
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
    }
  };
};
