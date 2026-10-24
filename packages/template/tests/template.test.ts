import { describe, expect, it } from 'vitest';
import {
  hasConflictMarkers,
  isSettableVariableName,
  referencedVariables,
  render,
  TemplateSyntaxError,
  validate,
  type RenderContext,
} from '../src/index';

const laptop: RenderContext = {
  variables: { editor: 'helix', shell: 'fish' },
  builtins: { machine: { name: 'laptop', os: 'darwin' }, agent: 'claude' },
};

describe('render', () => {
  it('substitutes Variables into the Template', () => {
    expect(render('Use {{editor}} and {{ shell }}.', laptop)).toEqual({
      text: 'Use helix and fish.',
      warnings: [],
    });
  });

  it('substitutes Built-in Variables from the Machine and the agent', () => {
    expect(
      render('{{agent}} on {{machine.name}} ({{ machine.os }})', laptop).text,
    ).toBe('claude on laptop (darwin)');
  });

  it('prefers a Built-in Variable over a same-named Machine Variable', () => {
    const context = { ...laptop, variables: { agent: 'spoofed' } };
    expect(render('{{agent}}', context).text).toBe('claude');
  });

  it('keeps the if branch when an == condition holds', () => {
    const template = 'A{{if machine.os == "darwin"}}mac{{else}}other{{end}}B';
    expect(render(template, laptop).text).toBe('AmacB');
  });

  it('keeps the else branch when an == condition fails', () => {
    const template =
      'A{{ if agent == "codex" }}codex{{ else }}not codex{{ end }}B';
    expect(render(template, laptop).text).toBe('Anot codexB');
  });

  it('drops the block when the condition fails and there is no else', () => {
    expect(render('A{{if editor == "vim"}}vim{{end}}B', laptop).text).toBe(
      'AB',
    );
  });

  it('supports != conditions', () => {
    const template = '{{if editor != "vim"}}not vim{{end}}';
    expect(render(template, laptop).text).toBe('not vim');
  });

  it('nests conditional blocks', () => {
    const template =
      '{{if machine.os == "darwin"}}mac:{{if agent == "claude"}}claude{{else}}other{{end}}{{else}}linux{{end}}';
    expect(render(template, laptop).text).toBe('mac:claude');
    const codexOnLinux = {
      ...laptop,
      builtins: { machine: { name: 'box', os: 'linux' }, agent: 'codex' },
    };
    expect(render(template, codexOnLinux).text).toBe('linux');
  });

  it('compares a missing Variable as empty and warns', () => {
    const { text, warnings } = render('{{if pager == ""}}none{{end}}', laptop);
    expect(text).toBe('none');
    expect(warnings).toMatchObject([
      { kind: 'missing-variable', variable: 'pager', line: 1, column: 1 },
    ]);
  });

  it('does not warn about missing Variables in branches that are not rendered', () => {
    const template = '{{if agent == "codex"}}{{pager}}{{end}}';
    expect(render(template, laptop).warnings).toEqual([]);
  });

  it('renders an escaped \\{{ as a literal {{ without parsing it', () => {
    expect(render('Write \\{{editor}} or \\{{if}} literally', laptop)).toEqual({
      text: 'Write {{editor}} or {{if}} literally',
      warnings: [],
    });
  });

  it('treats a backslash as an escape only directly before {{', () => {
    expect(render('C:\\Users\\{{machine.name}}', laptop).text).toBe(
      'C:\\Users{{machine.name}}',
    );
    expect(render('C:\\Users\\ {{machine.name}} }} \\n', laptop).text).toBe(
      'C:\\Users\\ laptop }} \\n',
    );
  });

  it('removes the whole line of a block tag that stands alone on it', () => {
    const template = [
      '# Rules',
      '{{if machine.os == "darwin"}}',
      'Use brew.',
      '  {{else}}  ',
      'Use apt.',
      '{{end}}',
      'Be concise.',
    ].join('\n');
    expect(render(template, laptop).text).toBe(
      '# Rules\nUse brew.\nBe concise.',
    );
    const linux = {
      ...laptop,
      builtins: { ...laptop.builtins, machine: { name: 'box', os: 'linux' } },
    };
    expect(render(template, linux).text).toBe('# Rules\nUse apt.\nBe concise.');
  });

  it('removes standalone block tag lines at the start and end of the Template', () => {
    const template = '{{if agent == "claude"}}\nClaude only.\n{{end}}';
    expect(render(template, laptop).text).toBe('Claude only.\n');
  });

  it('keeps the rest of the line when a block tag shares it with text', () => {
    const template = '- Agent: {{if agent == "claude"}}Claude{{end}}\nNext';
    expect(render(template, laptop).text).toBe('- Agent: Claude\nNext');
  });

  it('keeps the line of a Variable that stands alone on it', () => {
    expect(render('a\n{{editor}}\nb', laptop).text).toBe('a\nhelix\nb');
  });

  it('preserves CRLF line endings, including around standalone block tags', () => {
    const template =
      'a\r\n{{if agent == "claude"}}\r\nb {{editor}}\r\n{{end}}\r\nc\r\n';
    expect(render(template, laptop).text).toBe('a\r\nb helix\r\nc\r\n');
  });

  it('reports lines and columns correctly in CRLF input', () => {
    expect(render('a\r\nb\r\n  {{pager}}', laptop).warnings).toMatchObject([
      { variable: 'pager', line: 3, column: 3 },
    ]);
    expect(validate('a\r\n{{end}}')).toMatchObject({ line: 2, column: 1 });
  });

  it('evaluates Expressions inside fenced code blocks; escaping is the only way to keep {{ literal', () => {
    const template = [
      '```sh',
      'echo {{editor}}',
      'echo \\{{editor}}',
      '```',
    ].join('\n');
    expect(render(template, laptop).text).toBe(
      ['```sh', 'echo helix', 'echo {{editor}}', '```'].join('\n'),
    );
    expect(validate('```\n{{ broken\n```')).toMatchObject({
      line: 2,
      column: 1,
    });
  });

  it('renders a missing Variable as empty and warns where it is used', () => {
    expect(render('Hi\nPager: {{pager}}!', laptop)).toEqual({
      text: 'Hi\nPager: !',
      warnings: [
        {
          kind: 'missing-variable',
          variable: 'pager',
          line: 2,
          column: 8,
          message: 'Variable "pager" is not set on this Machine',
        },
      ],
    });
  });

  it('treats a Variable set to an empty string as present', () => {
    const context = { ...laptop, variables: { pager: '' } };
    expect(render('[{{pager}}]', context)).toEqual({
      text: '[]',
      warnings: [],
    });
  });
});

