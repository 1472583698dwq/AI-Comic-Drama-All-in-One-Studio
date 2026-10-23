import os
import json
import re
import zipfile
import io
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, HTTPException, UploadFile, File, Form, Query, Request
from pydantic import BaseModel

from app.models.agent_policy import AgentPolicy, normalize_policy
from app.models.project_meta import ProjectMetaCreate, ProjectMetaUpdate
from app.providers.project.manager import project_manager, ProjectRevConflict

router = APIRouter()


@router.get("/projects")
async def list_projects(
    q: Optional[str] = Query(None, description="关键词搜索标题/描述"),
    status: Optional[str] = Query(None, description="draft|producing|done|archived|all"),
    sort: str = Query("updated_at", description="updated_at|created_at|last_opened_at|name"),
):
    items = project_manager.list_projects(q=q, status=status, sort=sort)
    return {"projects": items, "total": len(items)}


@router.post("/projects")
async def create_project(req: ProjectMetaCreate):
    if not req.title or not req.title.strip():
        raise HTTPException(status_code=400, detail="项目标题不能为空")
    meta = project_manager.create_project(
        title=req.title.strip(),
        style_preset=req.style_preset,
        aspect_ratio=req.aspect_ratio,
        description=req.description or "",
        source=req.source or "blank",
        cover_url=req.cover_url,
    )
    return meta


class ImportProjectRequest(BaseModel):
    title: Optional[str] = None
    style_preset: Optional[str] = None
    aspect_ratio: Optional[str] = None


@router.post("/projects/import")
async def import_project(
    file: Optional[UploadFile] = File(None),
    novel_text: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
    style_preset: Optional[str] = Form("donghua_xianxia"),
    aspect_ratio: Optional[str] = Form("9:16"),
):
    """
    导入项目：支持
    - 上传 .json (ProjectContent)
    - 上传 .zip (含 content.json / canvas.json)
    - 或直接传 novel_text 由后端拆解后创建项目（可选）
    """
    # 情况1: 上传文件
    if file and file.filename:
        content_bytes = await file.read()
        if not content_bytes:
            raise HTTPException(status_code=400, detail="上传文件为空")
        fname = file.filename.lower()
        try:
            if fname.endswith(".json"):
                data = json.loads(content_bytes.decode("utf-8"))
                proj_title = title or data.get("title") or "导入项目"
                meta = project_manager.create_project(
                    title=proj_title,
                    style_preset=style_preset or data.get("style_preset") or "donghua_xianxia",
                    aspect_ratio=aspect_ratio or data.get("aspect_ratio") or "9:16",
                    source="import",
                    initial_content=data,
                )
                return {"project": meta, "content": data}
            elif fname.endswith(".zip"):
                # 解压
                with zipfile.ZipFile(io.BytesIO(content_bytes)) as zf:
                    names = zf.namelist()
                    # 寻找 content.json
                    content_data = None
                    canvas_data = None
                    for n in names:
                        if n.endswith("content.json"):
                            content_data = json.loads(zf.read(n).decode("utf-8"))
                        elif n.endswith("canvas.json"):
                            canvas_data = json.loads(zf.read(n).decode("utf-8"))
                    if not content_data and not canvas_data:
                        # 尝试直接读取第一个 json
                        for n in names:
                            if n.endswith(".json"):
                                content_data = json.loads(zf.read(n).decode("utf-8"))
                                break
                    if not content_data and not canvas_data:
                        raise HTTPException(status_code=400, detail="zip 包内未找到 content.json/canvas.json")
                    proj_title = title or (content_data or {}).get("title") or "导入项目"
                    meta = project_manager.create_project(
                        title=proj_title,
                        style_preset=style_preset or (content_data or {}).get("style_preset") or "donghua_xianxia",
                        aspect_ratio=aspect_ratio or (content_data or {}).get("aspect_ratio") or "9:16",
                        source="import",
                        initial_content=content_data,
                    )
                    if canvas_data:
                        project_manager.save_canvas(meta["id"], canvas_data)
                    return {"project": meta, "content": content_data, "canvas": canvas_data}
            else:
                raise HTTPException(status_code=400, detail="仅支持 .json 或 .zip 导入")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"导入解析失败: {e}")

    # 情况2: 仅 novel_text 创建（前端可先走 parse-script 再保存）
    if novel_text and novel_text.strip():
        # 仅创建空项目，前端可再调用 parse-script 并 PUT content
        meta = project_manager.create_project(
            title=title or novel_text.strip()[:20] or "小说项目",
            style_preset=style_preset or "donghua_xianxia",
            aspect_ratio=aspect_ratio or "9:16",
            description=novel_text.strip()[:200],
            source="novel",
        )
        return {"project": meta, "novel_text": novel_text.strip()}

    raise HTTPException(status_code=400, detail="请上传 .json/.zip 文件或提供 novel_text")


