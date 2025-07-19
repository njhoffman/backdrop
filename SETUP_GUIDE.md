# Pexels CLI Setup Guide

## Quick Setup Instructions

1. **Create project directory:**
   ```bash
   mkdir pexels-cli
   cd pexels-cli
   ```

2. **Copy all files from the artifacts above into the following structure:**

```
pexels-cli/
├── package.json
├── README.md
├── config.example.yaml
├── SETUP_GUIDE.md
├── src/
│   ├── index.js
│   ├── config/
│   │   └── ConfigManager.js
│   ├── database/
│   │   └── DatabaseManager.js
│   ├── utils/
│   │   ├── Logger.js
│   │   └── ProgressBar.js
│   └── commands/
│       ├── SearchCommand.js
│       ├── DownloadCommand.js
│       ├── ListCommand.js
│       ├── StatsCommand.js
│       ├── RatingCommand.js
│       └── HookCommand.js
└── test/
    ├── config/
    │   └── ConfigManager.test.js
    └── database/
        └── DatabaseManager.test.js
```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Make executable globally:**
   ```bash
   npm link
   ```

5. **Initialize configuration:**
   ```bash
   pexels help
   ```

6. **Edit configuration:**
   ```bash
   nano ~/.config/pexels.yaml
   ```
   - Add your Pexels API key
   - Configure hooks for your wallpaper system

7. **Test the installation:**
   ```bash
   pexels stats
   pexels search-images "test"
   ```

## File Contents Reference

### Core Files:
- **package.json** - Project dependencies and scripts
- **src/index.js** - Main application entry point
- **README.md** - User documentation

### Configuration:
- **src/config/ConfigManager.js** - Configuration management
- **config.example.yaml** - Example configuration file

### Database:
- **src/database/DatabaseManager.js** - SQLite database operations

### Commands:
- **src/commands/SearchCommand.js** - Search functionality
- **src/commands/DownloadCommand.js** - Download management
- **src/commands/ListCommand.js** - Content listing
- **src/commands/StatsCommand.js** - Statistics display
- **src/commands/RatingCommand.js** - Rating system
- **src/commands/HookCommand.js** - Wallpaper integration

### Utils:
- **src/utils/Logger.js** - Logging system
- **src/utils/ProgressBar.js** - Progress display

### Tests:
- **test/config/ConfigManager.test.js** - Configuration tests
- **test/database/DatabaseManager.test.js** - Database tests

## Development Workflow

```bash
# Run tests
npm test

# Run in development mode
npm run start

# Check code
node src/index.js help

# Test specific command
node src/index.js stats
```

## Troubleshooting

1. **Permission errors:**
   ```bash
   chmod +x src/index.js
   ```

2. **Module not found:**
   ```bash
   npm install
   ```

3. **Config not found:**
   ```bash
   pexels help  # Creates default config
   ```

## All files are available in the artifacts above - copy each one to its respective location in this directory structure.
