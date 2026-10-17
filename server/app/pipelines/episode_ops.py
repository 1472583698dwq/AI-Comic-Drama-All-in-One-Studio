"""
分集管理（项目 → 分集 → 场/镜）—— 操作 storage/projects/<id>/content.json。

设计（加法式，既有链路零破坏）：
- Project.episodes 只存元数据（id/episode_index/title/summary）；
- 场的归属写在 Scene.episode_id（None=未分集）；scene_index 保持全局唯一序号；
- scenes 仍是扁平数组，分镜台/一键成片/导演台/导出全部照旧消费；
- 地面真相是项目 content.json，不引入新存储/索引。
"""
import uuid
import math
from typing import Any, Dict, List, Optional

from app.providers.project.manager import project_manager


def _ep_id() -> str:
    return f"ep_{uuid.uuid4().hex[:8]}"


def _load(project_id: str) -> Dict[str, Any]:
    content = project_manager.get_content(project_id)
    if not isinstance(content, dict):
        raise ValueError(f"项目不存在或暂无内容: {project_id}")
    return content


def _episodes(content: Dict[str, Any]) -> List[Dict[str, Any]]:
    """读取并归一 episodes（补 id/index/title；清理非法项），不写盘。"""
    raw = content.get("episodes")
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for i, e in enumerate(raw):
        if not isinstance(e, dict):
            continue
        ep = dict(e)
        if not ep.get("id"):
            ep["id"] = _ep_id()
        try:
            idx = int(ep.get("episode_index") or 0)
        except Exception:
            idx = 0
        if idx <= 0:
            idx = len(out) + 1
            ep["episode_index"] = idx
        if not ep.get("title"):
            ep["title"] = f"第{idx}集"
        out.append(ep)
    out.sort(key=lambda x: x.get("episode_index") or 0)
    return out


def _scene_list(content: Dict[str, Any]) -> List[Dict[str, Any]]:
    scenes = content.get("scenes")
    if not isinstance(scenes, list):
        return []
    return [s for s in scenes if isinstance(s, dict)]


