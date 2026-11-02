// A stand-in for an overlay program such as sleeve in the stacking test: an unmanaged window with the given
// title and geometry, marked _BACKDROP_OVERLAY with a position. Each line on stdin ("above" or "below")
// changes the mark, as an overlay program does when it moves between above and below the visualizer.
// Usage: node standin-overlay.mjs <title> <position> <x> <y> <width> <height>
import readline from 'readline';
import x11 from 'x11';

const [title, position, x, y, width, height] = process.argv.slice(2);

x11.createClient((error, display) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const client = display.client;
  const id = client.AllocID();
  client.CreateWindow(id, display.screen[0].root, Number(x), Number(y), Number(width), Number(height), 0, 0, 0, 0,
    { overrideRedirect: true, backgroundPixel: 0xcc5533 });
  client.ChangeProperty(0, id, client.atoms.WM_NAME, client.atoms.STRING, 8, title);
  client.InternAtom(false, '_BACKDROP_OVERLAY', (atomError, atom) => {
    if (atomError) {
      console.error(atomError.message);
      process.exit(1);
    }
    const mark = value => client.ChangeProperty(0, id, atom, client.atoms.STRING, 8, value);
    mark(position);
    client.MapWindow(id);
    readline.createInterface({ input: process.stdin }).on('line', line => {
      mark(line.trim());
      // A round trip, so the change has reached the server before the test goes on
      client.GetInputFocus(() => console.log('marked'));
    });
  });
});

process.on('SIGTERM', () => process.exit(0));
