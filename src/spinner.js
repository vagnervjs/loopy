// Simple terminal spinner using Unicode characters

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII = ['-', '\\', '|', '/'];
const FRAME_INTERVAL = 80; // ms between frames

class Spinner {
  constructor(text = '', options = {}) {
    this.text = text;
    this.frameIndex = 0;
    this.intervalId = null;
    this.isSpinning = false;
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
    this.plain = Boolean(options.plain);
    this.noEmoji = Boolean(options.noEmoji) || this.plain;
  }

  shouldRender() {
    if (!this.enabled) return false;
    if (!process.stdout || !process.stdout.isTTY) return false;
    return true;
  }

  start(text) {
    if (!this.shouldRender()) {
      return;
    }
    if (this.isSpinning) {
      return;
    }

    if (text) {
      this.text = text;
    }

    this.isSpinning = true;
    this.frameIndex = 0;

    // Hide cursor
    process.stdout.write('\x1B[?25l');

    this.intervalId = setInterval(() => {
      this.render();
    }, FRAME_INTERVAL);

    this.render();
  }

  stop(finalText = '') {
    if (!this.isSpinning) {
      return;
    }
    if (!this.shouldRender()) {
      this.isSpinning = false;
      return;
    }

    this.isSpinning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Clear the line
    process.stdout.write('\r\x1B[K');

    if (finalText) {
      process.stdout.write(finalText + '\n');
    }

    // Show cursor
    process.stdout.write('\x1B[?25h');
  }

  render() {
    if (!this.isSpinning) {
      return;
    }

    const frames = this.noEmoji ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;
    const frame = frames[this.frameIndex];
    this.frameIndex = (this.frameIndex + 1) % frames.length;

    // Move to beginning of line, clear it, and write spinner + text
    process.stdout.write(`\r\x1B[K${frame} ${this.text}`);
  }

  updateText(text) {
    this.text = text;
    if (this.isSpinning) {
      this.render();
    }
  }
}

module.exports = { Spinner };
