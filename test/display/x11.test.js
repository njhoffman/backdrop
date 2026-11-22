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

describe('X11 uncoveredArea', () => {
  const TYPE = 300;
  const DOCK = 301;
  const monitor = { x: 1920, y: 0, width: 1920, height: 1080 };

  // windows: { id: { geometry: [x, y, width, height], mapped, inputOnly, dock, children } }, rootChildren bottom to top
  function client(windows, rootChildren, { atoms = true } = {}) {
    const fake = new EventEmitter();
    const gone = id => new Error(`no window ${id}`);
    fake.InternAtom = (onlyIfExists, name, done) => done(null, !atoms ? 0 : { _NET_WM_WINDOW_TYPE: TYPE, _NET_WM_WINDOW_TYPE_DOCK: DOCK }[name] ?? 0);
    fake.QueryTree = (id, done) => (id === 1 ? done(null, { children: rootChildren }) : windows[id] ? done(null, { children: windows[id].children ?? [] }) : done(gone(id)));
    fake.GetWindowAttributes = (id, done) => (windows[id] ? done(null, { mapState: windows[id].mapped === false ? 0 : 2, klass: windows[id].inputOnly ? 2 : 1 }) : done(gone(id)));
    fake.GetGeometry = (id, done) => {
      if (!windows[id]) return done(gone(id));
      const [xPos, yPos, width, height] = windows[id].geometry ?? [0, 0, 1, 1];
      return done(null, { xPos, yPos, width, height });
    };
    fake.GetProperty = (del, id, property, type, offset, length, done) => {
      if (!windows[id]) return done(gone(id));
      const data = Buffer.alloc(windows[id].dock ? 4 : 0);
      if (windows[id].dock) data.writeUInt32LE(DOCK, 0);
      return done(null, { data });
    };
    return fake;
  }
  const area = (windows, children, own, options) => new X11(client(windows, children, options), 1).uncoveredArea(monitor, own);

  it('gives the whole monitor when only its own windows lie above the wallpaper', async () => {
    const windows = { 10: { geometry: [1920, 0, 1920, 1080] }, 11: { geometry: [1920, 800, 1920, 280] }, 5: { geometry: [0, 0, 1920, 1080] } };
    // 5, below the wallpaper, and windows on the other monitor do not count
    expect(await area({ ...windows, 20: { geometry: [0, 0, 1920, 1080] } }, [5, 10, 11, 20], [10, 11])).to.deep.equal(monitor);
  });

  it('is null when another window overlaps the monitor above the wallpaper', async () => {
    const windows = { 10: { geometry: [1920, 0, 1920, 1080] }, 30: { geometry: [3000, 500, 400, 300] } };
    expect(await area(windows, [10, 30], [10])).to.equal(null);
  });

  it('passes over unmapped, input-only and vanished windows', async () => {
    const windows = { 10: {}, 30: { geometry: [1920, 0, 100, 100], mapped: false }, 31: { geometry: [1920, 0, 100, 100], inputOnly: true } };
    expect(await area(windows, [10, 30, 31, 32], [10])).to.deep.equal(monitor);
  });

  it('crops docks along the top and bottom edges, found on the window or inside its frame', async () => {
    const windows = {
      10: {}, 40: { geometry: [1920, 0, 1920, 20], dock: true },
      41: { geometry: [1920, 1058, 1920, 22], children: [42] }, 42: { dock: true }
    };
    expect(await area(windows, [10, 40, 41], [10])).to.deep.equal({ x: 1920, y: 20, width: 1920, height: 1038 });
  });

  it('is null for a dock away from the edges, or with no dock atoms at all', async () => {
    expect(await area({ 10: {}, 40: { geometry: [1920, 500, 1920, 20], dock: true } }, [10, 40], [10])).to.equal(null);
    expect(await area({ 10: {}, 40: { geometry: [1920, 0, 1920, 20], dock: true } }, [10, 40], [10], { atoms: false })).to.equal(null);
  });

  it('is null when none of its own windows is a top-level', async () => {
    expect(await area({ 10: {} }, [10], [99])).to.equal(null);
  });
});
