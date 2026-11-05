// projectM (projectMSDL) behind the visualizer adapter. It has no way to embed or to set its window type, so SDL is
// told to make the window override-redirect, which keeps i3 from tiling it. It also opens centered whatever its
// --left and --top say, so the manager moves it (moves), and its title follows the projectM preset, so the
// window is found by process (search). It is costly on GPU and CPU: fps is the main control.
export class ProjectmVisualizer {
  constructor(settings, instance) {
    this.settings = settings;
    this.instance = instance;
    this.moves = true;
  }

  title(monitor) {
    return `projectM ${monitor.name}`;
  }

  search(child) {
    return ['search', '--pid', String(child.pid)];
  }

  async prepare() {}

  // geometry is absolute in the root window: { x, y, width, height }
  command(monitor, { x, y, width, height }, env = process.env) {
    const { command, fps, presetDuration, presetPath, args } = this.instance.projectm;
    return {
      file: command ?? 'projectMSDL',
      args: [
        `--left=${x}`, `--top=${y}`, `--width=${width}`, `--height=${height}`, '--fullscreen=0', '--enableSplash=0',
        `--fps=${fps}`, `--presetDuration=${presetDuration}`,
        ...(presetPath ? [`--presetPath=${presetPath}`] : []),
        ...args
      ],
      env: {
        ...env,
        SDL_X11_FORCE_OVERRIDE_REDIRECT: '1',
        // Otherwise it records from the default capture device, a microphone, rather than what is playing
        SDL_AUDIODRIVER: 'pulseaudio',
        PULSE_SOURCE: '@DEFAULT_MONITOR@'
      }
    };
  }
}
