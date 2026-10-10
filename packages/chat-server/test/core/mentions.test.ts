import { describe, expect, it } from 'vitest';
import { extractMentionUsernames } from '../../src/core/mentions.js';

describe('extractMentionUsernames', () => {
  it('finds @usernames, lower-cased and de-duplicated, in order of first appearance', () => {
    expect(extractMentionUsernames('hey @Alice and @bob, @alice again')).toEqual(['alice', 'bob']);
  });

  it('requires the @ to start a word and ignores e-mail addresses', () => {
    expect(extractMentionUsernames('mail me at alice@example.com or ping @bob_1')).toEqual([
      'bob_1',
    ]);
    expect(extractMentionUsernames('(@carol) [@dave]! @eve?')).toEqual(['carol', 'dave', 'eve']);
  });

  it('ignores tokens that are not valid usernames', () => {
    expect(extractMentionUsernames('@ @a @this-has-dashes @ok_name')).toEqual(['ok_name']);
    expect(extractMentionUsernames('no mentions here')).toEqual([]);
  });
});
