import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { LaunchModelEffort } from '@tm8/contract';

import {
  ACCESS_MODE_CYCLE,
  ADDITIONAL_PROJECTS_UNAVAILABLE_REASON,
  agentTool,
  describeAccessMode,
  describeCapacity,
  effortLabel,
  LAUNCH_MODES,
  type LaunchAccessMode,
  type LaunchCapacity,
  type LaunchCredentialSource,
  type LaunchMode,
  type LaunchTeammate,
  type WorkdirMode,
} from '../domain/launch';
import { Avatar } from '../kit';
import type { ComposerWorkdir } from './NewSessionComposer';
import { TITLE_MAX } from './prompt-title';
import './launch-card.css';

/**
 * THE LAUNCH CARD — v2 (artifact 01a0dd42 rev 4, owner-approved 2026-09-26).
 *
 * The Run/Coordinate popup's body. Two border bands hold every option and the
 * center between them is for writing:
 *
 *   TOP BAND     who and where — verb, teammate │ project, checkout · slots ⋯ ✕
 *   CENTER       "Starts with" row · session title · instructions · attach row
 *   BOTTOM BAND  how it runs, then go — model, effort, access · summary · Launch
 *
 * The rarely-touched knobs (session mode, profile, credentials, harness,
 * plugins, extra projects, budget) live in the ADVANCED DRAWER over the right
 * edge of the center, toggled by ⋯ or ⌘. — not in a submenu.
 *
 * SIZED OFF ITS HOST, NOT THE VIEWPORT. The card's width and height are
 * container units of the popup layer (`container-type: size`), which is
 * `position: fixed; inset: 0` — so it is 80% × 82% of whatever the viewer
 * sees, whatever zoom `.cv2-root` carries. `vw`/`vh` inside a zoomed ancestor
 * would multiply by that zoom.
 *
 * NARROW WIDTHS SHED TEXT, NEVER CONTROLS. The card is itself a container
 * (`card`), and `launch-card.css` drops labels in steps at 1120 / 820 / 680 /
 * 560px of CARD width. Every dropped label is still the control's tooltip.
 *
 * WHY NOT `NewSessionComposer`. That card is also the create screen's, where
 * the prompt BECOMES the task. Here the textarea is instructions for one
 * launch and the task is edited from its chip, so the two surfaces now differ
 * in meaning, not only in layout; the create screen keeps its composer
 * untouched. What is shared is the state hook (`useLaunchComposerState`),
 * which keeps the two configs from drifting into different spawn semantics.
 *
 * PROPS-ONLY, NO STORE, like the composer: it renders in a test and a gallery
 * without a node. It owns only which menu is open and whether the drawer is.
 */

/** One row of the attach row's scroller: an entity or an upload. */
export interface LaunchCardAttachment {
  /** The entity id, or an upload's local key until it has one. */
  key: string;
  kind: string;
  title: string;
  /** The quiet fact after the title — a size, the kind. */
  meta?: string;
  status?: 'uploading' | 'failed';
  /** A failed upload's reason, as its tooltip. */
  error?: string;
}

/** One row of the attach menu's list. */
export interface LaunchCardCandidate {
  id: string;
  kind: string;
  title: string;
  /** `default`: the launch already carries it, so there is nothing to attach. */
  state: 'attachable' | 'attached' | 'default';
}

export interface LaunchCardModel {
  id: string;
  label: string;
  note?: string;
  /** Who serves it — the menu's group. */
  provider?: string;
  /** Which harness runs it — the group's "via …" and the control's meta. */
  agentTool?: string;
}

export interface LaunchCardProps {
  /** The opening verb's word: Run, Coordinate. */
  verbLabel: string;

  /* ---- top band ---- */
  teammates: readonly LaunchTeammate[];
  teammateId: string | null;
  onPickTeammate(id: string | null): void;
  /** "Remember picks for this teammate" — the box and what it restored. */
  remember: boolean;
  onRememberChange(next: boolean): void;
  restoredLine: string | null;

  workdirs: readonly ComposerWorkdir[];
  workdirId: string;
  onPickWorkdir(id: string): void;
  workdirMode: WorkdirMode;
  onWorkdirModeChange(next: WorkdirMode): void;
  workdirChoosable: boolean;
  worktreeBaseRef: string | null;
  onWorktreeBaseRefChange(next: string | null): void;
  /**
   * The project's branch and uncommitted count, when a host knows them. No
   * launch source carries either today, so both render only when supplied.
   */
  projectFacts?: { branch?: string | null; uncommitted?: number | null } | null;
  capacity?: LaunchCapacity;
  onClose(): void;

  /* ---- center ---- */
  /** The "Starts with" row's controls: context chips, Ask Jev, the meter. */
  startsWith: ReactNode;
  title: string;
  onTitleChange(next: string): void;
  titlePlaceholder: string;
  instructions: string;
  onInstructionsChange(next: string): void;
  instructionsPlaceholder: string;

  subject: { title: string; kind?: string };
  /** True for a session subject: continued, never edited (migration 200). */
  continuing: boolean;
  /** The subject's description; `null` while it is being read. */
  description: string | null;
  onDescriptionChange(next: string): void;
  /** Why the description cannot be edited here, when it cannot. */
  descriptionReadOnly: string | null;

  attachments: readonly LaunchCardAttachment[];
  onDetach(key: string): void;
  /** Undefined: the space's attachables were never read into this client. */
  candidates: readonly LaunchCardCandidate[] | undefined;
  onToggleCandidate(id: string): void;
  /** Why nothing can be attached right now (defaults unread, locked group). */
  attachRefusal: string | null;
  /** Absent: this host has no upload path, and the Files row says so. */
  onFiles?(files: readonly File[]): void;
  /** The attach menu opened: a host may read its pool in now. */
  onAttachOpen?(): void;

