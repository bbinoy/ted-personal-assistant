// Variables that look like credentials (API keys, tokens, an ssh agent socket). signal-cli needs none of these, so a bug
// in it cannot read them.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i;
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_NAME.test(k)));
}
