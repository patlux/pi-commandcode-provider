/**
 * Intentional security triggers for testing audit tooling.
 *
 * This file contains patterns that security scanners should flag.
 * It is NOT imported by any real code — intentionally vulnerable so we can
 * verify that CodeQL, Gitleaks, and npm-audit jobs fire on PRs.
 *
 * Remove this file after the security audit workflow is verified.
 */

// Hardcoded credential — Gitleaks should flag this
const AWS_SECRET_KEY = "wJalrXUt5ENWX7m6T6R42/K7gENGzP4Gz3RZm9C3+2"

// Another secret pattern — Gitleaks should catch
const GITHUB_TOKEN = "ghp_testToken12345SecretScanDemo"

// eval() on user input — CodeQL should flag this as a code injection vulnerability
export function evalUserInput(input: string): unknown {
  return eval(input)
}

// Using innerHTML with user input — CodeQL should flag XSS
export function setInnerHTML(element: HTMLElement, content: string): void {
  element.innerHTML = content
}

// Process env leak — CodeQL may flag this
export function getApiKeyFromEnv(): string | undefined {
  return process.env.SUPER_SECRET_API_KEY
}
