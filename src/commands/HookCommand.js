import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execAsync = promisify(exec);

export class HookCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
  }

  async goNext() {
    try {
      console.log(chalk.cyan('🔄 Processing current item and moving to next...'));
      
      // Step 1: Get current item filename
      const currentFilename = await this.getCurrentFilename();
      
      if (!currentFilename) {
        console.log(chalk.yellow('⚠️  No current item found'));
        return;
      }

      console.log(chalk.white(`📄 Current item: ${currentFilename}`));
      
      // Step 2: Look up item in database
      const item = await this.lookupItemInDatabase(currentFilename);
      
      if (!item) {
        console.log(chalk.yellow('⚠️  Item not found in database'));
        return;
      }

      // Step 3: Check if item needs rating
      const ratings = JSON.parse(item.ratings || '[]');
      
      if (ratings.length === 0) {
        console.log(chalk.yellow('⚠️  Item has no rating - use "keep" or "skip" command first'));
        return;
      }

      // Step 4: Move file based on last rating
      const lastRating = ratings[ratings.length - 1];
      await this.moveFileBasedOnRating(item, lastRating);

      // Step 5: Run play-next hook
      await this.runPlayNextHook();

      console.log(chalk.green('✅ Successfully processed item and moved to next'));
      
      this.logger.info('Go-next completed', {
        filename: currentFilename,
        itemId: item.id,
        lastRating: lastRating.number
      });

    } catch (error) {
      this.logger.error('Go-next failed:', error);
      console.error(chalk.red('❌ Go-next failed:'), error.message);
    }
  }

  async getCurrentFilename() {
    try {
      const config = this.config.get();
      const getNameCmd = config.hooks['get-name'];
      
      if (!getNameCmd) {
        throw new Error('get-name hook not configured');
      }

      const { stdout } = await execAsync(getNameCmd);
      const filename = stdout.trim();
      
      return filename || null;

    } catch (error) {
      this.logger.error('Failed to get current filename:', error);
      throw error;
    }
  }

  async lookupItemInDatabase(filename) {
    try {
      // Extract item ID from filename
      const basename = filename.split('/').pop(); // Get just the filename
      const nameWithoutExt = basename.split('.')[0]; // Remove extension
      const parts = nameWithoutExt.split('_');
      
      if (parts.length < 2) {
        throw new Error(`Invalid filename format: ${filename}`);
      }

      const itemId = parseInt(parts[0]);
      
      if (isNaN(itemId)) {
        throw new Error(`Could not extract item ID from filename: ${filename}`);
      }

      // Determine if it's a video or image based on extension
      const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(filename);
      
      // Look up in appropriate table
      const item = isVideo 
        ? await this.database.getVideo(itemId)
        : await this.database.getImage(itemId);

      if (item) {
        item.type = isVideo ? 'video' : 'image';
        item.filename = basename;
      }

      return item;

    } catch (error) {
      this.logger.error('Failed to lookup item in database:', error);
      throw error;
    }
  }

  async moveFileBasedOnRating(item, rating) {
    try {
      const config = this.config.get();
      const isVideo = item.type === 'video';
      
      const sourceDir = isVideo ? config.paths.videos_new : config.paths.images_new;
      
      let targetDir;
      if (rating.number === 0) {
        // Skipped - move to skip directory
        targetDir = isVideo 
          ? path.join(path.dirname(config.paths.videos_kept), 'videos_skip')
          : path.join(path.dirname(config.paths.images_kept), 'images_skip');
      } else {
        // Kept - move to keep directory
        targetDir = isVideo ? config.paths.videos_kept : config.paths.images_kept;
      }

      const fs = await import('fs-extra');
      const path = await import('path');
      
      await fs.ensureDir(targetDir);
      
      const sourcePath = path.join(sourceDir, item.filename);
      const targetPath = path.join(targetDir, item.filename);
      
      if (await fs.pathExists(sourcePath)) {
        await fs.move(sourcePath, targetPath);
        
        const action = rating.number === 0 ? 'skip' : 'keep';
        console.log(chalk.green(`📁 Moved file to ${action} directory: ${targetPath}`));
        
        this.logger.info(`File moved based on rating`, {
          itemId: item.id,
          rating: rating.number,
          action,
          targetPath
        });
      } else {
        console.log(chalk.yellow(`⚠️  Source file not found: ${sourcePath}`));
        this.logger.warn(`Source file not found: ${sourcePath}`);
      }

    } catch (error) {
      this.logger.error('Failed to move file based on rating:', error);
      throw error;
    }
  }

  async runPlayNextHook() {
    try {
      const config = this.config.get();
      const playNextCmd = config.hooks['play-next'];
      
      if (!playNextCmd) {
        throw new Error('play-next hook not configured');
      }

      console.log(chalk.cyan('▶️  Running play-next hook...'));
      
      const { stdout, stderr } = await execAsync(playNextCmd);
      
      if (stderr) {
        this.logger.warn('play-next hook stderr:', stderr);
      }
      
      if (stdout.trim()) {
        console.log(chalk.white(`Hook output: ${stdout.trim()}`));
      }
      
      this.logger.info('play-next hook executed successfully');

    } catch (error) {
      this.logger.error('Failed to run play-next hook:', error);
      throw error;
    }
  }

  async runPlayPrevHook() {
    try {
      const config = this.config.get();
      const playPrevCmd = config.hooks['play-prev'];
      
      if (!playPrevCmd) {
        throw new Error('play-prev hook not configured');
      }

      console.log(chalk.cyan('⏮️  Running play-prev hook...'));
      
      const { stdout, stderr } = await execAsync(playPrevCmd);
      
      if (stderr) {
        this.logger.warn('play-prev hook stderr:', stderr);
      }
      
      if (stdout.trim()) {
        console.log(chalk.white(`Hook output: ${stdout.trim()}`));
      }
      
      this.logger.info('play-prev hook executed successfully');

    } catch (error) {
      this.logger.error('Failed to run play-prev hook:', error);
      throw error;
    }
  }
}
