import type { ReactNode } from 'react';
import { VectorIcon } from '../kit/VectorIcon';
import type { ActionDef } from './types';

/**
 * The mark a verb wears: its drawn `art` when it has one, else its text
 * `icon`. Every surface that draws a verb's glyph asks this, so a verb given
 * art (`chat-about` → the chat mark) changes everywhere at once.
 */
export function actionGlyph(def: Pick<ActionDef, 'icon' | 'art'>, size = 13): ReactNode {
  return def.art ? <VectorIcon paths={def.art} size={size} /> : def.icon;
}
