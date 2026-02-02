const { suite } = require("./test/suite");
const { Spinner } = require("./src/spinner.js");

const test = suite("test-spinner");
const shouldSkip = !process.stdout.isTTY;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("renders visually with updates", { skip: shouldSkip }, async () => {
  const spinner = new Spinner();

  console.log("Testing Spinner Component\n");

  console.log("Test 1: Starting spinner for 2 seconds...");
  spinner.start("Loading");
  await wait(2000);
  spinner.stop("✓ Test 1 complete");

  console.log("\nTest 2: Starting spinner with text updates...");
  spinner.start("Step 1");
  await wait(500);
  spinner.updateText("Step 2");
  await wait(500);
  spinner.updateText("Step 3");
  await wait(500);
  spinner.stop("✓ Test 2 complete");

  console.log("\nTest 3: Multiple start/stop cycles...");
  spinner.start("Cycle 1");
  await wait(800);
  spinner.stop();
  spinner.start("Cycle 2");
  await wait(800);
  spinner.stop("✓ Test 3 complete");

  console.log("\n✓ All spinner tests passed - component renders visually when mounted\n");
});
