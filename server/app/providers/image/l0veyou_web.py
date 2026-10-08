"""
l0veyou 网页生图通道（GPT Image 2 / 2.5）

为什么不走它的公开 OpenAI 接口：同一个账号，`/v1/images/generations` 对 sk- key 所在分组
返回 403「Image generation is not enabled for this group」，但网页 /chat 能出图。
网页走的是站点自己的一套异步任务接口，这里照着网页前端（DoubaoView）的调用原样实现：

  1. POST {base}/api/v1/images/generate     {prompt, model, aspect_ratio, [num], [images]}
                                             → {code:0, data:{id, status:"pending"}}
  2. GET  {base}/api/v1/images/tasks/{id}   每 3 秒一次，pending → running → completed / failed
                                             completed 时 data.image_urls = [CloudFront 签名链接]
  3. 立刻把图下载到本地 —— 签名链接实测约 2 小时就过期（之后 CloudFront 一律 503）

鉴权用的是网页登录令牌（Bearer access_token），不是 sk- key：
  - access_token 会过期，过期后用 refresh_token 调 POST /api/v1/auth/refresh 续期；
  - **refresh_token 每续一次就轮换成新的**。所以新令牌必须立刻写回配置，否则重启后拿的是作废的旧令牌；
  - 也正因为轮换：本通道和浏览器如果共用同一个登录会话，谁先续期谁就把对方挤下线。
    给漫剧单独登录一个会话（另一个浏览器 / 无痕窗口登录后取那边的令牌）最省心。
"""
import asyncio
import base64
import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.core.config import settings
from app.providers.image.base import ImageProvider, ImageGenerateRequest, ImageGenerateResult

GENERATED_DIR = os.path.join(settings.STORAGE_DIR, "generated")
os.makedirs(GENERATED_DIR, exist_ok=True)

# 网页前端里能选的比例，原样照搬
_RATIOS = ("1:1", "16:9", "9:16", "4:3", "3:4")
# 网页前端的模型清单：2.0 只收 1 张参考图、单次 1 张；2.5 收 4 张参考图、单次最多 2 张
_MODEL_LIMITS: Dict[str, Tuple[int, int]] = {  # model → (最多参考图, 单次最多张数)
    "gpt-image-2": (1, 1),
    "gpt-image-2-5-flare": (4, 2),
    "gpt-image-2-5-full": (4, 2),
}
_MAX_REF_BYTES = 8 * 1024 * 1024        # 网页前端：每张参考图不能超过 8 MiB
_POLL_INTERVAL = 3.0                    # 网页前端：3 秒一次
_REFRESH_LEEWAY = 60                    # 令牌还剩不到 60 秒就提前续


def _nearest_ratio(ar: Optional[str]) -> str:
    """把项目里的任意画幅（含 2.39:1 这类）就近映射到它支持的五档。"""
    s = (ar or "").strip()
    if s in _RATIOS:
        return s
    try:
        w, h = (float(x) for x in s.split(":"))
        target = w / h
    except Exception:
        return "1:1"
    return min(_RATIOS, key=lambda r: abs(float(r.split(":")[0]) / float(r.split(":")[1]) - target))


def _jwt_exp(token: str) -> Optional[int]:
    """令牌若是 JWT 就读出 exp（秒），不是就返回 None。只解码不验签。"""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        return int(exp) if exp else None
    except Exception:
        return None


