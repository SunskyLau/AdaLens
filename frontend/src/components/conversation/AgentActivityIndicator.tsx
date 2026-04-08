export default function AgentActivityIndicator({ label }: { label?: string }) {
  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2"
    >
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-pulse" />
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-pulse [animation-delay:0.2s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-pulse [animation-delay:0.4s]" />
      </div>
      <span className="text-xs text-slate-500">{label ?? 'Agent is thinking...'}</span>
    </div>
  );
}
