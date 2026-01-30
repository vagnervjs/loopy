// Simple terminal spinner using Unicode characters

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL = 80; // ms between frames

class Spinner {
  constructor(text = '') {
    this.text = text;
    this.frameIndex = 0;
    this.intervalId = null;
    this.isSpinning = false;
  }

  start(text) {
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

    const frame = SPINNER_FRAMES[this.frameIndex];
    this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;

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
