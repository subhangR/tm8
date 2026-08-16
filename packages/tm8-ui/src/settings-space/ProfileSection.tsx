/**
 * Profile — everything `SpaceSummary` actually carries, and NOTHING ELSE. The
 * oracle never draws this section's body, so there is no canvas to transcribe;
 * inventing an avatar picker and a timezone field would be designing rather
 * than transcribing. Four real facts beat four plausible ones.
 *
 * EXTRACTED FROM `SettingsShell.tsx` 2026-08-16. It was an inline function
 * there, which meant this section was the one nobody could work on without
 * editing the file all eleven other sections route through. Its own file is
 * its own seat.
 */
import type { SpaceSummary } from '@tm8/contract';
import { DisabledAction } from '../panels';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SPACE_EDIT_UNAVAILABLE } from './reasons';

export function ProfileSection({ space, heading }: { space: SpaceSummary | null; heading: string }) {
  return (
    <SectionFrame title={heading} bodyTestId="profile-body">
      {space === null ? (
        <SectionAbsent
          head="This space did not resolve."
          why="spaces() returned no row with this id"
        />
      ) : (
        <div className="set-stack">
          <div className="set-kv">
            <span className="set-kv__k">Name</span>
            <span className="set-kv__v">{space.name}</span>
          </div>
          <div className="set-kv">
            <span className="set-kv__k">About</span>
            <span className="set-kv__v">{space.description || '—'}</span>
          </div>
          <div className="set-kv">
            <span className="set-kv__k">Members</span>
            <span className="set-kv__v">{space.memberCount}</span>
          </div>
          <div className="set-kv">
            <span className="set-kv__k">Repo</span>
            <span className="set-kv__v">{space.githubRepo || '—'}</span>
          </div>
          <div className="set-kv">
            <span className="set-kv__k">Created</span>
            <span className="set-kv__v">{space.createdAt}</span>
          </div>
          <div style={{ paddingTop: 8 }}>
            <DisabledAction reason={SPACE_EDIT_UNAVAILABLE} label="edit space details">
              Edit space details
            </DisabledAction>
          </div>
        </div>
      )}
    </SectionFrame>
  );
}
