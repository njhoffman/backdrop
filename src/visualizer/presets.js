// Presets backdrop ships. A preset is laid over the visualizer section (objects merge, lists replace), so it
// can change any setting, including the instance list. visualizer.presets can override these by name.
const WALLPAPER_COLORS = { source: 'wallpaper' };
// The hue of the configured colors turning once every 90 seconds, a few times a song, the same for every instance with it
const CYCLE_COLORS = { source: 'cycle', cycle: '90s' };
// The veil looks' lyrics, in the left third under a strip holding a small now-playing panel (cover, title, artist,
// album, seek bar), so the two never overlap
const VEIL_LYRICS = { now: 'full', now_position: 'top-left', now_area: '33%x11%+0+0', lyrics_area: '33%x89%+0+11%', background: 'auto' };
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

export const BUILTIN_PRESETS = {
  // Short, thin bars along the bottom, mostly see-through
  subtle: {
    opacity: 0.5,
    placement: { anchor: 'bottom', width: '100%', height: '15%' },
    instances: [{ name: 'main', module: 'bars', bars: { width: 8, gap: 2, amplify: 150 } }]
  },
  // A radial ring in the middle of the screen
  ring: {
    instances: [{
      name: 'ring', module: 'radial', placement: { anchor: 'center', width: '50%', height: '80%' },
      radial: { radius: 150, bars: 180, width: 4, amplify: 250, colors: ['#33aacc', '#a0e0ff'] }
    }]
  },
  // A thin wave across the whole screen
  wave: {
    instances: [{ name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'fill' }, wave: { color: '#33aacc', max_thickness: 4 } }]
  },
  // Bars along the bottom with a ring above them
  party: {
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
    instances: [
      { name: 'bars', module: 'bars', placement: { anchor: 'bottom', width: '100%', height: '25%' } },
      { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'center', width: '100%', height: '60%' } }
    ]
  },
  // Only lyrics, with the wallpaper clear around them
  'lyrics-only': {
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'center', width: '70%', height: '70%' } }]
  },
  // Lyrics down the left third, bars along the bottom of the rest
  'lyrics-side': {
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'left', width: '33%', height: '100%' } },
      { name: 'bars', module: 'bars', rect: SIDE_RECTS.bars }
    ]
  },
  // The wallpaper darkened under a see-through layer tinted from it, solid lyrics on it, a ring beside them with bars below it
  'lyrics-veil': { instances: veil() },
  // The track's cover blended over the wallpaper, lyrics in the middle, bars along the bottom
  'lyrics-blend': {
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, palette: WALLPAPER_COLORS, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '60%x70%+20%+5%', lyrics_align: 'center', background: 'cover@0.6' } },
      { name: 'bars', module: 'bars', placement: { anchor: 'bottom', width: '100%', height: '25%' } }
    ]
  },
  // The screensaver's own (screensaver.preset): the wallpaper under a veil, lyrics, a ring and bars, the ring and
  // bars blue to start with and turning through the hues together
  screensaver: { instances: veil({ cycle: true }) },
  // The screensaver's look for a song without lyrics (screensaver.preset_without_lyrics): the same veil and
  // now-playing panel as the screensaver's own, its lyrics area empty, under bars across the whole width and a ring
  // over each half, the left one following the left speaker and the right one the right, below the panel's strip,
  // turning colors with the bars as the screensaver's own preset does. With no text to read, the veil is half as
  // strong, darkening the wallpaper somewhat
  'screensaver-instrumental': {
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
    wallpaper: false,
    instances: [
      { name: 'projectm', engine: 'projectm', placement: { anchor: 'fill' } },
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '33%x100%+0+0', background: 'transparent' } },
      { name: 'bars', module: 'bars', rect: SIDE_RECTS.bars }
    ]
  },
  // sleeve as the whole background, with its cover hiding the wallpaper: lyrics on the left, a ring and bars on the right
  'lyrics-stage': {
    wallpaper: false,
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '33%x100%+0+0', background: 'cover' } },
      { name: 'bars', module: 'bars', rect: SIDE_RECTS.bars },
      { name: 'ring', module: 'radial', rect: SIDE_RECTS.ring, radial: RING }
    ]
  },
  // sleeve as the whole background: the full now-playing panel on the left, lyrics on the right, a wave along the bottom
  'lyrics-now': {
    wallpaper: false,
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: {
        now: 'full', now_area: '33%x75%+0+0', now_position: 'center-left', lyrics_area: '67%x75%+33%+0', background: 'cover'
      } },
      { name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'bottom', width: '100%', height: '25%' }, wave: { color: '#33aacc' } }
    ]
  }
};
