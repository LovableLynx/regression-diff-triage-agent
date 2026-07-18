#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} file does not exist: ${filePath}`);
  }
}

function newmanInvocation() {
  const localNewmanCli = path.join(
    PROJECT_ROOT,
    'node_modules',
    'newman',
    'bin',
    'newman.js'
  );

  if (fs.existsSync(localNewmanCli)) {
    return { command: process.execPath, prefixArgs: [localNewmanCli] };
  }

  return {
    command: process.platform === 'win32' ? 'newman.cmd' : 'newman',
    prefixArgs: []
  };
}

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROJECT_ROOT, stdio: 'inherit' });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`${label} could not start because Newman is not installed. Run "npm install" first.`));
        return;
      }
      reject(new Error(`${label} could not start: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with exit code ${code}.`));
    });
  });
}

async function captureSnapshot(label, collectionPath, environmentPath, reportPath) {
  const args = [
    'run', collectionPath,
    '-e', environmentPath,
    '-r', 'json',
    '--reporter-json-export', reportPath
  ];

  try {
    const invocation = newmanInvocation();
    await runCommand(
      invocation.command,
      [...invocation.prefixArgs, ...args],
      `Newman ${label} snapshot`
    );
  } catch (error) {
    // Newman uses a non-zero exit code for failed assertions, even when it
    // successfully exports the JSON report needed for regression triage.
    if (fs.existsSync(reportPath)) {
      console.warn(`Newman ${label} snapshot finished with failures; using its exported report for triage.`);
      return;
    }
    throw new Error(`${error.message} No JSON report was produced; check the collection, environment, base URL, and network connection.`);
  }
}

function waitForEnter() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let answered = false;
    prompt.question('Before snapshot captured. Make your code change now, then press Enter to continue.\n', () => {
      answered = true;
      prompt.close();
      resolve();
    });
    prompt.on('close', () => {
      if (!answered) {
        reject(new Error('Input closed before continuing. Run this command from an interactive terminal and press Enter after your code change.'));
      }
    });
  });
}

async function main() {
  const [, , collectionArgument, environmentArgument] = process.argv;
  if (!collectionArgument || !environmentArgument) {
    throw new Error('Usage: npm run triage:run -- <collection.json> <environment.json>');
  }

  const collectionPath = path.resolve(collectionArgument);
  const environmentPath = path.resolve(environmentArgument);
  requireFile(collectionPath, 'Collection');
  requireFile(environmentPath, 'Environment');

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-triage-'));
  const beforeReport = path.join(tempDirectory, 'before.json');
  const afterReport = path.join(tempDirectory, 'after.json');

  try {
    console.log('Capturing before snapshot...');
    await captureSnapshot('before', collectionPath, environmentPath, beforeReport);
    await waitForEnter();

    console.log('Capturing after snapshot...');
    await captureSnapshot('after', collectionPath, environmentPath, afterReport);
    await runCommand(process.execPath, [path.join(__dirname, 'triage.js'), beforeReport, afterReport], 'Triage report');
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
