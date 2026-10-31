import fsExtra from 'fs-extra';
import os from 'os';
import path from 'path';

// Requests every instance needs to sit transparently between the wallpaper and the windows: an unmanaged
// window stacked low ("!-"), clicks passing through, and "native" (compositor) transparency. "xroot"
// would copy the root pixmap, which backdrop never sets, so it would hide the wallpaper.
const BASE_REQUESTS = [
  'setopacity "native"', 'setbg 00000000', 'setxwintype "!-"', 'setclickthrough true', 'setdecorated false',
  'setfloating false', 'setfocused false', 'setmaximized false', 'setprintframes false'
];

// Replaces the #define lines of a module's settings file (e.g. bars.glsl) with the given values and
// appends the ones it does not have
export function applyDefines(source, values) {
  const remaining = new Map(Object.entries(values));
  const lines = source.split('\n').map(line => {
    const match = /^(\s*)#define\s+([A-Za-z_]\w*)\b/.exec(line);
    if (!match || !remaining.has(match[2])) return line;
    const value = remaining.get(match[2]);
    remaining.delete(match[2]);
    return `${match[1]}#define ${match[2]} ${value}`;
  });
  const added = [...remaining].map(([name, value]) => `#define ${name} ${value}`);
  return [...lines, ...(added.length ? ['', '/* Added by backdrop */', ...added] : [])].join('\n');
}

// GLava behind the visualizer adapter, for one instance of the visualizer section: prepare() builds its
// config root, command() launches it on a monitor. GLava reads $XDG_CONFIG_HOME/glava, so pointing that at the root leaves ~/.config/glava
// alone. The root links every file of the installed shaders, as `glava -C` does, except the module's
// settings file, which is a copy with backdrop's #defines.
export class GlavaVisualizer {
  constructor(settings, instance, { root, fs = fsExtra }) {
    this.settings = settings;
    this.instance = instance;
    this.root = root;
    this.fs = fs;
  }

  title(monitor) {
    return `backdrop-visualizer-${monitor.name}-${this.instance.name}`;
  }

  async prepare() {
    const { shaderDir } = this.settings.glava;
    const { module, defines } = this.instance;
    if (!await this.fs.pathExists(path.join(shaderDir, `${module}.glsl`))) {
      throw new Error(`GLava shaders not found in ${shaderDir} (no ${module}.glsl); set visualizer.glava.shader_dir`);
    }
    const dir = path.join(this.root, 'glava');
    await this.fs.remove(this.root);
    await this.fs.ensureDir(dir);
    for (const entry of await this.fs.readdir(shaderDir)) {
      if (entry === `${module}.glsl`) continue;
      await this.fs.symlink(path.join(shaderDir, entry), path.join(dir, entry));
    }
    const source = await this.fs.readFile(path.join(shaderDir, `${module}.glsl`), 'utf8');
    await this.fs.writeFile(path.join(dir, `${module}.glsl`), applyDefines(source, defines));
  }

  // geometry is absolute in the root window: { x, y, width, height }
  command(monitor, geometry, env = process.env) {
    const { audio, source, glava } = this.settings;
    const { module, requests } = this.instance;
    const all = [
      ...BASE_REQUESTS,
      `setgeometry ${geometry.x} ${geometry.y} ${geometry.width} ${geometry.height}`,
      `settitle "${this.title(monitor)}"`,
      `setsource "${source}"`,
      ...requests
    ];
    return {
      file: 'glava',
      args: [`--audio=${audio}`, `--force-mod=${module}`, ...all.flatMap(request => ['-r', request]), ...glava.args],
      // PulseAudio keeps its cookie under XDG_CONFIG_HOME, so it is pointed back at the user's own
      env: {
        ...env,
        XDG_CONFIG_HOME: this.root,
        PULSE_COOKIE: env.PULSE_COOKIE ?? path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pulse', 'cookie')
      }
    };
  }
}
