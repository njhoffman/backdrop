import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';

export class DatabaseManager {
  constructor() {
    this.db = null;
    this.dbPath = null;
  }

  async initialize(dbPath) {
    this.dbPath = dbPath;
    
    try {
      // Ensure database directory exists
      await fs.ensureDir(path.dirname(dbPath));
      
      // Open database connection
      this.db = new sqlite3.Database(dbPath);
      
      // Promisify database methods
      this.db.run = promisify(this.db.run.bind(this.db));
      this.db.get = promisify(this.db.get.bind(this.db));
      this.db.all = promisify(this.db.all.bind(this.db));
      
      // Create tables if they don't exist
      await this.createTables();
      
    } catch (error) {
      throw new Error(`Failed to initialize database: ${error.message}`);
    }
  }

  async createTables() {
    const createSearchTable = `
      CREATE TABLE IF NOT EXISTS search (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        keywords TEXT NOT NULL
      )
    `;

    const createVideosTable = `
      CREATE TABLE IF NOT EXISTS pexel_videos (
        id INTEGER PRIMARY KEY,
        width INTEGER,
        height INTEGER,
        url TEXT,
        image TEXT,
        duration INTEGER,
        user_id INTEGER,
        user_url TEXT,
        user_name TEXT,
        video_files TEXT,
        searches TEXT,
        downloaded TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const createImagesTable = `
      CREATE TABLE IF NOT EXISTS pexel_images (
        id INTEGER PRIMARY KEY,
        width INTEGER,
        height INTEGER,
        url TEXT,
        photographer TEXT,
        photographer_url TEXT,
        photographer_id INTEGER,
        avg_color TEXT,
        alt TEXT,
        src TEXT,
        searches TEXT,
        downloaded TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const createRatingsTable = `
      CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        rating INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        resolution TEXT,
        orientation TEXT DEFAULT 'landscape',
        source TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const createLocalVideosTable = `
      CREATE TABLE IF NOT EXISTS local_videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        size TEXT NOT NULL,
        duration INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const createLocalImagesTable = `
      CREATE TABLE IF NOT EXISTS local_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        size TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await this.db.run(createSearchTable);
    await this.db.run(createVideosTable);
    await this.db.run(createImagesTable);
    await this.db.run(createRatingsTable);
    await this.db.run(createLocalVideosTable);
    await this.db.run(createLocalImagesTable);
  }

  async addSearch(keywords) {
    const query = `
      INSERT INTO search (date, keywords)
      VALUES (?, ?)
    `;
    
    const result = await this.db.run(query, [new Date().toISOString(), keywords]);
    return result.lastID;
  }

  async addVideo(video, searchId, ranking) {
    const existing = await this.getVideo(video.id);
    
    if (existing) {
      // Update existing video with new search info
      return await this.updateVideoSearch(video.id, searchId, ranking);
    }

    const query = `
      INSERT INTO videos (
        id, width, height, url, image, duration, user_id, user_url, user_name,
        video_files, searches, downloaded, ratings
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const searches = JSON.stringify([{ search_id: searchId, ranking }]);
    const downloaded = JSON.stringify([]);

    await this.db.run(query, [
      video.id, video.width, video.height, video.url, video.image, video.duration,
      video.user.id, video.user.url, video.user.name,
      JSON.stringify(video.video_files), searches, downloaded
    ]);

    return video.id;
  }

  async addImage(image, searchId, ranking) {
    const existing = await this.getImage(image.id);
    
    if (existing) {
      // Update existing image with new search info
      return await this.updateImageSearch(image.id, searchId, ranking);
    }

    const query = `
      INSERT INTO images (
        id, width, height, url, photographer, photographer_url, photographer_id,
        avg_color, alt, src, searches, downloaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const searches = JSON.stringify([{ search_id: searchId, ranking }]);
    const downloaded = JSON.stringify([]);

    await this.db.run(query, [
      image.id, image.width, image.height, image.url, image.photographer,
      image.photographer_url, image.photographer_id, image.avg_color, image.alt,
      JSON.stringify(image.src), searches, downloaded
    ]);

    return image.id;
  }

  async updateVideoSearch(videoId, searchId, ranking) {
    const video = await this.getVideo(videoId);
    if (!video) return false;

    const searches = JSON.parse(video.searches || '[]');
    searches.push({ search_id: searchId, ranking });

    const query = `UPDATE pexel_videos SET searches = ? WHERE id = ?`;
    await this.db.run(query, [JSON.stringify(searches), videoId]);
    return true;
  }

  async updateImageSearch(imageId, searchId, ranking) {
    const image = await this.getImage(imageId);
    if (!image) return false;

    const searches = JSON.parse(image.searches || '[]');
    searches.push({ search_id: searchId, ranking });

    const query = `UPDATE pexel_images SET searches = ? WHERE id = ?`;
    await this.db.run(query, [JSON.stringify(searches), imageId]);
    return true;
  }

  async getVideo(id) {
    const query = `SELECT * FROM pexel_videos WHERE id = ?`;
    return await this.db.get(query, [id]);
  }

  async getImage(id) {
    const query = `SELECT * FROM pexel_images WHERE id = ?`;
    return await this.db.get(query, [id]);
  }

  async getVideosForDownload(limit = null) {
    let query = `
      SELECT * FROM pexel_videos 
      WHERE downloaded = '[]' OR downloaded IS NULL
      ORDER BY id
    `;
    
    if (limit) {
      query += ` LIMIT ${limit}`;
    }
    
    return await this.db.all(query);
  }

  async getImagesForDownload(limit = null) {
    let query = `
      SELECT * FROM pexel_images 
      WHERE downloaded = '[]' OR downloaded IS NULL
      ORDER BY id
    `;
    
    if (limit) {
      query += ` LIMIT ${limit}`;
    }
    
    return await this.db.all(query);
  }

  async updateVideoDownloaded(videoId, downloadedFiles) {
    const query = `UPDATE pexel_videos SET downloaded = ? WHERE id = ?`;
    await this.db.run(query, [JSON.stringify(downloadedFiles), videoId]);
  }

  async updateImageDownloaded(imageId, downloadedSizes) {
    const query = `UPDATE pexel_images SET downloaded = ? WHERE id = ?`;
    await this.db.run(query, [JSON.stringify(downloadedSizes), imageId]);
  }

  async addRating(itemId, rating, source, resolution = null) {
    const orientation = this.getOrientationFromResolution(resolution);
    
    const query = `
      INSERT INTO ratings (date, rating, item_id, resolution, orientation, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    await this.db.run(query, [
      new Date().toISOString(), rating, itemId, resolution, orientation, source
    ]);
  }

  getOrientationFromResolution(resolution) {
    if (!resolution) return 'landscape';
    
    const match = resolution.match(/(\d+)x(\d+)/);
    if (!match) return 'landscape';
    
    const width = parseInt(match[1]);
    const height = parseInt(match[2]);
    
    return height > width ? 'portrait' : 'landscape';
  }

  async addLocalVideo(filename, size, duration) {
    const query = `
      INSERT INTO local_videos (filename, size, duration)
      VALUES (?, ?, ?)
    `;
    
    const result = await this.db.run(query, [filename, size, duration]);
    return result.lastID;
  }

  async addLocalImage(filename, size) {
    const query = `
      INSERT INTO local_images (filename, size)
      VALUES (?, ?)
    `;
    
    const result = await this.db.run(query, [filename, size]);
    return result.lastID;
  }

  async getLocalVideos(filters = {}) {
    let query = `SELECT * FROM local_videos`;
    const params = [];

    if (filters.rated) {
      let ratingCondition = ` WHERE id IN (SELECT DISTINCT item_id FROM ratings WHERE source = 'local-video' AND rating > 0`;
      
      if (filters.orientation && filters.orientation !== 'any') {
        ratingCondition += ` AND orientation = ?`;
        params.push(filters.orientation);
      }
      
      ratingCondition += `)`;
      query += ratingCondition;
    }

    if (filters.limit) {
      query += ` LIMIT ?`;
      params.push(filters.limit);
    }

    return await this.db.all(query, params);
  }

  async getLocalImages(filters = {}) {
    let query = `SELECT * FROM local_images`;
    const params = [];

    if (filters.rated) {
      let ratingCondition = ` WHERE id IN (SELECT DISTINCT item_id FROM ratings WHERE source = 'local-image' AND rating > 0`;
      
      if (filters.orientation && filters.orientation !== 'any') {
        ratingCondition += ` AND orientation = ?`;
        params.push(filters.orientation);
      }
      
      ratingCondition += `)`;
      query += ratingCondition;
    }

    if (filters.limit) {
      query += ` LIMIT ?`;
      params.push(filters.limit);
    }

    return await this.db.all(query, params);
  }

  async getStats() {
    const videoCount = await this.db.get(`SELECT COUNT(*) as count FROM pexel_videos`);
    const imageCount = await this.db.get(`SELECT COUNT(*) as count FROM pexel_images`);
    const downloadedVideos = await this.db.get(`SELECT COUNT(*) as count FROM pexel_videos WHERE downloaded != '[]'`);
    const downloadedImages = await this.db.get(`SELECT COUNT(*) as count FROM pexel_images WHERE downloaded != '[]'`);
    const ratedItems = await this.db.get(`SELECT COUNT(*) as count FROM ratings WHERE rating > 0`);
    const skippedItems = await this.db.get(`SELECT COUNT(*) as count FROM ratings WHERE rating = 0`);

    return {
      totalVideos: videoCount.count,
      totalImages: imageCount.count,
      downloadedVideos: downloadedVideos.count,
      downloadedImages: downloadedImages.count,
      ratedItems: ratedItems.count,
      skippedItems: skippedItems.count
    };
  }

  async getDownloadedVideos(filters = {}) {
    let query = `SELECT * FROM pexel_videos WHERE downloaded != '[]' AND downloaded IS NOT NULL`;
    const params = [];

    if (filters.rated) {
      let ratingCondition = ` AND id IN (SELECT DISTINCT item_id FROM ratings WHERE source = 'pexel-video' AND rating > 0`;
      
      if (filters.orientation && filters.orientation !== 'any') {
        ratingCondition += ` AND orientation = ?`;
        params.push(filters.orientation);
      }
      
      ratingCondition += `)`;
      query += ratingCondition;
    }

    if (filters.limit) {
      query += ` LIMIT ?`;
      params.push(filters.limit);
    }

    let results = await this.db.all(query, params);
    
    // Include local videos if rated filter is used and no-local is not specified
    if (filters.rated && !filters.noLocal) {
      const localVideos = await this.getLocalVideos(filters);
      results = results.concat(localVideos.map(v => ({ ...v, source: 'local' })));
    }

    return results;
  }

  async getDownloadedImages(filters = {}) {
    let query = `SELECT * FROM pexel_images WHERE downloaded != '[]' AND downloaded IS NOT NULL`;
    const params = [];

    if (filters.rated) {
      let ratingCondition = ` AND id IN (SELECT DISTINCT item_id FROM ratings WHERE source = 'pexel-image' AND rating > 0`;
      
      if (filters.orientation && filters.orientation !== 'any') {
        ratingCondition += ` AND orientation = ?`;
        params.push(filters.orientation);
      }
      
      ratingCondition += `)`;
      query += ratingCondition;
    }

    if (filters.limit) {
      query += ` LIMIT ?`;
      params.push(filters.limit);
    }

    let results = await this.db.all(query, params);
    
    // Include local images if rated filter is used and no-local is not specified
    if (filters.rated && !filters.noLocal) {
      const localImages = await this.getLocalImages(filters);
      results = results.concat(localImages.map(i => ({ ...i, source: 'local' })));
    }

    return results;
  }

  async close() {
    if (this.db) {
      await this.db.close();
    }
  }
}