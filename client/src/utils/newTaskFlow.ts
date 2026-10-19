/**
 * 「新建任务」统一入口（侧栏顶部按钮 + 聊天历史空态按钮共用）。
 *
 * ZCode 式 draft 语义：
 * - 有项目：切到 AI 对话页；换项目走 bindProject（空项目上自建「新会话」草稿，
 *   已有会话且落在「已开始」的旧会话上时，等列表加载完再补开一段新会话），
 *   同项目且当前会话已开始则新开一段，否则复用未开始的草稿（空会话不堆积）。
 * - 无项目：返回 false —— 调用方负责弹「名称 + 风格模板」引导，创建完成后进对话页。
 */
import { useProjectStore } from '../stores/useProjectStore';
import { useChatHistoryStore } from '../stores/useChatHistoryStore';
import { useAgentStore } from '../components/agent/agentStore';

/** 当前会话是否已开始（有用户消息）：空草稿复用、已开始就新开一段 */
function currentSessionStarted(): boolean {
  const a = useAgentStore.getState();
  const cur = a.sessions.find((s) => s.id === a.activeSessionId);
  return (cur?.messages || []).some((m) => m.sender === 'user');
}

export function startNewTaskInProject(): boolean {
  const project = useProjectStore.getState().project;
  if (!project) return false;

  useProjectStore.getState().setActiveTab('agent');
  const agent = useAgentStore.getState();
  if (agent.projectId !== project.id) {
    // 换项目：绑定是异步加载会话列表的。若加载完落在「已开始」的旧会话上，
    // 用户点的毕竟是「新建任务」——再补开一段新会话（空草稿则照旧复用）。
    void Promise.resolve(agent.bindProject(project.id)).then(() => {
      const a = useAgentStore.getState();
      if (a.projectId !== project.id || a.loadingSessions) return;
      if (currentSessionStarted()) a.createSession();
    });
  } else if (currentSessionStarted()) {
    agent.createSession();
  }
  void useChatHistoryStore.getState().refresh();
  return true;
}
