#!/usr/bin/env python3
"""Generate the function-coverage manifest from the pinned upstream trees.

Usage: python3 -I gen_coverage.py <upstream-dir> <host-skills-dir> <out.json>

Every surface is enumerated from files at the pin (git ls-files), never from
memory. Each row starts UNIMPLEMENTED unless host evidence says otherwise;
state only moves to IMPLEMENTED when a later step records executed evidence.
"""
import json, os, subprocess, sys, hashlib
from pathlib import PurePosixPath as P

UP, HOST, OUT = sys.argv[1], sys.argv[2], sys.argv[3]

REPOS = {
  # key: (github, pin, host skill-dir prefix, plugin roots (relative), extra skill roots)
  'superpowers':    ('obra/superpowers', 'superpowers-', ['.'], []),
  'ponytail':       ('DietrichGebert/ponytail', 'ponytail-', ['.'], []),
  'mattpocock':     ('mattpocock/skills', 'mp-', ['.'], ['skills']),  # plugin.json lists only 27; 8 in-progress + 4 misc live outside it
  'flutter':        ('flutter/agent-plugins', '', ['.'], []),
  'harness':        ('ONA-AI-Labs/harness-engineering-playbook', '', [], ['skills']),
  'diagram-design': ('cathrynlavery/diagram-design', '', ['.'], []),
  'impeccable':     ('pbakaus/impeccable', '', ['plugin'], []),
  'graphify':       ('Graphify-Labs/graphify', '', [], []),
  'headroom':       ('headroomlabs-ai/headroom', '', ['plugins/headroom-agent-hooks', 'plugins/headroom-skill', 'plugins/headroom-snip'], []),
}
ADAPTER = {
  'skill': 'skill entity (native files in ~/.claude/skills or plugin)',
  'command': 'Claude plugin command (enabled per lane via enabledPlugins)',
  'agent': 'Claude plugin agent',
  'hook-config': 'Claude plugin hooks (enabled per lane via enabledPlugins)',
  'hook-file': 'Claude plugin hook runtime file',
  'mcp-server': 'tm8 stdio connector (mcp server create + approve + per-session selection)',
  'script': 'TOOL entity (typed inputs, PTY run)',
  'cli': 'TOOL entity per used subcommand',
  'plugin-manifest': 'Claude plugin install (installed_plugins.json + marketplace)',
}

def git(repo, *a):
  return subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True, check=True).stdout

rows = []
def row(repo, pin, kind, path, name=None, state='UNIMPLEMENTED', note=''):
  rows.append({'repo': REPOS[repo][0], 'pin': pin, 'surface': kind, 'path': path,
               'name': name or P(path).stem, 'tm8_adapter': ADAPTER[kind],
               'implementation_path': None, 'test_ref': None, 'state': state,
               'evidence': None, 'note': note})

def host_skill_state(prefix, name, repo_dir, skill_dir, files):
  """PROVISIONED-UNTESTED only when the host dir exists AND every sibling file is present."""
  for cand in (prefix + name, name, prefix + name.replace('ponytail', '').strip('-') if prefix else name):
    hd = os.path.join(HOST, cand)
    if os.path.isfile(os.path.join(hd, 'SKILL.md')):
      sib = [f[len(skill_dir) + 1:] for f in files if f.startswith(skill_dir + '/') and not f.endswith('/SKILL.md') and f != skill_dir + '/SKILL.md']
      missing = [s for s in sib if not os.path.exists(os.path.join(hd, s))]
      if missing:
        return 'UNIMPLEMENTED', f'host dir {cand} exists; {len(missing)}/{len(sib)} supporting files missing'
      return 'PROVISIONED-UNTESTED', f'host dir {cand} complete ({len(sib)} supporting files)'
  return 'UNIMPLEMENTED', 'no host skill dir'

