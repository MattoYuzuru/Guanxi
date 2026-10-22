"""JSON stdin/stdout worker, launched only through the dedicated-user SSH transport.
No paid model implementation is enabled by B1. All stderr, upstream logs and trajectories
are discarded, and private temporary Harbor outputs are deleted after projection.
"""
import asyncio
from importlib.metadata import version
import json
import fcntl
import contextlib
import logging
import os
from pathlib import Path
import signal
import sys
import tempfile
import time

from .environment import command, preflight, ACTIVE


def classify(result):
    """Only the hidden reward passes a task. Agent errors are not container infra errors."""
    if result.exception_info:
        name = result.exception_info.exception_type
        safe = {'wrong_container_slice', 'container_isolation_mismatch', 'rootless_systemd_required', 'resource_profile_exceeds_host', 'prebuilt_image_required', 'host_mounts_forbidden', 'host_environment_forbidden'}
        message = getattr(result.exception_info, 'exception_message', '')
        print('harbor_trial_error:' + name + (':' + message if message in safe else ''), file=sys.stderr)
        if name in {'BenchCancelled', 'BenchInterrupted'}:
            return 'infra_tainted', 'cancelled' if name == 'BenchCancelled' else 'preempted'
        if name in {'AgentTimeoutError', 'AgentExecutionTimeoutError'}:
            return 'failed', 'agent_limit'
        if name in {'AgentExecutionError', 'AgentExecutionFailedError', 'NonZeroAgentExitCodeError'}:
            return 'failed', 'agent_error'
        return 'infra_error', 'verifier' if 'Verifier' in name or 'Reward' in name else 'environment'
    reward = result.verifier_result.rewards if result.verifier_result else None
    if not isinstance(reward, dict) or len(reward) != 1 or not isinstance(next(iter(reward.values())), (int, float)):
        return 'infra_error', 'verifier'
    value = next(iter(reward.values()))
    if value not in (0, 1):
        return 'infra_error', 'verifier'
    return ('passed', 'none') if value == 1 else ('failed', 'hidden_tests')


def usage(result):
    from decimal import Decimal, ROUND_CEILING
    context = result.agent_result
    cost = getattr(context, 'cost_usd', None)
    i = getattr(context, 'n_input_tokens', None)
    o = getattr(context, 'n_output_tokens', None)
    return {'costMicrousd': int((Decimal(str(cost)) * 1_000_000).to_integral_value(rounding=ROUND_CEILING)) if cost is not None else None,
            'tokens': i + o if i is not None and o is not None else None}


def safe_error_type(result):
    allowed = {'RuntimeError', 'ValueError', 'KeyError', 'TypeError', 'AttributeError', 'UndefinedError', 'FileNotFoundError', 'RewardFileNotFoundError'}
    if not result.exception_info:
        return 'none'
    return result.exception_info.exception_type if result.exception_info.exception_type in allowed else 'other'


async def toy_tasks(root):
    """Build locally from the host's existing base image, never pull or use the network."""
    base = (await command('podman', 'image', 'inspect', 'docker.io/library/alpine:3.20', '--format', '{{.Id}}')).strip()
    build = root / 'build'
    build.mkdir()
    (build / 'Dockerfile').write_text(f'FROM {base}\nUSER 0\nRUN mkdir -p /logs/agent /logs/verifier /logs/artifacts /tests /solution /app && chmod -R a+rwX /logs /tests /solution /app\nWORKDIR /app\nUSER 65532:65532\n')
    image = 'localhost/guanxi-b1-toy:' + root.name.lower().replace('_', '-')
    await command('podman', 'build', '--network=none', '--pull=never', '-t', image, build)
    paths = []
    for i in range(2):
        task = root / f'toy-{i}'
        (task / 'environment').mkdir(parents=True)
        (task / 'tests').mkdir()
        (task / 'instruction.md').write_text('Write 42 to /app/answer.')
        (task / 'task.toml').write_text(f'''version = "1.0"
artifacts = ["/app"]
[environment]
docker_image = "{image}"
cpus = 1
memory_mb = 128
network_mode = "no-network"
[agent]
network_mode = "no-network"
timeout_sec = 30
[verifier]
environment_mode = "separate"
timeout_sec = 30
network_mode = "no-network"
''')
        # The second hidden verifier deliberately fails to prove completion != success.
        expected = '42' if i == 0 else '43'
        (task / 'tests/test.sh').write_text(f'''#!/bin/sh
mkdir -p /logs/verifier
if [ "$(cat /app/answer 2>/dev/null)" = "{expected}" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
''')
        (task / 'tests/test.sh').chmod(0o755)
        paths.append(task)
    return paths, image


