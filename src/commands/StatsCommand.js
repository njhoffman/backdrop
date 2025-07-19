import { createClient } from "pexels";
import chalk from "chalk";

export class StatsCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.client = createClient(config.get().api_key);
  }

  async showStats() {
    try {
      console.log(chalk.cyan.bold("\n📊 Pexels CLI Statistics\n"));

      // Get API rate limit info
      await this.showApiStats();

      // Get local database stats
      await this.showDatabaseStats();
    } catch (error) {
      this.logger.error("Failed to show stats:", error);
      console.error(chalk.red("❌ Failed to retrieve stats:"), error.message);
    }
  }

  async showApiStats() {
    try {
      console.log(chalk.yellow.bold("🌐 API Rate Limiting Information"));
      console.log(chalk.gray("─".repeat(50)));

      // The Pexels API doesn't provide direct rate limit info
      // We'll make a minimal request to check status
      const response = await this.client.photos.search({
        query: "test",
        per_page: 1,
      });

      console.log(chalk.green("✅ API Connection: Active"));
      console.log(
        chalk.white(`   • Status: ${response ? "Connected" : "Disconnected"}`),
      );
      console.log(chalk.white(`   • Rate Limit: 200 requests/hour (standard)`));
      console.log(
        chalk.white(`   • Last Check: ${new Date().toLocaleString()}`),
      );
    } catch (error) {
      console.log(chalk.red("❌ API Connection: Failed"));
      console.log(chalk.white(`   • Error: ${error.message}`));

      if (error.message.includes("rate limit")) {
        console.log(
          chalk.yellow(
            "   • Rate limit exceeded - please wait before making more requests",
          ),
        );
      }
    }
  }

  async showDatabaseStats() {
    try {
      console.log(chalk.yellow.bold("\n💾 Local Database Statistics"));
      console.log(chalk.gray("─".repeat(50)));

      const stats = await this.database.getStats();

      // Content overview
      console.log(chalk.white.bold("📝 Content Overview:"));
      console.log(
        chalk.white(`   • Total Videos: ${stats.totalVideos.toLocaleString()}`),
      );
      console.log(
        chalk.white(`   • Total Images: ${stats.totalImages.toLocaleString()}`),
      );
      console.log(
        chalk.white(
          `   • Total Items: ${(stats.totalVideos + stats.totalImages).toLocaleString()}`,
        ),
      );

      // Download status
      console.log(chalk.white.bold("\n📥 Download Status:"));
      console.log(
        chalk.white(
          `   • Downloaded Videos: ${stats.downloadedVideos.toLocaleString()}`,
        ),
      );
      console.log(
        chalk.white(
          `   • Downloaded Images: ${stats.downloadedImages.toLocaleString()}`,
        ),
      );

      const totalDownloaded = stats.downloadedVideos + stats.downloadedImages;
      const totalItems = stats.totalVideos + stats.totalImages;
      const downloadPercentage =
        totalItems > 0 ? ((totalDownloaded / totalItems) * 100).toFixed(1) : 0;

      console.log(
        chalk.white(
          `   • Download Progress: ${downloadPercentage}% (${totalDownloaded}/${totalItems})`,
        ),
      );

      // Rating information
      console.log(chalk.white.bold("\n⭐ Rating Information:"));
      console.log(
        chalk.white(
          `   • Rated Items (kept): ${stats.ratedItems.toLocaleString()}`,
        ),
      );
      console.log(
        chalk.white(
          `   • Skipped Items: ${stats.skippedItems.toLocaleString()}`,
        ),
      );

      const totalRated = stats.ratedItems + stats.skippedItems;
      const ratingPercentage =
        totalDownloaded > 0
          ? ((totalRated / totalDownloaded) * 100).toFixed(1)
          : 0;

      console.log(
        chalk.white(
          `   • Rating Progress: ${ratingPercentage}% (${totalRated}/${totalDownloaded})`,
        ),
      );

      // Remaining work
      console.log(chalk.white.bold("\n📋 Remaining Work:"));
      const remainingDownloads = totalItems - totalDownloaded;
      const remainingRatings = totalDownloaded - totalRated;

      console.log(
        chalk.white(
          `   • Items left to download: ${remainingDownloads.toLocaleString()}`,
        ),
      );
      console.log(
        chalk.white(
          `   • Items left to rate: ${remainingRatings.toLocaleString()}`,
        ),
      );

      // Storage information
      await this.showStorageStats();
    } catch (error) {
      this.logger.error("Failed to show database stats:", error);
      console.error(
        chalk.red("❌ Failed to retrieve database stats:"),
        error.message,
      );
    }
  }

  async showStorageStats() {
    try {
      console.log(chalk.white.bold("\n💽 Storage Information:"));

      const config = this.config.get();
      const fs = await import("fs-extra");

      const paths = [
        { name: "New Videos", path: config.paths.videos_new },
        { name: "New Images", path: config.paths.images_new },
        { name: "Kept Videos", path: config.paths.videos_kept },
        { name: "Kept Images", path: config.paths.images_kept },
      ];

      for (const pathInfo of paths) {
        try {
          const stats = await fs.stat(pathInfo.path);
          const files = await fs.readdir(pathInfo.path);

          console.log(
            chalk.white(`   • ${pathInfo.name}: ${files.length} files`),
          );
        } catch (error) {
          console.log(
            chalk.white(`   • ${pathInfo.name}: Directory not accessible`),
          );
        }
      }
    } catch (error) {
      this.logger.error("Failed to show storage stats:", error);
    }
  }
}
