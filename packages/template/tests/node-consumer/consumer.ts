// Imports the package by name, as the CLI does: plain tsc with NodeNext resolves its exports.
import { render } from '@agentsync/template';

const context = {
  variables: {},
  builtins: { machine: { name: 'laptop', os: 'darwin' }, agent: 'claude' },
};
console.log(render('{{agent}} on {{machine.name}}', context).text);
