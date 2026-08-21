// src/utils/logger.js
// Structured logging with timing markers for demo visibility

class Logger {
  constructor(prefix = "SRE-AGENT") {
    this.prefix = prefix;
    this.startTime = Date.now();
  }

  _elapsed() {
    return ((Date.now() - this.startTime) / 1000).toFixed(1);
  }

  _format(level, msg) {
    return `[${this._elapsed()}s] [${level}] ${this.prefix}: ${msg}`;
  }

  info(msg)  { console.log(this._format("INFO", msg)); }
  ok(msg)    { console.log(this._format(" OK ", `✓ ${msg}`)); }
  warn(msg)  { console.warn(this._format("WARN", `⚠ ${msg}`)); }
  error(msg) { console.error(this._format("ERR ", `✗ ${msg}`)); }

  step(num, msg) {
    console.log(`\n${"═".repeat(55)}`);
    console.log(`  STEP ${num}: ${msg}`);
    console.log(`${"═".repeat(55)}`);
  }

  banner(msg) {
    const line = "═".repeat(55);
    console.log(`\n${line}`);
    console.log(`  ${msg}`);
    console.log(`${line}\n`);
  }

  timer(label) {
    const start = Date.now();
    return {
      stop: () => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        this.ok(`${label} completed in ${elapsed}s`);
        return parseFloat(elapsed);
      }
    };
  }
}

module.exports = { Logger };
