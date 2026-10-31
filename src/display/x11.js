import x11 from 'x11';

// The few X requests backdrop makes itself, over its own connection to $DISPLAY: finding a window's
// top-level ancestor, stacking one window directly above another, setting the window opacity that
// compositors such as picom honor, and telling whether a compositor runs. Other X work goes through xrandr
// and xdotool.

const STACK_ABOVE = 0;
const PROP_MODE_REPLACE = 0;
const ATOM_CARDINAL = 6;
const MAX_OPACITY = 0xffffffff;

function call(client, request, ...args) {
  return new Promise((resolve, reject) => {
    client[request](...args, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

export class X11 {
  constructor(client, root, screen = 0) {
    this.client = client;
    this.root = root;
    this.screen = screen;
    this.errors = [];
    client.on('error', error => this.errors.push(error));
  }

  // Requests without replies report errors only as events; sync() is the barrier after which any have arrived
  async check(action) {
    await this.client.sync();
    const error = this.errors.shift();
    this.errors = [];
    if (error) throw new Error(`X ${action} failed: ${error.message ?? error}`);
  }

  // The child of the root window that holds window id
  async topLevel(id) {
    let current = id;
    for (let depth = 0; depth < 16; depth++) {
      const { root, parent } = await call(this.client, 'QueryTree', current);
      if (parent === root) return current;
      current = parent;
    }
    throw new Error(`Window ${id} is nested too deeply`);
  }

  // Whether window is above sibling among the root's children (QueryTree lists them bottom to top)
  async isAbove(id, sibling) {
    const { children } = await call(this.client, 'QueryTree', this.root);
    return children.indexOf(id) > children.indexOf(sibling);
  }

  // Puts window directly above sibling, leaving every other window where it is
  async stackAbove(id, sibling) {
    this.client.ConfigureWindow(id, { sibling, stackMode: STACK_ABOVE });
    await this.check('restack');
  }

  // Whether a compositor runs on the screen: one owns the _NET_WM_CM_S<screen> selection (EWMH)
  async hasCompositor() {
    const atom = await call(this.client, 'InternAtom', false, `_NET_WM_CM_S${this.screen}`);
    return (await call(this.client, 'GetSelectionOwner', atom)) !== 0;
  }

  // _NET_WM_WINDOW_OPACITY, 0 to 1
  async setOpacity(id, opacity) {
    const atom = await call(this.client, 'InternAtom', false, '_NET_WM_WINDOW_OPACITY');
    this.client.ChangeProperty(PROP_MODE_REPLACE, id, atom, ATOM_CARDINAL, 32, [Math.round(opacity * MAX_OPACITY)]);
    await this.check('opacity change');
  }
}

// Runs fn with a connection that is closed afterwards
export async function withX11(fn) {
  const display = await new Promise((resolve, reject) => {
    x11.createClient((error, result) => (error ? reject(error) : resolve(result)));
  });
  const client = display.client;
  try {
    // The screen of $DISPLAY (":0.1" is screen 1); the root window is the first screen's, as before
    const screen = Number(/\.(\d+)$/.exec(process.env.DISPLAY ?? '')?.[1] ?? 0);
    return await fn(new X11(client, display.screen[0].root, screen));
  } finally {
    await new Promise(resolve => client.close(() => resolve()));
  }
}
