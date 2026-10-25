import { describe, expect, it } from 'vitest';
import { begin, edit, end, follow, isDirty, rebase, saved, start } from '../src/draft';

const same = (a: string, b: string) => a === b;

describe('draft', () => {
  it('advances its base only to the revision its own save returned', () => {
    let draft = edit(start({ revision: 1, value: 'base' }), 'mine');
    draft = saved(begin(draft), 2);
    expect(draft.revision).toBe(2);
    expect(isDirty(draft, same)).toBe(false);
  });

  it('after its own save, takes a newer revision saved elsewhere instead of keeping stale text', () => {
    // Saved revision 2; another client saved revision 3 before the page reloaded.
    const draft = end(saved(begin(edit(start({ revision: 1, value: 'base' }), 'mine')), 2));
    expect(follow(draft, { revision: 3, value: 'theirs' }, same)).toMatchObject({ revision: 3, value: 'theirs' });
  });

  it('keeps unsaved edits and their base revision when a newer revision loads', () => {
    const draft = edit(start({ revision: 1, value: 'base' }), 'mine');
    expect(follow(draft, { revision: 3, value: 'theirs' }, same)).toBe(draft);
  });

  it('ignores an older or equal loaded revision', () => {
    const draft = end(saved(begin(edit(start({ revision: 1, value: 'base' }), 'mine')), 2));
    expect(follow(draft, { revision: 1, value: 'base' }, same)).toBe(draft);
  });

  it('ignores edits while a save is in flight, so the text sent is the text kept', () => {
    const draft = begin(edit(start({ revision: 1, value: 'base' }), 'sent'));
    expect(edit(draft, 'typed during save').value).toBe('sent');
  });

  it('a re-merge moves the base revision but keeps the draft unsaved', () => {
    // The resolver's draft is clean only while it equals the Conflict's own text.
    const draft = rebase(edit(start({ revision: 6, value: 'marked' }), 'resolved'), 7, 'remerged');
    expect(draft).toMatchObject({ revision: 7, value: 'remerged' });
    expect(isDirty(draft, same)).toBe(true);
  });
});