describe('validate', () => {
  it('accepts a well-formed Template', () => {
    const template =
      '# Rules\n{{if machine.os == "linux"}}\nUse {{editor}}.\n{{else}}\n{{if agent != "codex"}}x{{end}}\n{{end}}\n';
    expect(validate(template)).toBeNull();
  });

  it.each([
    [
      'an unclosed if',
      'a\n  {{if agent == "claude"}}x',
      2,
      3,
      'Unclosed {{if}}: add a matching {{end}}',
    ],
    ['a stray end', 'x\n{{end}}', 2, 1, '{{end}} has no matching {{if}}'],
    ['a stray else', '{{else}}', 1, 1, '{{else}} has no matching {{if}}'],
    [
      'a second else',
      '{{if agent == "a"}}{{else}}{{else}}{{end}}',
      1,
      28,
      '{{if}} can only have one {{else}}',
    ],
    [
      'an unterminated Expression',
      'Hi {{name',
      1,
      4,
      'Unclosed Expression: add a matching }}',
    ],
    ['an empty Expression', 'Hi {{ }}', 1, 4, 'Empty Expression'],
    [
      'an if without a comparison',
      '{{if editor}}x{{end}}',
      1,
      1,
      'Malformed {{if}}: expected {{if name == "value"}} or {{if name != "value"}}',
    ],
    [
      'an if with an unquoted value',
      '{{if editor == vim}}x{{end}}',
      1,
      1,
      'Malformed {{if}}: expected {{if name == "value"}} or {{if name != "value"}}',
    ],
    [
      'an if combining conditions',
      '{{if editor == "vim" and agent == "claude"}}x{{end}}',
      1,
      1,
      'Malformed {{if}}: expected {{if name == "value"}} or {{if name != "value"}}',
    ],
    [
      'an invalid Variable name',
      '{{first name}}',
      1,
      1,
      'Invalid Variable name "first name"',
    ],
    [
      'an unknown Built-in Variable',
      '{{machine.arch}}',
      1,
      1,
      'Unknown Built-in Variable "machine.arch"',
    ],
    [
      'the bare machine prefix',
      '{{machine}}',
      1,
      1,
      'Unknown Built-in Variable "machine"',
    ],
    [
      'an unknown Built-in Variable in a condition',
      '{{if machine.arch == "arm64"}}x{{end}}',
      1,
      1,
      'Unknown Built-in Variable "machine.arch"',
    ],
  ])('rejects %s with its position', (_, template, line, column, message) => {
    expect(validate(template)).toEqual({ line, column, message });
  });
});

