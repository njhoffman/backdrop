# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Run tests:**
```bash
npm test
# Uses Mocha test runner for config and database tests
```

**Start application:**
```bash
npm start
# or
node src/index.js
```

**Link for global use:**
```bash
npm link
pexels help
```

**Test specific functionality:**
```bash
node src/index.js stats
node src/index.js search-images "test query"
```

## Project Architecture

### Core Application Structure
The application is built around a central `PexelsApp` class in `src/index.js` that coordinates three main managers:

- **ConfigManager** (`src/config/ConfigManager.js`) - Handles YAML configuration loading, defaults, and environment variable integration
- **DatabaseManager** (`src/database/DatabaseManager.js`) - SQLite3 operations with promisified interface for search history, downloads, and ratings
- **Logger** (`src/utils/Logger.js`) - Winston-based logging system

### Command Pattern Architecture
Each CLI command is implemented as a separate class in `src/commands/`:

- **SearchCommand** - Pexels API integration for searching images/videos with pagination
- **DownloadCommand** - File download management with progress tracking
- **ListCommand** - Database queries for filtering and displaying content
- **StatsCommand** - API usage and download statistics
- **RatingCommand** - Content rating system (keep/skip/undo)
- **HookCommand** - External wallpaper manager integration

All commands receive the same three dependencies: `config`, `database`, and `logger`.

### Database Schema
Uses SQLite3 with four main tables:
- `search` - Search history tracking
- `videos` - Video metadata with JSON fields for searches, downloads, ratings
- `images` - Image metadata with JSON fields for searches, downloads, ratings  
- `ratings` - Rating events for analytics

### Configuration Management
- Default config: `~/.config/pexels.yaml`
- Environment variable support: `PEXELS_API`
- Automatic directory creation for cache and data paths
- Required hooks for wallpaper manager integration

### External Dependencies
- **Pexels API client** - Primary data source
- **Commander.js** - CLI argument parsing
- **Inquirer.js** - Interactive prompts
- **Chalk** - Terminal colors
- **fs-extra** - File system operations
- **YAML** - Configuration parsing

### Hook System
The application integrates with external wallpaper managers through configurable shell commands:
- `get-name` - Get current wallpaper filename
- `play-prev` - Navigate to previous wallpaper
- `play-next` - Navigate to next wallpaper

### File Organization Pattern
Content is organized into directory pairs:
- `*_new` directories for fresh downloads
- `*_kept` directories for rated content
- `*_skip` directories (auto-created) for rejected content

### Error Handling
- Application initialization validates API keys and required hooks
- Database operations use promisified SQLite3 with proper error propagation
- File operations ensure directory existence before writes