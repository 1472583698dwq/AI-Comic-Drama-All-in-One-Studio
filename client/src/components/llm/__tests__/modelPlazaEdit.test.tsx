// 文本模型（模型广场）：默认模型 / 供应商编辑（含高级自定义请求头）/ 设为默认
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getLlmPlaza = vi.fn();
const addLlmSupplier = vi.fn();
const updateLlmSupplier = vi.fn();
const deleteLlmSupplier = vi.fn();
const refreshLlmSupplier = vi.fn();
const setLlmActive = vi.fn();
const setLlmDefault = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
const toastError = vi.fn();

vi.mock('../../../services/api', () => ({
  apiService: {
    getLlmPlaza: (...a: any[]) => (getLlmPlaza as any)(...a),
    addLlmSupplier: (...a: any[]) => (addLlmSupplier as any)(...a),
    updateLlmSupplier: (...a: any[]) => (updateLlmSupplier as any)(...a),
    deleteLlmSupplier: (...a: any[]) => (deleteLlmSupplier as any)(...a),
    refreshLlmSupplier: (...a: any[]) => (refreshLlmSupplier as any)(...a),
    setLlmActive: (...a: any[]) => (setLlmActive as any)(...a),
    setLlmDefault: (...a: any[]) => (setLlmDefault as any)(...a),
  },
}));

vi.mock('../../../stores/useDialogStore', () => ({
  toast: {
    success: (...a: any[]) => (toastSuccess as any)(...a),
    warning: (...a: any[]) => (toastWarning as any)(...a),
    error: (...a: any[]) => (toastError as any)(...a),
    info: vi.fn(),
  },
  confirmAsync: vi.fn(async () => true),
}));

import { ModelPlaza } from '../ModelPlaza';
import { useLlmPlazaStore } from '../plazaStore';

const SUPPLIER = {
  id: 'sup_1',
  name: 'opencode',
  protocol: 'openai' as const,
  base_url: 'https://opencode.ai/zen/go/v1',
  has_key: true,
  api_key_hint: 'sk-••••',
  headers: { 'x-opencode-session': 'session_a' },
  models: [{ id: 'mimo-v2.6-flash' }],
  fetched_at: '',
  error: '连接失败：旧错误',
};

beforeEach(() => {
  useLlmPlazaStore.setState({
    suppliers: [],
    default: { supplier_id: '', model: '' },
    active: { supplier_id: '', model: '' },
    loaded: false,
    loading: false,
    error: '',
  });
  toastSuccess.mockReset();
  toastWarning.mockReset();
  toastError.mockReset();
  getLlmPlaza.mockReset().mockResolvedValue({
    suppliers: [SUPPLIER],
    default: { supplier_id: '', model: '' },
    active: { supplier_id: '', model: '' },
  });
  updateLlmSupplier.mockReset().mockResolvedValue({
    supplier: { ...SUPPLIER, error: '' },
    active: { supplier_id: '', model: '' },
  });
  setLlmDefault.mockReset().mockImplementation(async (sid: string, model: string) => ({
    default: { supplier_id: sid, model },
  }));
});

afterEach(() => cleanup());

describe('ModelPlaza 编辑', () => {
  it('编辑 → 高级自定义请求头可见 → 保存把新 Key 与请求头送到后端', async () => {
    render(<ModelPlaza />);
    expect((await screen.findAllByText('opencode')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    expect(await screen.findByText(/正在编辑「opencode」/)).toBeTruthy();

    // 高级折叠里能看到自定义请求头编辑器（已配请求头时默认展开）
    expect(await screen.findByText('自定义请求头 (Custom Headers)')).toBeTruthy();
    expect(screen.getByDisplayValue('x-opencode-session')).toBeTruthy();

    const keyInput = screen.getByPlaceholderText('API Key（留空不改动）') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-real-key' } });

    fireEvent.click(screen.getByRole('button', { name: /保存修改并重拉模型/ }));

    await waitFor(() => expect(updateLlmSupplier).toHaveBeenCalledTimes(1));
    expect(updateLlmSupplier).toHaveBeenCalledWith('sup_1', {
      name: 'opencode',
      base_url: 'https://opencode.ai/zen/go/v1',
      protocol: 'openai',
      api_key: 'sk-real-key',
      headers: { 'x-opencode-session': 'session_a' },
    });
    await waitFor(() => expect(useLlmPlazaStore.getState().suppliers[0].error).toBe(''));
  });

  it('Key 留空时保存不提交 api_key（后端保留旧 Key）', async () => {
    render(<ModelPlaza />);
    expect((await screen.findAllByText('opencode')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    fireEvent.click(await screen.findByRole('button', { name: /保存修改并重拉模型/ }));

    await waitFor(() => expect(updateLlmSupplier).toHaveBeenCalledTimes(1));
    const body = updateLlmSupplier.mock.calls[0][1];
    expect(body.api_key).toBeUndefined();
  });

  it('保存成功但重拉失败时提示「已保存」，不要误报成保存失败', async () => {
    updateLlmSupplier.mockResolvedValueOnce({
      supplier: { ...SUPPLIER, error: '连接失败：API Key 含非 ASCII 字符' },
      active: { supplier_id: '', model: '' },
    });
    render(<ModelPlaza />);
    expect((await screen.findAllByText('opencode')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    fireEvent.click(await screen.findByRole('button', { name: /保存修改并重拉模型/ }));

    await waitFor(() => expect(toastWarning).toHaveBeenCalled());
    const msg = toastWarning.mock.calls[0][0] as string;
    expect(msg).toContain('已保存修改');
    expect(msg).toContain('拉取模型失败');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('未设默认模型时给出引导；点模型星标即设为默认并显示在顶部', async () => {
    render(<ModelPlaza />);
    expect(await screen.findByText(/未设置 —— 先在下面添加供应商/)).toBeTruthy();

    // 展开供应商 → 点星标设为默认
    fireEvent.click(screen.getByRole('button', { name: /opencode/ }));
    fireEvent.click(await screen.findByRole('button', { name: /mimo-v2.6-flash/ }));

    await waitFor(() => expect(setLlmDefault).toHaveBeenCalledWith('sup_1', 'mimo-v2.6-flash'));
    await waitFor(() => expect(useLlmPlazaStore.getState().default.model).toBe('mimo-v2.6-flash'));
    // 顶部默认模型卡显示「供应商 · 模型」（模型 chip 上也会出现一次）
    expect((await screen.findAllByText('mimo-v2.6-flash')).length).toBeGreaterThan(1);
    expect(screen.queryByText(/未设置 —— 先在下面添加供应商/)).toBeNull();
  });
});
