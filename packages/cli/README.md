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

## Import provider keys (D-208)

```bash
guanxi connections import --file /absolute/path/to/owner.env --data-dir /absolute/path/to/node-data --json
```

This local command creates or rotates K3 vault connections without HTTP or provider calls.
It prints references and action facts only. It requires access to this node's OS wrapping key.
See [Connections](../server/src/connections/README.md#d-208-trusted-import-and-chat) for supported
keys and endpoint rules. Restart an already running node after standalone import. Alternatively,
start it with `GUANXI_PROVIDER_KEYS_FILE` naming the file; boot import leaves the vault unlocked
for interactive Chat and never grants unattended consent.