  /* ---- bottom band ---- */
  models: readonly LaunchCardModel[];
  model: string | null;
  onPickModel(id: string): void;
  effortStops: readonly LaunchModelEffort[];
  effort: LaunchModelEffort | null;
  onEffortChange(next: LaunchModelEffort | null): void;
  accessMode: LaunchAccessMode | null;
  onAccessModeChange(next: LaunchAccessMode): void;
  /** One line: what Launch will start, where. */
  summary: ReactNode;
  summaryText: string;
  /** Present ⇒ a Dispatch button; absent ⇒ none (pending the owner's call). */
  onDispatch?(): void;
  onSubmit(): void;
  busy: boolean;
  /** Launch is withheld WITH this reason. */
  refusal: string | null;
  /** A previous attempt's reason, shown without withholding Launch. */
  notice: string | null;
  shaking: boolean;
  onShakeEnd(): void;

  /* ---- advanced drawer ---- */
  mode: LaunchMode;
  onModeChange(next: LaunchMode): void;
  /** The resolved Interaction Profile and where it came from, when known. */
  profileLine: string | null;
  credentialProviderLabel: string | null;
  credential: LaunchCredentialSource | null;
  onCredentialChange(next: LaunchCredentialSource | null): void;
  githubCredential: LaunchCredentialSource | null;
  onGithubCredentialChange(next: LaunchCredentialSource | null): void;
  harnessApplies: boolean;
  harnessSurface: 'minimal' | 'inherit' | null;
  onHarnessChange?(next: 'minimal' | 'inherit' | null): void;
  installedPlugins: readonly string[] | null;
  installedPluginsNote: string | null;
  pluginSkillCounts: Readonly<Record<string, number>> | null;
  plugins: readonly string[] | null;
  onPluginsChange?(next: readonly string[] | null): void;
  /** The per-launch budget override. */
  budget: ReactNode;
  /** A dot on ⋯: something in the drawer is not its default. */
  advancedEdited: boolean;
}

type MenuName = 'team' | 'project' | 'checkout' | 'model' | 'effort' | 'access' | 'attach' | 'subject';

/** The session modes a fresh launch can take — see `NewSessionComposer`'s note. */
const MODE_OPTIONS = LAUNCH_MODES.filter((m) => m.id === 'worker' || m.id === 'coordinator');

/** The five postures, most permissive first — the mock's order. */
const ACCESS_OPTIONS = ACCESS_MODE_CYCLE.filter((m): m is LaunchAccessMode => m !== null).slice().reverse();

const CREDENTIAL_OPTIONS: readonly { value: LaunchCredentialSource | null; label: string }[] = [
  { value: null, label: 'Auto · mine if connected, else the space’s, else the node’s' },
  { value: 'member', label: 'Mine · refuse if I have not connected it' },
  { value: 'node', label: 'Node’s · this server’s account' },
];

const HARNESS_OPTIONS: readonly { value: 'minimal' | 'inherit' | null; label: string; hint: string }[] = [
  { value: null, label: 'Teammate default', hint: 'Whatever this teammate is configured for' },
  { value: 'minimal', label: 'Lean', hint: 'Repo skills, equipped skills and chosen plugins only · no claude.ai connectors' },
  { value: 'inherit', label: 'Full', hint: 'Every plugin, connector and skill the account has installed' },
];

const PROVIDER_WORD: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  moonshot: 'Moonshot AI',
  groq: 'Groq',
  custom: 'Added in this browser',
};

const KIND_GLYPH: Readonly<Record<string, string>> = {
  task: '▣',
  doc: '☰',
  artifact: '◇',
  drawing: '✎',
  file: '📄',
  work_session: '◉',
};

/** The first word of a model label that only repeats its vendor. */
const VENDOR_PREFIX = /^(Claude|OpenAI) /;

/** The posture's name and its sentence, from the domain's one spelling. */
function accessWords(mode: LaunchAccessMode | null): { name: string; hint: string } {
  const [name = '', hint = ''] = describeAccessMode(mode).split(' · ');
  return { name, hint };
}

export const EFFORT_NOT_TUNABLE_REASON =
  'This model takes no reasoning-effort setting, so there is no stop to pick.';

const NO_UPLOAD_REASON = 'This surface has no upload path, so files cannot be attached here.';

/**
 * KEEP AN OPEN MENU INSIDE THE CARD — the mock's `fit()`: flip it onto the
 * trigger's right edge when it would pass the card's right side, then shift it
 * right if that pushed it past the left.
 *
 * `scale` converts the rects' visual pixels into the menu's own CSS pixels:
 * `.cv2-root` carries a CSS zoom, and a `left` written in unzoomed pixels from
 * zoomed measurements would overshoot by exactly that zoom.
 */
function useFitInside(menu: RefObject<HTMLElement | null>, card: RefObject<HTMLElement | null>, key: string | null) {
  useLayoutEffect(() => {
    const m = menu.current;
    const c = card.current;
    if (!key || !m || !c) return;
    m.style.left = '';
    m.style.right = '';
    const pad = 8;
    const bounds = c.getBoundingClientRect();
    let rect = m.getBoundingClientRect();
    if (rect.width === 0) return; // not laid out (jsdom): nothing to fit
    const scale = m.offsetWidth > 0 ? m.offsetWidth / rect.width : 1;
    if (rect.right > bounds.right - pad) {
      m.style.left = 'auto';
      m.style.right = '0';
      rect = m.getBoundingClientRect();
    }
    if (rect.left < bounds.left + pad) {
      const anchor = m.parentElement?.getBoundingClientRect();
      if (anchor) {
        m.style.right = 'auto';
        m.style.left = `${(bounds.left + pad - anchor.left) * scale}px`;
      }
    }
  }, [menu, card, key]);
}

function Caret({ up }: { up?: boolean }) {
  return <span className="lcd-caret" aria-hidden="true">{up ? '▲' : '▼'}</span>;
}

