import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentMessageList } from '../AgentMessageList';
import { ApprovalCard } from '../AgentToolSteps';
import { permissionOfRunMode, splitThinkTags } from '../agentTypes';
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

describe('agent 交互：Codex 式思考/工具时间线 + 前台审批卡', () => {
  it('思考段独立折叠，工具调用按行内联（不再整组塞进「工具步骤」）', () => {
    render(<AgentMessageList messages={[agentMsg()]} {...listProps} />);
    // 工具行始终在时间线上，不依赖展开某个大折叠块
    expect(screen.getByText('generate_video')).toBeTruthy();
    // 完成态思考默认收起，点开后可回看
    expect(screen.queryByText('先看分镜再决定运镜。')).toBeNull();
    fireEvent.click(screen.getByText('思考'));
    expect(screen.getByText('先看分镜再决定运镜。')).toBeTruthy();
  });

  it('模型正文里的 <think> 标签不外露，思考内容进入思考段', () => {
    render(
      <AgentMessageList
        messages={[agentMsg({ thinking: '', text: '<think>内心推演</think>最终答案' })]}
        {...listProps}
      />,
    );
    expect(screen.queryByText(/<think>/)).toBeNull();
    expect(screen.getByText('最终答案')).toBeTruthy();
    fireEvent.click(screen.getByText('思考'));
    expect(screen.getByText('内心推演')).toBeTruthy();
  });

  it('splitThinkTags：闭合/未闭合都拆干净', () => {
    expect(splitThinkTags('前<think>推演A</think>后<think>推演B')).toEqual({
      clean: '前后',
      thoughts: ['推演A', '推演B'],
    });
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
