"""
Custom Provider Manager - 运行时自定义生成源持久化
存储结构:
  storage/providers/index.json  -> List[ProviderDefinition] 轻索引
  storage/providers/custom/{id}.json -> 单个定义详情
内置 providers(Builtin) 不在此持久化，仅运行时注册
"""
import os
import json
import glob
from typing import Dict, List, Optional, Any
from pathlib import Path

from app.models.provider_definition import ProviderDefinition
from app.core.config import settings


def _get_dirs():
    base = os.path.join(settings.STORAGE_DIR, "providers")
    custom_dir = os.path.join(base, "custom")
    os.makedirs(custom_dir, exist_ok=True)
    index_path = os.path.join(base, "index.json")
    return base, custom_dir, index_path


def _load_index() -> List[Dict[str, Any]]:
    _, _, index_path = _get_dirs()
    if not os.path.exists(index_path):
        return []
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
    except Exception as e:
        print(f"[CustomProviderManager] load index failed: {e}")
    return []


def _save_index(items: List[Dict[str, Any]]):
    _, _, index_path = _get_dirs()
    try:
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[CustomProviderManager] save index failed: {e}")


class CustomProviderManager:
    def list_definitions(self, kind: Optional[str] = None, scope: Optional[str] = None, project_id: Optional[str] = None) -> List[ProviderDefinition]:
        _, custom_dir, _ = _get_dirs()
        defs: List[ProviderDefinition] = []
        # 优先读 index，再校验文件存在
        index = _load_index()
        ids_from_index = set()
        for item in index:
            pid = item.get("id")
            if not pid:
                continue
            ids_from_index.add(pid)
            # 过滤 kind/scope
            if kind and item.get("kind") != kind:
                continue
            if scope and item.get("scope") != scope:
                continue
            if project_id and item.get("project_id") != project_id:
                # global 可见性由调用方决定，这里仅精确过滤
                pass
            # 尝试加载完整定义
            full = self.get_definition(pid)
            if full:
                if kind and full.kind != kind:
                    continue
                defs.append(full)
            else:
                # index 幽灵，跳过
                continue
        # 兜底扫描 custom 目录（防止 index 丢失）
        for fp in glob.glob(os.path.join(custom_dir, "prov_*.json")):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    pd = ProviderDefinition.model_validate(data)
                    if pd.id in ids_from_index:
                        continue
                    if kind and pd.kind != kind:
                        continue
                    defs.append(pd)
            except Exception:
                continue
        return defs

    def get_definition(self, provider_id: str) -> Optional[ProviderDefinition]:
        _, custom_dir, _ = _get_dirs()
        fp = os.path.join(custom_dir, f"{provider_id}.json")
        if not os.path.exists(fp):
            return None
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
                return ProviderDefinition.model_validate(data)
        except Exception as e:
            print(f"[CustomProviderManager] get {provider_id} failed: {e}")
            return None

    def save_definition(self, definition: ProviderDefinition) -> ProviderDefinition:
        _, custom_dir, _ = _get_dirs()
        definition.touch()
        fp = os.path.join(custom_dir, f"{definition.id}.json")
        try:
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(definition.model_dump(), f, ensure_ascii=False, indent=2)
        except Exception as e:
            raise RuntimeError(f"保存 provider 定义失败: {e}")
        # 更新 index
        index = _load_index()
        # 移除旧
        index = [x for x in index if x.get("id") != definition.id]
        index.append(definition.to_provider_info())
        _save_index(index)
        print(f"[CustomProviderManager] Saved {definition.id} ({definition.kind})")
        return definition

    def delete_definition(self, provider_id: str) -> bool:
        _, custom_dir, _ = _get_dirs()
        fp = os.path.join(custom_dir, f"{provider_id}.json")
        existed = os.path.exists(fp)
        if existed:
            try:
                pd = self.get_definition(provider_id)
                if pd and pd.builtin:
                    raise ValueError("内置 Provider 不可删除")
                os.remove(fp)
            except ValueError:
                raise
            except Exception as e:
                raise RuntimeError(f"删除失败: {e}")
        # 更新 index
        index = _load_index()
        new_index = [x for x in index if x.get("id") != provider_id]
        if len(new_index) != len(index) or existed:
            _save_index(new_index)
        return existed

    def create_from_dict(self, data: Dict[str, Any]) -> ProviderDefinition:
        pd = ProviderDefinition.model_validate(data)
        # 确保 id 唯一
        if self.get_definition(pd.id):
            # 自动重命名
            import uuid
            pd.id = f"prov_{uuid.uuid4().hex[:8]}"
        return self.save_definition(pd)

    def get_all_ids(self) -> List[str]:
        return [d.id for d in self.list_definitions()]


custom_provider_manager = CustomProviderManager()
