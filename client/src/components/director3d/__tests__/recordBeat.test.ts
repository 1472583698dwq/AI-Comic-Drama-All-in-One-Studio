// 录制节拍器：Worker 不可用（jsdom）时回退 setTimeout，仍能按节拍触发并可停止
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBeatTicker, workerSleep } from '../recordBeat';

describe('recordBeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('workerSleep 在无 Worker 环境回退 setTimeout 并在到点后 resolve', async () => {
    let done = false;
    const p = workerSleep(50).then(() => { done = true; });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(done).toBe(true);
  });

  it('createBeatTicker 按 interval 触发 tick，stop 后不再触发', async () => {
    let ticks = 0;
    const stop = createBeatTicker(10, () => { ticks += 1; });
    await vi.advanceTimersByTimeAsync(55);
    expect(ticks).toBeGreaterThanOrEqual(4);
    stop();
    const frozen = ticks;
    await vi.advanceTimersByTimeAsync(100);
    expect(ticks).toBe(frozen);
  });
});
