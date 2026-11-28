// Presets backdrop ships. A preset is laid over the visualizer section (objects merge, lists replace), so it
// can change any setting, including the instance list. visualizer.presets can override these by name. Each
// description is shown by the menu and the web page, and taken out before the preset is laid over the section.
const WALLPAPER_COLORS = { source: 'wallpaper' };
// The hue of the configured colors turning once every 90 seconds, a few times a song, the same for every instance with it
const CYCLE_COLORS = { source: 'cycle', cycle: '90s' };
// The veil looks' lyrics, in the left third under a strip holding a now-playing card (cover, title, artist,
// album, seek bar), so the two never overlap
const VEIL_LYRICS = {
  now: 'full', now_position: 'top-left', now_area: '33%x18%+0+0', lyrics_area: '33%x82%+0+18%', background: 'auto', style: { '--now-scale': '1.8' }
};
// The now-playing panel at a size for a large screen (sleeve 0.49.0's --now-scale; an older sleeve draws it at its own,
// laptop-sized one): minimal, a line with artist and title, or full, a card with the cover, title, artist, album and seek
// bar; where it stands (in area, else the whole page) and how large. The lyrics keep clear of it inside their area.
const nowPanel = (now, position, scale, area = null) => ({
  now, now_position: position, ...(area ? { now_area: area } : {}), style: { '--now-scale': String(scale), '--now-margin': '48px' }
});
const RING = { radius: 150, bars: 180, width: 4, amplify: 250, colors: ['#33aacc', '#a0e0ff'] };
// The veil looks' ring, larger and louder than the ring preset's
const VEIL_RING = { ...RING, radius: 230, width: 5, amplify: 450 };
// Beside lyrics in the left third: bars along the bottom of the rest, and a ring above them
const SIDE_RECTS = { bars: { x: '33%', y: '75%', width: '67%', height: '25%' }, ring: { x: '33%', y: 0, width: '67%', height: '75%' } };
// The bars' colors where they turn through the hues, blue to start with
const CYCLE_BARS = { colors: ['#000000', '#33aacc'] };
// The veil looks' instances: the wallpaper darkened under a see-through layer tinted from it, solid lyrics on it,
// a ring beside them with bars below it. With cycle, the ring and bars turn through the hues together.
function veil({ cycle = false } = {}) {
  const palette = cycle ? { palette: CYCLE_COLORS } : {};
  return [
    { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'fill' }, sleeve: VEIL_LYRICS },
    { name: 'bars', module: 'bars', ...palette, rect: SIDE_RECTS.bars, ...(cycle ? { bars: CYCLE_BARS } : {}) },
    { name: 'ring', module: 'radial', ...palette, rect: SIDE_RECTS.ring, radial: VEIL_RING }
  ];
}

// The Sunamu presets' sleeve settings: Sunamu's layout, and its background through sleeve's CSS swirl. sharp drops
// the layers' filter (no blur, brightness or saturation) and halves the whole background's opacity
function sunamu({ sharp = false } = {}) {
  const panel = nowPanel('full', 'center-left', 3, '40%x100%+0+0');
  return {
    lyrics_area: '60%x100%+40%+0', background: 'cover', cover: 'swirl', ...panel,
    style: {
      ...panel.style, '--art-animation': 'sleeve-art-swirl-css', '--swirl-size': '2', '--swirl-period': '60', '--swirl-delay': '10',
      '--swirl-timing': 'ease-in-out', '--art-dim': '0',
      ...(sharp
        ? { '--swirl-blur': '0px', '--swirl-brightness': '1', '--art-saturation': '1', '--art-opacity': '0.5' }
        : { '--swirl-blur': '180px', '--swirl-brightness': '0.5', '--art-saturation': '1.5', '--art-opacity': '1' })
    }
  };
}

