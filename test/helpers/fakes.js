import { EventEmitter } from 'events';
import { ConfigManager } from '../../src/config/ConfigManager.js';

// Stands in for MpvClient: records commands and answers get_property from `properties`
export class FakeMpvClient extends EventEmitter {
  constructor(properties = {}) {
    super();
    this.properties = { playlist: [], pid: 4242, ...properties };
    this.commands = [];
    this.closed = false;
  }

  async command(...args) {
    this.commands.push(args);
    if (args[0] === 'get_property') {
      if (!(args[1] in this.properties)) {
        throw new Error('mpv get_property failed: property unavailable');
      }
      return this.properties[args[1]];
    }
    if (args[0] === 'set_property') {
      this.properties[args[1]] = args[2];
    }
    return null;
  }

  getProperty(name) {
    return this.command('get_property', name);
  }

  setProperty(name, value) {
    return this.command('set_property', name, value);
  }

  observeProperty(id, name) {
    return this.command('observe_property', id, name);
  }

  close() {
    this.closed = true;
  }
}

export class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

// A ConfigManager initialized from defaults with the given overrides, without touching disk
export function makeConfig(overrides = {}) {
  const manager = new ConfigManager('/nonexistent/config.yaml');
  manager.config = manager.getDefaultConfig();
  manager.userConfig = {};
  for (const [key, value] of Object.entries(overrides)) {
    manager.set(key, value);
  }
  return manager;
}

export const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {}, enableConsole() {}
};

export const LISTMONITORS_ONE = 'Monitors: 1\n 0: +*DP-3 2304/698x1296/393+0+0  DP-3\n';
export const LISTMONITORS_TWO =
  'Monitors: 2\n' +
  ' 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n' +
  ' 1: +HDMI-1 1080/344x1920/193+2560+0  HDMI-1\n';
