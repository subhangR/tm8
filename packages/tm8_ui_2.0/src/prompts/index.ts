/**
 * The prompt catalog surface.
 *
 * Self-imports its stylesheet, following `panels/` and `settings-governance/`
 * rather than adding a line to main.tsx's global CSS manifest — a module that
 * carries its own styles cannot be mounted half-dressed.
 */
import './prompts.css';

export { PromptsScreen, type PromptsScreenProps } from './PromptsScreen';
export { PromptsOverlay, type PromptsOverlayProps } from './PromptsOverlay';
