import { expect } from 'chai';
import { EventEmitter } from 'events';
import { X11 } from '../../src/display/x11.js';

// An X client over a fake tree: { id: { children, mark, name, geometry } }, where an id missing from it has vanished
function fakeClient(tree, rootChildren, atom = 99) {
  const client = new EventEmitter();
  const gone = id => Object.assign(new Error(`no window ${id}`), { id });
  client.InternAtom = (onlyIfExists, name, done) => done(null, atom);
  client.QueryTree = (id, done) => {
    if (id === 1) return done(null, { children: rootChildren });
    return tree[id] ? done(null, { children: tree[id].children ?? [] }) : done(gone(id));
  };
  client.GetProperty = (del, id, property, type, offset, length, done) => {
    if (!tree[id]) return done(gone(id));
    const value = property === atom ? tree[id].mark : tree[id].name;
    return done(null, { data: Buffer.from(value ?? '') });
  };
  client.GetGeometry = (id, done) => (tree[id] ? done(null, tree[id].geometry) : done(gone(id)));
  return client;
}

describe('X11 overlays', () => {
  const geometry = { xPos: 5, yPos: 6, width: 70, height: 80 };

  it('finds the mark on a window inside a window manager\'s frame, stacking the frame and naming the window', async () => {
    const tree = {
      10: { children: [11], name: 'frame', geometry },
      11: { mark: 'below', name: 'sleeve' }
    };
    expect(await new X11(fakeClient(tree, [10]), 1).overlays()).to.deep.equal([
      { window: 10, position: 'below', name: 'sleeve', geometry: { x: 5, y: 6, width: 70, height: 80 } }
    ]);
  });

  it('finds it on an unmanaged top-level window, and takes that over a child\'s', async () => {
    const tree = {
      20: { children: [21], mark: 'above', name: 'top', geometry },
      21: { mark: 'below', name: 'child' }
    };
    const [found] = await new X11(fakeClient(tree, [20]), 1).overlays();
    expect(found).to.include({ window: 20, position: 'above', name: 'top' });
  });

  it('looks no deeper than a direct child, and passes over unmarked windows', async () => {
    const tree = {
      30: { children: [31], geometry },
      31: { children: [32] },
      32: { mark: 'below' }
    };
    expect(await new X11(fakeClient(tree, [30]), 1).overlays()).to.deep.equal([]);
  });

  it('keeps the stacking order and skips windows that vanish while being looked at', async () => {
    const tree = {
      40: { mark: 'above', name: 'low', geometry },
      42: { mark: 'above', name: 'high', geometry }
    };
    const found = await new X11(fakeClient(tree, [40, 41, 42]), 1).overlays();
    expect(found.map(item => item.name)).to.deep.equal(['low', 'high']);
  });

  it('finds none when no program ever made the mark', async () => {
    expect(await new X11(fakeClient({}, [50], 0), 1).overlays()).to.deep.equal([]);
  });
});
