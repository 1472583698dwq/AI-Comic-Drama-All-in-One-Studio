from typing import Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
import uuid


class ProjectMeta(BaseModel):
    id: str = Field(default_factory=lambda: f"proj_{uuid.uuid4().hex[:8]}")
    title: str
    cover_url: Optional[str] = None
    style_preset: str = "donghua_xianxia"
    aspect_ratio: str = "9:16"
    status: str = "draft"  # draft | producing | done | archived
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    last_opened_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    stats: Dict[str, Any] = Field(default_factory=lambda: {"shots": 0, "duration": 0, "characters": 0})
    source: str = "blank"  # blank | novel | import | canvas
    description: str = ""
    engine: Optional[str] = None

    def touch(self):
        self.updated_at = datetime.now().isoformat()

    def open(self):
        self.last_opened_at = datetime.now().isoformat()
        self.updated_at = self.last_opened_at


class ProjectMetaCreate(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    style_preset: str = "donghua_xianxia"
    aspect_ratio: str = "9:16"
    description: str = ""
    source: str = "blank"
    cover_url: Optional[str] = None


class ProjectMetaUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=80)
    style_preset: Optional[str] = None
    aspect_ratio: Optional[str] = None
    status: Optional[str] = None
    cover_url: Optional[str] = None
    description: Optional[str] = None
