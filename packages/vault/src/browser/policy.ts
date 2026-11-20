import { normalizeOrigin, sameOrigin } from '../origin/normalize.js';
import type { FillRefusalCode } from '../types.js';

/** Policy never includes a supplied URL in an error or result. */
export function checkTopFrameUrl(url: string, boundOrigin: string, devMode: boolean): FillRefusalCode | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' && !devMode) return 'insecure_context';
    normalizeOrigin(url, { allowPath: true, devMode });
    normalizeOrigin(boundOrigin, { devMode });
    return sameOrigin(url, boundOrigin, { devMode }) ? null : 'origin_mismatch';
  } catch {
    return 'origin_mismatch';
  }
}

export function checkFormAction(
  actionUrl: string, documentUrl: string, boundOrigin: string, devMode: boolean,
): FillRefusalCode | null {
  const documentRefusal = checkTopFrameUrl(documentUrl, boundOrigin, devMode);
  if (documentRefusal) return documentRefusal;
  try {
    const action = new URL(actionUrl, documentUrl);
    if (action.protocol === 'http:' && !devMode) return 'insecure_context';
    if (action.protocol !== 'https:' && action.protocol !== 'http:') return 'cross_origin_form_action';
    normalizeOrigin(action.href, { allowPath: true, devMode });
    return sameOrigin(action.href, boundOrigin, { devMode }) ? null : 'cross_origin_form_action';
  } catch {
    return 'cross_origin_form_action';
  }
}

export function checkNavigationChain(urls: readonly string[], boundOrigin: string, devMode: boolean): FillRefusalCode | null {
  for (const url of urls) {
    const code = checkTopFrameUrl(url, boundOrigin, devMode);
    if (code === 'insecure_context') return code;
    if (code) return 'cross_origin_redirect';
  }
  return null;
}

/** Used after inspecting the top document and, only if needed, its child frames. */
export function checkPasswordFieldLocation(topFrameHasField: boolean, childFrameHasField: boolean): FillRefusalCode | null {
  return topFrameHasField ? null : childFrameHasField ? 'not_top_frame' : 'fields_not_found';
}

/** Metadata only: the result cannot carry a query, fragment or credentials. */
export function observedOrigin(url: string): string | null {
  try {
    return normalizeOrigin(url, { allowPath: true, devMode: true }).origin;
  } catch {
    return null;
  }
}
