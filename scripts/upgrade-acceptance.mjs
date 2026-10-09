import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron, chromium } from 'playwright';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.join(root, 'artifacts');
const PRODUCT = 'docdiff-studio';
const MVP_SOURCE_COMMIT = '48fb1f3367c7f383c16d981d36cb19c5ad1abd84';
const MVP_PACKAGES = {
  'win32/x64': {
    bytes: 159242085,
    sha256: 'a7fe15312d7822454479d25d6f47c50c918ebee8804c311b571f85e7f5109f11',
    executable: { bytes: 246302208, sha256: '5ac4bb2b5cc7603244ae7510ae9322e696eb9ffad731fef063687bd757aaf49e' },
    appArchive: { bytes: 11355218, sha256: '24f599f5258384d33b7a2b3590b6b89add93447ee03a8bc32470863b3d3ab7b6' },
  },
  'linux/x64': {
    bytes: 125034782,
    sha256: '9a8ae5d8f10ccfc488cc20ef611a1ad9ab13132d85b42ba5959934f455f796ee',
    executable: { bytes: 228605256, sha256: '10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564' },
    appArchive: { bytes: 11355218, sha256: '4bdbf68240fac9e5ad8794248a54c871e1f216ad7430aea0ddec7b9c11761518' },
  },
};
const MAX_CHECKSUM_BYTES = 16 * 1024;
const MAX_FIXTURE_MANIFEST_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 300 * 1024 * 1024;
const MAX_APP_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 4 * 1024 * 1024;
const MAX_FIXTURE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_PROFILE_BYTES = 512 * 1024 * 1024;
const MAX_PROFILE_ENTRIES = 12000;
const OPERATION_TIMEOUT_MS = 120000;
const boundedListOverflow = new WeakMap();

function usage() {
  return [
    'Usage: node scripts/upgrade-acceptance.mjs',
    '  --old-package <verified 0.1.0 archive> --old-install-root <extracted 0.1.0 package>',
    '  --old-executable <path> --new-package <current CI archive> --new-install-root <extracted CI package>',
    '  --new-executable <path> --expected-source-commit <full git SHA> --sandbox true',
  ].join('\n');
}

