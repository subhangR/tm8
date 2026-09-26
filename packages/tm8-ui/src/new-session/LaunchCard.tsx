import {
  createContext,
  useCallback,
  useContext,
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
  capacitySlots,
  describeCapacity,
  effortLabel,
  type LaunchAccessMode,
  type LaunchCapacity,
  type LaunchCredentialSource,
  type LaunchMode,
  type LaunchTeammate,
  type WorkdirMode,
} from '../domain/launch';
import { Avatar } from '../kit';
import type { ComposerWorkdir } from './NewSessionComposer';
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

export interface LaunchCardModel {
  id: string;
  label: string;
  note?: string;
  /** Who serves it — the menu's group. */
  provider?: string;
  /** Which harness runs it — the group's "via …" and the control's meta. */
  agentTool?: string;
}


/**
 * A Jev suggestion waiting at the top of the teammate or model menu (owner,
 * form 01a0df34-2cd4): shown with its reason, applied ONLY when clicked.
 */
export interface JevMenuSuggestion {
  label: string;
  reason: string;
  /** The launch already runs with it: the row shows ✓ and the picker's ✦ goes. */
  current: boolean;
  /** Why it can't be applied here; null when it can. */
  refusal: string | null;
  onApply(): void;
}

/** What the shared shell draws: both bands, the drawer, the drop target and the keyboard. */
export interface LaunchCardShellProps {
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

  /** Absent: this host has no upload path, and dropping files does nothing. */
  onFiles?(files: readonly File[]): void;

  /* ---- bottom band ---- */
  models: readonly LaunchCardModel[];
  model: string | null;
  onPickModel(id: string): void;
  effortStops: readonly LaunchModelEffort[];
  effort: LaunchModelEffort | null;
  onEffortChange(next: LaunchModelEffort | null): void;
  accessMode: LaunchAccessMode | null;
  onAccessModeChange(next: LaunchAccessMode): void;
  /** ⌘↵ — the card's go action. */
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
  /** Jev's teammate and model suggestions, once it has answered. */
  jevTeammate?: JevMenuSuggestion | null;
  jevModel?: JevMenuSuggestion | null;
}

function JevSuggestRow({ s, testId, onDone }: { s: JevMenuSuggestion; testId: string; onDone(): void }) {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="lcd-mi lcd3-suggest"
        data-testid={testId}
        aria-disabled={Boolean(s.refusal) || s.current || undefined}
        title={s.refusal ?? s.reason}
        onClick={(event) => {
          event.stopPropagation();
          if (s.refusal || s.current) return;
          s.onApply();
          onDone();
        }}
      >
        <span className="lcd-ck lcd3-jevmark" aria-hidden="true">{s.current ? '✓' : '✦'}</span>
        <span className="lcd-mi__body">
          Jev suggests {s.label}
          <span className={s.refusal ? 'lcd-mi__why' : 'lcd-mi__sub lcd3-wrap'}>{s.refusal ?? s.reason}</span>
        </span>
      </button>
      <hr />
    </>
  );
}

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

/** The first word of a model label that only repeats its vendor. */
const VENDOR_PREFIX = /^(Claude|OpenAI) /;

/** The posture's name and its sentence, from the domain's one spelling. */
function accessWords(mode: LaunchAccessMode | null): { name: string; hint: string } {
  const [name = '', hint = ''] = describeAccessMode(mode).split(' · ');
  return { name, hint };
}

export const EFFORT_NOT_TUNABLE_REASON =
  'This model takes no reasoning-effort setting, so there is no stop to pick.';


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

export function Caret({ up }: { up?: boolean }) {
  return <span className="lcd-caret" aria-hidden="true">{up ? '▲' : '▼'}</span>;
}

/**
 * ONE OPEN MENU PER CARD, whoever draws it. The shell owns which menu is open
 * (Escape closes it before anything else) and the one ref `useFitInside`
 * keeps inside the card; a center drawn by a variant reads both from here.
 */
