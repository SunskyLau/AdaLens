import type { MouseEvent as ReactMouseEvent } from 'react';
import type { InsightType, SoftSteeringKind } from '@/types';
import {
  computeRouteBoxRadius,
  getInsightTypeHex,
  type StorylineNodeGeometry,
} from './storylineGraphLayout';
import StorylineSoftSteeringIcon, {
  resolveStorylineSoftSteeringBadgeBounds,
} from './storylineSoftSteeringIcon';
import DataQualityGlyphSvg from './glyphs/DataQualityGlyphSvg';

interface InsightTypeGlyphMarkProps {
  insightType: InsightType;
  size: number;
  color?: string;
  opacity?: number;
  maxHeight?: number;
  maxWidth?: number;
}

interface StorylineAtomicGlyphProps {
  node: StorylineNodeGeometry;
  isSelected: boolean;
  isPenHovered?: boolean;
  opacity?: number;
  steeringKind?: SoftSteeringKind | null;
  steeringEntryId?: string | null;
  onSelect: (summaryId: string, atomicId: string, event: ReactMouseEvent<Element>) => void;
  onSteeringBadgeClick?: (conversationEntryId: string) => void;
  onHoverStart?: (summaryId: string, atomicId: string, clientX: number, clientY: number) => void;
  onHoverMove?: (summaryId: string, atomicId: string, clientX: number, clientY: number) => void;
  onHoverEnd?: (summaryId: string, atomicId: string) => void;
}

const STORYLINE_GLYPH_VISUAL_SCALE = 1.08;
const STORYLINE_DATA_QUALITY_THEME_HEX = '#113C64';

function resolveStorylineInsightHex(insightType: InsightType): string {
  if (insightType === 'data_quality') {
    return STORYLINE_DATA_QUALITY_THEME_HEX;
  }
  return getInsightTypeHex(insightType);
}

