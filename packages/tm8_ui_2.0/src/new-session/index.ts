/**
 * new-session — the create screen that mints a task from a prompt and spawns
 * an agent on it.
 *
 * The stylesheet is imported by the screen itself, not here, following
 * `rich-input`/`files`: mounting the screen from anywhere styles it.
 */
export { NewSessionScreen, type NewSessionScreenProps, type NewSessionPhase } from './NewSessionScreen';
export { NewSessionComposer, type NewSessionComposerProps } from './NewSessionComposer';
export { TITLE_MAX, canDeriveTitle, deriveTitle, promptBody } from './prompt-title';
