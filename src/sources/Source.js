// Sources return database-ready media and {url, width, height, mime} download variants.
// Credentials and API-specific response shapes stay inside the adapter.
export class Source {
  constructor(name) {
    this.name = name;
    this.rateLimit = null;
  }

  async search(params) { throw new Error(`${this.name}: search is not implemented`); }
  async metadata(kind, id) { throw new Error(`${this.name}: metadata is not implemented`); }
  async downloadVariants(media) { return media.variants; }
}

export class SourceError extends Error {
  constructor(message, { status, retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
