/**
 * One-command setup: bring up the required services, compile, then deploy.
 *
 *   npm run setup                     # local devnet
 *   npm run setup -- --network preprod
 */

import { spawnSync } from 'node:child_process';

import { resolveNetwork, setActiveNetwork, parseNetworkFlag } from './network.js';

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    process.stderr.write(`\nCommand failed: ${command} ${args.join(' ')}\n`);
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const argv = process.argv;
  const flag = parseNetworkFlag(argv);
  if (flag) setActiveNetwork(flag);
  const { network, config } = resolveNetwork({ argv });

  process.stdout.write(`\n→ Setting up SealedBid on: ${network}\n\n`);

  run('docker', ['compose', 'up', '-d', '--wait', ...config.composeServices]);
  run('npm', ['run', 'compile']);
  run('npm', ['run', 'deploy', ...(network === 'undeployed' ? [] : ['--', '--network', network])]);
}

try {
  main();
} catch (err) {
  process.stderr.write(`\nSetup failed: ${(err as Error).message}\n`);
  process.exit(1);
}
