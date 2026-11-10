// One-speaker audio sources for a visualizer instance with `channel: left` or `right`. GLava's modules read both
// channels (radial draws one on each half of its circle), so an instance that should follow one speaker reads a
// PulseAudio remap source instead: mono, taken from that channel of the monitor of the source the section names
// (the default output for auto), which the sound server gives a stereo reader on both sides. Through PipeWire's pulse
// server too, where a stereo remap that copies one channel to both sides leaves the other silent.

export const CHANNELS = ['both', 'left', 'right'];
const PREFIX = 'backdrop_';

export const channelSource = channel => `${PREFIX}${channel}`;

// The modules this manages, as `pactl list short modules` shows them: { id, channel, master }
function ownModules(listing) {
  return listing.split('\n').flatMap(line => {
    const [id, name, args = ''] = line.split('\t');
    if (name !== 'module-remap-source') return [];
    const channel = /source_name=backdrop_(left|right)\b/.exec(args)?.[1];
    const master = /master=(\S+)/.exec(args)?.[1];
    return channel ? [{ id: id.trim(), channel, master }] : [];
  });
}

export class ChannelSources {
  constructor({ exec, logger }) {
    Object.assign(this, { exec, logger });
    this.warned = false;
  }

  // The source the remaps take from: the default output's monitor for auto, else the section's source as given
  async master(source) {
    if (source !== 'auto') return source;
    return `${(await this.exec('pactl', ['get-default-sink'])).trim()}.monitor`;
  }

  // Makes the remap source of each channel in channels exist, from source's monitor, and removes those no longer
  // wanted or taken from another master. Resolves to the channels that are ready; on a failure (no pactl, no
  // sound server) the ones it could not make are left out, and their instances read the section's source.
  async sync(channels, source) {
    const wanted = new Set(channels.filter(channel => channel !== 'both'));
    const ready = new Set();
    try {
      const master = wanted.size ? await this.master(source) : null;
      const existing = ownModules(await this.exec('pactl', ['list', 'short', 'modules']));
      for (const module of existing) {
        if (wanted.has(module.channel) && module.master === master && !ready.has(module.channel)) {
          ready.add(module.channel);
          continue;
        }
        await this.exec('pactl', ['unload-module', module.id]);
      }
      for (const channel of wanted) {
        if (ready.has(channel)) continue;
        await this.exec('pactl', [
          'load-module', 'module-remap-source', `master=${master}`, `source_name=${channelSource(channel)}`, 'channels=1',
          `master_channel_map=front-${channel}`, 'channel_map=mono', `source_properties=device.description=backdrop-${channel}`
        ]);
        ready.add(channel);
        this.logger.info('Visualizer channel source', { channel, master });
      }
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn('Cannot make one-speaker audio sources, so those instances show both speakers', { error: error.message });
      }
    }
    return ready;
  }

  // Removes every remap source this made
  release(source = 'auto') {
    return this.sync([], source);
  }
}
