import { ChromeIcon, type ChromeIconName } from './IconRail';
import './styles/project-tab-bar.css';

export interface ProjectTab {
  id: string;
  name: string;
  /** Real session count. Omitted means the host has not loaded it. */
  count?: number;
  /** Real live-agent count. Drives the green dot and working chip. */
  workingCount?: number;
  /** Real needs-input state. Takes precedence over working. */
  needsInput?: boolean;
}

export interface ProjectTabBarProps {
  projects: readonly ProjectTab[];
  activeProjectId: string;
  onSelectProject: (projectId: string) => void;
  onAddProject?: () => void;
  onOpenProjectSettings?: (projectId: string) => void;
  onOpenMultiProjectBoard?: () => void;
  onToggleSound?: () => void;
  soundEnabled?: boolean;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
  dark?: boolean;
  onOpenCommandPalette?: () => void;
}

function actionTitle(label: string, available: boolean): string {
  return available ? label : `${label} is not available in this tm8 workspace`;
}

function TopAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ChromeIconName;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="pn-ib"
      onClick={onClick}
      disabled={!onClick}
      title={actionTitle(label, Boolean(onClick))}
      aria-label={onClick ? label : `${label} — unavailable`}
    >
      <ChromeIcon name={icon} size={16} />
    </button>
  );
}

/**
 * Maestro's full-width project strip. Data and navigation stay upstream so the
 * host can source every count/status through RealFacade without this chrome
 * creating its own competing poll.
 */
export function ProjectTabBar({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onOpenProjectSettings,
  onOpenMultiProjectBoard,
  onToggleSound,
  soundEnabled = true,
  onOpenSettings,
  onToggleTheme,
  dark = false,
  onOpenCommandPalette,
}: ProjectTabBarProps) {
  return (
    <header className="pn-top projectTabBar" data-testid="project-tab-bar">
      <div className="pn-ptabs projectTabs" role="tablist" aria-label="Projects">
        {projects.map((project) => {
          const active = project.id === activeProjectId;
          const workingCount = project.workingCount ?? 0;
          const hasStatus = project.workingCount != null || project.needsInput != null;
          const dotKind = project.needsInput ? 'wait' : workingCount > 0 ? 'run' : 'idle';

          return (
            <div
              key={project.id}
              className={`pn-ptab projectTab${active ? ' pn-ptab--active projectTabActive' : ''}${project.needsInput ? ' projectTabNeedsInput' : ''}`}
              role="presentation"
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="projectTabMain"
                onClick={() => onSelectProject(project.id)}
                title={project.name}
              >
                {hasStatus && (
                  <span className="pn-dot-wrap">
                    <span className={`pn-dot pn-dot--${dotKind}${dotKind === 'run' ? ' pn-dot--live' : ''}`} />
                  </span>
                )}
                <span className="projectTabName">{project.name}</span>
                {workingCount > 0 && (
                  <span className="projectTabWorking">
                    <span className="projectTabWorkingDot" />
                    {workingCount}
                  </span>
                )}
                {project.count != null && project.count > 0 && (
                  <span className="projectTabCount">{project.count > 99 ? '99+' : project.count}</span>
                )}
              </button>

              {active && (
                <button
                  type="button"
                  className="projectTabSettingsBtn"
                  onClick={() => onOpenProjectSettings?.(project.id)}
                  disabled={!onOpenProjectSettings}
                  title={actionTitle('Project settings', Boolean(onOpenProjectSettings))}
                  aria-label={onOpenProjectSettings ? 'Project settings' : 'Project settings — unavailable'}
                >
                  <ChromeIcon name="settings" size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="pn-ib projectAddButton"
        onClick={onAddProject}
        disabled={!onAddProject}
        title={actionTitle('Add project', Boolean(onAddProject))}
        aria-label={onAddProject ? 'Add project' : 'Add project — unavailable'}
      >
        <ChromeIcon name="plus" size={14} />
      </button>

      <div className="pn-top-r">
        <TopAction label="Multi-Project Board" icon="layers" onClick={onOpenMultiProjectBoard} />
        <TopAction label={soundEnabled ? 'Mute sounds' : 'Unmute sounds'} icon={soundEnabled ? 'volume' : 'volumeOff'} onClick={onToggleSound} />
        <TopAction label="Settings" icon="settings" onClick={onOpenSettings} />
        <TopAction label={dark ? 'Light mode' : 'Dark mode'} icon={dark ? 'sun' : 'moon'} onClick={onToggleTheme} />
        <TopAction label="Search" icon="search" onClick={onOpenCommandPalette} />
        <button
          type="button"
          className="pn-ib"
          onClick={onOpenCommandPalette}
          disabled={!onOpenCommandPalette}
          title={actionTitle('Command palette (Cmd/Ctrl+K)', Boolean(onOpenCommandPalette))}
          aria-label={onOpenCommandPalette ? 'Command palette' : 'Command palette — unavailable'}
        >
          <span className="pn-kbd">⌘K</span>
        </button>
      </div>
    </header>
  );
}
