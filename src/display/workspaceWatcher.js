import readline from 'readline';

const SETTLE_MS = 300;
const RESTART_DELAY_MS = 5000;

// The outputs whose visible workspace holds a window, from i3's tree: a workspace's tiling and floating windows count,
// docks (polybar) do not, since they sit in an output's dock areas rather than a workspace, and neither does the
// scratchpad. workspaces is `i3-msg -t get_workspaces`, which names the visible one on each output.
export function occupiedOutputs(tree, workspaces) {
  const visible = new Set((workspaces ?? []).filter(item => item.visible).map(item => item.name));
  const occupied = new Set();
  const windows = node => (node.window ? 1 : 0)
    + (node.nodes ?? []).reduce((sum, child) => sum + windows(child), 0)
    + (node.floating_nodes ?? []).reduce((sum, child) => sum + windows(child), 0);
  const walk = (node, output) => {
    if (node.type === 'output') output = node.name;
    if (node.type === 'workspace' && visible.has(node.name) && windows(node) > 0) occupied.add(output);
    for (const child of node.nodes ?? []) walk(child, output);
  };
  walk(tree, null);
  return occupied;
}

// Calls onChange(occupied outputs, a Set) whenever which monitors show a window may have changed, from i3's window and
// workspace events (`i3-msg -t subscribe -m '["window","workspace","tick"]'`): a window opening, closing or moving,
// or another workspace shown. Events come in bursts, so the tree is read once they settle. Like OutputWatcher, the
// tick i3 sends every new subscriber says it is live, and the tree is read then too. Without i3-msg it logs once and
// reports nothing, so its user goes on as if every monitor were covered.
export class WorkspaceWatcher {
  constructor({ spawn, exec, logger, onChange, settle = SETTLE_MS, restartDelay = RESTART_DELAY_MS }) {
    Object.assign(this, { spawn, exec, logger, onChange, settle, restartDelay });
    this.child = null;
    this.stopped = false;
    this.timer = null;
    this.restartTimer = null;
    this.warned = false;
  }

  start() {
    this.stopped = false;
    this.listen();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.restartTimer);
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  listen() {
    if (this.stopped) return;
    const child = this.spawn('i3-msg', ['-t', 'subscribe', '-m', '["window","workspace","tick"]'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', error => {
      if (this.warned) return;
      this.warned = true;
      this.logger.warn('Cannot follow i3 window events, so every monitor counts as covered by windows', { error: error.message });
    });
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', line => this.line(line));
    child.on('exit', () => {
      if (this.child !== child) return;
      if (!this.stopped) this.restartTimer = setTimeout(() => this.listen(), this.restartDelay);
    });
  }

  line(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || message.success === false) return;
    if (message.first === true || 'change' in message) this.changed();
  }

  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.read();
    }, this.settle);
  }

  async read() {
    if (this.stopped) return;
    try {
      const [tree, workspaces] = await Promise.all([
        this.exec('i3-msg', ['-t', 'get_tree']).then(JSON.parse),
        this.exec('i3-msg', ['-t', 'get_workspaces']).then(JSON.parse)
      ]);
      if (!this.stopped) this.onChange(occupiedOutputs(tree, workspaces));
    } catch (error) {
      this.logger.debug?.('Reading the i3 tree failed', { error: error.message });
    }
  }
}
