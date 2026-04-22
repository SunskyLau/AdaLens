import { useEffect, useMemo, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import clsx from 'clsx';
import { fetchArtifact, getArtifactUrl } from '@/api/client';
import type { ExecutionRecord, PlanItem, PlanLiveState, PlanLogEntry } from '@/types';

interface PlanInspectorProps {
  runId: string;
  plan: PlanItem | undefined;
  execution: ExecutionRecord | undefined;
  planLogs?: PlanLiveState;
  planStreamBlockContainerClassName: string;
}

type StreamBlockType = 'text' | 'code' | 'error' | 'image';

interface StreamBlock {
  type: StreamBlockType;
  label?: string;
  content: string;
  path?: string;
}

export default function PlanInspector({
  runId,
  plan,
  execution,
  planLogs,
  planStreamBlockContainerClassName,
}: PlanInspectorProps) {
  if (!plan) return null;

  const isRunning = plan.status === 'analyzing' || plan.status === 'summarizing';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-slate-100 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-medium capitalize text-slate-800">{plan.kind}</h3>
          <span
            className={clsx(
              'flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium capitalize',
              getPlanStatusColor(plan.status)
            )}
          >
            {isRunning ? <Radio className="h-3 w-3 animate-pulse" /> : null}
            {plan.status}
          </span>
        </div>

        <p className="mb-3 text-sm text-slate-700">{plan.text}</p>
      </div>

      <PlanStreamPanel
        runId={runId}
        planLogs={planLogs}
        execution={execution}
        isRunning={isRunning}
        planStreamBlockContainerClassName={planStreamBlockContainerClassName}
      />
    </div>
  );
}

