/**
 * The phone's app-association files (s-lld §3, §19): what lets a tm8 web link
 * open in the TM8 app instead of a browser tab.
 *
 *   /.well-known/apple-app-site-association   iOS universal links (`applinks`)
 *                                              and Password AutoFill (`webcredentials`)
 *   /.well-known/assetlinks.json              Android App Links (Digital Asset Links)
 *
 * INFRASTRUCTURE, LIKE `/health`: not catalog operations, so no envelope and no
 * identity. Apple's CDN and Android's verifier fetch them anonymously and accept
 * only a 200 carrying bare JSON: a redirect, an HTML page or another content
 * type each leave the link in the browser. So the type is exactly
 * `application/json` (RFC 8259 defines no charset parameter for it), and the
 * frame dispatches these paths ahead of the static handler, whose SPA fallback
 * answered the extension-less AASA path with index.html and a 200 until this
 * route existed (./server.ts).
 *
 * STATIC, FROM CONFIG. The bytes are built once, with the frame, from
 * `config.mobileApp` (./config.ts). A file whose signing identity is not
 * configured is an honest 404 naming the variable to set. An empty document
 * would say "this host vouches for no app", which is not something the
 * operator decided, only something they have not done yet.
 *
 * WHAT OPENS THE APP. The web UI routes in the fragment
 * (`https://tm8.sh/#/s/<space>/e/<id>`), so the AASA matches path `/` with
 * fragment `/s/*`, in the iOS 13+ `components` form (the app's iOS floor is far
 * above 13, so the legacy `paths` form is not served). Nothing else on the host
 * opens the app: `/p/` previews, `/v2/` and `/mcp/oauth/callback` stay in the
 * browser. Android App Links cannot match a fragment at all: the app's intent
 * filter claims the host, and the statement here only vouches for the app.
 *
 * TRUST. Each file delegates this host's links, and through `webcredentials`
 * and `get_login_creds` its saved sign-in credentials, to the app identity it
 * names. That identity comes from the operator's environment and nowhere else,
 * and ./config.ts refuses a malformed one at boot.
 */
import type { ServerResponse } from 'node:http';

import type { MobileAppConfig } from './config.js';
import { fail } from './errors.js';
import { BASE_SECURITY_HEADERS } from './security.js';

/** The bundle id and package name of the TM8 app (decide Q3). */
export const DEFAULT_MOBILE_APP_ID = 'sh.tm8.mobile';

export const APPLE_APP_SITE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';
export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';

/** The AASA this node serves (Apple, "Supporting associated domains"). */
export interface AppleAppSiteAssociation {
  readonly applinks: {
    readonly details: ReadonlyArray<{
      readonly appIDs: readonly string[];
      readonly components: ReadonlyArray<Readonly<Record<string, string>>>;
    }>;
  };
  readonly webcredentials: { readonly apps: readonly string[] };
}

/** One Digital Asset Links statement (Google, "Verify Android App Links"). */
export interface AssetLinkStatement {
  readonly relation: readonly string[];
  readonly target: {
    readonly namespace: 'android_app';
    readonly package_name: string;
    readonly sha256_cert_fingerprints: readonly string[];
  };
}

/** Absent until `TM8_MOBILE_APPLE_TEAM_ID` names the team that signs the app. */
export function appleAppSiteAssociation(app: MobileAppConfig): AppleAppSiteAssociation | undefined {
  if (app.appleTeamId === undefined) return undefined;
  const appID = `${app.appleTeamId}.${app.appId}`;
  return {
    applinks: { details: [{ appIDs: [appID], components: [{ '/': '/', '#': '/s/*' }] }] },
    webcredentials: { apps: [appID] },
  };
}

/** Absent until `TM8_MOBILE_ANDROID_CERT_SHA256` names a signing certificate. */
export function assetLinks(app: MobileAppConfig): AssetLinkStatement[] | undefined {
  if (app.androidCertSha256.length === 0) return undefined;
  return [
    {
      relation: [
        'delegate_permission/common.handle_all_urls',
        'delegate_permission/common.get_login_creds',
      ],
      target: {
        namespace: 'android_app',
        package_name: app.appId,
        sha256_cert_fingerprints: [...app.androidCertSha256],
      },
    },
  ];
}

export interface WellKnownRoute {
  /**
   * GET or HEAD on one of the two paths: answers and returns true, or throws
   * the 404 for a file this node does not serve. Anything else returns false,
   * and the frame carries on as if this route did not exist.
   */
  serve(method: string, pathname: string, res: ServerResponse, requestId: string): boolean;
}

type WellKnownFile = { readonly body: Buffer } | { readonly missing: string };

export function createWellKnownRoute(
  app: MobileAppConfig = { appId: DEFAULT_MOBILE_APP_ID, androidCertSha256: [] },
): WellKnownRoute {
  const aasa = appleAppSiteAssociation(app);
  const links = assetLinks(app);
  const files = new Map<string, WellKnownFile>([
    [
      APPLE_APP_SITE_ASSOCIATION_PATH,
      aasa
        ? { body: Buffer.from(JSON.stringify(aasa)) }
        : {
            missing:
              `no iOS app is associated with this node: set TM8_MOBILE_APPLE_TEAM_ID to the Apple ` +
              `Developer Team ID that signs ${app.appId} and restart the server`,
          },
    ],
    [
      ASSET_LINKS_PATH,
      links
        ? { body: Buffer.from(JSON.stringify(links)) }
        : {
            missing:
              `no Android app is associated with this node: set TM8_MOBILE_ANDROID_CERT_SHA256 to the ` +
              `SHA-256 fingerprint of the certificate that signs ${app.appId} and restart the server`,
          },
    ],
  ]);

  return {
    serve(method, pathname, res, requestId) {
      if (method !== 'GET' && method !== 'HEAD') return false;
      const file = files.get(pathname);
      if (file === undefined) return false;
      if ('missing' in file) {
        // Merged into the error writer's own headers, as static.ts does for a
        // missing asset: a cache in front must not keep "missing" once the
        // operator sets the variable and restarts.
        res.setHeader('cache-control', 'no-store');
        throw fail('not_found', file.missing);
      }
      res.writeHead(200, {
        ...BASE_SECURITY_HEADERS,
        'content-type': 'application/json',
        'content-length': String(file.body.byteLength),
        // Revalidated, like the bundle's unhashed files: the bytes change with
        // the config, on a restart, under the same URL.
        'cache-control': 'no-cache',
        'x-tm8-request-id': requestId,
      });
      res.end(method === 'HEAD' ? undefined : file.body);
      return true;
    },
  };
}
