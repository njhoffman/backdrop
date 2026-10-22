# Pexels CLI v1.1.1 Specification (legacy)

Behavior of the pre-backdrop commands, kept as reference while they are ported to the new config and database layer. Superseded by `main.md`, `config.md` and `database.md`.

A Node.js command-line application for searching, downloading, curating, and managing wallpaper videos and images from Pexels, with local media import capabilities.

## Project Overview

**Technology Stack**: Node.js v18+ with ES6 modules
**Primary Dependencies**: 
- Pexels JavaScript SDK: https://github.com/pexels/pexels-javascript
- Pexels API Documentation: https://www.pexels.com/api/documentation/?language=javascript
- Rate Limiting Info: https://www.pexels.com/api/documentation/?language=javascript#statistics

**Architecture**: Command-line interface with interactive prompts, colorful output, and comprehensive error handling. All user inputs should be validated with fallback prompts when required arguments are missing.

## Core Application Startup Flow

When the application starts it must:
1. Check for the config file at `~/.config/pexels.yaml` and create default if it does not exist
2. Initialize the SQLite3 database if necessary (auto-create tables)
3. Validate that required fields are set: `api_key` and all `hooks` configuration
4. Ensure all configured paths exist with correct permissions
5. Create base directories: all paths in the `paths` configuration object

## Database Schema (SQLite3)

```javascript
// Search history table
const search = { 'id', 'date', 'keywords' }

// Pexels videos (renamed from 'videos' in v1.1.1)
const pexel_videos = [{
    "id", "width", "height", "url", "image", "duration", 
    "user_id", "user_url", "user_name",
    "video_files": [{ "id", "quality", "file_type", "width", "height", "link" }],
    "searches": [], // Array of {search_id, ranking} pairs
    "downloaded": [] // Array of downloaded video_file_ids
}];

// Pexels images (renamed from 'images' in v1.1.1)  
const pexel_images = [{
    "id", "width", "height", "url", "photographer", "photographer_url", 
    "photographer_id", "avg_color", "alt",
    "src": { "original", "large2x", "large", "medium", "small", "portrait", "landscape", "tiny" },
    "searches": [], // Array of {search_id, ranking} pairs
    "downloaded": [] // Array of downloaded sizes
}];

// Local imported media (added in v1.1.0)
const local_videos = [{
    "id",        // auto-increment primary key
    "filename",  // original filename
    "size",      // dimensions as "widthxheight" (e.g. "1920x1080")
    "duration"   // duration in seconds
}];

const local_images = [{
    "id",        // auto-increment primary key  
    "filename",  // original filename
    "size"       // dimensions as "widthxheight" (e.g. "1920x1080")
}];

// Unified ratings table (no longer stored in JSON arrays within items)
const ratings = [{
    "date", "rating", "item_id",
    "resolution",  // monitor resolution when rating was given
    "orientation", // 'landscape' or 'portrait' (monitor orientation, not content)
    "source"       // 'pexel-image', 'pexel-video', 'local-image', 'local-video'
});
```

## Configuration (YAML)

File location: `~/.config/pexels.yaml`

```yaml
api_key: ''  # Required - Pexels API key or PEXELS_API environment variable

paths:
  logfile: "$HOME/.local/share/pexels/pexels.log"
  database: "$HOME/.local/share/pexels/pexels.db"
  videos_new: "$HOME/.cache/pexels/videos"
  images_new: "$HOME/.cache/pexels/images"
  videos_kept: "$HOME/.local/share/pexels/videos"
  images_kept: "$HOME/.local/share/pexels/images"
  videos_local: "$HOME/.local/share/pexels/videos_local"  # v1.1.0+
  images_local: "$HOME/.local/share/pexels/images_local"  # v1.1.0+
  playlists: "$HOME/.local/share/pexels/playlists"

search_images:
  per_page: 80     # 15-80 range
  orientation: ''  # 'landscape', 'portrait', 'square', or empty
  min_size: 'large' # 'large'(24MP), 'medium'(12MP), 'small'(4MP)
  color: ''        # hex color or color name

search_videos:
  per_page: 80     # 15-80 range
  min_size: ''     # 'large', 'medium', 'small', or empty

hooks:
  get-name: ''   # Required - command to get current wallpaper filename
  play-prev: ''  # Required - command to go to previous wallpaper
  play-next: ''  # Required - command to go to next wallpaper
```

## Core Commands Implementation

### Search Commands
- `pexels search-images [query]` - Search Pexels images with pagination
- `pexels search-videos [query]` - Search Pexels videos with pagination

