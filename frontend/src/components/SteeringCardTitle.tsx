import {
  Crosshair,
  EyeOff,
  Plus,
  Search,
  type LucideIcon,
} from 'lucide-react';

import { getSteeringActionDisplayLabel } from '@/steering/kinds';
import type { SteeringActionKind } from '@/types';

interface SteeringCardTitleMeta {
  label: ReturnType<typeof getSteeringActionDisplayLabel>;
  icon: LucideIcon;
  iconContainerClassName: string;
  textClassName: string;
}

function joinClasses(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function getSteeringCardTitleMeta(kind: SteeringActionKind): SteeringCardTitleMeta {
  if (kind === 'ignore') {
    return {
      label: getSteeringActionDisplayLabel('ignore'),
      icon: EyeOff,
      iconContainerClassName: 'border-rose-200 bg-rose-100 text-rose-700',
      textClassName: 'text-rose-700',
    };
  }
  if (kind === 'elaborate') {
    return {
      label: getSteeringActionDisplayLabel('elaborate'),
      icon: Search,
      iconContainerClassName: 'border-sky-200 bg-sky-100 text-sky-700',
      textClassName: 'text-sky-700',
    };
  }
  if (kind === 'create') {
    return {
      label: getSteeringActionDisplayLabel('create'),
      icon: Plus,
      iconContainerClassName: 'border-emerald-200 bg-emerald-100 text-emerald-700',
      textClassName: 'text-emerald-700',
    };
  }
  return {
    label: getSteeringActionDisplayLabel('focus'),
    icon: Crosshair,
    iconContainerClassName: 'border-amber-200 bg-amber-100 text-amber-700',
    textClassName: 'text-amber-700',
  };
}

export default function SteeringCardTitle({
  kind,
  variant = 'card',
  className,
}: {
  kind: SteeringActionKind;
  variant?: 'card' | 'popover';
  className?: string;
}) {
  const meta = getSteeringCardTitleMeta(kind);
  const Icon = meta.icon;
  const isPopoverVariant = variant === 'popover';

  return (
    <span
      data-steering-card-title-kind={kind}
      className={joinClasses(
        'inline-flex items-center font-semibold',
        isPopoverVariant
          ? 'gap-1.5 text-[11px] uppercase tracking-[0.18em]'
          : 'gap-2 text-sm',
        meta.textClassName,
        className
      )}
    >
      <span
        data-steering-card-title-icon={kind}
        className={joinClasses(
          'inline-flex items-center justify-center rounded-full border',
          isPopoverVariant ? 'h-5 w-5' : 'h-6 w-6',
          meta.iconContainerClassName
        )}
      >
        <Icon className={isPopoverVariant ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      </span>
      <span>{meta.label}</span>
    </span>
  );
}
