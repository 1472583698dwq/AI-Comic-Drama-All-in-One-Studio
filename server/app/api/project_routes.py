import os
import json
import zipfile
import io
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel

from app.models.project_meta import ProjectMetaCreate, ProjectMetaUpdate
from app.providers.project.manager import project_manager

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


@router.put("/projects/{project_id}/content")
async def save_project_content(project_id: str, body: dict):
    # body 为完整 ProjectContent
    try:
        saved = project_manager.save_content(project_id, body)
        return {"status": "saved", "content": saved}
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


@router.get("/projects/{project_id}/agent-sessions")
async def get_project_agent_sessions(project_id: str):
    meta = project_manager.get_meta(project_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    sessions = project_manager.get_agent_sessions(project_id)
    return {"project_id": project_id, "sessions": sessions}


@router.put("/projects/{project_id}/agent-sessions")
async def save_project_agent_sessions(project_id: str, body: dict):
    try:
        sessions = body.get("sessions") if isinstance(body, dict) and "sessions" in body else body
        if not isinstance(sessions, list):
            sessions = []
        saved = project_manager.save_agent_sessions(project_id, sessions)
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