def _renumber(eps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """删除分集后重排序号；仅当标题是纯默认形式「第N集」时跟随序号更新，自定义标题不动。"""
    for i, e in enumerate(eps):
        e["episode_index"] = i + 1
        t = str(e.get("title") or "")
        if t and t.startswith("第") and t.endswith("集") and t[1:-1].isdigit():
            e["title"] = f"第{i + 1}集"
        elif not t:
            e["title"] = f"第{i + 1}集"
    return eps


def _summary(content: Dict[str, Any], eps: List[Dict[str, Any]]) -> Dict[str, Any]:
    scenes = _scene_list(content)
    stats: Dict[str, Dict[str, int]] = {}
    known = {e["id"] for e in eps}
    unassigned_scenes = 0
    for s in scenes:
        sid = s.get("episode_id") or ""
        if not sid or sid not in known:
            unassigned_scenes += 1
            continue
        d = stats.setdefault(sid, {"scenes": 0, "shots": 0})
        d["scenes"] += 1
        d["shots"] += len(s.get("shots") or [])
    out_eps = []
    for e in eps:
        st = stats.get(e["id"], {"scenes": 0, "shots": 0})
        out_eps.append({**e, "scene_count": st["scenes"], "shot_count": st["shots"]})
    return {
        "episodes": out_eps,
        "scenes_total": len(scenes),
        "shots_total": sum(len(s.get("shots") or []) for s in scenes),
        "unassigned_scenes": unassigned_scenes,
    }


def list_episodes(project_id: str) -> Dict[str, Any]:
    content = _load(project_id)
    return _summary(content, _episodes(content))


def create_episode(project_id: str, title: Optional[str] = None) -> Dict[str, Any]:
    content = _load(project_id)
    eps = _episodes(content)
    idx = max([int(e.get("episode_index") or 0) for e in eps], default=0) + 1
    eps.append({"id": _ep_id(), "episode_index": idx, "title": (title or "").strip() or f"第{idx}集", "summary": ""})
    content["episodes"] = eps
    project_manager.save_content(project_id, content)
    return _summary(content, eps)


def rename_episode(project_id: str, episode_id: str, title: str) -> Dict[str, Any]:
    if not episode_id:
        raise ValueError("episode_id 不能为空")
    if not (title or "").strip():
        raise ValueError("标题不能为空")
    content = _load(project_id)
    eps = _episodes(content)
    hit = None
    for e in eps:
        if e["id"] == episode_id:
            e["title"] = title.strip()
            hit = e
            break
    if not hit:
        raise ValueError(f"分集不存在: {episode_id}")
    content["episodes"] = eps
    project_manager.save_content(project_id, content)
    return _summary(content, eps)


def delete_episode(project_id: str, episode_id: str, move_to: Optional[str] = None) -> Dict[str, Any]:
    """删除分集：其下场默认变为未分集，可 move_to 指定转入另一个分集。"""
    if not episode_id:
        raise ValueError("episode_id 不能为空")
    content = _load(project_id)
    eps = _episodes(content)
    if not any(e["id"] == episode_id for e in eps):
        raise ValueError(f"分集不存在: {episode_id}")
    target: Optional[str] = None
    if move_to:
        if move_to == episode_id:
            raise ValueError("move_to 不能是自身")
        if not any(e["id"] == move_to for e in eps):
            raise ValueError(f"目标分集不存在: {move_to}")
        target = move_to
    moved = 0
    for s in _scene_list(content):
        if s.get("episode_id") == episode_id:
            if target:
                s["episode_id"] = target
                moved += 1
            else:
                s.pop("episode_id", None)
    eps = [e for e in eps if e["id"] != episode_id]
    eps = _renumber(eps)
    content["episodes"] = eps
    project_manager.save_content(project_id, content)
    out = _summary(content, eps)
    out["scenes_moved"] = moved
    return out


def assign_scenes(project_id: str, scene_indices: List[int], episode_id: Optional[str]) -> Dict[str, Any]:
    """按 scene_index 批量为场设置归属；episode_id=None → 移出分集（未分集）。"""
    content = _load(project_id)
    eps = _episodes(content)
    if episode_id and not any(e["id"] == episode_id for e in eps):
        raise ValueError(f"分集不存在: {episode_id}")
    want = set()
    for x in (scene_indices or []):
        try:
            want.add(int(x))
        except Exception:
            continue
    if not want:
        raise ValueError("scene_indices 不能为空")
    changed = 0
    for s in _scene_list(content):
        try:
            si = int(s.get("scene_index") or 0)
        except Exception:
            continue
        if si in want:
            if episode_id:
                s["episode_id"] = episode_id
            else:
                s.pop("episode_id", None)
            changed += 1
    content["episodes"] = eps
    project_manager.save_content(project_id, content)
    out = _summary(content, eps)
    out["assigned_scenes"] = changed
    return out


def split_scenes_into_episodes(scenes: List[Dict[str, Any]], count: int) -> tuple:
    """纯函数：把场按顺序尽量均分为 count 集，返回 (episodes, 原地修改后的数)。

    供 auto_split 与 split_novel_script(episode_count=) 复用。
    """
    if count < 1:
        raise ValueError("分集数至少为 1")
    n = len(scenes)
    if n == 0:
        raise ValueError("项目还没有场（先拆解剧本或新建分镜）")
    if count > n:
        raise ValueError(f"分集数（{count}）不能超过场数（{n}）")
    eps: List[Dict[str, Any]] = [
        {"id": _ep_id(), "episode_index": i + 1, "title": f"第{i + 1}集", "summary": ""}
        for i in range(count)
    ]
    base = n // count
    extra = n % count
    cursor = 0
    for i, e in enumerate(eps):
        size = base + (1 if i < extra else 0)
        for s in scenes[cursor:cursor + size]:
            s["episode_id"] = e["id"]
        cursor += size
    return eps, n


def auto_split(project_id: str, count: int) -> Dict[str, Any]:
    """把全部场按顺序均分为 count 集（会重建分集归属；原分集列表被替换）。"""
    content = _load(project_id)
    scenes = _scene_list(content)
    eps, n = split_scenes_into_episodes(scenes, int(count))
    content["episodes"] = eps
    project_manager.save_content(project_id, content)
    out = _summary(content, eps)
    out["note"] = f"已把 {n} 个场均分为 {len(eps)} 集"
    return out