const PRESETS = {
  // Short, thin bars along the bottom, mostly see-through
  subtle: {
    description: 'Short, thin bars along the bottom, mostly see-through',
    opacity: 0.5,
    placement: { anchor: 'bottom', width: '100%', height: '15%' },
    instances: [{ name: 'main', module: 'bars', bars: { width: 8, gap: 2, amplify: 150 } }]
  },
  // A radial ring in the middle of the screen
  ring: {
    description: 'A radial ring in the middle of the screen',
    instances: [{
      name: 'ring', module: 'radial', placement: { anchor: 'center', width: '50%', height: '80%' },
      radial: { radius: 150, bars: 180, width: 4, amplify: 250, colors: ['#33aacc', '#a0e0ff'] }
    }]
  },
  // A thin wave across the whole screen
  wave: {
    description: 'A thin wave across the whole screen',
    instances: [{ name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'fill' }, wave: { color: '#33aacc', max_thickness: 4 } }]
  },
  // Bars along the bottom with a ring above them
  party: {
    description: 'Bars along the bottom with a red and gold ring above them',
    instances: [
      { name: 'base', module: 'bars', placement: { anchor: 'bottom', height: '25%' } },
      {
        name: 'ring', module: 'radial', placement: { anchor: 'center', width: '40%', height: '60%' },
        radial: { radius: 120, bars: 140, amplify: 250, colors: ['#cc3333', '#ffcc66'] }
      }
    ]
  },
  // The presets below use sleeve's synced lyrics (docs/specs/sleeve.md); list order is stacking order, first lowest.
  // Over the wallpaper, the text colored from what is behind it. Lyrics above bars along the bottom
  lyrics: {
    description: 'Synced lyrics in the middle under a line naming the song, colored from the wallpaper, above bars along the bottom',
    instances: [
      { name: 'bars', module: 'bars', placement: { anchor: 'bottom', width: '100%', height: '25%' } },
      { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'center', width: '100%', height: '60%' }, sleeve: nowPanel('minimal', 'top-center', 3) }
    ]
  },
  // Only lyrics, with the wallpaper clear around them
  'lyrics-only': {
    description: 'Synced lyrics over a now-playing card, with the wallpaper clear around them',
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'center', width: '70%', height: '70%' }, sleeve: nowPanel('full', 'bottom-center', 2) }]
  },
  // Lyrics down the left third, bars along the bottom of the rest
  'lyrics-side': {
    description: 'Lyrics down the left third over a now-playing card, bars along the bottom of the rest',
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'left', width: '33%', height: '100%' }, sleeve: nowPanel('full', 'bottom-left', 2) },
      { name: 'bars', module: 'bars', rect: SIDE_RECTS.bars }
    ]
  },
  // The wallpaper darkened under a see-through layer tinted from it, solid lyrics on it, a ring beside them with bars below it
  'lyrics-veil': {
    description: 'The wallpaper darkened under a tinted veil, a now-playing strip over lyrics on the left, a ring and bars beside them',
    instances: veil()
  },
  // The track's cover blended over the wallpaper, lyrics in the middle, bars along the bottom
  'lyrics-blend': {
    description: 'The track\'s cover blended over the wallpaper, a line naming the song above lyrics in the middle, bars along the bottom',
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '60%x70%+20%+5%', lyrics_align: 'center', background: 'cover@0.6', ...nowPanel('minimal', 'top-center', 3) } },
      { name: 'bars', module: 'bars', placement: { anchor: 'bottom', width: '100%', height: '25%' } }
    ]
  },
  // The screensaver's own (screensaver.preset): the wallpaper under a veil, lyrics, a ring and bars, the ring and
  // bars blue to start with and turning through the hues together
  screensaver: {
    description: 'The screensaver\'s look: the lyrics veil, its ring and bars turning through the hues together',
    instances: veil({ cycle: true })
  },
  // The screensaver's look for a song without lyrics (screensaver.preset_without_lyrics): the same veil and
  // now-playing panel as the screensaver's own, its lyrics area empty, under bars across the whole width and a ring
  // over each half, the left one following the left speaker and the right one the right, below the panel's strip,
  // turning colors with the bars as the screensaver's own preset does. With no text to read, the veil is half as
  // strong, darkening the wallpaper somewhat
  'screensaver-instrumental': {
    description: 'The screensaver\'s look for a song without lyrics: a lighter veil, bars across the width and a ring for each speaker',
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'fill' }, sleeve: { ...VEIL_LYRICS, background: 'auto@0.5' } },
      { name: 'bars', module: 'bars', palette: CYCLE_COLORS, rect: { x: 0, y: '75%', width: '100%', height: '25%' }, bars: CYCLE_BARS },
      { name: 'ring-left', module: 'radial', channel: 'left', palette: CYCLE_COLORS, rect: { x: 0, y: '11%', width: '50%', height: '64%' }, radial: VEIL_RING },
      { name: 'ring-right', module: 'radial', channel: 'right', palette: CYCLE_COLORS, rect: { x: '50%', y: '11%', width: '50%', height: '64%' }, radial: VEIL_RING }
    ]
  },
  // projectM as the whole background, with lyrics and bars over it. Very demanding, so at 30 frames a second, and it
  // gives way at the load section's image level
  'screensaver-projectm': {
    description: 'projectM as the whole background, lyrics on the left and bars beside them; very demanding',
    wallpaper: false,
    instances: [
      { name: 'projectm', engine: 'projectm', placement: { anchor: 'fill' } },
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '33%x100%+0+0', background: 'transparent' } },
      { name: 'bars', module: 'bars', rect: SIDE_RECTS.bars }
    ]
  },
  // sleeve as the whole background, with its cover hiding the wallpaper: lyrics on the left, a ring and bars on the right
  'lyrics-stage': {
    description: 'The track\'s cover, sharp, as the whole background, lyrics over a now-playing card on the left, a ring and bars on the right',
    wallpaper: false,
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '33%x100%+0+0', background: 'cover', cover: 'sharp', ...nowPanel('full', 'bottom-left', 2, '33%x100%+0+0') } },
      { name: 'bars', module: 'bars', rect: SIDE_RECTS.bars },
      { name: 'ring', module: 'radial', rect: SIDE_RECTS.ring, radial: RING }
    ]
  },
  // Lyrics on the left, the whole cover sharp beside them (sleeve 0.48.0's --art-fit), over whichever cover look is
  // picked (the user's own until one is), since style lays over the cover's variables
  'lyrics-cover': {
    description: 'The whole track\'s cover, sharp, with the song named under it, beside lyrics on the left, over its colors as the background',
    wallpaper: false,
    instances: [
      // No card: the cover already stands beside the lyrics, so only its caption
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: {
        lyrics_area: '40%x100%+0+0', background: 'cover', ...nowPanel('minimal', 'bottom-center', 3, '60%x100%+40%+0'),
        style: { '--art-fit': 'contain', ...nowPanel('minimal', 'bottom-center', 3).style }
      } }
    ]
  },
  // Sunamu's moving background across the window, lyrics in the middle, a wave along the bottom
  'lyrics-swirl': {
    description: 'Two copies of the track\'s cover turning and blending as the whole background, a line naming the song above lyrics in the middle, a wave along the bottom',
    wallpaper: false,
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '60%x80%+20%+0', lyrics_align: 'center', background: 'cover', cover: 'swirl', ...nowPanel('minimal', 'top-center', 3) } },
      { name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'bottom', width: '100%', height: '20%' }, wave: { color: '#33aacc' } }
    ]
  },
  // Sunamu's background as Sunamu drew it (its ui/sunamu/Background.css): two copies of the cover twice the window's
  // longer side, blurred 180px, at half brightness and 1.5 saturation, exclusion blended, turning opposite ways once a
  // minute, the second 10 s behind; sleeve's CSS port of it (sleeve-art-swirl-css) rather than its shader. Laid out as
  // Sunamu is: the now-playing card on the left, lyrics on the right
  'lyrics-sunamu': {
    description: 'Sunamu\'s background as Sunamu drew it, two blurred copies of the cover turning, with its card on the left and lyrics on the right',
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu() }]
  },
  // The same as the custom Sunamu theme on charon draws it (~/.config/sunamu/themes/custom/background.css, overrides laid
  // over Background.css, in its electron scene's widget mode): there Sunamu's own rule for the two copies does not
  // apply, so they turn sharp and full size with no filter, and the whole background is at half opacity
  'lyrics-new-sunamu': {
    description: 'Sunamu\'s background with the copies of the cover sharp and the whole of it at half strength, card on the left, lyrics on the right',
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ sharp: true }) }]
  },
  // sleeve as the whole background: the full now-playing panel on the left, lyrics on the right, a wave along the bottom
  'lyrics-now': {
    description: 'The track\'s cover as the whole background, a large now-playing card on the left, lyrics on the right, a wave along the bottom',
    wallpaper: false,
    instances: [
      // The card as the centrepiece, filling most of its third
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: {
        lyrics_area: '60%x75%+40%+0', background: 'cover', ...nowPanel('full', 'center-left', 3, '40%x75%+0+0')
      } },
      { name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'bottom', width: '100%', height: '25%' }, wave: { color: '#33aacc' } }
    ]
  }
};

// Every look with lyrics runs only while sound plays here, so a song playing on another device (Spotify Connect)
// shows its lyrics with no empty bars beside them: GLava stops in silence while sleeve stays up for a song
export const BUILTIN_PRESETS = Object.fromEntries(Object.entries(PRESETS).map(([name, preset]) => [
  name, preset.instances?.some(instance => instance.engine === 'sleeve') ? { only_while_playing: true, ...preset } : preset
]));
