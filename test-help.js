const { suite } = require("./test/suite");
const { runCli } = require("./src/cli");

const test = suite("test-help");

test("prints help", async () => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await runCli(["--help"]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});
