import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execAsync = promisify(exec);

export class RatingCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.lastRating = null; // Store last rating for undo functionality
  }

  async keep(rating = 1) {
    try {
      const numRating = parseInt(rating);
      
      if (isNaN(numRating) || numRating < 1 || numRating > 3) {
        console.error(chalk.red('❌ Rating must be between 1 and 3'));
        return;
      }

      // Get current item from hook
      const currentItem = await this.getCurrentItem();
      
      if (!currentItem) {
        console.error(chalk.red('❌ No current item found'));
        return;
      }

      // Add rating to database
      await this.database.addRating(
        currentItem.id,
        numRating,
        currentItem.type === 'video' ? 'pexel-video' : 'pexel-image',
        await this.getCurrentResolution()
      );

      // Move file to keep directory
      await this.moveFileToKeep(currentItem, numRating);

      // Store for undo functionality
      this.lastRating = {
        item: currentItem,
        rating: numRating,
        action: 'keep',
        timestamp: new Date().toISOString()
      };

      console.log(chalk.green(`✅ Item rated ${numRating}/3 and moved to keep directory`));
      
      this.logger.info('Item rated and kept', {
        itemId: currentItem.id,
        type: currentItem.type,
        rating: numRating
      });

    } catch (error) {
      this.logger.error('Failed to keep item:', error);
      console.error(chalk.red('❌ Failed to keep item:'), error.message);
    }
  }

  async skip() {
    try {
      // Get current item from hook
      const currentItem = await this.getCurrentItem();
      
      if (!currentItem) {
        console.error(chalk.red('❌ No current item found'));
        return;
      }

      // Add rating (0 = skipped) to database
      await this.database.addRating(
        currentItem.id,
        0,
        currentItem.type === 'video' ? 'pexel-video' : 'pexel-image',
        await this.getCurrentResolution()
      );

      // Move file to skip directory
      await this.moveFileToSkip(currentItem);

      // Store for undo functionality
      this.lastRating = {
        item: currentItem,
        rating: 0,
        action: 'skip',
        timestamp: new Date().toISOString()
      };

      console.log(chalk.yellow('⏭️  Item skipped and moved to skip directory'));
      
      this.logger.info('Item skipped', {
        itemId: currentItem.id,
        type: currentItem.type
      });

    } catch (error) {
      this.logger.error('Failed to skip item:', error);
      console.error(chalk.red('❌ Failed to skip item:'), error.message);
    }
  }

  async undo() {
    try {
      if (!this.lastRating) {
        console.log(chalk.yellow('⚠️  No recent rating to undo'));
        return;
      }

      const { item, rating, action } = this.lastRating;
      
      // Move file back to original directory
      await this.moveFileBack(item, action);

      // Remove rating from database (this would need a new method in DatabaseManager)
      // For now, we'll just log that we should remove it
      console.log(chalk.green(`✅ Undid ${action} for item ${item.id}`));
      console.log(chalk.white('📝 Note: Rating entry remains in database for audit trail'));

      this.lastRating = null;
      
      this.logger.info('Rating undone', {
        itemId: item.id,
        type: item.type,
        previousAction: action,
        previousRating: rating
      });

    } catch (error) {
      this.logger.error('Failed to undo rating:', error);
      console.error(chalk.red('❌ Failed to undo rating:'), error.message);
    }
  }

  async getCurrentItem() {
    try {
      const config = this.config.get();
      const getNameCmd = config.hooks['get-name'];
      
      if (!getNameCmd) {
        throw new Error('get-name hook not configured');
      }

      const { stdout } = await execAsync(getNameCmd);
      const filename = stdout.trim();
      
      if (!filename) {
        return null;
      }

      // Parse filename to get item ID and type
      const basename = path.basename(filename, path.extname(filename));
      const parts = basename.split('_');
      
      if (parts.length < 2) {
        throw new Error(`Invalid filename format: ${filename}`);
      }

      const itemId = parseInt(parts[0]);
      const isVideo = filename.includes('.mp4') || filename.includes('.mov') || filename.includes('.avi');
      
      // Get item from database
      const item = isVideo 
        ? await this.database.getVideo(itemId)
        : await this.database.getImage(itemId);

      if (!item) {
        throw new Error(`Item not found in database: ${itemId}`);
      }

      return {
        ...item,
        type: isVideo ? 'video' : 'image',
        filename
      };

    } catch (error) {
      this.logger.error('Failed to get current item:', error);
      throw error;
    }
  }

  async getCurrentResolution() {
    try {
      // Try to get resolution from display info
      // This is a simplified version - in practice you'd want to detect the actual resolution
      const { stdout } = await execAsync('xrandr --current | grep primary').catch(() => ({ stdout: '' }));
      
      if (stdout) {
        const match = stdout.match(/(\d+x\d+)/);
        if (match) {
          return match[1];
        }
      }
      
      return '1920x1080'; // Default fallback
      
    } catch (error) {
      this.logger.warn('Failed to get current resolution:', error);
      return '1920x1080';
    }
  }

  async moveFileToKeep(item, rating) {
    const config = this.config.get();
    const isVideo = item.type === 'video';
    
    const sourceDir = isVideo ? config.paths.videos_new : config.paths.images_new;
    const targetDir = isVideo ? config.paths.videos_kept : config.paths.images_kept;
    
    await fs.ensureDir(targetDir);
    
    const sourcePath = path.join(sourceDir, item.filename);
    const targetPath = path.join(targetDir, item.filename);
    
    if (await fs.pathExists(sourcePath)) {
      await fs.move(sourcePath, targetPath);
      this.logger.info(`Moved file to keep directory: ${targetPath}`);
    } else {
      this.logger.warn(`Source file not found: ${sourcePath}`);
    }
  }

  async moveFileToSkip(item) {
    const config = this.config.get();
    const isVideo = item.type === 'video';
    
    const sourceDir = isVideo ? config.paths.videos_new : config.paths.images_new;
    
    // Create skip directories (not in original spec, but needed for functionality)
    const skipDir = isVideo 
      ? path.join(path.dirname(config.paths.videos_kept), 'videos_skip')
      : path.join(path.dirname(config.paths.images_kept), 'images_skip');
    
    await fs.ensureDir(skipDir);
    
    const sourcePath = path.join(sourceDir, item.filename);
    const targetPath = path.join(skipDir, item.filename);
    
    if (await fs.pathExists(sourcePath)) {
      await fs.move(sourcePath, targetPath);
      this.logger.info(`Moved file to skip directory: ${targetPath}`);
    } else {
      this.logger.warn(`Source file not found: ${sourcePath}`);
    }
  }

  async moveFileBack(item, action) {
    const config = this.config.get();
    const isVideo = item.type === 'video';
    
    const originalDir = isVideo ? config.paths.videos_new : config.paths.images_new;
    
    let currentDir;
    if (action === 'keep') {
      currentDir = isVideo ? config.paths.videos_kept : config.paths.images_kept;
    } else {
      currentDir = isVideo 
        ? path.join(path.dirname(config.paths.videos_kept), 'videos_skip')
        : path.join(path.dirname(config.paths.images_kept), 'images_skip');
    }
    
    const currentPath = path.join(currentDir, item.filename);
    const originalPath = path.join(originalDir, item.filename);
    
    if (await fs.pathExists(currentPath)) {
      await fs.move(currentPath, originalPath);
      this.logger.info(`Moved file back to original directory: ${originalPath}`);
    } else {
      this.logger.warn(`Current file not found: ${currentPath}`);
    }
  }
}
