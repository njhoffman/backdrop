import { expect } from 'chai';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { DoctorCommand } from '../../src/commands/DoctorCommand.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('DoctorCommand', () => {
  let db, config, lines, errors, installed, files, savedDisplay;
  const doctor = (overrides = {}) => new DoctorCommand(config, db, silentLogger, {
    version: '2.32.0',
    which: async name => installed.has(name),
    x11: async fn => fn({ hasCompositor: async () => true }),
    readStateFile: async () => null,
    orphans: () => null,
    pathExists: async file => files.has(file),
    ...overrides
  });
  const byName = (checks, name) => checks.find(check => check.name === name);

  beforeEach(() => {
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'visualizer.enabled': true, 'sources.pexels.api_key': 'key' });
    installed = new Set(['mpv', 'xwinwrap', 'ffmpeg', 'ffprobe', 'xrandr', 'xdotool', 'rofi', 'glava', 'notify-send', 'pactl', 'i3-msg']);
    files = new Set();
    lines = []; errors = [];
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
    sinon.stub(console, 'error').callsFake(line => errors.push(line));
    savedDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ':9';
    process.exitCode = undefined;
  });
  afterEach(() => {
    sinon.restore();
    db.close();
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    process.exitCode = undefined;
  });

  it('passes a healthy setup', async () => {
    const id = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 1920, height: 1080 });
    files.add('/m/a.png');
    const checks = await doctor().run();
    expect(checks.every(check => check.status === 'ok'), JSON.stringify(checks.filter(check => check.status !== 'ok'))).to.equal(true);
    expect(byName(checks, 'files').detail).to.equal('1 items, every file present');
    expect(lines.at(-1)).to.equal('Everything checks out');
    expect(process.exitCode).to.equal(undefined);
    expect(id).to.be.a('number');
  });

  it('fails on a missing required tool and warns on optional ones only when their feature is on', async () => {
    installed.delete('xwinwrap');
    installed.delete('glava');
    installed.delete('pactl');
    const checks = await doctor().run();
    expect(byName(checks, 'xwinwrap')).to.include({ status: 'fail', hint: 'install xwinwrap' });
    expect(byName(checks, 'glava').status).to.equal('warn');
    // only_while_playing is off: pactl is not needed
    expect(byName(checks, 'pactl')).to.equal(undefined);
    expect(process.exitCode).to.equal(1);
    expect(errors.at(-1)).to.equal('1 failed, 1 warning');
  });

  it('checks the display and the compositor', async () => {
    let checks = await doctor({ x11: async fn => fn({ hasCompositor: async () => false }) }).run();
    expect(byName(checks, 'compositor')).to.include({ status: 'warn', hint: 'start picom or another compositor' });
    checks = await doctor({ x11: async () => { throw new Error('connection refused'); } }).run();
    expect(byName(checks, 'X display')).to.include({ status: 'fail' });
    expect(byName(checks, 'X display').detail).to.include('connection refused');
    delete process.env.DISPLAY;
    checks = await doctor().run();
    expect(byName(checks, 'X display').detail).to.equal('DISPLAY is not set');
  });

  it('reports invalid values, unknown keys, a bad visualizer section and a missing Pexels key', async () => {
    config.errors = ['display.notify must be commands, all or off, not "loud"'];
    config.warnings = ['Unknown config key "visualizr"; closest: "visualizer"'];
    config.visualizerError = 'visualizer.module must be bars, graph, radial, circle, wave, not "spiral"';
    config.get().sources.pexels.api_key = '';
    const checks = await doctor().run();
    expect(checks.filter(check => check.group === 'config').map(check => [check.name, check.status])).to.deep.equal([
      ['value', 'fail'], ['unknown key', 'warn'], ['visualizer', 'warn'], ['Pexels key', 'warn']
    ]);
  });

  it('reports the daemon: running behind the CLI, a stale state file, and processes a crash left', async () => {
    let checks = await doctor({ readStateFile: async () => ({ pid: 42, version: '2.30.0' }) }).run();
    expect(byName(checks, 'daemon')).to.include({ status: 'warn', detail: 'running (pid 42, 2.30.0)' });
    expect(byName(checks, 'daemon').hint).to.include('it runs 2.30.0, the CLI is 2.32.0');

    files.add(`${config.get().paths.runtime}/state.json`);
    checks = await doctor({ orphans: () => ({ daemon: 7, orphans: [{ command: 'xwinwrap', pid: 70 }] }) }).run();
    expect(byName(checks, 'daemon')).to.include({ status: 'warn', hint: 'backdrop stop clears it' });
    expect(byName(checks, 'left running')).to.include({ status: 'warn', detail: 'xwinwrap (pid 70), from daemon 7, which exited without stopping' });
  });

  it('reports items whose files are missing, a few by id', async () => {
    for (let index = 1; index <= 5; index++) db.addMedia({ kind: 'image', source: 'local', source_id: index, path: `/m/${index}.png`, width: 1920, height: 1080 });
    files.add('/m/1.png');
    const checks = await doctor().run();
    expect(byName(checks, 'files')).to.include({ status: 'warn', detail: '4 of 5 items have no file (#2, #3, #4, ...)' });
    expect(byName(checks, 'files').hint).to.include('backdrop rescan --all');
  });

  it('runs the visualizer check with --visualizer, and prints JSON', async () => {
    const checkVisualizers = async () => [{ preset: null, instance: 'main', ok: true }, { preset: 'ring', instance: 'ring', ok: false, code: 1, output: ['syntax error'] }];
    const checks = await doctor({ checkVisualizers }).run({ visualizer: true, json: true });
    expect(checks.filter(check => check.group === 'visualizer').map(check => [check.name, check.status, check.detail])).to.deep.equal([
      ['(no preset) main', 'ok', 'runs'], ['ring ring', 'fail', 'exited with code 1: syntax error']
    ]);
    const json = JSON.parse(lines.at(-1));
    expect(json).to.include({ ok: false, failed: 1, warned: 0 });
    expect(json.checks).to.have.length(checks.length);
  });
});
