#!/usr/bin/env python3
"""Pinned Harbor + real mini-swe-agent, in-memory container fixture; no network/process engine."""
import asyncio
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
# Fail on every actual network connection, including accidental provider/config requests.
sys.addaudithook(lambda event, args: (_ for _ in ()).throw(AssertionError('network_forbidden')) if event == 'socket.connect' else None)

async def main():
    with tempfile.TemporaryDirectory(prefix='b1-mini-config-') as directory:
        os.environ['MSWEA_GLOBAL_CONFIG_DIR'] = directory
        os.environ['MSWEA_SILENT_STARTUP'] = '1'
        from guanxi_bench.agents import MiniSweFixture
        from harbor.environments.base import ExecResult
        from harbor.models.agent.context import AgentContext
        from minisweagent.environments.local import LocalEnvironment
        assert version('harbor') == '0.24.0'
        assert version('mini-swe-agent') == '2.4.6'
        calls = []
        class Environment:
            async def exec(self, command, **kwargs):
                calls.append(command)
                return ExecResult(stdout='COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\n' if command.startswith('echo ') else '', stderr='', return_code=0)
        with patch.object(LocalEnvironment, 'execute', side_effect=AssertionError('host_execution_forbidden')):
            agent = MiniSweFixture(logs_dir=Path(directory), model_name='fixture-free', max_steps=4)
            context = AgentContext()
            await agent.run('Write the fixture answer.', Environment(), context)
        assert calls == ['printf 42 > /app/answer', 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'], calls
        assert context.cost_usd == 0
        assert context.n_input_tokens == 0 and context.n_output_tokens == 0
        assert not list(Path(directory).rglob('*.json'))
        print(json.dumps({'realHarbor': version('harbor'), 'realControl': version('mini-swe-agent'), 'commands': len(calls), 'costMicrousd': 0, 'networkConnections': 0, 'hostExecutions': 0}))

asyncio.run(main())
