// A stand-in for GLava in the stacking test, which cannot run GLava under Xvfb: an unmanaged window with the
// instance's title at the given geometry that, like GLava, lowers itself to the bottom of the stack once it
// maps, and again a moment later, so the daemon's placement has to put it back above the wallpaper.
// Usage: node standin-visualizer.mjs <title> <x> <y> <width> <height>
import x11 from 'x11';

const [title, x, y, width, height] = process.argv.slice(2);
const STACK_BELOW = 1;

x11.createClient((error, display) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const client = display.client;
  const id = client.AllocID();
  client.CreateWindow(id, display.screen[0].root, Number(x), Number(y), Number(width), Number(height), 0, 0, 0, 0,
    { overrideRedirect: true, backgroundPixel: 0x33aacc, eventMask: x11.eventMask.StructureNotify });
  client.ChangeProperty(0, id, client.atoms.WM_NAME, client.atoms.STRING, 8, title);
  client.on('event', event => {
    if (event.name !== 'MapNotify') return;
    client.ConfigureWindow(id, { stackMode: STACK_BELOW });
    setTimeout(() => client.ConfigureWindow(id, { stackMode: STACK_BELOW }), 200);
  });
  client.MapWindow(id);
});

process.on('SIGTERM', () => process.exit(0));
