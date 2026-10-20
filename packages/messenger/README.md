# @ted-assistant/messenger

The `Messenger` interface of the Ted personal assistant: what the assistant needs from a chat platform. Platform packages (`@ted-assistant/signal`, ...) implement it and export `createMessenger(config)` and `doctor(config)` from a `/messenger` entry point; `loadMessenger(name)` loads one by name.

```sh
npm install @ted-assistant/messenger
```

Entry points:

- `@ted-assistant/messenger`: the types (`Messenger`, `IncomingMessage`, `Target`, ...), the addressing helpers (`directTarget`, `directOf`) and `loadMessenger`.
- `@ted-assistant/messenger/testing`: `FakeMessenger`, an in-memory messenger for tests (it records `sendFirst` calls in `firsts`).
- `@ted-assistant/messenger/contract`: `messengerContract(name, make)`, one `node:test` suite every adapter should pass.

Needs Node 24 or newer. MIT licensed.
