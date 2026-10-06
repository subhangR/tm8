/**
 * `workspace.dialogs.open|close` and `workspace.view.set` (Spec C §5, ruling
 * Q1). They act OUTSIDE Workspace state — the app shell owns dialogs and the
 * route — so each one asks a hook and returns an `external` plan. They still
 * run through `dispatch()`, so the source and typing policy apply to them as
 * to every other command.
 */
import { DIALOG_IDS, type DialogId } from '../types';
import { isRecord, reject, type Planner } from './shared';

function dialogIdOf(args: unknown): DialogId | null {
  if (!isRecord(args) || Object.keys(args).some((key) => key !== 'dialogId')) return null;
  const id = args.dialogId;
  return typeof id === 'string' && (DIALOG_IDS as readonly string[]).includes(id) ? (id as DialogId) : null;
}

export const openDialog: Planner = ({ state, env, hooks }) => {
  if (!isRecord(env.args) || typeof env.args.dialogId !== 'string') return reject('invalid_arguments');
  const dialogId = dialogIdOf(env.args);
  if (!dialogId) return reject('unsupported_dialog');
  // One blocking modal per window (API §9.2): a pending prompt is one.
  if (state.pending) return reject('busy');
  return { type: 'external', result: hooks.openDialog(dialogId) };
};

export const closeDialog: Planner = ({ env, hooks }) => {
  if (!isRecord(env.args) || typeof env.args.dialogId !== 'string') return reject('invalid_arguments');
  const dialogId = dialogIdOf(env.args);
  if (!dialogId) return reject('unsupported_dialog');
  return { type: 'external', result: hooks.closeDialog(dialogId) };
};

export const setView: Planner = ({ env, hooks }) => {
  if (!isRecord(env.args) || Object.keys(env.args).some((key) => key !== 'view')) return reject('invalid_arguments');
  // The Workspace is the only target; other views stay refused (ruling Q1).
  if (env.args.view !== 'tabs') return reject('view_unavailable');
  return { type: 'external', result: hooks.showWorkspace() };
};
