'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  AI_HUB_RAIL_GROUPS,
  AI_HUB_SECTION_META,
  AI_HUB_SECTIONS,
  type AiHubSection,
} from './ai-hub-sections';

const RAIL_DESKTOP_MIN_PX = 1024;

/**
 * Secondary vertical navigation rail for the unified AI Central.
 *
 * Visually aligned with `SettingsRail` (`src/components/settings/settings-rail.tsx`):
 * vertical sticky column on desktop (`lg+`), horizontally scrollable bar with
 * active-item auto-scroll on narrow viewports.
 */
export function AiHubRail({
  active,
  onSelect,
  canAccessInfrastructure,
  hints,
}: {
  active: AiHubSection;
  onSelect: (section: AiHubSection) => void;
  canAccessInfrastructure: boolean;
  hints?: Partial<Record<AiHubSection, ReactNode>>;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia(`(min-width: ${RAIL_DESKTOP_MIN_PX}px)`).matches) return;
    activeRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [active]);

  const visibleGroups = AI_HUB_RAIL_GROUPS.filter(
    (g) => !g.adminOnly || canAccessInfrastructure,
  );

  return (
    <nav
      aria-label="Seções da Central de IA"
      className={cn(
        'flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'border-b border-border',
        'lg:sticky lg:top-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0',
      )}
    >
      {visibleGroups.map(({ group, label }, groupIdx) => {
        const items = AI_HUB_SECTIONS.filter(
          (id) =>
            AI_HUB_SECTION_META[id].group === group &&
            (!AI_HUB_SECTION_META[id].adminOnly || canAccessInfrastructure),
        );
        if (items.length === 0) return null;

        return (
          <div
            key={group}
            className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5"
          >
            <div
              className={cn(
                'hidden px-3 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase lg:block',
                groupIdx === 0 ? 'pt-0.5' : 'pt-4',
              )}
            >
              {label}
            </div>
            {items.map((id) => {
              const meta = AI_HUB_SECTION_META[id];
              const Icon = meta.icon;
              const isActive = id === active;
              return (
                <button
                  key={id}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => onSelect(id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors',
                    'lg:w-full',
                    isActive
                      ? 'bg-primary-soft text-primary-on-soft'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1">{meta.label}</span>
                  {hints?.[id] != null ? (
                    <span
                      className={cn(
                        'hidden items-center gap-1.5 text-xs lg:inline-flex',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {hints[id]}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
