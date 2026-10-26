import { createRoot } from 'react-dom/client';
import { PendingFormsBanner } from '../src/forms/PendingFormsBanner';
import { PendingFormsProvider, createPendingFormsStore } from '../src/forms/pending';
import { FormsPortProvider } from '../src/forms/seam';
import { createFixtureFormsPort } from '../src/forms/fixture-port';
import { FORM_FIXTURE_FORMS } from '../src/forms/fixtures';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/tab-workspace/view/content.css';

const form = structuredClone(FORM_FIXTURE_FORMS.find(f => f.content.status === 'open')!);
form.content.questions = Array.from({ length: 16 }, (_, i) => ({
  key: `question_${i}`, type: 'short_text', title: `Question ${i + 1}: ${'Long question content that should wrap within the overlay. '.repeat(3)}`,
  required: i === 15, position: i, config: {},
  help: 'Additional context for this decision. '.repeat(5),
}));
form.content.sections = [];
const port = createFixtureFormsPort({ forms: [form], responses: [] });
const store = createPendingFormsStore({
  spaceId: 'attention-scroll-fixture',
  async pendingForSessions() { return { sessions: [{ workSessionId: 'session', total: 1, queued: 0, forms: [{
    formId: form.id, title: 'Long attention questionnaire', version: form.version, structureVersion: 1,
    questionCount: form.content.questions.length, openedAt: null, draft: null,
  }] }] }; },
  async formDetail() { return { id: form.id, title: form.title, version: form.version, content: { kind: 'form', ...form.content } }; },
  onEvent() { return () => {}; },
}, { debounceMs: 0 });
const inline = new URLSearchParams(location.search).has('inline');
createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" data-theme="light" style={{ position: 'fixed', inset: 0 }}>
    <FormsPortProvider port={port}><PendingFormsProvider store={store}>
      {inline ? <div className="pn-panel" style={{ position: 'fixed', top: 10, left: 10, height: 300, width: 520 }}>
        <PendingFormsBanner sessionId="session" />
        <div>Session content remains below the inline banner</div>
      </div> : <div className="tws-astrip" role="toolbar" aria-label="Session actions" style={{ position: 'fixed', right: 0, top: 40, bottom: 0 }}>
        <div className="tws-astrip-section tws-astrip-section--kind"><div className="tws-astrip-cluster tws-astrip-kind">
          <PendingFormsBanner sessionId="session" variant="chip" />
        </div></div>
      </div>}
    </PendingFormsProvider></FormsPortProvider>
  </div>,
);
