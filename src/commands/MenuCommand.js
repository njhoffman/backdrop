import { spawn } from 'child_process';
import { DisplayCommand } from './DisplayCommand.js';
import { RatingCommand } from './RatingCommand.js';
import { MODE_KINDS, getMode, otherMode } from '../display/Playlist.js';
import { describeNotification, escapeMarkup, notifyError } from '../utils/notify.js';
import { formatAdjustments } from '../utils/mediaView.js';

const SPEEDS = ['0.5', '0.75', '1', '1.25', '1.5', '+0.1', '-0.1'];
const DIMS = ['0', '20', '40', '60', '+10', '-10'];

// Shows entries in rofi -dmenu and resolves to the picked index, or null when the menu was dismissed.
// -format i returns the index, so labels never have to be parsed back; -no-custom rejects typed text.
export function rofiMenu(extraArgs = [], spawnProcess = spawn) {
  return (entries, { prompt, message }) => new Promise((resolve, reject) => {
    const args = ['-dmenu', '-i', '-no-custom', '-format', 'i', '-p', prompt, ...(message ? ['-mesg', message] : []), ...extraArgs];
    const child = spawnProcess('rofi', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('rofi is not installed') : error));
    child.on('close', code => {
      // rofi exits 1 when dismissed with Escape
      if (code === 1) resolve(null);
      else if (code === 0 && /^\d+$/.test(output.trim())) resolve(Number(output.trim()));
      else reject(new Error(`rofi exited with code ${code}`));
    });
    child.stdin.end(`${entries.join('\n')}\n`);
  });
}

// A rofi menu over the playback and rating commands for the monitor under the pointer (or --monitor).
// It closes after an action unless --stay is given; speed and dim stay in their submenu for repeated steps.
export class MenuCommand {
  constructor(config, database, logger, { display, rating, runMenu } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.display = display ?? new DisplayCommand(config, database, logger);
    this.rating = rating ?? new RatingCommand(config, database, logger, { control: this.display.control });
    this.runMenu = runMenu ?? rofiMenu(config.get().menu?.rofi_args ?? []);
  }

  get control() {
    return this.display.control;
  }

  // Each menu returns null when dismissed, { monitor } to retarget, { back: true } to show the main menu
  // again, or { done: true } after an action. Opened from a keybinding there is no terminal to read an
  // error from, so errors are also sent as notifications; with --stay the menu then stays open.
  async open(options = {}) {
    let monitor;
    try {
      monitor = (await this.control.targetMonitor(options.monitor)).name;
    } catch (error) {
      await notifyError(error.message, { logger: this.logger });
      throw error;
    }
    for (;;) {
      let result;
      try {
        result = await this.mainMenu(monitor);
      } catch (error) {
        await notifyError(error.message, { logger: this.logger });
        if (!options.stay) throw error;
        continue;
      }
      if (!result) return;
      if (result.monitor) monitor = result.monitor;
      else if (!result.back && !options.stay) return;
    }
  }

  // The playing item as rofi's message, e.g. "#412  video  3840x2160\n0:18 · 25 fps · ★★☆ · DP-1"
  async describe(monitorName) {
    const { monitor, media, rating } = await this.control.current(monitorName);
    if (!media) return { media: null, message: escapeMarkup(`${monitor.name}: nothing from the library playing`) };
    const { summary, body } = describeNotification({ monitor, media, rating, tags: this.database.getTags(media.id) });
    const adjustments = formatAdjustments(media);
    return { media, message: [escapeMarkup(summary), body, adjustments && escapeMarkup(adjustments)].filter(Boolean).join('\n') };
  }

  async mainMenu(monitor) {
    const { media, message } = await this.describe(monitor);
    const target = { monitor };
    const items = [];
    if (media) {
      items.push(
        ['keep 1', () => this.rating.keep(1, target)],
        ['keep 2', () => this.rating.keep(2, target)],
        ['keep 3', () => this.rating.keep(3, target)],
        ['keep 3 and next', () => this.rating.keep(3, { ...target, next: true })],
        ['skip', () => this.rating.skip(target)]
      );
    }
    items.push(['undo', () => this.rating.undo()]);
    items.push(
      ['next', () => this.display.next({ ...target, random: false })],
      ['next (random)', () => this.display.next({ ...target, random: true })],
      ['prev', () => this.display.prev(target)]
    );
    if (media) items.push(['go-next', () => this.rating.goNext(target)]);
    if (media && MODE_KINDS.video.includes(media.kind)) items.push(['speed ▸', () => this.stepMenu(monitor, 'speed', SPEEDS)]);
    if (media) items.push(['dim ▸', () => this.stepMenu(monitor, 'dim', DIMS)]);
    const other = otherMode(getMode(this.database));
    items.push([`mode: switch to ${other}s`, () => this.display.mode(other, target)]);
    const { monitors } = await this.control.state();
    if (monitors.length > 1) items.push([`monitor: ${monitor} ▸`, () => this.monitorMenu(monitor)]);

    const picked = await this.runMenu(items.map(([label]) => label), { prompt: 'backdrop', message });
    if (picked === null) return null;
    return (await items[picked][1]()) ?? { done: true };
  }

  // Applies values until dismissed, showing the new value each time; dismissing it ends the action
  async stepMenu(monitor, kind, values) {
    for (;;) {
      const { media, message } = await this.describe(monitor);
      if (!media) return { back: true };
      const current = kind === 'speed' ? media.speed : media.dim;
      const picked = await this.runMenu(values, { prompt: `${kind} (now ${current})`, message });
      if (picked === null) return { done: true };
      await this.display[kind](values[picked], { monitor });
    }
  }

  async monitorMenu(current) {
    const { monitors } = await this.control.state();
    const picked = await this.runMenu(monitors.map(monitor => (monitor.name === current ? `${monitor.name} (current)` : monitor.name)),
      { prompt: 'monitor', message: escapeMarkup(`Target for the menu's actions: ${current}`) });
    return picked === null ? { back: true } : { monitor: monitors[picked].name };
  }
}
