import React, { useRef, useEffect } from 'react';

interface AutoTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minRows?: number;
  maxRows?: number;
}

export const AutoTextarea: React.FC<AutoTextareaProps> = ({ minRows=1, maxRows=5, value, onChange, style, className, ...props }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lineHeight = 20; // approx
  useEffect(()=>{
    if (ref.current) {
      const el = ref.current;
      el.style.height = 'auto';
      const maxH = maxRows * lineHeight + 16;
      el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
      el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
    }
  }, [value, maxRows]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      rows={minRows}
      style={{...style, resize: 'none' as const, overflow: 'hidden'}}
      className={className}
      {...props}
    />
  );
};
