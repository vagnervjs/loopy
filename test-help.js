const { runCli } = require('./src/cli');

const originalStdoutWrite = process.stdout.write.bind(process.stdout);

async function main() {
  process.stdout.write = () => true;
  try {
    await runCli(['--help']);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
}

main().catch((e) => {
  process.stdout.write = originalStdoutWrite;
  console.error(e);
  process.exit(1);
});
