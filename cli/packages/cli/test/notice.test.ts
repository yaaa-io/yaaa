import { describe, expect, it } from 'vitest';
import { checkDue, noticeAllowed, versionToMention } from '../src/notice.js';

const argv = (...a: string[]) => ['node', 'yaaa', ...a];
const DAY = 24 * 60 * 60 * 1000;

describe('update notice', () => {
  it('is only for a person at a terminal', () => {
    expect(noticeAllowed(argv('status'), {}, true)).toBe(true);
    expect(noticeAllowed(argv('--profile', 'local', 'products', 'search', 'tote'), {}, true)).toBe(true);
    expect(noticeAllowed(argv('status'), {}, false)).toBe(false); // piped: an agent
    expect(noticeAllowed(argv('--json', 'status'), {}, true)).toBe(false);
    expect(noticeAllowed(argv('status'), { YAAA_NO_UPDATE_CHECK: '1' }, true)).toBe(false);
    expect(noticeAllowed(argv('status'), { CI: 'true' }, true)).toBe(false);
    expect(noticeAllowed(argv('mcp'), {}, true)).toBe(false);
    expect(noticeAllowed(argv('update'), {}, true)).toBe(false);
    expect(noticeAllowed(argv('notify', 'run'), {}, true)).toBe(false);
    expect(noticeAllowed(argv('notify', 'status'), {}, true)).toBe(true);
    expect(noticeAllowed(argv('--version'), {}, true)).toBe(false);
  });

  it('checks at most once a day', () => {
    const now = Date.now();
    expect(checkDue({}, now)).toBe(true);
    expect(checkDue({ checkedAt: now - DAY / 2 }, now)).toBe(false);
    expect(checkDue({ checkedAt: now - DAY }, now)).toBe(true);
  });

  it('mentions a newer version, at most once a day', () => {
    const now = Date.now();
    expect(versionToMention({ latest: '0.2.0' }, '0.1.0', now)).toBe('0.2.0');
    expect(versionToMention({ latest: '0.1.0' }, '0.1.0', now)).toBeUndefined();
    expect(versionToMention({ latest: '0.0.9' }, '0.1.0', now)).toBeUndefined();
    expect(versionToMention({ latest: '0.2.0', notifiedAt: now - 1000 }, '0.1.0', now)).toBeUndefined();
    expect(versionToMention({ latest: '0.2.0', notifiedAt: now - DAY }, '0.1.0', now)).toBe('0.2.0');
    expect(versionToMention({}, '0.1.0', now)).toBeUndefined();
  });
});
