import pathlib
p = pathlib.Path('client/src/components/director3d/Director3DStage.tsx')
t = p.read_text(encoding='utf-8', errors='ignore')
# Add stopPropagation to both onKeyDown handlers
t = t.replace(
    "onKeyDown={(e) => { if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleAgentSceneGenerate(); } }}",
    "onKeyDown={(e) => { e.stopPropagation(); if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleAgentSceneGenerate(); } }} onPaste={(e) => e.stopPropagation()} onCopy={(e) => e.stopPropagation()} onCut={(e) => e.stopPropagation()}",
    1
)
t = t.replace(
    "onKeyDown={(e) => { if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleExecuteAiDirective(); } }}",
    "onKeyDown={(e) => { e.stopPropagation(); if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleExecuteAiDirective(); } }} onPaste={(e) => e.stopPropagation()} onCopy={(e) => e.stopPropagation()} onCut={(e) => e.stopPropagation()}",
    1
)
# Add nodrag select-text
t = t.replace('className="flex-1 bg-surface/70', 'className="flex-1 nodrag select-text bg-surface/70', 1)
t = t.replace('className="flex-1 bg-transparent', 'className="flex-1 nodrag select-text bg-transparent', 1)
p.write_text(t, encoding='utf-8')
print('fixed Director3DStage')
