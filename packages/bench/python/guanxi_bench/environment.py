"""Small Harbor environment for the D-194 rootless host. No host mounts/network/devices.
Harbor 0.24.0 is imported from the separately installed, locked virtual environment.
"""
import asyncio
import json
import os
from pathlib import Path
import pwd
import uuid

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities, EnvironmentResourceCapabilities

ACTIVE = set()


async def command(*args, timeout=120):
    p = await asyncio.create_subprocess_exec(*map(str, args), stdout=asyncio.subprocess.PIPE,
                                             stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except BaseException:
        if p.returncode is None:
            p.kill()
        await p.wait()
        raise
    if p.returncode:
        raise RuntimeError('container_command_failed_' + str(args[1]) + '_' + str(p.returncode))
    return out.decode('utf-8', errors='replace')


async def preflight():
    # MUTATION: host-user-guard
    if os.getuid() != 1001 or pwd.getpwuid(os.getuid()).pw_name != 'guanxi-bench':
        raise RuntimeError('dedicated_bench_user_required')
    info = json.loads(await command('podman', 'info', '--format', 'json'))
    host = info.get('host', {})
    if not host.get('security', {}).get('rootless') or host.get('cgroupManager') != 'systemd':
        raise RuntimeError('rootless_systemd_required')


class BenchPodman(BaseEnvironment):
    @staticmethod
    def type():
        return 'guanxi-rootless-podman'

    @property
    def capabilities(self):
        return EnvironmentCapabilities(disable_internet=True)

    @classmethod
    def resource_capabilities(cls):
        return EnvironmentResourceCapabilities(cpu_limit=True, memory_limit=True)

    def _validate_definition(self):
        if not self.task_env_config.docker_image:
            raise ValueError('prebuilt_image_required')
        # Harbor passes bookkeeping log binds even to copy-based providers.
        # Recognize only its private trial-log paths and do not mount any of them.
        for mount in self._mounts:
            if mount.get('target') not in {'/logs/agent', '/logs/verifier', '/logs/artifacts'} or not Path(mount.get('source', '')).resolve().is_relative_to(self.trial_paths.trial_dir.resolve()):
                raise ValueError('host_mounts_forbidden')
        self._mounts = []
        if self.task_env_config.env or self._persistent_env:
            raise ValueError('host_environment_forbidden')
        self.container = 'guanxi-b1-' + uuid.uuid4().hex
        self.created = False
        ACTIVE.add(self)

    async def start(self, force_build):
        await preflight()
        if self._effective_cpus > 8 or self._effective_memory_mb > 12288:
            raise ValueError('resource_profile_exceeds_host')
        # No user-defined run flags, bind roots, privileged mode, socket or GPU access.
        await command('podman', 'run', '--detach', '--pull=never', '--name', self.container,
                      '--label', 'org.guanxi.bench=b1', '--network=none', '--cap-drop=ALL',
                      '--security-opt=no-new-privileges', '--pids-limit=256',
                      '--cpus', str(self._effective_cpus), '--memory', f'{self._effective_memory_mb}m',
                      self.task_env_config.docker_image, '/bin/sh', '-c', 'while :; do sleep 3600; done')
        self.created = True
        info = json.loads(await command('podman', 'inspect', self.container))[0]
        profile = info['HostConfig']
        if profile['NetworkMode'] != 'none' or profile.get('Privileged') or profile.get('Devices') or info.get('Mounts'):
            raise RuntimeError('container_isolation_mismatch')
        if 'user-1001.slice' not in info['State'].get('CgroupPath', ''):
            raise RuntimeError('wrong_container_slice')
        await self.exec('mkdir -p /logs/agent /logs/verifier /logs/artifacts /tests /solution /app')

    async def stop(self, delete=True):
        # Remove only this environment's UUID, even after an interrupted create.
        await command('podman', 'rm', '--force', '--ignore', self.container, timeout=30)
        exists = await asyncio.create_subprocess_exec('podman', 'container', 'exists', self.container)
        if await exists.wait() != 1:
            raise RuntimeError('cleanup_unconfirmed')
        self.created = False
        ACTIVE.discard(self)

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None, **kwargs):
        args = ['podman', 'exec', '--workdir', cwd or '/app']
        if env:
            # Task subprocesses receive only explicit environment entries, never host inheritance.
            for k, v in env.items():
                args.extend(['--env', f'{k}={v}'])
        if user is not None:
            args.extend(['--user', str(user)])
        args.extend([self.container, '/bin/sh', '-c', command])
        p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(p.communicate(), timeout_sec or 120)
        except BaseException:
            if p.returncode is None:
                p.kill()
            await p.wait()
            # A timed-out exec may have surviving descendants: destroy its whole environment.
            await self.stop()
            raise
        return ExecResult(stdout=stdout.decode(errors='replace'), stderr=stderr.decode(errors='replace'),
                          return_code=p.returncode)

    async def upload_file(self, source_path, target_path):
        await command('podman', 'cp', str(source_path), f'{self.container}:{target_path}')

    async def upload_dir(self, source_dir, target_dir):
        await self.exec('mkdir -p ' + __import__('shlex').quote(target_dir))
        await command('podman', 'cp', str(source_dir) + '/.', f'{self.container}:{target_dir}')

    async def download_file(self, source_path, target_path):
        Path(target_path).parent.mkdir(parents=True, exist_ok=True)
        await command('podman', 'cp', f'{self.container}:{source_path}', str(target_path))

    async def download_dir(self, source_dir, target_dir):
        Path(target_dir).mkdir(parents=True, exist_ok=True)
        await command('podman', 'cp', f'{self.container}:{source_dir}/.', str(target_dir))
