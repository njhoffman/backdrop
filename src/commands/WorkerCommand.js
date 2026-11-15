import { hello, runWorker } from '../offload/worker.js';
import { setJsonOutput } from '../utils/output.js';

// `backdrop worker` (hidden): encodes for a daemon on another machine, which runs it over SSH
// (src/offload/RemoteEncoder.js). stdout carries only the protocol's JSON lines; everything else goes to stderr.
export class WorkerCommand {
  constructor(config, database, logger, { version, input = process.stdin, output = process.stdout, run = runWorker } = {}) {
    this.config = config;
    this.logger = logger;
    this.version = version;
    this.input = input;
    this.output = output;
    this.runWorker = run;
  }

  async run(options = {}) {
    setJsonOutput(true);
    const config = this.config.get();
    if (options.hello) {
      this.output.write(`${JSON.stringify(hello(config, { version: this.version }))}\n`);
      return 0;
    }
    const code = await this.runWorker({ config, input: this.input, output: this.output, logger: this.logger });
    // An open stdin (the client's heartbeats) would keep the process alive after the job
    this.input.destroy?.();
    if (code) process.exitCode = code;
    return code;
  }
}
