import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const bash =
  process.env.AAH_TEST_BASH ||
  (process.platform === "win32"
    ? ["D:/Git/bin/bash.exe", "C:/Program Files/Git/bin/bash.exe"].find(
        existsSync,
      )
    : "bash")
const available =
  bash &&
  spawnSync(bash, ["--version"]).status === 0 &&
  spawnSync("git", ["--version"]).status === 0
const posix = (value) =>
  value
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)

function command(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "aah-updater-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const checkout = path.join(dir, "checkout")
  const upstream = path.join(dir, "upstream")
  const bin = path.join(dir, "bin")
  mkdirSync(checkout)
  mkdirSync(bin)
  for (const folder of ["deploy", "web/server"])
    mkdirSync(path.join(checkout, folder), { recursive: true })
  for (const name of ["update.sh", "compose.sh", "upstream.json"])
    copyFileSync(
      path.join(root, "deploy", name),
      path.join(checkout, "deploy", name),
    )
  writeFileSync(path.join(checkout, ".gitignore"), ".env.web\n.deploy/\n")
  writeFileSync(
    path.join(checkout, ".env.web"),
    "ADMIN_PASSWORD=test-only\nENCRYPTION_KEY=test-only\n",
  )
  writeFileSync(path.join(checkout, "web/server/index.mjs"), "export {};\n")
  writeFileSync(path.join(checkout, "web/package.json"), '{"name":"fixture"}\n')
  writeFileSync(path.join(checkout, "web/package-lock.json"), "{}\n")
  command(checkout, "init", "-b", "main")
  command(checkout, "config", "user.name", "Updater test")
  command(checkout, "config", "user.email", "updater-test@localhost")
  command(checkout, "add", ".")
  command(
    checkout,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "baseline",
  )
  const base = command(checkout, "rev-parse", "HEAD")
  command(dir, "clone", checkout, upstream)
  command(upstream, "config", "user.name", "Updater test")
  command(upstream, "config", "user.email", "updater-test@localhost")
  writeFileSync(path.join(upstream, "upstream.txt"), "new upstream feature\n")
  command(upstream, "add", ".")
  command(
    upstream,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "upstream change",
  )
  command(
    checkout,
    "config",
    `url.${upstream.replaceAll("\\", "/")}.insteadOf`,
    "https://github.com/2010384626/all-api-hub.git",
  )
  const docker = `#!/usr/bin/env bash
set -eu
printf '%s|%s\\n' "\${AAH_IMAGE:-default}" "$*" >> "$AAH_DOCKER_LOG"
case "$1" in
  build) [[ "\${AAH_TEST_FAIL:-}" != build ]] || exit 31 ;;
  compose)
    if [[ " $* " = *' ps -q app '* ]]; then echo fixture-container; fi
    if [[ " $* " = *' up -d '* ]]; then printf '%s' "\${AAH_IMAGE:-default}" > "$AAH_ACTIVE_IMAGE"; fi
    ;;
  inspect)
    if [[ "$*" = *'.Image'* ]]; then echo sha256:previous-image
    elif [[ "$*" = *'.Mounts'* ]]; then echo all-api-hub-web-data
    elif [[ ( "\${AAH_TEST_FAIL:-}" = health || "\${AAH_TEST_FAIL:-}" = restore ) && -f "$AAH_ACTIVE_IMAGE" && "$(cat "$AAH_ACTIVE_IMAGE")" = all-api-hub-web:* ]]; then echo unhealthy
    else echo healthy; fi
    ;;
  run)
    if [[ "$*" = *'tar -C /data -czf'* && "\${AAH_TEST_FAIL:-}" = backup ]]; then exit 32; fi
    if [[ "$*" = *'tar -C /data -xzf'* && "\${AAH_TEST_FAIL:-}" = restore ]]; then exit 33; fi
    ;;
esac
`
  writeFileSync(path.join(bin, "docker"), docker)
  chmodSync(path.join(bin, "docker"), 0o755)
  const log = path.join(dir, "docker.log")
  const active = path.join(dir, "active-image")
  function run(failure = "", args = []) {
    return spawnSync(
      bash,
      [posix(path.join(checkout, "deploy/update.sh")), ...args],
      {
        cwd: checkout,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          AAH_DOCKER_LOG: posix(log),
          AAH_ACTIVE_IMAGE: posix(active),
          AAH_TEST_FAIL: failure,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    )
  }
  return {
    checkout,
    upstream,
    base,
    run,
    logs: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
  }
}

test(
  "updater refuses uncommitted changes before contacting Docker",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    writeFileSync(path.join(f.checkout, "local.txt"), "keep me")
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Commit or stash/)
    assert.equal(f.logs(), "")
    assert.equal(
      readFileSync(path.join(f.checkout, "local.txt"), "utf8"),
      "keep me",
    )
  },
)

