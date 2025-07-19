import axios from "axios";
import fs from "fs-extra";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";
import { ProgressBar } from "../utils/ProgressBar.js";

export class DownloadCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
  }

  async download(options = {}) {
    try {
      const config = this.config.get();

      // Show download options
      const downloadOptions = await this.getDownloadOptions(options);

      // Check available space and permissions
      await this.checkPrerequisites(downloadOptions);

      // Get items to download
      const items = await this.getItemsToDownload(downloadOptions);

      if (items.length === 0) {
        console.log(chalk.yellow("📭 No items to download"));
        return;
      }

      console.log(chalk.cyan(`📥 Starting download of ${items.length} items`));

      const progress = new ProgressBar("Downloading", items.length);
      let downloaded = 0;
      let totalSize = 0;
      let errors = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        try {
          const downloadedFiles = await this.downloadItem(
            item,
            downloadOptions,
          );

          if (item.type === "video") {
            await this.database.updateVideoDownloaded(item.id, downloadedFiles);
          } else {
            await this.database.updateImageDownloaded(item.id, downloadedFiles);
          }

          downloaded++;
          totalSize += downloadedFiles.reduce(
            (sum, file) => sum + (file.size || 0),
            0,
          );
        } catch (error) {
          this.logger.error(
            `Download failed for ${item.type} ${item.id}:`,
            error,
          );
          errors++;
        }

        progress.update(i + 1, `Downloaded: ${downloaded}, Errors: ${errors}`);

        // Small delay to avoid overwhelming the server
        await this.sleep(50);
      }

      progress.complete();

      console.log(chalk.green("\n✅ Download completed!"));
      console.log(chalk.white(`📊 Summary:`));
      console.log(chalk.white(`   • Successfully downloaded: ${downloaded}`));
      console.log(
        chalk.white(`   • Total size: ${this.formatBytes(totalSize)}`),
      );
      console.log(chalk.white(`   • Errors: ${errors}`));

      this.logger.info("Download completed", {
        downloaded,
        totalSize,
        errors,
        options: downloadOptions,
      });
    } catch (error) {
      this.logger.error("Download failed:", error);
      console.error(chalk.red("❌ Download failed:"), error.message);
    }
  }

  async getDownloadOptions(options) {
    const config = this.config.get();
    const defaultTotal = 50;

    const questions = [];

    if (!options.total) {
      questions.push({
        type: "input",
        name: "total",
        message: "How many items to download?",
        default: defaultTotal.toString(),
        validate: (input) => {
          const num = parseInt(input);
          return (!isNaN(num) && num > 0) || "Please enter a valid number";
        },
      });
    }

    if (!options.type) {
      questions.push({
        type: "list",
        name: "type",
        message: "What type of content to download?",
        choices: [
          { name: "Both images and videos", value: "both" },
          { name: "Images only", value: "images" },
          { name: "Videos only", value: "videos" },
        ],
        default: "both",
      });
    }

    questions.push({
      type: "list",
      name: "imageSize",
      message: "Preferred image size:",
      choices: [
        { name: "Original (highest quality)", value: "original" },
        { name: "Large (2x)", value: "large2x" },
        { name: "Large", value: "large" },
        { name: "Medium", value: "medium" },
      ],
      default: "large",
      when: (answers) => (options.type || answers.type) !== "videos",
    });

    questions.push({
      type: "list",
      name: "videoQuality",
      message: "Preferred video quality:",
      choices: [
        { name: "HD (best quality)", value: "hd" },
        { name: "SD (standard)", value: "sd" },
        { name: "Any available", value: "any" },
      ],
      default: "hd",
      when: (answers) => (options.type || answers.type) !== "images",
    });

    const answers = await inquirer.prompt(questions);

    return {
      total: parseInt(options.total || answers.total),
      type: options.type || answers.type,
      imageSize: answers.imageSize || "large",
      videoQuality: answers.videoQuality || "hd",
    };
  }

  async checkPrerequisites(options) {
    const config = this.config.get();

    // Check directories exist and are writable
    const dirs = [config.paths.videos_new, config.paths.images_new];

    for (const dir of dirs) {
      try {
        await fs.ensureDir(dir);
        await fs.access(dir, fs.constants.W_OK);
      } catch (error) {
        throw new Error(`Directory ${dir} is not writable: ${error.message}`);
      }
    }

    // TODO: Add disk space check
    // TODO: Add API rate limit check

    console.log(chalk.green("✅ Prerequisites check passed"));
  }

  async getItemsToDownload(options) {
    const items = [];

    if (options.type === "both" || options.type === "videos") {
      const videos = await this.database.getVideosForDownload(
        options.type === "videos"
          ? options.total
          : Math.floor(options.total / 2),
      );
      items.push(...videos.map((v) => ({ ...v, type: "video" })));
    }

    if (options.type === "both" || options.type === "images") {
      const images = await this.database.getImagesForDownload(
        options.type === "images"
          ? options.total
          : Math.ceil(options.total / 2),
      );
      items.push(...images.map((i) => ({ ...i, type: "image" })));
    }

    return items.slice(0, options.total);
  }

  async downloadItem(item, options) {
    const config = this.config.get();
    const downloadedFiles = [];

    if (item.type === "video") {
      const videoFiles = JSON.parse(item.video_files || "[]");
      const targetFile = this.selectVideoFile(videoFiles, options.videoQuality);

      if (targetFile) {
        const filename = `${item.id}_${targetFile.quality}.${this.getFileExtension(targetFile.file_type)}`;
        const filepath = path.join(config.paths.videos_new, filename);

        const size = await this.downloadFile(targetFile.link, filepath);
        downloadedFiles.push({
          id: targetFile.id,
          quality: targetFile.quality,
          filepath,
          size,
        });
      }
    } else {
      const src = JSON.parse(item.src || "{}");
      const targetUrl = src[options.imageSize];

      if (targetUrl) {
        const filename = `${item.id}_${options.imageSize}.jpg`;
        const filepath = path.join(config.paths.images_new, filename);

        const size = await this.downloadFile(targetUrl, filepath);
        downloadedFiles.push({
          size: options.imageSize,
          filepath,
          size,
        });
      }
    }

    return downloadedFiles;
  }

  selectVideoFile(videoFiles, quality) {
    if (quality === "any") {
      return videoFiles[0];
    }

    // Try to find exact quality match
    const exact = videoFiles.find((f) => f.quality === quality);
    if (exact) return exact;

    // Fallback to best available
    const qualityOrder = ["hd", "sd"];
    for (const q of qualityOrder) {
      const file = videoFiles.find((f) => f.quality === q);
      if (file) return file;
    }

    return videoFiles[0];
  }

  async downloadFile(url, filepath) {
    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
    });

    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      let size = 0;

      response.data.on("data", (chunk) => {
        size += chunk.length;
      });

      writer.on("finish", () => resolve(size));
      writer.on("error", reject);
    });
  }

  getFileExtension(fileType) {
    const extensions = {
      "video/mp4": "mp4",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
    };

    return extensions[fileType] || "mp4";
  }

  formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
