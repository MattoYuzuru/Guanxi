"""Offline stdlib fixtures. No Harbor install, SSH, Podman, network or live models."""
import asyncio
import importlib
import json
from pathlib import Path
import sys
import types
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'python'))

# The fake upstream boundary leaves our actual adapters and guard code under test.
class Model:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

for name in ['harbor', 'harbor.environments', 'harbor.environments.base', 'harbor.environments.capabilities',
             'harbor.agents', 'harbor.agents.base', 'harbor.agents.installed', 'harbor.agents.installed.base']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['harbor.environments.base'].BaseEnvironment = object
sys.modules['harbor.environments.base'].ExecResult = Model
sys.modules['harbor.environments.capabilities'].EnvironmentCapabilities = Model
sys.modules['harbor.environments.capabilities'].EnvironmentResourceCapabilities = Model
sys.modules['harbor.agents.base'].BaseAgent = object
sys.modules['harbor.agents.installed.base'].NonZeroAgentExitCodeError = type('NonZeroAgentExitCodeError', (RuntimeError,), {})
from guanxi_bench import environment, agents, worker


class GuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_dedicated_user_and_rootless_required_before_container_commands(self):
        with patch.object(environment.os, 'getuid', return_value=0), patch.object(environment, 'command', new_callable=AsyncMock, return_value=json.dumps({'host': {'security': {'rootless': True}, 'cgroupManager': 'systemd'}})) as cmd:
            with self.assertRaisesRegex(RuntimeError, 'dedicated_bench_user'):
                await environment.preflight()
            cmd.assert_not_awaited()
        for rootless, manager, ok in [(False, 'systemd', False), (True, 'cgroupfs', False), (True, 'systemd', True)]:
            with patch.object(environment.os, 'getuid', return_value=1001), patch.object(environment.pwd, 'getpwuid', return_value=Model(pw_name='guanxi-bench')), patch.object(environment, 'command', new_callable=AsyncMock, return_value=json.dumps({'host': {'security': {'rootless': rootless}, 'cgroupManager': manager}})):
                if ok:
                    await environment.preflight()
                else:
                    with self.assertRaisesRegex(RuntimeError, 'rootless_systemd'):
                        await environment.preflight()

    async def test_run_flags_and_observed_slice_are_enforced(self):
        env = environment.BenchPodman()
        env.container = 'guanxi-b1-fixture'
        env._effective_cpus = 2
        env._effective_memory_mb = 256
        env.task_env_config = Model(docker_image='sha256:' + '1' * 64)
        profile = {'HostConfig': {'NetworkMode': 'none', 'Privileged': False, 'Devices': []}, 'Mounts': [], 'Config': {'User': '65532:65532'}, 'State': {'CgroupPath': '/user.slice/user-1001.slice/libpod-fixture'}}
        calls = []
        async def cmd(*args, **kwargs):
            calls.append(args)
            return json.dumps([profile]) if args[1] == 'inspect' else ''
        env.exec = AsyncMock(return_value=Model(return_code=0))
        with patch.object(environment, 'preflight', new_callable=AsyncMock), patch.object(environment, 'command', side_effect=cmd):
            await env.start(False)
            run = calls[0]
            self.assertIn('--network=none', run)
            self.assertIn('--cap-drop=ALL', run)
            self.assertEqual(run[run.index('--user') + 1], '65532:65532')
            self.assertIn('--security-opt=no-new-privileges', run)
            self.assertEqual(run[run.index('--cpus') + 1], '2')
            self.assertEqual(run[run.index('--memory') + 1], '256m')
            self.assertNotIn('--privileged', run)
            self.assertNotIn('--device', run)
            self.assertNotIn('--volume', run)
            profile['State']['CgroupPath'] = '/user.slice/user-1000.slice'
            with self.assertRaisesRegex(RuntimeError, 'wrong_container_slice'):
                await env.start(False)

    async def test_guanxi_exec_uses_only_container_interface_and_validates_stdout(self):
        agent = agents.GuanxiExec.__new__(agents.GuanxiExec)
        agent.project = 'bench'; agent.connection = 'connection-id'; agent.model_name = 'fixture-free'
        env = Model(exec=AsyncMock(return_value=Model(return_code=0, stdout=json.dumps({'version': 1, 'sessionId': 'session', 'status': 'completed', 'text': 'do not export', 'error': None}))))
        context = Model()
        await agent.run('untrusted; echo bad', env, context)
        command_text = env.exec.call_args.args[0]
        self.assertIn("--prompt 'untrusted; echo bad'", command_text)
        self.assertIn('--json', command_text)
        self.assertIsNone(context.cost_usd)
        env.exec.return_value.stdout = '{"version": 2}'
        with self.assertRaisesRegex(RuntimeError, 'malformed_agent_exec'):
            await agent.run('task', env, context)

    def test_hidden_tests_and_infra_are_distinct(self):
        def result(error=None, rewards=None):
            return Model(exception_info=Model(exception_type=error) if error else None,
                         verifier_result=Model(rewards=rewards) if rewards is not None else None)
        self.assertEqual(worker.classify(result(rewards={'reward': 0})), ('failed', 'hidden_tests'))
        self.assertEqual(worker.classify(result(rewards={'reward': 1})), ('passed', 'none'))
        self.assertEqual(worker.classify(result('AgentTimeoutError')), ('failed', 'agent_limit'))
        self.assertEqual(worker.classify(result('EnvironmentStartTimeoutError')), ('infra_error', 'environment'))
        self.assertEqual(worker.classify(result('VerifierTimeoutError')), ('infra_error', 'verifier'))
        for rewards in [None, {}, {'reward': '1'}, {'reward': float('nan')}, {'reward': 1, 'other': 0}]:
            self.assertEqual(worker.classify(result(rewards=rewards)), ('infra_error', 'verifier'))

    async def test_interrupted_and_cancelled_are_infra_and_malformed_fields_fail(self):
        agent = agents.GuanxiExec.__new__(agents.GuanxiExec)
        agent.project = 'bench'; agent.connection = 'connection-id'; agent.model_name = 'fixture-free'
        for status, exception in [('cancelled', agents.BenchCancelled), ('interrupted', agents.BenchInterrupted)]:
            record = {'version': 1, 'sessionId': 's', 'status': status, 'text': '', 'error': None}
            env = Model(exec=AsyncMock(return_value=Model(return_code=1, stdout=json.dumps(record))))
            with self.assertRaises(exception) as raised:
                await agent.run('task', env, Model())
            result = Model(exception_info=Model(exception_type=type(raised.exception).__name__))
            self.assertEqual(worker.classify(result)[0], 'infra_tainted')
        for patch_record in [{'version': True}, {'text': {}}, {'error': 42}, {'sessionId': []}, {'status': ['completed']}]:
            record = {'version': 1, 'sessionId': None, 'status': 'completed', 'text': '', 'error': None} | patch_record
            env = Model(exec=AsyncMock(return_value=Model(return_code=0, stdout=json.dumps(record))))
            with self.assertRaisesRegex(RuntimeError, 'malformed_agent_exec'):
                await agent.run('task', env, Model())

    def test_usage_is_observed_not_zero_filled(self):
        self.assertEqual(worker.usage(Model(agent_result=Model(cost_usd=None, n_input_tokens=None, n_output_tokens=None))), {'costMicrousd': None, 'tokens': None})
        self.assertEqual(worker.usage(Model(agent_result=Model(cost_usd=0.0000011, n_input_tokens=10, n_output_tokens=4))), {'costMicrousd': 2, 'tokens': 14})
        self.assertEqual(worker.usage(Model(agent_result=None)), {'costMicrousd': None, 'tokens': None})

    async def test_untrusted_output_is_bounded_and_environment_is_torn_down(self):
        stdout = asyncio.StreamReader()
        stdout.feed_data(b'x' * (environment.OUTPUT_LIMIT + 1)); stdout.feed_eof()
        stderr = asyncio.StreamReader(); stderr.feed_eof()
        process = Model(stdout=stdout, stderr=stderr, returncode=None, wait=AsyncMock(return_value=-9))
        killed = []
        def kill():
            killed.append(True); process.returncode = -9
        process.kill = kill
        env = environment.BenchPodman()
        env.container = 'guanxi-b1-fixture'; env.stop = AsyncMock()
        with patch.object(environment.asyncio, 'create_subprocess_exec', new_callable=AsyncMock, return_value=process):
            with self.assertRaises(environment.OutputLimitError):
                await env.exec('fixture output flood')
        self.assertEqual(killed, [True]); env.stop.assert_awaited_once()

    async def test_toy_verifier_is_executable_under_the_nonroot_workload(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(worker, 'command', new_callable=AsyncMock, return_value='sha256:' + '1' * 64):
            tasks, image = await worker.toy_tasks(Path(directory))
            for task in tasks:
                self.assertEqual((task / 'tests/test.sh').stat().st_mode & 0o777, 0o755)

    async def test_worker_refuses_paid_models_before_importing_harbor_or_contacting_podman(self):
        p = {'maxTrialMicrousd': 1, 'model': 'paid', 'connection': 'secret://k3/bench'}
        with patch.object(worker, 'version', side_effect=lambda name: '0.24.0' if name == 'harbor' else '2.4.6'), patch.object(worker, 'preflight', new_callable=AsyncMock) as preflight:
            with self.assertRaisesRegex(ValueError, 'bounded_k3_gateway'):
                await worker.run(p)
            preflight.assert_not_awaited()

if __name__ == '__main__':
    unittest.main()
