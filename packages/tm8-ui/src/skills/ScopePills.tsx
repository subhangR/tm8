import { Pill } from '../kit/Pill';
import type { SkillScopeView } from './scope';

/** Level and provider as two small pills; the full location rides the tooltip. */
export function ScopePills({ scope }: { scope: SkillScopeView | null }) {
  if (!scope || (!scope.level && !scope.provider)) return null;
  const title = [scope.provider, scope.level, scope.where].filter(Boolean).join(' · ');
  return <span className="sk-scope" title={title}>
    {scope.level && <Pill tone="info">{scope.level}</Pill>}
    {scope.provider && <Pill tone="idle">{scope.provider}</Pill>}
  </span>;
}
