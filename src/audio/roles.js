// Which machine is the audio server, from what each one plays (streams.js). The machine whose players play while
// the other's do not is the server; the other is its client and relays the music. When both play, or neither, or
// the other machine cannot be reached (peer null), each stays local.

export const ROLES = ['server', 'client', 'local'];

export function decideRole(local, peer) {
  if (!peer) return 'local';
  const here = Boolean(local?.active);
  const there = Boolean(peer.active);
  if (here && !there) return 'server';
  if (there && !here) return 'client';
  return 'local';
}

// The host whose speakers play: this one as server, the peer as client, none while local
export function serverHost(role, hostname, peer) {
  if (role === 'server') return hostname;
  if (role === 'client') return peer;
  return null;
}
