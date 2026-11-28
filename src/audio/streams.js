// What this machine's music players are playing, read from the sound server (PulseAudio, or PipeWire's pulse
// server) with `pactl -f json`. Only streams of the players in audio_relay.players count: a notification, a video
// call or the relay's own stream is not music to relay.

// The null sink a client plays the server's music into, which its visualizer reads the monitor of (RelayPipe.js)
export const RELAY_SINK = 'backdrop_relay';

// The stream properties a player is known by; matched case-insensitively, a player's name anywhere in one
const PLAYER_PROPERTIES = ['application.name', 'application.process.binary', 'node.name', 'application.id'];

// The player in players that a sink input belongs to, or null
export function streamPlayer(input, players) {
  const values = PLAYER_PROPERTIES.map(key => String(input?.properties?.[key] ?? '').toLowerCase()).filter(Boolean);
  return players.find(player => values.some(value => value.includes(String(player).toLowerCase()))) ?? null;
}

// A sink's volume in percent: the loudest channel, as pactl gives it ("54%")
export function sinkVolume(sink) {
  const channels = Object.values(sink?.volume ?? {}).map(channel => Number.parseInt(channel?.value_percent, 10));
  const valid = channels.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

// The snapshot for the sink inputs and sinks pactl listed: { active, player, sink, volume, muted }. Active when an
// uncorked stream of a player plays on a sink other than the relay's; its sink is then the one to relay, else the
// default output, whose volume the keys change.
export function activity(inputs, sinks, { players, defaultSink = null }) {
  const byIndex = new Map(sinks.map(sink => [sink.index, sink]));
  const playing = inputs
    .filter(input => !input.corked)
    .map(input => ({ input, player: streamPlayer(input, players), sink: byIndex.get(input.sink) }))
    .find(({ player, sink }) => player && sink && sink.name !== RELAY_SINK);
  const sink = playing?.sink ?? sinks.find(item => item.name === defaultSink) ?? null;
  return {
    active: Boolean(playing),
    player: playing?.player ?? null,
    sink: sink?.name ?? defaultSink,
    volume: sinkVolume(sink),
    muted: Boolean(sink?.mute)
  };
}

// Reads the snapshot from the sound server; throws when pactl or the server is missing
export async function readActivity(exec, { players }) {
  const [inputs, sinks, defaultSink] = await Promise.all([
    exec('pactl', ['-f', 'json', 'list', 'sink-inputs']),
    exec('pactl', ['-f', 'json', 'list', 'sinks']),
    exec('pactl', ['get-default-sink'])
  ]);
  return activity(JSON.parse(inputs || '[]'), JSON.parse(sinks || '[]'), { players, defaultSink: defaultSink.trim() || null });
}
