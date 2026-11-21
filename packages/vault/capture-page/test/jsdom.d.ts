/**
 * The slice of jsdom these tests use. @types/jsdom is not a dependency, and this
 * keeps the typecheck gate from depending on one.
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: Window & typeof globalThis;
  }
}
