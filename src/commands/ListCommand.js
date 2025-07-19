import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';

export class ListCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
  }

  async listImages(options = {}) {
    try {
      const filters = this.buildFilters(options);
      const images = await this.database.getDownloadedImages(filters);
      
      if (images.length === 0) {
        const ratedMsg = filters.rated 
          ? ` (rated${filters.orientation !== 'any' ? ` - ${filters.orientation}` : ''})`
          : '';
        console.log(chalk.yellow(`📭 No downloaded images found${ratedMsg}`));
        return;
      }

      const orientationMsg = filters.rated && filters.orientation !== 'any' 
        ? ` - ${filters.orientation} orientation`
        : '';
      console.log(chalk.cyan.bold(`\n🖼️  Downloaded Images (${images.length})${orientationMsg}\n`));
      
      const filteredImages = await this.filterByKeywords(images, options.keywords);
      const finalImages = this.applyFilters(filteredImages, options);
      
      if (options.playlist) {
        await this.savePlaylist(finalImages, options.playlist, 'images');
      } else {
        await this.displayInteractiveList(finalImages, 'image');
      }
      
    } catch (error) {
      this.logger.error('Failed to list images:', error);
      console.error(chalk.red('❌ Failed to list images:'), error.message);
    }
  }

  async listVideos(options = {}) {
    try {
      const filters = this.buildFilters(options);
      const videos = await this.database.getDownloadedVideos(filters);
      
      if (videos.length === 0) {
        const ratedMsg = filters.rated 
          ? ` (rated${filters.orientation !== 'any' ? ` - ${filters.orientation}` : ''})`
          : '';
        console.log(chalk.yellow(`📭 No downloaded videos found${ratedMsg}`));
        return;
      }

      const orientationMsg = filters.rated && filters.orientation !== 'any' 
        ? ` - ${filters.orientation} orientation`
        : '';
      console.log(chalk.cyan.bold(`\n🎬 Downloaded Videos (${videos.length})${orientationMsg}\n`));
      
      const filteredVideos = await this.filterByKeywords(videos, options.keywords);
      const finalVideos = this.applyFilters(filteredVideos, options);
      
      if (options.playlist) {
        await this.savePlaylist(finalVideos, options.playlist, 'videos');
      } else {
        await this.displayInteractiveList(finalVideos, 'video');
      }
      
    } catch (error) {
      this.logger.error('Failed to list videos:', error);
      console.error(chalk.red('❌ Failed to list videos:'), error.message);
    }
  }

  buildFilters(options) {
    const filters = {};
    
    if (options.number) {
      filters.limit = parseInt(options.number);
    }
    
    if (options.rated !== undefined) {
      filters.rated = true;
      
      // Handle no-local flag
      if (options.noLocal) {
        filters.noLocal = true;
      }
      
      // Handle orientation filter
      if (typeof options.rated === 'string') {
        const orientation = options.rated.toLowerCase();
        if (['landscape', 'portrait', 'any'].includes(orientation)) {
          filters.orientation = orientation;
        } else {
          console.log(chalk.yellow(`⚠️  Invalid orientation '${options.rated}', using 'any'`));
          filters.orientation = 'any';
        }
      } else {
        // Default when --rated is specified without value
        filters.orientation = 'any';
      }
    }
    
    return filters;
  }

  async filterByKeywords(items, keywords) {
    if (!keywords || keywords.length === 0) {
      return items;
    }
    
    return items.filter(item => {
      const searches = JSON.parse(item.searches || '[]');
      return searches.some(search => 
        keywords.some(keyword => 
          search.keywords && search.keywords.toLowerCase().includes(keyword.toLowerCase())
        )
      );
    });
  }

  applyFilters(items, options) {
    let filtered = [...items];
    
    if (options.sizes && options.sizes.length > 0) {
      filtered = filtered.filter(item => {
        const downloaded = JSON.parse(item.downloaded || '[]');
        return downloaded.some(dl => 
          options.sizes.includes(dl.quality || dl.size)
        );
      });
    }
    
    return filtered;
  }

  async displayInteractiveList(items, type) {
    const config = this.config.get();
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const downloaded = JSON.parse(item.downloaded || '[]');
      
      // Get ratings from ratings table
      const ratings = await this.database.db.all(
        'SELECT * FROM ratings WHERE item_id = ? AND source = ? ORDER BY date DESC',
        [item.id, type === 'video' ? 'pexel-video' : 'pexel-image']
      );
      
      console.log(chalk.white.bold(`\n[${i + 1}/${items.length}] ${type.toUpperCase()} ID: ${item.id}`));
      console.log(chalk.gray('─'.repeat(60)));
      
      if (type === 'video') {
        console.log(chalk.white(`📐 Dimensions: ${item.width}x${item.height}`));
        console.log(chalk.white(`⏱️  Duration: ${item.duration}s`));
        console.log(chalk.white(`👤 User: ${item.user_name}`));
      } else {
        console.log(chalk.white(`📐 Dimensions: ${item.width}x${item.height}`));
        console.log(chalk.white(`📷 Photographer: ${item.photographer}`));
        console.log(chalk.white(`🎨 Color: ${item.avg_color}`));
        console.log(chalk.white(`📝 Alt: ${item.alt || 'N/A'}`));
      }
      
      // Show downloaded files or local info
      if (item.source === 'local') {
        console.log(chalk.blue(`📁 Local file: ${item.filename}`));
        console.log(chalk.white(`📐 Dimensions: ${item.size}`));
        if (type === 'video' && item.duration) {
          console.log(chalk.white(`⏱️  Duration: ${item.duration}s`));
        }
      } else {
        if (downloaded.length > 0) {
          console.log(chalk.green(`📥 Downloaded: ${downloaded.length} file(s)`));
          downloaded.forEach(dl => {
            const quality = dl.quality || dl.size;
            const size = dl.size ? this.formatBytes(dl.size) : 'Unknown size';
            console.log(chalk.white(`   • ${quality}: ${size}`));
          });
        }
      }
      
      // Show ratings
      if (ratings.length > 0) {
        const lastRating = ratings[0]; // Most recent rating
        const ratingText = lastRating.rating === 0 ? 'Skipped' : `⭐ ${lastRating.rating}/3`;
        const orientation = lastRating.orientation || 'landscape';
        console.log(chalk.yellow(`📊 Rating: ${ratingText} (${orientation})`));
      } else {
        console.log(chalk.gray('📊 Rating: Not rated'));
      }
      
      // Interactive options
      const choices = [
        { name: 'Continue to next', value: 'continue' },
        { name: 'Rate this item', value: 'rate' },
        { name: 'Show file paths', value: 'paths' },
        { name: 'Exit', value: 'exit' }
      ];
      
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices
        }
      ]);
      
      if (answer.action === 'exit') {
        break;
      } else if (answer.action === 'rate') {
        await this.rateItem(item, type);
      } else if (answer.action === 'paths') {
        this.showFilePaths(downloaded, config, item);
      }
    }
  }

  showFilePaths(downloaded, config, item) {
    console.log(chalk.yellow('\n📁 File Paths:'));
    
    if (item.source === 'local') {
      const localDir = item.duration !== undefined ? config.paths.videos_local : config.paths.images_local;
      const localPath = path.join(localDir, item.filename);
      console.log(chalk.white(`   • Local: ${localPath}`));
    } else {
      downloaded.forEach(dl => {
        if (dl.filepath) {
          console.log(chalk.white(`   • ${path.basename(dl.filepath)}: ${dl.filepath}`));
        }
      });
    }
  }.formatBytes(dl.size) : 'Unknown size';
          console.log(chalk.white(`   • ${quality}: ${size}`));
        });
      }
      
      // Show ratings
      if (ratings.length > 0) {
        const lastRating = ratings[0]; // Most recent rating
        const ratingText = lastRating.rating === 0 ? 'Skipped' : `⭐ ${lastRating.rating}/3`;
        const orientation = lastRating.orientation || 'landscape';
        console.log(chalk.yellow(`📊 Rating: ${ratingText} (${orientation})`));
      } else {
        console.log(chalk.gray('📊 Rating: Not rated'));
      }
      
      // Interactive options
      const choices = [
        { name: 'Continue to next', value: 'continue' },
        { name: 'Rate this item', value: 'rate' },
        { name: 'Show file paths', value: 'paths' },
        { name: 'Exit', value: 'exit' }
      ];
      
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices
        }
      ]);
      
      if (answer.action === 'exit') {
        break;
      } else if (answer.action === 'rate') {
        await this.rateItem(item, type);
      } else if (answer.action === 'paths') {
        this.showFilePaths(downloaded, config);
      }
    }
  }

  async rateItem(item, type) {
    const ratingAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'rating',
        message: 'How would you rate this item?',
        choices: [
          { name: '⭐ 1 - Keep (basic)', value: 1 },
          { name: '⭐⭐ 2 - Keep (good)', value: 2 },
          { name: '⭐⭐⭐ 3 - Keep (excellent)', value: 3 },
          { name: '❌ Skip (don\'t keep)', value: 0 },
          { name: 'Cancel', value: 'cancel' }
        ]
      }
    ]);
    
    if (ratingAnswer.rating !== 'cancel') {
      const source = type === 'video' ? 'pexel-video' : 'pexel-image';
      await this.database.addRating(item.id, ratingAnswer.rating, source);
      
      const ratingText = ratingAnswer.rating === 0 ? 'skipped' : `rated ${ratingAnswer.rating}/3`;
      console.log(chalk.green(`✅ Item ${ratingText}`));
    }
  }

  showFilePaths(downloaded, config) {
    console.log(chalk.yellow('\n📁 File Paths:'));
    downloaded.forEach(dl => {
      if (dl.filepath) {
        console.log(chalk.white(`   • ${path.basename(dl.filepath)}: ${dl.filepath}`));
      }
    });
  }

  async savePlaylist(items, playlistName, type) {
    try {
      const config = this.config.get();
      const playlistDir = config.paths.playlists;
      
      await fs.ensureDir(playlistDir);
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = playlistName || `${type}-playlist-${timestamp}`;
      const filepath = path.join(playlistDir, `${filename}.m3u`);
      
      const lines = ['#EXTM3U'];
      
      for (const item of items) {
        const downloaded = JSON.parse(item.downloaded || '[]');
        
        for (const dl of downloaded) {
          if (dl.filepath && await fs.pathExists(dl.filepath)) {
            const title = type === 'video' 
              ? `${item.user_name} - ${item.width}x${item.height}`
              : `${item.photographer} - ${item.width}x${item.height}`;
            
            lines.push(`#EXTINF:-1,${title}`);
            lines.push(dl.filepath);
          }
        }
      }
      
      await fs.writeFile(filepath, lines.join('\n'));
      
      console.log(chalk.green(`✅ Playlist saved: ${filepath}`));
      console.log(chalk.white(`📝 Contains ${items.length} items`));
      
    } catch (error) {
      this.logger.error('Failed to save playlist:', error);
      console.error(chalk.red('❌ Failed to save playlist:'), error.message);
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}