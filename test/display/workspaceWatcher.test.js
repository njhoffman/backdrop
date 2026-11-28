import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { WorkspaceWatcher, occupiedOutputs } from '../../src/display/workspaceWatcher.js';
import { silentLogger } from '../helpers/fakes.js';

// An i3 tree: outputs holding a dock area (polybar) and workspaces with tiling and floating windows
function tree({ one = [], oneFloating = [], two = [] } = {}) {
  const win = id => ({ type: 'con', window: id, nodes: [], floating_nodes: [] });
  return {
    type: 'root', nodes: [
      { type: 'output', name: '__i3', nodes: [{ type: 'con', nodes: [{ type: 'workspace', name: '__i3_scratch', nodes: [win(90)], floating_nodes: [] }] }] },
      { type: 'output', name: 'DP-1', nodes: [
        { type: 'dockarea', nodes: [win(99)] },
        { type: 'con', nodes: [
          { type: 'workspace', name: '1', nodes: one.map(win), floating_nodes: oneFloating.map(id => ({ type: 'floating_con', nodes: [win(id)], floating_nodes: [] })) },
          { type: 'workspace', name: '3', nodes: [win(30)], floating_nodes: [] }
        ] }
      ] },
      { type: 'output', name: 'HDMI-1', nodes: [{ type: 'con', nodes: [{ type: 'workspace', name: '5', nodes: two.map(win), floating_nodes: [] }] }] }
    ]
  };
}
const workspaces = [{ name: '1', visible: true }, { name: '3', visible: false }, { name: '5', visible: true }];

describe('workspaceWatcher', () => {
  it('finds the outputs whose visible workspace holds a window, counting floating ones and not docks or the scratchpad', () => {
    expect([...occupiedOutputs(tree(), workspaces)]).to.deep.equal([]);
    expect([...occupiedOutputs(tree({ one: [1] }), workspaces)]).to.deep.equal(['DP-1']);
    expect([...occupiedOutputs(tree({ oneFloating: [2] }), workspaces)]).to.deep.equal(['DP-1']);
    expect([...occupiedOutputs(tree({ two: [3] }), workspaces)]).to.deep.equal(['HDMI-1']);
    // Workspace 3 has a window but is not shown
    expect([...occupiedOutputs(tree(), [{ name: '3', visible: true }])]).to.deep.equal(['DP-1']);
  });

  it('reads the tree once events settle, and from the first tick of a subscription', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill() {} });
    const spawned = [];
    let reads = 0;
    const exec = async (file, args) => {
      if (args[1] === 'get_tree') reads++;
      return JSON.stringify(args[1] === 'get_tree' ? tree({ one: [1] }) : workspaces);
    };
    const changes = [];
    const watcher = new WorkspaceWatcher({
      spawn: (file, args) => { spawned.push([file, ...args]); return child; }, exec, logger: silentLogger, settle: 5,
      onChange: occupied => changes.push([...occupied])
    });
    watcher.start();
    expect(spawned).to.deep.equal([['i3-msg', '-t', 'subscribe', '-m', '["window","workspace","tick"]']]);
    child.stdout.write('{"first":true}\n');
    child.stdout.write('{"change":"focus"}\n{"change":"new"}\n');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(reads).to.equal(1);
    expect(changes).to.deep.equal([['DP-1']]);
    watcher.stop();
  });
});
