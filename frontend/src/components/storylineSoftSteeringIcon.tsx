import type { SoftSteeringKind } from '@/types';

const STORYLINE_SOFT_STEERING_BADGE_SIZE_PX = 14;
const STORYLINE_SOFT_STEERING_ICON_SIZE_PX = 8;
const COLUMN_STEERING_BADGE_RIGHT_OUTSET_PX = 2;
const COLUMN_STEERING_BADGE_BOTTOM_OVERLAP_PX = 4;

function getStorylineSoftSteeringPalette(kind: SoftSteeringKind): {
  fill: string;
  stroke: string;
  icon: string;
} {
  if (kind === 'ignore') {
    return {
      fill: '#fff1f2',
      stroke: '#fda4af',
      icon: '#be123c',
    };
  }
  if (kind === 'elaborate') {
    return {
      fill: '#eff6ff',
      stroke: '#93c5fd',
      icon: '#1d4ed8',
    };
  }
  return {
    fill: '#fffbeb',
    stroke: '#fcd34d',
    icon: '#b45309',
  };
}

function renderIcon(kind: SoftSteeringKind) {
  if (kind === 'ignore') {
    return (
      <>
        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
        <line x1="2" x2="22" y1="2" y2="22" />
      </>
    );
  }
  if (kind === 'elaborate') {
    return (
      <>
        <circle cx="11" cy="11" r="7" />
        <line x1="20" x2="16.65" y1="20" y2="16.65" />
        <line x1="11" x2="11" y1="8" y2="14" />
        <line x1="8" x2="14" y1="11" y2="11" />
      </>
    );
  }
  return (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="22" x2="18" y1="12" y2="12" />
      <line x1="6" x2="2" y1="12" y2="12" />
      <line x1="12" x2="12" y1="6" y2="2" />
      <line x1="12" x2="12" y1="22" y2="18" />
    </>
  );
}

function resolveBadgeOrigin(
  anchorX: number,
  anchorY: number,
  scope: 'summary' | 'atomic' | 'column'
): {
  badgeLeft: number;
  badgeTop: number;
} {
  if (scope === 'column') {
    return {
      badgeLeft:
        anchorX
        - STORYLINE_SOFT_STEERING_BADGE_SIZE_PX
        + COLUMN_STEERING_BADGE_RIGHT_OUTSET_PX,
      badgeTop:
        anchorY
        - STORYLINE_SOFT_STEERING_BADGE_SIZE_PX
        + COLUMN_STEERING_BADGE_BOTTOM_OVERLAP_PX,
    };
  }
  return {
    badgeLeft: anchorX - STORYLINE_SOFT_STEERING_BADGE_SIZE_PX,
    badgeTop: anchorY - STORYLINE_SOFT_STEERING_BADGE_SIZE_PX,
  };
}

export function resolveStorylineSoftSteeringBadgeBounds(args: {
  anchorX: number;
  anchorY: number;
  scope: 'summary' | 'atomic' | 'column';
  paddingPx?: number;
}): {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
} {
  const { anchorX, anchorY, scope, paddingPx = 0 } = args;
  const { badgeLeft, badgeTop } = resolveBadgeOrigin(anchorX, anchorY, scope);
  return {
    x: badgeLeft - paddingPx,
    y: badgeTop - paddingPx,
    width: STORYLINE_SOFT_STEERING_BADGE_SIZE_PX + paddingPx * 2,
    height: STORYLINE_SOFT_STEERING_BADGE_SIZE_PX + paddingPx * 2,
    rx: STORYLINE_SOFT_STEERING_BADGE_SIZE_PX / 2 + paddingPx,
  };
}

export default function StorylineSoftSteeringIcon({
  kind,
  anchorX,
  anchorY,
  scope,
}: {
  kind: SoftSteeringKind;
  anchorX: number;
  anchorY: number;
  scope: 'summary' | 'atomic' | 'column';
}) {
  const palette = getStorylineSoftSteeringPalette(kind);
  const { x: badgeLeft, y: badgeTop } = resolveStorylineSoftSteeringBadgeBounds({
    anchorX,
    anchorY,
    scope,
  });
  const iconOffset = (STORYLINE_SOFT_STEERING_BADGE_SIZE_PX - STORYLINE_SOFT_STEERING_ICON_SIZE_PX) / 2;

  return (
    <g
      pointerEvents="none"
      data-storyline-soft-steering-icon={kind}
      data-storyline-soft-steering-scope={scope}
    >
      <rect
        x={badgeLeft}
        y={badgeTop}
        width={STORYLINE_SOFT_STEERING_BADGE_SIZE_PX}
        height={STORYLINE_SOFT_STEERING_BADGE_SIZE_PX}
        rx={STORYLINE_SOFT_STEERING_BADGE_SIZE_PX / 2}
        fill={palette.fill}
        stroke={palette.stroke}
        strokeWidth={0.9}
      />
      <svg
        x={badgeLeft + iconOffset}
        y={badgeTop + iconOffset}
        width={STORYLINE_SOFT_STEERING_ICON_SIZE_PX}
        height={STORYLINE_SOFT_STEERING_ICON_SIZE_PX}
        viewBox="0 0 24 24"
        fill="none"
        stroke={palette.icon}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {renderIcon(kind)}
      </svg>
    </g>
  );
}