@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    combined = project_manager.get_combined(project_id)
    if not combined:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return combined


@router.get("/projects/{project_id}/agent-policy")
async def get_project_agent_policy(project_id: str):
    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return normalize_policy(meta.get("agent_policy"))


@router.put("/projects/{project_id}/agent-policy")
async def update_project_agent_policy(project_id: str, policy: AgentPolicy):
    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    normalized = normalize_policy(policy.model_dump())
    updated = project_manager.update_meta(project_id, {"agent_policy": normalized})
    if not updated:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return normalize_policy(updated.get("agent_policy"))


@router.put("/projects/{project_id}")
async def update_project_meta(project_id: str, req: ProjectMetaUpdate):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="无可更新字段")
    # 标题校验
    if "title" in updates and not updates["title"].strip():
        raise HTTPException(status_code=400, detail="标题不能为空")
    meta = project_manager.update_meta(project_id, updates)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return meta


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    ok = project_manager.delete_project(project_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return {"status": "deleted", "id": project_id}


@router.post("/projects/{project_id}/duplicate")
async def duplicate_project(project_id: str):
    new_meta = project_manager.duplicate_project(project_id)
    if not new_meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return new_meta


@router.post("/projects/{project_id}/open")
async def open_project(project_id: str):
    meta = project_manager.open_project(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return meta


@router.get("/projects/{project_id}/export")
async def export_project(project_id: str):
    from fastapi.responses import StreamingResponse

    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    content = project_manager.get_content(project_id)
    canvas = project_manager.get_canvas(project_id)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=2))
        if content:
            zf.writestr("content.json", json.dumps(content, ensure_ascii=False, indent=2))
        if canvas:
            zf.writestr("canvas.json", json.dumps(canvas, ensure_ascii=False, indent=2))
        # 资产清单（可选）
        zf.writestr("README.txt", f"项目 {meta.get('title')} 导出包\n含 meta/content/canvas\n")

    buf.seek(0)
    headers = {"Content-Disposition": f'attachment; filename="{project_id}.zip"'}
    return StreamingResponse(buf, media_type="application/zip", headers=headers)


# ---- Content (分镜内容) ----
@router.get("/projects/{project_id}/content")
async def get_project_content(project_id: str):
    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    content = project_manager.get_content(project_id)
    return {"meta": meta, "content": content}


def _expected_rev(request: Optional[Request], body: Dict[str, Any]) -> Optional[int]:
    """从 If-Match 头或 body._rev 读取客户端持有的版本号（缺省 = 旧客户端，不做乐观锁）。"""
    raw: Any = None
    if request is not None:
        raw = request.headers.get("if-match")
    if raw is None and isinstance(body, dict):
        raw = body.get("_rev")
    if raw is None or raw == "":
        return None
    try:
        return int(str(raw).strip().strip('"'))
    except Exception:
        return None


