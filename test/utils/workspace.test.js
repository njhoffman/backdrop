import { expect } from 'chai';
import sinon from 'sinon';
import { enterWorkspace, workspaceName } from '../../src/utils/workspace.js';
import { silentLogger } from '../helpers/fakes.js';

describe('workspace', () => {
  const workspaces = [
    { name: '1', output: 'DP-1', visible: true, focused: false },
    { name: '2', output: 'DP-1', visible: false, focused: false },
    { name: '3 "web"', output: 'HDMI-1', visible: true, focused: true }
  ];
  const fakeRun = (list = workspaces) => sinon.stub().callsFake(async (file, args) => (args[0] === '-t' ? JSON.stringify(list) : ''));

  it('names the menu workspace from menu.workspace', () => {
    expect(workspaceName(undefined)).to.equal('backdrop');
    expect(workspaceName(true)).to.equal('backdrop');
    expect(workspaceName(' wall ')).to.equal('wall');
    expect(workspaceName(false)).to.be.null;
    expect(() => workspaceName(3)).to.throw('menu.workspace must be true, false or a workspace name, not 3');
  });

  it('shows the workspace on the target output, then brings back that output\'s workspace and the focused one', async () => {
    const run = fakeRun();
    const leave = await enterWorkspace('backdrop', 'DP-1', { run });
    expect(run.secondCall.args).to.deep.equal(['i3-msg', ['focus output "DP-1"; workspace --no-auto-back-and-forth "backdrop"']]);
    await leave();
    expect(run.thirdCall.args[1]).to.deep.equal([
      'workspace --no-auto-back-and-forth "1"; workspace --no-auto-back-and-forth "3 \\"web\\""'
    ]);
  });

  it('does nothing when disabled, already there, or without i3, and only logs a failed switch', async () => {
    let run = fakeRun();
    await (await enterWorkspace(null, 'DP-1', { run }))();
    expect(run.called).to.be.false;

    run = fakeRun([{ name: 'backdrop', output: 'DP-1', visible: true, focused: true }]);
    await (await enterWorkspace('backdrop', 'DP-1', { run }))();
    expect(run.calledOnce).to.be.true;

    run = sinon.stub().rejects(Object.assign(new Error('spawn i3-msg ENOENT'), { code: 'ENOENT' }));
    await (await enterWorkspace('backdrop', 'DP-1', { run, logger: silentLogger }))();
    expect(run.calledOnce).to.be.true;

    run = fakeRun();
    run.onSecondCall().rejects(new Error('i3-msg failed'));
    const warn = sinon.spy();
    await (await enterWorkspace('backdrop', 'DP-1', { run, logger: { ...silentLogger, warn } }))();
    expect(run.calledTwice).to.be.true;
    expect(warn.calledOnceWith('Failed to switch i3 workspace')).to.be.true;
  });
});
