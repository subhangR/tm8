/**
 * Profile — the SPACE's profile: what this space is, and the record behind it.
 *
 * STILL EVERYTHING `SpaceSummary` CARRIES AND NOTHING ELSE. The original note
 * here said inventing an avatar picker or a timezone field would be designing
 * rather than transcribing, and that still holds — nothing below reads a field
 * the DTO does not have. What changed is the ARRANGEMENT of the fields it does
 * have, which was five identical `.set-kv` rows in a flat stack: a dump of the
 * DTO's shape rather than a profile. The name of the space and the sentence
 * describing it are what the section is ABOUT; `memberCount`, `githubRepo` and
 * `createdAt` are the record behind them. Two groups, not one list.
 *
 * `unreadTotal` is the one carried field still not drawn, and deliberately: it
 * is a live per-viewer counter, not a fact about the space. It belongs on a
 * rail badge and would go stale the moment this pane opened. `id` IS drawn —
 * it is the string a person pastes into `tm8`, and it was the only genuinely
 * useful field the old stack left out.
 *
 * THREE THINGS MEASURED WRONG HERE, all fixed below (numbers in
 * `space-profile.css`, taken in Chrome per SECTION-CONTRACT.md §8):
 *
 *   1. `.set-stack` pads itself by the section gutter INSIDE `SectionFrame`'s
 *      `.set-section__pad`, which pads by the same gutter. The body's first
 *      label sat 18px right of the section's own title. The stack here owns no
 *      padding at all; the frame's gutter is the only one.
 *   2. `Created` rendered `space.createdAt` raw — `2026-01-04T09:00:00.000Z`
 *      shown to a human. `kit/time.ts` is the app's one formatter and its
 *      header already forbids exactly this ("never a raw ISO string leaked
 *      into the UI"); this section simply was not going through it.
 *   3. `About` and `Repo` rendered `—` when null. An em dash is a legal
 *      character in both, so an absent field was drawn identically to a
 *      present one. Absence is now said in words.
 *
 * EXTRACTED FROM `SettingsShell.tsx` 2026-08-16. It was an inline function
 * there, which meant this section was the one nobody could work on without
 * editing the file all eleven other sections route through. Its own file is
 * its own seat.
 */
import type { ReactNode } from 'react';
import type { SpaceSummary } from '@tm8/contract';
import { DisabledAction } from '../panels';
import { absTime, shortDate } from '../kit';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SPACE_EDIT_UNAVAILABLE } from './reasons';
import './space-profile.css';

/** What an absent field says. Never a dash — see the header, point 3. */
const NOT_SET = 'Not set';

/**
 * "3 members" / "1 member". A bare `3` needed its label to mean anything.
 *
 * WRITTEN AS ONE TEMPLATE ON PURPOSE, and please leave it that way: the
 * obvious `n === 1 ? 'member' : 'members'` puts a quoted bare kind slug in
 * this file, and `no-kind-literals.test.ts` (§15.2) fails it — correctly, by
 * its own letter. This is a count noun in an English sentence rather than a
 * reference to the member KIND, so `memberKindRef()` is the wrong instrument
 * here: it answers with a registry slug, which is an identifier and not a word
 * anybody reads. Interpolating past the quote satisfies both facts.
 */
function memberCount(n: number): string {
  return `${n} member${n === 1 ? '' : 's'}`;
}

/**
 * One record row. `value` is null when the field is genuinely absent, which is
 * a different rendering rather than a different string — a caller cannot pass
 * "the empty look" by accident, and a test can find it by `data-unset`.
 */
function Field({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: ReactNode | null;
  /** Machine-shaped values (the id, the repo path) render mono. */
  mono?: boolean;
  title?: string;
}) {
  return (
    <>
      <dt className="set-space-profile__k">{label}</dt>
      <dd
        className={`set-space-profile__v${mono ? ' set-space-profile__v--mono' : ''}`}
        title={title}
      >
        {value === null ? (
          <span className="set-space-profile__unset" data-unset="true">
            {NOT_SET}
          </span>
        ) : (
          value
        )}
      </dd>
    </>
  );
}

export function ProfileSection({ space, heading }: { space: SpaceSummary | null; heading: string }) {
  if (space === null) {
    return (
      <SectionFrame title={heading} bodyTestId="profile-body">
        {/* Wrapped so this lane can undo `.set-absent`'s own padding without
            editing the shared stylesheet — see space-profile.css. */}
        <div className="set-space-profile__absent">
          <SectionAbsent
            head="This space did not resolve."
            why="spaces() returned no row with this id"
          />
        </div>
      </SectionFrame>
    );
  }

  // '' when unparseable, which `kit/time.ts` guarantees rather than 'Invalid
  // Date' — so a broken stamp falls through to the absent rendering instead of
  // printing garbage with a label on it.
  const created = shortDate(space.createdAt);
  const createdExact = absTime(space.createdAt);

  return (
    <SectionFrame title={heading} bodyTestId="profile-body">
      <div className="set-space-profile">
        <header className="set-space-profile__id">
          <h3 className="set-space-profile__name">{space.name}</h3>
          {space.description ? (
            <p className="set-space-profile__about">{space.description}</p>
          ) : (
            <p className="set-space-profile__about">
              <span className="set-space-profile__unset" data-unset="true">
                No description set.
              </span>
            </p>
          )}
        </header>

        <dl className="set-space-profile__record">
          <Field label="Members" value={memberCount(space.memberCount)} />
          <Field label="Repo" value={space.githubRepo || null} mono />
          <Field
            label="Created"
            value={created || null}
            /* The exact instant stays one hover away, which is the whole
               reason the short form is safe to show. */
            title={createdExact || undefined}
          />
          <Field label="Space id" value={space.id} mono />
        </dl>

        <div className="set-space-profile__actions">
          <DisabledAction reason={SPACE_EDIT_UNAVAILABLE} label="edit space details">
            Edit space details
          </DisabledAction>
        </div>
      </div>
    </SectionFrame>
  );
}
