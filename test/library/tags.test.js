import { expect } from 'chai';
import { parseTags, pageSlug, tagsFor } from '../../src/library/tags.js';

describe('tags', () => {
  describe('parseTags', () => {
    it('splits names on punctuation and camelCase and lowercases them', () => {
      expect(parseTags('ocean_waves-AerialCoast.final')).to.deep.equal(['ocean', 'waves', 'aerial', 'coast']);
    });

    it('drops words with digits, short words, stop words and file or camera boilerplate', () => {
      expect(parseTags('3571264-uhd_3840_2160_30fps')).to.deep.equal([]);
      expect(parseTags('DJI_0042 sunset over the lake 4k h264')).to.deep.equal(['sunset', 'lake']);
      expect(parseTags('pexels-video-of-a-red-fox')).to.deep.equal(['red', 'fox']);
    });

    it('keeps letters outside ASCII and removes duplicates', () => {
      expect(parseTags('Café café Straße')).to.deep.equal(['café', 'straße']);
      expect(parseTags('')).to.deep.equal([]);
      expect(parseTags(null)).to.deep.equal([]);
    });
  });

  it('takes the last path segment of a page URL', () => {
    expect(pageSlug('https://www.pexels.com/video/aerial-view-of-waves-1234/')).to.equal('aerial-view-of-waves-1234');
    expect(pageSlug('not a url')).to.equal('');
  });

  describe('tagsFor', () => {
    it('uses the original file name of local imports', () => {
      expect(tagsFor({ source: 'local', original_name: 'Snowy Mountains.mov' })).to.deep.equal([
        { tag: 'snowy', origin: 'filename' }, { tag: 'mountains', origin: 'filename' }
      ]);
    });

    it('ignores remote-<id> names and combines the page slug with the description, first origin winning', () => {
      expect(tagsFor({
        source: 'pexels', original_name: 'remote-12.mp4',
        page_url: 'https://www.pexels.com/photo/green-forest-99/', tags: ['Forest path in green light']
      })).to.deep.equal([
        { tag: 'green', origin: 'page' }, { tag: 'forest', origin: 'page' },
        { tag: 'path', origin: 'description' }, { tag: 'light', origin: 'description' }
      ]);
    });
  });
});
