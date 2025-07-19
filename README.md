# Pexels CLI - Wallpaper Management Tool

A command-line interface for searching, downloading, and managing wallpaper videos and images from Pexels.

## Features

- 🔍 Search Pexels for images and videos with keywords
- 📥 Download content with configurable quality settings
- ⭐ Rate and organize downloaded content
- 📊 Track statistics and API usage
- 🎵 Generate playlists for wallpaper management
- 📁 Import and manage local media files
- 🔗 Integration hooks for wallpaper services
- 📁 Automatic file organization (keep/skip directories)

## Installation

```bash
npm install -g pexels-cli
```

Or clone and install locally:

```bash
git clone <repository-url>
cd pexels-cli
npm install
npm link
```

## Quick Start

1. **Get a Pexels API Key**
   - Visit [Pexels API](https://www.pexels.com/api/)
   - Create an account and generate an API key

2. **Set up configuration**
   ```bash
   pexels help  # Creates default config file
   ```
   
3. **Edit configuration**
   - Edit `~/.config/pexels.yaml`
   - Set your API key and hooks

4. **Search for content**
   ```bash
   pexels search-images "nature landscape"
   pexels search-videos "ocean waves"
   ```

5. **Download content**
   ```bash
   pexels download --total 50
   ```

## Configuration

The configuration file is located at `~/.config/pexels.yaml`:

```yaml
api_key: "your-pexels-api-key"

paths:
  logfile: "$HOME/.local/share/pexels/wallpaper.log"
  database: "$HOME/.local/share/pexels/events.db"
  videos_new: "$HOME/.cache/pexels/videos"
  images_new: "$HOME/.cache/pexels/images"
  videos_kept: "$HOME/.local/share/pexels/videos"
  images_kept: "$HOME/.local/share/pexels/images"
  videos_local: "$HOME/.local/share/pexels/videos_local"
  images_local: "$HOME/.local/share/pexels/images_local"
  playlists: "$HOME/.local/share/pexels/playlists"

search_images:
  per_page: 80
  orientation: ""
  min_size: "large"
  color: ""

search_videos:
  per_page: 80
  min_size: ""

hooks:
  get-name: "command-to-get-current-filename"
  play-prev: "command-to-go-to-previous"
  play-next: "command-to-go-to-next"
```

## Commands

### Search Commands

**Search for images:**
```bash
pexels search-images "sunset mountain"
pexels search-images "ocean" --orientation landscape --min-size large
pexels search-images "city" --portrait  # Only portrait format images (height > width)
```

**Search for videos:**
```bash
pexels search-videos "rain forest"
pexels search-videos "city traffic" --min-size large
pexels search-videos "dancing" --portrait  # Only portrait format videos (height > width)
```

### Download Commands

**Download content:**
```bash
pexels download                    # Interactive download
pexels download --total 100       # Download 100 items
```

### List Commands

**List downloaded content:**
```bash
pexels list-images                 # List all downloaded images
pexels list-videos --rated         # List only rated videos (any orientation, includes local)
pexels list-videos --rated=landscape  # List only landscape-rated videos
pexels list-images --rated=portrait   # List only portrait-rated images
pexels list-videos --rated --no-local # List only rated Pexels videos (exclude local)
pexels list-images --keywords sunset mountain
pexels list-videos --playlist "favorites"
```

### Rating Commands

**Rate content:**
```bash
pexels keep 3          # Rate current item 3/3 stars
pexels keep            # Rate current item 1/3 stars (default)
pexels skip            # Skip current item
pexels undo            # Undo last rating
```

### Utility Commands

**View statistics:**
```bash
pexels stats           # Show API limits and download statistics
```

**Import local media:**
```bash
pexels import          # Interactive directory selection
pexels import /path/to/media/folder  # Import from specific directory
```

**Integration hooks:**
```bash
pexels go-next         # Process current item and move to next
```

## Hooks Integration

The application supports integration with wallpaper management systems through configurable hooks:

- **get-name**: Command to get the filename of currently playing wallpaper
- **play-prev**: Command to go to previous wallpaper
- **play-next**: Command to go to next wallpaper

Example hook configurations:

```yaml
hooks:
  get-name: "wallpaper-daemon --current-file"
  play-prev: "wallpaper-daemon --previous"
  play-next: "wallpaper-daemon --next"
```

## File Organization

The application automatically organizes files into directories based on ratings:

- **New downloads**: `videos_new`, `images_new`
- **Kept items**: `videos_kept`, `images_kept`
- **Local imports**: `videos_local`, `images_local`
- **Skipped items**: `videos_skip`, `images_skip` (auto-created)

## Database

Uses SQLite3 to store:
- Search history and results
- Download metadata
- Rating information
- File locations and status

## API Rate Limiting

- Pexels API: 200 requests/hour
- The application tracks and displays rate limit usage
- Automatic delays between requests to respect limits

## Development

**Run tests:**
```bash
npm test
```

**Development mode:**
```bash
npm run start
```

## Requirements

- Node.js 18+
- SQLite3
- Pexels API key

## File Structure

```
pexels-cli/
├── src/
│   ├── commands/          # Command implementations
│   ├── config/            # Configuration management
│   ├── database/          # Database operations
│   ├── utils/             # Utility functions
│   └── index.js           # Main application entry
├── test/                  # Test files
└── package.json
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT License

## Support

For issues and questions, please create an issue in the GitHub repository.