import { describe, expect, it } from 'vitest';
import { compareSemver, isNewerVersion, isSemver, parseSemver } from '../../src/version/semver';
import { shouldShowWhatsNew } from '../../src/version/whatsNew';
import { acceptUpdateInfo } from '../../src/version/updates';

describe('semver', () => {
  it('parses versions with optional v prefix, prerelease and build metadata', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('v1.2.3-beta.1+sha.abc')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['beta', '1'] });
    for (const bad of ['', '1.2', '1.2.3.4', '01.2.3', 'latest', 'v']) expect(isSemver(bad)).toBe(false);
  });

  it('orders by precedence', () => {
    const sorted = ['1.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '0.9.9', '1.10.0', '1.2.0'].sort(
      compareSemver,
    );
    expect(sorted).toEqual(['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0']);
  });

  it('treats a v prefix and build metadata as equal precedence', () => {
    expect(compareSemver('v1.1.0', '1.1.0+build.7')).toBe(0);
  });

  it('isNewerVersion never reports junk as newer', () => {
    expect(isNewerVersion('1.1.0', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('garbage', '1.0.0')).toBe(false);
  });
});

describe('shouldShowWhatsNew (show once after an update)', () => {
  it('shows after an upgrade, not on the same version or a downgrade', () => {
    expect(shouldShowWhatsNew('1.0.0', '1.1.0', true)).toBe(true);
    expect(shouldShowWhatsNew('1.1.0', '1.1.0', true)).toBe(false);
    expect(shouldShowWhatsNew('1.2.0', '1.1.0', true)).toBe(false);
  });

  it('fresh installs stay quiet; returning pre-tracking players see it', () => {
    expect(shouldShowWhatsNew(null, '1.1.0', false)).toBe(false);
    expect(shouldShowWhatsNew(null, '1.1.0', true)).toBe(true);
  });

  it('treats a corrupt stored value as older', () => {
    expect(shouldShowWhatsNew('not-a-version', '1.1.0', false)).toBe(true);
  });
});

describe('acceptUpdateInfo (renderer-side validation of the main-process answer)', () => {
  const url = 'https://github.com/idekakdj/Battle-Royale-v1/releases/tag/v1.1.0';

  it('accepts a strictly newer github.com release and strips the v', () => {
    expect(acceptUpdateInfo({ version: 'v1.1.0', url }, '1.0.0')).toEqual({ version: '1.1.0', url });
  });

  it('rejects same/older versions, non-github URLs and malformed payloads', () => {
    expect(acceptUpdateInfo({ version: '1.0.0', url }, '1.0.0')).toBeNull();
    expect(acceptUpdateInfo({ version: '0.9.0', url }, '1.0.0')).toBeNull();
    expect(acceptUpdateInfo({ version: '2.0.0', url: 'https://evil.example/x' }, '1.0.0')).toBeNull();
    expect(acceptUpdateInfo({ version: '2.0.0', url: 'http://github.com/x' }, '1.0.0')).toBeNull();
    expect(acceptUpdateInfo(null, '1.0.0')).toBeNull();
    expect(acceptUpdateInfo({ version: 2 }, '1.0.0')).toBeNull();
  });
});
