# -*- coding: utf-8 -*-
"""生成源错误 → 行动建议（单一实现：工具执行口 / 连通测试 / Agent 共用）。

只做文本分类，不解析结构化错误；命中即给"下一步去哪做什么"，避免用户拿着一句
「缺少 Key / 余额不足 / 连接失败」不知道该动哪里。
"""
import re
from typing import Optional

_RULES = [
    (r"balance|insufficient|quota|余额|欠费|额度",
     "上游账户余额/配额问题：去对应平台充值，或在「设置→生成源」改用其他可用源"),
    (r"api[_ \-]?key|unauthor|401|403|invalid token|forbidden|缺少.{0,12}key|key.{0,8}(为空|missing)",
     "鉴权/Key 问题：到「设置→生成源」给该源填 Key（保存后点「测试→实测」验证），不要写死在代码里"),
    (r"127\.0\.0\.1:8188|comfyui|connection refused|econnrefused|无法连接|connect(ion)? (error|failed|timed)",
     "本地服务或地址不通：确认对应服务（如 ComfyUI）已启动、端口与「生成源」里配置一致"),
    (r"timeout|timed out|超时|deadline",
     "上游超时：可重试一次；连续超时检查网络/代理，或换源"),
    (r"审核|moderation|sensitive|安全策略|risk.?control",
     "内容被上游安全审核拦截：调整提示词/素材（尤其避免真人脸），或换源"),
    (r"余额|充值|605",
     "上游返回 605/余额类错误：以平台后台为准，充值后重试或临时切换免费源"),
]


def provider_error_hint(message: str) -> Optional[str]:
    """返回行动建议（无匹配返回 None）。大小写不敏感，取第一条命中。"""
    m = str(message or "").lower()
    if not m:
        return None
    for pat, hint in _RULES:
        try:
            if re.search(pat, m):
                return hint
        except Exception:
            continue
    return None