function parseArgs(argv) {
  const allowed = new Set([
    '--old-package', '--old-install-root', '--old-executable', '--new-package', '--new-install-root',
    '--new-executable', '--expected-source-commit', '--sandbox',
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (!allowed.has(key) || values.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Invalid or repeated argument: ${key ?? '(missing)'}`);
    }
    values.set(key, argv[index + 1]);
    index += 1;
  }
  for (const key of allowed) assert.ok(values.has(key), `Missing ${key}.`);
  assert.equal(values.get('--sandbox'), 'true', 'Sandboxed launch is mandatory; pass --sandbox true.');
  return {
    oldPackage: values.get('--old-package'),
    oldInstallRoot: values.get('--old-install-root'),
    oldExecutable: values.get('--old-executable'),
    newPackage: values.get('--new-package'),
    newInstallRoot: values.get('--new-install-root'),
    newExecutable: values.get('--new-executable'),
    expectedSourceCommit: values.get('--expected-source-commit'),
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function createPublicRunDirectory() {
  const repositoryRoot = await realpath(root);
  const outputParent = await realpath(path.dirname(outputRoot));
  assert.ok(samePath(outputParent, repositoryRoot), 'The acceptance output parent must resolve to the repository root.');
  const candidate = path.resolve(outputParent, path.basename(outputRoot));
  assert.ok(isInside(repositoryRoot, candidate) && !samePath(repositoryRoot, candidate), 'The acceptance output directory must be a direct child of the repository root.');

  let outputInfo;
  try {
    outputInfo = await lstat(outputRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let containedOutputRoot;
  if (outputInfo) {
    assert.ok(outputInfo.isDirectory() && !outputInfo.isSymbolicLink(), 'The acceptance output path must be a real directory, not a link.');
    containedOutputRoot = await realpath(outputRoot);
    assert.ok(isInside(repositoryRoot, containedOutputRoot) && !samePath(repositoryRoot, containedOutputRoot), 'The acceptance output directory resolves outside the repository.');
  } else {
    await mkdir(candidate, { recursive: false });
    outputInfo = await lstat(candidate);
    assert.ok(outputInfo.isDirectory() && !outputInfo.isSymbolicLink(), 'The created acceptance output path must be a real directory.');
    containedOutputRoot = await realpath(candidate);
    assert.ok(isInside(repositoryRoot, containedOutputRoot) && !samePath(repositoryRoot, containedOutputRoot), 'The created acceptance output directory resolves outside the repository.');
  }

  const artifactRoot = await mkdtemp(path.join(containedOutputRoot, 'upgrade-'));
  const canonicalArtifactRoot = await realpath(artifactRoot);
  assert.ok(isInside(containedOutputRoot, canonicalArtifactRoot) && !samePath(containedOutputRoot, canonicalArtifactRoot), 'The run directory must remain inside the acceptance output directory.');
  return { repositoryRoot, outputRoot: containedOutputRoot, artifactRoot: canonicalArtifactRoot };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashBoundedFile(filePath, maximumBytes) {
  const before = await stat(filePath);
  assert.ok(before.isFile(), `Expected a regular file: ${path.basename(filePath)}`);
  assert.ok(before.size <= maximumBytes, `File exceeds the ${maximumBytes}-byte limit: ${path.basename(filePath)}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    assert.ok(bytes <= maximumBytes, `File grew past the ${maximumBytes}-byte limit: ${path.basename(filePath)}`);
    hash.update(chunk);
  }
  assert.equal(bytes, before.size, `File changed while being read: ${path.basename(filePath)}`);
  return { bytes, sha256: hash.digest('hex') };
}

async function containedRegularFile(input, label, maximumBytes, allowedRoot) {
  const allowedRealRoot = await realpath(allowedRoot);
  const resolved = await realpath(path.resolve(input));
  assert.ok(isInside(allowedRealRoot, resolved), `${label} must resolve inside its approved directory.`);
  const linkInfo = await lstat(path.resolve(input));
  assert.ok(!linkInfo.isSymbolicLink(), `${label} must not be a symbolic link.`);
  const info = await stat(resolved);
  assert.ok(info.isFile(), `${label} must be a regular file.`);
  assert.ok(info.size <= maximumBytes, `${label} exceeds its ${maximumBytes}-byte bound.`);
  return resolved;
}

async function validateInstallRoot(input, label) {
  const lexical = path.resolve(input);
  const info = await lstat(lexical);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} install root must be a real directory.`);
  return realpath(lexical);
}

function expectedArchiveName(version) {
  const platform = process.platform === 'win32' ? 'win' : 'linux';
  const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `${PRODUCT}-${version}-${platform}-x64.${extension}`;
}

async function validateVersions(args) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const newVersion = packageJson.version;
  assert.match(newVersion, semver, 'The current package version must be a complete semantic version.');
  assert.equal(Number(newVersion.split('.')[0]), 1, 'Portable upgrade acceptance requires a stable 1.x package.');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(args.expectedSourceCommit, /^[a-f0-9]{40}$/i, 'The expected source commit must be a full Git SHA-1.');
  assert.equal(sourceCommit.toLowerCase(), args.expectedSourceCommit.toLowerCase(), 'The checkout must match the source commit used for this package build.');
  const trackedChanges = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  const untrackedPaths = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  const packageInputs = ['src/', 'public/', 'dist/', 'dist-electron/', 'docs/', 'examples/', 'third_party/', 'package.json', 'LICENSE', 'THIRD_PARTY.md', 'README.md'];
  const untrackedPackageInputs = untrackedPaths.filter((item) => packageInputs.some((prefix) => item === prefix || item.startsWith(prefix))
    && item !== 'third_party/dependencies.json');
  assert.deepEqual(untrackedPackageInputs, [], 'The package tree contains untracked files not bound to a Git source commit.');
  const sourceDiff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return { oldVersion: '0.1.0', newVersion, sourceCommit, sourceDiffSha256: sha256(sourceDiff), trackedChanges, untrackedPaths };
}

async function validateNewPackageManifest(archivePath, version) {
  const releaseRoot = await realpath(path.join(root, 'release'));
  assert.ok(isInside(await realpath(root), releaseRoot) && !samePath(await realpath(root), releaseRoot), 'The release directory must be inside this checkout.');
  const expectedName = expectedArchiveName(version);
  assert.equal(path.basename(archivePath), expectedName, 'New package archive name/version does not match the checked-out package.');
  const manifestPath = await containedRegularFile(path.join(releaseRoot, 'SHA256SUMS.txt'), 'New package checksum manifest', MAX_CHECKSUM_BYTES, releaseRoot);
  const manifestText = await readFile(manifestPath, 'utf8');
  const matches = manifestText.split(/\r?\n/).filter((line) => line.endsWith(`  ${expectedName}`));
  assert.equal(matches.length, 1, 'The new package checksum manifest must contain one exact archive row.');
  const match = matches[0].match(/^([a-f0-9]{64})  ([^\r\n]+)$/i);
  assert.ok(match && match[2] === expectedName, 'The new package checksum row is malformed.');
  return match[1].toLowerCase();
}

async function validatePackageInputs(args, versions) {
  assert.equal(process.arch, 'x64', 'Only x64 portable packages are qualified.');
  assert.ok(['win32', 'linux'].includes(process.platform), 'Only Windows and Linux are qualified.');
  const platform = `${process.platform}/${process.arch}`;
  const oldExpected = MVP_PACKAGES[platform];
  assert.ok(oldExpected, 'No pinned MVP release archive exists for this platform.');

  const oldArchivePath = await containedRegularFile(args.oldPackage, 'Pinned MVP archive', MAX_PACKAGE_BYTES, root);
  const oldName = expectedArchiveName(versions.oldVersion);
  assert.equal(path.basename(oldArchivePath), oldName);
  const oldArchive = await hashBoundedFile(oldArchivePath, MAX_PACKAGE_BYTES);
  assert.equal(oldArchive.bytes, oldExpected.bytes, 'Pinned MVP archive byte count differs from the published release.');
  assert.equal(oldArchive.sha256, oldExpected.sha256, 'Pinned MVP archive digest differs from the published release.');

  const releaseRoot = await realpath(path.join(root, 'release'));
  const newArchivePath = await containedRegularFile(args.newPackage, 'Current CI archive', MAX_PACKAGE_BYTES, releaseRoot);
  const newName = expectedArchiveName(versions.newVersion);
  assert.equal(path.basename(newArchivePath), newName);
  const newExpectedSha256 = await validateNewPackageManifest(newArchivePath, versions.newVersion);
  const newArchive = await hashBoundedFile(newArchivePath, MAX_PACKAGE_BYTES);
  assert.equal(newArchive.sha256, newExpectedSha256, 'Current CI archive differs from its generated checksum manifest.');

  const oldInstallRoot = await validateInstallRoot(args.oldInstallRoot, 'Pinned MVP');
  const newInstallRoot = await validateInstallRoot(args.newInstallRoot, 'Current CI');
  assert.ok(!samePath(oldInstallRoot, newInstallRoot), 'The MVP and target packages must be extracted into separate install roots.');
  const executableName = process.platform === 'win32' ? 'DocDiff Studio.exe' : 'docdiff-studio';
  const oldExecutablePath = await containedRegularFile(args.oldExecutable, 'Pinned MVP executable', MAX_EXECUTABLE_BYTES, oldInstallRoot);
  const newExecutablePath = await containedRegularFile(args.newExecutable, 'Current CI executable', MAX_EXECUTABLE_BYTES, newInstallRoot);
  assert.equal(path.basename(oldExecutablePath), executableName);
  assert.equal(path.basename(newExecutablePath), executableName);
  const oldAppArchivePath = await containedRegularFile(path.join(path.dirname(oldExecutablePath), 'resources', 'app.asar'), 'Pinned MVP app.asar', MAX_APP_ARCHIVE_BYTES, oldInstallRoot);
  const newAppArchivePath = await containedRegularFile(path.join(path.dirname(newExecutablePath), 'resources', 'app.asar'), 'Current CI app.asar', MAX_APP_ARCHIVE_BYTES, newInstallRoot);
  const [oldExecutable, newExecutable, oldAppArchive, newAppArchive] = await Promise.all([
    hashBoundedFile(oldExecutablePath, MAX_EXECUTABLE_BYTES),
    hashBoundedFile(newExecutablePath, MAX_EXECUTABLE_BYTES),
    hashBoundedFile(oldAppArchivePath, MAX_APP_ARCHIVE_BYTES),
    hashBoundedFile(newAppArchivePath, MAX_APP_ARCHIVE_BYTES),
  ]);
  assert.equal(oldExecutable.bytes, oldExpected.executable.bytes, 'Extracted MVP executable size differs from the pinned archive member.');
  assert.equal(oldExecutable.sha256, oldExpected.executable.sha256, 'Extracted MVP executable differs from the pinned archive member.');
  assert.equal(oldAppArchive.bytes, oldExpected.appArchive.bytes, 'Extracted MVP app.asar size differs from the pinned archive member.');
  assert.equal(oldAppArchive.sha256, oldExpected.appArchive.sha256, 'Extracted MVP app.asar differs from the pinned archive member.');

  return {
    old: {
      label: 'old', version: versions.oldVersion, sourceCommit: MVP_SOURCE_COMMIT,
      provenance: 'pinned-public-mvp-release-asset', packageName: oldName,
      packageBytes: oldArchive.bytes, packageSha256: oldArchive.sha256,
      packagePath: oldArchivePath, installRoot: oldInstallRoot,
      executablePath: oldExecutablePath, executableBytes: oldExecutable.bytes, executableSha256: oldExecutable.sha256,
      appArchivePath: oldAppArchivePath, appArchiveBytes: oldAppArchive.bytes, appArchiveSha256: oldAppArchive.sha256,
    },
    target: {
      label: 'target', version: versions.newVersion, sourceCommit: versions.sourceCommit,
      provenance: 'local-ci-package-from-checked-out-commit', packageName: newName,
      packageBytes: newArchive.bytes, packageSha256: newArchive.sha256,
      packagePath: newArchivePath, installRoot: newInstallRoot,
      executablePath: newExecutablePath, executableBytes: newExecutable.bytes, executableSha256: newExecutable.sha256,
      appArchivePath: newAppArchivePath, appArchiveBytes: newAppArchive.bytes, appArchiveSha256: newAppArchive.sha256,
    },
  };
}

async function loadFixtureManifest(kind) {
  const manifestPath = kind === 'mvp'
    ? path.join(root, 'examples', 'corpus', 'manifest.json')
    : path.join(root, 'examples', 'v1', 'manifest.json');
  const manifestLinkInfo = await lstat(manifestPath);
  assert.ok(manifestLinkInfo.isFile() && !manifestLinkInfo.isSymbolicLink(), `${kind} fixture manifest must be a regular file.`);
  const manifestRealPath = await realpath(manifestPath);
  assert.ok(isInside(await realpath(path.join(root, 'examples')), manifestRealPath), `${kind} fixture manifest escaped the examples directory.`);
  const before = await stat(manifestPath);
  assert.ok(before.isFile() && before.size <= MAX_FIXTURE_MANIFEST_BYTES, `${kind} fixture manifest exceeds its byte bound.`);
  const bytes = await readFile(manifestPath);
  assert.ok(bytes.length <= MAX_FIXTURE_MANIFEST_BYTES, `${kind} fixture manifest is too large.`);
  assert.equal(bytes.length, before.size, `${kind} fixture manifest changed while being read.`);
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.ok(Array.isArray(manifest.files), `${kind} fixture manifest has no file inventory.`);
  return { manifest, manifestPath, manifestSha256: sha256(bytes) };
}

async function loadFixture(kind, name, manifest) {
  const entry = kind === 'mvp'
    ? manifest.files.find((item) => path.basename(item.file ?? '') === name)
    : manifest.files.find((item) => item.name === name);
  assert.ok(entry, `Fixture is not listed in the ${kind} manifest: ${name}`);
  const filePath = kind === 'mvp'
    ? path.join(root, 'examples', entry.file)
    : path.join(root, 'examples', 'v1', 'corpus', entry.name);
  const realPath = await realpath(filePath);
  assert.ok(isInside(path.join(root, 'examples'), realPath), `Fixture path escaped the examples directory: ${name}`);
  const info = await stat(realPath);
  assert.ok(info.isFile() && info.size <= MAX_FIXTURE_BYTES, `Fixture is not a bounded regular file: ${name}`);
  assert.equal(info.size, entry.bytes, `Fixture byte count differs from its manifest: ${name}`);
  const identity = await hashBoundedFile(realPath, MAX_FIXTURE_BYTES);
  assert.equal(identity.bytes, entry.bytes, `Fixture changed while being read: ${name}`);
  assert.equal(identity.sha256, entry.sha256.toLowerCase(), `Fixture digest differs from its manifest: ${name}`);
  return { name, path: realPath, bytes: identity.bytes, sha256: identity.sha256 };
}

async function hashProfileTree(profilePath) {
  let entries = 0;
  let bytes = 0;
  const pending = [profilePath];
  while (pending.length) {
    const current = pending.pop();
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      assert.ok(entries <= MAX_PROFILE_ENTRIES, 'Synthetic profile exceeded the bounded entry count.');
      const childPath = path.join(current, child.name);
      const info = await lstat(childPath);
      if (info.isDirectory()) pending.push(childPath);
      else if (info.isFile()) {
        bytes += info.size;
        assert.ok(bytes <= MAX_PROFILE_BYTES, 'Synthetic profile exceeded the bounded size.');
      } else {
        // Chromium may create lock symlinks; count their own metadata without following them.
        assert.ok(info.isSymbolicLink(), 'Synthetic profile contains an unsupported special file.');
        bytes += Buffer.byteLength(child.name);
      }
    }
  }
  return { entries, bytes };
}

function samePath(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function boundedPush(list, value, maximumItems = 300) {
  if (list.length < maximumItems) list.push(String(value).slice(0, 2000));
  else boundedListOverflow.set(list, (boundedListOverflow.get(list) ?? 0) + 1);
}

function assertOfflineRequests(requests, label, allowedProtocols = ['docdiff:', 'data:', 'blob:']) {
  assert.equal(boundedListOverflow.get(requests) ?? 0, 0, `${label} request log exceeded its bound; offline behavior cannot be confirmed.`);
  const unexpected = requests.filter((rawUrl) => {
    try { return !allowedProtocols.includes(new URL(rawUrl).protocol); }
    catch { return true; }
  });
  assert.deepEqual(unexpected, [], `${label} requested a non-local asset.`);
}

async function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
  assert.ok(child.exitCode !== null || child.signalCode !== null, `${label} Electron process did not exit after close.`);
}

async function closeApp(record) {
  if (!record || record.closed) return;
  const child = record.app.process();
  await record.app.close();
  await waitForExit(child, record.label);
  record.closed = true;
}

async function launchPackage(identity, profilePath, expectedMarker, errorList, consoleList, requestList, launchedApps) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DOC_DIFF_VITE_ORIGIN;
  const app = await _electron.launch({
    executablePath: identity.executablePath,
    args: [`--user-data-dir=${profilePath}`],
    env,
    chromiumSandbox: true,
    timeout: 60000,
  });
  const record = { label: identity.label, app, closed: false };
  launchedApps.push(record);
  const window = await app.firstWindow();
  window.on('pageerror', (error) => boundedPush(errorList, error.message));
  window.on('console', (message) => boundedPush(consoleList, `${message.type()}: ${message.text()}`));
  window.context().on('request', (request) => boundedPush(requestList, request.url(), 2000));

  await window.getByRole('button', { name: identity.label === 'old' ? 'Compare PDFs' : /Compare pair/ }).waitFor({ timeout: 60000 });
  await window.waitForFunction(() => document.readyState === 'complete', null, { timeout: 60000 });
  const security = await app.evaluate(({ BrowserWindow, app }) => {
    const currentWindow = BrowserWindow.getAllWindows()[0];
    const preferences = currentWindow.webContents.getLastWebPreferences();
    return {
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      url: currentWindow.webContents.getURL(),
      packaged: app.isPackaged,
      appVersion: app.getVersion(),
      appPath: app.getAppPath(),
      executablePath: process.execPath,
      userDataPath: app.getPath('userData'),
    };
  });
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  assert.equal(security.packaged, true);
  assert.equal(security.appVersion, identity.version);
  assert.equal(security.url, 'docdiff://app/index.html');
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  assert.ok(samePath(security.executablePath, identity.executablePath), `${identity.label} launched a different executable.`);
  assert.ok(samePath(security.userDataPath, profilePath), `${identity.label} did not use the isolated upgrade profile.`);

  const appArchivePath = await containedRegularFile(security.appPath, `${identity.label} app.asar`, MAX_APP_ARCHIVE_BYTES, identity.installRoot);
  assert.equal(path.basename(appArchivePath).toLowerCase(), 'app.asar');
  assert.ok(samePath(appArchivePath, identity.appArchivePath), `${identity.label} loaded a different app.asar than the archive extraction.`);
  const appArchiveIdentity = await hashBoundedFile(appArchivePath, MAX_APP_ARCHIVE_BYTES);
  assert.equal(appArchiveIdentity.sha256, identity.appArchiveSha256, `${identity.label} app.asar differs from the package proof.`);
  const executableIdentity = await hashBoundedFile(identity.executablePath, MAX_EXECUTABLE_BYTES);
  assert.equal(executableIdentity.sha256, identity.executableSha256);
  assertOfflineRequests(requestList, identity.label);

  if (expectedMarker !== null) {
    const marker = await app.evaluate(({ app }, markerName) => {
      const fs = process.getBuiltinModule('node:fs');
      const pathApi = process.getBuiltinModule('node:path');
      return fs.readFileSync(pathApi.join(app.getPath('userData'), markerName), 'utf8');
    }, 'docdiff-upgrade-profile-marker.txt');
    assert.equal(marker, expectedMarker, 'The target version did not retain the synthetic upgrade profile.');
  }
  record.window = window;
  record.security = security;
  record.appArchivePath = appArchivePath;
  identity.appArchivePath = appArchivePath;
  record.applicationFiles = [
    { path: identity.executablePath, expectedSha256: identity.executableSha256, maximumBytes: MAX_EXECUTABLE_BYTES },
    { path: appArchivePath, expectedSha256: identity.appArchiveSha256, maximumBytes: MAX_APP_ARCHIVE_BYTES },
  ];
  return record;
}

async function saveReport(record, reportsPath, filename, format, buttonName) {
  const outputPath = path.join(reportsPath, filename);
  assert.ok(isInside(reportsPath, outputPath));
  const beforeCount = await record.app.evaluate(() => globalThis.__docdiffUpgradeSaveCalls ?? 0);
  await record.app.evaluate(({ dialog }, filePath) => {
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async (...args) => {
      globalThis.__docdiffUpgradeSaveCalls = (globalThis.__docdiffUpgradeSaveCalls ?? 0) + 1;
      dialog.showSaveDialog = original;
      return { canceled: false, filePath };
    };
  }, outputPath);
  await record.window.getByRole('button', { name: buttonName, exact: true }).click();
  await record.window.getByText('Report saved.', { exact: true }).waitFor({ timeout: 60000 });
  const afterCount = await record.app.evaluate(() => globalThis.__docdiffUpgradeSaveCalls ?? 0);
  assert.equal(afterCount, beforeCount + 1, 'The actual report IPC must reach the private dialog destination.');
  const reportIdentity = await hashBoundedFile(outputPath, MAX_REPORT_BYTES);
  const bytes = await readFile(outputPath);
  assert.equal(bytes.length, reportIdentity.bytes);
  assert.equal(sha256(bytes), reportIdentity.sha256, 'Saved report changed while being read.');
  return { path: outputPath, bytes, sha256: reportIdentity.sha256, format };
}

async function clickCompareAndObserveWorker(page, buttonName, workerChunk) {
  const workerEvent = page.waitForEvent('worker', { timeout: 60000 });
  await page.getByRole('button', { name: buttonName }).click();
  const worker = await workerEvent;
  assert.ok(worker.url().includes(workerChunk), `Expected the actual ${workerChunk} comparison worker, received ${worker.url()}.`);
  return worker.url();
}

async function runOldPdfReview(record, fixtureFiles, reportsPath) {
  const page = record.window;
  await page.locator('#before-file').setInputFiles(fixtureFiles.oldBefore.path);
  await page.locator('#after-file').setInputFiles(fixtureFiles.oldAfter.path);
  const workerUrl = await clickCompareAndObserveWorker(page, 'Compare PDFs', 'compare.worker');
  await page.getByText('Differences found', { exact: true }).waitFor({ timeout: OPERATION_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.page-image')];
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
  }, null, { timeout: OPERATION_TIMEOUT_MS });
  assert.equal(await page.locator('.error-symbol').count(), 0);

  const json = await saveReport(record, reportsPath, 'mvp-review.json', 'json', 'Save JSON');
  const report = JSON.parse(json.bytes.toString('utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.summary.changed, 1);
  const changed = report.rows.find((row) => row.status === 'changed');
  assert.ok(changed, 'The MVP PDF worker did not return its changed page.');
  assert.ok(changed.beforeText.includes('Status: pending') && changed.beforeText.includes('Total: 128,750'));
  assert.ok(changed.afterText.includes('Status: approved') && changed.afterText.includes('Total: 182,750'));
  assert.ok(changed.changes.some((change) => change.kind === 'removed'));
  assert.ok(changed.changes.some((change) => change.kind === 'added'));
  assert.ok(changed.visual?.changedPixels > 0);

  const html = await saveReport(record, reportsPath, 'mvp-review.html', 'html', 'Save HTML');
  const htmlText = html.bytes.toString('utf8');
  assert.ok(!/<script\b/i.test(htmlText), 'The standalone report must not include executable script tags.');
  assert.ok(htmlText.includes('Status: pending') && htmlText.includes('Status: approved'));
  assert.ok(htmlText.includes('Total: 128,750') && htmlText.includes('Total: 182,750'));
  return { json, html, report, workerUrl };
}

async function runNewPdfReview(record, fixtureFiles, reportsPath) {
  const page = record.window;
  await page.getByLabel('Pair 1 before document', { exact: true }).setInputFiles(fixtureFiles.oldBefore.path);
  await page.getByLabel('Pair 1 after document', { exact: true }).setInputFiles(fixtureFiles.oldAfter.path);
  const workerUrl = await clickCompareAndObserveWorker(page, /Compare pair/, 'compare-v2.worker');
  await page.locator('section[aria-label="Pair 1"] .pair-done').waitFor({ timeout: OPERATION_TIMEOUT_MS });
  const json = await saveReport(record, reportsPath, 'upgrade-pdf.json', 'json', 'Save batch JSON');
  const result = JSON.parse(json.bytes.toString('utf8'));
  assert.equal(result.schemaVersion, 2);
  assert.ok(!result.reportKind, 'A single selected pair must export a direct schema-2 result.');
  assert.equal(result.documents.before.format, 'pdf');
  assert.equal(result.summary.changed, 1);
  const changed = result.rows.find((row) => row.status === 'changed');
  assert.ok(changed?.visual?.changedPixels > 0);
  assert.ok(changed.beforeText.includes('Status: pending') && changed.afterText.includes('Status: approved'));
  const html = await saveReport(record, reportsPath, 'upgrade-pdf.html', 'html', 'Save selected HTML');
  const htmlText = html.bytes.toString('utf8');
  assert.ok(!/<script\b/i.test(htmlText), 'The target PDF report must not include executable script tags.');
  assert.ok(htmlText.includes('Status: pending') && htmlText.includes('Status: approved'));
  assert.ok(htmlText.includes('Total: 128,750') && htmlText.includes('Total: 182,750'));
  return { json, html, result, workerUrl };
}

async function runNewDocxReview(record, fixtureFiles, reportsPath) {
  const page = record.window;
  await page.getByLabel('Pair 1 before document', { exact: true }).setInputFiles(fixtureFiles.docxBefore.path);
  await page.getByLabel('Pair 1 after document', { exact: true }).setInputFiles(fixtureFiles.docxAfter.path);
  const workerUrl = await clickCompareAndObserveWorker(page, /Compare pair/, 'compare-v2.worker');
  await page.locator('section[aria-label="Pair 1"] .pair-done').waitFor({ timeout: OPERATION_TIMEOUT_MS });
  const json = await saveReport(record, reportsPath, 'upgrade-docx.json', 'json', 'Save batch JSON');
  const result = JSON.parse(json.bytes.toString('utf8'));
  assert.equal(result.schemaVersion, 2);
  assert.ok(!result.reportKind, 'A single selected pair must export a direct schema-2 result.');
  assert.equal(result.documents.before.format, 'docx');
  assert.equal(result.documents.before.unitKind, 'docx-block');
  assert.equal(result.outcome, 'changed');
  assert.ok(result.rows.some((row) => row.beforeText.includes('1250') && row.afterText.includes('1350')));
  assert.ok(result.rows.some((row) => row.cellChanges?.some((cell) => cell.changes.some((change) => change.kind === 'added' || change.kind === 'removed'))));
  assert.ok(result.rows.every((row) => !row.beforeImageDataUrl && !row.afterImageDataUrl));
  const html = await saveReport(record, reportsPath, 'upgrade-docx.html', 'html', 'Save selected HTML');
  const htmlText = html.bytes.toString('utf8');
  assert.ok(!/<script\b/i.test(htmlText), 'The target DOCX report must not include executable script tags.');
  assert.ok(htmlText.includes('1250') && htmlText.includes('1350'));
  return { json, html, result, workerUrl };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { artifactRoot } = await createPublicRunDirectory();
  const profilePath = path.join(artifactRoot, 'synthetic-profile');
  const reportsPath = artifactRoot;

  const startedAt = new Date().toISOString();
  const steps = [];
  const errors = [];
  const consoleMessages = [];
  const applicationRequests = [];
  const observations = {};
  const evidence = { schemaVersion: 1, suite: 'portable-upgrade-v1', status: 'failed', startedAt };
  let versions = null;
  let oldRecord = null;
  let newRecord = null;
  let browser = null;
  let browserContext = null;
  let reportPage = null;
  let activePage = null;
  let markerToken = null;
  let profileSummary = null;
  let fixtureBefore = new Map();
  const launchedApps = [];
  const cleanupErrors = [];

  try {
    assert.equal(await lstat(profilePath).then(() => true, () => false), false, 'The unique synthetic profile must start absent.');
    versions = await validateVersions(args);
    const { old: oldIdentity, target: newIdentity } = await validatePackageInputs(args, versions);
    assert.notEqual(oldIdentity.packageSha256, newIdentity.packageSha256, 'Pinned MVP and current CI package archives must be distinct.');
    steps.push('pinned MVP release archive and current CI package/source identities bound');

    const [oldManifest, newManifest] = await Promise.all([loadFixtureManifest('mvp'), loadFixtureManifest('v1')]);
    const fixtureFiles = {
      oldBefore: await loadFixture('mvp', 'word-number-before.pdf', oldManifest.manifest),
      oldAfter: await loadFixture('mvp', 'word-number-after.pdf', oldManifest.manifest),
      docxBefore: await loadFixture('v1', 'docx-change-before.docx', newManifest.manifest),
      docxAfter: await loadFixture('v1', 'docx-change-after.docx', newManifest.manifest),
    };
    const fixtureBytes = Object.values(fixtureFiles).reduce((sum, entry) => sum + entry.bytes, 0);
    assert.ok(fixtureBytes <= MAX_FIXTURE_TOTAL_BYTES, 'Upgrade fixture inputs exceed the aggregate bound.');
    fixtureBefore = new Map(Object.values(fixtureFiles).map((entry) => [entry.path, entry.sha256]));
    fixtureBefore.set(oldManifest.manifestPath, oldManifest.manifestSha256);
    fixtureBefore.set(newManifest.manifestPath, newManifest.manifestSha256);

    const oldPackageBefore = await hashBoundedFile(oldIdentity.packagePath, MAX_PACKAGE_BYTES);
    markerToken = randomUUID();
    oldRecord = await launchPackage(oldIdentity, profilePath, null, errors, consoleMessages, applicationRequests, launchedApps);
    activePage = oldRecord.window;
    steps.push('released 0.1.0 starts in a new isolated profile with renderer sandbox');

    const oldReports = await runOldPdfReview(oldRecord, fixtureFiles, reportsPath);
    steps.push('MVP dedicated PDF worker comparison and actual schema-1 HTML/JSON save IPC');

    await oldRecord.app.evaluate(({ app }, token) => {
      const fs = process.getBuiltinModule('node:fs');
      const pathApi = process.getBuiltinModule('node:path');
      const userData = app.getPath('userData');
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(pathApi.join(userData, 'docdiff-upgrade-profile-marker.txt'), token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }, markerToken);
    await closeApp(oldRecord);
    oldRecord = null;
    activePage = null;
    const oldExeAfter = await hashBoundedFile(oldIdentity.executablePath, MAX_EXECUTABLE_BYTES);
    assert.equal(oldExeAfter.sha256, oldIdentity.executableSha256);
    const oldArchiveAfter = await hashBoundedFile(oldIdentity.packagePath, MAX_PACKAGE_BYTES);
    assert.deepEqual(oldArchiveAfter, oldPackageBefore, 'Old portable package archive changed during the review.');
    steps.push('MVP process closes and its package/executable bytes remain unchanged');

    newRecord = await launchPackage(newIdentity, profilePath, markerToken, errors, consoleMessages, applicationRequests, launchedApps);
    activePage = newRecord.window;
    steps.push('stable 1.x starts with the same synthetic profile and preserves its marker');

    const newPdf = await runNewPdfReview(newRecord, fixtureFiles, reportsPath);
    steps.push('upgraded dedicated PDF worker comparison and direct schema-2 JSON save IPC');
    const newDocx = await runNewDocxReview(newRecord, fixtureFiles, reportsPath);
    steps.push('upgraded dedicated DOCX worker comparison and direct schema-2 JSON save IPC');

    const profileUsage = await hashProfileTree(profilePath);
    profileSummary = { uniqueSyntheticProfile: true, samePathAcrossVersions: true, markerPreserved: true, ...profileUsage };
    await closeApp(newRecord);
    newRecord = null;
    activePage = null;

    browser = await chromium.launch({ chromiumSandbox: true, timeout: 60000 });
    browserContext = await browser.newContext();
    const browserRequests = [];
    browserContext.on('request', (request) => boundedPush(browserRequests, request.url(), 500));
    reportPage = await browserContext.newPage();
    activePage = reportPage;
    await reportPage.goto(pathToFileURL(oldReports.html.path).href, { waitUntil: 'load', timeout: 60000 });
    await reportPage.getByRole('heading', { name: 'DocDiff Studio comparison' }).waitFor({ timeout: 30000 });
    await reportPage.waitForFunction(() => {
      const images = [...document.images];
      return images.length >= 2 && images.every((image) => image.complete && image.naturalWidth > 0);
    }, null, { timeout: 60000 });
    const oldHtmlBody = await reportPage.locator('body').innerText();
    for (const text of ['Status: pending', 'Status: approved', 'Total: 128,750', 'Total: 182,750']) {
      assert.ok(oldHtmlBody.includes(text), `Standalone MVP report lost expected text: ${text}`);
    }
    assert.equal(await reportPage.evaluate(() => location.protocol), 'file:');
    assertOfflineRequests(browserRequests, 'standalone MVP HTML', ['file:', 'data:', 'blob:']);
    steps.push('saved MVP standalone HTML reopens in Chromium with source text and both page images');

    assert.deepEqual(errors, [], 'Neither version may emit a renderer page error.');
    assertOfflineRequests(applicationRequests, 'Electron applications');
    for (const [filePath, expectedHash] of fixtureBefore) {
      const info = await hashBoundedFile(filePath, filePath.endsWith('.json') ? MAX_FIXTURE_MANIFEST_BYTES : MAX_FIXTURE_BYTES);
      assert.equal(info.sha256, expectedHash, `Input/source bytes changed during acceptance: ${path.basename(filePath)}`);
    }
    for (const identity of [oldIdentity, newIdentity]) {
      const executable = await hashBoundedFile(identity.executablePath, MAX_EXECUTABLE_BYTES);
      assert.equal(executable.sha256, identity.executableSha256, `${identity.label} executable changed during acceptance.`);
      assert.ok(identity.appArchivePath, `${identity.label} app.asar path was not observed.`);
      const asar = await hashBoundedFile(identity.appArchivePath, MAX_APP_ARCHIVE_BYTES);
      assert.equal(asar.sha256, identity.appArchiveSha256, `${identity.label} app.asar changed during acceptance.`);
      const archive = await hashBoundedFile(identity.packagePath, MAX_PACKAGE_BYTES);
      assert.equal(archive.sha256, identity.packageSha256, `${identity.label} outer package changed during acceptance.`);
    }
    const reportIdentities = {};
    for (const report of [oldReports.json, oldReports.html, newPdf.json, newPdf.html, newDocx.json, newDocx.html]) {
      assert.ok(samePath(path.dirname(report.path), artifactRoot), `Retained report must be a sibling of upgrade.json: ${path.basename(report.path)}`);
      const after = await hashBoundedFile(report.path, MAX_REPORT_BYTES);
      assert.equal(after.sha256, report.sha256, 'Saved report bytes changed after export.');
      reportIdentities[path.basename(report.path)] = { bytes: after.bytes, sha256: after.sha256 };
    }
    steps.push('fixture/source files, both package executables and app archives, and saved reports remain unchanged');

    evidence.status = 'passed';
    evidence.finishedAt = new Date().toISOString();
    evidence.platform = `${process.platform}/${process.arch}`;
    evidence.host = { osRelease: os.release(), osVersion: os.version(), cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length };
    evidence.expectedVersions = { old: versions.oldVersion, target: versions.newVersion };
    evidence.source = {
      commit: versions.sourceCommit,
      provenance: 'CI package built from this checkout; tracked worktree diff is separately hashed',
      trackedDiffSha256: versions.sourceDiffSha256,
      trackedChanges: versions.trackedChanges,
      untrackedPaths: versions.untrackedPaths,
    };
    evidence.corpora = {
      mvpManifest: { name: path.basename(oldManifest.manifestPath), sha256: oldManifest.manifestSha256 },
      v1Manifest: { name: path.basename(newManifest.manifestPath), sha256: newManifest.manifestSha256 },
      files: Object.fromEntries(Object.values(fixtureFiles).map((entry) => [entry.name, { bytes: entry.bytes, sha256: entry.sha256 }])),
    };
    evidence.packages = { old: summarizeIdentity(oldIdentity), target: summarizeIdentity(newIdentity) };
    evidence.profile = { ...profileSummary, removedAfterRun: true };
    evidence.reports = {
      mvpJson: { schemaVersion: 1, ...reportIdentities['mvp-review.json'] },
      mvpHtml: { standaloneReopened: true, imagesLoaded: await reportPage.locator('img').count(), ...reportIdentities['mvp-review.html'] },
      upgradedPdfJson: { schemaVersion: 2, outcome: newPdf.result.outcome, ...reportIdentities['upgrade-pdf.json'] },
      upgradedPdfHtml: { schemaVersion: 2, ...reportIdentities['upgrade-pdf.html'] },
      upgradedDocxJson: { schemaVersion: 2, outcome: newDocx.result.outcome, ...reportIdentities['upgrade-docx.json'] },
      upgradedDocxHtml: { schemaVersion: 2, ...reportIdentities['upgrade-docx.html'] },
    };
    evidence.workerChunks = { mvpPdf: oldReports.workerUrl, upgradedPdf: newPdf.workerUrl, upgradedDocx: newDocx.workerUrl };
    evidence.security = {
      old: { sandbox: true, contextIsolation: true, nodeIntegration: false, packaged: true, appVersion: oldIdentity.version, origin: 'docdiff://app/index.html' },
      target: { sandbox: true, contextIsolation: true, nodeIntegration: false, packaged: true, appVersion: newIdentity.version, origin: 'docdiff://app/index.html' },
      chromiumSandboxRequested: true,
      unexpectedNetworkRequests: 0,
    };
    evidence.steps = steps;
    evidence.sourceInputsUnchanged = true;
    evidence.applicationBytesUnchanged = true;
    await writeFile(path.join(artifactRoot, 'upgrade.json'), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    let visibleState = '';
    if (activePage) {
      try {
        visibleState = (await activePage.locator('body').innerText()).slice(0, 8000);
        await activePage.screenshot({ path: path.join(artifactRoot, 'failure.png'), fullPage: true, timeout: 15000 });
      } catch {}
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.steps = steps;
    evidence.message = String(error).slice(0, 4000);
    evidence.errors = errors;
    evidence.consoleMessages = consoleMessages;
    evidence.applicationRequests = applicationRequests;
    evidence.visibleState = visibleState;
    await writeFile(path.join(artifactRoot, 'failure.json'), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(() => undefined);
    console.error(JSON.stringify({ status: 'failed', artifact: artifactRoot, message: String(error).slice(0, 1000) }));
    process.exitCode = 1;
  } finally {
    for (const record of [...launchedApps].reverse()) {
      try { await closeApp(record); }
      catch (error) { cleanupErrors.push(`${record.label} Electron process: ${String(error).slice(0, 500)}`); }
    }
    if (browserContext) {
      try { await browserContext.close(); }
      catch (error) { cleanupErrors.push(`Standalone report browser context: ${String(error).slice(0, 500)}`); }
    }
    if (browser) {
      try { await browser.close(); }
      catch (error) { cleanupErrors.push(`Standalone report browser: ${String(error).slice(0, 500)}`); }
    }
    try {
      const profileParent = await realpath(artifactRoot);
      const profileInfo = await lstat(profilePath).catch(() => null);
      if (profileInfo) {
        assert.ok(!profileInfo.isSymbolicLink(), 'Synthetic profile unexpectedly became a symbolic link.');
        const profileRealPath = await realpath(profilePath);
        assert.ok(isInside(profileParent, profileRealPath) && profileRealPath !== profileParent, 'Refusing to remove a profile outside this acceptance run.');
        await rm(profileRealPath, { recursive: true, force: true });
      }
      const profileRemoved = await lstat(profilePath).then(() => false, () => true);
      if (evidence.status === 'passed') {
        assert.ok(profileRemoved, 'Synthetic profile cleanup did not complete.');
        const evidencePath = path.join(artifactRoot, 'upgrade.json');
        const saved = JSON.parse((await readFile(evidencePath, 'utf8')));
        saved.profile.removedAfterRun = profileRemoved;
        await writeFile(evidencePath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      }
    } catch (cleanupError) {
      cleanupErrors.push(`Synthetic profile cleanup: ${String(cleanupError).slice(0, 500)}`);
    }
    if (cleanupErrors.length) {
      process.exitCode = 1;
      const cleanupFailure = cleanupErrors.join('; ').slice(0, 2000);
      const acceptancePath = path.join(artifactRoot, 'upgrade.json');
      if (evidence.status === 'passed') {
        evidence.status = 'failed';
        evidence.message = `Cleanup did not complete: ${cleanupFailure}`;
        await rm(acceptancePath, { force: true }).catch(() => undefined);
        await writeFile(path.join(artifactRoot, 'failure.json'), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(() => undefined);
      } else {
        const failurePath = path.join(artifactRoot, 'failure.json');
        try {
          const failure = JSON.parse(await readFile(failurePath, 'utf8'));
          failure.cleanupErrors = cleanupErrors;
          await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch {}
      }
      console.error(JSON.stringify({ status: 'failed', artifact: artifactRoot, cleanupErrors }));
    } else if (evidence.status === 'passed') {
      console.log(JSON.stringify({ status: 'passed', artifact: artifactRoot, steps: steps.length }));
    }
  }
}

function summarizeIdentity(identity) {
  return {
    provenance: identity.provenance,
    version: identity.version,
    sourceCommit: identity.sourceCommit,
    packageName: identity.packageName,
    packageBytes: identity.packageBytes,
    packageSha256: identity.packageSha256,
    executableBytes: identity.executableBytes,
    executableSha256: identity.executableSha256,
    appArchiveBytes: identity.appArchiveBytes,
    appArchiveSha256: identity.appArchiveSha256,
  };
}

await main();
