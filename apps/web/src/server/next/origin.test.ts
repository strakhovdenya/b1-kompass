import { describe, expect, it } from 'vitest';
import { isTrustedRequestOrigin, parseTrustedOrigin } from './origin';
import type { OriginSettings, TrustedOrigin } from './origin';

const settings = (overrides: Partial<OriginSettings>): OriginSettings => ({
  appOrigin: undefined,
  vercelEnv: undefined,
  vercelUrl: undefined,
  ...overrides,
});

const accepted = (origin: string): TrustedOrigin => ({ ok: true, origin });

const PREVIEW_HOST = 'b1-kompass-git-feature-team.vercel.app';

describe('parseTrustedOrigin', () => {
  it('trusted origin configuration parses production preview and test origins', () => {
    const cases: [Partial<OriginSettings>, TrustedOrigin][] = [
      [
        { appOrigin: 'https://b1-kompass.example', vercelEnv: 'production' },
        accepted('https://b1-kompass.example'),
      ],
      [
        { appOrigin: 'https://b1.example:8443', vercelEnv: 'production' },
        accepted('https://b1.example:8443'),
      ],
      // An explicit APP_ORIGIN wins over the preview fallback.
      [
        {
          appOrigin: 'https://review.b1-kompass.example',
          vercelEnv: 'preview',
          vercelUrl: PREVIEW_HOST,
        },
        accepted('https://review.b1-kompass.example'),
      ],
      [
        { vercelEnv: 'preview', vercelUrl: PREVIEW_HOST },
        accepted(`https://${PREVIEW_HOST}`),
      ],
      [
        { appOrigin: 'http://localhost:3100' },
        accepted('http://localhost:3100'),
      ],
      [
        { appOrigin: 'http://localhost:3101' },
        accepted('http://localhost:3101'),
      ],
      [
        { appOrigin: 'http://localhost:3102' },
        accepted('http://localhost:3102'),
      ],
      [
        { appOrigin: 'http://127.0.0.1:3000' },
        accepted('http://127.0.0.1:3000'),
      ],
    ];
    for (const [input, expected] of cases) {
      expect(parseTrustedOrigin(settings(input))).toEqual(expected);
    }
  });

  it('invalid origin configuration fails closed without request host fallback', () => {
    const invalidAppOrigins = [
      'https://b1-kompass.example/',
      'https://b1-kompass.example/practice',
      'https://b1-kompass.example?x=1',
      'https://b1-kompass.example#top',
      'https://user:secret@b1-kompass.example',
      'https://*.vercel.app',
      '*',
      'b1-kompass.example',
      'ftp://b1-kompass.example',
      'http://b1-kompass.example',
      'HTTPS://B1-KOMPASS.EXAMPLE',
      'https://b1-kompass.example, https://evil.example',
    ];
    for (const appOrigin of invalidAppOrigins) {
      for (const vercelEnv of ['production', 'preview', undefined]) {
        const result = parseTrustedOrigin(
          settings({ appOrigin, vercelEnv, vercelUrl: PREVIEW_HOST }),
        );
        expect(result).toEqual({ ok: false, error: 'invalid-app-origin' });
      }
    }

    const invalidPreviewHosts = [
      'https://b1.vercel.app',
      'b1.vercel.app/path',
      'user@b1.vercel.app',
      '*.vercel.app',
      'localhost',
      'b1.vercel.app:443',
    ];
    for (const vercelUrl of invalidPreviewHosts) {
      const result = parseTrustedOrigin(
        settings({ vercelEnv: 'preview', vercelUrl }),
      );
      expect(result).toEqual({ ok: false, error: 'invalid-preview-host' });
    }

    expect(parseTrustedOrigin(settings({}))).toEqual({
      ok: false,
      error: 'missing-origin',
    });
    expect(parseTrustedOrigin(settings({ vercelEnv: 'preview' }))).toEqual({
      ok: false,
      error: 'missing-origin',
    });

    // The request side compares exactly; a missing header is refused and a
    // forged Host plays no part.
    const trusted = 'http://localhost:3100';
    expect(isTrustedRequestOrigin(trusted, trusted)).toBe(true);
    for (const received of [
      null,
      '',
      'null',
      'http://localhost:3101',
      'http://localhost:3100/',
      'https://localhost:3100',
      'http://evil.example',
    ]) {
      expect(isTrustedRequestOrigin(trusted, received)).toBe(false);
    }
  });

  it('origin fallback requires explicit preview environment', () => {
    const outcomes = [
      'preview',
      'production',
      'development',
      'staging',
      '',
    ].map((vercelEnv) =>
      parseTrustedOrigin(settings({ vercelEnv, vercelUrl: PREVIEW_HOST })),
    );
    expect(outcomes).toEqual([
      accepted(`https://${PREVIEW_HOST}`),
      { ok: false, error: 'missing-origin' },
      { ok: false, error: 'missing-origin' },
      { ok: false, error: 'missing-origin' },
      { ok: false, error: 'missing-origin' },
    ]);
    expect(parseTrustedOrigin(settings({ vercelUrl: PREVIEW_HOST }))).toEqual({
      ok: false,
      error: 'missing-origin',
    });

    // An explicitly invalid APP_ORIGIN is not replaced by the fallback in
    // any environment.
    for (const vercelEnv of ['preview', 'production', 'development']) {
      expect(
        parseTrustedOrigin(
          settings({
            appOrigin: 'https://example.com/path',
            vercelEnv,
            vercelUrl: PREVIEW_HOST,
          }),
        ),
      ).toEqual({ ok: false, error: 'invalid-app-origin' });
    }
  });
});
