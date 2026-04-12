import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { ProvenanceCitation, SteeringTargetSnapshot } from '@/types';

type NarrativeTone = 'stage' | 'final';

interface NarrativeMarkdownProps {
  markdown: string;
  citations?: ProvenanceCitation[];
  tone?: NarrativeTone;
  onActivateCitation?: (target: SteeringTargetSnapshot) => void;
}

interface MarkdownNode {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

type TextSegment =
  | { type: 'text'; value: string }
  | { type: 'citation_group'; markers: number[] };

function parseCitationMarkers(rawValue: string): number[] | null {
  const parts = rawValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const markers: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const marker = Number.parseInt(part, 10);
    if (!Number.isInteger(marker) || marker < 1 || seen.has(marker)) {
      continue;
    }
    seen.add(marker);
    markers.push(marker);
  }
  return markers.length > 0 ? markers : null;
}

function splitCitationSegments(value: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < value.length) {
    const openIndex = value.indexOf('[[', cursor);
    if (openIndex < 0) {
      break;
    }
    const closeIndex = value.indexOf(']]', openIndex + 2);
    if (closeIndex < 0) {
      break;
    }
    const rawMarkers = value.slice(openIndex + 2, closeIndex);
    const markers = parseCitationMarkers(rawMarkers);
    if (!markers) {
      cursor = closeIndex + 2;
      continue;
    }
    if (openIndex > textStart) {
      segments.push({
        type: 'text',
        value: value.slice(textStart, openIndex),
      });
    }
    segments.push({
      type: 'citation_group',
      markers,
    });
    cursor = closeIndex + 2;
    textStart = cursor;
  }

  if (textStart < value.length) {
    segments.push({
      type: 'text',
      value: value.slice(textStart),
    });
  }

  return segments;
}

function createCitationNode(markers: number[]): MarkdownNode {
  const href = markers.length === 1
    ? `#citation-${markers[0]}`
    : `#citation-group-${markers.join(',')}`;
  return {
    type: 'link',
    url: href,
    children: [{ type: 'text', value: markers.join(',') }],
  };
}

function injectCitationMarkers(node: MarkdownNode): void {
  if (!Array.isArray(node.children) || node.children.length === 0) {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('[[')) {
      const segments = splitCitationSegments(child.value);
      if (segments.length === 1 && segments[0]?.type === 'text') {
        nextChildren.push(child);
        continue;
      }
      for (const segment of segments) {
        if (segment.type === 'text') {
          if (segment.value) {
            nextChildren.push({ type: 'text', value: segment.value });
          }
          continue;
        }
        nextChildren.push(createCitationNode(segment.markers));
      }
      continue;
    }

    injectCitationMarkers(child);
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

function remarkNarrativeCitations() {
  return (tree: MarkdownNode) => {
    injectCitationMarkers(tree);
  };
}

function parseMarker(value: unknown): number | null {
  const marker = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(marker) || marker < 1) {
    return null;
  }
  return marker;
}

function parseCitationHref(href: string | undefined): number[] | null {
  if (!href) {
    return null;
  }
  if (href.startsWith('#citation-group-')) {
    return parseCitationMarkers(href.slice('#citation-group-'.length));
  }
  if (href.startsWith('#citation-')) {
    const marker = parseMarker(href.slice('#citation-'.length));
    return marker === null ? null : [marker];
  }
  return null;
}

function citationTextClasses(tone: NarrativeTone): string {
  return tone === 'stage'
    ? 'text-amber-700 hover:text-amber-900'
    : 'text-emerald-700 hover:text-emerald-900';
}

function citationBackgroundClasses(tone: NarrativeTone): string {
  return tone === 'stage'
    ? 'hover:bg-amber-100/70'
    : 'hover:bg-emerald-100/70';
}

const CITATION_SUPERSCRIPT_CLASS = 'ml-0.5 align-super text-[0.75em]';

