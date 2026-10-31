import { modeOfKind } from '../Playlist.js';
import { readCpuSeconds, isSoftwareDecoder, isLargeVideo, RECENT_SAMPLES } from '../cpu.js';

// Failed IPC checks in a row before mpv is restarted
const HEALTH_FAILURES = 2;

// mpv health checks, CPU sampling and decoder recording for a Daemon (passed in), whose screens they visit.
export class Health {
  constructor(daemon) {
    this.daemon = daemon;
  }

  // Supervision otherwise only sees process exits; an mpv that stops answering IPC is killed,
  // and handleExit restarts it within the usual restart budget. A healthy mpv is also sampled for CPU use.
  async checkHealth() {
    await Promise.all([...this.daemon.screens.values()].map(async screen => {
      if (this.daemon.stopping || screen.checking || screen.child.exitCode !== null || screen.child.signalCode !== null) {
        return;
      }
      screen.checking = true;
      try {
        const pid = await screen.client.getProperty('pid');
        screen.healthFailures = 0;
        await this.sample(screen, pid);
      } catch (error) {
        screen.healthFailures = (screen.healthFailures ?? 0) + 1;
        this.daemon.logger.warn('mpv health check failed', { monitor: screen.monitor.name, failures: screen.healthFailures, error: error.message });
        if (screen.healthFailures >= HEALTH_FAILURES && !this.daemon.stopping) {
          this.daemon.logger.error('mpv is not responding, restarting', { monitor: screen.monitor.name });
          this.daemon.killGroup(screen.child, 'SIGKILL');
        }
      } finally {
        screen.checking = false;
      }
    }));
  }

  // Measures the CPU mpv used since the previous sample. The interval counts toward the playing item only
  // if that item played through all of it, so a switch never charges one item for another's decoding.
  async sample(screen, pid) {
    let cpu;
    try {
      cpu = await readCpuSeconds(pid, this.daemon.readFile);
    } catch (error) {
      this.daemon.logger.debug('Cannot read mpv CPU time', { monitor: screen.monitor.name, error: error.message });
      return;
    }
    const at = this.daemon.now();
    const last = screen.sample;
    screen.sample = { pid, cpu, at, media: screen.media };
    if (last?.pid === pid && at > last.at && cpu >= last.cpu) {
      const seconds = (at - last.at) / 1000;
      const cpuSeconds = cpu - last.cpu;
      screen.recent = [...(screen.recent ?? []), { seconds, cpuSeconds }].slice(-RECENT_SAMPLES);
      if (screen.media && screen.media === last.media && screen.loadedAt <= last.at) {
        try {
          this.daemon.database.addPlaybackSample(screen.media.id, seconds, cpuSeconds);
        } catch (error) {
          this.daemon.logger.warn('Failed to record playback cost', { mediaId: screen.media.id, error: error.message });
        }
      }
    }
    await this.recordDecoder(screen);
    await this.daemon.writeState().catch(error => this.daemon.logger.warn('Failed to write state', { error: error.message }));
  }

  // mpv reports the decoder only once a file is open, and observed properties only fire on changes,
  // so the decoder is read on each sample rather than on load
  async recordDecoder(screen) {
    const { media } = screen;
    if (!media || modeOfKind(media.kind) !== 'video') {
      screen.hwdec = null;
      return;
    }
    let hwdec;
    try {
      hwdec = await screen.client.getProperty('hwdec-current');
    } catch {
      return;
    }
    screen.hwdec = hwdec || 'no';
    try {
      this.daemon.database.setDecoder(media.id, screen.hwdec);
    } catch (error) {
      this.daemon.logger.warn('Failed to record decoder', { mediaId: media.id, error: error.message });
    }
    if (isSoftwareDecoder(hwdec) && isLargeVideo(media) && !this.daemon.softwareWarned.has(media.id)) {
      this.daemon.softwareWarned.add(media.id);
      this.daemon.logger.warn('Video above 1080p is decoded in software', {
        monitor: screen.monitor.name, mediaId: media.id, size: `${media.width}x${media.height}`, path: media.path
      });
    }
  }
}