class L0veyouWebProvider(ImageProvider):
    id = "l0veyou_web"
    display_name = "l0veyou 网页生图（GPT Image 2）"
    description = "l0veyou.com 网页 /chat 的生图通道；用网页登录令牌，自动续期，出图后立刻落盘"
    icon = "Sparkles"

    # 同进程里多个生图请求同时撞上过期时，只能有一个去续期 —— refresh_token 是轮换的，
    # 两个人拿同一个旧 refresh_token 去续，后到的那个必然失败。
    _refresh_lock = asyncio.Lock()

    # ── 配置 ──────────────────────────────────────────────
    def _base(self) -> str:
        return (getattr(settings, "L0VEYOU_BASE_URL", "") or "https://l0veyou.com").rstrip("/")

    def _access(self) -> str:
        return (getattr(settings, "L0VEYOU_ACCESS_TOKEN", "") or "").strip()

    def _refresh(self) -> str:
        return (getattr(settings, "L0VEYOU_REFRESH_TOKEN", "") or "").strip()

    def _model(self, req: ImageGenerateRequest) -> str:
        return (req.model or getattr(settings, "L0VEYOU_IMAGE_MODEL", "") or "gpt-image-2").strip()

    def is_configured(self) -> bool:
        return bool(self._access() or self._refresh())

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await self._authed(c, "GET", "/api/v1/auth/me")
            return r.status_code == 200
        except Exception:
            return False

    def get_capabilities(self) -> Dict[str, Any]:
        cap = super().get_capabilities()
        cap.update({
            "aspect_ratios": list(_RATIOS),
            "models": list(_MODEL_LIMITS),
            "supports_reference_images": True,
            "max_reference_images": 4,
        })
        return cap

    # ── 鉴权：带令牌请求，401 时续期重试一次 ──────────────────────
    async def _do_refresh(self, c: httpx.AsyncClient, stale_access: str) -> None:
        async with self._refresh_lock:
            # 等锁期间别人可能已经续过了：令牌变了就直接用新的
            if self._access() and self._access() != stale_access:
                return
            rt = self._refresh()
            if not rt:
                raise RuntimeError("l0veyou 登录令牌已过期，且没有配 refresh_token，无法自动续期。请重新登录后更新令牌")
            r = await c.post(f"{self._base()}/api/v1/auth/refresh", json={"refresh_token": rt},
                             headers={"Content-Type": "application/json"})
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            data = (body or {}).get("data") or {}
            if r.status_code != 200 or body.get("code") != 0 or not data.get("access_token"):
                raise RuntimeError(
                    f"l0veyou 令牌续期失败（HTTP {r.status_code}：{(body or {}).get('message') or r.text[:120]}）。"
                    "常见原因：浏览器里同一个会话先续了期，这边的 refresh_token 已被轮换作废。请重新取一次令牌"
                )
            # 轮换后的新令牌必须立刻落盘，否则下次重启拿的是作废的旧 refresh_token
            from app.core.config import write_env_file
            write_env_file({
                "L0VEYOU_ACCESS_TOKEN": data["access_token"],
                "L0VEYOU_REFRESH_TOKEN": data.get("refresh_token") or rt,
            })

    async def _authed(self, c: httpx.AsyncClient, method: str, path: str, **kw) -> httpx.Response:
        tok = self._access()
        exp = _jwt_exp(tok) if tok else None
        if (not tok) or (exp and exp - time.time() < _REFRESH_LEEWAY):
            await self._do_refresh(c, tok)
            tok = self._access()
        r = await c.request(method, f"{self._base()}{path}",
                            headers={"Authorization": f"Bearer {tok}", **kw.pop("headers", {})}, **kw)
        if r.status_code == 401 and self._refresh():
            await self._do_refresh(c, tok)
            r = await c.request(method, f"{self._base()}{path}",
                                headers={"Authorization": f"Bearer {self._access()}"}, **kw)
        return r

    @staticmethod
    def _unwrap(r: httpx.Response, what: str) -> Dict[str, Any]:
        try:
            body = r.json()
        except Exception:
            raise RuntimeError(f"l0veyou {what}失败：HTTP {r.status_code}，响应不是 JSON：{r.text[:160]}")
        if r.status_code != 200 or body.get("code") != 0:
            raise RuntimeError(f"l0veyou {what}失败：HTTP {r.status_code}，{body.get('message') or body}")
        return body.get("data") or {}

    # ── 生图 ──────────────────────────────────────────────
    def _refs(self, req: ImageGenerateRequest, model: str) -> List[str]:
        raw = list(req.reference_images or [])
        dyn = req.dynamic_inputs or {}
        if not raw and dyn.get("reference_images"):
            raw = list(dyn["reference_images"])
        if not raw:
            return []
        max_refs = _MODEL_LIMITS.get(model, (1, 1))[0]
        if len(raw) > max_refs:
            raise ValueError(f"{model} 最多支持 {max_refs} 张参考图，当前 {len(raw)} 张"
                             + ("（多张参考图请改用 gpt-image-2-5-flare / full）" if max_refs == 1 else ""))
        # 网页前端传的就是 data URL；本地 /storage/... 和 http 链接都统一内联成 data URI
        from app.providers.media_refs import resolve_media_refs
        kept, dropped = resolve_media_refs(raw, kind="image")
        if dropped:
            raise ValueError("参考图无法使用：" + "；".join(f"{d['ref']}（{d['reason']}）" for d in dropped))
        out: List[str] = []
        for ref in kept:
            if ref.startswith("http"):
                out.append(ref)
                continue
            approx = len(ref.split(",", 1)[-1]) * 3 // 4
            if approx > _MAX_REF_BYTES:
                raise ValueError(f"参考图约 {approx // 1024 // 1024}MB，超过 l0veyou 的 8 MiB 上限")
            out.append(ref)
        return out

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not self.is_configured():
            raise RuntimeError("l0veyou 未配置：请在 设置 → 能力配置 → 生图 → l0veyou 里填登录令牌")
        prompt = (req.prompt or "").strip()
        if not prompt:
            raise ValueError("提示词不能为空")

        model = self._model(req)
        ratio = _nearest_ratio(req.aspect_ratio)
        payload: Dict[str, Any] = {"prompt": prompt, "model": model, "aspect_ratio": ratio}
        num = int(((req.extra or {}).get("num") or 1))
        if num > 1:
            payload["num"] = min(num, _MODEL_LIMITS.get(model, (1, 1))[1])
        refs = self._refs(req, model)
        if refs:
            payload["images"] = refs

        started = time.time()
        timeout = float(getattr(settings, "L0VEYOU_TIMEOUT", 180) or 180)
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=15.0)) as c:
            task = self._unwrap(await self._authed(c, "POST", "/api/v1/images/generate", json=payload), "提交生图任务")
            task_id = task.get("id")
            if not task_id:
                raise RuntimeError(f"l0veyou 没返回任务 id：{task}")

            deadline = started + timeout
            while True:
                await asyncio.sleep(_POLL_INTERVAL)
                t = self._unwrap(await self._authed(c, "GET", f"/api/v1/images/tasks/{task_id}"), "查询任务")
                st = t.get("status")
                if st == "completed":
                    urls = t.get("image_urls") or []
                    break
                if st == "failed":
                    raise RuntimeError(f"l0veyou 生图失败：{t.get('error') or '未返回原因'}（任务 {task_id}）")
                if time.time() > deadline:
                    raise TimeoutError(f"l0veyou 生图超时（{int(timeout)}s 仍为 {st}，任务 {task_id}）")

            if not urls:
                raise RuntimeError(f"l0veyou 任务已完成但没有返回图片（任务 {task_id}）")

            # 签名链接约 2 小时过期，必须马上下载；只取第一张作为本次结果，其余记进 raw
            img = await c.get(urls[0], timeout=60.0)
            if img.status_code != 200 or not img.content:
                raise RuntimeError(f"l0veyou 出图了但下载失败：HTTP {img.status_code}（签名链接可能已过期）")

        ctype = img.headers.get("content-type", "")
        ext = ".png" if "png" in ctype else ".webp" if "webp" in ctype else ".jpg"
        filename = f"l0veyou_{uuid.uuid4().hex[:10]}{ext}"
        filepath = os.path.join(GENERATED_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(img.content)

        width = height = 0
        try:
            from io import BytesIO
            from PIL import Image
            width, height = Image.open(BytesIO(img.content)).size
        except Exception:
            pass

        return ImageGenerateResult(
            image_url=f"/storage/generated/{filename}",
            local_path=filepath,
            provider=self.id,
            seed=-1,
            width=width,
            height=height,
            elapsed_ms=int((time.time() - started) * 1000),
            engine=f"l0veyou/{model}",
            prompt_id=task_id,
            # 不把签名链接存下来：几小时后就是死链，还带着签名
            raw={"task_id": task_id, "model": model, "aspect_ratio": ratio, "image_count": len(urls)},
        )