describe('render with malformed syntax', () => {
  it('throws a TemplateSyntaxError instead of producing output', () => {
    const attempt = () => render('ok\n{{end}}', laptop);
    expect(attempt).toThrow(TemplateSyntaxError);
    expect(attempt).toThrow(expect.objectContaining({ line: 2, column: 1 }));
  });
});

describe('referencedVariables', () => {
  it('lists each Machine Variable once, in order of first use, across all branches', () => {
    const template = [
      '{{editor}} {{if pager == "less"}}{{shell}}{{else}}{{editor}}{{term}}{{end}}',
      '{{if agent == "codex"}}{{if machine.os != "linux"}}{{email}}{{end}}{{end}}',
    ].join('\n');
    expect(referencedVariables(template)).toEqual([
      'editor',
      'pager',
      'shell',
      'term',
      'email',
    ]);
  });

  it('excludes Built-in Variables and escaped Expressions', () => {
    expect(
      referencedVariables('{{agent}} {{machine.name}} \\{{literal}}'),
    ).toEqual([]);
  });

  it('throws a TemplateSyntaxError for a malformed Template', () => {
    expect(() => referencedVariables('{{if x == "y"}}')).toThrow(
      TemplateSyntaxError,
    );
  });
});

describe('hasConflictMarkers', () => {
  it('finds git-style markers left in a Conflict', () => {
    const marked = [
      'Shared',
      '<<<<<<< revision 4',
      'Use helix.',
      '=======',
      'Use vim.',
      '>>>>>>> proposed',
    ].join('\n');
    expect(hasConflictMarkers(marked)).toBe(true);
    expect(hasConflictMarkers('a\r\n<<<<<<<\r\nb')).toBe(true);
    expect(hasConflictMarkers('a\n>>>>>>> proposed')).toBe(true);
    expect(hasConflictMarkers('a\n||||||| base\nb')).toBe(true);
  });

  it('accepts resolved text, including Markdown that merely resembles a marker', () => {
    expect(hasConflictMarkers('Shared\nUse helix.\n')).toBe(false);
    expect(hasConflictMarkers('Title\n=======\nBody')).toBe(false);
    expect(hasConflictMarkers('> quote\n>> nested\n  <<<<<<< indented')).toBe(
      false,
    );
  });
});

describe('isSettableVariableName', () => {
  it('accepts names a Template can reference', () => {
    expect(
      ['editor', 'work_email', '_private', 'Shell2'].map(
        isSettableVariableName,
      ),
    ).toEqual([true, true, true, true]);
  });

  it('rejects reserved Built-in names, keywords, and names the grammar cannot express', () => {
    const rejected = [
      'agent',
      'machine',
      'machine.name',
      'machine.custom',
      'if',
      'else',
      'end',
    ];
    expect(rejected.filter(isSettableVariableName)).toEqual([]);
    expect(
      ['', 'first name', '2fa', 'work-email', 'a.b'].filter(
        isSettableVariableName,
      ),
    ).toEqual([]);
  });
});
