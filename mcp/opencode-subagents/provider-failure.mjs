// Only recognized terminal provider errors are surfaced; raw logs can contain secrets.
export function providerFailure(text) {
  if (/Go usage limit exceeded/i.test(text)) return "Go usage limit exceeded";
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