**Options**:
- `--per-page <number>` - Results per page (15-80)
- `--orientation <type>` - Images only: landscape, portrait, square  
- `--min-size <size>` - Minimum size: large, medium, small
- `--color <color>` - Images only: hex or color name
- `--portrait` - Only return content where height > width (v1.0.1+)

**Behavior**:
- Prompt for query if not provided
- Paginate through ALL results until exhausted or rate limited
- Check for existing items in database before inserting
- Update search associations for existing items
- Show progress with dynamic updates
- Provide summary statistics including filtered content count
- Offer to proceed to download after completion

### Download Command
- `pexels download [--total <number>]` - Download items from database

**Behavior**:
- Show interactive options for download preferences
- Validate disk space, permissions, and rate limits before starting
- Display comprehensive progress bar with speed metrics
- Download only items not already downloaded
- Update database with download status

### List Commands  
- `pexels list-images` - Interactive browsing of downloaded images
- `pexels list-videos` - Interactive browsing of downloaded videos

**Options**:
- `--number <num>` - Limit results
- `--rated [orientation]` - Show only rated items, optionally filter by monitor orientation ('landscape', 'portrait', 'any')
- `--no-local` - Exclude local imported files when using --rated (v1.1.0+)
- `--keywords <keywords...>` - Filter by search keywords
- `--sizes <sizes...>` - Filter by downloaded sizes  
- `--playlist <name>` - Save as M3U playlist file

**Interactive Features**:
- Rate items during browsing (1-3 stars or skip)
- Show file paths and metadata
- Display rating history with monitor orientation

### Rating Commands
- `pexels keep [rating]` - Mark current item as kept (1-3 stars, default 1)
- `pexels skip` - Mark current item as skipped (0 rating)
- `pexels undo` - Undo last rating and file movement

**Behavior**:
- Get current item via `get-name` hook
- Automatically detect monitor orientation from resolution
- Move files between directories (new/kept/skip)
- Support undo functionality with file restoration

### Import Command (v1.1.0+)
- `pexels import [directory]` - Import local media files

**Behavior**:
- Prompt for directory if not provided
- Scan for video (.mp4, .mov, .avi, .mkv, .webm, .m4v) and image files (.jpg, .jpeg, .png, .gif, .bmp, .webp)
- Copy files to `videos_local` and `images_local` directories
- Extract dimensions using ffprobe (videos) and ImageMagick (images)
- Fallback to filename parsing if tools unavailable
- Create database entries with auto-generated IDs
- Add default rating (1 star) with orientation detection
- Show progress and import statistics

### Utility Commands
- `pexels stats` - Show API rate limits and database statistics
- `pexels go-next` - Hook integration for wallpaper management
- `pexels help` - Application information and command overview

## File Organization System

**Download Flow**: `*_new` → `*_kept` or `*_skip` (based on rating)
- **New downloads**: `videos_new`, `images_new`
- **Kept items** (rated 1-3): `videos_kept`, `images_kept`  
- **Skipped items** (rated 0): `videos_skip`, `images_skip` (auto-created)
- **Local imports**: `videos_local`, `images_local`

## Hook Integration System

External wallpaper manager integration through configurable shell commands:
1. `go-next` command gets current filename via `get-name` hook
2. Looks up item in database by parsing filename for ID
3. Processes rating and moves file to appropriate directory
4. Executes `play-next` hook to advance wallpaper
5. Supports undo functionality

## Technical Requirements

**Code Style**: Clean, modern ES6/ES7 with minimal comments and consistent naming
**Error Handling**: Comprehensive logging to file with timestamps for all operations
**Testing**: Mocha test suite with Chai assertions (`npm run test`)
**Dependencies**: Minimize external dependencies, prefer built-in Node.js modules
**Performance**: Respect API rate limits, implement progress tracking, handle large file operations
**Cross-platform**: Support Linux, macOS, and Windows file paths and commands

## Key Implementation Notes

1. **Database Schema Evolution**: Tables renamed in v1.1.1 for clarity (videos→pexel_videos, images→pexel_images)
2. **Rating System**: Centralized in ratings table (v1.0.0+), removed JSON arrays from content tables  
3. **Local Media**: Full import system with dimension detection and automatic rating (v1.1.0+)
4. **Orientation Handling**: Distinguish content orientation (height>width) from monitor orientation (rating context)
5. **Portrait Filtering**: Content filtering (--portrait) vs rating filtering (--rated=portrait)
6. **Progress Tracking**: Real-time updates for all long-running operations
7. **Interactive UX**: Colorful, aligned output with comprehensive user feedback

This specification represents the complete current state of the Pexels CLI project as of version 1.1.1.