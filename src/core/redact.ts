// Credentials never reach a log, whatever a library or an error message includes. (Values stop at a quote, comma or space,
// so a JSON line stays valid JSON after it is redacted.)
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***")
    .replace(/\bsk[-_][A-Za-z0-9_-]{24,}/g, "sk-***") // other providers' keys (ElevenLabs sk_..., OpenAI sk-...)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "***")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "***") // a JWT
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1***")
    .replace(/(authorization["']?\s*[:=]\s*["']?basic\s+)[A-Za-z0-9+/=]{8,}/gi, "$1***")
    .replace(/(xi-api-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1***")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password|key|sig|signature)=)[^&\s"']+/gi, "$1***")
    .replace(/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)[^\s"',;}]+/g, "$1***") // .env style: ANTHROPIC_API_KEY=..., TTS_HTTP_TOKEN=...
    .replace(/(\/\/[^\s/:@"']+:)[^\s/@"']+@/g, "$1***@"); // https://user:password@host
}

// Phone numbers and credentials never reach a log.
export function redact(text: string): string {
  return redactSecrets(text.replace(/\+\d{7,15}/g, (m) => `+***${m.slice(-2)}`));
}
