/**
 * THE GENERIC ENTITY PAGE (CONTRACT §5 ruling 7, owner 2026-10-18).
 *
 * The phone's v1 screens are chat, doc, task, work_session and artifact. Every
 * other kind opens THIS: what the entity is, what it says, what it links to and
 * what was said about it — and every linked thing is one tap from its own page.
 * It replaces the "no phone screen" toast (audit E3), which told the reader
 * there was nowhere to go after they had already asked to go there.
 *
 * Deliberately read-only and registry-blind. A kind that needs verbs keeps
 * them on the entity's action button (EntityFab) where the host has one; a
 * kind that needs a real arrangement earns a v1 screen after a real-phone pass.
 */
import type { ReactNode } from 'react';
import type { Connections, EdgeView, EntityDetail, EntitySummary, MessageView } from '@tm8/contract';
import { KindIcon, getKind } from '../domain';
import { phoneTime, tintOf } from '../mobile-lists/phone-row';
import '../mobile-lists/phone-list.css';
import { PhoneMessages } from './PhoneMessages';
import './phone-page.css';

/** The kinds with a real phone screen in v1 (ruling 7). Everything else is generic. */
export const PHONE_SCREEN_KINDS: ReadonlySet<string> = new Set(['chat', 'doc', 'task', 'work_session', 'artifact']);

/** Pages whose Messages section sits below the body (ruling 8); others list them under Linked. */
export const MESSAGES_ON_PAGE: ReadonlySet<string> = new Set(['task', 'doc', 'work_session']);

export function hasPhoneScreen(kind: string): boolean {
  return PHONE_SCREEN_KINDS.has(kind);
}

export interface PhoneEntityPageProps {
  /** Null while the read is in flight. */
  detail: EntityDetail | null | undefined;
  connections?: Connections | undefined;
  messages?: readonly MessageView[] | undefined;
  /** Push a linked entity's page — `openEntityOnPhone`. */
  onOpenEntity: (id: string, kind: string) => void;
  /** Opens the full discussion; absent ⇒ every loaded message is listed. */
  onViewAllMessages?: () => void;
}

/** The text an entity says about itself, whatever its content shape calls it. */
export function bodyTextOf(detail: EntityDetail): string {
  const content = detail.content as unknown as Record<string, unknown> | null;
  for (const key of ['body', 'description', 'summary', 'text']) {
    const value = content?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return detail.excerpt ?? '';
}

interface LinkGroup {
  readonly label: string;
  readonly items: readonly EntitySummary[];
}

/** Edge groups → the OTHER end of each edge, grouped by the group's label. */
export function linkGroupsOf(connections: Connections | undefined): LinkGroup[] {
  if (!connections) return [];
  const groups = [...connections.outgoing, ...connections.incoming];
  const out: LinkGroup[] = [];
  for (const group of groups) {
    const items = group.edges
      .map((edge: EdgeView) => (group.direction === 'outgoing' ? edge.target : edge.source))
      .filter((other) => !other.deletedAt && other.kind !== 'message');
    if (items.length > 0) out.push({ label: group.label, items });
  }
  return out;
}

export function PhoneEntityPage(props: PhoneEntityPageProps): ReactNode {
  const { detail } = props;
  if (!detail) {
    return (
      <div className="pp" data-testid="phone-entity-page" aria-busy="true">
        <div className="pp-hero">
          <span className="pp-sk pp-sk--eyebrow" />
          <span className="pp-sk pp-sk--title" />
          <span className="pp-sk pp-sk--line" />
        </div>
      </div>
    );
  }
  const config = getKind(detail.kind);
  const now = Date.now();
  const body = bodyTextOf(detail);
  const groups = linkGroupsOf(props.connections ?? detail.connections);
  const author = detail.createdBy?.displayName;
  return (
    <article className="pp" data-testid="phone-entity-page" data-kind={detail.kind}>
      <header className="pp-hero">
        <span className="pp-eyebrow">
          <KindIcon kind={detail.kind} size={14} />
          {config.label}
        </span>
        <h1 className="pp-title">{detail.title || 'Untitled'}</h1>
        <p className="pp-meta">
          {author ? <span>{author}</span> : null}
          <span>
            updated <time dateTime={detail.updatedAt}>{phoneTime(detail.updatedAt, now)}</time>
          </span>
        </p>
      </header>
      {body ? <div className="pp-body">{body}</div> : null}
      <section className="pp-sec" aria-label="Linked" data-testid="phone-linked">
        <h2 className="pp-sec__h">Linked</h2>
        {groups.length === 0 ? (
          <p className="pp-quiet">Nothing linked.</p>
        ) : (
          groups.map((group, gi) => (
            <div key={`${group.label}:${gi}`} className="pp-grp">
              <h3 className="pp-grp__h">{group.label}</h3>
              <ul className="pp-links">
                {group.items.map((item) => {
                  /* An edge's endpoint is a summary whose state may be partial,
                     so the row reads only the facts every summary carries. */
                  const at = item.activityAt || item.updatedAt;
                  const time = phoneTime(at, now);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="pl-r pp-link"
                        data-testid="phone-linked-row"
                        onClick={() => props.onOpenEntity(item.id, item.kind)}
                      >
                        <span className={`pl-g pl-g--${tintOf(item.kind)}`} aria-hidden>
                          <KindIcon kind={item.kind} size={18} />
                        </span>
                        <span className="pl-b">
                          <span className="pl-l1">
                            <span className="pl-t">{item.title || 'Untitled'}</span>
                            {time ? (
                              <time className="pl-tm" dateTime={at}>
                                {time}
                              </time>
                            ) : null}
                          </span>
                          <span className="pl-l2">
                            <span className="pl-meta">{getKind(item.kind).label}</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </section>
      {/* Other kinds list messages UNDER Linked (ruling 8). */}
      <PhoneMessages
        messages={props.messages}
        {...(props.onViewAllMessages ? { onViewAll: props.onViewAllMessages } : {})}
      />
    </article>
  );
}
