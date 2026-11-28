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
// the layers' filter (no blur, brightness or saturation), halves the whole background's opacity and turns the copies at
// a constant speed, since sharp copies easing to a near stop at each turn's end read as a stall (seen over 80 s,
// 2026-11-28); tint multiplies
// each copy with the cover's dark vibrant color, as Sunamu does with its --color-bg (sleeve 0.50.0's --swirl-tint; an
// older sleeve takes the name and draws no tint)
// style lays further values over these, for the variations below
function sunamu({ sharp = false, tint = false, style = {} } = {}) {
  const panel = nowPanel('full', 'center-left', 3, '40%x100%+0+0');
  return {
    lyrics_area: '60%x100%+40%+0', background: 'cover', cover: 'swirl', ...panel,
    style: {
      ...panel.style, '--art-animation': 'sleeve-art-swirl-css', '--swirl-size': '2', '--swirl-period': '60', '--swirl-delay': '10',
      '--swirl-timing': 'ease-in-out', '--art-dim': '0', '--swirl-tint': tint === true ? 'cover' : tint || 'none',
      ...(sharp
        ? { '--swirl-blur': '0px', '--swirl-brightness': '1', '--art-saturation': '1', '--art-opacity': '0.5', '--swirl-timing': 'linear' }
        : { '--swirl-blur': '180px', '--swirl-brightness': '0.5', '--art-saturation': '1.5', '--art-opacity': '1' }),
      ...style
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
  'lyrics-blurred-swirl': {
    description: 'Two copies of the track\'s cover turning and blending as the whole background, a line naming the song above lyrics in the middle, a wave along the bottom',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: lively patches of the cover\'s colors, best on colorful covers; 8 to 12% changed every 5 s. Lyrics: fair, as they can sit over pale parts of the cover.',
      'Second look, 100 s, no skipping, 2026-11-28: on a grey cover with an orange star, its shapes drift steadily and stay recognizable; 9 to 14% changed every 5 s, brightness 0.26.'
    ],
    wallpaper: false,
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: { lyrics_area: '60%x80%+20%+0', lyrics_align: 'center', background: 'cover', cover: 'swirl', ...nowPanel('minimal', 'top-center', 3) } },
      { name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'bottom', width: '100%', height: '20%' }, wave: { color: '#33aacc' } }
    ]
  },
  // The same with Sunamu's tint, each copy multiplied by the cover's dark vibrant (sleeve 0.51.0 tints the shader swirl)
  'lyrics-blurred-swirl-tinted': {
    description: 'lyrics-blurred-swirl tinted by the cover\'s dark accent, as Sunamu tints its copies',
    details: [
      'Second look, 100 s, no skipping, 2026-11-28: deep red fields from the cover\'s accent with the lyrics clear on them; 6 to 12% changed every 5 s; dark (brightness 0.08) but rich (color 0.84). One of the best.'
    ],
    wallpaper: false,
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: {
        lyrics_area: '60%x80%+20%+0', lyrics_align: 'center', background: 'cover', cover: 'swirl', ...nowPanel('minimal', 'top-center', 3),
        style: { ...nowPanel('minimal', 'top-center', 3).style, '--swirl-tint': 'cover' }
      } },
      { name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'bottom', width: '100%', height: '20%' }, wave: { color: '#33aacc' } }
    ]
  },
  // lyrics-blurred-swirl at Sunamu's pace, a turn a minute: calmer
  'lyrics-blurred-slow': {
    description: 'lyrics-blurred-swirl turning once a minute, as Sunamu does, for a calmer background',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: almost the same as lyrics-blurred-swirl, 7 to 12% changed every 5 s against its 8 to 12%, slowing a little at the end of each turn. Lyrics: fair.',
      'Second look, 100 s, no skipping, 2026-11-28: vivid purple and orange shapes on a colorful cover, grey on a grey one; 7 to 13% changed every 5 s, hard to tell from lyrics-blurred-swirl.'
    ],
    wallpaper: false,
    instances: [
      { name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: {
        lyrics_area: '60%x80%+20%+0', lyrics_align: 'center', background: 'cover', cover: 'swirl', ...nowPanel('minimal', 'top-center', 3),
        style: { ...nowPanel('minimal', 'top-center', 3).style, '--swirl-period': '60' }
      } },
      { name: 'wave', module: 'wave', opacity: 0.6, placement: { anchor: 'bottom', width: '100%', height: '20%' }, wave: { color: '#33aacc' } }
    ]
  },
  // Sunamu's background and its variations. details are what an 80 s look at each on 1440p showed (2026-11-28; the change
  // is the share of the picture that changed in each 5 s), shown with the animation in the menu's i and the web page.
  // Sunamu's background as Sunamu drew it (its ui/sunamu/Background.css): two copies of the cover twice the window's
  // longer side, blurred 180px, at half brightness and 1.5 saturation, exclusion blended, turning opposite ways once a
  // minute, the second 10 s behind; sleeve's CSS port of it (sleeve-art-swirl-css) rather than its shader. Laid out as
  // Sunamu is: the now-playing card on the left, lyrics on the right. Kept as the reference for the rest.
  'lyrics-blurred-sunamu': {
    description: 'Sunamu\'s background as Sunamu drew it, two blurred copies of the cover turning, with its card on the left and lyrics on the right',
    details: [
      'The reference: Sunamu\'s own background, untinted, which the other Sunamu looks vary.',
      'Seen over 80 s on 1440p, 2026-11-28: an even, slowly drifting wash, dull grey on most covers; 6 to 9% of it changed every 5 s. Lyrics: very good.',
      'Second look, 100 s, no skipping, 2026-11-28: a flat grey wash on a grey cover; the change pulses every 50 s (4 to 18%) as the two eased turns line up.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu() }]
  },
  // Sunamu's background with Sunamu's tint: each copy multiplied with the cover's dark vibrant color
  'lyrics-blurred-tinted': {
    description: 'Sunamu\'s background tinted as Sunamu tints it: two blurred copies of the cover turning in one rich tone of its dark accent',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: one rich tone of the cover fills the screen (amber, deep blue), soft and slowly shifting; 3 to 8% changed every 5 s. Lyrics: very good. A top pick.',
      'Second look, 100 s, no skipping, 2026-11-28: nearly black on a dark, grey cover (brightness 0.02, 1% change): the cover\'s dark accent times half brightness leaves almost nothing. Fine on colorful covers, unusable on dark ones.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ tint: true }) }]
  },
  // Variations on it, each changing one thing, tried live on 2026-11-28 (sleeve ctl display) to compare
  'lyrics-blurred-soft': {
    description: 'Between lyrics-blurred-tinted and lyrics-sharp-tinted, untinted: a lighter blur, so the turning copies show soft shapes with edges',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: soft patches of color with edges that keep forming; 10 to 21% changed every 5 s, the most of the blurred looks. Lyrics: very good. The top pick.',
      'Second look, 100 s, no skipping, 2026-11-28: on a grey cover, soft grey shapes moving in 50 s pulses (4 to 19% changed every 5 s); brightness 0.21.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({
      style: { '--swirl-blur': '50px', '--swirl-brightness': '0.75', '--art-saturation': '1.25', '--art-opacity': '0.75' }
    }) }]
  },
  'lyrics-blurred-soft-tinted': {
    description: 'lyrics-blurred-soft tinted by the cover\'s dark accent: soft shapes with edges in one rich tone',
    details: [
      'Second look, 100 s, no skipping, 2026-11-28: deep blue (and red) fields with soft shapes, the lyrics clear; 4 to 10% changed every 5 s; brightness 0.13, color 0.38. One of the best.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({
      tint: true, style: { '--swirl-blur': '50px', '--swirl-brightness': '0.75', '--art-saturation': '1.25', '--art-opacity': '0.75' }
    }) }]
  },
  'lyrics-blurred-offset': {
    description: 'lyrics-blurred-sunamu with the second copy half a turn behind, so the two blend at opposite angles for stronger colors',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: much like lyrics-blurred-sunamu, now and then a stronger patch of color where the copies meet; 5 to 11% changed every 5 s. Lyrics: very good.',
      'Second look, 100 s, no skipping, 2026-11-28: blue and orange gradients on a colorful cover, then grey on a dark one; 7 to 16% changed every 5 s.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ style: { '--swirl-delay': '30' } }) }]
  },
  'lyrics-blurred-vivid': {
    description: 'lyrics-blurred-sunamu with the colors pushed much richer, for pale covers',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: barely richer than lyrics-blurred-sunamu on the covers that played, none of them pale; 7 to 12% changed every 5 s. Lyrics: very good.',
      'Second look, 100 s, no skipping, 2026-11-28: nothing to boost on a colorless cover (color 0.03): it only helps pale covers that have some color.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ style: { '--art-saturation': '2.5' } }) }]
  },
  // The custom Sunamu theme on charon (~/.config/sunamu/themes/custom/background.css, overrides laid over
  // Background.css, in its electron scene's widget mode, where Sunamu's own rule for the two copies does not apply):
  // the copies sharp and unfiltered, the whole at half opacity, with Sunamu's tint
  'lyrics-sharp-tinted': {
    description: 'Sharp copies of the cover turning at half strength, tinted by its dark accent, as a custom Sunamu theme draws them',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: deep fields of the cover\'s accent with faint sharp shapes; 6 to 10% changed every 5 s (turning eased then, constant since). Lyrics: good. A top pick.',
      'Untinted, the same copies were striking on bright covers and nearly black on dark ones.',
      'Second look, 100 s, no skipping, 2026-11-28: moody teal fields with the cover\'s sharp pattern, an even 3 to 4% every 5 s with no pauses since the turns went linear; brightness 0.10. Good.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ sharp: true, tint: true }) }]
  },
  'lyrics-sharp-bright': {
    description: 'Sharp, untinted copies of the cover brightened, so they invert each other hard; busy, more for watching than reading',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: a black and white collage, the busiest look by far: 18 to 27% changed every 5 s, twice the others. Lyrics: poor. Better as a screensaver.',
      'Second look, 100 s, no skipping, 2026-11-28: a vivid patterned collage on a colorful cover, black and white on a photo; 12 to 22% changed every 5 s. Striking, busy.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ sharp: true, style: { '--swirl-brightness': '1.4' } }) }]
  },
  // The tint pulls the black and white collage toward one tone, which may leave the lyrics readable
  'lyrics-sharp-bright-tinted': {
    description: 'lyrics-sharp-bright tinted by the cover\'s dark accent, calming its hard inversions toward one tone',
    details: [
      'Second look, 100 s, no skipping, 2026-11-28: the tint calms lyrics-sharp-bright to an even 6 to 11% every 5 s, dark grey on a black and white cover; the lyrics stay readable.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ sharp: true, tint: true, style: { '--swirl-brightness': '1.4' } }) }]
  },
  'lyrics-sharp-duotone': {
    description: 'Sharp copies of the cover tinted one fixed blue, a duotone that stays the same from track to track',
    details: [
      'Seen over 80 s on 1440p, 2026-11-28: calm blue-grey sharp shapes; 5 to 13% changed every 5 s (turning eased then, constant since). Lyrics: good. lyrics-sharp-tinted does the same with each cover\'s own color.',
      'Second look, 100 s, no skipping, 2026-11-28: calm blue-grey with sharp shapes, 3 to 8% changed every 5 s; the lyrics stay readable.'
    ],
    wallpaper: false,
    instances: [{ name: 'lyrics', engine: 'sleeve', opacity: 1, placement: { anchor: 'fill' }, sleeve: sunamu({ sharp: true, tint: '#4a6a9a' }) }]
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
