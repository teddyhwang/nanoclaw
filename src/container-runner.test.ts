/**
 * container-runner — composition and lifecycle policy.
 *
 * What used to be here were source-text assertions: `readFileSync` on this
 * module plus a regex. They broke on a byte-identical move and stayed green
 * through a behavior change, so each one is now a behavioral case against the
 * thing it was really guarding. Argv assertions moved to
 * `src/drivers/docker-driver.test.ts`, which is where argv now lives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTAINER_CPU_LIMIT, CONTAINER_MEMORY_LIMIT } from './config.js';
import type { ContainerConfig } from './container-config.js';
import {
  armSessionLifecycle,
  buildMounts,
  composeSessionSpec,
  mergeVolumeMounts,
  parseMemoryMb,
  parsePidsLimit,
  resolveProviderName,
  syncSkillSymlinks,
  toMountSpecs,
} from './container-runner.js';
import type { SupervisedHandle } from './drivers/session-events.js';
import { _resetEnginePathsForTests, setEnginePaths } from './engine/paths.js';
import { addSkillRoot } from './engine/skill-roots.js';
import { log } from './log.js';
import {
  listProviderContainerConfigNames,
  registerProviderContainerConfig,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import type { AgentGroup, Session } from './types.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./modules/typing/index.js', () => ({ stopTypingRefresh: vi.fn() }));

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

const agentGroup: AgentGroup = {
  id: 'agent-1',
  name: 'Agent One',
  folder: 'agent-one',
  agent_provider: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as AgentGroup;

const session: Session = {
  id: 'session-1',
  agent_group_id: 'agent-1',
  messaging_group_id: 'messaging-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as Session;

const containerConfig: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;

const mounts: VolumeMount[] = [
  {
    hostPath: '/install/data/v2-sessions/agent-1/session-1',
    containerPath: '/workspace',
    readonly: false,
    mountClass: 'group-state',
    scope: 'agent-1',
  },
  {
    hostPath: '/install/container/agent-runner/src',
    containerPath: '/app/src',
    readonly: true,
    mountClass: 'install-surface',
    scope: 'agent-1',
  },
];

function compose(
  overrides: {
    gateway?: Record<string, unknown>;
    contribution?: Record<string, unknown>;
    containerConfig?: ContainerConfig;
  } = {},
) {
  return composeSessionSpec({
    agentGroup,
    session,
    containerName: 'nanoclaw-v2-agent-one-1700000000000',
    mounts,
    containerConfig: overrides.containerConfig ?? containerConfig,
    mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
    contribution: (overrides.contribution ?? {}) as never,
    gateway: (overrides.gateway ?? {}) as never,
  });
}

function composeWithFolder(folder: string) {
  return composeSessionSpec({
    agentGroup: { ...agentGroup, folder },
    session,
    containerName: 'nanoclaw-v2-agent-one-1700000000000',
    mounts,
    containerConfig,
    mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
    contribution: {} as never,
    gateway: {} as never,
  });
}

describe('composeSessionSpec', () => {
  it('keys the session by install, group and session id', () => {
    expect(compose().key).toMatchObject({ agentGroupId: 'agent-1', sessionId: 'session-1' });
  });

  it('routes the model provider contribution onto the contributed lane', () => {
    // Registry-sourced env is provenance-exempt from the credential-NAME check
    // — the custom-endpoint provider registers ANTHROPIC_AUTH_TOKEN=placeholder
    // for the gateway to overwrite on the wire, and composed-lane rules would
    // deny that install's every spawn.
    const spec = compose({
      contribution: { env: { XDG_DATA_HOME: '/workspace/xdg', ANTHROPIC_AUTH_TOKEN: 'placeholder' } },
    });
    expect(spec.containers[0].contributedEnv).toMatchObject({
      XDG_DATA_HOME: '/workspace/xdg',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
    expect(spec.containers[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('passes non-secret mailbox environment on the composed lane', () => {
    expect(compose().containers[0].env.NANOCLAW_MAILBOX_BACKEND).toBe('sqlite');
  });

  it('credential and gateway lanes override provider/spawn contributions in order', () => {
    const spec = composeSessionSpec({
      agentGroup,
      session,
      containerName: 'nanoclaw-v2-agent-one-1700000000000',
      mounts,
      containerConfig,
      mailboxEnvironment: {},
      contribution: { env: { HTTPS_PROXY: 'http://provider:1' } },
      credentialEnv: { HTTPS_PROXY: 'http://credential:2' },
      gateway: { env: { HTTPS_PROXY: 'http://gateway-must-win:15001' } },
    });
    expect(spec.containers[0].contributedEnv?.HTTPS_PROXY).toBe('http://gateway-must-win:15001');
  });

  it('bypasses the credential proxy for embedded host services', () => {
    expect(compose().containers[0].env).toMatchObject({
      NO_PROXY: 'host.docker.internal,localhost,127.0.0.1',
      no_proxy: 'host.docker.internal,localhost,127.0.0.1',
    });
  });

  it('carries the exact resolved group root for nested-host admission', () => {
    expect(compose().groupHostPath).toBeTruthy();
    expect(compose().groupHostPath).not.toBe('');
  });

  it('gateway mounts merge collision-free, shadowing a composed mount on the same target', () => {
    const spec = compose({
      gateway: {
        mounts: [
          {
            class: 'allowlisted-extra',
            hostPath: '/tmp/stub',
            containerPath: '/workspace',
            mode: 'ro',
            groupScope: 'agent-1',
          },
          {
            class: 'allowlisted-extra',
            hostPath: '/tmp/ca.pem',
            containerPath: '/tmp/onecli-ca.pem',
            mode: 'ro',
            groupScope: 'agent-1',
          },
        ],
      },
    });
    const targets = spec.containers[0].mounts.map((m) => m.containerPath);
    expect(targets.filter((t) => t === '/workspace')).toHaveLength(1);
    expect(spec.containers[0].mounts.find((m) => m.containerPath === '/workspace')?.hostPath).toBe('/tmp/stub');
    expect(targets).toContain('/tmp/onecli-ca.pem');
  });

  it('gateway containers ride beside the agent', () => {
    const spec = compose({
      gateway: {
        containers: [{ role: 'egress-proxy', image: 'proxy:1', env: {}, mounts: [] }],
      },
    });
    expect(spec.containers.map((c) => c.role)).toEqual(['agent', 'egress-proxy']);
  });

  it('carries the lineage label and stamps the group folder VERBATIM (D9)', () => {
    // The id→folder mapping lives only in the central DB; carrying the folder
    // on the session is what lets an admission-side check pin `groups/<folder>`
    // mounts to the session. Byte-identical to `agentGroup.folder` — drivers
    // refuse rather than project it, so composition must never pre-mangle it.
    expect(compose().labels['nanoclaw-container-name']).toBe('nanoclaw-v2-agent-one-1700000000000');
    expect(compose().labels['nanoclaw-group-folder']).toBe(agentGroup.folder);
  });

  it('REFUSES a folder that exceeds the 63-byte label cap instead of letting a driver project it', () => {
    // Admission joins `groups/<folder>` hostPaths to this label by string
    // concatenation; no admission-side check can invert a hash-suffix
    // projection, so an unlabelable folder must refuse at composition —
    // before any driver, where the error can name the real problem instead
    // of surfacing later as a policy denial blaming the wrong culprit.
    let thrown: unknown;
    try {
      composeWithFolder(`agent-${'x'.repeat(70)}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ kind: 'spec-invalid', retryable: false });
    expect(String((thrown as Error).message)).toContain('nanoclaw-group-folder');
    expect(String((thrown as Error).message)).toContain('rename the group folder');
  });

  it('REFUSES a folder outside the label-value charset, even a short one', () => {
    for (const folder of ['spike agent', 'café', 'agent-']) {
      let thrown: unknown;
      try {
        composeWithFolder(folder);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `folder '${folder}' must refuse`).toMatchObject({ kind: 'spec-invalid', retryable: false });
    }
  });

  it('accepts a folder at exactly 63 bytes, and the uuid-minted shape a governance flow creates', () => {
    // The bound is the cap itself, not a timid margin below it — and the
    // ~42-byte `agent-<uuid>` shape minted group folders get must stay legal,
    // so refusals are rare and loud rather than routine.
    const sixtyThree = `a${'b'.repeat(61)}c`;
    expect(sixtyThree.length).toBe(63);
    expect(composeWithFolder(sixtyThree).labels['nanoclaw-group-folder']).toBe(sixtyThree);
    const minted = 'agent-ef251cff-7911-42a6-b835-942fa947ab74';
    expect(composeWithFolder(minted).labels['nanoclaw-group-folder']).toBe(minted);
  });

  it('splits PID 1 so a driver can preserve the image init', () => {
    const agent = compose().containers[0];
    expect(agent.command).toEqual(['bash', '-c']);
    expect(agent.args).toEqual(['exec /app/start-with-camofox.sh']);
  });

  it('asks for a shared-private network and the standard posture', () => {
    const spec = compose();
    expect(spec.network).toBe('shared-private');
    expect(spec.hardening).toBe('standard');
    expect(spec.runtimeTier).toBe('container');
    expect(spec.stopGraceSeconds).toBe(12);
  });

  it('reads the isolation tier from the group container config, defaulting to container', () => {
    expect(compose().runtimeTier).toBe('container');
    expect(compose({ containerConfig: { ...containerConfig, runtimeTier: 'vm' } }).runtimeTier).toBe('vm');
    expect(compose({ containerConfig: { ...containerConfig, runtimeTier: 'container' } }).runtimeTier).toBe(
      'container',
    );
  });

  it('composes an explicit runAs posture on a uid-1000 host', () => {
    // uid 1000 matches the agent image's node user, so Docker's realization of
    // this posture is a no-op — but the spec contract (drivers/types.ts) says
    // the identity that must read 0600 host-owned material is explicit for
    // every non-root host, never inherited from an image USER. A driver whose
    // auxiliary image runs as 65532 cannot open the session's 0600 material
    // without it. Reverting to the old host-uid heuristic fails exactly this case.
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const getgid = vi.spyOn(process, 'getgid').mockReturnValue(1000);
    try {
      const spec = compose();
      expect(spec.runAs).toEqual({ uid: 1000, gid: 1000 });
      expect(spec.containers[0].env.HOME).toBe('/home/node');
    } finally {
      getuid.mockRestore();
      getgid.mockRestore();
    }
  });

  it('maps identity and HOME together for any non-root uid', () => {
    // Under a uid the image has no passwd entry for, HOME resolves to '/' and
    // the provider SDK's `mkdir ~/.claude` dies EACCES — so the mapping and
    // the explicit HOME travel together, exactly as they did in the old argv.
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(501);
    const getgid = vi.spyOn(process, 'getgid').mockReturnValue(20);
    try {
      const spec = compose();
      expect(spec.runAs).toEqual({ uid: 501, gid: 20 });
      expect(spec.containers[0].env.HOME).toBe('/home/node');
    } finally {
      getuid.mockRestore();
      getgid.mockRestore();
    }
  });

  it('never asks a runtime to run the session as root', () => {
    // The hardened posture pins non-root, so a composed uid-0 runAs could never
    // be realized; Docker's root behavior (image USER wins) stays unchanged.
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      const spec = compose();
      expect(spec.runAs).toBeUndefined();
      expect(spec.containers[0].env.HOME).toBeUndefined();
    } finally {
      getuid.mockRestore();
    }
  });

  it('leaves cpu and memory unset by default (unbounded, as today)', () => {
    // Guards the knobs' own defaults: an accidental default cap would OOM-kill
    // workloads that run fine now.
    expect(CONTAINER_CPU_LIMIT).toBe('');
    expect(CONTAINER_MEMORY_LIMIT).toBe('');
    const spec = compose();
    expect(spec.resources.cpus).toBeUndefined();
    expect(spec.resources.memoryMb).toBeUndefined();
    expect(spec.resources.shmSizeMb).toBe(1024);
  });
});

describe('parseMemoryMb', () => {
  it('reads the operator-facing docker size strings', () => {
    expect(parseMemoryMb('8g')).toBe(8192);
    expect(parseMemoryMb('512m')).toBe(512);
    expect(parseMemoryMb('2G')).toBe(2048);
  });

  it('treats a bare number as bytes, the way Docker does', () => {
    // Reinterpreting it as megabytes would multiply an existing operator value
    // by a million.
    expect(parseMemoryMb('536870912')).toBe(512);
  });

  it('treats blank and zero as unbounded — the meanings Docker itself assigns', () => {
    for (const value of ['', '   ', '0']) {
      expect(parseMemoryMb(value)).toBeUndefined();
    }
  });

  it('REFUSES garbage instead of silently removing the cap', () => {
    // Fail-closed like the raw pass-through this replaced: Docker used to
    // reject an invalid value at spawn. Returning undefined would fail in the
    // one wrong direction a resource limit has — quietly uncapped.
    for (const value of ['lots', '-4', '8gb extra', '8 gigs']) {
      expect(() => parseMemoryMb(value), `'${value}' must refuse`).toThrow(/CONTAINER_MEMORY_LIMIT/);
    }
  });
});

describe('parsePidsLimit', () => {
  it('accepts a positive integer and floors fractions', () => {
    expect(parsePidsLimit('2048')).toBe(2048);
    expect(parsePidsLimit('2048.7')).toBe(2048);
  });

  it('rejects 0, negatives, blank and garbage', () => {
    // cgroups v2 rejects `--pids-limit 0` with EINVAL, killing the spawn.
    for (const value of ['0', '-1', '', '   ', 'lots']) {
      expect(parsePidsLimit(value)).toBeUndefined();
    }
  });
});

describe('mount contribution precedence', () => {
  it('keeps the last provider/spawn source for each container target', () => {
    expect(
      mergeVolumeMounts(
        [{ hostPath: '/base', containerPath: '/same', readonly: true }],
        [
          { hostPath: '/provider', containerPath: '/same', readonly: true },
          { hostPath: '/spawn-last', containerPath: '/same', readonly: false },
        ],
      ),
    ).toEqual([{ hostPath: '/spawn-last', containerPath: '/same', readonly: false }]);
  });
});

describe('toMountSpecs', () => {
  it('carries the class and scope through, and maps readonly to a mode', () => {
    expect(toMountSpecs(mounts, 'agent-1')).toEqual([
      {
        class: 'group-state',
        hostPath: '/install/data/v2-sessions/agent-1/session-1',
        containerPath: '/workspace',
        mode: 'rw',
        groupScope: 'agent-1',
      },
      {
        class: 'install-surface',
        hostPath: '/install/container/agent-runner/src',
        containerPath: '/app/src',
        mode: 'ro',
        groupScope: 'agent-1',
      },
    ]);
  });

  it('defaults an unclassed mount to the vetted-upstream class', () => {
    const [spec] = toMountSpecs([{ hostPath: '/x', containerPath: '/y', readonly: false }], 'agent-1');
    expect(spec.class).toBe('allowlisted-extra');
    expect(spec.groupScope).toBe('agent-1');
  });
});

describe('armSessionLifecycle', () => {
  function fakeHandle(startBehavior: () => Promise<void> = async () => {}): {
    handle: Pick<SupervisedHandle, 'onTerminal' | 'start'>;
    order: string[];
  } {
    const order: string[] = [];
    return {
      order,
      handle: {
        onTerminal: () => order.push('onTerminal'),
        start: async () => {
          order.push('start');
          await startBehavior();
        },
      },
    };
  }

  it('arms terminal handling before starting, and bookkeeping after', async () => {
    const { handle, order } = fakeHandle();
    await armSessionLifecycle({
      handle,
      onTerminal: () => {},
      afterStart: () => {
        order.push('afterStart');
      },
    });

    // A failure landing during startup must find a runtime that already knows
    // how to finalize; recording "running" before the session exists would
    // mark a session running that never started.
    expect(order).toEqual(['onTerminal', 'start', 'afterStart']);
  });

  it('never runs the post-start bookkeeping when the start fails', async () => {
    const { handle, order } = fakeHandle(async () => {
      throw new Error('image-unavailable');
    });

    await expect(
      armSessionLifecycle({
        handle,
        onTerminal: () => {},
        afterStart: () => {
          order.push('afterStart');
        },
      }),
    ).rejects.toThrow('image-unavailable');

    expect(order).toEqual(['onTerminal', 'start']);
  });
});

describe('embedded host path composition', () => {
  it('ignores cwd and admits nested workspace group state with the wrapper command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-embedded-'));
    const dataDir = path.join(root, 'data');
    const groupsDir = path.join(root, 'groups');
    const containerSourceDir = path.join(root, 'packages', 'nanoclaw', 'container');
    const nestedGroupDir = path.join(groupsDir, 'workspace-a', agentGroup.folder);
    fs.mkdirSync(path.join(containerSourceDir, 'agent-runner', 'src'), { recursive: true });
    fs.mkdirSync(path.join(containerSourceDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(nestedGroupDir, 'plugins'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    if (!listProviderContainerConfigNames().includes('test-embedded-surfaces')) {
      registerProviderContainerConfig('test-embedded-surfaces', () => ({}), { providesAgentSurfaces: true });
    }
    const previousCwd = process.cwd();
    const previousSource = process.env.NANOCLAW_CONTAINER_SOURCE_DIR;
    try {
      setEnginePaths({
        projectRoot: root,
        groupsDir,
        dataDir,
        containerSourceDir,
        groupDirResolver: () => nestedGroupDir,
      });
      process.env.NANOCLAW_CONTAINER_SOURCE_DIR = containerSourceDir;
      process.chdir(dataDir);
      const providerManifest = path.join(root, 'pi-rpc-provider.json');
      const toolManifest = path.join(root, 'container-tools.json');
      fs.writeFileSync(providerManifest, '{}');
      fs.writeFileSync(toolManifest, '{}');
      const composedMounts = await buildMounts(agentGroup, session, containerConfig, 'test-embedded-surfaces', {
        mounts: [
          {
            hostPath: providerManifest,
            containerPath: '/workspace/.config/pi/providers.json',
            readonly: true,
          },
          {
            hostPath: toolManifest,
            containerPath: '/workspace/.config/pi/tools.json',
            readonly: true,
          },
        ],
      });
      expect(composedMounts.find((mount) => mount.containerPath === '/workspace/agent')?.hostPath).toBe(
        fs.realpathSync(nestedGroupDir),
      );
      expect(composedMounts.find((mount) => mount.containerPath === '/app/src')?.hostPath).toBe(
        fs.realpathSync(path.join(containerSourceDir, 'agent-runner', 'src')),
      );
      expect(composedMounts.map((mount) => mount.containerPath)).toEqual(
        expect.arrayContaining(['/workspace/.config/pi/providers.json', '/workspace/.config/pi/tools.json']),
      );
      const spec = composeSessionSpec({
        agentGroup,
        session,
        containerName: 'embedded-test',
        mounts: composedMounts,
        containerConfig,
        contribution: {},
        gateway: {},
        mailboxEnvironment: {},
      });
      expect(spec.groupHostPath).toBe(fs.realpathSync(nestedGroupDir));
      expect(spec.containers[0].args).toEqual(['exec /app/start-with-camofox.sh']);
      expect(spec.stopGraceSeconds).toBe(12);
    } finally {
      process.chdir(previousCwd);
      if (previousSource === undefined) delete process.env.NANOCLAW_CONTAINER_SOURCE_DIR;
      else process.env.NANOCLAW_CONTAINER_SOURCE_DIR = previousSource;
      _resetEnginePathsForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('syncSkillSymlinks', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function tmpClaudeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-skills-'));
  }

  it('links every selected skill to its container path', () => {
    const dir = tmpClaudeDir();
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    const link = path.join(dir, 'skills', 'welcome');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Dangling on the host, valid inside the container.
    expect(fs.readlinkSync(link)).toBe('/app/skills/welcome');
  });

  it('discovers filtered skills in extra mounted roots without shadowing built-ins', () => {
    const dir = tmpClaudeDir();
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-source-'));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-extra-'));
    fs.mkdirSync(path.join(source, 'skills', 'welcome'), { recursive: true });
    fs.mkdirSync(path.join(extra, 'welcome'));
    fs.mkdirSync(path.join(extra, 'google'));
    fs.mkdirSync(path.join(extra, 'hidden'));
    cleanups.push(
      addSkillRoot({
        hostPath: extra,
        containerPath: '/app/optimus-skills',
        skillFilter: (name) => name !== 'hidden',
      }),
    );

    syncSkillSymlinks(dir, { ...containerConfig, skills: 'all' } as ContainerConfig, agentGroup, source);
    expect(fs.readlinkSync(path.join(dir, 'skills', 'welcome'))).toBe('/app/skills/welcome');
    expect(fs.readlinkSync(path.join(dir, 'skills', 'google'))).toBe('/app/optimus-skills/google');
    expect(fs.existsSync(path.join(dir, 'skills', 'hidden'))).toBe(false);
  });

  it('prunes symlinks that are no longer selected', () => {
    const dir = tmpClaudeDir();
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome', 'vercel-cli'] } as ContainerConfig);
    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    expect(fs.existsSync(path.join(dir, 'skills', 'vercel-cli'))).toBe(false);
  });

  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    // Template overlays depend on surviving the prune (see src/group-skills.ts);
    // a stale pre-refactor skill copy (#3001) otherwise gets served forever with
    // no trace.
    const dir = tmpClaudeDir();
    fs.mkdirSync(path.join(dir, 'skills', 'welcome'), { recursive: true });

    syncSkillSymlinks(dir, { ...containerConfig, skills: ['welcome'] } as ContainerConfig);

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Shared skill not symlinked'),
      expect.objectContaining({ skill: 'welcome' }),
    );
  });
});
