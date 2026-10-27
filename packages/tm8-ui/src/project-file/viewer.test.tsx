// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ProjectFileReadResult } from '@tm8/contract';
import { ProjectFileViewer } from './ProjectFileViewer';
import { resetProjectFactsForTest } from './projects';

afterEach(() => {
  cleanup();
  resetProjectFactsForTest();
});

function seamWith(read: Partial<ProjectFileReadResult> | Error, asked: string[] = []) {
  return {
    projectFiles: {
      list: async () => ({ workingDir: '/w/tm8', separator: '/' as const }),
      read: async (_projectId: string, path: string) => {
        asked.push(path);
        if (read instanceof Error) throw read;
        return { projectId: 'p1', path, name: 'a.ts', mime: 'text/plain', sizeBytes: 20, encoding: 'utf8', content: '', truncated: false, ...read };
      },
    },
  } as never;
}

const target = { projectId: 'p1', path: 'src/balance/rounding.ts' };

describe('ProjectFileViewer', () => {
  it('shows highlighted, line-numbered, read-only source under a breadcrumb that starts with the project', async () => {
    const asked: string[] = [];
    const { container } = render(
      <ProjectFileViewer seam={seamWith({ content: 'const a = 1;\nexport { a };\n' }, asked)} target={target} projectName="tm8" />,
    );
    await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull());
    expect(asked).toEqual(['/w/tm8/src/balance/rounding.ts']);
    expect(screen.getByRole('navigation', { name: 'File path' }).textContent).toBe('tm8›src›balance›rounding.ts');
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(container.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length).toBeGreaterThan(1);
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    await waitFor(() => expect(container.querySelector('.tok-keyword')).not.toBeNull());
  });

  it('says where a truncated file was cut off', async () => {
    render(<ProjectFileViewer seam={seamWith({ content: 'x'.repeat(2048), truncated: true, sizeBytes: 6 * 1024 * 1024 })} target={target} projectName="tm8" />);
    expect((await screen.findByRole('note')).textContent).toMatch(/cut off at 2 KB/);
  });

  it('a binary file has no preview, with its mime and size', async () => {
    render(
      <ProjectFileViewer
        seam={seamWith({ encoding: 'base64', mime: 'application/octet-stream', content: 'AAAA', sizeBytes: 3 })}
        target={{ projectId: 'p1', path: 'model.bin' }}
        projectName="tm8"
      />,
    );
    expect(await screen.findByText('No preview for this file type')).toBeTruthy();
    expect(screen.getByText(/application\/octet-stream · 3 bytes/)).toBeTruthy();
  });

  it('renders an image from base64', async () => {
    render(
      <ProjectFileViewer seam={seamWith({ encoding: 'base64', mime: 'image/png', content: 'iVBO' })} target={{ projectId: 'p1', path: 'chart.png' }} projectName="tm8" />,
    );
    expect(((await screen.findByRole('img')) as HTMLImageElement).src).toBe('data:image/png;base64,iVBO');
  });

  it('a missing file or project says so instead of crashing', async () => {
    render(<ProjectFileViewer seam={seamWith(Object.assign(new Error('gone'), { code: 'not_found' }))} target={target} projectName={null} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer in the project/);
  });

  it('a node without project files says they are unavailable', async () => {
    render(<ProjectFileViewer seam={{} as never} target={target} projectName="tm8" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/unavailable/);
  });
});
