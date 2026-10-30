/**
 * THE PHONE'S APP-ASSOCIATION FILES — s-lld §3 (deep and universal links), §19.
 *
 * `/.well-known/apple-app-site-association` lets iOS open a tm8 web link in
 * the TM8 app; `/.well-known/assetlinks.json` lets Android verify its App Link.
 * Both are fetched anonymously, by Apple's CDN and by Android's verifier, and
 * both refuse anything but a 200 with JSON: a redirect, an HTML page or the
 * wrong content type each turn the link back into a browser tab.
 *
 * What only a request can see, so it is asserted through the pipeline with a
 * real UI bundle mounted (the SPA fallback is the thing that used to answer):
 *
 *  · configured from the environment (`TM8_MOBILE_*`, read by loadConfig),
 *    each file is a 200 with `Content-Type: application/json` exactly, no
 *    `Location`, for app id `sh.tm8.mobile` (decide Q3);
 *  · the AASA matches path `/` with fragment `/s/*`, checked against the web
 *    addresses of the LLD §3 route table;
 *  · unconfigured, each path is an honest 404 `not_found` naming the variable
 *    to set, never index.html. Before this route existed the extension-less
 *    AASA path got index.html with a 200 from the static handler's fallback;
 *  · HEAD answers the GET's headers without a body; other methods fall through
 *    to the frame's `not_found`;
 *  · the transport gate still runs: `Host: tm8.sh` (what the verifiers send to
 *    a node published there) passes, a rebound Host is refused.
 *
 * `node:http` rather than fetch: it never follows a redirect, so "no redirect"
 * is the status line itself, and it can send the Host a verifier sends.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../src/facade/index.js';
import { ConfigError, loadConfig } from '../src/http/config.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { createStaticHandler } from '../src/http/static.js';
import { appleAppSiteAssociation, assetLinks } from '../src/http/well-known.js';

// Literal on purpose: these are the URLs Apple's CDN and Android's verifier fetch.
const AASA = '/.well-known/apple-app-site-association';
const ASSET_LINKS = '/.well-known/assetlinks.json';

const TEAM_ID = 'ABCDE12345';
/** Synthetic: the SHA-256 of a string, not of any certificate. */
function fingerprintOf(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').toUpperCase().match(/../g)!.join(':');
}
const RELEASE_CERT = fingerprintOf('tm8 test release certificate');
const UPLOAD_CERT = fingerprintOf('tm8 test upload certificate');

/** What a node published at tm8.sh with both accounts filled in is started with. */
const CONFIGURED_ENV = {
  TM8_PUBLIC_ORIGIN: 'https://tm8.sh',
  TM8_MOBILE_APPLE_TEAM_ID: TEAM_ID,
  // As an operator pastes them: spaced, one lower-cased, one repeated.
  TM8_MOBILE_ANDROID_CERT_SHA256: ` ${RELEASE_CERT.toLowerCase()} , ${UPLOAD_CERT},${RELEASE_CERT} `,
};

const APP_ID = `${TEAM_ID}.sh.tm8.mobile`;
const EXPECTED_AASA = {
  applinks: {
    details: [{ appIDs: [APP_ID], components: [{ '/': '/', '#': '/s/*' }] }],
  },
  webcredentials: { apps: [APP_ID] },
};
const EXPECTED_ASSET_LINKS = [
  {
    relation: [
      'delegate_permission/common.handle_all_urls',
      'delegate_permission/common.get_login_creds',
    ],
    target: {
      namespace: 'android_app',
      package_name: 'sh.tm8.mobile',
      sha256_cert_fingerprints: [RELEASE_CERT, UPLOAD_CERT],
    },
  },
];

function makeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-ui-well-known-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>the web app</title>');
  return dir;
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function ask(port: number, path: string, opts: { method?: string; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.host === undefined ? {} : { host: opts.host },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function boot(env: NodeJS.ProcessEnv): Promise<{ server: FacadeServer; port: number }> {
  const server = createFacadeServer({
    config: { ...loadConfig(env), port: 0 },
    registry: new HandlerRegistry(),
    staticHandler: createStaticHandler(makeBundle()),
  });
  const { port } = await server.listen();
  return { server, port };
}

describe('loadConfig — the phone app the node vouches for (TM8_MOBILE_*)', () => {
  it('defaults to app id sh.tm8.mobile with neither platform identity', () => {
    expect(loadConfig({}).mobileApp).toEqual({ appId: 'sh.tm8.mobile', androidCertSha256: [] });
  });

  it('reads the Team ID and the fingerprints, upper-cased, de-duplicated, in order', () => {
    expect(loadConfig(CONFIGURED_ENV).mobileApp).toEqual({
      appId: 'sh.tm8.mobile',
      appleTeamId: TEAM_ID,
      androidCertSha256: [RELEASE_CERT, UPLOAD_CERT],
    });
  });

  it('takes another app id for a per-operator build', () => {
    expect(loadConfig({ TM8_MOBILE_APP_ID: 'com.acme.tm8' }).mobileApp?.appId).toBe('com.acme.tm8');
  });

  it('refuses a Team ID that is not the 10-character one Apple issues', () => {
    for (const value of ['abcde12345', 'ABCDE1234', 'ABCDE123456', `${TEAM_ID}.sh.tm8.mobile`, 'ABCDE-1234']) {
      expect(() => loadConfig({ TM8_MOBILE_APPLE_TEAM_ID: value }), value).toThrow(ConfigError);
      expect(() => loadConfig({ TM8_MOBILE_APPLE_TEAM_ID: value }), value).toThrow(/TM8_MOBILE_APPLE_TEAM_ID/);
    }
  });

  it('refuses a fingerprint that is not a colon-separated SHA-256', () => {
    const sha1 = createHash('sha1').update('x').digest('hex').toUpperCase().match(/../g)!.join(':');
    for (const value of [sha1, RELEASE_CERT.replaceAll(':', ''), `${RELEASE_CERT}:00`, 'not-a-fingerprint']) {
      expect(() => loadConfig({ TM8_MOBILE_ANDROID_CERT_SHA256: value }), value).toThrow(ConfigError);
      expect(() => loadConfig({ TM8_MOBILE_ANDROID_CERT_SHA256: value }), value)
        .toThrow(/TM8_MOBILE_ANDROID_CERT_SHA256/);
    }
  });

  it('refuses an app id that is not both an iOS bundle id and an Android package name', () => {
    // A hyphen is legal on iOS only, an underscore on Android only, a leading
    // digit on neither part of the intersection; one id serves both platforms.
    for (const value of ['mobile', 'sh.tm8-mobile', 'sh.tm8_mobile', 'sh.8tm.mobile', 'sh..mobile', 'sh.tm8.mobile.']) {
      expect(() => loadConfig({ TM8_MOBILE_APP_ID: value }), value).toThrow(/TM8_MOBILE_APP_ID/);
    }
  });
});

describe('the documents', () => {
  const app = loadConfig(CONFIGURED_ENV).mobileApp!;

  it('AASA: applinks and webcredentials for <Team ID>.sh.tm8.mobile', () => {
    expect(appleAppSiteAssociation(app)).toEqual(EXPECTED_AASA);
  });

  it('assetlinks: one statement for the android_app sh.tm8.mobile and its certificates', () => {
    expect(assetLinks(app)).toEqual(EXPECTED_ASSET_LINKS);
  });

  it('names nothing for a platform whose identity is unset', () => {
    const bare = loadConfig({}).mobileApp!;
    expect(appleAppSiteAssociation(bare)).toBeUndefined();
    expect(assetLinks(bare)).toBeUndefined();
  });

  /**
   * Apple's component patterns: `*` is any run of characters, `?` exactly one,
   * and a key that is present must match its part of the URL (the fragment
   * without its `#`). Modelled here to read the served component against real
   * addresses: those of the LLD §3 route table open the app, and nothing else
   * this host serves does.
   */
  function componentMatches(component: Readonly<Record<string, string>>, address: string): boolean {
    const glob = (pattern: string, value: string): boolean =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
        .test(value);
    const url = new URL(address);
    const path = component['/'];
    const fragment = component['#'];
    return (path === undefined || glob(path, url.pathname))
      && (fragment === undefined || glob(fragment, url.hash.replace(/^#/, '')));
  }

  it('matches path / with fragment /s/*: the web addresses of the LLD §3 route table, and only them', () => {
    const [component] = appleAppSiteAssociation(app)!.applinks.details[0]!.components;
    expect(component).toEqual({ '/': '/', '#': '/s/*' });
    const space = '01a0fb3d-558e-7d92-b370-d0601112607a';
    for (const address of [
      `https://tm8.sh/#/s/${space}/home`,
      `https://tm8.sh/#/s/${space}/workspace`,
      `https://tm8.sh/#/s/${space}/inbox`,
      `https://tm8.sh/#/s/${space}/k/tasks?mode=tree`,
      `https://tm8.sh/#/s/${space}/e/01a1867c-9a44-795c-9214-96ddf2f9daea?origin=tasks`,
      `https://tm8.sh/#/s/${space}/channel/01a18724-1c19-7ba1-82a4-e609a87715ad?msg=1`,
      `https://tm8.sh/#/s/${space}/settings/members`,
      `https://tm8.sh/?ref=mail#/s/${space}/home`,
    ]) {
      expect(componentMatches(component!, address), address).toBe(true);
    }
    for (const address of [
      'https://tm8.sh/',
      'https://tm8.sh/#/',
      'https://tm8.sh/#/invite/abc',
      `https://tm8.sh/s/${space}/home`,
      'https://tm8.sh/p/capability/index.html',
      'https://tm8.sh/mcp/oauth/callback?code=x',
      'https://tm8.sh/v2/spaces',
    ]) {
      expect(componentMatches(component!, address), address).toBe(false);
    }
  });
});

describe('through the pipeline — configured (TM8_MOBILE_* set), with the UI bundle mounted', () => {
  let server: FacadeServer;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await boot(CONFIGURED_ENV));
  });

  afterAll(async () => {
    await server.close();
  });

  for (const [path, expected] of [
    [AASA, EXPECTED_AASA],
    [ASSET_LINKS, EXPECTED_ASSET_LINKS],
  ] as const) {
    it(`GET ${path} → 200 application/json, no redirect, the document`, async () => {
      const res = await ask(port, path, { host: 'tm8.sh' });
      expect(res.status).toBe(200);
      expect(res.headers.location).toBeUndefined();
      expect(res.headers['content-type']).toBe('application/json');
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(JSON.parse(res.body)).toEqual(expected);
    });

    it(`HEAD ${path} → the GET's headers, no body`, async () => {
      const get = await ask(port, path);
      const head = await ask(port, path, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers['content-type']).toBe('application/json');
      expect(head.headers['content-length']).toBe(get.headers['content-length']);
      expect(head.body).toBe('');
    });

    it(`POST ${path} is no operation: the frame's not_found`, async () => {
      const res = await ask(port, path, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('not_found');
    });
  }

  it('the transport gate still runs: a rebound Host is refused before anything is served', async () => {
    const res = await ask(port, AASA, { host: 'evil.example' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('forbidden');
  });

  it('the bundle still answers its own routes', async () => {
    const res = await ask(port, '/some/client/route');
    expect(res.status).toBe(200);
    expect(res.body).toContain('the web app');
  });
});

describe('through the pipeline — unconfigured (the default), with the UI bundle mounted', () => {
  let server: FacadeServer;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await boot({}));
  });

  afterAll(async () => {
    await server.close();
  });

  for (const [path, variable] of [
    [AASA, 'TM8_MOBILE_APPLE_TEAM_ID'],
    [ASSET_LINKS, 'TM8_MOBILE_ANDROID_CERT_SHA256'],
  ] as const) {
    it(`GET ${path} → 404 not_found naming ${variable}, never index.html`, async () => {
      const res = await ask(port, path);
      expect(res.status).toBe(404);
      expect(res.headers.location).toBeUndefined();
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      // A cache in front must not keep "missing" once the operator fills it in.
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain('the web app');
      const { error } = JSON.parse(res.body);
      expect(error.code).toBe('not_found');
      expect(error.message).toContain(variable);
      expect(error.message).toContain('sh.tm8.mobile');
    });
  }
});
