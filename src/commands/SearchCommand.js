import { createClient } from 'pexels';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { ProgressBar } from '../utils/ProgressBar.js';

export class SearchCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.client = createClient(config.get().api_key);
  }

  async searchImages(query, options) {
    try {
      if (!query) {
        const answer = await inquirer.prompt([
          {
            type: 'input',
            name: 'query',
            message: 'Enter search keywords for images:',
            validate: (input) => input.trim() !== '' || 'Query cannot be empty'
          }
        ]);
        query = answer.query;
      }

      console.log(chalk.cyan(`🔍 Searching for images: "${query}"`));

      const searchConfig = this.config.get().search_images;
      const searchParams = {
        query,
        per_page: parseInt(options.perPage) || searchConfig.per_page,
        orientation: options.orientation || searchConfig.orientation,
        size: options.minSize || searchConfig.min_size,
        color: options.color || searchConfig.color
      };

      // Remove empty parameters
      Object.keys(searchParams).forEach(key => {
        if (searchParams[key] === '') {
          delete searchParams[key];
        }
      });

      const searchId = await this.database.addSearch(query);
      let totalFetched = 0;
      let totalAdded = 0;
      let totalUpdated = 0;
      let totalFiltered = 0; // Count of items filtered out by --portrait
      let page = 1;
      let hasMore = true;

      const progress = new ProgressBar('Fetching images');

      while (hasMore) {
        try {
          const response = await this.client.photos.search({
            ...searchParams,
            page
          });

          if (!response.photos || response.photos.length === 0) {
            hasMore = false;
            break;
          }

          for (let i = 0; i < response.photos.length; i++) {
            const photo = response.photos[i];
            
            // Apply --portrait filter if specified
            if (options.portrait && photo.height <= photo.width) {
              totalFiltered++;
              continue;
            }
            
            const ranking = (page - 1) * searchParams.per_page + i + 1;
            
            const existing = await this.database.getImage(photo.id);
            if (existing) {
              await this.database.updateImageSearch(photo.id, searchId, ranking);
              totalUpdated++;
            } else {
              await this.database.addImage(photo, searchId, ranking);
              totalAdded++;
            }
            totalFetched++;
          }

          progress.update(page, `Page ${page} - ${totalFetched} images processed${options.portrait ? `, ${totalFiltered} filtered` : ''}`);

          if (response.photos.length < searchParams.per_page) {
            hasMore = false;
          } else {
            page++;
          }

          // Small delay to respect rate limits
          await this.sleep(100);

        } catch (error) {
          this.logger.error('Error fetching page:', { page, error: error.message });
          if (error.message.includes('rate limit')) {
            console.log(chalk.yellow('⚠️  Rate limit reached, stopping search'));
            break;
          }
          throw error;
        }
      }

      progress.complete();

      console.log(chalk.green('\n✅ Search completed!'));
      console.log(chalk.white(`📊 Summary:`));
      console.log(chalk.white(`   • Total images fetched: ${totalFetched}`));
      console.log(chalk.white(`   • New images added: ${totalAdded}`));
      console.log(chalk.white(`   • Existing images updated: ${totalUpdated}`));
      if (options.portrait) {
        console.log(chalk.white(`   • Images filtered (not portrait): ${totalFiltered}`));
      }

      this.logger.info('Image search completed', {
        query,
        totalFetched,
        totalAdded,
        totalUpdated,
        pages: page - 1
      });

      // Ask if user wants to proceed to download
      const continueAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'download',
          message: 'Would you like to download these images now?',
          default: false
        }
      ]);

      if (continueAnswer.download) {
        const { DownloadCommand } = await import('./DownloadCommand.js');
        const downloadCmd = new DownloadCommand(this.config, this.database, this.logger);
        await downloadCmd.download({ type: 'images' });
      }

    } catch (error) {
      this.logger.error('Image search failed:', error);
      console.error(chalk.red('❌ Search failed:'), error.message);
    }
  }

  async searchVideos(query, options) {
    try {
      if (!query) {
        const answer = await inquirer.prompt([
          {
            type: 'input',
            name: 'query',
            message: 'Enter search keywords for videos:',
            validate: (input) => input.trim() !== '' || 'Query cannot be empty'
          }
        ]);
        query = answer.query;
      }

      console.log(chalk.cyan(`🔍 Searching for videos: "${query}"`));

      const searchConfig = this.config.get().search_videos;
      const searchParams = {
        query,
        per_page: parseInt(options.perPage) || searchConfig.per_page,
        min_size: options.minSize || searchConfig.min_size
      };

      // Remove empty parameters
      Object.keys(searchParams).forEach(key => {
        if (searchParams[key] === '') {
          delete searchParams[key];
        }
      });

      const searchId = await this.database.addSearch(query);
      let totalFetched = 0;
      let totalAdded = 0;
      let totalUpdated = 0;
      let totalFiltered = 0; // Count of items filtered out by --portrait
      let page = 1;
      let hasMore = true;

      const progress = new ProgressBar('Fetching videos');

      while (hasMore) {
        try {
          const response = await this.client.videos.search({
            ...searchParams,
            page
          });

          if (!response.videos || response.videos.length === 0) {
            hasMore = false;
            break;
          }

          for (let i = 0; i < response.videos.length; i++) {
            const video = response.videos[i];
            
            // Apply --portrait filter if specified
            if (options.portrait && video.height <= video.width) {
              totalFiltered++;
              continue;
            }
            
            const ranking = (page - 1) * searchParams.per_page + i + 1;
            
            const existing = await this.database.getVideo(video.id);
            if (existing) {
              await this.database.updateVideoSearch(video.id, searchId, ranking);
              totalUpdated++;
            } else {
              await this.database.addVideo(video, searchId, ranking);
              totalAdded++;
            }
            totalFetched++;
          }

          progress.update(page, `Page ${page} - ${totalFetched} videos processed${options.portrait ? `, ${totalFiltered} filtered` : ''}`);

          if (response.videos.length < searchParams.per_page) {
            hasMore = false;
          } else {
            page++;
          }

          // Small delay to respect rate limits
          await this.sleep(100);

        } catch (error) {
          this.logger.error('Error fetching page:', { page, error: error.message });
          if (error.message.includes('rate limit')) {
            console.log(chalk.yellow('⚠️  Rate limit reached, stopping search'));
            break;
          }
          throw error;
        }
      }

      progress.complete();

      console.log(chalk.green('\n✅ Search completed!'));
      console.log(chalk.white(`📊 Summary:`));
      console.log(chalk.white(`   • Total videos fetched: ${totalFetched}`));
      console.log(chalk.white(`   • New videos added: ${totalAdded}`));
      console.log(chalk.white(`   • Existing videos updated: ${totalUpdated}`));
      if (options.portrait) {
        console.log(chalk.white(`   • Videos filtered (not portrait): ${totalFiltered}`));
      }

      this.logger.info('Video search completed', {
        query,
        totalFetched,
        totalAdded,
        totalUpdated,
        pages: page - 1
      });

      // Ask if user wants to proceed to download
      const continueAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'download',
          message: 'Would you like to download these videos now?',
          default: false
        }
      ]);

      if (continueAnswer.download) {
        const { DownloadCommand } = await import('./DownloadCommand.js');
        const downloadCmd = new DownloadCommand(this.config, this.database, this.logger);
        await downloadCmd.download({ type: 'videos' });
      }

    } catch (error) {
      this.logger.error('Video search failed:', error);
      console.error(chalk.red('❌ Search failed:'), error.message);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}