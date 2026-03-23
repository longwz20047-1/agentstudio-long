import { describe, it, expect } from 'vitest';
import { formatOpenCliResult, formatOpenCliError } from '../outputFormatter.js';

describe('formatOpenCliResult', () => {
  it('formats JSON array result with count', () => {
    const data = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
    const stdout = JSON.stringify(data);
    const result = formatOpenCliResult('twitter', 'list', stdout);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('twitter/list results (2 found)');
    expect(result.content[0].text).toContain('```json');
    expect(result.content[0].text).toContain('"name": "Alice"');
  });

  it('formats JSON object result', () => {
    const data = { status: 'ok', count: 42 };
    const stdout = JSON.stringify(data);
    const result = formatOpenCliResult('reddit', 'info', stdout);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('reddit/info results (object)');
    expect(result.content[0].text).toContain('```json');
    expect(result.content[0].text).toContain('"status": "ok"');
  });

  it('formats non-JSON plain text result', () => {
    const stdout = 'some plain text output\nwith multiple lines';
    const result = formatOpenCliResult('github', 'status', stdout);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('github/status results');
    expect(result.content[0].text).not.toContain('```json');
    expect(result.content[0].text).toContain('```\n' + stdout + '\n```');
  });
});

describe('formatOpenCliError', () => {
  it('formats error message', () => {
    const result = formatOpenCliError('twitter', 'post', 'Authentication failed');

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('## twitter/post Error\n\nAuthentication failed');
  });
});
