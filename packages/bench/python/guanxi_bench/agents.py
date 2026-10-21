"""Adapters use installed upstream code; neither prompts nor model trajectories are saved."""
import asyncio
import json
import shlex
from importlib.metadata import version

from harbor.agents.base import BaseAgent
from harbor.agents.installed.base import NonZeroAgentExitCodeError


class BenchCancelled(RuntimeError):
    pass


class BenchInterrupted(RuntimeError):
    pass


class MiniSweFixture(BaseAgent):
    """Real mini-swe-agent control flow, using its zero-cost deterministic model."""
    def __init__(self, *args, max_steps=4, **kwargs):
        super().__init__(*args, **kwargs)
        self.max_steps = max_steps

    @staticmethod
    def name():
        return 'mini-swe-agent'

    def version(self):
        return version('mini-swe-agent')

    async def setup(self, environment):
        pass

    async def run(self, instruction, environment, context):
        from minisweagent.agents.default import DefaultAgent
        from minisweagent.models.test_models import DeterministicModel, make_output
        from minisweagent.environments.local import LocalEnvironment
        loop = asyncio.get_running_loop()

        class Bridge:
            def execute(self, action, cwd=''):
                result = asyncio.run_coroutine_threadsafe(
                    environment.exec(action['command'], cwd=cwd or '/app', timeout_sec=10), loop).result(20)
                output = {'output': (result.stdout or '') + (result.stderr or ''), 'returncode': result.return_code, 'exception_info': ''}
                # Reuse only upstream's completion recognizer, never its host execute method.
                LocalEnvironment._check_finished(self, output)
                return output

            def get_template_vars(self, **kwargs):
                return kwargs

            def serialize(self):
                return {}

        model = DeterministicModel(outputs=[
            make_output('', [{'command': 'printf 42 > /app/answer'}], cost=0),
            make_output('', [{'command': 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'}], cost=0),
        ], cost_per_call=0)
        agent = DefaultAgent(model, Bridge(), system_template='Solve the fixture using shell commands.',
                             instance_template='{{task}}', step_limit=self.max_steps, cost_limit=0, output_path=None)
        result = await asyncio.to_thread(agent.run, instruction)
        if result.get('exit_status') != 'Submitted':
            raise NonZeroAgentExitCodeError('fixture_agent_failed')
        context.cost_usd = 0
        context.n_input_tokens = 0
        context.n_output_tokens = 0


class GuanxiExec(BaseAgent):
    """Use a prepared task image containing a node with K3 connection/project policy.
    The node/project must point at /app in this container. No host node is contacted.
    Connection credentials remain in that node's K3 vault; only an ID is passed here.
    """
    def __init__(self, *args, project='bench', connection='bench', **kwargs):
        super().__init__(*args, **kwargs)
        self.project = project
        self.connection = connection

    @staticmethod
    def name():
        return 'guanxi'

    def version(self):
        return 'exec-json-v1'

    async def setup(self, environment):
        result = await environment.exec('command -v guanxi')
        if result.return_code:
            raise RuntimeError('prepared_guanxi_image_required')

    async def run(self, instruction, environment, context):
        args = ['guanxi', 'agent', 'exec', '--json', '--project', self.project,
                '--connection', self.connection, '--model', self.model_name, '--mode', 'full-access',
                '--prompt', instruction]
        response = await environment.exec(shlex.join(args), timeout_sec=600)
        result = json.loads(response.stdout)
        valid = (isinstance(result, dict) and set(result) == {'version', 'sessionId', 'status', 'text', 'error'}
                 and type(result['version']) is int and result['version'] == 1
                 and (result['sessionId'] is None or isinstance(result['sessionId'], str))
                 and isinstance(result['text'], str)
                 and (result['error'] is None or isinstance(result['error'], str))
                 and isinstance(result['status'], str)
                 and result['status'] in {'completed', 'failed', 'cancelled', 'interrupted'})
        if not valid:
            raise RuntimeError('malformed_agent_exec')
        if result['status'] == 'cancelled':
            raise BenchCancelled('agent_cancelled')
        if result['status'] == 'interrupted':
            raise BenchInterrupted('agent_interrupted')
        if result['status'] == 'failed':
            raise NonZeroAgentExitCodeError('agent_exec_failed')
        if response.return_code:
            raise RuntimeError('malformed_agent_exec')
        # Agent completion is not a task pass. Harbor's hidden verifier decides.
        context.cost_usd = None