export default function NarrativeMarkdown({
  markdown,
  citations = [],
  tone = 'final',
  onActivateCitation,
}: NarrativeMarkdownProps) {
  const citationsByMarker = new Map(citations.map((citation) => [citation.marker, citation]));
  const accentLinkClass =
    tone === 'stage'
      ? 'font-medium text-amber-700 underline underline-offset-2'
      : 'font-medium text-emerald-700 underline underline-offset-2';
  const inlineCodeClass =
    tone === 'stage'
      ? 'rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[0.9em] text-amber-900'
      : 'rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[0.9em] text-emerald-900';
  const blockquoteClass =
    tone === 'stage'
      ? 'mt-3 border-l-2 border-amber-300 pl-4 italic text-slate-600 first:mt-0'
      : 'mt-3 border-l-2 border-emerald-300 pl-4 italic text-slate-600 first:mt-0';
  const tableHeadClass = tone === 'stage' ? 'border-b border-amber-200' : 'border-b border-emerald-200';
  const tableRowClass = tone === 'stage'
    ? 'border-b border-amber-100 last:border-b-0'
    : 'border-b border-emerald-100 last:border-b-0';
  const renderSingleCitation = (marker: number) => {
    const citation = citationsByMarker.get(marker);
    if (!citation || !onActivateCitation) {
      return (
        <sup
          className={`${CITATION_SUPERSCRIPT_CLASS} font-semibold text-slate-500`}
          data-provenance-marker={marker}
        >
          {marker}
        </sup>
      );
    }
    return (
      <sup className={CITATION_SUPERSCRIPT_CLASS} data-provenance-marker={marker}>
        <button
          type="button"
          title={citation.label}
          data-provenance-marker={marker}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onActivateCitation(citation.target);
          }}
          className={`rounded px-0.5 font-semibold transition ${citationTextClasses(tone)} ${citationBackgroundClasses(tone)}`}
        >
          {marker}
        </button>
      </sup>
    );
  };
  const renderCitationCluster = (markers: number[]) => {
    if (markers.length === 1) {
      return renderSingleCitation(markers[0]!);
    }
    return (
      <sup
        className={CITATION_SUPERSCRIPT_CLASS}
        data-provenance-markers={markers.join(',')}
      >
        {markers.map((marker, index) => {
          const citation = citationsByMarker.get(marker);
          const canActivate = Boolean(citation && onActivateCitation);
          return (
            <span key={`citation-cluster-${marker}`} className="inline-flex items-center">
              {index > 0 ? <span className="px-[1px] text-slate-400">,</span> : null}
              {canActivate ? (
                <button
                  type="button"
                  title={citation?.label}
                  data-provenance-marker={marker}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onActivateCitation?.(citation!.target);
                  }}
                  className={`rounded px-0.5 font-semibold transition ${citationTextClasses(tone)} ${citationBackgroundClasses(tone)}`}
                >
                  {marker}
                </button>
              ) : (
                <span className="font-semibold text-slate-500" data-provenance-marker={marker}>
                  {marker}
                </span>
              )}
            </span>
          );
        })}
      </sup>
    );
  };
  const components = {
    a: (({ children, href }: { children?: ReactNode; href?: string }) => {
      const parsedMarkers = parseCitationHref(href);
      if (!parsedMarkers) {
        return (
          <a href={href} target="_blank" rel="noreferrer" className={accentLinkClass}>
            {children}
          </a>
        );
      }
      return renderCitationCluster(parsedMarkers);
    }) as never,
    h1: ({ children }: { children?: ReactNode }) => (
      <h1 className="mt-4 text-xl font-semibold text-slate-900 first:mt-0">{children}</h1>
    ),
    h2: ({ children }: { children?: ReactNode }) => (
      <h2 className="mt-4 text-lg font-semibold text-slate-900 first:mt-0">{children}</h2>
    ),
    h3: ({ children }: { children?: ReactNode }) => (
      <h3 className="mt-4 text-base font-semibold text-slate-900 first:mt-0">{children}</h3>
    ),
    p: ({
      children,
      node: _node,
      ...props
    }: { children?: ReactNode; node?: unknown } & Record<string, unknown>) => (
      <p {...props} className="mt-3 leading-6 first:mt-0">
        {children}
      </p>
    ),
    ol: ({
      children,
      className,
      node: _node,
      ...props
    }: { children?: ReactNode; className?: string; node?: unknown } & Record<string, unknown>) => (
      <ol
        {...props}
        className={`mt-3 list-decimal space-y-2 pl-6 first:mt-0 ${className ?? ''}`.trim()}
      >
        {children}
      </ol>
    ),
    ul: ({
      children,
      className,
      node: _node,
      ...props
    }: { children?: ReactNode; className?: string; node?: unknown } & Record<string, unknown>) => (
      <ul
        {...props}
        className={`mt-3 list-disc space-y-2 pl-6 first:mt-0 ${className ?? ''}`.trim()}
      >
        {children}
      </ul>
    ),
    li: ({
      children,
      className,
      node: _node,
      ...props
    }: { children?: ReactNode; className?: string; node?: unknown } & Record<string, unknown>) => (
      <li
        {...props}
        className={`leading-6 pl-1 [&>p]:mt-0 [&>ul]:mt-2 [&>ol]:mt-2 ${className ?? ''}`.trim()}
      >
        {children}
      </li>
    ),
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote className={blockquoteClass}>{children}</blockquote>
    ),
    code: ({
      children,
      className,
    }: { children?: ReactNode; className?: string }) =>
      className ? (
        <code className={`${className} font-mono text-[0.9em] text-slate-100`}>
          {children}
        </code>
      ) : (
        <code className={inlineCodeClass}>{children}</code>
      ),
    pre: ({ children }: { children?: ReactNode }) => (
      <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-900 px-4 py-3 text-sm first:mt-0">
        {children}
      </pre>
    ),
    table: ({ children }: { children?: ReactNode }) => (
      <div className="mt-3 overflow-x-auto first:mt-0">
        <table className="min-w-full border-collapse text-left text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }: { children?: ReactNode }) => <thead className={tableHeadClass}>{children}</thead>,
    tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
    tr: ({ children }: { children?: ReactNode }) => <tr className={tableRowClass}>{children}</tr>,
    th: ({ children }: { children?: ReactNode }) => <th className="px-3 py-2 font-semibold text-slate-900">{children}</th>,
    td: ({ children }: { children?: ReactNode }) => <td className="px-3 py-2 align-top leading-6">{children}</td>,
  } as any;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks, remarkNarrativeCitations]}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
}
