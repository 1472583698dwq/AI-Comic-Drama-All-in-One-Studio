import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentMessageList } from '../AgentMessageList';
import { ApprovalCard } from '../AgentToolSteps';
import { permissionOfRunMode } from '../agentTypes';
import type { ChatMsg } from '../agentTypes';

function agentMsg(over: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: 'm1',
    sender: 'agent',
    text: '已完成。',
    thinking: '先看分镜再决定运镜。',
    time: '12:00',
    steps: [
      { id: 's1', name: 'generate_video', status: 'completed', args: { prompt: '两人对决' }, elapsedMs: 1200 },
    ],
    ...over,
  } as ChatMsg;
}

const listProps = {
  onSendSuggestion: () => {},
  onExecutePlan: () => {},
  onProposalAction: () => {},
  proposalBusy: {},
  onApplyArtifact: () => {},
};

describe('agent 交互：思维链内工具 + 前台审批卡', () => {
  it('工具调用收进思维链，不再单独挂在消息底部', () => {
    render(<AgentMessageList messages={[agentMsg()]} {...listProps} />);
    const header = screen.getByText(/思维链/);
    expect(header.textContent).toContain('1 次工具调用');
    // 完成态默认折叠：工具行不可见，展开后出现在思维链里
    expect(screen.queryByText('generate_video')).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText('generate_video')).toBeTruthy();
  });

  it('审批卡不在消息列表里（由输入框上方前台渲染）', () => {
    render(<AgentMessageList messages={[agentMsg()]} {...listProps} />);
    expect(screen.queryByText(/等待确认/)).toBeNull();
  });

  it('ApprovalCard 前台卡片：允许一次 / 始终允许 / 拒绝', () => {
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        aid="a1"
        tool="canvas_execute"
        args={{ prompt: 'x' }}
        createdAt={Date.now()}
        autoAllowed={false}
        onApprove={onApprove}
      />,
    );
    expect(screen.getByText(/等待确认/)).toBeTruthy();
    expect(screen.getByText('canvas_execute', { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByText('允许一次'));
    expect(onApprove).toHaveBeenLastCalledWith('a1', true, false);

    fireEvent.click(screen.getByText(/本会话始终允许/));
    fireEvent.click(screen.getByText('允许一次'));
    expect(onApprove).toHaveBeenLastCalledWith('a1', true, true);

    fireEvent.click(screen.getByText('拒绝'));
    expect(onApprove).toHaveBeenLastCalledWith('a1', false, false);
  });

  it('权限 token 归一：create* → create，plan* → 执行维度', () => {
    expect(permissionOfRunMode('create_auto')).toBe('create');
    expect(permissionOfRunMode('create')).toBe('create');
    expect(permissionOfRunMode('plan_auto')).toBe('auto');
    expect(permissionOfRunMode('plan')).toBe('approve');
    expect(permissionOfRunMode('auto')).toBe('auto');
  });
});
