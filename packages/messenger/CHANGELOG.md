# Changelog

0.x releases may change the API between minor versions.

## 0.1.0 (unreleased)

Added
- Optional `Messenger.sendFirst(recipient, text)`: one first message to a number or username (FakeMessenger and the contract cover it).
- First published version: the `Messenger` interface, the neutral addressing convention (`Target`, `directTarget`, `directOf`), `loadMessenger` / `loadMessengerModule`, `/testing` (`FakeMessenger`) and `/contract` (`messengerContract`, one test suite every platform package runs). Built to `dist`, with declarations.