async def run(plan):
    if version('harbor') != '0.24.0' or version('mini-swe-agent') != '2.4.6':
        raise ValueError('pinned_environment_required')
    if plan['maxTrialMicrousd'] != 0 or plan['model'] != 'fixture-free' or plan['connection'] is not None:
        raise ValueError('bounded_k3_gateway_required')
    if sys.version_info[:3] != (3, 12, 14):
        raise ValueError('pinned_python_required')
    if plan['mode'] != 'fixture':
        raise ValueError('real_bench_executor_not_configured')
    if len(plan['tasks']) != 2 or plan['seeds'] != [0] or len(plan['arms']) != 1 or plan['arms'][0]['kind'] != 'mini-swe-agent' or plan['arms'][0]['version'] != '2.4.6':
        raise ValueError('host_smoke_envelope_required')
    await preflight()
    from harbor.trial.trial import Trial
    from harbor.models.trial.config import TrialConfig
    results = []
    with tempfile.TemporaryDirectory(prefix='b1-', dir='/home/guanxi-bench') as tmp:
        root = Path(tmp)
        os.environ['MSWEA_GLOBAL_CONFIG_DIR'] = str(root / 'mini-config')
        os.environ['MSWEA_SILENT_STARTUP'] = '1'
        os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
        image = None
        try:
            tasks, image = await toy_tasks(root)
            for i, path in enumerate(tasks):
                for j, seed in enumerate(plan['seeds']):
                    arms = list(plan['arms'])
                    if (i + j) % 2:
                        arms.reverse()
                    for arm in arms:
                        start = time.monotonic()
                        if arm['kind'] not in {'mini-swe-agent', 'guanxi'}:
                            raise ValueError('unsupported_host_arm')
                        agent_class = 'MiniSweFixture' if arm['kind'] == 'mini-swe-agent' else 'GuanxiExec'
                        agent_kwargs = {'max_steps': plan['maxSteps']} if arm['kind'] == 'mini-swe-agent' else {}
                        config = TrialConfig.model_validate({
                            'task': {'path': str(path)}, 'trial_name': f'trial-{i}-{j}-{arm["kind"]}', 'trials_dir': str(root / 'trials'),
                            'agent': {'import_path': 'guanxi_bench.agents:' + agent_class, 'model_name': plan['model'],
                                      'override_timeout_sec': plan['timeoutSec'], 'kwargs': agent_kwargs},
                            'environment': {'import_path': 'guanxi_bench.environment:BenchPodman',
                                            'override_cpus': plan['cpus'], 'override_memory_mb': plan['memoryMb'],
                                            'cpu_enforcement_policy': 'limit', 'memory_enforcement_policy': 'limit'},
                        })
                        trial = await Trial.create(config)
                        result = await trial.run()
                        outcome, reason = classify(result)
                        results.append({'task': plan['tasks'][i]['id'], 'arm': arm['id'], 'seed': seed,
                                        'outcome': outcome, 'reason': reason, **usage(result),
                                        'errorType': safe_error_type(result),
                                        'durationMs': round((time.monotonic() - start) * 1000)})
        finally:
            # Harbor may preserve the first trial error and suppress later cleanup errors.
            # Independently require every environment to acknowledge removal.
            for environment in list(ACTIVE):
                await environment.stop()
            if image:
                await command('podman', 'image', 'rm', image, timeout=30)
    return results


def main():
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    plan = json.load(sys.stdin)
    async def entry():
        task = asyncio.current_task()
        for sig in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_running_loop().add_signal_handler(sig, task.cancel)
        return await asyncio.wait_for(run(plan), timeout=plan['timeoutSec'])
    try:
        with open('/home/guanxi-bench/.guanxi-bench.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink):
                result = asyncio.run(entry())
            print(json.dumps(result))
    except BaseException as error:
        # Never echo arbitrary Python/provider errors, instructions or raw Harbor results.
        code = str(error) if isinstance(error, RuntimeError) and str(error).startswith('container_command_failed_') else type(error).__name__
        print('bench_worker_failed:' + code, file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
