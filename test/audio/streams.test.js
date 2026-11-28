import { expect } from 'chai';
import { RELAY_SINK, activity, readActivity, sinkVolume, streamPlayer } from '../../src/audio/streams.js';

const PLAYERS = ['spotify', 'mpd', 'musicman'];

// Sink inputs and sinks as `pactl -f json` lists them through PipeWire's pulse server, cut to what is read
const input = (index, sink, properties, corked = false) => ({ index, sink, corked, properties });
const sink = (index, name, percent, mute = false) => ({
  index, name, mute, state: 'RUNNING',
  volume: { 'front-left': { value_percent: `${percent}%` }, 'front-right': { value_percent: `${percent}%` } }
});
const spotify = { 'application.name': 'spotify', 'application.process.binary': 'spotify', 'node.name': 'spotify' };
const mpd = { 'application.name': 'Music Player Daemon', 'application.process.binary': 'mpd' };
const firefox = { 'application.name': 'Firefox', 'application.process.binary': 'firefox' };
const SINKS = [sink(57, 'alsa_output.hdmi', 100), sink(130, 'bluez_output.AC_BF.1', 54), sink(200, RELAY_SINK, 100)];

describe('audio streams', () => {
  it('knows a player by its application name, program or node name, ignoring case', () => {
    expect(streamPlayer(input(1, 130, spotify), PLAYERS)).to.equal('spotify');
    expect(streamPlayer(input(1, 130, mpd), PLAYERS)).to.equal('mpd');
    expect(streamPlayer(input(1, 130, { 'node.name': 'MusicMan-player' }), PLAYERS)).to.equal('musicman');
    expect(streamPlayer(input(1, 130, firefox), PLAYERS)).to.be.null;
    expect(streamPlayer(input(1, 130, {}), PLAYERS)).to.be.null;
  });

  it('reads a sink volume as its loudest channel, null when there is none', () => {
    expect(sinkVolume(sink(1, 'a', 54))).to.equal(54);
    expect(sinkVolume({ volume: { 'front-left': { value_percent: '40%' }, 'front-right': { value_percent: '45%' } } })).to.equal(45);
    expect(sinkVolume({})).to.be.null;
    expect(sinkVolume(null)).to.be.null;
  });

  it('is active while an uncorked player stream plays, on the sink it plays on', () => {
    const result = activity([input(1, 57, firefox), input(2, 130, spotify)], SINKS, { players: PLAYERS, defaultSink: 'alsa_output.hdmi' });
    expect(result).to.deep.equal({ active: true, player: 'spotify', sink: 'bluez_output.AC_BF.1', volume: 54, muted: false });
  });

  it('leaves out corked streams, other programs and the relay sink, reporting the default output', () => {
    const inputs = [input(1, 130, spotify, true), input(2, 130, firefox), input(3, 200, mpd)];
    const result = activity(inputs, SINKS, { players: PLAYERS, defaultSink: 'bluez_output.AC_BF.1' });
    expect(result).to.deep.equal({ active: false, player: null, sink: 'bluez_output.AC_BF.1', volume: 54, muted: false });
  });

  it('reports a muted sink, and a default output it cannot find by name only', () => {
    const muted = activity([input(2, 130, spotify)], [sink(130, 'bluez_output.AC_BF.1', 30, true)], { players: PLAYERS });
    expect(muted).to.include({ active: true, muted: true, volume: 30 });
    expect(activity([], [], { players: PLAYERS, defaultSink: 'gone' })).to.deep.equal({ active: false, player: null, sink: 'gone', volume: null, muted: false });
  });

  it('reads the snapshot with pactl', async () => {
    const calls = [];
    const exec = async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (args.includes('sink-inputs')) return JSON.stringify([input(2, 130, spotify)]);
      if (args.includes('sinks')) return JSON.stringify(SINKS);
      return 'bluez_output.AC_BF.1\n';
    };
    expect(await readActivity(exec, { players: PLAYERS })).to.include({ active: true, player: 'spotify', volume: 54 });
    expect(calls).to.have.members(['pactl -f json list sink-inputs', 'pactl -f json list sinks', 'pactl get-default-sink']);
  });
});