function getPlanStatusColor(status: string) {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'analyzing':
      return 'bg-blue-100 text-blue-700';
    case 'summarizing':
      return 'bg-violet-100 text-violet-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    case 'paused':
      return 'bg-amber-100 text-amber-700';
    case 'terminated':
      return 'bg-slate-200 text-slate-700';
    case 'pending':
      return 'bg-slate-100 text-slate-600';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function PlanStreamPanel({
  runId,
  planLogs,
  execution,
  isRunning,
  planStreamBlockContainerClassName,
}: {
  runId: string;
  planLogs?: PlanLiveState;
  execution?: ExecutionRecord;
  isRunning: boolean;
  planStreamBlockContainerClassName: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasLogs = !!planLogs && planLogs.logs.length > 0;
  const fallbackSourceKey = execution
    ? [
      execution.code_path || '',
      execution.stdout_path || '',
      execution.stderr_path || '',
      execution.created_at || '',
    ].join('|')
    : '';
  const [fallbackCode, setFallbackCode] = useState('');
  const [fallbackStdout, setFallbackStdout] = useState('');
  const [fallbackStderr, setFallbackStderr] = useState('');
  const [fallbackLoaded, setFallbackLoaded] = useState(false);

  useEffect(() => {
    setFallbackCode('');
    setFallbackStdout('');
    setFallbackStderr('');
    setFallbackLoaded(false);
  }, [fallbackSourceKey]);

  useEffect(() => {
    if (!execution || !runId || fallbackLoaded) {
      return;
    }

    let active = true;
    const loadFallback = async () => {
      if (execution.code_path) {
        try {
          const data = await fetchArtifact(runId, execution.code_path);
          if (active) setFallbackCode(data);
        } catch {
          if (active) setFallbackCode('');
        }
      }
      if (execution.stdout_content) {
        if (active) setFallbackStdout(execution.stdout_content);
      } else if (execution.stdout_path) {
        try {
          const data = await fetchArtifact(runId, execution.stdout_path);
          if (active) setFallbackStdout(data);
        } catch {
          if (active) setFallbackStdout('');
        }
      }
      if (execution.stderr_content) {
        if (active) setFallbackStderr(execution.stderr_content);
      } else if (execution.stderr_path) {
        try {
          const data = await fetchArtifact(runId, execution.stderr_path);
          if (active) setFallbackStderr(data);
        } catch {
          if (active) setFallbackStderr('');
        }
      }
      if (active) setFallbackLoaded(true);
    };
    void loadFallback();

    return () => {
      active = false;
    };
  }, [execution, fallbackLoaded, runId]);

  const blocks = useMemo(() => {
    let baseBlocks: StreamBlock[] = [];
    if (hasLogs && planLogs) {
      baseBlocks = buildBlocksFromLogs(planLogs.logs);
      baseBlocks = mergeFullStdoutIntoBlocks(baseBlocks, fallbackStdout);
    } else {
      if (fallbackCode) {
        baseBlocks.push({ type: 'code', label: 'Code', content: fallbackCode });
      }
      if (fallbackStdout) {
        baseBlocks.push({ type: 'code', label: 'Output', content: fallbackStdout });
      }
      if (fallbackStderr) {
        baseBlocks.push({ type: 'error', label: 'Error', content: fallbackStderr });
      }
      if (execution?.error_message && !fallbackStderr) {
        baseBlocks.push({ type: 'error', label: 'Error', content: execution.error_message });
      }
    }
    return insertPlotBlocksAfterOutput(baseBlocks, execution?.plot_paths || []);
  }, [execution, fallbackCode, fallbackStderr, fallbackStdout, hasLogs, planLogs]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [blocks.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          {isRunning ? <Radio className="h-3 w-3 animate-pulse text-red-500" /> : null}
          Analysis Stream
        </h4>
      </div>

      <div ref={scrollRef} className={planStreamBlockContainerClassName}>
        {blocks.length === 0 ? (
          <div className="text-xs text-slate-400">No analysis output yet.</div>
        ) : (
          blocks.map((block, index) => (
            <StreamBlockView key={`${block.type}-${block.path ?? index}`} runId={runId} block={block} />
          ))
        )}
      </div>
    </div>
  );
}

function StreamBlockView({ runId, block }: { runId: string; block: StreamBlock }) {
  const [zoomOpen, setZoomOpen] = useState(false);
  if (block.type === 'image') {
    if (!block.path) return null;
    return (
      <div>
        {block.label ? <div className="mb-1 text-xs text-slate-500">{block.label}</div> : null}
        <button type="button" onClick={() => setZoomOpen(true)} className="block w-full" title="Click to zoom">
          <img
            src={getArtifactUrl(runId, block.path)}
            alt={block.label || 'Plot'}
            className="w-full rounded-md border border-slate-100"
          />
        </button>
        <div className="mt-1 text-[11px] text-slate-400">{block.path}</div>
        {zoomOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
            onClick={() => setZoomOpen(false)}
          >
            <div className="max-h-[92vh] max-w-[96vw]" onClick={(event) => event.stopPropagation()}>
              <img
                src={getArtifactUrl(runId, block.path)}
                alt={`${block.label || 'Plot'} zoomed`}
                className="max-h-[92vh] max-w-[96vw] rounded-lg bg-white shadow-2xl"
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (block.type === 'text') {
    return (
      <div>
        {block.label ? <div className="mb-1 text-xs text-slate-500">{block.label}</div> : null}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{block.content}</div>
      </div>
    );
  }

  if (block.type === 'error') {
    return (
      <div>
        {block.label ? <div className="mb-1 text-xs text-red-600">{block.label}</div> : null}
        <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {block.content}
        </pre>
      </div>
    );
  }

  return (
    <div>
      {block.label ? <div className="mb-1 text-xs text-slate-500">{block.label}</div> : null}
      <pre className="overflow-x-auto overflow-y-auto whitespace-pre rounded-lg bg-slate-900 p-3 text-xs text-slate-200">
        {block.content}
      </pre>
    </div>
  );
}

function insertPlotBlocksAfterOutput(blocks: StreamBlock[], plotPaths: string[]): StreamBlock[] {
  if (plotPaths.length === 0) return blocks;
  const existingImagePaths = new Set(
    blocks
      .filter((block) => block.type === 'image' && block.path)
      .map((block) => (block.path || '').trim())
      .filter(Boolean)
  );
  const seen = new Set<string>();
  const uniquePlotPaths: string[] = [];
  for (const path of plotPaths) {
    const normalized = path.trim();
    if (!normalized || seen.has(normalized) || existingImagePaths.has(normalized)) continue;
    seen.add(normalized);
    uniquePlotPaths.push(normalized);
  }
  if (uniquePlotPaths.length === 0) return blocks;
  const plotBlocks: StreamBlock[] = uniquePlotPaths.map((path, index) => ({
    type: 'image',
    label: `Plot ${index + 1}`,
    content: '',
    path,
  }));
  const outputIndex = findLastBlockIndex(blocks, 'Output');
  if (outputIndex >= 0) {
    return [...blocks.slice(0, outputIndex + 1), ...plotBlocks, ...blocks.slice(outputIndex + 1)];
  }
  const codeIndex = findLastBlockIndex(blocks, 'Code');
  if (codeIndex >= 0) {
    return [...blocks.slice(0, codeIndex + 1), ...plotBlocks, ...blocks.slice(codeIndex + 1)];
  }
  return [...blocks, ...plotBlocks];
}

function mergeFullStdoutIntoBlocks(blocks: StreamBlock[], fullStdout: string): StreamBlock[] {
  if (!fullStdout.trim()) {
    return blocks;
  }
  const outputIndex = findLastBlockIndex(blocks, 'Output');
  if (outputIndex < 0) {
    return [...blocks, { type: 'code', label: 'Output', content: fullStdout }];
  }
  const merged = [...blocks];
  merged[outputIndex] = { ...merged[outputIndex], content: fullStdout };
  return merged;
}

function findLastBlockIndex(blocks: StreamBlock[], label: string): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].label === label) {
      return index;
    }
  }
  return -1;
}

function buildBlocksFromLogs(logs: PlanLogEntry[]): StreamBlock[] {
  const filtered = logs
    .filter((log) => log.channel !== 'llm')
    .sort((a, b) => a.seq - b.seq);
  const grouped: Array<{ channel: PlanLogEntry['channel']; content: string }> = [];
  for (const log of filtered) {
    if (log.channel === 'system' || log.channel === 'exec_plot') {
      grouped.push({ channel: log.channel, content: log.content });
      continue;
    }
    const last = grouped[grouped.length - 1];
    if (last && last.channel === log.channel) {
      last.content += log.content;
    } else {
      grouped.push({ channel: log.channel, content: log.content });
    }
  }

  return grouped.flatMap<StreamBlock>((group) => {
    if (group.channel === 'exec_stdout') {
      return [{ type: 'code', label: 'Output', content: group.content }];
    }
    if (group.channel === 'exec_stderr') {
      return [{ type: 'error', label: 'Error', content: group.content }];
    }
    if (group.channel === 'exec_plot') {
      const path = group.content.trim();
      return path ? [{ type: 'image', label: 'Plot', content: '', path }] : [];
    }
    if (group.channel === 'system') {
      const trimmed = group.content.trimStart();
      if (trimmed.startsWith('[REFLECTION]')) {
        return [{ type: 'text', label: 'Reflection', content: trimmed.replace('[REFLECTION]', '').trimStart() }];
      }
      if (trimmed.startsWith('[TOOL]')) {
        return [{ type: 'text', label: 'Tool', content: trimmed.replace('[TOOL]', '').trimStart() }];
      }
      if (trimmed.startsWith('[CODE]')) {
        return [{ type: 'code', label: 'Code', content: trimmed.replace('[CODE]', '').trimStart() }];
      }
      if (trimmed.startsWith('[EXECUTION ERROR]') || trimmed.startsWith('[SYSTEM ERROR]')) {
        return [{
          type: 'error',
          label: 'Error',
          content: trimmed.replace('[EXECUTION ERROR]', '').replace('[SYSTEM ERROR]', '').trimStart(),
        }];
      }
      if (trimmed.startsWith('[SYSTEM NOTE]')) {
        return [];
      }
      return [{ type: 'text', content: group.content }];
    }
    return [{ type: 'text', content: group.content }];
  });
}