for repo, (gh, prefix, roots, extra) in REPOS.items():
  d = os.path.join(UP, repo)
  pin = git(d, 'rev-parse', 'HEAD').strip()
  files = git(d, 'ls-files').split('\n')
  fs = set(files)
  skill_dirs = set()
  for root in roots:
    rp = '' if root == '.' else root + '/'
    man = rp + '.claude-plugin/plugin.json'
    m = json.load(open(os.path.join(d, man))) if man in fs else {}
    if man in fs: row(repo, pin, 'plugin-manifest', man, m.get('name'))
    # skills: manifest list / string, else default skills/
    sk = m.get('skills')
    sk_roots = [s.lstrip('./') for s in (sk if isinstance(sk, list) else [sk])] if sk else [rp + 'skills']
    sk_roots = [s if s.startswith(rp) or not rp else rp + s for s in sk_roots]
    for f in files:
      if f.endswith('/SKILL.md') and any(f.startswith(s.rstrip('/') + '/') for s in sk_roots):
        skill_dirs.add(str(P(f).parent))
    for f in files:
      if f.startswith(rp + 'commands/') and f.count('/') == rp.count('/') + 1 and f.endswith(('.md', '.toml')):
        row(repo, pin, 'command', f, note='Codex .toml: convert to .md for Claude' if f.endswith('.toml') else '')
      if f.startswith(rp + 'agents/') and f.endswith('.md'):
        row(repo, pin, 'agent', f)
    hooks = m.get('hooks')
    hook_cfgs = [h.lstrip('./') for h in (hooks if isinstance(hooks, list) else [hooks])] if isinstance(hooks, (list, str)) else []
    hook_cfgs = [rp + h for h in hook_cfgs] or ([rp + 'hooks/hooks.json'] if rp + 'hooks/hooks.json' in fs else [])
    for h in hook_cfgs:
      row(repo, pin, 'hook-config', h)
    for f in files:
      if f.startswith(rp + 'hooks/') and not f.endswith('.json') and '/test' not in f and f.count('/') <= rp.count('/') + 2:
        row(repo, pin, 'hook-file', f)
    mcp = m.get('mcpServers') or {}
    if not mcp and rp + '.mcp.json' in fs:
      mcp = json.load(open(os.path.join(d, rp + '.mcp.json'))).get('mcpServers', {})
    for name, cfg in mcp.items():
      row(repo, pin, 'mcp-server', man, name, note='command: ' + ' '.join([cfg.get('command', '')] + cfg.get('args', [])))
  for e in extra:
    for f in files:
      if f.startswith(e + '/') and f.endswith('/SKILL.md'):
        skill_dirs.add(str(P(f).parent))
  if repo == 'graphify':
    row(repo, pin, 'skill', 'graphify/skill.md', 'graphify', *host_skill_state('', 'graphify', d, 'graphify', []),)
  for sd in sorted(skill_dirs):
    name = P(sd).name
    st, note = host_skill_state(prefix, name, d, sd, files)
    if repo == 'mattpocock' and sd.startswith('skills/in-progress/'):
      note += '; upstream in-progress: mark EXPERIMENTAL'
    row(repo, pin, 'skill', sd + '/SKILL.md', name, st, note)
  # scripts: depth-1 entry points under scripts/ (not fixtures/tests)
  for f in files:
    parts = f.split('/')
    if parts[0] == 'scripts' and len(parts) == 2 and f.endswith(('.py', '.sh', '.mjs', '.js', '.ts')):
      row(repo, pin, 'script', f)
  if repo == 'harness':
    for f in files:
      if f.startswith('tools/') and f.endswith('.py'):
        row(repo, pin, 'script', f)

# CLIs whose subcommands are functions in their own right
row('graphify', rows[-1]['pin'] if rows[-1]['repo'] == REPOS['graphify'][0] else git(os.path.join(UP, 'graphify'), 'rev-parse', 'HEAD').strip(),
    'cli', 'graphify (uv tool graphifyy)', 'graphify affected|path|explain|query', note='subcommands enumerated in step 5 from --help at the pin')
row('impeccable', git(os.path.join(UP, 'impeccable'), 'rev-parse', 'HEAD').strip(), 'cli', 'cli/bin/cli.js', 'impeccable CLI',
    note='subcommands enumerated in step 6 from skill/ + cli/ at the pin')
row('headroom', git(os.path.join(UP, 'headroom'), 'rev-parse', 'HEAD').strip(), 'cli', 'headroom/cli', 'headroom proxy',
    note='per-credential backend seam, flag default OFF (step 8)')

summary = {}
for r in rows:
  k = (r['repo'], r['surface'])
  summary.setdefault(r['repo'], {}).setdefault(r['surface'], {}).setdefault(r['state'], 0)
  summary[r['repo']][r['surface']][r['state']] += 1
out = {'generated': '2026-11-28', 'generator': 'scripts/gen_coverage.py (enumerates git ls-files at each pin)',
       'states': ['IMPLEMENTED', 'PROVISIONED-UNTESTED', 'UNIMPLEMENTED', 'OUT-OF-SCOPE'],
       'summary': summary, 'rows': rows}
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps(summary, indent=1))
print('rows', len(rows))
