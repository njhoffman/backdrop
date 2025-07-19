# Changelog

All notable changes to the Pexels CLI project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - Database Table Renaming

### Changed
- **Database Schema**: Renamed core tables for better clarity and consistency
  - `videos` table renamed to `pexel_videos`
  - `images` table renamed to `pexel_images`
- **Version**: Patch bump from 1.1.0 to 1.1.1
- **Project Documentation**: Updated main specification with comprehensive current state documentation
  - Fixed typos and outdated references
  - Added complete feature overview for v1.1.1
  - Enhanced for AI/Claude Code CLI integration
  - Clarified database schema evolution and current structure

### Technical Details
**Database Table Renaming**:
- Updated all SQL queries and table references throughout the codebase
- Maintained backward compatibility for existing functionality
- Enhanced clarity between Pexels content (`pexel_*`) and local content (`local_*`)
- Updated database specification documentation
- Modified test suite to reflect new table names

**Prompt**: "Patch bump the version. Rename the 'images' database table 'pexel_images', rename the 'videos' database table 'pexel_videos'."

**Changes Made**:
- Updated `DatabaseManager.js` with new table names in all queries
- Modified table creation SQL statements
- Updated all CRUD operations to use new table names
- Enhanced test coverage for renamed tables
- Updated database specification documentation
- **Documentation Enhancement**: Completely rewrote `main.md` specification
  - Current feature set as of v1.1.1 with all implemented functionality
  - Clear database schema with table evolution notes
  - Complete configuration reference with all paths
  - Comprehensive command documentation with all options
  - Technical requirements and implementation guidelines
  - Structured for AI assistant initialization and development

---

## [1.1.0] - Local Media Import and Management

### Added
- **Import Command**: New `import` command for importing local media files
  - Automatically detects video and image files in specified directory
  - Copies files to dedicated local directories (`videos_local`, `images_local`)
  - Extracts media dimensions using ffprobe/ImageMagick with filename fallback
  - Creates database entries in new `local_videos` and `local_images` tables
  - Automatically adds default rating (1 star) for imported files
- **Local Media Database Tables**: 
  - `local_videos` table with fields: id, filename, size, duration
  - `local_images` table with fields: id, filename, size
- **Local Media Integration**:
  - Local files included in `list-videos` and `list-images` when `--rated` is used
  - Added `--no-local` flag to exclude local files from listings
  - Enhanced source tracking in ratings table with `local-video` and `local-image` types
- **Configuration Paths**: Added `videos_local` and `images_local` config paths

### Changed
- **Minor Version Bump**: Updated from 1.0.0 to 1.1.0
- **Database Schema**: Extended ratings table source field to support local media types
- **List Commands**: Enhanced to display local media with distinct formatting
- **File Path Display**: Improved to show local file paths for imported media

### Technical Details
**Local Media Import System**:
- Multi-format support: MP4, MOV, AVI, MKV, WebM for videos; JPG, PNG, GIF, BMP, WebP for images
- Dimension detection via ffprobe for videos and ImageMagick for images
- Fallback parsing from filename patterns when tools unavailable
- Automatic orientation detection based on media dimensions
- Progress tracking with import statistics and error handling

**Database Integration**:
- New tables: `local_videos`, `local_images` with auto-increment IDs
- Extended ratings source types: `pexel-image`, `pexel-video`, `local-image`, `local-video`
- Enhanced queries to include local media in rated content listings
- Proper foreign key relationships maintained

**Command Enhancements**:
- `import [directory]` - Import local media with interactive directory selection
- `list-videos --no-local` - Exclude local files from rated listings
- `list-images --no-local` - Exclude local files from rated listings

**Prompt**: "Perform a minor version bump. Let's add an 'import' command that will take a directory as an argument (or interactively ask), and will import all files in the directory into the directory of two new config properties, 'paths.videos_local' and 'paths.images_local'. We will need two new database tables: 'local_videos' that will have the fields: 'id', 'filename', 'size', 'duration' 'local_images' that will have fields: 'id', 'filename', 'size' size should refer to the dimensions of the image or video, not the file size. After it copies the files, it should update the database tables local_videos and local_images with the new information. It should also update the ratings table, with the rating value set to 1, item_id set to the id of the new video or image, orientation set to 'landscape' or 'portrait', and the source set to 'local-image' or 'local-video'. The search-images and search-videos command should add a '--no-local' flag that will prevent it from including local files, by default it should include them if the '--rated' option is used. Redo the config.md and the database.md files with the new specs."

---

## [1.0.0] - Project Setup and Configuration Updates

#### Added
- Initial project structure with complete CLI implementation
- ES6 module support in package.json
- Comprehensive documentation and setup guide
- **Documentation**: Added complete specification files to `docs/specs/` directory
  - `main.md` - Original project instructions and requirements
  - `config.md` - Configuration specification 
  - `database.md` - Database schema specification
  - `changelog.md` - Project change tracking
