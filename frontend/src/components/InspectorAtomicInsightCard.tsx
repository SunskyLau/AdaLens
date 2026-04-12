import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { fetchArtifact, getArtifactUrl } from '@/api/client';
import type { AtomicInsight } from '@/types';
import { getInsightTypeColor, getInsightTypeLabel } from './inspectorShared';

interface AtomicInsightCardProps {
  runId: string;
  atomic: AtomicInsight;
  index: number;
  showMetrics?: boolean;
  showCodeEvidence?: boolean;
  showOutputEvidence?: boolean;
  enablePlotZoom?: boolean;
  className?: string;
}

export default function AtomicInsightCard({
  runId,
  atomic,
  index,
  showMetrics = true,
  showCodeEvidence = true,
  showOutputEvidence = true,
  enablePlotZoom = true,
  className,
}: AtomicInsightCardProps) {
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [codeContent, setCodeContent] = useState('');
  const [outputContent, setOutputContent] = useState('');
  const [codeLoading, setCodeLoading] = useState(false);
  const [outputLoading, setOutputLoading] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  const plotPath = atomic.evidence?.plot_path || '';
  const codePath = atomic.evidence?.code_path || '';
  const outputPath = atomic.evidence?.output_path || '';
  const hasPlot = !!plotPath;
  const hasCode = !!codePath;
  const hasOutput = !!outputPath;

  useEffect(() => {
    if (codeExpanded && hasCode && !codeContent && !codeLoading) {
      setCodeLoading(true);
      fetchArtifact(runId, codePath)
        .then(setCodeContent)
        .catch(() => setCodeContent('Failed to load code'))
        .finally(() => setCodeLoading(false));
    }
  }, [codeContent, codeExpanded, codeLoading, codePath, hasCode, runId]);

  useEffect(() => {
    if (outputExpanded && hasOutput && !outputContent && !outputLoading) {
      setOutputLoading(true);
      fetchArtifact(runId, outputPath)
        .then(setOutputContent)
        .catch(() => setOutputContent('Failed to load output'))
        .finally(() => setOutputLoading(false));
    }
  }, [hasOutput, outputContent, outputExpanded, outputLoading, outputPath, runId]);

  return (
    <div className={clsx('overflow-hidden rounded-lg border border-slate-200 bg-white', className)}>
      <div className="p-3">
        <div className="mb-2 flex items-start gap-2">
          <span
            className={clsx(
              'shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium',
              getInsightTypeColor(atomic.insight_type)
            )}
          >
            {getInsightTypeLabel(atomic.insight_type)}
          </span>
          {atomic.columns && atomic.columns.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              {atomic.columns.map((column) => (
                <span
                  key={column}
                  className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"
                >
                  {column}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {showMetrics ? (
          <>
            <div className="mb-2 flex items-start gap-2">
              <span className="whitespace-nowrap rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                Interest {(atomic.interest ?? 0).toFixed(2)}
              </span>
              <span className="whitespace-nowrap rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                Significance {(atomic.significance ?? 0).toFixed(2)}
              </span>
              <span className="whitespace-nowrap rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                Impact {(atomic.impact ?? 0).toFixed(2)}
              </span>
            </div>

            <div className="mb-2 flex items-start gap-2">
              <span className="whitespace-nowrap rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">
                Importance {(atomic.importance ?? 0).toFixed(2)}
              </span>
            </div>
          </>
        ) : null}
        <p className="text-sm leading-relaxed text-slate-700">{atomic.text}</p>
      </div>

      <div className="px-3 pb-3">
        {hasPlot ? (
          <>
            {enablePlotZoom ? (
              <button
                type="button"
                onClick={() => setZoomOpen(true)}
                className="block w-full"
                title="Click to zoom"
              >
                <img
                  src={getArtifactUrl(runId, plotPath)}
                  alt={`Insight ${index} plot`}
                  className="w-full rounded-md border border-slate-100"
                />
              </button>
            ) : (
              <img
                src={getArtifactUrl(runId, plotPath)}
                alt={`Insight ${index} plot`}
                className="w-full rounded-md border border-slate-100"
              />
            )}
            <div className="mt-1 text-[10px] text-slate-400">{plotPath}</div>

            {enablePlotZoom && zoomOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
                onClick={() => setZoomOpen(false)}
              >
                <div className="max-h-[92vh] max-w-[96vw]" onClick={(event) => event.stopPropagation()}>
                  <img
                    src={getArtifactUrl(runId, plotPath)}
                    alt={`Insight ${index} plot zoomed`}
                    className="max-h-[92vh] max-w-[96vw] rounded-lg bg-white shadow-2xl"
                  />
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-dashed border-amber-300 bg-amber-50 p-3 text-xs text-amber-700">
            Plot evidence is missing for this atomic insight.
          </div>
        )}
      </div>

      {showCodeEvidence || showOutputEvidence ? (
        <div className="border-t border-slate-100">
          {showCodeEvidence ? (
            <InspectorEvidenceToggle
              label="Code"
              expanded={codeExpanded}
              disabled={!hasCode}
              onToggle={() => {
                if (hasCode) setCodeExpanded((current) => !current);
              }}
            >
              <pre className="max-h-48 overflow-auto whitespace-pre rounded-lg bg-slate-900 p-3 text-xs text-slate-200">
                {codeLoading ? 'Loading...' : codeContent || 'No content'}
              </pre>
            </InspectorEvidenceToggle>
          ) : null}

          {showOutputEvidence ? (
            <div className={showCodeEvidence ? 'border-t border-slate-100' : undefined}>
              <InspectorEvidenceToggle
                label="Output"
                expanded={outputExpanded}
                disabled={!hasOutput}
                onToggle={() => {
                  if (hasOutput) setOutputExpanded((current) => !current);
                }}
              >
                <pre className="max-h-48 overflow-auto whitespace-pre rounded-lg bg-slate-900 p-3 text-xs text-slate-200">
                  {outputLoading ? 'Loading...' : outputContent || 'No content'}
                </pre>
              </InspectorEvidenceToggle>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function InspectorEvidenceToggle({
  label,
  expanded,
  disabled,
  onToggle,
  children,
}: {
  label: string;
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={onToggle}
        className={clsx(
          'flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors',
          disabled ? 'cursor-not-allowed text-slate-300' : 'text-slate-500 hover:bg-slate-50'
        )}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {expanded ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}
