// Shared shell prefix for fake harness CLIs used in unit tests.
// Production preflight-on-invoke (#636) probes --version / auth / models before
// the real stage spawn. Fakes that only echo argv would fail those probes.

/** Bash snippet: answer readiness probes, then fall through to the test body. */
export const PREFLIGHT_READINESS_SHIM = `
# production preflight readiness (#636)
if [ "$#" -ge 1 ]; then
  case "$1" in
    --version|version|--help)
      echo "\${0##*/} 1.0.0-test"
      exit 0
      ;;
  esac
  if [ "$1" = "auth" ] && [ "\${2:-}" = "status" ]; then
    echo '{"loggedIn":true}'
    exit 0
  fi
  if [ "$1" = "login" ] && [ "\${2:-}" = "status" ]; then
    echo "Logged in using ChatGPT"
    exit 0
  fi
  if [ "$1" = "--list-models" ]; then
    echo "model-a (test)"
    exit 0
  fi
  if [ "$1" = "providers" ] && [ "\${2:-}" = "list" ]; then
    echo "provider-a"
    exit 0
  fi
  if [ "$1" = "run" ] && [ "\${2:-}" = "--help" ]; then
    echo "Usage: run"
    exit 0
  fi
  if [ "$1" = "models" ]; then
    echo "model-a"
    exit 0
  fi
fi
`.trim();

/** Wrap a bash body so production preflight readiness probes succeed first. */
export function withPreflightReadiness(body: string): string {
  return `#!/usr/bin/env bash\n${PREFLIGHT_READINESS_SHIM}\n${body}\n`;
}