export function LaunchCard(props: LaunchCardProps) {
  const {
    verbLabel, teammates, teammateId, onPickTeammate, remember, onRememberChange, restoredLine,
    workdirs, workdirId, onPickWorkdir, workdirMode, onWorkdirModeChange, workdirChoosable,
    worktreeBaseRef, onWorktreeBaseRefChange, projectFacts, capacity, onClose,
    startsWith, title, onTitleChange, titlePlaceholder, instructions, onInstructionsChange, instructionsPlaceholder,
    subject, continuing, description, onDescriptionChange, descriptionReadOnly,
    attachments, onDetach, candidates, onToggleCandidate, attachRefusal, onFiles, onAttachOpen,
    models, model, onPickModel, effortStops, effort, onEffortChange, accessMode, onAccessModeChange,
    summary, summaryText, onDispatch, onSubmit, busy, refusal, notice, shaking, onShakeEnd,
    mode, onModeChange, profileLine, credentialProviderLabel, credential, onCredentialChange,
    githubCredential, onGithubCredentialChange, harnessApplies, harnessSurface, onHarnessChange,
    installedPlugins, installedPluginsNote, pluginSkillCounts, plugins, onPluginsChange, budget, advancedEdited,
  } = props;

  const card = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<MenuName | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [teamQuery, setTeamQuery] = useState('');
  const [attachQuery, setAttachQuery] = useState('');
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const [hidden, setHidden] = useState(0);

  const close = useCallback(() => setOpen(null), []);
  const toggle = (name: MenuName) => setOpen((current) => (current === name ? null : name));
  useFitInside(menuRef, card, open);

  const blocked = busy || Boolean(refusal);
  const submit = () => { if (!blocked) onSubmit(); };

  /* THE KEYBOARD, layered as the mock rules it: Escape closes a menu first,
     then the drawer, then the popup; ⌘. toggles the drawer; ⌘↵ launches.

     CAPTURE PHASE, AND CONSUMED: the popup sits over panels that close on
     Escape themselves (the detail panel does), and a bubble-phase listener
     let one Escape close the menu AND the panel underneath — found live on
     a real node. The one exception is Escape from inside the context
     popover or the Jev panel, which close themselves first. The ref keeps
     one listener for the card's life. */
  const keys = useRef({ open, drawer, submit, onClose });
  keys.current = { open, drawer, submit, onClose };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const k = keys.current;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key === '.') {
        setOpen(null);
        setDrawer((d) => !d);
      } else if (mod && event.key === 'Enter') {
        k.submit();
      } else if (event.key === 'Escape') {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.lsel-popover, .jev-entry__pop')) return;
        if (k.open !== null) setOpen(null);
        else if (k.drawer) setDrawer(false);
        else k.onClose();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* "+N MORE": how many attachment chips sit past the scroller's right edge. */
  const countHidden = useCallback(() => {
    const l = list.current;
    if (!l) return;
    const edge = l.getBoundingClientRect().right - 12;
    setHidden([...l.querySelectorAll('.lcd-ent')].filter((c) => c.getBoundingClientRect().right > edge).length);
  }, []);
  useLayoutEffect(countHidden, [attachments, countHidden]);
  useEffect(() => {
    const l = list.current;
    if (!l || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(countHidden);
    observer.observe(l);
    return () => observer.disconnect();
  }, [countHidden]);

  const stop = (act: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    act();
  };

  const teammate = (teammateId ? teammates.find((t) => t.id === teammateId) : null) ?? teammates[0] ?? null;
  const workdir = workdirs.find((w) => w.id === workdirId) ?? null;
  const scratch = workdirId === 'scratch';
  const current = models.find((m) => m.id === model) ?? null;
  const modelName = current?.label ?? model ?? 'Model';
  const vendor = VENDOR_PREFIX.exec(modelName)?.[0] ?? '';
  const toolWord = current?.agentTool ? agentTool(current.agentTool)?.label ?? current.agentTool : '';
  const access = accessWords(accessMode);
  const uncommitted = projectFacts?.uncommitted ?? null;
  const baseWord = worktreeBaseRef ? worktreeBaseRef : 'node’s base';

  /* The model menu's groups: provider order as the catalog lists it. */
  const groups: { provider: string; rows: LaunchCardModel[] }[] = [];
  for (const m of models) {
    const provider = m.provider ?? 'other';
    const group = groups.find((g) => g.provider === provider);
    if (group) group.rows.push(m);
    else groups.push({ provider, rows: [m] });
  }

  const needle = teamQuery.trim().toLowerCase();
  const roster = needle ? teammates.filter((t) => t.name.toLowerCase().includes(needle)) : teammates;
  const attachNeedle = attachQuery.trim().toLowerCase();
  const pool = (candidates ?? []).filter((c) => !attachNeedle || `${c.title} ${c.kind}`.toLowerCase().includes(attachNeedle));

  const menuProps = (name: MenuName, extra = '') => ({
    ref: menuRef,
    className: `lcd-menu ${extra}`,
    onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
    'data-menu': name,
  });

  const files = (list_: FileList | null) => {
    if (!list_ || list_.length === 0 || !onFiles) return;
    onFiles([...list_]);
  };

  const togglePlugin = (id: string) => {
    const now = plugins ?? [];
    onPluginsChange?.(now.includes(id) ? now.filter((p) => p !== id) : [...now, id].sort());
  };
  const harnessEnabled = harnessApplies && Boolean(onHarnessChange);
  const pluginsEnabled = harnessEnabled && harnessSurface !== 'inherit' && Boolean(onPluginsChange);

  return (
    <div
      ref={card}
      className="lcd"
      data-testid="launch-card"
      data-shake={shaking || undefined}
      data-drop={dropping || undefined}
      data-busy={busy || undefined}
      onAnimationEnd={onShakeEnd}
      onClick={close}
      /* FILES DROP ANYWHERE ON THE CARD. Only a drag that carries files lights
         the target; dragging text within the card is left alone. */
      onDragEnter={(event) => {
        if (!onFiles || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (onFiles && event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={() => {
        if (!dropping) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); }
      }}
      onDrop={(event) => {
        if (!onFiles || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        files(event.dataTransfer.files);
      }}
    >
      {/* ============ TOP BAND: who · where · more ============ */}
      <header className="lcd-band lcd-band--top">
        <span className="lcd-verb" data-testid="lcd-verb">{verbLabel}</span>

        <div className="lcd-anchor lcd-a-tm">
          <button
            type="button"
            className="lcd-tool"
            data-testid="nsx-team"
            aria-haspopup="menu"
            aria-expanded={open === 'team'}
            aria-label={teammate ? `Teammate: ${teammate.name}` : 'Teammate: none on this node'}
            title={restoredLine ? `restored for ${teammate?.name ?? ''}: ${restoredLine}` : teammate?.name}
            onClick={stop(() => { setTeamQuery(''); toggle('team'); })}
          >
            {teammate ? (
              <Avatar actorId={teammate.id} provenance="agent" label={teammate.name} initials={teammate.initial} size={22} />
            ) : null}
            <b>{teammate?.name ?? 'Teammate'}</b>
            <Caret />
          </button>
          {open === 'team' ? (
            <div {...menuProps('team', 'lcd-menu--down lcd-menu--team')} role="menu" data-testid="nsx-team-menu">
              {teammates.length > 6 ? (
                <input
                  className="lcd-search"
                  placeholder="Filter teammates…"
                  aria-label="Filter teammates"
                  value={teamQuery}
                  autoFocus
                  onChange={(event) => setTeamQuery(event.target.value)}
                />
              ) : null}
              <div className="lcd-grp">Teammate</div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={teammateId === null}
                className="lcd-mi"
                onClick={stop(() => { onPickTeammate(null); close(); })}
              >
                <span className="lcd-ck" aria-hidden="true">{teammateId === null ? '✓' : ''}</span>
                <span className="lcd-auto" aria-hidden="true">A</span>
                <span className="lcd-mi__body">
                  Auto
                  <span className="lcd-mi__sub">
                    {teammates[0] ? `pick for me · currently ${teammates[0].name}` : 'pick for me — no teammates on this node yet'}
                  </span>
                </span>
              </button>
              {roster.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={teammateId === t.id}
                  className="lcd-mi"
                  onClick={stop(() => { onPickTeammate(t.id); close(); })}
                >
                  <span className="lcd-ck" aria-hidden="true">{teammateId === t.id ? '✓' : ''}</span>
                  <Avatar actorId={t.id} provenance="agent" label={t.name} initials={t.initial} size={22} />
                  <span className="lcd-mi__body">
                    {t.name}
                    {[t.model, t.agentTool, t.owner ? `owned by ${t.owner}` : null].some(Boolean) ? (
                      <span className="lcd-mi__sub">
                        {[t.model, t.agentTool, t.owner ? `owned by ${t.owner}` : null].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
              {roster.length === 0 && needle ? <div className="lcd-note">Nobody matches “{teamQuery.trim()}”.</div> : null}
              <hr />
              <label className="lcd-foot lcd-foot--check">
                <input
                  type="checkbox"
                  checked={remember}
                  data-testid="lcd-remember"
                  onChange={(event) => onRememberChange(event.target.checked)}
                />
                Remember picks for this teammate
              </label>
              <div className="lcd-foot" data-testid="lcd-restored">
                {restoredLine ? `restored: ${restoredLine}` : 'no saved picks · using the teammate’s defaults'}
              </div>
            </div>
          ) : null}
        </div>

        <span className="lcd-sep" aria-hidden="true" />

        <div className="lcd-anchor lcd-a-pj">
          <button
            type="button"
            className="lcd-tool"
            data-testid="nsx-workdir"
            aria-haspopup="menu"
            aria-expanded={open === 'project'}
            aria-label={`Working directory: ${workdir?.name ?? 'not chosen'}`}
            title={[workdir?.name, projectFacts?.branch, uncommitted ? `${String(uncommitted)} uncommitted` : null].filter(Boolean).join(' · ')}
            onClick={stop(() => toggle('project'))}
          >
            <span className="lcd-pjbadge" aria-hidden="true">{(workdir?.name ?? '?').charAt(0).toLowerCase()}</span>
            <b>{workdir?.name ?? 'Working directory'}</b>
            {projectFacts?.branch && !scratch ? <span className="lcd-branch">⎇ {projectFacts.branch}</span> : null}
            {uncommitted && !scratch && workdirMode !== 'worktree' ? (
              <span className="lcd-dirty">{uncommitted}<span className="lcd-dirty__word"> uncommitted</span></span>
            ) : null}
            <Caret />
          </button>
          {open === 'project' ? (
            <div {...menuProps('project', 'lcd-menu--down lcd-menu--wide')} role="menu" data-testid="nsx-workdir-menu">
              <div className="lcd-grp">Projects in this space</div>
              {workdirs.filter((w) => w.id !== 'scratch').map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={w.id === workdirId}
                  aria-disabled={w.disabledReason ? true : undefined}
                  className="lcd-mi"
                  title={w.disabledReason}
                  onClick={stop(() => {
                    if (w.disabledReason) return;
                    onPickWorkdir(w.id);
                    close();
                  })}
                >
                  <span className="lcd-ck" aria-hidden="true">{w.id === workdirId ? '✓' : ''}</span>
                  <span className="lcd-mi__body">
                    {w.name}
                    {w.disabledReason
                      ? <span className="lcd-mi__why">{w.disabledReason}</span>
                      : w.detail ? <span className="lcd-mi__sub lcd-mono">{w.detail}</span> : null}
                  </span>
                </button>
              ))}
              {workdirs.length <= 1 ? <div className="lcd-note">No project is linked to this space.</div> : null}
              <div className="lcd-grp">No project</div>
              {workdirs.filter((w) => w.id === 'scratch').map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={w.id === workdirId}
                  className="lcd-mi"
                  onClick={stop(() => { onPickWorkdir(w.id); close(); })}
                >
                  <span className="lcd-ck" aria-hidden="true">{w.id === workdirId ? '✓' : ''}</span>
                  <span className="lcd-mi__body">{w.name}<span className="lcd-mi__sub">{w.detail}</span></span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* A scratch session has no checkout, so it has no checkout control. */}
        {workdirChoosable ? (
          <div className="lcd-anchor lcd-a-wt">
            <button
              type="button"
              className="lcd-tool"
              data-testid="nsx-copy"
              aria-haspopup="menu"
              aria-expanded={open === 'checkout'}
              aria-label={workdirMode === 'worktree' ? `Checkout: worktree from ${baseWord}` : 'Checkout: shared'}
              title={workdirMode === 'worktree' ? `Worktree from ${baseWord}` : 'Shared checkout'}
              onClick={stop(() => toggle('checkout'))}
            >
              <span aria-hidden="true">{workdirMode === 'worktree' ? '⑂' : '⌂'}</span>
              <span className="lcd-wt-name">{workdirMode === 'worktree' ? `Worktree · ${baseWord}` : 'Shared checkout'}</span>
              <Caret />
            </button>
            {open === 'checkout' ? (
              <div {...menuProps('checkout', 'lcd-menu--down lcd-menu--wide')} role="menu" data-testid="lcd-checkout-menu">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={workdirMode === 'project'}
                  className="lcd-mi"
                  onClick={stop(() => { onWorkdirModeChange('project'); close(); })}
                >
                  <span className="lcd-ck" aria-hidden="true">{workdirMode === 'project' ? '✓' : ''}</span>
                  <span className="lcd-mi__body">
                    Shared checkout
                    <span className="lcd-mi__sub">runs in the project as it is now · uncommitted changes visible</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={workdirMode === 'worktree'}
                  className="lcd-mi"
                  onClick={stop(() => onWorkdirModeChange('worktree'))}
                >
                  <span className="lcd-ck" aria-hidden="true">{workdirMode === 'worktree' ? '✓' : ''}</span>
                  <span className="lcd-mi__body">
                    Isolate in a worktree
                    <span className="lcd-mi__sub">a new branch nothing else edits</span>
                  </span>
                </button>
                {workdirMode === 'worktree' ? (
                  <label className="lcd-inset">
                    <span>Branch from</span>
                    <input
                      className="lcd-search lcd-mono"
                      data-testid="lcd-base-ref"
                      /* No list of refs is readable here, so the field is typed
                         and empty means the node picks — never a guessed name. */
                      placeholder="the node’s default base"
                      value={worktreeBaseRef ?? ''}
                      onChange={(event) => onWorktreeBaseRefChange(event.target.value.trim() || null)}
                    />
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <span className="lcd-spacer" />
        <span className="lcd-brk" aria-hidden="true" />
        {capacity ? (
          <span className="lcd-node" data-testid="lcd-slots" title={describeCapacity(capacity)}>
            <span className="lcd-dot" data-full={capacity.slotsFree <= 0 || undefined} />
            <span className="lcd-nodename">slots · </span>
            {capacity.slotsTotal - capacity.slotsFree}/{capacity.slotsTotal}
          </span>
        ) : null}
        <button
          type="button"
          className="lcd-icon lcd-i-adv"
          data-testid="lcd-advanced-toggle"
          aria-pressed={drawer}
          aria-label="Advanced settings (⌘.)"
          title="Advanced · ⌘."
          onClick={stop(() => { close(); setDrawer((d) => !d); })}
        >
          ⋯{advancedEdited ? <span className="lcd-badge" aria-label="changed" /> : null}
        </button>
        <button
          type="button"
          className="lcd-icon lcd-i-close"
          data-testid="lcd-close"
          aria-label="Close (esc)"
          title="Close · esc"
          onClick={stop(onClose)}
        >
          ✕
        </button>
      </header>

      {/* ============ CENTER: starts with · writing · attach ============ */}
      <div className="lcd-stage">
        <div className="lcd-center">
          <div className="lcd-ctx" aria-label="What the session starts with" onClick={(event) => event.stopPropagation()}>
            <span className="lcd-lead">Starts with</span>
            {startsWith}
          </div>

          <input
            className="lcd-title"
            data-testid="nsx-title"
            value={title}
            maxLength={TITLE_MAX}
            disabled={busy}
            /* Safari's contacts AutoFill matches a "title" field; see the
               composer's note. The CSS removes its button. */
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            name="tm8-hdr-input"
            aria-label="Session title"
            placeholder={titlePlaceholder || 'Session title'}
            onChange={(event) => onTitleChange(event.target.value)}
          />
          <textarea
            className="lcd-instr"
            data-testid="lcd-instructions"
            value={instructions}
            aria-label="Instructions for this session"
            aria-describedby={refusal || notice ? 'lcd-refusal' : undefined}
            disabled={busy}
            autoFocus
            placeholder={instructionsPlaceholder}
            onChange={(event) => onInstructionsChange(event.target.value)}
          />

          <div className="lcd-attrow" aria-label="Attached">
            <div className="lcd-anchor">
              <button
                type="button"
                className="lcd-attbtn"
                data-testid="lcd-attach"
                aria-haspopup="menu"
                aria-expanded={open === 'attach'}
                aria-label="Attach"
                title="Attach files or anything in this space, as context"
                onClick={stop(() => {
                  setAttachQuery('');
                  if (open !== 'attach') onAttachOpen?.();
                  toggle('attach');
                })}
              >
                📎<span className="lcd-attbtn__label"> Attach</span><Caret up />
              </button>
              {open === 'attach' ? (
                <div {...menuProps('attach', 'lcd-menu--up lcd-menu--wide')} role="menu" data-testid="lcd-attach-menu">
                  <input
                    className="lcd-search"
                    placeholder="Find a task, doc, artifact, file…"
                    aria-label="Find something to attach"
                    value={attachQuery}
                    autoFocus
                    onChange={(event) => setAttachQuery(event.target.value)}
                  />
                  <button
                    type="button"
                    role="menuitem"
                    className="lcd-mi"
                    data-testid="lcd-attach-files"
                    aria-disabled={!onFiles || Boolean(attachRefusal) || undefined}
                    title={!onFiles ? NO_UPLOAD_REASON : attachRefusal ?? undefined}
                    onClick={stop(() => {
                      if (!onFiles || attachRefusal) return;
                      fileInput.current?.click();
                    })}
                  >
                    <span className="lcd-ck" aria-hidden="true">⤒</span>
                    <span className="lcd-mi__body">
                      Files from this computer…
                      <span className={onFiles ? 'lcd-mi__sub' : 'lcd-mi__why'}>
                        {onFiles ? 'or drop them anywhere on the card' : NO_UPLOAD_REASON}
                      </span>
                    </span>
                  </button>
                  <div className="lcd-grp">In this space</div>
                  {attachRefusal ? <div className="lcd-note" role="status">{attachRefusal}</div> : null}
                  {candidates === undefined ? (
                    <div className="lcd-note" role="status">
                      Nothing attachable has been read into this client, so none can be offered. This is unknown, not empty.
                    </div>
                  ) : pool.length === 0 ? (
                    <div className="lcd-note">{attachNeedle ? `Nothing matches “${attachQuery.trim()}”.` : 'Nothing in this space to attach.'}</div>
                  ) : pool.slice(0, 60).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={c.state !== 'attachable'}
                      aria-disabled={c.state === 'default' || Boolean(attachRefusal) || undefined}
                      className="lcd-mi"
                      data-testid={`lcd-attach-${c.id}`}
                      title={c.state === 'default' ? 'The launch already carries this by default.' : undefined}
                      onClick={stop(() => {
                        if (c.state === 'default' || attachRefusal) return;
                        onToggleCandidate(c.id);
                      })}
                    >
                      <span className="lcd-ck" aria-hidden="true">{c.state !== 'attachable' ? '✓' : ''}</span>
                      <span className="lcd-kind" aria-hidden="true">{KIND_GLYPH[c.kind] ?? '•'}</span>
                      <span className="lcd-mi__body">
                        {c.title}
                        <span className="lcd-mi__sub">{c.kind}{c.state === 'default' ? ' · already carried by default' : ''}</span>
                      </span>
                    </button>
                  ))}
                  <div className="lcd-foot">
                    Attached items go in as context. The subject stays “{subject.title}”. Sessions can’t be attached as context.
                  </div>
                </div>
              ) : null}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                data-testid="lcd-file-input"
                onChange={(event) => { files(event.target.files); event.target.value = ''; close(); }}
              />
            </div>

            <div className="lcd-anchor lcd-a-subj">
              <button
                type="button"
                className="lcd-ent lcd-ent--subject"
                data-testid="lcd-subject"
                aria-haspopup="dialog"
                aria-expanded={open === 'subject'}
                title={continuing
                  ? 'The session this launch continues'
                  : 'The task this session works on. Click to read or edit its description.'}
                onClick={stop(() => toggle('subject'))}
              >
                <span className="lcd-ent__kind" aria-hidden="true">{KIND_GLYPH[subject.kind ?? 'task'] ?? '▣'}</span>
                <span className="lcd-ent__title">{subject.title}</span>
                <Caret up />
              </button>
              {open === 'subject' ? (
                <div
                  {...menuProps('subject', 'lcd-menu--up lcd-subjmenu')}
                  role="dialog"
                  aria-label={continuing ? 'The session being continued' : 'Task description'}
                  data-testid="lcd-subject-menu"
                >
                  {continuing ? (
                    <div className="lcd-foot">
                      This launch continues “{subject.title}”: the new session reads its transcript first. Nothing here is loaded
                      from it or saved onto it — your instructions above are for the new session.
                    </div>
                  ) : (
                    <>
                      <div className="lcd-grp">
                        Task description
                        <span>{descriptionReadOnly ? 'read-only here' : 'saves onto the task before launch'}</span>
                      </div>
                      <textarea
                        className="lcd-subjdesc"
                        aria-label="Task description"
                        data-testid="lcd-description"
                        value={description ?? ''}
                        readOnly={Boolean(descriptionReadOnly) || description === null}
                        placeholder={description === null ? 'Reading the task…' : 'No description yet.'}
                        autoFocus
                        onChange={(event) => onDescriptionChange(event.target.value)}
                      />
                      <div className="lcd-foot">
                        {descriptionReadOnly
                          ?? 'The agent reads this as its briefing. Your instructions above are for this launch only.'}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>

            <div className="lcd-attlist" ref={list} onScroll={countHidden} data-testid="lcd-attached">
              {attachments.length === 0 ? <span className="lcd-empty">Nothing else attached</span> : null}
              {attachments.map((a) => (
                <span
                  key={a.key}
                  className="lcd-ent"
                  data-status={a.status}
                  title={a.error ?? `${a.title} · ${a.kind}`}
                  data-testid={`lcd-attached-${a.key}`}
                >
                  <span className="lcd-ent__kind" aria-hidden="true">{KIND_GLYPH[a.kind] ?? '•'}</span>
                  <span className="lcd-ent__title">{a.title}</span>
                  {a.status === 'uploading'
                    ? <span className="lcd-ent__meta">uploading…</span>
                    : a.status === 'failed'
                      ? <span className="lcd-ent__meta lcd-ent__meta--bad">failed</span>
                      : a.meta ? <span className="lcd-ent__meta lcd-ent__bytes">{a.meta}</span> : null}
                  <button
                    type="button"
                    className="lcd-ent__rm"
                    aria-label={`Detach ${a.title}`}
                    onClick={stop(() => onDetach(a.key))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {hidden > 0 ? (
              <button
                type="button"
                className="lcd-more"
                data-testid="lcd-more"
                title="Show the rest"
                onClick={stop(() => list.current?.scrollTo({ left: list.current.scrollWidth, behavior: 'smooth' }))}
              >
                +{hidden} more
              </button>
            ) : null}
          </div>
        </div>

        {/* REFUSAL floats over the bottom of the center: no permanent row. */}
        {(refusal ?? notice) ? (
          <p className="lcd-refusal" id="lcd-refusal" role="alert">{refusal ?? notice}</p>
        ) : null}

        <aside
          className="lcd-drawer"
          data-open={drawer || undefined}
          aria-label="Advanced settings"
          aria-hidden={!drawer}
          data-testid="lcd-drawer"
          onClick={(event) => event.stopPropagation()}
        >
          {drawer ? (
            <>
              <div className="lcd-drawer__head">
                <b>Advanced</b><span className="lcd-hint">⌘.</span>
                <span className="lcd-spacer" />
                <button type="button" className="lcd-icon" aria-label="Close advanced" onClick={() => setDrawer(false)}>✕</button>
              </div>
              <div className="lcd-drawer__body">
                <div className="lcd-field">
                  <h4>Session mode</h4>
                  <select
                    data-testid="lcd-mode"
                    value={mode}
                    aria-label="Session mode"
                    onChange={(event) => onModeChange(event.target.value as LaunchMode)}
                  >
                    {MODE_OPTIONS.map((m) => (
                      <option key={m.id} value={m.id}>{`${m.label} — ${m.description.replace(/\.$/, '').toLowerCase()}`}</option>
                    ))}
                  </select>
                  <div className="lcd-s">from the {verbLabel} button</div>
                </div>
                <div className="lcd-field">
                  <h4>Interaction profile</h4>
                  <div className="lcd-s lcd-s--first" data-testid="lcd-profile">
                    {profileLine ?? 'resolved by the node at launch — the teammate’s, else the space’s, else the node’s'}
                  </div>
                  <div className="lcd-s">pinned at launch — kept for the session’s whole life, including resumes</div>
                </div>
                <div className="lcd-field">
                  <h4>{credentialProviderLabel ? `${credentialProviderLabel} credential` : 'Agent credential'}</h4>
                  <select
                    data-testid="lcd-credential"
                    aria-label={credentialProviderLabel ? `${credentialProviderLabel} credential` : 'Agent credential'}
                    disabled={credentialProviderLabel === null}
                    title={credentialProviderLabel === null
                      ? 'This agent tool has no personal credential provider, so there is nothing to choose.'
                      : undefined}
                    value={credential ?? ''}
                    onChange={(event) => onCredentialChange((event.target.value || null) as LaunchCredentialSource | null)}
                  >
                    {CREDENTIAL_OPTIONS.map((o) => <option key={o.label} value={o.value ?? ''}>{o.label}</option>)}
                  </select>
                </div>
                <div className="lcd-field">
                  <h4>GitHub credential</h4>
                  <select
                    data-testid="lcd-github-credential"
                    aria-label="GitHub credential"
                    value={githubCredential ?? ''}
                    onChange={(event) => onGithubCredentialChange((event.target.value || null) as LaunchCredentialSource | null)}
                  >
                    {CREDENTIAL_OPTIONS.map((o) => <option key={o.label} value={o.value ?? ''}>{o.label}</option>)}
                  </select>
                </div>
                <div className="lcd-field">
                  <h4>Harness</h4>
                  <div className="lcd-seg" role="radiogroup" aria-label="Harness">
                    {HARNESS_OPTIONS.map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        role="radio"
                        aria-checked={harnessSurface === o.value}
                        aria-disabled={!harnessEnabled || undefined}
                        title={harnessEnabled ? o.hint : 'Only Claude Code lanes have a harness to choose; this agent tool ignores it.'}
                        onClick={() => { if (harnessEnabled) onHarnessChange?.(o.value); }}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  {pluginsEnabled ? (
                    <div className="lcd-plugins" data-testid="lcd-plugins">
                      <label className="lcd-check">
                        <input type="checkbox" checked={plugins === null} onChange={() => onPluginsChange?.(plugins === null ? [] : null)} />
                        the teammate’s plugins
                      </label>
                      {(installedPlugins ?? []).map((id) => {
                        const [name, marketplace] = id.split('@');
                        const skills = pluginSkillCounts?.[id] ?? 0;
                        return (
                          <label key={id} className="lcd-check" title={marketplace}>
                            <input type="checkbox" checked={plugins?.includes(id) === true} onChange={() => togglePlugin(id)} />
                            {name}{skills > 0 ? <span className="lcd-hint"> · {skills} skill{skills === 1 ? '' : 's'}</span> : null}
                          </label>
                        );
                      })}
                      {installedPluginsNote ? <div className="lcd-s">{installedPluginsNote}</div> : null}
                    </div>
                  ) : (
                    <div className="lcd-s">
                      {!harnessEnabled
                        ? 'Only Claude Code lanes have a harness to choose.'
                        : 'Full already loads every plugin the account has installed.'}
                    </div>
                  )}
                </div>
                <div className="lcd-field">
                  <h4>Also attach projects</h4>
                  <div className="lcd-s lcd-s--first">{ADDITIONAL_PROJECTS_UNAVAILABLE_REASON}</div>
                </div>
                <div className="lcd-field lcd-field--budget">
                  <h4>Context budget for this launch</h4>
                  {budget}
                </div>
              </div>
            </>
          ) : null}
        </aside>
      </div>

      {/* ============ BOTTOM BAND: how it runs · go ============ */}
      <footer className="lcd-band lcd-band--bot">
        <div className="lcd-anchor lcd-a-first">
          <button
            type="button"
            className="lcd-tool"
            data-testid="nsx-model"
            aria-haspopup="menu"
            aria-expanded={open === 'model'}
            aria-label={`Model: ${modelName}`}
            title={[modelName, toolWord].filter(Boolean).join(' · ')}
            onClick={stop(() => toggle('model'))}
          >
            <span className="lcd-glyph" aria-hidden="true">✳</span>
            <b>{vendor ? <span className="lcd-vendor">{vendor}</span> : null}{modelName.slice(vendor.length)}</b>
            {toolWord ? <span className="lcd-meta">{toolWord}</span> : null}
            <Caret up />
          </button>
          {open === 'model' ? (
            <div {...menuProps('model', 'lcd-menu--up')} role="menu" data-testid="nsx-model-menu">
              {models.length === 0 ? <div className="lcd-note">no known models on this node</div> : null}
              {groups.map((g) => {
                const tools = [...new Set(g.rows.map((r) => r.agentTool).filter(Boolean))]
                  .map((t) => agentTool(t)?.label ?? t).join(', ');
                return (
                  <div key={g.provider} role="group" aria-label={PROVIDER_WORD[g.provider] ?? g.provider}>
                    <div className="lcd-grp">
                      {PROVIDER_WORD[g.provider] ?? g.provider}
                      {tools ? <span>via {tools}</span> : null}
                    </div>
                    {g.rows.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={model === m.id}
                        className="lcd-mi"
                        title={m.note}
                        onClick={stop(() => { onPickModel(m.id); close(); })}
                      >
                        <span className="lcd-ck" aria-hidden="true">{model === m.id ? '✓' : ''}</span>
                        <span className="lcd-mi__body lcd-mi__body--plain">{m.label}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="lcd-anchor">
          <button
            type="button"
            className="lcd-tool"
            data-testid="nsx-effort"
            aria-haspopup="menu"
            aria-expanded={open === 'effort'}
            aria-disabled={effortStops.length === 0 || undefined}
            aria-label={`Reasoning effort: ${effort ? effortLabel(effort) : 'the model default'}`}
            title={effortStops.length === 0 ? EFFORT_NOT_TUNABLE_REASON : `Reasoning effort: ${effortLabel(effort)}`}
            onClick={stop(() => { if (effortStops.length > 0) toggle('effort'); })}
          >
            <span className="lcd-bars" aria-hidden="true">
              {(effortStops.length > 0 ? effortStops : (['low', 'medium', 'high', 'max'] as const)).map((stop_, index, all) => (
                <i
                  key={stop_}
                  data-on={effort !== null && effortStops.indexOf(effort) >= index ? '' : undefined}
                  style={{ height: `${4 + Math.round((8 * index) / Math.max(all.length - 1, 1))}px` }}
                />
              ))}
            </span>
            <span className="lcd-effort-word">{effortLabel(effort)}</span>
            <Caret up />
          </button>
          {open === 'effort' ? (
            <div {...menuProps('effort', 'lcd-menu--up lcd-menu--narrow')} role="menu" data-testid="lcd-effort-menu">
              <div className="lcd-grp">
                Effort
                <span>{effortStops.length > 0 ? `${effortStops[0]}–${effortStops[effortStops.length - 1]}` : ''}</span>
              </div>
              {effortStops.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="menuitemradio"
                  aria-checked={effort === e}
                  className="lcd-mi"
                  onClick={stop(() => { onEffortChange(e); close(); })}
                >
                  <span className="lcd-ck" aria-hidden="true">{effort === e ? '✓' : ''}</span>
                  <span className="lcd-mi__body lcd-mi__body--plain">{effortLabel(e)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="lcd-anchor">
          <button
            type="button"
            className={`lcd-tool ${accessMode === 'fullAccess' ? 'lcd-tool--full' : ''}`}
            data-testid="nsx-perm"
            aria-haspopup="menu"
            aria-expanded={open === 'access'}
            aria-label={`Permission mode: ${describeAccessMode(accessMode)}`}
            title={describeAccessMode(accessMode)}
            onClick={stop(() => toggle('access'))}
          >
            <span className="lcd-dot" aria-hidden="true" />
            <span>{access.name}</span>
            <Caret up />
          </button>
          {open === 'access' ? (
            <div {...menuProps('access', 'lcd-menu--up')} role="menu" data-testid="nsx-perm-menu">
              <div className="lcd-grp">Permission mode</div>
              {ACCESS_OPTIONS.map((option) => {
                const words = accessWords(option);
                return (
                  <button
                    key={option}
                    type="button"
                    role="menuitemradio"
                    aria-checked={accessMode === option}
                    className={`lcd-mi ${option === 'fullAccess' ? 'lcd-mi--full' : ''}`}
                    onClick={stop(() => { onAccessModeChange(option); close(); })}
                  >
                    <span className="lcd-ck" aria-hidden="true">{accessMode === option ? '✓' : ''}</span>
                    <span className="lcd-mi__body lcd-mi__body--plain">{words.name}</span>
                    <span className="lcd-mi__r">{words.hint}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <span className="lcd-spacer" />
        <span className="lcd-summary" data-testid="lcd-summary" title={summaryText}>{summary}</span>
        {onDispatch ? (
          <button
            type="button"
            className="lcd-btn lcd-btn--dispatch"
            data-testid="launch-dispatch"
            aria-label="Dispatch"
            title="Dispatch hands the task to the space’s dispatcher, which picks its own teammate, model and place — nothing on this card applies"
            onClick={stop(onDispatch)}
          >
            <span className="lcd-btn__label">Dispatch</span>⇥
          </button>
        ) : null}
        <button
          type="button"
          className="lcd-btn lcd-btn--go"
          data-testid="nsx-send"
          /* aria-disabled, not disabled: a refused Launch stays focusable so
             its reason is reachable; the handler re-guards. */
          aria-disabled={blocked}
          title={refusal ?? summaryText}
          onClick={stop(submit)}
        >
          {busy ? 'Launching…' : 'Launch'} <span className="lcd-kbd" aria-hidden="true">⌘↵</span>
        </button>
      </footer>
    </div>
  );
}
