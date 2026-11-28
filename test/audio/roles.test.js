import { expect } from 'chai';
import { decideRole, serverHost } from '../../src/audio/roles.js';

const playing = { active: true };
const quiet = { active: false };

describe('audio roles', () => {
  it('makes the machine that plays alone the server and the other its client', () => {
    expect(decideRole(playing, quiet)).to.equal('server');
    expect(decideRole(quiet, playing)).to.equal('client');
  });

  it('keeps both local when both play or neither does', () => {
    expect(decideRole(playing, playing)).to.equal('local');
    expect(decideRole(quiet, quiet)).to.equal('local');
  });

  it('stays local while the other machine cannot be reached, or before this one is read', () => {
    expect(decideRole(playing, null)).to.equal('local');
    expect(decideRole(null, playing)).to.equal('client');
    expect(decideRole(null, null)).to.equal('local');
  });

  it('names the host whose speakers play', () => {
    expect(serverHost('server', 'charon', 'minerva')).to.equal('charon');
    expect(serverHost('client', 'minerva', 'charon')).to.equal('charon');
    expect(serverHost('local', 'charon', 'minerva')).to.be.null;
  });
});
