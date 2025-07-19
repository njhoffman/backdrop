import { expect } from 'chai';
import sinon from 'sinon';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';

describe('DatabaseManager', () => {
  let dbManager;
  let tempDir;
  let dbPath;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pexels-db-test-'));
    dbPath = path.join(tempDir, 'test.db');
    dbManager = new DatabaseManager();
    await dbManager.initialize(dbPath);
  });

  afterEach(async () => {
    if (dbManager) {
      await dbManager.close();
    }
    await fs.remove(tempDir);
  });

  describe('initialization', () => {
    it('should create database file and tables', async () => {
      expect(await fs.pathExists(dbPath)).to.be.true;
      
      // Verify tables were created
      const tables = await dbManager.db.all(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `);
      
      const tableNames = tables.map(t => t.name);
      expect(tableNames).to.include.members(['search', 'pexel_videos', 'pexel_images', 'ratings', 'local_videos', 'local_images']);
    it('should filter downloaded videos by rating orientation', async () => {
      const searchId = await dbManager.addSearch('test search');
      
      // Add test videos
      const mockVideo1 = {
        id: 123,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video1',
        image: 'https://example.com/image1.jpg',
        duration: 30,
        user: { id: 456, url: 'https://example.com/user', name: 'Test User' },
        video_files: []
      };
      
      const mockVideo2 = {
        id: 124,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video2',
        image: 'https://example.com/image2.jpg',
        duration: 30,
        user: { id: 456, url: 'https://example.com/user', name: 'Test User' },
        video_files: []
      };

      await dbManager.addVideo(mockVideo1, searchId, 1);
      await dbManager.addVideo(mockVideo2, searchId, 2);
      
      // Mark as downloaded
      await dbManager.updateVideoDownloaded(123, [{ id: 789, quality: 'hd' }]);
      await dbManager.updateVideoDownloaded(124, [{ id: 790, quality: 'hd' }]);
      
      // Add ratings with different orientations
      await dbManager.addRating(123, 3, 'pexel-video', '1920x1080'); // landscape
      await dbManager.addRating(124, 2, 'pexel-video', '1080x1920'); // portrait
      
      // Test landscape filter
      const landscapeVideos = await dbManager.getDownloadedVideos({ 
        rated: true, 
        orientation: 'landscape' 
      });
      expect(landscapeVideos).to.have.length(1);
      expect(landscapeVideos[0].id).to.equal(123);
      
      // Test portrait filter
      const portraitVideos = await dbManager.getDownloadedVideos({ 
        rated: true, 
        orientation: 'portrait' 
      });
      expect(portraitVideos).to.have.length(1);
      expect(portraitVideos[0].id).to.equal(124);
      
      // Test any filter (should return both)
      const anyVideos = await dbManager.getDownloadedVideos({ 
        rated: true, 
        orientation: 'any' 
      });
      expect(anyVideos).to.have.length(2);
    });

  describe('search management', () => {
    it('should add search records', async () => {
      const searchId = await dbManager.addSearch('test keywords');
      
      expect(searchId).to.be.a('number');
      expect(searchId).to.be.greaterThan(0);
      
      const search = await dbManager.db.get('SELECT * FROM search WHERE id = ?', [searchId]);
      expect(search.keywords).to.equal('test keywords');
    });
  });

  describe('video management', () => {
    let searchId;
    
    beforeEach(async () => {
      searchId = await dbManager.addSearch('test search');
    });

    it('should add new video', async () => {
      const mockVideo = {
        id: 123,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video',
        image: 'https://example.com/image.jpg',
        duration: 30,
        user: {
          id: 456,
          url: 'https://example.com/user',
          name: 'Test User'
        },
        video_files: [
          {
            id: 789,
            quality: 'hd',
            file_type: 'video/mp4',
            width: 1920,
            height: 1080,
            link: 'https://example.com/video.mp4'
          }
        ]
      };

      const videoId = await dbManager.addVideo(mockVideo, searchId, 1);
      
      expect(videoId).to.equal(123);
      
      const video = await dbManager.getVideo(123);
      expect(video).to.not.be.null;
      expect(video.width).to.equal(1920);
      expect(video.user_name).to.equal('Test User');
    });

    it('should update existing video with new search info', async () => {
      const mockVideo = {
        id: 123,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video',
        image: 'https://example.com/image.jpg',
        duration: 30,
        user: {
          id: 456,
          url: 'https://example.com/user',
          name: 'Test User'
        },
        video_files: []
      };

      // Add video first time
      await dbManager.addVideo(mockVideo, searchId, 1);
      
      // Add same video with different search
      const newSearchId = await dbManager.addSearch('another search');
      await dbManager.addVideo(mockVideo, newSearchId, 2);
      
      const video = await dbManager.getVideo(123);
      const searches = JSON.parse(video.searches);
      
      expect(searches).to.have.length(2);
      expect(searches[0].search_id).to.equal(searchId);
      expect(searches[1].search_id).to.equal(newSearchId);
    });

    it('should get videos for download', async () => {
      const mockVideo = {
        id: 123,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video',
        image: 'https://example.com/image.jpg',
        duration: 30,
        user: { id: 456, url: 'https://example.com/user', name: 'Test User' },
        video_files: []
      };

      await dbManager.addVideo(mockVideo, searchId, 1);
      
      const videos = await dbManager.getVideosForDownload(10);
      expect(videos).to.have.length(1);
      expect(videos[0].id).to.equal(123);
    });

    it('should update video downloaded status', async () => {
      const mockVideo = {
        id: 123,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video',
        image: 'https://example.com/image.jpg',
        duration: 30,
        user: { id: 456, url: 'https://example.com/user', name: 'Test User' },
        video_files: []
      };

      await dbManager.addVideo(mockVideo, searchId, 1);
      
      const downloadedFiles = [{ id: 789, quality: 'hd' }];
      await dbManager.updateVideoDownloaded(123, downloadedFiles);
      
      const video = await dbManager.getVideo(123);
      const downloaded = JSON.parse(video.downloaded);
      
      expect(downloaded).to.deep.equal(downloadedFiles);
    });
  });

  describe('image management', () => {
    let searchId;
    
    beforeEach(async () => {
      searchId = await dbManager.addSearch('test search');
    });

    it('should add new image', async () => {
      const mockImage = {
        id: 456,
        width: 1920,
        height: 1080,
        url: 'https://example.com/image',
        photographer: 'Test Photographer',
        photographer_url: 'https://example.com/photographer',
        photographer_id: 789,
        avg_color: '#FF0000',
        alt: 'Test image',
        src: {
          original: 'https://example.com/original.jpg',
          large: 'https://example.com/large.jpg'
        }
      };

      const imageId = await dbManager.addImage(mockImage, searchId, 1);
      
      expect(imageId).to.equal(456);
      
      const image = await dbManager.getImage(456);
      expect(image).to.not.be.null;
      expect(image.photographer).to.equal('Test Photographer');
      expect(image.avg_color).to.equal('#FF0000');
    });
  });

  describe('rating management', () => {
    it('should add rating with orientation detection', async () => {
      const searchId = await dbManager.addSearch('test search');
      const mockVideo = {
        id: 123,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video',
        image: 'https://example.com/image.jpg',
        duration: 30,
        user: { id: 456, url: 'https://example.com/user', name: 'Test User' },
        video_files: []
      };

      await dbManager.addVideo(mockVideo, searchId, 1);
      
      // Test landscape orientation
      await dbManager.addRating(123, 3, 'pexel-video', '1920x1080');
      
      const landscapeRating = await dbManager.db.get('SELECT * FROM ratings WHERE item_id = ? AND resolution = ?', [123, '1920x1080']);
      expect(landscapeRating.rating).to.equal(3);
      expect(landscapeRating.orientation).to.equal('landscape');
      
      // Test portrait orientation
      await dbManager.addRating(123, 2, 'pexel-video', '1080x1920');
      
      const portraitRating = await dbManager.db.get('SELECT * FROM ratings WHERE item_id = ? AND resolution = ?', [123, '1080x1920']);
      expect(portraitRating.rating).to.equal(2);
      expect(portraitRating.orientation).to.equal('portrait');
    });

    it('should detect orientation correctly', () => {
      expect(dbManager.getOrientationFromResolution('1920x1080')).to.equal('landscape');
      expect(dbManager.getOrientationFromResolution('1080x1920')).to.equal('portrait');
      expect(dbManager.getOrientationFromResolution('1920x1920')).to.equal('landscape'); // square = landscape
      expect(dbManager.getOrientationFromResolution(null)).to.equal('landscape'); // default
      expect(dbManager.getOrientationFromResolution('invalid')).to.equal('landscape'); // invalid format
    });
  });

  describe('statistics', () => {
    it('should return correct statistics', async () => {
      const searchId = await dbManager.addSearch('test search');
      
      // Add some test data
      const mockVideo = {
        id: 123,
        width: 1920,
        height: 1080,
        url: 'https://example.com/video',
        image: 'https://example.com/image.jpg',
        duration: 30,
        user: { id: 456, url: 'https://example.com/user', name: 'Test User' },
        video_files: []
      };

      await dbManager.addVideo(mockVideo, searchId, 1);
      await dbManager.updateVideoDownloaded(123, [{ id: 789, quality: 'hd' }]);
      await dbManager.addRating(123, 3, 'pexel-video');
      
      const stats = await dbManager.getStats();
      
      expect(stats.totalVideos).to.equal(1);
      expect(stats.downloadedVideos).to.equal(1);
      expect(stats.ratedItems).to.equal(1);
      expect(stats.skippedItems).to.equal(0);
    });
  });
});