import { expect } from 'chai';
import { AUTO_RULES, choosePreset, imageStats, imageTags, ruleFits, ruleProblem } from '../../src/visualizer/autoRules.js';
import { BUILTIN_PRESETS } from '../../src/visualizer/presets.js';

const pixels = (rgb, count = 4) => Buffer.from(Array.from({ length: count }, () => rgb).flat());

describe('autoRules', () => {
  it('measures brightness, chroma and the shares of colored and vivid pixels, and tags an image by them', () => {
    expect(imageStats(pixels([255, 255, 255]))).to.deep.equal({ brightness: 1, chroma: 0, colored: 0, vivid: 0 });
    expect(imageStats(pixels([0, 0, 0]))).to.include({ brightness: 0, chroma: 0 });
    expect(imageStats(pixels([200, 20, 20]))).to.include({ colored: 1, vivid: 1 });
    expect(imageStats([])).to.equal(null);
    // A black and white photo with a red band is not black and white: the band's share counts, not the mean
    const banded = Buffer.concat([pixels([90, 90, 90], 90), pixels([200, 30, 30], 10)]);
    expect(imageTags(imageStats(banded))[0]).to.equal('muted');
    // A grey photo is black and white whatever its brightness; a saturated dark one is colorful and dark
    expect(imageTags(imageStats(pixels([120, 120, 125])))).to.deep.equal(['grayscale', 'mid']);
    expect(imageTags(imageStats(pixels([40, 5, 120])))).to.deep.equal(['colorful', 'dark']);
    expect(imageTags(imageStats(pixels([230, 200, 160])))).to.deep.equal(['muted', 'bright']);
    expect(imageTags(null)).to.deep.equal([]);
  });

  it('picks by the decision order: behind windows bars, then lyrics, the image preferred and what it is like', () => {
    const pick = moment => choosePreset({ view: 'fullscreen', lyrics: true, prefer: 'cover', image: ['colorful', 'mid'], ...moment })?.preset;
    expect(pick({ view: 'background' })).to.equal('bars');
    // Behind windows never lyrics, even with them and a black and white cover
    expect(pick({ view: 'background', image: ['grayscale', 'dark'] })).to.equal('bars');
    // The user's first rule: a black and white cover, the cover preferred
    expect(pick({ image: ['grayscale', 'mid'] })).to.equal('lyrics-sharp-duotone');
    expect(pick({})).to.equal('lyrics-blurred-soft-tinted');
    expect(pick({ prefer: 'wallpaper', image: ['grayscale', 'mid'] })).to.equal('lyrics-veil');
    // No lyrics, or not known yet: a look made without them
    expect(pick({ lyrics: false, prefer: 'wallpaper' })).to.equal('radials');
    expect(pick({ lyrics: null, prefer: 'cover' })).to.equal('cover-radials');
    expect(pick({ lyrics: false, image: ['grayscale', 'mid'] })).to.equal('cover-radials');
  });

  it('tries the config\'s rules first, matching every image tag a rule names', () => {
    const mine = [{ when: { view: 'fullscreen', image: ['colorful', 'bright'] }, preset: 'lyrics-blurred-vivid', reason: 'bright and colorful' }];
    const moment = { view: 'fullscreen', lyrics: true, prefer: 'cover', image: ['colorful', 'bright'] };
    expect(choosePreset(moment, [...mine, ...AUTO_RULES])).to.deep.equal({ preset: 'lyrics-blurred-vivid', reason: 'bright and colorful' });
    expect(ruleFits(mine[0], { ...moment, image: ['colorful', 'dark'] })).to.equal(false);
    // A rule without a reason is described by its conditions
    expect(choosePreset({ view: 'background' }, [{ when: { view: 'background', lyrics: false }, preset: 'graph' }])).to.deep.equal({ preset: 'graph', reason: 'behind windows, no lyrics' });
    expect(choosePreset({ view: 'fullscreen' }, [])).to.equal(null);
  });

  it('names only presets there are, and checks a rule\'s conditions', () => {
    const presets = Object.keys(BUILTIN_PRESETS);
    for (const rule of AUTO_RULES) expect(ruleProblem(rule, presets), rule.preset).to.equal(null);
    expect(ruleProblem({ when: { view: 'tv' }, preset: 'ring' }, presets)).to.equal('when.view must be fullscreen or background');
    expect(ruleProblem({ when: { image: 'sepia' }, preset: 'ring' }, presets)).to.match(/^when.image must be among/);
    expect(ruleProblem({ when: { lyrics: 'yes' }, preset: 'ring' }, presets)).to.equal('when.lyrics must be true or false');
    expect(ruleProblem({ when: { mood: 'calm' }, preset: 'ring' }, presets)).to.match(/^when.mood is not one of/);
    expect(ruleProblem({ preset: 'nope' }, presets)).to.equal('preset must be one of the presets, not "nope"');
    expect(ruleProblem('ring', presets)).to.equal('must be a mapping with when and preset');
  });
});