test(
  "updater leaves live service and checkout untouched on merge conflict",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const file = "web/server/index.mjs"
    for (const [cwd, text] of [
      [f.checkout, "local customization"],
      [f.upstream, "upstream rewrite"],
    ]) {
      writeFileSync(path.join(cwd, file), text)
      command(cwd, "add", file)
      command(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-m", text)
    }
    const before = command(f.checkout, "rev-parse", "HEAD")
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /conflicts with this fork/)
    assert.equal(f.logs(), "")
    assert.equal(command(f.checkout, "rev-parse", "HEAD"), before)
    assert.equal(
      readFileSync(path.join(f.checkout, file), "utf8"),
      "local customization",
    )
  },
)

test(
  "updater never stops service when candidate tests/build fail",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const result = f.run("build")
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(f.logs(), /build/)
    assert.doesNotMatch(f.logs(), /stop app/)
    assert.equal(command(f.checkout, "rev-parse", "HEAD"), f.base)
  },
)

test(
  "updater check mode builds candidate without deploying or changing checkout",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const result = f.run("", ["--check"])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(f.logs(), /--target test/)
    assert.match(f.logs(), /--target runtime/)
    assert.doesNotMatch(f.logs(), /stop app/)
    assert.equal(command(f.checkout, "rev-parse", "HEAD"), f.base)
  },
)

test(
  "updater resumes old image without data restore if backup fails",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const result = f.run("backup")
    assert.notEqual(result.status, 0)
    assert.match(
      f.logs(),
      /sha256:previous-image\|compose .*up -d --no-build app/,
    )
    assert.doesNotMatch(f.logs(), /tar -C \/data -xzf/)
    assert.equal(command(f.checkout, "rev-parse", "HEAD"), f.base)
  },
)

test(
  "updater restores encrypted volume and old image on failed health check",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const result = f.run("health")
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(f.logs(), /tar -C \/data -xzf \/backup\/data.tgz/)
    assert.match(
      f.logs(),
      /sha256:previous-image\|compose .*up -d --no-build app/,
    )
    assert.equal(command(f.checkout, "rev-parse", "HEAD"), f.base)
    assert.match(
      readFileSync(path.join(f.checkout, ".deploy/image.env"), "utf8"),
      /sha256:previous-image/,
    )
  },
)

test(
  "updater advances source and persists image only after healthy deployment",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const result = f.run()
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(
      readFileSync(path.join(f.checkout, "upstream.txt"), "utf8"),
      "new upstream feature\n",
    )
    assert.notEqual(command(f.checkout, "rev-parse", "HEAD"), f.base)
    assert.match(
      readFileSync(path.join(f.checkout, ".deploy/image.env"), "utf8"),
      /^AAH_IMAGE=all-api-hub-web:[a-f0-9]{40}\n$/,
    )
    assert.match(f.logs(), /tar -C \/data -czf/)
    assert.doesNotMatch(f.logs(), /tar -C \/data -xzf/)
    assert.equal(
      existsSync(path.join(f.checkout, ".deploy/update.lock")),
      false,
    )
  },
)

test(
  "updater leaves service stopped and retains backup if restore fails",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const result = f.run("restore")
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DATA RESTORE FAILED/)
    assert.match(f.logs(), /tar -C \/data -xzf/)
    assert.doesNotMatch(f.logs(), /sha256:previous-image\|compose .*up -d/)
    assert.equal(command(f.checkout, "rev-parse", "HEAD"), f.base)
    assert.equal(existsSync(path.join(f.checkout, ".deploy/backups")), true)
  },
)

test(
  "updater pins explicitly requested SDK and reference data in candidate",
  { skip: !available },
  (t) => {
    const f = fixture(t)
    const result = f.run("", [
      "--check",
      "--detector",
      "0.2.0",
      "--data",
      "0.0.1794360871947",
    ])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(
      f.logs(),
      /npm install --package-lock-only --ignore-scripts --save-exact lmfpd-sdk@0\.2\.0 lmfpd-data@0\.0\.1794360871947/,
    )
    assert.doesNotMatch(f.logs(), /stop app/)
    assert.equal(command(f.checkout, "rev-parse", "HEAD"), f.base)
    const invalid = f.run("", ["--data", "latest"])
    assert.equal(invalid.status, 2)
    assert.match(invalid.stderr, /Expected --data/)
  },
)
