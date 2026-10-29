/**
 * The web-platform globals this package's code uses, and nothing else.
 *
 * The package compiles against `lib: ["ES2022"]` with no DOM, so that a
 * reference to `window`, `document`, `history` or `localStorage` is a type
 * error here and not a crash on a phone. Both runtimes that execute this code
 * provide the five below: the browser (tm8-ui through Vite) and Hermes (the
 * app through Metro). Each is declared only as far as the moved code uses it:
 * `btoa`, `atob`, `TextEncoder` and `TextDecoder` in `routes/q.ts` (the `q=`
 * codec), `URL#host` in `chat/turn-steps.ts`. A new use is a deliberate edit
 * here, which is the point.
 *
 * This file is not emitted and is not part of any consumer's program, so it
 * never collides with the DOM lib in tm8-ui or React Native's globals.
 */

declare function btoa(data: string): string;
declare function atob(data: string): string;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  decode(input?: Uint8Array): string;
}

declare class URL {
  constructor(url: string, base?: string);
  readonly host: string;
}
