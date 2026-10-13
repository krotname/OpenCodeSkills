// Only recognized terminal provider errors are surfaced; raw logs can contain secrets.
export function providerFailure(text) {
  if (/Go usage limit exceeded/i.test(text)) return "Go usage limit exceeded";
  if (/rate.?limit|too many requests|quota|usage limit|\b429\b/i.test(text)) return "Provider rate or usage limit";
  if (/model.{0,80}(not found|not available|not supported|unavailable)|ProviderModelNotFound|\b404\b/i.test(text)) return "Model unavailable";
  if (/unauthori[sz]ed|forbidden|authentication|invalid.{0,15}(api.?key|credential)|\b40[13]\b/i.test(text)) return "Provider authentication error";
  if (/overload|capacity|service unavailable|internal server error|\b50[0234]\b/i.test(text)) return "Provider unavailable";
  if (/timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network error/i.test(text)) return "Provider connection error";
  return null;
}

export function inspectLogLines(state, lines, title) {
  for (const line of lines) {
    if (line.includes(`title="${title}"`)) state.logRun = line.match(/\brun=([a-zA-Z0-9]+)/)?.[1];
    if (state.logRun && line.includes(`run=${state.logRun} `) && line.includes("level=ERROR")) {
      const failure = providerFailure(line);
      if (failure) return failure;
    }
  }
  return null;
}

export function inspectOutputLines(lines) {
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "error") {
        const failure = providerFailure(JSON.stringify(event.error));
        if (failure) return failure;
      }
    } catch { /* Plain output and tool results are not terminal API errors. */ }
  }
  return null;
}
