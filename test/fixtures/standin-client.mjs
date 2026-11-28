// A stand-in for a maximized program's window in the placement test: a mapped window covering the whole screen,
// which xwinwrap takes for its parent when the root has no virtual root (a terminal on minerva, 3.3.1). With
// `desktop` it is marked _NET_WM_WINDOW_TYPE_DESKTOP, as a file manager's desktop window is. Prints its window id
// once it is mapped.
// Usage: node standin-client.mjs [desktop]
import x11 from 'x11';

const desktop = process.argv[2] === 'desktop';
const ATOM = 4;

x11.createClient((error, display) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const { client } = display;
  const screen = display.screen[0];
  const id = client.AllocID();
  client.CreateWindow(id, screen.root, 0, 0, screen.pixel_width, screen.pixel_height, 0, 0, 0, 0,
    { backgroundPixel: 0x202020, eventMask: x11.eventMask.StructureNotify });
  client.ChangeProperty(0, id, client.atoms.WM_NAME, client.atoms.STRING, 8, desktop ? 'standin-desktop' : 'standin-client');
  const mapped = () => client.MapWindow(id);
  client.on('event', event => {
    if (event.name === 'MapNotify') console.log(id);
  });
  if (!desktop) return mapped();
  client.InternAtom(false, '_NET_WM_WINDOW_TYPE', (typeError, type) => {
    client.InternAtom(false, '_NET_WM_WINDOW_TYPE_DESKTOP', (desktopError, value) => {
      client.ChangeProperty(0, id, type, ATOM, 32, [value]);
      mapped();
    });
  });
});

process.on('SIGTERM', () => process.exit(0));
