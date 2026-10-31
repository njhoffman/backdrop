import fs from 'fs';
import os from 'os';
import path from 'path';
import { configureOutput } from '../../src/utils/output.js';
import { configureNotify } from '../../src/utils/notify.js';

// Every XDG location points into one directory for the run, so a test that leaves a path at its default
// writes there rather than into the user's config, library, cache or a running daemon's runtime dir.
// Kept short: mpv socket paths under the runtime dir must fit in 107 bytes.
export const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-test-'));
for (const [name, dir] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_RUNTIME_DIR', 'run']]) {
  process.env[name] = path.join(xdgRoot, dir);
  // Created, since tools the tests run (systemd-analyze) expect XDG_RUNTIME_DIR to exist
  fs.mkdirSync(process.env[name], { mode: 0o700 });
}

export const mochaHooks = {
  afterAll() {
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
};

// Plain output for every test, even when mocha runs in a terminal; output tests opt back in
configureOutput({ interactive: false });

// notify-send never runs in tests; notifications sent are recorded here
export const notifications = [];
configureNotify({ exec: async (file, args) => { notifications.push(args); return `${notifications.length}\n`; } });
