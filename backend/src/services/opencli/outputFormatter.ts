type McpResult = { content: Array<{ type: 'text'; text: string }> };

export function formatOpenCliResult(site: string, action: string, stdout: string): McpResult {
  let formatted: string;
  try {
    const data = JSON.parse(stdout);
    const count = Array.isArray(data) ? `${data.length} found` : 'object';
    formatted = `## ${site}/${action} results (${count})\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  } catch {
    formatted = `## ${site}/${action} results\n\n\`\`\`\n${stdout}\n\`\`\``;
  }
  return { content: [{ type: 'text', text: formatted }] };
}

export function formatOpenCliError(site: string, action: string, errorMessage: string): McpResult {
  return { content: [{ type: 'text', text: `## ${site}/${action} Error\n\n${errorMessage}` }] };
}
