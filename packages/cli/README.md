# Guanxi

Local-first web-интерфейс для Ollama.

```bash
npx guanxi
```

Ollama должна быть установлена и запущена. Текущий CLI поднимает Guanxi server в
foreground и открывает браузер. Daemon, `status`, `stop`, TUI и agent client
запланированы, но пока не реализованы.

Подробности, ограничения и команды разработки — в
[README репозитория](../../README.md). Архитектурный roadmap находится в
[`docs/plans/ROADMAP.md`](../../docs/plans/ROADMAP.md).

## Partial relay client

`guanxi relay exec --request owner-plan.json --key retry-key --url http://127.0.0.1:4310 --json`
submits explicit relay choices and polls metadata-only status. The file supplies `projectId`,
`connectionId`, `model`, `consent: "full-access"`, `domains`, `plan` and `caps`; the CLI supplies
the start key. A repeated key reuses the committed run; changed choices conflict. Runtime facts
are server-owned and are refused in public JSON. The default server returns
`runtime_meter_unavailable`; stock exact tokenization and owned-workspace allocation remain
unimplemented prerequisites. This command does not make stock relay execution available.

Stdout contains one JSON status record. Completion exits 0, acknowledged cancellation 130,
and refusal, wrapping-up, input-required, interruption or failure 1. SIGINT requests stop by
start key, including preparation before a run ID exists. If acknowledgement is unavailable
after the client's explicit five-second wait, status is interrupted/cancellation_unconfirmed;
the client does not claim cleanup. This command accepts only loopback HTTP node URLs. It never
prints plan contents, tool output or reasoning. Relay has no UI in this slice.