- **Orientation filtering**: Added orientation-based filtering for `--rated` option
  - Support for `--rated=landscape`, `--rated=portrait`, `--rated=any`
  - Default behavior is `--rated=any` when orientation not specified
- **Portrait content filtering**: Added `--portrait` option for search commands
  - Filters search results to only include portrait format content (height > width)
  - Available for both `search-images` and `search-videos` commands
  - Provides statistics on filtered content in search summary

#### Changed
- **Config file naming**: Updated default log file from `wallpaper.log` to `pexels.log`
- **Database naming**: Updated default database file from `events.db` to `pexels.db`
- **Module type**: Added `"type": "module"` to package.json to resolve ES6 import warnings
- **Database schema**: Removed redundant `ratings` field from `videos` and `images` tables
- **Ratings table**: Added `orientation` field with automatic detection (portrait/landscape)

#### Fixed
- ES6 module parsing warning by adding proper module type declaration

#### Technical Details
**Database Schema Changes**:
- Removed `ratings` JSON field from `videos` and `images` tables (redundant with `ratings` table)
- Added `orientation` field to `ratings` table with default value 'landscape'
- Implemented automatic orientation detection based on resolution (height > width = portrait)
- Updated queries to use `ratings` table instead of embedded JSON ratings
- Modified tests to reflect new schema structure

**Prompt**: "We are going to update the database and remove some redundancies. Since we already have a ratings table, let's remove the ratings list from the images and videos tables. Let's also add a field to the ratings table that is 'orientation' that can be portrait or landscape. By default it is landscape, and it refers to the resolution of the monitor viewing the image or video. Add any necessary code to populate this with the correct orientation, portrait for monitor with height greater than width, landscape for monitor with width greater than or equal to height."

**Orientation Filtering Enhancement**:
- Enhanced `--rated` option for `list-images` and `list-videos` commands
- Added support for orientation-specific filtering: `landscape`, `portrait`, `any`
- Updated database queries to filter by rating orientation
- Added validation and error handling for invalid orientation values
- Enhanced user feedback to show orientation filter in output messages

**Prompt**: "now let's add the ability for the '--rated' option of the search-videos and search-images command to specify an orientation, either '--rated=landscape' or '--rated=portrait', or '--rated=any'. The default will be '--rated=any' but it does not have to be specified."

**Portrait Content Filtering**:
- Added `--portrait` option to `search-images` and `search-videos` commands
- Filters search results to only include content with portrait aspect ratio (height > width)
- Provides real-time filtering statistics during search progress
- Adds filtered count to search completion summary
- Comprehensive test coverage for portrait filtering logic

**Prompt**: "Let's add an option '--portrait' to the commands search-images and search-videos that will only return images or videos in portrait format (height > width). This is different than the --rated=portrait option which only returns rated images or videos that were rated with a monitor in portrait format (the orientation field of the ratings table)."

**Changes Made**:
- Updated CLI option definitions for `search-images` and `search-videos` commands
- Enhanced `SearchCommand.searchImages()` and `searchVideos()` with portrait filtering logic
- Added real-time filtering statistics during search operations
- Created comprehensive test suite for portrait filtering functionality
- Updated progress display to show filtered content count
- Enhanced search summary to include filter statistics
- Updated README documentation with new usage examples

---

## [1.0.0] - Initial Release

### Added
- Complete CLI application structure
- Pexels API integration for searching images and videos
- SQLite3 database for content management
- Interactive download system with progress tracking
- Rating system (keep/skip with 1-3 star ratings)
- Wallpaper service integration hooks
- Playlist generation (M3U format)
- Comprehensive logging system
- Statistics and API rate limiting tracking
- File organization (new/kept/skip directories)
- Full test suite with Mocha/Chai
- Configuration management with YAML
- Interactive CLI with colorful output

### Core Commands
- `search-images` - Search for images with keywords
- `search-videos` - Search for videos with keywords  
- `download` - Download content with progress tracking
- `list-images` / `list-videos` - Interactive content browsing
- `keep` / `skip` / `undo` - Rating and file management
- `stats` - API and download statistics
- `go-next` - Wallpaper service integration
- `help` - Application information

### Technical Components
- **ConfigManager**: YAML configuration with environment variable support
- **DatabaseManager**: SQLite3 operations with full schema implementation
- **SearchCommand**: Paginated API searches with rate limiting
- **DownloadCommand**: Multi-threaded downloads with progress bars
- **RatingCommand**: File organization and rating system
- **HookCommand**: External wallpaper service integration
- **Logger**: Winston-based logging with rotation
- **ProgressBar**: Visual progress tracking for operations

### Dependencies
- Node.js 18+ with ES6 modules
- pexels (API client)
- sqlite3 (database)
- commander (CLI framework)
- inquirer (interactive prompts)
- chalk (colorized output)
- winston (logging)
- axios (HTTP downloads)
- fs-extra (file operations)
- yaml (configuration parsing)