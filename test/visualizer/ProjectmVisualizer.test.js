import { expect } from 'chai';
import { ProjectmVisualizer } from '../../src/visualizer/ProjectmVisualizer.js';

describe('ProjectmVisualizer', () => {
  const adapter = (projectm = {}) => new ProjectmVisualizer({}, { name: 'pm', projectm: { fps: 30, presetDuration: 30, presetPath: null, args: [], command: null, ...projectm } });

  it('asks for the window, override-redirect, recording what plays', () => {
    const { file, args, env } = adapter().command({ name: 'DP-3' }, { x: 10, y: 20, width: 640, height: 360 }, { HOME: '/h' });
    expect(file).to.equal('projectMSDL');
    expect(args).to.include.members(['--left=10', '--top=20', '--width=640', '--height=360', '--fullscreen=0', '--enableSplash=0', '--fps=30']);
    expect(env).to.deep.equal({ HOME: '/h', SDL_X11_FORCE_OVERRIDE_REDIRECT: '1', SDL_AUDIODRIVER: 'pulseaudio', PULSE_SOURCE: '@DEFAULT_MONITOR@' });
  });

  it('passes its settings on', () => {
    const { file, args } = adapter({ fps: 20, presetPath: '/p', args: ['--beatSensitivity=1'], command: '/opt/pm' }).command({ name: 'x' }, { x: 0, y: 0, width: 1, height: 1 }, {});
    expect(file).to.equal('/opt/pm');
    expect(args).to.include.members(['--fps=20', '--presetPath=/p', '--beatSensitivity=1']);
  });

  it('finds its window by process, since the title follows the projectM preset', () => {
    expect(adapter().search({ pid: 42 })).to.deep.equal(['search', '--pid', '42']);
    expect(adapter().moves).to.equal(true);
  });
});
