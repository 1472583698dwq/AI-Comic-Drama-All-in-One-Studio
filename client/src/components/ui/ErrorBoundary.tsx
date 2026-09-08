import React from 'react';

interface Props {
  name: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** 视图级错误边界：渲染崩溃时显示可读错误而不是白屏/卡死，并支持重置。 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      console.error(`[ErrorBoundary:${this.props.name}]`, error, info?.componentStack);
    } catch {}
  }

  render() {
    if (this.state.error) {
      const err: any = this.state.error;
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3 overflow-y-auto">
          <div className="w-12 h-12 rounded-2xl bg-red-500/15 border border-red-500/40 flex items-center justify-center text-xl">⚠️</div>
          <h2 className="text-sm font-bold text-white">{this.props.name}加载失败</h2>
          <pre className="max-w-2xl w-full text-left text-[11px] font-mono text-red-300 bg-black/40 border border-red-500/30 rounded-xl p-3 whitespace-pre-wrap break-all max-h-56 overflow-y-auto custom-scrollbar">
            {String(err?.message || err)}
            {err?.stack ? `\n\n${String(err.stack).split('\n').slice(0, 8).join('\n')}` : ''}
          </pre>
          <p className="text-[11px] text-gray-500">请把上面的红字发给开发者定位。构建：{typeof window !== 'undefined' ? (window as any).__STUDIO_BUILD__ || 'unknown' : ''}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold hover:opacity-90"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
