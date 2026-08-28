/**
 * Connect a GitHub repository to this Space.
 *
 * The form has ONE field on purpose. `projects.create` needs node-admin
 * because it accepts an arbitrary working directory, and a project row is a
 * read grant over that directory; this door never lets the caller name one, so
 * there is nothing here to ask for. Adding a path input would not just widen
 * the form, it would reintroduce the reason the operation needs node-admin.
 *
 * The refusals are spelled out rather than collapsed into "something went
 * wrong", because each has a DIFFERENT fix and the user is the only one who
 * can apply it: connect a credential, correct the URL, or pick a repository
 * their account can actually read.
 */
import { useCallback, useState } from 'react';
import { Eyebrow, Pill } from '../../kit';
import { isCollabError } from '../../types';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { ProjectFromRepo, SpaceId } from '../../types/contract';

export interface ProjectRepoSectionProps {
  facade: CollabFacade;
  spaceId: SpaceId;
  /** Already connected, from `SpaceSummary.githubRepo`. */
  connectedRepo?: string | null;
  /** Re-read the settings after a successful connect. */
  onChanged: () => void;
}

/**
 * `no_github_credential` arrives as a `forbidden` carrying that reason, and it
 * is the one refusal with a fix the user can act on immediately — so it is
 * separated from every other `forbidden` rather than sharing their copy.
 */
function describe(e: unknown): string {
  if (isCollabError(e)) {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    if (reason === 'no_github_credential') {
      return 'Connect your GitHub account first — Settings → Agent credentials.';
    }
    if (reason === 'repo_unreadable') {
      return 'That repository could not be read with your GitHub account. Check the name, and that your account has access.';
    }
    switch (e.code) {
      case 'invalid_input':
        return 'Enter a GitHub repository as owner/repo or https://github.com/owner/repo.';
      case 'forbidden':
        return 'You need to be an admin of this Space to connect a repository.';
      // The server's unique `projects.working_dir` violation (23505) maps to
      // invariant_violation in http/errors.ts, so that is the code a duplicate
      // repository actually arrives as — not a 'conflict'.
      case 'invariant_violation':
        return 'That repository is already connected here.';
      case 'upstream_unavailable':
        return 'The clone did not finish. It is safe to try again.';
      case 'not_implemented':
        return 'This tm8 node does not offer self-serve repository linking.';
      default:
        return e.message;
    }
  }
  return 'Something went wrong.';
}

export function ProjectRepoSection({ facade, spaceId, connectedRepo, onChanged }: ProjectRepoSectionProps) {
  const [repoUrl, setRepoUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<ProjectFromRepo | null>(null);

  const connect = useCallback((): void => {
    const value = repoUrl.trim();
    if (!value) {
      setError('Enter a GitHub repository as owner/repo or https://github.com/owner/repo.');
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const result = await facade.createProjectFromRepo(spaceId, { repoUrl: value });
        setLinked(result);
        setRepoUrl('');
        onChanged();
      } catch (e) {
        setError(describe(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [facade, spaceId, repoUrl, onChanged]);

  return (
    <section className="cv2-set__section" aria-label="Repository" data-testid="settings-repo">
      <header className="cv2-set__sectionhead">
        <Eyebrow>repository</Eyebrow>
      </header>

      {connectedRepo && (
        <div className="cv2-set__facts">
          <span className="t-code" data-testid="settings-repo-connected">{connectedRepo}</span>
        </div>
      )}

      <div className="cv2-set__form">
        <input
          className="cv2-set__input cv2-set__input--wide"
          value={repoUrl}
          placeholder="owner/repo"
          aria-label="GitHub repository"
          disabled={busy}
          onChange={(e) => setRepoUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
          data-testid="settings-repo-input"
        />
        <button
          type="button"
          className="cv2-actionbtn"
          disabled={busy}
          onClick={connect}
          data-testid="settings-repo-connect"
        >
          {busy ? 'Cloning…' : 'Connect'}
        </button>
      </div>

      {/* Cloning is a network operation against someone else's server; saying
          how long it may take is the difference between waiting and retrying. */}
      {busy && (
        <p className="cv2-set__note" data-testid="settings-repo-busy">
          Cloning with your GitHub credential. A large repository can take a minute.
        </p>
      )}

      {error && (
        <p className="cv2-set__error" role="alert" data-testid="settings-repo-error">{error}</p>
      )}

      {linked && (
        <div className="cv2-set__facts" data-testid="settings-repo-result">
          <span className="t-code">{linked.repoUrl}</span>
          {/* Trust is never a choice at this door, and a user who tries to run
              an agent here next needs to know that before they try. */}
          <Pill tone="neutral" dot={false}>{linked.trust}</Pill>
          <span className="cv2-set__note">
            Connected as an untrusted project. A node admin can promote it before agents run against it.
          </span>
        </div>
      )}
    </section>
  );
}
