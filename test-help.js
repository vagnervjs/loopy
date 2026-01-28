const { runCli } = require('./src/cli');

runCli(['--help']).catch(e => {
  console.error(e);
  process.exit(1);
});
