import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { makeConfig } from './fakes.js';
import { xdgRoot } from './setup.js';

describe('test isolation', () => {
  it('keeps every default path and the config file inside the run directory', () => {
    const inside = file => !path.relative(xdgRoot, file).startsWith('..');
    const manager = new ConfigManager();
    expect(manager.configPath).to.satisfy(inside);
    for (const [key, file] of Object.entries(manager.getDefaultPaths())) {
      expect(file, `paths.${key}`).to.satisfy(inside);
    }
    // makeConfig() keeps the defaults but for a runtime dir that does not exist, so no daemon is found
    const { runtime, ...paths } = makeConfig().get().paths;
    for (const [key, file] of Object.entries(paths)) expect(file, `paths.${key}`).to.satisfy(inside);
    expect(fs.existsSync(runtime)).to.equal(false);
    expect(xdgRoot.startsWith(os.homedir())).to.equal(false);
  });
});
