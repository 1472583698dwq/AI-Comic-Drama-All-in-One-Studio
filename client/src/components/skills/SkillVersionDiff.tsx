import React, { useEffect, useMemo, useState } from 'react';
import { History, GitCompare } from 'lucide-react';
import { apiService } from '../../services/api';

interface VerInfo { vid: string; mtime: number; size: number; source: string }
type Op = { t: 'eq' | 'add' | 'del'; s: string };

/** 行级 LCS diff（行数上限截断，保证大数据不卡死） */
function lineDiff(a: string, b: string, maxLines = 1200): Op[] {
  let A = a.split('\n');
  let B = b.split('\n');
  if (A.length > maxLines) A = [...A.slice(0, maxLines), `…（旧版余下 ${A.length - maxLines} 行已截断）`];
  if (B.length > maxLines) B = [...B.slice(0, maxLines), `…（现行余下 ${B.length - maxLines} 行已截断）`];
  const n = A.length, m = B.length;
  // 内存封顶：超大时退化为首尾对比
  if (n * m > 4_000_000) {
    return [
      { t: 'del', s: `旧版 ${n} 行（过大，仅展示首 40 行）` },
      ...A.slice(0, 40).map((s): Op => ({ t: 'del', s })),
      { t: 'add', s: `现行 ${m} 行（过大，仅展示首 40 行）` },
      ...B.slice(0, 40).map((s): Op => ({ t: 'add', s })),
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i], nxt = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? nxt[j + 1] + 1 : Math.max(nxt[j], row[j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: 'eq', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', s: A[i] }); i++; }
    else { ops.push({ t: 'add', s: B[j] }); j++; }
  }
  while (i < n) { ops.push({ t: 'del', s: A[i++] }); }
  while (j < m) { ops.push({ t: 'add', s: B[j++] }); }
  return ops;
}

const fmtTime = (ts: number) => {
  try { return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }); }
  catch { return String(ts); }
};

/** Skill 版本历史 + 与现行 diff（导入覆盖/Creator 备份自动留档） */
export const SkillVersionDiff: React.FC<{ skillName: string }> = ({ skillName }) => {
  const [open, setOpen] = useState(false);
  const [vers, setVers] = useState<VerInfo[]>([]);
  const [vid, setVid] = useState('');
  const [oldC, setOldC] = useState('');
  const [curC, setCurC] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setOpen(false); setVers([]); setVid(''); setOldC(''); setCurC(''); setErr('');
  }, [skillName]);

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const r = await apiService.listSkillVersions(skillName);
      const list = r.versions || [];
      setVers(list);
      const firstOld = list.find((v: VerInfo) => v.vid !== 'current');
      if (!firstOld) { setOldC(''); setCurC(''); return; }
      setVid(firstOld.vid);
      const [o, c] = await Promise.all([
        apiService.getSkillVersion(skillName, firstOld.vid),
        apiService.getSkillVersion(skillName, 'current').catch(() => ({ content: '' })),
      ]);
      setOldC(o.content || ''); setCurC((c as any).content || '');
    } catch (e: any) {
      setErr(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const switchVer = async (v: string) => {
    setVid(v); setLoading(true); setErr('');
    try {
      const o = await apiService.getSkillVersion(skillName, v);
      setOldC(o.content || '');
      if (!curC) {
        const c = await apiService.getSkillVersion(skillName, 'current').catch(() => ({ content: '' }));
        setCurC((c as any).content || '');
      }
    } catch (e: any) {
      setErr(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const ops = useMemo(() => (oldC || curC ? lineDiff(oldC, curC) : []), [oldC, curC]);
  const stat = useMemo(() => ({
    add: ops.filter(o => o.t === 'add').length,
    del: ops.filter(o => o.t === 'del').length,
  }), [ops]);
  const snapshots = vers.filter(v => v.vid !== 'current');

  return (
    <div className="bg-surface/80 rounded-xl border border-white/60 dark:border-white/12 overflow-hidden">
      <button
        onClick={() => { if (!open && vers.length === 0) load(); setOpen(!open); }}
        className="w-full px-4 py-2.5 flex items-center gap-1.5 text-xs font-semibold text-violet-300 hover:bg-white/5"
      >
        <History className="w-3.5 h-3.5" />版本历史与 diff
        {snapshots.length > 0 && <span className="text-[10px] px-1.5 py-px rounded bg-violet-500/20 font-mono">{snapshots.length} 个快照</span>}
        <span className="ml-auto text-gray-500 text-[10px]">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2">
          {loading && <div className="text-[11px] text-gray-500">加载中…</div>}
          {err && <div className="text-[11px] text-red-400">{err}</div>}
          {!loading && !err && snapshots.length === 0 && (
            <div className="text-[11px] text-gray-500">暂无历史快照。导入覆盖或 Creator 持久化同名 Skill 时会自动留档。</div>
          )}
          {snapshots.length > 0 && (
            <>
              <select
                value={vid} onChange={(e) => switchVer(e.target.value)}
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-violet-500"
              >
                {snapshots.map(v => (
                  <option key={v.vid} value={v.vid}>{fmtTime(v.mtime)} · {v.source} · {(v.size / 1024).toFixed(1)}KB</option>
                ))}
              </select>
              <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <GitCompare className="w-3.5 h-3.5 text-violet-300" />
                快照 → 现行：<span className="text-emerald-400 font-mono">+{stat.add}</span>
                <span className="text-red-400 font-mono">-{stat.del}</span>
              </div>
              <pre className="text-[11px] font-mono leading-relaxed max-h-64 overflow-y-auto custom-scrollbar rounded-lg border border-white/10 bg-surface/80 p-2 whitespace-pre-wrap break-words">
                {ops.filter(o => o.t !== 'eq').length === 0
                  ? <span className="text-gray-500">与现行完全一致。</span>
                  : ops.filter(o => o.t !== 'eq').slice(0, 400).map((o, i) => (
                    <div key={i} className={o.t === 'add' ? 'bg-emerald-500/10 text-emerald-200' : 'bg-red-500/10 text-red-200'}>
                      {o.t === 'add' ? '+' : '-'}{o.s || ' '}
                    </div>
                  ))}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
};
