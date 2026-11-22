/** Apply to the document AND every asset response, including errors. */
export const CAPTURE_RESPONSE_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // The legacy form of frame-ancestors 'none', and no other origin may embed the page or its modules
  // (review addendum 2, C3). artifacts.tm8.sh is the same site as tm8.sh, so not same-site.
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
});
