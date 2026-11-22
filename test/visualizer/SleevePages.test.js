import { expect } from 'chai';
import { changedLook, lostStartOption, styleChange } from '../../src/visualizer/SleevePages.js';

describe('SleevePages', () => {
  describe('sleeve\'s style', () => {
    const look = style => ({ now: 'lyrics', background: 'cover', style });

    it('counts a style as changed by its content, in any order', () => {
      expect(changedLook(look({ '--art-size': '512', '--art-blur': '0' }), look({ '--art-blur': '0', '--art-size': '512' }))).to.equal(false);
      expect(changedLook(look(null), look(null))).to.equal(false);
      expect(changedLook(look({ '--art-size': '512' }), look({ '--art-size': '256' }))).to.equal(true);
      expect(changedLook(look(null), look({ '--art-size': '512' }))).to.equal(true);
      expect(changedLook(look({ '--art-size': '512' }), look(null))).to.equal(true);
    });

    it('takes a name the page started with and the next look drops as a lost start option', () => {
      expect(lostStartOption(look({ '--art-size': '512' }), look({ '--art-size': '256' }))).to.equal(false);
      expect(lostStartOption(look({ '--art-size': '512' }), look({ '--art-blur': '0' }))).to.equal(true);
      expect(lostStartOption(look({ '--art-size': '512' }), look(null))).to.equal(true);
      expect(lostStartOption(look(null), look({ '--art-size': '512' }))).to.equal(false);
    });

    it('sends an empty value for each name the next style drops, and nothing when neither has one', () => {
      expect(styleChange({ '--art-size': '512', '--art-blur': '0' }, { '--art-size': '256' })).to.deep.equal({ '--art-blur': '', '--art-size': '256' });
      expect(styleChange(null, { '--art-size': '256' })).to.deep.equal({ '--art-size': '256' });
      expect(styleChange({ '--art-size': '512' }, null)).to.deep.equal({ '--art-size': '' });
      expect(styleChange(null, null)).to.equal(null);
    });
  });
});
