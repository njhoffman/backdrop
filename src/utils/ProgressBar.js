import chalk from "chalk";

export class ProgressBar {
  constructor(title, total = null) {
    this.title = title;
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
    this.lastUpdate = 0;
  }

  update(current, message = "") {
    this.current = current;
    const now = Date.now();

    // Throttle updates to avoid too frequent redraws
    if (now - this.lastUpdate < 100) return;
    this.lastUpdate = now;

    const elapsed = (now - this.startTime) / 1000;
    const rate = current / elapsed;

    let bar = "";
    if (this.total) {
      const percentage = Math.min(100, (current / this.total) * 100);
      const filled = Math.floor(percentage / 5);
      const empty = 20 - filled;
      bar = `[${"█".repeat(filled)}${" ".repeat(empty)}] ${percentage.toFixed(1)}%`;
    }

    const status = this.total ? `${current}/${this.total}` : `${current}`;

    const rateStr = rate > 0 ? ` (${rate.toFixed(1)}/s)` : "";

    process.stdout.write(
      `\r${chalk.cyan(this.title)}: ${bar} ${status}${rateStr} ${message}`,
    );
  }

  complete(message = "Complete") {
    process.stdout.write(`\r${chalk.green("✅ " + this.title)}: ${message}\n`);
  }
}
