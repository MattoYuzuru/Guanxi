"""Adapters use installed upstream code; neither prompts nor model trajectories are saved."""
import asyncio
import json
import shlex
from importlib.metadata import version

from harbor.agents.base import BaseAgent
from harbor.agents.installed.base import NonZeroAgentExitCodeError


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
        loop = asyncio.get_running_loop()

        class Bridge:
            def execute(self, action, cwd=''):
                result = asyncio.run_coroutine_threadsafe(
                    environment.exec(action['command'], cwd=cwd or '/app', timeout_sec=10), loop).result(20)
                return {'output': (result.stdout or '') + (result.stderr or ''), 'returncode': result.return_code}

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
        if set(result) != {'version', 'sessionId', 'status', 'text', 'error'} or result['version'] != 1:
            raise RuntimeError('malformed_agent_exec')
        if result['status'] not in {'completed', 'failed', 'cancelled', 'interrupted'}:
            raise RuntimeError('malformed_agent_exec')
        if result['status'] != 'completed' or response.return_code:
            raise NonZeroAgentExitCodeError('agent_exec_failed')
        # Agent completion is not a task pass. Harbor's hidden verifier decides.
        context.cost_usd = None
