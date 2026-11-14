import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { canReadKernelLog, followKernelLog, gpuTrouble, processName } from '../../src/display/kernelLog.js';

describe('kernelLog', () => {
  it('names a process as the kernel does, cut to 15 characters', () => {
    expect(processName('/home/me/rife/rife-ncnn-vulkan')).to.equal('rife-ncnn-vulka');
    expect(processName('rife')).to.equal('rife');
  });

  it('finds fence timeouts and hangs of the process named, and nothing else', () => {
    const name = 'rife-ncnn-vulka';
    expect(gpuTrouble('Fence expiration time out i915-0000:00:02.0:rife-ncnn-vulka[429491]:8!', name)).to.equal('fence');
    expect(gpuTrouble('i915 0000:00:02.0: [drm] GPU HANG: ecode 12:1:8fddfff9, in rife-ncnn-vulka [381556]', name)).to.equal('hang');
    expect(gpuTrouble('i915 0000:00:02.0: [drm] GPU HANG: ecode 12:1:fa9ffffe, in Xorg [3087]', name)).to.equal(null);
    expect(gpuTrouble('Fence expiration time out i915-0000:00:02.0:Xorg[3087]:96ce4!', name)).to.equal(null);
    expect(gpuTrouble('rife-ncnn-vulka[1]: segfault at 0', name)).to.equal(null);
    expect(gpuTrouble('GPU HANG in rife', '')).to.equal(null);
  });

  it('counts the kernel log readable only when it returns a line', async () => {
    let args;
    expect(await canReadKernelLog({ exec: async (file, given) => { args = [file, ...given]; return 'audit: a line\n'; } })).to.equal(true);
    expect(args).to.include.members(['journalctl', '-k', '-b']);
    expect(await canReadKernelLog({ exec: async () => '' })).to.equal(false);
    expect(await canReadKernelLog({ exec: async () => { throw new Error('ENOENT'); } })).to.equal(false);
  });

  it('follows new lines until stopped', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    let spawned;
    const seen = [];
    const watch = followKernelLog(line => seen.push(line), { spawn: (file, args) => { spawned = [file, ...args]; return child; } });
    expect(spawned).to.include.members(['journalctl', '-k', '-f', '-n', '0']);
    child.stdout.write('one\ntwo\n');
    await new Promise(resolve => setImmediate(resolve));
    expect(seen).to.deep.equal(['one', 'two']);
    watch.stop();
    expect(child.killed).to.equal(true);
  });

  it('reports a journalctl that cannot start, and stops quietly', () => {
    const errors = [];
    const watch = followKernelLog(() => {}, { spawn: () => { throw new Error('ENOENT'); }, onError: error => errors.push(error.message) });
    expect(errors).to.deep.equal(['ENOENT']);
    watch.stop();
  });
});
