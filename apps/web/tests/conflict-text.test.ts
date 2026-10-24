import { describe, expect, it } from 'vitest';
import { conflictHunks, pickSide, remerge } from '../src/conflict-text';

const marked = [
  '# Rules',
  '<<<<<<< Template revision 3',
  'Use tabs.',
  '=======',
  'Use spaces.',
  'Two of them.',
  '>>>>>>> edit from revision 2',
  'Be brief.',
].join('\n');

describe('conflictHunks', () => {
  it('finds each marked hunk with both sides and their labels', () => {
    expect(conflictHunks(marked)).toEqual([{
      firstLine: 2,
      lastLine: 7,
      current: { label: 'Template revision 3', lines: ['Use tabs.'] },
      edit: { label: 'edit from revision 2', lines: ['Use spaces.', 'Two of them.'] },
    }]);
  });
});

describe('pickSide', () => {
  const twoHunks = [
    '<<<<<<< Template revision 3', 'a1', '=======', 'b1', '>>>>>>> edit from revision 2',
    'shared',
    '<<<<<<< Template revision 3', 'a2', '=======', 'b2', '>>>>>>> edit from revision 2',
  ].join('\n');

  it('replaces one hunk with the chosen side and leaves the others marked', () => {
    const [, second] = conflictHunks(twoHunks);
    expect(pickSide(twoHunks, second, 'edit')).toBe([
      '<<<<<<< Template revision 3', 'a1', '=======', 'b1', '>>>>>>> edit from revision 2',
      'shared',
      'b2',
    ].join('\n'));
  });

  it('keeps both sides, current first', () => {
    const [first] = conflictHunks(marked);
    expect(pickSide(marked, first, 'both')).toBe('# Rules\nUse tabs.\nUse spaces.\nTwo of them.\nBe brief.');
  });
});

describe('remerge', () => {
  const merged = { revision: 3, text: 'one\ntwo\nthree' };

  it('takes changes to different lines from both without markers', () => {
    const newer = { revision: 4, text: 'ONE\ntwo\nthree' };
    expect(remerge(merged, newer, 'one\ntwo\nTHREE')).toBe('ONE\ntwo\nTHREE');
  });

  it('marks lines both changed, the newer Template first', () => {
    const newer = { revision: 4, text: 'one\nTWO\nthree' };
    expect(remerge(merged, newer, 'one\n2\nthree')).toBe(
      'one\n<<<<<<< Template revision 4\nTWO\n=======\n2\n>>>>>>> your resolution\nthree',
    );
  });
});
