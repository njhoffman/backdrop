## Config

:- The cli program will have a config file called `config.yaml` in the followingcurrent directoryi :
"HOME/.$config/pexels.yaml"

It will contain the following properties and defaults, search queryies do not have config defaults

```javascript
api_key = '',   // if not set should try to read from PEXELS_API environment vvariable
paths = {
    logfile     : "$HOME/.local/share/pexels/wallpaper.sqlite3",
    database    : "$HOME/.local/share/pexels/events.db",
    videos_new  : "$HOME/.cache/pexels/images",
    image__new  : "$HOME/.cache/pexels/videos",
    videos_kept : "$HOME/.local/share/pexelsimages",
    images_kept : "$HOME/.local/share/pexels/images",
    playlists   : "$HOME/.local/share/pexels/playlist",
},

search_images = {        // photo search options with defaults, query is required
  query       : "",      // The search query. Ocean, Tigers, Pears, etc. (no default config setting)
  per_page    : 80,      // The number of results you are requesting per page. (min 15, max 80)
  orientation : '',      // Desired photo orientation. Can be: "landndscape, portrait, square"
  min_size    : 'large', // Minimum photo size. Can be: "large(24MP), medium(12MP), small(4MP)".
  color       : '',      // Desired photo color to match general color to. Can be: any hexadecimal (i.e. #ffffff)
                         // or color name: red, orange, yellow, green, turquoise, blue, violet, pink, brown, black, gray, white
},

search_videos = {  // video search options with defaults, query is required
  query     : "",  // The search query. Ocean, Tigers, Pears, etc. (no default config setting)
  min_size  : '',  // Minimum photo size. Can be: "large(24MP), medium(12MP), small(4MP)".
  per_page  : 80,  // The number of results you are requesting per page. (min 15, max 80)
},

// integrastion hooks, can can be a string command patb of a shell script, all are required
// these should take into account multiple monitor setups
hooks = {
    get-name   : '', // cmd or script to get filename of currently playing item,
    play-prevt : '', // cmd or script to go to the next video/image,
    play-next  : '',  // cmd or script to go to the next video/image
},


 The app should prevent execution if required fields aren't set: api_key, any of the hooks
 The query is required for both searches, and does not have config defaults, so if is
    not set in the command line lin it must be asked interactively