@router.put("/projects/{project_id}/content")
async def save_project_content(project_id: str, body: dict, request: Request):
    # body 为完整 ProjectContent；带 _rev/If-Match 时做乐观锁，旧快照返回 409
    try:
        saved = project_manager.save_content(project_id, body, expected_rev=_expected_rev(request, body))
        return {"status": "saved", "content": saved, "rev": saved.get("_rev")}
    except ProjectRevConflict as e:
        raise HTTPException(status_code=409, detail={"code": "rev_conflict", "current_rev": e.current_rev})
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存失败: {e}")


@router.patch("/projects/{project_id}/shots/{shot_id}")
async def patch_project_shot(project_id: str, shot_id: str, body: dict, request: Request):
    """字段级合并单个分镜（只发差异字段），避免整份 PUT 把服务端舞台/新分镜覆盖回旧值。"""
    try:
        updates = dict(body or {})
        saved = project_manager.patch_shot(
            project_id, shot_id, updates, expected_rev=_expected_rev(request, updates),
        )
        return saved
    except ProjectRevConflict as e:
        raise HTTPException(status_code=409, detail={"code": "rev_conflict", "current_rev": e.current_rev})
    except KeyError:
        raise HTTPException(status_code=404, detail=f"分镜不存在: {shot_id}")
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存失败: {e}")


# ---- Canvas ----
@router.get("/projects/{project_id}/canvas")
async def get_project_canvas(project_id: str, canvas_id: Optional[str] = None):
    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    canvas = project_manager.get_canvas(project_id, canvas_id=canvas_id)
    return {"project_id": project_id, "canvas": canvas}


@router.put("/projects/{project_id}/canvas")
async def save_project_canvas(project_id: str, body: dict):
    try:
        # body 可为 {snapshot: {...}} 或直接 snapshot；支持 canvas_id/name 多画布
        snapshot = body.get("snapshot") if "snapshot" in body else body
        if snapshot is None:
            snapshot = body
        canvas_id = body.get("canvas_id") or (snapshot.get("canvas_id") if isinstance(snapshot, dict) else None) or "default"
        name = body.get("name") or (snapshot.get("name") if isinstance(snapshot, dict) else None)
        saved = project_manager.save_canvas(project_id, snapshot, canvas_id=canvas_id, name=name)
        return {"status": "saved", "canvas": saved}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存失败: {e}")


@router.get("/projects/{project_id}/canvases")
async def list_project_canvases(project_id: str):
    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return {"project_id": project_id, "canvases": project_manager.list_canvases(project_id)}


@router.put("/projects/{project_id}/canvases/{canvas_id}")
async def rename_project_canvas(project_id: str, canvas_id: str, body: dict):
    try:
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="名称不能为空")
        return project_manager.rename_canvas(project_id, canvas_id, name)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=404 if isinstance(e, FileNotFoundError) else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"重命名失败: {e}")


@router.delete("/projects/{project_id}/canvases/{canvas_id}")
async def delete_project_canvas(project_id: str, canvas_id: str):
    try:
        return project_manager.delete_canvas(project_id, canvas_id)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=404 if isinstance(e, FileNotFoundError) else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除失败: {e}")


# ── REQ-toonflow-canvas 画布备份：旧画布自动迁移后、第一次保存前，先把原 JSON 留一份 ──
_CANVAS_BACKUP_KEEP = 20  # 每个画布最多保留的备份份数（只在迁移时触发，超出删最旧的兜底防膨胀）


def _read_stored_canvas_raw(pid: str, canvas_id: str) -> Optional[Dict[str, Any]]:
    """读 canvas.json 里该画布的**原始条目**（不经 get_canvas 裁剪，保留 updated_at 等全部字段）。"""
    from app.providers.project import manager as pm

    p = pm._canvas_path(pid)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"画布文件损坏，无法备份: {e}")
    if not isinstance(data, dict):
        return None
    canvases = data.get("canvases")
    if isinstance(canvases, dict):
        entry = canvases.get(canvas_id)
        return {"canvas_id": canvas_id, **entry} if isinstance(entry, dict) else None
    # 存量单画布文件：只有 default 一张，整份原样备份
    if canvas_id == "default" and isinstance(data.get("nodes"), list):
        return dict(data)
    return None


