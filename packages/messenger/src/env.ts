// The environment for a helper process (signal-cli, ffmpeg, whisper, Kokoro): shared by the platform and speech packages so the rule lives in one place.
// Variables that look like credentials (API keys, tokens, an ssh agent socket). A helper opens data other people control and needs
// none of these, so a bug in one cannot read them.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i;
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_NAME.test(k)));
}
