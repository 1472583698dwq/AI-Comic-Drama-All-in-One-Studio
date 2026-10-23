from typing import Any, Dict, List

from pydantic import BaseModel, Field

POLICY_GROUPS = (
    "read",
    "generate",
    "write_project",
    "write_assets",
    "admin",
    "delegate",
    "system",
    "settings",
)
PERMISSION_VALUES = ("allow", "ask", "deny")

DEFAULT_PERMISSIONS: Dict[str, str] = {
    "read": "allow",
    "generate": "allow",
    "write_project": "allow",
    "write_assets": "allow",
    "admin": "ask",
    "delegate": "allow",
    "system": "deny",
    "settings": "ask",
}

DEFAULT_CREATOR_SCOPES: List[str] = ["capability", "canvas", "workspace", "agent"]


class AgentPolicy(BaseModel):
    execution_mode: str = "auto"
    permissions: Dict[str, str] = Field(default_factory=lambda: dict(DEFAULT_PERMISSIONS))
    model: Dict[str, Any] = Field(default_factory=dict)
    creator: Dict[str, Any] = Field(default_factory=lambda: {
        "enabled": True,
        "scopes": list(DEFAULT_CREATOR_SCOPES),
        "require_change_set": True,
    })


def default_policy() -> Dict[str, Any]:
    return AgentPolicy().model_dump()


def normalize_policy(raw: Any) -> Dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    base = default_policy()

    mode = str(data.get("execution_mode") or base["execution_mode"]).strip().lower()
    if mode in ("plan", "planning", "plan_auto", "readonly"):
        mode = "plan"
    elif mode in ("create", "creator", "creation", "creative", "create_auto"):
        mode = "create"
    elif mode in ("auto", "approve", "approval", "standard", "normal", "default", "automation", "automatic"):
        mode = "auto"
    else:
        mode = "auto"
    base["execution_mode"] = mode

    permissions = data.get("permissions") if isinstance(data.get("permissions"), dict) else {}
    merged = dict(DEFAULT_PERMISSIONS)
    for key in POLICY_GROUPS:
        value = str(permissions.get(key, merged[key])).strip().lower()
        merged[key] = value if value in PERMISSION_VALUES else "ask"
    base["permissions"] = merged

    model = data.get("model") if isinstance(data.get("model"), dict) else {}
    base["model"] = dict(model)

    creator = data.get("creator") if isinstance(data.get("creator"), dict) else {}
    scopes = creator.get("scopes")
    if not isinstance(scopes, list):
        scopes = list(DEFAULT_CREATOR_SCOPES)
    scopes = [str(x) for x in scopes if str(x) in DEFAULT_CREATOR_SCOPES]
    base["creator"] = {
        "enabled": bool(creator.get("enabled", True)),
        "scopes": scopes or list(DEFAULT_CREATOR_SCOPES),
        "require_change_set": bool(creator.get("require_change_set", True)),
    }
    return base
