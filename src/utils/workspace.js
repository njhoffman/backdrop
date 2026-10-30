import { run as defaultRun } from '../display/Monitors.js';

export const DEFAULT_WORKSPACE = 'backdrop';

// menu.workspace: true for the default name, a string for another, false to stay put
export function workspaceName(setting) {
  if (setting === false || setting === null) return null;
  if (setting === undefined || setting === true) return DEFAULT_WORKSPACE;
  if (typeof setting === 'string' && setting.trim()) return setting.trim();
  throw new Error(`menu.workspace must be true, false or a workspace name, not ${JSON.stringify(setting)}`);
}

// An i3 command argument in double quotes
function quote(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Shows the i3 workspace name on output, so nothing covers the wallpaper while the menu is open, and
// resolves to a function that brings back the workspace that output showed and the one that had focus.
// --no-auto-back-and-forth keeps i3's workspace_auto_back_and_forth from toggling away instead. Without
// i3 (no i3-msg, or not running) it does nothing; the menu works the same, only covered.
export async function enterWorkspace(name, output, { run = defaultRun, logger } = {}) {
  const noop = async () => {};
  if (!name) return noop;
  let workspaces;
  try {
    workspaces = JSON.parse(await run('i3-msg', ['-t', 'get_workspaces']));
  } catch (error) {
    logger?.debug('No i3 workspace switch', { error: error.message });
    return noop;
  }
  const focused = workspaces.find(workspace => workspace.focused)?.name;
  const shown = workspaces.find(workspace => workspace.visible && workspace.output === output)?.name;
  if (shown === name) return noop;

  const switchTo = workspace => `workspace --no-auto-back-and-forth ${quote(workspace)}`;
  try {
    await run('i3-msg', [`focus output ${quote(output)}; ${switchTo(name)}`]);
  } catch (error) {
    logger?.warn('Failed to switch i3 workspace', { error: error.message });
    return noop;
  }
  // The output's own workspace first, then the focused one, which may be on another output
  const restore = [...new Set([shown, focused].filter(Boolean))].map(switchTo).join('; ');
  return async () => {
    if (!restore) return;
    try {
      await run('i3-msg', [restore]);
    } catch (error) {
      logger?.warn('Failed to restore i3 workspace', { error: error.message });
    }
  };
}