export interface LaunchCardMenu {
  open: string | null;
  toggle(name: string): void;
  close(): void;
  menuProps(name: string, extra?: string): {
    ref: RefObject<HTMLDivElement | null>;
    className: string;
    onClick(event: { stopPropagation(): void }): void;
    'data-menu': string;
  };
  /** Wrap a handler so the card's click-away does not also close its menu. */
  stop(act: () => void): (event: { stopPropagation(): void }) => void;
  /** The card element: menus fit inside it, and a variant measures against it. */
  card: RefObject<HTMLDivElement | null>;
}

const LaunchCardMenuContext = createContext<LaunchCardMenu | null>(null);

export function useLaunchCardMenu(): LaunchCardMenu {
  const menu = useContext(LaunchCardMenuContext);
  if (!menu) throw new Error('useLaunchCardMenu is only available inside a LaunchCardShell');
  return menu;
}


/**
 * THE SHELL both card versions share: the top band's pickers, the bottom
 * band's model / effort / access, the advanced drawer, the file drop target,
 * the keyboard, and the one-open-menu rule. A version supplies the verb, the
 * center and the go buttons.
 */
export function LaunchCardShell(props: LaunchCardShellProps & {
  /** The top band's first control: the v2 verb badge, the v3 verb switch. */
  verb: ReactNode;
  center: ReactNode;
  /** The bottom band's right end: summary and go buttons. */
  actions: ReactNode;
  /** Extra class on the card: `lcd--v3`. */
  className?: string;
  /** Escape closes this first (an open preview), before menus and the drawer. */
  onEscapeFirst?: (() => boolean) | undefined;
  /** The access mode is fixed by the node, and why — the control shows Full access, locked. */
  accessLock?: string | null;
  /** Tab cycles inside the card, and focus returns to the opener when it closes. */
  trapFocus?: boolean;
  /** Drawn over the whole card, bands included (v3's previews). */
  overlay?: ReactNode;
}) {
  const {
    verbLabel, teammates, teammateId, onPickTeammate, remember, onRememberChange, restoredLine,
    workdirs, workdirId, onPickWorkdir, workdirMode, onWorkdirModeChange, workdirChoosable,
    worktreeBaseRef, onWorktreeBaseRefChange, projectFacts, capacity, onClose, onFiles,
    models, model, onPickModel, effortStops, effort, onEffortChange, accessMode, onAccessModeChange,
    onSubmit, busy, refusal, notice, shaking, onShakeEnd,
    mode, onModeChange, profileLine, credentialProviderLabel, credential, onCredentialChange,
    githubCredential, onGithubCredentialChange, harnessApplies, harnessSurface, onHarnessChange,
    installedPlugins, installedPluginsNote, pluginSkillCounts, plugins, onPluginsChange, budget, advancedEdited,
    jevTeammate = null, jevModel = null,
    verb, center, actions, className, onEscapeFirst, accessLock = null, trapFocus = false, overlay,
  } = props;

  const card = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [teamQuery, setTeamQuery] = useState('');
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  const close = useCallback(() => setOpen(null), []);
  const toggle = useCallback((name: string) => setOpen((current) => (current === name ? null : name)), []);
  useFitInside(menuRef, card, open);

  const blocked = busy || Boolean(refusal);
  const submit = () => { if (!blocked) onSubmit(); };

  /* THE KEYBOARD, layered as the mock rules it: Escape closes a preview
     first, then a menu, then an open context popover or Jev panel, then the
     drawer, then the popup; ⌘. toggles the drawer; ⌘↵ launches.

     CAPTURE PHASE, AND CONSUMED: the popup sits over panels that close on
     Escape themselves (the detail panel does), and a bubble-phase listener
     let one Escape close the menu AND the panel underneath — found live on
     a real node. The one exception is Escape from inside the context
     popover or the Jev panel, which close themselves first. The ref keeps
     one listener for the card's life. */
  const keys = useRef({ open, drawer, submit, onClose, onEscapeFirst, trapFocus });
  keys.current = { open, drawer, submit, onClose, onEscapeFirst, trapFocus };
  /* FOCUS GOES BACK TO THE OPENER when the card closes (v3): the Run button
     that opened it, so a keyboard user lands where they were. */
  useEffect(() => {
    if (!trapFocus) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [trapFocus]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const k = keys.current;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === 'Tab' && k.trapFocus && card.current) {
        /* TAB STAYS INSIDE: the open preview if there is one, else the card. */
        const scope = card.current.querySelector<HTMLElement>('[data-focus-scope]') ?? card.current;
        const focusable = [...scope.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
        )].filter((el) => !el.hasAttribute('disabled') && !el.closest('[aria-hidden="true"], [hidden]'));
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const inside = document.activeElement instanceof Node && scope.contains(document.activeElement);
        if (event.shiftKey && (!inside || document.activeElement === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (mod && event.key === '.') {
        setOpen(null);
        setDrawer((d) => !d);
      } else if (mod && event.key === 'Enter') {
        k.submit();
      } else if (event.key === 'Escape') {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.lsel-popover, .jev-entry__pop')) return;
        if (k.onEscapeFirst?.()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        /* Those two only hear an Escape with focus inside them. Typing in the
           instructions with the Jev panel open, then Escape, closed the whole
           card and dropped the instructions — found live on a real node. */
        const popoverClose = card.current?.querySelector<HTMLElement>('.lsel-popover__close, [data-testid="jev-panel-close"]');
        if (k.open !== null) setOpen(null);
        else if (popoverClose) popoverClose.click();
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

  const stop = useCallback((act: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    act();
  }, []);

  const teammate = (teammateId ? teammates.find((t) => t.id === teammateId) : null) ?? teammates[0] ?? null;
  const workdir = workdirs.find((w) => w.id === workdirId) ?? null;
  const scratch = workdirId === 'scratch';
  const current = models.find((m) => m.id === model) ?? null;
  const modelName = current?.label ?? model ?? 'Model';
  const vendor = VENDOR_PREFIX.exec(modelName)?.[0] ?? '';
  const toolWord = current?.agentTool ? agentTool(current.agentTool)?.label ?? current.agentTool : '';
  const shownAccess = accessLock ? 'fullAccess' : accessMode;
  const access = accessWords(shownAccess);
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

  const menuProps = useCallback((name: string, extra = '') => ({
    ref: menuRef,
    className: `lcd-menu ${extra}`,
    onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
    'data-menu': name,
  }), []);
  const menu: LaunchCardMenu = { open, toggle, close, menuProps, stop, card };

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
    <LaunchCardMenuContext.Provider value={menu}>
    <div
      ref={card}
      className={className ? `lcd ${className}` : 'lcd'}
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
        {verb}

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
            {jevTeammate && !jevTeammate.current ? <span className="lcd3-jevmark" title="Jev suggests a teammate — in this menu">✦</span> : null}
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
              {jevTeammate ? <JevSuggestRow s={jevTeammate} testId="lcd3-jev-teammate" onDone={close} /> : null}
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
            {capacitySlots(capacity)}
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

      {/* ============ CENTER: the version's own ============ */}
      <div className="lcd-stage">
        {center}
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
            {jevModel && !jevModel.current ? <span className="lcd3-jevmark" title="Jev suggests a model — in this menu">✦</span> : null}
            <Caret up />
          </button>
          {open === 'model' ? (
            <div {...menuProps('model', 'lcd-menu--up')} role="menu" data-testid="nsx-model-menu">
              {jevModel ? <JevSuggestRow s={jevModel} testId="lcd3-jev-model" onDone={close} /> : null}
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
            className={`lcd-tool ${shownAccess === 'fullAccess' ? 'lcd-tool--full' : ''}`}
            data-testid="nsx-perm"
            aria-haspopup="menu"
            aria-expanded={open === 'access'}
            aria-disabled={accessLock ? true : undefined}
            aria-label={`Permission mode: ${describeAccessMode(shownAccess)}`}
            title={accessLock ?? describeAccessMode(shownAccess)}
            onClick={stop(() => { if (!accessLock) toggle('access'); })}
          >
            <span className="lcd-dot" aria-hidden="true" />
            <span>{access.name}</span>
            {accessLock ? <span aria-hidden="true">🔒</span> : <Caret up />}
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
        {actions}
      </footer>
      {overlay}
    </div>
    </LaunchCardMenuContext.Provider>
  );
}