function renderGlyphShape(
  insightType: InsightType,
  size: number,
  color: string,
  maxHeight?: number,
  maxWidth?: number,
) {
  const half = size / 2;
  const radius = half * 0.9;
  const strokeWidth = Math.max(0.35, size * 0.09);
  const fillAlpha = 0.2;
  const fillTint = `${color}${Math.round(fillAlpha * 255).toString(16).padStart(2, '0')}`;

  switch (insightType) {
    case 'value': {
      const r = radius * 1.12;
      const barWidth = r * 0.38;
      const barGap = r * 0.14;
      const baseY = r * 0.78;
      const barHeights = [r * 0.82, r * 1.26, r * 0.58];
      const xStart = -(barWidth * 3 + barGap * 2) / 2;
      return (
        <>
          <line
            x1={xStart - r * 0.08}
            y1={baseY}
            x2={xStart + barWidth * 3 + barGap * 2 + r * 0.08}
            y2={baseY}
            stroke={color}
            strokeWidth={strokeWidth * 0.55}
            strokeLinecap="round"
          />
          {barHeights.map((height, index) => {
            const x = xStart + index * (barWidth + barGap);
            return (
              <rect
                key={`value-bar-${index}`}
                x={x}
                y={baseY - height}
                width={barWidth}
                height={height}
                rx={1.2}
                fill={color}
              />
            );
          })}
        </>
      );
    }
    case 'proportion': {
      const r = radius * 0.7;
      const arcEndX = r * Math.cos(-Math.PI / 3);
      const arcEndY = r * Math.sin(-Math.PI / 3);
      return (
        <>
          <circle cx={0} cy={0} r={r} fill={fillTint} stroke={color} strokeWidth={strokeWidth * 0.65} />
          <path d={`M 0 0 L ${r} 0 A ${r} ${r} 0 0 1 ${arcEndX} ${arcEndY} Z`} fill={color} />
        </>
      );
    }
    case 'rank': {
      const r = radius * 1.12;
      const rawStepWidth = r * 0.52;
      const rawBaseY = r * 0.86;
      const baseStepHeight = r * 0.24;
      const stepDelta = r * 0.54;
      const rawLabelGap = r * 0.14;
      const rawNumberFontSize = Math.max(3.2, size * 0.38);
      const rawStepHeights = [
        baseStepHeight,
        baseStepHeight + stepDelta,
        baseStepHeight + stepDelta * 2,
      ];
      const rawStepTopYs = rawStepHeights.map((height) => rawBaseY - height);
      const rawLabelCenterYs = rawStepTopYs.map(
        (stepTopY) => stepTopY - rawLabelGap - rawNumberFontSize / 2
      );
      const rawLabelTopY = Math.min(
        ...rawLabelCenterYs.map((centerY) => centerY - rawNumberFontSize / 2)
      );
      const rawMinY = Math.min(...rawStepTopYs, rawLabelTopY);
      const rawMaxY = rawBaseY;
      const rawHeight = rawMaxY - rawMinY;
      const rawWidth = rawStepWidth * 3;
      const heightScale = maxHeight && maxHeight > 0
        ? maxHeight / Math.max(1e-6, rawHeight)
        : 1;
      const widthScale = maxWidth && maxWidth > 0
        ? maxWidth / Math.max(1e-6, rawWidth)
        : 1;
      const fitScale = Math.min(1, heightScale, widthScale);
      const stepWidth = rawStepWidth * fitScale;
      const stepHeights = rawStepHeights.map((height) => height * fitScale);
      let yShift = 0;
      if (maxHeight && maxHeight > 0) {
        const scaledMinY = rawMinY * fitScale;
        const scaledMaxY = rawMaxY * fitScale;
        yShift = -(scaledMinY + scaledMaxY) / 2;
      }
      const baseY = rawBaseY * fitScale + yShift;
      const labels = ['3', '2', '1'];
      const xStart = -(stepWidth * labels.length) / 2;
      const numberFontSize = rawNumberFontSize * fitScale;
      const labelGap = rawLabelGap * fitScale;
      const y1 = baseY - stepHeights[0];
      const y2 = baseY - stepHeights[1];
      const y3 = baseY - stepHeights[2];
      const x1 = xStart + stepWidth;
      const x2 = xStart + stepWidth * 2;
      const x3 = xStart + stepWidth * 3;
      const podiumPath = [
        `M ${xStart} ${baseY}`,
        `L ${xStart} ${y1}`,
        `L ${x1} ${y1}`,
        `L ${x1} ${y2}`,
        `L ${x2} ${y2}`,
        `L ${x2} ${y3}`,
        `L ${x3} ${y3}`,
        `L ${x3} ${baseY}`,
        'Z',
      ].join(' ');
      return (
        <>
          <path d={podiumPath} fill={color} />
          {stepHeights.map((height, index) => {
            const centerX = xStart + (index + 0.5) * stepWidth;
            const stepTopY = baseY - height;
            const centerY = stepTopY - labelGap - numberFontSize / 2;
            return (
              <text
                key={`rank-step-${labels[index]}`}
                x={centerX}
                y={centerY}
                fill={color}
                fontSize={numberFontSize}
                fontWeight={800}
                textAnchor="middle"
                dominantBaseline="central"
                alignmentBaseline="central"
              >
                {labels[index]}
              </text>
            );
          })}
        </>
      );
    }
    case 'difference':
      return (
        <>
          <rect x={-radius * 0.75} y={-radius * 0.12} width={radius * 0.42} height={radius * 0.9} rx={1.5} fill={color} />
          <rect x={radius * 0.3} y={-radius * 0.76} width={radius * 0.42} height={radius * 0.9} rx={1.5} fill={color} />
          <line x1={-radius * 0.02} y1={-radius * 0.7} x2={-radius * 0.02} y2={radius * 0.9} stroke={color} strokeWidth={strokeWidth * 0.56} strokeLinecap="round" />
        </>
      );
    case 'trend':
      {
        const p0 = { x: -radius * 0.82, y: radius * 0.62 };
        const p1 = { x: -radius * 0.3, y: radius * 0.2 };
        const p2 = { x: radius * 0.18, y: radius * 0.32 };
        const tip = { x: radius * 0.8, y: -radius * 0.52 };
        const segDx = tip.x - p2.x;
        const segDy = tip.y - p2.y;
        const segLen = Math.max(1e-6, Math.hypot(segDx, segDy));
        const ux = segDx / segLen;
        const uy = segDy / segLen;
        const nx = -uy;
        const ny = ux;
        const arrowLen = radius * 0.58;
        const arrowHalfWidth = radius * 0.24;
        const headBase = {
          x: tip.x - ux * arrowLen,
          y: tip.y - uy * arrowLen,
        };
        const left = {
          x: headBase.x + nx * arrowHalfWidth,
          y: headBase.y + ny * arrowHalfWidth,
        };
        const right = {
          x: headBase.x - nx * arrowHalfWidth,
          y: headBase.y - ny * arrowHalfWidth,
        };
        return (
          <>
            <polyline
              points={`${p0.x},${p0.y} ${p1.x},${p1.y} ${p2.x},${p2.y} ${headBase.x},${headBase.y}`}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth * 1.02}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polygon
              points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
              fill={color}
            />
          </>
        );
      }
    case 'distribution':
      return (
        <path
          d={`M ${-radius * 0.86} ${radius * 0.5} C ${-radius * 0.62} ${radius * 0.32}, ${-radius * 0.5} ${-radius * 0.26}, ${-radius * 0.2} ${-radius * 0.46} C ${-radius * 0.08} ${-radius * 0.54}, ${radius * 0.08} ${-radius * 0.54}, ${radius * 0.2} ${-radius * 0.46} C ${radius * 0.5} ${-radius * 0.26}, ${radius * 0.62} ${radius * 0.32}, ${radius * 0.86} ${radius * 0.5}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      );
    case 'association':
      return (
        <>
          <circle cx={-radius * 0.3} cy={0} r={radius * 0.4} fill="none" stroke={color} strokeWidth={strokeWidth * 0.75} />
          <circle cx={radius * 0.3} cy={0} r={radius * 0.4} fill="none" stroke={color} strokeWidth={strokeWidth * 0.75} />
          <line x1={-radius * 0.02} y1={0} x2={radius * 0.02} y2={0} stroke={color} strokeWidth={strokeWidth * 0.8} strokeLinecap="round" />
        </>
      );
    case 'outlier':
      return (
        <>
          <circle cx={-radius * 0.5} cy={radius * 0.46} r={radius * 0.11} fill={color} />
          <circle cx={-radius * 0.28} cy={radius * 0.58} r={radius * 0.11} fill={color} />
          <circle cx={-radius * 0.08} cy={radius * 0.44} r={radius * 0.11} fill={color} />
          <circle cx={radius * 0.14} cy={radius * 0.58} r={radius * 0.11} fill={color} />
          <circle cx={radius * 0.36} cy={radius * 0.46} r={radius * 0.11} fill={color} />
          <circle cx={-radius * 0.18} cy={radius * 0.72} r={radius * 0.1} fill={color} />
          <circle cx={radius * 0.08} cy={radius * 0.72} r={radius * 0.1} fill={color} />
          <circle cx={radius * 0.74} cy={-radius * 0.72} r={radius * 0.2} fill={color} />
        </>
      );
    case 'extreme':
      {
        // Taller apex + narrower base + enlarged apex dot.
        const rawApexY = -radius * 1.34;
        const rawBottomY = radius * 0.9;
        const rawHalfBaseWidth = radius * 0.46;
        const rawDotRadius = radius * 0.34;
        const baseLineStrokeWidth = strokeWidth * 1.04;
        const rawMinY = rawApexY - rawDotRadius;
        const rawMaxY = rawBottomY + baseLineStrokeWidth / 2;
        const rawHeight = rawMaxY - rawMinY;
        const rawWidth = (rawHalfBaseWidth + baseLineStrokeWidth / 2) * 2;
        const heightScale = maxHeight && maxHeight > 0
          ? maxHeight / Math.max(1e-6, rawHeight)
          : 1;
        const widthScale = maxWidth && maxWidth > 0
          ? maxWidth / Math.max(1e-6, rawWidth)
          : 1;
        const fitScale = Math.min(1, heightScale, widthScale);
        const scaledMinY = rawMinY * fitScale;
        const scaledMaxY = rawMaxY * fitScale;
        let yShift = 0;
        if (maxHeight && maxHeight > 0) {
          const halfAllowedHeight = maxHeight / 2;
          const shiftMin = -halfAllowedHeight - scaledMinY;
          const shiftMax = halfAllowedHeight - scaledMaxY;
          const centerShift = -(scaledMinY + scaledMaxY) / 2;
          const downwardBias = Math.min(halfAllowedHeight * 0.16, radius * fitScale * 0.18);
          const desiredShift = centerShift + downwardBias;
          yShift = Math.min(Math.max(desiredShift, shiftMin), shiftMax);
        }
        const apexY = rawApexY * fitScale + yShift;
        const bottomY = rawBottomY * fitScale + yShift;
        const halfBaseWidth = rawHalfBaseWidth * fitScale;
        const dotRadius = rawDotRadius * fitScale;
        const lineStrokeWidth = baseLineStrokeWidth * fitScale;
        return (
          <>
            <polyline
              points={`${-halfBaseWidth},${bottomY} 0,${apexY} ${halfBaseWidth},${bottomY}`}
              fill="none"
              stroke={color}
              strokeWidth={lineStrokeWidth}
              strokeLinecap="round"
              strokeLinejoin="miter"
            />
            <circle cx={0} cy={apexY} r={dotRadius} fill={color} />
          </>
        );
      }
    case 'cluster':
      {
        const r = radius * 1.12;
        return (
          <>
            <circle
              cx={0}
              cy={0}
              r={r * 0.58}
              fill={fillTint}
              stroke={color}
              strokeWidth={strokeWidth * 0.68}
            />
            <circle cx={-r * 0.24} cy={-r * 0.08} r={r * 0.13} fill={color} />
            <circle cx={-r * 0.03} cy={-r * 0.18} r={r * 0.11} fill={color} />
            <circle cx={r * 0.2} cy={r * 0.04} r={r * 0.12} fill={color} />
            <circle cx={-r * 0.1} cy={r * 0.22} r={r * 0.1} fill={color} />
            <circle cx={r * 0.14} cy={r * 0.2} r={r * 0.09} fill={color} />
            <circle cx={-r * 0.82} cy={-r * 0.52} r={r * 0.1} fill={color} />
            <circle cx={r * 0.86} cy={-r * 0.24} r={r * 0.1} fill={color} />
            <circle cx={r * 0.74} cy={r * 0.6} r={r * 0.09} fill={color} />
            <circle cx={-r * 0.76} cy={r * 0.56} r={r * 0.08} fill={color} />
          </>
        );
      }
    case 'data_quality':
      return (
        <DataQualityGlyphSvg
          size={size}
          color={color}
          maxHeight={maxHeight}
          maxWidth={maxWidth}
        />
      );
    default:
      return <circle cx={0} cy={0} r={radius * 0.55} fill={color} />;
  }
}

export function InsightTypeGlyphMark({
  insightType,
  size,
  color,
  opacity = 1,
  maxHeight,
  maxWidth,
}: InsightTypeGlyphMarkProps) {
  const glyphColor = color || resolveStorylineInsightHex(insightType);
  return (
    <g opacity={opacity}>
      {renderGlyphShape(insightType, size, glyphColor, maxHeight, maxWidth)}
    </g>
  );
}

export default function StorylineAtomicGlyph({
  node,
  isSelected,
  isPenHovered = false,
  opacity = 1,
  steeringKind = null,
  steeringEntryId = null,
  onSelect,
  onSteeringBadgeClick,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: StorylineAtomicGlyphProps) {
  const typeHex = resolveStorylineInsightHex(node.insightType);
  const hitRadius = node.hitDiameter / 2;
  const glyphSize = node.glyphDiameter * STORYLINE_GLYPH_VISUAL_SCALE * (isSelected ? 1.12 : 1);
  const glyphOpacity = isSelected ? 1 : 0.88;
  const routeBoxStrokeWidth = isSelected ? 1.85 : isPenHovered ? 1.5 : 0.9;
  const routeBoxOpacity = isSelected ? 1 : isPenHovered ? 0.92 : 0.62;
  const routeBoxFill = isSelected ? `${typeHex}1f` : isPenHovered ? `${typeHex}12` : 'none';
  const routeBoxRadius = computeRouteBoxRadius(node.width, node.height);
  const glyphBoundaryInset = routeBoxStrokeWidth / 2 + 1.25;
  const glyphMaxHeight = Math.max(0, node.height - glyphBoundaryInset * 2);
  const glyphMaxWidth = Math.max(0, node.width - glyphBoundaryInset * 2);
  const atomicBadgeAnchorX = node.width / 2 + routeBoxStrokeWidth / 2;
  const atomicBadgeAnchorY = -node.height / 2 - routeBoxStrokeWidth / 2;
  const atomicBadgeEntryId = steeringKind && steeringEntryId ? steeringEntryId : null;
  const badgeBounds =
    steeringKind && atomicBadgeEntryId
      ? resolveStorylineSoftSteeringBadgeBounds({
        anchorX: atomicBadgeAnchorX,
        anchorY: atomicBadgeAnchorY,
        scope: 'atomic',
        paddingPx: 3,
      })
      : null;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      data-storyline-interactive="true"
      data-storyline-glyph-id={node.atomicId}
      data-storyline-glyph-pen-hovered={isPenHovered ? 'true' : undefined}
      className="cursor-pointer"
      opacity={opacity}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.summaryId, node.atomicId, event);
      }}
      onMouseEnter={(event) => {
        onHoverStart?.(node.summaryId, node.atomicId, event.clientX, event.clientY);
      }}
      onMouseMove={(event) => {
        onHoverMove?.(node.summaryId, node.atomicId, event.clientX, event.clientY);
      }}
      onMouseLeave={() => {
        onHoverEnd?.(node.summaryId, node.atomicId);
      }}
    >
      <circle cx={0} cy={0} r={hitRadius} fill="transparent" />
      <rect
        x={-node.width / 2}
        y={-node.height / 2}
        width={node.width}
        height={node.height}
        rx={routeBoxRadius}
        fill={routeBoxFill}
        stroke={typeHex}
        strokeWidth={routeBoxStrokeWidth}
        strokeOpacity={routeBoxOpacity}
      />
      {badgeBounds && atomicBadgeEntryId && onSteeringBadgeClick ? (
        <rect
          x={badgeBounds.x}
          y={badgeBounds.y}
          width={badgeBounds.width}
          height={badgeBounds.height}
          rx={badgeBounds.rx}
          fill="transparent"
          pointerEvents="all"
          data-storyline-interactive="true"
          data-storyline-soft-steering-badge-hit-target="atomic"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSteeringBadgeClick(atomicBadgeEntryId);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      ) : null}
      {steeringKind ? (
        <StorylineSoftSteeringIcon
          kind={steeringKind}
          anchorX={atomicBadgeAnchorX}
          anchorY={atomicBadgeAnchorY}
          scope="atomic"
        />
      ) : null}
      <InsightTypeGlyphMark
        insightType={node.insightType}
        size={glyphSize}
        color={typeHex}
        opacity={glyphOpacity}
        maxHeight={glyphMaxHeight}
        maxWidth={glyphMaxWidth}
      />
    </g>
  );
}