@router.post("/projects/{project_id}/canvases/{canvas_id}/backup")
async def backup_project_canvas(project_id: str, canvas_id: str, body: Optional[Dict[str, Any]] = Body(None)):
    """备份画布 JSON 到 storage/projects/{pid}/canvas_backups/{cid}-{yyyyMMdd-HHmmss}.json。

    - 不带 body（或 body 无 canvas）：备份当前已存的画布条目；画布不存在 → 404；
    - body = {canvas: {...}}：备份前端给的原始 JSON（迁移前的 raw 画布，比已存条目更全）。
    """
    from app.core.config import settings
    from app.providers.project import manager as pm

    pid = pm._resolve_id(project_id)
    if not project_manager.get_meta(pid):
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    payload = body.get("canvas") if isinstance(body, dict) else None
    if payload is not None and not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="canvas 必须是 JSON 对象")
    source = "payload"
    if payload is None:
        payload = _read_stored_canvas_raw(pid, canvas_id)
        source = "stored"
        if payload is None:
            raise HTTPException(status_code=404, detail=f"画布不存在: {canvas_id}")

    backup_dir = os.path.join(pm.PROJECTS_ROOT, pid, "canvas_backups")
    os.makedirs(backup_dir, exist_ok=True)
    # 画布 id 来自 URL：只留安全字符做文件名（cv_xxx / default 原样不变），杜绝 .. 之类穿越
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", canvas_id).strip("_")[:80] or "canvas"
    now = datetime.now()
    stamp = now.strftime("%Y%m%d-%H%M%S")
    target = None
    for i in range(100):  # 同一秒重复备份：-1、-2… 避让，O_EXCL 真占位防并发撞名
        name = f"{stem}-{stamp}{'' if i == 0 else f'-{i}'}.json"
        cand = os.path.join(backup_dir, name)
        try:
            fd = os.open(cand, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        target = cand
        break
    if not target:
        raise HTTPException(status_code=429, detail="同一秒内备份过多，请稍后重试")

    pattern = re.compile(rf"^{re.escape(stem)}-\d{{8}}-\d{{6}}(-\d+)?\.json$")
    olds = sorted(
        (os.path.join(backup_dir, n) for n in os.listdir(backup_dir) if pattern.match(n)),
        key=lambda x: (os.path.getmtime(x), x),
    )
    for stale in olds[:-_CANVAS_BACKUP_KEEP]:
        if stale != target:
            try:
                os.remove(stale)
            except OSError:
                pass

    storage_root = os.path.realpath(settings.STORAGE_DIR)
    real = os.path.realpath(target)
    inside = real.startswith(storage_root + os.sep)
    rel = os.path.relpath(real, storage_root).replace(os.sep, "/") if inside else real
    return {
        "status": "success",
        "path": rel,
        "url": f"/storage/{rel}" if inside else None,
        "file": os.path.basename(target),
        "canvas_id": canvas_id,
        "source": source,
        "created_at": now.isoformat(timespec="seconds"),
    }


@router.get("/projects/{project_id}/agent-sessions")
async def get_project_agent_sessions(project_id: str, scope: str = "all"):
    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    sessions = project_manager.get_agent_sessions(project_id, scope=scope)
    return {"project_id": project_id, "sessions": sessions, "scope": scope}


@router.put("/projects/{project_id}/agent-sessions")
async def save_project_agent_sessions(project_id: str, body: dict, scope: str = ""):
    try:
        sessions = body.get("sessions") if isinstance(body, dict) and "sessions" in body else body
        if not isinstance(sessions, list):
            sessions = []
        saved = project_manager.save_agent_sessions(project_id, sessions, scope=(scope or "").strip() or None)
        return {"status": "saved", "project_id": project_id, "sessions": saved}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存会话失败: {e}")


@router.delete("/projects/{project_id}/agent-sessions/{session_id}")
async def delete_project_agent_session(project_id: str, session_id: str):
    try:
        return project_manager.delete_agent_session(project_id, session_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除会话失败: {e}")
