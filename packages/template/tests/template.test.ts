import { describe, expect, it } from 'vitest';
import {
  hasConflictMarkers,
  isSettableVariableName,
  suspectedConflictMarkers,
  referencedVariables,
  render,
  TemplateSyntaxError,
  validate,
  type RenderContext,
} from '../src/index';

const laptop: RenderContext = {
  variables: { editor: 'helix', shell: 'fish' },
  builtins: { machine: { hostname: 'laptop', nickname: 'Work laptop', os: 'darwin' }, agent: 'claude' },
};

describe('render', () => {
  it('substitutes Variables into the Template', () => {
    expect(render('Use {{editor}} and {{ shell }}.', laptop)).toEqual({
      text: 'Use helix and fish.',
      warnings: [],
    });
  });

  it('marks substituted text, but conditions compare the bare value', () => {
    const mark = (value: string, name: string) => `[${name}:${value}]`;
    expect(
      render('{{if agent == "claude"}}{{editor}}{{end}} on {{agent}}{{missing}}.', laptop, { mark }).text,
    ).toBe('[editor:helix] on [agent:claude].');
  });

  it('substitutes Built-in Variables from the Machine and the agent', () => {
    expect(
      render('{{agent}} on {{machine.hostname}} ({{ machine.os }})', laptop).text,
    ).toBe('claude on laptop (darwin)');
  });

  it('keeps the nickname and the hostname apart', () => {
    expect(
      render(
        '{{machine.nickname}} / {{machine.hostname}}{{if machine.nickname == "Work laptop"}} yes{{end}}{{if machine.hostname != "laptop"}} no{{end}}',
        laptop,
      ).text,
    ).toBe('Work laptop / laptop yes');
    expect(validate('{{machine.name}}')).not.toBeNull();
    expect(referencedVariables('{{machine.nickname}} {{machine.hostname}}')).toEqual([]);
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
      builtins: { machine: { hostname: 'box', nickname: 'Box', os: 'linux' }, agent: 'codex' },
    };
    expect(render(template, codexOnLinux).text).toBe('linux');
  });

  describe('conditions', () => {
    const on = (os: string, agent: string, variables: Record<string, string> = {}): RenderContext => ({
      variables,
      builtins: { machine: { hostname: 'box', nickname: 'Box', os }, agent },
    });
    const show = (condition: string, context: RenderContext) =>
      render(`{{if ${condition}}}yes{{else}}no{{end}}`, context).text;

    it.each([
      ['machine.os == "linux" && agent == "claude"', ['yes', 'no', 'no']],
      ['machine.os == "linux" || agent == "claude"', ['yes', 'yes', 'yes']],
      ['!(machine.os == "linux")', ['no', 'no', 'yes']],
      ['!machine.os == "linux" && agent == "claude"', ['no', 'no', 'yes']],
    ])('evaluates %s', (condition, expected) => {
      const contexts = [on('linux', 'claude'), on('linux', 'codex'), on('macos', 'claude')];
      expect(contexts.map((context) => show(condition, context))).toEqual(expected);
    });

    it('binds && tighter than ||, and parentheses override it', () => {
      const context = on('macos', 'claude');
      expect(show('agent == "claude" || agent == "codex" && machine.os == "linux"', context)).toBe('yes');
      expect(show('(agent == "claude" || agent == "codex") && machine.os == "linux"', context)).toBe('no');
    });

    it('ignores whitespace and line breaks between tokens', () => {
      expect(show('(machine.os==\n"linux")&&!(agent!="claude")', on('linux', 'claude'))).toBe('yes');
    });

    it('renders the first {{else if}} branch that holds', () => {
      const template = [
        '{{if machine.os == "macos"}}',
        'brew',
        '{{else if machine.os == "linux" && agent == "codex"}}',
        'apt for codex',
        '{{else if machine.os == "linux"}}',
        'apt',
        '{{else}}',
        'winget',
        '{{end}}',
      ].join('\n');
      expect(render(template, on('macos', 'codex')).text).toBe('brew\n');
      expect(render(template, on('linux', 'codex')).text).toBe('apt for codex\n');
      expect(render(template, on('linux', 'claude')).text).toBe('apt\n');
      expect(render(template, on('windows', 'claude')).text).toBe('winget\n');
    });

    it('warns only about Variables it had to look up, at the Variable', () => {
      const template = '{{if agent == "codex" && pager == "less"}}x{{else if editor == "vim" || shell == "fish"}}y{{end}}';
      expect(render(template, on('linux', 'claude', { editor: 'vim' })).warnings).toEqual([]);
      expect(render(template, on('linux', 'codex', { editor: 'helix' })).warnings).toMatchObject([
        { variable: 'pager', line: 1, column: template.indexOf('pager') + 1 },
        { variable: 'shell', line: 1, column: template.indexOf('shell') + 1 },
      ]);
    });

    it('lists the Variables of every condition and branch', () => {
      expect(
        referencedVariables('{{if a == "1" && !(b == "2" || agent == "pi")}}{{c}}{{else if d != "4"}}{{e}}{{end}}'),
      ).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('does not count {{else if}} towards the nesting limit', () => {
      const chain = '{{if agent == "x"}}' + '{{else if agent == "x"}}'.repeat(200) + '{{else}}ok{{end}}';
      expect(render(chain, laptop).text).toBe('ok');
    });

    it('tests whether a Variable is set, without warning when it is not', () => {
      const template = '{{if work_email}}Mail {{work_email}}.{{else if !pager}}No pager.{{end}}';
      expect(render(template, on('linux', 'pi', { work_email: 'a@b.c' }))).toEqual({ text: 'Mail a@b.c.', warnings: [] });
      expect(render(template, on('linux', 'pi'))).toEqual({ text: 'No pager.', warnings: [] });
      // An empty value counts as no value, as in ${x:-default}.
      expect(render(template, on('linux', 'pi', { work_email: '', pager: 'less' })).text).toBe('');
      expect(referencedVariables(template)).toEqual(['work_email', 'pager']);
    });

    it('tests membership in a list', () => {
      const condition = 'agent in ["claude", "pi",] && !(machine.os in ["windows"])';
      expect(['claude', 'pi', 'codex'].map((agent) => show(condition, on('linux', agent)))).toEqual(['yes', 'yes', 'no']);
      expect(show(condition, on('windows', 'claude'))).toBe('no');
    });

    it('matches globs against the whole value', () => {
      const hostname = (name: string): RenderContext => ({
        variables: {},
        builtins: { machine: { hostname: name, nickname: name, os: 'linux' }, agent: 'claude' },
      });
      const condition = 'machine.hostname matches "build-?.*"';
      expect(['build-1.ci', 'build-2.', 'build-10.ci', 'xbuild-1.ci', 'build-1'].map((h) => show(condition, hostname(h))))
        .toEqual(['yes', 'yes', 'no', 'no', 'no']);
      // Everything but * and ? is literal, regular expression syntax included.
      expect(show('machine.hostname matches "a+(b)|[c]"', hostname('a+(b)|[c]'))).toBe('yes');
      expect(show('machine.hostname matches "a+(b)|[c]"', hostname('aa(b)'))).toBe('no');
      expect(show('machine.hostname matches "*"', hostname('line\nbreak'))).toBe('yes');
    });

    it('rejects conditions nested deeper than 64', () => {
      expect(validate(`{{if ${'!'.repeat(64)}agent == "x"}}{{end}}`)).toMatchObject({
        message: 'Conditions can only be nested 64 deep',
      });
      expect(validate(`{{if ${'!'.repeat(63)}agent == "x"}}{{end}}`)).toBeNull();
    });
  });

  it.each([
    ['}}', '==', 'yes'],
    ['}}', '!=', 'no'],
    ['{{', '==', 'yes'],
    ['{{', '!=', 'no'],
  ])(
    'finds the closing }} outside a quoted %s in an %s comparison',
    (delimiter, operator, expected) => {
      const template = `{{if x ${operator} "a${delimiter}b"}}yes{{else}}no{{end}}`;
      const context = { ...laptop, variables: { x: `a${delimiter}b` } };
      expect(render(template, context)).toEqual({
        text: expected,
        warnings: [],
      });
    },
  );

  it('compares a missing Variable as empty and warns', () => {
    const { text, warnings } = render('{{if pager == ""}}none{{end}}', laptop);
    expect(text).toBe('none');
    expect(warnings).toMatchObject([
      { kind: 'missing-variable', variable: 'pager', line: 1, column: 6 },
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
    expect(render('C:\\Users\\{{machine.hostname}}', laptop).text).toBe(
      'C:\\Users{{machine.hostname}}',
    );
    expect(render('C:\\Users\\ {{machine.hostname}} }} \\n', laptop).text).toBe(
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
      builtins: { ...laptop.builtins, machine: { hostname: 'box', nickname: 'Box', os: 'linux' } },
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

  it('renders a default for a missing or empty Variable, without a warning', () => {
    const template = '{{editor ?? "vim"}} {{ pager??"less" }} {{shell ?? "a}}b"}}';
    expect(render(template, laptop)).toEqual({ text: 'helix less fish', warnings: [] });
    expect(render('[{{pager ?? "less"}}]', { ...laptop, variables: { pager: '' } }).text).toBe('[less]');
    const mark = (value: string, name: string) => `<${name}:${value}>`;
    expect(render('{{pager ?? "less"}}', laptop, { mark }).text).toBe('<pager:less>');
    expect(referencedVariables('{{pager ?? "less"}}')).toEqual(['pager']);
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
    ['an if without a condition', '{{if}}x{{end}}', 1, 5, 'Expected a condition such as agent == "claude"'],
    ['a value without an operator', '{{if editor "vim"}}x{{end}}', 1, 13, 'Expected ==, !=, in or matches before "vim"'],
    ['a Built-in Variable tested for being set', '{{if machine.os}}x{{end}}', 1, 6, 'Built-in Variables are always set: compare machine.os with == or != instead'],
    ['in without a list', '{{if agent in "pi"}}x{{end}}', 1, 15, 'Expected a list after in, such as ["claude", "pi"]'],
    ['an empty list', '{{if agent in []}}x{{end}}', 1, 16, 'Expected a quoted value after [, such as "linux"'],
    ['an unclosed list', '{{if agent in ["pi"}}x{{end}}', 1, 20, 'Unclosed [: add a matching ]'],
    ['not in', '{{if agent not in ["pi"]}}x{{end}}', 1, 12, 'Put ! in front instead: !(agent in …)'],
    ['two names in a row', '{{if agent codex}}x{{end}}', 1, 12, 'Expected ==, !=, in or matches before codex'],
    ['an unquoted value with a dash', '{{if machine.hostname matches build-*}}x{{end}}', 1, 36, 'Unexpected - in a condition: quote values, such as "linux"'],
    ['~= for patterns', '{{if machine.hostname ~= "a*"}}x{{end}}', 1, 23, 'Unexpected ~ in a condition: match a pattern with matches, such as machine.hostname matches "build-*"'],
    ['elif', '{{if a}}{{elif b}}{{end}}', 1, 9, 'Use {{else if …}} instead'],
    ['endif', '{{if a}}{{endif}}', 1, 9, 'Use {{end}} instead'],
    ['|| for a default', '{{editor || "vim"}}', 1, 1, 'Use ?? for a default, such as {{editor ?? "vim"}}'],
    ['a list without commas', '{{if agent in ["pi" "codex"]}}x{{end}}', 1, 21, 'Expected , or ] before "codex"'],
    ['an unquoted pattern', '{{if agent matches cl*}}x{{end}}', 1, 22, 'Unexpected * in a condition: quote a pattern, such as "build-*"'],
    ['matches without a pattern', '{{if agent matches}}x{{end}}', 1, 19, 'Expected a quoted value after matches, such as "linux"'],
    ['a malformed default', '{{editor ?? vim}}', 1, 1, 'Malformed default: expected {{name ?? "default"}}'],
    ['a default on an invalid name', '{{first name ?? "x"}}', 1, 1, 'Invalid Variable name "first name"'],
    ['an if with an unquoted value', '{{if editor == vim}}x{{end}}', 1, 16, 'Expected a quoted value after ==, such as "linux"'],
    ['a single-quoted value', "{{if editor == 'vim'}}x{{end}}", 1, 16, 'Unexpected \' in a condition: quote values with "'],
    ['a single =', '{{if editor = "vim"}}x{{end}}', 1, 13, 'Unexpected = in a condition: compare with =='],
    ['and spelled out', '{{if editor == "vim" and agent == "claude"}}x{{end}}', 1, 22, 'Use && instead of and'],
    ['not spelled out', '{{if not editor == "vim"}}x{{end}}', 1, 6, 'Use ! instead of not'],
    ['comparisons without an operator between them', '{{if a == "1" b == "2"}}x{{end}}', 1, 15, 'Expected && or || before b'],
    ['a dangling &&', '{{if a == "1" &&}}x{{end}}', 1, 17, 'Expected a condition such as agent == "claude"'],
    ['an unclosed (', '{{if (a == "1" || b == "2"}}x{{end}}', 1, 6, 'Unclosed (: add a matching )'],
    ['a stray )', '{{if a == "1")}}x{{end}}', 1, 14, 'Unexpected ): it has no matching ('],
    ['an else if without an if', '{{else if a == "1"}}', 1, 1, '{{else if}} has no matching {{if}}'],
    ['an else if after else', '{{if a == "1"}}{{else}}{{else if a == "2"}}{{end}}', 1, 24, '{{else if}} must come before {{else}}'],
    ['a position on a later line of a tag', '{{if a == "1"\n   && b "x"}}x{{end}}', 2, 9, 'Expected ==, !=, in or matches before "x"'],
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
      '{{if agent == "pi" || machine.arch == "arm64"}}x{{end}}',
      1,
      23,
      'Unknown Built-in Variable "machine.arch"',
    ],
  ])('rejects %s with its position', (_, template, line, column, message) => {
    expect(validate(template)).toEqual({ line, column, message });
  });
});

describe('large Templates', () => {
  // Sized so a parser that rescans the source per Expression overruns the default test timeout
  // several times over, while a linear one takes milliseconds. No timing threshold is asserted.
  const lines = 30_000;

  it('validates many lines of Expressions and positions an error on the last line', () => {
    const template = '{{agent}}\n'.repeat(lines);
    expect(validate(template)).toBeNull();
    expect(validate(template + '  {{end}}')).toEqual({
      line: lines + 1,
      column: 3,
      message: '{{end}} has no matching {{if}}',
    });
  });

  it('validates many Expressions on one line and positions an error at its end', () => {
    const template = '{{agent}}'.repeat(lines);
    expect(validate(template)).toBeNull();
    expect(validate(template + '{{end}}')).toMatchObject({
      line: 1,
      column: lines * '{{agent}}'.length + 1,
    });
  });
});

describe('nesting', () => {
  const nested = (depth: number) =>
    '{{if agent == "claude"}}'.repeat(depth) +
    '{{editor}}' +
    '{{end}}'.repeat(depth);

  it('renders {{if}} blocks nested 64 deep', () => {
    expect(validate(nested(64))).toBeNull();
    expect(render(nested(64), laptop).text).toBe('helix');
    expect(referencedVariables(nested(64))).toEqual(['editor']);
  });

  it('rejects the 65th nested {{if}} at its position', () => {
    const tag = '{{if agent == "claude"}}';
    expect(validate(nested(65))).toEqual({
      line: 1,
      column: 64 * tag.length + 1,
      message: '{{if}} blocks can only be nested 64 deep',
    });
    expect(() => render(nested(10_000), laptop)).toThrow(TemplateSyntaxError);
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
      referencedVariables('{{agent}} {{machine.hostname}} \\{{literal}}'),
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

describe('suspectedConflictMarkers', () => {
  it('reports the lines of a leftover ======= separator without making it a hard marker', () => {
    const text = 'left\n=======\nright\r\n=======\r\nend';
    expect(hasConflictMarkers(text)).toBe(false);
    expect(suspectedConflictMarkers(text)).toEqual([2, 4]);
  });

  it('also reports a Markdown heading underline of exactly seven =, which it cannot tell apart', () => {
    expect(suspectedConflictMarkers('Title\n=======\nBody')).toEqual([2]);
  });

  it('ignores other runs of =', () => {
    expect(
      suspectedConflictMarkers('Title\n========\n======\n a = b\n ======='),
    ).toEqual([]);
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
