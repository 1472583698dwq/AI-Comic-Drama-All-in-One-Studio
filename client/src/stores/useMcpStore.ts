import { create } from 'zustand';
import { MCPToolDefinition, MCPToolLog } from '../types';
import { apiService } from '../services/api';

interface McpState {
  tools: MCPToolDefinition[];
  logs: MCPToolLog[];
  isToolRunning: boolean;
  selectedToolName: string | null;

  // Actions
  fetchTools: () => Promise<void>;
  toggleTool: (toolName: string) => void;
  invokeTool: (toolName: string, args: Record<string, any>) => Promise<any>;
  setSelectedToolName: (name: string | null) => void;
}

export const useMcpStore = create<McpState>((set, get) => ({
  tools: [],
  logs: [],
  isToolRunning: false,
  selectedToolName: null,

  fetchTools: async () => {
    const tools = await apiService.listMcpTools();
    set({ tools });
  },

  toggleTool: (toolName) => {
    const tools = get().tools.map((t) =>
      t.name === toolName ? { ...t, is_enabled: !t.is_enabled } : t
    );
    set({ tools });
  },

  invokeTool: async (toolName, args) => {
    const logId = 'log-' + Date.now();
    const newLog: MCPToolLog = {
      id: logId,
      tool_name: toolName,
      timestamp: new Date().toLocaleTimeString(),
      status: 'executing',
      arguments: args,
    };

    set({ logs: [newLog, ...get().logs], isToolRunning: true });

    try {
      const response = await apiService.callMcpTool(toolName, args);
      set({
        isToolRunning: false,
        logs: get().logs.map((l) =>
          l.id === logId
            ? {
                ...l,
                status: response.status === 'success' ? 'success' : 'error',
                result: response.result || response.error,
                duration_ms: response.execution_time_ms || 120,
              }
            : l
        ),
      });
      return response;
    } catch (e: any) {
      set({
        isToolRunning: false,
        logs: get().logs.map((l) =>
          l.id === logId ? { ...l, status: 'error', result: e.message } : l
        ),
      });
      throw e;
    }
  },

  setSelectedToolName: (name) => set({ selectedToolName: name }),
}));
